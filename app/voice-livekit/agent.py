"""
    SPIKE: LiveKit Agents voice worker (Christy screening interviewer).
Sarvam STT/TTS + LiveKit Agents turn handling + direct streaming Gemini LLM.
"""

from __future__ import annotations

import os
import re
import time
import asyncio
import inspect
import logging
from collections.abc import Mapping
from typing import Any, Awaitable, Callable

from dotenv import load_dotenv

from livekit import api as livekit_api
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import openai, sarvam

import persistence
import phone
import phone_canary
from closing import ClosingState, ClosingStateMachine
from observability import (
    Span,
    StructuredLogger,
    counter_metric,
    histogram_metric,
    reset_correlation_id,
    set_correlation_id,
    start_span,
)
from persistence import LifecycleError, WorkerContext
from prompting import (
    build_prompt_context,
    collect_prompt_metadata,
    format_questions as prompting_format_questions,
    format_resume_facts as prompting_format_resume_facts,
    opening_line,
    system_prompt,
)
from provenance import screening_provenance

load_dotenv()

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
# Google AI Studio's direct OpenAI-compatible endpoint. AgentSession consumes
# the plugin's async token stream; no iKey/model gateway is present in this path.
GEMINI_BASE_URL = os.getenv(
    "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai/"
)
_log = StructuredLogger("agent")


