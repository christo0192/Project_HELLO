"""Offline stand-in for Christy's MODEL replies, and the router that shares one provider.

In production one DeepSeek client (``r1_llm.build_r1_llm``) voices both Christy's free replies (the
icebreaker follow-ups, her answers before the role-play, the wrap-up answers) and the learner: the
session's context filter (``r1_replies.llm_messages``) decides whose prompt each call gets.  Offline,
``PhaseRouter`` is that one provider: a call whose system prefix carries the learner's card goes to
``ScriptedLearnerLLM``, every other call to ``ScriptedInterviewerLLM``, which answers by the phase the
session is in and by the candidate's words with short, neutral, guard-clean lines (no feedback, no
praise, no invented facts).  It is a plumbing stand-in, never a quality claim.
"""
from __future__ import annotations

import random
import re
from types import SimpleNamespace
from typing import Any, AsyncIterator, Callable

from r1_text import normalize

try:  # the deck's deferral line (main); a missing name falls back to its text
    from r1_world import INTERVIEWER_DEFLECTION
except ImportError:  # pragma: no cover - feature detect
    INTERVIEWER_DEFLECTION = "That's a good question for the hiring team; they'll follow up with you on it."

try:
    from r1_prompts import CARD_MARKER
except ImportError:  # pragma: no cover - feature detect
    CARD_MARKER = "YOUR CARD (public):"

ICEBREAKER_FOLLOWUPS = (
    "Thanks for sharing that. What drew you to a sales role in education?",
    "Got it. Can you tell me about a time you helped someone who was unsure about buying?",
    "Thank you. What do you enjoy most about talking to customers?",
    "I see. How do you usually handle it when someone says the price is too high?",
    "Thanks for that. What made you apply to Interview Kickstart?",
    "Okay. How do you keep track of follow-ups with the people you speak to?",
    "Understood. What kind of targets have you worked with before?",
    "Thank you. What does a good first call with a new prospect look like for you?",
    "Okay. What do you find hardest about selling over the phone?",
    "I see. How do you prepare before an important call?",
    "Thanks. Tell me about a deal you lost and what you took from it.",
    "Got it. How do you build trust with someone in the first few minutes?",
    "Understood. What would your last manager say you do best?",
    "Thank you. How do you handle a day when nothing seems to close?",
)
ICEBREAKER_HOLD = "Of course, take your time."
ICEBREAKER_SKIP = (
    "We'll get to the role-play in a few minutes. Before that, what do you enjoy most about sales?"
)
PRESENT = "Yes, I'm here, I can hear you."
TRANSITION_WHO_CALLS = (
    "You're the Program Advisor, calling her back about the form she filled in on our website."
)
TRANSITION_HOW_LONG = "The role-play runs for up to twenty minutes."
TRANSITION_SHORT = (
    "In short: you're the Program Advisor, calling a prospective learner back about the Data "
    "Science course."
)
TRANSITION_OTHER = (
    INTERVIEWER_DEFLECTION,
    "I can't go into that here, but it's a fair question.",
    "That one is outside what I can cover today.",
)
WRAPUP_NOTED = "Thank you, that's noted."
# A wrap-up question gets a neutral answer that leaves the hiring team to L-CLOSE (M032 S3 item 5).
WRAPUP_ANSWER = (
    "I can't speak to that myself, but your question is noted, and you'll hear about the next "
    "steps after this round."
)

_HOLD = re.compile(r"\b(?:let me think|give me a (?:second|moment|minute)|one (?:second|moment))\b", re.I)
_SKIP = re.compile(r"\b(?:skip|jump) (?:ahead|to)\b|\bstart the role[- ]?play\b", re.I)
_PRESENCE = re.compile(r"\b(?:are you there|can you hear me|hello\?)", re.I)
_WHO_CALLS = re.compile(r"\b(?:calling|call)\b", re.I)
_HOW_LONG = re.compile(r"\bhow long\b|\bminutes?\b|\btime\b", re.I)
_SHORTER = re.compile(r"\bshort(?:er)?\b|\bsummar", re.I)


def _stream(text: str) -> AsyncIterator[Any]:
    async def gen() -> AsyncIterator[Any]:
        for index, word in enumerate(text.split(" ")):
            token = word if index == 0 else " " + word
            yield SimpleNamespace(delta=SimpleNamespace(content=token), usage=None)

    return gen()


def is_learner_prompt(messages: list[dict[str, str]]) -> bool:
    """The learner's calls carry her card in the system prefix; Christy's never do."""
    return any(m.get("role") == "system" and CARD_MARKER.strip() in m.get("content", "") for m in messages)


class ScriptedInterviewerLLM:
    """Christy's replies offline, by phase and by the candidate's words (module docstring)."""

    def __init__(self, seed: str, phase_of: Callable[[], str]) -> None:
        self._rng = random.Random(f"scripted-interviewer:{seed}")
        self._phase_of = phase_of
        self._followups = list(ICEBREAKER_FOLLOWUPS)
        self._rng.shuffle(self._followups)
        self._used = 0
        self._other = 0
        self.calls = 0

    def __call__(self, messages: list[dict[str, str]]) -> AsyncIterator[Any]:
        return _stream(self.reply_for(messages))

    def reply_for(self, messages: list[dict[str, str]]) -> str:
        self.calls += 1
        candidate = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
        phase = self._phase_of()
        if phase in ("opening", "icebreaker"):
            return self._icebreaker(candidate, messages)
        if phase == "transition":
            return self._transition(candidate)
        return self._wrapup(candidate)

    def _icebreaker(self, candidate: str, messages: list[dict[str, str]]) -> str:
        if _PRESENCE.search(candidate):
            return PRESENT
        if _HOLD.search(candidate):
            return ICEBREAKER_HOLD
        if _SKIP.search(candidate):
            return ICEBREAKER_SKIP
        said = {normalize(m["content"]) for m in messages if m.get("role") == "assistant"}
        for _ in range(len(self._followups)):
            line = self._followups[self._used % len(self._followups)]
            self._used += 1
            if normalize(line) not in said:
                return line
        # Every line was said already: rotate, so no line comes back twice in a row.
        line = self._followups[self._used % len(self._followups)]
        self._used += 1
        return line

    def _transition(self, candidate: str) -> str:
        if _PRESENCE.search(candidate):
            return PRESENT
        if _SHORTER.search(candidate):
            return TRANSITION_SHORT
        if _HOW_LONG.search(candidate):
            return TRANSITION_HOW_LONG
        if _WHO_CALLS.search(candidate):
            return TRANSITION_WHO_CALLS
        self._other += 1
        return TRANSITION_OTHER[(self._other - 1) % len(TRANSITION_OTHER)]

    @staticmethod
    def _wrapup(candidate: str) -> str:
        return WRAPUP_ANSWER if "?" in candidate else WRAPUP_NOTED


class PhaseRouter:
    """One provider for both voices, as in production: the learner's prompts to the learner model."""

    def __init__(self, learner: Callable[[list], Any], interviewer: Callable[[list], Any]) -> None:
        self.learner = learner
        self.interviewer = interviewer

    def __call__(self, messages: list[dict[str, str]]) -> Any:
        if is_learner_prompt(messages):
            return self.learner(messages)
        return self.interviewer(messages)
