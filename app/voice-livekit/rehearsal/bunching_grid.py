"""The bunching grid: advisor patterns x five paces, offline, against the real learner engine.

M032 S1 item 8 (and the earlier review's "fix2/grid.py", which was never committed).  Every
change to WHEN the learner raises her owed objections has to show that no family goes late, that
the forced path is not used materially more often, and where in their windows the families now
land.  This module drives ``RolePlayEngine`` turn by turn with a scripted advisor and a scripted
learner model (no network, no key, no LLM), the way ``tests/test_r1_roleplay.Session`` does, and
reports per pattern and pace:

* ``late``: the families with a move said after its deadline (inside the slip limit), or never
  completed;
* ``excluded``: the schedule's exclusion reasons (``family_slip``, ``family_missing``): a family
  that slipped past the limit or went missing, so the attempt is not auto-scored;
* ``forced``: how many of the eight graded moves were issued on the forced path;
* ``last_r``: the R (seconds) of the last graded delivery, the end of the "bunch";
* ``cue_r``: when the 17:00 time cue was said (None if never);
* ``holds``: how many turns held an owed move back (any ``owed_deferred_*`` reason);
* ``waits``: how many turns an idle primary waited for a natural moment (M032 S1);
* ``gaps``: per family, the learner lines heard between the line that delivered its primary and
  the line that delivered its push (SWEEP-1: at least 1 when neither was forced and the pace is
  35 s or faster), with ``forced_primaries`` the families whose primary was forced.

The six patterns of the earlier review (cooperative, pitcher, terse, questioner, offerer, cutter)
are the gate, with two more from the S1 review (S1-R1): ``decider`` and ``cutter_decider`` are the
cooperative and the cutting advisor with a learner who names her decision maker in a free reply
whenever she is asked who else decides (a volunteered stall, S1 item 3).  ``owner_shape`` is a
paraphrased reconstruction of the shape of the owner's 2026-11-11 call (the advisor answers her
questions, offers to bring her husband in, puts a question to her and gives her time); it is
reported, not gated, and copies no line of that call.

The STEP rows (``STEPS``, review S1-R2) start at the owner's pace and slow down mid-call (20 or
25 s an exchange, then 55-80 s from R 250-650).  The S1 waits spend slack while the pace is fast,
so a later slowdown can leave a family a little later than the release before it; the gate there
is the scoring one (``gate_regressions``): no new exclusion (a slip past the limit or a missing
family) and no time cue lost.  Lateness and forced moves are reported.

Run it from ``app/voice-livekit``::

    python -m rehearsal.bunching_grid                 # the flags as the environment sets them
    python -m rehearsal.bunching_grid --compare       # every S1 flag off, then every one on
    python -m rehearsal.bunching_grid --compare-s2    # S1 on and S2 off, then every flag on

``--compare-s2`` (M032 S2, learner voice) also reports every flag off (origin/main) against every
flag on.  ``pushy`` (SWEEP-3) is an advisor who asks her to enrol today again and again, with a
learner who says in a free reply that she is not ready to commit today whenever she is asked: her
volunteered stall spaces the next objection (``note_objection`` is global), so F1, F2 and F3
lateness is reported for it.

``--compare`` also prints the runs where the flags made a family late or excluded that was not
before, or used the forced path more than ``FORCED_TOLERANCE`` times more (``regressions``).

The advisor texts are synthetic.  Nothing here reads or writes a session, a transcript or a key.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator
from unittest import mock

_WORKER_DIR = str(Path(__file__).resolve().parents[1])
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

from r1_personas import resolve_persona  # noqa: E402
from r1_roleplay import RolePlayEngine, TurnMode  # noqa: E402
from r1_scheduler import CURIOSITY_LABELS_V2, CURIOSITY_TOPICS  # noqa: E402

PACES: tuple[float, ...] = (20.0, 25.0, 35.0, 50.0, 65.0)
GRADED_MOVES: tuple[str, ...] = (
    "F3-PRIMARY",
    "F3-PUSH",
    "F2-PRIMARY",
    "F2-PUSH",
    "F1-ANCHOR",
    "F1-COUNTER",
    "F4-PRIMARY",
    "F4-PUSH",
)
# The M032 S1 rollback flags.  ``--compare`` runs the grid with all of them off (the behaviour of
# origin/main) and with all of them on.
S1_FLAGS: tuple[str, ...] = (
    "R1_NATURAL_TIMING",
    "R1_RESPOND_FIRST",
    "R1_CONCERN_LEDGER",
    "R1_SPLIT_REPLAN",
    "R1_PUSH_AFTER_REACTION",
)
# The M032 S2 rollback flags (learner voice).  ``--compare-s2`` runs S1 on with these off, then
# every flag on, and reports every flag off (origin/main) against every flag on.
S2_FLAGS: tuple[str, ...] = (
    "R1_LEARNER_VOICE_V2",
    "R1_NO_COMMIT_LEDGER",
    "R1_OFFER_TERMS",
    "R1_ACK_TURN_NOTE",
    "R1_TIC_V2",
    "R1_OFFER_REALISM",
    "R1_REPLY_LENGTH",
)
# The S1 review's step rows: (fast pace, slow pace, R from which the slow pace applies).
STEPS: tuple[tuple[float, float, float], ...] = (
    (20.0, 55.0, 250.0),
    (20.0, 65.0, 250.0),
    (20.0, 80.0, 450.0),
    (20.0, 80.0, 650.0),
    (25.0, 65.0, 350.0),
    (25.0, 80.0, 250.0),
)
# The graded families with a primary and a push (F1's counter answers the advisor's price).
PUSH_PAIRS: dict[str, tuple[str, str]] = {
    "F3": ("F3-PRIMARY", "F3-PUSH"),
    "F2": ("F2-PRIMARY", "F2-PUSH"),
    "F1": ("F1-ANCHOR", "F1-COUNTER"),
    "F4": ("F4-PRIMARY", "F4-PUSH"),
}
# SWEEP-1's target: at these paces and faster an unforced push follows at least one reaction.
REACTION_PACE_MAX = 35.0
REACTION_FAMILIES: tuple[str, ...] = ("F3", "F2", "F4")
END_R_SEC = 1150.0
START_R_SEC = 20.0
GREETING = "Hi, this is Alex from the admissions team. Thanks for taking my call."
INTENT_ACK = "Okay, I see."
FREE_REPLY = "I see, that helps."
# The ``decider`` learners' free reply when the advisor asks who else decides (S1-R1).
DECIDER_REPLY = "Honestly, I'd need to talk it through with my husband first."
# The ``pushy`` learner's free reply when the advisor asks her to enrol today (SWEEP-3).
NOT_TODAY_REPLY = "I'm not ready to commit to anything today."
# What the scripted learner asks when a free reply is handed a curiosity topic (keyed by the label
# the reminder quotes), and how a helpful advisor answers it.
CURIOSITY_QUESTIONS: dict[str, str] = {
    "whether the classes are live or recorded": "Are the classes live or recorded?",
    "what you would actually build in the course": "What would I actually build in the course?",
    "whether you could pay in monthly instalments": "Could I pay in monthly instalments?",
    "how much time you would get with mentors": "Would I get one-on-one time with a mentor?",
    "how many hours a week it takes": "How many hours a week does it take?",
    "how many people are in a batch": "How many people are in a batch?",
    "whether you need to know anything before you start": (
        "Do I need to know anything before I start?"
    ),
    "whether there is any help with the job search afterwards": (
        "Is there any help with the job search afterwards?"
    ),
}
# With R1_TIC_V2 (SWEEP-12) the reminder quotes a rotated phrase per topic: the scripted learner
# asks the same question for any phrase of that topic.
_TOPIC_QUESTIONS = {
    topic: CURIOSITY_QUESTIONS[label]
    for topic, label in CURIOSITY_TOPICS
    if label in CURIOSITY_QUESTIONS
}
CURIOSITY_LABEL_QUESTIONS: dict[str, str] = {
    **CURIOSITY_QUESTIONS,
    **{
        phrase: _TOPIC_QUESTIONS[topic]
        for topic, phrases in CURIOSITY_LABELS_V2.items()
        if topic in _TOPIC_QUESTIONS
        for phrase in phrases
    },
}
CURIOSITY_ANSWERS: dict[str, str] = {
    "Are the classes live or recorded?": (
        "The classes are live on weekends, and every session is recorded for you as well."
    ),
    "What would I actually build in the course?": (
        "You'll build three portfolio projects, including a churn model and a dashboard."
    ),
    "Could I pay in monthly instalments?": (
        "Yes, there is an EMI option, so you can spread the payments over twelve months."
    ),
    "Would I get one-on-one time with a mentor?": (
        "Yes, every learner gets a one-on-one mentor session every two weeks."
    ),
    "How many hours a week does it take?": (
        "Most learners spend about eight hours a week on it, alongside a full-time job."
    ),
    "How many people are in a batch?": "There are about thirty students in a batch.",
    "Do I need to know anything before I start?": (
        "No prior coding experience is needed, we start from the basics."
    ),
    "Is there any help with the job search afterwards?": (
        "Yes, career support includes resume reviews, mock interviews and referrals."
    ),
}

COOPERATIVE = (
    "What made you start looking at data science right now?",
    "Tell me more about that.",
    "Our curriculum covers python, sql and machine learning, with mentors from top companies.",
    "How many hours a week could you realistically put in alongside work?",
    "The classes are live on weekends and every session is recorded, so you can catch up.",
    "Would anyone else be involved in the decision?",
    "The course is $9,000, and there are discounts depending on the payment plan you pick.",
    "I can't go down to $7,000, but I can take $1,000 off on the upfront plan.",
    "Our alumni have moved into analyst roles at good companies after the program.",
    "Your husband is welcome to be involved, we are happy to include him in every step.",
    "Mentorship and mock interviews are part of the program from the first month.",
)
PITCHER = (
    "Our program covers python, statistics and machine learning, and you'll build real projects "
    "with mentor reviews every single week.",
    "We have live classes on weekends and recordings of every session, so working people can fit "
    "it around their jobs easily.",
    "Our career support includes resume reviews, mock interviews and referrals to our hiring "
    "partners across the country.",
    "The fee is $9,000 and we offer an EMI option so that you don't have to pay it all at once.",
    "Most of our learners are working professionals who study six to eight hours a week on top "
    "of their jobs.",
    "Our instructors come from companies like Google and Amazon and they bring real-world "
    "experience into every module.",
)
TERSE = ("Okay.", "Sure.", "Right.", "I see.", "Mm-hmm, okay.", "Got it.")
QUESTIONER = (
    "We have weekend batches and weekday evening batches. Which timing would suit you better?",
    "Our mentors review every project. Have you built anything like that before?",
    "The program runs for six months. How does your week usually look for you?",
    "We have an EMI option as well. Which number would suit you?",
    "Our alumni work at good companies now. Does that kind of role appeal to you?",
    "There is a capstone at the end. Would you enjoy working on a real dataset?",
)
OFFERER = (
    "I can send you the recordings of a sample class so you can see the teaching.",
    "Take your time, there's no rush at all on this.",
    "I can bring your husband into a joint call if that helps you both.",
    "We can arrange a short session with one of our mentors for you this week.",
    "No pressure, discuss it at home and come back to me whenever you like.",
    "I can share a few alumni stories with you over email after this.",
)
CHALLENGE = "Where did you get that number?"
# SWEEP-3: an advisor who keeps asking her to enrol today, between short pitches.
PUSHY = (
    "Our curriculum covers python, sql and machine learning, with mentors from top companies.",
    "Can you enrol today? Seats in this batch are filling fast.",
    "The classes are live on weekends and every session is recorded, so you can catch up.",
    "So shall I send you the enrolment link today?",
    "The course is $9,000, and there are discounts depending on the payment plan you pick.",
    "Would you like to lock in your seat today?",
    "Our alumni have moved into analyst roles at good companies after the program.",
)
# The owner's call, in shape only (paraphrased; no line of it is copied).  Her own questions are
# answered as the cooperative advisor answers them.
OWNER_SHAPE = (
    "Tell me a little about your work right now and what made you look at data science.",
    "We have both live classes and recordings of every session, so you never miss anything.",
    "Our mentors come from big tech companies, they review your projects and refer you onwards.",
    "That's a fair point, plenty of people feel that way at the start.",
    "Sure, if your husband is around, I can bring him into a joint call and go over it again.",
    "The fee is $9,000, and there is a monthly plan if that is easier for you.",
    "So which number would suit you?",
    "Okay, I hear you.",
    "Fine, talk it over at home and come back to me whenever you are ready.",
    "Okay.",
)
# The gated patterns: no run of them may turn late or excluded, nor be forced more than this many
# times more often, with the S1 flags on than with them off.
GATED_PATTERNS: tuple[str, ...] = (
    "cooperative",
    "pitcher",
    "terse",
    "questioner",
    "offerer",
    "cutter",
    "decider",
    "cutter_decider",
)
FORCED_TOLERANCE = 1


@dataclass
class RunResult:
    """One simulated role-play at one pace (counts, seconds and move ids only)."""

    pattern: str
    pace: float
    step: tuple[float, float] | None = None  # (slow pace, from R) for a STEP row
    late: list[str] = field(default_factory=list)
    excluded: list[str] = field(default_factory=list)
    forced: int = 0
    last_r: float | None = None
    cue_r: float | None = None
    holds: int = 0
    waits: int = 0
    delivered: dict[str, float | None] = field(default_factory=dict)
    turns: int = 0
    gaps: dict[str, int | None] = field(default_factory=dict)
    forced_moves: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "pattern": self.pattern,
            "pace": self.pace,
            "step": None if self.step is None else list(self.step),
            "late": list(self.late),
            "excluded": list(self.excluded),
            "forced": self.forced,
            "last_r": self.last_r,
            "cue_r": self.cue_r,
            "holds": self.holds,
            "waits": self.waits,
            "delivered": dict(self.delivered),
            "turns": self.turns,
            "gaps": dict(self.gaps),
            "forced_moves": list(self.forced_moves),
        }

    def reaction_gaps(self) -> dict[str, int | None]:
        """SWEEP-1: the gaps of the families whose primary and push were both unforced."""
        return {
            family: self.gaps.get(family)
            for family in REACTION_FAMILIES
            if not set(PUSH_PAIRS[family]) & set(self.forced_moves)
            and self.gaps.get(family) is not None
        }


class _Learner:
    """The scripted learner model: an acknowledgement on intents, a question when handed one."""

    def __init__(
        self, engine: RolePlayEngine, *, names_decider: bool = False, says_not_today: bool = False
    ) -> None:
        self.engine = engine
        self.last_question: str | None = None
        self.heard = 0  # learner lines the advisor heard (some or all of)
        self.names_decider = names_decider
        self.says_not_today = says_not_today
        self.advisor_text = ""  # the advisor's turn this reply answers

    def speak(self, plan: Any, r_sec: float, *, cut: bool = False) -> str:
        engine = self.engine
        self.last_question = None
        if plan.mode is TurnMode.EXIT or plan.aside:
            return ""
        if plan.mode is TurnMode.SAY_ONLY:
            spoken = engine.compose_speech(plan).text
        elif plan.mode is TurnMode.INTENT:
            spoken = engine.compose_speech(plan, INTENT_ACK).text
        else:
            base = FREE_REPLY
            if self.names_decider and "anyone else" in self.advisor_text.lower():
                base = DECIDER_REPLY  # a stall she volunteers (S1 item 3)
            if self.says_not_today and "today" in self.advisor_text.lower():
                base = NOT_TODAY_REPLY  # the not-today stall she volunteers (SWEEP-3)
            reply = base
            reminder = plan.reminder or ""
            for label, question in CURIOSITY_LABEL_QUESTIONS.items():
                if f'curious about "{label}"' in reminder:
                    reply = f"{base} {question}"
                    self.last_question = question
                    break
            spoken = engine.sanitize_reply(plan, reply).text
            if self.last_question is not None and self.last_question not in spoken:
                self.last_question = None  # the guard dropped the question
        if cut and spoken:
            words = spoken.split()
            self.heard += 1
            engine.record_spoken(plan, " ".join(words[:3]), r_sec=r_sec, interrupted=True)
            return ""
        if spoken:
            self.heard += 1
            engine.record_spoken(plan, spoken, r_sec=r_sec)
        return spoken


AdvisorFn = Callable[[int, "_Learner"], str]


def _cycle(lines: tuple[str, ...], index: int) -> str:
    return lines[index % len(lines)]


def _cooperative(index: int, learner: _Learner) -> str:
    if learner.last_question is not None:
        return CURIOSITY_ANSWERS[learner.last_question]
    return _cycle(COOPERATIVE, index)


def _pitcher(index: int, learner: _Learner) -> str:
    return _cycle(PITCHER, index)


def _terse(index: int, learner: _Learner) -> str:
    return _cycle(TERSE, index)


def _questioner(index: int, learner: _Learner) -> str:
    return _cycle(QUESTIONER, index)


def _offerer(index: int, learner: _Learner) -> str:
    return _cycle(OFFERER, index)


def _cutter(index: int, learner: _Learner) -> str:
    if index % 3 == 2:
        return CHALLENGE
    return _cooperative(index, learner)


def _pushy(index: int, learner: _Learner) -> str:
    if learner.last_question is not None:
        return CURIOSITY_ANSWERS[learner.last_question]
    return _cycle(PUSHY, index)


def _owner_shape(index: int, learner: _Learner) -> str:
    if learner.last_question is not None:
        return CURIOSITY_ANSWERS[learner.last_question]
    return _cycle(OWNER_SHAPE, index)


PATTERNS: dict[str, AdvisorFn] = {
    "cooperative": _cooperative,
    "pitcher": _pitcher,
    "terse": _terse,
    "questioner": _questioner,
    "offerer": _offerer,
    "cutter": _cutter,
    "decider": _cooperative,
    "cutter_decider": _cutter,
    "owner_shape": _owner_shape,
    "pushy": _pushy,
}
# The patterns whose learner names her decision maker when asked who else decides.
DECIDER_PATTERNS = frozenset({"decider", "cutter_decider"})
# The patterns whose learner says she is not ready to commit today when asked to enrol today.
NOT_TODAY_PATTERNS = frozenset({"pushy"})


def run_one(
    pattern: str,
    pace: float,
    *,
    seed: str = "grid",
    step: tuple[float, float] | None = None,
) -> RunResult:
    """One role-play: ``pattern``'s advisor at ``pace`` seconds an exchange until R = 19:10.

    ``step`` (slow pace, from R): the exchanges from that R on take the slow pace (a STEP row).
    """
    advisor = PATTERNS[pattern]
    persona = resolve_persona("p1_career_switcher", variant="v1")
    engine = RolePlayEngine(persona, candidate_first_name="Alex", seed=f"{seed}:{pattern}:{pace}")
    learner = _Learner(
        engine,
        names_decider=pattern in DECIDER_PATTERNS,
        says_not_today=pattern in NOT_TODAY_PATTERNS,
    )
    result = RunResult(pattern, pace, step)
    cut_moves: set[str] = set()
    line_of: dict[str, int] = {}  # the heard learner line that delivered each graded move
    r = START_R_SEC
    index = -1
    text = GREETING
    while r <= END_R_SEC:
        plan = engine.plan_turn(text, r, turn_index=2 * result.turns + 1, candidate_seconds=8.0)
        result.turns += 1
        if any(reason.startswith("owed_deferred") for reason in plan.reasons):
            result.holds += 1
        if "owed_waits_for_moment" in plan.reasons:
            result.waits += 1
        if plan.mode is TurnMode.EXIT:
            break
        cut = (
            pattern == "cutter"
            and plan.mode is TurnMode.INTENT
            and plan.move_id in GRADED_MOVES
            and plan.move_id not in cut_moves
        )
        if cut:
            cut_moves.add(plan.move_id)
        learner.advisor_text = text
        learner.speak(plan, r, cut=cut)
        for move_id in GRADED_MOVES:
            if move_id not in line_of and engine.scheduler.is_delivered(move_id):
                line_of[move_id] = learner.heard
        index += 1
        text = advisor(index, learner)
        r += pace if step is None or r < step[1] else step[0]
    summary = engine.scheduler.summary(final=True)
    moves = {move["id"]: move for move in summary["moves"]}
    for move_id in GRADED_MOVES:
        move = moves[move_id]
        result.delivered[move_id] = move["delivered_sec"]
        if move["delivered_sec"] is not None and move["forced"]:
            result.forced += 1
            result.forced_moves.append(move_id)
    for family, (primary, push) in PUSH_PAIRS.items():
        if primary in line_of and push in line_of:
            result.gaps[family] = line_of[push] - line_of[primary] - 1
        else:
            result.gaps[family] = None
    delivered = [value for value in result.delivered.values() if value is not None]
    result.last_r = max(delivered) if delivered else None
    result.cue_r = summary["time_cue_delivered_sec"]
    late: set[str] = set()
    for family, info in summary["families"].items():
        lateness = info["max_lateness_sec"]
        if not info["delivered"] or (lateness is not None and lateness > 0):
            late.add(family)
    result.late = sorted(late)
    result.excluded = sorted(summary["exclusion_reasons"])
    return result


def run_grid(
    env: dict[str, str] | None = None,
    *,
    patterns: tuple[str, ...] | None = None,
    paces: tuple[float, ...] = PACES,
) -> list[RunResult]:
    """Every pattern at every pace, with ``env`` (flag values) set for the duration."""
    names = patterns or tuple(PATTERNS)
    with mock.patch.dict(os.environ, env or {}):
        return [run_one(name, pace) for name in names for pace in paces]


def run_steps(
    env: dict[str, str] | None = None,
    *,
    patterns: tuple[str, ...] = GATED_PATTERNS,
    steps: tuple[tuple[float, float, float], ...] = STEPS,
) -> list[RunResult]:
    """The STEP rows: every gated pattern at each (fast, slow, from R) of ``steps``."""
    with mock.patch.dict(os.environ, env or {}):
        return [
            run_one(name, fast, step=(slow, at)) for name in patterns for fast, slow, at in steps
        ]


def _key(item: RunResult) -> tuple[str, float, tuple[float, float] | None]:
    return (item.pattern, item.pace, item.step)


def _where(item: RunResult) -> str:
    where = f"{item.pattern}@{item.pace:.0f}"
    if item.step is not None:
        where += f"->{item.step[0]:.0f}@R{item.step[1]:.0f}"
    return where


def gate_regressions(before: list[RunResult], after: list[RunResult]) -> list[str]:
    """The runs ``after`` made worse for scoring: a new exclusion or a newly missing time cue."""
    found: list[str] = []
    old = {_key(item): item for item in before}
    for item in after:
        base = old.get(_key(item))
        if base is None:
            continue
        for reason in sorted(set(item.excluded) - set(base.excluded)):
            found.append(f"{_where(item)}: {reason} new")
        if item.cue_r is None and base.cue_r is not None:
            found.append(f"{_where(item)}: time cue newly missing")
    return found


def flags(value: str) -> dict[str, str]:
    """Every S1 rollback flag set to ``value`` ("0" or "1")."""
    return {name: value for name in S1_FLAGS}


def s2_flags(value: str, *, s1: str = "1") -> dict[str, str]:
    """Every S2 rollback flag set to ``value``, and every S1 flag to ``s1``."""
    return {**flags(s1), **{name: value for name in S2_FLAGS}}


def all_flags(value: str) -> dict[str, str]:
    """Every S1 and S2 rollback flag set to ``value`` (all "0" is origin/main)."""
    return s2_flags(value, s1=value)


def totals(results: list[RunResult]) -> dict[str, Any]:
    """The grid's headline numbers: late and excluded runs, forced moves, mean last delivery."""
    last = [item.last_r for item in results if item.last_r is not None]
    return {
        "runs": len(results),
        "late_runs": sum(1 for item in results if item.late),
        "excluded_runs": sum(1 for item in results if item.excluded),
        "forced_moves": sum(item.forced for item in results),
        "mean_last_r": round(sum(last) / len(last), 1) if last else None,
        "cue_missing": sum(1 for item in results if item.cue_r is None),
        "pushes_without_reaction_fast": len(pushes_without_reaction(results)),
    }