class _LiveKitTranscriptFilter(logging.Filter):
    """Remove candidate text extras from SDK records before any handler sees them."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.__dict__.pop("user_input", None)
        record.__dict__.pop("transcript", None)
        return True


_LIVEKIT_TRANSCRIPT_FILTER = _LiveKitTranscriptFilter()
logging.getLogger("livekit.agents").addFilter(_LIVEKIT_TRANSCRIPT_FILTER)

ROOM_SESSION_RE = re.compile(
    r"^screening-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$",
    re.IGNORECASE,
)


def _room_name_from_context(ctx: JobContext) -> str:
    room = getattr(ctx, "room", None)
    name = getattr(room, "name", None)
    if name:
        return str(name)

    job = getattr(ctx, "job", None)
    for attr in ("room_name", "roomName"):
        value = getattr(job, attr, None)
        if value:
            return str(value)

    job_room = getattr(job, "room", None)
    if isinstance(job_room, str) and job_room:
        return job_room
    job_room_name = getattr(job_room, "name", None)
    return str(job_room_name) if job_room_name else ""


def _session_id_from_room_name(room_name: str) -> str | None:
    match = ROOM_SESSION_RE.match(room_name)
    return match.group(1) if match else None


def _float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw in (None, ""):
        return default
    try:
        return float(raw)
    except ValueError:
        return default


CANDIDATE_SILENCE_PROMPT_SEC = _float_env("CANDIDATE_SILENCE_PROMPT_SEC", 30.0)
CANDIDATE_SILENCE_END_SEC = _float_env("CANDIDATE_SILENCE_END_SEC", 20.0)
PHONE_TERMINAL_REPLY_TIMEOUT_SEC = _float_env("PHONE_TERMINAL_REPLY_TIMEOUT_SEC", 10.0)


def _bounded_float_env(name: str, default: float, lo: float, hi: float) -> float:
    """Read a float env var and CLAMP it — a residency bound that an operator
    can set to zero (or to a week) is not a bound."""
    value = _float_env(name, default)
    if value != value:  # NaN
        return default
    return lo if value < lo else hi if value > hi else value


# ── Bounded room residency (0038 / D-7) ───────────────────────────────
# The entrypoint used to `await _close_event.wait()` with NO wall-clock cap,
# and `participant_disconnected` never initiates a close — so a candidate who
# simply closed the tab left the worker resident in the room until something
# else happened to it. This is that cap.
#
# It is a WALL CLOCK, deliberately, not an attempt counter: a counter that
# gates a control needs its own reset lifecycle or it becomes a one-way latch,
# while a deadline derived from the session's own start resets naturally with
# every new session.
#
# NOT DONE HERE, and refused rather than postponed: driving `close_room_once()`
# from `participant_disconnected`. That would race the worker's `delete_room`
# against the API's `stopEgress`, which is the mechanism most likely to produce
# EGRESS_ABORTED — the exact latch the finalize path was just taught not to
# mis-fire. It is also unnecessary: with the finalize runtime enabled the
# sweeper drives `stopEgress` at `ended_at + grace`, well before the room's own
# 600s empty timeout.
SESSION_MAX_RESIDENCY_SEC = _bounded_float_env(
    "SESSION_MAX_RESIDENCY_SEC", 3600.0, 60.0, 21600.0
)


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw in (None, ""):
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _monotonic() -> float:
    """Monotonic clock seam — replaceable in deterministic tests."""
    return time.monotonic()


def _safe_emit(fn: Callable[..., None], *args: Any, **kwargs: Any) -> None:
    """Emit a metric defensively — an instrumentation failure must never
    alter the session business flow (OBS-06 invariant)."""
    try:
        fn(*args, **kwargs)
    except Exception:  # noqa: BLE001
        pass


def _provider_metric_component(metric: Any) -> str | None:
    name = type(metric).__name__.lower()
    if "llm" in name:
        return "llm"
    if "tts" in name:
        return "tts"
    return None


def _provider_metric_number(metric: Any, *names: str) -> float | None:
    for name in names:
        value = getattr(metric, name, None)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return float(value)
    return None


_TURN_METRIC_FIELDS: tuple[tuple[str, str], ...] = (
    ("transcription_delay", "transcription"),
    ("end_of_turn_delay", "end_of_turn"),
    ("on_user_turn_completed_delay", "turn_hook"),
    ("llm_node_ttft", "llm_first_token"),
    ("tts_node_ttfb", "tts_first_audio"),
    ("playback_latency", "playback"),
    ("e2e_latency", "e2e"),
)


def _record_turn_metrics(item: Any, channel: str) -> None:
    """Emit LiveKit ChatMessage stage timing without content or identifiers."""
    metrics = getattr(item, "metrics", None)
    if not isinstance(metrics, Mapping):
        return
    role = str(getattr(item, "role", "unknown"))
    if role not in {"user", "assistant"}:
        return
    for field, component in _TURN_METRIC_FIELDS:
        value = metrics.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        _safe_emit(
            histogram_metric,
            "voice_turn_stage_duration_sec",
            max(0.0, float(value)),
            {"channel": channel, "component": component, "role": role},
        )


def _record_provider_metrics(event: Any) -> None:
    """Log bounded LLM/TTS timings emitted by LiveKit Agents, when available.

    We intentionally skip STT/EOU here for now per the latency work order.
    Field names differ slightly across SDK versions, so this function probes a
    small allowlist and never logs transcript, room, candidate, request IDs, or
    raw provider payloads.
    """
    metric = getattr(event, "metrics", event)
    component = _provider_metric_component(metric)
    if component is None:
        return

    duration = _provider_metric_number(metric, "duration", "duration_sec", "elapsed")
    ttf = _provider_metric_number(metric, "ttft", "ttfb", "time_to_first_token", "time_to_first_byte")
    if duration is not None:
        _safe_emit(
            histogram_metric,
            "voice_provider_duration_sec",
            duration,
            {"schema": component},
        )
        _log.info(
            "unknown_event",
            error_type="voice_provider_duration",
            schema=component,
            duration_sec=round(duration, 3),
        )
    if ttf is not None:
        _safe_emit(
            histogram_metric,
            "voice_provider_first_signal_sec",
            ttf,
            {"schema": component},
        )
        _log.info(
            "unknown_event",
            error_type="voice_provider_first_signal",
            schema=component,
            duration_sec=round(ttf, 3),
        )


def _start_span_guarded(name: str, parent: Span | None = None) -> Span | None:
    """Start a span defensively — a broken tracer must never break the flow."""
    try:
        return start_span(name, parent)
    except Exception:  # noqa: BLE001
        return None


async def _run_span_guarded(
    name: str, fn: Callable[[Span | None], Any], parent: Span | None = None
) -> Any:
    """Run ``fn`` inside a span (mirrors ``with_span_async``) with a guarded start.

    If span plumbing itself fails (broken tracer), ``fn`` still runs directly —
    instrumentation failure must not alter lifecycle correctness.
    """
    span = _start_span_guarded(name, parent)
    if span is None:
        return await fn(None)
    try:
        return await fn(span)
    except Exception as exc:
        span.set_error(exc)
        raise
    finally:
        span.end()


class Christy(Agent):
    def __init__(self, instructions: str) -> None:
        super().__init__(instructions=instructions)


_FINAL_GOODBYE_RE = re.compile(r"\b(?:good\s*bye|bye|take care)\b", re.IGNORECASE)


def _is_final_goodbye(text: str) -> bool:
    """The prompt reserves these phrases exclusively for the final closing."""
    return bool(_FINAL_GOODBYE_RE.search(text))


async def _close_after_playout(
    speech_handle: Any,
    close_room_once: Callable[[], Any],
) -> None:
    """Wait for final speech playout, then close the room immediately."""
    if speech_handle is not None:
        wait_for_playout = getattr(speech_handle, "wait_for_playout", None)
        if callable(wait_for_playout):
            await wait_for_playout()
    await close_room_once()


async def _await_candidate_activity(
    candidate_activity: asyncio.Event,
    timeout_sec: float,
) -> bool:
    """Wait one silence window. True if activity arrived, False if it lapsed.

    The production seam, and the ONLY place this loop reads a clock. Factored
    out so the termination loop's decisions can be driven deterministically in
    a test instead of by sleeping and hoping — see the loop's own note.
    """
    try:
        await asyncio.wait_for(candidate_activity.wait(), timeout=timeout_sec)
        return True
    except asyncio.TimeoutError:
        return False


async def _silence_termination_loop(
    session: Any,
    candidate_activity: asyncio.Event,
    close_room_once: Callable[[], Any],
    *,
    prompt_after_sec: float,
    end_after_sec: float,
    wait_for_activity: Callable[[asyncio.Event, float], Awaitable[bool]] | None = None,
) -> None:
    """Prompt once per silent period, then speak a final goodbye and close.

    Candidate activity restarts the full silence window. The final room close
    occurs only after the goodbye's SpeechHandle confirms playout.

    ── WHY THE WAIT IS A SEAM ────────────────────────────────────────────
    The behaviour is unchanged: `wait_for_activity` defaults to
    `_await_candidate_activity`, which is exactly the `asyncio.wait_for` this
    loop used inline, and production passes nothing.

    What changes is that a test can decide "activity arrived" or "the window
    lapsed" DIRECTLY, instead of racing a real clock. The test that covered the
    restart used a 50 ms window and asserted 10 ms after setting the event, so
    it failed whenever a loaded runner stalled that assertion sleep past the
    RESTARTED deadline — which is what it did in CI — and it could not detect a
    broken restart at all, because 15 ms is before the original 50 ms deadline.
    Widening the sleeps only moves the race; removing the clock from the
    decision removes it.
    """
    wait = wait_for_activity if wait_for_activity is not None else _await_candidate_activity
    while True:
        candidate_activity.clear()
        if await wait(candidate_activity, prompt_after_sec):
            continue

        prompt_handle = session.say(
            "Are you still there? No worries if you need a moment.",
            allow_interruptions=True,
        )
        await prompt_handle.wait_for_playout()

        candidate_activity.clear()
        if await wait(candidate_activity, end_after_sec):
            continue

        goodbye_handle = session.say(
            "Looks like you're unavailable, so I'll end the screening here. Thanks for your time, and goodbye.",
            allow_interruptions=False,
        )
        await _close_after_playout(goodbye_handle, close_room_once)
        return


async def _delete_livekit_room(room_name: str) -> None:
    """Delete the room so every participant receives a terminal disconnect."""
    client = livekit_api.LiveKitAPI()
    try:
        await client.room.delete_room(livekit_api.DeleteRoomRequest(room=room_name))
    finally:
        await client.aclose()


def _item_text(item: Any) -> str:
    """Extract all text without losing SDK text-only message surfaces."""
    text_content = getattr(item, "text_content", None)
    if isinstance(text_content, str) and text_content.strip():
        return text_content.strip()
    content = getattr(item, "content", None) or []
    chunks: list[str] = []
    for part in content:
        if isinstance(part, str):
            chunks.append(part)
        elif hasattr(part, "text"):
            value = getattr(part, "text", None)
            if isinstance(value, str):
                chunks.append(value)
    return "".join(chunks).strip()


def _turn_anchor_ms(item: Any) -> int | None:
    """Validated millisecond speech-start anchor for a conversation item.

    Primary: ``ChatMessage.metrics['started_speaking_at']`` — the SDK's
    speech-start timestamp (VAD speech start for user turns, TTS start for
    assistant turns; a ``time.time()`` seconds float). Fallback:
    ``ChatMessage.created_at`` — the message-finalization time. Metrics is a
    TypedDict, i.e. a dict at runtime, so only Mapping values are inspected.
    Invalid anchors (bool, NaN/inf, nonpositive, out-of-range) are rejected
    by the persistence normaliser; the next candidate, or NULL, is used so
    the 0026 DB CHECK can never fire on a turn write.
    """
    metrics = getattr(item, "metrics", None)
    if isinstance(metrics, Mapping):
        anchor = persistence.normalize_turn_anchor_ms(metrics.get("started_speaking_at"))
        if anchor is not None:
            return anchor
    created_at = getattr(item, "created_at", None)
    if created_at is None:
        return None
    return persistence.normalize_turn_anchor_ms(created_at)


def _native_turn_predates_question(message: Any, question_anchor_ms: int | None) -> bool:
    """True only when both real anchors prove the final belongs before this ask."""
    started_ms = _turn_anchor_ms(message)
    return (
        started_ms is not None
        and question_anchor_ms is not None
        and started_ms < question_anchor_ms
    )


# ── Bounded session outcome counter mapping (OBS-06) ────────────────
# Fixed, explicit allowlist for the session outcome label.  Values outside this
# fixed set (including any future/unknown terminal reason) map to the bounded
# ``other_failure`` bucket — never dynamic text.  The raw close reason,
# session/candidate IDs, transcript and room names are never emitted.
_SESSION_OUTCOME_ALLOWLIST: dict[str | None, str] = {
    None: "conversation_complete",
    "worker_crash": "worker_crash",
    "shutdown_forced": "shutdown_forced",
    "provider_error": "provider_error",
    # 0038: its own bucket, so a residency timeout never inflates the
    # `other_failure` catch-all or the crash count.
    "residency_timeout": "residency_timeout",
}


def _bounded_outcome(reason: str | None) -> str:
    """Map a terminal reason to a fixed bounded outcome label.

    Unknown or unlisted values map to ``other_failure`` (bounded bucket).
    """
    return _SESSION_OUTCOME_ALLOWLIST.get(reason, "other_failure")


# ── Bounded room-teardown label vocabulary (X7b, 2026-08-29) ──────────
# `_bounded_outcome` above is a session-OUTCOME allowlist: it only knows the
# crash/shutdown/provider/residency buckets, so every HALT reason a phone leg
# ends on (``candidate_ended_call``, ``callback_scheduled``, ``disconnect``,
# ``malformed_exchange``, ``persistence_failed`` …) collapsed into
# ``other_failure`` when the teardown log reused it — a candidate saying goodbye
# and a worker crash were indistinguishable in the one log line that names WHY a
# room was deleted. The teardown gets its own vocabulary covering the real HALT
# strings plus ``completed`` and ``disconnect``; anything unlisted still falls
# back to ``other_failure``. Fixed strings only — never transcript, ids, room.
_ROOM_TEARDOWN_LABELS: dict[str | None, str] = {
    None: "conversation_complete",
    "completed": "conversation_complete",
    "disconnect": "transport_disconnect",
    phone.HALT_CANDIDATE_ENDED: "candidate_ended",
    phone.HALT_NO_ANSWER: "no_exchange_captured",
    phone.HALT_MALFORMED_EXCHANGE: "malformed_exchange",
    phone.HALT_CALLBACK_SCHEDULED: "callback_scheduled",
    phone.HALT_PERSISTENCE: "persistence_failed",
}


def _teardown_label(reason: str | None) -> str:
    """Bounded label for the room-teardown log. Unknown → other_failure."""
    return _ROOM_TEARDOWN_LABELS.get(reason, "other_failure")


# ── Explicit close-reason mapping (SDK enum values only) ──────────────
# None value → conversation_complete (normal completion with explicit signal)
# str value → terminal_reason code (fail case)
_CLOSE_REASON_TO_TERMINAL: dict[str | None, str | None] = {
    None: None,
    "completed": None,
    "normal": None,
    "client_initiated": None,
    # LiveKit Agents 1.6 CloseReason values. A participant leaving the room,
    # an explicit session close, or a completed task are normal terminal paths.
    "participant_disconnected": None,
    "user_initiated": None,
    "task_completed": None,
    "job_shutdown": "shutdown_forced",
    "shutdown": "shutdown_forced",
    "cancelled": "shutdown_forced",
    "timeout": "shutdown_forced",
    "disconnected": "shutdown_forced",
    # X7a (2026-08-29): the verified 1.6.4 `CloseReason.ERROR` value ("error")
    # is what the SDK emits when the AgentSession closes on an unrecoverable
    # error — the exact shape a Sarvam STT websocket death (close 1006 keepalive
    # timeout under CPU starvation) produces. It carries an `error` attribute of
    # type STTError/LLMError/TTSError/RealtimeModelError, whose class name is not
    # in `_CLOSE_ERROR_NAME_TO_TERMINAL`, so it USED TO fall through the error
    # branch to `None` → logged `clean_close`. A transport death is never a clean
    # close. Map it to the `provider_error` FAILURE bucket so the close is
    # labelled truthfully.
    "error": "provider_error",
    "provider_error": "provider_error",
    "stt_error": "provider_error",
    "tts_error": "provider_error",
    "llm_error": "provider_error",
    # ── P4: SIP/telephony disconnect reasons ──────────────────────────
    # Added deliberately narrow. These three are the LiveKit DisconnectReason
    # values a PSTN leg can produce that the browser path never sees; every
    # other reason, phone or not, is left to fall through to `worker_crash`.
    #
    # They map to `provider_error` rather than to a truer name because
    # `fail_session` accepts only the reasons in persistence._FAILED_REASONS
    # and the 0006 CHECK, and widening that pair is a migration this lane does
    # not own. `provider_error` is at least honest about the direction — the
    # telephony leg failed, the worker did not — and, crucially, it is a
    # FAILURE bucket: no completion, no scoring, no scorecard for a call that
    # never had a consenting human on it. The truthful per-attempt outcome is
    # recorded by the 0042 phone events the gate posts, not by this label.
    "user_unavailable": "provider_error",
    "user_rejected": "provider_error",
    "sip_trunk_failure": "provider_error",
}

# Mapping of SDK error type names to terminal_reason codes.
_CLOSE_ERROR_NAME_TO_TERMINAL: dict[str, str | None] = {
    "livekiterror": None,
    "timeouterror": "shutdown_forced",
    "cancellederror": "shutdown_forced",
    "connectionerror": "shutdown_forced",
}


def _close_reason_name(reason: Any) -> str | None:
    if reason is None:
        return None
    raw_reason = getattr(reason, "name", None) or getattr(reason, "value", None) or reason
    return str(raw_reason).lower().rsplit(".", 1)[-1]


def _is_normal_disconnect_reason(reason: Any) -> bool:
    reason_str = _close_reason_name(reason)
    return reason_str in {"completed", "normal", "client_initiated"}


def _classify_close_event(event: Any) -> str | None:
    """Classify a close event into terminal_reason or None (normal complete).

    Uses an explicit mapping of SDK close-status values only.
    Never inspects raw reason text.

    Returns:
      None → conversation_complete (requires explicit completion signal).
      str  → terminal_reason code (fail/shutdown).

    Unknown explicit close reasons still fail closed. However, LiveKit can emit
    a clean close event with neither error nor reason when the candidate leaves
    the room normally. Treat that SDK clean-close shape as conversation_complete
    so recordings and scorecards are produced instead of leaving a false
    worker_crash terminal state.
    """
    reason = getattr(event, "reason", None)
    if reason is not None:
        reason_str = _close_reason_name(reason)
        if reason_str in _CLOSE_REASON_TO_TERMINAL:
            return _CLOSE_REASON_TO_TERMINAL[reason_str]

    error = getattr(event, "error", None)
    if error is not None:
        error_name = type(error).__name__.lower()
        # Check key existence explicitly — None is a valid mapped value
        # (meaning conversation_complete), distinct from "key not found".
        if error_name in _CLOSE_ERROR_NAME_TO_TERMINAL:
            return _CLOSE_ERROR_NAME_TO_TERMINAL[error_name]
        # Unknown AgentSession close errors commonly arrive after a normal
        # participant-initiated disconnect (the SDK logs CLIENT_INITIATED on a
        # separate internal event). Treat the close as conversation_complete;
        # provider/start exceptions are caught by the outer exception path and
        # still fail as worker_crash/provider_error.
        return None

    if reason is not None:
        return "worker_crash"

    # Clean SDK close with no error/reason → normal candidate leave.
    return None


async def _resolve_worker_context_with_retry(
    session_id: str,
    room_name: str,
    *,
    attempts: int,
    backoff_sec: float,
) -> "WorkerContext | str":
    """Resolve worker context, retrying transient failures before giving up.

    ``persistence.resolve_worker_context`` returns a WorkerContext on success or
    a stable error-category string on failure. A single failure used to abandon
    the whole call (candidate joined, no bot). Because the API is scale-to-zero,
    the first lookup after a cold start can transiently fail; retry a bounded
    number of times with a fixed backoff, then return the last error so the
    caller can fail closed. Retrying a genuinely-absent/unauthorized session is
    harmless — it stays unresolved and still fails closed.
    """
    attempts = max(1, attempts)
    resolved: "WorkerContext | str" = "context_api_error"
    for attempt in range(attempts):
        resolved = await persistence.resolve_worker_context(session_id, room_name)
        if isinstance(resolved, WorkerContext):
            return resolved
        if attempt + 1 < attempts:
            _log.warn(
                "worker_context_resolution_retry",
                error_category=str(resolved),
                attempt=attempt + 1,
            )
            await asyncio.sleep(max(0.0, backoff_sec))
    return resolved


# ── P4: worker isolation (browser vs phone) ───────────────────────────
# The existing worker registers with NO `agent_name`, which means LiveKit
# auto-dispatches it into EVERY room in the project — including the phone rooms
# the dialer provisions. Setting `agent_name` on this worker would silently stop
# browser screening, so the default stays unnamed and instead learns to RECOGNISE
# a phone room and refuse it. The named phone worker is a separate deployment,
# enabled by PHONE_AGENT_NAME; rolling it back is not deploying it, which needs
# no change to the browser path at all.

_PARTICIPANT_POLL_SEC = 0.25


def _phone_agent_name() -> str:
    """The named phone worker's dispatch name, or "" for the default worker.

    Read at call time, not at import: the default must be observable as a
    default, and a test that cannot change it cannot prove it.
    """
    return (os.getenv("PHONE_AGENT_NAME") or "").strip()


def _room_metadata_from_context(ctx: JobContext) -> Any:
    """Room metadata blob, if the SDK has one yet. Never logged, never parsed
    for anything except the channel marker."""
    metadata = phone.room_metadata_of(ctx)
    if metadata:
        return metadata
    job = getattr(ctx, "job", None)
    job_room = getattr(job, "room", None)
    return getattr(job_room, "metadata", None)


def _worker_handles_room(room_name: str, room_metadata: Any) -> bool:
    """Does THIS worker own this room?

    Diagnostic candidate preflight rooms are provider-only and must never
    dispatch an interviewer, resolve session context, persist, or record.
    Symmetric, deliberately: the unnamed browser worker handles everything that
    is not a phone room, and the named phone worker handles nothing else.
    """
    if phone.is_preflight_room(room_metadata):
        return False
    is_phone = phone.is_phone_room(room_name, room_metadata)
    return is_phone if _phone_agent_name() else not is_phone


def build_worker_options() -> WorkerOptions:
    """Construct WorkerOptions, naming the worker ONLY when configured.

    Unset/empty PHONE_AGENT_NAME must produce byte-for-byte the options the
    browser worker has always had — no `agent_name` key at all, so automatic
    dispatch is untouched.
    """
    options: dict[str, Any] = {
        "entrypoint_fnc": entrypoint,
        # The browser worker keeps its zero-idle memory posture. The named
        # phone worker is a separate 2 GB app and keeps ONE process warm: the
        # production call at 09:00 waited for an on-demand process before the
        # first turn, an avoidable cold-path delay that did not exist at the
        # conversational layer.
        "num_idle_processes": 1 if _phone_agent_name() else 0,
        "initialize_process_timeout": 60.0,
        "job_memory_warn_mb": 1400,
        "job_memory_limit_mb": 0,
    }
    agent_name = _phone_agent_name()
    if agent_name:
        options["agent_name"] = agent_name
    return WorkerOptions(**options)


async def _wait_for_sip_participant(ctx: JobContext, timeout_sec: float) -> Any:
    """Wait, bounded, for a participant to actually appear in the room.

    Returns the participant or None on timeout. A SIP leg being up is not proof
    of a human — this only establishes that SOMETHING answered, which is the
    earliest moment at which speaking is not speaking into a ringing line.
    """
    deadline = _monotonic() + max(0.0, timeout_sec)
    while True:
        room = getattr(ctx, "room", None)
        participants = getattr(room, "remote_participants", None)
        values = getattr(participants, "values", None)
        if callable(values):
            for participant in list(values()):
                if participant is not None:
                    return participant
        if _monotonic() >= deadline:
            return None
        await asyncio.sleep(_PARTICIPANT_POLL_SEC)


# ── P4: the default answer classifier ─────────────────────────────────
# A bounded, deterministic rule set over the FIRST spoken response to the
# disclosure. It is the default for an injectable seam, and it is deliberately
# conservative: only an explicit affirmative is consent. Anything it cannot
# read as one of the five outcomes is a machine, because a machine gets no
# assessment, no recording and no scorecard — the safe direction to be wrong in.

_MACHINE_RE = re.compile(
    r"leave (?:a )?(?:your )?message|after the (?:tone|beep)|voice\s?mail|"
    r"not available (?:right now|at the moment)|record your message|"
    r"press \d|unable to take your call",
    re.IGNORECASE,
)
_WRONG_NUMBER_RE = re.compile(
    r"wrong number|no one (?:by|with) that name|nobody (?:by|with) that name|"
    r"you(?:'ve| have) got the wrong",
    re.IGNORECASE,
)
_OPT_OUT_RE = re.compile(
    r"do(?:n't| not) (?:ever )?call(?: me)?(?: again)?|stop calling|"
    r"remove (?:my|this) number|take me off",
    re.IGNORECASE,
)
_REFUSED_RE = re.compile(
    r"do(?:n't| not) record|no recording|not (?:comfortable|okay|ok) with|"
    r"^\s*(?:no|nope|no thanks|not interested)\b",
    re.IGNORECASE,
)
# Anchored deliberately. An affirmative has to BE the answer: matching "sure"
# anywhere in the sentence reads "I'm not sure" as consent, which is the one
# false positive this whole file exists to prevent.
_AFFIRMATIVE_RE = re.compile(
    r"^\s*(?:well|um|uh|so|hi|hello|hey)?[\s,]*"
    r"(?:yes|yeah|yep|yup|sure|okay|ok|go ahead|that(?:'s| is) fine|"
    r"fine|please do|carry on|of course)\b",
    re.IGNORECASE,
)


def classify_answer_text(text: str) -> str | None:
    """Map one spoken response to a gate outcome, or None if unreadable.

    Order matters: opt-out and wrong-number are checked before refusal, because
    "don't call me again" is both, and the stronger, more suppressive reading is
    the one the candidate meant.
    """
    value = (text or "").strip()
    if not value:
        return None
    if _MACHINE_RE.search(value):
        return phone.CLASSIFY_MACHINE
    if _WRONG_NUMBER_RE.search(value):
        return phone.CLASSIFY_WRONG_NUMBER
    if _OPT_OUT_RE.search(value):
        return phone.CLASSIFY_OPT_OUT
    if _REFUSED_RE.search(value):
        return phone.CLASSIFY_REFUSED
    if _AFFIRMATIVE_RE.search(value):
        return phone.CLASSIFY_HUMAN
    return None


# ── P4: the phone session ─────────────────────────────────────────────
# Reached only by the NAMED phone worker, and only for a phone room. Nothing in
# here touches persistence: a phone attempt's lifecycle lives in 0042 and is
# advanced by the internal worker events this flow posts, so the worker has no
# business writing call_sessions rows on this path.

# Recording is OFF at session start, unconditionally. The one and only moment at
# which it may exist is after `disclosure.delivered` is accepted — see
# `_phone_recording_permitted`.
#
# THE SAME OBJECT, not a second literal. The canonical definition moved into
# `phone.py` when Canary-1 gained its own session start: two files each holding
# their own copy of "recording is off" is exactly how one of them silently stops
# saying it, and the canary's spoken disclosure claims "this call is not being
# recorded". This alias keeps every existing reader of `_PHONE_NO_RECORDING`
# working while making `phone.PHONE_NO_RECORDING` the single source.
_PHONE_NO_RECORDING = phone.PHONE_NO_RECORDING


async def _phone_recording_permitted() -> None:
    """The single legal call site for "recording may now exist".

    The worker does not start egress itself — the API half attaches attempt
    egress when it applies `disclosure.delivered`, which is the same event whose
    acceptance is the precondition here. This seam exists so that the ordering
    is observable in a test, and so that any future worker-side recording has
    exactly one place it is allowed to be called from. It must never be reached
    on the machine, refusal, opt-out, wrong-number or no-participant paths.
    """
    _log.info("unknown_event", error_type="phone_recording_permitted")


async def _classify_phone_answer(
    turns: "asyncio.Queue[str]",
    say: Callable[[str], Any],
    *,
    attempts: int = 2,
    consumed: "list[str] | None" = None,
) -> str:
    """Read the response to the disclosure, re-asking at most once.

    Turn-bounded here; wall-clock-bounded by the gate, which runs this under a
    hard timeout — so neither a silent line nor an endlessly chatty one can keep
    the call in the unclassified state where recording is forbidden and the
    conversation has not started.

    Every utterance this consumes is appended to ``consumed`` when provided, so
    the gate can read the RAW consent reply (the last consumed text) it decided
    HUMAN on and commit it as the candidate half of the gate transcript. The
    classifier reads it; the gate records it — no text is inferred after.
    """
    for attempt in range(max(1, attempts)):
        text = await turns.get()
        if consumed is not None and isinstance(text, str) and text.strip():
            consumed.append(text)
        decision = classify_answer_text(text)
        if decision is not None:
            return decision
        if attempt + 1 < attempts:
            await say(phone.PHONE_REASK_TEXT)
    return phone.CLASSIFY_MACHINE


def _role_turn_line(role_title: str | None) -> str | None:
    """The verbatim role line appended to EVERY per-turn phone instruction (X3c).

    Returns None when no role is known, so a role-less state adds nothing rather
    than a hollow "the role is exactly: none". The title is used VERBATIM from
    the server-verified assessment state — never invented, never a placeholder
    like "software engineer" (the exact wrong title a live call spoke on
    2026-08-29 when the role reached the LLM only through the best-effort
    `update_instructions` mutation, which is a no-op on the read-only 1.6.4
    `Agent.instructions` property).
    """
    role = (role_title or "").strip()
    if not role:
        return None
    return (
        f'The role is exactly: "{role}" — always name it exactly if asked; '
        "never invent a job title."
    )


def phone_question_instructions(
    question: "phone.PhonePlanQuestion", role_title: str | None = None,
) -> str:
    """The instruction handed to the model for ONE plan question.

    The model may phrase it however it likes — that is the whole point of a
    voice screening — but it is told exactly which question it is covering,
    and it is told not to move on. Which question was covered is never
    inferred afterwards from what was said; it comes from this call site and
    from the key committed with the answer.

    X3c: the verbatim role line is appended here so EVERY per-turn instruction
    carries the role, independent of whether the system-prompt mutation reached
    the live LLM context. `role_title` defaults to None (no line) so the browser
    lane and any role-less caller are byte-unchanged.
    """
    lines = [
        "Continue the live phone conversation naturally, then ask this one planned question:",
        question.text,
        "",
        "Briefly acknowledge the candidate's latest substantive answer when "
        "there is one. Ask exactly ONE question in this response. Do not move "
        "past the planned topic, summarise the call, or say goodbye. Treat "
        "resume details as unverified claims: never present them as confirmed "
        "employment history.",
    ]
    if question.hint:
        lines.append(f"If their answer is thin, the thing worth probing is: {question.hint}")
    role_line = _role_turn_line(role_title)
    if role_line is not None:
        lines.append(role_line)
    return "\n".join(lines)


def _compact_phone_resume_evidence(evidence: Any) -> dict[str, Any]:
    """Bound phone prompt evidence to what can improve the next spoken turn."""
    if not isinstance(evidence, dict):
        return {}
    compact: dict[str, Any] = {}
    for key in ("name", "current_role", "experience_years"):
        if key in evidence:
            compact[key] = evidence[key]
    recent = evidence.get("recent_role")
    if isinstance(recent, dict):
        compact["recent_role"] = {
            key: recent[key] for key in ("title", "employer", "period")
            if key in recent
        }
        highlights = recent.get("highlights")
        if isinstance(highlights, list):
            compact["recent_role"]["highlights"] = highlights[:2]
    for key, limit in (("prior_roles", 2), ("skills", 12), ("career_highlights", 3)):
        value = evidence.get(key)
        if isinstance(value, list):
            compact[key] = value[:limit]
    summary = evidence.get("summary")
    if isinstance(summary, str):
        compact["summary"] = summary[:300]
    return compact


def _phone_instructions_text(state: "phone.PhoneAssessmentState") -> str:
    """Build the bounded role/evidence instructions shared by native and legacy phone agents.

    Every block appended AFTER `system_prompt` here is PHONE-ONLY. The browser
    (WebRTC) prompt surface is sha-pinned (`tests/test_browser_prompt_pin.py`),
    and the browser lane renders only `system_prompt`, so these appends cannot
    shift it. The resume-conflict directive (X10) is added ONLY when compacted
    resume evidence is actually present, so a role-less / resume-less call never
    carries a dangling reference to facts the model was not given.
    """
    compact_resume = _compact_phone_resume_evidence(state.resume_facts)
    text = system_prompt(
        candidate_name=state.candidate_name,
        role_title=state.role_title,
        role_focus=(state.role_focus or ", ".join(state.role_required_skills))[:600],
        resume_facts=prompting_format_resume_facts(compact_resume),
        questions=(
            "The exact currently owed question is supplied separately for "
            "each response. Never select or advance a question yourself."
        ),
        interviewer_instructions=(state.interviewer_instructions or "")[:2000],
    )
    text = (
        text
        + phone.PHONE_CALLBACK_POLICY_TEXT
        + phone.PHONE_ROLE_GROUNDING_TEXT
        + phone.PHONE_TURN_DISCIPLINE_TEXT
        + phone.PHONE_EXPRESSIVENESS_TEXT
    )
    # Resume-conflict probing rides the compacted evidence: only offer the
    # directive when there is evidence to reconcile against. Omitting it when
    # `compact_resume` is empty keeps the reference from dangling.
    if compact_resume:
        text = text + phone.PHONE_RESUME_CONFLICT_TEXT
    resume = phone.render_resume_context(state.turns)
    return f"{text}\n\n{resume}" if resume else text


async def _apply_phone_instructions(agent: Any, state: "phone.PhoneAssessmentState") -> bool:
    """Give the agent the REAL instructions, once the plan is known.

    The full question bank is deliberately NOT repeated in the system prompt:
    the durable loop supplies exactly one owed question to each generation.
    The plan's `key` is also absent: the model is never asked to report which
    question it covered, because identity comes from the call site and the
    committed key — never from prose.

    A RESUMING leg also gets the persisted exchange replayed into the prompt,
    bounded by `phone.render_resume_context`, so the model can refer to what the
    candidate already said instead of starting the conversation over. It is
    never asked to work out from that transcript which questions REMAIN — that
    comes from the cursor, and inferring question identity from prose is the
    failure this whole phase exists to prevent.

    Best effort by design. If the SDK's Agent has no writable `instructions`,
    the screening still runs on the base prompt and every boundary is still
    keyed and committed correctly; the questions are simply less tailored.

    X3b (2026-08-29 role-determinism): after delivery, VERIFY the role title
    actually reached the agent instead of trusting the mutation blindly. On
    livekit-agents 1.6.4 `update_instructions` routes to the live `_activity`
    when the session is running and does NOT update the readable `instructions`
    property, so a read-back can be stale even on success — the check is
    therefore best-effort and only ever RAISES A LOUD LOG, never fails the leg.
    Determinism does not depend on this mutation landing: the role is appended
    to every per-turn instruction (see `_role_turn_line`), which is the path the
    live LLM provably reads. This log is the observability that was missing when
    a call spoke the wrong job title on 2026-08-29.
    """
    text = _phone_instructions_text(state)
    try:
        delivered = await _deliver_phone_instructions(agent, text)
    except Exception:  # noqa: BLE001
        _log.warn(
            "unknown_event", error_type="phone_instructions_not_applied",
            error_category="agent_instructions",
        )
        return False
    _verify_role_instructions_applied(agent, state.role_title, text)
    return delivered


def _verify_role_instructions_applied(
    agent: Any, role_title: str | None, applied_text: str,
) -> None:
    """Log loudly if the role title is absent from the effective instructions.

    Read-back never fails the leg (see `_apply_phone_instructions`). It reads the
    best surface 1.6.4 exposes — the `instructions` property when it is a plain
    string — and falls back to the text WE built and handed to the mutator, so a
    stale property read does not produce a false alarm. Fixed error categories
    only; never the title, transcript, ids or room name.
    """
    role = (role_title or "").strip()
    if not role:
        # No role to assert — nothing to verify, and nothing was owed.
        return
    effective = getattr(agent, "instructions", None)
    if not isinstance(effective, str) or role not in effective:
        # Fall back to what we actually delivered: the mutator may have routed
        # the update to the live activity, leaving the readable property stale.
        effective = applied_text
    if role not in effective:
        _log.warn(
            "unknown_event", error_type="phone_instructions_not_applied",
            error_category="role_title_absent",
        )


async def _deliver_phone_instructions(agent: Any, text: str) -> bool:
    """Hand new instructions to a RUNNING agent, and say whether it took.

    `Agent.instructions` is a read-only property on livekit-agents 1.6; the
    supported mutator is `await agent.update_instructions(...)`. A bare
    `setattr` therefore raises on the real SDK and succeeds on a stub — which
    is the worst possible combination, because the tests would be green while
    the candidate's name, the question flow and the resume replay never reached
    the model at all.

    So the mutator is tried FIRST and the attribute write is the fallback, and
    the function REPORTS whether either worked rather than swallowing it. The
    caller logs a failure; the screening still runs, and every boundary is
    still keyed and committed correctly, because the question text is passed to
    `generate_reply` directly and never read back out of the prompt.
    """
    update = getattr(agent, "update_instructions", None)
    if callable(update):
        try:
            result = update(text)
            if inspect.isawaitable(result):
                await result
            return True
        except Exception:  # noqa: BLE001
            pass
    try:
        setattr(agent, "instructions", text)
        return True
    except Exception:  # noqa: BLE001
        return False


def _build_provider_session(*, phone_mode: bool = False, turn_mode: str | None = None) -> Any:
    """The one provider/turn-session construction used by WebRTC and phone.

    Extracted verbatim from `_run_phone_session` — same kwargs, same env reads,
    same order, no behaviour change — so that the Canary-1 branch drives the
    SAME Sarvam STT, Sarvam TTS and Gemini configuration production drives.

    Without this the canary would be a second copy of the model wiring, and a
    drifting `SARVAM_TTS_VOICE`, `GEMINI_MODEL` or `GEMINI_BASE_URL` would make
    Canary-1 green while production was broken. This repository has already paid
    for a duplicated vocabulary that failed silently when the two copies
    diverged; a green canary that proves nothing about production is the same
    defect with a worse blast radius, because it is the thing standing between a
    deploy and a real candidate's phone ringing.

    NOTE what this shares and what it does not. It shares the PROVIDER
    PIPELINE. It does not share `phone.phone_agent_class`, its function tools,
    the human/machine classifier or `run_phone_gate`'s ordering — the canary
    drives a bare `Agent`. See `docs/runbooks/phone-canary1.md` for the list of
    what a green canary run does and does not evidence.
    """
    session_options: dict[str, Any] = {}
    if phone_mode:
        # Phone's durable cursor selects the next question after the user turn,
        # while LiveKit may already be preparing a speculative reply. The
        # coordinator injects the per-turn instruction inside
        # `on_user_turn_completed`, which ALWAYS invalidates the speculation —
        # the live call on 2026-08-28 logged "chat context or tools have
        # changed after on_user_turn_completed" on every substantive turn, so
        # the lane paid for a Gemini request it then discarded, every time.
        # Disabling it here matches what this comment has always claimed.
        # AgentSession still owns EOU, interruption, scheduling and playout.
        #
        # TOOLLESS re-enables speculation. The reason it was disabled above is
        # the tool-first lane's DISCARD: the muzzled required-tool pass ran a
        # Gemini request the lane threw away every substantive turn. Toolless has
        # no muzzled pass — it is one ordinary generation — so speculating it is
        # a real latency win. The per-turn instruction is still injected in
        # `on_user_turn_completed`; if the SDK invalidates the speculation
        # because of that, it simply falls back to a normal generation, which is
        # no worse than today's always-normal path — so leave it ON regardless.
        session_options["preemptive_generation"] = (
            turn_mode == phone.PHONE_TURN_MODE_TOOLLESS
        )
        # X8 (2026-08-29 CPU-starvation): rollback-first endpointing offload. On
        # `local` (DEFAULT) nothing is added here — the SDK's default local
        # endpointing (Silero VAD + v1-mini EOU) runs exactly as today, so
        # merging changes nothing. On `stt` the phone session delegates
        # end-of-utterance to the STT provider (Sarvam runs `vad_signals=true`),
        # moving that decision off the worker's own VAD/EOU compute. PHONE ONLY:
        # this whole block is `phone_mode`-gated, so the browser session never
        # receives `turn_detection`. Logged once below at construction.
        turn_detection = phone.phone_turn_detection()
        if turn_detection == phone.PHONE_TURN_DETECTION_STT:
            session_options["turn_detection"] = "stt"
        _log.info(
            "unknown_event", error_type="phone_turn_detection",
            error_category=turn_detection,
        )

    session = AgentSession(
        stt=sarvam.STT(
            model=os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
            language=os.getenv("SARVAM_LANGUAGE", "en-IN"),
        ),
        tts=sarvam.TTS(
            model=os.getenv("SARVAM_TTS_MODEL", "bulbul:v3"),
            speaker=os.getenv("SARVAM_TTS_VOICE", "simran"),
        ),
        llm=openai.LLM(
            model=GEMINI_MODEL,
            api_key=os.getenv("GEMINI_API_KEY"),
            base_url=GEMINI_BASE_URL,
        ),
        **session_options,
    )

    # The browser path already emitted these bounded provider timings; the
    # phone construction site did not register the handler, leaving the exact
    # first/second-turn latency complaint unmeasurable. The shared recorder
    # logs timings and component names only — never transcript, room or IDs.
    @session.on("metrics_collected")
    def _on_phone_metrics_collected(event):  # noqa: ANN001
        _record_provider_metrics(event)

    return session


def _build_phone_provider_session(turn_mode: str | None = None) -> Any:
    """Phone seam delegates to the shared provider session factory."""
    return _build_provider_session(phone_mode=True, turn_mode=turn_mode)


async def _run_phone_entrypoint(ctx: JobContext, room_name: str) -> None:
    """Named-worker entry for a phone room.

    The attempt id comes off the per-attempt DISPATCH metadata, never off the
    room name: the room is keyed by SESSION so one session's reconnect attempts
    share a transcript, and a session id posted as an ``attempt_id`` resolves to
    no attempt at all — every event would come back ``ignored:
    unknown_attempt`` and nothing would ever be recorded for the call.
    """
    # ── Canary-1: the three-condition branch, before anything else ────
    # ALL THREE must hold: the worker is armed by its own Fly secret, the
    # DISPATCH says `mode == "canary"`, and the ROOM says `canary is true`.
    # Any one of them missing is the existing behaviour, untouched.
    #
    # Two independent signals rather than one, and both from closed-key blobs
    # that the production builders structurally cannot emit. A mismatch is a
    # refusal, never a fallback: "the dispatch looked like a canary so we
    # treated it as one" is how a real candidate ends up in a branch that posts
    # no events and commits no boundaries.
    #
    # Placed BEFORE attempt-id resolution because a canary dispatch carries no
    # attempt id by design. That is also why a DISARMED worker refuses it here
    # and returns before `ctx.connect()` — the mechanism's strongest control is
    # that its dispatch is inert on any worker that has not been armed.
    if phone.phone_canary_enabled():
        room_metadata = _room_metadata_from_context(ctx)
        if phone.canary_mode_of(ctx) is not None and phone.is_canary_room(room_metadata):
            canary_id = phone.canary_id_of(ctx)
            if canary_id is None:
                _log.warn(
                    "unknown_event",
                    error_type="phone_canary_refused",
                    error_category="canary_id_missing",
                )
                return
            await phone_canary.run_phone_canary(
                ctx,
                room_name,
                canary_id,
                session_factory=_build_phone_provider_session,
                agent_factory=Agent,
                close_room=_close_phone_room,
                # The PRODUCTION wait function, with the CANARY's own bound.
                # Reusing the function keeps one implementation of "has
                # anything answered yet"; the separate bound exists because
                # this clock starts at job assignment and must cover dispatch
                # scheduling, a cold worker start and the whole ring window.
                wait_for_participant=lambda: _wait_for_sip_participant(
                    ctx, phone.canary_participant_wait_sec()
                ),
            )
            return

    attempt_id = phone.attempt_id_from_dispatch_metadata(ctx)
    if attempt_id is None:
        # No attempt to post events against. Fail closed: do not connect, do not
        # speak, do not activate, do not record, do not post. A call the system
        # cannot account for is one the worker must not conduct.
        _log.warn(
            "unknown_event",
            error_type="phone_dispatch_unresolved",
            error_category="attempt_id_missing",
        )
        return
    # ── NO EPOCH, NO CALL ─────────────────────────────────────────────
    # The epoch is not decoration on the heartbeat; it is the heartbeat's
    # entire claim to the lease. Without it this leg cannot renew the
    # concurrency lease, and a leg that cannot renew its lease will have the
    # slot reclaimed out from under a live conversation part-way through the
    # screening — the candidate keeps talking, the attempt is marked
    # `abandoned`, the engagement leaves `in_call`, and the assessment this leg
    # scores is discarded because its edge is gated on `in_call`.
    #
    # So this is refused in the SAME direction as a missing attempt id, and for
    # a stronger reason: an unaccountable call is bad, and a call that will
    # silently destroy a screening it has already conducted is worse. Running
    # "without a heartbeat" is not a degraded mode; it is the defect.
    epoch = phone.epoch_from_dispatch_metadata(ctx)
    if epoch is None:
        _log.warn(
            "unknown_event",
            error_type="phone_dispatch_unresolved",
            error_category="epoch_missing",
        )
        return
    await _run_phone_session(ctx, room_name, attempt_id, epoch)


async def _run_native_phone_screening(
    *,
    session: Any,
    agent: Any,
    events: Any,
    state: Any,
    attempt_id: str,
    session_id: str,
    room_name: str,
    result: phone.PhoneGateResult,
    latest_assistant: list[str | None],
    latest_assistant_anchor: list[int | None],
    latest_candidate_anchor: list[int | None],
    candidate_end_requested: asyncio.Event,
    reply_started: asyncio.Event,
    reply_handle: list[Any],
    assistant_delivery_complete: asyncio.Event,
    candidate_activity: asyncio.Event,
    agent_listening: asyncio.Event,
    agent_activity_changed: asyncio.Event,
    close_event: asyncio.Event,
    turn_mode: str = phone.PHONE_TURN_MODE_TOOLFIRST,
) -> phone.PhoneGateResult:
    """Run post-consent screening through LiveKit's native turn lifecycle.

    The durable question cursor remains server-owned, but this coordinator is
    deliberately not an audio scheduler: ``on_user_turn_completed`` commits
    the completed boundary, updates the next-topic instruction, and returns.
    LiveKit then performs the one ordinary reply, interruption, and playout.
    """
    cursor = state.cursor
    completed = list(state.completed_keys)
    finished = asyncio.Event()
    terminal_reason: dict[str, str] = {}
    terminal_reply_required = {"value": False}
    closing = ClosingStateMachine()
    silence_prompted = {"value": False}
    # The coordinator owns pending evidence; durable effects happen only from
    # coordinator-bound tools after LiveKit authorizes the scheduled reply.
    reply_plan: list[str | None] = [None]
    pending: dict[str, Any] = {
        "question": None, "prompt": None, "candidate": None,
        "message": None, "probe_used": False, "source_event_id": None,
    }
    # The last successful advance result for the CURRENT reply. Gemini may
    # emit two advance calls in one step, or a second one after the first
    # resolved; both used to read an empty `pending` and halt the whole call
    # (`HALT_PERSISTENCE`, observed live 2026-08-28). A duplicate advance is
    # answered with the SAME instruction instead — the durable commit is
    # idempotent on `source_event_id`, so nothing double-writes.
    last_advance: dict[str, str | None] = {"text": None}
    # F0b — MALFORMED-EXCHANGE GUARD RECOVERY STATE. The guard below used to
    # `finished.set()` the instant it saw an empty question prompt, and the main
    # loop then deleted the room — silently killing a healthy call (live
    # 2026-08-29). A single empty read is far more likely a transient tracking
    # race than a genuine malfunction, so the guard now RE-ASKS the planned
    # question once and lets the conversation continue. Only a SECOND consecutive
    # empty read at the SAME cursor position is treated as a real malfunction and
    # allowed to end the call. This records the cursor the guard last recovered
    # at, so consecutive-at-the-same-position can be distinguished from a single
    # recovered blip that later advanced normally.
    malformed_guard: dict[str, int | None] = {"recovered_cursor": None}
    # TOOLLESS: background boundary-commit tasks. In toolless mode the durable
    # commit is moved OFF the speech path — it runs after the assistant reply is
    # delivered instead of inside a muzzled tool leg. These tasks are retained so
    # the terminal teardown can cancel any still in flight; a small, bounded set
    # (one per candidate turn) that lives only for the leg.
    commit_tasks: set[asyncio.Task] = set()

    async def wait_for_activity(timeout: float) -> str:
        """Wait on LiveKit activity or close without creating a turn queue."""
        activity = asyncio.create_task(candidate_activity.wait())
        agent_changed = asyncio.create_task(agent_activity_changed.wait())
        closed = asyncio.create_task(close_event.wait())
        try:
            done, _ = await asyncio.wait(
                (activity, agent_changed, closed), timeout=max(0.0, timeout),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if closed in done:
                return "closed"
            if activity in done:
                return "activity"
            if agent_changed in done:
                return "agent_state"
            return "timeout"
        finally:
            for task in (activity, agent_changed, closed):
                if not task.done():
                    task.cancel()
            await asyncio.gather(activity, agent_changed, closed, return_exceptions=True)

    async def native_silence_loop() -> None:
        """Use LiveKit state/activity as the only phone inactivity authority."""
        while not finished.is_set():
            if not agent_listening.is_set():
                ready = asyncio.create_task(agent_listening.wait())
                closed = asyncio.create_task(close_event.wait())
                try:
                    done, _ = await asyncio.wait(
                        (ready, closed), return_when=asyncio.FIRST_COMPLETED,
                    )
                    if closed in done and not finished.is_set():
                        terminal_reason.setdefault("reason", "disconnect")
                        finished.set()
                finally:
                    for task in (ready, closed):
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(ready, closed, return_exceptions=True)
                continue
            candidate_activity.clear()
            agent_activity_changed.clear()
            outcome = await wait_for_activity(CANDIDATE_SILENCE_PROMPT_SEC)
            if outcome != "timeout":
                if outcome == "closed" and not finished.is_set():
                    terminal_reason.setdefault("reason", "disconnect")
                    finished.set()
                continue
            silence_prompted["value"] = True
            prompt = session.say(
                phone.PHONE_SILENCE_PROMPT_TEXT,
                allow_interruptions=True,
            )
            wait = getattr(prompt, "wait_for_playout", None)
            if callable(wait):
                await wait()
            if candidate_activity.is_set():
                continue
            candidate_activity.clear()
            # Ignore the prompt's own speaking→idle transitions. New agent
            # activity in the second window still wakes the wait below.
            agent_activity_changed.clear()
            outcome = await wait_for_activity(CANDIDATE_SILENCE_END_SEC)
            if outcome != "timeout":
                continue
            goodbye = session.say(
                phone.PHONE_SILENCE_GOODBYE_TEXT,
                allow_interruptions=True,
            )
            wait = getattr(goodbye, "wait_for_playout", None)
            if callable(wait):
                await wait()
            if (
                not finished.is_set()
                and not candidate_activity.is_set()
                and not close_event.is_set()
            ):
                terminal_reason.setdefault("reason", phone.HALT_NO_ANSWER)
                finished.set()

    silence_task = asyncio.create_task(native_silence_loop())

    def add_turn_instruction(turn_ctx: Any, text: str) -> None:
        """Add an instruction only to the SDK's temporary context for this reply."""
        add_message = getattr(turn_ctx, "add_message", None)
        if callable(add_message):
            add_message(role="developer", content=text)
            return
        items = getattr(turn_ctx, "items", None)
        if isinstance(items, list):
            items.append({"role": "developer", "content": text})
            return
        raise RuntimeError("phone_turn_context_unavailable")

    async def wait_for_terminal_reply() -> bool:
        try:
            await asyncio.wait_for(
                reply_started.wait(), timeout=PHONE_TERMINAL_REPLY_TIMEOUT_SEC,
            )
        except asyncio.TimeoutError:
            return False
        handle = reply_handle[0]
        wait = getattr(handle, "wait_for_playout", None)
        if callable(wait):
            value = wait()
            if inspect.isawaitable(value):
                await value
        if handle is not None and closing.state is ClosingState.CLOSING_PENDING:
            closing.closing_delivered()
        return handle is not None

    async def on_native_turn(
        text: str, message: Any = None, turn_ctx: Any = None,
    ) -> None:
        # This hook routes and buffers only. It never changes the cursor or
        # writes transcript evidence; those effects belong to the tools below.
        reply_plan[0] = None
        if finished.is_set():
            from livekit.agents import StopResponse  # noqa: PLC0415
            raise StopResponse()
        if candidate_end_requested.is_set() or phone.is_explicit_end_call_request(text):
            candidate_end_requested.set()
            reply_plan[0] = phone.PHONE_CANDIDATE_END_TEXT
            add_turn_instruction(turn_ctx, "Say exactly the candidate-end compliance closing: end the call now, thank the candidate, and say goodbye. Do not ask another question.")
            terminal_reply_required["value"] = True
            terminal_reason["reason"] = phone.HALT_CANDIDATE_ENDED
            finished.set()
            return
        if closing.state is ClosingState.CANDIDATE_QNA:
            closing.candidate_questions_handled()
            setattr(agent, "_turn_policy", "closing")
            terminal_reply_required["value"] = True
            terminal_reason["reason"] = "completed"
            finished.set()
            add_turn_instruction(turn_ctx, "Answer the candidate's question briefly if they asked one. Then thank them, say the team will be in touch, and say goodbye. Do not ask another question.")
            return
        question = state.question_at(cursor)
        if silence_prompted["value"]:
            silence_prompted["value"] = False
            if question is not None:
                add_turn_instruction(turn_ctx, phone_question_instructions(question, state.role_title))
            return
        # A proposal is a two-turn protocol. Its pending state is local to this
        # live worker and the server confirmation RPC is the durable boundary.
        if getattr(agent, "callback_confirmation_pending", lambda: False)():
            decision = phone.callback_confirmation_decision(text)
            setattr(agent, "_turn_policy", "callback")
            if decision == "confirmed":
                add_turn_instruction(
                    turn_ctx,
                    "The candidate explicitly confirmed the exact callback read-back. "
                    "Call confirm_callback now and do not speak before its result.",
                )
            elif decision == "declined":
                getattr(agent, "clear_callback_proposal")()
                add_turn_instruction(
                    turn_ctx,
                    "The candidate did not confirm that time. Ask for an exact new "
                    "IST date and time, then call propose_callback only after it is clear. "
                    "Do not book or advance the interview.",
                )
            else:
                setattr(agent, "_turn_policy", "clarification")
                add_turn_instruction(
                    turn_ctx,
                    "Ask only whether the exact callback date and India time you just "
                    "read back are correct. Do not book until the candidate says yes.",
                )
            return
        # ROUTE CHECKS FIRST (X10). The bounded conversational routes —
        # end-call, callback deferral, role/general clarification, connectivity —
        # are recognised BEFORE the patience gate so a SHORT clarification like
        # "can you repeat the question" still routes to a spoken reply instead of
        # being suppressed as a fragment. The one exception is the `hesitation`
        # route: when the patience gate is on, a bare filler is SUPPRESSED (the
        # bot stays silent and the fragment stays in context) rather than being
        # answered with a re-ask, which is the pre-X10 behaviour that made the
        # bot respond to thinking-out-loud on the stt-endpointing path.
        patience_on = phone.phone_patience_gate_enabled()
        route = phone.candidate_turn_route(text)
        if route is not None:
            if route == "hesitation":
                if patience_on:
                    setattr(agent, "_turn_policy", "patience_suppressed")
                    from livekit.agents import StopResponse  # noqa: PLC0415
                    raise StopResponse()
                # Gate off: preserve the pre-X10 re-ask behaviour exactly.
                setattr(agent, "_turn_policy", "clarification")
                if question is not None:
                    add_turn_instruction(turn_ctx, "Answer briefly from verified role context, then ask this same planned topic again as ONE natural spoken question in your own words:\n" + question.text)
                return
            setattr(agent, "_turn_policy", "callback" if route == "callback_deferral" else "clarification")
            if question is not None and route == "callback_deferral":
                add_turn_instruction(
                    turn_ctx,
                    "Address the callback request. Ask for an exact IST date and time "
                    "if needed, then call propose_callback. It only validates and reads "
                    "back the time; it does not book anything. Do not answer or advance "
                    "the planned question.",
                )
            elif question is not None:
                add_turn_instruction(turn_ctx, "Answer briefly from verified role context, then ask this same planned topic again as ONE natural spoken question in your own words:\n" + question.text)
            return
        # THE PATIENCE GATE (X10). Not a recognised route: classify the final as
        # substantive / hesitation / thinking. A thinking statement earns ONE
        # short encouragement (no advance, no new question); a hesitation
        # fragment is suppressed so the bot waits for the real answer; a
        # substantive final falls through to the normal flow. Consecutive
        # suppressed fragments accumulate in the SDK chat context, so when the
        # substantive final lands the reply naturally sees the whole thought.
        if patience_on:
            substance = phone.phone_turn_substance(text)
            if substance == phone.PHONE_SUBSTANCE_THINKING:
                setattr(agent, "_turn_policy", "patience_encourage")
                add_turn_instruction(turn_ctx, phone.PHONE_PATIENCE_ENCOURAGEMENT_TEXT)
                return
            if substance == phone.PHONE_SUBSTANCE_HESITATION:
                setattr(agent, "_turn_policy", "patience_suppressed")
                from livekit.agents import StopResponse  # noqa: PLC0415
                raise StopResponse()
        if _native_turn_predates_question(message, latest_assistant_anchor[0]):
            from livekit.agents import StopResponse  # noqa: PLC0415
            raise StopResponse()
        if not assistant_delivery_complete.is_set():
            # A final transcript that arrived before the planned question was
            # audibly delivered is evidence of interruption, not an answer.
            add_turn_instruction(turn_ctx, "The previous question was interrupted. Ask that same topic again in your own natural words and wait; do not advance.")
            return
        prompt = (latest_assistant[0] or "").strip()
        if question is None or not prompt:
            # F0b — DEGRADE, DO NOT EXECUTE. An empty question prompt here means
            # the native tracking the guard reads was not populated for the ask
            # this answer belongs to. Historically this set HALT_MALFORMED_EXCHANGE
            # and `finished.set()`, and the main loop then DELETED THE ROOM under a
            # live, active call (2026-08-29) with no log line at all. A single
            # empty read is recovered: re-ask the current planned question (the
            # same `add_turn_instruction` + `phone_question_instructions` idiom the
            # interrupted-question case uses) and return, so the conversation
            # continues. Only when the guard fires a SECOND consecutive time for
            # the SAME cursor position do we accept it as a genuine malfunction and
            # end the call — truthfully, as an aborted assessment (see the main
            # loop), never as a silent room delete.
            if question is not None and malformed_guard["recovered_cursor"] != cursor:
                malformed_guard["recovered_cursor"] = cursor
                _log.info(
                    "unknown_event", error_type="phone_turn_guard",
                    error_category="malformed_exchange_recovered",
                )
                add_turn_instruction(turn_ctx, phone_question_instructions(question, state.role_title))
                return
            _log.info(
                "unknown_event", error_type="phone_turn_guard",
                error_category="malformed_exchange_terminal",
            )
            terminal_reason["reason"] = phone.HALT_MALFORMED_EXCHANGE
            finished.set()
            return
        # A well-formed exchange clears the one-shot recovery latch, so a later
        # empty read at this same cursor gets its own recovery attempt rather than
        # inheriting a stale "already recovered here" mark.
        malformed_guard["recovered_cursor"] = None
        if turn_mode == phone.PHONE_TURN_MODE_TOOLLESS and commit_tasks:
            # TOOLLESS ORDERING GUARD. The background commit reads shared `pending`
            # via `on_advance`. Turn-taking normally means the previous turn's
            # commit has already run by the time the next answer arrives, but the
            # loop does not guarantee the scheduled commit executed before this
            # hook overwrites `pending`. Drain any in-flight commit BEFORE the
            # update so a turn's boundary is never committed under the next turn's
            # key. Almost always a no-op (the task already finished); bounded so a
            # wedged commit cannot stall the live turn.
            inflight = [t for t in commit_tasks if not t.done()]
            if inflight:
                try:
                    await asyncio.wait_for(
                        asyncio.gather(*inflight, return_exceptions=True),
                        timeout=PHONE_TERMINAL_REPLY_TIMEOUT_SEC,
                    )
                except asyncio.TimeoutError:
                    _log.warn(
                        "unknown_event", error_type="phone_toolless_commit",
                        error_category="prior_commit_drain_timeout",
                    )
        pending.update({
            "question": question,
            "prompt": prompt,
            "candidate": text,
            "message": message,
            "turn_ctx": turn_ctx,
            "probe_used": False,
            "source_event_id": phone.plan_source_event_id(question.key),
        })
        last_advance["text"] = None
        latest_candidate_anchor[0] = None
        setattr(agent, "_turn_policy", "substantive")
        if turn_mode == phone.PHONE_TURN_MODE_TOOLLESS:
            # TOOLLESS (browser-style). No mandatory coordinator tool: the model
            # authors and speaks the reply in ONE Gemini call. Adherence to the
            # question plan rides this per-turn instruction (the same
            # current-question context, minus the "call exactly ONE coordinator
            # tool" requirement). The durable boundary is committed in the
            # BACKGROUND after the reply is delivered — see `commit_after_reply`.
            add_turn_instruction(
                turn_ctx,
                phone_question_instructions(question, state.role_title)
                + "\n\nBriefly acknowledge one specific detail from the candidate's "
                "answer, then ask the next planned topic — or, if their answer was "
                "thin, one natural same-topic follow-up (your judgment) — as ONE "
                "question in your own words.",
            )
            task = asyncio.create_task(commit_after_reply())
            commit_tasks.add(task)
            task.add_done_callback(commit_tasks.discard)
            return
        add_turn_instruction(
            turn_ctx,
            "You must call exactly ONE coordinator tool before any spoken text. "
            "Choose request_probe for one useful same-topic follow-up when the answer is thin; "
            "otherwise choose advance_screening. Never speak before the tool result. "
            "After the tool result, briefly acknowledge one specific detail from the "
            "candidate's answer, then ask the authorized topic as ONE natural spoken "
            "question in your own words.",
        )
        # Legacy/in-memory clients without the new probe endpoint use the
        # deterministic thin-answer fallback. Production PhoneEventClient
        # always exposes record_probe, so its durable tool-first path is used.
        if not callable(getattr(events, "record_probe", None)):
            await on_advance()

    async def on_probe() -> str:
        question = pending.get("question")
        if question is None or pending.get("probe_used"):
            return "Probe denied. Call advance_screening if the answer is sufficient."
        recorder = getattr(events, "record_probe", None)
        if not callable(recorder):
            terminal_reason["reason"] = phone.HALT_PERSISTENCE
            finished.set()
            return "Probe unavailable; do not ask a follow-up."
        outcome = await recorder(
            session_id, question.key, cursor,
            f"probe:{phone.plan_source_event_id(question.key)}",
        )
        if not outcome.ok and outcome.status != "duplicate":
            return "Probe denied. Call advance_screening without asking a follow-up."
        pending["probe_used"] = True
        hint = f" The most useful angle: {question.hint}" if question.hint else ""
        return (
            "Probe authorized. Acknowledge briefly, then ask ONE follow-up question "
            "in your own natural words on this same topic: " + question.text + hint
        )

    async def on_advance() -> str:
        nonlocal cursor
        question = pending.get("question")
        prompt = pending.get("prompt")
        candidate = pending.get("candidate")
        message = pending.get("message")
        if question is None or not prompt or not isinstance(candidate, str):
            # A duplicate advance in the SAME reply (the first one cleared
            # `pending`) is answered idempotently, never by ending the call.
            duplicate = last_advance["text"]
            if duplicate:
                return duplicate
            terminal_reason["reason"] = phone.HALT_PERSISTENCE
            finished.set()
            return "Advance unavailable; do not ask another question."
        turns = [
            {"speaker": "bot", "text": prompt, "turn_started_at_ms": latest_assistant_anchor[0]},
            {"speaker": "candidate", "text": candidate, "turn_started_at_ms": _turn_anchor_ms(message) if message is not None else None},
        ]
        outcome = await events.commit_boundary(session_id, question.key, cursor, pending["source_event_id"], turns)
        if outcome.ok and outcome.cursor == cursor and last_advance["text"] is not None:
            # A concurrent duplicate of an advance that already applied: the
            # commit is idempotent on `source_event_id` and the local cursor
            # has already moved. Repeat the authorization; do not halt.
            return last_advance["text"]
        if not outcome.ok or outcome.cursor != cursor + 1:
            terminal_reason["reason"] = phone.HALT_PERSISTENCE
            finished.set()
            return "The screening cannot safely continue. Do not ask another question."
        if question.key not in completed:
            completed.append(question.key)
        cursor = outcome.cursor
        pending["question"] = None
        next_question = state.question_at(cursor)
        if next_question is None:
            if callable(getattr(events, "record_probe", None)):
                closing.plan_completed()
                closing.wind_down_delivered()
                if pending.get("turn_ctx") is not None:
                    add_turn_instruction(pending["turn_ctx"], "The screening is complete. Ask the candidate whether they have any questions about the role, team, company, or process. Do not say goodbye yet.")
                last_advance["text"] = "Advance authorized. Ask whether the candidate has any questions. Do not close the call yet."
                return last_advance["text"]
            terminal_reply_required["value"] = True
            terminal_reason["reason"] = "completed"
            finished.set()
            if pending.get("turn_ctx") is not None:
                add_turn_instruction(pending["turn_ctx"], "Thank the candidate briefly, say goodbye, and complete the final closing. Do not ask another question.")
            last_advance["text"] = "Advance authorized. Thank the candidate briefly, say goodbye, and complete the final closing."
            return last_advance["text"]
        pending["probe_used"] = False
        hint = f" The most useful angle if their answer is thin: {next_question.hint}" if next_question.hint else ""
        last_advance["text"] = (
            "Advance authorized. Briefly acknowledge one specific detail from their "
            "answer, then ask ONE question in your own natural words covering exactly "
            "this topic: " + next_question.text + hint
        )
        return last_advance["text"]

    async def commit_after_reply() -> None:
        """TOOLLESS: commit the boundary in the background after the reply.

        The tool-first lane commits INSIDE a muzzled `advance_screening` leg
        before the speech leg runs — two sequential Gemini calls per turn. In
        toolless there is one call: the model already authored and is delivering
        its reply. This coroutine waits for that reply to finish playing, then
        fires the SAME idempotent `commit_boundary` (via `on_advance`, keyed on
        the identical `source_event_id`), so the cursor moves and the exact same
        committed keys the scorer aligns on are produced — just off the speech
        path.

        The delivery wait is BEST-EFFORT, not a correctness fence.
        `assistant_delivery_complete` is a session-lifetime event that may still
        be set from the PREVIOUS reply when this task starts, so the wait can
        return immediately and the commit can land before the current reply
        finishes playing. That is harmless: the boundary is the candidate's
        ALREADY-CAPTURED answer, the model's reply does not depend on the commit
        (toolless strips the coordinator tools and the per-turn instruction is
        already injected), and the commit is idempotent on `source_event_id`. The
        only effect of an early commit is the cursor advancing a moment sooner —
        and the next candidate turn is serialized behind this task by the toolless
        ordering guard in `on_native_turn`, so `pending` cannot be corrupted.

        `on_advance` is idempotent and self-guarding: a duplicate or stale commit
        is answered without ending the call, and a genuine persistence failure
        sets `HALT_PERSISTENCE` and `finished`. Per the pilot contract, a FAILED
        background commit must be LOUD and must NOT drop the call — the server is
        the durable resume authority, so a lost commit only means resume re-asks
        that one topic, which is acceptable pilot behavior. We therefore log the
        failure and leave `on_advance`'s own halt decision intact rather than
        swallowing it or force-killing the leg here.

        X10 SUBSTANCE GATE. The boundary commit advances the durable cursor, so
        it must fire ONLY for a substantive candidate turn. A suppressed
        hesitation never reaches `pending.update`, so in the normal path this
        task is only ever scheduled for a substantive turn — but as
        defense-in-depth (and to honour the never-advance-without-substance
        contract even if a fragment slips past the gate), re-classify the exact
        `pending['candidate']` text here and SKIP the commit when it is not
        substantive. Skipping leaves the cursor where it is, so the next answer
        commits under the same still-owed key; the server-owned resume is
        untouched. Bypassed when the gate is off, restoring the pre-X10 path.
        """
        candidate_text = pending.get("candidate")
        if (
            phone.phone_patience_gate_enabled()
            and phone.phone_turn_substance(candidate_text)
            != phone.PHONE_SUBSTANCE_SUBSTANTIVE
        ):
            _log.info(
                "unknown_event", error_type="phone_toolless_commit",
                error_category="non_substantive_commit_skipped",
            )
            return
        try:
            await asyncio.wait_for(
                assistant_delivery_complete.wait(),
                timeout=PHONE_TERMINAL_REPLY_TIMEOUT_SEC,
            )
        except asyncio.TimeoutError:
            # The reply never signalled delivery. Commit anyway: the boundary is
            # about the candidate's answer, not the bot's playout, and the
            # server-keyed idempotency makes an early commit safe. Do not drop
            # the call on a missing delivery signal.
            _log.info(
                "unknown_event", error_type="phone_toolless_commit",
                error_category="delivery_timeout_commit_anyway",
            )
        try:
            outcome = await on_advance()
        except Exception:  # noqa: BLE001
            # A background commit must never take the call down by raising into
            # a bare task. Log loudly; the server remains the durable authority
            # and resume re-asks the topic. `finished` is untouched here.
            _log.warn(
                "unknown_event", error_type="phone_toolless_commit",
                error_category="background_commit_failed",
            )
            return
        # `on_advance` returns an instruction string on success and on its
        # idempotent duplicate/stale paths; it sets HALT_PERSISTENCE + finished
        # itself on a genuine failure. Surface a loud line either way so a lost
        # commit (resume will re-ask that topic) is observable in the logs.
        if terminal_reason.get("reason") == phone.HALT_PERSISTENCE:
            _log.warn(
                "unknown_event", error_type="phone_toolless_commit",
                error_category="commit_halted_persistence",
            )

    async def native_say(text: str) -> None:
        speech = session.say(text, allow_interruptions=True)
        wait = getattr(speech, "wait_for_playout", None)
        if callable(wait):
            value = wait()
            if inspect.isawaitable(value):
                await value

    async def on_booking(turn: Any) -> None:
        if bool(getattr(turn, "booked", False)):
            terminal_reason["reason"] = phone.HALT_CALLBACK_SCHEDULED
            finished.set()

    # The same Agent instance was installed at SIP answer. Consent changes
    # authorization and instructions; it never swaps the scheduler's agent.
    if not await _apply_phone_instructions(agent, state):
        raise RuntimeError("phone_instructions_unavailable")
    setattr(agent, "_on_user_turn", on_native_turn)
    setattr(agent, "_on_booking", on_booking)
    setattr(agent, "_on_probe", on_probe)
    setattr(agent, "_on_advance", on_advance)
    # Test seam (same idiom as `_on_advance`/`_on_probe`): the background commit
    # coroutine and its `pending` buffer are exposed so the substance-gated
    # commit (X10 Fix 2a) can be exercised directly with a seeded non-substantive
    # `pending`, which the live turn hook can never produce because it suppresses
    # first. Not read on any production path.
    setattr(agent, "_commit_after_reply", commit_after_reply)
    setattr(agent, "_pending", pending)
    setattr(agent, "_native_turns", True)
    authorize = getattr(agent, "authorize_screening", None)
    if not callable(authorize):
        raise RuntimeError("phone_consent_authorization_unavailable")
    authorize()

    question = state.question_at(cursor)
    if question is None:
        terminal_reason["reason"] = "completed"
        finished.set()
    else:
        # The first post-consent question is delivered through Gemini in the
        # tool-less "opening" policy so it is phrased naturally — the same
        # behavior the browser lane has always had. PR #157 pinned this to
        # fixed `session.say` because a stale policy transition could trap the
        # opening generation in a required-tool loop until LiveKit exhausted
        # its function-step budget and closed the room. That trap is now
        # structurally disarmed: the tool-resolved latch releases speech after
        # one tool resolution and a duplicate advance is answered
        # idempotently, so the worst a raced generation can do is speak. The
        # fixed-text path remains as the fallback when the LLM path is
        # unavailable, and the WHICH-question authority is unchanged — it is
        # this call site and the committed key, never the spoken prose.
        spoke = False
        generate = getattr(session, "generate_reply", None)
        if callable(generate):
            setattr(agent, "_turn_policy", "opening")
            try:
                handle = generate(instructions=phone_question_instructions(question, state.role_title))
                if inspect.isawaitable(handle):
                    handle = await handle
                wait = getattr(handle, "wait_for_playout", None)
                if callable(wait):
                    value = wait()
                    if inspect.isawaitable(value):
                        await value
                spoke = True
            except Exception:  # noqa: BLE001
                _log.warn(
                    "unknown_event", error_type="phone_first_question_fallback",
                    error_category="generate_reply_failed",
                )
                spoke = False
            finally:
                setattr(agent, "_turn_policy", "substantive")
        if not spoke:
            speech = session.say(question.text, allow_interruptions=True)
            wait = getattr(speech, "wait_for_playout", None)
            if callable(wait):
                value = wait()
                if inspect.isawaitable(value):
                    await value
        # F0a — PRIME THE NATIVE TURN TRACKING AT THE GATE HANDOFF.
        # The first planned question is delivered HERE, at the consent→screening
        # handoff, through `generate_reply`/`say`. The native turn hook
        # (`on_native_turn`) reads three pieces of tracking to decide whether the
        # candidate's next utterance is a real answer: `latest_assistant[0]` (the
        # question text it is answering), `latest_assistant_anchor[0]` (the moment
        # the question was asked), and `assistant_delivery_complete` (proof the
        # ask was audibly finished, not interrupted). In production those are
        # populated ASYNCHRONOUSLY by the SDK's `conversation_item_added` /
        # `agent_state_changed` / `speech_created` handlers — and on a live call
        # 2026-08-29 they had NOT landed by the time the candidate's first plain
        # answer arrived. The malformed-exchange guard then read an empty
        # `latest_assistant[0]`, declared the exchange malformed, and the main
        # loop DELETED THE ROOM under a healthy, active SIP call. Prime the exact
        # fields the guard consumes with the delivered question text and an anchor
        # of "now", so a first answer that races ahead of the SDK events is still
        # measured against a real, populated ask instead of an empty one.
        #
        # FALLBACK ONLY — this fills the gaps the SDK events left, it never
        # overwrites them. When the `conversation_item_added` / `agent_state_changed`
        # / `speech_created` handlers DID land, they carry the authoritative
        # values (including the real speech-start anchor and the interrupted-question
        # evidence prefix), and clobbering those would corrupt the committed
        # boundary. So prime a field only when it is still unset: an empty
        # `latest_assistant[0]` gets the delivered question text; a missing anchor
        # gets "now" (a first answer necessarily arrives after the ask, so "now"
        # keeps `_native_turn_predates_question` from mis-reading it); and an
        # un-set delivery flag is set, because reaching here means the ask's
        # playout already awaited above. It never touches the durable cursor or
        # the committed key — WHICH question is authoritative is unchanged.
        if question is not None:
            if not (latest_assistant[0] or "").strip():
                latest_assistant[0] = question.text
            if latest_assistant_anchor[0] is None:
                latest_assistant_anchor[0] = int(round(time.time() * 1000))
            if not assistant_delivery_complete.is_set():
                assistant_delivery_complete.set()

    try:
        # This bounds the whole leg, not one answer. Per-turn inactivity is
        # owned by the LiveKit activity-driven silence loop above.
        await asyncio.wait_for(finished.wait(), timeout=SESSION_MAX_RESIDENCY_SEC)
    except asyncio.TimeoutError:
        terminal_reason["reason"] = "residency_timeout"
    finally:
        silence_task.cancel()
        await asyncio.gather(silence_task, return_exceptions=True)
        # TOOLLESS: let any in-flight background commit finish so a boundary the
        # candidate already answered is not lost to teardown, but bound the wait
        # so a wedged commit cannot hold the leg open. A commit that does not
        # settle in time is left to the server's durable resume authority.
        if commit_tasks:
            pending_commits = [t for t in commit_tasks if not t.done()]
            if pending_commits:
                try:
                    await asyncio.wait_for(
                        asyncio.gather(*pending_commits, return_exceptions=True),
                        timeout=PHONE_TERMINAL_REPLY_TIMEOUT_SEC,
                    )
                except asyncio.TimeoutError:
                    for t in pending_commits:
                        t.cancel()
                    await asyncio.gather(*pending_commits, return_exceptions=True)

    reason = terminal_reason.get("reason")
    if terminal_reply_required["value"]:
        terminal_reply_played = await wait_for_terminal_reply()
        if reason == "completed" and not terminal_reply_played:
            reason = phone.HALT_NO_ANSWER

    if reason == "completed":
        done = None
        queue_owned = False
        for attempt in range(20):
            done = await events.complete_assessment(attempt_id, session_id)
            if done.ok or not phone.retryable_completion(done):
                break
            # `scoring_queued` is an acknowledged durable handoff, not a
            # transport failure. Give the API worker time to score before
            # asking again; the worker never posts completion until the row
            # exists, so a retry remains idempotent and fail-closed.
            if done.status == phone.ASSESSMENT_QUEUED_STATUS:
                # Terminal ownership has transferred completely to the
                # durable queue worker. The PSTN worker must not poll, retry,
                # or post assessment.completed after this handoff.
                queue_owned = True
                break
        if not queue_owned and done is not None and done.ok and not done.adopted:
            await events.post_event(attempt_id, "assessment.completed")
        elif not queue_owned and done is not None and done.status is not None:
            # A known non-score verdict is truthfully terminal. A transport
            # failure has no status and remains non-terminal for recovery.
            await events.post_event(attempt_id, "assessment.aborted")
    elif reason in {
        phone.HALT_CANDIDATE_ENDED,
        phone.HALT_NO_ANSWER,
        # F0b — a TERMINAL malformed exchange is a genuine, truthful end of the
        # screening (the guard already recovered once and the same cursor still
        # produced no usable ask). It is NOT infrastructure-retryable, so it
        # belongs with the honest aborts and posts `assessment.aborted` — it was
        # previously in the no-op set below, which is exactly what let a killed
        # call end with no terminal signal AND no log.
        phone.HALT_MALFORMED_EXCHANGE,
    }:
        await events.post_event(attempt_id, "assessment.aborted")
    elif reason == "disconnect":
        # F4 — 'disconnect' stays NON-TERMINAL: the room/connection died
        # externally and the reclaim/reconnect machinery owns what happens next
        # (do NOT post here — that ownership is unchanged).
        #
        # X2 (2026-08-29 CPU-starvation incident): this branch used to LOG and
        # then FALL THROUGH to `_close_phone_room`, whose comment claimed the
        # delete was "a harmless no-op on a room that is already gone". That is
        # PROVEN FALSE for this class. CPU starvation killed the Sarvam STT
        # websocket (close 1006 keepalive timeout); the AgentSession closed with
        # `CloseReason.ERROR`; the close chain set terminal reason "disconnect";
        # and the fall-through deleted a LIVE room — LiveKit payloads showed the
        # SIP participant `callStatus: "active"` at ROOM_DELETED. The room is
        # exactly what LiveKit re-dispatch needs to resume the call (the
        # `gate_recorded` consent-skip path is PROVEN to resume a live room when
        # a worker dies — call 20's deploy restart). So on `disconnect` we do NOT
        # delete: log a structured preserved event and RETURN, leaving the room
        # for re-dispatch. The room's own `emptyTimeout` (120 s) garbage-collects
        # it if the candidate actually hung up. Every OTHER terminal reason keeps
        # its delete below. This preserves the "no deletion without a reason log"
        # invariant from PR #176 — nothing here deletes, so no delete-log is owed.
        _log.info(
            "unknown_event", error_type="phone_session_terminal",
            error_category="disconnect_nonterminal",
        )
        _log.info(
            "unknown_event", error_type="phone_room_preserved",
            error_category="disconnect",
        )
        return result
    elif reason in {phone.HALT_CALLBACK_SCHEDULED, phone.HALT_PERSISTENCE}:
        # Callback already changed the engagement; infrastructure and transport
        # halts remain non-terminal for existing reconnect/recovery ownership.
        pass
    else:
        await events.post_event(attempt_id, "assessment.aborted")
    # F0c — NEVER SILENTLY DELETE A LIVE ROOM. `_close_phone_room` deletes the
    # LiveKit room via RoomService, which terminates every participant — and on
    # 2026-08-29 that ran against a HEALTHY, `sip.callStatus: "active"` call with
    # zero log output, so the kill was unattributable from the outside. Every
    # room teardown now emits the terminal reason first (the fixed reason code
    # only — no transcript, ids, or room name). The invariant this establishes:
    # there is NO path that deletes a room without a log line naming why. The
    # deletion itself is unchanged — genuinely-ended calls (completed,
    # candidate_ended, no_answer, callback_scheduled, terminal malformed) still
    # tear down. `disconnect` no longer reaches here at all (it returned above).
    #
    # X7b: the label is `_teardown_label`, a teardown-specific bounded vocabulary,
    # NOT `_bounded_outcome` (a session-OUTCOME allowlist that mapped every HALT
    # reason to `other_failure`, making a candidate goodbye and a crash
    # indistinguishable in the one log line that says WHY a room was deleted).
    _log.info(
        "unknown_event", error_type="phone_room_teardown",
        error_category=_teardown_label(reason),
    )
    await _close_phone_room(room_name)
    return result


