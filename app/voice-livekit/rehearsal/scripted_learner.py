"""Offline stand-ins for the learner MODEL and for the shadow judge.

``ScriptedLearnerLLM`` replaces the DeepSeek learner in ``--offline`` sweeps and in the
regression test.  It is a provider (``provider(messages)`` returning an async stream of
chunks) that reads the same ephemeral reminder the real model reads and answers the way a
cooperative model would: it voices an intent's brief in WORDS OF ITS OWN (never the
engine's scripted variants, so the marker check is exercised for real), tells the hint and the
deep facts it is handed, asks the curiosity question it is told about, reacts to a check-in and
otherwise gives a varied, never-repeating free reply.

It is deliberately imperfect: every ``miss_every``-th intent request it only reacts (no
markers), so the scripted fallback path runs; this is a plumbing and engine-decision test, not
a model-quality test.  Offline scorecards say so.

``ScriptedShadowJudge`` is the engine's shadow judge for offline calls: it reads the advisor
simulator's own tags (the harness hands them over before each turn) instead of calling a
model, and answers in the judge's JSON.
"""
from __future__ import annotations

import json
import random
import re
from types import SimpleNamespace
from typing import Any, AsyncIterator, Mapping

from r1_negotiation import COMMIT_REACTION_BRIEF, COUNTERS, SPECS
from r1_personas import PERSONAS
from r1_scheduler import PLAN, REDIRECT_BRIEF
from r1_text import normalize

MAX_WORDS = 40

