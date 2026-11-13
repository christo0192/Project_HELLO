"""R1 owed-move scheduler: deterministic, worker-side, on the role-play clock R.

Plan 5.6.  The worker, not the LLM, decides which objection the learner owes next.  The
moves are:

    F3 value (primary, push)   F2 time (primary, push)   F1 price (anchor, counter)
    F4 stall (primary, push)   L-TIME-CUE                COMMIT-STALL

R1-Q: the worker decides WHAT is owed and the model voices it in context.  Each move
carries a worker-authored ``brief`` (what to raise, no candidate text), the exact
``must_say`` figures, ``markers`` (all-of groups of any-of regexes that prove it was
raised) and scripted ``variants`` (the first is ``line``) that the session appends if the
model's reply misses the markers.  Q-A and Q-B are no longer scheduled: they became
curiosity topics of the free replies (``r1_roleplay``).

Rules enforced here (each has a unit test):

* Discovery is protected: nothing is owed until the advisor makes a genuine value or
  pitch statement, or R reaches 5:00.  A greeting that merely names "Program Advisor" or
  "Interview Kickstart" is not a pitch (S0-B defect 3).
* At most ONE owed move per learner turn.
* A family is not opened until the previous family's exchange is answered.
* Topic triggers and spacing (R1-Q).  A primary is raised in context: the advisor's turn
  touched its topic (value, time, price, close) this turn or the last, or no objection was
  raised for ``IDLE_GAP_TURNS`` turns; and never closer than ``SPACING_TURNS`` learner
  turns after the previous objection of any family.  A push waits for an answer to its
  primary (the advisor touched the family's topic after it, or said
  ``SUBSTANTIVE_ANSWER_WORDS`` words that are not mainly a question or a request about the
  call) or ``PUSH_PATIENCE_TURNS`` turns.
* A deadline FORCES the move at the last learner turn that still lands on time, so spacing
  and triggers can never make a family unschedulable (S0-B defects 1 and 2).
* "Later deadlines shift instead": a move's effective deadline is
  ``max(nominal deadline, the turn its hard prerequisites were first met)``, so a late
  predecessor never makes its successors look late.  Slip is measured against that
  effective deadline; lateness against the nominal one is logged as well.
* A move that was not delivered (interrupted, TTS failure) stays owed.  Delivery is proven
  by the move's markers in the text that was actually played (``confirm_if_spoken``).
* L-TIME-CUE is only owed between 17:00 and 19:00 (after that the WEAK stall takes the
  turn), and a polite "thanks for your time" opener is not a farewell (``is_close_attempt``
  ignores the first minute, and that phrase until 4:00).  A farewell must END its
  sentence (only a name, "for now" or a closing courtesy may follow) and no later sentence
  of the turn may ask something, so "Take care of your kids first" or "That's all I have
  on the curriculum, any questions?" never cuts the role-play short.
* F1's counter follows the advisor's first concession or refusal, or, if the advisor never
  answers the anchor, the second candidate turn after it (S0-B: it was never owed in 4 runs).
* Any family slipping more than 60 s, or never delivered, excludes the session from
  auto-status.

The module is pure: it never reads a clock, so every test drives R explicitly.
"""
from __future__ import annotations

import functools
import re
from dataclasses import dataclass

from r1_commitment import (
    COMMIT_PERMITTED_R_SEC,
    COMMIT_STALL_R_SEC,
    commitment_line,
    detect_ask,
    Level,
)
from r1_script import LINES
from r1_text import (
    fold,
    fuzzy_contains,
    is_hollow_turn,
    is_question_like,
    normalize,
    split_sentences,
    word_count,
)

PLAN_VERSION = 2
SLIP_LIMIT_SEC = 60.0
DEFAULT_TURN_SEC = 45.0
LOOKAHEAD_MIN_SEC = 20.0
LOOKAHEAD_MAX_SEC = 90.0
# At least this many learner turns between two objections of any family (one normal turn).
SPACING_TURNS = 2
# A primary whose topic never came up is raised after this many turns without an objection.
IDLE_GAP_TURNS = SPACING_TURNS + 1
# M032 S1 (owner decision D-M032-1, flag ``R1_NATURAL_TIMING``).  While the plan is ahead of its
# pacing map (``Moment.slack_ok``), the idle path waits for a natural moment: the advisor handed
# her the floor, or a thread just closed, and not while a thread is open (an offer, a back-off or
# a question put to her, or her own question just answered); after this longer quiet stretch it is
# ready again whatever the turn (the wait is bounded).  IDLE_GAP_TURNS itself is unchanged (the
# engine's SLACK_TURNS_PER_MOVE derives from it), and so are spacing, the topic trigger, the
# deadlines and the forced path.
IDLE_GAP_SLACK_TURNS = 5
# An advisor turn this long (and not a bare "Okay", nor mainly a question or a request about the
# call) counts as a substantive answer to a primary.
SUBSTANTIVE_ANSWER_WORDS = 8
PUSH_PATIENCE_TURNS = 2
F3_FALLBACK_OPEN_SEC = 300
TIME_CUE_SEC = 1020
EARLY_CLOSE_BEFORE_SEC = 840
MATCH_THRESHOLD = 0.78

F3_PRIMARY = "F3-PRIMARY"
F3_PUSH = "F3-PUSH"
F2_PRIMARY = "F2-PRIMARY"
F2_PUSH = "F2-PUSH"
F1_ANCHOR = "F1-ANCHOR"
F1_COUNTER = "F1-COUNTER"
F4_PRIMARY = "F4-PRIMARY"
F4_PUSH = "F4-PUSH"
COMMIT_STALL = "COMMIT-STALL"
TIME_CUE = "L-TIME-CUE"

TIME_CUE_LINE = LINES["L-TIME-CUE"]
# An early farewell is answered by the learner stopping the advisor (an intent, voiced by the
# model); these are the scripted openers of the fallback, one of three picked by the attempt.
REDIRECT_OPENERS = (
    "Oh wait, before you go...",
    "Sorry, one more thing before you go...",
    "Actually, before we wrap up...",
)
REDIRECT_BRIEF = (
    "the advisor sounds like they are wrapping up the call, so stop them politely for a "
    "moment because you have one more thing to bring up; then"
)
# M032 SWEEP-24 (flag R1_LATE_END_REQUEST): from R = 14:00 an explicit request to end the exercise
# when one owed move completes the schedule: Christy says it will stop in a moment
# (L-ASIDE-LAST-POINT) and the learner raises that move with this brief in place of REDIRECT_BRIEF,
# with no "Oh wait, before you go" opener.  Worker-authored, listed for review (D-M032-4).
LAST_POINT_BRIEF = (
    "the call is about to end, so raise this one last thing briefly, in a sentence or two; then"
)


@dataclass(frozen=True)
class MoveSpec:
    """One row of the plan 5.6 table.

    ``brief`` says what to raise (plain language, no candidate text); ``must_say`` are figures
    that must be written exactly; ``markers`` are all-of groups of any-of regexes proving the
    move was raised; ``variants`` are scripted alternatives to ``line`` (the first fallback).
    ``{decision_maker}`` is filled per persona, in regexes as an escaped literal.
    """

    id: str
    family: str | None
    role: str
    line: str
    deadline_sec: int | None
    required: bool
    brief: str = ""
    must_say: tuple[str, ...] = ()
    markers: tuple[tuple[str, ...], ...] = ()
    variants: tuple[str, ...] = ()
    # M032 S2 item 3 (flag R1_LEARNER_VOICE_V2, phone map spoken-style M10): the owed worry as an
    # objective (the feeling and what she wants to know, no sentence shape), voiced as a statement
    # or a question; and statement-form fallback variants tried before ``variants``.  F3 and F2
    # only: an F1 anchor is an ask.  The markers are unchanged and prove every variant.
    worry: str = ""
    worry_variants: tuple[str, ...] = ()


PLAN: tuple[MoveSpec, ...] = (
    MoveSpec(
        F3_PRIMARY,
        "F3",
        "primary",
        "There's so much free stuff on YouTube and Coursera \u2014 why pay?",
        430,
        True,
        brief=(
            "you doubt it is worth paying when so much free material is available online "
            "(YouTube, Coursera), and you ask what this gives you that free material does not"
        ),
        markers=(
            (r"\bfree\b", r"\byoutube\b", r"\bcoursera\b", r"\budemy\b", r"\bfor nothing\b"),
            (
                r"\bpay(?:ing)?\b",
                r"\bpaid\b",
                r"\bworth\b",
                r"\bmoney\b",
                r"\bcost(?:s|ly)?\b",
                r"\bprice\b",
                r"\bspend(?:ing)?\b",
                # "what does this give me that YouTube or Coursera doesn't?" (R1-Q iteration 2: 8
                # live replies that said it were given the scripted variant as well)
                r"\b(?:give|gives|giving|offer|offers|get|gets|bring|brings|pick|choose)\b"
                r"[^.?!]{0,25}\b(?:that|than|over|beyond|instead of)\b",
                r"\bdifference\b",
            ),
        ),
        variants=(
            "I can find a lot of this for free online. What would I be paying for?",
            "I keep seeing free courses everywhere, so why would I pay for this one?",
        ),
        worry=(
            "you doubt it is worth paying when so much is free online (YouTube, Coursera); what "
            "you want to know is what this would give you that free material does not"
        ),
        worry_variants=(
            "I can find a lot of this for free online, so I'm not sure it's worth paying for.",
            "There's so much free material on YouTube and Coursera that I'm not sure what paying "
            "would add.",
        ),
    ),
    MoveSpec(
        F3_PUSH,
        "F3",
        "push",
        "Will this actually get me a job, with all these layoffs?",
        430,
        True,
        brief=(
            "you wonder whether this would actually help you get a job, given the layoffs "
            "you keep hearing about"
        ),
        markers=(
            (
                r"\bjobs?\b",
                r"\bhired\b",
                r"\bhiring\b",
                r"\bplace(?:d|ments?)\b",
                r"\bemploy\w*",
                # "would this actually help me land something" (no "job" in the sentence)
                r"\bland\b[^.?!]{0,15}\b(?:something|a role|role|a job|an offer|work|anything|"
                r"a position|one)\b",
            ),
            (
                r"\blay ?offs?\b",
                r"\blaid off\b",
                r"\bmarket\b",
                r"\bguarantee\w*",
                r"\bland\b",
                r"\bget me\b",
                r"\b(?:actually|really) (?:get|help|lead|land|work)\b",
                r"\bhelp me (?:get|land|find)\b",
                r"\blead to\b",
            ),
        ),
        variants=(
            "And with so many layoffs going on, can this really help me land a job?",
            "Do people actually get jobs after this, given how the market is right now?",
        ),
        worry=(
            "with all the layoffs in the news you are not sure a course like this would really "
            "help you get a job; what you want to know is whether it actually leads to work"
        ),
        worry_variants=(
            "With all the layoffs right now, I'm not sure this would actually help me get a job.",
            "With so many layoffs around, I'm not sure a course like this would lead to a job for "
            "me.",
        ),
    ),
    MoveSpec(
        F2_PRIMARY,
        "F2",
        "primary",
        "My schedule is already packed; I'm not sure I can keep up for six months.",
        640,
        True,
        brief=(
            "you are worried that your schedule is already packed and that you cannot keep "
            "up for six months"
        ),
        must_say=("six months",),
        markers=(
            (
                r"\bschedules?\b",
                r"\bbusy\b",
                r"\bpacked\b",
                r"\btime\b",
                r"\bhours\b",
                r"\bweek\b",
                r"\bwork\b",
                r"\bfamily\b",
            ),
            (
                r"\bkeep(?:ing)? up\b",
                r"\b(?:six|6) months\b",
                r"\bmanage\b",
                r"\bcope\b",
                r"\bfit\b",
                r"\bhandle\b",
                r"\bbalance\b",
                r"\bstay(?:ing)? on track\b",
                r"\bstick(?:ing)? with\b",
            ),
        ),
        variants=(
            "My schedule is pretty packed, and six months feels like a long time to "
            "keep up.",
            "I'm quite busy as it is, so I'm worried about keeping up with this for six months.",
        ),
        # The worry states no course length of its own: the figure stays the move's must_say until
        # S2P (probe first) changes it.  The variants above are statements already.
        worry=(
            "your days are already full with work and home, and you are not sure you could keep "
            "up with a course this long on top of them"
        ),
    ),
    MoveSpec(
        F2_PUSH,
        "F2",
        "push",
        "What happens if I fall behind?",
        640,
        True,
        brief="you ask what happens if you fall behind",
        markers=(
            (
                r"\b(?:fall|falls|falling|fell|get|gets|getting|got) behind\b",
                r"\bmiss(?:ed|es|ing)? (?:(?:a|an|some|the|few|many|one|two|several|couple|of) )*"
                r"(?:class|classes|session|sessions|lecture|lectures|week|weeks|module)\b",
                r"\bcatch(?:ing)? up\b",
            ),
        ),
        variants=(
            "And if I miss a few classes, how do I catch up?",
            "What if I get busy at work and fall behind?",
        ),
        worry=(
            "you are scared that if work gets busy you would fall behind and not be able to catch "
            "up; what you want to know is what happens then"
        ),
        worry_variants=(
            "I'm worried that if work gets busy, I'd fall behind and never catch up.",
            "If I miss a few classes when work piles up, I'm scared I won't be able to catch up.",
        ),
    ),
    MoveSpec(
        F1_ANCHOR,
        "F1",
        "primary",
        "$9,000 is a lot. I've heard people got it for around $7,000 \u2014 can you do that?",
        810,
        True,
        brief=(
            "tell the advisor that $9,000, the price on the website, feels like a lot, that you "
            "heard people got it for around $7,000, and ask if they can do that"
        ),
        must_say=("$9,000", "$7,000"),
        markers=((r"(?<![\d,])7,?000\b", r"\bseven thousand\b", r"\b7k\b"),),
        variants=(
            "$9,000 feels like a lot, and I heard some people paid around $7,000. "
            "Can you match that?",
            "$9,000 is a big number for me, and I read people got this for about $7,000. "
            "Is that possible?",
        ),
    ),
    MoveSpec(
        F1_COUNTER,
        "F1",
        "push",
        "Can you do a little better than that?",
        810,
        True,
        brief="you push once more for a better price, because the number is above what you hoped",
        markers=(
            (
                r"\b(?:little|bit|touch|tad) (?:better|lower|less|more)\b",
                r"\bbetter (?:price|deal|number|offer)\b",
                r"\blow(?:er|est)\b",
                r"\bcome down\b",
                r"\bbring (?:it|that|the price|this) down\b",
                r"\bany (?:more |extra )?(?:room|flexibility)\b",
                r"\bbest (?:you|price|offer|number)\b",
                r"\bfinal (?:price|number)\b",
                r"\bstretch\b",
                r"\bdo better\b",
                r"\breduce\w*",
                r"\bdiscount\b",
                r"\bcheaper\b",
                r"\bflexibility\b",
                r"\bnothing\b",
                r"\bpayment plans?\b",
                r"\banything at all\b",
                # R1-Q iteration 3: "so what would I actually end up paying?" is the counter asked
                # as a question (the model's own, then given the scripted "what's the final number
                # you can do for me?" on top).  ("What would I be paying for?" is F3, not this.)
                r"\b(?:end up|ending up) paying\b",
                r"\b(?:actual|real|total) (?:price|number|cost)\b",
                r"\bwhat (?:would|will) (?:it|that) (?:actually )?(?:come to|cost)\b",
            ),
        ),
        variants=(
            "Is there any room to bring that down a bit more?",
            "Could you go a little lower for me?",
        ),
    ),
    MoveSpec(
        F4_PRIMARY,
        "F4",
        "primary",
        "Let me think about it \u2014 maybe I'll join the next cohort.",
        930,
        True,
        brief="you are not ready to decide today and might wait for the next cohort",
        markers=(
            (
                r"\bthink(?:ing)? (?:about|it|this|that|over)\b",
                r"\bdecid\w*",
                r"\bready\b",
                r"\bwait(?:ing)?\b",
                r"\bsleep on\b",
                r"\bmull\b",
                r"\bconsider\w*",
                r"\bhold off\b",
                r"\bnot sure\b",
            ),
            (
                r"\bcohort\b",
                r"\bbatch\b",
                r"\blater\b",
                r"\bnext\b",
                r"\byet\b",
                r"\btoday\b",
                r"\btomorrow\b",
                r"\bfew days\b",
                r"\bweek\b",
                r"\bsome time\b",
            ),
        ),
        variants=(
            "I'm not ready to decide today. Maybe the next cohort would suit me better.",
            "I think I need some time to think this over, probably for the next batch.",
        ),
    ),
    MoveSpec(
        F4_PUSH,
        "F4",
        "push",
        "I'd also need to talk to my {decision_maker}.",
        930,
        True,
        brief="you add that you would also need to talk to your {decision_maker} first",
        markers=(
            (r"\b{decision_maker}\b",),
            (
                r"\btalk(?:ing)?\b",
                r"\bdiscuss\w*",
                r"\bcheck\w*",
                r"\bask\w*",
                r"\brun (?:it|this|that) by\b",
                # "run all of this by my husband" (R1-Q iteration 3: it missed, and the line was
                # said again as "I'd also need to talk to my husband.")
                r"\brun\b[^.?!]{0,20}\bby\b",
                r"\bgo (?:over|through)\b[^.?!]{0,25}\bwith\b",
                r"\bspeak\b",
                r"\bconsult\w*",
                r"\btell\b",
                r"\bshow\b",
                r"\bmention\b",
                # "I'd want my father involved before anything moves" (not "my husband would be
                # involved in the payment anyway")
                r"\b(?:want|need|like|have|get|bring|keep)\b[^.?!]{0,20}"
                r"\b(?:involved|on board|in the loop)\b",
                r"\b(?:opinion|input|approval|blessing|go-?ahead)\b",
                r"\bhear from\b",
            ),
        ),
        variants=(
            "I'd want to run this by my {decision_maker} first.",
            "I should discuss it with my {decision_maker} before deciding.",
        ),
    ),
    MoveSpec(COMMIT_STALL, None, "stall", "", None, False),
    MoveSpec(
        TIME_CUE,
        None,
        "cue",
        TIME_CUE_LINE,
        None,
        False,
        brief=(
            "you tell the advisor that YOU only have a couple of minutes left before YOUR own "
            "next call; it is your time that is short, not theirs"
        ),
        markers=(
            (
                r"\bminutes?\b",
                r"\banother call\b",
                r"\bnext call\b",
                r"\bhop on\b",
                r"\bshort on time\b",
                r"\brunning out of time\b",
                r"\b(?:have|need|got|gotta) to (?:go|run|jump|leave|get going|wrap)\b",
                # R1-Q final review round 1: the learner's own wording of a persona-true reason
                # ("I do need to wrap up soon, I've got to get dinner going") was not proof, so the
                # scripted "before my next call" was appended for a learner who was at home.
                r"\bwrap(?:ping)? (?:it )?up\b",
                r"\bget(?:ting)? going\b",
                r"\bhead(?:ing)? out\b",
                r"\bget(?:ting)? dinner\b",
                r"\bleave soon\b",
            ),
        ),
        variants=(
            "Heads up, I can only stay a few more minutes, something is coming up.",
            "I should mention I only have a few minutes left before I need to get going.",
        ),
    ),
)
FAMILIES = ("F3", "F2", "F1", "F4")