async def _run_phone_session(
    ctx: JobContext,
    room_name: str,
    attempt_id: str,
    epoch: int,
    *,
    client: Any = None,
    classifier: Callable[..., Any] | None = None,
) -> phone.PhoneGateResult:
    """Connect, wait, disclose, classify — then, and only then, screen."""
    await ctx.connect()
    events = client if client is not None else phone.PhoneEventClient()

    # Candidate-only queue used exclusively by the pre-consent disclosure
    # classifier. Post-consent turns remain inside LiveKit AgentSession.
    user_turns: "asyncio.Queue[str]" = asyncio.Queue()
    candidate_activity = asyncio.Event()
    agent_listening = asyncio.Event()
    agent_listening.set()
    agent_activity_changed = asyncio.Event()
    candidate_end_requested = asyncio.Event()
    close_event = asyncio.Event()
    close_reason: dict[str, Any] = {}
    # Used only as evidence for the server-keyed native boundary.
    latest_assistant: list[str | None] = [None]
    latest_assistant_anchor: list[int | None] = [None]
    latest_candidate_anchor: list[int | None] = [None]
    latest_candidate_stopped_anchor: list[int | None] = [None]
    participant_present_anchor: list[int | None] = [None]

    # ── 0071 / X4: PER-ITEM TRANSCRIPT DURABILITY IN THE PHONE PATH ────────
    # The browser path persists every turn as it happens; the phone path
    # buffered turns and persisted them only in pairs at question boundaries,
    # so a mid-call crash between boundaries lost everything since the last one
    # (live call 22, 2026-08-29: 4 of a 6.5-minute transcript survived). These
    # drive a best-effort per-item write for the ASSESSMENT phase only — the
    # gate transcript keeps its own is_gate=true writer. `[False]` until the
    # durable screening begins, so gate-phase items are never persisted here as
    # non-gate turns. `_item_seq` is a monotonic per-session id used purely as
    # the server-side idempotency key (it need not agree with turn_index — the
    # server assigns that); it makes a duplicate delivery converge.
    assessment_persist_active: list[bool] = [False]
    item_seq: list[int] = [0]
    persist_session_id = phone.session_id_from_room_name(room_name)
    persist_tasks: set[asyncio.Task] = set()

    async def _persist_phone_item(speaker: str, text: str, anchor_ms: int | None,
                                  source_item_id: str) -> None:
        """Best-effort per-item transcript write (0071 / X4).

        A failure here NEVER fails the call: the boundary path remains the
        durable resume authority, so a lost per-item write only means resume
        re-reads that span from the boundary. Any transport/refusal is logged
        without text and swallowed. Deduped server-side on `source_item_id`.
        """
        commit = getattr(events, "commit_item_turn", None)
        if not callable(commit) or not persist_session_id:
            return
        try:
            outcome = await commit(persist_session_id, speaker, text,
                                   source_item_id, anchor_ms)
        except Exception:  # noqa: BLE001
            _log.warn(
                "unknown_event", error_type="phone_item_persist",
                error_category="item_persist_failed",
            )
            return
        if outcome is not None and not getattr(outcome, "ok", False):
            _log.warn(
                "unknown_event", error_type="phone_item_persist",
                error_category="item_persist_not_ok",
            )

    def _spawn_item_persist(speaker: str, text: str, anchor_ms: int | None,
                            seq: int) -> None:
        """Fire the per-item write off the speech path (sync-hook safe).

        The key is `phone-item-<seq>`, a stable per-session id: a redelivered
        item carries the same seq and the server dedups on it, so a duplicate
        cannot double-insert. Never awaited on the hot path; tracked so a
        stop can drain it.
        """
        try:
            task = asyncio.create_task(
                _persist_phone_item(speaker, text, anchor_ms,
                                    f"phone-item-{seq}"))
        except RuntimeError:
            # No running loop (e.g. a synthetic test emitting outside the
            # session loop): the boundary path still persists the pair.
            return
        persist_tasks.add(task)
        task.add_done_callback(persist_tasks.discard)

    # Read the per-turn coordination mode ONCE at session start and log it, so
    # every later decision (provider speculation, `llm_node` policy, the commit
    # path) reads the same value and an operator can see which lane a call ran.
    # `PHONE_TURN_MODE` defaults to `toolfirst` (today's byte-path); `toolless`
    # opts into the browser-style one-call turn. Read at the call site with the
    # literal name so the env-contract scanner sees it.
    turn_mode = phone.phone_turn_mode()
    _log.info(
        "unknown_event", error_type="phone_turn_mode",
        error_category=turn_mode,
    )
    session = _build_phone_provider_session(turn_mode)
    reply_started = asyncio.Event()
    assistant_delivery_complete = asyncio.Event()
    reply_handle: list[Any] = [None]

    @session.on("speech_created")
    def _on_phone_speech_created(event):  # noqa: ANN001
        reply_handle[0] = getattr(event, "speech_handle", None)
        reply_started.set()
        # Once an authorized reply has been created, the next interim
        # generation must default to substantive tool-first policy. The
        # current reply already captured its route-specific settings; this
        # prevents clarification/opening policy from leaking into the next
        # speculative turn before the final hook runs.
        if getattr(agent, "_screening_authorized", False):
            setattr(agent, "_turn_policy", "substantive")
        assistant_delivery_complete.clear()
        handle = reply_handle[0]
        wait = getattr(handle, "wait_for_playout", None)
        if callable(wait):
            async def mark_delivered() -> None:
                try:
                    value = wait()
                    if inspect.isawaitable(value):
                        await value
                    assistant_delivery_complete.set()
                except Exception:
                    assistant_delivery_complete.clear()
            asyncio.create_task(mark_delivered())
        else:
            assistant_delivery_complete.set()

    @session.on("user_state_changed")
    def _on_phone_user_state_changed(event):  # noqa: ANN001
        new_state = getattr(event, "new_state", None)
        if new_state == "speaking":
            candidate_activity.set()
            # LiveKit 1.6.4 does not guarantee speech-start metrics on every
            # finalized ChatMessage. This event is the real local VAD anchor,
            # used only when the message has no provider timestamp.
            latest_candidate_anchor[0] = int(round(time.time() * 1000))
        # DISCONNECT DIAGNOSTICS. A candidate going 'away' (LiveKit's own
        # inactivity state) and coming back is exactly the shape a dropped or
        # muted leg leaves behind, and the live call had no record of it. Log
        # the transition to/from 'away' in FIXED strings only — no transcript,
        # no ids, no dynamic values.
        old_state = getattr(event, "old_state", None)
        if new_state == "away":
            _log.info(
                "unknown_event", error_type="phone_user_state",
                error_category="user_away",
            )
        elif old_state == "away":
            _log.info(
                "unknown_event", error_type="phone_user_state",
                error_category="user_active",
            )

    @session.on("user_input_transcribed")
    def _on_phone_transcript_activity(event):  # noqa: ANN001
        if str(getattr(event, "transcript", "") or "").strip():
            candidate_activity.set()

    @session.on("agent_state_changed")
    def _on_phone_agent_state_changed(event):  # noqa: ANN001
        new_state = getattr(event, "new_state", None)
        if new_state == "speaking":
            latest_assistant_anchor[0] = int(round(time.time() * 1000))
        if new_state in {"idle", "listening"}:
            agent_listening.set()
        else:
            agent_listening.clear()
        # Wake the inactivity controller without pretending the candidate spoke.
        agent_activity_changed.set()

    @session.on("conversation_item_added")
    def _on_phone_item(event):  # noqa: ANN001
        item = getattr(event, "item", None)
        role = getattr(item, "role", None)
        if role not in {"user", "assistant"}:
            return
        _record_turn_metrics(item, "phone")
        interrupted = role == "assistant" and getattr(item, "interrupted", False)
        text = _item_text(item)
        if interrupted:
            # Keep the generated fragment instead of silently deleting the
            # question at the start of an interrupted turn. The label is
            # evidence, not spoken text; the dashboard renders it separately
            # and the scorer can distinguish it from a fully delivered answer.
            text = (phone.INTERRUPTED_QUESTION_PREFIX + text).strip()
        if not text:
            return
        # Candidate turns are owned by LiveKit's completed-turn hook. Assistant
        # items are retained only as evidence for the server-keyed boundary.
        if role == "user":
            candidate_activity.set()
            metrics = getattr(item, "metrics", None)
            if isinstance(metrics, Mapping):
                stopped = persistence.normalize_turn_anchor_ms(metrics.get("stopped_speaking_at"))
                if stopped is not None:
                    latest_candidate_stopped_anchor[0] = stopped
            # 0071 / X4: persist the candidate turn the moment it lands, so a
            # crash before the next boundary does not lose it. Only in the
            # ASSESSMENT phase — the gate's consent reply has its own is_gate
            # writer — and best-effort, so a persist failure never drops the
            # call. The boundary still commits the pair; the migration's
            # authorship guard makes the boundary insert a no-op once these
            # per-item rows exist, so the two never double-write.
            if assessment_persist_active[0]:
                item_seq[0] += 1
                _spawn_item_persist(
                    "candidate", text, _turn_anchor_ms(item), item_seq[0])
            return
        if phone.is_gate_copy(text):
            # FIXED COPY IS NOT A SCREENING TURN. The disclosure, the re-ask,
            # every refusal closing, the callback confirmations and the closing
            # line are all spoken through `session.say`, which appends a
            # conversation item exactly like a generated turn does. Left in the
            # queue, a scheduling confirmation spoken mid-call would be
            # captured inside whichever question's boundary happened to be open
            # and committed as part of the candidate's answer.
            return
        # 0071 / X4: persist the bot turn per-item too (assessment phase only).
        if assessment_persist_active[0]:
            item_seq[0] += 1
            _spawn_item_persist("bot", text, _turn_anchor_ms(item), item_seq[0])
        metrics = getattr(item, "metrics", None)
        if isinstance(metrics, Mapping):
            started = persistence.normalize_turn_anchor_ms(metrics.get("started_speaking_at"))
            if started is not None and latest_candidate_stopped_anchor[0] is not None and started >= latest_candidate_stopped_anchor[0]:
                _safe_emit(histogram_metric, "voice_phone_candidate_to_first_audio_sec", (started - latest_candidate_stopped_anchor[0]) / 1000.0, {"channel": "phone"})
                latest_candidate_stopped_anchor[0] = None
        latest_assistant[0] = text
        # Keep the state-event anchor when the later conversation item carries
        # no metrics/created_at value. Never replace a real anchor with null.
        item_anchor = _turn_anchor_ms(item)
        if item_anchor is not None:
            latest_assistant_anchor[0] = item_anchor

    @session.on("close")
    def _on_phone_close(event):  # noqa: ANN001
        reason = _classify_close_event(event)
        close_reason["reason"] = reason
        # DISCONNECT DIAGNOSTICS. The 2026-08-28 live call died with the close
        # reason computed but never surfaced — and it was almost certainly a
        # CLEAN remote close, the one shape a failure-only log would exclude.
        # EVERY close is logged: `clean_close` for the SDK's normal shape
        # (reason None), otherwise one of the fixed codes
        # `_classify_close_event` returns. Never raw reason text.
        bounded = reason if reason in {
            "shutdown_forced", "provider_error", "worker_crash",
        } else ("clean_close" if reason is None else "other_failure")
        _log.warn(
            "unknown_event", error_type="phone_session_closed",
            error_category=bounded,
        )
        close_event.set()

    async def say(text: str) -> None:
        started_ms = int(round(time.time() * 1000))
        speech = session.say(text, allow_interruptions=False)
        wait_for_playout = getattr(speech, "wait_for_playout", None)
        if callable(wait_for_playout):
            await wait_for_playout()
        if text == phone.PHONE_DISCLOSURE_TEXT and participant_present_anchor[0] is not None:
            delta_ms = started_ms - participant_present_anchor[0]
            if delta_ms >= 0:
                _safe_emit(histogram_metric, "voice_phone_participant_to_disclosure_sec", delta_ms / 1000.0, {"channel": "phone"})

    def on_candidate_turn(text: str, message: Any = None, turn_ctx: Any = None) -> None:
        candidate_activity.set()
        user_turns.put_nowait(text)
        if phone.is_explicit_end_call_request(text):
            candidate_end_requested.set()

    agent = phone.phone_agent_class(Agent)(
        # The prompt is built AFTER the gate, once the plan is known — see
        # `_start_phone_assessment` below. Until then the agent carries the
        # base instructions only, because the gate does not screen anybody and
        # must not be handed the question flow.
        system_prompt(
            candidate_name=None, role_title=None, role_focus=None,
            resume_facts=None, questions=None,
        ),
        client=events,
        attempt_id=attempt_id,
        say=say,
        on_user_turn=on_candidate_turn,
        native_turns=True,
        turn_mode=turn_mode,
    )

    async def wait_for_participant() -> Any:
        """Wait for the answer, and only then open the media session.

        Coupled deliberately: with the session start on this side of the wait,
        there is no code path on which the agent can speak, run a turn, or start
        a silence timer before something has actually answered the call.
        """
        participant = await _wait_for_sip_participant(
            ctx, phone.phone_participant_wait_sec()
        )
        if participant is None:
            return None
        participant_present_anchor[0] = int(round(time.time() * 1000))
        await session.start(agent=agent, room=ctx.room, record=dict(_PHONE_NO_RECORDING))
        return participant

    # The raw consent utterance the classifier consumed, threaded out so the
    # gate can commit it as the candidate half of the gate transcript.
    consent_reply_out: list[str] = []

    async def classify() -> str:
        if classifier is not None:
            return await classifier(user_turns, say)
        return await _classify_phone_answer(
            user_turns, say, consumed=consent_reply_out
        )

    async def speak_opening() -> str | None:
        """Generate a warm, verified opening through the tool-less gate window.

        Sets the agent's `_gate_opening` window so `llm_node` streams the
        generated greeting even though screening is not yet authorized, asks the
        model to greet as Christy, disclose recording (including the fixed
        recording-disclosure sentence verbatim), and ask consent, then reads the
        exact spoken text back out of the same `latest_assistant` capture the
        native loop uses. Returns None on any failure so the gate falls back to
        the fixed disclosure — the gate verifies the text before trusting it.
        """
        generate = getattr(session, "generate_reply", None)
        if not callable(generate):
            return None
        setter = getattr(agent, "set_gate_opening", None)
        if callable(setter):
            setter(True)
        latest_assistant[0] = None
        opening_instructions = (
            "You are Christy, an AI voice assistant calling from the company "
            "about the candidate's job application. Greet the candidate warmly "
            "and briefly by voice. You MUST include this exact sentence "
            "verbatim, word for word, somewhere in your reply: "
            f"\"{phone.PHONE_DISCLOSURE_RECORDING_SENTENCE}\" "
            "Then ask whether it is okay to continue. Keep it to two or three "
            "short sentences and end with the consent question."
        )
        try:
            # The FIRST generation of a call runs against an EMPTY chat
            # context, and Gemini refuses a request with no contents
            # (400 INVALID_ARGUMENT, observed live 2026-08-29 — the opening
            # fell back to fixed copy on every call). `user_input` seeds one
            # user turn ("Hello?", which is what answering a phone sounds
            # like) so the request always carries contents. It is model
            # context only: it is not an STT turn, fires no turn hooks, and
            # the gate transcript takes the candidate's consent reply from
            # the classifier path, never from here.
            try:
                handle = generate(
                    user_input="Hello?", instructions=opening_instructions,
                )
            except TypeError:
                # An older/stubbed session without the `user_input` seam:
                # generate bare and let the verification/fallback decide.
                handle = generate(instructions=opening_instructions)
            if inspect.isawaitable(handle):
                handle = await handle
            wait = getattr(handle, "wait_for_playout", None)
            if callable(wait):
                value = wait()
                if inspect.isawaitable(value):
                    await value
        except Exception:  # noqa: BLE001
            return None
        finally:
            if callable(setter):
                setter(False)
        spoken_text = latest_assistant[0]
        return spoken_text if isinstance(spoken_text, str) and spoken_text.strip() else None

    async def fetch_durable_consent() -> "phone.PhoneAssessmentState | None":
        """The READ that lets a re-dispatched leg skip a second consent ask.

        Read-only by construction: `fetch_assessment_state` maps to
        `get_phone_assessment_state`, so it binds nothing and starts nothing. A
        fresh call has no plan yet and gets back `plan_missing` (not ok), so the
        gate runs the full disclosure; a RE-ENTRY into an already-consented
        conversation gets back the live state, whose `gate_recorded` the gate
        reads to skip the disclosure. A resolvable session id is required —
        without one there is nothing durable to consult.
        """
        sid = phone.session_id_from_room_name(room_name)
        if sid is None:
            return None
        fetch = getattr(events, "fetch_assessment_state", None)
        if not callable(fetch):
            # A legacy client without the read-only seam: consult nothing and
            # gate as before rather than reach for a write RPC.
            return None
        try:
            return await fetch(sid)
        except Exception:  # noqa: BLE001
            return None

    result = await phone.run_phone_gate(
        attempt_id=attempt_id,
        client=events,
        wait_for_participant=wait_for_participant,
        classify=classify,
        say=say,
        start_recording=_phone_recording_permitted,
        epoch=epoch,
        # F2 (2026-08-29 consent replay): consulted once before the disclosure
        # so a mid-call re-dispatch resumes instead of re-asking for consent.
        fetch_durable_consent=fetch_durable_consent,
        # Recording-from-answer: post call.answered before the disclosure so the
        # server can start the egress from the top of the call.
        post_call_answered=True,
        speak_opening=speak_opening,
        consent_reply_out=consent_reply_out,
        # Answer-first origination (Plivo bounce). OFF by default → byte-identical
        # current behavior. When ON, the gate waits for the server-verified
        # answer (the Plivo webhook applies `call.answered`) before it speaks a
        # word, because the SIP participant is present ~1s after dispatch, long
        # before the real candidate has picked up. The wait budget is the same
        # `PHONE_ANSWER_TIMEOUT_SEC` bound used elsewhere in the gate.
        bounce_mode=phone.phone_bounce_mode(),
        # The session hint for the server-side recording start: derived from
        # the room name the dialer minted (`phone-<sessionId>`), the same
        # derivation 0044's binding re-verifies. Without it the server's
        # disclosure-time DB read finds no session (it is bound only at
        # /assessment/start) and the egress silently never starts.
        session_id=phone.session_id_from_room_name(room_name),
    )

    if not result.assessment_allowed:
        # Machine, refusal, opt-out, wrong number, silent line: the attempt is
        # over. No scoring is triggered and no writeback is attempted, because
        # neither is reachable from here at all.
        await _close_phone_room(room_name)
        return result

    # ── 0044: the DURABLE screening ───────────────────────────────────
    # The session id comes from the ROOM NAME, which the dialer derives from it
    # — `phone-<sessionId>` — and the server re-verifies that binding before it
    # will bind anything. A room whose name does not parse is one the worker
    # cannot account for, so it screens nobody.
    session_id = phone.session_id_from_room_name(room_name)
    if session_id is None:
        _log.warn(
            "unknown_event", error_type="phone_assessment_unstarted",
            error_category="session_unresolved",
        )
        await _close_phone_room(room_name)
        return result

    # ── P5: THE LEASE MUST OUTLIVE THE CONVERSATION ───────────────────
    # Everything below this point is the conversation itself, and the
    # concurrency lease this leg holds was sized to cover the ORIGINATE — 75-odd
    # seconds from the dial, of which a candidate who answered on the last ring
    # has already spent most. A screening runs for minutes. Unrenewed, the lease
    # lapses mid-call: the fleet slot is released the instant it does (the cap
    # counts `lease_expires_at > now`), an eleventh call becomes admissible
    # while the tenth is still talking, the reclaim sweep marks this attempt
    # `abandoned` and moves the engagement out of `in_call`, and the assessment
    # this leg goes on to score is then ignored because that edge is gated on
    # `in_call`. A screening that was conducted and scored is lost, silently.
    #
    # WHY HERE. The gate above is not a conversation — it is a ring, a fixed
    # disclosure line and a classification, which is what the originate lease
    # was sized for and which ends with no candidate on the line at all on every
    # branch but one. The heartbeat starts at the first instant the call IS a
    # consented human conversation, and it covers all of it: the assessment
    # start, the recovery branches, every question boundary and the completion.
    # It is cancelled in a `finally`, so no exception path can leave it beating.
    lease_halt: dict[str, str] = {}
    running: dict[str, Any] = {}

    async def halt_for_lease(reason: str) -> None:
        """Stop the conversation. Called only when the slot cannot be proved.

        Cancelling the screening task is the whole mechanism: it is how a call
        conducted by one task is ended by another without an exception escaping
        a background beat that nobody awaits. The reason is recorded FIRST so
        the cancellation can be told apart from a real one at the await.
        """
        lease_halt["reason"] = reason
        task = running.get("screening")
        if task is not None and not task.done():
            task.cancel()

    async def _screen() -> phone.PhoneGateResult:
        # The atomic consent/start RPC already returned the full assessment
        # state; a second `/assessment/start` round trip here was pure audible
        # dead air between consent and the first question. Legacy gate paths
        # (no combined RPC) still fetch it.
        gate_state = getattr(result, "assessment_state", None)
        state = gate_state if gate_state is not None and gate_state.ok \
            else await events.start_assessment(attempt_id, session_id)
        if not state.ok:
            # ── A REFUSED START IS NOT PROOF THAT NOTHING HAPPENED ────────
            # `session_not_active` is exactly what a session that is ALREADY
            # COMPLETED presents — which is the state a scored-but-unacknowledged
            # screening is in. The chain that produces it: the completion endpoint
            # succeeded, inserted the assessment and lost its response; this leg
            # halted and posted nothing (correct); the webhook granted a reconnect;
            # and now the reconnecting leg is being told the session is not active.
            #
            # Aborting here would drive the engagement to terminal `failed` over a
            # screening that exists and is scored, and terminal is unrecoverable —
            # `apply_phone_event` short-circuits every later post with
            # `ignored: terminal`. So the completion endpoint is asked FIRST. It is
            # idempotent by construction and answers `scored` when the row is
            # there, so this recovers the acknowledgement without re-screening
            # anybody and without inventing a claim: the row still decides.
            _log.warn(
                "unknown_event", error_type="phone_assessment_unstarted",
                error_category=state.status,
            )
            # ── ADOPT A SCORED SCREENING, DO NOT RE-DO IT ────────────────
            # `already_scored` is the database saying: this session is
            # `completed` and a phone-sourced assessment row exists. There is
            # nothing to screen, nothing to score and nothing to write — the only
            # thing missing is the acknowledgement, which the leg that produced it
            # could not deliver.
            #
            # So this posts the completion DIRECTLY. It does not call the
            # completion endpoint, which would re-enter the scoring path to reach
            # the same row; it does not re-ask a question; and it cannot produce a
            # second writeback, because it performs no write at all. The post is
            # idempotent by 0042's deterministic internal event id, so a leg that
            # does this twice converges on the first verdict rather than writing a
            # second ledger row — and 0044's interlock accepts it precisely
            # because the row the RPC just found is there.
            if state.status == phone.ASSESSMENT_ALREADY_SCORED_STATUS:
                _log.info(
                    "unknown_event", error_type="phone_assessment_adopted",
                    error_category=state.status,
                )
                # The candidate is on the line and has just heard the recording
                # disclosure. Hanging up without a word on a leg that SUCCEEDED —
                # which is what an adoption is — would make a recovered screening
                # end worse than a failed one. The closing line is fixed copy and
                # is not a transcript turn, so saying it records nothing.
                await say(phone.PHONE_ASSESSMENT_CLOSING_TEXT)
                await events.post_event(attempt_id, "assessment.completed")
                await _close_phone_room(room_name)
                return result

            # `session_not_active` WITHOUT a row is the other half: the session was
            # completed but never scored. The completion endpoint can still finish
            # that, so it is asked — and the ROW still decides.
            if state.status == "session_not_active":
                recovered = await events.complete_assessment(attempt_id, session_id)
                if recovered.ok:
                    _log.info(
                        "unknown_event", error_type="phone_assessment_recovered",
                        error_category=recovered.status,
                    )
                    await say(phone.PHONE_ASSESSMENT_CLOSING_TEXT)
                    await events.post_event(attempt_id, "assessment.completed")
                    await _close_phone_room(room_name)
                    return result
                if phone.retryable_completion(recovered):
                    # Still no answer we can act on. Post NOTHING rather than
                    # terminalising a screening whose state we do not know.
                    _log.warn(
                        "unknown_event", error_type="phone_assessment_halted_leg",
                        error_category=phone.HALT_SCORING,
                    )
                    await _close_phone_room(room_name)
                    return result
            # No plan and nothing to recover. The leg ends without claiming
            # anything; `assessment.aborted` is the truthful terminal.
            await events.post_event(attempt_id, "assessment.aborted")
            await _close_phone_room(room_name)
            return result

        # 0071 / X4: the session is `in_progress` and the plan is snapshotted,
        # so every conversation item from here is a scored assessment turn.
        # Arm per-item persistence: `_on_phone_item` now writes each turn as it
        # lands (is_gate=false), giving the phone path the browser path's crash
        # durability. Gate-phase items above this line stay unpersisted here —
        # they belong to the is_gate=true gate writer.
        assessment_persist_active[0] = True

        return await _run_native_phone_screening(
            session=session,
            agent=agent,
            events=events,
            state=state,
            attempt_id=attempt_id,
            session_id=session_id,
            room_name=room_name,
            result=result,
            latest_assistant=latest_assistant,
            latest_assistant_anchor=latest_assistant_anchor,
            latest_candidate_anchor=latest_candidate_anchor,
            candidate_end_requested=candidate_end_requested,
            reply_started=reply_started,
            reply_handle=reply_handle,
            assistant_delivery_complete=assistant_delivery_complete,
            candidate_activity=candidate_activity,
            agent_listening=agent_listening,
            agent_activity_changed=agent_activity_changed,
            close_event=close_event,
            turn_mode=turn_mode,
        )

    heartbeat_task = asyncio.create_task(
        phone.run_phone_heartbeat(
            attempt_id=attempt_id,
            session_id=session_id,
            epoch=epoch,
            client=events,
            halt=halt_for_lease,
        )
    )
    try:
        screening = asyncio.ensure_future(_screen())
        running["screening"] = screening
        try:
            return await screening
        except asyncio.CancelledError:
            reason = lease_halt.get("reason")
            if reason is None:
                # Not ours. Someone cancelled this session for another reason
                # and swallowing that would hide a shutdown.
                raise
            # A LOST OR UNPROVABLE LEASE POSTS NOTHING — it is a retryable halt
            # in `phone.RETRYABLE_HALTS` for the same reason a failed boundary
            # is. The conversation is interrupted, not over: the reclaim sweep
            # has already restored the engagement's previous state, so
            # `assessment.aborted` would be untrue AND ignored (that edge is
            # gated on `in_call`), and `assessment.completed` would be a claim
            # about a screening that did not finish. 0042's reconnect budget
            # owns what happens next. The room is closed so the SIP leg on the
            # slot we no longer hold actually goes away.
            _log.warn(
                "unknown_event", error_type="phone_assessment_halted_leg",
                error_category=reason,
            )
            await _close_phone_room(room_name)
            return result
    finally:
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)
        # 0071 / X4: drain any in-flight per-item transcript writes so a clean
        # end does not drop the last turn's persistence. Best-effort and
        # bounded: a wedged write must not stall teardown, and the boundary
        # path remains the durable authority for anything not yet flushed.
        if persist_tasks:
            inflight = [t for t in persist_tasks if not t.done()]
            if inflight:
                try:
                    await asyncio.wait_for(
                        asyncio.gather(*inflight, return_exceptions=True),
                        timeout=PHONE_TERMINAL_REPLY_TIMEOUT_SEC,
                    )
                except asyncio.TimeoutError:
                    _log.warn(
                        "unknown_event", error_type="phone_item_persist",
                        error_category="item_persist_drain_timeout",
                    )