def pushes_without_reaction(
    results: list[RunResult], *, patterns: tuple[str, ...] = GATED_PATTERNS
) -> list[str]:
    """SWEEP-1: the unforced pushes said on the line right after their primary, at
    ``REACTION_PACE_MAX`` or faster (``pattern@pace:family``)."""
    found: list[str] = []
    for item in results:
        if item.pattern not in patterns or item.pace > REACTION_PACE_MAX:
            continue
        for family, gap in item.reaction_gaps().items():
            if gap is not None and gap < 1:
                found.append(f"{item.pattern}@{item.pace:.0f}:{family}")
    return found


def regressions(
    before: list[RunResult],
    after: list[RunResult],
    *,
    patterns: tuple[str, ...] = GATED_PATTERNS,
) -> list[str]:
    """The runs ``after`` made worse than ``before``: a family newly late or excluded, the forced
    path used more than ``FORCED_TOLERANCE`` times more, or the time cue newly missing."""
    found: list[str] = []
    old = {_key(item): item for item in before}
    for item in after:
        if item.pattern not in patterns:
            continue
        base = old.get(_key(item))
        if base is None:
            continue
        where = _where(item)
        for family in sorted(set(item.late) - set(base.late)):
            found.append(f"{where}: {family} newly late")
        for reason in sorted(set(item.excluded) - set(base.excluded)):
            found.append(f"{where}: {reason} new")
        if item.forced > base.forced + FORCED_TOLERANCE:
            found.append(f"{where}: forced {base.forced} -> {item.forced}")
        if item.cue_r is None and base.cue_r is not None:
            found.append(f"{where}: time cue newly missing")
    return found