# ----------------------------------------------------------------------------------------------
# M032 S2P, probe first (owner decision D-M032-7, S2 item 10; flag R1_PROBE_FIRST, read and latched
# by the engine).  The learner never states a course fact the advisor has not said.  F2's and F4's
# owed moves are worded without one (the markers are unchanged and prove every text below), and
# the F1 and F2 families may open with a PROBE: a short question about the price or the time the
# course takes, which delivers nothing graded (the move stays owed and reacts to the answer).
# ----------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class ProbeSpec:
    """A probe step (S2.10): what she asks before the family's owed point, and its fallbacks.

    ``markers`` prove the question was asked (a reply that asked it gets no scripted tail);
    ``variants`` are the scripted questions, tried in a seeded rotation.
    """

    family: str
    brief: str
    markers: tuple[tuple[str, ...], ...]
    variants: tuple[str, ...]


PROBE_F1 = ProbeSpec(
    "F1",
    "you want to know what the course costs before you think about anything else; ask the advisor "
    "in a short question of your own, and do not say or guess any figure yourself",
    (
        (r"\bhow much\b", r"\bcosts?\b", r"\bfees?\b", r"\bprice\b", r"\bcharge\b"),
        (r"\?",),
    ),
    (
        "How much is the course, by the way?",
        "What's the fee like?",
        "And what would the course cost me?",
    ),
)
# Her second price question after the advisor did not name a figure (the first dodge).
PROBE_F1_AGAIN = ProbeSpec(
    "F1",
    "you asked what the course costs and the advisor has not told you yet; ask once more, briefly "
    "and politely, in your own words, and do not say or guess any figure yourself",
    PROBE_F1.markers,
    (
        "Sorry, I didn't catch it. What would the course actually cost?",
        "And the fee itself, how much would that be?",
        "Just so I know, what's the price of the course?",
    ),
)
# The advisor talked about the price but named no figure: she asks what it comes to (SWEEP-19).
PROBE_F1_CLARIFY = ProbeSpec(
    "F1",
    "the advisor talked about the price but did not say a figure; ask in a short question what it "
    "would actually come to, and do not say or guess any figure yourself",
    PROBE_F1.markers,
    (
        "So what would it actually cost?",
        "And what's the actual fee, roughly?",
        "So how much would I be paying?",
    ),
)
PROBE_F2 = ProbeSpec(
    "F2",
    "you want to know how much time the course would take; ask the advisor in a short question how "
    "long it runs or how many hours a week it needs, and do not say or guess any figure yourself",
    (
        (
            r"\bhow long\b",
            r"\bhow many hours\b",
            r"\bhow much time\b",
            r"\bhours\b",
            r"\bweeks?\b",
            r"\bmonths?\b",
            r"\bduration\b",
        ),
        (r"\?",),
    ),
    (
        "How long does the course run?",
        "How many hours a week would it take?",
        "How much time would it take each week?",
    ),
)
PROBES: tuple[ProbeSpec, ...] = (PROBE_F1, PROBE_F1_AGAIN, PROBE_F1_CLARIFY, PROBE_F2)
# F2-PRIMARY and F4-PRIMARY without a course fact (the line, then the variants; S2.10).  F2: her
# packed schedule against a course of any length ("a long course" on the forced path, SWEEP-17 item
# 7).  F4: not ready to decide today, without the cohort she knows nothing about.
F2_PRIMARY_BRIEF_V2 = (
    "you are worried that your schedule is already packed and that you could not keep up with the "
    "course on top of it"
)
F2_PRIMARY_WORRY_V2 = (
    "your days are already full with work and home, and you are not sure you could keep up with "
    "the course on top of them"
)
F2_PRIMARY_LINE_V2 = (
    "My schedule is already packed; I'm not sure I could keep up with a long course."
)
F2_PRIMARY_VARIANTS_V2 = (
    "I'm quite busy as it is, so I'm worried about keeping up with a course on top of everything.",
    "My days are already full with work, so I'm not sure I could manage the course as well.",
)
F4_PRIMARY_BRIEF_V2 = (
    "you are not ready to decide today and want some time to think it over before you decide"
)
F4_PRIMARY_LINE_V2 = "I'm not ready to decide today; I need some time to think it over."
F4_PRIMARY_VARIANTS_V2 = (
    "I don't think I can decide today. I want some time to think about it first.",
    "I'm not ready to make a decision today, so let me think it over.",
)
# The owed moves whose texts change under probe first, and the course figures her scripted texts
# never hold then (SWEEP-17 item 7; the invariant test reads every learner text against it).
COURSE_LENGTH_FIGURE = re.compile(
    r"\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty-four)"
    r"[\s-]+(?:months?|weeks?)\b|\bhalf a year\b",
    re.IGNORECASE,
)


def probe_first_texts(move_id: str) -> tuple[str, str, str, tuple[str, ...]] | None:
    """(brief, worry, line, variants) of ``move_id`` under probe first, or None if unchanged."""
    if move_id == F2_PRIMARY:
        return (
            F2_PRIMARY_BRIEF_V2,
            F2_PRIMARY_WORRY_V2,
            F2_PRIMARY_LINE_V2,
            (F2_PRIMARY_LINE_V2, *F2_PRIMARY_VARIANTS_V2),
        )
    if move_id == F4_PRIMARY:
        return (
            F4_PRIMARY_BRIEF_V2,
            "",
            F4_PRIMARY_LINE_V2,
            (F4_PRIMARY_LINE_V2, *F4_PRIMARY_VARIANTS_V2),
        )
    return None


# R1-Q iteration 3.  "before my (own) next call" came back verbatim in 8 of 20 calls, also from a
# learner who was at home after work.  The cue is the same move said three ways (rotated by the
# attempt id); the markers accept all three.
# M032 SWEEP-27 (flag R1_TIME_CUE_V2; a95398ab p1): the first brief put her on "YOUR own next call"
# although she is at home after work.  The neutral wording replaces it while the flag is on (the
# spec's brief, pinned, is unchanged for the flag off); the markers already take "get going".
TIME_CUE_BRIEF_V2 = (
    "you tell the advisor that YOU only have a couple of minutes left before you need to get "
    "going; it is your time that is short, not theirs"
)
TIME_CUE_BRIEF_ALTERNATIVES = (
    "you tell the advisor that YOU can only stay for a couple more minutes because something else "
    "is coming up for you; it is your time that is short, not theirs",
    "you tell the advisor that YOU have to wrap up in a few minutes and leave soon; it is your "
    "time that is short, not theirs",
)
# Curiosity topics of the free replies (R1-Q): the two neutral questions that used to be
# scheduled (Q-A "live or recorded?", Q-B "what would I build?") plus more.  The engine hands the
# model one unasked topic every ``CURIOSITY_EVERY`` free replies.  L1 (mock call aa166f09: the pool
# of five was empty by 6:40, so the 18:30 check-in got "If you have no more questions, say so"): a
# topic is used up only when the learner's spoken question covers it (``curiosity_asked_in``) or
# the advisor already answered it, and three more topics joined the pool.
CURIOSITY_EVERY = 3
CURIOSITY_TOPICS: tuple[tuple[str, str], ...] = (
    ("format", "whether the classes are live or recorded"),
    ("build", "what you would actually build in the course"),
    ("payment", "whether you could pay in monthly instalments"),
    ("mentor_time", "how much time you would get with mentors"),
    ("weekly_hours", "how many hours a week it takes"),
    ("class_size", "how many people are in a batch"),
    ("prerequisites", "whether you need to know anything before you start"),
    ("job_search", "whether there is any help with the job search afterwards"),
)
# M032 SWEEP-12 (flag R1_TIC_V2): the labels the model read out as a question ("What would I
# actually build ...?" in six sessions, "Are the classes live or recorded?" in five) become phrases,
# rotated per session; her question about any of them still uses the topic up
# (``curiosity_asked_in(..., wide=True)``).
CURIOSITY_LABELS_V2: dict[str, tuple[str, ...]] = {
    "format": ("the class format", "live classes or recordings", "how the classes are run"),
    "build": (
        "the projects in the course",
        "the hands-on project work",
        "what gets built in the course",
    ),
    "payment": (
        "paying in monthly instalments",
        "a monthly payment option",
        "spreading the fee out",
    ),
    "mentor_time": ("time with mentors", "mentor access", "one-to-one mentor time"),
    "weekly_hours": ("the weekly time needed", "hours per week", "the time it takes each week"),
    "class_size": ("the batch size", "class size", "the number of people per batch"),
    "prerequisites": (
        "prerequisites",
        "the starting level needed",
        "any preparation before starting",
    ),
    "job_search": ("help with the job search", "job-search support", "support after the course"),
}
REQUIRED_MOVES = tuple(spec.id for spec in PLAN if spec.required)
SPEC_BY_ID = {spec.id: spec for spec in PLAN}
_ORDER = {spec.id: index for index, spec in enumerate(PLAN)}

# Simulation diagnosis 1 (U1, U2; flag R1_MARKERS_V2, latched per session by the engine): more
# any-of alternatives per marker group (by group index), so the worry in the model's new words
# proves the move and the scripted tail does not say it a second time in the same reply ("...run
# it past my husband. I'd also need to talk to my husband.").  Every marker of the release before
# stays; with the flag off the markers are exactly the release before.
EXTRA_MARKERS_V2: dict[str, tuple[tuple[str, ...], ...]] = {
    F2_PRIMARY: (
        (
            r"\bdays?\b",
            r"\bhome\b",
            r"\bkids\b",
            r"\bworkload\b",
            r"\bjob\b",
            r"\bevenings?\b",
            r"\bweekends?\b",
        ),
        (
            r"\bkeep(?:ing)? (?:pace|going)\b",
            r"\bon top of\b",
            r"\bsqueez\w*",
            r"\bfit (?:it|this|that) in\b",
        ),
    ),
    F2_PUSH: (
        (
            r"\b(?:fall|falls|falling|fell|fallen|get|gets|getting|got) (?:\w+ ){1,3}behind\b",
            r"\bpick (?:it |things )?(?:back )?up where\b",
            r"\bwhat happens (?:if|when)\b[^.?!]{0,40}\b(?:busy|miss\w*|behind|swamped|piles? up|"
            r"can'?t keep)\b",
        ),
    ),
    F4_PUSH: (
        (),
        (
            r"\brun (?:it|this|that|all of this|all this|everything) past\b",
            r"\bgo (?:over|through) (?:it|this|that|everything)\b",
        ),
    ),
    F1_COUNTER: ((r"\bfull price\b", r"\bnothing (?:added|extra)\b"),),
}

# Simulation diagnosis 2 (HF3, U1; the engine's R1_INTENT_TAIL_V3).  Her reply already made an owed
# point in its own words but missed a marker ("fitting the course around work and the kids"), so
# the scripted tail said the point a second time.  The tail is now the shortest of these statements
# that completes the markers together with her reply: a few words, never a second question.  Each
# carries the move's unchanged markers (new wording under D-M032-4, listed for review); F1-COUNTER's
# are per situation (``r1_negotiation.COUNTER_COMPLETIONS``).
TAIL_COMPLETIONS: dict[str, tuple[str, ...]] = {
    F2_PRIMARY: ("I'm just not sure I could keep up.", "I'm not sure how I'd fit it into my week."),
    F3_PRIMARY: (
        "I'm just not sure it's worth paying for.",
        "There's so much free online, I'm not sure it's worth it.",
    ),
    F3_PUSH: (
        "I'm just not sure it would lead to a job.",
        "I'm not sure it would really get me a job.",
    ),
    F4_PRIMARY: ("Not today, anyway.", "So I won't decide today."),
    F4_PUSH: (
        "I'd want my {decision_maker}'s input first.",
        "I'd need to talk to my {decision_maker} too.",
    ),
}
# The point of each move in words other than its markers: a reply that hits its theme already made
# the point, so only a completion is added (``{decision_maker}`` is filled, escaped).
TAIL_THEMES: dict[str, str] = {
    F2_PRIMARY: (
        r"\b(?:fit(?:ting)?|juggl\w*|packed|busy|schedule|keep(?:ing)? up|on top of|squeez\w*|"
        r"stretched|full|around (?:work|my|the kids|the family|everything))\b"
    ),
    F4_PRIMARY: (
        r"\b(?:think(?:ing)? (?:it|this|that|things) (?:over|through)|decid\w*|not ready|"
        r"sleep on|mull\w*|rush\w*|commit\w*|take (?:my|some|a bit of|a little) time)\b"
    ),
    F4_PUSH: r"\b(?:{decision_maker}|husband|wife|partner|father|mother|dad|mum|mom|parents?)\b",
    F3_PRIMARY: r"\b(?:free|online|youtube|coursera|udemy|worth|paying)\b",
    F3_PUSH: (
        r"\b(?:jobs?|hired|hiring|interviews?|offers?|lay ?offs?|laid off|market|placements?|"
        r"career)\b"
    ),
    # Negotiation lines (``r1_negotiation.NEGOTIATION_COMPLETIONS``).
    "N-PRICE-FIRST": r"\b(?:price|cost|fees?|how much|charge|number|figure)\b",
    "N-EMAIL-YES": r"\b(?:e-?mail\w*|summary|send\w*|details|writing)\b",
    F1_COUNTER: (
        r"\b(?:price|cost|pay(?:ing)?|total|final|all in|come to|number|figure|scholarship|"
        r"discount|cheaper|lower|afford\w*|budget|room)\b"
    ),
}