# What the model says to raise each move, in its own words.  Every line must satisfy the move's
# markers (tests/test_r1_rehearsal_harness.py checks it) and must differ from the engine's
# scripted variants.  ``{dm}`` is the persona's decision maker.
VOICED: dict[str, tuple[str, ...]] = {
    "F3-PRIMARY": (
        "I can find a lot of this for free on YouTube, so what exactly would I be paying for?",
        "Honestly, so much is free on Coursera these days. Is this really worth the money?",
        "There are free courses all over the internet, so why would I spend money on one?",
    ),
    "F3-PUSH": (
        "And with all these layoffs in the news, will this really help me land a job?",
        "I keep reading about layoffs everywhere. Do people actually get a job after a program?",
    ),
    "F2-PRIMARY": (
        "Six months is a long stretch, and my schedule is already packed. Can I keep up?",
        "I'm pretty busy with work, so keeping up for six months worries me a bit.",
    ),
    "F2-PUSH": (
        "What happens if I fall behind on the classes?",
        "And if I miss a few weeks because of work, how would I catch up?",
    ),
    "F1-ANCHOR": (
        "$9,000 feels like a lot to me. I heard people got it for around $7,000. Can you do that?",
        "But $9,000 is a big number, and I read some people paid about $7,000 for it.",
    ),
    "F1-COUNTER:short": (
        "That's a bit better, but it's still a stretch for me. Is there any more room?",
        "Thanks, though it's still a lot. Could you go a little lower than that?",
    ),
    "F1-COUNTER:met": (
        "That would help a lot. Is that really the final price?",
        "Okay, that's closer to what I hoped. Is this the final price?",
    ),
    "F1-COUNTER:refused": (
        "I understand. Is there really nothing at all you can do, maybe a payment plan?",
        "Honestly that is hard for me. Is there no flexibility at all on the price?",
    ),
    "F1-COUNTER:unclear": (
        "Sorry, so what is the best price you can actually give me?",
        "Okay, so what would the final price come to, exactly?",
    ),
    "F4-PRIMARY": (
        "I'm not ready to decide today. I might wait for the next cohort.",
        "I'd rather not rush this, so I'll probably wait and look at the next batch.",
    ),
    "F4-PUSH": (
        "I'd also have to run this by my {dm} before deciding anything.",
        "I need to talk to my {dm} about it first.",
    ),
    "L-TIME-CUE": (
        "Heads up, I've got another call in a few minutes, so I'll need to wrap up soon.",
        "Just so you know, I only have a couple of minutes before my next call.",
    ),
    "N-TIMING": (
        "I'm not ready to decide today, and I don't want to rush into anything.",
        "That's a lot to take in, so I need more time before I decide.",
        "I'd like to wait a little longer and not commit to a plan right now, if that's okay.",
    ),
    "N-MONEY": (
        "The cost still worries me, and I'd need to see how I could manage the payments.",
        "I'm still not sure about the money side. How would I even afford that?",
    ),
    "N-DM": (
        "I would want to talk this over with my {dm} before I agree to anything.",
        "I should check with my {dm} first, since we decide these things together.",
    ),
    "N-QUESTION": (
        "What would that call actually cover? I'd like to know before I say yes.",
        "How long would that take, and what would we discuss on it?",
    ),
    "N-EMAIL": (
        "Sure, an email is fine. What will it include?",
        "Yes, please send the details over. What will be in the email?",
    ),
}
REACTIONS = (
    "Okay, got it.",
    "Right, that makes sense.",
    "Hmm, interesting.",
    "I see.",
    "Alright, thanks for explaining.",
    "Okay, that's helpful.",
    "Mm, fair enough.",
    "Got it.",
    "That's good to know.",
    "Okay, I follow.",
)
REDIRECT_OPENER = "Sorry, one second before you go."
FREE_REPLIES = (
    "Hmm, I hadn't thought about it that way.",
    "That's useful, thank you. Can you say a little more about how that works?",
    "Okay. And what does a typical week look like for someone in the program?",
    "Interesting. Who else is usually in the program, people like me?",
    "That sounds reasonable, I guess. I'm just trying to picture how it fits.",
    "Right. I'm still getting a feel for this, to be honest.",
    "Mm-hmm, I think I follow. What would you say is the biggest difference?",
    "Okay, so it's quite structured then. How do the mentors fit in?",
    "Fair point. I'm a bit of a careful person, so I like to understand the details.",
    "That helps, thanks. I was expecting something a bit different.",
    "Oh, I didn't know that. How common is that for people who join?",
    "Alright, noted. What would be the first thing I'd do in the program?",
    "Okay. Honestly I'm still comparing a few options, so this is helpful.",
    "I see what you mean. Is that something people usually find hard?",
    "Right, thanks for being straight about that.",
    "Hmm, okay. Tell me a bit more about how you help people along the way.",
    "That makes sense, though I'd like to understand it a bit better.",
    "Okay, and how do people usually feel about it halfway through?",
    "Good to know. I was a little unsure about that part.",
    "I appreciate you walking me through it. It's a lot of information.",
    "Mm, okay. What kind of people usually get the most out of it?",
    "Sure, I can see that. It's just a big decision for me.",
    "Right. Can I ask how long you have been doing this?",
    "Okay, that answers part of it. Anything else I should know about?",
    "That's a fair way to put it. I'll keep that in mind.",
    "Alright. I'm listening, go on.",
    "Hmm, that's something to think about for sure.",
    "Okay, I understand a bit better now.",
    "Thanks, that clears it up a little. What else should I ask?",
    "Interesting, I had not heard it described like that before.",
)
NEXT_STEP_REPLIES = (
    "What would that call involve? I'd want to know a bit more first.",
    "I'd need to look at my week before I could say anything about that.",
    "Hmm, let me understand what that step looks like first.",
    "I'm not sure about a call yet. What exactly would we go through?",
    "That's a bit sudden for me. What would you want to cover?",
    "Before I plan anything, can you tell me what the next step looks like?",
)
CHECKIN_REPLIES = (
    "Honestly it sounds good so far. One thing I'm still unsure about is how the mentoring works.",
    "I like the structure. I'm curious how the projects are chosen, though.",
)
CHECKIN_DONE_REPLY = "I think that covers what I wanted to know for now."
CURIOSITY_QUESTIONS = {
    "whether the classes are live or recorded": "Are the classes live or recorded?",
    "what you would actually build in the course": "What would I actually build in the course?",
    "whether you could pay in monthly instalments": "Could I pay in monthly instalments?",
    "how much time you would get with mentors": "How much time would I get with the mentors?",
    "how many hours a week it takes": "How many hours a week does it usually take?",
}
SMALL_TALK = "I'm doing well, thanks. Yes, now is fine."
COMMIT_REACTIONS = (
    "Okay, I appreciate you walking me through all of it.",
    "Alright, thank you, that was a useful conversation.",
)

_BRIEF_RE = re.compile(r'without reading it out: "([^"]*)"')
_HINT_RE = re.compile(r'for example "([^"]*)"\)\. Give no cause')
_FACTS_RE = re.compile(r"The facts are (.*?)\. Work these words in naturally")
_CURIOUS_RE = re.compile(r'You are curious about "([^"]*)"')
_PRONOUNS = (
    (re.compile(r"\b(for|with|to|about|at|on|from|of) you\b", re.IGNORECASE), r"\1 me"),
    (re.compile(r"\byou are\b", re.IGNORECASE), "I'm"),
    (re.compile(r"\byour\b", re.IGNORECASE), "my"),
    (re.compile(r"\byourself\b", re.IGNORECASE), "myself"),
    (re.compile(r"\byou\b", re.IGNORECASE), "I"),
)