def last_delivery_table(before: list[RunResult], after: list[RunResult]) -> str:
    """The last graded delivery (R seconds) per pattern and pace, before -> after."""
    old = {(item.pattern, item.pace): item for item in before}
    paces = sorted({item.pace for item in after})
    lines = ["pattern       " + "".join(f"{pace:>13.0f}" for pace in paces)]
    for pattern in dict.fromkeys(item.pattern for item in after):
        cells = []
        for pace in paces:
            new = next(i for i in after if (i.pattern, i.pace) == (pattern, pace))
            base = old.get((pattern, pace))
            left = "-" if base is None or base.last_r is None else f"{base.last_r:.0f}"
            right = "-" if new.last_r is None else f"{new.last_r:.0f}"
            cells.append(f"{left + '->' + right:>13}")
        lines.append(f"{pattern:<14}" + "".join(cells))
    return "\n".join(lines)


def _rows(results: list[RunResult]) -> Iterator[str]:
    yield (
        "pattern              pace  late         excluded                 forced  last_r  cue_r  "
        "holds waits  gaps (F3 F2 F1 F4)"
    )
    for item in results:
        pace = f"{item.pace:.0f}" + (
            "" if item.step is None else f">{item.step[0]:.0f}@{item.step[1]:.0f}"
        )
        late = ",".join(item.late) or "-"
        excluded = ",".join(item.excluded) or "-"
        last = "-" if item.last_r is None else f"{item.last_r:.0f}"
        cue = "-" if item.cue_r is None else f"{item.cue_r:.0f}"
        gaps = " ".join(
            "-" if item.gaps.get(family) is None else str(item.gaps[family])
            for family in PUSH_PAIRS
        )
        yield (
            f"{item.pattern:<14} {pace:>10}  {late:<11}  {excluded:<23}  {item.forced:>6}  "
            f"{last:>6}  {cue:>5}  {item.holds:>5} {item.waits:>5}  {gaps}"
        )


