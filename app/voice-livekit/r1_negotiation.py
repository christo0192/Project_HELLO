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

import os
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
from r1_script import INTERVIEWER_ADDRESS_NAMES
from r1_text import (
    COUNT_NOUN_AFTER,
    canonical_amounts,
    clause_after,
    clause_before,
    dollar_amounts,
    expand_shorthand_amounts,
    fold,
    is_question_like,
    later_price_threat,
    negated_before,
    parse_amount,
    split_sentences,
)
from r1_tracker import _TIME_LIMIT, parse_discounts
from r1_world import NET_PRICES_USD, PRICE_USD

# A turn longer than this is read from its end: closing proposals come last, and a hostile
# or runaway transcript cannot make the detectors slow.
MAX_TEXT_CHARS = 12000
# Stall rounds the learner may spend on reasons inside the close window before it gives its
# (scripted) WEAK resolution.
MAX_STALL_ROUNDS = 2
# M032 SWEEP-18: a price stated on the advisor turn before is the base of a dollar discount.
STATED_CARRY_TURNS = 1
# M032 SWEEP-21: the quote record's kinds, the conflicts, at most this many per session, and how far
# above the best offer a total is a rise.
QUOTE_OFFER = "offer"
QUOTE_TOTAL = "total"
# Review S2P-R2: a course price named in another frame ("We charge $9,000", "Ours is $9,000").
QUOTE_NAMED = "named"
_STATED_KINDS = (QUOTE_TOTAL, QUOTE_NAMED)
CONFLICT_WEBSITE = "website"
CONFLICT_RISE = "rise"
MAX_CONFLICTS = 2
RISE_MIN_USD = 500
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
KIND_SIGNAL = "signal"

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


CONDITION_MONEY_PATH = "money_path"
CONDITION_DECIDER = "decider"
CONDITION_REASSURANCE = "reassurance"
CONDITION_NEEDS = "needs"
CONDITION_FAMILY = "families"
CONDITION_WORK = "work"


@dataclass(frozen=True)
class ConditionClause:
    id: str
    clause: str
    markers: tuple[tuple[str, ...], ...]
    fallbacks: tuple[str, ...]


def _condition(
    clause_id: str, clause: str, fallbacks: tuple[str, ...], *markers: tuple[str, ...]
) -> ConditionClause:
    return ConditionClause(clause_id, clause, markers, fallbacks)


CONDITION_CLAUSES = {
    CONDITION_MONEY_PATH: _condition(
        CONDITION_MONEY_PATH, "if I knew how the payment could work for me",
        ("Honestly, I think I could decide if I knew how the payment could work for me.",
         "What would really help is knowing how the payment could work for me.",
         "If I could see a way to pay that would work for me, that would change things."),
        (r"\b(?:pay|payment|payments|paying|afford)\b",),
        (r"\b(?:work|manage|handle|doable)\b",), (r"\b(?:if|once|knew|know|help)\b",),
    ),
    CONDITION_DECIDER: _condition(
        CONDITION_DECIDER, "if I knew what to tell my {decision_maker} about it",
        ("Honestly, it would be easier if I knew what to tell my {decision_maker} about it.",
         "What would really help is knowing what to tell my {decision_maker} about it.",
         "If I knew how to explain it to my {decision_maker}, that would make it easier."),
        (r"\b(?:tell|explain|say to|show)\b",), (r"\b{decision_maker}\b",),
        (r"\b(?:if|knew|know|help)\b",),
    ),
    CONDITION_REASSURANCE: _condition(
        CONDITION_REASSURANCE, "if I could hear how people like me got on after it",
        ("Honestly, it would help to hear how people like me got on after it.",
         "If I could hear how people like me did after the course, that would help.",
         "What would really help is hearing how people like me got on afterwards."),
        (r"\b(?:people like me|others like me|someone like me|people in my)\b",),
        (r"\b(?:got on|did|turned out|ended up|worked out|work out|after)\b",),
    ),
    CONDITION_NEEDS: _condition(
        CONDITION_NEEDS, "if I felt this really fits where I am",
        ("Honestly, I'd feel better if I felt this really fits where I am.",
         "What would really help is feeling sure this fits my situation.",
         "If I felt this was right for me where I am now, that would help."),
        (r"\b(?:fits|fit|right for)\b",), (r"\b(?:where I am|my situation|me)\b",),
        (r"\b(?:if|felt|feel|sure)\b",),
    ),
    CONDITION_WORK: _condition(
        CONDITION_WORK, "once things at work settle down",
        ("Honestly, I could look at it again once things at work settle down.",
         "It would be easier once things at work settle down a bit.",
         "Once work is less busy, I could think about it properly."),
        (r"\bwork\b",), (r"\b(?:settle|calm|quieter|less busy|eases)\b",),
    ),
}
CONDITION_FAMILY_CLAUSES = {
    "F1": _condition(
        "families:F1", "if the cost side felt manageable for me",
        ("Honestly, I could decide if the cost side felt manageable for me.",
         "What would really help is the cost feeling manageable for me.",
         "If the money side felt doable for me, that would change things."),
        (r"\b(?:cost|price|fee|money)\b",), (r"\b(?:manageable|doable|workable)\b",),
    ),
    "F2": _condition(
        "families:F2", "if I could see how it would fit my schedule",
        ("Honestly, it would help if I could see how it would fit my schedule.",
         "What would really help is seeing how it would fit my week.",
         "If I could see how it would work with my schedule, that would help."),
        (r"\b(?:fit|work)\b",), (r"\b(?:schedule|week|time)\b",),
    ),
    "F3": _condition(
        "families:F3", "if I felt sure it would really pay off for me",
        ("Honestly, I could decide if I felt sure it would really pay off for me.",
         "What would really help is feeling sure it would be worth it for me.",
         "If I knew it would pay off for someone like me, that would help."),
        (r"\b(?:pay off|worth it|be worth)\b",), (r"\b(?:sure|felt|knew)\b",),
    ),
}


N_TIMING = "N-TIMING"
N_MONEY = "N-MONEY"
N_DECISION_MAKER = "N-DM"
N_QUESTION = "N-QUESTION"
N_EMAIL = "N-EMAIL"
N_EMAIL_YES = "N-EMAIL-YES"

