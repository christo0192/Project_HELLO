"""The harness's own switches (read at call time, default ON; ``0``/``false``/``off``/``no`` is OFF).

Each one guards a fix to the simulator or its checks, so OFF restores the previous behaviour:

* ``REHEARSAL_KEEP_CONTROL_ACTS``: the live rewriter never rewords a move whose act a check
  scores (an end request, an insult, a brief request ...); it is said as the library wrote it.
* ``REHEARSAL_TRANSITION_ACTS_V2``: transition acts read the request's object (a brief request
  names the brief, a request to repeat an icebreaker question is ``repeat_request``), the brief
  repair check needs Christy's scripted brief line, and a ``repeat_request`` gets its own check.
* ``REHEARSAL_LEARNER_CLOCK``: the window checks time a learner line by the R at which the engine
  decided it, not by the start of the advisor turn it answered.
* ``REHEARSAL_COMMIT_WINDOW`` (diagnosis-2 D2-SC1): the commitment gates count only the calls that had
  a commitment window (a call with no commitment that ended on an end request, on the abuse hang-up
  or before 13:00 is excluded and counted beside the gate).
* ``REHEARSAL_SPOKEN_LEAKS`` (D2-HF2): a commitment the guard BLOCKED is no hard fail; the hard fail
  needs the guard's own flag or a commitment still in what the learner said.
* ``REHEARSAL_PROBE_VOCAB_V2`` (D2-ND1): the narrower need vocabulary, one topic per coordinated
  question and the wider call-scheduling exclusion of the disclosure gate's digs.
* ``REHEARSAL_CITED_MISFIRES`` (D2-HM1): the judge is asked to cite the advisor turn a misfire fails to
  follow (OFF sends the previous rubric and schema), a judged misfire of kind ``other`` counts only when
  it cites that turn and a reason, and one call adds at most 5 to a level's mean.
* ``REHEARSAL_IB_REPEAT_INSISTED`` (D2-IB1, integration): a repeat request that turns down ("no, I
  mean ...") the right question it just got also passes with the question before that one, as
  Christy's insisted-repeat line offers it.
* ``REHEARSAL_SAME_TURN_FRAGMENTS`` (integration, rambler): a candidate row the session saved with no
  span, written while the candidate's turn was still being said, is a fragment of that turn, not the
  candidate's next turn, when a check looks for the bot's reply to it.
"""
from __future__ import annotations

import os

KEEP_CONTROL_ACTS = "REHEARSAL_KEEP_CONTROL_ACTS"
TRANSITION_ACTS_V2 = "REHEARSAL_TRANSITION_ACTS_V2"
LEARNER_CLOCK = "REHEARSAL_LEARNER_CLOCK"
COMMIT_WINDOW = "REHEARSAL_COMMIT_WINDOW"
SPOKEN_LEAKS = "REHEARSAL_SPOKEN_LEAKS"
PROBE_VOCAB_V2 = "REHEARSAL_PROBE_VOCAB_V2"
SAME_TURN_FRAGMENTS = "REHEARSAL_SAME_TURN_FRAGMENTS"
CITED_MISFIRES = "REHEARSAL_CITED_MISFIRES"
IB_REPEAT_INSISTED = "REHEARSAL_IB_REPEAT_INSISTED"

_OFF = frozenset({"0", "false", "off", "no"})


def on(name: str) -> bool:
    """True unless the environment turns the switch off."""
    return str(os.environ.get(name, "1")).strip().lower() not in _OFF


__all__ = [
    "CITED_MISFIRES",
    "COMMIT_WINDOW",
    "IB_REPEAT_INSISTED",
    "KEEP_CONTROL_ACTS",
    "LEARNER_CLOCK",
    "PROBE_VOCAB_V2",
    "SAME_TURN_FRAGMENTS",
    "SPOKEN_LEAKS",
    "TRANSITION_ACTS_V2",
    "on",
]
