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
  the advisor's own clause promises it ("I can do $7,000", "Yes, you can have it for $7,000").  A
  question that names a figure is a proposal of it ("How does $8,500 sound?") unless it asks where
  the figure came from; an income, a competitor's price or what someone else paid is no offer, and
  before the anchor an amount needs a pricing word (R1-Q round 2).
* A pitch about the programme ("you can book a slot with a mentor every week", "we'll send you the
  link to the live class") is neither a callback nor an e-mail offer (``r1_commitment.
  call_proposal_in``, R1-Q round 2 and iteration 1).
* The commitment lines stay scripted and masked (``r1_commitment``); this module only picks the
  slot of the MEDIUM line (the advisor's evening or weekend proposal, else 7 PM) and whether
  the WEAK line was already said.  The WEAK line is said at most once per session.
* Every spoken variant here is ASCII, below the commitment cap, free of concession phrasing
  and of every persona's deep-need markers (the tests check all twelve persona variants).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Any, Iterable

from r1_commitment import (
    DEFAULT_SLOT,
    AskKind,
    Level,
    around,
    ask_acts,
    call_proposal_in,
    describes_programme,
)
from r1_scheduler import has_refusal, is_close_attempt, markers_match
from r1_text import (
    COUNT_NOUN_AFTER,
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
# A net price below MIN_NET_USD counts only in an explicit net-price frame ("I will give it to you
# for $3000", "give the program for 3000"): a bare small figure stays a deck discount.
MIN_FRAMED_NET_USD = 1000
# The highest figure read as the course's stated price (the list price is $9,000).
MAX_LIST_USD = 20000
PREFERRED_TIME = "7 PM"
MOVED_DAY = "tomorrow"
# The learner said it had to talk to its decision maker this recently: a vague "let me know when's
# good" is then answered by booking the call without a slot (``Negotiation.slot_choice``).
DEFER_RECENT_TURNS = 3
# An advisor's slot older than this many learner turns is not the proposal the learner answers.
SLOT_RECENT_TURNS = 6

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
N_EMAIL_YES = "N-EMAIL-YES"

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
            "I'm not ready to decide today. I'd rather not rush into this.",
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
            "The cost is still weighing on me. I'd need to work out how I could "
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
                # The enrolment wording (``question_spec``): what is included, what it signs up for,
                # what the learner would get.  "get" only in the learner's own question ("would I
                # be getting"): "I get what you're saying" or "I'll get back to you" is no question.
                r"\binclud\w*",
                r"\bsign(?:ing|ed)? up\b",
                r"\b(?:would|do|will|could|can|should|am) i (?:actually |really |even |be )*"
                r"get(?:ting)?\b",
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
                # The yes alone proves the move too (R1-Q iteration 3): a model that said "Sure, go
                # ahead and send the email" and lost its question to the question diet was given
                # "Yes, please send it over. What are you going to put in it?" on top.
                r"\bsure\b",
                r"\byes\b",
                r"\bplease\b",
                r"\bgo ahead\b",
                r"\bworks?\b",
                r"\bfine\b",
                r"\bgreat\b",
                r"\bokay\b",
                r"\bthanks?\b",
            ),
        ),
        (
            "Sure, you can email me. What will the email include?",
            "Okay, an email works for me. What will be in it, exactly?",
            "Yes, please send it over. What are you going to put in it?",
        ),
    ),
    NegotiationSpec(
        N_EMAIL_YES,
        KIND_EMAIL,
        None,
        "you say yes to the advisor sending the e-mail; they just told you what is in it, so you "
        "do not ask what it will include",
        (
            (r"\be-?mail\w*", r"\bmail\b", r"\bsend\b", r"\bdetails\b"),
            (
                r"\bsure\b",
                r"\byes\b",
                r"\bplease\b",
                r"\bgo ahead\b",
                r"\bworks?\b",
                r"\bfine\b",
                r"\bgreat\b",
                r"\bokay\b",
                r"\bthanks?\b",
                r"\bhelp\w*",
            ),
        ),
        (
            "Sure, you can email me the details.",
            "Okay, an email works for me.",
            "Yes, please send it over.",
        ),
    ),
)
SPEC_BY_ID = {spec.id: spec for spec in SPECS}
SPEC_BY_REASON = {spec.reason: spec for spec in SPECS if spec.reason is not None}

# The one question about the next step, worded for an enrolment ask ("Let's lock in the deal"):
# no call was proposed, so the learner asks what it would be signing up for (owner test 7f2a25e6
# turn 32 asked "What exactly would that call involve?" about a call nobody had mentioned).  It
# keeps the N-QUESTION id and markers; ``question_spec`` picks the wording by the advisor's ask.
N_QUESTION_ENROL_BRIEF = (
    "you ask the advisor what you would actually be signing up for and what is included, before "
    "you agree to anything"
)
N_QUESTION_ENROL_VARIANTS = (
    "What exactly would I be signing up for? I'd like to know what's included before I agree to "
    "anything.",
    "Before I agree to anything, what's actually included in what I'd be signing up for?",
    "What would I actually get for that, and what does it include?",
)


def question_spec(ask: AskKind | None) -> NegotiationSpec:
    """N-QUESTION worded for ``ask``: "the call" only when the advisor proposed a call."""
    spec = SPEC_BY_ID[N_QUESTION]
    if ask is AskKind.CALL:
        return spec
    return replace(spec, brief=N_QUESTION_ENROL_BRIEF, variants=N_QUESTION_ENROL_VARIANTS)


# The reaction before the scripted WEAK line at 19:00 (the line itself stays scripted and masked).
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
        "the price is above what you hoped, so ask if they can go lower; do not accept it, and "
        "do not call it better unless it just dropped",
        (
            "Okay, thanks, but I was hoping for a bit less. Can you go a little lower?",
            "I appreciate that, but could you do a little better than that?",
            "That helps, but it's still more than I planned for. Is there any more room on "
            "the price?",
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
            f"the advisor has already come down to {amount}; tell the advisor that is still a "
            "lot for you, that you heard people got it for around $7,000, and ask if they can "
            "do that",
            (amount, "$7,000"),
            (
                f"{amount} is still a lot for me, and I heard people got it for around $7,000. "
                "Can you do that?",
                f"{amount} is still more than I planned for, and I read some people paid about "
                "$7,000. Is that possible?",
                f"Okay, but {amount} is still a big number for me, and I heard it went for "
                "around $7,000. Can you match that?",
            ),
        )
    # The price is already at (or below) the ask.  The learner notes calmly that it is in line with
    # what it heard and may ask what the price includes: "is that the final price?" belongs to the
    # counter that follows (``SITUATION_MET``), and asking it here as well voices the same question
    # twice in a row (R1-Q round 2).  No surprise and no thanks: in the live sweep the learner was
    # "pleasantly surprised" two turns after it had reacted to the very same price.  Two of the
    # three scripted variants are statements (the question rate of the sweep was above its gate).
    brief_tail = (
        "you note calmly that it is in line with what you heard, with no surprise and no thanks, "
        "and you may ask what is included at that price; you do not ask whether it is the "
        "final price"
    )
    if offer_usd == ANCHOR_USD:
        return AnchorSituation(
            ANCHOR_REACHED,
            f"the advisor has already put {amount} on the table, the very price you heard "
            f"people got it for; {brief_tail}",
            (amount,),
            (
                "That's right at the $7,000 I heard people got it for. What exactly does that "
                "price include?",
                "That matches the $7,000 I read people paid.",
                "I heard about $7,000, so that is in line with what I read.",
            ),
        )
    # Below the $7,000: it is NOT "in line with what you heard" (the live sweep: "That lines up with
    # what I'd heard ... $4,500 is under the $7,000 I read about", one reply, two opinions).
    below_tail = (
        "you note calmly that it is even below the $7,000 you heard, with no surprise and no "
        "thanks, and you may ask what is included at that price; you do not ask whether it is the "
        "final price"
    )
    return AnchorSituation(
        ANCHOR_REACHED,
        f"the advisor has already put {amount} on the table, below the $7,000 you heard people "
        f"got it for; {below_tail}",
        (amount, "$7,000"),
        (
            f"{amount} is even below the $7,000 I heard people got it for. What exactly does "
            "that price include?",
            f"{amount} is under the $7,000 I read about.",
            f"I heard people paid about $7,000, and {amount} is below that.",
        ),
    )


ANCHOR_UNCLEAR = "unclear"


