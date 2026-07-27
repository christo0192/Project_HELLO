"""
Live transcript recorder — captures bot + candidate turns during a call and
writes each one to Postgres the moment it's finalized, so the dashboard can
render the conversation in real time (Supabase Realtime on transcript_turns).

Two tiny FrameProcessors spliced into the pipeline:
  * user side  (after STT)     -> each TranscriptionFrame = one candidate turn
  * assistant side (after out) -> LLM text between LLMFullResponseStart/EndFrame = one bot turn
"""

from loguru import logger

from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

import db


class _UserTurnCapture(FrameProcessor):
    """Records candidate turns from STT TranscriptionFrames (pass-through)."""

    def __init__(self, sink):
        super().__init__()
        self._sink = sink

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.text and frame.text.strip():
            await self._sink("candidate", frame.text.strip())
        await self.push_frame(frame, direction)


class _AssistantTurnCapture(FrameProcessor):
    """Aggregates the bot's streamed LLM text into one turn per response."""

    def __init__(self, sink):
        super().__init__()
        self._sink = sink
        self._buf: list[str] = []
        self._active = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self._buf = []
            self._active = True
        elif isinstance(frame, LLMTextFrame) and self._active:
            self._buf.append(frame.text)
        elif isinstance(frame, LLMFullResponseEndFrame) and self._active:
            text = "".join(self._buf).strip()
            if text:
                await self._sink("bot", text)
            self._buf = []
            self._active = False
        await self.push_frame(frame, direction)


class TranscriptRecorder:
    """Writes bot + candidate turns LIVE (one DB row per turn)."""

    def __init__(self):
        self._n = 0
        self._session_id = None
        self._user = _UserTurnCapture(self._record)
        self._assistant = _AssistantTurnCapture(self._record)

    def set_session(self, session_id) -> None:
        """Call once create_session() returns, before the conversation starts."""
        self._session_id = session_id

    async def _record(self, speaker: str, text: str) -> None:
        idx = self._n
        self._n += 1
        logger.info(f"[transcript] {speaker}: {text[:70]}")
        await db.save_turn(self._session_id, idx, speaker, text)  # live write

    def pipeline_processors(self):
        """Return (user, assistant) processors to splice into the pipeline."""
        return self._user, self._assistant
