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
from typing import Iterable, Mapping

from r1_text import (
    fold,
    fuzzy_contains,
    is_question_like,
    negated_before,
    split_sentences,
)

COMMIT_PERMITTED_R_SEC = 540
COMMIT_STALL_R_SEC = 780
# An advisor whose turns average fewer words than this over at least ``THIN_MIN_TURNS`` turns has
# not earned a commitment (the terse level of the rehearsal harness averages 5 to 6 words a turn,
# every other level 31 or more, the unit tests' cooperative advisor 10).
THIN_ADVISOR_MEAN_WORDS = 8
THIN_MIN_TURNS = 6
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


# R1-Q: the MEDIUM line gains a time slot, still ONE sentence ending "so we can decide", which
# is what the scorer-side mask matches (app/api/src/lib/r1/transcript.ts).  ``DEFAULT_SLOT`` is
# the slot when the advisor proposed nothing usable; ``r1_negotiation`` picks the real one.
DEFAULT_SLOT = "on Thursday at 7 PM"
COMMITMENT_LINES = {
    # R1-Q final review round 1: no "for that plan" (the learner never chose one).
    Level.STRONG: (
        "Okay, let's do it. Send me the enrolment link and I'll pay the deposit today."
    ),
    Level.MEDIUM: (
        "Let's book a call {slot} with my {decision_maker} so we can decide."
    ),
    Level.WEAK: "Let me think about it. Just email me the details and I'll get back to you.",
}
# The MEDIUM line when the advisor proposed a daytime weekday slot and the learner moves it to
# the evening.  Still one sentence, still ending "so we can decide".
MEDIUM_MOVED_LINE = (
    "Daytime is tough for me, so let's book a call {slot} with my {decision_maker} so we can "
    "decide."
)
# R1-Q iteration 2.  The MEDIUM line when the advisor named no usable time ("let me know when's
# good", "sometime next week") and the learner had just said it must talk to its decision maker
# first: it books the call but not a slot it never had ("Before I commit to any timing ..." and
# then "next week at 7 PM" was the contradiction).  One sentence, ending "so we can decide".
MEDIUM_DEFER_LINE = (
    "Let me check with my {decision_maker} first, and then let's book a call, so we can decide."
)
# The WEAK line when the stall answers a CALL ask (a callback, a time): it does not ask for an
# e-mail nobody offered, it says the learner will talk to its decision maker and be called back.
# Its second sentence is the one the scorer-side mask hides (app/api/src/lib/r1/transcript.ts).
WEAK_CALL_LINE = (
    "Let me think about it. Call me back after I've talked to my {decision_maker}, and I'll "
    "let you know."
)
# R1-Q iteration 3.  The WEAK line once the advisor has offered (or the learner has accepted) an
# e-mail with the details, or at the advisor's goodbye: it does not ask for the e-mail it was
# just promised (the live sweep: "Just email me the details" five times, after the e-mail was
# agreed, after the farewell).  Its second sentence is the one the scorer-side mask hides
# (transcript.ts).
WEAK_EMAIL_DONE_LINE = "Let me think about it. I'll read through the email and get back to you."


def commitment_line(
    level: Level,
    decision_maker: str,
    slot: str = DEFAULT_SLOT,
    *,
    moved: bool = False,
    deferred: bool = False,
    call: bool = False,
    emailed: bool = False,
) -> str:
    """The scripted line for ``level``; NONE is not a commitment and has no line.

    ``slot``, ``moved`` and ``deferred`` only shape the MEDIUM line: the call slot, whether the
    learner moved the advisor's daytime proposal to the evening, and whether it books the call
    without a slot.  ``call`` shapes the WEAK line: the stall answers a call ask; ``emailed``: the
    details were already promised by e-mail, so the line does not ask for them (it wins over
    ``call``: a learner who has an e-mail coming does not ask to be called back).
    """
    if level is Level.NONE:
        raise ValueError("no commitment line for Level.NONE")
    if level is Level.MEDIUM and deferred:
        template = MEDIUM_DEFER_LINE
    elif level is Level.MEDIUM and moved:
        template = MEDIUM_MOVED_LINE
    elif level is Level.WEAK and emailed:
        template = WEAK_EMAIL_DONE_LINE
    elif level is Level.WEAK and call:
        template = WEAK_CALL_LINE
    else:
        template = COMMITMENT_LINES[level]
    return template.format(decision_maker=decision_maker, slot=slot)


def stall_line(decision_maker: str) -> str:
    """The WEAK line, which is also the only response permitted before the close window."""
    return commitment_line(Level.WEAK, decision_maker)


def is_commitment_line(text: object, decision_maker: str) -> bool:
    """True when ``text`` is (a fuzzy rendering of) one of the scripted lines."""
    return any(
        fuzzy_contains(text, commitment_line(level, decision_maker, **variant))
        for level, variant in (
            (Level.STRONG, {}),
            (Level.MEDIUM, {}),
            (Level.MEDIUM, {"deferred": True}),
            (Level.WEAK, {}),
            (Level.WEAK, {"call": True}),
            (Level.WEAK, {"emailed": True}),
        )
    )


def mask_for_scorer(text: str, decision_maker: str) -> str:
    """Replace a scripted commitment line with a placeholder (it is never evidence)."""
    return MASK_PLACEHOLDER if is_commitment_line(text, decision_maker) else text


_DAY = r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight)"
_CLOCK = r"\d{1,2}(?::\d\d)?\s*(?:am|pm)"


def _compile(*patterns: str) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(pattern, re.IGNORECASE) for pattern in patterns)


