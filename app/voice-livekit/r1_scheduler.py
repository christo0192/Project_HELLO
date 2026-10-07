"""R1 owed-move scheduler: deterministic, worker-side, on the role-play clock R.

Plan 5.6.  The worker, not the LLM, decides which objection or neutral question the
learner owes next.  The moves are:

    Q-A   F3 value (primary, push)   F2 time (primary, push)   F1 price (anchor, counter)
    Q-B   F4 stall (primary, push)   L-TIME-CUE                COMMIT-STALL

Rules enforced here (each has a unit test):

* Discovery is protected: nothing is owed until the advisor makes a genuine value or
  pitch statement, or R reaches 3:30.  A greeting that merely names "Program Advisor" or
  "Interview Kickstart" is not a pitch (S0-B defect 3).
* At most ONE owed move per learner turn.
* A family is not opened until the previous family's exchange is answered, and a forced
  neutral question (Q-A, Q-B) never jumps the open family's pending push: the push is owed
  "unconditionally, next learner turn" and the question's slip gates nothing.
* Spacing ("at least 2 candidate turns after") is a soft floor.  A deadline FORCES the
  move at the last learner turn that still lands on time, so spacing can never make a
  family unschedulable (S0-B defects 1 and 2).
* "Later deadlines shift instead": a move's effective deadline is
  ``max(nominal deadline, the turn its hard prerequisites were first met)``, so a late
  predecessor never makes its successors look late.  Slip is measured against that
  effective deadline; lateness against the nominal one is logged as well.
* Q-B skipped because the advisor already explained what is built counts as resolved at
  the moment of the skip, so F4 is never starved of its prerequisite.
* A move that was not delivered (interrupted, TTS failure) stays owed.
* L-TIME-CUE is only owed between 11:00 and 13:00 (after that the WEAK stall takes the
  turn), and a polite "thanks for your time" opener is not a farewell (``is_close_attempt``
  ignores the first minute, and that phrase until 4:00).  A farewell must END its
  sentence (only a name, "for now" or a closing courtesy may follow) and no later sentence
  of the turn may ask something, so "Take care of your kids first" or "That's all I have
  on the curriculum, any questions?" never cuts the role-play short.
* F1's counter follows the advisor's first concession or refusal, or, if the advisor never
  answers the anchor, the second candidate turn after it (S0-B: it was never owed in 4 runs).
* Any family slipping more than 60 s, or never delivered, excludes the session from
  auto-status.
* The learner's lines are spoken VERBATIM by the worker (escalation step 1 from S0-B);
  this module only says what is owed and records delivery.

The module is pure: it never reads a clock, so every test drives R explicitly.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from r1_commitment import (
    COMMIT_PERMITTED_R_SEC,
    COMMIT_STALL_R_SEC,
    commitment_line,
    Level,
)
from r1_script import LINES
from r1_text import fold, fuzzy_contains, is_question_like, split_sentences, word_count

PLAN_VERSION = 1
SLIP_LIMIT_SEC = 60.0
DEFAULT_TURN_SEC = 45.0
LOOKAHEAD_MIN_SEC = 20.0
LOOKAHEAD_MAX_SEC = 90.0
SPACING_TURNS = 2
Q_A_OPENS_SEC = 120
F3_FALLBACK_OPEN_SEC = 210
TIME_CUE_SEC = 660
EARLY_CLOSE_BEFORE_SEC = 600
MATCH_THRESHOLD = 0.78

Q_A = "Q-A"
F3_PRIMARY = "F3-PRIMARY"
F3_PUSH = "F3-PUSH"
F2_PRIMARY = "F2-PRIMARY"
F2_PUSH = "F2-PUSH"
F1_ANCHOR = "F1-ANCHOR"
F1_COUNTER = "F1-COUNTER"
Q_B = "Q-B"
F4_PRIMARY = "F4-PRIMARY"
F4_PUSH = "F4-PUSH"
COMMIT_STALL = "COMMIT-STALL"
TIME_CUE = "L-TIME-CUE"

TIME_CUE_LINE = LINES["L-TIME-CUE"]
OH_WAIT_PREFIX = "Oh wait, before you go..."


@dataclass(frozen=True)
class MoveSpec:
    """One row of the plan 5.6 table."""

    id: str
    family: str | None
    role: str
    line: str
    deadline_sec: int | None
    required: bool


PLAN: tuple[MoveSpec, ...] = (
    MoveSpec(Q_A, None, "question", "Is it live classes or recorded?", 210, False),
    MoveSpec(
        F3_PRIMARY,
        "F3",
        "primary",
        "There's so much free stuff on YouTube and Coursera \u2014 why pay?",
        300,
        True,
    ),
    MoveSpec(
        F3_PUSH,
        "F3",
        "push",
        "Will this actually get me a job, with all these layoffs?",
        300,
        True,
    ),
    MoveSpec(
        F2_PRIMARY,
        "F2",
        "primary",
        "My schedule is already packed; I'm not sure I can keep up for six months.",
        420,
        True,
    ),
    MoveSpec(F2_PUSH, "F2", "push", "What happens if I fall behind?", 420, True),
    MoveSpec(
        F1_ANCHOR,
        "F1",
        "primary",
        "$9,000 is a lot. I've heard people got it for around $7,000 \u2014 can you do that?",
        540,
        True,
    ),
    MoveSpec(F1_COUNTER, "F1", "push", "Can you do a little better than that?", 540, True),
    MoveSpec(Q_B, None, "question", "What would I actually build in the course?", 585, False),
    MoveSpec(
        F4_PRIMARY,
        "F4",
        "primary",
        "Let me think about it \u2014 maybe I'll join the next cohort.",
        630,
        True,
    ),
    MoveSpec(F4_PUSH, "F4", "push", "I'd also need to talk to my {decision_maker}.", 630, True),
    MoveSpec(COMMIT_STALL, None, "stall", "", None, False),
    MoveSpec(TIME_CUE, None, "cue", TIME_CUE_LINE, None, False),
)
FAMILIES = ("F3", "F2", "F1", "F4")
REQUIRED_MOVES = tuple(spec.id for spec in PLAN if spec.required)
SPEC_BY_ID = {spec.id: spec for spec in PLAN}
_ORDER = {spec.id: index for index, spec in enumerate(PLAN)}


def _compile(*patterns: str) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(pattern, re.IGNORECASE) for pattern in patterns)


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
    r"off the table|out of the question|won'?t (?:work|happen))\b",
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
_CLOSING_COURTESY = (
    r"(?:good luck|best of luck|all the best|enjoy|feel free|please (?:reach|feel)|reach out)\b"
    r"[^?]*"
)
_CLOSING_PROMISE = (
    r"(?:i|we)(?:'ll| will| can)\s+(?:send|follow|be in touch|get back|have|email|reach|call|"
    r"look|keep|check|share|forward|get|text|ping|connect|let you know|talk|speak|catch)\b"
    r"[^?]*"
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
    r"\bhave a (?:great|good|nice|wonderful|lovely) "
    r"(?:day|evening|night|one|week|weekend)\b" + _FAREWELL_TAIL,
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


def _sentences(text: object) -> list[str]:
    return [fold(sentence).lower() for sentence in split_sentences(text)]


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


def _asks_something(sentence: str) -> bool:
    """A question that is not itself a farewell ("Have a great day." opens like one)."""
    if "?" in sentence:
        return True
    if any(pattern.search(sentence) for pattern in _CLOSE_FAREWELL):
        return False
    return is_question_like(sentence)


def is_close_attempt(text: object, r_sec: float | None = None) -> bool:
    """A farewell or wrap-up phrase.  Never fires on "end the call" style instructions.

    With ``r_sec`` given, nothing counts before R = 1:00 and the courtesy "thanks for your
    time" only counts from R = 4:00, so a polite opening is never mistaken for goodbye.
    A sentence counts when it ENDS with the farewell (see ``_FAREWELL_TAIL``) and no later
    sentence of the turn asks something, so a turn that goes on to ask ("Take care of your
    kids first, any questions?") is never a goodbye.
    """
    if r_sec is not None and r_sec < CLOSE_MIN_R_SEC:
        return False
    thanks_allowed = r_sec is None or r_sec >= CLOSE_THANKS_MIN_R_SEC
    sentences = _sentences(text)
    for index, sentence in enumerate(sentences):
        if any(_asks_something(later) for later in sentences[index + 1 :]):
            continue
        if any(pattern.search(sentence) for pattern in _CLOSE_FAREWELL):
            return True
        if thanks_allowed and any(pattern.search(sentence) for pattern in _CLOSE_THANKS):
            return True
    return False


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


@dataclass(frozen=True)
class OwedMove:
    """The one move owed this turn.  ``text`` is spoken verbatim by the worker."""

    id: str
    family: str | None
    role: str
    text: str
    forced: bool
    deadline_sec: int | None
    due_sec: float


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
    """Response to an early close attempt: redirect with a move, stall, or exit."""

    action: str
    move: OwedMove | None
    prefix: str


@dataclass
class _MoveState:
    spec: MoveSpec
    text: str
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

    def __init__(self, decision_maker: str) -> None:
        self.decision_maker = decision_maker
        self._states: dict[str, _MoveState] = {}
        for spec in PLAN:
            if spec.id == COMMIT_STALL:
                text = commitment_line(Level.WEAK, decision_maker)
            else:
                text = spec.line.format(decision_maker=decision_maker)
            self._states[spec.id] = _MoveState(spec, text)
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

    # ------------------------------------------------------------------ observation
    @property
    def lookahead_sec(self) -> float:
        """Expected length of the next turn: the recent average, clamped to 20-90 s."""
        recent = self._gaps[-4:]
        average = sum(recent) / len(recent) if recent else DEFAULT_TURN_SEC
        return min(LOOKAHEAD_MAX_SEC, max(LOOKAHEAD_MIN_SEC, average))

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
        self._auto_skip()
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
        )

    def _auto_skip(self) -> None:
        """Skip a neutral question the advisor already answered; resolved NOW (defect 1)."""
        for move_id, covered in (
            (Q_A, self.format_covered_turn),
            (Q_B, self.projects_covered_turn),
        ):
            state = self._states[move_id]
            if state.status == "pending" and covered is not None:
                state.status = "skipped"
                state.resolved_turn = self.turn

    # -------------------------------------------------------------------- selection
    def _state(self, move_id: str) -> _MoveState:
        return self._states[move_id]

    def _delivered(self, move_id: str) -> bool:
        return self._states[move_id].status == "delivered"

    def _since(self, move_id: str) -> int | None:
        state = self._states[move_id]
        if state.delivered_turn is None:
            return None
        return self.turn - state.delivered_turn

    def _resolved(self, move_id: str) -> bool:
        return self._states[move_id].status in ("delivered", "skipped")

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

        Plan 5.7 step 3: after it the learner says "Okay, that's helpful" and moves on.
        """
        counter = self._states[F1_COUNTER]
        return None if counter.delivered_turn is None else counter.delivered_turn + 1

    def commit_permitted(self, r_sec: float) -> bool:
        """The close window: all four families done and R >= 9:00."""
        return self.all_families_complete and r_sec >= COMMIT_PERMITTED_R_SEC

    def mark_commitment_resolved(self) -> None:
        """Record that a grade-level commitment line (or the 13:00 stall) was spoken."""
        self.commitment_resolved = True

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
        if move_id == Q_A:
            return r_sec >= Q_A_OPENS_SEC
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
        if move_id == Q_B:
            return self.family_complete("F1") and (since(F1_COUNTER) or 0) >= 1
        if move_id == F4_PRIMARY:
            return (
                self.family_complete("F3")
                and self.family_complete("F2")
                and self.family_complete("F1")
                and self._resolved(Q_B)
                and self._turns_since_f4_prerequisites() >= 1
            )
        if move_id == F4_PUSH:
            return (since(F4_PRIMARY) or 0) >= 1
        if move_id == TIME_CUE:
            # Only inside the 11:00-13:00 window: after the close window opens for the
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

    def _turns_since_f4_prerequisites(self) -> int:
        """Candidate turns since F1 and Q-B were both resolved (delivered or skipped)."""
        turns = []
        for move_id in (F1_COUNTER, Q_B):
            state = self._states[move_id]
            marker = state.delivered_turn if state.delivered_turn is not None else (
                state.resolved_turn
            )
            if marker is None:
                return 0
            turns.append(marker)
        return self.turn - max(turns)

    def _soft_ready(self, state: _MoveState) -> bool:
        move_id = state.spec.id
        since = self._since
        if move_id == F2_PRIMARY:
            return (since(F3_PUSH) or 0) >= SPACING_TURNS
        if move_id == F1_ANCHOR:
            return self.price_quoted_turn is not None or (since(F2_PUSH) or 0) >= SPACING_TURNS
        if move_id == F1_COUNTER:
            return self.price_answered_turn is not None or (since(F1_ANCHOR) or 0) >= 2
        if move_id == F4_PRIMARY:
            return self._turns_since_f4_prerequisites() >= SPACING_TURNS
        return True

    def _is_forced(self, state: _MoveState, r_sec: float) -> bool:
        deadline = state.spec.deadline_sec
        return deadline is not None and r_sec + self.lookahead_sec >= deadline

    def _enable_time(self, state: _MoveState, r_sec: float) -> float:
        """When a move that just became ready could first have been spoken.

        A turn-gated move became ready at this learner turn.  A clock-gated move (Q-A at
        2:00, the F3 fallback at 3:30, the cue at 11:00) became ready at its clock time,
        so a long candidate monologue cannot hide a late first learner turn.
        """
        move_id = state.spec.id
        if move_id == Q_A:
            return min(r_sec, float(Q_A_OPENS_SEC))
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

    def select(self, r_sec: float) -> OwedMove | None:
        """The one move owed at this turn, or None.  Does not mark it as issued."""
        if self._delivered_in_turn == self.turn:
            return None
        self._refresh_enabled(r_sec)
        open_family = self.open_family
        best: tuple[tuple[int, float, int], _MoveState, bool] | None = None
        for state in self._states.values():
            if not self._hard_ready(state, r_sec):
                continue
            forced = self._is_forced(state, r_sec)
            if not (forced or self._soft_ready(state)):
                continue
            order = _ORDER[state.spec.id]
            deadline = state.spec.deadline_sec
            if forced and state.spec.required:
                key = (0, float(deadline or 0), order)
            elif open_family is not None and state.spec.family == open_family:
                key = (1, 0.0, order)
            elif forced:
                # A neutral question (Q-A, Q-B) is never required and its slip gates
                # nothing, so it must not jump an open family's pending push, which the
                # plan owes "unconditionally, next learner turn".
                key = (1, 1.0, order)
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
        )

    def issue(self, move: OwedMove) -> None:
        """Record that ``move`` was handed to the session (it stays owed until delivered)."""
        state = self._states[move.id]
        state.issued += 1
        state.forced_when_issued = move.forced

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
        """Record that the worker finished speaking ``move_id``'s line.

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
        if move_id == COMMIT_STALL:
            self.commitment_resolved = True
        return delivery

    def confirm_if_spoken(
        self, move_id: str, spoken_text: object, r_sec: float, *, interrupted: bool = False
    ) -> Delivery | None:
        """Confirm delivery from the text that was actually played.

        The line counts as delivered when the played text contains it (fuzzy match, so
        punctuation and small STT-style changes do not matter).  A barge-in that cut the
        line short fails the match and leaves the move owed.
        """
        state = self._states.get(move_id)
        if state is None or state.status != "pending":
            return None
        if not fuzzy_contains(spoken_text, state.text, MATCH_THRESHOLD):
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
            if state.enabled_sec is None:
                state.enabled_sec = r_sec
            return self._owed(state, r_sec, True)
        return None

    def register_close_attempt(self, r_sec: float) -> CloseDecision:
        """Handle a farewell: redirect once before R = 10:00, otherwise exit.

        First attempt before 10:00 gets "Oh wait, before you go..." plus the next owed
        move, once.  A second attempt, or any attempt once R >= 10:00 with the
        commitment resolved (or R >= 13:00), goes to ROLEPLAY_EXIT.  If nothing is left
        to redirect with, the learner delivers the WEAK stall when the close window is
        open, else the call exits.
        """
        self.close_attempts += 1
        resolved = self.commitment_resolved
        if r_sec >= EARLY_CLOSE_BEFORE_SEC and (resolved or r_sec >= COMMIT_STALL_R_SEC):
            return CloseDecision("exit", None, "")
        if self.close_attempts >= 2:
            return CloseDecision("exit", None, "")
        move = self._force_next(r_sec)
        if move is not None:
            return CloseDecision("redirect", move, OH_WAIT_PREFIX)
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
