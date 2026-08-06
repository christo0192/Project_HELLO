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
from typing import Any, Callable

from dotenv import load_dotenv

from livekit import api as livekit_api
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import openai, sarvam

import persistence
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
from prompting import build_prompt_context, collect_prompt_metadata, opening_line, system_prompt
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


async def _silence_termination_loop(
    session: Any,
    candidate_activity: asyncio.Event,
    close_room_once: Callable[[], Any],
    *,
    prompt_after_sec: float,
    end_after_sec: float,
) -> None:
    """Prompt once per silent period, then speak a final goodbye and close.

    Candidate activity restarts the full silence window. The final room close
    occurs only after the goodbye's SpeechHandle confirms playout.
    """
    while True:
        candidate_activity.clear()
        try:
            await asyncio.wait_for(candidate_activity.wait(), timeout=prompt_after_sec)
            continue
        except asyncio.TimeoutError:
            pass

        prompt_handle = session.say(
            "Are you still there? No worries if you need a moment.",
            allow_interruptions=True,
        )
        await prompt_handle.wait_for_playout()

        candidate_activity.clear()
        try:
            await asyncio.wait_for(candidate_activity.wait(), timeout=end_after_sec)
            continue
        except asyncio.TimeoutError:
            pass

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


async def entrypoint(ctx: JobContext) -> None:
    started_at = _monotonic()
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
        _write_tasks.add(task)
        task.add_done_callback(_write_tasks.discard)
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

        # Await session closure — keeps entrypoint alive until close fires
        await _close_event.wait()

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
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            # Production default prewarms multiple idle job processes. That is
            # too memory-heavy for the single shared Fly worker used here and
            # can leave browser joins stuck with no assistant audio. Start job
            # processes only on demand.
            num_idle_processes=0,
            initialize_process_timeout=60.0,
            job_memory_warn_mb=1400,
            job_memory_limit_mb=0,
        )
    )
