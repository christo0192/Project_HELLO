"""R1 negotiation: the pure memory behind the learner's price, callback and close talk.

R1-Q.  In the owner test (b58c7d9c) the learner remembered nothing: a real $8,500 offer got
"Okay, that's helpful", a concrete callback proposal got the one sanctioned stall line, and
every mention of a next step got the same sentence again.  This module is the memory.  It reads
what the advisor (the candidate) said, keeps what was put on the table, and tells the role-play
engine WHAT the learner owes about it; the model still voices it in its own words.

Invariants (each has a test in ``tests/test_r1_negotiation.py``):

* Pure and deterministic: no I/O, no clock, no randomness.  Everything is lexical, so a
  prompt-injection string can neither create an offer nor talk the learner into a commitment.
* It only reads advisor text.  It stores turn indices, integers and normalised slot phrases
  (day, clock, part of day), never an utterance.
* A stall reason (timing, money, decision maker) is used once, and counts as handled only when
  the advisor addressed it AFTER the learner voiced it.  Timing and the decision maker belong to
  the owed F4 pair: the negotiation skips them until that pair was delivered, so no reason is
  voiced twice in a call (``Negotiation.voicings``).
* Prices are tracked from the first mention, not from the learner's anchor.  The advisor
  questioning or refusing a figure ("Who told you $7,000?", "$7,000 is too low for us") is not an
  offer, and a figure the learner itself said (the $7,000 anchor above all) is an offer only when
  the advisor's own clause promises it ("I can do $7,000").
* The commitment lines stay scripted and masked (``r1_commitment``); this module only picks the
  slot of the MEDIUM line (the advisor's evening or weekend proposal, else 7 PM) and whether
  the WEAK line was already said.  The WEAK line is said at most once per session.
* Every spoken variant here is ASCII, below the commitment cap, free of concession phrasing
  and of every persona's deep-need markers (the tests check all twelve persona variants).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

from r1_commitment import DEFAULT_SLOT, Level
from r1_scheduler import has_refusal, markers_match
from r1_text import (
    canonical_amounts,
    clause_after,
    clause_before,
    dollar_amounts,
    fold,
    is_question_like,
    negated_before,
    parse_amount,
    split_sentences,
)
from r1_world import PRICE_USD

# A turn longer than this is read from its end: closing proposals come last, and a hostile
# or runaway transcript cannot make the detectors slow.
MAX_TEXT_CHARS = 12000
# Stall rounds the learner may spend on reasons inside the close window before it gives its
# (scripted) WEAK resolution.
MAX_STALL_ROUNDS = 2
ANCHOR_USD = 7000
MIN_NET_USD = 4500
PREFERRED_TIME = "7 PM"
MOVED_DAY = "tomorrow"

REASON_TIMING = "timing"
REASON_MONEY = "money"
REASON_DECISION_MAKER = "decision_maker"
# The order the learner raises them in (the owed F4 pair covers timing and the decision maker
# once the families are done, so the first early ask meets the most natural one: timing).
REASONS = (REASON_TIMING, REASON_MONEY, REASON_DECISION_MAKER)

KIND_STALL = "stall"
KIND_QUESTION = "question"
KIND_EMAIL = "email"
KIND_COMMIT = "commit"

SITUATION_SHORT = "short"
SITUATION_MET = "met"
SITUATION_REFUSED = "refused"
SITUATION_UNCLEAR = "unclear"


def _compile(*patterns: str) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(pattern, re.IGNORECASE) for pattern in patterns)


def _tail(text: object) -> str:
    return fold(text)[-MAX_TEXT_CHARS:]


# ----------------------------------------------------------------------------------
# Spoken variants: what the learner can say, as worker-authored briefs and fallbacks.
# ----------------------------------------------------------------------------------
@dataclass(frozen=True)
class NegotiationSpec:
    """One thing the learner may raise on its own: a stall reason, a question, the e-mail yes.

    ``brief`` says what to raise (no candidate text), ``markers`` are all-of groups of any-of
    regexes proving it was raised (``r1_scheduler.markers_match``), and ``variants`` are the
    scripted lines appended when the model's reply misses the markers.  ``{decision_maker}``
    is filled per persona (an escaped literal inside a marker).
    """

    id: str
    kind: str
    reason: str | None
    brief: str
    markers: tuple[tuple[str, ...], ...]
    variants: tuple[str, ...]


N_TIMING = "N-TIMING"
N_MONEY = "N-MONEY"
N_DECISION_MAKER = "N-DM"
N_QUESTION = "N-QUESTION"
N_EMAIL = "N-EMAIL"

SPECS: tuple[NegotiationSpec, ...] = (
    NegotiationSpec(
        N_TIMING,
        KIND_STALL,
        REASON_TIMING,
        "you are not ready to decide today and would rather take your time than rush into a "
        "call or a start date",
        (
            (
                r"\bdecid\w*",
                r"\bready\b",
                r"\brush\w*",
                r"\bhurry\w*",
                r"\bthink(?:ing)? (?:about|it|this|that|over)\b",
                r"\btime\b",
                r"\bwait\w*",
                r"\bsleep on\b",
                r"\bmull\b",
                r"\bconsider\w*",
                r"\bsoon\b",
            ),
            (
                r"\btoday\b",
                r"\byet\b",
                r"\bright now\b",
                r"\bcohort\b",
                r"\bbatch\b",
                r"\blater\b",
                r"\bnext\b",
                r"\bmore time\b",
                r"\bsome time\b",
                r"\bfew days\b",
                r"\bweek\b",
                r"\btoo fast\b",
                r"\bso fast\b",
                r"\bquickly\b",
                r"\brush\w*",
                r"\bhurry\w*",
            ),
        ),
        (
            "I'm not ready to decide today, to be honest. I'd rather not rush into this.",
            "That feels like a lot too fast. I need some more time before I decide anything.",
            "I don't want to rush into it, so let me take some time to think it over.",
        ),
    ),
    NegotiationSpec(
        N_MONEY,
        KIND_STALL,
        REASON_MONEY,
        "you are still worried about the cost and would need to see how you could manage the "
        "payment before you agree to anything",
        (
            (
                r"\bmoney\b",
                r"\bcost\w*",
                r"\bafford\w*",
                r"\bexpensive\b",
                r"\bbudget\b",
                r"\bpayments?\b",
                r"\bpay(?:ing)?\b",
                r"\bspend\w*",
                r"\bstretch\b",
                r"\binvest\w*",
                r"\bprice\b",
                r"\bfees?\b",
            ),
        ),
        (
            "Honestly, the cost is still weighing on me. I'd need to work out how I could "
            "manage the payment.",
            "It's a lot of money to commit, so I'm not sure about the payment side yet.",
            "I'm still worried about the cost, and I'd have to see how I could afford it.",
        ),
    ),
    NegotiationSpec(
        N_DECISION_MAKER,
        KIND_STALL,
        REASON_DECISION_MAKER,
        "you would want to talk it over with your {decision_maker} before you agree to anything",
        (
            (r"\b{decision_maker}\b",),
            (
                r"\btalk\w*",
                r"\bdiscuss\w*",
                r"\bcheck\w*",
                r"\bask\w*",
                r"\brun (?:it|this|that) by\b",
                r"\bspeak\b",
                r"\bconsult\w*",
                r"\btell\b",
                r"\bshow\b",
                r"\bmention\b",
                r"\bchat\b",
                r"\btogether\b",
            ),
        ),
        (
            "I'd really like to talk this over with my {decision_maker} before I agree to "
            "anything.",
            "Let me run it by my {decision_maker} first, since we decide these things together.",
            "I should check with my {decision_maker} before I say yes to a plan.",
        ),
    ),
    NegotiationSpec(
        N_QUESTION,
        KIND_QUESTION,
        None,
        "you ask the advisor what the next step or the call would actually involve, before "
        "you agree to anything",
        (
            (r"\bwhat\b", r"\bhow\b", r"\bwhich\b", r"\bwhy\b"),
            (
                r"\bcall\b",
                r"\bnext steps?\b",
                r"\binvolve\w*",
                r"\bcover\w*",
                r"\bdiscuss\w*",
                r"\bhappen\w*",
                r"\bexpect\w*",
            ),
        ),
        (
            "What exactly would that call involve? I'd like to know before I agree to anything.",
            "Before I agree to anything, what would the next step actually be?",
            "What would we cover on that call, and how long would it take?",
        ),
    ),
    NegotiationSpec(
        N_EMAIL,
        KIND_EMAIL,
        None,
        "you say yes to the advisor sending an e-mail with the details, and you ask what the "
        "e-mail will include",
        (
            (r"\be-?mail\w*", r"\bmail\b", r"\bsend\b", r"\bdetails\b"),
            (
                r"\bwhat\b",
                r"\binclude\w*",
                r"\bcover\w*",
                r"\bcontain\w*",
                r"\bin it\b",
            ),
        ),
        (
            "Sure, you can email me. What will the email include?",
            "Okay, an email works for me. What will be in it, exactly?",
            "Yes, please send it over. What are you going to put in it?",
        ),
    ),
)
SPEC_BY_ID = {spec.id: spec for spec in SPECS}
SPEC_BY_REASON = {spec.reason: spec for spec in SPECS if spec.reason is not None}

# The reaction before the scripted WEAK line at 13:00 (the line itself stays scripted and masked).
COMMIT_REACTION_BRIEF = (
    "react to what the advisor just said in one short, friendly sentence, and say nothing about "
    "thinking it over, e-mail or getting back to them, because the closing line follows "
    "separately"
)


@dataclass(frozen=True)
class CounterSituation:
    """How the learner pushes once more on price, given what the advisor answered."""

    id: str
    brief: str
    variants: tuple[str, ...]


COUNTERS: tuple[CounterSituation, ...] = (
    CounterSituation(
        SITUATION_SHORT,
        "the advisor came down a little but the number is still a stretch for you, so you ask "
        "whether they can go a bit lower; you do not accept it",
        (
            "That's better, but it's still a stretch for me. Can you go a little lower?",
            "Okay, that helps a bit, but could you do a little better than that?",
            "I appreciate that, but it's still a lot for me. Is there any more room on the "
            "price?",
        ),
    ),
    CounterSituation(
        SITUATION_MET,
        "the advisor says they can meet the price you asked for; you sound relieved but ask "
        "whether that is really the final price, and you do not accept it yet",
        (
            "Oh, that would help a lot. Is that the final price, then?",
            "Okay, that is closer to what I hoped. Is that the best you can do?",
            "Thank you, that's better. Is that your final price?",
        ),
    ),
    CounterSituation(
        SITUATION_REFUSED,
        "the advisor says the price cannot move; you ask, politely, whether there is anything "
        "at all they can do, for example a payment plan",
        (
            "Is there really nothing you can do? Even a payment plan would help.",
            "I understand, but is there anything at all that could make it easier, like a "
            "payment plan?",
            "That's tough for me. Is there no flexibility at all on the price?",
        ),
    ),
    CounterSituation(
        SITUATION_UNCLEAR,
        "the advisor's answer on price was not clear, so you ask what the final price would "
        "actually be",
        (
            "So what would the final price be, exactly?",
            "Sorry, so what's the final number you can do for me?",
            "Okay, so what would be the final price after all that?",
        ),
    ),
)
COUNTER_BY_SITUATION = {item.id: item for item in COUNTERS}


@dataclass(frozen=True)
class AnchorSituation:
    """The F1 anchor ("$9,000 is a lot, I heard $7,000") when a price is already on the table.

    In the rehearsal sweep the advisor offered "$2,000 off, so $7,000" at 0:10 and "$2,500 off"
    at 1:05, and the learner still anchored with "I heard people got it for around $7,000".  The
    anchor keeps its exact figures but reacts to the number the advisor already gave.
    """

    id: str
    brief: str
    must_say: tuple[str, ...]
    variants: tuple[str, ...]


ANCHOR_ABOVE = "above"
ANCHOR_REACHED = "reached"


def _usd(amount: int) -> str:
    return f"${int(amount):,}"


def anchor_after_offer(offer_usd: int) -> AnchorSituation:
    """The anchor that reacts to ``offer_usd``, the best price already on the table."""
    amount = _usd(offer_usd)
    if offer_usd > ANCHOR_USD:
        return AnchorSituation(
            ANCHOR_ABOVE,
            f"the advisor has already come down to {amount}; you say that is still a lot for "
            "you, that you heard people got it for around $7,000, and you ask if the advisor "
            "can do that",
            (amount, "$7,000"),
            (
                f"{amount} is still a lot for me, and I heard people got it for around $7,000. "
                "Can you do that?",
                f"Honestly {amount} is still a stretch, and I read some people paid about "
                "$7,000. Is that possible?",
                f"Okay, but {amount} is still a big number for me, and I heard it went for "
                "around $7,000. Can you match that?",
            ),
        )
    relation = (
        "the very price you heard people got it for"
        if offer_usd == ANCHOR_USD
        else "below the $7,000 you heard people got it for"
    )
    return AnchorSituation(
        ANCHOR_REACHED,
        f"the advisor has already put {amount} on the table, {relation}; you sound pleased and "
        "ask whether that really is the final price",
        tuple(dict.fromkeys((amount, "$7,000"))),
        (
            "That's close to the $7,000 I heard people got it for. Is that really the final "
            "price?",
            "Oh, that's in line with the $7,000 I heard about. Is that the best price, then?",
            "I heard people got it for around $7,000, so that sounds about right. Is that your "
            "final price?",
        ),
    )


def fill_decision_maker(text: str, decision_maker: str, *, regex: bool = False) -> str:
    """``text`` with ``{decision_maker}`` filled (escaped when it goes into a regex)."""
    value = re.escape(decision_maker) if regex else decision_maker
    return text.replace("{decision_maker}", value)


def filled_markers(
    markers: tuple[tuple[str, ...], ...], decision_maker: str
) -> tuple[tuple[str, ...], ...]:
    """Marker groups with the persona's decision maker put into the regexes."""
    return tuple(
        tuple(fill_decision_maker(pattern, decision_maker, regex=True) for pattern in group)
        for group in markers
    )