def tail_theme_hit(move_id: str, text: object, decision_maker: str) -> bool:
    """HF3, U1: ``text`` already makes ``move_id``'s point in some words (``TAIL_THEMES``)."""
    theme = TAIL_THEMES.get(move_id)
    if theme is None:
        return False
    pattern = re.compile(_fill(theme, decision_maker, regex=True), re.IGNORECASE)
    return pattern.search(fold(text)) is not None


def tail_completions(move_id: str, decision_maker: str) -> tuple[str, ...]:
    """HF3, U1: the move's completion statements, the decision maker filled in."""
    return tuple(_fill(text, decision_maker) for text in TAIL_COMPLETIONS.get(move_id, ()))


def widened_markers(
    move_id: str, markers: tuple[tuple[str, ...], ...]
) -> tuple[tuple[str, ...], ...]:
    """``markers`` with ``EXTRA_MARKERS_V2`` added to each group (R1_MARKERS_V2)."""
    extra = EXTRA_MARKERS_V2.get(move_id, ())
    return tuple(
        (*group, *(extra[index] if index < len(extra) else ()))
        for index, group in enumerate(markers)
    )


def _compile(*patterns: str) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(pattern, re.IGNORECASE) for pattern in patterns)


def _fill(text: str, decision_maker: str, *, regex: bool = False) -> str:
    """Put the persona's decision maker into a line, a brief or (escaped) a marker regex."""
    value = re.escape(decision_maker) if regex else decision_maker
    return text.replace("{decision_maker}", value)


@functools.lru_cache(maxsize=256)
def _compiled_markers(
    markers: tuple[tuple[str, ...], ...],
) -> tuple[tuple[re.Pattern[str], ...], ...]:
    return tuple(_compile(*group) for group in markers)


def markers_match(markers: tuple[tuple[str, ...], ...], text: object) -> bool:
    """True when every marker group has at least one regex that hits ``text``.

    No markers means "nothing to prove", which is NOT a delivery (the caller falls back to
    the verbatim line).  Pure; the text is folded and matched case-insensitively.
    """
    if not markers:
        return False
    folded = fold(text)
    return all(
        any(pattern.search(folded) for pattern in group) for group in _compiled_markers(markers)
    )


# A value or pitch statement describes what the product is or does.  Naming the company
# or the role ("Program Advisor", "Interview Kickstart") is a greeting, not a pitch.
_PITCH = _compile(
    r"\b(?:instructors?|mentor(?:ship|s|ing)?|career support|capstone|mock interviews?|"
    r"modules?|curriculum|alumni|placements?|hands-on|real-world|portfolio)\b",
    r"\b(?:we|ik|interview kickstart) (?:offer|provide|have|cover|teach|run|give|help|"
    r"specialize|focus|prepare|train)\w*\b",
    r"\b(?:the|our|this) (?:data science )?(?:course|program|programme|curriculum|bootcamp)"
    r"(?!\s+advisor)\b[^.?!]{0,30}\b(?:covers?|includes?|offers?|teaches|gives?|helps?|"
    r"prepares?|comes with|is designed|is built|takes you|lasts)\b",
    r"\byou(?:'ll| will) (?:learn|get|build|work|cover|gain|go through)\b",
    r"\bhelps? (?:you|people|engineers|professionals|learners|students)\b",
    r"\bfounded\b|\b750\b|\b18 (?:engineering )?domains\b|\b(?:google|facebook|amazon|netflix)\b",
    r"\bcareer[- ]transition (?:course|program|programme|support)\b",
)
_PRICE = _compile(
    r"\$\s?\d",
    r"\b\d[\d,]*\s*(?:dollars|usd)\b",
    r"\b(?:priced?|pricing|tuition|fees?|costs?)\b",
    r"\bdiscounts?\b",
)
_CONCESSION = _compile(
    r"\b(?:discounts?|off|reduc\w+|lower\w*|waive[ds]?|waiver|special|cashback|rebate|"
    r"scholarship|saving[s]?|bring (?:it|the price|that) down|come down|meet you|match)\b",
    r"\$\s?\d",
    r"\b\d{1,2}\s?%",
)
_REFUSAL = _compile(
    r"\b(?:can'?t|cannot|can not|unable|not able|no flexibility|not possible|"
    r"isn'?t possible|won'?t be able|don'?t have (?:the )?(?:flexibility|ability|room)|"
    r"that'?s (?:our|the) (?:best|lowest|final|fixed)|fixed (?:price|fee)|"
    r"not something we|we don'?t (?:negotiate|discount|offer)|"
    r"isn'?t (?:something|an option|available)|is not (?:something|an option|available)|"
    r"off the table|out of the question|won'?t (?:work|happen)|"
    r"that (?:is|'s) (?:as low as|as good as|the (?:best|lowest|final|limit)|our (?:best|"
    r"lowest|final))|best (?:i|we) can (?:do|offer)|as low as (?:i|we) can)\b",
)
_FORMAT = _compile(
    r"\blive (?:classes|sessions|lectures|instruction|mentoring|teaching|training|online|"
    r"and recorded|or recorded|plus recorded)\b",
    r"\b(?:classes|sessions|lectures|it)(?: are| is)? live\b",
    r"\b(?:mostly|fully|partly|all|entirely) (?:live|recorded)\b",
    r"\blive-?streamed?\b|\brecordings?\b|\brecorded (?:classes|sessions|lectures|videos?)\b",
    r"\bself[- ]paced\b|\bon[- ]demand\b|\bweekend batch\b|\bevening batch\b",
)
_PROJECTS = _compile(
    r"\byou(?:'ll| will) (?:build|work on|create|complete)\b",
    r"\b(?:build|building|built) (?:a|an|real|your|models?|pipelines?|dashboards?|projects?|"
    r"portfolio)\b",
    r"\bprojects? (?:like|such as|include|includes|where|that)\b",
)
# A farewell must END its sentence.  After the phrase only a first name, "for now", or a
# closing courtesy or promise may follow ("Take care, Meera - enjoy the week.", "Thanks
# for your time, and I'll send the details.").  A phrase that is followed by anything
# else is not a goodbye: "Take care of your kids first, I understand", "That's all I have
# on the curriculum, any questions?", "We can wrap it up quickly with a payment plan" and
# "Have a great day at work, but first ..." all keep the advisor on the call, and a false
# positive here costs a counted attempt its time.
_NAME_TAIL = (
    r"(?:[\s,-]+(?!(?:of|to|for|at|with|and|but|on|in|if|so|about|first|before)\b)"
    r"[a-z']{2,15}){0,2}"
)
# What may follow "thanks for your time" in a sign-off: well wishes, an invitation to get back
# ("let me know what you decide", "I hope this helps you decide", "no pressure, take your time",
# "looking forward to hearing from you").  A statement about the programme is not one.
# What may follow the opening words of a sign-off: a few more words, never a sentence that goes on
# to the next topic ("Let me know if anything is unclear as I walk you through the fees").
_SIGN_OFF_TAIL = (
    r"(?:(?!\b(?:next|now|then|because|while|where|walk|explain|cover|so let|as i|and i|"
    r"coming|moving)\b)[^?.!]){0,60}"
)
_CLOSING_COURTESY = (
    r"(?:good luck|best of luck|all the best|enjoy|feel free|please (?:reach|feel)|reach out|"
    r"let me know|let us know|i hope (?:this|that|it) (?:helps|helped|was|makes)|"
    r"i hope (?:to|we)\b|looking forward|i appreciate (?:your|the) (?:time|chat|call)|"
    r"it was (?:nice|great|a pleasure|good|lovely)|(?:a )?pleasure|no pressure|no rush|"
    r"take your time|whenever you(?:'re| are)? ready|when you(?:'re| are) ready|"
    r"don'?t hesitate|(?:keep|stay) in touch|see you)\b"
    + _SIGN_OFF_TAIL
)
_CLOSING_PROMISE = (
    r"(?:i|we)(?:'ll| will| can)\s+(?:send|follow|be in touch|get back|have|email|reach|call|"
    r"look|keep|check|share|forward|get|text|ping|connect|let you know|talk|speak|catch)\b"
    + _SIGN_OFF_TAIL
)
_CLOSING_SENTENCE = re.compile(
    r"^(?:(?:and|so|okay|ok|great|sure|alright)[,\s]+)*(?:" + _CLOSING_COURTESY + r"|"
    + _CLOSING_PROMISE + r")[\s.!]*$",
    re.IGNORECASE,
)
_FAREWELL_TAIL = (
    r"(?:\s+for (?:now|today|the day))?"
    + _NAME_TAIL
    + r"(?:\s*[,;-]*\s*(?:and\s+)?(?:" + _CLOSING_COURTESY + r"|" + _CLOSING_PROMISE + r"))?"
    r"[\s.!]*$"
)
_CLOSE_FAREWELL = _compile(
    r"\b(?:good ?bye|bye(?: bye)?)\b" + _FAREWELL_TAIL,
    r"\btake care(?:\s+of\s+your(?:self|selves))?\b" + _FAREWELL_TAIL,
    r"\b(?:talk|speak)(?: to you)? soon\b" + _FAREWELL_TAIL,
    r"\bhave a (?:great|good|nice|wonderful|lovely|fantastic|amazing) "
    r"(?:rest of (?:your|the) )?(?:day|workday|work ?week|evening|night|one|week|weekend)\b"
    + _FAREWELL_TAIL,
    r"\bi'?ll let you go\b" + _FAREWELL_TAIL,
    r"\bthat'?s all (?:from me|i have)\b" + _FAREWELL_TAIL,
    r"\b(?:let'?s|we can|i'?ll|i will) wrap (?:this|it|things) up(?: here| now| for today)?\b"
    r"[\s.!]*$",
    r"\bi think we'?re done(?: here)?\b[\s.!]*$",
    r"\bwe'?re (?:all )?done here\b[\s.!]*$",
)
# "Thanks for your time" is also a common OPENING courtesy, so it only counts as a
# farewell once the call is well under way, and only as the end of the sentence.
_CLOSE_THANKS = _compile(
    r"\bthanks? (?:you )?(?:so much )?(?:again )?for your time(?: today| again)?" + _FAREWELL_TAIL
)
CLOSE_MIN_R_SEC = 60
CLOSE_THANKS_MIN_R_SEC = 240
# A farewell comes last: a runaway turn is read from its end (and the reading stays linear).
CLOSE_MAX_CHARS = 12000
STT_TAIL_MIN_OTHER_WORDS = 20
STT_TAIL_MAX_WORDS = 4
# After "thanks for your time" only a word or two ("Bye.", "Take care.") may follow.
THANKS_TRAILING_WORDS = 3


def _sentences(text: object) -> list[str]:
    return [fold(sentence).lower() for sentence in split_sentences(text)]


# M032 SWEEP-19 item 6: the advisor asks what number or price works for her ("Which number would
# suit you?", "How much could you pay?"), in a question.  Narrow on purpose (SWEEP-6 may widen it).
_ASKS_HER_NUMBER = _compile(
    r"\b(?:what|which) (?:number|price|figure|amount)\b[^.?!]{0,40}\b(?:work|works|suit|suits|fit|"
    r"fits|good|okay|ok|comfortable|in mind|best)\b",
    r"\bhow much (?:can|could|would|are) you (?:able to )?(?:pay|afford|spend|do|manage)\b",
    r"\bwhat (?:were|are) you (?:hoping|looking|expecting|planning) to (?:pay|spend)\b",
    r"\bwhat(?:'s| is) your (?:number|price)\b",
)


def asks_her_number(text: object) -> bool:
    """The advisor asks what number would work for her (M032 SWEEP-19 item 6)."""
    return any(
        is_question_like(sentence) and any(pattern.search(sentence) for pattern in _ASKS_HER_NUMBER)
        for sentence in _sentences(text)
    )


def is_pitch_statement(text: object) -> bool:
    """A declarative sentence that describes what IK or the course is or does."""
    for sentence in _sentences(text):
        if is_question_like(sentence):
            continue
        if any(pattern.search(sentence) for pattern in _PITCH):
            return True
    return False


def quotes_price(text: object) -> bool:
    """The advisor states or raises the price (an amount, or a price word, or a discount)."""
    for sentence in _sentences(text):
        if any(pattern.search(sentence) for pattern in _PRICE[:2]):
            return True
        if not is_question_like(sentence) and any(
            pattern.search(sentence) for pattern in _PRICE[2:]
        ):
            return True
    return False


def answers_price(text: object) -> bool:
    """A concession or a refusal: the advisor's first answer to the learner's anchor."""
    lowered = fold(text).lower()
    return any(pattern.search(lowered) for pattern in (*_CONCESSION, *_REFUSAL))


def has_refusal(text: object) -> bool:
    """The text declines, refuses or rules out something ("we can't", "isn't possible")."""
    lowered = fold(text).lower()
    return any(pattern.search(lowered) for pattern in _REFUSAL)


def covers_format(text: object) -> bool:
    """The advisor explained or raised live-versus-recorded delivery."""
    lowered = fold(text).lower()
    return any(pattern.search(lowered) for pattern in _FORMAT)


def covers_projects(text: object) -> bool:
    """The advisor explained what is built, not just that there is a capstone."""
    lowered = fold(text).lower()
    return any(pattern.search(lowered) for pattern in _PROJECTS)


# Topic triggers (R1-Q): which objection family the advisor's turn invited.  A discovery
# QUESTION about a topic ("have you tried free courses?") never triggers it: in the owner test
# (b58c7d9c, turn 35) the value objection landed on a question about the learner's blocker.
_VALUE_TALK = _compile(
    r"\b(?:free|youtube|coursera|udemy|certificates?|certification|worth|roi|outcomes?|"
    r"job market|salary hike|career growth)\b",
)
_SCHEDULE_TALK = _compile(
    r"\b(?:schedules?|timings?|time commitment|per week|a week|weekends?|weekdays?|evenings?|"
    r"flexib\w+|self[- ]paced|at your own pace|pace|deadlines?|batch(?:es)?|duration|"
    r"(?:six|6|\d+) months?|hours? (?:a|per|each|every) (?:week|day))\b",
)
_CLOSE_TALK = _compile(
    r"\bwhat do you think\b",
    r"\bshall we\b",
    r"\bnext steps?\b",
    r"\bmove forward\b",
    r"\b(?:e-?mail|mail|send)\b[^.?!]{0,30}\b(?:details|brochure|curriculum|information|info|"
    r"link|summary)\b",
    r"\bcall (?:you )?back\b",
    r"\bwhen (?:you|i|we) (?:call|ring)\b",
    r"\bschedul\w+\b[^.?!]{0,20}\b(?:call|chat|meeting|session|time|slot)\b",
    r"\bfollow[- ]?up\b",
    r"\bget back to\b",
    r"\b(?:decide|decision)\b",
    r"\b(?:limited|few) (?:seats|spots)\b",
    r"\b(?:next|upcoming) cohort\b|\bcohort (?:starts|begins|is starting)\b",
    r"\bready to (?:join|enrol+|start|go)\b",
)