def table(results: list[RunResult]) -> str:
    return "\n".join(_rows(results))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--compare", action="store_true", help="flags off, then flags on")
    parser.add_argument(
        "--compare-s2", action="store_true", help="S1 on and S2 off, then every flag on"
    )
    parser.add_argument("--json", help="write the results to this file")
    args = parser.parse_args(argv)
    out: dict[str, Any] = {}
    if args.compare_s2:
        return _compare_s2(args.json)
    settings = (("off", flags("0")), ("on", flags("1"))) if args.compare else (("env", None),)
    grids: dict[str, list[RunResult]] = {}
    for label, env in settings:
        results = run_grid(env)
        grids[label] = results
        print(f"== flags {label}")
        print(table(results))
        print(json.dumps(totals(results)))
        out[label] = {"totals": totals(results), "runs": [item.as_dict() for item in results]}
    if args.compare:
        found = regressions(grids["off"], grids["on"])
        print("== last graded delivery R (off -> on)")
        print(last_delivery_table(grids["off"], grids["on"]))
        print("== regressions (gated patterns): " + ("; ".join(found) if found else "none"))
        out["regressions"] = found
        steps_off = run_steps(flags("0"))
        steps_on = run_steps(flags("1"))
        print("== step rows, flags off")
        print(table(steps_off))
        print("== step rows, flags on")
        print(table(steps_on))
        gate = gate_regressions(steps_off, steps_on)
        other = regressions(steps_off, steps_on)
        print("== step rows, scoring regressions: " + ("; ".join(gate) if gate else "none"))
        print("== step rows, later or more forced (reported): " + ("; ".join(other) or "none"))
        out["step_gate_regressions"] = gate
        out["step_changes"] = other
        out["steps"] = {
            "off": [item.as_dict() for item in steps_off],
            "on": [item.as_dict() for item in steps_on],
        }
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=1), encoding="utf-8")
    return 0