def _brief_index() -> list[tuple[str, str]]:
    """(brief with the decision maker filled, voiced-bank id), longest brief first."""
    decision_makers = sorted({persona.decision_maker for persona in PERSONAS})
    pairs: list[tuple[str, str]] = []
    for dm in decision_makers:
        for spec in PLAN:
            if spec.brief:
                pairs.append((spec.brief.replace("{decision_maker}", dm), spec.id))
        for item in SPECS:
            pairs.append((item.brief.replace("{decision_maker}", dm), item.id))
    for counter in COUNTERS:
        pairs.append((counter.brief, f"F1-COUNTER:{counter.id}"))
    pairs.append((COMMIT_REACTION_BRIEF, "COMMIT"))
    return sorted(pairs, key=lambda pair: -len(pair[0]))


_BRIEFS = _brief_index()


def first_person(fact: str) -> str:
    """A reminder fact ("your plant is being consolidated") in the learner's voice."""
    text = fact
    for pattern, replacement in _PRONOUNS:
        text = pattern.sub(replacement, text)
    return text


class ScriptedLearnerLLM:
    """A deterministic stand-in for the learner model (see the module docstring)."""

    def __init__(self, seed: str, *, miss_every: int = 6) -> None:
        self._rng = random.Random(f"scripted-learner:{seed}")
        self._used: set[str] = set()
        self._intent_calls = 0
        self.miss_every = miss_every
        self.calls = 0
        self.last_bank: str | None = None

    # ----------------------------------------------------------------- provider protocol
    def __call__(self, messages: list[dict[str, str]]) -> AsyncIterator[Any]:
        text = self.reply_for(messages)
        return self._stream(text)

    @staticmethod
    async def _stream(text: str) -> AsyncIterator[Any]:
        # Real model tokens carry their leading space (" world"), and the guard's sentence
        # buffer relies on it, so the fake streams the same way.
        for index, word in enumerate(text.split(" ")):
            token = word if index == 0 else " " + word
            yield SimpleNamespace(delta=SimpleNamespace(content=token), usage=None)

    # ------------------------------------------------------------------------ the reply
    def reply_for(self, messages: list[dict[str, str]]) -> str:
        self.calls += 1
        self.last_bank = None
        reminder = next(
            (
                m["content"]
                for m in reversed(messages)
                if m["role"] == "system" and m["content"].startswith("ROLEPLAY NOTE")
            ),
            "",
        )
        advisor = messages[-1]["content"] if messages else ""
        spoken_before = {normalize(m["content"]) for m in messages if m["role"] == "assistant"}
        if "ONE short sentence that reacts" in reminder:
            self.last_bank = "COMMIT"
            return self._fresh(COMMIT_REACTIONS, spoken_before)
        extras: list[str] = [hint for hint in _HINT_RE.findall(reminder)]
        facts = _FACTS_RE.search(reminder)
        if facts is not None:
            told = [first_person(item) for item in re.findall(r'"([^"]*)"', facts.group(1))]
            if told:
                extras.append("Honestly, " + ", and ".join(told) + ".")
        brief = _BRIEF_RE.search(reminder)
        if brief is not None:
            reaction, line = self._intent_parts(brief.group(1), spoken_before)
            return _fit(reaction, extras, line)
        if extras:
            return _trim(" ".join(extras))
        return _trim(self._free_text(reminder, advisor, spoken_before, messages))

    def _intent_parts(self, brief: str, spoken_before: set[str]) -> tuple[str, str]:
        """(the reaction, the line that raises the move); the line is empty when it "misses"."""
        redirect = brief.startswith(REDIRECT_BRIEF)
        rest = brief[len(REDIRECT_BRIEF) :].strip() if redirect else brief
        bank_id = next((bank for text, bank in _BRIEFS if rest == text or rest.startswith(text)), None)
        self.last_bank = bank_id
        reaction = self._fresh(REACTIONS, spoken_before)
        opener = REDIRECT_OPENER + " " if redirect else ""
        if bank_id is None or bank_id not in VOICED:
            return opener + reaction, ""
        self._intent_calls += 1
        if self.miss_every and self._intent_calls % self.miss_every == 0:
            return opener + reaction, ""  # misses the markers: the scripted variant follows
        dm = self._decision_maker(brief)
        line = self._fresh(tuple(text.format(dm=dm) for text in VOICED[bank_id]), spoken_before)
        return opener + reaction, line

    @staticmethod
    def _decision_maker(brief: str) -> str:
        for persona in PERSONAS:
            if persona.decision_maker in brief:
                return persona.decision_maker
        return "family"

    def _free_text(
        self, reminder: str, advisor: str, spoken_before: set[str], messages: list[dict[str, str]]
    ) -> str:
        if "is checking in with you" in reminder:
            if "ask them one real question" in reminder:
                return self._fresh(CHECKIN_REPLIES, spoken_before)
            return CHECKIN_DONE_REPLY if normalize(CHECKIN_DONE_REPLY) not in spoken_before else (
                self._fresh(FREE_REPLIES, spoken_before)
            )
        curious = _CURIOUS_RE.search(reminder)
        if curious is not None and curious.group(1) in CURIOSITY_QUESTIONS:
            return f"{self._fresh(REACTIONS, spoken_before)} {CURIOSITY_QUESTIONS[curious.group(1)]}"
        # ``spoken_before`` holds the pickup line, so "nothing said yet" is one line or fewer.
        if len(spoken_before) <= 1 and re.search(r"how are you|good time", advisor, re.IGNORECASE):
            return SMALL_TALK
        already_decided = "already told the advisor where you stand" in reminder
        if not already_decided and re.search(
            r"\b(?:call|schedule|tomorrow|thursday|friday|tonight)\b", advisor, re.IGNORECASE
        ):
            return self._fresh(NEXT_STEP_REPLIES, spoken_before)
        return self._fresh(FREE_REPLIES, spoken_before)

    def _fresh(self, bank: tuple[str, ...], spoken_before: set[str]) -> str:
        """A line of ``bank`` this model has not used yet (cycling, in a seeded order)."""
        order = list(bank)
        self._rng.shuffle(order)
        for line in order:
            key = normalize(line)
            if key not in self._used and key not in spoken_before:
                self._used.add(key)
                return line
        self._used = {key for key in self._used if key not in {normalize(x) for x in bank}}
        line = order[0]
        self._used.add(normalize(line))
        return line