def anchor_after_unclear_low(amount_usd: int) -> AnchorSituation:
    """The anchor when the advisor named ``amount_usd``, under $7,000, in a way not read as a price.

    Owner test 8f5bfefc: the advisor said $3,000 and the learner still asked "$9,000 ... can you do
    $7,000?".  Whatever the figure was (an offer worded in a way the parser misses, a part payment,
    a discount), asking for MORE than it is wrong: the learner reacts to that number and asks what
    the total would be, and still names the $7,000 it heard (the anchor's delivery marker).
    """
    amount = _usd(amount_usd)
    return AnchorSituation(
        ANCHOR_UNCLEAR,
        f"the advisor mentioned {amount}, but it is not clear that is the full price you would "
        "pay; react to that number, say you had heard it was around $7,000, and ask what the "
        "total would come to for you; do not ask for $7,000 and do not accept anything yet",
        (amount, "$7,000"),
        (
            f"Wait, {amount} for the whole program? I'd heard it was around $7,000, so what would "
            "I actually pay?",
            f"Sorry, just so I follow: is {amount} what I'd pay in total? I'd heard around $7,000.",
            f"Hold on, {amount}? I heard people paid around $7,000. What would the total be for "
            "me?",
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
# Iteration 3: "the day after tomorrow" is not "tomorrow", and "later this week", "early next week"
# and "in a few days" are loose days, not "today" (the live sweep booked "today at 7 PM" for a call
# the advisor proposed "in a few days", "later this week" and "early next week").
DAY_AFTER_TOMORROW = "day after tomorrow"
DAY_THIS_WEEK = "this week"
DAY_A_FEW_DAYS = "a few days"
LOOSE_DAYS = frozenset({"next week", DAY_THIS_WEEK, DAY_A_FEW_DAYS})
_DAY = re.compile(
    r"\b((?:the )?day after tomorrow|tomorrow|tonight|today|" + "|".join(_WEEKDAYS)
    + r"|this weekend|the weekend|weekend|early next week|later next week|next week"
    r"|later this week|later in the week|this week|(?:in )?(?:a few|a couple of|couple of|two|"
    r"three|2|3) days)\b",
    re.IGNORECASE,
)
_DAY_CANON = {
    "the day after tomorrow": DAY_AFTER_TOMORROW,
    "early next week": "next week",
    "later next week": "next week",
    "later this week": DAY_THIS_WEEK,
    "later in the week": DAY_THIS_WEEK,
}
# A time that belongs to something the advisor SENDS, not to a call: "I'll send those over today",
# "I'll email you the summary tonight".  A call word between the verb and the time keeps it.
_DELIVERY_BEFORE = re.compile(
    r"\b(?:send|sending|sent|e-?mail|mail|share|forward|text|message|drop|shoot|put together|"
    r"get (?:that|it|those|them|everything|the [\w ]{1,30}?) out)\b"
    r"(?:(?!\b(?:call|chat|talk|speak|meet\w*|invite|slot|time|session|catch|check|touch|follow"
    r"|reconnect|ring|phone)\b)[^.?!]){0,50}$",
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
_PART = re.compile(r"\b(mornings?|afternoons?|evenings?|nights?|noon)\b", re.IGNORECASE)


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

    @property
    def vague(self) -> bool:
        """No clock time and no part of the day, and at most a loose day ("next week") for a day.

        "I can try you sometime next week" names no slot the learner could book.
        """
        return self.hour is None and self.part is None and (
            self.day is None or self.day in LOOSE_DAYS
        )


@dataclass(frozen=True)
class SlotChoice:
    """The slot the learner books: its phrase, and whether it moved the advisor's proposal.

    ``deferred`` means no slot is named: the advisor offered none that can be booked and the learner
    had just said it must talk to its decision maker first, so the MEDIUM line books the call
    without a time (``r1_commitment.MEDIUM_DEFER_LINE``).
    """

    phrase: str
    moved: bool
    deferred: bool = False


def _hour24(hour: int, meridiem: str) -> int | None:
    if not 0 <= hour <= 23:
        return None
    if hour > 12:
        return hour
    base = hour % 12
    return base + (12 if meridiem.lower() == "p" else 0)


def _call_time(text: str, match: re.Match[str]) -> bool:
    """The time at ``match`` belongs to a call, not to something the advisor sends or e-mails."""
    start = max(text.rfind(mark, 0, match.start()) for mark in ".?!") + 1
    return _DELIVERY_BEFORE.search(text[start : match.start()]) is None


def _canonical_day(raw: str) -> str:
    day = re.sub(r"^in ", "", raw.lower())
    if day in _DAY_CANON:
        return _DAY_CANON[day]
    if re.fullmatch(r"(?:a few|a couple of|couple of|two|three|2|3) days", day):
        return DAY_A_FEW_DAYS
    return day


def _first_call_time(pattern: re.Pattern[str], text: str) -> re.Match[str] | None:
    return next((m for m in pattern.finditer(text) if _call_time(text, m)), None)


def parse_slot(*texts: object) -> Slot | None:
    """The first day, clock time and part of day found in ``texts``, or None if there is none.

    Each component is taken from the first text that has it, so a caller passes the nearest
    text first ("tomorrow? maybe like 10:00 a.m." before an unrelated "today" earlier on).  A time
    that belongs to something the advisor sends ("I'll send those over today") is not a call time,
    and "the day after tomorrow" is not "tomorrow" (R1-Q iteration 3).
    """
    folded = [_tail(text).lower() for text in texts]
    day: str | None = None
    part: str | None = None
    hour: int | None = None
    minute = 0
    for text in folded:
        if day is None:
            day_match = _first_call_time(_DAY, text)
            day = _canonical_day(day_match.group(1)) if day_match else None
        if part is None:
            part_match = _first_call_time(_PART, text)
            part = part_match.group(1).lower().rstrip("s") if part_match else None
        if hour is None:
            clock = _first_call_time(_CLOCK, text)
            if clock is not None:
                hour = _hour24(int(clock.group(1)), clock.group(3))
                minute = int(clock.group(2) or 0)
                if not 0 <= minute <= 59:
                    minute = 0
            else:
                spoken = _first_call_time(_CLOCK_WORD, text)
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
    if day == DAY_AFTER_TOMORROW:
        return "the day after tomorrow"
    if day == DAY_THIS_WEEK:
        return "later this week"
    if day == DAY_A_FEW_DAYS:
        return "in a few days"
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
# Detectors on the advisor's text.  A call, a time or a follow-up is read by
# ``r1_commitment.call_proposal_in`` (one structural reading, shared with the ask detector).  An
# e-mail OFFER asks the same four questions: the advisor is the subject, the object is
# information, and no programme timeline or cadence hangs on it.
# ----------------------------------------------------------------------------------
_OFFER_FRAME = (
    r"(?:(?:i|we)(?:'ll|'d|'m going to| am going to| are going to| will| can| could| shall|"
    r" would| should| may)|let me|let us|let'?s|(?:can|could|shall|should|may|will|would) (?:i|we)|"
    r"(?:want|like) me to|how about (?:i|we)|what if (?:i|we)|if (?:i|we)(?: sent| send| emailed)|"
    r"would it help (?:if (?:i|we)|to)|if you(?:'d| would) like,? (?:i|we))"
)
_ADVERBS = r"(?:(?:also|then|just|happily|gladly|definitely|actually|still|quickly|at least|"
_ADVERBS += r"go ahead and|really|now) )*"
_MAIL_VERB = r"(?:e-?mail|mail|send|sent|text|whatsapp|message|drop|shoot)"
_MAIL_INFO = (
    r"(?:details|brochure|curriculum|syllabus|information|info|summary|everything|overview|"
    r"outline|breakdown|pricing|fee structure|fees|proposal|document|pdf|schedule|timetable|"
    r"recap|plan options|payment plan options|payment plans|outcome data|course outline|"
    r"course details|program details|programme details|payment details|the e-?mail|it all|"
    r"all of it|full details|plan details|options|plan|start dates?|cohort schedule)"
)
# The words between the verb and the information: no "so" or "that" clause ("send a calendar
# invite so you both have the details" sends an invite, not the details).
_GAP = r"(?:(?!\b(?:so|because|which|who|that)\b)[^.?!]){0,40}?"
_NOT_REMINDERS = (
    r"(?!\s+(?:reminders?|notifications?|updates?|alerts?|newsletters?|receipts?|"
    r"confirmations?|invites?)\b)"
)
_EMAIL_OFFER = _compile(
    r"\b" + _OFFER_FRAME + r"\s+" + _ADVERBS + _MAIL_VERB + r"\b" + _GAP + r"\b" + _MAIL_INFO
    + r"\b",
    r"\b" + _OFFER_FRAME + r"\s+" + _ADVERBS + r"(?:e-?mail|mail) (?:you|me|him|her|them|it|"
    r"that|this|everything)\b(?!\s+(?:the|your|a|an|some|all|my|these|those)\b)",
    r"\b" + _OFFER_FRAME + r"\s+" + _ADVERBS + r"(?:send|shoot|drop|mail|e-?mail) "
    r"(?:you |me )?(?:an? |the |that |this |your )?(?:e-?mail|mail|message)\b" + _NOT_REMINDERS,
    r"\b" + _OFFER_FRAME + r"\b[^.?!]{0,30}\b(?:send|give|share|forward|put)\b[^.?!]{0,40}\b"
    r"(?:(?:in|on|by|via|over|to|into) (?:an? |your |the |my )?(?:e-?mail|mail|inbox|whatsapp|"
    r"address)|in writing)\b",
    r"\b" + _OFFER_FRAME + r"\s+" + _ADVERBS + r"(?:e-?mail|mail) (?:you |me )?(?:the |a |an )?"
    r"(?:[\w-]+ ){0,2}(?:link|form)\b",
    # "I'll also share a course outline beforehand": information handed over between calls
    r"\b" + _OFFER_FRAME + r"\s+" + _ADVERBS + r"(?:share|forward) " + _GAP + r"\b" + _MAIL_INFO
    + r"\b[^.?!]{0,20}\b(?:beforehand|ahead of|in advance|before (?:our|the|then|that|we)|"
    r"after (?:our|the|this|that)|later|today|tonight)\b",
    # "The email will cover the full breakdown": the e-mail the advisor is sending
    r"\bthe e-?mail (?:will |would |should )?(?:cover|covers|include|includes|contain|contains|"
    r"list|lists|has|show|shows|outline|outlines)\b",
    # "I'll get that e-mail out to you today", "I'll have the plan details e-mailed to you"
    r"\b" + _OFFER_FRAME + r"\s+" + _ADVERBS + r"(?:get|have) (?:that |the |an |your |this )?"
    r"(?:[\w-]+ ){0,4}?(?:e-?mails?|mail|details|information|brochure|everything)\b[^.?!]{0,25}"
    r"\b(?:out|sent|over|e-?mailed|mailed|off)\b",
)
# "I'll send it over today" is an e-mail offer.  A QUESTION in a turn that is about a form or a link
# and names no e-mail word is not: the pronoun is the form ("... a two-minute enrollment form. Can
# I send it right now?"; R1-Q iteration 2: the learner answered "What would that email actually
# include?").
_EMAIL_OFFER_PRONOUN = _compile(
    r"\b" + _OFFER_FRAME + r"\s+" + _ADVERBS + r"(?:send|forward|share) (?:it|that|this|them|"
    r"everything) (?:over|across|out|your way|right away|right now|shortly|today|tonight|later|"
    r"right after|after|once|as soon as|before)\b",
)
_EMAIL_WORD = re.compile(r"\b(?:e-?mails?|e-?mailed|mail|mailed|inbox|address)\b", re.IGNORECASE)
_FORM_WORD = re.compile(
    r"\b(?:forms?|links?|applications?|enrol+ment|registration|payment|deposit|invoice|agreement|"
    r"paperwork|contract)\b",
    re.IGNORECASE,
)
# The details of a class are class logistics, not the information a learner decides on: "we'll send
# you the link to the live class on Monday".  ("details of the program" is information.)
_CLASS_OBJECT = re.compile(
    r"\b(?:link|links|schedule|timetable|details|notes|materials?|recordings?|invites?|"
    r"invitations?|reminders?)\s+(?:to|for|of|about)\s+(?:(?:join|attend|access|watch|view|open|"
    r"enter)\s+)?(?:the |your |our |every |each |all )?"
    r"(?:live |recorded |weekly |online |upcoming |first |demo )?(?:class|classes|session|"
    r"sessions|lecture|lectures|webinars?|workshops?|zoom|meeting|demo|orientation|induction)\b"
    r"|\b(?:class|session|lecture|webinar|workshop|zoom|meeting|demo|orientation) "
    r"(?:link|links|schedule|invite|invites|reminder|reminders|recording|recordings)\b",
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
    not mistaken for the day.  What counts as a proposal is ``r1_commitment.call_proposal_in``.
    """
    sentences = split_sentences(_tail(text).lower())
    for index, sentence in enumerate(sentences):
        if call_proposal_in(sentence) is not None:
            # The proposing sentence first, then the one after it, then the one before it.
            after = sentences[index + 1 : index + 2]
            before = sentences[max(0, index - 1) : index]
            near = [sentence, *after, *before]
            return Callback(parse_slot(*near))
    return None


def detect_email_offer(text: object) -> bool:
    """The advisor offers to e-mail or send the details.

    Not a pitch about what the programme sends: "we'll send you the schedule once you enroll",
    "we will send you the link to the live class on Monday" and "we mail you a report every
    week" describe the programme (R1-Q round 2), so a match whose neighbourhood is a cadence, a
    programme timeline or class logistics is not an offer.
    """
    folded = _tail(text).lower()
    form_talk = _EMAIL_WORD.search(folded) is None and _FORM_WORD.search(folded) is not None
    for sentence in split_sentences(folded):
        patterns = _EMAIL_OFFER
        if not (form_talk and is_question_like(sentence)):
            patterns = (*_EMAIL_OFFER, *_EMAIL_OFFER_PRONOUN)
        for pattern in patterns:
            for match in pattern.finditer(sentence):
                near = around(sentence, match.start(), match.end())
                if describes_programme(near) or _CLASS_OBJECT.search(near):
                    continue
                return True
    return False


# What an e-mail would hold, named in the advisor's offer ("the curriculum, pricing and discount
# options"): two of these in the turn mean the advisor already said what is in it.
_MAIL_CONTENT_NOUN = re.compile(
    r"\b(curriculum|syllabus|brochure|pricing|prices?|fees?|discounts?|payment (?:plans?|options)|"
    r"plan options|instal+ments?|schedule|start dates?|cohort (?:dates?|schedule)|outcome data|"
    r"placement (?:stats|data|numbers)|success stories|testimonials?|modules?|breakdown|"
    r"capstone|mentorship|career support|guarantee|terms)\b",
    re.IGNORECASE,
)


def lists_email_contents(text: object) -> bool:
    """The advisor's turn names what the e-mail holds (two or more of its contents)."""
    found = {match.group(1).lower() for match in _MAIL_CONTENT_NOUN.finditer(_tail(text))}
    return len(found) >= 2


# The learner turned a call down ("I'd rather keep it to email for now", "I haven't agreed to any
# date yet"): an open proposal it declined is not answered later by booking it (R1-Q iteration 2:
# the learner declined a call twice and then booked it when the advisor said goodbye).
_DECLINES_CALL = re.compile(
    r"\b(?:rather|prefer|better|happier|more comfortable)\b[^.?!]{0,30}\b(?:e-?mail|text|message|"
    r"writing|chat here)\b"
    r"|\bkeep (?:it|this|things|us)\b[^.?!]{0,20}\b(?:to|over|by|via)\b[^.?!]{0,10}\b(?:e-?mail|"
    r"text|message|writing)\b"
    r"|\b(?:not up for|not comfortable with|don'?t want|do not want|not ready for|not doing|"
    r"skip)\s+(?:a |any |the )?(?:phone )?calls?\b"
    r"|\bno (?:phone )?calls?\b"
    r"|\b(?:haven'?t|have not|not) (?:yet )?agreed to\b"
    r"|\bnot (?:agreeing|committing) to (?:a |any |the )?(?:call|time|date|day)\b"
    r"|\bi(?:'ll| will) (?:reply|respond|write|answer) (?:to you )?(?:there|by (?:e-?mail|text)|"
    r"over (?:e-?mail|text)|in (?:the )?(?:e-?mail|writing))\b",
    re.IGNORECASE,
)


# R1-Q iteration 3.  The learner turned a call, a check-in or a time down in other words, and
# the live sweep booked it anyway (nine calls): "I'd rather reach out myself", "I'd rather you
# didn't", "I'd rather not lock in a time yet", "I'd rather not have a check-in hanging over me",
# "I can't really pin down a time ... rather than you calling me".  An explicit decline holds
# for the whole call.
_DECLINES_CALL_MORE = re.compile(
    r"\b(?:rather|prefer|better) (?:to )?(?:reach out|get in touch|contact you|call you|"
    r"get back to you|come back to you|be the one to)\b"
    r"|\brather than you (?:calling|checking in|reaching out|following up|chasing|ringing)\b"
    r"|\bi(?:'d| would) rather you (?:didn'?t|did not|not|left it)\b"
    r"|\bi(?:'d| would) rather not (?:have|get) a (?:check-?in|call|follow-?up)\b"
    r"|\b(?:no need to|don'?t need you to|please don'?t|you don'?t need to) "
    r"(?:call|check in|follow up|chase|ring|reach out)\b"
    r"|\bi(?:'ll| will) (?:reach out|get in touch|contact you|come back to you|call you)\b"
    r"[^.?!]{0,30}\b(?:myself|on my own|rather than|instead)\b",
    re.IGNORECASE,
)
# A day or a part of the day the learner called difficult: "Tomorrow evening's tricky for me".
_SLOT_REFUSAL = re.compile(
    r"\b(?:tricky|awkward|tough|difficult|hard|unpredictable|busy|doesn'?t work|won'?t work|"
    r"isn'?t great|not great|no good|can'?t do|can'?t make|not possible|not ideal|bad time|"
    r"not a good time|conflicts?|packed)\b",
    re.IGNORECASE,
)


def declines_call(spoken: object) -> bool:
    """The learner's own words turn a proposed call down or put it off in favour of e-mail.

    "I'll reach out / let you know" alone is not a decline: it is how every stall ends.  Only an
    explicit refusal is ("I'd rather reach out myself", "I'd rather you didn't", "I'd rather keep
    it to e-mail"), and it holds for the rest of the call.  "I'm not ready to lock in a time
    yet" is a pause, not a refusal: an advisor who answers the worry may still be booked.
    """
    folded = fold(spoken)
    return (
        _DECLINES_CALL.search(folded) is not None
        or _DECLINES_CALL_MORE.search(folded) is not None
    )


# The learner called the cost the lesser worry ("my worry is more about time than money", "that's
# really what worries me more than the cost", "it's not really the money", "that part sits easier
# with me"): the money stall is never voiced afterwards ("The cost is still the sticking point for
# me" came after all of them).
_COST_SECONDARY = re.compile(
    r"\b(?:time|schedule|hours?|keeping up|workload|pace)\b[^.?!]{0,30}\bthan (?:the )?(?:money|"
    r"cost|price|fees?)\b"
    r"|\bmore than (?:the )?(?:money|cost|price|fees?)\b"
    r"|\b(?:it'?s|that'?s|this is) not (?:really |so much |just )?(?:about )?(?:the )?(?:money|"
    r"cost|price)\b"
    r"|\b(?:money|cost|price)\b[^.?!]{0,12}\b(?:isn'?t|is not|not) (?:really |so much )?"
    r"(?:the|my|a) (?:main |real |big )?(?:issue|problem|worry|concern|sticking point)\b"
    r"|\b(?:that|the) (?:part|price|number|cost) sits easier\b|\bsits easier with me\b",
    re.IGNORECASE,
)


def says_cost_is_secondary(spoken: object) -> bool:
    """The learner said the cost worries it less than something else."""
    return _COST_SECONDARY.search(fold(spoken)) is not None


# The learner said it will wait: "waiting feels more realistic for me right now", "I'll wait for the
# next cohort", "I'm not ready to commit yet".  It does not enrol or pay in the same breath.
WAIT_RECENT_TURNS = 3
_WILL_WAIT = re.compile(
    r"\b(?:waiting|wait|hold(?:ing)? off|put(?:ting)? (?:it|this) off|postpon\w+)\b[^.?!]{0,30}"
    r"\b(?:realistic|better|safer|makes? (?:more )?sense|best|until|for the next|a (?:bit|while|"
    r"little)|for now|right now|longer)\b"
    r"|\b(?:maybe|probably|perhaps|rather|better|wait|join|go|do|for|suit|prefer)\b[^.?!]{0,25}"
    r"\bnext (?:cohort|batch|intake)\b"
    r"|\bnext (?:cohort|batch|intake)\b[^.?!]{0,25}\b(?:suit|better|works|instead)\b"
    r"|\bnot (?:ready )?(?:to )?(?:commit|enrol+|sign up|decide|pay|move forward|start)\b"
    r"[^.?!]{0,12}\b(?:yet|today|now|right now|this)\b"
    r"|\bi(?:'ll| will|'d| would) (?:rather |probably |prefer to |like to |just )?wait\b",
    re.IGNORECASE,
)


def says_will_wait(spoken: object) -> bool:
    """The learner said it will wait before committing (see ``_WILL_WAIT``)."""
    return _WILL_WAIT.search(fold(spoken)) is not None


def refused_slot(spoken: object) -> Slot | None:
    """The day or part of the day the learner said it cannot do, or None.

    A sentence that calls a day or a time difficult ("Tomorrow evening's tricky for me", "Evenings
    are unpredictable with lab work") refuses that slot: a call is never booked there afterwards.
    """
    for sentence in split_sentences(fold(spoken)):
        if _SLOT_REFUSAL.search(sentence) is None:
            continue
        slot = parse_slot(sentence)
        if slot is not None and (slot.day is not None or slot.part is not None):
            return slot
    return None


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


# R1-Q iteration 1.  "Let me check with my manager" is no discount: the judge flagged the thanks
# that followed it as unwarranted gratitude.  Tentative wording about the price, with nothing
# put on the table in the same turn, grants nothing.
_TENTATIVE = re.compile(
    r"\b(?:check|speak|talk|ask|run (?:it|this|that) by|escalate (?:it|this|that) to) "
    r"(?:with |to )?(?:my|the|our) (?:manager|supervisor|boss|lead|team lead|director|head|"
    r"finance team|team|seniors?)\b"
    r"|\blet me (?:check|see|try|talk|ask|find out|look into|speak|run)\b"
    r"|\bi(?:'ll| will| can| could| might| may) (?:try|see|check|ask|look into|find out|talk to|"
    r"speak to|reach out)\b"
    r"|\bsee what i can do\b|\bno promises\b|\b(?:can'?t|cannot|not) promise\b"
    r"|\bi(?:'ll| will) do my best\b|\b(?:might|may) be able to\b",
    re.IGNORECASE,
)
_TENTATIVE_PRICE = re.compile(
    r"\b(?:price|cost|fees?|discount\w*|lower|reduc\w+|less|cheaper|deal|waive\w*|"
    r"scholarship|offer|special|exception|that low|that much|the number)\b|\$\s?\d",
    re.IGNORECASE,
)
# Who else is involved in the decision: "Is anyone else involved in the decision?", "Would you
# talk it over with your husband?".  Asked of the learner, so questions only.
_DECIDER_ASKED = re.compile(
    r"\b(?:who else|any ?(?:one|body) else|some ?(?:one|body) else|other (?:people|person))\b"
    r"[^?]{0,40}\b(?:involved|decisions?|decid\w+|say in|part of|on board|weigh in|sign off|"
    r"approv\w+|consult\w*)\b"
    r"|\bdecision[- ]?makers?\b"
    r"|\b(?:involved|part) in (?:the|this|that|your) (?:decision|choice)\b"
    r"|\bwho(?:'s| is| makes| will make| decides| helps)\b[^?]{0,30}\b(?:decision|decid\w+)\b"
    r"|\bdecide (?:this |it |that )?(?:together|with|alone|on your own|by yourself)\b"
    r"|\bdiscuss (?:it|this|that) with\b"
    r"|\b(?:do|will|would|did) you (?:need to |have to |want to |plan to )?(?:talk|speak|check|"
    r"discuss|consult|run)\b[^?]{0,30}\b(?:"
    + _DM_WORDS
    + r"|any ?(?:one|body)|some ?(?:one|body))\b"
    r"|\b(?:your|any) "
    + _DM_WORDS
    + r"\b[^?]{0,30}\b(?:involved|decision|decide\w*|on board|part of|a say|input|opinion)\b",
    re.IGNORECASE,
)


def detect_tentative(text: object) -> bool:
    """The advisor only SAYS they will check or try on the price ("I can check with my manager").

    A turn that also puts a figure on the table is an offer, not a hedge (the caller checks); the
    turn must be about the price, so "let me check the start date" is not a hedge on a discount.
    """
    folded = _tail(text).lower()
    return _TENTATIVE.search(folded) is not None and _TENTATIVE_PRICE.search(folded) is not None


def asks_decider(text: object) -> bool:
    """The advisor asks the learner who else is involved in the decision."""
    for sentence in split_sentences(_tail(text).lower()):
        sentence = sentence[-PIECE_CHARS:]
        if is_question_like(sentence) and _DECIDER_ASKED.search(sentence) is not None:
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
_OFF_AFTER = re.compile(
    r"^\s*(?:off|discount|less|reduction)\b"
    r"|^\s*(?:is|as) (?:genuinely |really |truly )?(?:the |our )?(?:deepest|maximum|max|biggest|"
    r"largest|most|top)\b",
    re.IGNORECASE,
)
_DISCOUNT_BEFORE = re.compile(
    r"\bdiscounts?\s+(?:of|worth|up to|around|about)?\s*$"
    r"|\b(?:reduc\w+|cut|knock|shave|lower|waive|slash|trim|drop|take|sav(?:e|es|ed|ing))\s+"
    r"(?:the price |it |that |this |the fee |you |your partner )?(?:by |of |down by |off )?"
    r"(?:another |an extra |a further )?\s*$",
    re.IGNORECASE,
)
# A discount DESCRIBED, not granted: "discounts up to $1,500", "some people qualify for up to
# $1,500 off", "depending on the plan you could save $1,000".  (R1-Q final review round 1: "up to
# fifteen hundred dollars" was ledgered as a $7,500 offer, and the learner then said "$7,500 is a
# bit better" to an advisor who had said no such price.)
_DISCOUNT_DESCRIPTION = re.compile(
    r"\b(?:up ?to|as (?:high|much|big|large) as|ranging from|anywhere from|between|"
    r"(?:some|many|most|certain|a few|several) (?:of our )?(?:people|learners|students|folks|"
    r"candidates)|qualify(?:ing)? for|eligible for|(?:may|might|could) (?:also )?(?:get|"
    r"receive|qualify|be eligible|save)|typically|usually|generally|sometimes)\b"
    r"[^.?!;]{0,45}$",
    re.IGNORECASE,
)
def _described_discount(lowered: str, start: int) -> bool:
    """The discount at ``start`` is described ("discounts up to ..."), not offered by the advisor
    in the first person ("I can offer up to ...")."""
    before = clause_before(lowered, start)
    return (
        _DISCOUNT_DESCRIPTION.search(before) is not None
        and _FIRST_PERSON_OFFER.search(before) is None
    )


# A bound, not a price: "under six thousand", "below $7,000", "no more than $7,500".
_BOUND_BEFORE = re.compile(
    r"\b(?:under|below|beneath|less than|no more than|not more than|at most|just under|"
    r"a little under|a bit under|well under|maximum of|"
    # "I will do better than 7000" promises a price below the figure, never the figure itself.
    r"better than|lower than|cheaper than)\s+(?:about |around |roughly )?$",
    re.IGNORECASE,
)
# The advisor selling the course for a figure: "I will give it to you for $3000", "I'm giving the
# program for 3000", "you can have the course at $3,000" (owner test 8f5bfefc).  "get" / "have" /
# "take" need "you" as the subject: "Most of my students get it for 6000" is someone else's price.
_ONLY = r"(?:only\s+|just\s+)?"
_THE_COURSE = r"(?:it|this|that|the (?:whole )?(?:program|programme|course|thing))"
# The seller of a give / sell / offer frame is the advisor ("I", "we", "let me"): "Scaler sells it
# for 3000" is a competitor's price (review of the 8f5bfefc fix).  A few words may sit between
# ("I can give it, give the program for 3000", "we are happy to give you the course for").
_OUR_SELLER = (
    r"(?:\b(?:i|we)(?:'(?:ll|d|m|re|ve))?|\blet (?:me|us)|\blet'?s)(?:\s+[\w',]+){0,4}?\s+"
)
_NET_FRAME = re.compile(
    _OUR_SELLER
    + r"(?:giv(?:e|es|ing)|gave|sell(?:s|ing)?|sold|offer(?:s|ing)?|let you have|do|doing)\s+"
    r"(?:you\s+)?" + _THE_COURSE + r"\s+(?:to you\s+)?(?:for|at)\s+" + _ONLY + r"$"
    r"|\byou(?:'ll| will| would|'d| can| could| may)?\s+(?:also\s+)?(?:get|have|take|grab)\s+"
    + _THE_COURSE + r"\s+(?:for|at)\s+" + _ONLY + r"$"
    r"|\byou(?:'ll| will| would|'d| can| could| may)?\s+(?:join|enrol+|sign up|start|get in)\s+"
    r"(?:the (?:program|programme|course)\s+)?(?:for|at)\s+" + _ONLY + r"$"
    # A plain "fee is" only: "the booking fee is just $1,000" is a part of the price.
    r"|(?<!booking )(?<!registration )(?<!reservation )(?<!admission )(?<!application )"
    r"(?<!token )(?<!seat )(?<!deposit )"
    r"\b(?:price|cost|fee|total)\s+(?:for you\s+)?(?:is|will be|would be|comes to)\s+" + _ONLY
    + r"$"
    r"|\byou(?:'ll| will| would|'d)?\s+" + _ONLY + r"pay\s+" + _ONLY + r"$"
    r"|\b(?:bring(?:ing)?|take|taking|get(?:ting)?)\s+(?:it|this|that|the price)\s+down\s+to\s+$",
    re.IGNORECASE,
)
# Other ways the advisor names a figure as the learner's price (owner test 8f5bfefc review): "I can
# offer you $3,000", "I'll make it 3000", "How about $3,000?", "It's yours for $3,000", "For you
# it's just 3000", "I'll give you a deal at $3,000".  Read in the figure's own clause.
_LOW_NET_BEFORE = re.compile(
    r"\boffer(?:s|ing)?\s+(?:you\s+)?(?:a (?:price|deal|rate) of\s+)?" + _ONLY + r"$"
    r"|\b(?:make|making)\s+it\s+" + _ONLY + r"$"
    r"|\blet'?s (?:make it|do|say|go with|settle (?:on|at)|close (?:on|at))\s+" + _ONLY + r"$"
    r"|\b(?:how|what) about\s+" + _ONLY + r"$"
    r"|\b(?:it'?s|it is|it will be|it would be|that'?s)\s+(?:all\s+)?yours\s+(?:for|at)\s+"
    + _ONLY + r"$"
    r"|\bfor you\b[^.?!]{0,20}$"
    r"|\b(?:deal|price|rate|offer)\s+(?:of|at|for)\s+" + _ONLY + r"$",
    re.IGNORECASE,
)
_LOW_NET_AFTER = re.compile(
    r"^\s*(?:only\s+)?(?:for you|and it'?s yours|is (?:my |our |the |your )?(?:final|best|last|"
    r"lowest)|final|flat|all in|in total|total|for the (?:whole|full|entire) "
    r"(?:program|programme|course))\b",
    re.IGNORECASE,
)
# A lead clause that makes the figure after it a price: "Special price for you, $3,000."
_LOW_NET_LEAD = re.compile(
    r"\b(?:special|final|best|lowest|deal|for you|my price|our price|your price)\b",
    re.IGNORECASE,
)
# A figure that is a part of the price, never the price itself (review of the 8f5bfefc fix): a
# deposit, a booking or registration fee, an instalment, a per-module fee, an add-on, or what is
# paid now when "the rest" comes later.  ``_PART_LATER`` is the rest of the sentence.
_PART_AFTER = re.compile(
    r"^\s*(?:(?:more|extra|additional|on top|cash ?back|back|refund|rebate|voucher|coupon|"
    r"credit|bonus|scholarship|waiver)\b"
    r"|(?:per|each|every|a|an|/)\s*(?:\w+\s+)?(?:months?|instal+ments?|emis?|modules?|terms?|"
    r"semesters?|quarters?|weeks?|years?|class(?:es)?|sessions?|parts?|units?|levels?|"
    r"subjects?|payments?)\b"
    r"|(?:as|for|in|is)\s+(?:a |an |the |your |my )?(?:\w+\s+)?(?:deposit|down ?payment|advance|"
    r"token|booking|registration|reservation|admission|application|first|initial|instal+ment|"
    r"emi|part)\b"
    r"|up ?front\b|in advance\b|advance\b|to (?:reserve|block|book|hold|lock|secure) "
    # A duration or a count of payments (review round 2): "1500 for 6 months", "1500, 6 times".
    r"|,?\s*(?:for|over|across)\s+(?:the next\s+|about\s+)?(?:\d{1,2}|two|three|four|five|six|"
    r"seven|eight|nine|ten|eleven|twelve)\s+(?:months|weeks|instal+ments|emis|payments)\b"
    r"|,?\s*(?:\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+times\b"
    r"|,?\s*(?:twice|thrice)\b)",
    re.IGNORECASE,
)
# An add-on or a discount named a word or two after the figure (review round 2): "a $2,000 early
# bird discount", "$2,000 in credits", "$3,000 worth of bonuses", "a $2,000 referral bonus".  A
# linking word ("with the discount", "which is a discount") keeps the figure the price.
_ADDON_AFTER = re.compile(
    r"^\s*(?:worth\b"
    r"|(?:(?!(?:with|after|including|incl|post|which|that|this|is|was|and|so|because|thanks|"
    r"due|from|for|than|but|or|it|you|as|if|when|now|today|only|just)\b)[\w-]+\s+){0,2}"
    r"(?:discounts?|savings?|off|credits?|bonus(?:es)?|vouchers?|coupons?|cash ?back|"
    r"scholarships?|rebates?|waivers?|refunds?|rewards?|grants?|gift)\b)",
    re.IGNORECASE,
)
_PART_NOW = re.compile(r"^\s*(?:now|today|first|initially|to start|to begin)\b", re.IGNORECASE)
_PART_LATER = re.compile(
    r"\b(?:later|the rest|remaining|balance|afterwards|after (?:that|placement|the course)|"
    r"in (?:two|three|four|\d) (?:parts|payments|instal+ments))\b",
    re.IGNORECASE,
)
_PART_BEFORE = re.compile(
    r"\b(?:deposit|down ?payment|advance|token|booking|registration|reservation|admission|"
    r"application|seat|blocking)(?:\s+(?:fee|amount|charge|payment|money))?\b[^.?!]{0,25}$"
    r"|\b(?:first|initial|each|every|per|monthly|one|an?)\s+(?:instal+ment|emi|part|month)\b"
    r"[^.?!]{0,25}$"
    r"|\b(?:instal+ments?|emis?)\s+(?:of|is|are|will be|would be|comes? to)\b[^.?!]{0,15}$"
    r"|\b(?:an? )?(?:additional|extra|another|further)\s+$"
    # A freebie ("a free 3000 dollar course") and where a plan starts ("EMIs start at $1,500").
    r"|\bfree\s+(?:[\w-]+\s+)?$"
    r"|\b(?:emis?|instal+ments?|plans?|payments?|prices?|fees?|pricing|it|they|which|that)\s+"
    r"(?:\w+\s+)?(?:start(?:s|ing)?|begin(?:s|ning)?)\s+(?:at|from)\s+(?:just\s+|only\s+)?$"
    r"|\bstarting (?:at|from)\s+(?:just\s+|only\s+)?$",
    re.IGNORECASE,
)
# The rest of the price is paid later, in so many words (review round 2): "join for 2000 and pay
# the rest in EMIs", "start for 2000, rest in instalments".  Every figure under the net floor in
# such a sentence is then a part, whatever follows it.
_REST_OWED = re.compile(
    r"\bpay\w*\s+(?:\w+\s+){0,3}?(?:the |a )?(?:rest|remaining|balance|remainder)\b"
    r"|\b(?:the |a )?(?:rest|remaining(?: amount| fee)?|balance|remainder)\s+(?:\w+\s+){0,3}?"
    r"(?:in|over|through|via|as|by)\s+(?:\w+\s+){0,2}?(?:emis?|instal+ments?|parts|payments|"
    r"months|monthly|weeks)\b"
    r"|\b(?:the |a )?(?:rest|remaining(?: amount| fee)?|balance|remainder)\s+(?:\w+\s+){0,4}?"
    r"(?:later|afterwards|after (?:placement|the course|you (?:get|land) a job))\b",
    re.IGNORECASE,
)
# A discount by any name before the figure, or "by" a figure ("bring it down by 2000"), and someone
# else's price ("Most of my students get it for 6000", "Other people pay 3000").
_LOW_DISCOUNT_BEFORE = re.compile(
    r"\b(?:discount\w*|off|saving\w*|scholarship\w*|waiver|waive\w*|cash ?back|rebate|reduction|"
    r"concession|less|cheaper|lower)\b[^.?!]{0,30}$"
    r"|\bby\s+(?:another |an extra |a further )?$",
    re.IGNORECASE,
)
_THIRD_PARTY_BEFORE = re.compile(
    r"\b(?:students?|people|others|alumni|everyone|everybody|learners?|folks|friends?|"
    r"colleagues?|candidates?|they|he|she)\b(?:\s+\w+){0,3}?\s+(?:get|gets|pay|pays|take|takes|"
    r"have|has|buy|buys|join|joins)\b",
    re.IGNORECASE,
)
_YEAR_BEFORE = re.compile(r"\b(?:in|since|from|until|till|by|of|year|the)\s+$", re.IGNORECASE)
_YEAR_AFTER = re.compile(r"^\s*(?:batch|cohort|intake|session|class|season)\b", re.IGNORECASE)


# How far around a figure its frame is read: every frame is a few words, and a bounded window
# keeps a sentence with many figures linear (the hostile-text bound in test_r1_negotiation).
_FRAME_CHARS = 120
# A currency word between the figure and what follows it ("1500 rupees a month" is per month).
_UNIT_WORD = re.compile(r"^\s*(?:dollars?|usd|bucks|rupees?|inr|rs)\b\.?", re.IGNORECASE)


def _part_of_price(
    lowered: str, start: int, end: int, rest_later: bool, *, value: int | None = None,
    rest_owed: bool = False,
) -> bool:
    """The figure at ``start:end`` is a discount, a part payment, an add-on or someone else's.

    ``rest_later`` says the sentence speaks of a later payment ("and the rest later"), and
    ``rest_owed`` that it says the rest is paid later in so many words ("pay the rest in EMIs"):
    every ``value`` under the net floor is then a part.
    """
    window = lowered[max(0, start - _FRAME_CHARS) : start]
    before = clause_before(window, len(window))
    after = _UNIT_WORD.sub("", lowered[end : end + _FRAME_CHARS], count=1)
    return bool(
        _OFF_AFTER.match(after)
        or _ADDON_AFTER.match(after)
        or _DISCOUNT_BEFORE.search(window)
        or _LOW_DISCOUNT_BEFORE.search(before)
        or _PART_AFTER.match(after)
        or (rest_later and _PART_NOW.match(after))
        or (rest_owed and value is not None and value < MIN_NET_USD)
        or _PART_BEFORE.search(before)
        or _THIRD_PARTY_BEFORE.search(before)
        or _described_discount(window, len(window))
    )


def _low_net_cue(lowered: str, start: int, end: int, promised: bool) -> bool:
    """The advisor names the figure at ``start:end`` as the learner's own price for the course."""
    if promised:  # a question phrased as an offer, or "Okay, 3000, final."
        return True
    window = lowered[max(0, start - _FRAME_CHARS) : start]
    if _NET_FRAME.search(window) or _LOW_NET_BEFORE.search(clause_before(window, len(window))):
        return True
    if _LOW_NET_AFTER.match(_UNIT_WORD.sub("", lowered[end : end + _FRAME_CHARS], count=1)):
        return True
    lead = _lead_clause(window, len(window))
    return bool(lead and _LOW_NET_LEAD.search(lead))


_PRICE_CUE = re.compile(
    r"\b(?:deal|price|cost|fee|make it|let'?s (?:make|do|say|go|settle|keep)|lets (?:make|do|"
    r"say|go)|come down|bring (?:it|that|the|this)|go (?:down )?to|settle|special|final|offer|"
    r"discount|for you|meet|floor|deepest|lowest|minimum|maximum|best (?:i|we) can|"
    r"(?:ends|expires?|expired|holds|valid|good) (?:tonight|today|at midnight|till|until|by))\b",
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
    r"accurate|available|applicable|possible)|old (?:promo\w*|batch|price|rate|offer|cohort|"
    r"pricing|deal)|needs? (?:to get )?(?:an? )?approval|(?:we|i) don'?t do|"
    r"don'?t think (?:we|i) can|no longer|expired|never (?:offered|promised)|"
    r"(?:isn'?t|aren'?t|wasn'?t|weren'?t) (?:available|valid|applicable|possible|offered)|"
    r"was (?:for|only|valid|available)|only (?:for|valid|available|applicable)|"
    r"last (?:year|batch|cohort|month)|no way|not happening|isn'?t happening|"
    r"not what we (?:charge|offer)|what we charge|doesn'?t exist|not our (?:price|rate)|"
    r"(?:was|were) (?:the |a )?(?:early[- ]bird|scholarship|promo\w*)|scholarship|"
    r"don'?t know where (?:that|you|it)|wish (?:i|we) could|if only|"
    r"(?:below|under|beneath) (?:our|the) (?:minimum|floor|limit|lowest)|"
    r"not (?:a|an|the) (?:\w+ ){0,2}(?:we|i) (?:offer|do|can|have|give|charge)|"
    r"old (?:curriculum|program\w*|course|version|intake|term)|(?:paid|was|were) [^.?!]{0,20}"
    r"\bin (?:19|20)\d\d|not (?:something|what) we|not yours|isn'?t something we)\b",
    re.IGNORECASE,
)
# A question ABOUT a figure (where it came from, whether the learner is sure, what the learner's
# own number is) is the advisor probing, not offering: "Who told you $7,000?", "Where did you hear
# $8,000?", "What is your budget, $6,000?".  (R1-Q round 2: for a figure the learner did NOT say,
# every other question that names it is a proposal, as before round 1.)
_INQUIRY = re.compile(
    r"\bwho (?:told|said|promised|quoted|gave|mentioned|offered|advised|suggested)\b"
    r"|\bwhere (?:did|do|have|has|had|was|were|is) (?:you|they|he|she|it|that|this|those|these)\b"
    r"|\b(?:why|what makes|what made) (?:do |did |would )?you (?:think|say|believe|expect|assume|"
    r"want|ask|feel|need)\b"
    r"|\bwhy (?:is|are|was|were|does|do|did|would|should)\b"
    r"|\bhow (?:did|do|would) you (?:get|come|hear|arrive|know|find|calculate|reach)\b"
    r"|\b(?:are|were) you sure\b"
    r"|\b(?:did|do|does) (?:someone|somebody|anyone|anybody|they|he|she) (?:\w+ ){0,2}?(?:tell|"
    r"told|say|said|promise|promised|quote|quoted|mention|mentioned|offer|offered|give|gave)\b"
    # ... asking for the learner's own number ("What is your budget, $6,000?"), but not "Would
    # $8,500 fit your budget?", which is an offer.
    r"|\bwhat(?:'s| is| are| was) (?:your|the) (?:budget|range|expectations?|number|figure|"
    r"target|limit|ceiling|salary)\b"
    r"|\bhow much (?:can|do|would|will|could) you\b"
    r"|\bwhat (?:can|do|would|will|could) you (?:afford|pay|spend|manage)\b"
    r"|\b(?:is|was) your (?:budget|range|target|limit|ceiling|expectation|salary)\b"
    r"|\byour (?:budget|range|target|limit|ceiling|expectation|salary) (?:is|was|of|around|about)\b"
    r"|\b(?:are|were) you (?:thinking|looking|hoping|expecting)\b"
    r"|\bis (?:that|this|it) (?:what|the (?:price|number|amount|figure)) you\b",
    re.IGNORECASE,
)
# A figure that is NOT the price of the course for the learner: an income ("a salary hike of about
# $8,000 a year", "earn $5,000 more per month"), a competitor ("compared with a $6,000 bootcamp")
# or what someone else paid ("last year one student paid $7,500").  Round 1 tracked prices from
# the first mention, so these pitch figures became "an offer on the table" (R1-Q round 2).
_NOT_OURS_BEFORE = re.compile(
    r"\b(?:salary|salaries|earn\w*|income|incomes|hike|ctc|lpa|stipend|take-home|compensation|"
    r"compared (?:with|to)|versus|vs|other (?:programs?|programmes?|courses?|bootcamps?|"
    r"institutes?|providers?|platforms?|universities)|competitors?|elsewhere|"
    r"(?:students?|alumni|alumnus|learners?|someone|somebody|people|others|candidates?|"
    r"professionals?|folks|they|he|she)\s+(?:\w+\s+){0,2}?(?:paid|got|took|"
    r"enrolled|joined|saved|received|availed|used|bought|spent)|"
    r"last (?:year|month|quarter|cohort|batch)|previously|used to|in the past|"
    r"(?:previous|prior|earlier|old|last) (?:cohort|batch|class|intake)|"
    r"(?:quoted|offered|told|given|charged)|"
    r"bootcamps?|institutes?|universit\w+|colleges?|degrees?|competitors?|market|industry|"
    r"companies|employers?|recruiters?|salar\w+|raise|bonus\w*|value|worth|valued|"
    r"graduates?|alumni|freshers?|analysts?|scientists?|engineers?|signing|offers? that|"
    r"typical\w*|average|most (?:\w+ )?(?:programs?|courses?)|roles?|jobs?|positions?)\b",
    re.IGNORECASE,
)
_NOT_OURS_AFTER = re.compile(
    r"^\s*(?:(?:more|extra|additional|higher|bonus)\s+)?(?:a|per|every|each|/)\s*"
    r"(?:month|year|annum|week|hour)\b"
    r"|^\s*(?:monthly|yearly|annual\w*|p\.?a\.?|lpa)\b"
    r"|^\s*(?:bootcamp|degree|mba|masters?|diploma|university|college|certification)\b"
    r"|^\s*(?:hike|raise|increase|salary|income|jump|bonus)\b"
    r"|^[^.?!]{0,25}\b(?:elsewhere|on its own|by itself|alone|each|apiece|per session|higher|"
    r"more on average|compared (?:to|with))\b"
    r"|^\s*(?:later|afterwards|after that|on completion|when you finish)\b",
    re.IGNORECASE,
)
# Before the learner's anchor an amount counts as the price on the table only next to a pricing
# word: nobody has asked for a price yet, so a bare "$8,000" in a pitch is not an offer.
_COURSE_PRICE_CUE = re.compile(
    r"\b(?:prices?|costs?|fees?|tuition|total (?:cost|price|fee)|deal|(?:we|i|they) offer\w*|"
    r"offer(?:ed|ing)? (?:you|of|a|an)|special offer|on offer|discounts?|off|special|final|net|"
    r"for you|make it|let'?s (?:make|do|say|go|settle|keep)|lets (?:make|do|say|go)|"
    r"come down|bring(?:ing)? (?:it|that|the|this)|go (?:down )?to|settle|meet you|"
    r"push it|comes? to|works? out|early[- ]bird|you(?:'ll| will| would|'d)? pay|"
    r"pay(?:ing)? (?:only|just)|scholarships?|waive\w*|reduc\w+|lower\w*|knock|drop|match|"
    r"program(?:me)? (?:is|for|at)|course (?:is|for|at)|enrol+\w* (?:for|at)|"
    r"get it (?:for|at)|have it (?:for|at)|take it|lock(?:ed)? (?:it|that|this|the)|"
    r"rate|floor|deepest|best (?:i|we) can|lowest|sav(?:e|es|ed|ing)|(?:ends|expires?|expired|"
    r"holds|valid|good) (?:tonight|today|at midnight|till|until|by))\b",
    re.IGNORECASE,
)
# Said while a figure is hedged: "I'll try for $8,000", "let me see if I can do $8,000".
_HEDGE_BEFORE = re.compile(
    r"\b(?:might|may|maybe|perhaps|possibly|probably|hopefully|try(?:ing)?|see (?:if|what|"
    r"whether|how)|check(?:ing)?|ask(?:ing)?|find out|look(?:ing)? (?:at|into)|depends?|"
    r"depending|if (?:we|i) can|can'?t promise|no promise|not sure|should be able|could be able|"
    r"wish|if only|would love to|i'?d love to|would if i could)\b",
    re.IGNORECASE,
)
# ... and, for a figure the learner said, a rough one ("around", "close to", "the range").
_HEDGE_LOOSE = re.compile(
    r"\b(?:get(?:ting)? close|close to|near(?:ly)?|around|roughly|approximately|about|ballpark|"
    r"range|up to)\b",
    re.IGNORECASE,
)
_HEDGE_AFTER = re.compile(
    r"^\s*(?:\w+ ){0,2}?(?:is possible|would be possible|may be possible|might be possible|"
    r"could be possible|may be|might be|could be)\b",
    re.IGNORECASE,
)
_HEDGE_AFTER_LEARNER = re.compile(
    r"^\s*(?:\w+ ){0,2}?(?:would depend|depends on|depending on|is subject to)\b",
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
    r"^\s*(?:then|it is|it'?s (?:a deal|done|yours|fine|ok|okay)|for you|works|deal|"
    r"is (?:fine|okay|ok|good|done|a deal|acceptable|alright|yours)|"
    r"is (?:genuinely |really |truly |our |the |my )?(?:final|best|lowest|last|floor|deepest|"
    r"limit|minimum|total))\b",
    re.IGNORECASE,
)
# Plain acceptances of a figure the learner asked for, without "I can do": "Yes, you can have it
# for $7,000", "Sure, it's yours for $7,000", "You got it, $7,000", "For you, $7,000".
_GRANT = re.compile(
    r"\byou(?:'ll| will| can| could| may) (?:also )?(?:get|have|take|keep|own)\b"
    r"|\byou (?:get|have|take|keep) (?:it|this|that|them)\b"
    r"|\bit(?:'s| is| will be| would be) (?:all )?yours\b"
    r"|\b(?:that|this)(?:'s| is| would be| will be) (?:yours|a deal|done|settled)\b"
    r"|\byou(?:'ve| have)? got (?:it|that|a deal)\b"
    r"|\bfor you\b",
    re.IGNORECASE,
)
# A bare affirmation that opens the clause before the figure: "Okay, $7,000."
_AFFIRM_ONLY = re.compile(
    r"^\W*(?:okay|ok|alright|all right|fine|sure|yes|yeah|yep|absolutely|definitely|"
    r"of course|done|deal|agreed|sold|certainly|great|perfect)\W*$",
    re.IGNORECASE,
)
_PUNCT_BREAK = re.compile(r"[.?!,;:\n]|\s-+\s")
# A question can still carry an offer.  "How about $8,000?", "What if I do $8,000?", "Can I do
# $8,000 for you?", "How does $8,500 sound?", "What do you say to $8,000?", "Can we close at
# $8,000 today?" and "If I give you $1,000 off, will you join today?" are offers whatever the
# question word; "Would $8,500 work for you?", "Is $8,000 something you can manage?" and "I can do
# $8,000, okay?" are offers too.  For a figure the LEARNER said (the $7,000 anchor above all) a
# question counts only when it is phrased as one of these: a wh-question about it ("Who told you
# we could do $7,000?", "Where did you hear $7,000 would work?") is the advisor asking about a
# figure, not making it.  (A question that names any other figure is a proposal of it unless it
# is an ``_INQUIRY``.)
_OFFER_VERB = (
    r"(?:do|offer|give|make|bring|take|go|settle|meet|match|put|knock|cut|drop|reduce|lower)"
)
_QUESTION_OFFER_ALWAYS = re.compile(
    r"\b(?:how|what) about\b|\bwhat if (?:i|we)\b|\b(?:want|like) me to\b[^?]{0,20}\b"
    + _OFFER_VERB + r"\b|\b(?:shall|should|can|could|may) (?:i|we) (?:\w+ ){0,2}?" + _OFFER_VERB
    + r"\b|\b(?:shall|should|can|could|may) (?:i|we) (?:\w+ ){0,2}?(?:reserve|hold|lock|secure|"
    r"book|enrol+|sign)\b|(?:^\W*(?:and |so )*|\b(?:do you|would you) )(?:want|take|grab|accept|"
    r"like) (?:the |this |that )?\$\d[\d,]*"
    r"|\bhow (?:does|do|would|will|is|are) [^?]{0,25}\b(?:sound|look|feel|work|seem)\b"
    r"|\bwhat (?:do|would|will) you (?:say|think)\b(?: (?:about|of|to|if))?"
    r"|\b(?:can|could|would) you (?:\w+ ){0,2}?(?:do|stretch|go|manage|afford|pay|meet|spend|swing|"
    r"handle|live with)\b"
    r"|\b(?:can|could|shall|may) (?:we|i) (?:\w+ ){0,2}?(?:close|settle|finali[sz]e|agree|"
    r"lock|wrap|call it|say|meet|split)\b"
    r"|\b(?:would|will|can|could) you (?:\w+ ){0,2}?(?:join|enrol+|sign|commit|take|accept|"
    r"go ahead|come on board|start|pay|confirm|proceed|decide|agree)\b"
    r"|\bdeal\s*\?\s*$",
    re.IGNORECASE,
)
_QUESTION_OFFER_PLAIN = re.compile(
    r"\b(?:would|will|does|do|is|are)\b[^?]{0,45}\b(?:work|fine|ok|okay|alright|acceptable|"
    r"good|comfortable|suit\w*|manage\w*|afford\w*|doable|feasible|fit|easier|lighter|"
    r"better|more (?:comfortable|manageable|affordable))\b",
    re.IGNORECASE,
)
_WH_START = re.compile(
    r"^\W*(?:(?:and|so|but|um|uh|well|okay|ok|now|then)\W+)*(?:who|whom|whose|where|why|what|"
    r"which|when|how)\b(?!\s+about\b)",
    re.IGNORECASE,
)


_NOT_AN_OFFER_QUESTION = re.compile(
    r"\b(?:your|the) (?:friend|colleague|husband|wife|partner|father|mother|company|employer|"
    r"boss|manager|roommate|family|parents|brother|sister|dad|mom)\b"
    r"|\b(?:other|another) (?:institutes?|bootcamps?|providers?|programs?|courses?|schools?)\b"
    r"|\bcompared (?:to|with)\b|\btalk(?:ing)? about\b|\bwhat would you do\b"
    r"|\bhow (?:would|do) you feel\b|\byou'?d save\b|\b(?:isn'?t|aren'?t|wasn'?t|weren'?t)\b"
    r"|\bso you(?:'re| are) saying\b|\bwhy\b",
    re.IGNORECASE,
)


def _question_is_an_offer(lowered: str) -> bool:
    """A question sentence phrased as an offer (see the frames above)."""
    if _NOT_AN_OFFER_QUESTION.search(lowered) is not None:
        return False
    if _QUESTION_OFFER_ALWAYS.search(lowered) is not None:
        return True
    if _WH_START.match(lowered) is not None:
        return False
    return (
        _QUESTION_OFFER_PLAIN.search(lowered) is not None
        or _FIRST_PERSON_OFFER.search(lowered) is not None
    )


def _lead_clause(lowered: str, start: int) -> str:
    """The clause before the one the figure at ``start`` opens, when the figure opens its own.

    "Okay, I'll match that, $7,000." puts the promise in the clause before the figure; a clause
    that already holds other words of its own ("... but $7,000") looks no further back, so a
    promise made for another figure ("I can do $8,500 but $7,000 maybe") never carries over.
    """
    parts = [part.strip() for part in _PUNCT_BREAK.split(lowered[:start])]
    if not parts or len(parts[-1].split()) > 1:
        return ""
    earlier = [part for part in parts[:-1] if part]
    return earlier[-1] if earlier else ""


_ACCEPT_WORDS = frozenset(
    "okay ok fine alright all right sure yes yeah yep done deal agreed sold then it is its s you "
    "win got a final good great perfect certainly absolutely of course for now i m ll give take "
    "will have your yours set settled accepted goes on that bring down at to we meet match well "
    "so and just let make say go with can do".split()
)
_AFFIRM_WORDS = frozenset(
    "okay ok fine alright sure yes yeah yep done deal agreed sold win absolutely certainly "
    "great perfect settled accepted".split()
)
_FIGURE_WORDS = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*\b", re.IGNORECASE)


def bare_acceptance(lowered: str) -> bool:
    """The sentence is nothing but an affirmation and a figure ("Okay fine, 7000.").

    Structural: whatever surrounds the figure is affirmation words, there is at least one real
    affirmation among them, and the whole sentence is short.  ("Seven thousand, done." reads as
    ``$7000, done.`` once amounts are canonical.)
    """
    rest = _FIGURE_WORDS.sub(" ", lowered)
    words = [word.replace("'", "") for word in re.findall(r"[a-z']+", rest)]
    if not words or len(words) > 8:
        return False
    return all(word in _ACCEPT_WORDS for word in words) and any(
        word in _AFFIRM_WORDS for word in words
    )


_RESULT_BEFORE = re.compile(
    r"\b(?:bring(?:s|ing)?|mak(?:es|ing)|tak(?:es|ing)|put(?:s|ting)|get(?:s|ting)) "
    r"(?:it|that|this|you|the [\w ]{1,40}?)\s*(?:down |back )?(?:to|at)\s*$",
    re.IGNORECASE,
)


def _promised(lowered: str, start: int, end: int) -> bool:
    """The advisor's own clause promises the amount at ``start:end`` ("I can do $7,000")."""
    if bare_acceptance(lowered):
        return True
    before = clause_before(lowered, start)
    if _RESULT_BEFORE.search(before) and _FIRST_PERSON_OFFER.search(lowered[:start]):
        return True  # "I'll take another $500 off, bringing the course down to $7000"
    if _FIRST_PERSON_OFFER.search(before) or _GRANT.search(before):
        return True
    if _ACCEPTING_AFTER.search(clause_after(lowered, end)):
        return True
    lead = _lead_clause(lowered, start)
    return bool(
        lead
        and (
            _FIRST_PERSON_OFFER.search(lead)
            or _GRANT.search(lead)
            or _AFFIRM_ONLY.match(lead)
        )
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
    if _HEDGE_BEFORE.search(before) is not None or _HEDGE_AFTER.match(lowered[end:]) is not None:
        return False
    if learner_said and (
        _HEDGE_LOOSE.search(before) is not None
        or _HEDGE_AFTER_LEARNER.match(lowered[end:]) is not None
    ):
        return False
    return not learner_said or _promised(lowered, start, end)


def _not_our_price(lowered: str, start: int, end: int) -> bool:
    """The amount at ``start:end`` is an income, a competitor's price or someone else's payment."""
    return bool(
        _NOT_OURS_BEFORE.search(clause_before(lowered, start))
        or _NOT_OURS_AFTER.match(lowered[end:])
    )


# Someone else selling the course (review round 2): "Scaler sells it for 3000", "Coursera's price
# is $3,000", "At Scaler the price is $3,000".  The learner's own objection names free courses on
# YouTube and Coursera, so an advisor's comparison names them too.  Known platforms are read by
# name; any other capitalised name only as a seller ("Acme sells it", "Acme's price", "at Acme").
_KNOWN_SELLERS = (
    r"scaler|coursera|udemy|upgrad|simplilearn|great ?learning|masai|almabetter|newton school|"
    r"coding ?ninjas|udacity|edx|youtube|linkedin learning|springboard|datacamp|codecademy|"
    r"byju'?s|unacademy|intellipaat|edureka|accio ?job|pw skills|physics ?wallah|imarticus|"
    r"jigsaw|board infinity|guvi|hero vired|internshala|skillshare|khan academy|"
    r"analytics vidhya|nptel|swayam|applied ?ai|interview ?bit|leetcode|educative|brainstation|"
    r"general assembly|le wagon|excelr|odin ?school|bosscoder|crio|geeks ?for ?geeks|gfg"
)
_CAPITALISED = re.compile(r"(?<![\w'])([A-Z][a-zA-Z]+)(?:'s|\u2019s)?\b")
# Capitalised words that are never a seller: the speaker, the learner, the interviewer, our own
# brand, the course's subjects, employers named in a pitch, calendar words and contractions.
_NOT_A_SELLER = frozenset(
    "i i'm i'll i'd i've it it's that that's this there there's here here's what what's who "
    "who's how let let's today today's tonight tonight's we you your our okay ok so and but "
    "yes yeah no sure well also then now see look please hi hello thanks thank sorry actually "
    "priya christy christie christo interview kickstart ik data science python sql machine "
    "learning deep ai ml google facebook amazon netflix meta apple microsoft faang maang "
    "january february march april may june july august september october november december "
    "monday tuesday wednesday thursday friday saturday sunday emi emis usd inr dollar dollars "
    "the a an for with at on in of to my normally usually basically honestly really currently "
    "right overall typically generally just only again total final plus still otherwise "
    "originally literally frankly definitely obviously clearly great good perfect absolutely "
    "most many some other others every everyone everybody nobody students people "
    # Price words that start a sentence ("Best price is $6,500", "Mera last price 6,000 hai"):
    "best last special lowest discounted revised net new updated reduced offer offers course "
    "program programme fee fees price prices cost mera hamara apna aapka ma'am sir".split()
)
# After the seller's name, "I" / "we" / "our" / "for you" hand the figure back to the advisor:
# "Scaler sells it for 6000, but I'll give it to you for 3000".
_OUR_SUBJECT = re.compile(r"\b(?:i|we|our|ours|us|me|my|let'?s|for you)\b", re.IGNORECASE)
_SELLER_VERB = (
    r"(?:sells?|sold|selling|offers?|offered|offering|gives?|gave|giving|charges?|charged|"
    r"charging|lists?|listed|prices?|priced|costs?)"
)


def _role_pattern(alt: str, verbs: str) -> re.Pattern[str]:
    """A name in a seller's role: "at NAME", "NAME's", "NAME (word) sells"."""
    return re.compile(
        r"\b(?:at|on|from|via|through)\s+(?:" + alt + r")\b"
        r"|\b(?:" + alt + r")(?:'s|\u2019s)\b"
        r"|\b(?:" + alt + r")\s+(?:(?!(?:it|that|this|which|the|our|we|i)\b)\w+\s+)?" + verbs
        + r"\b",
        re.IGNORECASE,
    )


_KNOWN_SELLER = _role_pattern(_KNOWN_SELLERS, r"(?:" + _SELLER_VERB + r"|is|are|has|have)")


# An unknown name sells only with a verb that is never a noun after it: "Best price is $6,500" and
# "Course cost" are not "Acme prices it" (fuzz pass, 2026-10-30).
_NAMED_SELLER_VERB = (
    r"(?:sells?|sold|selling|offers|offered|offering|gives|gave|giving|charges?|charged|"
    r"charging|lists|listed|priced)"
)


def _named_sellers(piece: str) -> re.Pattern[str] | None:
    """Capitalised names in ``piece`` in a seller's role, as a pattern over the lowered text."""
    names: list[str] = []
    for match in _CAPITALISED.finditer(piece):
        word = match.group(1)
        if word.isupper() or word.lower() in _NOT_A_SELLER:
            continue  # "EMI", "FAANG", "I": an acronym or a word that never sells the course
        names.append(re.escape(word.lower()))
    if not names:
        return None
    return _role_pattern("|".join(dict.fromkeys(names)), _NAMED_SELLER_VERB)


def _third_party_seller(lowered: str, start: int, sellers: re.Pattern[str] | None) -> bool:
    """A competitor, not the advisor, sells at the figure at ``start``: a seller named before it
    in its frame, with no "I" / "we" / "our" / "for you" after that name."""
    window = lowered[max(0, start - _FRAME_CHARS) : start]
    last = None
    for pattern in (_KNOWN_SELLER, sellers):
        if pattern is None:
            continue
        for match in pattern.finditer(window):
            if last is None or match.end() > last:
                last = match.end()
    return last is not None and _OUR_SUBJECT.search(window, last) is None


# A sentence is read in pieces of at most this many characters: speech-to-text may run a whole
# monologue together, and the amount grammar must stay fast on any input.
PIECE_CHARS = 400


# Independent clauses are read one by one: "..., and I can apply the maximum discount" is its own
# offer and not a member of the list of discounts before it; "that $6300 ends tonight, can I send
# the link?" is a statement followed by a question.
_CLAUSE_SPLIT = re.compile(
    r"\s*[;]\s*|\s*,\s*(?:and |but |so |yet )?(?=(?:i|we|let me|you)\b)"
    r"|\s*,\s*(?=(?:can|could|should|shall|would|will|do|does|is|are) (?:i|we|you|that|it)\b)",
    re.IGNORECASE,
)


def _clauses(sentence: str) -> list[str]:
    """``sentence`` split into its independent clauses (see ``_CLAUSE_SPLIT``)."""
    return [part for part in _CLAUSE_SPLIT.split(sentence) if part and part.strip()]


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


def _piece_offers(
    piece: str,
    own: frozenset[int] = frozenset(),
    *,
    require_cue: bool = False,
    rest_later: bool = False,
    rest_owed: bool = False,
) -> dict[int, bool]:
    """Net prices (and whether each is conditional) offered in one piece of a sentence.

    ``own`` are the figures the learner said (the anchor among them): the advisor repeating
    one is an offer only with a promise in the same clause.  A question that names a figure the
    learner said offers it only when it is phrased as an offer ("How about $7,000?", "How does
    $7,000 sound?", "Would $7,000 work for you?"); a question about where a figure came from
    ("Who told you $8,000?") offers nothing; any other question that names a new figure
    proposes it.  ``require_cue`` (before the learner's anchor) wants a pricing word in the
    sentence, and an income, a competitor's price or what someone else paid is never an offer.
    ``rest_later`` says the sentence speaks of paying the rest later: "$2,000 now" is then a part;
    ``rest_owed`` that it says so in so many words: every figure under the net floor is a part.
    A competitor named as the seller ("Scaler sells it for 3000") is never the advisor's offer.
    """
    # "$6500, which is ..." keeps its comma: the amount grammar would swallow it, and with it the
    # clause boundary the refusal and hedge checks read.
    lowered = canonical_amounts(re.sub(r"(\d),(?=\s)", r"\1 ,", piece)).lower()
    asked = is_question_like(piece)
    if asked and _INQUIRY.search(lowered):
        return {}
    # A question phrased as an offer promises the figure itself, so it needs no further promise;
    # any other question that names a figure is the advisor asking about it, not offering it.
    asked_as_offer = asked and _question_is_an_offer(lowered)
    if asked and not asked_as_offer:
        return {}
    plain_acceptance = bare_acceptance(lowered)
    sellers = _named_sellers(piece)

    def theirs(start: int) -> bool:
        return _third_party_seller(lowered, start, sellers)

    def part(value: int, start: int, end: int) -> bool:
        return _part_of_price(
            lowered, start, end, rest_later, value=value, rest_owed=rest_owed
        )

    def low_net(value: int, start: int, end: int) -> bool:
        # "I will give it to you for $3000" is a price however low it is and whenever it is said:
        # the owner test 8f5bfefc lost that offer to the cue gate and the $4,500 floor, and the
        # learner then asked for $7,000 as if nothing was offered.  A part of the price ("$2,000
        # upfront", "the booking fee is $1,000", "1500 per instalment") or a discount is not one.
        return (
            MIN_FRAMED_NET_USD <= value < MIN_NET_USD
            and not part(value, start, end)
            and not theirs(start)
            and _low_net_cue(lowered, start, end, asked_as_offer or plain_acceptance)
        )

    def bare_value(match: re.Match[str], thousands: bool) -> int | None:
        if thousands:
            return int(round(float(match.group(1)) * 1000))
        return parse_amount(match.group(1))

    bare: list[tuple[int, int, int]] = []
    for pattern, thousands in (
        (_BARE_THOUSANDS, True), (_BARE_DECIMAL, True), (_BARE_WHOLE, False)
    ):
        for match in pattern.finditer(lowered):
            value = bare_value(match, thousands)
            # "In 2025 ...", "the 2026 batch": a year is no price.
            year = not thousands and 1900 <= (value or 0) < 2100 and bool(
                _YEAR_BEFORE.search(lowered[: match.start()])
                or _YEAR_AFTER.match(lowered[match.end() :])
            )
            if value is not None and not year:
                bare.append((value, match.start(), match.end()))
    dollars = [
        (parse_amount(match.group(1), bool(match.group(2))), match.start(), match.end())
        for match in _DOLLARS.finditer(lowered)
    ]
    # A figure in a net-price frame opens the gates below whatever its size.
    framed_any = any(
        value is not None
        and (
            low_net(value, start, end)
            or (
                _NET_FRAME.search(lowered[max(0, start - _FRAME_CHARS) : start]) is not None
                and not part(value, start, end)
                and not theirs(start)
            )
        )
        for value, start, end in bare + dollars
    )
    # A bare figure said as a discount ("for 1000 off", "1500 less") is the discount it is with a
    # "$": the framed floor read it as a $1,000 price (review of the 8f5bfefc fix).
    bare_off = any(
        value < MIN_NET_USD and _OFF_AFTER.match(lowered[end:]) is not None
        for value, _start, end in bare
    )
    if (
        require_cue and not asked_as_offer and not framed_any and not bare_off
        and _COURSE_PRICE_CUE.search(lowered) is None
    ):
        return {}
    conditional = _CONDITIONAL.search(lowered) is not None
    found: dict[int, bool] = {}
    discounts: set[int] = set()
    small: set[int] = set()

    def admitted(value: int, start: int, end: int) -> bool:
        said = value in own
        if _not_our_price(lowered, start, end) or theirs(start):
            return False
        if _BOUND_BEFORE.search(lowered[max(0, start - 40) : start]) is not None:
            return False  # "under six thousand" is a bound, never the price itself
        return _offered(lowered, start, end, learner_said=said and not asked_as_offer)

    def as_discount_at(start: int, end: int) -> bool:
        return (
            _OFF_AFTER.match(lowered[end:]) is not None
            or _DISCOUNT_BEFORE.search(lowered[:start]) is not None
        )

    for value, start, end in dollars:
        if value is None or not admitted(value, start, end):
            continue
        as_discount = as_discount_at(start, end)
        described = _described_discount(lowered, start)
        if low_net(value, start, end):
            found[value] = conditional
        elif 0 < value < MIN_NET_USD:
            small.add(value)
            if as_discount and not described:
                discounts.add(value)
        elif MIN_NET_USD <= value < PRICE_USD:
            found[value] = conditional
    for match in _PERCENT_OFF.finditer(lowered):
        if _offered(lowered, match.start(), match.end()) and not _described_discount(
            lowered, match.start()
        ):
            discount = int(round(PRICE_USD * float(match.group(1)) / 100))
            # The same floor as a dollar figure: "I gave you more than 90% discount" is no $900
            # offer (owner test 7f2a25e6 turn 58, the learner then named a price nobody said).
            if PRICE_USD - discount >= MIN_NET_USD:
                discounts.add(discount)
    if _PRICE_CUE.search(lowered) or asked_as_offer or plain_acceptance or framed_any or bare_off:
        for value, start, end in bare:
            if not admitted(value, start, end):
                continue
            if low_net(value, start, end):
                found[value] = conditional
            elif MIN_NET_USD <= value < PRICE_USD and (
                _PRICE_CUE.search(lowered) or asked_as_offer or plain_acceptance or framed_any
            ):
                found[value] = conditional
            elif 0 < value < MIN_NET_USD and as_discount_at(start, end):
                small.add(value)
                if not _described_discount(lowered, start):
                    discounts.add(value)
    # Several small amounts in one sentence are a LIST of the deck's discounts, not an offer.
    if len(discounts) == 1 and small <= discounts:
        found[PRICE_USD - next(iter(discounts))] = conditional
    return found


def parse_price_offers(
    text: object, own_amounts: Iterable[int] = (), *, require_cue: bool = False
) -> list[tuple[int, bool]]:
    """Net prices the advisor put on the table, as ``(net_usd, conditional)`` pairs.

    Reads "$8,500", "8500", "8.5", "8.5k" (a bare number only next to a price cue) and
    "$500 off" / "10% off" (converted to the price they leave).  The learner's own ask
    echoed back ("you want the deal at 7000"), a refused or questioned figure ("$7,000 is too
    low for us", "Who told you $7,000?"), an income or a competitor's price ("a salary hike of
    $8,000 a year", "compared with a $6,000 bootcamp") and a LIST of deck discounts ("discounts
    of $500, $1000 and $1500") are not offers.  The $7,000 anchor, and every figure in
    ``own_amounts`` (what the learner said), counts only when the advisor promises it ("I can do
    $7,000", "Sure, it's yours for $7,000").  ``require_cue`` is for the turns before the
    learner's anchor: a sentence then needs a pricing word ("price", "discount", "for you" ...)
    before any amount in it counts.
    """
    own = frozenset({ANCHOR_USD, *own_amounts})
    offers: dict[int, bool] = {}
    for sentence in split_sentences(_tail(text)):
        # "You'll pay $2,000 now, and the rest later": the clause with the figure does not say so.
        rest_later = _PART_LATER.search(sentence) is not None
        rest_owed = _REST_OWED.search(sentence) is not None
        for clause in _clauses(sentence):
            for piece in _pieces(clause):
                offers.update(
                    _piece_offers(
                        piece,
                        own,
                        require_cue=require_cue,
                        rest_later=rest_later,
                        rest_owed=rest_owed,
                    )
                )
    return sorted(offers.items(), reverse=True)


# A stated price says "pay" ("Pay me $3,000 and it's yours"); a statistic said "over" or "more
# than" a figure ("over $5,000", "more than 2,500 dollars is the average hike") is no price.
_PAY_WORD = re.compile(r"\bpa(?:y|ys|ying|id)\b", re.IGNORECASE)
_ROUGH_BEFORE = re.compile(
    r"\b(?:over|more than|above|upwards of|in excess of|nearly|almost|around)\s+$", re.IGNORECASE
)


def unread_low_figures(text: object, own_amounts: Iterable[int] = ()) -> list[int]:
    """Figures under the $7,000 anchor the advisor named as a possible price, offered or not.

    The anchor's backstop (owner test 8f5bfefc review): a low price worded in a way
    ``parse_price_offers`` does not read ("Pay me $3,000 and it's yours") must not be answered
    with "$9,000 ... can you do $7,000?".  A discount, a part payment, an add-on, someone else's
    price, an income, a bound, a count ("5,000 alumni") and a refused or negated figure are none,
    and a figure (with a "$" or without) counts only next to a pricing word: "Over $5,000
    learners" or "a $2,000 referral bonus" in a pitch is no price (review round 2).  The caller
    drops the figures that were read as offers.
    """
    own = frozenset({ANCHOR_USD, *own_amounts})
    found: list[int] = []
    for sentence in split_sentences(_tail(text)):
        rest_later = _PART_LATER.search(sentence) is not None
        rest_owed = _REST_OWED.search(sentence) is not None
        for clause in _clauses(sentence):
            for piece in _pieces(clause):
                lowered = canonical_amounts(re.sub(r"(\d),(?=\s)", r"\1 ,", piece)).lower()
                if is_question_like(piece) and _INQUIRY.search(lowered):
                    continue
                cued = bool(
                    _COURSE_PRICE_CUE.search(lowered)
                    or _PRICE_CUE.search(lowered)
                    or _FIRST_PERSON_OFFER.search(lowered)
                    or _GRANT.search(lowered)
                    or _PAY_WORD.search(lowered)
                )
                figures = [
                    (parse_amount(match.group(1), bool(match.group(2))), match)
                    for match in _DOLLARS.finditer(lowered)
                ]
                figures += [
                    (parse_amount(match.group(1)), match)
                    for match in _BARE_WHOLE.finditer(lowered)
                ]
                sellers = _named_sellers(piece)
                for value, match in figures:
                    start, end = match.start(), match.end()
                    if (
                        value is None
                        or not MIN_FRAMED_NET_USD <= value < ANCHOR_USD
                        or value in own
                        or not (cued or _low_net_cue(lowered, start, end, False))
                        or (1900 <= value < 2100 and not match.group(0).startswith("$"))
                        or COUNT_NOUN_AFTER.match(_UNIT_WORD.sub("", lowered[end:], count=1))
                        or _part_of_price(
                            lowered, start, end, rest_later, value=value, rest_owed=rest_owed
                        )
                        or _not_our_price(lowered, start, end)
                        or _third_party_seller(lowered, start, sellers)
                        or _BOUND_BEFORE.search(lowered[max(0, start - 40) : start])
                        or _ROUGH_BEFORE.search(lowered[max(0, start - 40) : start])
                        or negated_before(lowered, start, 8)
                        or has_refusal(clause_after(lowered, end))
                        or _PRICE_NO.search(clause_after(lowered, end))
                    ):
                        continue
                    found.append(value)
    return found


def states_full_price(text: object) -> bool:
    """The advisor states a price at or above the $7,000 anchor for the course ("The program
    costs $9,000", "the fee is 8000"): a low figure named before it is no longer the price."""
    for sentence in split_sentences(_tail(text)):
        for clause in _clauses(sentence):
            for piece in _pieces(clause):
                lowered = canonical_amounts(re.sub(r"(\d),(?=\s)", r"\1 ,", piece)).lower()
                if is_question_like(piece) or _COURSE_PRICE_CUE.search(lowered) is None:
                    continue
                sellers = _named_sellers(piece)
                figures = [
                    (parse_amount(match.group(1), bool(match.group(2))), match)
                    for match in _DOLLARS.finditer(lowered)
                ] + [
                    (parse_amount(match.group(1)), match)
                    for match in _BARE_WHOLE.finditer(lowered)
                ]
                for value, match in figures:
                    start, end = match.start(), match.end()
                    if (
                        value is not None
                        and ANCHOR_USD <= value <= MAX_LIST_USD
                        and not _not_our_price(lowered, start, end)
                        and not _third_party_seller(lowered, start, sellers)
                        and not negated_before(lowered, start, 8)
                        and not _PRICE_NO.search(clause_after(lowered, end))
                    ):
                        return True
    return False


@dataclass(frozen=True)
class AdvisorActs:
    """What one advisor turn does, read with the detectors the engine uses (one reading).

    ``enrol`` / ``call`` are the two kinds of ask (a callback or time proposal is a call),
    ``email_offer`` an offer to send information, ``best_offer_usd`` the lowest net price put on
    the table, ``price_answer`` whether the turn answers the learner's anchor (an offer or a
    refusal) and ``close_attempt`` a farewell.  ``tests/test_r1_detector_corpus.py`` scores every
    field against the labelled advisor-utterance corpus.
    """

    enrol: bool
    call: bool
    callback: Callback | None
    email_offer: bool
    best_offer_usd: int | None
    price_answer: bool
    close_attempt: bool

    @property
    def ask_kind(self) -> AskKind | None:
        """The engine's single answer: an enrolment ask outranks a call ask."""
        if self.enrol:
            return AskKind.ENROL
        return AskKind.CALL if self.call else None


def read_advisor_turn(
    text: object, *, after_anchor: bool = True, r_sec: float = 345.0
) -> AdvisorActs:
    """Read one advisor turn the way ``RolePlayEngine.plan_turn`` does.

    ``after_anchor`` says the learner's $7,000 anchor was already delivered: an amount then answers
    it, while before it an amount needs a pricing word.  ``r_sec`` is the role-play clock for the
    farewell rule (a courtesy such as "thanks for your time" only counts from 4:00).
    """
    acts = ask_acts(text)
    state = Negotiation("husband")
    seen = state.observe(5, text, anchor_turn=4 if after_anchor else None)
    return AdvisorActs(
        enrol=AskKind.ENROL in acts,
        call=AskKind.CALL in acts or seen.callback is not None,
        callback=seen.callback,
        email_offer=seen.email_offer,
        best_offer_usd=state.best_offer_usd,
        price_answer=seen.price_answer,
        close_attempt=is_close_attempt(text, r_sec),
    )


# The figure is the $7,000 only when it is a price: "seven thousand applications last year" and
# "7,000 learners" are counts (R1-Q final review round 1: the first read as an answer to the
# anchor).
_COUNT_NOUN = (
    r"(?:months?|students|people|learners|applications?|applicants|alumni|graduates|enrol+ments?|"
    r"seats|users|candidates|sign-?ups|members|reviews|jobs|hires|companies|mentors|instructors)"
)
_ANCHOR_REF = re.compile(
    r"(?<![\d,.])\$?7,?000\b(?!\s*" + _COUNT_NOUN + r")"
    r"|\bseven (?:thousand|grand)\b(?!\s*" + _COUNT_NOUN + r")|\b7k\b",
    re.IGNORECASE,
)
# "Where did you hear seven?" / "Who told you seven?": the advisor asks about the learner's figure
# in the learner's own shorthand.
_ANCHOR_SHORTHAND = re.compile(
    r"\b(?:where|who|when|how) (?:did|do|have|has|was|were) (?:you|they|that|it)\b[^?.!]{0,25}"
    r"\b(?:hear|heard|get|got|see|saw|read|find|found|told|said|quote|quoted)\b[^?.!]{0,15}"
    r"\b(?:seven|7)\b(?!\s*" + _COUNT_NOUN + r")"
    r"|\bwho (?:told|said|quoted|promised|gave) you\b[^?.!]{0,15}\b(?:seven|7)\b"
    r"(?!\s*" + _COUNT_NOUN + r")",
    re.IGNORECASE,
)
_PRICE_NOUN_NO = re.compile(
    r"\bold (?:promo\w*|batch|price|rate|offer|cohort|pricing|deal)\b|\bscholarship\b"
    r"|\bearly[- ]bird\b|\bpromo(?:tion)? (?:is|was|has) (?:over|gone|ended|expired)\b"
)
_LIST_PRICE = re.compile(
    r"(?:\bprice|\bfee|\bcost|\bit'?s|\bis|\bcosts|\bat)\s+(?:is |only |just )?\$?9,?000\b",
    re.IGNORECASE,
)
# "If I can't do $8,000, would you still join?" supposes a refusal; it does not make one.
_SUPPOSES = re.compile(
    r"\b(?:if|unless|in case|suppose|supposing|what if) (?:i|we)\b"
    r"|^\W*(?:and |so |but |okay |ok )*(?:if|unless|suppose|supposing)\b",
    re.IGNORECASE,
)
# "That's our deepest discount.", "That's the lowest with instalments.": the price will not move.
_FINAL_STATEMENT = re.compile(
    r"\b(?:that|this|it)(?:'s| is) (?:genuinely |really |truly |absolutely )?(?:our|the|my) "
    r"(?:deepest|lowest|best|final|maximum|max|biggest|largest|last|bottom)\b",
    re.IGNORECASE,
)
_PRONOUN_OBJECT = re.compile(r"\b(?:that|this|it|those|them)\b", re.IGNORECASE)
def mentions_anchor(text: object) -> bool:
    """The advisor's turn names the learner's $7,000 (any wording of it)."""
    for sentence in split_sentences(_tail(text).lower()):
        sentence = sentence[-PIECE_CHARS:]  # the amount grammar must stay fast on any input
        canon = canonical_amounts(re.sub(r"(\d),(?=\s)", r"\1 ,", sentence)).lower()
        if _ANCHOR_REF.search(canon) is not None or _ANCHOR_SHORTHAND.search(sentence) is not None:
            return True
    return False


_HEDGED_REFUSAL = re.compile(
    r"\b(?:can'?t|cannot|no) promise|\bnot (?:sure|certain)\b|\blet me (?:see|check)\b|"
    r"\bi'?ll (?:try|see|check)\b|\bcheck with\b",
    re.IGNORECASE,
)


def refuses_price(text: object) -> bool:
    """The advisor refuses the learner's price ("we can't go lower", "$7,000 is impossible").

    Four shapes count: a refusal in a sentence about the price ("we can't go lower"); a sentence
    that names the $7,000 anchor and denies it (impossible, too low, no way, an old batch,
    "that's not what we charge"); a challenge to where the anchor came from ("Who told you
    $7,000?"); and the list price restated after the anchor was named ("You heard $7,000. The
    price is $9,000.").  A hedge ("I can't promise anything, but let me see") and a supposed refusal
    ("If I can't do $8,000, would you still join?") are not refusals.
    """
    anchor_seen = False
    list_price = False
    previous_anchor = False
    for sentence in split_sentences(_tail(text).lower()):
        sentence = sentence[-PIECE_CHARS:]  # the amount grammar must stay fast on any input
        canon = canonical_amounts(re.sub(r"(\d),(?=\s)", r"\1 ,", sentence)).lower()
        asked = is_question_like(sentence)
        reference = _ANCHOR_REF.search(canon)
        mentions = reference is not None or _ANCHOR_SHORTHAND.search(sentence) is not None
        anchor_seen = anchor_seen or mentions
        if _LIST_PRICE.search(canon) is not None and not asked:
            list_price = True
        supposes = _SUPPOSES.search(sentence) is not None
        hedged = _HEDGED_REFUSAL.search(sentence) is not None
        no_match = _PRICE_NO.search(canon)
        # "That was an old promotion": a denial that names a price thing is about the price itself.
        price_noun_denial = no_match is not None and _PRICE_NOUN_NO.search(no_match.group(0))
        denies = has_refusal(sentence) or no_match is not None
        if not asked and not supposes and not hedged:
            if _FINAL_STATEMENT.search(sentence) is not None:
                return True
            carried = previous_anchor and (
                _PRONOUN_OBJECT.search(sentence) is not None or no_match is not None
            )
            if denies and (
                mentions or carried or price_noun_denial or _PRICE_TALK.search(sentence)
            ):
                return True
            if reference is not None and negated_before(canon, reference.start(), 8):
                return True
        if asked and mentions and _INQUIRY.search(canon) is not None:
            return True
        if asked and previous_anchor and _INQUIRY.search(canon) is not None:
            return True
        previous_anchor = mentions
    return anchor_seen and list_price


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
    # R1-Q iteration 1: the turn named the $7,000 anchor after it was delivered; the advisor only
    # said they would check or try (nothing granted); the advisor asked who else decides.
    anchor_mentioned: bool = False
    tentative: bool = False
    decider_asked: bool = False
    # R1-Q iteration 3: the e-mail offer already says what is in the e-mail; the turn put a price on
    # the table that is LOWER than the best one before it (``lower_offer_usd``); every figure the
    # turn named as a price (an instalment option above the best offer is no better than it).
    email_listed: bool = False
    lower_offer_usd: int | None = None

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
        # The learner turn on which it last said it had to talk to its decision maker (the MEDIUM
        # line then books a call without inventing a slot the learner never had).
        self.decider_said_turn: int | None = None
        # R1-Q iteration 3.  The turn on which the learner first turned a call or a time down in
        # so many words (an explicit decline holds for the rest of the call), the days and parts
        # of the day it called difficult (never booked), the turn the advisor's latest slot was
        # proposed on, and what the learner said about its priorities (cost called secondary: no
        # money stall).
        self.call_declined_turn: int | None = None
        self.refused_slots: list[Slot] = []
        self.last_slot_turn: int | None = None
        self.money_secondary = False
        # R1-Q final review round 1.  The turn on which the learner said it will wait ("waiting
        # feels more realistic", "the next cohort"), and the latest turn on which the advisor
        # addressed the decision maker (a STRONG commitment needs the decider stall answered and
        # no wait said).
        self.wait_said_turn: int | None = None
        self.decider_handled_turn: int | None = None
        # Owner test 8f5bfefc review: figures under the $7,000 the advisor named that were not read
        # as offers, as (turn, usd); the anchor reacts to the latest instead of asking for more.
        self.low_mentions: list[tuple[int, int]] = []
        # The latest turn that stated a price at or above the $7,000 (the $9,000 list price, an
        # $8,000 offer): a low figure named before it is stale (review round 2: "$2,000 in
        # credits" at turn 56 made the anchor after "The program costs $9,000" ask about $2,000).
        self.low_cleared_turn: int | None = None

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
                self.last_slot_turn = turn
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
        prior_best = self.best_offer_usd
        # Before the anchor nobody has asked for a price, so an amount needs a pricing word.
        for net, conditional in parse_price_offers(
            text, self.own_amounts, require_cue=not after_anchor
        ):
            mentioned = True
            if all(item.net_usd != net for item in self.offers + offers):
                offers.append(PriceOffer(turn, net, conditional))
        read = {item.net_usd for item in self.offers + offers}
        if any(item.net_usd >= ANCHOR_USD for item in offers) or states_full_price(text):
            self.low_cleared_turn = turn
        for usd in unread_low_figures(text, self.own_amounts):
            if usd not in read:
                self.low_mentions.append((turn, usd))
        lowest_now = min((item.net_usd for item in offers), default=None)
        lower = lowest_now if lowest_now is not None and (
            prior_best is None or lowest_now < prior_best
        ) else None
        answered_price = after_anchor and mentioned
        if answered_price:
            self.answer_offer = True
        if after_anchor:
            refusal = refuses_price(text)
            if refusal:
                self.refusals += 1
        self.offers.extend(offers)
        newly: set[str] = set()
        addressed = reasons_handled_in(text, self.decision_maker)
        if REASON_DECISION_MAKER in addressed:
            self.decider_handled_turn = turn
        for reason in addressed:
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
            anchor_mentioned=after_anchor and mentions_anchor(text),
            tentative=not mentioned and not refusal and detect_tentative(text),
            decider_asked=asks_decider(text),
            email_listed=email and lists_email_contents(text),
            lower_offer_usd=lower,
        )

    def note_learner_text(
        self, spoken: object, turn: int | None = None, *, stall: bool = False
    ) -> None:
        """Remember what the learner said: the figures (so the advisor repeating one is not an
        offer) and, at ``turn``, that it has to talk to its decision maker first.  ``stall`` marks
        the owed timing objection ("maybe the next cohort"): that is the objection the advisor is
        meant to answer, not a decision to wait."""
        for amount in dollar_amounts(spoken):
            if 0 < amount <= PRICE_USD:
                self.own_amounts.add(amount)
        if turn is not None and self._says_decider_first(spoken):
            self.decider_said_turn = turn
        if turn is not None and self.call_declined_turn is None and declines_call(spoken):
            self.call_declined_turn = turn
        refused = refused_slot(spoken)
        if refused is not None and refused not in self.refused_slots:
            self.refused_slots.append(refused)
        if says_cost_is_secondary(spoken):
            self.money_secondary = True
        if turn is not None and not stall and says_will_wait(spoken):
            self.wait_said_turn = turn

    def _says_decider_first(self, spoken: object) -> bool:
        """The learner said it would talk to or check with its decision maker."""
        pattern = re.compile(
            r"\b(?:talk|speak|check|discuss|consult|run (?:it|this|that) by|ask|tell)\b[^.?!]{0,40}"
            r"\b" + re.escape(self.decision_maker.lower()) + r"\b",
            re.IGNORECASE,
        )
        return pattern.search(fold(spoken)) is not None

    def note_reason_voiced(self, reason: str, turn: int) -> None:
        """The learner raised ``reason`` (a stall reason intent, or the owed F4 moves)."""
        self.voiced.setdefault(reason, turn)
        self.voicings[reason] = self.voicings.get(reason, 0) + 1
        if reason == REASON_DECISION_MAKER:
            self.decider_said_turn = turn

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

    def unread_low_usd(self) -> int | None:
        """The latest figure under the $7,000 (and under the best offer) not read as an offer."""
        best = self.best_offer_usd
        cleared = self.low_cleared_turn
        return next(
            (
                usd
                for said, usd in reversed(self.low_mentions)
                if (best is None or usd < best) and (cleared is None or said >= cleared)
            ),
            None,
        )

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

    def money_is_settled(self) -> bool:
        """The price is no longer the learner's worry: it met the ask, or it called cost secondary.

        The money stall ("The cost is still the sticking point for me") after "my worry is more
        about time than money" and after the $7,000 was met contradicted the learner itself.
        """
        best = self.best_offer_usd
        return (
            self.money_secondary
            or (best is not None and best <= ANCHOR_USD)
            or self.price_situation() == SITUATION_MET
        )

    def call_declined(self) -> bool:
        """The learner turned a call down in so many words (it holds for the rest of the call)."""
        return self.call_declined_turn is not None

    def decider_unresolved(self) -> bool:
        """The learner said it must talk to its decision maker first and the advisor did not
        address that afterwards (the advisor's answer has to come AFTER the learner's words)."""
        said = self.decider_said_turn
        if said is None:
            return False
        handled = self.decider_handled_turn
        return handled is None or handled <= said

    def strong_blocked(self, turn: int) -> str | None:
        """Why a STRONG commitment would contradict the learner's own words, or None.

        R1-Q final review round 1: a strong advisor who was told "I'd want to talk it over with my
        husband before anything moves forward" and "waiting feels more realistic" got "Okay, let's
        do it, I'll pay the deposit today" in the live sweep.  STRONG is for a learner who has no
        decider left to consult, is not waiting and did not turn a call down.
        """
        if self.call_declined():
            return "call_declined"
        waited = self.wait_said_turn
        if waited is not None and 0 <= turn - waited <= WAIT_RECENT_TURNS:
            return "learner_waiting"
        if self.decider_unresolved():
            return "decider_unresolved"
        return None

    def slot_refused(self, slot: Slot | None) -> bool:
        """``slot`` is a day or part of the day the learner said it cannot do."""
        if slot is None:
            return False
        for refused in self.refused_slots:
            if refused.day is not None and slot.day == refused.day:
                return True
            if refused.day is None and refused.part is not None and (
                slot.part == refused.part or (refused.part in ("evening", "night") and slot.evening)
            ):
                return True
        return False

    def slot_choice(self, turn: int | None = None, *, picks_own: bool = True) -> SlotChoice:
        """The slot of the MEDIUM line for the advisor's latest proposal.

        When the advisor named no slot that can be booked (nothing, or "sometime next week") and
        the learner said within the last ``DEFER_RECENT_TURNS`` turns that it has to talk to its
        decision maker first, the call is booked without a slot (``SlotChoice.deferred``).  A slot
        the learner said it cannot do is never booked (R1-Q iteration 3), and a proposal older than
        ``SLOT_RECENT_TURNS`` turns is no proposal: the learner does not pick a day the advisor
        named long ago.  ``picks_own`` is False when the ask was not for a call (an enrolment ask
        graded MEDIUM): with no recent slot the learner then books the call without one, instead of
        inventing "Thursday at 7 PM" for a call nobody proposed.
        """
        slot = self.last_slot
        stale = (
            slot is not None
            and turn is not None
            and self.last_slot_turn is not None
            and turn - self.last_slot_turn > SLOT_RECENT_TURNS
        )
        if stale:
            slot = None
        choice = choose_slot(slot)
        vague = slot is None or slot.vague
        recent = (
            turn is not None
            and self.decider_said_turn is not None
            and 0 <= turn - self.decider_said_turn <= DEFER_RECENT_TURNS
        )
        refused = self.slot_refused(slot) or (
            slot is None and self.slot_refused(Slot(None, None, 0, "evening"))
        )
        if refused or (vague and recent) or (slot is None and not picks_own):
            choice = SlotChoice(choice.phrase, False, True)
        self.chosen_slot = choice
        return choice

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
            "slot_deferred": None if self.chosen_slot is None else self.chosen_slot.deferred,
            "call_declined_turn": self.call_declined_turn,
            "refused_slots": len(self.refused_slots),
            "money_secondary": self.money_secondary,
            "wait_said_turn": self.wait_said_turn,
            "decider_handled_turn": self.decider_handled_turn,
            "decider_said_turn": self.decider_said_turn,
        }