_CURIOSITY_COVERED = {
    "format": _FORMAT,
    "build": _PROJECTS,
    "payment": _compile(
        r"\binstal+ments?\b", r"\bemi\b", r"\bmonthly\b", r"\bpayment plans?\b"
    ),
    "mentor_time": _compile(
        r"\bmentor(?:s|ship|ing)?\b", r"\binstructors?\b", r"\b1[- ]on[- ]1\b"
    ),
    "class_size": _compile(
        r"\b\d+ (?:students|learners|people) (?:in|per) (?:a |each |every |the )?(?:batch|cohort|"
        r"class)\b",
        r"\b(?:batch|cohort|class) (?:size|of \d+)\b",
        r"\bsmall (?:batch|batches|cohorts?|class|classes|groups?)\b",
    ),
    "prerequisites": _compile(
        r"\bprerequisites?\b",
        r"\bno (?:prior|coding|programming) (?:knowledge|experience|background)\b",
        r"\bfrom scratch\b|\bbeginner[- ]friendly\b|\bfrom the basics\b",
    ),
    "job_search": _compile(
        r"\bcareer (?:support|services|coach\w*)\b",
        r"\bjob (?:search|placement|assistance|support)\b",
        r"\bresume (?:review|reviews|building)\b|\bmock interviews?\b|\breferrals?\b",
        # Review S7L-R3: "we have placement support for a full year".
        r"\bplacements?\b|\binterview prep(?:aration)?\b",
    ),
    "weekly_hours": _compile(
        r"\bhours? (?:a|per|each|every) (?:week|day)\b",
        r"\b\d+ hours?\b",
        r"\bhours of\b",
        # "ten to fifteen hours" (R1-Q iteration 3: the hours were asked again after "ten to
        # fifteen hours a week" because only digits counted)
        r"\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)"
        r"(?:\s*(?:-|to)\s*(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
        r"fifteen|twenty))?\s+hours?\b",
    ),
}


def curiosity_covered(topic: str, text: object) -> bool:
    """The advisor's text already answered curiosity ``topic``, so the learner need not ask."""
    lowered = fold(text).lower()
    return any(pattern.search(lowered) for pattern in _CURIOSITY_COVERED.get(topic, ()))


# How the learner's own question names a curiosity topic (L1), on top of the words that answer it:
# "could I pay in monthly instalments?", "What would the weekly time commitment look like?".
_CURIOSITY_ASKED = {
    "format": _compile(r"\blive\b", r"\brecord(?:ed|ings?)\b", r"\bself[- ]paced\b"),
    "build": _compile(r"\bbuild\b", r"\bprojects?\b", r"\bwork on\b", r"\bportfolio\b"),
    "payment": _compile(
        r"\bpay (?:in|over|monthly|it (?:in|over|monthly))\b",
        r"\bpayment (?:plans?|options?)\b",
        r"\bspread (?:it|the cost|the payments?)\b",
    ),
    "mentor_time": _compile(
        r"\bone[- ]on[- ]one\b", r"\bdoubts?\b", r"\bask (?:someone|a person)\b"
    ),
    "weekly_hours": _compile(
        r"\b(?:weekly|time) commitment\b",
        r"\bhow (?:much time|many hours)\b(?![^?]{0,40}\bmentor)",
    ),
    "class_size": _compile(
        r"\bhow (?:many|big)\b[^?]{0,30}\b(?:people|students|learners|batch|cohort|class)\b",
        r"\b(?:batch|cohort|class) size\b",
    ),
    "prerequisites": _compile(
        r"\b(?:need|have) to know\b",
        r"\bbefore (?:i|you|we) (?:start|begin|join)\b",
        r"\bbeginners?\b",
        r"\b(?:enough|right) background\b",
    ),
    "job_search": _compile(
        r"\bjob (?:search|hunt|hunting)\b",
        r"\bfind(?:ing)? (?:a )?(?:job|role)\b",
        r"\bland(?:ing)? (?:a )?(?:job|role)\b",
        r"\bcareer (?:help|support|services)\b",
        r"\bplacements?\b",
    ),
}


# M032 SWEEP-12: the rotated noun-phrase labels (``CURIOSITY_LABELS_V2``) asked back in her own
# question ("what about the class format?", "and the weekly time needed?").  Read only with
# ``wide`` (flag R1_TIC_V2), so the release before reads her questions as it did.
_CURIOSITY_ASKED_WIDE = {
    "format": _compile(
        r"\b(?:class|course) format\b", r"\bhow (?:are )?the classes (?:are )?run\b"
    ),
    "build": _compile(r"\b(?:gets|get|is|are) built\b", r"\bhands-?on\b"),
    "payment": _compile(
        r"\bspread(?:ing)? (?:the |it |out )?(?:fee|cost|payments?|out)\b",
        r"\bmonthly (?:payments?|options?)\b",
    ),
    "weekly_hours": _compile(
        r"\bweekly time\b",
        r"\btime (?:it takes|needed|required) (?:each|every|a|per) week\b",
        r"\bhours per week\b",
    ),
    "class_size": _compile(r"\b(?:number of )?people (?:per|in a|in each) batch\b"),
    "prerequisites": _compile(r"\bstarting level\b", r"\bprepar(?:e|ation) before\b"),
    "job_search": _compile(r"\bjob[- ]search\b", r"\bsupport after the course\b"),
}


def curiosity_asked_in(text: object, *, wide: bool = False) -> frozenset[str]:
    """The curiosity topics a question of the LEARNER's ``text`` asks about (L1).

    Only question-like sentences count: "I like that it's live" asks nothing.  A topic is used up
    once she asked it, whether the engine handed it over or she asked on her own.  ``wide``
    (SWEEP-12) also reads the rotated labels of ``CURIOSITY_LABELS_V2``.
    """
    found: set[str] = set()
    for sentence in split_sentences(text):
        if not is_question_like(sentence):
            continue
        lowered = fold(sentence).lower()
        for topic, _label in CURIOSITY_TOPICS:
            patterns = (*_CURIOSITY_COVERED.get(topic, ()), *_CURIOSITY_ASKED.get(topic, ()))
            if wide:
                patterns += _CURIOSITY_ASKED_WIDE.get(topic, ())
            if any(pattern.search(lowered) for pattern in patterns):
                found.add(topic)
    return frozenset(found)


# R1-Q iteration 2.  What the advisor has answered and the learner must not ask again (the live
# sweep: "what happens if someone falls behind?" answered with "recordings and mentor catch-up
# support", then "what actually happens if someone does?"; the weekly hours asked twice).  Only the
# topics a person remembers being told are listed; "the mentors" in a pitch is not an answer.
ANSWERED_LABELS: tuple[tuple[str, str], ...] = (
    ("format", "whether the classes are live or recorded"),
    ("weekly_hours", "how many hours a week it takes"),
    ("payment", "whether you can pay in monthly instalments"),
    ("fall_behind", "what happens if someone falls behind"),
)
_FALL_BEHIND_ANSWERED = _compile(
    r"\bcatch(?:ing)? up\b",
    r"\b(?:fall|falls|falling|fell|get|gets|getting|got) behind\b",
    r"\bmiss(?:ed|es|ing)? (?:a |an |some |the |any )?(?:class|classes|session|sessions)\b",
)


def answered_topics(text: object) -> frozenset[str]:
    """The ``ANSWERED_LABELS`` topics the advisor's ``text`` answers."""
    lowered = fold(text).lower()
    found = {topic for topic, _label in ANSWERED_LABELS[:3] if curiosity_covered(topic, text)}
    if any(pattern.search(lowered) for pattern in _FALL_BEHIND_ANSWERED):
        found.add("fall_behind")
    return frozenset(found)


# M032 SWEEP-7 (flag R1_COME_BACK): her own question the advisor dodged gets one come-back.  The
# topics she can be owed an answer on are the curiosity topics (as ``curiosity_asked_in`` reads
# them, ``wide``) and two more forms: "what if I fall behind / miss a class?" and "could I pay it
# month by month?".  Price figures stay with F1 and S2P.
OPEN_QUESTION_LABELS: dict[str, tuple[str, ...]] = {
    **CURIOSITY_LABELS_V2,
    "fall_behind": ("what happens if you fall behind",),
}
_OPEN_QUESTION_ASKED = {
    "fall_behind": _compile(
        r"\bfall(?:s|ing)? behind\b", r"\bmiss (?:a |some )?(?:class|classes|session|sessions)\b"
    ),
    "payment": _compile(
        r"\bmonth by month\b",
        r"\bpay (?:it |that |for it )?(?:off )?(?:each|every|per|a) month\b",
    ),
}
# A deferral ("I'll get to that in a minute", "we can talk about that later", "hold that thought")
# and a vague non-answer ("it's very flexible", "it depends", "don't worry about that").  Read
# only on the advisor turn right after her question, and only when it left her topic uncovered.
_DEFERS = _compile(
    r"\b(?:i'?ll|i will|we'?ll|we will|let me|let's|let us|i can|we can) (?:get|come(?: back)?|"
    r"circle back|return) to (?:that|it|this|those|your question)\b",
    r"\b(?:we can|let's|let us|i'?ll|we'?ll|we will|i will) (?:discuss|talk about|cover|go over|"
    r"get into|look at) (?:that|it|this|those)\b[^.?!]{0,20}\b(?:later|afterwards|in a (?:bit|"
    r"minute|moment|second)|at the end|next time|another time)\b",
    r"\bhold (?:on to )?that (?:thought|question)\b",
    r"\b(?:that'?s|that is) (?:something|a question) (?:for|we can (?:cover|discuss)) later\b",
)
_VAGUE = _compile(
    r"\b(?:it'?s|it is|that'?s|that is|timing is|the timing is|the schedule is|it'?s all) "
    r"(?:very |quite |pretty |completely |totally |really |super )?flexible\b",
    r"\bit (?:all )?(?:depends|varies)\b",
    r"\bwhatever (?:works|suits) (?:for )?you\b",
    r"\b(?:that'?s|that is|it'?s|it is) (?:very |quite |totally )?manageable\b",
)
# Review S7L-R3: a reassuring opener ("Don't worry about it, the recordings are always there") is
# often followed by the real answer, so it counts as a dodge only when the turn says little else.
_REASSURE = _compile(
    r"\b(?:don'?t|do not) worry about (?:that|it|this)\b",
    r"\bwe'?ll (?:figure|sort|work) (?:it|that|something) out\b",
    r"\b(?:that'?s|that is|it'?s|it is) (?:not|never) (?:a |an )?(?:problem|issue|concern)"
    r"(?: at all)?\b",
)
REASSURE_REST_MAX_WORDS = 8


def open_question_topics(text: object, *, wide: bool = True) -> frozenset[str]:
    """The topics a question of the LEARNER's ``text`` asks the advisor about (SWEEP-7)."""
    found = set(curiosity_asked_in(text, wide=wide))
    for sentence in split_sentences(text):
        if not is_question_like(sentence):
            continue
        lowered = fold(sentence).lower()
        for topic, patterns in _OPEN_QUESTION_ASKED.items():
            if any(pattern.search(lowered) for pattern in patterns):
                found.add(topic)
    return frozenset(found)


# Review S7L-R3: what answers HER "what if I fall behind?" right after she asked it ("every class
# is recorded so you can watch it later", "you can rewatch any session").  Wider than
# ``_FALL_BEHIND_ANSWERED``, which a pitch must not trip ("classes are live and recorded").
_FALL_BEHIND_COVERED = (
    *_FALL_BEHIND_ANSWERED,
    *_compile(
        r"\bcatch[- ]up\b",
        r"\brecord(?:ed|ing|ings)?\b",
        r"\bre-?watch\b|\breplay(?:s|ed)?\b",
        r"\bwatch (?:it|them|the (?:class|classes|session|sessions|recording|recordings)) "
        r"(?:later|again|any ?time)\b",
        r"\b(?:backup|back-up|extra|doubt(?:[- ]clearing)?) (?:class|classes|session|sessions)\b",
    ),
)


def open_question_covered(topic: str, text: object) -> bool:
    """The advisor's ``text`` answers the open-question ``topic`` (``curiosity_covered``)."""
    if topic == "fall_behind":
        lowered = fold(text).lower()
        return any(pattern.search(lowered) for pattern in _FALL_BEHIND_COVERED)
    return curiosity_covered(topic, text)


def defers_or_vague(text: object) -> bool:
    """The advisor put her question off or answered it with nothing (SWEEP-7, counts only).

    A reassurance ("that's not a problem") counts only when at most ``REASSURE_REST_MAX_WORDS``
    words of the turn are not part of it (review S7L-R3)."""
    sentences = _sentences(text)
    if any(pattern.search(sentence) for sentence in sentences for pattern in (*_DEFERS, *_VAGUE)):
        return True
    for sentence in sentences:
        for pattern in _REASSURE:
            match = pattern.search(sentence)
            if match is None:
                continue
            rest = word_count(text) - word_count(match.group(0))
            if rest <= REASSURE_REST_MAX_WORDS:
                return True
    return False


def dodged_question(text: object, topics: frozenset[str] | tuple[str, ...]) -> bool:
    """The advisor's turn dodged her question about ``topics`` (M032 SWEEP-7).

    True when no topic is covered, the turn is not hollow ("Okay."), and it defers ("I'll get to
    that"), answers vaguely ("it's very flexible") or pivots to a question of their own.  A pivot
    whose own question names her topic ("How many hours could you give it?") is discovery, and a
    plain pitch that misses the topic is not a dodge either.
    """
    if not topics or not isinstance(text, str) or is_hollow_turn(text):
        return False
    if any(open_question_covered(topic, text) for topic in topics):
        return False
    if defers_or_vague(text):
        return True
    if not asks_her_directly(text):
        return False
    questions = " ".join(
        sentence for sentence in split_sentences(text) if is_question_like(sentence)
    )
    return not (set(topics) & open_question_topics(questions))


# The F4 push when a call was proposed in the same turn: the learner must talk to its decision
# maker first and is glad for them to join a call, it never says they dislike calls (a model said
# "he's not really one for these things" and, a turn later, booked a call with him).
F4_PUSH_CALL_SUFFIX = (
    "; you are happy for them to join a call once you have talked, and you never say that they "
    "dislike calls or would not take part"
)
# L7 (mock call aa166f09: "my partner" at 69 and 71, then the owed F4 push at 82 said it again as
# news).  When the learner already said she would talk to her decision maker, the push refers back
# to it in a few words; its markers (the decision maker and a talk verb) are unchanged.
F4_PUSH_SAID_SUFFIX = (
    "; you already said earlier that you would talk to your {decision_maker}, so refer back to "
    'it in a few words (for example "like I said") instead of saying it as news'
)
F4_PUSH_SAID_VARIANTS = (
    "Like I said, I'd need to talk it over with my {decision_maker} first.",
    "As I mentioned, I'd want to talk to my {decision_maker} before anything moves.",
)