N_SIG_PLAN = "N-SIG-PLAN"
N_SIG_FORMAT = "N-SIG-FORMAT"
N_SIG_DISCOUNT = "N-SIG-DISCOUNT"
SIGNAL_IDS = (N_SIG_PLAN, N_SIG_FORMAT, N_SIG_DISCOUNT)

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
    NegotiationSpec(
        N_SIG_PLAN, KIND_SIGNAL, None,
        "you ask whether the payment can be spread out or how the payment plans work",
        ((r"\b(?:pay\w*|plan\w*|instal+ment\w*|spread|split|monthly|up front)\b",),
         (r"\?",)),
        (
            "Is there a way to spread the payment out, or does it all have to be paid at once?",
            "How would the payment actually work, and could I split it up instead of paying "
            "it all in one go?",
            "Is there some kind of payment plan, or is it one payment up front?",
        ),
    ),
    NegotiationSpec(
        N_SIG_FORMAT, KIND_SIGNAL, None,
        "you ask how the classes actually run and whether you could keep up alongside work",
        ((r"\b(?:class\w*|session\w*|week\w*|course|format|run|pace)\b",),
         (r"\b(?:keep up|alongside|around work|job|working|fit)\b",), (r"\?",)),
        (
            "How do the classes actually run week to week, and could I keep up alongside my job?",
            "What does a normal week in the course look like, and could I realistically keep up "
            "while working?",
            "Are the sessions something I could fit around work, or would I struggle to keep up?",
        ),
    ),
    NegotiationSpec(
        N_SIG_DISCOUNT, KIND_SIGNAL, None,
        "you ask whether anything can be done on the price if you decide soon",
        ((r"\b(?:price|fee|cost|discount|flexib\w*)\b",),
         (r"\b(?:soon\w*|quickly|decid\w*|made up my mind)\b",), (r"\?",)),
        (
            "If I made up my mind fairly soon, is there anything you could do on the price?",
            "Is there any flexibility on the fee if I decided quickly?",
            "Would anything change on the price if I decided sooner rather than later?",
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


# M032 SWEEP-3 (flag R1_NO_COMMIT_LEDGER, read by the engine).  The stall reasons and the question
# about the next step no longer end "before you agree to anything" (aa166f09, 199e97c2: every reply
# after one of them said the not-today stall again).  Ids, kinds, reasons and markers are unchanged;
# N-DM needs its decision maker and a talk or check verb, N-QUESTION a what/how and the call, the
# next step, involve, include or sign up, and every variant below proves them.
NO_COMMIT_BRIEFS: dict[str, str] = {
    N_MONEY: (
        "you are still worried about the cost and would need to see how you could manage the "
        "payment"
    ),
    N_DECISION_MAKER: "you would want to check with your {decision_maker} first",
    N_QUESTION: "you ask the advisor what the next step or the call would actually involve",
}
NO_COMMIT_VARIANTS: dict[str, tuple[str, ...]] = {
    N_DECISION_MAKER: (
        "I'd really like to talk this over with my {decision_maker} first.",
        "Let me run it by my {decision_maker} first, since we decide these things together.",
        "I should check with my {decision_maker} before I say yes to a plan.",
    ),
    N_QUESTION: (
        "What exactly would that call involve? I'd like to know that first.",
        "What would the next step be, exactly?",
        "What would we cover on that call, and how long would it take?",
    ),
}
N_QUESTION_ENROL_BRIEF_V2 = (
    "you ask the advisor what you would actually be signing up for and what is included"
)
N_QUESTION_ENROL_VARIANTS_V2 = (
    "What exactly would I be signing up for? I'd like to know what's included first.",
    "What's included in what I'd be signing up for?",
    "What would I actually get for that, and what does it include?",
)


# M032 SWEEP-22 (flag R1_PROBE_FIRST): she asks the price before she worries about it.  On an early
# enrolment or call ask with no price named and none asked, N-PRICE-FIRST replaces the money stall:
# a price question that is no stall (no reason voiced, no stall round, no objection for spacing).
KIND_PRICE_FIRST = "price_first"
N_PRICE_FIRST = "N-PRICE-FIRST"
PRICE_FIRST_SPEC = NegotiationSpec(
    N_PRICE_FIRST,
    KIND_PRICE_FIRST,
    None,
    "you cannot think about signing up before you know what it costs, so ask the advisor what the "
    "fee is, in your own words, without saying anything about the cost yourself",
    (
        (r"\bhow much\b", r"\bcosts?\b", r"\bfees?\b", r"\bprice\b", r"\bcharge\b"),
        (r"\?",),
    ),
    (
        "I'd need to know the fee first. What does the course cost?",
        "Before I think about that, how much is the course?",
        "What would it cost me? I'd need to know that first.",
    ),
)
SPEC_BY_ID[N_PRICE_FIRST] = PRICE_FIRST_SPEC
# SWEEP-22 item 4: the first money stall (REASON_MONEY not voiced yet), without SWEEP-3's tail:
# about the price the advisor named, or, after her price question was dodged, about not knowing
# it.
N_MONEY_NAMED_BRIEF = (
    "you are worried about the price the advisor mentioned and would need to see how you could "
    "manage the payment"
)
N_MONEY_UNKNOWN_BRIEF = (
    "you still don't know what it costs, and you couldn't agree to anything before knowing that "
    "and how you would manage the payment"
)
# Review S2P-R7: the first money stall about a price he named, with no "still" in any variant (the
# fallbacks rotate by seed, so the lead variant alone cannot keep "still" out of a first worry).
N_MONEY_NAMED_VARIANTS = (
    "It's a lot of money to commit, so I'm not sure about the payment side yet.",
    "The cost is weighing on me. I'd need to work out how I could manage the payment.",
    "I'm worried about the cost, and I'd have to see how I could afford it.",
)
N_MONEY_UNKNOWN_VARIANTS = (
    "I still don't know what it would cost me, and I'd need to know that first.",
    "Without knowing the fee, I can't really agree to anything yet.",
    "I'd have to know the cost first, and how I could manage the payment.",
)


def money_spec(*, price_named: bool, price_asked: bool, first: bool) -> NegotiationSpec | None:
    """N-MONEY worded for what she knows of the price (SWEEP-22 item 4), or None (unchanged).

    ``first``: the money stall was not voiced yet.  With a price named, the first stall is about
    that price and none of its variants says "still" (review S2P-R7: they rotate by seed, so a
    promoted lead variant was not enough); with none named after her price question went
    unanswered, it is about not knowing the cost.  A later money stall keeps the release's "still
    worried about the cost".
    """
    if not first:
        return None
    spec = SPEC_BY_ID[N_MONEY]
    if price_named:
        return replace(spec, brief=N_MONEY_NAMED_BRIEF, variants=N_MONEY_NAMED_VARIANTS)
    if price_asked:
        return replace(spec, brief=N_MONEY_UNKNOWN_BRIEF, variants=N_MONEY_UNKNOWN_VARIANTS)
    return None


# SWEEP-22 item 2: her own question about the course price (never the time or an extra's cost).
_ASKS_PRICE = re.compile(
    r"\bhow much (?:is|does|would|will|did) (?:it|this|that|the course|the program(?:me)?|"
    r"the fee|the whole thing)(?: (?:actually|really|roughly|exactly))?(?: cost| be| come to)?\b"
    r"|\bwhat(?:'s| is| would be| will be) (?:the |your )?(?:actual |total |final |course )?"
    r"(?:fee|price|cost|tuition)\b(?! (?:of|for) (?:the |a |an )?(?:recordings?|extra|add-?on|"
    r"materials?|exam|certificate))"
    r"|\bwhat (?:does|would|will|did) (?:it|this|that|the course|the program(?:me)?) "
    r"(?:actually |really )?(?:cost|come to)\b"
    r"|\bhow much (?:do|would|will) (?:you|they) charge\b"
    r"|\bhow much (?:would|will|do|am) i (?:be )?pay(?:ing)?\b"
    r"|\bwhat would i (?:actually )?(?:be )?pay(?:ing)?\b",
    re.IGNORECASE,
)
_NOT_PRICE_QUESTION = re.compile(
    r"\bhow much (?:time|effort|work|homework|study|practice)\b|\bextra cost for\b",
    re.IGNORECASE,
)


def asks_price(learner_text: object) -> bool:
    """Her line asks what the course costs ("So how much is it?"), in a question (SWEEP-22)."""
    for sentence in split_sentences(learner_text):
        if not (is_question_like(sentence) or "?" in sentence):
            continue
        folded = fold(sentence)
        if _NOT_PRICE_QUESTION.search(folded):
            continue
        if _ASKS_PRICE.search(folded):
            return True
    return False


# SWEEP-22 item 5: the advisor talked about the cost or her budget without any figure.
PRICE_CUE_BUDGET = "budget"
PRICE_CUE_COST = "cost"
_BUDGET_QUESTION = re.compile(
    r"\bwhat(?:'s| is| would be) your budget\b|\bwhat (?:kind of |sort of )?budget\b"
    r"|\bhow much (?:can|could|would|are) you (?:able to )?(?:afford|spend|invest|pay|put in)\b"
    r"|\bdo you have (?:a|any) budget\b|\bcan you afford\b|\byour budget (?:for|is)\b",
    re.IGNORECASE,
)
_COST_TALK = re.compile(
    r"\b(?:it|this|that|the course|the program(?:me)?|this course|our course|this program(?:me)?)"
    r"(?:'s| is| will be| would be| can be| might be)? (?:a bit |a little |quite |very |really |"
    r"slightly |definitely |somewhat |kind of )?(?:expensive|pricey|costly|not cheap)\b(?!\s+to\b)"
    r"|\b(?:it|this|the course|the program(?:me)?) costs? (?:some |a lot of |good |real )?money\b"
    r"|\bcan(?:'?t|not) (?:give|offer|provide|do) (?:it|this|the course|you the course|you this)"
    r"(?: to you)? (?:for )?free\b"
    r"|\bif i (?:give|gave|offer|offered) (?:it|this|you (?:the course|this course|it)|the course)"
    r"(?: to you)? (?:for )?free\b",
    re.IGNORECASE,
)
_ANY_FIGURE = re.compile(r"\$\s?\d|\b\d[\d,]{2,}\b|\b\d+(?:\.\d+)?\s?k\b", re.IGNORECASE)


def price_cue(advisor_text: object) -> str | None:
    """"budget", "cost" or None: the advisor raised her budget or the cost with no figure."""
    canonical = canonical_amounts(advisor_text)
    if _ANY_FIGURE.search(canonical):
        return None
    found: str | None = None
    for sentence in split_sentences(_tail(advisor_text)):
        folded = fold(sentence)
        if (is_question_like(sentence) or "?" in sentence) and _BUDGET_QUESTION.search(folded):
            return PRICE_CUE_BUDGET
        if _COST_TALK.search(folded):
            found = PRICE_CUE_COST
    return found


def no_commit_spec(spec: NegotiationSpec) -> NegotiationSpec:
    """A stall reason's ``spec`` without the "before you agree to anything" priming (SWEEP-3).

    N-QUESTION is left as it is: ``question_spec`` words it by the advisor's ask.
    """
    brief = NO_COMMIT_BRIEFS.get(spec.id)
    if brief is None or spec.id == N_QUESTION:
        return spec
    return replace(spec, brief=brief, variants=NO_COMMIT_VARIANTS.get(spec.id, spec.variants))


def question_spec(ask: AskKind | None, *, no_commit: bool = False) -> NegotiationSpec:
    """N-QUESTION worded for ``ask``: "the call" only when the advisor proposed a call.

    ``no_commit`` (SWEEP-3) drops the "before you agree to anything" priming.
    """
    spec = SPEC_BY_ID[N_QUESTION]
    if ask is AskKind.CALL:
        if no_commit:
            return replace(
                spec, brief=NO_COMMIT_BRIEFS[N_QUESTION], variants=NO_COMMIT_VARIANTS[N_QUESTION]
            )
        return spec
    if no_commit:
        return replace(spec, brief=N_QUESTION_ENROL_BRIEF_V2, variants=N_QUESTION_ENROL_VARIANTS_V2)
    return replace(spec, brief=N_QUESTION_ENROL_BRIEF, variants=N_QUESTION_ENROL_VARIANTS)


# The reaction before the scripted WEAK line at 19:00 (the line itself stays scripted and masked).
COMMIT_REACTION_BRIEF = (
    "react to what the advisor just said in one short, friendly sentence, and say nothing about "
    "thinking it over, e-mail or getting back to them, because the closing line follows "
    "separately"
)
# M032 SWEEP-25 B (flag R1_COMMIT_REACTION_V2; a95398ab #60: the reaction said she had to go and
# asked for the documents, then the WEAK line asked for the e-mail again).  New wording under
# D-M032-4, listed for review; the guard drops a goodbye left in it all the same.
COMMIT_REACTION_BRIEF_V2 = (
    "react to what the advisor just said in one short, friendly sentence; do not say goodbye or "
    "that you have to go, and say nothing about thinking it over, e-mail, sending anything or "
    "getting back to them, because the closing line follows separately"
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

# M032 SWEEP-19 (flag R1_COUNTER_V2): the counter matches the number actually on the table.  A met
# price is checked as the final price and never pushed lower (PRICE_MET_NOTE says so on every other
# turn); a price far below anything she expected, or free, is met with a careful buyer's surprise,
# never relief; the scripted counters lose their "[ack], but" hinge.  ``COUNTERS`` stays for the
# flag off.  Every variant proves F1-COUNTER's markers (r1_scheduler: "final price", "final
# number", "lower", "better", "room", "anything at all" ...).
SITUATION_FAR_BELOW = "far_below"
SITUATION_CONFLICT = "conflict"
COUNTERS_V2: tuple[CounterSituation, ...] = (
    CounterSituation(
        SITUATION_SHORT,
        COUNTER_BY_SITUATION[SITUATION_SHORT].brief,
        (
            "I was hoping for a bit less than that. Can you go a little lower?",
            "Could you do a little better than that for me?",
            "It's still more than I planned for. Is there any more room on the price?",
        ),
    ),
    CounterSituation(
        SITUATION_MET,
        "the advisor's price is at or below your ask; sound relieved, check it is the final price "
        "with nothing added later, and do not ask for less or accept it",
        (
            "Oh, that would really help. And is that the final price, with nothing added on top "
            "later?",
            "That's a relief. Just so I'm sure, is that the final price, all in?",
            "Okay, that helps a lot. Is that the final number, or would anything get added later?",
        ),
    ),
    CounterSituation(
        SITUATION_REFUSED,
        COUNTER_BY_SITUATION[SITUATION_REFUSED].brief,
        (
            COUNTER_BY_SITUATION[SITUATION_REFUSED].variants[0],
            "Would anything at all make it easier, like a payment plan?",
            COUNTER_BY_SITUATION[SITUATION_REFUSED].variants[2],
        ),
    ),
    COUNTER_BY_SITUATION[SITUATION_UNCLEAR],
    CounterSituation(
        SITUATION_FAR_BELOW,
        "the advisor's price is far below anything you expected; sound surprised and a little "
        "wary rather than relieved, check it is really the final price with nothing added later, "
        "and do not accept it",
        (
            "Wait, that's far lower than I expected. Is that really the final price, with nothing "
            "added later?",
            "That's a lot less than I thought. Is that the final number, all in?",
            "Really? That surprises me. Is that the final price, or is there a catch?",
        ),
    ),
)
COUNTER_V2_BY_SITUATION = {item.id: item for item in COUNTERS_V2}
# Simulation diagnosis 1 (L3): the advisor questions where her $7,000 came from ("Who told you
# that?", "Where did you hear that?", "those figures aren't verified").
_FIGURE_SOURCE_CHALLENGE = re.compile(
    r"\bwho (?:told|said|gave) (?:you|that)\b"
    r"|\bwhere did you (?:get|hear|read|see|find) (?:that|this|it|those|these|the)\b"
    r"|\b(?:not|aren'?t|isn'?t|weren'?t|wasn'?t) (?:verified|true|real|accurate|correct)\b"
    r"|\bsupposedly\b"
    r"|\bname (?:anyone|someone|the (?:people|person))\b",
    re.IGNORECASE,
)


def challenges_her_figure(text: object) -> bool:
    """L3: an advisor turn that questions the source of her figure."""
    return _FIGURE_SOURCE_CHALLENGE.search(fold(text)) is not None


# Simulation diagnosis 1 (L3, flag R1_PRICE_ASKED_ONCE): the unclear counter's brief read "the
# advisor's answer on price was not clear", and the model said so out loud ("your answer wasn't
# clear to me") to an advisor who had named the price.  Same variants, no verdict on his answer.
UNCLEAR_COUNTER_V3 = CounterSituation(
    SITUATION_UNCLEAR,
    "you still do not know what the price would come to for you, so ask what it would come to, "
    "all in",
    COUNTER_BY_SITUATION[SITUATION_UNCLEAR].variants,
)
# Simulation diagnosis 2 (HF3, U1; the engine's R1_INTENT_TAIL_V3): F1-COUNTER's completion
# statements per situation (``r1_scheduler.TAIL_COMPLETIONS``).  A reply that already asked about
# the price gets one of these, never a second question; each proves F1-COUNTER's unchanged markers.
_COUNTER_FINAL_COMPLETIONS = (
    "That final number is what I need.",
    "I'd still need the final price, all in.",
)
_COUNTER_MET_COMPLETIONS = (
    "I'd just want to know that's the final price.",
    "As long as that's the final number.",
)
# The same for the negotiation lines whose tail most often said her point again (the e-mail yes
# after "sending a summary would help", the price asked twice in other words).
NEGOTIATION_COMPLETIONS: dict[str, tuple[str, ...]] = {
    N_PRICE_FIRST: ("So how much is it?",),
    N_EMAIL_YES: ("Please do send it.", "Please send it over."),
}
COUNTER_COMPLETIONS: dict[str, tuple[str, ...]] = {
    SITUATION_SHORT: ("Even a little lower would help.", "A bit lower would really help."),
    SITUATION_MET: _COUNTER_MET_COMPLETIONS,
    SITUATION_FAR_BELOW: _COUNTER_MET_COMPLETIONS,
    SITUATION_REFUSED: ("Even a payment plan would help.", "Anything at all would help."),
    SITUATION_UNCLEAR: _COUNTER_FINAL_COMPLETIONS,
    SITUATION_CONFLICT: _COUNTER_FINAL_COMPLETIONS,
}
# SWEEP-19 item 6: the advisor asked what number works for her while the counter is planned (only on
# a short or unclear answer): she names the $7,000 she heard as her hope.
YOUR_NUMBER_COUNTER_SUFFIX = (
    "; they asked what number works for you, so say you were hoping for something close to the "
    "$7,000 you heard and ask if they can come down to that"
)
# SWEEP-21: the advisor's price differs from the website's or from his own earlier offer while the
# counter is planned: one check, as a question.  ``{expected}`` and ``{source}`` are filled by
# ``conflict_counter``.
SITUATION_CONFLICT_BRIEF = (
    "the advisor named {amount}, which is not the {expected} you {source}; ask about the "
    "difference in your own words, as a question, and do not accept either number"
)
SITUATION_CONFLICT_WEBSITE_VARIANTS = (
    "Wait, didn't the website say $9,000? So what's the actual price for me?",
    "Sorry, I'm a bit lost. Is it $9,000 or {amount}? What's the final price?",
)
SITUATION_CONFLICT_RISE_VARIANTS = (
    "Hold on, earlier you said {earlier}. So what's the actual price now?",
    "Sorry, I'm a bit lost. Is it {earlier} or {amount}? What's the final price?",
)


def conflict_counter(kind: str, amount_usd: int, earlier_usd: int | None) -> CounterSituation:
    """F1-COUNTER for a price conflict (SWEEP-21): ``kind`` is "website" or "rise"."""
    amount = _usd(amount_usd)
    if kind == "rise" and earlier_usd is not None:
        earlier = _usd(earlier_usd)
        brief = SITUATION_CONFLICT_BRIEF.format(
            amount=amount, expected=earlier, source="heard from them earlier"
        )
        variants = tuple(
            text.format(amount=amount, earlier=earlier) for text in SITUATION_CONFLICT_RISE_VARIANTS
        )
    else:
        brief = SITUATION_CONFLICT_BRIEF.format(
            amount=amount, expected=WEBSITE_PRICE, source="saw on the website"
        )
        variants = tuple(text.format(amount=amount) for text in SITUATION_CONFLICT_WEBSITE_VARIANTS)
    return CounterSituation(SITUATION_CONFLICT, brief, variants)


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


def anchor_after_offer(
    offer_usd: int,
    *,
    probe_first: bool = False,
    counter_v2: bool = False,
    situational: bool = False,
    advisor_said_anchor: bool = False,
    reacted: bool = False,
) -> AnchorSituation:
    """The anchor that reacts to ``offer_usd``, the best price already on the table.

    M032: ``probe_first`` (S2P, SWEEP-16 item 2) words the briefs as objectives in the form of the
    probe-first anchor (no "has already come down", which presumes a discount, and no banned
    phrase); ``counter_v2`` (SWEEP-19 item 5) takes the "[ack], but" hinge out of the third ABOVE
    variant.  Must-say figures, the $7,000 marker and the request are unchanged.

    ``situational`` (simulation diagnosis 2, MF3; the engine's R1_PRICE_STORY): a price under
    the $7,000 is answered for the situation (``_below_anchor_situation``).
    """
    amount = _usd(offer_usd)
    if offer_usd > ANCHOR_USD:
        third = (
            f"I heard it went for around $7,000, and {amount} is still a big number for me. "
            "Can you match that?"
            if counter_v2
            else f"Okay, but {amount} is still a big number for me, and I heard it went for "
            "around $7,000. Can you match that?"
        )
        brief = (
            f"the advisor's price is {amount}, still more than you planned to spend; say so in "
            "your own words, say you heard someone got it for around $7,000, and ask whether they "
            "could match that"
            if probe_first
            else f"the advisor has already come down to {amount}; tell the advisor that is still a "
            "lot for you, that you heard people got it for around $7,000, and ask if they can "
            "do that"
        )
        return AnchorSituation(
            ANCHOR_ABOVE,
            brief,
            (amount, "$7,000"),
            (
                f"{amount} is still a lot for me, and I heard people got it for around $7,000. "
                "Can you do that?",
                f"{amount} is still more than I planned for, and I read some people paid about "
                "$7,000. Is that possible?",
                third,
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
            f"the advisor's price is {amount}, which is the very figure you heard someone paid; "
            f"{brief_tail}"
            if probe_first
            else f"the advisor has already put {amount} on the table, the very price you heard "
            f"people got it for; {brief_tail}",
            (amount,),
            (
                "That's right at the $7,000 I heard people got it for. What exactly does that "
                "price include?",
                "That matches the $7,000 I read people paid.",
                "I heard about $7,000, so that is in line with what I read.",
            ),
        )
    if situational:
        picked = _below_anchor_situation(
            offer_usd, advisor_said_anchor=advisor_said_anchor, reacted=reacted
        )
        if picked is not None:
            return picked
    # Below the $7,000: it is NOT "in line with what you heard" (the live sweep: "That lines up with
    # what I'd heard ... $4,500 is under the $7,000 I read about", one reply, two opinions).
    below_tail = (
        "you note calmly that it is even below the $7,000 you heard, with no surprise and no "
        "thanks, and you may ask what is included at that price; you do not ask whether it is the "
        "final price"
    )
    if situational:
        below_tail += "; you never call it good news or good to know"  # MF3
    return AnchorSituation(
        ANCHOR_REACHED,
        f"the advisor's price is {amount}, below the $7,000 you heard someone paid; {below_tail}"
        if probe_first
        else f"the advisor has already put {amount} on the table, below the $7,000 you heard "
        f"people got it for; {below_tail}",
        (amount, "$7,000"),
        (
            f"{amount} is even below the $7,000 I heard people got it for. What exactly does "
            "that price include?",
            f"{amount} is under the $7,000 I read about.",
            f"I heard people paid about $7,000, and {amount} is below that.",
        ),
    )


# Simulation diagnosis 2 (MF3): the anchor below the $7,000 had one brief ("note calmly that it is
# even below the $7,000 you heard") whatever had happened: the advisor had named the $7,000 himself
# ("3000, better than 7000"), she had already reacted to this very price ("a price that low makes me
# suspicious"), or the price was a fraction of it, and the model said "which is good to know" in the
# middle of a price objection.  Each keeps the $7,000 marker and the must-say figures (new wording
# under D-M032-4, listed for review).
ANCHOR_FAR_BELOW_SHARE = 0.5
ANCHOR_ECHOED = "echoed"
ANCHOR_REACTED = "reacted"
ANCHOR_WARY = "wary"


def _below_anchor_situation(
    offer_usd: int, *, advisor_said_anchor: bool, reacted: bool
) -> AnchorSituation | None:
    """MF3: the anchor for a price under the $7,000 in a situation, or None (the default)."""
    if offer_usd >= ANCHOR_USD:
        return None
    amount = _usd(offer_usd)
    if advisor_said_anchor:
        return AnchorSituation(
            ANCHOR_ECHOED,
            f"the advisor named {amount} and mentioned the $7,000 himself; agree that you had "
            f"heard about $7,000 too, and say that is why {amount} makes you want to know what is "
            "included; never pleased, never thankful",
            (amount, "$7,000"),
            (
                f"I'd heard about $7,000 too, so {amount} makes me want to know what's included.",
                f"I'd heard $7,000 as well, which is why {amount} makes me ask what's in it.",
            ),
        )
    if reacted:
        return AnchorSituation(
            ANCHOR_REACTED,
            f"you already reacted to {amount}; give the $7,000 you heard as the reason for that "
            f"reaction (since you had heard about $7,000, {amount} makes you wonder what is left "
            "out), without repeating the reaction itself; never pleased, never thankful",
            (amount, "$7,000"),
            (
                f"Since I'd heard about $7,000, {amount} makes me wonder what's left out.",
                f"I'd heard about $7,000, so {amount} has me wondering what's missing.",
            ),
        )
    if offer_usd < ANCHOR_USD * ANCHOR_FAR_BELOW_SHARE:
        return AnchorSituation(
            ANCHOR_WARY,
            f"{amount} is far below the $7,000 you heard someone paid; sound wary, never pleased "
            "or thankful and never call it good news, and ask what is left out at that price",
            (amount, "$7,000"),
            (
                f"{amount} is well below the $7,000 I heard someone paid, so what's left out?",
                f"I heard about $7,000, so {amount} makes me wary. What's not included?",
            ),
        )
    return None


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


# M032 S2P (D-M032-7, S2 item 10): F1-ANCHOR when no lower price is on the table.  The advisor
# STATED a price (``ANCHOR_STATED``: she reacts to his number; a number at least $300 away from the
# website's adds the one conflict check, ``ANCHOR_STATED_CONFLICT``), or nobody told her the price
# after two price questions, past the probe deadline or on the forced path (``ANCHOR_CHECK``: the
# $9,000 she thinks she saw is a check, never a statement), or he talked about giving it for free
# (``ANCHOR_FREE``, SWEEP-19).  Every form keeps the $7,000 marker and must-say and a request.
ANCHOR_STATED = "stated"
ANCHOR_STATED_CONFLICT = "stated_conflict"
ANCHOR_CHECK = "check"
ANCHOR_FREE = "free"
# Simulation diagnosis 3 (D3-LRN-PRICE1, the engine's R1_FOREIGN_PRICE): the advisor named the
# course price in rupees or lakhs; she is in the US, so she checks it in dollars (the website's
# $9,000) and keeps the $7,000 marker and the request, like the check form.
ANCHOR_FOREIGN = "foreign"
WEBSITE_PRICE = "$9,000"
# The website's $9,000 and a stated price at least this far from it are a conflict (SWEEP-21).
CONFLICT_MIN_GAP_USD = 300


def anchor_after_stated(stated_usd: int) -> AnchorSituation:
    """The anchor that reacts to the course price the advisor stated (S2.10, probe first)."""
    amount = _usd(stated_usd)
    if abs(stated_usd - PRICE_USD) >= CONFLICT_MIN_GAP_USD:
        return AnchorSituation(
            ANCHOR_STATED_CONFLICT,
            f"the advisor said the price is {amount}, but you thought the website said around "
            "$9,000; check that once in your own words as a short question, then say you heard "
            "someone got it for around $7,000 and ask whether they could do that for you; do not "
            "accept either number",
            (amount, WEBSITE_PRICE, "$7,000"),
            (
                f"Oh, {amount}? I thought the website said around $9,000. Either way, I heard "
                "someone paid about $7,000. Could you do that?",
                f"Wait, I thought I saw about $9,000 on the website, not {amount}. Someone told me "
                "they paid around $7,000. Is that possible?",
                f"Hmm, {amount}? I had around $9,000 in my head from the website. I heard of "
                "someone paying about $7,000, could you do that?",
            ),
        )
    return AnchorSituation(
        ANCHOR_STATED,
        f"the advisor said the price is {amount}, more than you planned to spend; say so in your "
        "own words, say you heard someone got it for around $7,000, and ask whether they could do "
        "that for you",
        (amount, "$7,000"),
        (
            f"{amount} is more than I planned to spend. I heard someone got it for around $7,000. "
            "Could you do that for me?",
            f"Hmm, {amount} is a lot for me. Someone told me they paid about $7,000. Is that "
            "possible?",
            f"{amount} is more than I was expecting to pay. I heard about $7,000 from someone, "
            "could you do that?",
        ),
    )


def anchor_check() -> AnchorSituation:
    """The anchor when nobody has told her the price (S2.10's check form, probe first)."""
    return AnchorSituation(
        ANCHOR_CHECK,
        "nobody has told you the price yet; say you think you saw about $9,000 on the website and "
        "check whether that is right, then say you heard someone got it for around $7,000 and ask "
        "whether they could do that for you",
        (WEBSITE_PRICE, "$7,000"),
        (
            "I think I saw about $9,000 on the website, is that right? I heard someone got it for "
            "around $7,000. Could you do that?",
            "Is it about $9,000? That's what I think I saw on the website. Someone told me they "
            "paid around $7,000, is that possible?",
            "I think the website said around $9,000, is that right? I heard of someone paying "
            "about $7,000, could you do that for me?",
        ),
    )


def anchor_after_free() -> AnchorSituation:
    """The anchor when the advisor talked about giving the course for free (SWEEP-19)."""
    return AnchorSituation(
        ANCHOR_FREE,
        "the advisor talked about giving you the course for free; say that surprises you, that you "
        "had heard people paid around $7,000, and ask what the catch is; do not accept anything",
        ("$7,000",),
        (
            "Wait, free? I'd heard people paid around $7,000 for it, so what's the catch?",
            "Free? That surprises me, I heard it was around $7,000. What's the catch?",
            "Hold on, free? I'd heard about $7,000. What would I end up paying?",
        ),
    )


def anchor_after_foreign() -> AnchorSituation:
    """The anchor when the advisor named the price in rupees (D3-LRN-PRICE1)."""
    return AnchorSituation(
        ANCHOR_FOREIGN,
        "the advisor named the price in rupees; you are in the US, so say you were expecting "
        "dollars and check whether it is about $9,000 as you think you saw on the website, then "
        "say you heard someone got it for around $7,000 and ask whether they could do that",
        (WEBSITE_PRICE, "$7,000"),
        (
            "Rupees? I'm in the US, so I was thinking in dollars. Is it about $9,000, like I saw "
            "on the website? I heard someone paid around $7,000. Could you do that?",
            "Oh, in rupees? I was expecting dollars, I'm in the US. Is it around $9,000? That's "
            "what I think I saw on the website. Someone told me they paid about $7,000, is that "
            "possible?",
            "Sorry, rupees? I'm in the US, so I had dollars in mind. I think the website said "
            "around $9,000, is that right? I heard of someone paying about $7,000, could you do "
            "that for me?",
        ),
    )


# D3-LRN-PRICE1: a figure in rupees, lakhs or crores ("fifteen thousand rupees", "Rs 1,20,000",
# "3 lakh"), read on the text BEFORE ``canonical_amounts`` (which writes "fifteen thousand" as
# "$15000").  A course-price frame must lead into it ("the fee is", "it costs", "the course is")
# or follow it ("for the full course", "in total").
# Review D3R-4: a figure starts with a digit or a number word ("a" only as "a lakh" / "a crore"),
# so "a rupee amount" is no figure; "and", "a" and "point" only continue one ("one and a half").
_NUMBER_START = (
    r"(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|"
    r"fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|"
    r"eighty|ninety|hundred|thousand|half)"
)
_NUMBER_WORDS = r"(?:" + _NUMBER_START[3:-1] + r"|and|a|point)"
_FIGURE = (
    r"(?:\d[\d,.]*|" + _NUMBER_START + r"|a(?=\s+(?:lakhs?|lacs?|crores?)\b))"
    r"(?:[\s-]+(?:\d[\d,.]*|" + _NUMBER_WORDS + r"))*"
)
_FOREIGN_FIGURE = re.compile(
    r"(?:(?:\u20b9|\brs\.?|\binr)\s*\d[\d,.]*(?:\s*(?:lakhs?|lacs?|crores?|k)\b)?"
    r"|\b" + _FIGURE + r"\s*(?:lakhs?|lacs?|crores?)\b(?:\s+(?:indian\s+)?(?:rupees?|inr))?"
    r"|\b" + _FIGURE + r"\s+(?:indian\s+)?(?:rupees?|inr)\b)",
    re.IGNORECASE,
)
# Review D3R-4: the price frame binds to the figure ("the fee is", "it costs", "the course is",
# "you'll pay about"), with only hedges between them; "the course" thirty characters back ("after
# the course you can earn 10 lakh") or a bare "pay" ("companies pay 12 lakh") frames nothing.
_FOREIGN_FRAME_BEFORE = re.compile(
    r"(?:\b(?:fees?|price|pricing|costs?|costing|tuition|total)(?:'s)?"
    r"|\b(?:course|program(?:me)?)(?:'s| is| was| costs?| comes to| would be| will be)"
    r"|\b(?:it|that|this)(?:'s| is| was| would be| will be| costs?| comes to| would cost|"
    r" will cost)"
    r"|\b(?:you|you'll|you'd|you will|you would)(?: need to| have to| be)? (?:pay|paying|invest)"
    r"|\bcomes? to)"
    r"(?:\s+(?:is|are|was|of|would be|will be|comes to|come to|just|only|about|around|roughly|"
    r"approximately|approx|nearly|like|for (?:the|this) (?:course|program(?:me)?)))*\s*$",
    re.IGNORECASE,
)
# Review D3R-4: earnings ("earn 10 lakh", "20 lakh packages", "a salary of") are never the price.
_EARNINGS_BEFORE = re.compile(
    r"\b(?:earn\w*|salar\w*|packages?|ctc|income|make|makes|making|get paid|hike)\b[^.?!,]{0,25}$",
    re.IGNORECASE,
)
_EARNINGS_AFTER = re.compile(
    r"^\W*(?:packages?|salar\w*|ctc|per annum|p\.?a\.?\b|a year|per year|annually|jobs?|offers?)",
    re.IGNORECASE,
)
_FOREIGN_FRAME_AFTER = re.compile(
    r"^\W*(?:for (?:the )?(?:full |whole |entire )?(?:course|program(?:me)?)|in total|total|"
    r"all in|all together|altogether)\b",
    re.IGNORECASE,
)


def foreign_price_in(text: object) -> str | None:
    """The course price the advisor named in rupees in ``text`` (its words, lower case), or None.

    "The fee's fifteen thousand rupees for the full course" names a price; "my cousin earns two
    lakh a month" (no price frame) and "$9,000, which is about seven lakh rupees" after a dollar
    price in the same sentence stay a dollar price (the dollar figure is the price).
    """
    for sentence in split_sentences(str(text or "")):
        lowered = fold(sentence).lower()
        for match in _FOREIGN_FIGURE.finditer(lowered):
            before = lowered[: match.start()]
            if "$" in before or re.search(r"\bdollars?\b", before):
                continue
            after = lowered[match.end() :]
            if _EARNINGS_BEFORE.search(before) or _EARNINGS_AFTER.search(after):
                continue  # review D3R-4: a salary or a package, not the course price
            if _FOREIGN_FRAME_BEFORE.search(before) or _FOREIGN_FRAME_AFTER.search(after):
                return match.group(0).strip()
    return None


def mask_foreign_prices(text: str) -> str:
    """``text`` with every rupee figure written as "a rupee figure", so the dollar readers never
    take "fifteen thousand rupees" for $15,000 (D3-LRN-PRICE1)."""
    return _FOREIGN_FIGURE.sub("a rupee figure", text)


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
# M032 SWEEP-25 A1 (flag R1_WEAK_EMAIL_V2; a95398ab #60, 199e97c2 #82: "I'll send you the documents
# and the road map" was no e-mail offer, so the 19:00 WEAK line asked for the e-mail again).  The
# first frame of ``_EMAIL_OFFER`` also takes documents, brochures, PDFs and road maps, and no object
# the learner is to sign or that is for the enrolment, the registration, a payment or KYC ("I'll
# send you the documents to sign for enrolment" is paperwork, not information).
# Review S3R-8: the paperwork word may come first too ("the enrollment documents", "the KYC
# documents"), and "to be signed" / "and you can sign them" follow it.
_PAPERWORK_BEFORE = (
    r"(?<!enrolment )(?<!enrollment )(?<!enrolement )(?<!registration )(?<!kyc )(?<!admission )"
    r"(?<!payment )(?<!signing )(?<!onboarding )"
)
_MAIL_INFO_V2 = (
    r"(?:" + _MAIL_INFO + r"|" + _PAPERWORK_BEFORE + r"documents?|brochures?|pdfs?|road ?maps?)"
)
_NOT_PAPERWORK = (
    r"(?!\s+(?:to (?:be )?sign(?:ed)?|that (?:you )?(?:need to |have to |must )?sign|"
    r"for (?:you to sign|(?:the |your )?(?:enrol\w*|registration|payment|kyc|admission))|"
    r"and (?:you can |then |just )?sign)\b)"
)
_EMAIL_OFFER_V2 = (
    re.compile(
        r"\b" + _OFFER_FRAME + r"\s+" + _ADVERBS + _MAIL_VERB + r"\b" + _GAP + r"\b"
        + _MAIL_INFO_V2 + r"\b" + _NOT_PAPERWORK,
        re.IGNORECASE,
    ),
    *_EMAIL_OFFER[1:],
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
# Owner 2026-11-20: limited-time offers address timing under the India playbook.
_HANDLED_TIMING_PLAYBOOK = (_TIME_LIMIT,)
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


def detect_email_offer(text: object, *, v2: bool = False) -> bool:
    """The advisor offers to e-mail or send the details.

    Not a pitch about what the programme sends: "we'll send you the schedule once you enroll",
    "we will send you the link to the live class on Monday" and "we mail you a report every
    week" describe the programme (R1-Q round 2), so a match whose neighbourhood is a cadence, a
    programme timeline or class logistics is not an offer.  ``v2`` (M032 SWEEP-25, the engine's
    R1_WEAK_EMAIL_V2) also reads documents, brochures, PDFs and road maps, never paperwork.
    """
    folded = _tail(text).lower()
    form_talk = _EMAIL_WORD.search(folded) is None and _FORM_WORD.search(folded) is not None
    offers = _EMAIL_OFFER_V2 if v2 else _EMAIL_OFFER
    for sentence in split_sentences(folded):
        patterns = offers
        if not (form_talk and is_question_like(sentence)):
            patterns = (*offers, *_EMAIL_OFFER_PRONOUN)
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
# Simulation diagnosis 2 (ST1 (2)): the advisor promised to send it in writing ("I'll get the
# exact monthly figures sent over", "I'll put the breakdown in writing", "the email will have
# everything").
# ``detect_email_offer`` reads an offer; this reads a promise the WEAK line must not ask for again.
# Review of ST1: only a sending verb (send, e-mail, forward, write up) reads a promise from its
# object alone; put, pop, drop, share and get send nothing without a written channel or a sending
# word ("I'll get the figures sent over", "pop the details in an email", "share it by email"), so
# "Let me put it this way", "Let me get your details first" and "I'll share my screen" are none.
_PROMISES_SEND = re.compile(
    r"\b(?:i(?:'ll| will)|let me|we(?:'ll| will))\s+(?:\w+\s+){0,2}?(?:send|e-?mail|forward|"
    r"write up)\b(?!\s+back\b)[^.?!]{0,50}\b(?:figures|numbers|breakdown|details|summary|"
    r"everything|it all|info\w*|e-?mail|brochure|curriculum|options|stories|in writing)\b"
    r"|\b(?:i(?:'ll| will)|let me|we(?:'ll| will))\s+(?:\w+\s+){0,2}?(?:put|pop|drop|share|get)\b"
    r"(?!\s+back\b)[^.?!]{0,50}\b(?:in writing|in (?:an?|the) (?:e-?mail|message|summary)|"
    r"(?:by|via|over) e-?mail|in your inbox|(?:sent|emailed|e-mailed|forwarded) (?:over|across|"
    r"through|to you|your way)|(?:over|across) to you by)\b"
    r"|\b(?:the|my|an?|that) (?:e-?mail|summary|write-?up)\b[^.?!]{0,25}\bwill (?:have|include|"
    r"cover|set out|lay out)\b",
    re.IGNORECASE,
)


def promises_to_send(text: object) -> bool:
    """ST1 (2): the advisor promised to send her the details in writing ("I'll get the exact
    figures sent over", "I'll put the breakdown in writing", "the email will have everything")."""
    return any(_PROMISES_SEND.search(sentence) for sentence in split_sentences(_tail(text)))


# Simulation diagnosis 2 (SC2): the advisor puts the call after what her decline was waiting for
# ("once you've read it", "after you and your husband talk", "you can confirm or move it").
# Review of SC2: "we" is never the subject ("after we talk" is the call itself), the call word must
# stand outside the deferral ("After we talk, you'll feel better" names no call), and someone
# else's call ("tell him to call us", "have her call our office") proposes none to her.
_DEFERS_CALL = re.compile(
    r"\b(?:once|after|when|whenever)\s+(?:you(?:'ve| have)?|you and your \w+|you two|you both|"
    r"both of you|he|she|they)\b[^.?!]{0,40}?\b(?:read|looked|look|gone|go|seen|see|talked|"
    r"talk|spoken|speak|discussed|discuss|had a chance|reviewed|review|sat down|sit down)\b"
    r"|\b(?:confirm|move|change|cancel|reschedule|shift)\s+(?:it|that|the (?:call|time|slot|"
    r"day))\b",
    re.IGNORECASE,
)
_CALL_WORD = re.compile(
    r"\b(?:call|chat|check[- ]?in|catch up|follow[- ]?up|speak|talk|meet|pencil)\w*\b",
    re.IGNORECASE,
)


_THIRD_PARTY_CALLER = re.compile(
    r"\b(?:him|her|them|he|she|they|your \w+)\s+(?:to\s+)?$", re.IGNORECASE
)


def defers_call_until_after(text: object) -> bool:
    """SC2: an advisor sentence that proposes a call AFTER her reading or her talk with the decider,
    or leaves it to her to confirm or move."""
    for sentence in split_sentences(_tail(text)):
        deferral = _DEFERS_CALL.search(sentence)
        if deferral is None:
            continue
        blank = " " * len(deferral.group(0))
        rest = sentence[: deferral.start()] + blank + sentence[deferral.end() :]
        for call in _CALL_WORD.finditer(rest):
            if _THIRD_PARTY_CALLER.search(rest[: call.start()]) is None:
                return True
    return False


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


# M032 SWEEP-6 (flag R1_PRICE_MEMORY): the advisor asks HER what price or what monthly amount
# would work ("Okay, what number works for you?", "What could you pay each month?", "What's your
# budget?").  A question-like sentence addressed to her; a check-in is not one.  The forms that
# could be about effort ("how much can you manage?") need a money word, and so does a sentence
# with a time word ("What number of hours works for you?").  The engine reads it only once the F1
# anchor is delivered, so "what number works for you?" alone is about the price.
_HER_NUMBER = _compile(
    r"\bwhat (?:number|price|amount|figure|budget)\b[^.?!]{0,40}\b(?:works?|would work|suits?|"
    r"fits?|in mind|comfortable|(?:can|could|would) you (?:do|afford|pay|manage|spend))\b",
    r"\bwhat(?:'s| is) your (?:budget|number|price range|range|price)\b",
    r"\bhow much (?:can|could|would|are) you (?:pay|afford|spend|manage|willing|able|comfortable|"
    r"looking)\b",
    r"\bwhat (?:can|could|would) you (?:pay|afford|spend|manage)\b",
    r"\bwhat (?:were|are) you (?:hoping|looking|expecting|planning) to (?:pay|spend)\b",
)
_HER_NUMBER_NEEDS_MONEY = _compile(
    r"\bhow much (?:can|could|would|are) you (?:manage|willing|able|comfortable|looking)\b",
    r"\bwhat (?:can|could|would) you manage\b",
)
_MONEY_CUE = re.compile(
    r"\$|\b(?:pay|paying|afford|spend|budget|price|fee|fees|invest|dollars?|cost|money|emi|"
    r"instal+ments?)\b",
    re.IGNORECASE,
)
_TIME_CUE_WORDS = re.compile(r"\b(?:hours?|week|weekly|weeks|time|evenings?)\b", re.IGNORECASE)
# Review S7L-R6/R4: with no money word, "number" is a contact number, a callback or a count ("What
# number works for you for the follow-up call?", "What number of sessions works for you?"), and a
# figure that works for someone else is theirs ("What figure would work for your manager?").
_NOT_HER_PRICE = re.compile(
    r"\b(?:number|amount|figure) of\b"
    r"|\b(?:call|calls|calling|callback|phone|mobile|whatsapp|reach|contact|text|message|"
    r"follow[- ]?up|sessions?|classes|modules?|students?|people|days?)\b"
    r"|\b(?:works?|work|suits?|fits?) for your\b",
    re.IGNORECASE,
)
_MONTHLY_CUE = re.compile(r"\b(?:month|months|monthly|emi|instal+ments?)\b", re.IGNORECASE)
YOUR_NUMBER_TOTAL = "total"
YOUR_NUMBER_MONTHLY = "monthly"


# Simulation diagnosis 2 (ST1 (4), the engine's R1_STALL_MEMORY): the same question with no "you"
# ("What monthly amount would feel workable?"): a money noun and a "for her" predicate.
# Review of ST1 (4): the predicate is about her: "feel / be / seem" with a judging word ("would be
# comfortable"), or "work / suit / fit" ending the question or "for you"; never "work out to" or a
# bare "would be" ("So what does the monthly payment work out to? About 600." quotes it himself).
_HER_NUMBER_BARE = re.compile(
    r"^\W*(?:(?:so|and|okay|ok|then|right)\W+)*(?:what|how much)\b[^?]{0,30}\b(?:amount|number|"
    r"figure|budget|payment|price|monthly|a month|per month|each month)\b[^?]{0,25}\b(?:"
    r"(?:feels?|would (?:feel|be|seem)|seems?|sounds?)\s+(?:\w+\s+)?(?:workable|manageable|doable|"
    r"comfortable|realistic|affordable|right|okay|ok|for you)\b"
    r"|(?:works?|would work|suits?|would suit|fits?|would fit)(?:\s+(?:best|for you))?\s*(?:\?|$))",
    re.IGNORECASE,
)
_SELF_ANSWER = re.compile(r"\$\s?\d|\b\d{2,}\b")


def her_number_question(text: object, *, bare: bool = False) -> str | None:
    """``"monthly"`` or ``"total"`` when the advisor asks what she could pay, else None.

    ``bare`` (ST1 (4)): a short money question with no "you" counts as put to her too.
    """
    sentences = split_sentences(text)
    for index, sentence in enumerate(sentences):
        lowered = fold(sentence).lower()
        if not is_question_like(lowered):
            continue
        if (
            bare
            and _HER_NUMBER_BARE.search(lowered)
            and not _NOT_HER_PRICE.search(lowered)
            # A figure he gives right after the question answers it himself.
            and not any(_SELF_ANSWER.search(later) for later in sentences[index + 1 :])
        ):
            return YOUR_NUMBER_MONTHLY if _MONTHLY_CUE.search(lowered) else YOUR_NUMBER_TOTAL
        if not re.search(r"\byou(?:r)?\b", lowered):
            continue
        if any(pattern.search(lowered) for pattern in _CHECKIN):
            continue
        if not any(pattern.search(lowered) for pattern in _HER_NUMBER):
            continue
        money = _MONEY_CUE.search(lowered) is not None
        if not money and (
            _TIME_CUE_WORDS.search(lowered) is not None
            or _NOT_HER_PRICE.search(lowered) is not None
            or any(pattern.search(lowered) for pattern in _HER_NUMBER_NEEDS_MONEY)
        ):
            continue
        return YOUR_NUMBER_MONTHLY if _MONTHLY_CUE.search(lowered) else YOUR_NUMBER_TOTAL
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


def reasons_handled_in(
    text: object, decision_maker: str = "", *, playbook: bool = False
) -> frozenset[str]:
    """The stall reasons the advisor's ``text`` speaks to (it must still follow the reason)."""
    folded = _tail(text).lower()
    found: set[str] = set()
    own = re.escape(decision_maker.lower()) + "|" if decision_maker else ""
    dm_pattern = re.compile(r"\b(?:" + own + _DM_WORDS + r")\b")
    verb_pattern = re.compile(r"\b" + _HANDLED_DM_VERB + r"\w*\b")
    for sentence in split_sentences(folded):
        if (any(pattern.search(sentence) for pattern in _HANDLED_TIMING)
                or (playbook and any(p.search(sentence) for p in _HANDLED_TIMING_PLAYBOOK))):
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
    # "$1000 EMI option monthly", "$600 monthly" (L5, mock call aa166f09 turn 106).  Not "$6000
    # EMI is also available" / "$6000 EMI options available" (repair, round 2): that figure is
    # the total, and EMI is what comes with it (``_MONTHLY_AFTER``'s lookahead).
    r"|(?:emis?|monthly)\b(?!\s+(?:options?|plans?|facilit(?:y|ies)|available|possible|also|too|"
    r"is|are|can|could|would|will)\b)"
    r"|(?:\w+\s+){0,2}(?:emi|instal+ment) (?:option|plan)s? monthly\b"
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
# M032 SWEEP-19 item 4 (with SWEEP-18's reader, one corpus run): "a ticket size of around 6000 USD",
# "it's priced at 6000", "our pricing is 6000" name the course price too.
_COURSE_PRICE_CUE_V2 = re.compile(
    _COURSE_PRICE_CUE.pattern[:-3] + r"|ticket(?:[- ]size)?|priced|pricing)\b",
    re.IGNORECASE,
)
_PRICE_WORD_V2 = re.compile(r"\b(?:ticket(?:[- ]size)?|priced|pricing)\b", re.IGNORECASE)
# Said while a figure is hedged: "I'll try for $8,000", "let me see if I can do $8,000".
_HEDGE_BEFORE = re.compile(
    r"\b(?:might|may|maybe|perhaps|possibly|probably|hopefully|try(?:ing)?|see (?:if|what|"
    r"whether|how)|check(?:ing)?|ask(?:ing)?|find out|look(?:ing)? (?:at|into)|depends?|"
    r"depending|if (?:we|i) can|can'?t promise|no promise|not sure|should be able|could be able|"
    r"wish|if only|would love to|i'?d love to|would if i could)\b",
    re.IGNORECASE,
)
# ... and, for a figure the learner said, a rough one ("around", "close to", "the range").
# L5 (mock call aa166f09, turn 95: "Maybe we can offer you $6000 rather than $12000" parsed
# nothing).  A leading "maybe" or "perhaps" before a first-person offer verb is a filler, not a
# hedge: "maybe we can offer you", "perhaps I can give you".  "Maybe I can try for $8,000" and
# "we may be able to do $8,000" stay hedged (``try`` and ``may`` are hedges of their own).
_SOFT_OFFER_LEAD = re.compile(
    r"\b(?:maybe|perhaps)\s+(?=(?:i|we)\s+(?:can|will|could)\s+(?:\w+\s+)?(?:offer|give)\b)",
    re.IGNORECASE,
)
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
    hedge_before = _SOFT_OFFER_LEAD.sub(" ", before)
    if (
        _HEDGE_BEFORE.search(hedge_before) is not None
        or _HEDGE_AFTER.match(lowered[end:]) is not None
    ):
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
_NOT_A_SELLER = frozenset(INTERVIEWER_ADDRESS_NAMES) | frozenset(
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


@dataclass(frozen=True)
class _PieceReading:
    """What one piece of an advisor sentence put on the table (M032 SWEEP-18).

    ``explicit``: nets the advisor named as the price; ``derived``: nets worked out from a discount
    (a dollar amount off the base, or a percentage off it); ``total``: the piece names a resulting
    total at or above the list price ("so for you it is $9,000"), which is explicit too.
    """

    explicit: dict[int, bool]
    derived: dict[int, bool]
    total: bool = False


# M032 SWEEP-18: a resulting total named after a discount ("which brings it to 8.5k", "so for you
# it is $9,000", "it comes to $8,500"): it is the net, and it wins over the net worked out from the
# discount.  Read on the text just before the figure.
_RESULT_TOTAL_BEFORE = re.compile(
    r"\b(?:brings?|bringing|makes?|making|takes?|taking|puts?|putting)\s+"
    r"(?:it|that|this|the (?:price|fee|total|cost|course|program|programme))\s+"
    r"(?:down\s+|back\s+)?to\s+(?:just\s+|only\s+|about\s+|around\s+)?$"
    r"|\bso\s+(?:for you\s+)?(?:it(?:'s| is| will be| would be| comes to)|that(?:'s| is| comes to)|"
    r"you(?:'d| would| will|'ll)? pay)\s+(?:just\s+|only\s+)?$"
    r"|\b(?:comes?|coming)\s+(?:down\s+)?to\s+(?:just\s+|only\s+|about\s+|around\s+)?$"
    r"|\b(?:net|final|total|effective)\s+(?:price|fee|cost|amount)?\s*(?:of|is|would be|will be|"
    r"comes to)\s+$",
    re.IGNORECASE,
)
_RESULT_TOTAL_CHARS = 60


def _piece_offers(
    piece: str,
    own: frozenset[int] = frozenset(),
    *,
    require_cue: bool = False,
    rest_later: bool = False,
    rest_owed: bool = False,
    base_usd: int = PRICE_USD,
) -> dict[int, bool]:
    """Net prices (and whether each is conditional) offered in one piece of a sentence.

    The release before M032 SWEEP-18: a dollar discount always comes off the list price, and a
    derived net is added beside an explicit one (``_piece_reading`` with ``v2`` False).
    """
    reading = _piece_reading(
        piece,
        own,
        require_cue=require_cue,
        rest_later=rest_later,
        rest_owed=rest_owed,
        base_usd=base_usd,
    )
    return {**reading.explicit, **reading.derived}


def _piece_reading(
    piece: str,
    own: frozenset[int] = frozenset(),
    *,
    require_cue: bool = False,
    rest_later: bool = False,
    rest_owed: bool = False,
    base_usd: int = PRICE_USD,
    v2: bool = False,
    dollar_base_usd: int | None = None,
) -> _PieceReading:
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
    ``base_usd`` is the price a percentage comes off (``stated_price_usd``; the list price when
    the turn names none).

    M032 SWEEP-18 (``v2``, flag R1_OFFER_READER_V2): a dollar discount comes off
    ``dollar_base_usd`` (the price the advisor named, else the list price) instead of always the
    list price, and its net counts only below the list price (at or above it is a restatement); a
    resulting total named after the discount ("which brings it to 8.5k", "so for you it is $9,000")
    is explicit, and the caller keeps a derived net only when the sentence names no explicit one.
    """
    empty = _PieceReading({}, {})
    # "$6500, which is ..." keeps its comma: the amount grammar would swallow it, and with it the
    # clause boundary the refusal and hedge checks read.
    lowered = canonical_amounts(re.sub(r"(\d),(?=\s)", r"\1 ,", piece)).lower()
    asked = is_question_like(piece)
    if asked and _INQUIRY.search(lowered):
        return empty
    # A question phrased as an offer promises the figure itself, so it needs no further promise;
    # any other question that names a figure is the advisor asking about it, not offering it.
    asked_as_offer = asked and _question_is_an_offer(lowered)
    if asked and not asked_as_offer:
        return empty
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
    cue_pattern = _COURSE_PRICE_CUE_V2 if v2 else _COURSE_PRICE_CUE
    if (
        require_cue and not asked_as_offer and not framed_any and not bare_off
        and cue_pattern.search(lowered) is None
    ):
        return empty
    conditional = _CONDITIONAL.search(lowered) is not None
    found: dict[int, bool] = {}
    discounts: set[int] = set()
    small: set[int] = set()
    percent_nets: dict[int, int] = {}  # SWEEP-18: a percentage's discount -> the net it leaves

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
            net = int(round(base_usd * (100 - float(match.group(1))) / 100))
            discount = PRICE_USD - net
            # The same floor as a dollar figure: "I gave you more than 90% discount" is no $900
            # offer (owner test 7f2a25e6 turn 58, the learner then named a price nobody said).  A
            # percentage off a higher stated price that leaves the list price or more is no offer.
            if net >= MIN_NET_USD and discount > 0:
                discounts.add(discount)
                percent_nets[discount] = net
    # SWEEP-19 item 4 (v2): "it's priced at 6000", "the ticket size is 6000" name a bare price too.
    price_cue = _PRICE_CUE.search(lowered) is not None or (
        v2 and _PRICE_WORD_V2.search(lowered) is not None
    )
    if price_cue or asked_as_offer or plain_acceptance or framed_any or bare_off:
        for value, start, end in bare:
            if not admitted(value, start, end):
                continue
            if low_net(value, start, end):
                found[value] = conditional
            elif MIN_NET_USD <= value < PRICE_USD and (
                price_cue or asked_as_offer or plain_acceptance or framed_any
            ):
                found[value] = conditional
            elif 0 < value < MIN_NET_USD and as_discount_at(start, end):
                small.add(value)
                if not _described_discount(lowered, start):
                    discounts.add(value)
    # Several small amounts in one sentence are a LIST of the deck's discounts, not an offer.
    derived: dict[int, bool] = {}
    single = len(discounts) == 1 and small <= discounts
    if not v2:
        if single:
            derived[PRICE_USD - next(iter(discounts))] = conditional
        return _PieceReading(found, derived)
    if single:
        discount = next(iter(discounts))
        if discount in percent_nets:
            net = percent_nets[discount]
        else:
            # SWEEP-18: a dollar discount comes off the price the advisor named.
            net = (dollar_base_usd or PRICE_USD) - discount
        if MIN_NET_USD <= net < PRICE_USD:
            derived[net] = conditional
    total = False
    for value, start, end in bare + dollars:
        if value is None:
            continue
        before = lowered[max(0, start - _RESULT_TOTAL_CHARS) : start]
        if _RESULT_TOTAL_BEFORE.search(before) is None or theirs(start) or part(value, start, end):
            continue
        if MIN_NET_USD <= value < PRICE_USD and admitted(value, start, end):
            found[value] = conditional  # "which brings it to 8.5k": the net, said
        elif PRICE_USD <= value <= MAX_LIST_USD:
            total = True  # "so for you it is $9,000": a total, not a lower price
    return _PieceReading(found, derived, total)


def parse_price_offers(
    text: object,
    own_amounts: Iterable[int] = (),
    *,
    require_cue: bool = False,
    v2: bool = False,
    base_usd: int | None = None,
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

    M032 SWEEP-18 (``v2``, flag R1_OFFER_READER_V2): a dollar discount comes off the price the
    advisor named in this turn (``stated_price_usd(..., v2=True)``: never a later-price threat or
    another batch's price), else ``base_usd`` (the negotiation's carry-over of the previous turn's
    stated price), else the list price; and a sentence that names its net (or a resulting total)
    keeps only that, never the net worked out from its discount as well.  A percentage still comes
    off the price ``stated_price_usd`` reads (L5), as before.
    """
    if v2:
        offers = _parse_price_offers_v2(
            text, own_amounts, require_cue=require_cue, base_usd=base_usd
        )
        base = stated_price_usd(text, v2=True) or base_usd or PRICE_USD
        return _reconcile_price_offers(text, offers, base)
    own = frozenset({ANCHOR_USD, *own_amounts})
    offers: dict[int, bool] = {}
    base = stated_price_usd(text) or PRICE_USD
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
                        base_usd=base,
                    )
                )
    return _reconcile_price_offers(text, sorted(offers.items(), reverse=True), base)


def _india_playbook_on() -> bool:
    return os.getenv("R1_INDIA_PLAYBOOK", "1").strip().lower() not in (
        "0", "off", "false", "no"
    )


def _total_reconcile_on() -> bool:
    return os.getenv("R1_DISCOUNT_TOTAL_RECONCILE", "1").strip().lower() not in (
        "0", "off", "false", "no"
    )


def _reconcile_price_offers(
    text: object, offers: list[tuple[int, bool]], base: int
) -> list[tuple[int, bool]]:
    if not _total_reconcile_on():
        return offers
    if len(offers) < 2 or not any(net in NET_PRICES_USD for net, _ in offers):
        return offers
    reconciled = [m for m in parse_discounts(text, reconcile=True) if m.heard_usd is not None]
    if len(reconciled) != 1:
        return offers
    mention = reconciled[0]
    total = PRICE_USD - mention.usd
    if not any(net == total for net, _ in offers):
        return offers
    phantom = base - mention.heard_usd
    return [(net, conditional) for net, conditional in offers
            if net != phantom or net == total]


def _parse_price_offers_v2(
    text: object,
    own_amounts: Iterable[int] = (),
    *,
    require_cue: bool = False,
    base_usd: int | None = None,
) -> list[tuple[int, bool]]:
    """``parse_price_offers`` with M032 SWEEP-18's reading (see there)."""
    own = frozenset({ANCHOR_USD, *own_amounts})
    offers: dict[int, bool] = {}
    percent_base = stated_price_usd(text) or PRICE_USD
    dollar_base = stated_price_usd(text, v2=True) or base_usd or PRICE_USD
    for sentence in split_sentences(_tail(text)):
        rest_later = _PART_LATER.search(sentence) is not None
        rest_owed = _REST_OWED.search(sentence) is not None
        explicit: dict[int, bool] = {}
        derived: dict[int, bool] = {}
        total = False
        for clause in _clauses(sentence):
            for piece in _pieces(clause):
                reading = _piece_reading(
                    piece,
                    own,
                    require_cue=require_cue,
                    rest_later=rest_later,
                    rest_owed=rest_owed,
                    base_usd=percent_base,
                    v2=True,
                    dollar_base_usd=dollar_base,
                )
                explicit.update(reading.explicit)
                derived.update(reading.derived)
                total = total or reading.total
        offers.update(explicit)
        if not explicit and not total:
            offers.update(derived)
    return sorted(offers.items(), reverse=True)


def stated_price_usd(text: object, *, v2: bool = False) -> int | None:
    """The course price the advisor states in this turn at or above the list price, if any.

    L5 (mock call aa166f09, turn 99: "it's coming with a 50% discount. If you start with a new
    batch, you would have to end up paying $12000." was read as $4,500, half of the $9,000 list
    price).  A percentage comes off the price the advisor named: the highest figure from the list
    price up to ``MAX_LIST_USD`` that is not an income, a competitor's price, someone else's
    payment, a part payment or a refused figure.  None when the turn names no such figure (the
    percentage then comes off the list price).  Review fix: the figure must be framed as the price
    (``_STATED_FRAME``: "the fee is", "you would end up paying", "costs", "normally", "off",
    "instead of"), and a saving, a value or an add-on ("You will save $10,000", "the $10,000
    masterclass is included") is none.

    M032 SWEEP-18 (``v2``): "rather than" frames the price as "instead of" does, and a sentence
    with a later-price threat or another batch's price (``r1_text.later_price_threat``) states
    none: "if you wait, you will have to pay $13000" is no base for a discount.
    """
    found: list[int] = []
    frame = _STATED_FRAME_V2 if v2 else _STATED_FRAME
    for sentence in split_sentences(_tail(text)):
        if v2 and later_price_threat(sentence, PRICE_USD):
            continue
        for clause in _clauses(sentence):
            for piece in _pieces(clause):
                lowered = canonical_amounts(re.sub(r"(\d),(?=\s)", r"\1 ,", piece)).lower()
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
                        and PRICE_USD <= value <= MAX_LIST_USD
                        and not _NOT_OURS_BEFORE.search(clause_before(lowered, start))
                        and not _third_party_seller(lowered, start, sellers)
                        and not negated_before(lowered, start, 8)
                        and not _PRICE_NO.search(clause_after(lowered, end))
                        and not _PART_AFTER.match(_UNIT_WORD.sub("", lowered[end:], count=1))
                        and frame.search(lowered[max(0, start - _STATED_SPAN) : start])
                        and not _STATED_NOT_PRICE.search(
                            lowered[max(0, start - _STATED_SPAN) : end + _STATED_SPAN]
                        )
                    ):
                        found.append(value)
    return max(found, default=None)


# How far around a figure ``stated_price_usd`` reads its frame (review fix).
_STATED_SPAN = 30
# The figure is the course's price: "the fee/price/course is", "costs", "you would (end up) pay",
# "normally", "originally", "off", "instead of", "it's".
_STATED_FRAME = re.compile(
    r"\b(?:fees?|price[sd]?|pricing|costs?|costing|course|program(?:me)?|pays?|paying|paid|"
    r"normally|usually|originally|regularly|list|off|instead of|(?:it|that|this)(?:'s| is| was| "
    r"would be| will be))\b[^$]{0,25}$",
    re.IGNORECASE,
)
# M032 SWEEP-18: "$6,000 for you rather than $12,000" names $12,000 as the price, like "instead of".
_STATED_FRAME_V2 = re.compile(
    r"\b(?:fees?|price[sd]?|pricing|costs?|costing|course|program(?:me)?|pays?|paying|paid|"
    r"normally|usually|originally|regularly|list|off|instead of|rather than|(?:it|that|this)"
    r"(?:'s| is| was| would be| will be))\b[^$]{0,25}$",
    re.IGNORECASE,
)
# A saving, a value, an add-on or a scholarship around the figure is no price for the course.
_STATED_NOT_PRICE = re.compile(
    r"\b(?:save|saves|saving|savings|value|valued|worth|included|includes|including|scholarships?|"
    r"masterclass(?:es)?|bonus|cheaper|less than|more than)\b",
    re.IGNORECASE,
)


# L5 (mock call aa166f09, turn 106: "$9000 same price for 9 months, $1000, $1000 EMI option
# monthly").  A monthly payment the advisor names: a figure followed by "a month", "per month",
# "monthly", "EMI" or "instalment(s)", or one after "EMIs of", "monthly payments of".  Review
# fix: the word must follow the figure directly.  A comma is a clause boundary ("$4,500, EMI
# options are there" is a total price and a note that EMIs exist; the figure's own thousands
# separator is read, a trailing comma is not), and "EMI" that goes on as "options are there",
# "available", "also possible" is no rate.
_MONTHLY_FIGURE = re.compile(r"\$\s?(\d+(?:,\d{3})*(?:\.\d+)?)\s*(k\b)?", re.IGNORECASE)
_MONTHLY_AFTER = re.compile(
    r"^\s*(?:(?:a|per|each|every|/)\s*month\b|monthly\b|"
    r"(?:as |in |an? )?(?:emis?|instal+ments?)\b(?!\s+(?:options?|plans?|facilit(?:y|ies)|"
    r"available|possible|also|too|is|are|can|could|would|will)\b)|"
    r"(?:\w+\s+){0,2}(?:emi|instal+ment) (?:option|plan)s? monthly\b)",
    re.IGNORECASE,
)
_MONTHLY_BEFORE = re.compile(
    r"\b(?:emis?|instal+ments?|monthly (?:payments?|instal+ments?|fees?|amount)|(?:pay|paying)"
    r" monthly)\s+(?:of|at|is|are|would be|will be|comes? to|around|about|just|only|roughly)?"
    r"\s*(?:just |only |about |around |roughly )?$",
    re.IGNORECASE,
)
# A monthly figure below this is no payment for the course ("$5 a month" is a subscription).
MIN_MONTHLY_USD = 50
# Every monthly payment above is said with one of these words, so a turn without any is skipped.
_MONTHLY_CUE = re.compile(r"month|\bemis?\b|instal", re.IGNORECASE)


def monthly_amounts(text: object) -> list[int]:
    """The monthly payments for the course the advisor names in ``text`` (L5).

    "$1000 EMI", "$1,000 a month", "1000 dollars per month", "EMIs of $1,500", "monthly payments of
    $800".  An income or a hike ("a salary hike of $1,000 a month", "earn $5,000 more per month")
    and a negated figure are not payments.
    """
    found: list[int] = []
    tail = _tail(text)
    if _MONTHLY_CUE.search(fold(tail)) is None:
        return found  # no "month", "EMI" or "instalment": nothing to read (and no slow fold)
    lowered = canonical_amounts(tail).lower()
    totals: set[int] | None = None
    for match in _MONTHLY_FIGURE.finditer(lowered):
        value = parse_amount(match.group(1), bool(match.group(2)))
        # Review fix: a figure at or above ``MIN_NET_USD`` is a price for the course, not a rate
        # ("I can do $5,000 monthly too if needed").
        if value is None or not MIN_MONTHLY_USD <= value < MIN_NET_USD:
            continue
        start, end = match.start(), match.end()
        after = _UNIT_WORD.sub("", lowered[end : end + _FRAME_CHARS], count=1)
        before = lowered[max(0, start - _FRAME_CHARS) : start]
        if _MONTHLY_AFTER.match(after) is None and _MONTHLY_BEFORE.search(before) is None:
            continue
        if _NOT_OURS_BEFORE.search(clause_before(lowered, start)) is not None:
            continue
        if re.match(r"^\s*(?:more|extra|additional|higher)\b", after) is not None:
            continue
        if negated_before(lowered, start, 8):
            continue
        if totals is None:
            # A figure this turn offers as the total price is no monthly rate as well.
            totals = {net for net, _conditional in parse_price_offers(text)}
        if value in totals:
            continue
        found.append(value)
    return found


# A stated price says "pay" ("Pay me $3,000 and it's yours"); a statistic said "over" or "more
# than" a figure ("over $5,000", "more than 2,500 dollars is the average hike") is no price.
_PAY_WORD = re.compile(r"\bpa(?:y|ys|ying|id)\b", re.IGNORECASE)
_ROUGH_BEFORE = re.compile(
    r"\b(?:over|more than|above|upwards of|in excess of|nearly|almost|around)\s+$", re.IGNORECASE
)


def unread_low_figures(
    text: object, own_amounts: Iterable[int] = (), *, v2: bool = False
) -> list[int]:
    """Figures under the $7,000 anchor the advisor named as a possible price, offered or not.

    The anchor's backstop (owner test 8f5bfefc review): a low price worded in a way
    ``parse_price_offers`` does not read ("Pay me $3,000 and it's yours") must not be answered
    with "$9,000 ... can you do $7,000?".  A discount, a part payment, an add-on, someone else's
    price, an income, a bound, a count ("5,000 alumni") and a refused or negated figure are none,
    and a figure (with a "$" or without) counts only next to a pricing word: "Over $5,000
    learners" or "a $2,000 referral bonus" in a pitch is no price (review round 2).  The caller
    drops the figures that were read as offers.  A figure the turn names as a monthly payment
    (``monthly_amounts``, also when it is said twice: "$1000, $1000 EMI option monthly") is a
    part of the price too.
    """
    own = frozenset({ANCHOR_USD, *own_amounts, *monthly_amounts(text)})
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
                    (_COURSE_PRICE_CUE_V2 if v2 else _COURSE_PRICE_CUE).search(lowered)
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


# M032 SWEEP-21: a total said with its frame after the figure ("we offer a $9,500 fee", "the $9,000
# program") or as the same total spread out ("the same $9,000 over nine months").
_TOTAL_AFTER = re.compile(
    r"^\s*(?:dollars?|usd)?\s*(?:course\s+|program(?:me)?\s+|tuition\s+)?"
    r"(?:fees?|price|tuition|total|in total|all in|overall|course|program(?:me)?)\b"
    r"|^\s*(?:dollars?|usd)?\s*(?:over|across|spread over|for)\s+(?:\w+\s+){0,2}?months?\b",
    re.IGNORECASE,
)
_TOTAL_BEFORE = re.compile(
    r"\b(?:the same|same|a total of|total of|in total|all in|overall)\s+(?:of\s+)?$",
    re.IGNORECASE,
)
# A figure the turn calls a value, a saving or an add-on, a scholarship ... is no total.
_TOTAL_NOT_PRICE_RE = re.compile(
    r"\b(?:save|saves|saving|savings|value|valued|worth|included|includes|including|scholarships?|"
    r"masterclass(?:es)?|bonus|cheaper|less than|more than|salary|salaries|earn\w*|hike)\b",
    re.IGNORECASE,
)
# Someone else's figure before a total, without ``_NOT_OURS_BEFORE``'s job nouns: "for the analyst
# track we offer a $9,500 fee" is the advisor's own price.
_TOTAL_NOT_OURS = re.compile(
    r"\b(?:salary|salaries|earn\w*|income|incomes|hike|ctc|lpa|stipend|take-home|compensation|"
    r"compared (?:with|to)|versus|vs|other (?:programs?|programmes?|courses?|bootcamps?|"
    r"institutes?|providers?|platforms?|universities)|competitors?|elsewhere|"
    r"(?:students?|alumni|alumnus|learners?|someone|somebody|people|others|candidates?|"
    r"professionals?|folks|they|he|she)\s+(?:\w+\s+){0,2}?(?:paid|got|took|"
    r"enrolled|joined|saved|received|availed|used|bought|spent)|"
    r"last (?:year|month|quarter|cohort|batch)|previously|used to|in the past|"
    r"(?:previous|prior|earlier|old|last) (?:cohort|batch|class|intake)|"
    r"bootcamps?|institutes?|universit\w+|colleges?|degrees?|market|industry|companies|"
    r"employers?|recruiters?|raise|typical\w*|average)\b",
    re.IGNORECASE,
)


# M032 S2P (the SWEEP-21 corpus check, 2026-11-12): the price the course goes back or up to after a
# deadline is a later price, never a total.  While the lower price stands it is an urgency lever
# ("That price is locked only if you deposit tonight. Tomorrow it's back to $9000.", "In a week the
# price is back to $9000"), so it raises no rise and no website check.  Read in the figure's own
# clause only, so "Tomorrow we can talk, but the course is $9,000." is still a total.
_LATER_TOTAL_FRAME = re.compile(
    r"\b(?:back (?:up )?to|(?:goes|go|going|will go|rises?|jumps?|reverts?|returns?|resets?) "
    r"(?:back )?(?:up )?to)\s+(?:about |around |roughly )?$",
    re.IGNORECASE,
)
_LATER_TOTAL_TIME = re.compile(
    r"\b(?:tomorrow|next (?:week|month)|in (?:a|one|two|three|a few|a couple of) (?:days?|weeks?)|"
    r"after (?:today|tonight|this week|the deadline|friday)|from (?:tomorrow|next week|monday))\b",
    re.IGNORECASE,
)
# The deadline said right after the figure ("resets to $9000 tomorrow", "$9,500 from next week").
_LATER_TOTAL_TIME_AFTER = re.compile(
    r"^\s*(?:dollars?\s+)?(?:again\s+)?(?:from\s+|starting\s+|after\s+)?(?:tomorrow|tonight|"
    r"next (?:week|month)|monday)\b",
    re.IGNORECASE,
)


def _later_total(lowered: str, start: int, end: int) -> bool:
    """The figure at ``start:end`` is the price after a deadline (``_LATER_TOTAL_*``)."""
    clause = clause_before(lowered, start)
    return bool(
        _LATER_TOTAL_FRAME.search(clause)
        or _LATER_TOTAL_TIME.search(clause)
        or _LATER_TOTAL_TIME_AFTER.match(lowered[end:])
    )


def stated_totals(text: object) -> list[int]:
    """The course totals at or above the list price the advisor names in ``text`` (SWEEP-21).

    The figures ``states_full_price`` accepts, plus a frame after the figure ("a $9,500 fee") and
    the same total spread out ("the same $9,000 over nine months").  A later-price threat or another
    batch's price, the price after a deadline ("Tomorrow it's back to $9000"), a value, a saving, an
    add-on, a salary, a refused or negated figure and someone else's price are none.  Ints only, in
    the order said.
    """
    found: list[int] = []
    for sentence in split_sentences(_tail(text)):
        if later_price_threat(sentence, PRICE_USD):
            continue
        for clause in _clauses(sentence):
            for piece in _pieces(clause):
                if is_question_like(piece):
                    continue
                lowered = canonical_amounts(re.sub(r"(\d),(?=\s)", r"\1 ,", piece)).lower()
                cue = _COURSE_PRICE_CUE.search(lowered) is not None
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
                    if value is None or not PRICE_USD <= value <= MAX_LIST_USD:
                        continue
                    window = lowered[max(0, start - _STATED_SPAN) : end + _STATED_SPAN]
                    after = lowered[end:]
                    framed = (
                        cue
                        or _STATED_FRAME_V2.search(lowered[max(0, start - _STATED_SPAN) : start])
                        or _TOTAL_BEFORE.search(lowered[max(0, start - _STATED_SPAN) : start])
                        or _TOTAL_AFTER.match(after)
                    )
                    if (
                        framed
                        and not _TOTAL_NOT_PRICE_RE.search(window)
                        and not _TOTAL_NOT_OURS.search(clause_before(lowered, start))
                        and not _NOT_OURS_AFTER.match(after)
                        and not _third_party_seller(lowered, start, sellers)
                        and not negated_before(lowered, start, 8)
                        and not _PRICE_NO.search(clause_after(lowered, end))
                        and not _later_total(lowered, start, end)
                        and value not in found
                    ):
                        found.append(value)
    return found


# M032 S2P review S2P-R2: the course price the advisor names however he frames it ("We charge
# $9,000 for the full program", "The total is $9,000", "Ours is $9,000", "You'd be looking at
# $9,000", "We're at $9,500 for this cohort", "It's 9k"): a course-scale dollar figure in a
# statement, with every exclusion ``stated_totals`` makes (a value, a saving, an add-on, a salary,
# someone else's or another program's price, a refused or negated figure, a later or another
# batch's price) and no discount ("$5,000 off").  It only tells her a price was named (no probe,
# no price question) and what the anchor reacts to; the conflict check keeps ``stated_totals``.
NAMED_MIN_USD = 4500
# Someone else's figure said after it ("$7,200 by someone else, that was not us", "$7,000 is what
# people say they paid").
_NAMED_NOT_OURS_AFTER = re.compile(
    r"^[^.?!]{0,30}\b(?:someone else|somebody else|elsewhere|not us|another (?:company|provider|"
    r"institute|program(?:me)?|course)|(?:people|someone|somebody|others|students|learners|they)"
    r"\s+(?:\w+\s+){0,3}?(?:paid|pay|got|spent))\b",
    re.IGNORECASE,
)
# "You'd be looking at $9,000" states the price; the hedge "I'm looking into $8,000" does not.
_YOU_LOOKING_AT = re.compile(
    r"\byou(?:'d| would|'ll| will|'re| are)?(?: be)? looking at\s+(?:about |around |roughly )?$",
    re.IGNORECASE,
)


def named_prices(text: object) -> list[int]:
    """The course prices ($4,500 to ``MAX_LIST_USD``) the advisor names in ``text``, however
    framed (review S2P-R2), in the order said; ints only."""
    found: list[int] = []
    for sentence in split_sentences(_tail(expand_shorthand_amounts(text))):
        if later_price_threat(sentence, PRICE_USD):
            continue
        for clause in _clauses(sentence):
            for piece in _pieces(clause):
                if is_question_like(piece):
                    continue
                lowered = canonical_amounts(re.sub(r"(\d),(?=\s)", r"\1 ,", piece)).lower()
                sellers = _named_sellers(piece)
                for match in _DOLLARS.finditer(lowered):
                    value = parse_amount(match.group(1), bool(match.group(2)))
                    if value is None or not NAMED_MIN_USD <= value <= MAX_LIST_USD:
                        continue
                    start, end = match.start(), match.end()
                    window = lowered[max(0, start - _STATED_SPAN) : end + _STATED_SPAN]
                    after = lowered[end:]
                    before = lowered[max(0, start - 40) : start]
                    hedged = _HEDGE_BEFORE.search(before) is not None
                    if (
                        not _TOTAL_NOT_PRICE_RE.search(window)
                        and not _TOTAL_NOT_OURS.search(clause_before(lowered, start))
                        and not _NOT_OURS_AFTER.match(after)
                        and not _OFF_AFTER.match(after)
                        and not _NAMED_NOT_OURS_AFTER.match(after)
                        and not _DISCOUNT_BEFORE.search(before)
                        and not (hedged and _YOU_LOOKING_AT.search(before) is None)
                        and not _third_party_seller(lowered, start, sellers)
                        and not negated_before(lowered, start, 8)
                        and not _PRICE_NO.search(clause_after(lowered, end))
                        and not _later_total(lowered, start, end)
                        and value not in found
                    ):
                        found.append(value)
    return found


# M032 S2P (the SWEEP-21 corpus check): the discounts a turn names ("discounts of $500, $1,000 or
# $1,500", "discounts up to $1500", "$1,000 off", "the $500 to $1,500 plan discounts").  Figures
# joined as a list ("$500, $1,000 or $1,500", "$500 to $1,500") are one group, and the whole group
# is discounts when one of them sits right after a discount frame or right before "off" or
# "discount(s)" (one word may come between: "plan discounts").  A list price said with a discount
# that brings it to or below the earlier offer keeps that offer reachable, so it is no rise.
_DISCOUNT_LIST_JOIN = re.compile(r"^\s*,?\s*(?:or|and|to)?\s*(?:even\s+)?$", re.IGNORECASE)
_DISCOUNT_NOUN_AFTER = re.compile(
    r"^\s*(?:dollars?\s+)?(?:[a-z]+(?:-[a-z]+)?\s+)?(?:off|discounts?|reductions?)\b",
    re.IGNORECASE,
)
# A bare three-digit figure ("discounts of 500, 1000 or 1500") counts only inside such a group.
_BARE_HUNDREDS = re.compile(r"(?<![\d$.,])([1-9]\d{2})(?![\d,])" + _NOT_UNIT, re.IGNORECASE)


def discount_amounts(text: object) -> list[int]:
    """The dollar discounts ``text`` names, $100 to $3,000, in the order said (ints only)."""
    found: list[int] = []
    for sentence in split_sentences(_tail(text)):
        lowered = canonical_amounts(re.sub(r"(\d),(?=\s)", r"\1 ,", sentence)).lower()
        figures = sorted(
            [
                (match.start(), match.end(), parse_amount(match.group(1), bool(match.group(2))))
                for match in _DOLLARS.finditer(lowered)
            ]
            + [
                (match.start(), match.end(), parse_amount(match.group(1)))
                for pattern in (_BARE_WHOLE, _BARE_HUNDREDS)
                for match in pattern.finditer(lowered)
            ]
        )
        groups: list[list[tuple[int, int, float | None]]] = []
        for figure in figures:
            if groups and _DISCOUNT_LIST_JOIN.match(lowered[groups[-1][-1][1] : figure[0]]):
                groups[-1].append(figure)
            else:
                groups.append([figure])
        for group in groups:
            framed = any(
                _DISCOUNT_BEFORE.search(lowered[max(0, start - 40) : start]) is not None
                or _DISCOUNT_NOUN_AFTER.match(lowered[end:]) is not None
                for start, end, _value in group
            )
            if not framed or negated_before(lowered, group[0][0], 8):
                continue
            for _start, _end, value in group:
                if value is not None and 100 <= value <= IMPLAUSIBLE_NET_USD:
                    found.append(int(value))
    return found


# M032 SWEEP-19: the advisor says the price does not move ("the price is fixed", "the fee is the
# same for everyone"); a statement only.
_HELD_PRICE = re.compile(
    r"\b(?:price|fee|cost)(?: is|'s) (?:fixed|final|non-?negotiable|the same for everyone)\b",
    re.IGNORECASE,
)


def holds_price(text: object) -> bool:
    """The advisor says in a statement that the course price is fixed (SWEEP-19's restatement)."""
    return any(
        not is_question_like(sentence) and _HELD_PRICE.search(fold(sentence)) is not None
        for sentence in split_sentences(_tail(text))
    )


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
    text: object, *, after_anchor: bool = True, r_sec: float = 345.0, reader_v2: bool = False
) -> AdvisorActs:
    """Read one advisor turn the way ``RolePlayEngine.plan_turn`` does.

    ``after_anchor`` says the learner's $7,000 anchor was already delivered: an amount then answers
    it, while before it an amount needs a pricing word.  ``r_sec`` is the role-play clock for the
    farewell rule (a courtesy such as "thanks for your time" only counts from 4:00).  ``reader_v2``
    reads the offers with M032 SWEEP-18's reader (the corpus comparison).
    """
    acts = ask_acts(text)
    state = Negotiation("husband")
    seen = state.observe(5, text, anchor_turn=4 if after_anchor else None, reader_v2=reader_v2)
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
# M032 S2 offer readers (advisor text only; pure, tail-bounded, linear).
# ----------------------------------------------------------------------------------
# SWEEP-5 (flag R1_OFFER_TERMS): what an offer carried besides its price (fda9e9f6 #65-66: "$1,000
# off and monthly EMI" got a reaction to the number alone).  A statement offering it, in the
# advisor's own frame; never a question put to her ("Would EMI help you?"), a negated term ("We
# don't have EMI right now"), the past ("Last year we had a free class") or a third party's free
# material ("a free course on Coursera").
TERM_INSTALMENTS = "instalments"
TERM_FREE_EXTRA = "free_extra"
OFFER_TERMS = (TERM_INSTALMENTS, TERM_FREE_EXTRA)
_INSTALMENT_TERM = re.compile(
    r"\b(?:emis?|instal+ments?|payment plans?|monthly payments?|"
    r"pay (?:it |that |this )?(?:monthly|every month|per month|over (?:\d{1,2}|a few|several) "
    r"months|in (?:monthly )?instal+ments)|split (?:the |your |it into )?(?:payments?|fees?|"
    r"costs?|parts))\b",
    re.IGNORECASE,
)
_INSTALMENT_TERM_PLAYBOOK = re.compile(
    r"\b(?:(?:zero|no|0\s*%?)[- ]?(?:percent\s+)?interest(?!\s+in\b)|"
    r"interest[- ]free)\b", re.I
)
_INSTALMENT_OFFER = re.compile(
    r"\b(?:can|could|will|'ll|offer\w*|have|has|give|provide\w*|allow\w*|available|option|"
    r"tied up|opt|choose|let)\b",
    re.IGNORECASE,
)
# Review S2R-10: up to two words between "free" and the noun ("a free mock interview session"),
# the thing named first ("the recordings for free"), and a free period ("free for a month", "try
# it free").
_FREE_EXTRA_TERM = re.compile(
    r"\b(?:free|complimentary|bonus)\s(?:[\w-]+\s){0,2}?(?:trial|months?|weeks?|sessions?|"
    r"class(?:es)?|courses?|modules?|access|mentoring|mentorship)\b"
    r"|\b(?:a|one|two|first|the first) (?:month|week)s? (?:is |for )?free\b"
    r"|\bfree for (?:a|one|two|the first|the next) (?:(?:few|couple of) )?"
    r"(?:months?|weeks?|days?)\b"
    r"|\btry (?:it|this|that|the (?:course|program(?:me)?|classes)) (?:out )?(?:for )?free\b"
    r"|\b(?:recordings?|sessions?|class(?:es)?|modules?|access|mentoring|mentorship|trial) "
    r"(?:for )?free\b",
    re.IGNORECASE,
)
_FREE_EXTRA_FRAME = re.compile(
    r"\b(?:i|we)\b[^.?!]{0,40}?\b(?:give|giving|add|adding|throw(?:ing)? in|include|including|"
    r"offer|offering|provide|providing)\b"
    r"|\byou (?:get|will get|'ll get|can get|also get|would get|can try|could try|can have)\b",
    re.IGNORECASE,
)
# "no-cost EMI" is an instalment offer, not a negated one ("We offer no-cost EMI").
_NO_COST = re.compile(r"\bno[- ]cost\b", re.IGNORECASE)
# Review S2R-8: a monthly plan, as against a payment split in parts ("two halves", "half now and
# half in two months"): only the monthly one gets the "what would it come to each month" clause.
_MONTHLY_TERM = re.compile(
    r"\b(?:emis?|monthly|every month|per month|a month|each month|over (?:\d{1,2}|a few|several|"
    r"(?:three|six|nine|twelve|eighteen|twenty-four)) months|(?:\d{1,2}|three|six|nine|twelve)"
    r"[- ]months?\b)",
    re.IGNORECASE,
)
_PLATFORMS = re.compile(r"\b(?:youtube|coursera|udemy|online|internet)\b", re.IGNORECASE)
_PAST_TENSE = re.compile(r"\b(?:had|was|were|used to)\b", re.IGNORECASE)
# A payment plan named only as what a discount depends on ("discounts of $500 or $1,000 depending
# on the payment plan you choose") offers her no instalments: the note would hand her a course fact
# the advisor never said (D-M032-7).  An instalment word in the same clause still counts.
_PLAN_CONDITION_BEFORE = re.compile(
    r"\b(?:depending|depends|depend|based|on)\s(?:on\s)?"
    r"(?:(?:the|your|which|whichever|a|an|each)\s)?(?:\w+\s){0,2}$",
    re.IGNORECASE,
)
_PLAN_CONDITION_AFTER = re.compile(
    r"^\s(?:that\s)?(?:you|they)\s(?:choose|chose|pick|picked|select|go with|opt for)\b",
    re.IGNORECASE,
)
_PLAN_CONDITION_CHARS = 60


def _plan_as_condition(clause: str, term: re.Match[str]) -> bool:
    """``term`` is "payment plan" named only as a discount's condition (see above)."""
    if not term.group(0).lower().startswith("payment plan"):
        return False
    before = clause[max(0, term.start() - _PLAN_CONDITION_CHARS) : term.start()]
    after = clause[term.end() : term.end() + _PLAN_CONDITION_CHARS]
    return (
        _PLAN_CONDITION_BEFORE.search(before) is not None
        or _PLAN_CONDITION_AFTER.search(after) is not None
    )


def _offered_statement(sentence: str, start: int) -> bool:
    """The term at ``start`` sits in an advisor statement and is not negated or in the past."""
    if is_question_like(sentence) or "?" in sentence:
        return False
    if negated_before(sentence, start):
        return False
    return _PAST_TENSE.search(sentence) is None


def _sold_by_someone_else(clause: str) -> bool:
    """A capitalised name in a seller's role in ``clause`` ("Scaler gives a free class")."""
    sellers = _named_sellers(clause)
    return sellers is not None and sellers.search(clause.lower()) is not None


def offer_terms_in(text: object) -> frozenset[str]:
    """The non-price terms (``OFFER_TERMS``) an advisor turn offered her (SWEEP-5)."""
    return _offer_terms(text)[0]


def instalments_are_monthly(text: object) -> bool:
    """The instalments an advisor turn offered are monthly (EMI, "monthly", "over N months").

    Review S2R-8: "split the payment into two halves" offers instalments, but not monthly ones.
    """
    return _offer_terms(text)[1]


def _offer_terms(text: object) -> tuple[frozenset[str], bool]:
    found: set[str] = set()
    monthly = False
    for sentence in split_sentences(_tail(text)):
        for clause in _clauses(sentence):
            clause = _NO_COST.sub("zero-cost", clause)
            term = next(
                (
                    match
                    for match in _INSTALMENT_TERM.finditer(clause)
                    if not _plan_as_condition(clause, match)
                ),
                None,
            )
            playbook_term = False
            if term is None and _india_playbook_on():
                term = _INSTALMENT_TERM_PLAYBOOK.search(clause)
                playbook_term = term is not None
            if (
                term is not None
                and _INSTALMENT_OFFER.search(clause) is not None
                and _offered_statement(clause, term.start())
            ):
                found.add(TERM_INSTALMENTS)
                monthly = monthly or playbook_term or _MONTHLY_TERM.search(clause) is not None
            extra = _FREE_EXTRA_TERM.search(clause)
            if (
                extra is not None
                and _FREE_EXTRA_FRAME.search(clause) is not None
                and _PLATFORMS.search(clause) is None
                and not _sold_by_someone_else(clause)
                and _offered_statement(clause, extra.start())
            ):
                found.add(TERM_FREE_EXTRA)
    return frozenset(found), monthly


# SWEEP-13 (flag R1_OFFER_REALISM): a price far below anything she expected, or the course for
# free, so she reacts as a careful buyer (8f5bfefc: $9,000 cut to $3,000; b419d478: a $500 price).
# A net price read at this or less, or a framed course price under $1,000, is "low".
IMPLAUSIBLE_NET_USD = 3000
IMPLAUSIBLE_LOW = "low"
IMPLAUSIBLE_FREE = "free"
_COURSE_OBJECT = (
    r"(?:it|(?:this|that|our|the)(?: (?:whole|entire|full))? (?:course|program(?:me)?)|this|that)"
)
_SMALL_PRICE = r"\$\s?(\d{1,3})(?!\d|[,.]\d)"
_FRAMED_SMALL_PRICE = re.compile(
    r"\b(?:give|gives|giving|offer|offering|sell|selling|let you have|do|doing)\s"
    r"(?:you\s)?" + _COURSE_OBJECT + r"\s(?:to you\s)?(?:for|at)\s(?:just |only |a mere )?"
    + _SMALL_PRICE
    + r"|\b(?:price|cost|fee)\s(?:of|is|will be|would be|comes to)\s(?:just |only )?"
    + _SMALL_PRICE,
    re.IGNORECASE,
)
_NOT_A_COURSE_PRICE = re.compile(
    r"\b(?:a|per|each|every|/)\s?(?:month|week|day)\b|\bmonthly\b|\bweekly\b|\bdaily\b"
    r"|^\s*(?:off|discount)\b"
    r"|\b(?:deposit|booking|registration|token|application|emis?|instal+ments?|upfront|down)\b",
    re.IGNORECASE,
)
# Review S2R-2: the figure right after a framed price is no course price when it is a difference
# ("$500 less", "$500 more for the premium track", "$500 lower than the last batch") or the head of
# a bigger number ("$9 thousand", "$8.5 thousand", which ``canonical_amounts`` writes "$8 $1000").
_NOT_A_PRICE_TAIL = re.compile(
    r"^\s*(?:less|more|lower|higher|cheaper|dearer|extra|off|discount|thousand|grand|hundred|"
    r"lakhs?|lacs?|k\b)|^\s*(?:\.\d|\$\s?\d|\d)",
    re.IGNORECASE,
)
# The course itself for free.  Review S2R-2 and S2R-3: a bare "it is free", "it for free" or "free
# of charge" is nearly always something else (a recording to rewatch, a masterclass, the placement
# support), so "is free", "for free" and "free of cost / charge" need the course or programme as
# their subject; "it" counts only as the object of an offering verb ("give it to you for free", "you
# can have it free").  "won't pay anything" is a free course only at the end of its clause: never
# "until you're placed", "upfront", "today", "extra for the mentors" or "more than $6,000".
_FREE_COURSE = re.compile(
    r"\b(?:give|gives|giving|gave|let you have|provide|providing|offer|offering)\s(?:you\s)?"
    + _COURSE_OBJECT
    + r"\s(?:to you\s)?(?:for\s)?(?:free|at no cost)\b"
    r"|\b(?:have|get) it (?:for )?free\b"
    r"|\b(?:course|program(?:me)?) for free\b"
    r"|\b(?:course|program(?:me)?) (?:is|will be|would be|can be|could be) (?:completely |"
    r"totally |entirely )?(?:free|at no cost)\b"
    r"|\b(?:course|program(?:me)?) (?:(?:is|will be|would be|comes) )?(?:completely |totally |"
    r"entirely )?free of (?:cost|charge)\b"
    r"|\b(?:won'?t|will not|wouldn'?t|don'?t) (?:have to |need to )?pay anything"
    r"(?= at all\b| for (?:it|this|that|the (?:whole |entire |full )?(?:course|program(?:me)?))\b"
    r"|\s*(?:[.,;!]|$))",
    re.IGNORECASE,
)
_FREE_TAIL_EXTRA = re.compile(
    r"^\s*(?:of charge\s)?(?:(?:for|in|during) (?:a |the )?(?:first |initial )?"
    r"(?:(?:\d+|one|two|three|seven|fourteen|thirty)[ -])?(?:days?|weeks?|months?|class(?:es)?|"
    r"sessions?|trials?)\b|(?:trials?|months?|weeks?|days?|sessions?|class(?:es)?|demos?|"
    r"webinars?|access|modules?|content|resources)\b|to\s\w)",
    re.IGNORECASE,
)
_FREE_ELSEWHERE = re.compile(
    r"\bfree (?:content|stuff|courses|videos|time|material)\b|\bare you free\b|\bfeel free\b"
    r"|\bfor free on\b|\bfree online\b|\b(?:youtube|coursera|udemy|edx)\b",
    re.IGNORECASE,
)
# A free part of the offer said in the same sentence ("you won't pay anything, the first month is
# on us"): that is a free extra (``offer_terms_in``), not the whole course for free.
_FREE_PART = re.compile(
    r"\b(?:first|one|a) (?:month|week)\b|\btrial\b|\bdemo\b",
    re.IGNORECASE,
)


# Simulation diagnosis 2 (MF2; the engine's R1_LOW_OFFER_READER): a very low price said without a
# dollar sign or a pricing word ("the most I can do is maybe 500 USD", "I can let you have it at
# 500", "I can do it for 800"), a bare amount-only reply after a price exchange ("200 dollars."),
# and a free package offered to her.  Monthly figures, discounts and deposits stay no price.
_LOW_FRAMED_BARE = re.compile(
    r"\b(?:(?:the )?(?:most|best|lowest)(?: price)? i can (?:do|go|offer)(?: is| would be)?|"
    r"let you have (?:it|this|that|the course|the program(?:me)?) (?:at|for)|"
    r"i can do (?:it|this|that) (?:at|for))\s(?:maybe |about |around |just |only |a mere )?"
    r"\$?\s?(\d{1,3}(?:,\d{3})?|\d{1,4})(?!\d)(?![,.]\d)",
    re.IGNORECASE,
)
_AMOUNT_ONLY = re.compile(
    r"^\W*(?:(?:um+|uh+|okay|ok|so|fine|alright|right),?\s+)*\$?\s?(\d{1,3}(?:,\d{3})?|\d{1,4})"
    r"\s?(?:usd|dollars?|bucks)?\W*$",
    re.IGNORECASE,
)
_FREE_PACKAGE = re.compile(
    r"\b(?:give|offer|let you have|get)\b[^.?!]{0,15}\ba free (?:package|course|program(?:me)?|"
    r"place|seat|spot|enrol+ment)\b",
    re.IGNORECASE,
)
# Review of MF2: the figure is a price only when nothing after it makes it a count or a share ("10%
# off", "6 months of mentoring", "2 extra sessions", "for 2 people", "1 payment plan"): it ends the
# clause, or a connective or a price word follows it.  A figure without a "$" or a currency word
# (``canonical_amounts`` writes "500 USD" as "$500") is a price only from $100 up: "Okay, 30." is
# hours a week far more often than a $30 course.
_CURRENCY_AFTER = re.compile(r"\s*(?:usd|dollars?|bucks)\b", re.IGNORECASE)
_PRICE_FIGURE_END = re.compile(
    r"(?:\s*(?:usd|dollars?|bucks)\b)?\s*(?:[.,;:!?)]|-|$|(?:for|if|and|but|so|then|now|today|"
    r"tops|max(?:imum)?|total|flat|all|only|on|with|as|which|because|since|or|is|that|including|"
    r"plus|net|final|in total|all in|right|okay|ok)\b)",
    re.IGNORECASE,
)
_UNMARKED_PRICE_MIN_USD = 100


def _low_offer_wide(sentence: str, *, amount_only: bool) -> tuple[str, int | None] | None:
    """MF2: the wider low-price and free readings of one sentence."""
    lowered = canonical_amounts(sentence).lower()
    if _INQUIRY.search(lowered):
        return None
    matches = list(_LOW_FRAMED_BARE.finditer(lowered))
    if amount_only:
        matches += list(_AMOUNT_ONLY.finditer(lowered))
    for match in matches:
        value = int(match.group(1).replace(",", ""))
        after = lowered[match.end() : match.end() + 40]
        before = lowered[max(0, match.start() - 60) : match.start()]
        if not 0 < value <= IMPLAUSIBLE_NET_USD:
            continue
        marked = lowered[: match.start(1)].rstrip().endswith("$") or bool(
            _CURRENCY_AFTER.match(lowered[match.end(1) :])
        )
        if not marked and value < _UNMARKED_PRICE_MIN_USD:
            continue
        if _PRICE_FIGURE_END.match(lowered[match.end(1) :]) is None:
            continue
        if _NOT_A_COURSE_PRICE.search(after) or _NOT_A_COURSE_PRICE.search(before):
            continue
        if negated_before(lowered, match.start()):
            continue
        return IMPLAUSIBLE_LOW, value
    match = _FREE_PACKAGE.search(lowered)
    if match is not None and not negated_before(lowered, match.start()):
        return IMPLAUSIBLE_FREE, None
    return None


def implausible_offer_in(
    text: object,
    own_amounts: Iterable[int] = (),
    *,
    wide: bool = False,
    amount_only: bool = False,
) -> tuple[str, int | None] | None:
    """``("low", usd)``, ``("free", None)`` or None for one advisor turn (SWEEP-13).

    A question phrased as an offer counts ("if I give it to you free, will you take it?"), as it
    does for ``parse_price_offers``.  A monthly figure, a discount, a deposit or an instalment, a
    third party's price, and a negated figure are never the course's price.

    ``wide`` (simulation diagnosis 2, MF2): also the bare low price in an offer frame and a free
    package; ``amount_only`` (a price was already on the table): a reply that is only an amount.
    """
    found = _implausible_offer_in(text, own_amounts)
    if found is not None or not wide:
        return found
    for sentence in split_sentences(_tail(text)):
        wider = _low_offer_wide(sentence, amount_only=amount_only)
        if wider is not None:
            return wider
    return None


def _implausible_offer_in(
    text: object, own_amounts: Iterable[int] = ()
) -> tuple[str, int | None] | None:
    """SWEEP-13's reading (``implausible_offer_in`` without ``wide``)."""
    tail = _tail(text)
    nets = [net for net, _conditional in parse_price_offers(tail, own_amounts)]
    low = [net for net in nets if net <= IMPLAUSIBLE_NET_USD]
    if low:
        return IMPLAUSIBLE_LOW, min(low)
    for raw in split_sentences(tail):
        # Review S2R-2: a sentence whose net price is read above the far-below line ("The fee is
        # $500 less if you pay before Friday" is $8,500) is an ordinary offer: its "$500" is no
        # framed price, and nothing in it is the course for free.
        if any(
            net > IMPLAUSIBLE_NET_USD for net, _conditional in parse_price_offers(raw, own_amounts)
        ):
            continue
        sentence = canonical_amounts(raw)
        lowered = sentence.lower()
        if _INQUIRY.search(lowered):
            continue
        for match in _FRAMED_SMALL_PRICE.finditer(lowered):
            value = int(match.group(1) or match.group(2))
            after = lowered[match.end() : match.end() + 40]
            before = lowered[max(0, match.start() - 60) : match.start()]
            if (
                value <= 0
                or _NOT_A_PRICE_TAIL.match(after)
                or _NOT_A_COURSE_PRICE.search(after)
                or _NOT_A_COURSE_PRICE.search(before)
            ):
                continue
            if negated_before(lowered, match.start()) or _third_party_seller(
                lowered, match.start(), _named_sellers(sentence)
            ):
                continue
            return IMPLAUSIBLE_LOW, value
        if _FREE_ELSEWHERE.search(lowered):
            continue
        for match in _FREE_COURSE.finditer(lowered):
            if _FREE_TAIL_EXTRA.match(lowered[match.end() :]):
                continue
            pays = "pay anything" in match.group(0)
            if pays and _FREE_PART.search(lowered):
                continue
            if not pays and negated_before(lowered, match.start()):
                continue
            return IMPLAUSIBLE_FREE, None
    return None


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
    # M032 SWEEP-21: the stated totals of this turn (ints), and the price conflict it raised, if
    # any: (kind, usd, earlier usd) with kind "website" or "rise" (``Negotiation.price_conflict``).
    totals: tuple[int, ...] = ()
    conflict: tuple[str, int, int | None] | None = None
    # Review S2P-R2: the course prices this turn named in any other frame (``named_prices``).
    named: tuple[int, ...] = ()

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

    def __init__(
        self, decision_maker: str, *, max_stall_rounds: int = MAX_STALL_ROUNDS,
        timeline_v3: bool = False, india_playbook: bool | None = None,
    ) -> None:
        self.india_playbook = _india_playbook_on() if india_playbook is None else india_playbook
        # Set by the engine only under the India playbook.
        self.time_offer_turn: int | None = None
        self.decision_maker = decision_maker
        self.timeline_v3 = timeline_v3
        self.condition_named: list[dict[str, Any]] = []
        self.max_stall_rounds = max_stall_rounds
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
        # Simulation diagnosis 2 (SC2, the engine's R1_DECLINE_SCOPE): a decline in a free reply
        # before the close window, and the latest advisor turn after it that answered its reason
        # (deferred the call until after the reading or the talk, or handled the timing or the
        # decision maker).  It caps the in-window grade only while it stands unanswered.
        self.pre_window_decline_turn: int | None = None
        self.pre_window_answered_turn: int | None = None
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
        # M032 SWEEP-18 (reader v2): the latest price the advisor stated at or above the list price,
        # as (turn, usd); a dollar discount on the very next advisor turn comes off it ("The program
        # is $9,500." then "I can do $1,000 off for you."), never a threat or another batch's price.
        self._stated: tuple[int, int] | None = None
        # M032 SWEEP-21 (quote record, ints only): every offer and every stated total the advisor
        # named, as (turn, usd, kind) with kind "offer" or "total"; the conflicts already checked
        # (kind, usd), and the turn of a price rise still open (no figure named since).
        self.quotes: list[tuple[int, int, str]] = []
        self.conflicts: list[tuple[str, int]] = []
        self.rise_open_turn: int | None = None
        # M032 SWEEP-19: the latest turn after the anchor that restated the full price with no
        # offer, or said the price is fixed ("No, the price is $9,000 for everyone.").
        self.full_price_turn: int | None = None
        # Simulation diagnosis 1 (L3): the advisor turn after the anchor that questioned where her
        # figure came from ("Who told you that?"), or None.
        self.figure_challenged_turn: int | None = None
        self._totals_read = False
        # Review S2P-R2 (naturalness): her heard anchor asked about the website's price (the check
        # form), so no WEBSITE conflict is checked after it (``note_anchor``).
        self.website_checked = False

    # ------------------------------------------------------------------ observation
    def observe(
        self,
        turn: int,
        text: object,
        *,
        anchor_turn: int | None = None,
        reader_v2: bool = False,
        probed: bool = False,
        read_totals: bool = False,
        email_v2: bool = False,
    ) -> NegotiationTurn:
        """Read one advisor turn.  ``anchor_turn`` is the learner turn of the $7,000 ask.

        Prices are tracked from the first mention, not from the anchor: an offer made before
        the learner asked for $7,000 is on the table, so the anchor can react to it and a later
        restatement of it is never "new".  A refusal only answers the anchor, so it counts after
        it.

        M032: ``reader_v2`` (SWEEP-18, flag R1_OFFER_READER_V2) reads the offers with
        ``parse_price_offers(..., v2=True)`` and carries the previous advisor turn's stated price
        over as the base of a dollar discount (``STATED_CARRY_TURNS``); ``probed`` (SWEEP-19, flag
        R1_PROBE_FIRST) says the learner just asked the price, so an amount needs no pricing word,
        as after the anchor ("It's around 6000 dollars"); ``read_totals`` (S2P, SWEEP-19, SWEEP-21)
        keeps the quote record (every offer and stated total), the price conflict of the turn and
        the turn that restated the full price after the anchor.  ``email_v2`` (SWEEP-25, flag
        R1_WEAK_EMAIL_V2) reads an e-mail offer of documents, brochures or a road map too.
        """
        callback = detect_callback(text)
        if callback is not None:
            self.callbacks.append({"turn": turn, "has_slot": callback.slot is not None})
            if callback.slot is not None:
                self.last_slot = callback.slot
                self.last_slot_turn = turn
        email = detect_email_offer(text, v2=email_v2)
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
        carry: int | None = None
        stated_now: int | None = None
        if reader_v2:
            stated_now = stated_price_usd(text, v2=True)
            previous = self._stated
            if (
                stated_now is None
                and previous is not None
                and 0 < turn - previous[0] <= STATED_CARRY_TURNS
            ):
                carry = previous[1]
        read_offers = parse_price_offers(
            text,
            self.own_amounts,
            require_cue=not after_anchor and not probed,
            v2=reader_v2,
            base_usd=carry,
        )
        if stated_now is not None:
            self._stated = (turn, stated_now)
        for net, conditional in read_offers:
            mentioned = True
            if all(item.net_usd != net for item in self.offers + offers):
                offers.append(PriceOffer(turn, net, conditional))
        read = {item.net_usd for item in self.offers + offers}
        full_price = states_full_price(text)
        if any(item.net_usd >= ANCHOR_USD for item in offers) or full_price:
            self.low_cleared_turn = turn
        for usd in unread_low_figures(text, self.own_amounts, v2=reader_v2):
            if usd not in read:
                self.low_mentions.append((turn, usd))
        # M032 SWEEP-21 and SWEEP-19 (only when the engine reads them: ``read_totals``).
        totals: tuple[int, ...] = ()
        conflict: tuple[str, int, int | None] | None = None
        named: tuple[int, ...] = ()
        if read_totals:
            self._totals_read = True
            totals = tuple(stated_totals(text))
            nets_now = {net for net, _conditional in read_offers}
            # Review S2P-R2: a course price named in any frame ("We charge $9,000", "Ours is
            # $9,000"); not one read above or one she said herself.  At or above the $7,000 it is a
            # named price the anchor reacts to; under it, before the anchor, a low mention.
            named = tuple(
                usd
                for usd in named_prices(text)
                if usd not in totals and usd not in read and usd not in self.own_amounts
            )
            for item in offers:
                self.quotes.append((turn, item.net_usd, QUOTE_OFFER))
            for usd in totals:
                self.quotes.append((turn, usd, QUOTE_TOTAL))
            for usd in named:
                if usd >= ANCHOR_USD:
                    self.quotes.append((turn, usd, QUOTE_NAMED))
                    self.low_cleared_turn = turn
                elif not after_anchor and (turn, usd) not in self.low_mentions:
                    self.low_mentions.append((turn, usd))
            if nets_now or totals or named:
                self.rise_open_turn = None
            conflict = self._price_conflict(
                totals,
                nets_now,
                prior_best,
                after_anchor,
                discounts=discount_amounts(text),
                named=named,
            )
            if conflict is not None:
                self.conflicts.append((conflict[0], conflict[1]))
                if conflict[0] == CONFLICT_RISE:
                    self.rise_open_turn = turn
            # Review S2P-R2 (naturalness): a price at or above the $7,000 restated after the anchor
            # with no offer ("No, it's actually $9,500 for the full program") answers her check
            # or her ask as a refusal does (SWEEP-19's REFUSED), whatever its frame.
            restated = any(usd >= ANCHOR_USD for usd in (*totals, *named))
            if after_anchor and not read_offers and (full_price or holds_price(text) or restated):
                self.full_price_turn = turn
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
            if self.figure_challenged_turn is None and challenges_her_figure(text):
                self.figure_challenged_turn = turn  # L3: "Who told you that?"
        self.offers.extend(offers)
        newly: set[str] = set()
        addressed = reasons_handled_in(text, self.decision_maker, playbook=self.india_playbook)
        if REASON_DECISION_MAKER in addressed:
            self.decider_handled_turn = turn
        early = self.pre_window_decline_turn
        if early is not None and turn > early and (
            defers_call_until_after(text)
            or addressed & {REASON_TIMING, REASON_DECISION_MAKER}
        ):
            self.pre_window_answered_turn = turn  # SC2: the reason of her early decline answered
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
            totals=totals,
            conflict=conflict,
            named=named,
        )

    def _price_conflict(
        self,
        totals: tuple[int, ...],
        nets_now: set[int],
        prior_best: int | None,
        after_anchor: bool,
        *,
        discounts: list[int] | tuple[int, ...] = (),
        named: tuple[int, ...] = (),
    ) -> tuple[str, int, int | None] | None:
        """SWEEP-21: the price conflict this turn raises, each (kind, usd) once, at most twice.

        WEBSITE: after the anchor, a total of $9,000 or more at least $300 away from the website's
        $9,000 (before the anchor S2.10's anchor owns the check).  RISE: a total at least $500 above
        the best offer on the table, unless this turn keeps the lower figure as an option ("$6,000
        upfront or $9,000 over nine months"), also through a discount it names that brings the
        total to or below that offer ("$9,000, with discounts up to $1,500" after $8,000;
        ``discounts``, from ``discount_amounts``).

        Review S2P-R2/R4 (naturalness): no WEBSITE check once her anchor asked about the website's
        price (``website_checked``: his next figure is the answer), nor on a turn that also names a
        price within $300 of the website's ("$9,000, or $9,600 in total with the EMI", "the
        advanced track is $11,000") or an offer under it ("$6,000 for you rather than $12,000").
        """
        if len(self.conflicts) >= MAX_CONFLICTS:
            return None
        website_ok = (
            after_anchor
            and not self.website_checked
            and not any(
                abs(usd - PRICE_USD) < CONFLICT_MIN_GAP_USD for usd in (*totals, *named)
            )
            and not any(net < PRICE_USD for net in nets_now)
        )
        for usd in totals:
            key = (CONFLICT_WEBSITE, usd)
            if (
                website_ok
                and abs(usd - PRICE_USD) >= CONFLICT_MIN_GAP_USD
                and key not in self.conflicts
            ):
                return CONFLICT_WEBSITE, usd, None
        if prior_best is None or any(net <= prior_best for net in nets_now):
            return None
        for usd in totals:
            key = (CONFLICT_RISE, usd)
            if any(usd - discount <= prior_best for discount in discounts):
                continue
            if usd >= prior_best + RISE_MIN_USD and key not in self.conflicts:
                return CONFLICT_RISE, usd, prior_best
        return None

    def latest_total_usd(self) -> int | None:
        """The latest course total the advisor stated (SWEEP-21's quote record), or None."""
        return next((usd for _t, usd, kind in reversed(self.quotes) if kind == QUOTE_TOTAL), None)

    def latest_stated_usd(self) -> int | None:
        """The course price the advisor last stated, in any frame (a total or a named price), or
        None.  Review S2P-R4: of the figures that turn named, the website's (within $300 of it)
        comes first, so "The fee is $9,000 and the advanced track is $11,000" or "$9,000, or
        $9,600 in total with the EMI" is a $9,000 price, not the last figure said."""
        stated = [(turn, usd) for turn, usd, kind in self.quotes if kind in _STATED_KINDS]
        if not stated:
            return None
        last_turn = stated[-1][0]
        same = [usd for turn, usd in stated if turn == last_turn]
        near = [usd for usd in same if abs(usd - PRICE_USD) < CONFLICT_MIN_GAP_USD]
        return near[0] if near else same[-1]

    def latest_stated_turn(self) -> int | None:
        """The turn of ``latest_stated_usd`` (None when no price was stated)."""
        return next(
            (turn for turn, _usd, kind in reversed(self.quotes) if kind in _STATED_KINDS), None
        )

    def reapply_conflict(
        self, conflict: tuple[str, int, int | None], turn: int
    ) -> tuple[str, int, int | None] | None:
        """Review S2P-R5 (naturalness): the conflict a lost first half raised (its reply was never
        heard, so it was given back) is raised again on the continuation that replans it, unless
        it was checked since or the session's checks are used up.  Returns it, or None."""
        kind, usd, _earlier = conflict
        key = (kind, usd)
        if key in self.conflicts or len(self.conflicts) >= MAX_CONFLICTS:
            return None
        if kind == CONFLICT_WEBSITE and self.website_checked:
            return None
        self.conflicts.append(key)
        if kind == CONFLICT_RISE:
            self.rise_open_turn = turn
        return conflict

    def note_anchor(self, anchor_id: str, stated_usd: int | None) -> None:
        """Her heard F1-ANCHOR checked the website's price (review S2P-R2, naturalness): the check
        form asked "is it about $9,000?", so no WEBSITE conflict is checked after it (his next
        figure is the answer); the stated-conflict form already checked ``stated_usd``."""
        if anchor_id in (ANCHOR_CHECK, ANCHOR_FOREIGN):
            self.website_checked = True
        elif anchor_id == ANCHOR_STATED_CONFLICT and stated_usd is not None:
            key = (CONFLICT_WEBSITE, stated_usd)
            if key not in self.conflicts:
                self.conflicts.append(key)

    def price_now_usd(self) -> int | None:
        """The latest price named, a total or an offer (the later by turn; SWEEP-21)."""
        return self.quotes[-1][1] if self.quotes else None

    def note_learner_text(
        self,
        spoken: object,
        turn: int | None = None,
        *,
        stall: bool = False,
        objection: bool = False,
        in_window: bool = False,
        scoped: bool = False,
    ) -> None:
        """Remember what the learner said: the figures (so the advisor repeating one is not an
        offer) and, at ``turn``, that it has to talk to its decision maker first.  ``stall`` marks
        the owed timing objection ("maybe the next cohort"): that is the objection the advisor is
        meant to answer, not a decision to wait.

        ``scoped`` (simulation diagnosis 2, SC2; the engine's R1_DECLINE_SCOPE): a decline in the
        graded objection itself (``objection``: F4-PRIMARY, F4-PUSH or a stall reason) is the
        thing the advisor must handle, not a decision; one in a free reply before the close
        window (``in_window`` False) is recorded as ``pre_window_decline_turn``; only one inside
        the window is ``call_declined_turn``."""
        for amount in dollar_amounts(spoken):
            if 0 < amount <= PRICE_USD:
                self.own_amounts.add(amount)
        if turn is not None and self._says_decider_first(spoken):
            self.decider_said_turn = turn
        if turn is not None and declines_call(spoken):
            if not scoped or in_window:
                if self.call_declined_turn is None:
                    self.call_declined_turn = turn
            elif not objection:
                self.pre_window_decline_turn = turn
        refused = refused_slot(spoken)
        if refused is not None and refused not in self.refused_slots:
            self.refused_slots.append(refused)
        if says_cost_is_secondary(spoken):
            self.money_secondary = True
        if turn is not None and not stall and says_will_wait(spoken):
            self.wait_said_turn = turn

    def _says_decider_first(self, spoken: object) -> bool:
        """The learner said it would talk to or check with its decision maker."""
        text = fold(spoken)
        pattern = re.compile(
            r"\b(?:talk|speak|check|discuss|consult|run (?:it|this|that) by|ask|tell)\b[^.?!]{0,40}"
            r"\b" + re.escape(self.decision_maker.lower()) + r"\b",
            re.IGNORECASE,
        )
        if not self.timeline_v3:
            return pattern.search(text) is not None
        clauses = re.split(r"[.?!]+|,\s*(?:so|and)\b|;\s+|\s+but\s+", text)
        for clause in clauses:
            habitual = re.search(
                r"\b(?:usually|normally|tend to)\b.*\b(?:talk|speak|check|discuss|"
                r"consult|run|ask|tell)\b", clause,
            )
            future = re.search(
                r"\b(?:first|before|need to|have to|would want to|will|going to|gonna)\b"
                r"|['?](?:d want to|ll)\b", clause,
            )
            if not (habitual and not future) and pattern.search(clause):
                return True
        return False

    def note_reason_voiced(self, reason: str, turn: int) -> None:
        """The learner raised ``reason`` (a stall reason intent, or the owed F4 moves)."""
        self.voiced.setdefault(reason, turn)
        self.voicings[reason] = self.voicings.get(reason, 0) + 1
        if reason == REASON_DECISION_MAKER:
            self.decider_said_turn = turn

    def note_condition(self, clause_id: str, spoken: object, turn: int) -> bool:
        clauses = (*CONDITION_CLAUSES.values(), *CONDITION_FAMILY_CLAUSES.values())
        clause = next((item for item in clauses if item.id == clause_id), None)
        if clause is None or not markers_match(
            filled_markers(clause.markers, self.decision_maker), spoken
        ):
            return False
        self.condition_named.append({"id": clause_id, "turn": turn})
        return True

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

    def price_situation(self, *, counter_v2: bool = False, asked_once: bool = False) -> str:
        """How the advisor answered the anchor: short of the ask, met it, refused, or unclear.

        The best price on the table counts, whenever it was offered; but an advisor who only
        REFUSED after the anchor (an earlier offer is not repeated) has refused.  M032 SWEEP-19
        (``counter_v2``): with no offer and no refusal, an advisor who restated the full price or
        said it is fixed after the anchor (``full_price_turn``) has refused too; the refusal count
        and the turn the anchor was answered are not touched, so the counter's timing is unchanged.
        Simulation diagnosis 1 (L3, ``asked_once``: R1_PRICE_ASKED_ONCE): so has an advisor who
        named the full price and then, after the anchor, only challenged her figure ("Who told you
        that?", ``figure_challenged_turn``): she knows his price, so asking what it would be is the
        same question twice.  A tentative answer ("we can see what we can do") stays unclear.
        """
        best = self.best_offer_usd
        if best is not None and (self.answer_offer or not self.refusals):
            return SITUATION_MET if best <= ANCHOR_USD else SITUATION_SHORT
        if self.refusals:
            return SITUATION_REFUSED
        if counter_v2 and best is None and self.full_price_turn is not None:
            return SITUATION_REFUSED
        if (
            counter_v2
            and asked_once
            and best is None
            and self.figure_challenged_turn is not None
            and any(usd >= ANCHOR_USD for _turn, usd, _kind in self.quotes)
        ):
            return SITUATION_REFUSED
        return SITUATION_UNCLEAR

    def counter_situation(
        self, *, counter_v2: bool = False, far_below: bool = False, asked_once: bool = False
    ) -> CounterSituation:
        """The counter for how the advisor answered the anchor.

        M032 SWEEP-19 (``counter_v2``): the v2 texts; a met price that is far below anything she
        expected (``far_below``: the best offer is $3,000 or less, or the last price read was low or
        free) gets the careful-buyer counter instead of relief.  ``asked_once`` (L3,
        R1_PRICE_ASKED_ONCE): see ``price_situation``, and the unclear brief has no verdict.
        """
        situation = self.price_situation(counter_v2=counter_v2, asked_once=asked_once)
        if not counter_v2:
            return COUNTER_BY_SITUATION[situation]
        if asked_once and situation == SITUATION_UNCLEAR:
            return UNCLEAR_COUNTER_V3
        best = self.best_offer_usd
        if situation == SITUATION_MET and (
            far_below or (best is not None and best <= IMPLAUSIBLE_NET_USD)
        ):
            return COUNTER_V2_BY_SITUATION[SITUATION_FAR_BELOW]
        return COUNTER_V2_BY_SITUATION[situation]

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
        return self.stall_rounds < self.max_stall_rounds and self.next_reason(skip) is not None

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
        """The learner turned a call down in so many words (it holds for the rest of the call).

        SC2 (R1_DECLINE_SCOPE): a decline before the close window holds only until an advisor turn
        after it answered its reason (``pre_window_answered_turn``).
        """
        if self.call_declined_turn is not None:
            return True
        early = self.pre_window_decline_turn
        if early is None:
            return False
        answered = self.pre_window_answered_turn
        return answered is None or answered <= early

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
        Owner 2026-11-20: a later time-limited deck offer can answer a prior wait.
        """
        if self.call_declined():
            return "call_declined"
        waited = self.wait_said_turn
        if (waited is not None and 0 <= turn - waited <= WAIT_RECENT_TURNS
                and not (self.india_playbook and self.time_offer_turn is not None
                         and self.time_offer_turn > waited)):
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
            **({"condition_named": list(self.condition_named)} if self.condition_named else {}),
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
            "pre_window_decline_turn": self.pre_window_decline_turn,
            "pre_window_answered_turn": self.pre_window_answered_turn,
            "refused_slots": len(self.refused_slots),
            "money_secondary": self.money_secondary,
            "wait_said_turn": self.wait_said_turn,
            "decider_handled_turn": self.decider_handled_turn,
            "decider_said_turn": self.decider_said_turn,
            # M032 S2P (ints and ids only, and only once the engine reads them, so the log of a
            # session with the S2P flags off is the release before): the quote record, the
            # conflicts checked, and the turn the full price was restated after the anchor.
            **(
                {
                    "quotes": [
                        {"turn": turn, "usd": usd, "kind": kind}
                        for turn, usd, kind in self.quotes
                    ],
                    "conflicts": [{"kind": kind, "usd": usd} for kind, usd in self.conflicts],
                    "full_price_turn": self.full_price_turn,
                    "website_checked": self.website_checked,
                }
                if self._totals_read
                else {}
            ),
        }