# ----------------------------------------------------------------------------------
# Advisor speech acts: who acts, with whom, when and what  (R1-Q iteration 1)
#
# The old detectors were long lists of phrasings, and every review round found one more phrasing
# that broke one of them.  The reading below asks four structural questions of a sentence instead,
# and the labelled corpus (tests/fixtures/r1_advisor_corpus.jsonl, scored by
# tests/test_r1_detector_corpus.py) keeps the answers honest:
#
#   1. WHO ACTS.  An offer or a promise needs the advisor as its subject (I or we with a modal,
#      "let me", "let's", "shall I", "how about I"), a question to the learner ("would you like
#      ..."), or an imperative.  "You can book ..." and "the coach will call you ..." describe the
#      programme.
#   2. WITH WHOM.  A proposed call is with THIS learner: "with you", "you and your husband", a
#      purpose ("to answer your questions") or a concrete day or clock time.  A mentor, a TA or an
#      expert as the other party is the programme unless the sentence is a question to the
#      learner or a singular "I" offer; a batch, a class or a cohort is never a call.
#   3. WHEN.  A programme timeline (once you enrol, in the third month, every week, anytime) is a
#      pitch; a day, a clock time or "after you have read it" is a proposal.
#   4. WHAT.  Sending "the details" is an e-mail offer, "the payment link" or "your seat" is an
#      enrolment ask, and "we will get back to you with the placement stats" delivers information
#      and proposes no call.
# ----------------------------------------------------------------------------------
_UNITS = (
    r"(?:week|weeks|day|days|month|months|class|classes|session|sessions|module|modules|"
    r"lecture|lectures|weekend|weekends|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"evening|evenings|morning|mornings|fortnight|term|semester|batch|cohort|phase|sprint|"
    r"quarter|year)"
)
CADENCE = re.compile(
    r"\b(?:every|each) (?:other |single )?(?:\w+ )?" + _UNITS + r"\b"
    r"|\b(?:weekly|daily|monthly|fortnightly|bi-?weekly|annually|yearly)\b"
    r"|\b(?:once|twice|thrice|\w+ times) (?:a|per|every|each) (?:week|month|day|fortnight|year)\b"
    r"|\bper (?:week|month|day|class|session)\b"
    r"|\b(?:any ?time|at any time|any day|as often as|whenever you (?:need|want|like|wish|feel|"
    r"get stuck|are stuck|are struggling|miss))\b",
    re.IGNORECASE,
)
_JOINED = (
    r"(?:enrol+(?:ed|ment)?|sign(?:ed|ing)? up|register(?:ed|ing)?|registration|pay(?:ing|ment)?|"
    r"paid|join(?:ed|ing)?(?!\s+(?:the |this |a |our |my )?(?:call|meeting|chat|session|"
    r"conversation|zoom|link|us for (?:a|the|this) (?:call|chat|session)))|"
    r"start(?:ed)? (?:the |your |our )?(?:program|programme|course|classes|bootcamp|batch|"
    r"cohort)|begin (?:the |your )?(?:program|programme|course|classes)|"
    r"graduat\w+|complet\w+ (?:the |your )?(?:program|programme|course|module|capstone)|"
    r"finish(?:ed)? (?:the |your )?(?:program|programme|course|module|capstone)?|"
    r"through (?:the |your )?(?:first|second|third|last|final) (?:module|week|month|phase))"
)
PROGRAMME_TIMED = re.compile(
    r"\b(?:once|after|when|as soon as|before|until) (?:you(?:'ve| have|'re| are|'ll| will)? |"
    r"your |the )?" + _JOINED + r"\b"
    r"|\b(?:after|upon|post|before) (?:the |your |their )?(?:enrol+ment|registration|joining|"
    r"sign-?up|graduation|completion)\b"
    r"|\bduring (?:the|your|our) (?:program|programme|course|bootcamp|cohort|batch|classes|term|"
    r"six months|6 months|live|capstone)\b"
    r"|\bthroughout (?:the|your|our)\b"
    r"|\b(?:in|on|at|by|during|within|for) (?:the )?(?:first|second|third|fourth|fifth|sixth|"
    r"seventh|eighth|last|final|\d+(?:st|nd|rd|th)) (?:day|week|month|module|phase|semester|"
    r"term|class|session|quarter)s?\b"
    r"|\b(?:at|by) the (?:start|beginning|end) of (?:the|each|every|your|our)\b"
    r"|\b(?:before|after|during) (?:each |every |your |our )(?:live |weekly |first )?(?:class|"
    r"classes|session|sessions|lecture|lectures|webinar|workshop|orientation|capstone)\b"
    r"|\b(?:when|once|after|as soon as) (?:the |your |our )?(?:batch|cohort|class(?:es)?|course|"
    r"program(?:me)?|bootcamp|term) (?:starts?|begins?|kicks off|is confirmed|opens?|ends?|"
    r"finishes|is over|completes|is full)\b"
    r"|\bon (?:the )?(?:next|first|last) (?:session|class|day|module)\b"
    r"|\b(?:the )?(?:second|moment|minute|instant) (?:you|your)\b"
    r"|\bas part of (?:the|your|our)\b|\bincluded (?:in|with)\b"
    r"|\bpart of (?:the|your|our) (?:program|programme|course|package|plan|fee)\b"
    r"|\bif you (?:miss|skip|fall behind|get stuck|are stuck|struggle|need help|need)\b",
    re.IGNORECASE,
)
# What the programme itself provides: a match next to these words is a pitch.
_FEATURE = re.compile(
    r"\b(?:mentors?|mentorship|mentoring|coach(?:es)?|coaching|instructors?|trainers?|faculty|"
    r"teachers?|teaching assistants?|tas?|alumni|experts?|recruiters?|peers?|classmates?|"
    r"hiring managers?|placement officers?|senior \w+|industry \w+|buddy|"
    r"mock interviews?|interview prep\w*|office hours?|one[- ]on[- ]one|1[- ]on[- ]1|1:1|"
    r"live (?:class|classes|session|sessions|lecture|lectures|q ?& ?a|doubt)|"
    r"doubts?[- ](?:clearing|solving|resolution|session)|webinars?|workshops?|"
    r"resume (?:review|workshop)|career services|community|group chat|capstone|"
    r"onboarding|orientation|induction|kick-?off|welcome (?:call|session)|"
    r"placement (?:support|team|assistance))\b",
    re.IGNORECASE,
)
# A batch, a class or a cohort is the programme's own schedule, never a call with this learner.
_PROGRAMME_NOUNS = re.compile(
    r"\b(?:batch|batches|cohort|cohorts|class|classes|course|program|programme|bootcamp|lecture|"
    r"lectures|webinar|workshop|curriculum|module|modules|timings?|semester)\b",
    re.IGNORECASE,
)
_BATCH_SLOT = re.compile(
    r"\b(?:slot|seat|spot|place)s?\b[^.?!]{0,25}\b(?:batch|cohort|class|course|program)\b"
    r"|\b(?:batch|cohort)\b[^.?!]{0,15}\b(?:slot|seat|spot|place)s?\b",
    re.IGNORECASE,
)
# "session" and "slot" are the programme's own words (a class, a mentor session), so a match that
# ends in one needs a sign that the advisor means a conversation with THIS learner.
_SESSION_NOUN = re.compile(r"\b(?:session|slot)s?\W*$", re.IGNORECASE)
_LEARNER_CUE = re.compile(
    r"\b(?:with|for|and) (?:you|me|us|him|her|them)\b|\byou and\b|\byou both\b|\bboth of you\b"
    r"|\byour (?:husband|wife|partner|spouse|father|mother|parents|family|dad|mom|roommates?)\b"
    r"|\b(?:tomorrow|tonight|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b"
    r"|\b\d{1,2}(?::\d\d)?\s*(?:am|pm)\b"
    r"|\b(?:follow[- ]?up|quick|short|brief|another|second|one more|counsel+ing|discussion)\b"
    r"|\bto (?:talk|discuss|go over|walk you|explain|answer|review|chat|hear|work out|plan|"
    r"finali[sz]e|map|confirm|check|figure)\b",
    re.IGNORECASE,
)
# When: a day, a clock time, a relative moment, or "after you have read it".
_CLOCK_TIME = r"\d{1,2}(?::\d\d)?\s*[ap]\.?\s?m\b\.?"
_WHEN_CUE = re.compile(
    r"\b(?:tomorrow|tonight|today|later (?:today|tonight|this week)|monday|tuesday|wednesday|"
    r"thursday|friday|saturday|sunday|weekends?|weekdays?|(?:early |later )?(?:next|this) "
    r"(?:week|month)|end of (?:the )?week|"
    r"(?:in|within) (?:a|an|one|two|three|four|five|six|seven|ten|a few|a couple of|couple of|"
    r"few|\d+) (?:minutes?|hours?|days?|weeks?|months?)|"
    r"(?:one|two|three|four|five|six|seven|\d+) (?:days?|weeks?|hours?) from now|"
    r"(?:in|after|once|when|before|as soon as) you(?:'ve| have)? (?:read|reviewed|talked|spoken|"
    r"discussed|checked|looked|gone|sat|had|thought|decided|run|seen)|"
    r"evenings?|mornings?|afternoons?|nights?|noon|midnight|lunch|o'?clock|same time|"
    r"sometime)\b|" + _CLOCK_TIME,
    re.IGNORECASE,
)
_CONCRETE_DAY = re.compile(
    r"\b(?:tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"(?:early |later )?(?:next|this) (?:week|weekend)|this weekend|(?:in|within) (?:a|an|one|two|"
    r"three|four|five|six|seven|ten|a few|a couple of|couple of|few|\d+) (?:minutes?|hours?|days?|"
    r"weeks?)|evenings?|mornings?|afternoons?|noon|midnight|o'?clock|same time|sometime|"
    r"weekends?|weekdays?|later today|lunch)\b|" + _CLOCK_TIME + r"|\b\d{1,2}\b(?=\s*(?:works?|"
    r"suits?|okay|ok|is fine|is good)\b)",
    re.IGNORECASE,
)
# Who the call is with: this learner (and their people), or a stated purpose.
_WITH_LEARNER = re.compile(
    r"\b(?:with|for|and) (?:you|me|us|him|her|them|your \w+)\b|\byou and\b|\byou both\b"
    r"|\bboth of you\b|\bthe two of you\b|\byour (?:husband|wife|partner|spouse|father|mother|"
    r"parents|family|dad|mom|roommates?)\b|\bto (?:talk|discuss|go over|walk|explain|answer|"
    r"review|chat|hear|work out|plan|finali[sz]e|map|confirm|check|see|figure|cover|look)\b"
    r"|\b(?:your|any) (?:questions|thoughts|concerns|doubts)\b",
    re.IGNORECASE,
)
# Information handed over, not a conversation: "we will get back to you with the placement stats".
_INFO_NOUN = (
    r"(?:details|stats|statistics|numbers|information|info|answers?|options|updates?|schedule|"
    r"brochure|curriculum|figures|data|outcomes?|breakdown|confirmation|pricing|prices?|"
    r"fees?|recap|summary|outline|plans?|overview|syllabus|timetable|dates)"
)
_INFO_AFTER = re.compile(
    r"^[^.?!]{0,25}\bwith (?:the |your |all (?:the |your )?|those |these |some |more |a |an |any )?"
    r"(?:[\w-]+ ){0,2}" + _INFO_NOUN + r"\b",
    re.IGNORECASE,
)
# "I'll text you the payment plan comparison tonight": a message that carries information is an
# information send, not a call (R1-Q ship de-risk: it was read as a call proposal in the close
# window and booked a call at the farewell; the production detector reads it as nothing).
_MESSAGE_YOU = re.compile(r"\b(?:text|message|whatsapp|ping)(?:ing)? you$", re.IGNORECASE)
# (Ship-gate round 1: a link, a page or a form is information too: "text you the link to the demo".)
_INFO_DIRECT = re.compile(
    r"^\s+(?:the |your |all (?:the |your )?|those |these |some |more |a |an |any |over |across |"
    r"out )*(?:[\w-]+ ){0,2}(?:" + _INFO_NOUN + r"|links?|pages?|forms?)\b",
    re.IGNORECASE,
)
# Questions ABOUT the programme or knowledge questions: "Did you know you can book ...?".
_KNOWLEDGE_Q = re.compile(
    r"\b(?:did|do|does|would|can|could|will|should) (?:you|students|learners|people|everyone|"
    r"they|one) (?:know|realize|realise|imagine|remember)\b"
    r"|\bwould it help to know\b|\bwant to know\b|\bwondering how\b|\bcurious about\b"
    r"|\b(?:isn'?t|aren'?t|wasn'?t) (?:it|that|this|they)\b"
    r"|\bhow do (?:students|learners|people|they)\b"
    r"|\bwhy do (?:you think|students|learners|people)\b"
    r"|\b(?:can|do|does|are|will|could|would) (?:students|learners|people|participants|"
    r"candidates)\b|\bwhat (?:students|learners|people) \w+",
    re.IGNORECASE,
)
# The learner is asked to contact the advisor ("call me back", "get back to me"): not a proposal.
_ASKS_LEARNER_TO_CONTACT = re.compile(
    r"\b(?:call|ring|phone|ping|text|message|email|e-mail|reach|contact|write to|reply to|"
    r"get back to|come back to|check back with|talk to|speak to|speak with) (?:me|us)\b"
    r"|\bgive (?:me|us) a (?:call|ring|buzz|shout)\b",
    re.IGNORECASE,
)
_MAX_SENTENCE = 700
# The call we are on: "after the call", "once we finish this call", "on this call".
_EXISTING_CALL = re.compile(
    r"\b(?:after|before|during|on|at the end of|finish|finishing|end|ending|hang up|wrap up|"
    r"through|over)\s+(?:this|the|our|that)\s+(?:call|chat|conversation|session|meeting)\b"
    r"|\b(?:this|our) (?:call|conversation|chat)\b",
    re.IGNORECASE,
)
# The advisor explaining why THIS call is happening, in the past or progressive: "so I thought
# I'd give you a quick call", "I'm just calling to say hi", "I wanted to call you about the
# form".  (R1-Q iteration 3: a greeting like that was logged as a call proposal and the learner
# answered it with a money stall in its first reply.)  A later moment in the sentence makes it a
# proposal again.
_THIS_CALL_FRAME = re.compile(
    r"\b(?:thought|figured|decided|wanted|had to|needed to|was going to|just wanted to|"
    r"i'?m (?:just )?(?:calling|ringing|phoning|reaching out)|"
    r"i (?:just )?(?:called|rang|phoned))\b"
    r"[^.?!]{0,30}\b(?:give you|gave you|call you|ring you|call|reach out|touch base|check in|"
    r"follow up)\b",
    re.IGNORECASE,
)
# A LATER moment: with one of these the sentence proposes another call ("I wanted to call you
# back tomorrow", "I thought I'd follow up after you talk to your husband").  "Today" is not one.
_LATER_CUE = re.compile(
    r"\b(?:tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|later|"
    r"next (?:week|month|few)|this (?:week|weekend|evening)|(?:in|within) (?:a|an|one|two|three|"
    r"four|five|six|seven|ten|a few|a couple of|couple of|few|\d+) "
    r"(?:minutes?|hours?|days?|weeks?)|"
    r"(?:after|once|when|as soon as) you(?:'ve| have)?\b|evenings?|mornings?|afternoons?|noon|"
    r"sometime|call (?:you )?back|get back to you)\b|" + _CLOCK_TIME,
    re.IGNORECASE,
)
# Frames: who acts.  The advisor's own offer or promise, a request for permission, "let's".
_FP_OFFER = re.compile(
    r"\b(?:i|we)(?:'ll|'d|'m going to|'re going to|\s+(?:will|would|can|could|shall|should|may|"
    r"might|am going to|are going to|want to|plan to|need to|have to|also|just|then|"
    r"definitely|really|gladly|happily|still|even))\b"
    r"|\blet me\b|\blet us\b|\blet'?s\b"
    # "I'll send everything over, and can call Thursday": the subject is dropped.
    r"|\b(?:can|could|will|shall|may) (?:also )?(?:call|ring|phone|text|ping|reach out|follow up|"
    r"check back|check in|circle back|get back|talk|speak|connect)\b",
    re.IGNORECASE,
)
# The learner is invited to contact the advisor: "feel free to reach out", "just call".
_LEARNER_INITIATED = re.compile(
    r"\b(?:feel free to|free to|please|just|don'?t hesitate to|do not hesitate to|you can|"
    r"you could|you may|welcome to|if you|whenever you|when you|once you)\s+(?:\w+ ){0,2}?"
    r"(?:reach out|"
    r"call|ring|text|message|e-?mail|contact|get in touch|get back|come back|check back|"
    r"ping)\b",
    re.IGNORECASE,
)
# Checking that THIS call is a good moment ("a few minutes to chat?"), not a new call.
_NOW_CHECK = re.compile(
    r"\b(?:a|a few|a couple of|couple of|few|some) (?:minutes?|moments?|seconds?)\b[^.?!]{0,20}"
    r"\b(?:to|for) (?:chat|talk|speak|discuss)\b|\b(?:is|was) (?:now|this) (?:an? )?(?:good|bad|"
    r"okay|ok|fine|right|convenient|decent|alright|all right) (?:time|moment)\b|\b(?:right )?now\b"
    r"[^.?!]{0,15}\b(?:to|for) (?:chat|talk|speak)\b|\bgood time to (?:chat|talk|speak)\b|"
    r"\b(?:do|did) you have (?:a |a few |a couple of )?(?:minutes?|moments?|time)\b[^.?!]{0,25}"
    r"\b(?:to|for) (?:chat|talk|speak)\b",
    re.IGNORECASE,
)
# "Our team will call you tomorrow ...": the company's people acting for this learner.
_TEAM_FRAME = re.compile(
    r"\b(?:our|my|the) (?:[\w-]+ ){0,2}?(?:team|counsel+ors?|advis[eo]rs?|managers?|executives?|"
    r"specialists?|representatives?|admissions?|colleagues?)\b[^.?!]{0,12}\b(?:will|can|could|"
    r"would|shall|is going to|are going to)\b",
    re.IGNORECASE,
)
_SINGULAR_OFFER = re.compile(
    r"\b(?:i(?:'ll|'d)|i\s+(?:will|would|can|could|shall|may|might|also|just|then|definitely|"
    r"gladly|happily|still))\b|\blet me\b|\blet us\b|\blet'?s\b|\b(?:can|could|shall|should|may|"
    r"might|would|will|do) i\b|\b(?:what|how) about i\b|\bwant me to\b|\blike me to\b",
    re.IGNORECASE,
)
_ASK_PERMISSION = re.compile(
    r"\b(?:can|could|shall|should|may|might|would|will|do|did) (?:i|we)\b"
    r"|\b(?:what|how) about (?:i|we)\b|\bwhat if (?:i|we)\b|\bwhy (?:don'?t|not) (?:i|we)\b"
    r"|\b(?:want|like) me to\b|\bif (?:i|we) (?:could|can|were to|set|book|schedule|arrange)\b"
    r"|\b(?:would it be|is it|would that be|is that) (?:ok|okay|fine|alright|all right|good|"
    r"better)(?: with you)?(?: if| to| for)?\b|\bwould it help (?:if|to)\b",
    re.IGNORECASE,
)
_LEARNER_ASK = re.compile(
    r"\b(?:would|do|will|can|could|are|were|shall|did) you(?: and your \w+)?(?: (?:want|like|"
    r"prefer|wish|care|be open|be willing|be able|be free|be available|be up for|be ok|be okay|"
    r"be comfortable|be interested|mind|rather|join|do|make|manage|take|have))?\b",
    re.IGNORECASE,
)
_IMPERATIVE = re.compile(
    r"^\W*(?:(?:okay|ok|so|now|then|alright|great|sure|please|and|well|just|yes|perfect|fine|"
    r"look|listen|tell you what)\W+)*(?:please )?(?:schedule|book|set up|set|arrange|fix|pick|"
    r"choose|name|plan|organi[sz]e|pencil|line up|lock in|call|ring|text|give|reach out|"
    r"tell me|let me know|say|send|check|take|grab)\b",
    re.IGNORECASE,
)
_PICK_TIME = re.compile(
    r"\byou (?:pick|choose|name|decide|set|tell me)\b[^.?!]{0,20}\b(?:time|day|date|slot|when)\b"
    r"|\bpick (?:a|the|your) (?:time|day|date|slot)\b",
    re.IGNORECASE,
)

# What: a call.
_BOOK_VERB = (
    r"(?:schedul\w*|set(?:ting)? up|set(?:ting)?|book(?:ing)?|arrang\w*|line(?: up)?|fix|"
    r"plan(?:ning)?|organi[sz]\w*|pencil|lock(?:ing)? in)"
)
_CALL_NOUN = (
    r"(?:calls?|chats?|meetings?|conversations?|demo|sessions?|slots?|follow[- ]?ups?|"
    r"catch[- ]?ups?|check[- ]?ins?|touch ?base|sync|walk[- ]?through|discussions?|"
    r"appointments?|consultations?|counsel+ing)"
)
_TIME_NOUN = (
    r"(?:a|the|some|another|that|this|any|good|best) (?:good |best |convenient |suitable |right |"
    r"specific |better |weekday |weekend )?(?:time|day|date|evening|morning|afternoon|weekday|"
    r"weekend|slot)"
)
_PEOPLE = r"you"
# (pattern, needs_when): a follow-up or "talk again" is only a proposal with a moment attached.
_CALL_OBJECTS: tuple[tuple[re.Pattern[str], bool], ...] = (
    # book / schedule / set up ... a call, a chat, a session, a slot, a time
    (
        re.compile(
            r"\b" + _BOOK_VERB + r"\b(?: [\w'-]+){0,4}? (?:a |an |the |that |this |our |another |"
            r"your |some |one |any )?(?:[\w-]+ ){0,3}?" + _CALL_NOUN + r"\b",
            re.IGNORECASE,
        ),
        False,
    ),
    (
        re.compile(
            r"\b(?:schedul\w*|set(?:ting)? up|set|book(?:ing)?|arrang\w*|fix|find|pick|pencil in)"
            r"\b(?: [\w'-]+){0,3}? " + _TIME_NOUN + r"\b",
            re.IGNORECASE,
        ),
        False,
    ),
    # "a quick call", "another call", "the next call"
    (
        re.compile(
            r"\b(?:a|an|another|one more|the next|the follow[- ]?up|our next|a second) "
            r"(?:quick |short |brief |follow[- ]?up |second |further |ten[- ]minute |15[- ]minute |"
            r"20[- ]minute |\d+[- ]minute )?(?:call|chat|meeting|conversation|catch[- ]?up|"
            r"check[- ]?in)\b",
            re.IGNORECASE,
        ),
        False,
    ),
    # call you / ring you / give you a call / call back
    (
        re.compile(
            r"\b(?:call|ring|phone|ping|buzz|text)(?:ing)? " + _PEOPLE + r"\b"
            r"|\b(?:give|gave|giving) " + _PEOPLE + r" a (?:call|ring|buzz|shout)\b"
            r"|\b(?:call|ring|phone)(?:ing)? (?:you )?back\b",
            re.IGNORECASE,
        ),
        False,
    ),
    # "find twenty minutes", "carve out half an hour", "grab ten minutes": time for a conversation
    (
        re.compile(
            r"\b(?:find|carve out|set aside|grab|block|free up)\b(?: [\w'-]+){0,3}? "
            r"(?:minutes?|half an hour|an hour|a few minutes|some time)\b",
            re.IGNORECASE,
        ),
        False,
    ),
    # "hop on a Zoom", "jump on a quick video call", "get on a call", "have a quick word"
    (
        re.compile(
            r"\b(?:hop|jump|get|dial|log) (?:on|onto|into) (?:a |an |the |our )?(?:[\w-]+ ){0,2}?"
            r"(?:zoom|call|video call|meet|teams|hangout|chat)\b"
            r"|\bhave a (?:quick |brief |short )?(?:word|chat|natter|catch[- ]?up)\b",
            re.IGNORECASE,
        ),
        False,
    ),
    # follow up / check back / reach out / get back to you / touch base
    (
        re.compile(
            r"\bfollow(?:ing)?[ -]?up\b|\bcheck(?:ing)? (?:back|in)\b|\bcircle back\b"
            r"|\bloop back\b|\bcome back to you\b|\bget(?:ting)? back to you\b|\btouch base\b"
            r"|\breconnect\b|\breach(?:ing)? out\b|\bget in touch\b|\bbe in touch\b"
            r"|\bregroup\b|\breconvene\b|\bpick (?:this|it|that|things) up\b|\bresume\b|\brevisit\b"
            r"|\bcontinue (?:this|the (?:conversation|discussion|chat))\b",
            re.IGNORECASE,
        ),
        True,
    ),
    # "I could do tomorrow evening", "we can do Thursday at 7", "I'm free on Friday"
    (
        re.compile(
            r"\b(?:do|make it|manage|go with|say|fit you in|squeeze you in)\b"
            r"(?: [\w'-]+){0,2}? (?:" + _CONCRETE_DAY.pattern + r")"
            r"|\b(?<!your )(?<!the )(?<!a )(?:call|ring|phone|text|ping)\b(?: you| back)*(?: on| "
            r"at| in| this| next| around| by)? (?:" + _CONCRETE_DAY.pattern + r")"
            r"|\bi(?:'m| am) (?:free|available)\b[^.?!]{0,20}(?:" + _CONCRETE_DAY.pattern + r")",
            re.IGNORECASE,
        ),
        False,
    ),
    (
        re.compile(
            r"\b(?:talk|speak|chat|connect|catch up|meet|sync)(?:ing)? (?:again|tomorrow|"
            r"tonight|today|on|at|this|next|in|after|once|with you|to you|together|once more|"
            r"then)\b",
            re.IGNORECASE,
        ),
        True,
    ),
    (
        re.compile(
            r"\b(?:talk|speak)(?:ing)? (?:to|with) your (?:husband|wife|partner|spouse|"
            r"father|mother|dad|mom|family|parents)\b",
            re.IGNORECASE,
        ),
        False,
    ),
)
# A question about a day or a time ("What evening works best for you?", "Does 9 work?").
_TIME_ASKS = (
    re.compile(
        r"\b(?:what|which) (?:day|time|date|evening|morning|afternoon|weekday|slot|days|times|"
        r"evenings|mornings)\b[^.?!]{0,50}\b(?:works|work (?:for|best|better|well|out)|suit|suits|"
        r"good|convenient|best|better|free|available|preferable|prefer|fine|okay|ok)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bwhen (?:are|would|can|could|will) you (?:be )?(?:free|available|up for|ok|okay|"
        r"comfortable|around)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bwhen (?:can|could|shall|should|would|do|will) (?:i|we) (?:call|ring|phone|talk|speak|"
        r"connect|catch up|reach|get back|follow|check|touch|chat|meet)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:when|what time) should (?:i|we) (?:call|ring|phone|check|reach|follow|get back|"
        r"talk|speak)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bwhen (?:will|can|could|would) (?:you|i) (?:get|come|be) back\b|\bwhen (?:can|will) "
        r"i expect\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bwhen(?:'s| is| would be| works| would work| is better| is best| are you)\b[^.?!]{0,25}"
        r"\b(?:call|chat|meeting|talk|speak|time|catch up|moment|reconnect|connect|touch base|"
        r"follow(?:ing)?[- ]?up|get back|regroup|zoom|word)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:does|would|will|is|are|do|how about|what about|shall we do|shall we say|"
        r"can we do|could we do|how does|how'?s|if we say)\b[^.?!]{0,50}"
        r"\b(?:" + _DAY + r"|" + _CLOCK_TIME + r"|(?<![\d$,.])\d{1,2}(?![\d,.])|next week|"
        r"this week|this weekend|"
        r"sometime|lunch|same time|(?:one|two|three|four|five|six|seven|\d+) (?:days?|weeks?|"
        r"hours?) from now)\b"
        r"[^.?!]{0,50}\b(?:work|works|suit|suits|fine|ok|okay|good|convenient|better|sound|"
        r"sounds|best|alright)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:how about|what about|shall we (?:do|say|make it)|can we do|could we do|let'?s do|"
        r"let'?s say|let'?s make it|how does|how'?s)\b[^.?!]{0,30}"
        r"\b(?:" + _DAY + r"|" + _CLOCK_TIME + r"|next week|this week|this weekend|weekend|"
        r"evening|morning|afternoon|noon|lunch|sometime)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bdo you have (?:a |an |some )?(?:\w+ )?(?:minutes?|time|half an hour|an hour|a moment)\b"
        r"[^.?!]{0,30}\b(?:" + _DAY + r"|weekend|morning|evening|afternoon|" + _CLOCK_TIME + r")",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bare you (?:free|available|around|open)\b[^.?!]{0,40}\b(?:" + _DAY + r"|this week|"
        r"next week|weekend|call|tomorrow|tonight|later|evening|morning)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:" + _CLOCK_TIME + r"|o'?clock|" + _DAY + r")\b[^.?!]{0,25}\b(?:works?|suits?)\b"
        r"[^.?!]*\?",
        re.IGNORECASE,
    ),
)
# Questions about a "call" as such: "Would a quick call work?", "Is a call something you ...?".
_CALL_QUESTIONS = (
    re.compile(
        r"\b(?:would|could|can|will|is|does|do|shall we have|can we have|how about|what about|"
        r"are you open to|would you be open to|would you like|do you want|do you prefer)\b"
        r"[^.?!]{0,50}\b(?:a|an|another)\s+(?:[\w-]+ ){0,2}?(?:call|chat|meeting|"
        r"conversation|catch[- ]?up|check[- ]?in|follow[- ]?up|word|zoom|buzz|sync|huddle|"
        r"video call|three-way)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bwhat(?:'s| is| would be) (?:the |a )?(?:best |good |right )?next step\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bpencil (?:you|me|us|it|that|this|something) in\b", re.IGNORECASE),
    re.compile(
        r"\b(?:can|could|shall|should|may|will|i'?ll|let me) (?:i |we )?call (?:you )?back\b",
        re.IGNORECASE,
    ),
)

_BEFORE_CHARS = 30
_AFTER_CHARS = 30


def around(lowered: str, start: int, end: int) -> str:
    """The words next to the match at ``start:end``: where a pitch keeps its cadence or timeline.

    Only the neighbourhood counts, so a faraway "every week" or "mentors" in a long sentence
    cannot cancel a real proposal: "Let's schedule a call so I can walk you through how the
    mentors work" is still a proposal.
    """
    return lowered[max(0, start - _BEFORE_CHARS) : end + _AFTER_CHARS]


def describes_programme(near: str) -> bool:
    """True when ``near`` (``around`` a match) reads as the programme's cadence or timeline."""
    return CADENCE.search(near) is not None or PROGRAMME_TIMED.search(near) is not None


def _close_to_batch(lowered: str, start: int, end: int) -> bool:
    """The match sits next to a batch, class or course: a seat in the programme, not a call."""
    near = lowered[max(0, start - 25) : end + 25]
    wide = lowered[max(0, start - 45) : end + 45]
    return _PROGRAMME_NOUNS.search(near) is not None or _BATCH_SLOT.search(wide) is not None


# A schedule PITCH ends in a fit check but proposes nothing with this learner: "Our live classes run
# on Saturdays at 10 AM, would that work for you?", "The mentor sessions are on Tuesdays and
# Thursdays, does that suit you?".  R1-Q ship de-risk: read as a call proposal it became a pending
# ask, and the learner booked "let's book a call" at the farewell (5/5 early pitches) or earned an
# unearned MEDIUM in the close window (6/6).  The production detector gives a pitch a free reply.
_PLURAL_WEEKDAY = re.compile(
    r"\b(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b", re.IGNORECASE
)
# A party of THIS learner's, which makes a time question a real proposal ("is that good for you and
# your husband?", "I'll call you").
_LEARNER_PARTY = re.compile(
    r"\byour (?:husband|wife|partner|spouse|father|mother|parents|family|dad|mom)\b|\byou and\b"
    r"|\byou both\b|\bboth of you\b|\bthe (?:two|three) of (?:you|us)\b|\bwith you\b"
    r"|\b(?:call|ring|phone|text) you\b",
    re.IGNORECASE,
)


def _is_schedule_pitch(lowered: str) -> bool:
    """The sentence describes the programme's own schedule and offers nothing of the advisor's.

    It names the cadence, a programme feature or a plural weekday ("Saturdays") and neither a party
    of the learner's ("your husband", "you and") nor an "I'll" / "let's" offer.
    """
    if _LEARNER_PARTY.search(lowered) is not None or _SINGULAR_OFFER.search(lowered) is not None:
        return False
    return (
        describes_programme(lowered)
        or _FEATURE.search(lowered) is not None
        or _PLURAL_WEEKDAY.search(lowered) is not None
    )


def call_proposal_in(sentence: object) -> str | None:
    """The phrase that proposes a call, a time or a follow-up with THIS learner, or None.

    ``sentence`` is one sentence of the advisor.  See the block comment above for the four
    questions it answers; ``tests/test_r1_detector_corpus.py`` holds the labelled cases.  A schedule
    pitch that ends in a fit check ("... on Saturdays, would that work for you?") proposes nothing
    (``_is_schedule_pitch``), so the learner answers it freely, as in production.
    """
    lowered = fold(sentence).lower().strip()[-_MAX_SENTENCE:]
    found = _call_proposal_match(lowered)
    if found is None:
        return None
    phrase, from_time_ask = found
    if _is_schedule_pitch(lowered) and (
        from_time_ask or _PLURAL_WEEKDAY.search(lowered) is not None
    ):
        return None
    return phrase


def _call_proposal_match(lowered: str) -> tuple[str, bool] | None:
    """The phrase that proposes a call and whether it is a question about a day or a time."""
    if not lowered or _KNOWLEDGE_Q.search(lowered) is not None:
        return None
    if _NOW_CHECK.search(lowered) is not None and _CONCRETE_DAY.search(lowered) is None:
        return None
    if _THIS_CALL_FRAME.search(lowered) is not None and _LATER_CUE.search(lowered) is None:
        return None  # "I thought I'd give you a quick call": the call we are on
    asked = is_question_like(lowered)
    if asked:
        for pattern in _TIME_ASKS:
            match = pattern.search(lowered)
            if match is not None and not _close_to_batch(lowered, match.start(), match.end()):
                return match.group(0)[:40], True
    singular = _SINGULAR_OFFER.search(lowered) is not None
    framed = (
        _FP_OFFER.search(lowered) is not None
        or _TEAM_FRAME.search(lowered) is not None
        or _ASK_PERMISSION.search(lowered) is not None
        or _IMPERATIVE.match(lowered) is not None
        or _PICK_TIME.search(lowered) is not None
    )
    if asked:
        for pattern in _CALL_QUESTIONS:
            match = pattern.search(lowered)
            if match is None:
                continue
            near = around(lowered, match.start(), match.end())
            if describes_programme(near) or _close_to_batch(lowered, match.start(), match.end()):
                continue
            return match.group(0)[:40], False
    if _PICK_TIME.search(lowered) is not None:
        return "pick a time", False
    learner_asked = asked and _LEARNER_ASK.search(lowered) is not None
    if not framed and not learner_asked:
        return None
    if (
        _ASKS_LEARNER_TO_CONTACT.search(lowered) is not None
        and not asked
        and _FP_OFFER.search(lowered) is None
    ):
        return None
    for pattern, needs_when in _CALL_OBJECTS:
        for match in pattern.finditer(lowered):
            if _object_proposes_call(
                lowered, match, asked=asked, singular=singular, needs_when=needs_when
            ):
                return match.group(0)[:40], False
    return None


def _object_proposes_call(
    lowered: str, match: re.Match[str], *, asked: bool, singular: bool, needs_when: bool
) -> bool:
    """Whether one call-object ``match`` is a proposal given the sentence around it."""
    start, end = match.span()
    near = around(lowered, start, end)
    if describes_programme(near):
        return False
    if _close_to_batch(lowered, start, end):
        return False
    if _EXISTING_CALL.search(lowered[max(0, start - 14) : end]) is not None:
        return False  # "after the call", "this call": the call we are on, not a new one
    if _INFO_AFTER.match(lowered[end:]) is not None:
        return False
    if (
        _MESSAGE_YOU.search(lowered[start:end]) is not None
        and _INFO_DIRECT.match(lowered[end:]) is not None
    ):
        return False  # "I'll text you the details tonight": information, not a call
    if _LEARNER_INITIATED.search(lowered[max(0, start - 30) : end]) is not None:
        return False  # "feel free to reach out": the learner's move, not the advisor's offer
    if needs_when and _WHEN_CUE.search(lowered) is None:
        return False
    learner_cue = _WITH_LEARNER.search(lowered) is not None
    if _FEATURE.search(near) is not None and not (asked or (singular and learner_cue)):
        return False
    session_noun = _SESSION_NOUN.search(lowered[start:end]) is not None
    if session_noun and _LEARNER_CUE.search(lowered) is None:
        return False
    if asked:
        return True
    imperative = _IMPERATIVE.match(lowered) is not None
    lets = re.search(r"\blet'?s\b|\blet us\b", lowered) is not None
    if imperative or lets:
        return True
    # A statement: a concrete moment, or a stated purpose or company, makes it a proposal.
    return _WHEN_CUE.search(lowered) is not None or learner_cue


# What: an enrolment or a payment.  Ship restore (owner decision 2026-10-09: anything worse than
# production behaves exactly like production): this is origin/main's own enrolment-ask reading,
# its ``_ENROL_ASK`` and the per-sentence loop of its ``detect_ask``, verbatim.  The structural
# grammar that replaced it did not converge in five review rounds (each narrowing either missed
# an ask main reads or read an information send main does not); its misses and false positives
# are now production's, which the owner accepted.
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


def enrol_ask_in(sentence: object) -> str | None:
    """The phrase that asks the learner to enrol or pay in one advisor sentence, or None.

    Production's reading, verbatim (origin/main ``detect_ask``): the first ``_ENROL_ASK`` match.
    """
    lowered = fold(sentence).lower()
    for pattern in _ENROL_ASK:
        match = pattern.search(lowered)
        if match:
            return match.group(0)[:40]
    return None


@dataclass(frozen=True)
class Ask:
    """A detected ask: its kind and the matched phrase (a few words, for logs)."""

    kind: AskKind
    phrase: str


def ask_acts(text: object) -> dict[AskKind, Ask]:
    """Every kind of ask in the advisor's ``text``: an enrolment ask, a call ask, or both.

    A turn can hold both ("Let me send you an email, and could we lock in a short call?"); the
    corpus test of the detectors (``tests/test_r1_detector_corpus.py``) scores each kind on its
    own, while ``detect_ask`` below keeps the engine's single answer.
    """
    found: dict[AskKind, Ask] = {}
    for sentence in split_sentences(text):
        if AskKind.ENROL not in found:
            phrase = enrol_ask_in(sentence)
            if phrase is not None:
                found[AskKind.ENROL] = Ask(AskKind.ENROL, phrase)
        if AskKind.CALL not in found:
            phrase = call_proposal_in(sentence)
            if phrase is not None:
                found[AskKind.CALL] = Ask(AskKind.CALL, phrase)
    return found


def detect_ask(text: object) -> Ask | None:
    """Return the strongest enrolment or call ask in the advisor's ``text``, if any.

    An enrolment ask outranks a call ask.  Detection is purely lexical and
    deterministic, so a prompt-injection string cannot talk the worker into or out of
    treating a turn as an ask.
    """
    found = ask_acts(text)
    return found.get(AskKind.ENROL) or found.get(AskKind.CALL)


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


# How far back a negator may sit from the end of a commitment phrase and still govern it.  A clause
# break (comma, full stop, "but") ends the reach, so "I can't do Tuesday, but Thursday works" keeps
# its Thursday.
_NEGATION_REACH_WORDS = 10
def _affirms(patterns: Iterable[re.Pattern[str]], lowered: str) -> bool:
    """True when one of ``patterns`` matches ``lowered`` without a negator in its own clause.

    "And ten tomorrow won't work" and "I don't think tomorrow works" contain the words of an
    agreement ("tomorrow ... works") and mean the opposite (R1-Q iteration 2: both were graded
    MEDIUM and flagged the live call).  A negator inside the match, or earlier in the same clause,
    turns the phrase round.
    """
    for pattern in patterns:
        for match in pattern.finditer(lowered):
            if negated_before(lowered, match.end(), _NEGATION_REACH_WORDS):
                continue
            return True
    return False


def classify_learner_commitment(text: object) -> Level:
    """The highest commitment level expressed in learner ``text``.

    STRONG is an enrolment or payment affirmation; MEDIUM is accepting or proposing a
    call, a day or a time; WEAK is the "let me think, email me" stall.  The scripted
    lines classify as their own level, and every scripted objection line classifies at
    most WEAK.  A phrase a negator governs ("tomorrow won't work", "I don't think Thursday
    works") agrees to nothing.
    """
    folded = fold(text)
    lowered = folded.lower()
    if _affirms(_STRONG, lowered):
        return Level.STRONG
    if fuzzy_contains(folded, COMMITMENT_LINES[Level.STRONG]):
        return Level.STRONG
    if _affirms(_MEDIUM, lowered):
        return Level.MEDIUM
    medium_line = COMMITMENT_LINES[Level.MEDIUM].replace("{decision_maker}", "")
    medium_line = medium_line.replace("{slot}", DEFAULT_SLOT)
    if fuzzy_contains(folded, medium_line, 0.7):
        return Level.MEDIUM
    if _affirms(_WEAK, lowered):
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
    # R1-Q: how many of the learner's stall reasons (timing, money, decision maker) the advisor
    # actually handled after the learner raised them.  Deterministic, so it only ever adds
    # evidence the worker itself observed.
    reasons_handled: int = 0
    # R1-Q iteration 3.  The advisor pressured or misled the learner (an offer outside the deck's
    # discounts, a coercive deadline: the integrity flags the scorer reads), or answered in a
    # handful of words all call (the mean advisor turn is under ``THIN_ADVISOR_MEAN_WORDS``).  A
    # prospect does not agree to a call with either: the live sweep booked one with all four pushy
    # advisors (each invented $2,000 to $4,800 off) and with all four terse ones.
    pressured: bool = False
    thin: bool = False


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
    legitimate urgency lever used.  MEDIUM: asked; at least 1 deep need released; and either
    at least 2 families answered or at least 1 stall reason handled (R1-Q: an advisor who
    solved the learner's stated reason has earned a call even if the judge was slow).
    Otherwise WEAK.  A call-only ask is capped at MEDIUM, because the learner is never
    offered a payment moment it did not ask for.  Missing tracker data (quality ``None``)
    counts as not answered, so a failed shadow judge can only lower the family evidence.  An
    advisor who pressured the learner or answered in a handful of words (R1-Q iteration 3:
    ``pressured`` / ``thin``) gets WEAK whatever else was done.
    """
    if evidence.ask_kind is None:
        return Level.WEAK
    answered = families_answered(evidence.family_quality)
    result = Level.WEAK
    if evidence.needs_released >= 1 and (len(answered) >= 2 or evidence.reasons_handled >= 1):
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
    if evidence.pressured or evidence.thin:
        result = Level.WEAK
    return result


def commitment_permitted(r_sec: float, families_complete: bool) -> bool:
    """A commitment other than the WEAK stall needs R >= 9:00 and all four families done."""
    return families_complete and r_sec >= COMMIT_PERMITTED_R_SEC