# M032 SWEEP-3 (flag R1_NO_COMMIT_LEDGER): she already said she is not deciding today in a line of
# her own, so the owed F4 primary refers back to it ("like I said") instead of saying it as news.
# Its markers and must-say are unchanged; both variants prove the move.
F4_PRIMARY_SAID_SUFFIX = (
    "; you already said earlier that you are not ready to decide yet, so refer back to it in a few "
    'words (for example "like I said") instead of saying it as news'
)
F4_PRIMARY_SAID_VARIANTS = (
    "Like I said, I'm not ready to decide today. I want a bit more time.",
    "As I mentioned, I'd like to wait and decide later, not today.",
)
# M032 S2 item 4 (phone map question-flow M5): the advisor already talked about the topic of an owed
# primary before it was raised, so she says why it still worries her in light of what she was told
# ("what you were told about X", never the advisor's details said back as facts: the guard's
# format_or_schedule_claim would drop them).
PREEMPTED_SUFFIX = (
    "; the advisor already told you something about {label}, so say in your own words why it "
    "still worries you after what you were told, without repeating their details as facts"
)
# Keyed by what the advisor talked about (``preempting_topics``), so the label names only that
# (review S2R-5: live or recorded classes alone were labelled "the schedule and the time it
# takes", and with F2's must-say "six months" she was told the advisor had said how long it is).
PREEMPTED_F2_FORMAT = "F2-format"
PREEMPTED_LABELS: tuple[tuple[str, str], ...] = (
    ("F3", "what the course gives you"),
    ("F2", "the schedule"),
    (PREEMPTED_F2_FORMAT, "how the classes are run"),
)


def preempting_topics(text: object) -> frozenset[str]:
    """What an advisor turn already talked about in a statement, as ``PREEMPTED_LABELS`` keys.

    F3: free material, worth or outcomes (``_VALUE_TALK``), never a pitch alone; F2: the schedule
    (``_SCHEDULE_TALK``); ``PREEMPTED_F2_FORMAT``: live or recorded delivery only.  A question
    about the topic pre-empts nothing.
    """
    found: set[str] = set()
    for sentence in _sentences(text):
        if is_question_like(sentence):
            continue
        if any(pattern.search(sentence) for pattern in _VALUE_TALK):
            found.add("F3")
        if any(pattern.search(sentence) for pattern in _SCHEDULE_TALK):
            found.add("F2")
    if covers_format(text):
        found.add(PREEMPTED_F2_FORMAT)
    return frozenset(found)


def preempting_families(text: object) -> frozenset[str]:
    """The families an advisor turn already talked about in a statement (S2 item 4).

    Narrower than ``topics_in``: F3 is free material, worth or outcomes (``_VALUE_TALK``), never a
    pitch alone; F2 is the format or the schedule.  A question about the topic pre-empts nothing.
    """
    return frozenset(
        "F2" if topic == PREEMPTED_F2_FORMAT else topic for topic in preempting_topics(text)
    )


# M032 S2 item 5 (review S2R-1): the advisor's turn took up the worry her last line raised, in any
# words.  Wider than ``topics_in``, which reads what INVITES an objection, not what answers one
# ("our learners still get hired every month" after the layoffs worry, "every class is recorded,
# you can catch up anytime" after the falling-behind worry).  A miss only costs the anti-validation
# note; a false "not answered" would tell her to say a handled worry was not handled, so the lists
# are wide.  F2 and F3 only: an F4 or stall worry is answered by a back-off, never by a topic.
_WORRY_ANSWER: dict[str, tuple[re.Pattern[str], ...]] = {
    "F3": _compile(
        r"\b(?:jobs?|hired|hiring|hires?|placements?|placed|alumni|careers?|guarantee\w*|"
        r"interviews?|mentors?|mentorship|mentoring|projects?|portfolios?|support\w*|outcomes?|"
        r"salar(?:y|ies)|transition\w*|switch\w*|worth|value|structured?|feedback|certificat\w*|"
        r"recruit\w*|compan(?:y|ies)|network\w*|industry|market|layoffs?|roles?|offers?|"
        r"success\w*|refund\w*|free|youtube|coursera|udemy|curriculum|learners?|students?|"
        r"graduates?|recession|economy|demand|skills?)\b",
    ),
    "F2": _compile(
        r"\b(?:record(?:ed|ings?)?|catch(?:ing)? up|miss(?:ed|es|ing)?|mentors?|weekends?|"
        r"evenings?|weekdays?|hours?|flexib\w+|schedules?|pace|self[- ]paced|working "
        r"professionals?|famil(?:y|ies)|jobs?|extend\w*|extensions?|pause\w*|defer\w*|"
        r"batch(?:es)?|cohorts?|time|support\w*|doubts?|live|convenien\w*|whenever|anytime|"
        r"any time|later|busy|manag\w*|balanc\w*|behind|backup|buddy|months?|weeks?|deadlines?|"
        r"replay|rewatch|re-watch|on[- ]demand)\b",
    ),
}


def worry_answered(family: str | None, text: object) -> bool:
    """The advisor's turn took up the worry of ``family`` (F2 or F3; any other: True)."""
    patterns = _WORRY_ANSWER.get(family or "")
    if patterns is None:
        return True
    lowered = fold(text).lower()
    return any(pattern.search(lowered) for pattern in patterns)


def f4_push_said(decision_maker: str) -> tuple[str, tuple[str, ...]]:
    """The F4 push brief suffix and variants when the decision maker was already named (L7)."""
    return (
        _fill(F4_PUSH_SAID_SUFFIX, decision_maker),
        tuple(_fill(text, decision_maker) for text in F4_PUSH_SAID_VARIANTS),
    )


def topics_in(text: object) -> frozenset[str]:
    """The objection families (F3 value, F2 time, F1 price, F4 close) this advisor turn touches.

    F3: a statement about what the course is or does (a pitch), or free material, certificates
    and outcomes.  F2: format or schedule talk.  F1: a price or a discount.  F4: any close
    talk (an ask, a callback or e-mail offer, "what do you think", "shall we").  Questions
    do not trigger F3 and F2 (they are discovery), but they may trigger F1 and F4.
    """
    found: set[str] = set()
    if quotes_price(text):
        found.add("F1")
    if covers_format(text):
        found.add("F2")
    if detect_ask(text) is not None:
        found.add("F4")
    if is_pitch_statement(text):
        found.add("F3")
    for sentence in _sentences(text):
        statement = not is_question_like(sentence)
        if statement and any(pattern.search(sentence) for pattern in _VALUE_TALK):
            found.add("F3")
        if statement and any(pattern.search(sentence) for pattern in _SCHEDULE_TALK):
            found.add("F2")
        if any(pattern.search(sentence) for pattern in _CLOSE_TALK):
            found.add("F4")
    return frozenset(found)


# A request about the call itself, not an answer to the learner: ending it, or asking whether the
# learner is the one selling (owner test 7f2a25e6: turn 64 "Okay, never mind, can you disconnect
# the call?" released the F4 push as if it answered the stall; 41 "are you selling the course to
# me").
_META_REQUEST = _compile(
    r"\b(?:disconnect|end|cut|drop|stop)(?: (?:the|this|our))? (?:call|role[- ]?play|interview)\b",
    r"\bhang up\b",
    r"\blet'?s disconnect\b",
    r"\bselling\b[^.?!]{0,30}\bto me\b",
)
# An open invitation hands the learner the floor ("What else is on your mind?"): the push answers
# it, so it is not a question the push would leave unanswered.
_OPEN_INVITATION = _compile(
    r"\bwhat else\b",
    r"\banything else\b",
    r"\bon your mind\b",
    r"\bwhat do you think\b",
    r"\bany (?:other |more |further )?(?:questions|doubts|concerns|worries)\b",
)


# "What students love is that ...", "What matters most is that ...": a wh-cleft is a statement
# even though it opens like a question (reviewed fix: a 70-word answer with no "?" was judged as
# asking, so the push waited its patience out).
_WH_CLEFT = re.compile(r"^\W*(?:what|how|why|where|who)\s+(?:\w+\s+){1,6}?(?:is|was)\s+that\b")


def _asks_the_learner(sentence: str) -> bool:
    """A sentence that asks: a "?", or a question opening that is not a wh-cleft statement."""
    if "?" in sentence:
        return True
    return is_question_like(sentence) and _WH_CLEFT.search(sentence) is None


def answers_substantively(text: object) -> bool:
    """The advisor said something: ``SUBSTANTIVE_ANSWER_WORDS`` words, mostly not questions.

    At least half of the turn's words are in sentences that neither ask the learner something
    (an open invitation such as "What else is on your mind?" is not counted as asking) nor
    request something about the call itself (``_META_REQUEST``), so "Okay, never mind, can
    you disconnect the call?" (eight words, one question) answers nothing.
    """
    if word_count(text) < SUBSTANTIVE_ANSWER_WORDS:
        return False
    total = said = 0
    for sentence in _sentences(text):
        words = word_count(sentence)
        total += words
        if any(pattern.search(sentence) for pattern in _META_REQUEST):
            continue
        if not _asks_the_learner(sentence) or any(
            pattern.search(sentence) for pattern in _OPEN_INVITATION
        ):
            said += words
    return 2 * said >= total


# M032 S1: readers of the advisor's turn for the learner's manners (respond first, the natural
# moment).  Lexical, sentence by sentence, every quantifier bounded.  Copied in spirit from the
# phone bot's directedness rule (a broad "is it a question?" test fired on answer openings), never
# imported from it.
#
# An OFFER waits for her reaction: the advisor, in the first person singular, proposes to do
# something for her ("I can bring him into a joint call", "let me set up a demo class", "would you
# like me to arrange a mentor chat?").  "We can ..." is left out: on the advisor corpus it is
# nearly always the programme described ("we can set up a catch-up session if you miss a class"),
# and so is a pitch ("we will send you a certificate").  Nothing about price, a discount, a free
# trial, a budget or enrolling counts (the negotiation reads those), nor an e-mail, a link, the
# details or a callback (the negotiation's too).  Nor a discourse phrase said with one of those
# verbs (review S1R-5): "let me put it this way", "let me add one more thing", "I'll give you an
# example", "I can give you an idea of ...", "I will show you why ...": the advisor explains, and
# nothing waits for her reaction.
_NOT_AN_OFFER_TAIL = (
    r"(?!(?<=put) (?:it|that|things)\b)"
    r"(?!(?<=add) (?:that|this|to that)\b)"
    r"(?! (?:one|a|another|just one) (?:more |last |final |quick |small )?(?:thing|point|word)\b)"
    r"(?! (?:you |to that )?(?:an? |some |one )?(?:examples?|idea|sense|picture|overview|"
    r"breakdown|analogy|perspective|context)\b)"
    r"(?! (?:you )?(?:why|how|what|where|when)\b)"
    r"(?! (?:it |this |that )?(?:simply|differently|another way|this way|in perspective)\b)"
)
_OFFER = _compile(
    r"\bi(?:'ll| will| can| could)(?: also| actually| even| easily| happily| definitely| just)? "
    r"(?:put|add|get(?! back)|bring|arrange|give|send|share|set up|connect|organi[sz]e|book|"
    r"include|show|introduce|loop)\b" + _NOT_AN_OFFER_TAIL,
    r"\blet me (?:send|arrange|set up|get you|connect|put|add|organi[sz]e|book)\b"
    + _NOT_AN_OFFER_TAIL,
    r"\b(?:would you like|do you want|want) me to\b",
    r"\bif you (?:want|like|prefer|wish)\b[^.?!]{0,40}\bi(?:'ll| will| can| could)\b",
)
_OFFER_EXCLUDED = _compile(
    r"\$\s?\d",
    r"\b\d[\d,]*\s*(?:dollars|usd|k)\b",
    r"\b\d{1,2}\s?%",
    r"\b(?:price|pricing|priced|fees?|costs?|discount\w*|off|scholarships?|cashback|rebate|"
    r"waive\w*|emi|instal\w*|free|percent|enrol\w*|pay|paying|payment\w*|budget|monthly|"
    r"per month|a month|call you|ring you)\b",
)
# The negotiation's own offers: an e-mail, a message, a link or the details sent over.
_OFFER_NEGOTIATION = _compile(
    r"\b(?:e-?mail\w*|mail|whatsapp|text message|link|brochure|summary|details|information|"
    r"info|curriculum|syllabus)\b",
)
# A BACK-OFF gives her time ("take your time", "no rush", "discuss it at home and come back to
# me").  Not when the same turn presses again ("no pressure, but the offer ends today"), and not a
# course description ("the program is self-paced, so you can take your time with each module").
_BACK_OFF = _compile(
    r"\btake (?:your|all the|as much|some) time\b",
    r"\bno (?:rush|hurry|pressure)\b",
    r"\bdon'?t (?:rush|hurry|feel (?:rushed|pressured))\b",
    r"\bwhenever you(?:'re| are) ready\b",
    r"\bthink (?:it|this|about it) over\b",
    r"\bsleep on it\b",
    r"\byou can\b[^.?!]{0,50}\b(?:get back to (?:me|us)|call (?:me|us) back|come back to (?:me|us)|"
    r"reach out to (?:me|us))\b",
    r"\b(?:get back to (?:me|us)|call (?:me|us) back|come back to (?:me|us))\b[^.?!]{0,30}"
    r"\b(?:later|whenever|when you|once you|after you|any ?time)\b",
)
_BACK_OFF_COURSE = _compile(
    r"\b(?:modules?|lessons?|class(?:es)?|courses?|program(?:me)?s?|curriculum|recordings?|"
    r"sessions?|pace|paced|assignments?|projects?)\b",
)
_PRESSES_AGAIN = _compile(
    r"\b(?:today|tonight|ends?|ending|deadline|last (?:chance|day|few)|limited|hurry up|"
    r"won'?t wait|spots?|seats?|fill(?:ing)? (?:up|fast)|higher price|"
    r"(?:price|fee) (?:goes|will go) up)\b",
    r"\b(?:decid|enrol|sign|join|commit|regist)\w* (?:soon|quickly|now|today|this week)\b",
)
# A QUESTION PUT TO HER: a question-like sentence that names her ("which figure would suit you?",
# "how does your week usually look").  Not an open invitation (that hands her the floor), a tag
# ("..., right?"), "does that make sense?", a presence check, a request about the call itself, a
# discourse marker said as a question ("Okay, you know what? ...", "Guess what?"), or a pitch said
# as a question ("did you know you can book a mentor anytime?", "isn't it great that ...?", "why
# do you think our students ...?").  The tag is a bounded run read on the sentence's last
# ``_TAG_TAIL_CHARS`` characters only (review S1-R6: "[,\s]+" with ``search`` was quadratic in a
# run of commas and spaces, 0.2 s on a 4,000-character turn).
_TAG_TAIL = re.compile(
    r"[,\s]{1,6}(?:right|okay|ok|yeah|yes|no|na|isn'?t it|you know|correct|huh|eh)\W{0,3}$"
)
_TAG_TAIL_CHARS = 40
_NOT_PUT_TO_HER = _compile(
    r"\bmakes? sense\b",
    r"\b(?:can you hear me|are you (?:there|with me)|hello)\b",
    r"^\W*(?:(?:and|so|okay|ok|well|now|then|but)\W+){0,3}(?:do|did) you (?:even )?(?:know|"
    r"realis\w*|realiz\w*)\b",
    r"\bwould it help (?:you )?to know\b",
    r"^\W*(?:\w+\W+){0,2}why do you think\b",
    r"\b(?:isn'?t|wouldn'?t|won'?t) (?:it|that|this) be\b",
    r"\bisn'?t (?:it|that|this) (?:great|amazing|nice|good|wonderful|awesome|fair|cool)\b",
    r"\bdon'?t you think\b",
    # A sentence that is only a discourse marker ("Okay, you know what?", "See, guess what?").
    r"^\W*(?:(?:okay|ok|so|and|but|well|hey|oh|yeah|see|now|listen)\W+){0,3}"
    r"(?:you know(?: what)?|guess what)\W*$",
)
_SECOND_PERSON = re.compile(r"\b(?:you|your|yours|yourself)\b")


