"""Deterministic, forward-only timing state for an R1 role-play interview.

The machine owns phase legality and the paused role-play clock.  It does not
perform I/O: ``r1_session`` owns wakeable waits and the required exit ordering.
"""
from __future__ import annotations

import time
from enum import Enum


class R1Phase(str, Enum):
    """The ordered interview phases, including explicit temporary pause/abort states."""

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


# 4:30 icebreaker + 1:30 transition to S=20:00 + 0:12 exit + 2:00 wrap + 0:15 close.
NORMAL_PATH_MAX_SEC = 20 * 60 + 12 + 120 + 15
MAX_AGENT_RESIDENCY_SEC = 120 + 24 * 60 + 15 + 90
# S-clock hard caps (plan section 5.1): icebreaker S=4:30, role-play S=20:00, forced close S=24:00.
ICEBREAKER_HARD_SEC = 270.0
ROLEPLAY_RESUME_CAP_SEC = 1200.0
FORCED_CLOSE_SEC = 1440.0

# The ``transcript_turns.phase`` CHECK set (migration 0116, chk_transcript_turns_phase).
TRANSCRIPT_PHASES = frozenset(
    {
        "opening",
        "icebreaker",
        "transition",
        "roleplay",
        "aside",
        "roleplay_exit",
        "wrapup",
        "closing",
    }
)
# Phases without a row label of their own borrow the nearest labelled one.
_TRANSCRIPT_PHASE_ALIASES = {
    R1Phase.PRE_JOIN: "opening",
    R1Phase.FINISHING: "closing",
    R1Phase.ABORTED: "closing",
}
# R is paused while role-play is in either of these (one continuous paused span).
_PAUSED_PHASES = frozenset({R1Phase.ASIDE, R1Phase.PAUSED_DISCONNECTED})
# Entering any of these means the role-play is over, however it ended: R stops counting.
_AFTER_ROLEPLAY = frozenset(
    {R1Phase.ROLEPLAY_EXIT, R1Phase.WRAPUP, R1Phase.CLOSING, R1Phase.FINISHING, R1Phase.ABORTED}
)


