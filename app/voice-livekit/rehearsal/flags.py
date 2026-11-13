"""The harness's own switches (read at call time, default ON; ``0``/``false``/``off``/``no`` is OFF).

Each one guards a fix to the simulator or its checks, so OFF restores the previous behaviour:

* ``REHEARSAL_KEEP_CONTROL_ACTS``: the live rewriter never rewords a move whose act a check
  scores (an end request, an insult, a brief request ...); it is said as the library wrote it.
* ``REHEARSAL_TRANSITION_ACTS_V2``: transition acts read the request's object (a brief request
  names the brief, a request to repeat an icebreaker question is ``repeat_request``), the brief
  repair check needs Christy's scripted brief line, and a ``repeat_request`` gets its own check.
* ``REHEARSAL_LEARNER_CLOCK``: the window checks time a learner line by the R at which the engine
  decided it, not by the start of the advisor turn it answered.
"""
from __future__ import annotations

import os

KEEP_CONTROL_ACTS = "REHEARSAL_KEEP_CONTROL_ACTS"
TRANSITION_ACTS_V2 = "REHEARSAL_TRANSITION_ACTS_V2"
LEARNER_CLOCK = "REHEARSAL_LEARNER_CLOCK"

_OFF = frozenset({"0", "false", "off", "no"})


def on(name: str) -> bool:
    """True unless the environment turns the switch off."""
    return str(os.environ.get(name, "1")).strip().lower() not in _OFF


__all__ = ["KEEP_CONTROL_ACTS", "LEARNER_CLOCK", "TRANSITION_ACTS_V2", "on"]