def offers_something(text: object) -> bool:
    """The advisor offers to do something for the learner that waits for her reaction (M032 S1)."""
    sentences = _sentences(text)
    if any(pattern.search(sentence) for sentence in sentences for pattern in _OFFER_NEGOTIATION):
        return False
    for sentence in sentences:
        if any(pattern.search(sentence) for pattern in _OFFER_EXCLUDED):
            continue
        if any(pattern.search(sentence) for pattern in _OFFER):
            return True
    return False


def backs_off(text: object) -> bool:
    """The advisor gives the learner time or hands the decision back to her (M032 S1)."""
    sentences = _sentences(text)
    if any(pattern.search(sentence) for sentence in sentences for pattern in _PRESSES_AGAIN):
        return False
    for sentence in sentences:
        if any(pattern.search(sentence) for pattern in _BACK_OFF_COURSE):
            continue
        if any(pattern.search(sentence) for pattern in _BACK_OFF):
            return True
    return False


def asks_her_directly(text: object) -> bool:
    """A question-like sentence addressed to the learner herself (M032 S1, RCA LR-4).

    Wider than ``r1_personas.asks_about_learner`` ("which figure would suit you?" is no dig) and
    narrower than "any question": an open invitation hands her the floor instead, a tag question
    asks nothing, and a presence check or a request about the call is not put to her in role.
    """
    for sentence in _sentences(text):
        if not _asks_the_learner(sentence):
            continue
        tag = _TAG_TAIL.search(sentence, max(0, len(sentence) - _TAG_TAIL_CHARS))
        if tag is not None:
            head = sentence[: tag.start()]
            if "?" not in head and not is_question_like(head):
                continue
        if any(pattern.search(sentence) for pattern in _OPEN_INVITATION):
            continue
        if any(pattern.search(sentence) for pattern in (*_META_REQUEST, *_NOT_PUT_TO_HER)):
            continue
        if _SECOND_PERSON.search(sentence):
            return True
    return False


def tells_something(text: object) -> bool:
    """The advisor SAID something (M032 S1): ``SUBSTANTIVE_ANSWER_WORDS`` words in statements.

    Stricter than ``answers_substantively``: an open invitation ("That makes sense. What else is
    on your mind?") hands her the floor but answers nothing, so its words do not count here.
    """
    said = 0
    for sentence in _sentences(text):
        if _asks_the_learner(sentence) or any(
            pattern.search(sentence) for pattern in (*_OPEN_INVITATION, *_META_REQUEST)
        ):
            continue
        said += word_count(sentence)
    return said >= SUBSTANTIVE_ANSWER_WORDS


def offers_floor(text: object) -> bool:
    """The advisor hands the learner the floor ("What else is on your mind?", "Any questions?")."""
    return any(
        pattern.search(sentence) for sentence in _sentences(text) for pattern in _OPEN_INVITATION
    )


# M032 SWEEP-33 (flag R1_FLOOR_YIELD): the advisor asks for the floor ("Can I talk?", "Sorry, let me
# finish.", "Please just listen to me.").  The turn is read word by word: softeners are stripped
# from both ends, and what is left must be one of these forms IN FULL, so "Can I talk to your
# husband?", "Let me explain the fee, it is nine thousand", a bare "Listen." and "Let me explain."
# are never a request for the floor.
_FLOOR_SOFTENERS = frozenset("sorry please just okay ok hey no wait".split())
# Review S7L-R2: "Hold on, let me finish.", "One second, let me finish.", "Just a second, ...".
_FLOOR_SOFTENER_PAIRS = frozenset(
    (
        ("excuse", "me"),
        ("hold", "on"),
        ("hang", "on"),
        ("one", "second"),
        ("one", "sec"),
        ("one", "minute"),
        ("a", "second"),
        ("a", "sec"),
        ("a", "minute"),
    )
)
# Review S7L-R2: "listen what I am saying" (speech-to-text drops the "to"), "let me complete my
# point".
_FLOOR_LISTEN = r"listen (?:to )?(?:me|what i(?:'m| am) saying)"
_FLOOR_REQUEST = re.compile(
    r"(?:"
    r"(?:can|could|may) i (?:please )?(?:talk|speak|finish|complete|say something|explain)"
    r"(?: (?:first|now|please))?"
    r"|let me (?:finish|complete|speak|talk)(?: (?:my point|my thought|this|what i(?:'m| am) "
    r"saying))?(?: (?:first|please))?"
    rf"|(?:can|could) you (?:please )?(?:just )?(?:{_FLOOR_LISTEN}|hear me out)(?: first)?"
    rf"|(?:please )?(?:just )?(?:{_FLOOR_LISTEN}|hear me out)(?: first)?"
    r")"
)
FLOOR_REQUEST_MAX_WORDS = 12


def asks_for_floor(text: object, names: tuple[str, ...] = ()) -> bool:
    """The advisor asks her to let them speak, and the turn says nothing else (M032 SWEEP-33).

    ``names``: her first name, a softener like "sorry" when said around the request ("Meera, let me
    finish.").  At most ``FLOOR_REQUEST_MAX_WORDS`` words; linear in the text.
    """
    if not isinstance(text, str):
        return False
    folded = text.lower().replace("\u2019", "'")
    words = [word.strip("'") for word in _WORD_TOKEN.findall(folded)]
    words = [word for word in words if word]
    if not words or len(words) > FLOOR_REQUEST_MAX_WORDS:
        return False
    soft = _FLOOR_SOFTENERS | {name.lower() for name in names if name}
    start, end = 0, len(words)
    while start < end:
        if words[start] in soft:
            start += 1
        elif start + 1 < end and (words[start], words[start + 1]) in _FLOOR_SOFTENER_PAIRS:
            start += 2
        else:
            break
    while end > start:
        if words[end - 1] in soft:
            end -= 1
        elif end - 2 >= start and (words[end - 2], words[end - 1]) in _FLOOR_SOFTENER_PAIRS:
            end -= 2
        else:
            break
    return start < end and _FLOOR_REQUEST.fullmatch(" ".join(words[start:end])) is not None


def _asks_something(sentence: str) -> bool:
    """A question that is not itself a farewell ("Have a great day." opens like one)."""
    if "?" in sentence:
        return True
    if any(pattern.search(sentence) for pattern in _CLOSE_FAREWELL):
        return False
    return is_question_like(sentence)


# Trail-off fillers only.  Courtesies ("thank you", "thanks a lot", "alright then") are not here:
# "Thank you so much, bye." ends a long wrap-up and is a real goodbye (R1-Q round 2).
_STT_TAIL_WORDS = frozenset("bye so yeah yes okay ok um uh hmm well".split())
# A tail trails off ("So yeah. Bye"); "Okay. Bye." has no trail-off word and is a goodbye.
_TRAIL_OFF_WORDS = frozenset("so yeah yes um uh hmm well".split())
# A lone acknowledgement before the "bye" is a wrap-up: "Okay. Bye." is a goodbye.
_WRAP_UP_WORDS = frozenset("okay ok alright all right great perfect cool sure fine then".split())


_WORD_TOKEN = re.compile(r"[A-Za-z0-9']+")


def _strip_stt_bye_tail(text: object) -> str:
    """``text`` without a trailing speech-to-text "bye" tail (the text itself if there is none).

    In the owner test (b58c7d9c) a 90-word answer ended "So yeah. Bye" and the learner answered
    "Oh wait, before you go..." although nobody was leaving.  The tail is read on WORDS, not on
    one punctuation: the final SENTENCE of a turn that is nothing but trail-off fillers ending in
    "bye" / "bye bye" ("So yeah. Bye", "So yeah, bye.", "So yeah. Bye bye.", "So yeah, okay,
    bye."), at most ``STT_TAIL_MAX_WORDS`` words in all, after at least ``STT_TAIL_MIN_OTHER_WORDS``
    other words.  Anything else keeps its farewell: "Okay, bye." in a short turn, a sentence with
    a real word in it ("Take care. Bye.", "Talk to you tomorrow, bye.", "Thank you so much,
    bye.", "Alright then, bye."), and a tail inside a longer sentence ("..., so yeah, bye.").
    """
    folded = fold(text)
    sentences = split_sentences(folded)
    if len(sentences) < 2:
        return folded
    words = [match.group(0).lower() for match in _WORD_TOKEN.finditer(sentences[-1])]
    if (
        not words
        or words[-1] != "bye"
        or len(words) > STT_TAIL_MAX_WORDS
        or any(word not in _STT_TAIL_WORDS for word in words)
        or not (
            all(word == "bye" for word in words) or any(word in _TRAIL_OFF_WORDS for word in words)
        )
    ):
        return folded
    head = " ".join(sentences[:-1])
    if word_count(head) < STT_TAIL_MIN_OTHER_WORDS:
        return folded
    wrap_up = [match.group(0).lower() for match in _WORD_TOKEN.finditer(sentences[-2])]
    if wrap_up and all(word in _WRAP_UP_WORDS for word in wrap_up):
        return folded  # "... Okay. Bye." wraps up: the advisor is leaving
    return head


def is_close_attempt(text: object, r_sec: float | None = None) -> bool:
    """A farewell or wrap-up phrase.  Never fires on "end the call" style instructions.

    With ``r_sec`` given, nothing counts before R = 1:00 and the courtesy "thanks for your
    time" only counts from R = 4:00, so a polite opening is never mistaken for goodbye.
    A sentence counts when it ENDS with the farewell (see ``_FAREWELL_TAIL``) and no later
    sentence of the turn asks something, so a turn that goes on to ask ("Take care of your
    kids first, any questions?") is never a goodbye.  A "Bye" tail of fillers at the end of a
    long turn is a speech-to-text tail and does not count (``_strip_stt_bye_tail``), and the
    courtesy "thanks for your time" only counts when the turn stops there: if a statement
    follows it ("Thanks for your time. So, coming to the fees, it's nine thousand.") the
    advisor is still talking.
    """
    if r_sec is not None and r_sec < CLOSE_MIN_R_SEC:
        return False
    thanks_allowed = r_sec is None or r_sec >= CLOSE_THANKS_MIN_R_SEC
    sentences = _sentences(_strip_stt_bye_tail(fold(text)[-CLOSE_MAX_CHARS:]))
    count = len(sentences)
    # What follows each sentence, worked out once from the end (two passes over the sentences, not
    # one pass per sentence): whether a later sentence asks something, and whether every later
    # sentence is a sign-off tail.
    asks_after = [False] * (count + 1)
    closing_after = [True] * (count + 1)
    for index in range(count - 1, -1, -1):
        asks_after[index] = asks_after[index + 1] or _asks_something(sentences[index])
        closing_after[index] = closing_after[index + 1] and (
            not thanks_allowed or _is_closing_tail(sentences[index])
        )
    for index, sentence in enumerate(sentences):
        if asks_after[index + 1]:
            continue
        if any(pattern.search(sentence) for pattern in _CLOSE_FAREWELL):
            return True
        if (
            thanks_allowed
            and closing_after[index + 1]
            and any(pattern.search(sentence) for pattern in _CLOSE_THANKS)
        ):
            return True
    return False


# M032 S3.1 (flag R1_CLOSING_STATE; RCA END-1, fda9e9f6 #73-#90: "take your time and call me back
# later" and "get back to us" were never read as closes, so the learner filled four goodbye
# cycles).  A hand-over close ENDS the turn and nothing is asked after it: "call me back (later)"
# and "get back to me/us", with only a time and courtesy after them.  ``is_close_attempt`` and the
# corpus's ``farewell`` labels are unchanged: this is the engine's own, flagged reading, and before
# 14:00 it reaches Christy's question, never a silent exit.  "Take your time", "no rush" and "no
# pressure" alone are how an advisor waits for an answer mid-call (corpus: "Take your time." is
# no farewell), so they close only right after her own sign-off (``after_sign_off``).
_HANDOVER_WHEN = (
    r"(?: (?:later(?: on)?|anytime|any time|tomorrow|whenever(?: you(?:'re| are) (?:ready|free))?"
    r"|when(?:ever)? you(?:'re| are) (?:ready|free|done)|once you(?:'ve| have) decided"
    r"|after you(?:'ve| have) (?:talked|spoken|decided)(?: (?:to|with) (?:him|her|them))?))?"
)
_HANDOVER_TAIL = (
    r"(?:[\s,]+(?:then|okay|ok|please|thanks|thank you|bye|take care|no rush|no pressure))*"
    r"[\s.!]*$"
)
_HANDOVER_CLOSE = _compile(
    r"\bcall (?:me|us) back" + _HANDOVER_WHEN + _HANDOVER_TAIL,
    r"\bget back to (?:me|us)" + _HANDOVER_WHEN + _HANDOVER_TAIL,
)
# A hand-over that is a condition, not a close ("if you have any doubts, get back to me", "in case
# of questions, call us back"): read in the sentence before the hand-over itself.
_CONDITIONAL_HANDOVER = re.compile(
    r"\b(?:if|in case|should you|incase)\b|\bany (?:more |other |further )?"
    r"(?:questions?|doubts?|queries|query|concerns?|issues?|problems?)\b",
    re.IGNORECASE,
)
# The whole sentence is the wait ("Sure, take your time.", "Take your time, no rush."): "Just a
# quick check-in, no pressure." is the advisor still talking.
_WAIT_PHRASE = r"(?:take (?:all )?your time|no rush|no hurry|no pressure)"
_WAIT_FOR_HER = _compile(
    r"^\W*(?:(?:sure|okay|ok|of course|no problem|absolutely|alright|yes|yeah|that'?s fine)"
    r"[,\s]+){0,3}" + _WAIT_PHRASE + r"(?:[,\s]+" + _WAIT_PHRASE + r")?" + _HANDOVER_TAIL,
)
# A sentence of courtesy alone ("Thank you.", "Bye.", "Take care, Divya.") after the close.
_COURTESY_WORDS = frozenset(
    "thank thanks you so much very bye goodbye take care okay ok alright sure great have a nice "
    "good day evening then all the best talk soon later again".split()
)
COURTESY_MAX_WORDS = 8


def _courtesy_sentence(sentence: str) -> bool:
    words = normalize(sentence).split()
    if len(words) > COURTESY_MAX_WORDS:
        return False
    unknown = [word for word in words if word not in _COURTESY_WORDS]
    return len(unknown) <= 1 and (not unknown or len(words) >= 2)


def hands_over_close(text: object, *, after_sign_off: bool = False) -> bool:
    """S3.1: the advisor closes in role by handing over ("Take your time and call me back later.").

    Read on the turn's last sentence that is not courtesy alone, which must hold no question.
    ``after_sign_off``: her own last line signed off, so "Sure, take your time." closes too.
    """
    sentences = _sentences(fold(text)[-CLOSE_MAX_CHARS:])
    while len(sentences) > 1 and _courtesy_sentence(sentences[-1]):
        sentences.pop()
    if not sentences or "?" in sentences[-1]:
        return False
    last = sentences[-1]
    for pattern in _HANDOVER_CLOSE:
        match = pattern.search(last)
        # Review S3R-1 (naturalness): "If you have any doubts, just get back to me." keeps the
        # door open mid-pitch; only an unconditional hand-over closes the call.
        if match is not None and _CONDITIONAL_HANDOVER.search(last[: match.start()]) is None:
            return True
    return after_sign_off and any(pattern.search(last) for pattern in _WAIT_FOR_HER)