# ----------------------------------------------------------------------------------
# Time slots: "tomorrow ... maybe like 10:00 a.m." becomes a normalised slot.
# ----------------------------------------------------------------------------------
_WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_WEEKEND_DAYS = frozenset({"saturday", "sunday", "this weekend", "the weekend", "weekend"})
_DAY = re.compile(
    r"\b(tomorrow|tonight|today|" + "|".join(_WEEKDAYS) + r"|this weekend|the weekend|weekend"
    r"|next week)\b",
    re.IGNORECASE,
)
_CLOCK = re.compile(r"\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s?m\b", re.IGNORECASE)
_HOUR_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
}
_CLOCK_WORD = re.compile(
    r"\b(" + "|".join(_HOUR_WORDS) + r")\s*(?:o'?clock\s*)?([ap])\.?\s?m\b", re.IGNORECASE
)
_PART = re.compile(r"\b(morning|afternoon|evening|night|noon)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Slot:
    """A call time the advisor proposed, normalised (day word, 24-hour clock, part of day)."""

    day: str | None
    hour: int | None
    minute: int
    part: str | None

    @property
    def evening(self) -> bool:
        late = self.hour is not None and self.hour >= 17
        return late or self.part in ("evening", "night") or self.day == "tonight"

    @property
    def weekend(self) -> bool:
        return self.day in _WEEKEND_DAYS


@dataclass(frozen=True)
class SlotChoice:
    """The slot the learner books: its phrase, and whether it moved the advisor's proposal."""

    phrase: str
    moved: bool


def _hour24(hour: int, meridiem: str) -> int | None:
    if not 0 <= hour <= 23:
        return None
    if hour > 12:
        return hour
    base = hour % 12
    return base + (12 if meridiem.lower() == "p" else 0)


def parse_slot(*texts: object) -> Slot | None:
    """The first day, clock time and part of day found in ``texts``, or None if there is none.

    Each component is taken from the first text that has it, so a caller passes the nearest
    text first ("tomorrow? maybe like 10:00 a.m." before an unrelated "today" earlier on).
    """
    folded = [_tail(text).lower() for text in texts]
    day: str | None = None
    part: str | None = None
    hour: int | None = None
    minute = 0
    for text in folded:
        if day is None:
            day_match = _DAY.search(text)
            day = day_match.group(1).lower() if day_match else None
        if part is None:
            part_match = _PART.search(text)
            part = part_match.group(1).lower() if part_match else None
        if hour is None:
            clock = _CLOCK.search(text)
            if clock is not None:
                hour = _hour24(int(clock.group(1)), clock.group(3))
                minute = int(clock.group(2) or 0)
                if not 0 <= minute <= 59:
                    minute = 0
            else:
                spoken = _CLOCK_WORD.search(text)
                if spoken is not None:
                    hour = _hour24(_HOUR_WORDS[spoken.group(1).lower()], spoken.group(2))
    if day is None and hour is None and part is None:
        return None
    return Slot(day, hour, minute, part)


def _clock_text(slot: Slot) -> str:
    hour = 0 if slot.hour is None else slot.hour
    suffix = "AM" if hour < 12 else "PM"
    shown = hour % 12 or 12
    return f"{shown} {suffix}" if slot.minute == 0 else f"{shown}:{slot.minute:02d} {suffix}"


def _day_text(day: str | None) -> str:
    if day is None:
        return ""
    if day in ("tomorrow", "tonight", "today", "next week"):
        return day
    if day in _WEEKEND_DAYS and day not in _WEEKDAYS:
        return "this weekend"
    return "on " + day.capitalize()


def choose_slot(slot: Slot | None) -> SlotChoice:
    """The slot of the MEDIUM line.

    The advisor's own proposal when it is an evening or a weekend; otherwise the learner's
    preferred 7 PM (``moved`` is True when it replaced a daytime weekday proposal).  Nothing
    usable means the legacy default slot.
    """
    if slot is None:
        return SlotChoice(DEFAULT_SLOT, False)
    day = _day_text(slot.day)
    if slot.hour is None and slot.part is None:
        if slot.weekend or slot.evening:
            return SlotChoice(day, False)  # a weekend day, or "tonight"
        return SlotChoice(f"{day or MOVED_DAY} at {PREFERRED_TIME}", False)
    if slot.weekend or slot.evening:
        time = ""
        if slot.hour is not None:
            time = "at " + _clock_text(slot)
        elif slot.part in ("evening", "night"):
            time = "in the evening"
        phrase = " ".join(part for part in (day, time) if part)
        return SlotChoice(phrase or DEFAULT_SLOT, False)
    return SlotChoice(f"{day or MOVED_DAY} at {PREFERRED_TIME}", True)


# ----------------------------------------------------------------------------------
# Detectors on the advisor's text.
# ----------------------------------------------------------------------------------
_DAY_WORDS = (
    r"(?:tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"next week|this week|the weekend|this weekend|weekend)"
)
# "call you on/at/in/next/this ..." is a callback only when a day, a clock time or a part of the
# day follows ("call you at 7 pm", "call you on Monday"); "reach you on the next session" is a
# pitch about the programme, not a proposal (R1-Q round 1, review 2).
_WHEN_WORD = (
    r"(?:tomorrow|tonight|today|later|next week|this week|the weekend|this weekend|weekend|"
    r"(?:on|at|this|next|in|around|by|after|before)\s+(?:the\s+)?(?:monday|tuesday|wednesday|"
    r"thursday|friday|saturday|sunday|tomorrow|tonight|today|\d|noon|midnight|morning|afternoon|"
    r"evening|night|(?:a )?(?:few|couple)|one|two|three|four|five|six|seven|eight|nine|ten))"
)
_CALLBACK = _compile(
    r"\bcall(?:ing)? (?:you |me )?back\b",
    r"\b(?:call|ring|phone|ping|text) (?:you|me) (?:back |again )?" + _WHEN_WORD + r"\b",
    r"\bwhen (?:you|i|we) (?:call|ring|phone) (?:me|you)\b",
    r"\b(?:schedul\w*|set up|book|arrange|fix|plan|organi[sz]e|pencil in)\b[^.?!]{0,30}\b"
    r"(?:call|chat|meeting|session|follow[- ]?up|catch[- ]?up|conversation|time|slot)\b",
    r"\b(?:follow[- ]?up|second|another|next|quick) (?:call|chat|meeting|conversation)\b",
    r"\b(?:talk|speak|connect|chat|catch up|meet)\b(?: again| to you| with you)? "
    r"(?:on |this |next |later )?" + _DAY_WORDS + r"\b",
    r"\bwhat (?:time|day)s? (?:works?|suits?|is good|is best|would work)\b",
    r"\bwhen (?:can|could|shall|should|would) (?:i|we) (?:call|talk|speak|connect|catch up)\b",
    r"\bwhen (?:will|can|could|would) (?:you|i) (?:get|come|be) back\b",
    r"\bwhen (?:can|will|should) i expect\b",
    r"\bget back to (?:me|us)\b",
)
# An e-mail OFFER is a first-person promise to send information: "I'll email you the details",
# "let me send you the brochure", "I will mail that once we finish".  A pitch about what the
# programme sends ("we send you the recordings after every class", "we will send you a
# certificate", "the platform will send you an email reminder") is not one (R1-Q round 1,
# review 2): the subject must be I / we / let me with a modal, and the object must be
# information or a pronoun followed by a "when" cue.
_OFFER_SUBJECT = (
    r"(?:(?:i|we)(?:'ll|'d|'m going to| am going to| are going to| will| can| could| shall|"
    r" would)|let me|let us|let'?s)"
)
_MAIL_VERB = r"(?:e-?mail|mail|send)"
_MAIL_INFO = (
    r"(?:details|brochure|curriculum|syllabus|information|info|summary|link|everything|"
    r"overview|outline|breakdown|pricing|fee structure|proposal|document|pdf|schedule|"
    r"timetable|payment details)"
)
_EMAIL_OFFER = _compile(
    r"\b" + _OFFER_SUBJECT + r"\s+(?:also |then |just |happily |gladly |definitely |actually )?"
    + _MAIL_VERB + r"\b[^.?!]{0,30}\b" + _MAIL_INFO + r"\b",
    r"\b" + _OFFER_SUBJECT + r"\s+(?:also |then |just )?(?:send|shoot|drop|mail|e-?mail) "
    r"(?:you |me )?(?:an? )?(?:e-?mail|mail|message)\b"
    r"(?!\s+(?:reminders?|notifications?|updates?|alerts?|newsletters?|receipts?|"
    r"confirmations?|invites?)\b)",
    r"\b" + _OFFER_SUBJECT + r"\s+(?:also |then |just )?" + _MAIL_VERB + r" "
    r"(?:it|that|this|them|everything)\b[^.?!]{0,15}\b(?:over|across|once|after|later|today|"
    r"tonight|shortly|right now|right away|when|as soon)\b",
)
_RECURRING = re.compile(
    r"\b(?:every|each) (?:class|week|session|day|month|module|lecture|friday|monday|saturday|"
    r"sunday)\b",
    re.IGNORECASE,
)
_CHECKIN = _compile(
    r"\bwhat do you think(?: about (?:that|this|it|all (?:of )?(?:this|that)))?(?: so far)?"
    r"[\s?.!]*$",
    r"\bwhat are your (?:thoughts|views)(?: on (?:that|this|it))?[\s?.!]*$",
    r"\bhow (?:does|do) (?:that|this|it|all (?:of )?that) (?:sound|feel|look)"
    r"(?: to you)?[\s?.!]*$",
    r"\b(?:does|do|did) (?:that|this|it) (?:make sense|sound (?:good|fair|okay|ok|"
    r"reasonable|right)|work for you)[\s?.!]*$",
    r"\bis (?:it|that|this) (?:fine|ok|okay|alright|good|fair) (?:with|for) you\b",
    r"\bare you (?:ok|okay|fine|alright|comfortable) with (?:that|this|it)\b",
    r"\bhow do you feel\b",
    r"\bwould that work\b",
)
# These only count in a question: "Anything else you wanted to know?" and "Do you have any
# questions?" check in, but "you can ask any questions you want" does not.
_CHECKIN_ASKED = _compile(
    r"\banything else\b",
    r"\b(?:do you have|have you got|are there|is there|got) any (?:other |more |further )?"
    r"(?:questions|doubts|concerns)\b",
    r"^(?:and |so |okay |ok )?any (?:other |more |further )?(?:questions|doubts|concerns)\b",
)
_HANDLED_TIMING = _compile(
    r"\b(?:next|upcoming|coming) (?:cohort|batch)\b",
    r"\bcohorts? (?:start|starts|begin|begins|is starting|are starting)\b",
    r"\bstart dates?\b",
    r"\b(?:flexib\w+|self[- ]paced|at your own pace|recordings?|recorded)\b",
    r"\bno (?:rush|hurry|pressure)\b",
    r"\btake your time\b",
    r"\b(?:weekend|evening) batch\b",
)
_HANDLED_MONEY = _compile(
    r"\binstal+ments?\b",
    r"\bemi\b",
    r"\bpayment plans?\b",
    r"\bmonthly (?:payments?|plans?|instal+ments?)\b",
    r"\bfinanc(?:e|ing)\b",
    r"\bpay (?:over|in parts|in instal+ments|monthly)\b",
    r"\bsplit (?:the |your )?payments?\b",
    r"\$\s?\d[\d,]*\s*(?:off|discount)\b",
    r"\bdiscounts?\b",
)
_DM_WORDS = r"(?:husband|wife|partner|father|mother|dad|mom|spouse|parents|family)"
_HANDLED_DM_VERB = (
    r"(?:talk|speak|chat|discuss|include|involve|loop|bring|invite|join|add|explain|walk|meet|"
    r"connect|call)"
)
_PRICE_TALK = re.compile(
    r"\b(?:price|cost|fees?|discount\w*|lower|reduc\w+|less|cheaper|deal|negotiat\w+|7k|"
    r"7,?000|that low|that much)\b|\$\s?\d",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Callback:
    """The advisor proposed (or asked about) a call back, with the slot if one was named."""

    slot: Slot | None


def detect_callback(text: object) -> Callback | None:
    """A callback, follow-up call or time proposal in the advisor's ``text``.

    The slot is read from the sentence that proposes it and its neighbours ("Can we call back
    tomorrow? Maybe like 10:00 a.m."), so an unrelated "today" elsewhere in a long turn is
    not mistaken for the day.
    """
    sentences = split_sentences(_tail(text).lower())
    for index, sentence in enumerate(sentences):
        if any(pattern.search(sentence) for pattern in _CALLBACK):
            # The proposing sentence first, then the one after it, then the one before it.
            after = sentences[index + 1 : index + 2]
            before = sentences[max(0, index - 1) : index]
            near = [sentence, *after, *before]
            return Callback(parse_slot(*near))
    return None


def detect_email_offer(text: object) -> bool:
    """The advisor offers to e-mail or send the details."""
    folded = _tail(text).lower()
    return any(
        pattern.search(sentence)
        for sentence in split_sentences(folded)
        if _RECURRING.search(sentence) is None
        for pattern in _EMAIL_OFFER
    )


def detect_checkin(text: object) -> bool:
    """The advisor checks in ("what do you think?", "anything else?", "is that fine?")."""
    for sentence in split_sentences(_tail(text).lower()):
        if any(pattern.search(sentence) for pattern in _CHECKIN):
            return True
        if is_question_like(sentence) and any(
            pattern.search(sentence) for pattern in _CHECKIN_ASKED
        ):
            return True
    return False


def reasons_handled_in(text: object, decision_maker: str = "") -> frozenset[str]:
    """The stall reasons the advisor's ``text`` speaks to (it must still follow the reason)."""
    folded = _tail(text).lower()
    found: set[str] = set()
    own = re.escape(decision_maker.lower()) + "|" if decision_maker else ""
    dm_pattern = re.compile(r"\b(?:" + own + _DM_WORDS + r")\b")
    verb_pattern = re.compile(r"\b" + _HANDLED_DM_VERB + r"\w*\b")
    for sentence in split_sentences(folded):
        if any(pattern.search(sentence) for pattern in _HANDLED_TIMING):
            found.add(REASON_TIMING)
        for pattern in _HANDLED_MONEY:
            match = pattern.search(sentence)
            if match is not None and not negated_before(sentence, match.start()):
                found.add(REASON_MONEY)
        if dm_pattern.search(sentence) and verb_pattern.search(sentence):
            found.add(REASON_DECISION_MAKER)
    return frozenset(found)


# ----------------------------------------------------------------------------------
# Price offers: "$8,500", "8500", "8.5" and "$500 off" become net prices on the table.
# ----------------------------------------------------------------------------------
_DOLLARS = re.compile(r"\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?", re.IGNORECASE)
_PERCENT_OFF = re.compile(
    r"(\d{1,2}(?:\.\d+)?)\s?(?:%|per ?cent|percent)\s*(?:off|discount)\b", re.IGNORECASE
)
# A bare number is not a price when a unit follows it ("6.5 months", "6000 students").
_NOT_UNIT = (
    r"(?!\s*(?:months?|weeks?|hours?|days?|years?|minutes?|%|percent|students|learners|"
    r"people|alumni|members|times|x\b|a\.?m\b|p\.?m\b))"
)
_BARE_THOUSANDS = re.compile(
    r"(?<![\d$.,])(\d{1,2}(?:\.\d{1,2})?)\s*(?:k|thousand|grand)\b" + _NOT_UNIT, re.IGNORECASE
)
_BARE_DECIMAL = re.compile(
    r"(?<![\d$.,:])(\d{1,2}\.\d{1,2})(?![\d:])" + _NOT_UNIT, re.IGNORECASE
)
_BARE_WHOLE = re.compile(r"(?<![\d$.,])(\d{1,2},?\d{3})(?![\d])" + _NOT_UNIT, re.IGNORECASE)
_OFF_AFTER = re.compile(r"^\s*(?:off|discount|less|reduction)\b", re.IGNORECASE)
_DISCOUNT_BEFORE = re.compile(
    r"\bdiscounts?\s+(?:of|worth|up to|around|about)?\s*$", re.IGNORECASE
)
_PRICE_CUE = re.compile(
    r"\b(?:deal|price|cost|fee|make it|let'?s (?:make|do|say|go|settle|keep)|lets (?:make|do|"
    r"say|go)|come down|bring (?:it|that|the|this)|go (?:down )?to|settle|special|final|offer|"
    r"discount|for you|meet)\b",
    re.IGNORECASE,
)
_ASK_ECHO = re.compile(
    r"\byou(?:'re| are)? (?:asking|looking|hoping|wanting|requesting|expecting|saying|"
    r"saying you need)|asking for|looking for|you (?:want|wanted|asked|mentioned|said|heard|"
    r"need|needed|were told)|you(?:'d| would) like|you(?:'ve| have) heard|heard (?:of|that|"
    r"about)|people (?:got|paid|get)\b",
    re.IGNORECASE,
)
_OFFER_CUE = re.compile(
    r"\b(?:let'?s|lets|make|bring|take|get|come|go|settle|close|keep|do|offer|give|can|could|"
    r"will|special|final|best|meet|split|put|say)\b",
    re.IGNORECASE,
)
_CONDITIONAL = re.compile(
    r"\b(?:if|when|provided|as long as|in exchange|upfront|in full|lump ?sum|early|deadline|"
    r"today|this (?:week|month)|enrol+\w* (?:today|by|before))\b",
    re.IGNORECASE,
)


# The advisor questioning or refusing a figure is not offering it (R1-Q round 1): "Where did you
# hear that $7,000?  That's not something we offer", "$7,000 is too low for us", "Sorry, $7,000 is
# impossible", "Who told you $7,000?  That was an old promo".
_PRICE_NO = re.compile(
    r"\b(?:impossible|too (?:low|much|little|less)|not (?:correct|realistic|true|right|valid|"
    r"accurate|available)|old promo\w*|needs? (?:to get )?(?:an? )?approval|(?:we|i) don'?t do|"
    r"don'?t think (?:we|i) can|no longer|expired|never (?:offered|promised))\b",
    re.IGNORECASE,
)
# A figure the LEARNER said (the $7,000 anchor, or any amount it spoke) is only an offer when
# the advisor's own clause promises it: "I can do $7,000", "let's make it 7000", "7000 then".
_FIRST_PERSON_OFFER = re.compile(
    r"\b(?:i|we)(?:'ll|'d|'m (?:able|happy|willing|going) to| am (?:able|happy|willing|going) "
    r"to| are (?:able|happy|willing|going) to| will| can| could| would| shall)\s+"
    r"(?:\w+\s+){0,3}?(?:do|make|give|offer|get|bring|take|go|settle|meet|match|put|approve|"
    r"extend|arrange|keep|say|cut|knock|drop|reduce|lower|close|come)\b"
    r"|\blet'?s (?:\w+\s+){0,2}?(?:make|do|say|go|settle|keep|call|close|meet)\b"
    r"|\bhow about\b|\bwhat if (?:i|we)\b|\bmake it\b",
    re.IGNORECASE,
)
_ACCEPTING_AFTER = re.compile(
    r"^\s*(?:then|it is|it'?s (?:a deal|done|yours)|for you|works|deal|"
    r"is (?:fine|okay|ok|good|doable|possible|done|a deal|acceptable|alright))\b",
    re.IGNORECASE,
)
# A question can still carry an offer.  "How about $8,000?", "What if I do $8,000?", "Can I do
# $8,000 for you?" are offers whatever the question word; "Would $8,500 work for you?" and "I can
# do $8,000, okay?" are offers too, but a wh-question ("Who told you we could do $7,000?", "Where
# did you hear $7,000 would work?") is the advisor asking about a figure, not making it.
_OFFER_VERB = (
    r"(?:do|offer|give|make|bring|take|go|settle|meet|match|put|knock|cut|drop|reduce|lower)"
)
_QUESTION_OFFER_ALWAYS = re.compile(
    r"\b(?:how|what) about\b|\bwhat if (?:i|we)\b|\b(?:want|like) me to\b[^?]{0,20}\b"
    + _OFFER_VERB + r"\b|\b(?:shall|can|could|may) (?:i|we) (?:\w+ ){0,2}?" + _OFFER_VERB + r"\b",
    re.IGNORECASE,
)
_QUESTION_OFFER_PLAIN = re.compile(
    r"\b(?:would|will|does|do|is|are)\b[^?]{0,25}\b(?:work|fine|ok|okay|alright|acceptable|"
    r"good|comfortable|suit\w*)\b",
    re.IGNORECASE,
)
_WH_START = re.compile(
    r"^\W*(?:(?:and|so|but|um|uh|well|okay|ok|now|then)\W+)*(?:who|whom|whose|where|why|what|"
    r"which|when|how)\b(?!\s+about\b)",
    re.IGNORECASE,
)


def _question_is_an_offer(lowered: str) -> bool:
    """A question sentence phrased as an offer (see the frames above)."""
    if _QUESTION_OFFER_ALWAYS.search(lowered) is not None:
        return True
    if _WH_START.match(lowered) is not None:
        return False
    return (
        _QUESTION_OFFER_PLAIN.search(lowered) is not None
        or _FIRST_PERSON_OFFER.search(lowered) is not None
    )


def _promised(lowered: str, start: int, end: int) -> bool:
    """The advisor's own clause promises the amount at ``start:end`` ("I can do $7,000")."""
    return bool(
        _FIRST_PERSON_OFFER.search(clause_before(lowered, start))
        or _ACCEPTING_AFTER.search(clause_after(lowered, end))
    )


def _offered(lowered: str, start: int, end: int, *, learner_said: bool = False) -> bool:
    """False when the amount at ``start:end`` is the learner's ask echoed, negated or refused.

    ``learner_said`` marks a figure the learner itself spoke (the $7,000 anchor or any amount it
    said): the advisor repeating it is an offer only when the same clause promises it.
    """
    before = clause_before(lowered, start)
    cue = _OFFER_CUE.search(before) is not None
    if _ASK_ECHO.search(before) and not cue:
        return False
    if negated_before(lowered, start, 8):
        return False
    after = clause_after(lowered, end)
    if (has_refusal(after) or _PRICE_NO.search(after)) and not cue:
        return False
    return not learner_said or _promised(lowered, start, end)


# A sentence is read in pieces of at most this many characters: speech-to-text may run a whole
# monologue together, and the amount grammar must stay fast on any input.
PIECE_CHARS = 400


def _pieces(sentence: str) -> list[str]:
    """``sentence`` cut at word boundaries into pieces of at most ``PIECE_CHARS``."""
    if len(sentence) <= PIECE_CHARS:
        return [sentence]
    pieces: list[str] = []
    current = ""
    for word in sentence.split():
        word = word[:PIECE_CHARS]
        if current and len(current) + 1 + len(word) > PIECE_CHARS:
            pieces.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        pieces.append(current)
    return pieces


def _piece_offers(piece: str, own: frozenset[int] = frozenset()) -> dict[int, bool]:
    """Net prices (and whether each is conditional) offered in one piece of a sentence.

    ``own`` are the figures the learner said (the anchor among them): the advisor repeating
    one is an offer only with a promise in the same clause.  A question offers nothing unless
    it is phrased as an offer ("How about $8,000?", "Would $8,500 work for you?").
    """
    lowered = canonical_amounts(piece).lower()
    # A question phrased as an offer promises the figure itself, so it needs no further promise.
    asked_as_offer = False
    if is_question_like(piece):
        asked_as_offer = _question_is_an_offer(lowered)
        if not asked_as_offer:
            return {}
    conditional = _CONDITIONAL.search(lowered) is not None
    found: dict[int, bool] = {}
    discounts: set[int] = set()
    small: set[int] = set()
    for match in _DOLLARS.finditer(lowered):
        value = parse_amount(match.group(1), bool(match.group(2)))
        if value is None or not _offered(
            lowered,
            match.start(),
            match.end(),
            learner_said=value in own and not asked_as_offer,
        ):
            continue
        as_discount = _OFF_AFTER.match(lowered[match.end() :]) is not None
        if _DISCOUNT_BEFORE.search(lowered[: match.start()]) is not None:
            as_discount = True
        if 0 < value < MIN_NET_USD:
            small.add(value)
            if as_discount:
                discounts.add(value)
        elif MIN_NET_USD <= value < PRICE_USD:
            found[value] = conditional
    for match in _PERCENT_OFF.finditer(lowered):
        if _offered(lowered, match.start(), match.end()):
            discounts.add(int(round(PRICE_USD * float(match.group(1)) / 100)))
    # Several small amounts in one sentence are a LIST of the deck's discounts, not an offer.
    if len(discounts) == 1 and small <= discounts:
        found[PRICE_USD - next(iter(discounts))] = conditional
    if _PRICE_CUE.search(lowered):
        for pattern in (_BARE_THOUSANDS, _BARE_DECIMAL):
            for match in pattern.finditer(lowered):
                value = int(round(float(match.group(1)) * 1000))
                if MIN_NET_USD <= value < PRICE_USD and _offered(
                    lowered,
                    match.start(),
                    match.end(),
                    learner_said=value in own and not asked_as_offer,
                ):
                    found[value] = conditional
        for match in _BARE_WHOLE.finditer(lowered):
            value = parse_amount(match.group(1))
            if (
                value is not None
                and MIN_NET_USD <= value < PRICE_USD
                and _offered(
                    lowered,
                    match.start(),
                    match.end(),
                    learner_said=value in own and not asked_as_offer,
                )
            ):
                found[value] = conditional
    return found


def parse_price_offers(
    text: object, own_amounts: Iterable[int] = ()
) -> list[tuple[int, bool]]:
    """Net prices the advisor put on the table, as ``(net_usd, conditional)`` pairs.

    Reads "$8,500", "8500", "8.5", "8.5k" (a bare number only next to a price cue) and
    "$500 off" / "10% off" (converted to the price they leave).  The learner's own ask
    echoed back ("you want the deal at 7000"), a refused or questioned figure ("$7,000 is too
    low for us", "Who told you $7,000?") and a LIST of deck discounts ("discounts of $500,
    $1000 and $1500") are not offers.  The $7,000 anchor, and every figure in ``own_amounts``
    (what the learner said), counts only when the advisor promises it ("I can do $7,000").
    """
    own = frozenset({ANCHOR_USD, *own_amounts})
    offers: dict[int, bool] = {}
    for sentence in split_sentences(_tail(text)):
        for piece in _pieces(sentence):
            offers.update(_piece_offers(piece, own))
    return sorted(offers.items(), reverse=True)


def refuses_price(text: object) -> bool:
    """The advisor refuses to move the price ("we can't go lower", "the price is fixed")."""
    return any(
        has_refusal(sentence) and _PRICE_TALK.search(sentence) is not None
        for sentence in split_sentences(_tail(text).lower())
    )


# ----------------------------------------------------------------------------------
# The state.
# ----------------------------------------------------------------------------------
@dataclass(frozen=True)
class PriceOffer:
    turn: int
    net_usd: int
    conditional: bool


@dataclass(frozen=True)
class NegotiationTurn:
    """What one advisor turn put on the table (no text is kept)."""

    turn: int
    callback: Callback | None
    email_offer: bool
    checkin: bool
    offers: tuple[PriceOffer, ...]
    refusal: bool
    reasons_handled: frozenset[str]
    # True when the turn put a price on the table that the learner's anchor has already been
    # delivered against, whether that price is new or a restatement of an earlier one.
    answered_price: bool = False

    @property
    def offer_added(self) -> bool:
        """A price that was not on the table before (this session) was offered this turn."""
        return bool(self.offers)

    @property
    def price_answer(self) -> bool:
        """The advisor answered the learner's anchor (an offer, a restated offer or a refusal)."""
        return self.answered_price or self.refusal


class Negotiation:
    """Everything the learner remembers about the price, the callbacks and its own reasons."""

    def __init__(self, decision_maker: str) -> None:
        self.decision_maker = decision_maker
        self.offers: list[PriceOffer] = []
        self.refusals = 0
        # True once an advisor turn AFTER the learner's anchor put a price on the table (new or
        # restated); with it the best offer is the answer to the anchor, otherwise a refusal is.
        self.answer_offer = False
        # Whole-dollar figures the learner said: the advisor repeating one is not an offer
        # unless the advisor promises it (``parse_price_offers``).
        self.own_amounts: set[int] = set()
        self.callbacks: list[dict[str, Any]] = []
        self.last_slot: Slot | None = None
        self.email_offers: list[int] = []
        self.email_answered = False
        self.question_used = False
        self.checkins = 0
        self.voiced: dict[str, int] = {}
        # How many times each stall reason was voiced (N-* or the owed F4 move): more than one
        # per reason is the stall loop in different words (R1-Q round 1).
        self.voicings: dict[str, int] = {}
        self.handled: dict[str, int] = {}
        self.stall_rounds = 0
        self.responses: list[dict[str, Any]] = []
        self.weak_line_said = False
        self.level: Level | None = None
        self.resolved = False
        self.commitment_turn: int | None = None
        self.chosen_slot: SlotChoice | None = None

    # ------------------------------------------------------------------ observation
    def observe(
        self, turn: int, text: object, *, anchor_turn: int | None = None
    ) -> NegotiationTurn:
        """Read one advisor turn.  ``anchor_turn`` is the learner turn of the $7,000 ask.

        Prices are tracked from the first mention, not from the anchor: an offer made before
        the learner asked for $7,000 is on the table, so the anchor can react to it and a later
        restatement of it is never "new".  A refusal only answers the anchor, so it counts after
        it.
        """
        callback = detect_callback(text)
        if callback is not None:
            self.callbacks.append({"turn": turn, "has_slot": callback.slot is not None})
            if callback.slot is not None:
                self.last_slot = callback.slot
        email = detect_email_offer(text)
        if email:
            self.email_offers.append(turn)
        checkin = detect_checkin(text)
        if checkin:
            self.checkins += 1
        after_anchor = anchor_turn is not None and turn > anchor_turn
        offers: list[PriceOffer] = []
        refusal = False
        mentioned = False
        for net, conditional in parse_price_offers(text, self.own_amounts):
            mentioned = True
            if all(item.net_usd != net for item in self.offers + offers):
                offers.append(PriceOffer(turn, net, conditional))
        answered_price = after_anchor and mentioned
        if answered_price:
            self.answer_offer = True
        if after_anchor:
            refusal = refuses_price(text)
            if refusal:
                self.refusals += 1
        self.offers.extend(offers)
        newly: set[str] = set()
        for reason in reasons_handled_in(text, self.decision_maker):
            voiced_at = self.voiced.get(reason)
            if voiced_at is not None and voiced_at < turn and reason not in self.handled:
                self.handled[reason] = turn
                newly.add(reason)
        return NegotiationTurn(
            turn=turn,
            callback=callback,
            email_offer=email,
            checkin=checkin,
            offers=tuple(offers),
            refusal=refusal,
            reasons_handled=frozenset(newly),
            answered_price=answered_price,
        )

    def note_learner_text(self, spoken: object) -> None:
        """Remember the figures the learner said, so the advisor repeating one is not an offer."""
        for amount in dollar_amounts(spoken):
            if 0 < amount <= PRICE_USD:
                self.own_amounts.add(amount)

    def note_reason_voiced(self, reason: str, turn: int) -> None:
        """The learner raised ``reason`` (a stall reason intent, or the owed F4 moves)."""
        self.voiced.setdefault(reason, turn)
        self.voicings[reason] = self.voicings.get(reason, 0) + 1

    def note_spoken(self, spec_id: str, spoken: object, turn: int) -> bool:
        """Record that spec ``spec_id`` was raised, if the played text proves it."""
        spec = SPEC_BY_ID.get(spec_id)
        if spec is None:
            return False
        markers = filled_markers(spec.markers, self.decision_maker)
        if not markers_match(markers, spoken):
            return False
        if spec.reason is not None:
            self.note_reason_voiced(spec.reason, turn)
        if spec.kind == KIND_EMAIL:
            self.email_answered = True
        if spec.kind == KIND_QUESTION:
            self.question_used = True
        return True

    def note_commitment(self, level: Level, turn: int) -> None:
        """A scripted commitment line was spoken (the engine calls this once)."""
        if self.level is None:
            self.level = level
            self.commitment_turn = turn
        self.resolved = True
        if level is Level.WEAK:
            self.weak_line_said = True

    def note_response(self, turn: int, response: str) -> None:
        """Log which response the learner gave on ``turn`` (an id, never text)."""
        self.responses.append({"turn": turn, "response": response})

    # -------------------------------------------------------------------- decisions
    @property
    def best_offer_usd(self) -> int | None:
        """The lowest price the advisor has put on the table since the anchor."""
        return min((item.net_usd for item in self.offers), default=None)

    def price_situation(self) -> str:
        """How the advisor answered the anchor: short of the ask, met it, refused, or unclear.

        The best price on the table counts, whenever it was offered; but an advisor who only
        REFUSED after the anchor (an earlier offer is not repeated) has refused.
        """
        best = self.best_offer_usd
        if best is not None and (self.answer_offer or not self.refusals):
            return SITUATION_MET if best <= ANCHOR_USD else SITUATION_SHORT
        if self.refusals:
            return SITUATION_REFUSED
        return SITUATION_UNCLEAR

    def counter_situation(self) -> CounterSituation:
        return COUNTER_BY_SITUATION[self.price_situation()]

    def next_reason(self, skip: Iterable[str] = ()) -> str | None:
        """The first stall reason the learner has not raised yet, in ``REASONS`` order.

        ``skip`` are reasons an owed objection will voice in its own right (the F4 pair owns
        timing and the decision maker): raising them here as well would be the same stall
        twice, back to back.
        """
        skipped = set(skip)
        return next(
            (
                reason
                for reason in REASONS
                if reason not in self.voiced and reason not in skipped
            ),
            None,
        )

    def can_stall(self, skip: Iterable[str] = ()) -> bool:
        """Whether an ask inside the close window may still be met with a reason."""
        return self.stall_rounds < MAX_STALL_ROUNDS and self.next_reason(skip) is not None

    @property
    def reasons_handled_count(self) -> int:
        return len(self.handled)

    def slot_choice(self) -> SlotChoice:
        """The slot of the MEDIUM line for the advisor's latest proposal."""
        self.chosen_slot = choose_slot(self.last_slot)
        return self.chosen_slot

    # ------------------------------------------------------------------------ log
    def log(self) -> dict[str, Any]:
        """Turn indices, integers and ids only (logged, never posted)."""
        return {
            "offers": [
                {"turn": item.turn, "net_usd": item.net_usd, "conditional": item.conditional}
                for item in self.offers
            ],
            "best_offer_usd": self.best_offer_usd,
            "price_situation": self.price_situation(),
            "refusals": self.refusals,
            "callbacks": list(self.callbacks),
            "email_offer_turns": list(self.email_offers),
            "email_answered": self.email_answered,
            "checkins": self.checkins,
            "reasons_voiced": dict(self.voiced),
            "reason_voicings": dict(self.voicings),
            "reasons_handled": dict(self.handled),
            "stall_rounds": self.stall_rounds,
            "responses": list(self.responses),
            "weak_line_said": self.weak_line_said,
            "level": None if self.level is None else self.level.name,
            "commitment_turn": self.commitment_turn,
            "slot": None if self.chosen_slot is None else self.chosen_slot.phrase,
            "slot_moved": None if self.chosen_slot is None else self.chosen_slot.moved,
        }
