"""R1 earned close: ask detector, commitment levels, grade and the three scripted lines.

Plan 5.8.  The worker, not the LLM, decides whether and how the learner commits:

* ``detect_ask`` runs on the candidate's text.  An enrolment ask, or a request to book a
  call, a day or a time, counts.  S0-B found the learner accepting a dated call while only
  the WEAK stall was allowed, so call and time asks are first-class here (they are MEDIUM
  commitments), not an afterthought to the enrolment words.
* ``grade`` turns the worker's own evidence into STRONG, MEDIUM or WEAK.
* The learner's commitment lines are scripted and spoken by the worker.  An LLM sentence
  that reaches a level above WEAK is a violation (``classify_learner_commitment`` is the
  detector ``r1_guard`` uses).

The module holds only pure functions and constants.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum, IntEnum
from typing import Mapping

from r1_text import fold, fuzzy_contains, split_sentences

COMMIT_PERMITTED_R_SEC = 540
COMMIT_STALL_R_SEC = 780
MASK_PLACEHOLDER = "[learner commitment response withheld from scoring]"
FAMILIES = ("F1", "F2", "F3", "F4")
DISCOUNT_CAP_USD = 1500


class Level(IntEnum):
    """Commitment levels, ordered so ``level > Level.WEAK`` means "more than a stall"."""

    NONE = 0
    WEAK = 1
    MEDIUM = 2
    STRONG = 3


class AskKind(str, Enum):
    """ENROL asks for enrolment or payment; CALL asks for a call, a time or a next step."""

    ENROL = "enrol"
    CALL = "call"


COMMITMENT_LINES = {
    Level.STRONG: (
        "Okay, let's do it. Send me the enrolment link for that plan and I'll pay the "
        "deposit today."
    ),
    Level.MEDIUM: (
        "Let's book a call on Thursday at 7 PM with my {decision_maker} so we can decide."
    ),
    Level.WEAK: "Let me think about it. Just email me the details and I'll get back to you.",
}


def commitment_line(level: Level, decision_maker: str) -> str:
    """The scripted line for ``level``; NONE is not a commitment and has no line."""
    if level is Level.NONE:
        raise ValueError("no commitment line for Level.NONE")
    return COMMITMENT_LINES[level].format(decision_maker=decision_maker)


def stall_line(decision_maker: str) -> str:
    """The WEAK line, which is also the only response permitted before the close window."""
    return commitment_line(Level.WEAK, decision_maker)


def is_commitment_line(text: object, decision_maker: str) -> bool:
    """True when ``text`` is (a fuzzy rendering of) one of the three scripted lines."""
    return any(
        fuzzy_contains(text, commitment_line(level, decision_maker))
        for level in (Level.STRONG, Level.MEDIUM, Level.WEAK)
    )


def mask_for_scorer(text: str, decision_maker: str) -> str:
    """Replace a scripted commitment line with a placeholder (it is never evidence)."""
    return MASK_PLACEHOLDER if is_commitment_line(text, decision_maker) else text


_DAY = r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight)"
_CLOCK = r"\d{1,2}(?::\d\d)?\s*(?:am|pm)"


def _compile(*patterns: str) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(pattern, re.IGNORECASE) for pattern in patterns)


_ENROL_ASK = _compile(
    r"\b(?:shall|should|can|could|may|would|will) (?:i|we) (?:\w+ ){0,2}?"
    r"(?:send|share|email|proceed|go ahead|enrol+|register|sign|reserve|lock|secure|"
    r"process|get you)\b",
    r"\b(?:let'?s|let us) (?:get you|go ahead|move forward|proceed|enrol+|sign|register|"
    r"finali[sz]e|lock|secure|reserve)\b",
    r"\b(?:are|were) you (?:ready|willing|prepared|interested|keen) (?:to|in) "
    r"(?!hear|talk|discuss|dive|get into|speak|share|tell|go through|learn more|know)\w+",
    r"\b(?:sign(?:ing)?|enrol+(?:ing)?|register(?:ing)?) (?:you|me) "
    r"(?:up|in|enrolled|registered|started|onboard)\b",
    r"\b(?:let'?s|shall we|can we|want me to|would you like me to|ready to) (?:\w+ ){0,2}"
    r"get you (?:started|enrolled|signed up|registered|onboard)\b",
    r"\b(?:we|i)(?:'ll| will| can| could| should)? get you (?:enrolled|signed up|registered)\b",
    r"\bsend\b[^.?!]{0,15}\b(?:payment|enrol+ment|registration) (?:details|form|page)\b",
    r"\benrol+ me\b",
    r"\b(?:i'?ll|i will|we'?ll|we will|shall i|can i|could i|let me|let us|let'?s) "
    r"(?:\w+ ){0,2}?enrol+ you\b",
    r"\b(?:would you like|do you want) to (?:enrol+|sign up|join|proceed|move forward|"
    r"get started|secure|reserve|lock|go ahead|take (?:it|this|the course|the program))\b",
    r"\b(?:payment|enrol+ment|registration|sign-?up|invoice) link\b",
    r"\bsend (?:you |me )?(?:the |a |an )?(?:link|invoice|payment|enrol+ment form|"
    r"registration form)\b",
    r"\b(?:pay|put down|make|place) (?:the |a |your |an )?(?:\w+ )?deposit\b"
    r"|\bdeposit (?:today|now)\b",
    r"\b(?:can|could|will|would|shall|should) you (?:\w+ ){0,2}pay (?:today|now|upfront|"
    r"in full)\b|\b(?:please )?pay (?:today|now)\b",
    r"\b(?:book|reserve|secure|lock in|hold|save) (?:your|a|the|my) (?:spot|seat|place)\b",
    r"\b(?:want|like|ready|shall|should|can|could|let'?s|how about|what about|time to|"
    r"happy to|why don'?t we|why not)\b[^.?!]{0,20}\b(?:move forward|proceed|go ahead)\b",
    r"\bready to (?:enrol+|sign|join|commit|move|proceed)\b",
    r"\bhow (?:would|do) you (?:like|want) to (?:proceed|move forward|go forward|pay|enrol+)\b",
)
_CALL_ASK = _compile(
    r"\b(?:schedule|set up|book|arrange|line up|fix|plan|organi[sz]e|pencil in)\b"
    r"[^.?!]{0,30}\b(?:call|chat|meeting|session|demo|time|slot|follow[- ]?up|"
    r"catch[- ]?up|conversation)\b",
    r"\b(?:can|could|shall|should|would|will|may|how about|what about|let'?s|want to|"
    r"like to)\b[^.?!]{0,25}\b(?:follow[- ]?up|quick|another|second|short|brief|next) "
    r"(?:call|chat|meeting|conversation)\b",
    r"\b(?:can|could|shall|should|may|will|i'?ll|let me) (?:i |we )?call (?:you )?back\b",
    r"\b(?:can|could|shall|should|may|will|i'?ll|let me) (?:i |we )?(?:call|ring|ping|text) you "
    r"(?:back|tomorrow|tonight|on|at|later|this|next)\b",
    r"\b(?:talk|speak|connect|chat|catch up)\b (?:again |to you |with you )?(?:on |this |next )?"
    r"(?:" + _DAY + r"|week)\b",
    r"\b(?:does|would|will|is|how about|what about|shall we do|can we do|do)\b"
    r"[^.?!]{0,30}\b(?:" + _DAY + r"|next week|this week|" + _CLOCK + r")\b"
    r"[^.?!]{0,30}\b(?:work|works|suit|suits|good|fine|okay|ok|convenient|better)\b",
    r"\bwhat (?:day|time|date|slot)s?\b[^.?!]{0,30}\b(?:work|works|suit|suits|good|"
    r"convenient|best|free|available)\b",
    r"\bwhen (?:are|would|can|could) you (?:be )?(?:free|available|up for|ok|okay|"
    r"comfortable)\b",
    r"\bare you (?:free|available)\b[^.?!]{0,30}\b(?:" + _DAY + r"|this week|next week|call)\b",
    r"\b(?:i'?ll|i will|let me|we'?ll|we will) (?:call|ring|ping|reach out|get back|"
    r"follow up|check in|connect)\b[^.?!]{0,40}\b(?:" + _DAY + r"|next week|this week|"
    r"later today)\b",
    r"\bwhat(?:'s| is| would be) (?:the |a )?(?:best |good |right )?next step\b",
)


@dataclass(frozen=True)
class Ask:
    """A detected ask: its kind and the matched phrase (a few words, for logs)."""

    kind: AskKind
    phrase: str


def detect_ask(text: object) -> Ask | None:
    """Return the strongest enrolment or call ask in the candidate's ``text``, if any.

    An enrolment ask outranks a call ask.  Detection is purely lexical and
    deterministic, so a prompt-injection string cannot talk the worker into or out of
    treating a turn as an ask.
    """
    call_hit: Ask | None = None
    for sentence in split_sentences(text):
        lowered = fold(sentence).lower()
        for pattern in _ENROL_ASK:
            match = pattern.search(lowered)
            if match:
                return Ask(AskKind.ENROL, match.group(0)[:40])
        if call_hit is None:
            for pattern in _CALL_ASK:
                match = pattern.search(lowered)
                if match:
                    call_hit = Ask(AskKind.CALL, match.group(0)[:40])
                    break
    return call_hit


_JOIN_COURSE = (
    r"join (?:the|this|your|that|our) (?:next |upcoming |data science )*"
    r"(?:course|program|programme|cohort|batch|bootcamp|class)"
)
_STRONG = _compile(
    r"\blet'?s do it\b",
    r"\bsign me up\b",
    r"\bcount me in\b",
    r"\bi'?m sold\b",
    r"\byou(?:'ve| have) convinced me\b",
    r"\bi'?ll (?:enrol+|sign up|register|pay (?:the )?(?:deposit|today)|go ahead)\b",
    r"\bi'?ll take it\b(?!\s+from)",
    r"\bsend (?:me )?(?:the )?(?:enrol+ment|payment|registration|sign-?up) link\b",
    r"\bi'?m ready to (?:enrol+|sign up|join|pay|commit)\b",
    r"\blet'?s (?:enrol+|get (?:me )?started|go ahead|move forward)\b",
    # "join" only counts with a course object: "I want to join a data team eventually" is a
    # career goal, not an enrolment.  ("i'd like" is one word to speech-to-text.)
    r"\bi(?:'d| would) like to (?:enrol+|sign up|move forward|proceed|" + _JOIN_COURSE + r")\b",
    r"\bi want to (?:enrol+|sign up|move forward|proceed|" + _JOIN_COURSE + r")\b",
)
_MEDIUM = _compile(
    r"\b(?:call|chat|meeting)\b[^.?!]{0,40}\b(?:could|would|should|will|can|does) work\b",
    r"\b" + _DAY + r"\b[^.?!]{0,15}\b(?:works?|is (?:good|fine|great|best)|suits)\b",
    r"\btalk (?:on |again )?" + _DAY + r"\b",
    r"\b(?:let'?s|can we|could we|shall we) (?:set|book|schedule|line|lock|pencil)\b",
    r"\bwhat (?:times?|days?|slots?) (?:do you have|are you free|work|suits?)\b",
    r"\b(?:see|talk to|speak to|speak with|catch) you (?:on |this |next )?(?:" + _DAY +
    r"|week|then)\b",
    r"\b(?:i'?m|i am) (?:free|available)\b[^.?!]{0,20}(?:" + _DAY + r"|week|evening|"
    r"morning|afternoon|" + _CLOCK + r")",
    r"\b" + _CLOCK + r"\b[^.?!]{0,15}\b(?:works?|is fine|is good|suits)\b",
    r"\b(?:book|booked|schedule|scheduled|set up) (?:a|the|that|our|this) (?:call|chat|"
    r"meeting)\b",
)
_WEAK = _compile(
    r"\blet me think (?:about it|it over)\b",
    r"\bemail me\b",
    r"\bsend (?:me )?(?:the |an? )?(?:details|info|information|summary|email)\b",
    r"\bget back to you\b",
    r"\bi'?ll (?:think|be in touch)\b",
)


def classify_learner_commitment(text: object) -> Level:
    """The highest commitment level expressed in learner ``text``.

    STRONG is an enrolment or payment affirmation; MEDIUM is accepting or proposing a
    call, a day or a time; WEAK is the "let me think, email me" stall.  The scripted
    lines classify as their own level, and every scripted objection line classifies at
    most WEAK.
    """
    folded = fold(text)
    lowered = folded.lower()
    if any(pattern.search(lowered) for pattern in _STRONG):
        return Level.STRONG
    if fuzzy_contains(folded, COMMITMENT_LINES[Level.STRONG]):
        return Level.STRONG
    if any(pattern.search(lowered) for pattern in _MEDIUM):
        return Level.MEDIUM
    medium_line = COMMITMENT_LINES[Level.MEDIUM].replace("{decision_maker}", "")
    if fuzzy_contains(folded, medium_line, 0.7):
        return Level.MEDIUM
    if any(pattern.search(lowered) for pattern in _WEAK):
        return Level.WEAK
    return Level.NONE


@dataclass(frozen=True)
class CommitmentEvidence:
    """The worker's own record at the moment of the ask (plan 5.8 criteria)."""

    ask_kind: AskKind | None
    needs_released: int
    family_quality: Mapping[str, int | None]
    discount_ok: bool
    urgency_lever: bool