# S3.1: the words of a courtesy-only advisor turn ("Sure. Thank you.", "Yeah, sure.", "Okay, no
# problem, take care."): right after her own sign-off it is a mutual goodbye.
_COURTESY_TURN_WORDS = frozenset(
    {*_COURTESY_WORDS, "yes", "yeah", "yep", "fine", "perfect", "cool", "no", "problem",
     "worries", "of", "course", "absolutely", "definitely", "sounds", "good", "that", "works",
     "your", "time", "hmm", "mm", "mhm", "noted", "got", "it", "understood", "will", "do",
     "right"}
)
COURTESY_TURN_MAX_WORDS = 10


def courtesy_only(text: object) -> bool:
    """S3.1: an advisor turn of courtesy and acknowledgement alone, asking nothing."""
    folded = fold(text)
    if "?" in folded:
        return False
    words = normalize(folded).split()
    return (
        0 < len(words) <= COURTESY_TURN_MAX_WORDS
        and all(word in _COURTESY_TURN_WORDS for word in words)
    )


# Review S3R-3 / S3R-1 (naturalness): a mutual goodbye takes leave.  "Hmm.", "Okay.", "No.",
# "Right.", "Got it." or "Okay, so" after her "I'll think it over." are the advisor thinking or
# about to go on, never a goodbye (each one locked a WEAK commitment from 14:00).
_LEAVE_TAKING = re.compile(
    r"\b(?:bye|goodbye|thanks?|thank you|take care|talk (?:to you )?soon|see you|cheers"
    r"|have a (?:nice|good|great) (?:day|evening|one)|all the best)\b"
)


def courtesy_goodbye(text: object) -> bool:
    """S3.1: a courtesy-only advisor turn that takes leave ("Sure. Thank you.", "Okay, bye.")."""
    return courtesy_only(text) and _LEAVE_TAKING.search(normalize(fold(text))) is not None


def _is_closing_tail(sentence: str) -> bool:
    """A sentence that may follow "thanks for your time" in a sign-off.

    A word or two ("Bye.", "Take care."), a farewell, or a closing courtesy or promise ("I'll
    send the details.", "Feel free to reach out.").  A statement about the programme ("So,
    coming to the fees, it's nine thousand.") means the advisor is still talking.
    """
    return (
        word_count(sentence) <= THANKS_TRAILING_WORDS
        or any(pattern.search(sentence) for pattern in _CLOSE_FAREWELL)
        or _CLOSING_SENTENCE.match(sentence) is not None
    )


@dataclass(frozen=True)
class TurnSignals:
    """What one candidate turn told the scheduler (no candidate text is kept)."""

    turn: int
    pitch: bool
    price_quoted: bool
    price_answered: bool
    format_covered: bool
    projects_covered: bool
    close_attempt: bool
    substantive: bool
    topics: frozenset[str] = frozenset()
    answered: bool = False


@dataclass(frozen=True)
class Moment:
    """What the advisor's turn was, for the idle path of a primary (M032 S1, D-M032-1).

    ``slack_ok``: the plan is ahead of its pacing map (the engine's ``_ahead_of_pacing``); without
    it the moment changes nothing.  ``floor_offered``: the advisor handed her the floor (a check-in,
    "what else is on your mind?").  ``thread_open``: something waits for her answer (an offer, a
    back-off, a question put to her, a dig, or her own question just answered).  ``thread_closed``:
    the advisor finished a point and left nothing open.  The engine builds it per turn and passes it
    to ``select`` for that turn only.
    """

    slack_ok: bool = False
    floor_offered: bool = False
    thread_open: bool = False
    thread_closed: bool = False


@dataclass(frozen=True)
class OwedMove:
    """The one move owed this turn.

    ``text`` is the move's own scripted line (the first fallback variant).  The session does
    not speak it: the model voices ``brief`` (R1-Q) and the line is only the fallback.
    """

    id: str
    family: str | None
    role: str
    text: str
    forced: bool
    deadline_sec: int | None
    due_sec: float
    brief: str = ""
    must_say: tuple[str, ...] = ()
    markers: tuple[tuple[str, ...], ...] = ()
    variants: tuple[str, ...] = ()


@dataclass(frozen=True)
class Delivery:
    """A delivered move with its slip against the effective deadline."""

    move_id: str
    family: str | None
    turn: int
    delivered_sec: float
    due_sec: float
    slip_sec: float
    lateness_sec: float | None


@dataclass(frozen=True)
class CloseDecision:
    """Response to an early close attempt: redirect with a move, stall, or exit.

    ``prefix`` is the scripted opener a redirect is spoken with (``REDIRECT_OPENERS[0]``, "Oh
    wait, before you go..."; the ship restore plays it before the owed line, or with R1_PROBE_FIRST
    before the probe-first step that is due, SWEEP-20); it is empty for a stall or an exit.
    """

    action: str
    move: OwedMove | None
    prefix: str


@dataclass
class _MoveState:
    spec: MoveSpec
    text: str
    brief: str = ""
    markers: tuple[tuple[str, ...], ...] = ()
    variants: tuple[str, ...] = ()
    status: str = "pending"
    enabled_sec: float | None = None
    delivered_sec: float | None = None
    delivered_turn: int | None = None
    resolved_turn: int | None = None
    issued: int = 0
    interruptions: int = 0
    forced_when_issued: bool = False
    delivery: Delivery | None = None


