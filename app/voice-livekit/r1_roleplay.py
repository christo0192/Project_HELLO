"""R1 role-play engine: the single integration surface for the learner's content.

One ``RolePlayEngine`` per interview ties together the owed-move scheduler, the
disclosure gate and coverage tracker, the earned-close logic and the output guard.  The
session (``r1_session``, a follow-up change) owns phases, clocks, I/O and the LLM; the
engine only DECIDES, deterministically, what the learner does on each candidate turn:

    plan = engine.plan_turn(candidate_text, r_sec, turn_index=..., candidate_seconds=...)

``plan.mode`` is one of

``SAY_ONLY``
    Speak ``plan.scripted_text`` verbatim and call no LLM: the graded commitment line (STRONG,
    MEDIUM with its call slot, or the WEAK resolution), the close-attempt stall, or
    (``plan.aside``) the interviewer's one-off L-ASIDE-COACH or L-ASIDE-END (``plan.line_id``),
    which the session speaks in the ASIDE phase with ``plan.voice == "interviewer"`` and which
    is excluded from evidence (plan 5.10).  The WEAK line is spoken at most once per session
    (``r1_negotiation``).
``INTENT``
    R1-Q option B, intent-voiced moves.  The worker decides WHAT the learner raises (an owed
    objection, an early-farewell redirect, the time cue, and, from the negotiation, a stall
    reason, the e-mail yes, one question about the call) and the model voices it in context,
    in the same single call: it reacts to the advisor first and then raises
    ``plan.intent.brief`` in its own words.  Delivery is proven by ``plan.intent.markers`` in
    the text that was played.  If the model's reply misses them, ``intent_tail`` returns a
    scripted variant (``plan.intent.fallbacks``, vetted by the repetition check) that the
    session appends, so an owed move is never lost to the model (a reply that already asked
    a question gets no second negotiation question: that line then waits).
    ``compose_speech`` builds the final text for callers that do not stream.  The 19:00 stall
    is an INTENT without markers: one short model reaction, then the scripted WEAK line, always.
``LLM_REPLY``
    A free, constrained reply using ``plan.reminder`` (a HINT for a first probe, the DEEP
    need's facts only on the turn that asks about a released topic, and now and then one
    curiosity topic), screened sentence by sentence by ``plan.guard_ctx``.
``EXIT``
    The candidate said goodbye again, or (``"end_confirmed"`` in ``plan.reasons``) confirmed an
    out-of-role request to stop before R = 14:00 with no commitment on record: the session moves
    to ROLEPLAY_EXIT and the interviewer's normal wrap-up follows (owner decision 2026-10-29).  An
    early end is scored only when the normal fidelity checks pass (``fidelity``: R reached 10:00,
    every family delivered, and the rest).  From 14:00, or with a commitment on record, an end
    request is a farewell on the close ladder instead.  Owner decision 2026-10-30: the session may
    hand ``plan_turn`` the end-intent model's verdict (``end_intent``), which can only raise the
    lexical reading ("wrap up the interview", "kindly end the interview", "end the inter view"),
    and a settled bare yes ("Yes.", "Haan ji.") answers L-ASIDE-END (``confirmed_yes``).

Repetition control (R1-Q): ``record_spoken`` feeds every sentence the learner actually
played into a ``SpokenMemory``; each plan's guard context carries a snapshot (``said``), so
the output guard drops a sentence the learner already said (a ``repeat`` hit: hygiene, never
posted).  The thinking filler and the guard fallback are 3-variant rotations seeded by the
attempt id (``filler_text``, ``GuardContext.variant``), and so are the scripted variants of
every intent.

Negotiation (R1-Q): ``self.negotiation`` (``r1_negotiation``) remembers what the advisor put on
the table (prices, callbacks, an e-mail offer, check-ins), which of the learner's stall reasons
(timing, money, decision maker) were raised and which the advisor handled.  An ask before the
close window is met with the next unused reason (or the owed F4 move, or any forced move; timing
and the decision maker are the F4 pair's own reasons and are never voiced early as well); an
ask inside the window is graded with the handled reasons as evidence.  The price counter
follows the advisor's actual answer, the anchor reacts to a price already on the table, and the
wrap turn reacts to the number on the table.  Once a scripted commitment line is on record, the
guard's commitment cap is that level, so the learner can confirm the call it booked.

Nothing here can change a phase, a grade or the schedule from candidate or model text
beyond the deterministic rules: the LLM has no tools, the judge's JSON is whitelisted,
and farewell/ask detection is lexical.  An intent's brief is worker-authored and never holds
candidate text.  The engine never stores candidate text; its logs hold turn indices, counts
and booleans only.

Integration sketch for ``r1_session`` (the follow-up change; one call per final candidate
transcript in ROLEPLAY, with ``r_sec`` read from the phase machine's role-play clock)::

    engine = RolePlayEngine(resolve_persona(pid, variant=v, seed=attempt_id,
                                            avoid_first_name=first_name),
                            candidate_first_name=first_name, seed=attempt_id)
    plan = engine.plan_turn(text, machine.roleplay_elapsed, turn_index=i,
                            backchannel=is_acknowledgement_turn(text),
                            repair=is_repair_turn(text),
                            answers_nothing=is_backchannel_turn(text))
    (after a barge-in cut the learner's line: an owed move it did not deliver waits one turn
     while the plan has a turn to spare, a lone acknowledgement only gets her point finished and
     a "Sorry?" gets it again, and a graded commitment line she did not finish is said again;
     see ``record_spoken``.  A reply cancelled before any audio is reported with
     ``engine.reply_lost(plan)``)
    if plan.exit_roleplay:            -> machine.transition(ROLEPLAY_EXIT), L-EXIT, the wrap-up
    elif plan.aside:                  -> ASIDE phase, say(plan.scripted_text), back to ROLEPLAY
    elif plan.mode is SAY_ONLY:       -> raise StopResponse; say(plan.scripted_text)
    else (INTENT or LLM_REPLY):       -> add plan.reminder as the ephemeral system message;
                                         llm_node streams through engine.stream_guard(plan);
                                         for an INTENT, once the stream ended, append
                                         engine.intent_tail(plan, <what was streamed>)
    afterwards: engine.record_spoken(plan, spoken_text, interrupted=...),
                messages = engine.judge_messages(text, learner_last, turn=plan.turn)
                ... later, off the speech path (possibly after the NEXT plan_turn):
                engine.apply_judge(shadow_judge_output, plan.turn)  (the turn it judged)
    at the end: post engine.admin_log(final=True, r_end=...) and persist
                ``interview_round_attempts.content_sha`` = ``r1_content.CONTENT_SHA256``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, replace
from enum import Enum
from typing import Any, Iterable

from r1_commitment import (
    COMMIT_STALL_R_SEC,
    THIN_ADVISOR_MEAN_WORDS,
    THIN_MIN_TURNS,
    AskKind,
    CommitmentEvidence,
    Level,
    classify_learner_commitment,
    commitment_line,
    detect_ask,
    grade,
)
from r1_content import CONTENT_SHA256, CONTENT_VERSION
from r1_guard import (
    QUESTION_DIET_WINDOW,
    REPEAT,
    GuardContext,
    GuardLedger,
    GuardResult,
    StreamGuard,
    guard_text,
    has_concession,
    hours_said,
)
from r1_negotiation import (
    ANCHOR_USD,
    COMMIT_REACTION_BRIEF,
    KIND_COMMIT,
    KIND_STALL,
    N_EMAIL,
    N_EMAIL_YES,
    N_TIMING,
    REASON_DECISION_MAKER,
    REASON_MONEY,
    REASON_TIMING,
    SPEC_BY_ID,
    SPEC_BY_REASON,
    Negotiation,
    NegotiationSpec,
    NegotiationTurn,
    anchor_after_offer,
    declines_call,
    fill_decision_maker,
    filled_markers,
    question_spec,
)
from r1_personas import H_TOPICS, RenderedPersona, asks_about_learner, detect_probes
from r1_prompts import (
    ANCHOR_NOT_OFFERED_NOTE,
    ANSWERED_NOTE,
    BACKCHANNEL_CUT_NOTE,
    CHALLENGE_NOTE,
    CHECKIN_DONE_NOTE,
    CHECKIN_NOTE,
    DECIDER_ASKED_NOTE,
    EMAIL_AGAIN_NOTE,
    EMAIL_OFFER_NOTE,
    HOLD_NOTE,
    HOLLOW_NOTE,
    CUT_REPEAT_NOTE,
    INTERRUPTED_NOTE,
    NEXT_STEP_PROPOSED_NOTE,
    PRICE_MET_NOTE,
    PRICE_UNCHANGED_NOTE,
    RESOLVED_NOTE,
    STRETCH_USED_NOTE,
    STYLE_NOTES,
    TEMPLATE_USED_NOTE,
    TRY_NOT_GRANTED_NOTE,
    control_prose,
    format_usd,
    interviewer_prefix,
    learner_prefix,
    turn_reminder,
)
from r1_scheduler import (
    ANSWERED_LABELS,
    COMMIT_STALL,
    CURIOSITY_EVERY,
    CURIOSITY_TOPICS,
    EARLY_CLOSE_BEFORE_SEC,
    F1_ANCHOR,
    F1_COUNTER,
    F2_PRIMARY,
    F2_PUSH,
    F3_PRIMARY,
    F3_PUSH,
    F4_PRIMARY,
    F4_PUSH,
    F4_PUSH_CALL_SUFFIX,
    FAMILIES,
    IDLE_GAP_TURNS,
    PLAN,
    REDIRECT_BRIEF,
    REDIRECT_OPENERS,
    TIME_CUE,
    TIME_CUE_BRIEF_ALTERNATIVES,
    OwedMove,
    OwedMoveScheduler,
    answered_topics,
    curiosity_covered,
    is_close_attempt,
    markers_match,
    quotes_price,
)
from r1_script import LEARNER_FILLER_SHORT, LEARNER_FILLER_VARIANTS
from r1_script import line as script_line
from r1_text import (
    PHRASE_STRETCH,
    PHRASE_TEMPLATE_Q,
    SpokenMemory,
    canonical_amounts,
    dollar_amounts,
    fold,
    fuzzy_contains,
    is_closer,
    is_hollow_turn,
    normalize,
    pick_variant,
    repeat_kind,
    reply_opener,
    reply_phrases,
    reply_tics,
    split_sentences,
    word_count,
)
from r1_tracker import (
    CoverageTracker,
    NeedState,
    build_judge_messages,
    confirms_end,
    declines_end,
    detect_character_break,
    end_intent_level,
    is_bare_yes,
    parse_judge_output,
    promises_call_back,
)
from r1_world import WORLD_VERSION

STALL_DEFER_GRACE_SEC = 30
# An ask in the very first advisor turn is the greeting, not a close (it is not graded, not held
# open for a farewell, and does not make the learner voice a stall reason).
EARLY_ASK_IGNORE_SEC = 30
MAX_ASIDES = 3
MIN_SUBSTANTIVE_TURNS = 8
SUBSTANTIVE_WORDS = 3
STT_SHORT_WORDS = 2
STT_SHORT_SHARE_LIMIT = 0.10
FIDELITY_MIN_R_SEC = 600
# The advisor text one turn's readers parse (its last characters): a cost bound only.
MAX_CANDIDATE_CHARS = 4000

KIND_OBJECTION = "objection"
KIND_REDIRECT = "redirect"
KIND_CUE = "cue"
# How many of the learner's last replies the style rules look back over (``r1_guard``).
STYLE_HISTORY = 8
# Situation notes that belong to a free reply: an intent has its own brief to voice.
_FREE_REPLY_NOTES = frozenset({ANCHOR_NOT_OFFERED_NOTE, TRY_NOT_GRANTED_NOTE})
# The advisor challenges the learner's own words or how the learner is asking (owner test
# 7f2a25e6: 56 "where did you get that number?", 58 "you are asking too many questions").  Read
# sentence by sentence; "where did you get your degree?" is a dig, not a challenge.  A sales point
# that opens the same way is not one either (reviewed fix): "I didn't mention it earlier, but we
# also have EMI", "why do you ask? Is budget a big concern?" (a sales technique), "you keep asking
# great questions".
_CHALLENGE = re.compile(
    r"\bwhere did you (?:get|hear|read) (?:that|this|it|those|these|the idea|the number)\b"
    r"|\bi (?:didn'?t|did not|never) (?:say|said|mention|mentioned|tell you|told you) "
    r"(?:anything|that|this|it|so)\b(?!.*\b(?:but|earlier|before|yet|however|also)\b)"
    r"|\bwhy (?:are|do) you keep ask(?:ing)?\b"
    r"|\bwhy are you (?:still |always )?asking (?:me )?"
    r"(?:so many|the same|all th(?:is|ese)|again)\b"
    r"|\btoo many questions\b"
    r"|\byou keep asking (?:me|so many|the same|all th(?:is|ese)|again|questions)\b",
    re.IGNORECASE,
)
# Owed moves held back for a challenge in one session: a combative advisor cannot stall the plan.
MAX_CHALLENGE_DEFERRALS = 2
# A cut or challenged objection waits a turn only while the plan is ahead of its pacing map
# (``RolePlayEngine._ahead_of_pacing``).  Each objection still owed is given this many turns: the
# idle gap a primary waits when the advisor never invites it, plus one for a cut.  On the final
# review's bunching grid (six advisor patterns x 20, 25, 35, 50 and 65 s an exchange) 4 is never
# worse than the release without holds on forced moves, slip or deliveries; 2.5 forced the F4 pair
# at 35 s, and 3 or 3.5 delivered the time cue up to 12 s later.
SLACK_TURNS_PER_MOVE = IDLE_GAP_TURNS + 1
# Each family's required moves and their shared deadline, in plan order (the pacing map).
_PACING_MAP: tuple[tuple[int, tuple[str, ...]], ...] = tuple(
    (
        max(spec.deadline_sec or 0 for spec in PLAN if spec.family == family and spec.required),
        tuple(spec.id for spec in PLAN if spec.family == family and spec.required),
    )
    for family in FAMILIES
)
# A turn this short that says no "no" leaves L-ASIDE-END's question open: speech-to-text finalises
# a lone "Hmm", "Okay." or "Yeah." about a second before the rest (owner test 7f2a25e6, 43/55/70).
END_FRAGMENT_WORDS = 2
# Voice barge-in: how often a graded commitment line that was played and then cut by a barge-in is
# said again on a later turn, per session.  A line the candidate never heard a word of (cancelled
# before any audio, ``reply_lost``) is said again as well, without counting.
COMMITMENT_REVOICE_LIMIT = 2


def challenges_learner(text: object) -> bool:
    """The advisor pushes back on something the learner said or on how the learner asks."""
    return any(_CHALLENGE.search(fold(sentence)) for sentence in split_sentences(text))


class TurnMode(str, Enum):
    SAY_ONLY = "say_only"
    INTENT = "intent"
    LLM_REPLY = "llm_reply"
    EXIT = "exit"


@dataclass(frozen=True)
class LearnerIntent:
    """What the model must voice this turn (R1-Q).

    ``brief`` is a plain-language goal written by the worker (never candidate text);
    ``must_say`` are figures that must be written exactly; ``markers`` are all-of groups of
    any-of regexes that prove the move was raised (``r1_scheduler.markers_match``);
    ``fallbacks`` are the scripted variants to append, in the order to try them, if the
    reply misses the markers, and ``fallback`` is the first of them.
    """

    kind: str
    brief: str
    must_say: tuple[str, ...]
    markers: tuple[tuple[str, ...], ...]
    fallback: str
    fallbacks: tuple[str, ...] = ()
    forced: bool = False


@dataclass(frozen=True)
class TurnPlan:
    """What the learner does on one candidate turn (see the module docstring)."""

    turn: int
    mode: TurnMode
    reasons: tuple[str, ...]
    scripted_text: str
    move_id: str | None
    commitment_level: Level | None
    resolves_commitment: bool
    reminder: str | None
    guard_ctx: GuardContext
    voice: str = "learner"
    aside: bool = False
    character_break: str | None = None
    intent: LearnerIntent | None = None
    # R1-Q: the negotiation spec an INTENT plan voices (a stall reason, the e-mail yes ...), if any.
    negotiation_id: str | None = None
    # The scripted interviewer line an aside speaks (L-ASIDE-COACH or L-ASIDE-END).
    line_id: str | None = None
    # Voice barge-in: an owed move this plan does not voice but may complete.  The advisor cut the
    # learner off while she was raising it and she is told to finish (or repeat) her point: when the
    # played text proves the move it counts as delivered then (``record_spoken``), never twice.
    credit_move_id: str | None = None

    @property
    def needs_llm(self) -> bool:
        return self.mode in (TurnMode.INTENT, TurnMode.LLM_REPLY)

    @property
    def exit_roleplay(self) -> bool:
        return self.mode is TurnMode.EXIT


@dataclass(frozen=True)
class Speech:
    """The text to hand to ``session.say``, and how it was built.

    ``model_text`` is what survived the guard of the model's reply, ``tail_text`` the scripted
    line or variant appended after it (an intent's fallback), ``guard`` the guard result.
    """

    text: str
    model_text: str
    tail_text: str
    guard: GuardResult | None
    voice: str = "learner"


class RolePlayEngine:
    """Deterministic content decisions for one R1 role-play."""

    def __init__(
        self,
        persona: RenderedPersona,
        *,
        candidate_first_name: str = "",
        seed: str = "",
        keep_excerpts: bool = False,
    ) -> None:
        self.persona = persona
        self.keep_excerpts = keep_excerpts
        self.candidate_first_name = candidate_first_name
        self.seed = seed or "r1"
        self.scheduler = OwedMoveScheduler(persona.decision_maker)
        self.tracker = CoverageTracker(persona, seed=self.seed)
        self.ledger = GuardLedger()
        self.turn = 0
        self.last_r = 0.0
        self._advisor_amounts: set[int] = set()
        # The word count of every planned turn (the substantive-turn count, the thin-advisor
        # evidence and the turn count), and of the turns that are not acknowledgement-only
        # (``plan_turn(backchannel=...)``), which the speech-to-text sanity check reads: a lone
        # "Okay." or "Yeah, go on." is a whole turn the candidate meant, not a long answer that
        # speech-to-text chopped into fragments.  Voice barge-in (min_words 0) commits each such
        # acknowledgement as its own turn, where the SDK used to bank it into the next one (owner
        # test 1eb18cd4: 7 of its 8 short role-play turns were acknowledgements, 21% short, and
        # ``stt_sanity`` failed a normal session).
        self._word_counts: list[int] = []
        self._stt_word_counts: list[int] = []
        self._turn_map: dict[int, int] = {}
        self._longest_turn_sec = 0.0
        self._asks: list[dict[str, Any]] = []
        self._stalls = 0
        self._commitment_level: Level | None = None
        self._commitment_turn: int | None = None
        self._violations = 0
        self._ai_questions = 0
        self._asides: list[dict[str, Any]] = []
        self._coach_played = False
        self._break_kind: str | None = None
        self._learner_control = control_prose(learner_prefix(persona))
        self._interviewer_control = control_prose(interviewer_prefix())
        self.exit_requested = False
        # Repetition control: every learner sentence actually played, so the guard can drop
        # a sentence the learner already said; and how often a rotating line was used.
        self._spoken = SpokenMemory()
        self._fallbacks = 0
        self._fillers = 0
        # Intent-voiced moves: how often each move was handed to the model and how often its
        # scripted fallback had to be appended (counts only; logged, not posted).
        self._intent_uses: dict[str, int] = {}
        self._intent_fallbacks: dict[str, int] = {}
        # Curiosity: the topics already asked (or answered by the advisor) and the free replies
        # since the last one was suggested.
        self._curiosity_asked: set[str] = set()
        self._free_replies = 0
        self._free_at_last_curiosity = 0
        # Negotiation (R1-Q): what is on the table, the stall reasons used and the commitment
        # on record.  ``_notes`` are this turn's situation notes for the reminder, and
        # ``_new_offer_usd`` the price an advisor turn added (the only "pleasant surprise" turn).
        self.negotiation = Negotiation(persona.decision_maker)
        self._notes: list[str] = []
        self._price_notes: list[str] = []
        self._new_offer_usd: int | None = None
        self._force_curiosity = False
        # R1-Q iteration 1.  How the learner's replies opened and which tic words they held
        # (the style rules vary the next reply), the ask that could not be answered before the
        # close window (a farewell inside the window answers it), and whether the advisor only
        # said they would check on the price (nothing granted: no thanks for a discount).
        self._styles: list[tuple[str, tuple[str, ...]]] = []
        self._pending_ask: AskKind | None = None
        self._nothing_granted = False
        # R1-Q iteration 2.  Whether each reply held a question and how often each tracked phrase
        # tic was used (the guard's question diet and phrase quotas); the hours-a-week figures the
        # advisor gave (the learner may repeat them); what the advisor already answered; the moves
        # held back once for a dig; the call ask of the current turn; the price talk of the turn;
        # and whether the learner turned a proposed call down.
        self._asked: list[bool] = []
        self._phrases: dict[str, int] = {}
        self._advisor_hours: set[float] = set()
        self._answered: list[str] = []
        self._dig_deferred: set[str] = set()
        self._call_ask_now = False
        self._price_talk = False
        self._declined_calls = 0
        self._organic_pushes: list[str] = []
        # R1-Q iteration 3.  Whether the advisor's turn put a LOWER price on the table (the only
        # turn a reaction may call a price better), how many advisor turns in a row said (almost)
        # nothing, whether the learner's last reply was a goodbye (it is not said twice to a
        # silent advisor), whether the advisor asked who else decides this turn, and the topics
        # of the digs that already held an owed move back.
        self._fresh_price = False
        self._hollow_run = 0
        self._last_reply_closer = False
        self._decider_asked_now = False
        self._dig_deferred_topics: set[str] = set()
        # R1-Q final review round 1.  The tracked phrases of each reply (the guard's spacing window
        # for the stall phrases).
        self._phrase_history: list[tuple[str, ...]] = []
        # Owner test 7f2a25e6.  The owed move held back by each turn on which the advisor challenged
        # the learner, in order (at most ``MAX_CHALLENGE_DEFERRALS`` per session; one move can be
        # held by two challenges in a row).
        self._challenge_deferred: list[str] = []
        # Owner test 7f2a25e6 ("can you disconnect the call?").  The one-off L-ASIDE-END question
        # (when it played) or the explicit request that needed none, whether the question is still
        # open (a fragment leaves it open), and whether the candidate confirmed the stop.  A
        # confirmed stop exits the role-play into the wrap-up exactly as a farewell exit does
        # (``exit_requested``; owner decision 2026-10-29) and changes no grade, disclosure or
        # schedule state.  From 14:00, or with a commitment on record, an end request is a
        # farewell instead and reaches only what "bye" reaches.
        self._end_aside: dict[str, Any] | None = None
        self._end_pending = False
        # Whether L-ASIDE-END is still the last line said (``end_question_open``), and the plan
        # that made it stale (a reply lost before it was heard makes it fresh again).
        self._end_question_last = False
        self._end_stale_by: TurnPlan | None = None
        self.end_confirmed = False
        # Voice barge-in (owner decision 2026-10-28).  Whether the advisor cut the learner's last
        # line off after part of it was heard, the owed move that line carried and did not
        # deliver, and the moves already held back once for a cut (at most once per move).  The
        # first two describe the last line only: the next ``plan_turn`` consumes them.
        self._learner_cut = False
        self._cut_move: str | None = None
        self._interrupt_deferred: set[str] = set()
        # The graded commitment line the candidate did not hear whole (a barge-in cut it before the
        # end, or the SDK cancelled it before any word was heard), and whether part of it WAS heard
        # (a cut): it is said again on the next turn, and only a cut line's revoice counts toward
        # ``COMMITMENT_REVOICE_LIMIT``.  And the plan whose reply was cancelled before any audio
        # (``reply_lost``), with what its planning consumed: a turn that answers nothing ("Okay.",
        # "Sorry?") gets that very plan again; any other turn is planned afresh, with the ask, the
        # next-step question, the stall counts and the close-ladder count the lost plan used up
        # given back.
        self._unheard_commitment: TurnPlan | None = None
        self._unheard_was_cut = False
        self._commitment_revoices = 0
        self._lost_plan: TurnPlan | None = None
        self._lost_undo: tuple[Any, ...] | None = None
        self._turn_undo: tuple[Any, ...] | None = None
        self._turn_ask: AskKind | None = None

    # ------------------------------------------------------------------- properties
    @property
    def commitment_resolved(self) -> bool:
        return self.scheduler.commitment_resolved

    @property
    def commitment_level(self) -> Level | None:
        return self._commitment_level

    def _commitment_cap(self) -> Level:
        """The highest commitment level a model sentence may reach.

        The stall (WEAK) until a scripted line is on record; afterwards the recorded level, so
        the learner can confirm the call it has already booked ("Great, talk to you Thursday
        then.") instead of being cut off into a guard hit that counts toward the gate.  The
        scripted lines themselves are never guarded.
        """
        on_record = self._commitment_level
        return Level.WEAK if on_record is None else max(Level.WEAK, on_record)

    def _confirming(self) -> bool:
        """A call or a start is agreed (MEDIUM or STRONG on record): the learner only confirms."""
        return self._commitment_level in (Level.MEDIUM, Level.STRONG)

    def guard_context(
        self,
        phase: str = "roleplay",
        *,
        mode: str = "reply",
        turn: int | None = None,
        reminder: str | None = None,
        quiet_empty: bool = False,
        released: Iterable[str] | None = None,
        confirm: bool = False,
        free_reply: bool = False,
    ) -> GuardContext:
        """The guard context for an LLM reply now.

        Its ``control_texts`` are the private instruction prose of the prompts in play
        (never the words the model is meant to say), for the guard's echo check.
        ``quiet_empty`` is for an intent reply: an empty result stays empty, because the
        session appends the intent's own scripted variant instead of "Sorry, what were you
        saying?".

        ``released`` (a plan's own call) is the deep needs that may be told in THIS reply, the ones
        the turn asked about: a need told earlier is not told again, and one never asked about
        is never dumped (R1-Q iteration 1).  Without it every unlocked need counts as released.
        """
        if mode != "reply":
            released_topics: frozenset[str] = frozenset()
        elif released is None:
            released_topics = self.tracker.gate.released_topics
        else:
            released_topics = frozenset(released)
        gate = self.tracker.gate
        spent = frozenset(topic for topic in H_TOPICS if gate.state(topic) is NeedState.REVEALED)
        if phase == "roleplay":
            control = (self._learner_control,)
            if reminder:
                control += (control_prose(reminder),)
        else:
            control = (self._interviewer_control,)
        return GuardContext(
            phase=phase,
            persona=self.persona,
            candidate_first_name=self.candidate_first_name,
            released_topics=released_topics,
            advisor_amounts=frozenset(self._advisor_amounts),
            mode=mode,
            commitment_cap=self._commitment_cap(),
            turn=self.turn if turn is None else turn,
            control_texts=control,
            keep_excerpts=self.keep_excerpts,
            said=self._spoken.snapshot() if phase == "roleplay" else (),
            seed=self.seed,
            variant=self._fallbacks,
            quiet_empty=quiet_empty,
            spent_topics=spent,
            nothing_granted=self._nothing_granted,
            recent_styles=tuple(self._styles[-STYLE_HISTORY:]),
            confirm=confirm,
            offer_usd=self.negotiation.best_offer_usd,
            recent_questions=tuple(self._asked[-STYLE_HISTORY:]),
            phrase_counts=tuple(sorted(self._phrases.items())),
            free_reply=free_reply,
            advisor_hours=frozenset(self._advisor_hours),
            fresh_price=self._fresh_price,
            hollow=self._hollow_run >= 1 and self._last_reply_closer,
            decider_asked=self._decider_asked_now,
            recent_phrases=tuple(self._phrase_history[-STYLE_HISTORY:]),
        )

    def filler_text(self) -> str:
        """The learner's thinking filler: a 3-variant rotation seeded by the attempt id.

        A variant whose sentences the learner already played is skipped (a slow provider makes
        the fourth filler repeat the first word for word); when all of them were played the
        filler is the short "One moment...", which can never be a repeat.
        """
        said = self._spoken.snapshot()
        text = LEARNER_FILLER_SHORT
        for step in range(len(LEARNER_FILLER_VARIANTS)):
            candidate = pick_variant(LEARNER_FILLER_VARIANTS, self.seed, self._fillers + step)
            if not _repeats(candidate, said):
                text = candidate
                break
        self._fillers += 1
        return text

    # ------------------------------------------------------------------ the decision
    def plan_turn(
        self,
        candidate_text: str,
        r_sec: float,
        *,
        turn_index: int | None = None,
        candidate_seconds: float | None = None,
        backchannel: bool = False,
        repair: bool = False,
        answers_nothing: bool = False,
        end_intent: str | None = None,
        confirmed_yes: bool = False,
    ) -> TurnPlan:
        """Decide what the learner does after this candidate turn (``_decide_plan``).

        Reviewed fix (2026-10-30): L-ASIDE-END stops being the line the candidate answers as soon
        as anything else is said after it.  A fragment ("Okay.", "Hmm.", "Sorry?") still leaves the
        question pending (``_end_pending``: end words confirm), but the learner answers it in role,
        so a plain "Yes." three lines later is said to her: it confirmed the stop, and the model
        was still told "Christy has just asked" (``end_question_open``).  Any plan but the aside
        itself and the exit makes the question stale; a reply the candidate never heard
        (``reply_lost``) makes it fresh again.
        """
        plan = self._decide_plan(
            candidate_text,
            r_sec,
            turn_index=turn_index,
            candidate_seconds=candidate_seconds,
            backchannel=backchannel,
            repair=repair,
            answers_nothing=answers_nothing,
            end_intent=end_intent,
            confirmed_yes=confirmed_yes,
        )
        if (
            self._end_question_last
            and plan.line_id != "L-ASIDE-END"
            and plan.mode is not TurnMode.EXIT
        ):
            self._end_question_last = False
            self._end_stale_by = plan
        return plan

    def _decide_plan(
        self,
        candidate_text: str,
        r_sec: float,
        *,
        turn_index: int | None = None,
        candidate_seconds: float | None = None,
        backchannel: bool = False,
        repair: bool = False,
        answers_nothing: bool = False,
        end_intent: str | None = None,
        confirmed_yes: bool = False,
    ) -> TurnPlan:
        """Decide what the learner does after this candidate turn (see module docstring).

        The worker's judgement of a short turn (``r1_session``):

        * ``backchannel``: nothing but acknowledgement ("yeah", "okay", "mm-hmm", "okay,
          continue"; ``is_acknowledgement_turn``).  When this turn cut the learner's last line off
          (``record_spoken(..., interrupted=True)``) she only finishes her point.  Such a turn is
          never counted by the speech-to-text sanity check (``fidelity``): it is not a fragment.
        * ``repair``: only a request to hear it again or a check that she is there ("Sorry?",
          "Pardon?", "Hello? Are you there?"; ``is_repair_turn``).  After a cut she says it again.
        * ``answers_nothing``: courtesy words alone (``is_backchannel_turn``).  With the two above
          it decides whether a plan whose reply was cancelled before any audio (``reply_lost``)
          is simply planned again.

        Owner decisions of 2026-10-30 (meaning-based end detection, ``r1_end_intent``):

        * ``end_intent``: the end-intent model's verdict on this turn ("end", "maybe" or "no"),
          or None when it was not asked (the prefilter missed, the lexical fast path already
          decided, the classifier is off) or gave no usable answer in time.  It can only RAISE the
          lexical reading (``r1_tracker.end_intent_level``): "end" exits before 14:00 like an
          explicit request, "maybe" gets L-ASIDE-END, and with None every plan is exactly what
          it was before.
        * ``confirmed_yes``: the session let a bare yes settle (``is_bare_yes``: "yes", "yes
          please", "haan ji", "go ahead"; nothing followed it), so it confirms the stop while
          L-ASIDE-END's question is open.  A decline still wins.
        """
        # Ship restore, a pure cost bound: every reader below is lexical and linear in the text, and
        # no real advisor turn comes near this (longest live turn 1,072 characters, the owner's
        # longest grouped turn 1,039), so the bound only shortens pathological speech-to-text.
        if isinstance(candidate_text, str) and len(candidate_text) > MAX_CANDIDATE_CHARS:
            candidate_text = candidate_text[-MAX_CANDIDATE_CHARS:]
        # Voice barge-in: whether THIS turn is the one that cut the learner's last line off, and the
        # owed move that line failed to deliver.  Consumed here, whatever the turn turns out to be.
        cut, self._learner_cut = self._learner_cut, False
        cut_move, self._cut_move = self._cut_move, None
        lone_backchannel = cut and backchannel
        repeat_request = cut and repair and not backchannel
        # A plan whose reply the SDK cancelled before any audio, and what its planning consumed.
        lost, self._lost_plan = self._lost_plan, None
        lost_undo, self._lost_undo = self._lost_undo, None
        # An out-of-role request to end the call (owner test 7f2a25e6, turns 64 and 71).  Before
        # R = 14:00 and with no commitment on record it is answered by the interviewer, never by an
        # owed move and never by the close ladder: she asks once (L-ASIDE-END: say "end the
        # interview" to stop).  End words in answer, or the request again at a later turn of that
        # stretch, confirm the stop; anything else resumes the role-play with this very turn, and a
        # backchannel or a speech-to-text fragment ("Hmm", "Okay.") leaves the question open.  A
        # first request that names the interview or the role play ("End the interview.", "Can we
        # end this role play?"; ``explicit_end_request``) and that the turn ends on is confirmed
        # at once, without the question, which would only ask the candidate to say exactly that
        # (owner test 1eb18cd4); one that says more ("Please stop the interview, I need a
        # moment.") gets the question, so a candidate who wants something else can carry on.
        # A confirmed stop ends the ROLE-PLAY, not the session (owner decision 2026-10-29): the
        # plan is the role-play exit, and L-EXIT and the interviewer's wrap-up follow, as after a
        # farewell exit.  The session completes normally and is scored only if the fidelity checks
        # pass (R reached 10:00, every family delivered ...), so asking to stop earns nothing a
        # second "bye" before 14:00 (the close ladder's exit) would not.
        #
        # From 14:00, or once a commitment is on record, the role-play has already earned its score
        # and the request is the advisor's way of saying goodbye (reviewed fix: "Okay Priya, let's
        # disconnect the call now, I'll send you the email" at 18:20, after a complete role-play,
        # ended it as a failed session, and "End the interview." right after a booked call
        # did too, where "Thank you so much, bye!" exits and is scored).  So the request, or end
        # words answering a question asked earlier, is a farewell: it gets exactly what "bye" gets
        # on the close ladder (the redirect once before 14:00, the WEAK stall in the close window,
        # otherwise the exit) and nothing more, so it stays injection-neutral.
        #
        # The lexical reading (``detect_end_request``, ``explicit_end_request``) is the floor of
        # ``end_level``; the end-intent model's verdict (``end_intent``) may raise it within the
        # rails of ``end_intent_level`` (owner decision 2026-10-30).  A first request at level
        # "end" is confirmed at once, one at "maybe" gets the question.
        end_level = end_intent_level(candidate_text, end_intent)
        lexical_level = end_intent_level(candidate_text, None)
        # Reviewed fix (2026-10-30): once the question has been asked and has closed (declined, or
        # answered by talk about the sale), a "later request" that confirms the stop at once must
        # be the candidate's own words, never a model-only "maybe": after a declined aside, "At the
        # end of the day, the course pays for itself." with a model "maybe" exited the role-play
        # with no question at all.  A model "end" still counts (``end_intent_level`` lets it
        # through only for a turn that ends on a request to stop the interview or the role play),
        # and while the question is open a model "maybe" is still an answer to it (only right
        # after it: once anything else was said, ``end_question_open`` is False; reviewed fix).
        if (
            end_level == "maybe"
            and lexical_level == "no"
            and self._end_aside is not None
            and not self.end_question_open
        ):
            end_level = lexical_level
        by_model = end_level != lexical_level
        end_request = end_level != "no"
        # Once the aside has been asked, an answer that also declines is a no whatever end words it
        # holds: "No, I don't think I want to stop", "No, why would you end the call?" (reviewed
        # fix: these ended the session).
        declined = self._end_aside is not None and declines_end(candidate_text)
        # After the question a bare yes confirms too, once the session has let it settle
        # (``confirmed_yes``; owner decision 2026-10-30): "Yes.", "Yes please.", "Haan ji.".  Only
        # as the answer to the question itself: a yes after the learner spoke again is said to her.
        end_words = (end_request and not declined) or (
            self._end_pending
            and (
                confirms_end(candidate_text)
                or (confirmed_yes and self.end_question_open and is_bare_yes(candidate_text))
            )
        )
        # "Let's cut the call now, I'll call you tomorrow": a call-back promise is the advisor
        # closing the sale's call in role, so it is a farewell, never the out-of-role stop (reviewed
        # fix: after a declined aside it ended the session).
        out_of_role = (
            r_sec < EARLY_CLOSE_BEFORE_SEC
            and not self.commitment_resolved
            and not promises_call_back(candidate_text)
        )
        if out_of_role and self._end_aside is not None and end_words:
            return self._end_plan(turn_index, r_sec=r_sec, by_model=by_model)
        farewell_end = end_words and not out_of_role
        if self._end_pending and (
            farewell_end
            or word_count(candidate_text) > END_FRAGMENT_WORDS
            or declines_end(candidate_text)
        ):
            self._end_pending = False
        if end_request and self._end_aside is None and out_of_role:
            # The aside is no answer to the lost plan either: what that plan used up is given back.
            self._restore_lost(lost_undo)
            if end_level == "end":
                return self._end_plan(turn_index, r_sec=r_sec, by_model=by_model)
            return self._end_aside_plan(r_sec, turn_index, by_model=by_model)
        break_kind = detect_character_break(candidate_text)
        if lost is not None:
            if (
                (backchannel or repair or answers_nothing)
                and not farewell_end
                and break_kind is None
                and not is_close_attempt(candidate_text, r_sec)
            ):
                # Voice barge-in (min_words 0): a lone "Okay.", "Sorry" or "Hello?" in the think gap
                # cancelled the reply before the candidate heard any of it.  That turn answers
                # nothing, so the lost plan is the answer still owed: the very same plan (its turn,
                # its ask, its commitment line) is voiced now.  A commitment line the candidate
                # never heard is no revoice: the replay spends nothing of the revoice limit.
                if self._unheard_commitment is lost:
                    self._unheard_commitment = None
                return replace(lost, reasons=lost.reasons + ("replanned_after_lost_reply",))
            self._restore_lost(lost_undo)
        if self._wants_aside(break_kind):
            return self._aside_plan(break_kind or "ai", r_sec, turn_index)
        if break_kind == "ai":
            self._ai_questions += 1
        self._turn_undo = (
            self._pending_ask,
            self.negotiation.question_used,
            self.negotiation.stall_rounds,
            self._stalls,
            self.scheduler.close_attempts,
        )
        self.turn += 1
        turn = self.turn
        self.last_r = r_sec
        self._notes = []
        self._price_notes = []
        self._nothing_granted = False
        self._force_curiosity = False
        if turn_index is not None:
            self._turn_map[turn] = turn_index
        if candidate_seconds is not None:
            self._longest_turn_sec = max(self._longest_turn_sec, candidate_seconds)
        words = word_count(candidate_text)
        self._word_counts.append(words)
        if not backchannel:
            self._stt_word_counts.append(words)
        self._hollow_run = self._hollow_run + 1 if is_hollow_turn(candidate_text) else 0
        self._decider_asked_now = False
        signals = self.scheduler.observe_candidate_turn(candidate_text, r_sec)
        obs = self.tracker.observe_candidate_turn(candidate_text, turn)
        self._advisor_amounts.update(advisor_amounts_in(candidate_text))
        self._advisor_hours.update(hours_said(candidate_text))
        self._price_talk = quotes_price(candidate_text)
        for topic in answered_topics(candidate_text):
            if topic not in self._answered:
                self._answered.append(topic)
        negotiated = self._observe_negotiation(candidate_text, turn)
        self._note_situation(negotiated)
        self._note_curiosity_covered(candidate_text)
        # Nothing in the very first advisor turn is an ask: it is the greeting ("is now a good
        # time?", "I thought I'd give you a quick call"), and it gets a free reply.
        early = turn == 1 and r_sec < EARLY_ASK_IGNORE_SEC
        ask = None if early else detect_ask(candidate_text)
        wants = ask.kind if ask is not None else None
        if wants is None and negotiated.callback is not None and not early:
            wants = AskKind.CALL  # a concrete callback or time proposal is a call ask
        self._call_ask_now = wants is AskKind.CALL
        self._turn_ask = wants
        reasons: list[str] = []
        if obs.injection:
            reasons.append("injection_phrase_flagged")
        if break_kind:
            reasons.append(f"character_break:{break_kind}")
        self._break_kind = break_kind
        decision = None
        if farewell_end:
            reasons.append("end_request_as_farewell")
            if by_model:
                reasons.append("end_intent_model")
        if self._unheard_commitment is not None:
            revoiced = self._revoice_commitment(r_sec, reasons)
            if revoiced is not None:
                return revoiced
        if signals.close_attempt or farewell_end:
            decision = self.scheduler.register_close_attempt(r_sec)
            if decision.action == "exit":
                self.exit_requested = True
                reasons.append("close_attempt_exit")
                return self._plan(TurnMode.EXIT, reasons)
        # Disclosure is tied to the turn that asks about the topic: a first probe is answered
        # with the HINT layer and a follow-up (or a repeat probe of a released need) with the
        # DEEP layer, in that very reply.  An owed move that is not forced waits one turn.
        reveal_topics = self.tracker.gate.deep_due(obs.gate)
        if wants is not None or negotiated.email_offer or negotiated.checkin:
            planned = self._negotiate(
                negotiated,
                wants,
                r_sec,
                reasons,
                first_probes=obs.gate.first_probes,
                reveal_topics=reveal_topics,
                monologue=candidate_seconds,
            )
            if planned is not None:
                return planned
        if decision is not None and decision.move is not None:
            move = decision.move
            self.scheduler.issue(move)
            if decision.action == "redirect":
                # Ship restore: production's scripted redirect, "Oh wait, before you go..." and the
                # owed line (a model-voiced redirect said its goodbye and then the opener).
                reasons.append("close_attempt_redirect")
                text = f"{decision.prefix} {move.text}"
                return self._plan(TurnMode.SAY_ONLY, reasons, scripted=text, move_id=move.id)
            reasons.append("close_attempt_stall")
            return self._plan(
                TurnMode.SAY_ONLY,
                reasons,
                scripted=self._weak_text(move.text),
                move_id=move.id,
                level=Level.WEAK,
                resolves=True,
            )
        reveal_due = bool(obs.gate.first_probes) or bool(reveal_topics)
        challenged = False
        held_for_cut = False
        move = self.scheduler.select(r_sec)
        if move is not None:
            if reveal_due and self._may_defer(move, r_sec):
                reasons.append("owed_deferred_for_reveal")
            elif (
                move.id in (F1_ANCHOR, F1_COUNTER)
                and wants is not None
                and self._may_defer(move, r_sec)
            ):
                # The advisor proposed a call or a time: that is answered first, and the price
                # reaction waits one turn unless its deadline forces it (R1-Q final review round 1:
                # "That's even below the $7,000 ..." answered "Does seven tomorrow work?").
                reasons.append("owed_deferred_for_ask")
            elif (
                (lone_backchannel or repeat_request)
                and not (repeat_request and move.id == cut_move)
                and self._may_defer(move, r_sec)
            ):
                # Voice barge-in (owner decision 2026-10-28).  A lone "yeah" that cut the learner
                # off raises no move: she finishes her point, and when that point was the owed move
                # her continuation completes it (``credit_move_id``).  A "Sorry?" or a "Pardon?"
                # gets what she was saying said again and no other move (when her cut line WAS the
                # owed move, the move itself is that repeat, below).  Neither spends the move's one
                # interrupt deferral, which is for a real answer over her line; however often it
                # happens, a deadline still forces the move (``_may_defer``).
                held_for_cut = True
                reasons.append(
                    "owed_deferred_for_backchannel"
                    if lone_backchannel
                    else "owed_deferred_for_repeat"
                )
            elif not repeat_request and move.id == cut_move and self._may_hold_for_cut(move, r_sec):
                # The advisor said something real over the learner's line: the move it carried is
                # not started again on the very next turn, she answers what they said first.  The
                # move waits ONE turn, once per move and only while the plan has a turn to spare
                # (``_may_hold``), and a deadline still forces it.
                self._interrupt_deferred.add(move.id)
                held_for_cut = True
                reasons.append("owed_deferred_for_interrupt")
            elif challenges_learner(candidate_text) and self._may_hold_for_challenge(move, r_sec):
                # The advisor pushed back on the learner's own words or on how it asks (owner test
                # 7f2a25e6: "where did you get that number?" got a one-line answer and the F2 push).
                # That is answered first and the owed move waits ONE turn; twice per session and
                # only while the plan has a turn to spare (``_may_hold``), so a combative advisor
                # cannot hold the plan back, and a deadline still forces it.  Two challenges in a
                # row hold the same move twice (reviewed fix: the owner's 56 and 58 were both
                # challenges, and under a once-per-move rule 58 got the F4 primary on top of "you
                # are asking too many questions").
                self._challenge_deferred.append(move.id)
                challenged = True
                self._notes.append(CHALLENGE_NOTE)
                reasons.append("owed_deferred_for_challenge")
            elif (
                move.id not in self._dig_deferred
                and self._dig_key(candidate_text) not in self._dig_deferred_topics
                and asks_about_learner(candidate_text)
                and self._may_defer(move, r_sec)
            ):
                # The advisor asked the learner a direct question about themselves (a dig the
                # probe rules did not catch: "is he more of a sounding board, or does he need to be
                # convinced?"): that question is answered first, the owed move waits ONE turn
                # (R1-Q iteration 2: F1-ANCHOR and F3-PRIMARY answered a question about the husband
                # and the father).  A deadline still forces it, so the gate's slip limit holds.  One
                # deferral per topic of dig (iteration 3): a run of digs on the same topic would
                # otherwise hold every owed move back in turn.
                self._dig_deferred.add(move.id)
                self._dig_deferred_topics.add(self._dig_key(candidate_text))
                reasons.append("owed_deferred_for_dig")
            else:
                self.scheduler.issue(move)
                reasons.append(f"owed:{move.id}" + (":forced" if move.forced else ""))
                if repeat_request and move.id == cut_move:
                    reasons.append("repeat_after_cut")  # her cut line again: the repeat asked for
                if move.id == COMMIT_STALL:
                    # The 19:00 stall: a short reaction, then the scripted WEAK line, spoken
                    # and masked exactly, and never a second time (``Negotiation``).
                    stall = self._commit_stall_plan(
                        move,
                        reasons,
                        first_probes=obs.gate.first_probes,
                        reveal_topics=reveal_topics,
                        monologue=candidate_seconds,
                    )
                    if stall is not None:
                        return stall
                else:
                    return self._intent_plan(
                        move,
                        reasons,
                        redirect=False,
                        first_probes=obs.gate.first_probes,
                        reveal_topics=reveal_topics,
                        monologue=candidate_seconds,
                    )
        if lone_backchannel or repeat_request:
            # "Yeah" said over the learner cut her off: she finishes her point in one sentence and
            # raises nothing new (no owed move above unless forced, no curiosity, no check-in).  A
            # "Sorry?" gets her point said again.  Either way the move her cut line carried counts
            # as delivered if what she says now proves it (``credit_move_id``).
            reasons.append("backchannel_continuation" if lone_backchannel else "repeat_after_cut")
            self._notes.append(BACKCHANNEL_CUT_NOTE if lone_backchannel else CUT_REPEAT_NOTE)
            return self._plan(
                TurnMode.LLM_REPLY,
                reasons,
                first_probes=obs.gate.first_probes,
                reveal_topics=reveal_topics,
                monologue=candidate_seconds,
                credit_move_id=cut_move,
            )
        reasons.append("free_reply")
        if cut:
            # The advisor cut in: what they said is answered, the cut line is not started again.
            self._notes.append(INTERRUPTED_NOTE)
        curiosity = ""
        # A challenge is only answered (``CHALLENGE_NOTE``): no curiosity question, no check-in.
        # Neither is the turn that cut the learner off while she was raising an owed move.
        quiet = reveal_due or break_kind is not None or challenged or held_for_cut
        if self._force_curiosity and not quiet:
            # The advisor checked in ("what do you think?", "anything else?"): an honest
            # reaction and one real question, never the stall.
            curiosity = self._curiosity_for_free_reply(force=True)
            self._notes.append(CHECKIN_NOTE if curiosity else CHECKIN_DONE_NOTE)
        elif not quiet:
            curiosity = self._curiosity_for_free_reply()
        return self._plan(
            TurnMode.LLM_REPLY,
            reasons,
            first_probes=obs.gate.first_probes,
            reveal_topics=reveal_topics,
            monologue=candidate_seconds,
            curiosity=curiosity,
        )

    def _revoice_commitment(self, r_sec: float, reasons: list[str]) -> TurnPlan | None:
        """The graded commitment line the candidate did not hear whole, said again, or None.

        Voice barge-in: a "Great." over "Okay, let's do it. Send me the ..." cut the line before
        its end, or an "Okay." cancelled it before any audio.  The learner earned it and was saying
        it, so the same scripted line (same level, same slot) is said again on this turn, whatever
        the advisor said over it, instead of the commitment being lost to a free reply that may
        only stall.  Not once the commitment is on record, and a forced owed move (other than the
        19:00 stall the line resolves) is spoken first: the line then waits for the following turn.

        Only a line that was played and then cut counts toward ``COMMITMENT_REVOICE_LIMIT`` (and
        only it is stopped by the limit): a line the candidate never heard a word of
        (``reply_lost``) was never said, so saying it now is its first hearing, not a revoice
        (reviewed fix: two lost replays used the limit up, so the first real cut dropped the
        commitment).
        """
        unheard = self._unheard_commitment
        counts = self._unheard_was_cut
        if self.commitment_resolved or (
            counts and self._commitment_revoices >= COMMITMENT_REVOICE_LIMIT
        ):
            self._unheard_commitment = None
            return None
        owed = self.scheduler.select(r_sec)
        if (
            owed is not None
            and owed.forced
            and owed.id != COMMIT_STALL
            and owed.id != unheard.move_id
        ):
            return None
        self._unheard_commitment = None
        if counts:
            self._commitment_revoices += 1
        reasons.append("commitment_revoiced")
        return self._plan(
            TurnMode.SAY_ONLY,
            reasons,
            scripted=unheard.scripted_text,
            move_id=unheard.move_id,
            level=unheard.commitment_level,
            resolves=True,
        )

    def _restore_lost(self, undo: tuple[Any, ...] | None) -> None:
        """Give back what the plan of a reply cancelled before any audio used up when planned.

        Nothing of it was heard: the advisor's ask is still open (that turn's ask, else the one
        open before it), and the next-step question, the stall rounds inside the close window, the
        count of stalls before it and the farewells on the close ladder are as they were before
        that turn.  The last matters for a farewell that speech-to-text split in two ("... have a
        great day." and "Bye."): the "Bye." cancelled the redirect before any audio, and counting
        that unheard redirect made the "Bye." the second farewell, so the role-play exited before
        14:00 without the candidate ever hearing "Oh wait, before you go..." (reviewed fix).  Now
        the "Bye." is the first farewell again and gets the redirect.
        """
        if undo is None:
            return
        pending, question_used, stall_rounds, stalls, close_attempts, ask = undo
        self._pending_ask = ask if ask is not None else pending
        self.negotiation.question_used = question_used
        self.negotiation.stall_rounds = stall_rounds
        self._stalls = stalls
        self.scheduler.close_attempts = close_attempts

    def reply_lost(self, plan: TurnPlan) -> None:
        """The SDK cancelled ``plan``'s reply before the candidate heard any of it.

        At ``min_words`` 0 an "Okay.", a "Sorry" or a "Hello?" in the one or two seconds the reply
        is being thought of is a turn of its own, and it cancels the reply (the session's
        ``r1_reply_cancelled_before_audio``).  Nothing was heard, so nothing is recorded; the next
        ``plan_turn`` either plans this very plan again (a turn that answers nothing) or plans
        afresh with what this plan used up given back.  A graded commitment line is said again
        either way, and since the candidate heard none of it that is no revoice (it spends nothing
        of ``COMMITMENT_REVOICE_LIMIT``).  The session also reports a reply cut after its first
        audio frame but before any word was heard: that too is a line nobody heard.  Only the
        latest plan counts: a newer turn was already planned otherwise.

        The line that made L-ASIDE-END's question stale was never heard either, so the question is
        the last line said again (``end_question_open``).
        """
        if plan is self._end_stale_by:
            self._end_stale_by = None
            self._end_question_last = self._end_pending
        if plan.aside or plan.mode is TurnMode.EXIT or plan.turn != self.turn:
            return
        self._lost_plan = plan
        self._lost_undo = None if self._turn_undo is None else (*self._turn_undo, self._turn_ask)
        if (
            plan.resolves_commitment
            and plan.commitment_level is not None
            and plan.scripted_text
            and not self.commitment_resolved
        ):
            self._unheard_commitment = plan
            self._unheard_was_cut = False

    @staticmethod
    def _dig_key(candidate_text: str) -> str:
        """The topic of a dig: the needs the question probes, else ``other`` (a third party)."""
        topics = sorted(detect_probes(candidate_text))
        return ",".join(topics) if topics else "other"

    @staticmethod
    def _may_defer(move: Any, r_sec: float) -> bool:
        """Whether a reveal turn may hold ``move`` back for one turn.

        A forced move (its deadline is near) never waits, so the gate's slip limit holds.
        The time cue and the COMMIT-STALL wait too (R1-Q: at turn 79 the cue landed on top of
        a due reveal), except that the stall is the end-game backstop: past
        ``STALL_DEFER_GRACE_SEC`` it is spoken even on a reveal turn, because the role-play
        hard-ends at 20:00.
        """
        if move.forced:
            return False
        past_grace = r_sec >= COMMIT_STALL_R_SEC + STALL_DEFER_GRACE_SEC
        return not (move.id == COMMIT_STALL and past_grace)

    def _may_hold_for_cut(self, move: OwedMove, r_sec: float) -> bool:
        """Whether the owed move a cut line carried may wait one turn (``..._for_interrupt``).

        Once per move, and only while the plan has slack (``_may_hold``).
        """
        return move.id not in self._interrupt_deferred and self._may_hold(move, r_sec)

    def _may_hold_for_challenge(self, move: OwedMove, r_sec: float) -> bool:
        """Whether the owed move may wait one turn for a challenge (``..._for_challenge``).

        Twice per session (two challenges in a row may hold the same move), and only while the plan
        has slack (``_may_hold``).
        """
        return len(self._challenge_deferred) < MAX_CHALLENGE_DEFERRALS and self._may_hold(
            move, r_sec
        )

    def _may_hold(self, move: OwedMove, r_sec: float) -> bool:
        """Whether a cut or a challenge may hold ``move`` back one turn (reviewed fix m4).

        Both holds came with voice barge-in and owner test 7f2a25e6 (before them a cut objection was
        raised again on the very next turn, and a challenge held nothing back).  Stacked with each
        other and with spacing they pushed the later families into forced runs the release before
        them never had: a candidate who cut every objection and challenged the learner every third
        turn got F1 and F4 forced at 35 s an exchange and the time cue never said, and one who cut
        at 65 s lost the F4 push (a missing family, so no score).  So a hold needs:

        * a move that is not forced (``_may_defer``): the deadlines and the forced path are
          unchanged;
        * a move with a deadline: the time cue and the 19:00 stall have no forced path to fall
          back on, so a hold can push the cue out of its 17:00-19:00 window; they are raised again
          at once;
        * slack in the plan (``_ahead_of_pacing``).

        Without them the move is raised again at once, as before the holds (the model still reacts
        to what the advisor said first, and the scripted variants rotate, so it is not word for
        word).
        """
        return (
            move.deadline_sec is not None
            and self._may_defer(move, r_sec)
            and self._ahead_of_pacing(r_sec)
        )

    def _ahead_of_pacing(self, r_sec: float) -> bool:
        """Whether one more turn now still lets every open family land by its deadline.

        At the current pace (the scheduler's expected turn length), the objections still owed up
        to and including each family are given ``SLACK_TURNS_PER_MOVE`` turns each, after the one
        turn the hold costs; every family that is not finished must still make its deadline.  At
        the owner's pace (20-25 s an exchange) there is slack and a cut objection waits; at 35 s
        and slower the plan has no turn to spare until most of it is delivered.
        """
        pace = self.scheduler.lookahead_sec
        owed = 0
        for deadline, move_ids in _PACING_MAP:
            left = sum(1 for move_id in move_ids if not self.scheduler.is_delivered(move_id))
            owed += left
            if left and r_sec + pace * (1 + SLACK_TURNS_PER_MOVE * owed) > deadline:
                return False
        return True

    def _wants_aside(self, break_kind: str | None) -> bool:
        """The one-off aside: a coaching request, or the second "are you an AI?" question."""
        if break_kind is None or self._coach_played or len(self._asides) >= MAX_ASIDES:
            return False
        return break_kind == "coach" or self._ai_questions >= 1

    def _aside_plan(self, kind: str, r_sec: float, turn_index: int | None) -> TurnPlan:
        """L-ASIDE-COACH, spoken by the interviewer; the turn is excluded from evidence.

        The candidate's words are not observed by the scheduler or the tracker, the
        role-play clock is the session's to pause, and nothing in the schedule moves.
        """
        self._coach_played = True
        self._asides.append(
            {"kind": kind, "after_roleplay_turn": self.turn, "transcript_turn": turn_index}
        )
        self._break_kind = kind
        return self._plan(
            TurnMode.SAY_ONLY,
            ["aside_coach", f"character_break:{kind}"],
            scripted=script_line("L-ASIDE-COACH", **self.persona.line_values),
            voice="interviewer",
            aside=True,
            line_id="L-ASIDE-COACH",
        )

    def _end_aside_plan(
        self, r_sec: float, turn_index: int | None, *, by_model: bool = False
    ) -> TurnPlan:
        """L-ASIDE-END, once: say "end the interview" to stop, otherwise carry on.

        Like the coach aside it is excluded from evidence (nothing observes the candidate's
        words, no owed move is issued, the schedule does not move) and the session pauses R.
        It is asked only before R = 14:00 with no commitment on record, and not for a request that
        names the interview or the role play (that one is confirmed at once, ``_end_plan``).  The
        next candidate turn that is more than a fragment answers it (``_end_pending``); only end
        words confirm (``confirms_end``), and so does a later end request, while R < 14:00 and no
        commitment is on record.  After that both are farewells (the close ladder, see
        ``plan_turn``).  ``by_model``: the end-intent model, not the lexical detector, heard the
        request (reason ``end_intent_model``).
        """
        self._end_aside = {
            "after_roleplay_turn": self.turn,
            "transcript_turn": turn_index,
            "r_sec": round(r_sec, 1),
            "question_asked": True,
            "confirmed": False,
        }
        self._end_pending = True
        self._end_question_last = True
        return self._plan(
            TurnMode.SAY_ONLY,
            ["aside_end_request"] + (["end_intent_model"] if by_model else []),
            scripted=script_line("L-ASIDE-END", **self.persona.line_values),
            voice="interviewer",
            aside=True,
            line_id="L-ASIDE-END",
        )

    def end_question_lapsed(self) -> None:
        """The candidate said nothing after L-ASIDE-END: the silence ladder's prompt comes next.

        Silence is handled as it always was, so an answer to "Are you still there?" is not an
        answer to L-ASIDE-END: the question is no longer pending (a later end request still ends).
        """
        self._end_pending = False
        self._end_question_last = False

    @property
    def end_question_open(self) -> bool:
        """True while L-ASIDE-END's question waits for its answer and is the last line said.

        Only then may a bare yes confirm (``confirmed_yes``), a model "maybe" answer it, and the
        end-intent model be told the question was just asked.  A fragment leaves the question
        pending, but once the learner answers it in role (``plan_turn``) the next turn is said to
        her, not to the interviewer (reviewed fix: "Okay.", her reply, then "Yes." ended the
        role-play).
        """
        return self._end_pending and self._end_question_last

    def _end_plan(
        self, turn_index: int | None, *, r_sec: float, by_model: bool = False
    ) -> TurnPlan:
        """The candidate confirmed the stop: the role-play exits into the interviewer's wrap-up.

        Owner decision 2026-10-29 ("the role play should end and the finishing part of Christy the
        interviewer should come in"; "score it if checks pass").  The plan is the role-play exit
        (``exit_requested``, as the close ladder's exit sets it), so the session says L-EXIT and
        runs the wrap-up and the ordinary completion; the fidelity checks then decide whether the
        early end is scored (R reached 10:00, every family delivered and the rest), so at 5:00 it
        never is.  No new outcome and no new path: a second "bye" before 14:00 reaches this exit
        too.  The turn is excluded from evidence (the scheduler, the tracker and the word counts
        never see it; the session writes its row as ``aside``, so the API gate's speech-to-text
        check leaves it out as well) and changes no commitment, disclosure or schedule state.  A
        FIRST request that names the interview or the role play, and that the turn ends on, gets
        here with no question asked: it is then recorded with ``question_asked`` false and the
        reason ``end_request_explicit``.  So does one the end-intent model judged "end" and that
        names the interview or the role play (owner decision 2026-10-30; reason
        ``end_intent_model`` as well, which also marks a confirmation only the model heard).
        """
        reasons = ["end_confirmed"] + (["end_intent_model"] if by_model else [])
        if self._end_aside is None:
            reasons.insert(0, "end_request_explicit")
            self._end_aside = {
                "after_roleplay_turn": self.turn,
                "transcript_turn": turn_index,
                "r_sec": round(r_sec, 1),
                "question_asked": False,
                "confirmed": False,
            }
        self._end_aside["confirmed"] = True
        self._end_aside["answer_transcript_turn"] = turn_index
        self._end_pending = False
        self._end_question_last = False
        self.end_confirmed = True
        self.exit_requested = True
        return self._plan(TurnMode.EXIT, reasons)

    # ----------------------------------------------------------------- negotiation
    def _observe_negotiation(self, candidate_text: str, turn: int) -> NegotiationTurn:
        """Let the negotiation read this advisor turn (offers, callbacks, e-mail, check-ins)."""
        anchor = self.scheduler.deliveries_by_id().get(F1_ANCHOR)
        seen = self.negotiation.observe(
            turn, candidate_text, anchor_turn=None if anchor is None else anchor.turn
        )
        if seen.price_answer:
            self.scheduler.note_price_answered()
        for offer in seen.offers:
            self._advisor_amounts.add(offer.net_usd)  # the learner may name a price it heard
        # A price that is not LOWER than the best on the table is no news (R1-Q iteration 3: the
        # $8,000 instalment option, offered after $7,500, was "a little better than I expected").
        self._new_offer_usd = seen.lower_offer_usd
        self._fresh_price = seen.lower_offer_usd is not None
        return seen

    def _note_situation(self, seen: NegotiationTurn) -> None:
        """Worker notes for what this advisor turn did that the learner must not misread.

        Who else decides is always the persona's decision maker (a model answered "it's just me
        deciding" and, two minutes later, "I'd want to talk to my husband first"); the $7,000 is the
        learner's own number until the advisor plainly offers it (a model said "Oh, $7,000, that's
        better than I expected" after raising it itself); and "I can check with my manager" grants
        nothing (the judge flagged the thanks that followed it).
        """
        if seen.decider_asked:
            self._decider_asked_now = True
            self._notes.append(DECIDER_ASKED_NOTE.format(answer=self.persona.decider_answer))
        best = self.negotiation.best_offer_usd
        if seen.anchor_mentioned and (best is None or best > ANCHOR_USD):
            self._notes.append(ANCHOR_NOT_OFFERED_NOTE)
        if seen.tentative:
            self._notes.append(TRY_NOT_GRANTED_NOTE)
            self._nothing_granted = True
        # Where the price stands, whenever it comes up (the live sweep: "that's the number I was
        # hoping for" at $6,000 and, one turn later, "still a stretch for me"; "that's better than
        # before" at an unchanged $7,500).  The anchor and the counter carry the price in their own
        # brief, and the wrap turn names it in the offer note, so they skip these.
        if best is not None and self._price_talk:
            if best <= ANCHOR_USD:
                self._price_notes.append(PRICE_MET_NOTE.format(amount=format_usd(best)))
            elif seen.lower_offer_usd is None:
                self._price_notes.append(PRICE_UNCHANGED_NOTE.format(amount=format_usd(best)))

    def _standing_notes(
        self,
        *,
        mode: TurnMode,
        move_id: str | None,
        price_wrap: bool,
        intent: LearnerIntent | None,
    ) -> tuple[str, ...]:
        """Worker notes that hold on every reply of a situation, not only the turn that began it.

        * a proposed call that was not accepted yet stays unaccepted until the close window opens
          (the live sweep: "Since you asked, yes, let's talk tomorrow" two turns after the ask);
        * what the advisor already answered is not asked again (a free reply only);
        * a tracked phrase tic already used ("a stretch", "what would that call involve") is not
          used again;
        * where the price stands, unless the turn carries the price in its own brief.
        """
        notes: list[str] = []
        if (
            self._pending_ask is not None
            and not (self.negotiation.resolved or self.commitment_resolved)
            and not self.scheduler.commit_permitted(self.last_r)
        ):
            notes.append(HOLD_NOTE)
        if mode is TurnMode.LLM_REPLY and self._answered:
            labels = dict(ANSWERED_LABELS)
            topics = "; ".join(labels[topic] for topic in self._answered if topic in labels)
            if topics:
                notes.append(ANSWERED_NOTE.format(topics=topics))
        if mode is TurnMode.LLM_REPLY and self._hollow_run >= 1 and self._last_reply_closer:
            notes.append(HOLLOW_NOTE)
        if self._phrases.get(PHRASE_STRETCH, 0) >= 1:
            notes.append(STRETCH_USED_NOTE)
        if self._phrases.get(PHRASE_TEMPLATE_Q, 0) >= 1:
            notes.append(TEMPLATE_USED_NOTE)
        if not price_wrap and move_id not in (F1_ANCHOR, F1_COUNTER):
            notes.extend(self._price_notes)
        return tuple(notes)

    def _evidence(self, kind: AskKind) -> CommitmentEvidence:
        """The commitment evidence, with the stall reasons the advisor handled added."""
        words = self._word_counts
        thin = len(words) >= THIN_MIN_TURNS and sum(words) / len(words) < THIN_ADVISOR_MEAN_WORDS
        return replace(
            self.tracker.commitment_evidence(kind),
            reasons_handled=self.negotiation.reasons_handled_count,
            thin=thin,
        )

    def _negotiate(
        self,
        seen: NegotiationTurn,
        wants: AskKind | None,
        r_sec: float,
        reasons: list[str],
        *,
        first_probes: tuple[str, ...],
        reveal_topics: tuple[str, ...],
        monologue: float | None,
    ) -> TurnPlan | None:
        """The learner's answer to an ask, a callback, an e-mail offer or a check-in.

        None means "carry on with the normal path" (an owed move, or a free reply), possibly with
        a situation note added for the reminder.  The responses are the table of R1-Q 4.4:

        * a commitment is already on record: never repeat it, react in a free reply;
        * an ask before the close window: the owed F4 move if it can land now (or any forced
          move), else the next unused stall reason, else one question about the call;
        * an ask inside the window: the graded scripted line (STRONG, MEDIUM with the slot),
          or, when the grade is WEAK and a reason is left (at most two rounds), that reason;
          with none left, the scripted WEAK resolution line;
        * an e-mail offer: yes, and what will it include (once); a check-in: an honest reaction
          and one real question, never the stall.
        """
        negotiation = self.negotiation
        layers = {
            "first_probes": first_probes,
            "reveal_topics": reveal_topics,
            "monologue": monologue,
        }
        if wants is not None:
            self._asks.append({"turn": self.turn, "kind": wants.value})
            # A call or enrolment ask is answered with a stall reason, a question or the commitment
            # line, not with a need (R1-Q final review round 1: the H3 deep layer was told in reply
            # to "Would your husband join a short call?").  The layers are not given, so the need
            # stays released and is offered on the next turn that digs for it.
            layers["first_probes"] = ()
            layers["reveal_topics"] = ()
        if negotiation.resolved or self.commitment_resolved:
            if wants is not None or seen.email_offer or seen.checkin:
                reasons.append("commitment_on_record")
                self._notes.append(RESOLVED_NOTE)
            return None
        if wants is not None:
            if not self.scheduler.commit_permitted(r_sec):
                self._pending_ask = wants  # open until the close window (a farewell answers it)
                owed = self.scheduler.select(r_sec)
                if owed is not None and (owed.forced or owed.family == "F4"):
                    # The owed objection lands in context (the advisor just proposed a next
                    # step), and a deadline is never starved by an advisor who asks every turn.
                    # A forced move that is not the F4 stall is a different topic from the
                    # proposal, so the learner is also told to react to the proposal.
                    reasons.append("ask_yields_to_owed_move")
                    if owed.family != "F4":
                        self._notes.append(NEXT_STEP_PROPOSED_NOTE)
                    return None
                self._stalls += 1
                reasons.append("ask_before_close_window")
                return self._reason_plan(reasons, ask=wants, **layers)
            self._pending_ask = None
            evidence = self._evidence(wants)
            level = grade(evidence)
            reasons.append(f"ask_in_window:grade_{level.name.lower()}")
            if evidence.pressured:
                reasons.append("advisor_pressured")  # an invented offer or a coercive deadline
            if evidence.thin:
                reasons.append("advisor_thin")  # answers in a handful of words, all call
            if level is Level.STRONG:
                # The learner's own words come first (R1-Q final review round 1): it said it has
                # a decision maker to consult that the advisor did not answer, it will wait, or it
                # turned a call down.  It books a call at most, and a declined call is no booking.
                blocked = negotiation.strong_blocked(self.turn)
                if blocked is not None:
                    level = Level.MEDIUM
                    reasons.append(f"strong_blocked:{blocked}")
            if level is Level.MEDIUM and negotiation.call_declined():
                # The learner turned a call or a time down in so many words ("I'd rather reach out
                # myself", "I'd rather not lock in a time yet"): it does not book one now.  In the
                # live sweep it booked the call anyway in nine of twenty calls, two minutes after
                # the refusal, and the pushy and terse advisors earned a MEDIUM they had not.
                level = Level.WEAK
                reasons.append("call_declined")
            if level > Level.WEAK:
                return self._commit_plan(level, reasons, ask=wants)
            if negotiation.can_stall(self._stall_skip()):
                negotiation.stall_rounds += 1
                planned = self._reason_plan(reasons, ask=wants, **layers)
                if planned is not None:
                    return planned
            # A stall that answers a CALL ask does not ask for an e-mail nobody offered.
            return self._commit_plan(Level.WEAK, reasons, call=wants is AskKind.CALL, ask=wants)
        if seen.email_offer:
            if negotiation.email_answered:
                self._notes.append(EMAIL_AGAIN_NOTE)
            else:
                owed = self.scheduler.select(r_sec)
                if owed is not None and owed.forced:
                    # A deadline is never starved by an e-mail offer: the owed move lands now and
                    # the e-mail is thanked in a few words.
                    reasons.append("email_yields_to_owed_move")
                    self._notes.append(EMAIL_OFFER_NOTE)
                else:
                    reasons.append("email_offer")
                    # The advisor already said what is in it: the learner says yes and asks nothing.
                    spec_id = N_EMAIL_YES if seen.email_listed else N_EMAIL
                    return self._spec_plan(SPEC_BY_ID[spec_id], reasons, **layers)
        if seen.checkin:
            reasons.append("checkin")
            self._force_curiosity = True
        return None

    def _reasons_owned_by_f4(self) -> frozenset[str]:
        """Stall reasons the owed F4 moves still have to voice (timing, the decision maker).

        Voicing one of them early as well is the same stall twice in a row (R1-Q round 1), so
        the negotiation skips them until the F4 move that owns them was delivered.
        """
        owned: set[str] = set()
        if not self.scheduler.is_delivered(F4_PRIMARY):
            owned.add(REASON_TIMING)
        if not self.scheduler.is_delivered(F4_PUSH):
            owned.add(REASON_DECISION_MAKER)
        return frozenset(owned)

    def _stall_skip(self) -> frozenset[str]:
        """Stall reasons the learner does not voice now.

        The F4 pair's own reasons (see above), and the money stall once the price stopped being the
        worry: the $7,000 was met, or the learner called the cost the lesser worry ("The cost is
        still the sticking point for me" after "my worry is more about time than money").
        """
        skip = set(self._reasons_owned_by_f4())
        if self.negotiation.money_is_settled():
            skip.add(REASON_MONEY)
        return frozenset(skip)

    def _reason_plan(
        self, reasons: list[str], *, ask: AskKind | None = None, **layers: Any
    ) -> TurnPlan | None:
        """Voice the next unused stall reason, else the one question about the next step, else None.

        The question is worded for ``ask`` (``question_spec``: "the call" only after a call ask) and
        is used up when it is planned, so a reply that missed its markers does not bring the same
        question back on the next early ask.
        """
        reason = self.negotiation.next_reason(self._stall_skip())
        if reason is not None:
            spec = SPEC_BY_REASON[reason]
        elif not self.negotiation.question_used:
            spec = question_spec(ask)
            self.negotiation.question_used = True
        else:
            return None  # every reason is spent: react in a free reply (the next-step note)
        reasons.append(f"stall_reason:{spec.reason or spec.kind}")
        if spec.kind == KIND_STALL:
            self.scheduler.note_objection()
        return self._spec_plan(spec, reasons, **layers)

    def _spec_plan(
        self,
        spec: NegotiationSpec,
        reasons: list[str],
        *,
        first_probes: tuple[str, ...],
        reveal_topics: tuple[str, ...],
        monologue: float | None,
    ) -> TurnPlan:
        """The plan for a negotiation spec the model voices (a reason, a question, e-mail yes)."""
        dm = self.persona.decision_maker
        variants = tuple(fill_decision_maker(text, dm) for text in spec.variants)
        fallbacks = self._fallback_order(spec.id, variants)
        self._intent_uses[spec.id] = self._intent_uses.get(spec.id, 0) + 1
        intent = LearnerIntent(
            kind=spec.kind,
            brief=fill_decision_maker(spec.brief, dm),
            must_say=(),
            markers=filled_markers(spec.markers, dm),
            fallback=fallbacks[0],
            fallbacks=fallbacks,
        )
        self.negotiation.note_response(self.turn, spec.id)
        return self._plan(
            TurnMode.INTENT,
            reasons,
            intent=intent,
            negotiation_id=spec.id,
            first_probes=first_probes,
            reveal_topics=reveal_topics,
            monologue=monologue,
        )

    def _weak_kwargs(self, call: bool = False) -> dict[str, bool]:
        """Which wording of the WEAK line fits the call so far.

        The e-mail was offered or accepted: "I'll read through the email and get back to you", not a
        second request for it.  A call ask and no declined call: "call me back after I've talked to
        my husband".  Otherwise (also after a declined call) the plain "email me the details".
        """
        negotiation = self.negotiation
        emailed = bool(negotiation.email_offers) or negotiation.email_answered
        return {"emailed": emailed, "call": call and not negotiation.call_declined()}

    def _weak_text(self, default: str) -> str:
        """The WEAK line of a farewell or the 19:00 stall, in the wording that fits."""
        kwargs = self._weak_kwargs()
        if not kwargs["emailed"]:
            return default
        return commitment_line(Level.WEAK, self.persona.decision_maker, **kwargs)

    def _commit_plan(
        self,
        level: Level,
        reasons: list[str],
        *,
        call: bool = False,
        ask: AskKind | None = None,
    ) -> TurnPlan | None:
        """The scripted commitment line for ``level`` (MEDIUM carries the call slot).

        ``call`` says the WEAK stall answers a call ask: its second sentence then says the learner
        will talk to its decision maker and be called back, not "e-mail me the details".  A MEDIUM
        line books the call without a slot when the advisor named none and the learner had just
        said it must talk to its decision maker first, when the slot is one the learner refused or
        the advisor named long ago, or when the ask was not for a call at all (``ask`` is the
        enrolment ask: the learner does not invent "Thursday at 7 PM" for it).
        """
        negotiation = self.negotiation
        dm = self.persona.decision_maker
        if level is Level.WEAK and negotiation.weak_line_said:
            self._notes.append(RESOLVED_NOTE)  # the WEAK line is said at most once
            return None
        if level is Level.MEDIUM:
            choice = negotiation.slot_choice(self.turn, picks_own=ask is not AskKind.ENROL)
            text = commitment_line(
                level, dm, choice.phrase, moved=choice.moved, deferred=choice.deferred
            )
        elif level is Level.WEAK:
            text = commitment_line(level, dm, **self._weak_kwargs(call))
        else:
            text = commitment_line(level, dm)
        negotiation.note_response(self.turn, f"commit:{level.name.lower()}")
        return self._plan(
            TurnMode.SAY_ONLY,
            reasons,
            scripted=text,
            level=level,
            resolves=True,
        )

    def _commit_stall_plan(
        self,
        move: OwedMove,
        reasons: list[str],
        *,
        first_probes: tuple[str, ...],
        reveal_topics: tuple[str, ...],
        monologue: float | None,
    ) -> TurnPlan | None:
        """The 19:00 stall: one short reaction by the model, then the scripted WEAK line.

        The intent has no markers on purpose: the line is always appended after the reaction
        (``intent_tail``), and the model is told to say nothing about thinking it over, so the
        WEAK wording is spoken exactly once and stays maskable.
        """
        if self.negotiation.weak_line_said:
            self._notes.append(RESOLVED_NOTE)
            return None
        text = self._weak_text(move.text)
        intent = LearnerIntent(
            kind=KIND_COMMIT,
            brief=COMMIT_REACTION_BRIEF,
            must_say=(),
            markers=(),
            fallback=text,
            fallbacks=(text,),
        )
        self.negotiation.note_response(self.turn, "commit:weak_at_stall")
        return self._plan(
            TurnMode.INTENT,
            reasons,
            scripted=text,
            move_id=move.id,
            level=Level.WEAK,
            resolves=True,
            intent=intent,
            first_probes=first_probes,
            reveal_topics=reveal_topics,
            monologue=monologue,
        )

    # ------------------------------------------------------------------- intents
    def _fallback_order(
        self, key: str, variants: tuple[str, ...], openers: tuple[str, ...] = ()
    ) -> tuple[str, ...]:
        """The scripted variants in the order to try them: seeded rotation, fresh ones first.

        The start of the rotation comes from the attempt id and the move (so two sessions do
        not open with the same variant), and each time the move is handed to the model the
        rotation moves on.  A variant whose sentences the learner already said is tried last.
        ``openers`` (the early-farewell redirect) are paired with the variants one for one.
        """
        count = self._intent_uses.get(key, 0)
        seed = f"{self.seed}:{key}"
        ordered: list[str] = []
        for step in range(len(variants)):
            text = pick_variant(variants, seed, count + step)
            if openers:
                text = f"{pick_variant(openers, seed, count + step)} {text}"
            ordered.append(text)
        said = self._spoken.snapshot()
        fresh = [text for text in ordered if not _repeats(text, said)]
        return tuple(fresh + [text for text in ordered if text not in fresh])

    def _intent_plan(
        self,
        move: OwedMove,
        reasons: list[str],
        *,
        redirect: bool,
        first_probes: tuple[str, ...],
        reveal_topics: tuple[str, ...],
        monologue: float | None,
    ) -> TurnPlan:
        """The plan for an owed move the model voices (the move is already issued).

        The price counter depends on how the advisor answered the anchor (R1-Q): push for a bit
        more after a concession short of the ask, "is there nothing at all?" after a refusal,
        "so what is the final price?" when the answer was unclear.
        """
        if move.id == F1_COUNTER:
            situation = self.negotiation.counter_situation()
            brief = situation.brief
            best = self.negotiation.best_offer_usd
            if best is not None:
                # What is actually on the table, so the reaction names the real number (and never
                # calls the same price better than before).
                brief += f"; the advisor's best price so far is {format_usd(best)}"
            move = replace(move, brief=brief, variants=situation.variants)
            self.negotiation.note_response(self.turn, f"counter:{situation.id}")
        elif move.id == F1_ANCHOR and self.negotiation.best_offer_usd is not None:
            # A price is already on the table (the advisor offered before the learner asked):
            # the anchor keeps its exact $9,000 / $7,000 but reacts to that number.
            anchor = anchor_after_offer(self.negotiation.best_offer_usd)
            move = replace(
                move, brief=anchor.brief, must_say=anchor.must_say, variants=anchor.variants
            )
            self.negotiation.note_response(self.turn, f"anchor:{anchor.id}")
        elif move.id == F4_PUSH and self._call_ask_now:
            # The advisor just proposed a call: "I'd need to talk to my father" must not turn into
            # "he's not really one for these things", and the call stays welcome.
            move = replace(move, brief=move.brief + F4_PUSH_CALL_SUFFIX)
        elif move.id == TIME_CUE:
            # Three wordings of the cue, one per attempt ("before my own next call": 8 of 20).
            briefs = (move.brief, *TIME_CUE_BRIEF_ALTERNATIVES)
            move = replace(move, brief=pick_variant(briefs, self.seed, 0))
        variants = move.variants or (move.text,)
        if move.id == TIME_CUE:
            # The scripted cue never puts the learner on another call when a variant without it
            # exists ("before my next call" was said by a learner who had just got home).
            neutral = tuple(
                text for text in variants if "next call" not in text and "another call" not in text
            )
            variants = neutral or variants
        fallbacks = self._fallback_order(
            move.id, variants, REDIRECT_OPENERS if redirect else ()
        )
        self._intent_uses[move.id] = self._intent_uses.get(move.id, 0) + 1
        brief = f"{REDIRECT_BRIEF} {move.brief}" if redirect else move.brief
        kind = KIND_REDIRECT if redirect else (KIND_CUE if move.id == TIME_CUE else KIND_OBJECTION)
        intent = LearnerIntent(
            kind=kind,
            brief=brief,
            must_say=move.must_say,
            markers=move.markers,
            fallback=fallbacks[0],
            fallbacks=fallbacks,
            forced=move.forced and not redirect,
        )
        return self._plan(
            TurnMode.INTENT,
            reasons,
            move_id=move.id,
            intent=intent,
            first_probes=first_probes,
            reveal_topics=reveal_topics,
            monologue=monologue,
        )

    def intent_tail(self, plan: TurnPlan, spoken_so_far: str) -> str:
        """The scripted variant to append after an intent reply, or "" if it already delivered.

        ``spoken_so_far`` is what the guard let through of the model's reply.  If it proves
        the move (the markers hit) nothing is appended.  Otherwise the first variant that does
        not repeat something the learner already said, in this call or in this very reply,
        is returned (the repetition check; the first one if every variant repeats), so the
        owed move is never lost to the model and is never said twice word for word.  A reply
        that already asked a question gets no second negotiation question: when no variant
        proves a negotiation line without its question, nothing is appended (an owed move, the
        farewell redirect and the WEAK line are always appended).
        """
        intent = plan.intent
        if intent is None or markers_match(intent.markers, spoken_so_far):
            return ""
        if intent.kind == KIND_COMMIT and fuzzy_contains(spoken_so_far, plan.scripted_text):
            return ""  # the model already said the closing line: it is never said twice
        said = self._spoken.snapshot() + tuple(
            normalize(sentence) for sentence in split_sentences(spoken_so_far)
        )
        candidates = intent.fallbacks or (intent.fallback,)
        if "?" in spoken_so_far:
            # The model already asked something in this reply: a second question in the scripted
            # tail is the same question twice in other words ("... what would I actually end up
            # paying? Sorry, so what's the final number you can do for me?").  A statement that
            # proves the move goes first, then the tail without its question if that still proves
            # it.
            quiet = [text for text in candidates if "?" not in text]
            stripped = [_without_questions(text) for text in candidates if "?" in text]
            stripped = [text for text in stripped if text and markers_match(intent.markers, text)]
            if intent.markers and plan.move_id is None and plan.negotiation_id is not None:
                # When no variant proves a negotiation line without a question, nothing is appended
                # (owner test 7f2a25e6 turn 32: "What exactly would I be getting for it? What
                # exactly would that call involve?"); the stall reason stays unused.  A graded owed
                # move, the farewell redirect and the marker-less WEAK line always keep their tail:
                # an owed move dropped here was often held until its deadline forced it, which
                # bunched primaries and pushes there and slipped a family (reviewed fix).
                proven = [text for text in quiet if markers_match(intent.markers, text)]
                proven += stripped
                if not proven:
                    return ""
                candidates = tuple(proven)
            else:
                candidates = (*quiet, *stripped, *candidates)
        chosen = next((text for text in candidates if not _repeats(text, said)), candidates[0])
        key = plan.move_id or plan.negotiation_id
        if key is not None:
            self._intent_fallbacks[key] = self._intent_fallbacks.get(key, 0) + 1
        return chosen

    # ------------------------------------------------------------------- curiosity
    def _note_curiosity_covered(self, advisor_text: str) -> None:
        """A topic the advisor already answered is not asked about."""
        for topic, _label in CURIOSITY_TOPICS:
            if topic not in self._curiosity_asked and curiosity_covered(topic, advisor_text):
                self._curiosity_asked.add(topic)

    def _question_budget(self) -> bool:
        """The learner may ask a question now: none of its last replies held one.

        The guard drops the question of a free reply otherwise (``QUESTION_DIET_WINDOW``), so a
        curiosity topic handed over then would be wasted and marked as asked.
        """
        return not any(self._asked[-QUESTION_DIET_WINDOW:])

    def _curiosity_for_free_reply(self, *, force: bool = False) -> str:
        """One unasked question topic every ``CURIOSITY_EVERY`` free replies, else "".

        These are the neutral questions that used to be scheduled (live or recorded, what
        would I build) plus three more; the model is only told what it is curious about and
        may ask in its own words, so nothing is owed and nothing is graded.  ``force`` (the
        advisor checked in) ignores the cadence, never the question budget.
        """
        self._free_replies += 1
        if not self._question_budget():
            return ""
        if not force and self._free_replies - self._free_at_last_curiosity < CURIOSITY_EVERY:
            return ""
        ids = tuple(topic for topic, _label in CURIOSITY_TOPICS)
        labels = dict(CURIOSITY_TOPICS)
        for step in range(len(ids)):
            topic = pick_variant(ids, self.seed, step)
            if topic not in self._curiosity_asked:
                self._curiosity_asked.add(topic)
                self._free_at_last_curiosity = self._free_replies
                return labels[topic]
        return ""

    # ------------------------------------------------------------------ the plan
    def _plan(
        self,
        mode: TurnMode,
        reasons: list[str],
        *,
        scripted: str = "",
        move_id: str | None = None,
        level: Level | None = None,
        resolves: bool = False,
        first_probes: tuple[str, ...] = (),
        reveal_topics: tuple[str, ...] = (),
        monologue: float | None = None,
        voice: str = "learner",
        aside: bool = False,
        intent: LearnerIntent | None = None,
        curiosity: str = "",
        negotiation_id: str | None = None,
        line_id: str | None = None,
        credit_move_id: str | None = None,
    ) -> TurnPlan:
        reminder: str | None = None
        kind = None if aside else self._break_kind
        price_wrap = self.scheduler.price_wrap_turn == self.scheduler.turn
        if mode in (TurnMode.INTENT, TurnMode.LLM_REPLY):
            # After a MEDIUM or STRONG commitment a free reply only confirms it: no new doubt,
            # no probe answered, no curiosity (in the smoke test the learner answered the
            # advisor's confirmation with "hold on, what would that call involve?").
            confirm = mode is TurnMode.LLM_REPLY and self._confirming()
            if confirm:
                first_probes = ()
                reveal_topics = ()
                curiosity = ""
            elif reveal_topics:
                # One layer of disclosure per reply, the deep need first: a reply that is handed a
                # deep need about one topic and a hint about another voices only one of them (the
                # live sweep: the hint answered and the deep need of the other topic was never
                # told).  The hint topic is probed again later or not at all; its deep need stays
                # locked.
                first_probes = tuple(topic for topic in first_probes if topic in reveal_topics)
            # One opening style per free reply, rotated (an intent opens with its own reaction).
            style_note = (
                pick_variant(STYLE_NOTES, self.seed, self.turn)
                if mode is TurnMode.LLM_REPLY
                else ""
            )
            notes = tuple(
                note for note in self._notes if intent is None or note not in _FREE_REPLY_NOTES
            )
            if not confirm:
                notes += self._standing_notes(
                    mode=mode, move_id=move_id, price_wrap=price_wrap, intent=intent
                )
            # The layers are handed over only here, on the turn that asked about the topic.
            self.tracker.gate.mark_hint_offered(first_probes)
            self.tracker.gate.mark_deep_offered(reveal_topics)
            reminder = turn_reminder(
                self.persona,
                r_sec=self.last_r,
                first_probe_topics=first_probes,
                unlocked_topics=reveal_topics,
                monologue_sec=monologue,
                character_break=kind is not None,
                price_wrap=price_wrap,
                intent_brief="" if intent is None else intent.brief,
                must_say=() if intent is None else intent.must_say,
                intent_forced=False if intent is None else intent.forced,
                curiosity=curiosity,
                offer_usd=self.negotiation.best_offer_usd,
                # The anchor already reacts to the price on the table: no "pleasant surprise".
                new_offer_usd=None if move_id == F1_ANCHOR else self._new_offer_usd,
                notes=notes,
                reaction_only=intent is not None and intent.kind == KIND_COMMIT,
                style_note=style_note,
                confirm=confirm,
            )
            ctx = self.guard_context(
                mode="reply",
                reminder=reminder,
                quiet_empty=mode is TurnMode.INTENT,
                released=reveal_topics,
                confirm=confirm,
                free_reply=mode is TurnMode.LLM_REPLY and not confirm,
            )
        else:
            ctx = self.guard_context(mode="reply")
        return TurnPlan(
            turn=self.turn,
            mode=mode,
            reasons=tuple(reasons),
            scripted_text=scripted,
            move_id=move_id,
            commitment_level=level,
            resolves_commitment=resolves,
            reminder=reminder,
            guard_ctx=ctx,
            voice=voice,
            aside=aside,
            character_break=kind,
            intent=intent,
            negotiation_id=negotiation_id,
            line_id=line_id,
            credit_move_id=credit_move_id,
        )

    # ---------------------------------------------------------------------- speech
    def compose_speech(self, plan: TurnPlan, model_raw: str = "") -> Speech:
        """The text to say for a SAY_ONLY or INTENT plan, for callers that do not stream.

        An INTENT plan's ``model_raw`` is guarded like a streamed reply; when it does not
        prove the move, the scripted variant follows it (``intent_tail``).  An empty or failed
        model call therefore yields the scripted variant alone, so an owed move is never lost.
        """
        if plan.mode is TurnMode.EXIT:
            return Speech("", "", "", None, plan.voice)  # nothing is said on an exit
        if plan.mode is TurnMode.SAY_ONLY:
            return Speech(plan.scripted_text, "", plan.scripted_text, None, plan.voice)
        if plan.mode is not TurnMode.INTENT:
            raise ValueError("an LLM_REPLY plan is streamed through stream_guard")
        model_text = ""
        result: GuardResult | None = None
        if model_raw.strip():
            result = guard_text(model_raw, plan.guard_ctx)
            self.record_guard(result)
            model_text = result.text
        tail = self.intent_tail(plan, model_text)
        text = f"{model_text} {tail}".strip()
        return Speech(text, model_text, tail, result, plan.voice)

    def stream_guard(self, plan: TurnPlan) -> StreamGuard:
        """A per-reply sentence guard; pass its ``result`` to ``record_guard`` afterwards."""
        return StreamGuard(plan.guard_ctx)

    def sanitize_reply(self, plan: TurnPlan, raw: str) -> GuardResult:
        """Guard a whole LLM reply at once and count its hits."""
        result = guard_text(raw, plan.guard_ctx)
        self.record_guard(result)
        return result

    def record_guard(self, result: GuardResult) -> None:
        self.ledger.record(result)
        if result.fallback_used:
            self._fallbacks += 1  # the next fallback starts at the next variant

    def record_spoken(
        self,
        plan: TurnPlan,
        spoken_text: str,
        *,
        r_sec: float | None = None,
        interrupted: bool = False,
        by_candidate: bool = True,
    ) -> None:
        """Record what the learner actually said, so reveals and deliveries are exact.

        ``interrupted``: the line was cut before its end; ``by_candidate`` is False when R1 cut it
        itself (a hung generation past its deadline): only a cut by the candidate is answered as one
        on the next turn, while what was not heard stays owed either way.
        """
        if plan.aside:
            return  # the interviewer's aside is scripted and excluded from evidence
        when = self.last_r if r_sec is None else r_sec
        cap = self._commitment_cap()  # the level on record BEFORE this turn's line
        self._spoken.add(spoken_text)
        if spoken_text.strip():
            self._styles.append((reply_opener(spoken_text), reply_tics(spoken_text)))
            self._asked.append("?" in spoken_text)
            self._last_reply_closer = is_closer(spoken_text)
            phrases = reply_phrases(spoken_text)
            self._phrase_history.append(phrases)
            for key in phrases:
                self._phrases[key] = self._phrases.get(key, 0) + 1
        self.tracker.note_learner_text(spoken_text, plan.turn)
        self.negotiation.note_learner_text(
            spoken_text,
            plan.turn,
            stall=plan.move_id == F4_PRIMARY or plan.negotiation_id == N_TIMING,
        )
        if self._pending_ask is not None and declines_call(spoken_text):
            # The learner turned the proposed call down in its own words ("I'd rather keep it to
            # email", "I'd rather reach out myself", "I'd rather you didn't"): a farewell inside the
            # close window must not book it after all (R1-Q iterations 2 and 3).
            self._pending_ask = None
            self._declined_calls += 1
        carried = plan.move_id if plan.move_id is not None else plan.credit_move_id
        if carried is not None:
            delivery = self.scheduler.confirm_if_spoken(
                carried, spoken_text, when, interrupted=interrupted
            )
            # The owed F4 pair voices two stall reasons; the advisor's answer to them counts
            # as handled evidence for the grade.
            if delivery is not None and delivery.move_id == F4_PRIMARY:
                self.negotiation.note_reason_voiced(REASON_TIMING, plan.turn)
            elif delivery is not None and delivery.move_id == F4_PUSH:
                self.negotiation.note_reason_voiced(REASON_DECISION_MAKER, plan.turn)
        # Voice barge-in: the next turn is the one that cut her off.  A move the played part
        # already proved is delivered above (it was heard); one it did not prove stays owed.
        self._learner_cut = interrupted and by_candidate and bool(spoken_text.strip())
        self._cut_move = (
            carried
            if self._learner_cut
            and carried is not None
            and not self.scheduler.is_delivered(carried)
            else None
        )
        if not interrupted:
            self._credit_organic_push(plan, spoken_text, when)
        if plan.negotiation_id is not None:
            self.negotiation.note_spoken(plan.negotiation_id, spoken_text, plan.turn)
        scripted_commitment = plan.commitment_level is not None and bool(plan.scripted_text)
        if plan.resolves_commitment and scripted_commitment:
            if fuzzy_contains(spoken_text, plan.scripted_text):
                if self._commitment_level is None:
                    self._commitment_level = plan.commitment_level
                    self._commitment_turn = plan.turn
                self.scheduler.mark_commitment_resolved()
                if plan.commitment_level is not None:
                    self.negotiation.note_commitment(plan.commitment_level, plan.turn)
                self._unheard_commitment = None
            elif interrupted and not self.commitment_resolved:
                # Voice barge-in: the line was cut before the candidate heard it whole, so nothing
                # is on record; it is said again on the next turn (``_revoice_commitment``), and
                # that revoice counts toward the limit when some of it was heard.
                self._unheard_commitment = plan
                self._unheard_was_cut = bool(spoken_text.strip())
        if not scripted_commitment or plan.commitment_level is Level.WEAK:
            if classify_learner_commitment(spoken_text) > cap or has_concession(spoken_text):
                self._violations += 1

    def _credit_organic_push(self, plan: TurnPlan, spoken_text: str, when: float) -> None:
        """A push the learner already voiced in a free reply is not owed again.

        "What happens if someone falls behind?" asked in a free reply, answered by the advisor, and
        then "What actually happens if someone does?" as the owed F2 push was a re-ask (R1-Q
        iteration 2: four calls).  When the primary of a family was delivered at least one turn ago
        and the played text proves its push, the push counts as delivered now.
        """
        for push_id, primary_id in ((F2_PUSH, F2_PRIMARY), (F3_PUSH, F3_PRIMARY)):
            if plan.move_id == push_id or self.scheduler.is_delivered(push_id):
                continue
            since = self.scheduler.turns_since_delivery(primary_id)
            if since is None or since < 1:
                continue
            if self.scheduler.confirm_if_spoken(push_id, spoken_text, when) is not None:
                self._organic_pushes.append(push_id)

    # ------------------------------------------------------------------------ judge
    def judge_messages(
        self, candidate_text: str, learner_last: str, *, turn: int | None = None
    ) -> list[dict[str, str]]:
        """Messages for the shadow judge about the turn just planned.

        ``turn`` is the role-play turn being judged (``plan.turn``); it only seeds the
        fence sentinel, and defaults to the latest turn.  The caller must keep it and hand
        it back to ``apply_judge``, because the verdict arrives after the next turn began.
        """
        return build_judge_messages(
            candidate_text,
            learner_last,
            seed=self.seed,
            turn=self.turn if turn is None else turn,
        )

    def apply_judge(self, raw: Any, judged_turn: int) -> bool:
        """Apply the judge's raw output (text or dict) to ``judged_turn``.

        ``judged_turn`` is required: the shadow judge runs off the speech path and its
        verdict lands after ``plan_turn`` for the NEXT turn, so "the latest turn" is the
        wrong default.  A verdict for turn N attributed to turn N+1 would test the wrong
        turn for a question (``had_question``) and the wrong turn for deduplication.
        Invalid output changes nothing.
        """
        result = parse_judge_output(raw)
        return self.tracker.apply_judge(result, judged_turn)

    # -------------------------------------------------------------------------- logs
    def fidelity(self, r_end: float | None = None) -> dict[str, Any]:
        """The plan 6.4 administration checks this module can evaluate.

        ``stt_sanity`` (fewer than ``STT_SHORT_SHARE_LIMIT`` of the turns of at most
        ``STT_SHORT_WORDS`` words) reads only the turns that are not acknowledgement-only: an
        "Okay." or "Okay, continue." is the candidate's whole turn, which voice barge-in commits on
        its own, not speech-to-text chopping a long answer into fragments.  A short turn that is
        anything else ("Hi Pooja", "the price", "So bye") still counts, and a role-play of nothing
        but acknowledgements fails closed, as an empty one does.
        """
        end = self.last_r if r_end is None else r_end
        schedule = self.scheduler.summary(final=True)
        substantive = sum(1 for count in self._word_counts if count >= SUBSTANTIVE_WORDS)
        stt = self._stt_word_counts
        short_share = (
            sum(1 for count in stt if count <= STT_SHORT_WORDS) / len(stt) if stt else 1.0
        )
        reasons = list(schedule["exclusion_reasons"])  # type: ignore[arg-type]
        checks = {
            "r_reached_10_min": end >= FIDELITY_MIN_R_SEC,
            "enough_substantive_turns": substantive >= MIN_SUBSTANTIVE_TURNS,
            "all_families_delivered": not any(r.startswith("family_missing") for r in reasons),
            "f1_counter_delivered": self.scheduler.deliveries_by_id().get(F1_COUNTER) is not None,
            "family_slip_within_limit": not any(r.startswith("family_slip") for r in reasons),
            "no_unprobed_reveal": self.tracker.gate.unreleased_reveals == 0,
            "no_commitment_violation": self._violations == 0,
            "guard_hits_below_threshold": not self.ledger.flagged,
            "stt_sanity": short_share < STT_SHORT_SHARE_LIMIT,
        }
        return {
            "checks": checks,
            "passes": all(checks.values()),
            "substantive_turns": substantive,
            "short_turn_share": round(short_share, 3),
            "acknowledgement_turns": len(self._word_counts) - len(stt),
        }

    def admin_log(self, *, final: bool = False, r_end: float | None = None) -> dict[str, Any]:
        """The trusted administration log (turn indices, counts and booleans only)."""
        schedule = self.scheduler.summary(final=final)
        tracker = self.tracker.admin_view()
        fidelity = self.fidelity(r_end) if final else None
        for move in schedule["moves"]:  # type: ignore[attr-defined]
            move["transcript_turn"] = self._turn_map.get(move["turn"])
        needs = []
        for record in tracker["needs"]:
            entry = dict(record)
            for key in ("probe", "followup", "released", "revealed"):
                turn = record[f"{key}_turn"]
                entry[f"{key}_transcript_turn"] = None if turn is None else self._turn_map.get(turn)
            needs.append(entry)
        return {
            "content_version": CONTENT_VERSION,
            "content_sha256": CONTENT_SHA256,
            "world_version": WORLD_VERSION,
            "persona": {
                "id": self.persona.id,
                "version": self.persona.version,
                "variant": self.persona.variant_id,
            },
            "roleplay_turns": self.turn,
            "turn_map": [
                {"roleplay_turn": key, "transcript_turn": value}
                for key, value in sorted(self._turn_map.items())
            ],
            "schedule": schedule,
            "needs": needs,
            "tracker": {key: value for key, value in tracker.items() if key != "needs"},
            "commitment": {
                "asks": list(self._asks),
                "stalls_before_window": self._stalls,
                "level": None if self._commitment_level is None else self._commitment_level.name,
                "turn": self._commitment_turn,
                "resolved": self.commitment_resolved,
            },
            "guard": self.ledger.summary(),
            # Which layer of each need was handed to the model on which role-play turn
            # (indices only; logged for the rehearsal metrics, not posted).
            "disclosure": self.tracker.gate.offers_view(),
            "repetition": {
                "remembered_sentences": len(self._spoken),
                "repeats_dropped": self.ledger.counts.get(REPEAT, 0),
                "fallbacks_used": self._fallbacks,
                "fillers_used": self._fillers,
            },
            # Intent-voiced moves (counts only; logged for the rehearsal metrics, not posted):
            # how often each move went to the model and how often its scripted variant had to
            # be appended because the model's reply missed the markers.
            "intents": {
                "handed_to_model": dict(self._intent_uses),
                "fallback_appended": dict(self._intent_fallbacks),
                "curiosity_asked": sorted(self._curiosity_asked),
                # Pushes the learner voiced in a free reply (not owed again), and calls it declined.
                "organic_pushes": list(self._organic_pushes),
                "declined_calls": self._declined_calls,
            },
            # Counts only (logged for the rehearsal metrics, not posted): replies that held a
            # question, the tracked phrase tics, and what the advisor already answered.
            "style": {
                "replies": len(self._asked),
                "questions": sum(1 for asked in self._asked if asked),
                "phrases": dict(self._phrases),
                "answered": list(self._answered),
            },
            # What the learner remembers about the price, callbacks, reasons and the close
            # (turn indices, integers and ids only; logged, not posted).
            "negotiation": self.negotiation.log(),
            "early_close": {
                "attempts": self.scheduler.close_attempts,
                "exit_requested": self.exit_requested,
                # The one-off out-of-role end request: the "end the interview now, or carry on?"
                # aside, or an explicit request that needed none (``question_asked`` false).
                "end_request": None if self._end_aside is None else dict(self._end_aside),
            },
            "character_breaks": {
                "ai_questions": self._ai_questions,
                "asides": list(self._asides),
            },
            "communication": {
                "candidate_turns": len(self._word_counts),
                "acknowledgement_turns": len(self._word_counts) - len(self._stt_word_counts),
                "longest_candidate_turn_sec": round(self._longest_turn_sec, 1),
            },
            "excluded_from_auto_status": schedule["excluded_from_auto_status"],
            "exclusion_reasons": schedule["exclusion_reasons"],
            "fidelity": fidelity,
        }


# "it works out to 200 a month" / "about 150 per month": a bare number next to a monthly cue.
_BARE_MONTHLY = re.compile(
    r"(?<![\d$,.])(\d{2,4})(?:\s*(?:dollars|usd|bucks))?\s*(?:a|per|each|every|/)\s*month\b",
    re.IGNORECASE,
)


def advisor_amounts_in(text: object) -> set[int]:
    """The whole-dollar amounts the advisor's ``text`` names, however they are written.

    The learner may repeat any of them.  Spoken amounts ("two hundred a month", "fifteen hundred
    dollars a month") and a bare number beside "a month" count as well as "$N" (R1-Q final review
    round 1: the guard read the learner's "two hundred a month" in canonical form but only the
    advisor's digits with a dollar sign, so repeating the advisor's own figure was an "invented"
    amount and cost the learner its reply).
    """
    folded = canonical_amounts(text)
    amounts = set(dollar_amounts(folded))
    amounts.update(int(match.group(1)) for match in _BARE_MONTHLY.finditer(folded))
    return amounts


def _without_questions(text: str) -> str:
    """``text`` without its question sentences ("A statement. A question?" -> "A statement.")."""
    return " ".join(s for s in split_sentences(text) if "?" not in s).strip()


def _repeats(text: str, said: tuple[str, ...]) -> bool:
    """True when any sentence of ``text`` repeats something in ``said`` (``repeat_kind``)."""
    return any(repeat_kind(sentence, said) is not None for sentence in split_sentences(text))