async def _close_phone_room(room_name: str) -> None:
    """Delete the room so the SIP leg is torn down. Best effort, never raises
    into the gate's decision."""
    # F0c — THE INVARIANT ENFORCER. Every phone room deletion funnels through
    # here, so a single log line at this chokepoint guarantees NO room is ever
    # deleted without an attributable log — the property whose absence let a
    # healthy `sip.callStatus: "active"` call be killed silently on 2026-08-29.
    # The specific terminal REASON is named by the caller (the main loop's
    # `phone_room_teardown` / the lease-cancel `phone_assessment_halted_leg`
    # logs) because only the caller knows it; this line proves the deletion
    # itself is never invisible even on the pre-conversation gate-refusal paths.
    # Fixed strings only — no room name, ids, or transcript.
    _log.info(
        "unknown_event", error_type="phone_room_deleted",
    )
    try:
        await _delete_livekit_room(room_name)
    except Exception:  # noqa: BLE001
        _log.warn(
            "unknown_event",
            error_type="phone_room_close_failed",
            error_category="room_delete",
        )


async def entrypoint(ctx: JobContext) -> None:
    started_at = _monotonic()

    # P4: channel isolation, decided BEFORE ctx.connect(). A worker that does
    # not own this room must not connect, must not speak, must not activate and
    # must not write a single row — so the check happens on the job's room
    # identity, which is available before any media connection exists.
    room_identity = _room_name_from_context(ctx)
    room_metadata = _room_metadata_from_context(ctx)
    if not _worker_handles_room(room_identity, room_metadata):
        _log.info(
            "unknown_event",
            error_type="worker_room_skipped",
            schema="phone" if phone.is_phone_room(room_identity, room_metadata) else "browser",
        )
        return

    if _phone_agent_name():
        await _run_phone_entrypoint(ctx, room_identity)
        return

    await ctx.connect()
    meta = collect_prompt_metadata(ctx)
    room_name = str(meta.get("room_name") or _room_name_from_context(ctx) or "")
    session_id = meta.get("session_id") or meta.get("sessionId") or _session_id_from_room_name(room_name)
    _log.info(
        "worker_context_resolution_start",
        has_room_name=bool(room_name),
        has_session_id=bool(session_id),
        room_name_source="metadata_or_context" if room_name else "missing",
    )
    cid_token = set_correlation_id(meta.get("correlation_id"))

    # HIGH SEC-13: Resolve worker context from API (server-side lookup).
    # Never restore sensitive room metadata from client-visible data.
    worker_ctx: WorkerContext | None = None
    if session_id:
        # Resolve authorized context with a bounded retry. The worker still fails
        # the session CLOSED when context cannot be resolved — but a single
        # transient failure (API cold start / DB blip) must not permanently
        # abandon a valid call, which left candidates with a joined room and no
        # bot. A genuinely-absent or unauthorized session still fails closed
        # after the attempts are exhausted.
        resolved = await _resolve_worker_context_with_retry(
            str(session_id),
            str(room_name),
            attempts=max(1, _int_env("WORKER_CONTEXT_RESOLVE_ATTEMPTS", 3)),
            backoff_sec=_float_env("WORKER_CONTEXT_RESOLVE_BACKOFF_SEC", 1.5),
        )
        if isinstance(resolved, WorkerContext):
            worker_ctx = resolved
        else:
            # Hosted jobs fail closed when authorized context cannot be resolved.
            _log.warn(
                "worker_context_resolution_failed",
                error_category=str(resolved),
                has_room_name=bool(room_name),
                has_session_id=bool(session_id),
            )
            await persistence.fail_session(
                str(session_id), "worker_crash", expected_status="waiting",
            )
            reset_correlation_id(cid_token)
            return

    try:
        await _run_session(ctx, started_at, session_id, worker_ctx, room_name)
    finally:
        reset_correlation_id(cid_token)


