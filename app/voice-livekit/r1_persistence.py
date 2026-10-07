"""Additive persistence for R1; the phone writer and its insert shape stay untouched.

PR-3 introduces the ``/api/internal/r1/attempt-outcome`` endpoint.  Until then
the worker deliberately treats its 404 as a logged, non-fatal compatibility
condition: terminal session settlement must never depend on a newer API route.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.error import HTTPError

import persistence
from observability import StructuredLogger
from r1_context import _request_json

# Plan section 9 fence 10: StructuredLogger only (its allowlist and secret scan drop
# anything else); a call names a status or an exception TYPE, never a message or text.
_log = StructuredLogger("r1")


@dataclass(frozen=True)
class TerminalDisposition:
    """An internal R1 outcome mapped to an existing session lifecycle terminal reason.

    The CAS source status is deliberately NOT part of the disposition: it is a
    property of the session (waiting until ``activate_session`` succeeds,
    in_progress afterwards), never of the outcome.  ``R1TurnWriter.terminal``
    derives it from the caller's activation state.
    """

    terminal_reason: str
    completed: bool = False


# Existing accepted reasons: app/api/src/lib/session-lifecycle.ts:60-93 and
# screening_v2.call_sessions.chk_call_sessions_terminal_reason (0006, widened
# by the merged residency migration).  R1 intentionally adds no shared reason.
OUTCOME_DISPOSITIONS: dict[str, TerminalDisposition] = {
    "complete": TerminalDisposition("conversation_complete", completed=True),
    "candidate_left": TerminalDisposition("worker_crash"),
    "no_show": TerminalDisposition("worker_crash"),
    "provider_error": TerminalDisposition("provider_error"),
    "residency_timeout": TerminalDisposition("residency_timeout"),
    "shutdown_forced": TerminalDisposition("shutdown_forced"),
    "configuration_failed": TerminalDisposition("room_create_error"),
    "context_failed": TerminalDisposition("worker_crash"),
}


def _http_status(error: BaseException) -> int | None:
    """Extract only a numeric HTTP status for fail-soft logging; never log response content."""
    status = getattr(error, "code", getattr(error, "status", None))
    return status if isinstance(status, int) else None


class R1TurnWriter:
    """Write R1-only transcript fields and settle outcomes through isolated API seams."""

    def __init__(
        self,
        session_id: str | None,
        room: str,
        *,
        attempt_id: str | None = None,
        requester: Callable[..., dict[str, Any]] = _request_json,
    ) -> None:
        self.session_id = session_id
        self.room = room
        self.attempt_id = attempt_id
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
            if not self.session_id:
                _log.warn("unknown_event", error_type="r1_transcript_skipped_no_session")
                return
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
        if not self.session_id:
            _log.warn("unknown_event", error_type="r1_usage_skipped_no_session")
            return
        payload = {
            "room": self.room,
            "participant_kind": participant_kind,
            "event": "disconnect",
            "seconds": max(0, seconds),
            "event_key": f"r1-disconnect:{self.session_id}",
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        }
        await asyncio.to_thread(self._requester, "/api/internal/r1/usage", payload, 10.0)

    async def activate(self) -> Any:
        """CAS ``waiting`` to ``in_progress``; the caller must fail closed unless ``.ok``.

        Only the worker activates a session, and ``complete_session`` and the default
        ``fail_session`` compare-and-set from ``in_progress`` (plan section 4 step 8).
        Missing session ids are reported as a non-ok DISABLED outcome by ``persistence``.
        """
        return await persistence.activate_session(self.session_id)

    async def terminal(
        self, outcome: str, duration_sec: int, *, activated: bool | None = False
    ) -> Any:
        """Map an R1 outcome to a pre-existing terminal reason and the right CAS source.

        ``activated`` is the worker's own record of ``activate``: True leaves
        ``in_progress``, False (no-show, context or configuration failure, cancellation
        before the candidate joined) leaves ``waiting``.  None means the activation
        CAS timed out or errored, so it may still have landed from its thread: the
        failure CAS then tries ``in_progress`` first and ``waiting`` second (each is a
        compare-and-set, so only the real current status can match).  A CAS that does
        not apply is logged, never silent: a CONFLICT means another writer already
        settled the row, which an operator must be able to see.
        """
        if not self.session_id:
            _log.warn("unknown_event", error_type="r1_terminal_skipped_no_session")
            return None
        disposition = OUTCOME_DISPOSITIONS[outcome]
        if disposition.completed:
            result = await persistence.complete_session(
                self.session_id,
                duration_sec,
                disposition.terminal_reason,
            )
            self._log_unapplied(outcome, "in_progress", result)
            return result
        sources = ("in_progress", "waiting") if activated is None else (
            ("in_progress",) if activated else ("waiting",)
        )
        result = None
        for expected_status in sources:
            result = await persistence.fail_session(
                self.session_id,
                disposition.terminal_reason,
                expected_status=expected_status,
            )
            if getattr(result, "ok", False):
                return result
            self._log_unapplied(outcome, expected_status, result)
        return result

    @staticmethod
    def _log_unapplied(outcome: str, expected_status: str, result: Any) -> None:
        """Record a terminal CAS that did not apply (outcome and source are fixed labels)."""
        if getattr(result, "ok", False):
            return
        _log.warn(
            "unknown_event",
            error_type=f"r1_terminal_not_applied:{outcome}",
            error_category=f"{expected_status}_{getattr(result, 'kind', 'unknown')}",
        )

    async def attempt_outcome(self, outcome: str) -> None:
        """Best-effort PR-3 outcome write, intentionally after the durable terminal transition."""
        if not self.attempt_id:
            _log.info("unknown_event", error_type="r1_attempt_outcome_skipped_no_attempt")
            return
        payload = {"attempt_id": self.attempt_id, "outcome": outcome}
        try:
            await asyncio.to_thread(
                self._requester,
                "/api/internal/r1/attempt-outcome",
                payload,
                10.0,
            )
        except HTTPError as exc:
            if exc.code == 404:
                _log.info(
                    "unknown_event", error_type="r1_attempt_outcome_unavailable", status=404
                )
                exc.close()
                return
            _log.warn(
                "unknown_event",
                error_type="r1_attempt_outcome_failed",
                status=exc.code if isinstance(exc.code, int) else None,
            )
            exc.close()
        except Exception as exc:  # noqa: BLE001
            _log.warn(
                "unknown_event",
                error_type="r1_attempt_outcome_failed",
                error_category=type(exc).__name__,
                status=_http_status(exc),
            )
