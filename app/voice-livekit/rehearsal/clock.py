"""The modelled call clock: how many seconds one exchange of a rehearsal call takes.

The owed-move schedule, the close window (R >= 9:00), the time cue (11:00 to 13:00) and the
13:00 stall all depend on the role-play clock R, and the earlier S0-B harness used a fixed
105 s per turn, so 18 turns covered 31 minutes and the early-concession rule only covered the
first five turns.  This model is calibrated on the owner's session b58c7d9c: 23 learner
replies in about 14 minutes, i.e. about 35 s per exchange, with the advisor doing most of the
talking.

Per exchange the clock advances by (the runner applies them in this order):

====================  =========================================  ===========================
component             model                                      basis
====================  =========================================  ===========================
advisor speaking      words / 3.2 s (also emitted as a speaking  calibrated on b58c7d9c (below);
                      user state, so ``candidate_seconds`` is    gives the real monologue
                      real)                                      length
end of turn + STT     U(0.8, 1.6) s                              Sarvam streams finals only
learner model         the measured wall time of the real call;   S0-B total p50 2.26 s
                      2.5 s offline
TTS start             0.9 s                                      assumption (PR-4c to confirm)
learner speaking      words / 2.7 s                              natural pace
advisor reaction      U(1.5, 5.0) s                              human think time
====================  =========================================  ===========================

The advisor pace is the one calibration that matters.  On the owner's session the learner's time
cue landed at turn 79 (11:00 to 13:00 window) and the 13:00 stall at turn 92, which a replay of
that session's own word counts reproduces only at about 3.2 words per second (that advisor
talked fast, and speech-to-text kept repeated fragments); at 2.6 the same turns land 100 s late.
``tests/test_r1_rehearsal_regression.py`` pins both anchors.

Pure and seeded: the same seed gives the same clock, so offline runs are reproducible.
"""
from __future__ import annotations

import random
from dataclasses import dataclass


@dataclass(frozen=True)
class TimingParams:
    advisor_wps: float = 3.2
    learner_wps: float = 2.7
    endpoint_lo: float = 0.8
    endpoint_hi: float = 1.6
    tts_start: float = 0.9
    reaction_lo: float = 1.5
    reaction_hi: float = 5.0
    offline_llm_sec: float = 2.5
    min_speak_sec: float = 1.0


class TurnTimingModel:
    """Seconds for each part of an exchange, drawn from a seeded generator."""

    def __init__(self, seed: str, params: TimingParams | None = None) -> None:
        self.params = params or TimingParams()
        self._rng = random.Random(f"rehearsal-timing:{seed}")

    def advisor_speak(self, words: int) -> float:
        return max(self.params.min_speak_sec, words / self.params.advisor_wps)

    def endpoint(self) -> float:
        return self._rng.uniform(self.params.endpoint_lo, self.params.endpoint_hi)

    def learner_llm(self, measured: float | None) -> float:
        """The learner model's time: what was measured, else the offline constant."""
        if measured is not None and measured >= 0.0:
            return float(measured)
        return self.params.offline_llm_sec

    def tts_start(self) -> float:
        return self.params.tts_start

    def learner_speak(self, words: int) -> float:
        return words / self.params.learner_wps

    def reaction(self) -> float:
        return self._rng.uniform(self.params.reaction_lo, self.params.reaction_hi)

    def after_learner(self, words: int, measured_llm: float | None) -> float:
        """Everything between the end of the advisor's turn and the advisor's next words,
        except the end-of-turn endpoint (applied before the learner is asked)."""
        return (
            self.learner_llm(measured_llm)
            + self.tts_start()
            + self.learner_speak(words)
            + self.reaction()
        )