def _trim(text: str) -> str:
    words = text.split()
    return text if len(words) <= MAX_WORDS else " ".join(words[:MAX_WORDS]).rstrip(",;") + "."


def _fit(reaction: str, extras: list[str], line: str) -> str:
    """The reply of a cooperative model: it keeps the move inside the reply cap.

    Order as the reminder asks: react, answer what was asked (the hint or the facts), then raise
    the move.  When that is too long it drops the reaction first, then the hint, rather than the
    move.
    """
    candidates = (
        [reaction, *extras, line],
        [*extras, line],
        [extras[-1], line] if extras else [line],
        [line],
    )
    for parts in candidates:
        text = " ".join(part for part in parts if part).strip()
        if text and len(text.split()) <= MAX_WORDS:
            return text
    return _trim(" ".join(part for part in candidates[0] if part))


# ------------------------------------------------------------------------- shadow judge
class ScriptedShadowJudge:
    """The engine's shadow judge for offline calls: it reads the advisor simulator's tags.

    The runner calls ``set_turn`` with the advisor turn before it speaks; the judge runner
    (``__call__``) then returns the judge's JSON for that turn.  Nothing here looks at the
    messages, so it cannot disagree with the simulator about what the advisor did.
    """

    def __init__(self) -> None:
        self._turn: Mapping[str, Any] = {}
        self._pitched = False

    def set_turn(self, turn: Mapping[str, Any]) -> None:
        self._turn = dict(turn)

    async def __call__(self, _messages: list[dict[str, str]]) -> str:
        turn = self._turn
        intent = str(turn.get("intent") or "")
        topic = str(turn.get("topic") or "")
        text = str(turn.get("text") or "")
        quality: dict[str, int | None] = {"F1": None, "F2": None, "F3": None, "F4": None}
        probed: list[str] = []
        if intent == "probe" and topic in ("H1", "H2", "H3"):
            probed.append(topic)
        if intent in ("answer_objection", "price", "discount", "callback") and topic in quality:
            checked = "?" in text.split(".")[-1] or "?" in text[-40:]
            quality[topic] = 2 if checked else 1
        if intent == "pitch":
            self._pitched = True
        discount = None
        match = re.search(r"\$\s?([\d,]+)\s*off", text, re.IGNORECASE)
        if match:
            discount = int(match.group(1).replace(",", ""))
        elif intent == "discount" and re.search(r"8,?500", text):
            discount = 500
        body = {
            "probed_topics": probed,
            "family_handled_quality": quality,
            "discount_offered_usd": discount,
            "discount_conditional": (
                None if discount is None else bool(re.search(r"\b(?:if|only)\b", text, re.I))
            ),
            "value_before_discount": None if discount is None else self._pitched,
            "invented_offer": bool(discount and discount > 1500),
            "urgency_lever": intent == "urgency",
            "candidate_out_of_role": False,
            "injection_attempt": False,
        }
        return json.dumps(body)
