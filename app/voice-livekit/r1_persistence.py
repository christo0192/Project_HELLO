"""R1 additive persistence. Shared phone save_turn remains untouched."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Callable

import persistence
from r1_context import _request_json


class R1TurnWriter:
    def __init__(self, session_id: str, room: str, *, requester: Callable[..., dict[str, Any]] = _request_json) -> None:
        self.session_id = session_id
        self.room = room
        self._requester = requester

    async def save_turn(self, turn_index: int, speaker: str, text: str, phase: str, *, interrupted: bool = False) -> None:
        if not text.strip():
            return
        # R1 owns its extra fields. It never changes persistence.save_turn's
        # pinned insert shape used by phone callers.
        def run() -> None:
            table = persistence._table("transcript_turns")
            if not table:
                raise persistence.LifecycleError("r1_persistence_disabled")
            result = table.insert({"session_id": self.session_id, "turn_index": turn_index, "speaker": speaker,
                                   "text": text.strip(), "phase": phase, "interrupted": interrupted}).execute()
            if getattr(result, "error", None):
                raise persistence.LifecycleError("r1_turn_write_failed")
        await asyncio.to_thread(run)

    async def usage_disconnect(self, seconds: float, *, participant_kind: str = "agent") -> None:
        payload = {"room": self.room, "participant_kind": participant_kind, "event": "disconnect", "seconds": max(0, seconds),
                   "event_key": f"r1-disconnect:{self.session_id}", "occurred_at": datetime.now(timezone.utc).isoformat()}
        # The API requires the room; r1_session supplies it at call time.
        await asyncio.to_thread(self._requester, "/api/internal/r1/usage", payload, 10.0)

    async def terminal(self, outcome: str, duration_sec: int) -> Any:
        if outcome == "complete":
            return await persistence.complete_session(self.session_id, duration_sec, "conversation_complete")
        if outcome == "no_show":
            return await persistence.fail_session(self.session_id, "worker_crash", expected_status="waiting")
        reason = "shutdown_forced" if outcome == "shutdown_forced" else "worker_crash" if outcome == "candidate_left" else "provider_error"
        return await persistence.fail_session(self.session_id, reason)