def late_families(results: list[RunResult], pattern: str) -> dict[str, list[str]]:
    """The families late or excluded per pace for ``pattern`` (the SWEEP-3 report)."""
    return {
        f"{item.pace:.0f}": sorted(set(item.late) | set(item.excluded))
        for item in results
        if item.pattern == pattern
    }


def _compare_s2(json_path: str | None) -> int:
    """M032 S2: S1 on with S2 off against every flag on, and every flag off against every on."""
    out: dict[str, Any] = {}
    grids = {
        "main": run_grid(all_flags("0")),
        "s1": run_grid(s2_flags("0")),
        "s2": run_grid(all_flags("1")),
    }
    for label, results in grids.items():
        print(f"== {label}")
        print(table(results))
        print(json.dumps(totals(results)))
        out[label] = {"totals": totals(results), "runs": [item.as_dict() for item in results]}
    for base in ("s1", "main"):
        found = regressions(grids[base], grids["s2"])
        print(f"== last graded delivery R ({base} -> s2)")
        print(last_delivery_table(grids[base], grids["s2"]))
        print(f"== regressions ({base} -> s2, gated patterns): " + ("; ".join(found) or "none"))
        out[f"regressions_{base}"] = found
    for label in grids:
        out[f"pushy_late_{label}"] = late_families(grids[label], "pushy")
        print(f"== pushy late or excluded ({label}): {json.dumps(out[f'pushy_late_{label}'])}")
    steps = {"s1": run_steps(s2_flags("0")), "s2": run_steps(all_flags("1"))}
    gate = gate_regressions(steps["s1"], steps["s2"])
    print("== step rows (s1 -> s2), scoring regressions: " + ("; ".join(gate) or "none"))
    out["step_gate_regressions"] = gate
    out["step_changes"] = regressions(steps["s1"], steps["s2"])
    if json_path:
        Path(json_path).write_text(json.dumps(out, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