def families_answered(quality: Mapping[str, int | None]) -> tuple[str, ...]:
    """Families whose tracker quality is at least 1."""
    return tuple(
        family
        for family in FAMILIES
        if (quality.get(family) is not None and int(quality[family]) >= 1)
    )


def grade(evidence: CommitmentEvidence) -> Level:
    """STRONG, MEDIUM or WEAK for an ask that the close window permits.

    STRONG: commitment asked; at least 2 of 3 deep needs released; all four families
    answered with quality at least 1 (so F1 included); discount discipline intact; a
    legitimate urgency lever used.  MEDIUM: asked; at least 1 deep need released; at
    least 2 families answered.  Otherwise WEAK.  A call-only ask is capped at MEDIUM,
    because the learner is never offered a payment moment it did not ask for.  Missing
    tracker data (quality ``None``) counts as not answered, so a failed shadow judge can
    only lower the grade.
    """
    if evidence.ask_kind is None:
        return Level.WEAK
    answered = families_answered(evidence.family_quality)
    result = Level.WEAK
    if evidence.needs_released >= 1 and len(answered) >= 2:
        result = Level.MEDIUM
    if (
        evidence.needs_released >= 2
        and len(answered) == len(FAMILIES)
        and evidence.discount_ok
        and evidence.urgency_lever
    ):
        result = Level.STRONG
    if evidence.ask_kind is AskKind.CALL and result > Level.MEDIUM:
        result = Level.MEDIUM
    return result


def commitment_permitted(r_sec: float, families_complete: bool) -> bool:
    """A commitment other than the WEAK stall needs R >= 9:00 and all four families done."""
    return families_complete and r_sec >= COMMIT_PERMITTED_R_SEC
