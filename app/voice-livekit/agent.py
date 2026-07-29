"""
    SPIKE: LiveKit Agents voice worker (Gopu screening interviewer).
Sarvam STT/TTS + local multilingual turn-detector model + Anthropic Haiku LLM.

Run (PowerShell, venv activated):
    python agent.py download-files   # one-time model download
    python agent.py console          # talk to it via local mic/speakers (no LiveKit creds needed)
    python agent.py dev              # connect as a worker to LiveKit Cloud (needs .env creds)
"""

import os
import time
import asyncio
from typing import Any

from dotenv import load_dotenv

from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import anthropic, sarvam, silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

import persistence
from observability import set_correlation_id, reset_correlation_id
from prompting import build_prompt_context, collect_prompt_metadata

load_dotenv()


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


async def entrypoint(ctx: JobContext) -> None:
    started_at = time.monotonic()
    await ctx.connect()
    meta = collect_prompt_metadata(ctx)
    session_id = meta.get("session_id") or meta.get("sessionId")
    # OBS-02: initialise correlation context for this session.
    # The room creator (API /livekit/start) writes an opaque UUID v4 into room
    # metadata; the worker validates it before accepting.  A fresh UUID is
    # generated if the value is absent, invalid, or candidate-controlled.
    # This correlation_id is distinct from the API request that created the room.
    # The returned Token is used in finally to restore the previous context.
    _cid_token = set_correlation_id(meta.get("correlation_id"))
    try:
        system_text, opening_text = build_prompt_context(ctx)

        session = AgentSession(
            stt=sarvam.STT(
                model=os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
                language=os.getenv("SARVAM_LANGUAGE", "en-IN"),
            ),
            tts=sarvam.TTS(
                model=os.getenv("SARVAM_TTS_MODEL", "bulbul:v3"),
                speaker=os.getenv("SARVAM_TTS_VOICE", "shubh"),
            ),
            llm=anthropic.LLM(model=os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")),
            vad=silero.VAD.load(
                activation_threshold=_float_env("LIVEKIT_VAD_ACTIVATION_THRESHOLD", 0.7),
                min_speech_duration=_float_env("LIVEKIT_VAD_MIN_SPEECH_DURATION", 0.3),
                min_silence_duration=_float_env("LIVEKIT_VAD_MIN_SILENCE_DURATION", 0.65),
                prefix_padding_duration=_float_env("LIVEKIT_VAD_PREFIX_PADDING_DURATION", 0.25),
            ),
            turn_detection=MultilingualModel(),
            min_endpointing_delay=_float_env("LIVEKIT_MIN_ENDPOINTING_DELAY", 0.35),
            max_endpointing_delay=_float_env("LIVEKIT_MAX_ENDPOINTING_DELAY", 2.0),
            min_interruption_duration=_float_env("LIVEKIT_MIN_INTERRUPTION_DURATION", 0.75),
            min_interruption_words=_int_env("LIVEKIT_MIN_INTERRUPTION_WORDS", 2),
            false_interruption_timeout=_float_env("LIVEKIT_FALSE_INTERRUPTION_TIMEOUT", 1.2),
            resume_false_interruption=True,
            allow_interruptions=True,
        )

        turn_index = 0
        cleanup_started = False

        async def record_turn(speaker: str, text: str) -> None:
            nonlocal turn_index
            if not text:
                return
            idx = turn_index
            turn_index += 1
            await persistence.save_turn(session_id, idx, speaker, text)

        async def complete_once(failed_reason: str | None = None) -> None:
            nonlocal cleanup_started
            if cleanup_started:
                return
            cleanup_started = True
            duration = int(time.monotonic() - started_at)
            if failed_reason:
                await persistence.fail_session(session_id, failed_reason)
                return
            await persistence.complete_session(session_id, duration)
            await persistence.trigger_scoring(session_id)

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
            asyncio.create_task(record_turn(speaker, text))

        @session.on("close")
        def _on_close(event):  # noqa: ANN001
            reason = str(getattr(event, "reason", "") or "")
            error = getattr(event, "error", None)
            failed = f"{reason}: {error}" if error else None
            asyncio.create_task(complete_once(failed))

        await session.start(
            agent=Gopu(system_text),
            room=ctx.room,
            record={"audio": True, "transcript": True, "traces": False, "logs": False},
        )
        await session.generate_reply(instructions=opening_text)
    finally:
        # Token-based restore: reverts the ContextVar to its value *before*
        # set_correlation_id was called above, so sequential jobs cannot
        # inherit a stale correlation ID.  Created asyncio Tasks (callbacks)
        # hold their own Context snapshot at creation time and are unaffected
        # by this restore.
        reset_correlation_id(_cid_token)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