async def _run_session(
    ctx: JobContext,
    started_at: float,
    session_id: Any,
    worker_ctx: WorkerContext | None,
    room_name: str,
) -> None:
    # LLM-06: claim provenance before any provider construction. The same
    # configured model is then supplied directly to Gemini below.
    claim = await persistence.set_session_provenance(
        session_id,
        screening_provenance(GEMINI_MODEL),
    )
    if claim not in {
        persistence.ClaimResult.CLAIMED,
        persistence.ClaimResult.ALREADY_MATCHING,
    }:
        return

    # HIGH SEC-13: Build prompt from server-verified worker context,
    # never from client-visible room/participant metadata.
    if worker_ctx is not None:
        sys_text = system_prompt(
            candidate_name=worker_ctx.candidate_name,
            role_title=worker_ctx.role_title,
            role_focus=worker_ctx.role_focus,
            resume_facts=None,
            questions=prompting_format_questions(worker_ctx.screening_template),
            interviewer_instructions=worker_ctx.interviewer_instructions,
        )
        open_text = opening_line(
            candidate_name=worker_ctx.candidate_name,
            role_title=worker_ctx.role_title,
        )
    else:
        # Fallback (no server context) — use env-only prompt, no room metadata
        sys_text = system_prompt(
            candidate_name=None,
            role_title=None,
            role_focus=None,
            resume_facts=None,
            questions=None,
        )
        open_text = opening_line(
            candidate_name=None,
            role_title=None,
        )

    system_text = sys_text
    opening_text = open_text

    # REL-07: separate write-task set from the finalizer.
    # ONLY transcript writes go here; complete_once is never added.
    _write_tasks: set[asyncio.Task] = set()
    _background_tasks: set[asyncio.Task] = set()
    _finalizer_task: asyncio.Task | None = None
    _silence_task: asyncio.Task | None = None
    candidate_activity = asyncio.Event()
    room_close_started = False

    def tracked_write(coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        # Keep completed tasks until finalization. Removing a completed failed
        # task here makes drain_pending_writes() see an empty set and can mark a
        # session completed/scored even though every transcript insert failed.
        # A session has a bounded number of turns, so retaining these tasks for
        # the session lifetime is small and lets the terminal drain observe
        # both pending work and already-completed exceptions.
        _write_tasks.add(task)
        return task

    def tracked_background(coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
        return task

    async def close_room_once() -> None:
        nonlocal room_close_started
        if room_close_started:
            return
        room_close_started = True
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                await _delete_livekit_room(room_name)
                return
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if attempt < 2:
                    await asyncio.sleep(float(attempt + 1))
        room_close_started = False
        if last_error is not None:
            raise last_error

    # REL-07: activate session — fail closed on ANY non-SUCCESS outcome.
    activate_result = await persistence.activate_session(session_id)
    if not activate_result.ok:
        # CONFLICT, ERROR, DISABLED, or missing session_id — abort before
        # any provider construction or session.start() call.
        return
    _activation_applied: bool = True

    _cleanup_started = False
    _close_event = asyncio.Event()
    candidate_left_normally = False

    def _mark_candidate_left_normally(event: Any = None) -> None:
        """Remember a LiveKit participant-initiated leave across SDK close shapes.

        Some SDK versions log the room participant disconnect reason separately
        from the later AgentSession close event. Preserve that authoritative
        client-initiated signal so a candidate pressing Leave while TTS is still
        flushing is treated as a completed screening, not as worker_crash.
        """
        nonlocal candidate_left_normally
        reason = getattr(event, "reason", None) or getattr(event, "disconnect_reason", None)
        if reason is None or _is_normal_disconnect_reason(reason):
            candidate_left_normally = True

    room_on = getattr(getattr(ctx, "room", None), "on", None)
    if callable(room_on):
        def _participant_disconnected(event: Any = None) -> None:
            _mark_candidate_left_normally(event)

        try:
            registered = room_on("participant_disconnected")
            if callable(registered):
                registered(_participant_disconnected)
        except Exception:  # noqa: BLE001
            try:
                room_on("participant_disconnected", _participant_disconnected)
            except Exception:  # noqa: BLE001
                pass

    # OBS-06: parent span covering the whole voice session lifecycle.
    # Created only after activation succeeded — sessions that never started
    # are not instrumented.  Ended in the finally block AFTER the finalizer
    # completes so child spans always end before the parent.  Guarded start:
    # a broken tracer must never break the business flow.
    session_span = _start_span_guarded("voice_session")

    async def complete_once(failed_reason: str | None = None) -> None:
        """Terminate the session exactly once.

        Drains _write_tasks then marks the session terminal.
        If terminal CAS returns ERROR/DISABLED, raises LifecycleError.
        Instrumentation (finalize span + bounded outcome counter + duration
        histograms) is emitted ONLY after a successful terminal CAS.
        """
        nonlocal _cleanup_started
        if _cleanup_started:
            return
        _cleanup_started = True
        finalize_started = _monotonic()

        async def _finalize(span: Span | None) -> None:
            duration = int(_monotonic() - started_at)
            activated = _activation_applied

            drained = await persistence.drain_pending_writes(_write_tasks)
            expected = "in_progress" if activated else "waiting"
            outcome: str | None = None

            if not drained:
                result = await persistence.fail_session(
                    session_id, "shutdown_forced", expected_status=expected,
                )
                if not result.ok:
                    raise LifecycleError(f"terminal CAS failed after drain timeout: {result.kind}")
                outcome = "shutdown_forced"

            elif failed_reason:
                result = await persistence.fail_session(
                    session_id, failed_reason, expected_status=expected,
                )
                if not result.ok:
                    raise LifecycleError(f"terminal CAS failed for {failed_reason}: {result.kind}")
                outcome = failed_reason

            elif activated:
                result = await persistence.complete_session(
                    session_id, duration, terminal_reason="conversation_complete"
                )
                if not result.ok:
                    raise LifecycleError(f"terminal CAS failed for complete: {result.kind}")
                await persistence.trigger_scoring(session_id)
                outcome = None

            else:
                # Not activated and no failure reason — nothing to persist.
                return

            # Successful terminal transition — emit bounded metrics only.
            bounded = _bounded_outcome(outcome)
            if span is not None:
                span.set_attributes({"outcome": bounded})
            _safe_emit(counter_metric, "session_outcome_total", 1.0, {"outcome": bounded})
            _safe_emit(histogram_metric, "session_finalize_duration_sec",
                       round(_monotonic() - finalize_started, 3))
            _safe_emit(histogram_metric, "session_duration_sec", float(duration))

        await _run_span_guarded("session_finalize", _finalize, parent=session_span)

    # ── Provider lifecycle — wrapped in try/finally ────────────────
    try:
        turn_index = 0

        def _next_turn_index() -> int:
            nonlocal turn_index
            idx = turn_index
            turn_index += 1
            return idx

        async def record_turn(speaker: str, text: str, turn_started_at_ms: int | None = None) -> None:
            if not text:
                return
            turn_started = _monotonic()

            async def _persist(span: Span | None) -> None:
                await persistence.save_turn(
                    session_id, _next_turn_index(), speaker, text,
                    turn_started_at_ms=turn_started_at_ms,
                )
                if span is not None:
                    span.set_attributes({"speaker": speaker})
                _safe_emit(histogram_metric, "session_turn_persistence_duration_sec",
                           round(_monotonic() - turn_started, 3), {"speaker": speaker})

            await _run_span_guarded("turn_persistence", _persist, parent=session_span)

        session: AgentSession | None = None
        opening_recorded = False
        latest_speech_handle: Any = None
        natural_close_scheduled = False

        async def _setup_session(span: Span | None) -> None:
            nonlocal session
            # The browser and phone paths share this exact AgentSession
            # provider/turn construction. Channel-specific code begins only at
            # the gate, persistence, and presentation handlers below.
            session = _build_provider_session()

            @session.on("speech_created")
            def _on_speech_created(event):  # noqa: ANN001
                nonlocal latest_speech_handle
                latest_speech_handle = getattr(event, "speech_handle", None)

            @session.on("user_state_changed")
            def _on_user_state_changed(event):  # noqa: ANN001
                if getattr(event, "new_state", None) in {"speaking", "listening"}:
                    candidate_activity.set()

            @session.on("conversation_item_added")
            def _on_conversation_item(event):  # noqa: ANN001
                nonlocal opening_recorded, natural_close_scheduled, _silence_task
                item = getattr(event, "item", None)
                role = getattr(item, "role", None)
                if role not in {"assistant", "user"}:
                    return
                _record_turn_metrics(item, "webrtc")
                if role == "assistant" and getattr(item, "interrupted", False):
                    return
                text = _item_text(item)
                if role == "user":
                    candidate_activity.set()
                if role == "assistant" and opening_recorded and text == opening_text:
                    return
                speaker = "bot" if role == "assistant" else "candidate"
                tracked_write(record_turn(speaker, text, _turn_anchor_ms(item)))
                if (
                    role == "assistant"
                    and _is_final_goodbye(text)
                    and not natural_close_scheduled
                ):
                    natural_close_scheduled = True
                    candidate_activity.set()
                    if _silence_task is not None:
                        _silence_task.cancel()
                    speech_handle = getattr(session, "current_speech", None) or latest_speech_handle
                    tracked_background(
                        _close_after_playout(
                            speech_handle,
                            close_room_once,
                        )
                    )

            @session.on("close")
            def _on_close(event):  # noqa: ANN001
                nonlocal _finalizer_task  # *** CRITICAL: outer scope assignment ***
                failed_reason = None if candidate_left_normally else _classify_close_event(event)
                _finalizer_task = asyncio.create_task(complete_once(failed_reason))
                _close_event.set()

            await session.start(
                agent=Christy(system_text),
                room=ctx.room,
                record={"audio": True, "transcript": True, "traces": False, "logs": False},
            )

        setup_started = _monotonic()
        await _run_span_guarded("session_setup", _setup_session, parent=session_span)
        _safe_emit(histogram_metric, "session_setup_duration_sec",
                   round(_monotonic() - setup_started, 3))

        async def _generate_reply(span: Span | None) -> None:
            nonlocal opening_recorded
            opening_recorded = True
            say = getattr(session, "say", None)
            if callable(say):
                speech = say(opening_text)
                wait_for_playout = getattr(speech, "wait_for_playout", None)
                if callable(wait_for_playout):
                    await wait_for_playout()
            else:
                speech = session.generate_reply(instructions=opening_text)
                if inspect.isawaitable(speech):
                    speech = await speech
                wait_for_playout = getattr(speech, "wait_for_playout", None)
                if callable(wait_for_playout):
                    await wait_for_playout()
            tracked_write(record_turn("bot", opening_text))

        generate_started = _monotonic()
        await _run_span_guarded("session_generate_reply", _generate_reply, parent=session_span)
        _safe_emit(histogram_metric, "session_generate_reply_duration_sec",
                   round(_monotonic() - generate_started, 3))

        _silence_task = tracked_background(
            _silence_termination_loop(
                session,
                candidate_activity,
                close_room_once,
                prompt_after_sec=CANDIDATE_SILENCE_PROMPT_SEC,
                end_after_sec=CANDIDATE_SILENCE_END_SEC,
            )
        )

        # Await session closure — keeps entrypoint alive until close fires,
        # but no longer forever. See SESSION_MAX_RESIDENCY_SEC.
        try:
            await asyncio.wait_for(
                _close_event.wait(), timeout=SESSION_MAX_RESIDENCY_SEC
            )
        except asyncio.TimeoutError:
            # Caught EXPLICITLY here rather than falling through to the generic
            # handler below. asyncio.TimeoutError IS an Exception, so without
            # this the residency cap would persist `worker_crash` — a false
            # attribution that also pollutes the real crash signal. The
            # truthful code is `residency_timeout`, which required widening
            # BOTH persistence._FAILED_REASONS and the 0006
            # chk_call_sessions_terminal_reason CHECK (0038 §8); neither alone
            # is sufficient, and fail_session rejects anything outside the set.
            await complete_once(
                None if candidate_left_normally else "residency_timeout"
            )

    except Exception as exc:
        if session_span is not None:
            session_span.set_error(exc)
        # Provider construction/start/generate failed before close event. If the
        # room already told us the candidate intentionally disconnected, prefer
        # normal completion over a false worker_crash.
        await complete_once(None if candidate_left_normally else "worker_crash")
    finally:
        # If our own goodbye initiated room deletion, let that request finish;
        # otherwise cancel idle timers immediately on an external disconnect.
        if not room_close_started:
            for task in tuple(_background_tasks):
                if not task.done():
                    task.cancel()
        if _background_tasks:
            await asyncio.gather(*tuple(_background_tasks), return_exceptions=True)
        try:
            if _finalizer_task is not None:
                try:
                    await _finalizer_task
                except LifecycleError:
                    raise
                except Exception:  # noqa: BLE001
                    pass
        finally:
            # The parent span ends even when a LifecycleError propagates out
            # of the finalizer — exception paths must end spans.
            if session_span is not None:
                session_span.end()


if __name__ == "__main__":
    cli.run_app(build_worker_options())
