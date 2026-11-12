"""The model seams of ``R1Interview`` (its ``*_runner`` keywords) and what drives each in a rehearsal.

Production runs every seam on a client of its own when the session has an LLM: the shadow judge,
the end-intent classifier and the turn reader on R1's judge client (``build_r1_judge_llm``,
temperature 0); the transition bridge (M032 S5.4) on Christy's own client (``build_r1_llm``, the
interviewer's settings).  The rehearsal session is a fake with no ``.llm``, so a seam the harness
does not inject is simply OFF, and the interview then behaves as with that feature disabled.  So:

* live, every seam gets the production client it uses in production (``SEAM_CLIENTS``); a seam
  this module does not know stops the sweep (``UnknownSeam``) instead of guessing a client;
* offline, every known seam gets a deterministic scripted stand-in (``scripted_runners``): the
  end-intent classifier answers from the candidate turn's ground-truth act, the bridge says one
  neutral sentence, the turn reader reads nothing; an unknown seam is left out and recorded as
  ``absent`` in the call's header (``seam_modes``).
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Iterable

# Each seam's production client: "judge" (R1's judge client, temperature 0) or "interviewer"
# (Christy's client, build_r1_llm at its default temperature).
SEAM_CLIENTS: dict[str, str] = {
    "judge_runner": "judge",
    "end_intent_runner": "judge",
    "turn_reader_runner": "judge",
    "bridge_runner": "interviewer",
}
# The ground-truth acts of a candidate who wants the role-play or the interview to stop.
STOP_ACTS = frozenset({"end_request", "end_agree", "wrap_accept"})
END_INTENT_LATENCY_SEC = 0.4
BRIDGE_LATENCY_SEC = 0.9
TURN_READER_LATENCY_SEC = 0.6
BRIDGE_LINES = (
    "Thank you, that gives me a picture of how you work with people.",
    "Thanks, that helps me understand how you approach a call.",
)
EMPTY_READING = {"labels": {}, "answered_her_worry": "none", "answer_evidence": ""}


class UnknownSeam(RuntimeError):
    """``R1Interview`` takes a ``*_runner`` this harness does not know the production client of."""


def seam_client(name: str) -> str:
    """The production client of a seam ("judge" or "interviewer"); raises ``UnknownSeam``."""
    try:
        return SEAM_CLIENTS[name]
    except KeyError:
        raise UnknownSeam(
            f"R1Interview takes {name!r}, which rehearsal.seams.SEAM_CLIENTS does not map to its "
            "production client; add it there (judge or interviewer) before a live sweep"
        ) from None


def check_seams(names: Iterable[str]) -> None:
    """Raise ``UnknownSeam`` for the first seam with no known production client."""
    for name in names:
        seam_client(name)


def _latest_candidate(runtime: Any) -> Any:
    for span in reversed(getattr(runtime, "spans", [])):
        if span.speaker == "candidate":
            return span
    return None


class ScriptedEndIntent:
    """Offline end-intent classifier: the verdict the candidate's turn calls for, from its act.

    A turn whose ground truth is a wish to stop (an end request, a yes to Christy's question, a yes
    to the offer to wrap up) is "end" when it names the interview or the role-play and ends on
    it (``strictly_names_end``), else "maybe"; every other turn (an insult, a decline, sales talk)
    is "no".  The session's rails (``end_intent_level``) apply to it exactly as to the model's.
    """

    def __init__(self, runtime: Any, *, latency: float = END_INTENT_LATENCY_SEC) -> None:
        self.runtime = runtime
        self.latency = latency
        self.calls = 0

    async def __call__(self, _messages: list[dict[str, str]]) -> str:
        self.calls += 1
        await asyncio.sleep(self.latency)
        span = _latest_candidate(self.runtime)
        label = "no"
        if span is not None and span.act in STOP_ACTS:
            label = "end" if _names_end(span.text) else "maybe"
        return json.dumps({"intent": label})


def _names_end(text: str) -> bool:
    try:
        from r1_tracker import strictly_names_end
    except ImportError:  # pragma: no cover - feature detect
        return False
    return bool(strictly_names_end(text))


class ScriptedBridge:
    """Offline transition bridge: one neutral sentence, rotated (the session's own checks decide
    whether it is spoken)."""

    def __init__(self, *, latency: float = BRIDGE_LATENCY_SEC) -> None:
        self.latency = latency
        self.calls = 0

    async def __call__(self, _messages: list[dict[str, str]]) -> str:
        self.calls += 1
        await asyncio.sleep(self.latency)
        return BRIDGE_LINES[(self.calls - 1) % len(BRIDGE_LINES)]


class ScriptedTurnReader:
    """Offline turn reader (shadow, log-only): a valid reading with no labels."""

    def __init__(self, *, latency: float = TURN_READER_LATENCY_SEC) -> None:
        self.latency = latency
        self.calls = 0

    async def __call__(self, _messages: list[dict[str, str]]) -> str:
        self.calls += 1
        await asyncio.sleep(self.latency)
        return json.dumps(EMPTY_READING)


SCRIPTED: dict[str, Callable[[Any], Callable[[list], Any]]] = {
    "end_intent_runner": lambda runtime: ScriptedEndIntent(runtime),
    "bridge_runner": lambda runtime: ScriptedBridge(),
    "turn_reader_runner": lambda runtime: ScriptedTurnReader(),
}


def scripted_runners(runtime: Any, names: Iterable[str]) -> dict[str, Callable[[list], Any]]:
    """Offline stand-ins for every seam in ``names`` that has one (the judge has its own)."""
    return {name: SCRIPTED[name](runtime) for name in names if name in SCRIPTED}


__all__ = [
    "SEAM_CLIENTS",
    "ScriptedBridge",
    "ScriptedEndIntent",
    "ScriptedTurnReader",
    "UnknownSeam",
    "check_seams",
    "scripted_runners",
    "seam_client",
]