class R1PhaseMachine:
    """Reject skipped/backward transitions and pause only the role-play clock when required."""

    _FORWARD = {
        R1Phase.PRE_JOIN: {R1Phase.OPENING, R1Phase.FINISHING},
        R1Phase.OPENING: {
            R1Phase.ICEBREAKER,
            R1Phase.CLOSING,
            R1Phase.FINISHING,
            R1Phase.ABORTED,
            R1Phase.PAUSED_DISCONNECTED,
        },
        R1Phase.ICEBREAKER: {
            R1Phase.TRANSITION,
            R1Phase.CLOSING,
            R1Phase.FINISHING,
            R1Phase.ABORTED,
            R1Phase.PAUSED_DISCONNECTED,
        },
        R1Phase.TRANSITION: {
            R1Phase.ROLEPLAY,
            R1Phase.CLOSING,
            R1Phase.FINISHING,
            R1Phase.ABORTED,
            R1Phase.PAUSED_DISCONNECTED,
        },
        R1Phase.ROLEPLAY: {
            R1Phase.ASIDE,
            R1Phase.ROLEPLAY_EXIT,
            R1Phase.CLOSING,
            R1Phase.PAUSED_DISCONNECTED,
            R1Phase.FINISHING,
            R1Phase.ABORTED,
        },
        R1Phase.ASIDE: {
            R1Phase.ROLEPLAY,
            R1Phase.ROLEPLAY_EXIT,
            R1Phase.CLOSING,
            R1Phase.FINISHING,
            R1Phase.ABORTED,
            R1Phase.PAUSED_DISCONNECTED,
        },
        R1Phase.ROLEPLAY_EXIT: {
            R1Phase.WRAPUP,
            R1Phase.CLOSING,
            R1Phase.FINISHING,
            R1Phase.ABORTED,
            R1Phase.PAUSED_DISCONNECTED,
        },
        R1Phase.WRAPUP: {
            R1Phase.CLOSING,
            R1Phase.FINISHING,
            R1Phase.ABORTED,
            R1Phase.PAUSED_DISCONNECTED,
        },
        R1Phase.CLOSING: {R1Phase.FINISHING},
        R1Phase.PAUSED_DISCONNECTED: {
            R1Phase.FINISHING,
            R1Phase.OPENING,
            R1Phase.ICEBREAKER,
            R1Phase.TRANSITION,
            R1Phase.ROLEPLAY,
            R1Phase.ASIDE,
            R1Phase.ROLEPLAY_EXIT,
            R1Phase.WRAPUP,
            R1Phase.CLOSING,
        },
        R1Phase.ABORTED: {R1Phase.FINISHING},
        R1Phase.FINISHING: set(),
    }

    def __init__(self, clock=time.monotonic) -> None:
        self._clock = clock
        self.started_at = clock()
        self.phase = R1Phase.PRE_JOIN
        self._roleplay_started: float | None = None
        self._roleplay_ended: float | None = None
        self._roleplay_paused_at: float | None = None
        self._roleplay_pause_total = 0.0
        self._resume_phase: R1Phase | None = None
        self._phase_entered: dict[R1Phase, float] = {R1Phase.PRE_JOIN: self.started_at}
        # S (plan section 5.1) runs from activation, which is the first entry to OPENING.
        self._activated_at: float | None = None
        self.candidate_turns = 0

    def transition(self, target: R1Phase) -> None:
        """Move only along an allowed edge and accurately maintain the paused role-play clock.

        ASIDE and PAUSED_DISCONNECTED form ONE paused span: R stops when role-play
        enters either and resumes only when the machine reaches a non-paused phase.
        ASIDE -> PAUSED_DISCONNECTED -> ASIDE therefore never lets R run while the
        learner is still in an aside.
        """
        if target not in self._FORWARD[self.phase]:
            raise RuntimeError(f"r1_invalid_transition:{self.phase.value}->{target.value}")
        now = self._clock()
        if self.phase is R1Phase.ROLEPLAY and target in _PAUSED_PHASES:
            self._roleplay_paused_at = now
        if target not in _PAUSED_PHASES and self._roleplay_paused_at is not None:
            self._roleplay_pause_total += now - self._roleplay_paused_at
            self._roleplay_paused_at = None
        if self.phase is R1Phase.PAUSED_DISCONNECTED and target is not self.phase:
            self._resume_phase = None
        if (
            self._roleplay_started is not None
            and self._roleplay_ended is None
            and target in _AFTER_ROLEPLAY
        ):
            self._roleplay_ended = now  # R is final: the wrap-up is not role-play time
        self.phase = target
        # First entry wins: a rejoin must not restart a phase budget such as wrap-up's 2:00.
        self._phase_entered.setdefault(target, now)
        if target is R1Phase.OPENING and self._activated_at is None:
            self._activated_at = now
        if target is R1Phase.ROLEPLAY and self._roleplay_started is None:
            self._roleplay_started = now

    def begin_disconnect(self) -> None:
        """Enter the reconnect pause from a live phase and retain exactly one resume target."""
        live_phases = {
            R1Phase.OPENING,
            R1Phase.ICEBREAKER,
            R1Phase.TRANSITION,
            R1Phase.ROLEPLAY,
            R1Phase.ASIDE,
            R1Phase.ROLEPLAY_EXIT,
            R1Phase.WRAPUP,
        }
        if self.phase not in live_phases:
            raise RuntimeError("r1_invalid_disconnect_transition")
        self._resume_phase = self.phase
        self.transition(R1Phase.PAUSED_DISCONNECTED)

    def rejoin(self) -> R1Phase:
        """Return from a valid reconnect pause to the exact phase which was interrupted."""
        if self.phase is not R1Phase.PAUSED_DISCONNECTED or self._resume_phase is None:
            raise RuntimeError("r1_invalid_rejoin_transition")
        target = self._resume_phase
        self.transition(target)
        return target

    @property
    def resume_phase(self) -> R1Phase | None:
        """The phase a reconnect pause will return to (None outside the pause)."""
        return self._resume_phase if self.phase is R1Phase.PAUSED_DISCONNECTED else None

    @property
    def session_elapsed(self) -> float:
        """Return total wall time; the residency cap intentionally includes all pauses."""
        return self._clock() - self.started_at

    @property
    def session_clock(self) -> float:
        """Return S: wall time since activation (the first OPENING), or since start before it."""
        origin = self.started_at if self._activated_at is None else self._activated_at
        return max(0.0, self._clock() - origin)

    @property
    def roleplay_elapsed(self) -> float:
        """Return role-play time excluding disconnect and mute/aside pauses.

        R stops when the role-play ends (the exit line, the wrap-up or an abort is entered),
        so the value read at the end of the session is the role-play's own length, not the
        role-play plus the wrap-up: the trusted administration record and the plan 6.4 gate
        (``R >= 10:00``) measure the role-play, not the session.
        """
        if self._roleplay_started is None:
            return 0.0
        end = self._clock() if self._roleplay_ended is None else self._roleplay_ended
        paused = self._roleplay_pause_total
        if self._roleplay_paused_at is not None:
            paused += end - self._roleplay_paused_at
        return max(0.0, end - self._roleplay_started - paused)

    @property
    def roleplay_entered(self) -> bool:
        """True once the role-play phase was ever entered."""
        return self._roleplay_started is not None

    @property
    def roleplay_finished(self) -> bool:
        """True once the role-play ended normally (the exit line was reached), at any later point.

        Only ``ROLEPLAY_EXIT`` proves it: a role-play cut short by a stop goes straight to
        ``CLOSING`` and never enters it.
        """
        return R1Phase.ROLEPLAY_EXIT in getattr(self, "_phase_entered", {})

    def icebreaker_should_end(self) -> bool:
        """Apply the soft four-turn exit and absolute 4:30 icebreaker deadline (both on S)."""
        return self.session_clock >= ICEBREAKER_HARD_SEC or (
            self.session_clock >= 210 and self.candidate_turns >= 4
        )

    def remaining_icebreaker_seconds(self) -> float:
        """Return the hard icebreaker budget; driver waits may never exceed it."""
        return max(0.0, ICEBREAKER_HARD_SEC - self.session_clock)

    def remaining_roleplay_cap_seconds(self) -> float:
        """Return the S=20:00 role-play cap; S keeps running through every pause."""
        return max(0.0, ROLEPLAY_RESUME_CAP_SEC - self.session_clock)

    def remaining_roleplay_seconds(self) -> float:
        """Return min(R budget, S cap); R excludes deliberate pauses, S never pauses."""
        return max(0.0, min(840.0 - self.roleplay_elapsed, self.remaining_roleplay_cap_seconds()))

    def remaining_forced_close_seconds(self) -> float:
        """Return the time left until the S=24:00 forced close."""
        return max(0.0, FORCED_CLOSE_SEC - self.session_clock)

    def remaining_wrapup_seconds(self) -> float:
        """Return wrap-up's fixed hard budget from its phase entry."""
        return max(0.0, 120.0 - self.phase_elapsed(R1Phase.WRAPUP))

    def phase_elapsed(self, phase: R1Phase) -> float:
        """Return elapsed wall time in the current phase, or zero before entry."""
        entered = getattr(self, "_phase_entered", {}).get(phase)
        return 0.0 if entered is None else max(0.0, self._clock() - entered)

    def roleplay_should_end(self, commitment_resolved: bool = False) -> bool:
        """Apply role-play's soft, earned-early, and hard phase exits."""
        return (
            self.session_clock >= ROLEPLAY_RESUME_CAP_SEC
            or self.roleplay_elapsed >= 840
            or (self.roleplay_elapsed >= 780 and commitment_resolved)
        )

    def forced_close_due(self, residency_cap_sec: float = 1800) -> bool:
        """Retain the pure predicate for tests; production uses a scheduled deadline instead."""
        return self.session_clock >= min(FORCED_CLOSE_SEC, residency_cap_sec)

    def transcript_phase(self) -> str:
        """Return the ``transcript_turns.phase`` label for the current moment.

        Every value is inside the 0116 CHECK set: an unlabelled phase borrows its
        neighbour's label, and a reconnect pause reports the phase it will resume.
        """
        phase = self.phase
        if phase is R1Phase.PAUSED_DISCONNECTED and self._resume_phase is not None:
            phase = self._resume_phase
        label = _TRANSCRIPT_PHASE_ALIASES.get(phase, phase.value)
        return label if label in TRANSCRIPT_PHASES else "closing"
