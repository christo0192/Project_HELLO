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
from collections.abc import Mapping
from typing import Any, Awaitable, Callable

from dotenv import load_dotenv

from livekit import api as livekit_api
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import openai, sarvam

import persistence
import phone
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
    content = getattr(item, "content", None) or []
    chunks: list[str] = []
    for part in content:
        if isinstance(part, str):
            chunks.append(part)
        elif hasattr(part, "text"):
            chunks.append(str(part.text))
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
    return persistence.normalize_turn_anchor_ms(getattr(item, "created_at", None))


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

    Symmetric, deliberately: the unnamed browser worker handles everything that
    is not a phone room, and the named phone worker handles nothing else. A
    worker dispatched into the other channel's room returns without connecting.
    """
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
        # Production default prewarms multiple idle job processes. That is
        # too memory-heavy for the single shared Fly worker used here and
        # can leave browser joins stuck with no assistant audio. Start job
        # processes only on demand.
        "num_idle_processes": 0,
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
_PHONE_NO_RECORDING = {"audio": False, "transcript": False, "traces": False, "logs": False}


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
) -> str:
    """Read the response to the disclosure, re-asking at most once.

    Turn-bounded here; wall-clock-bounded by the gate, which runs this under a
    hard timeout — so neither a silent line nor an endlessly chatty one can keep
    the call in the unclassified state where recording is forbidden and the
    conversation has not started.
    """
    for attempt in range(max(1, attempts)):
        text = await turns.get()
        decision = classify_answer_text(text)
        if decision is not None:
            return decision
        if attempt + 1 < attempts:
            await say(phone.PHONE_REASK_TEXT)
    return phone.CLASSIFY_MACHINE


def phone_question_instructions(question: "phone.PhonePlanQuestion") -> str:
    """The instruction handed to the model for ONE plan question.

    The model may phrase it however it likes — that is the whole point of a
    voice screening — but it is told exactly which question it is covering,
    and it is told not to move on. Which question was covered is never
    inferred afterwards from what was said; it comes from this call site and
    from the key committed with the answer.
    """
    lines = [
        "Ask the candidate this one question now, in your own natural words:",
        question.text,
        "",
        "Ask ONLY this. Do not move on to another topic, do not summarise the "
        "call, and do not say goodbye.",
    ]
    if question.hint:
        lines.append(f"If their answer is thin, the thing worth probing is: {question.hint}")
    return "\n".join(lines)


async def _ask_phone_question(
    *,
    generate: Callable[[str], Awaitable[Any]],
    exchange: "asyncio.Queue[dict[str, str]]",
    question: "phone.PhonePlanQuestion",
    answer_timeout_sec: float,
    follow_up: bool,
) -> list[dict[str, str]]:
    """Put ONE question and collect the ordered exchange that answers it.

    Returns whatever it captured, including nothing. It does NOT decide whether
    the result is a completed boundary — `phone.valid_boundary_turns` and the
    database both do, and this function having its own opinion is how the two
    would drift.

    The wait is bounded by a WALL CLOCK, not by a turn counter: a candidate who
    goes quiet mid-answer produces no further items at all, so a counter would
    never be reached.
    """
    # Anything already queued belongs to the previous boundary or to the
    # disclosure exchange. Carrying it forward would attach one question's
    # answer to another question's key.
    while not exchange.empty():
        try:
            exchange.get_nowait()
        except asyncio.QueueEmpty:  # pragma: no cover - defensive
            break

    turns: list[dict[str, str]] = []
    rounds = 2 if follow_up else 1
    for round_index in range(rounds):
        if round_index == 0:
            await generate(phone_question_instructions(question))
        else:
            await generate(
                "Ask ONE short follow-up about what they just said, then stop. "
                "Do not change the subject and do not say goodbye."
            )
        deadline = _monotonic() + answer_timeout_sec
        while len(turns) < 12:
            remaining = deadline - _monotonic()
            if remaining <= 0:
                return turns
            try:
                item = await asyncio.wait_for(exchange.get(), timeout=remaining)
            except asyncio.TimeoutError:
                return turns
            turns.append(item)
            if item.get("speaker") == "candidate":
                break
        if not turns or turns[-1].get("speaker") != "candidate":
            return turns
    return turns


async def _apply_phone_instructions(agent: Any, state: "phone.PhoneAssessmentState") -> bool:
    """Give the agent the REAL instructions, once the plan is known.

    The question flow is formatted through `prompting.format_questions`, the
    SAME helper the browser path uses, so the two prompts cannot drift into
    different shapes. The plan's `key` is deliberately NOT put in the prompt:
    the model is never asked to report which question it covered, because
    which question was covered is decided by the call site and committed with
    the key — never read back out of prose.

    A RESUMING leg also gets the persisted exchange replayed into the prompt,
    bounded by `phone.render_resume_context`, so the model can refer to what the
    candidate already said instead of starting the conversation over. It is
    never asked to work out from that transcript which questions REMAIN — that
    comes from the cursor, and inferring question identity from prose is the
    failure this whole phase exists to prevent.

    Best effort by design. If the SDK's Agent has no writable `instructions`,
    the screening still runs on the base prompt and every boundary is still
    keyed and committed correctly; the questions are simply less tailored.
    """
    try:
        flow = prompting_format_questions([
            {"id": q.key, "question": q.text, "mandatory": q.mandatory}
            for q in state.questions
        ])
        text = system_prompt(
            candidate_name=state.candidate_name,
            role_title=None,
            role_focus=None,
            resume_facts=None,
            questions=flow,
        )
        resume = phone.render_resume_context(state.turns)
        if resume:
            text = f"{text}\n\n{resume}"
        return await _deliver_phone_instructions(agent, text)
    except Exception:  # noqa: BLE001
        _log.warn(
            "unknown_event", error_type="phone_instructions_not_applied",
            error_category="agent_instructions",
        )
        return False


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


async def _run_phone_entrypoint(ctx: JobContext, room_name: str) -> None:
    """Named-worker entry for a phone room.

    The attempt id comes off the per-attempt DISPATCH metadata, never off the
    room name: the room is keyed by SESSION so one session's reconnect attempts
    share a transcript, and a session id posted as an ``attempt_id`` resolves to
    no attempt at all — every event would come back ``ignored:
    unknown_attempt`` and nothing would ever be recorded for the call.
    """
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

    user_turns: "asyncio.Queue[str]" = asyncio.Queue()
    # 0044: the ORDERED exchange, both speakers, in the order the SDK produced
    # them. `user_turns` stays a separate, candidate-only queue because the
    # disclosure classifier reads it and must not be handed the bot's own
    # lines. Two queues rather than one filtered read: a filter is a thing a
    # later edit can forget to apply.
    exchange: "asyncio.Queue[dict[str, str]]" = asyncio.Queue()
    candidate_activity = asyncio.Event()
    close_event = asyncio.Event()
    close_reason: dict[str, Any] = {}

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
    )

    @session.on("conversation_item_added")
    def _on_phone_item(event):  # noqa: ANN001
        item = getattr(event, "item", None)
        role = getattr(item, "role", None)
        if role not in {"user", "assistant"}:
            return
        # An INTERRUPTED assistant line was not fully spoken, so recording it
        # as a bot turn would put words in the transcript the candidate never
        # heard — and the scorer reads that transcript.
        if role == "assistant" and getattr(item, "interrupted", False):
            return
        text = _item_text(item)
        if not text:
            return
        if role == "user":
            candidate_activity.set()
            user_turns.put_nowait(text)
        elif phone.is_gate_copy(text):
            # FIXED COPY IS NOT A SCREENING TURN. The disclosure, the re-ask,
            # every refusal closing, the callback confirmations and the closing
            # line are all spoken through `session.say`, which appends a
            # conversation item exactly like a generated turn does. Left in the
            # queue, a scheduling confirmation spoken mid-call would be
            # captured inside whichever question's boundary happened to be open
            # and committed as part of the candidate's answer.
            return
        exchange.put_nowait({
            "speaker": "candidate" if role == "user" else "bot",
            "text": text,
        })

    @session.on("close")
    def _on_phone_close(event):  # noqa: ANN001
        close_reason["reason"] = _classify_close_event(event)
        close_event.set()

    async def say(text: str) -> None:
        speech = session.say(text, allow_interruptions=False)
        wait_for_playout = getattr(speech, "wait_for_playout", None)
        if callable(wait_for_playout):
            await wait_for_playout()

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
        await session.start(agent=agent, room=ctx.room, record=dict(_PHONE_NO_RECORDING))
        return participant

    async def classify() -> str:
        if classifier is not None:
            return await classifier(user_turns, say)
        return await _classify_phone_answer(user_turns, say)

    result = await phone.run_phone_gate(
        attempt_id=attempt_id,
        client=events,
        wait_for_participant=wait_for_participant,
        classify=classify,
        say=say,
        start_recording=_phone_recording_permitted,
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
        state = await events.start_assessment(attempt_id, session_id)
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

        # The plan is now known, so the agent is given the REAL instructions: the
        # candidate's name and the ordered question flow, in the same shape the
        # browser path has always used.
        if not await _apply_phone_instructions(agent, state):
            # The screening still runs — the question text reaches the model
            # through `generate_reply`, and every boundary is still keyed and
            # committed by the cursor. What is lost is the tailoring and the
            # resume replay, so this is worth SEEING rather than swallowing.
            _log.warn(
                "unknown_event", error_type="phone_instructions_not_applied",
                error_category="not_delivered",
            )

        silence_task = asyncio.create_task(
            _silence_termination_loop(
                session,
                candidate_activity,
                lambda: _close_phone_room(room_name),
                prompt_after_sec=CANDIDATE_SILENCE_PROMPT_SEC,
                end_after_sec=CANDIDATE_SILENCE_END_SEC,
            )
        )

        async def generate(instructions: str) -> None:
            speech = session.generate_reply(instructions=instructions)
            if inspect.isawaitable(speech):
                speech = await speech
            wait_for_playout = getattr(speech, "wait_for_playout", None)
            if callable(wait_for_playout):
                await wait_for_playout()

        async def ask(question: Any, cursor: int) -> list[dict[str, str]]:
            return await _ask_phone_question(
                generate=generate,
                exchange=exchange,
                question=question,
                answer_timeout_sec=phone.phone_answer_timeout_sec(),
                follow_up=bool(question.hint),
            )

        try:
            assessment = await asyncio.wait_for(
                phone.run_phone_assessment(
                    attempt_id=attempt_id,
                    session_id=session_id,
                    client=events,
                    state=state,
                    ask=ask,
                    say=say,
                ),
                timeout=SESSION_MAX_RESIDENCY_SEC,
            )
        except asyncio.TimeoutError:
            # The residency cap. Nothing is claimed and nothing is terminalised as
            # a persistence failure: the conversation ran out of room, which is the
            # `assessment.aborted` case.
            assessment = phone.PhoneAssessmentResult()
        finally:
            silence_task.cancel()
            await asyncio.gather(silence_task, return_exceptions=True)

        # ── THE CONDITIONAL P4a DELIBERATELY LEFT OUT ─────────────────────
        # P4a posted `assessment.aborted` UNCONDITIONALLY and said so out loud:
        # the conditional belonged back here "when the persistence path exists,
        # and its condition must be 'scoring SUCCEEDED', not 'the room closed
        # cleanly'". This is that conditional, and that is its condition.
        #
        # `assessment.completed` drives 0042 to terminal `completed`, which every
        # downstream reader treats as a SCORED screening — so it is posted only
        # when the API has VERIFIED an assessment row exists. 0044's
        # `apply_phone_event` refuses the event anyway if the row is absent, so
        # this is the first of two gates rather than the only one.
        if assessment.scored:
            await events.post_event(attempt_id, "assessment.completed")
        elif phone.halt_is_retryable(assessment.halt_reason):
            # AN INFRASTRUCTURE FAILURE POSTS NOTHING.
            # The conversation is not over, it is interrupted. Both terminal
            # events available here would end the engagement: `assessment.aborted`
            # is terminal `failed`, and `assessment.completed` would be a lie. A
            # dropped or unwritable leg is what 0042's reconnect budget is FOR, and
            # the webhook's `sip.participant_left` drives it. Posting a terminal
            # event here would convert a retryable problem into a lost candidate —
            # the mirror of the P4a defect: stopping something that fails loudly
            # can make it fail silently, so this branch is logged.
            #
            # ONLY the infrastructure halts reach here. A candidate who simply
            # stopped answering is NOT a line drop, and laundering it into one
            # would let the webhook grant and CHARGE a reconnect — dialling that
            # candidate back up to three times for having gone quiet.
            _log.warn(
                "unknown_event", error_type="phone_assessment_halted_leg",
                error_category=assessment.halt_reason,
            )
        else:
            await events.post_event(attempt_id, "assessment.aborted")
        await _close_phone_room(room_name)
        return result

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




async def _close_phone_room(room_name: str) -> None:
    """Delete the room so the SIP leg is torn down. Best effort, never raises
    into the gate's decision."""
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
            role_title=None,
            role_focus=None,
            resume_facts=None,
            questions=None,
        )
        open_text = opening_line(
            candidate_name=worker_ctx.candidate_name,
            role_title=None,
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
            session = AgentSession(
                stt=sarvam.STT(
                    model=os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
                    language=os.getenv("SARVAM_LANGUAGE", "en-IN"),
                ),
                tts=sarvam.TTS(
                    model=os.getenv("SARVAM_TTS_MODEL", "bulbul:v3"),
                    speaker=os.getenv("SARVAM_TTS_VOICE", "simran"),
                ),
                # LiveKit's OpenAI-compatible adapter always consumes a token
                # stream. Point it directly at Google so first tokens are not
                # delayed by the previous iKey gateway hop.
                llm=openai.LLM(
                    model=GEMINI_MODEL,
                    api_key=os.getenv("GEMINI_API_KEY"),
                    base_url=GEMINI_BASE_URL,
                ),
                # Do not provide custom VAD or turn-detection components here.
                # LiveKit Agents owns turn handling via its AgentSession defaults.
                # This avoids deprecated endpointing knobs and keeps behavior on
                # the SDK-supported path.
            )

            @session.on("metrics_collected")
            def _on_metrics_collected(event):  # noqa: ANN001
                _record_provider_metrics(event)

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
