"""Deterministic, forward-only state for an R1 role-play interview."""
from __future__ import annotations

from enum import Enum
import time


class R1Phase(str, Enum):
    PRE_JOIN = "pre_join"
    OPENING = "opening"
    ICEBREAKER = "icebreaker"
    TRANSITION = "transition"
    ROLEPLAY = "roleplay"
    ASIDE = "aside"
    ROLEPLAY_EXIT = "roleplay_exit"
    WRAPUP = "wrapup"
    CLOSING = "closing"
    FINISHING = "finishing"
    PAUSED_DISCONNECTED = "paused_disconnected"
    ABORTED = "aborted"


# 4:30 + 1:30 to S=20:00 + 0:12 + 2:00 + 0:15.
NORMAL_PATH_MAX_SEC = 20 * 60 + 12 + 120 + 15
MAX_AGENT_RESIDENCY_SEC = 120 + 24 * 60 + 15 + 90


class R1PhaseMachine:
    """Owns the clock and refuses skips/backwards transitions."""

    _FORWARD = {
        R1Phase.PRE_JOIN: {R1Phase.OPENING, R1Phase.FINISHING},
        R1Phase.OPENING: {R1Phase.ICEBREAKER, R1Phase.CLOSING, R1Phase.FINISHING, R1Phase.PAUSED_DISCONNECTED},
        R1Phase.ICEBREAKER: {R1Phase.TRANSITION, R1Phase.CLOSING, R1Phase.FINISHING, R1Phase.PAUSED_DISCONNECTED},
        R1Phase.TRANSITION: {R1Phase.ROLEPLAY, R1Phase.CLOSING, R1Phase.FINISHING, R1Phase.PAUSED_DISCONNECTED},
        R1Phase.ROLEPLAY: {R1Phase.ASIDE, R1Phase.ROLEPLAY_EXIT, R1Phase.CLOSING, R1Phase.PAUSED_DISCONNECTED, R1Phase.FINISHING},
        R1Phase.ASIDE: {R1Phase.ROLEPLAY, R1Phase.CLOSING, R1Phase.FINISHING},
        R1Phase.ROLEPLAY_EXIT: {R1Phase.WRAPUP, R1Phase.CLOSING, R1Phase.FINISHING, R1Phase.PAUSED_DISCONNECTED},
        R1Phase.WRAPUP: {R1Phase.CLOSING, R1Phase.FINISHING, R1Phase.PAUSED_DISCONNECTED},
        R1Phase.CLOSING: {R1Phase.FINISHING},
        R1Phase.PAUSED_DISCONNECTED: {R1Phase.FINISHING, R1Phase.OPENING, R1Phase.ICEBREAKER, R1Phase.TRANSITION, R1Phase.ROLEPLAY, R1Phase.ROLEPLAY_EXIT, R1Phase.WRAPUP, R1Phase.CLOSING},
        R1Phase.ABORTED: {R1Phase.FINISHING},
        R1Phase.FINISHING: set(),
    }

    def __init__(self, clock=time.monotonic) -> None:
        self._clock = clock
        self.started_at = clock()
        self.phase = R1Phase.PRE_JOIN
        self._roleplay_started: float | None = None
        self._roleplay_paused_at: float | None = None
        self._roleplay_pause_total = 0.0
        self._resume_phase: R1Phase | None = None
        self.candidate_turns = 0

    def transition(self, target: R1Phase) -> None:
        if target not in self._FORWARD[self.phase]:
            raise RuntimeError(f"r1_invalid_transition:{self.phase.value}->{target.value}")
        now = self._clock()
        if self.phase == R1Phase.ROLEPLAY and target in {R1Phase.ASIDE, R1Phase.PAUSED_DISCONNECTED}:
            self._roleplay_paused_at = now
        if self.phase == R1Phase.PAUSED_DISCONNECTED and self._roleplay_paused_at is not None:
            self._roleplay_pause_total += now - self._roleplay_paused_at
            self._roleplay_paused_at = None
            self._resume_phase = None
        self.phase = target
        if target == R1Phase.ROLEPLAY and self._roleplay_started is None:
            self._roleplay_started = now
        if target == R1Phase.ROLEPLAY and self._roleplay_paused_at is not None:
            self._roleplay_pause_total += now - self._roleplay_paused_at
            self._roleplay_paused_at = None

    def begin_disconnect(self) -> None:
        if self.phase not in {R1Phase.OPENING, R1Phase.ICEBREAKER, R1Phase.TRANSITION, R1Phase.ROLEPLAY, R1Phase.ROLEPLAY_EXIT, R1Phase.WRAPUP}:
            raise RuntimeError("r1_invalid_disconnect_transition")
        self._resume_phase = self.phase
        self.transition(R1Phase.PAUSED_DISCONNECTED)

    def rejoin(self) -> R1Phase:
        if self.phase is not R1Phase.PAUSED_DISCONNECTED or self._resume_phase is None:
            raise RuntimeError("r1_invalid_rejoin_transition")
        target = self._resume_phase
        self.transition(target)
        return target

    @property
    def session_elapsed(self) -> float:
        return self._clock() - self.started_at

    @property
    def roleplay_elapsed(self) -> float:
        if self._roleplay_started is None:
            return 0.0
        paused = self._roleplay_pause_total
        if self._roleplay_paused_at is not None:
            paused += self._clock() - self._roleplay_paused_at
        return max(0.0, self._clock() - self._roleplay_started - paused)

    def icebreaker_should_end(self) -> bool:
        return self.session_elapsed >= 270 or (self.session_elapsed >= 210 and self.candidate_turns >= 4)

    def roleplay_should_end(self, commitment_resolved: bool = False) -> bool:
        return self.session_elapsed >= 1200 or self.roleplay_elapsed >= 840 or (self.roleplay_elapsed >= 780 and commitment_resolved)

    def forced_close_due(self, residency_cap_sec: float = 1800) -> bool:
        return self.session_elapsed >= min(1440, residency_cap_sec)
