"""Additive persistence for R1; the phone writer and its insert shape stay untouched.

PR-3 introduces the ``/api/internal/r1/attempt-outcome`` endpoint.  Until then
the worker deliberately treats its 404 as a logged, non-fatal compatibility
condition: terminal session settlement must never depend on a newer API route.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.error import HTTPError

import persistence
from r1_context import _request_json

_LOG = logging.getLogger("r1")


@dataclass(frozen=True)
class TerminalDisposition:
    """An internal R1 outcome mapped to an existing session lifecycle terminal reason."""

    terminal_reason: str
    expected_status: str = "in_progress"
    completed: bool = False


# Existing accepted reasons: app/api/src/lib/session-lifecycle.ts:60-93 and
# screening_v2.call_sessions.chk_call_sessions_terminal_reason (0006, widened
# by the merged residency migration).  R1 intentionally adds no shared reason.
OUTCOME_DISPOSITIONS: dict[str, TerminalDisposition] = {
    "complete": TerminalDisposition("conversation_complete", completed=True),
    "candidate_left": TerminalDisposition("worker_crash"),
    "no_show": TerminalDisposition("worker_crash", expected_status="waiting"),
    "provider_error": TerminalDisposition("provider_error"),
    "residency_timeout": TerminalDisposition("residency_timeout"),
    "shutdown_forced": TerminalDisposition("shutdown_forced"),
    "configuration_failed": TerminalDisposition("room_create_error", expected_status="waiting"),
    "context_failed": TerminalDisposition("worker_crash", expected_status="waiting"),
}


def _http_status(error: BaseException) -> int | None:
    """Extract only a numeric HTTP status for fail-soft logging; never log response content."""
    status = getattr(error, "code", getattr(error, "status", None))
    return status if isinstance(status, int) else None


class R1TurnWriter:
    """Write R1-only transcript fields and settle outcomes through isolated API seams."""

    def __init__(
        self,
        session_id: str,
        room: str,
        *,
        requester: Callable[..., dict[str, Any]] = _request_json,
    ) -> None:
        self.session_id = session_id
        self.room = room
        self._requester = requester

    async def save_turn(
        self,
        turn_index: int,
        speaker: str,
        text: str,
        phase: str,
        *,
        interrupted: bool = False,
    ) -> None:
        """Persist only non-empty R1 turns with the additive phase/interrupted fields."""
        if not text.strip():
            return

        def write_turn() -> None:
            table = persistence._table("transcript_turns")
            if not table:
                raise persistence.LifecycleError("r1_persistence_disabled")
            result = table.insert(
                {
                    "session_id": self.session_id,
                    "turn_index": turn_index,
                    "speaker": speaker,
                    "text": text.strip(),
                    "phase": phase,
                    "interrupted": interrupted,
                }
            ).execute()
            if getattr(result, "error", None):
                raise persistence.LifecycleError("r1_turn_write_failed")

        await asyncio.to_thread(write_turn)

    async def usage_disconnect(self, seconds: float, *, participant_kind: str = "agent") -> None:
        """Write the R1 usage-ledger disconnect before terminal settlement."""
        payload = {
            "room": self.room,
            "participant_kind": participant_kind,
            "event": "disconnect",
            "seconds": max(0, seconds),
            "event_key": f"r1-disconnect:{self.session_id}",
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        }
        await asyncio.to_thread(self._requester, "/api/internal/r1/usage", payload, 10.0)

    async def terminal(self, outcome: str, duration_sec: int) -> Any:
        """Map every R1 outcome to a pre-existing state-compatible terminal reason."""
        disposition = OUTCOME_DISPOSITIONS[outcome]
        if disposition.completed:
            return await persistence.complete_session(
                self.session_id,
                duration_sec,
                disposition.terminal_reason,
            )
        return await persistence.fail_session(
            self.session_id,
            disposition.terminal_reason,
            expected_status=disposition.expected_status,
        )

    async def attempt_outcome(self, outcome: str) -> None:
        """Best-effort PR-3 outcome write, intentionally after the durable terminal transition."""
        payload = {"attempt_id": self.session_id, "outcome": outcome}
        try:
            await asyncio.to_thread(
                self._requester,
                "/api/internal/r1/attempt-outcome",
                payload,
                10.0,
            )
        except HTTPError as exc:
            if exc.code == 404:
                _LOG.info("r1 attempt outcome endpoint unavailable status=404")
                exc.close()
                return
            _LOG.warning("r1 attempt outcome write failed status=%s", exc.code)
            exc.close()
        except Exception as exc:  # noqa: BLE001
            _LOG.warning("r1 attempt outcome write failed status=%s", _http_status(exc))
