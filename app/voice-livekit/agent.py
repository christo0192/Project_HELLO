"""
    SPIKE: LiveKit Agents voice worker (Gopu screening interviewer).
Sarvam STT/TTS + silero VAD endpointing + DeepSeek LLM.
"""

from __future__ import annotations

import os
import re
import time
import asyncio
from typing import Any, Callable

from dotenv import load_dotenv

from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import openai, sarvam, silero

import persistence
from observability import (
    Span,
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

DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
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


class Gopu(Agent):
    def __init__(self, instructions: str) -> None:
        super().__init__(instructions=instructions)


def _item_text(item: Any) -> str:
    content = getattr(item, "content", None) or []
    chunks: list[str] = []
    for part in content:
        if isinstance(part, str):
            chunks.append(part)
        elif hasattr(part, "text"):
            chunks.append(str(part.text))
    return "".join(chunks).strip()


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


def _classify_close_event(event: Any) -> str | None:
    """Classify a close event into terminal_reason or None (normal complete).

    Uses an explicit mapping of SDK close-status values only.
    Never inspects raw reason text.

    Returns:
      None → conversation_complete (requires explicit completion signal).
      str  → terminal_reason code (fail/shutdown).

    Unknown or missing close reason → worker_crash (fail closed).
    A completed interview requires an explicit completion signal;
    arbitrary participant disconnect without evidence is NOT completion.
    """
    error = getattr(event, "error", None)
    if error is not None:
        error_name = type(error).__name__.lower()
        # Check key existence explicitly — None is a valid mapped value
        # (meaning conversation_complete), distinct from "key not found".
        if error_name in _CLOSE_ERROR_NAME_TO_TERMINAL:
            return _CLOSE_ERROR_NAME_TO_TERMINAL[error_name]
        return "worker_crash"

    reason = getattr(event, "reason", None)
    if reason is not None:
        reason_str = str(getattr(reason, "name", reason)).lower()
        if reason_str in _CLOSE_REASON_TO_TERMINAL:
            return _CLOSE_REASON_TO_TERMINAL[reason_str]
        return "worker_crash"

    # No error and no explicit close reason → not a confirmed completion
    return "worker_crash"


async def entrypoint(ctx: JobContext) -> None:
    started_at = _monotonic()
    await ctx.connect()
    meta = collect_prompt_metadata(ctx)
    room_name = str(meta.get("room_name") or _room_name_from_context(ctx) or "")
    session_id = meta.get("session_id") or meta.get("sessionId") or _session_id_from_room_name(room_name)
    cid_token = set_correlation_id(meta.get("correlation_id"))

    # HIGH SEC-13: Resolve worker context from API (server-side lookup).
    # Never restore sensitive room metadata from client-visible data.
    worker_ctx: WorkerContext | None = None
    if session_id:
        resolved = await persistence.resolve_worker_context(str(session_id), str(room_name))
        if isinstance(resolved, WorkerContext):
            worker_ctx = resolved
        else:
            # Hosted jobs fail closed when authorized context cannot be resolved.
            await persistence.fail_session(
                str(session_id), "worker_crash", expected_status="waiting",
            )
            reset_correlation_id(cid_token)
            return

    try:
        await _run_session(ctx, started_at, session_id, worker_ctx)
    finally:
        reset_correlation_id(cid_token)


async def _run_session(ctx: JobContext, started_at: float, session_id: Any, worker_ctx: WorkerContext | None) -> None:
    # LLM-06: claim provenance before any provider construction. The same
    # configured model is then supplied to DeepSeek below.
    claim = await persistence.set_session_provenance(
        session_id,
        screening_provenance(DEEPSEEK_MODEL),
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
    _finalizer_task: asyncio.Task | None = None

    def tracked_write(coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        _write_tasks.add(task)
        task.add_done_callback(_write_tasks.discard)
        return task

    # REL-07: activate session — fail closed on ANY non-SUCCESS outcome.
    activate_result = await persistence.activate_session(session_id)
    if not activate_result.ok:
        # CONFLICT, ERROR, DISABLED, or missing session_id — abort before
        # any provider construction or session.start() call.
        return
    _activation_applied: bool = True

    _cleanup_started = False
    _close_event = asyncio.Event()

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

        async def record_turn(speaker: str, text: str) -> None:
            if not text:
                return
            turn_started = _monotonic()

            async def _persist(span: Span | None) -> None:
                await persistence.save_turn(session_id, _next_turn_index(), speaker, text)
                if span is not None:
                    span.set_attributes({"speaker": speaker})
                _safe_emit(histogram_metric, "session_turn_persistence_duration_sec",
                           round(_monotonic() - turn_started, 3), {"speaker": speaker})

            await _run_span_guarded("turn_persistence", _persist, parent=session_span)

        session: AgentSession | None = None

        async def _setup_session(span: Span | None) -> None:
            nonlocal session
            session = AgentSession(
                stt=sarvam.STT(
                    model=os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
                    language=os.getenv("SARVAM_LANGUAGE", "en-IN"),
                ),
                tts=sarvam.TTS(
                    model=os.getenv("SARVAM_TTS_MODEL", "bulbul:v3"),
                    speaker=os.getenv("SARVAM_TTS_VOICE", "shubh"),
                ),
                llm=openai.LLM(
                    model=DEEPSEEK_MODEL,
                    api_key=os.getenv("DEEPSEEK_API_KEY"),
                    base_url=DEEPSEEK_BASE_URL,
                ),
                vad=silero.VAD.load(
                    activation_threshold=_float_env("LIVEKIT_VAD_ACTIVATION_THRESHOLD", 0.7),
                    min_speech_duration=_float_env("LIVEKIT_VAD_MIN_SPEECH_DURATION", 0.3),
                    min_silence_duration=_float_env("LIVEKIT_VAD_MIN_SILENCE_DURATION", 0.65),
                    prefix_padding_duration=_float_env("LIVEKIT_VAD_PREFIX_PADDING_DURATION", 0.25),
                ),
                turn_detection=None,
                min_endpointing_delay=_float_env("LIVEKIT_MIN_ENDPOINTING_DELAY", 0.35),
                max_endpointing_delay=_float_env("LIVEKIT_MAX_ENDPOINTING_DELAY", 2.0),
                min_interruption_duration=_float_env("LIVEKIT_MIN_INTERRUPTION_DURATION", 0.75),
                min_interruption_words=_int_env("LIVEKIT_MIN_INTERRUPTION_WORDS", 2),
                false_interruption_timeout=_float_env("LIVEKIT_FALSE_INTERRUPTION_TIMEOUT", 1.2),
                resume_false_interruption=True,
                allow_interruptions=True,
            )

            @session.on("conversation_item_added")
            def _on_conversation_item(event):  # noqa: ANN001
                item = getattr(event, "item", None)
                role = getattr(item, "role", None)
                if role not in {"assistant", "user"}:
                    return
                if role == "assistant" and getattr(item, "interrupted", False):
                    return
                text = _item_text(item)
                speaker = "bot" if role == "assistant" else "candidate"
                tracked_write(record_turn(speaker, text))

            @session.on("close")
            def _on_close(event):  # noqa: ANN001
                nonlocal _finalizer_task  # *** CRITICAL: outer scope assignment ***
                failed_reason = _classify_close_event(event)
                _finalizer_task = asyncio.create_task(complete_once(failed_reason))
                _close_event.set()

            await session.start(
                agent=Gopu(system_text),
                room=ctx.room,
                record={"audio": True, "transcript": True, "traces": False, "logs": False},
            )

        setup_started = _monotonic()
        await _run_span_guarded("session_setup", _setup_session, parent=session_span)
        _safe_emit(histogram_metric, "session_setup_duration_sec",
                   round(_monotonic() - setup_started, 3))

        async def _generate_reply(span: Span | None) -> None:
            await session.generate_reply(instructions=opening_text)

        generate_started = _monotonic()
        await _run_span_guarded("session_generate_reply", _generate_reply, parent=session_span)
        _safe_emit(histogram_metric, "session_generate_reply_duration_sec",
                   round(_monotonic() - generate_started, 3))

        # Await session closure — keeps entrypoint alive until close fires
        await _close_event.wait()

    except Exception as exc:
        if session_span is not None:
            session_span.set_error(exc)
        # Provider construction/start/generate failed before close event
        await complete_once("worker_crash")
    finally:
        try:
            if _finalizer_task is not None and not _finalizer_task.done():
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