class OwedMoveScheduler:
    """Per-session schedule of the learner's owed moves (see the module docstring)."""

    def __init__(self, decision_maker: str, *, markers_v2: bool = False) -> None:
        """``markers_v2``: R1_MARKERS_V2 (simulation diagnosis 1), the wider delivery markers."""
        self.decision_maker = decision_maker
        self._states: dict[str, _MoveState] = {}
        for spec in PLAN:
            if spec.id == COMMIT_STALL:
                text = commitment_line(Level.WEAK, decision_maker)
            else:
                text = _fill(spec.line, decision_maker)
            markers = widened_markers(spec.id, spec.markers) if markers_v2 else spec.markers
            self._states[spec.id] = _MoveState(
                spec,
                text,
                brief=_fill(spec.brief, decision_maker),
                markers=tuple(
                    tuple(_fill(pattern, decision_maker, regex=True) for pattern in group)
                    for group in markers
                ),
                variants=(text, *(_fill(item, decision_maker) for item in spec.variants))
                if spec.variants
                else (),
            )
        self.turn = 0
        self.last_r: float | None = None
        self._gaps: list[float] = []
        self.pitch_turn: int | None = None
        self.price_quoted_turn: int | None = None
        self.price_answered_turn: int | None = None
        self.format_covered_turn: int | None = None
        self.projects_covered_turn: int | None = None
        self.close_attempts = 0
        self.commitment_resolved = False
        self._delivered_in_turn = -1
        self._last_objection_turn: int | None = None
        self._topic_turn: dict[str, int] = {}
        self._turn_answered = False
        # M032 SWEEP-20: (move id, issued, forced_when_issued, enabled_sec) before the last
        # redirect.
        self._redirect_undo: tuple[str, int, bool, float | None] | None = None

    # ------------------------------------------------------------------ observation
    @property
    def lookahead_sec(self) -> float:
        """Expected length of the next turn: the recent average, clamped to 20-90 s."""
        recent = self._gaps[-4:]
        average = sum(recent) / len(recent) if recent else DEFAULT_TURN_SEC
        return min(LOOKAHEAD_MAX_SEC, max(LOOKAHEAD_MIN_SEC, average))

    @property
    def cautious_lookahead_sec(self) -> float:
        """The slowest recent turn, never below ``lookahead_sec`` (M032 S1, review S1-R2).

        The S1 waits and holds spend the plan's buffer, so their slack is judged at the pace of the
        slowest of the last four turns: the first slow exchange after a fast stretch counts at once,
        where the average takes four turns to catch up.  Clamped like the average.
        """
        recent = self._gaps[-4:]
        slowest = max(recent) if recent else DEFAULT_TURN_SEC
        return min(LOOKAHEAD_MAX_SEC, max(self.lookahead_sec, slowest))

    def observe_candidate_turn(self, text: object, r_sec: float) -> TurnSignals:
        """Record one candidate turn at role-play time ``r_sec`` and derive its signals."""
        self.turn += 1
        if self.last_r is not None and r_sec > self.last_r:
            self._gaps.append(r_sec - self.last_r)
        self.last_r = r_sec
        pitch = is_pitch_statement(text)
        price = quotes_price(text)
        fmt = covers_format(text)
        projects = covers_projects(text)
        topics = topics_in(text)
        for family in topics:
            self._topic_turn[family] = self.turn
        self._turn_answered = answers_substantively(text)
        if pitch and self.pitch_turn is None:
            self.pitch_turn = self.turn
        if price and self.price_quoted_turn is None:
            self.price_quoted_turn = self.turn
        anchor = self._states[F1_ANCHOR]
        answered = False
        if (
            anchor.delivered_turn is not None
            and anchor.delivered_turn < self.turn
            and self.price_answered_turn is None
            and answers_price(text)
        ):
            self.price_answered_turn = self.turn
            answered = True
        if fmt and self.format_covered_turn is None:
            self.format_covered_turn = self.turn
        if projects and self.projects_covered_turn is None:
            self.projects_covered_turn = self.turn
        # Record when each move became ready even if this turn is answered by something
        # other than an owed move (a stall, a reveal, a free reply), so slip is never
        # understated.
        self._refresh_enabled(r_sec)
        return TurnSignals(
            turn=self.turn,
            pitch=pitch,
            price_quoted=price,
            price_answered=answered,
            format_covered=fmt,
            projects_covered=projects,
            close_attempt=is_close_attempt(text, r_sec),
            substantive=word_count(text) >= 2,
            topics=topics,
            answered=self._turn_answered,
        )

    # -------------------------------------------------------------------- selection
    def _state(self, move_id: str) -> _MoveState:
        return self._states[move_id]

    def _delivered(self, move_id: str) -> bool:
        return self._states[move_id].status == "delivered"

    def is_delivered(self, move_id: str) -> bool:
        """True once ``move_id`` was proven spoken (False for an unknown move)."""
        state = self._states.get(move_id)
        return state is not None and state.status == "delivered"

    def turns_since_delivery(self, move_id: str) -> int | None:
        """Learner turns since ``move_id`` was delivered (None if it was not)."""
        return self._since(move_id) if move_id in self._states else None

    def _since(self, move_id: str) -> int | None:
        state = self._states[move_id]
        if state.delivered_turn is None:
            return None
        return self.turn - state.delivered_turn

    def family_complete(self, family: str) -> bool:
        """True when every required component of ``family`` has been delivered."""
        return all(
            self._delivered(spec.id)
            for spec in PLAN
            if spec.family == family and spec.required
        )

    @property
    def all_families_complete(self) -> bool:
        return all(self.family_complete(family) for family in FAMILIES)

    @property
    def open_family(self) -> str | None:
        """The family whose primary was delivered but whose exchange is not finished."""
        for family in FAMILIES:
            primary = next(
                spec.id for spec in PLAN if spec.family == family and spec.role == "primary"
            )
            if self._delivered(primary) and not self.family_complete(family):
                return family
        return None

    @property
    def price_wrap_turn(self) -> int | None:
        """The turn that follows the F1 counter: the advisor's second answer on price.

        Plan 5.7 step 3: after it the learner does not push on price again.
        """
        counter = self._states[F1_COUNTER]
        return None if counter.delivered_turn is None else counter.delivered_turn + 1

    def graded_moves_owed(self, r_sec: float) -> bool:
        """True while a required move of a graded family (F1-F4) is still to come.

        A required move that is not delivered is owed until its deadline plus
        ``SLIP_LIMIT_SEC`` (after that the API fidelity gate counts it missing
        whatever happens).  M2 review fix: the interviewer's "going nowhere" offer to
        wrap up waits for this, so an accepted offer cannot end the role-play before
        F4-PRIMARY and F4-PUSH were said (``family_missing:f4`` / ``push_missing:f4``).
        """
        for spec in PLAN:
            if spec.family not in FAMILIES or not spec.required:
                continue
            if self._delivered(spec.id):
                continue
            if spec.deadline_sec is None or r_sec <= spec.deadline_sec + SLIP_LIMIT_SEC:
                return True
        return False

    def commit_permitted(self, r_sec: float) -> bool:
        """The close window: all four families done and R >= 13:00."""
        return self.all_families_complete and r_sec >= COMMIT_PERMITTED_R_SEC

    def mark_commitment_resolved(self) -> None:
        """Record that a grade-level commitment line (or the 19:00 stall) was spoken."""
        self.commitment_resolved = True

    def note_price_answered(self) -> None:
        """The negotiation read the advisor's answer to the anchor (an offer or a refusal).

        The price words of ``answers_price`` miss "let's make it 8.5" and a bare 8500; the
        negotiation reads those, so the counter does not have to wait for its fallback.
        """
        anchor = self._states[F1_ANCHOR]
        if (
            anchor.delivered_turn is not None
            and anchor.delivered_turn < self.turn
            and self.price_answered_turn is None
        ):
            self.price_answered_turn = self.turn

    def note_topic(self, family: str) -> None:
        """This advisor turn touched ``family``'s topic (M032 SWEEP-19: a number question before
        the anchor is a fresh moment for the F1 probe or anchor), as ``topics_in`` would mark it."""
        self._topic_turn[family] = self.turn

    def note_objection(self, *, turn: int | None = None) -> None:
        """A learner objection that is not a scheduled move (a stall reason) just landed.

        Spacing counts it, so the next scheduled objection still has breathing room.  ``turn`` is
        the learner turn it was said on (M032 S1: a stall she volunteered in a free reply, recorded
        after that reply played); the current turn by default, and never earlier than the last one.
        """
        when = self.turn if turn is None else min(turn, self.turn)
        if self._last_objection_turn is None or when > self._last_objection_turn:
            self._last_objection_turn = when

    def _primary_gate(self, family: str | None) -> bool:
        return self.open_family in (None, family)

    def _hard_ready(self, state: _MoveState, r_sec: float) -> bool:
        move_id = state.spec.id
        family = state.spec.family
        if state.status != "pending":
            return False
        if state.spec.role == "primary" and not self._primary_gate(family):
            return False
        since = self._since
        if move_id == F3_PRIMARY:
            return self.pitch_turn is not None or r_sec >= F3_FALLBACK_OPEN_SEC
        if move_id == F3_PUSH:
            return (since(F3_PRIMARY) or 0) >= 1
        if move_id == F2_PRIMARY:
            return (since(F3_PUSH) or 0) >= 1
        if move_id == F2_PUSH:
            return (since(F2_PRIMARY) or 0) >= 1
        if move_id == F1_ANCHOR:
            return (since(F2_PUSH) or 0) >= 1 or self.price_quoted_turn is not None
        if move_id == F1_COUNTER:
            return (since(F1_ANCHOR) or 0) >= 1
        if move_id == F4_PRIMARY:
            return (
                self.family_complete("F3")
                and self.family_complete("F2")
                and self.family_complete("F1")
                and (since(F1_COUNTER) or 0) >= 1
            )
        if move_id == F4_PUSH:
            return (since(F4_PRIMARY) or 0) >= 1
        if move_id == TIME_CUE:
            # Only inside the 17:00-19:00 window: after the close window opens for the
            # WEAK stall, "I've only got a couple of minutes" would be meaningless.
            in_window = TIME_CUE_SEC <= r_sec < COMMIT_STALL_R_SEC
            return in_window and self.open_family is None
        if move_id == COMMIT_STALL:
            return (
                r_sec >= COMMIT_STALL_R_SEC
                and self.commit_permitted(r_sec)
                and not self.commitment_resolved
                and self.open_family is None
            )
        return False

    def _since_objection(self) -> int:
        """Learner turns since the last objection of any family (since the start if none)."""
        if self._last_objection_turn is None:
            return self.turn
        return self.turn - self._last_objection_turn

    def _topic_fresh(self, family: str | None) -> bool:
        """The advisor's turn touched ``family``'s topic this turn or the one before."""
        if family is None:
            return False
        last = self._topic_turn.get(family)
        return last is not None and self.turn - last <= 1

    def _primary_in_context(self, family: str | None, moment: Moment | None = None) -> bool:
        """Breathing room first; then the topic came up, or it has been quiet for a while.

        With a ``moment`` that has slack (M032 S1, D-M032-1) the quiet-stretch path needs a
        natural moment too: the floor handed to her or a thread just closed, and not an open
        thread.  The wait is bounded (review S1-R2): after ``IDLE_GAP_SLACK_TURNS`` turns without an
        objection the primary is ready again, open thread or not (an advisor who puts something to
        her every turn kept a thread open on every turn, and the wait spent the plan's whole
        buffer); on such a turn the engine's respond-first hold may still hold it once.  It can
        only make a primary later than without a moment, never earlier.
        """
        gap = self._since_objection()
        if gap < SPACING_TURNS:
            return False
        if self._topic_fresh(family):
            return True
        if gap < IDLE_GAP_TURNS:
            return False
        if moment is None or not moment.slack_ok:
            return True
        if moment.floor_offered or gap >= IDLE_GAP_SLACK_TURNS:
            return True
        if moment.thread_open:
            return False
        return moment.thread_closed

    def _push_answered(self, primary_id: str) -> bool:
        """A push follows an answer to its primary, or waits a couple of turns.

        An answer is a turn after the primary that touched the family's topic (``_topic_fresh``,
        but not the turn that prompted the primary itself), or a substantive turn that is not
        mainly a question or a request about the call (``answers_substantively``).
        """
        state = self._states[primary_id]
        family = state.spec.family
        on_topic = (
            self._topic_fresh(family)
            and state.delivered_turn is not None
            and self._topic_turn[family] > state.delivered_turn
        )
        return (
            on_topic
            or self._turn_answered
            or (self._since(primary_id) or 0) >= PUSH_PATIENCE_TURNS
        )

    def _soft_ready(self, state: _MoveState, moment: Moment | None = None) -> bool:
        move_id = state.spec.id
        since = self._since
        if state.spec.role == "primary":
            return self._primary_in_context(state.spec.family, moment)
        if move_id == F3_PUSH:
            return self._push_answered(F3_PRIMARY)
        if move_id == F2_PUSH:
            return self._push_answered(F2_PRIMARY)
        if move_id == F4_PUSH:
            return self._push_answered(F4_PRIMARY)
        if move_id == F1_COUNTER:
            return self.price_answered_turn is not None or (since(F1_ANCHOR) or 0) >= 2
        return True

    def _is_forced(self, state: _MoveState, r_sec: float) -> bool:
        deadline = state.spec.deadline_sec
        return deadline is not None and r_sec + self.lookahead_sec >= deadline

    def _enable_time(self, state: _MoveState, r_sec: float) -> float:
        """When a move that just became ready could first have been spoken.

        A turn-gated move became ready at this learner turn.  A clock-gated move (the F3
        fallback at 5:00, the cue at 17:00) became ready at its clock time, so a long
        candidate monologue cannot hide a late first learner turn.
        """
        move_id = state.spec.id
        if move_id == F3_PRIMARY and self.pitch_turn is None:
            return min(r_sec, float(F3_FALLBACK_OPEN_SEC))
        if move_id == TIME_CUE:
            return min(r_sec, float(TIME_CUE_SEC))
        return r_sec

    def _refresh_enabled(self, r_sec: float) -> None:
        for state in self._states.values():
            if state.enabled_sec is None and self._hard_ready(state, r_sec):
                state.enabled_sec = self._enable_time(state, r_sec)

    def _due(self, state: _MoveState, r_sec: float) -> float:
        enabled = state.enabled_sec if state.enabled_sec is not None else r_sec
        deadline = state.spec.deadline_sec
        if state.spec.id == COMMIT_STALL:
            return max(float(COMMIT_STALL_R_SEC), enabled)
        if deadline is None:
            return enabled
        return max(float(deadline), enabled)

    def select(self, r_sec: float, *, moment: Moment | None = None) -> OwedMove | None:
        """The one move owed at this turn, or None.  Does not mark it as issued.

        ``moment`` (M032 S1) is what the advisor's turn was, for the idle path of a primary
        (``_primary_in_context``); None is the rule of before, so every other caller keeps it.
        """
        if self._delivered_in_turn == self.turn:
            return None
        self._refresh_enabled(r_sec)
        open_family = self.open_family
        best: tuple[tuple[int, float, int], _MoveState, bool] | None = None
        for state in self._states.values():
            if not self._hard_ready(state, r_sec):
                continue
            forced = self._is_forced(state, r_sec)
            if not (forced or self._soft_ready(state, moment)):
                continue
            order = _ORDER[state.spec.id]
            deadline = state.spec.deadline_sec
            if forced and state.spec.required:
                key = (0, float(deadline or 0), order)
            elif open_family is not None and state.spec.family == open_family:
                key = (1, 0.0, order)
            else:
                key = (2, float(deadline) if deadline is not None else 1e9, order)
            if best is None or key < best[0]:
                best = (key, state, forced)
        if best is None:
            return None
        _, state, forced = best
        return self._owed(state, r_sec, forced)

    def _owed(self, state: _MoveState, r_sec: float, forced: bool) -> OwedMove:
        return OwedMove(
            id=state.spec.id,
            family=state.spec.family,
            role=state.spec.role,
            text=state.text,
            forced=forced,
            deadline_sec=state.spec.deadline_sec,
            due_sec=self._due(state, r_sec),
            brief=state.brief,
            must_say=state.spec.must_say,
            markers=state.markers,
            variants=state.variants,
        )

    def issue(self, move: OwedMove) -> None:
        """Record that ``move`` was handed to the session (it stays owed until delivered)."""
        state = self._states[move.id]
        state.issued += 1
        state.forced_when_issued = move.forced

    def unissue(self, move_id: str) -> None:
        """Give back one issue of ``move_id``: its reply was cancelled before any audio (M032 S1).

        The split-answer replan issues the move again for the reply that is heard, so a move is
        counted once per reply the candidate heard ("issued": 2 for one spoken F2 push).
        """
        state = self._states.get(move_id)
        if state is not None and state.issued > 0:
            state.issued -= 1

    def next_move(self, r_sec: float) -> OwedMove | None:
        """Select the owed move and mark it issued."""
        move = self.select(r_sec)
        if move is not None:
            self.issue(move)
        return move

    # --------------------------------------------------------------------- delivery
    def confirm_delivered(
        self, move_id: str, r_sec: float, *, interrupted: bool = False
    ) -> Delivery | None:
        """Record that the worker finished saying ``move_id``.

        An interrupted playout is not a delivery: the move stays owed and is issued
        again at the next learner turn.  Returns None for an unknown, already-delivered
        or interrupted move.
        """
        state = self._states.get(move_id)
        if state is None or state.status != "pending":
            return None
        if interrupted:
            state.interruptions += 1
            return None
        if state.enabled_sec is None:
            state.enabled_sec = r_sec
        due = self._due(state, r_sec)
        deadline = state.spec.deadline_sec
        delivery = Delivery(
            move_id=move_id,
            family=state.spec.family,
            turn=self.turn,
            delivered_sec=r_sec,
            due_sec=due,
            slip_sec=max(0.0, r_sec - due),
            lateness_sec=None if deadline is None else max(0.0, r_sec - deadline),
        )
        state.status = "delivered"
        state.delivered_sec = r_sec
        state.delivered_turn = self.turn
        state.resolved_turn = self.turn
        state.delivery = delivery
        self._delivered_in_turn = self.turn
        if state.spec.family is not None:
            self._last_objection_turn = self.turn
        if move_id == COMMIT_STALL:
            self.commitment_resolved = True
        return delivery

    def spoken_proves(self, move_id: str, spoken_text: object) -> bool:
        """Whether the played text raised ``move_id``: its markers, else its verbatim line.

        A move with markers is proven by them (the model voices it in its own words, or the
        scripted fallback does: every variant satisfies the markers).  A move without markers
        (the 19:00 stall) is proven by the verbatim line, as before.
        """
        state = self._states.get(move_id)
        if state is None:
            return False
        if state.markers:
            return markers_match(state.markers, spoken_text)
        if fuzzy_contains(spoken_text, state.text, MATCH_THRESHOLD):
            return True
        if move_id == COMMIT_STALL:
            # The stall has three wordings (e-mail me; call me back; I'll read the e-mail).
            return any(
                fuzzy_contains(
                    spoken_text,
                    commitment_line(Level.WEAK, self.decision_maker, **variant),
                    MATCH_THRESHOLD,
                )
                for variant in ({"call": True}, {"emailed": True})
            )
        return False

    def confirm_if_spoken(
        self, move_id: str, spoken_text: object, r_sec: float, *, interrupted: bool = False
    ) -> Delivery | None:
        """Confirm delivery from the text that was actually played.

        The move counts as delivered when the played text proves it (``spoken_proves``), so
        punctuation, wording and small STT-style changes do not matter.  A barge-in that cut
        it short fails the check and leaves the move owed.
        """
        state = self._states.get(move_id)
        if state is None or state.status != "pending":
            return None
        if not self.spoken_proves(move_id, spoken_text):
            if interrupted:
                state.interruptions += 1
            return None
        return self.confirm_delivered(move_id, r_sec)

    # ---------------------------------------------------------------- early closing
    def _force_next(self, r_sec: float) -> OwedMove | None:
        """First unfinished move in plan order, ignoring clocks and spacing.

        A family that is mid-exchange finishes first, so a redirect never opens a new
        family on top of an unanswered push.
        """
        open_family = self.open_family
        for spec in PLAN:
            if spec.id in (COMMIT_STALL, TIME_CUE):
                continue
            if open_family is not None and spec.family != open_family:
                continue
            state = self._states[spec.id]
            if state.status != "pending":
                continue
            # M032 SWEEP-20: what a probing redirect gives back (``return_to_pending``).
            self._redirect_undo = (
                spec.id, state.issued, state.forced_when_issued, state.enabled_sec
            )
            if state.enabled_sec is None:
                state.enabled_sec = r_sec
            return self._owed(state, r_sec, True)
        return None

    def required_pending(self) -> tuple[str, ...]:
        """M032 SWEEP-24: the required graded moves not yet delivered, in plan order (pure)."""
        return tuple(
            spec.id
            for spec in PLAN
            if spec.required and spec.family in FAMILIES and not self._delivered(spec.id)
        )

    def next_forced_peek(self, r_sec: float) -> OwedMove | None:
        """M032 SWEEP-24: the move ``_force_next`` would give, without changing any state.

        Neither its enabled time nor the redirect's give-back record is touched; ``r_sec`` is only
        the reading time of the ``OwedMove`` returned.
        """
        open_family = self.open_family
        for spec in PLAN:
            if spec.id in (COMMIT_STALL, TIME_CUE):
                continue
            if open_family is not None and spec.family != open_family:
                continue
            state = self._states[spec.id]
            if state.status != "pending":
                continue
            return self._owed(state, r_sec, True)  # reads the state, sets nothing
        return None

    def return_to_pending(self, move_id: str) -> bool:
        """Undo the redirect's ``issue`` of ``move_id``: it stays owed as if never redirected.

        M032 SWEEP-20 (flag R1_PROBE_FIRST): an early-close redirect that speaks a probe (a short
        price or time question) delivers nothing graded, so the move's issued count, its forced flag
        and its enabled time go back to what they were before the farewell; its deadline is
        unchanged, and the farewell still used up the one redirect (``close_attempts``).  True when
        the state was restored.
        """
        undo = self._redirect_undo
        if undo is None or undo[0] != move_id:
            return False
        state = self._states[move_id]
        if state.status != "pending":
            return False
        _move, issued, forced, enabled = undo
        state.issued = issued
        state.forced_when_issued = forced
        state.enabled_sec = enabled
        self._redirect_undo = None
        return True

    def register_close_attempt(self, r_sec: float) -> CloseDecision:
        """Handle a farewell: redirect once before R = 14:00, otherwise exit.

        First attempt before 14:00 is answered by the next owed move, once (the learner
        stops the advisor: the redirect is an intent the model voices).  A second attempt, or
        any attempt once R >= 14:00 with the commitment resolved (or R >= 19:00), goes to
        ROLEPLAY_EXIT.  If nothing is left to redirect with, the learner delivers the WEAK
        stall when the close window is open, else the call exits.
        """
        self.close_attempts += 1
        resolved = self.commitment_resolved
        if r_sec >= EARLY_CLOSE_BEFORE_SEC and (resolved or r_sec >= COMMIT_STALL_R_SEC):
            return CloseDecision("exit", None, "")
        if self.close_attempts >= 2:
            return CloseDecision("exit", None, "")
        move = self._force_next(r_sec)
        if move is not None:
            return CloseDecision("redirect", move, REDIRECT_OPENERS[0])
        if self.commit_permitted(r_sec) and not resolved:
            state = self._states[COMMIT_STALL]
            state.enabled_sec = state.enabled_sec if state.enabled_sec is not None else r_sec
            return CloseDecision("stall", self._owed(state, r_sec, True), "")
        return CloseDecision("exit", None, "")

    # ---------------------------------------------------------------------- summary
    def deliveries(self) -> list[Delivery]:
        done = [s.delivery for s in self._states.values() if s.delivery is not None]
        return sorted(done, key=lambda item: (item.delivered_sec, _ORDER[item.move_id]))

    def deliveries_by_id(self) -> dict[str, Delivery]:
        return {item.move_id: item for item in self.deliveries()}

    def summary(self, *, final: bool = False) -> dict[str, object]:
        """Admin-log view of the schedule; with ``final`` missing families are reasons.

        Contains turn indices and seconds only; no candidate text.
        """
        moves = []
        for spec in PLAN:
            state = self._states[spec.id]
            delivery = state.delivery
            moves.append(
                {
                    "id": spec.id,
                    "family": spec.family,
                    "status": state.status,
                    "deadline_sec": spec.deadline_sec,
                    "enabled_sec": _round(state.enabled_sec),
                    "delivered_sec": _round(state.delivered_sec),
                    "turn": state.delivered_turn,
                    "slip_sec": _round(delivery.slip_sec) if delivery else None,
                    "lateness_sec": _round(delivery.lateness_sec) if delivery else None,
                    "issued": state.issued,
                    "interruptions": state.interruptions,
                    "forced": state.forced_when_issued,
                }
            )
        families: dict[str, dict[str, object]] = {}
        reasons: list[str] = []
        for family in FAMILIES:
            parts = [s for s in self._states.values() if s.spec.family == family]
            slips = [s.delivery.slip_sec for s in parts if s.delivery is not None]
            late = [
                s.delivery.lateness_sec
                for s in parts
                if s.delivery is not None and s.delivery.lateness_sec is not None
            ]
            complete = self.family_complete(family)
            max_slip = max(slips) if slips else None
            families[family] = {
                "delivered": complete,
                "max_slip_sec": _round(max_slip),
                "max_lateness_sec": _round(max(late)) if late else None,
            }
            if max_slip is not None and max_slip > SLIP_LIMIT_SEC:
                reasons.append(f"family_slip:{family}")
            if final and not complete:
                reasons.append(f"family_missing:{family}")
        cue = self._states[TIME_CUE]
        return {
            "plan_version": PLAN_VERSION,
            "moves": moves,
            "families": families,
            "time_cue_delivered_sec": _round(cue.delivered_sec),
            "close_attempts": self.close_attempts,
            "excluded_from_auto_status": bool(reasons),
            "exclusion_reasons": reasons,
        }


def _round(value: float | None) -> float | None:
    return None if value is None else round(float(value), 1)
