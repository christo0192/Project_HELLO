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
    (``plan.aside``) the interviewer's one-off L-ASIDE-COACH, which the session speaks in the
    ASIDE phase with ``plan.voice == "interviewer"`` and which is excluded from evidence
    (plan 5.10).  The WEAK line is spoken at most once per session (``r1_negotiation``).
``INTENT``
    R1-Q option B, intent-voiced moves.  The worker decides WHAT the learner raises (an owed
    objection, an early-farewell redirect, the time cue, and, from the negotiation, a stall
    reason, the e-mail yes, one question about the call) and the model voices it in context,
    in the same single call: it reacts to the advisor first and then raises
    ``plan.intent.brief`` in its own words.  Delivery is proven by ``plan.intent.markers`` in
    the text that was played.  If the model's reply misses them, ``intent_tail`` returns a
    scripted variant (``plan.intent.fallbacks``, vetted by the repetition check) that the
    session appends, so an owed move is never lost to the model.  ``compose_speech`` builds
    the final text for callers that do not stream.  The 13:00 stall is an INTENT without
    markers: one short model reaction, then the scripted WEAK line, always.
``LLM_REPLY``
    A free, constrained reply using ``plan.reminder`` (a HINT for a first probe, the DEEP
    need's facts only on the turn that asks about a released topic, and now and then one
    curiosity topic), screened sentence by sentence by ``plan.guard_ctx``.
``EXIT``
    The candidate said goodbye again: the session moves to ROLEPLAY_EXIT.

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
    plan = engine.plan_turn(text, machine.roleplay_elapsed, turn_index=i)
    if plan.exit_roleplay:            -> machine.transition(ROLEPLAY_EXIT)
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
    looks_like_proposal,
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
    N_QUESTION,
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
)
from r1_personas import H_TOPICS, RenderedPersona, asks_about_learner, detect_probes
from r1_prompts import (
    ANCHOR_NOT_OFFERED_NOTE,
    ANSWERED_NOTE,
    CHECKIN_DONE_NOTE,
    CHECKIN_NOTE,
    DECIDER_ASKED_NOTE,
    EMAIL_AGAIN_NOTE,
    EMAIL_OFFER_NOTE,
    HOLD_NOTE,
    HOLLOW_NOTE,
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
    F1_ANCHOR,
    F1_COUNTER,
    F2_PRIMARY,
    F2_PUSH,
    F3_PRIMARY,
    F3_PUSH,
    F4_PRIMARY,
    F4_PUSH,
    F4_PUSH_CALL_SUFFIX,
    REDIRECT_BRIEF,
    REDIRECT_OPENERS,
    TIME_CUE,
    TIME_CUE_BRIEF_ALTERNATIVES,
    OwedMove,
    OwedMoveScheduler,
    answered_topics,
    curiosity_covered,
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
    detect_character_break,
    parse_judge_output,
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

KIND_OBJECTION = "objection"
KIND_REDIRECT = "redirect"
KIND_CUE = "cue"
# How many of the learner's last replies the style rules look back over (``r1_guard``).
STYLE_HISTORY = 8
# Situation notes that belong to a free reply: an intent has its own brief to voice.
_FREE_REPLY_NOTES = frozenset({ANCHOR_NOT_OFFERED_NOTE, TRY_NOT_GRANTED_NOTE})


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
        self._word_counts: list[int] = []
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
        # for the stall phrases), whether the advisor's turn may hold a proposal the detectors
        # missed inside the close window (``late_ask_ok``), and how many such late asks the model
        # accepted (the farewell answers them like any open proposal).
        self._phrase_history: list[tuple[str, ...]] = []
        self._late_ask_ok = False
        self._late_asks = 0

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
            late_ask_ok=self._late_ask_ok and free_reply and phase == "roleplay",
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
    ) -> TurnPlan:
        """Decide what the learner does after this candidate turn (see module docstring)."""
        break_kind = detect_character_break(candidate_text)
        if self._wants_aside(break_kind):
            return self._aside_plan(break_kind or "ai", r_sec, turn_index)
        if break_kind == "ai":
            self._ai_questions += 1
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
        self._word_counts.append(word_count(candidate_text))
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
        # A turn the detectors read as no ask, inside the close window with nothing on record, that
        # still looks like a call or time proposal: if the model answers it with an acceptance, that
        # is a late ask for the farewell to answer, not a commitment leak (see ``r1_guard``).
        self._late_ask_ok = (
            wants is None
            and not early
            and not (self.negotiation.resolved or self.commitment_resolved)
            and self.scheduler.commit_permitted(r_sec)
            and looks_like_proposal(candidate_text)
        )
        reasons: list[str] = []
        if obs.injection:
            reasons.append("injection_phrase_flagged")
        if break_kind:
            reasons.append(f"character_break:{break_kind}")
        self._break_kind = break_kind
        # A proposal the learner could not answer before the close window is still open when the
        # advisor says goodbye inside it: the farewell answers as the ask would have (a strong
        # advisor closing at 11:20 after an early proposal used to get the WEAK stall).
        farewell_ask = (
            wants is None
            and signals.close_attempt
            and self._pending_ask is not None
            and self.scheduler.commit_permitted(r_sec)
            and not (self.negotiation.resolved or self.commitment_resolved)
        )
        if farewell_ask:
            wants = self._pending_ask
            reasons.append("pending_ask_at_farewell")
        decision = None
        if signals.close_attempt:
            decision = self.scheduler.register_close_attempt(r_sec)
            if decision.action == "exit" and not farewell_ask:
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
                reasons.append("close_attempt_redirect")
                return self._intent_plan(
                    move,
                    reasons,
                    redirect=True,
                    first_probes=obs.gate.first_probes,
                    reveal_topics=reveal_topics,
                    monologue=candidate_seconds,
                )
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
                if move.id == COMMIT_STALL:
                    # The 13:00 stall: a short reaction, then the scripted WEAK line, spoken
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
        reasons.append("free_reply")
        curiosity = ""
        if self._force_curiosity and not reveal_due and break_kind is None:
            # The advisor checked in ("what do you think?", "anything else?"): an honest
            # reaction and one real question, never the stall.
            curiosity = self._curiosity_for_free_reply(force=True)
            self._notes.append(CHECKIN_NOTE if curiosity else CHECKIN_DONE_NOTE)
        elif not reveal_due and break_kind is None:
            curiosity = self._curiosity_for_free_reply()
        return self._plan(
            TurnMode.LLM_REPLY,
            reasons,
            first_probes=obs.gate.first_probes,
            reveal_topics=reveal_topics,
            monologue=candidate_seconds,
            curiosity=curiosity,
        )

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
        hard-ends at 14:00.
        """
        if move.forced:
            return False
        past_grace = r_sec >= COMMIT_STALL_R_SEC + STALL_DEFER_GRACE_SEC
        return not (move.id == COMMIT_STALL and past_grace)

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
        )

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
                return self._reason_plan(reasons, **layers)
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
                planned = self._reason_plan(reasons, **layers)
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

    def _reason_plan(self, reasons: list[str], **layers: Any) -> TurnPlan | None:
        """Voice the next unused stall reason, else the one question about the call, else None."""
        reason = self.negotiation.next_reason(self._stall_skip())
        if reason is not None:
            spec = SPEC_BY_REASON[reason]
        elif not self.negotiation.question_used:
            spec = SPEC_BY_ID[N_QUESTION]
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
        """The WEAK line of a farewell or the 13:00 stall, in the wording that fits."""
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
        """The 13:00 stall: one short reaction by the model, then the scripted WEAK line.

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
        owed move is never lost to the model and is never said twice word for word.
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
        if (
            any(hit.rule == "late_ask_accepted" for hit in result.hits)
            and not (self.negotiation.resolved or self.commitment_resolved)
            and not self.negotiation.call_declined()
        ):
            # The model took a proposal the detectors missed as a call it would book: the ask stays
            # open for the farewell (``pending_ask_at_farewell``), graded like any other.
            self._late_asks += 1
            if self._pending_ask is None:
                self._pending_ask = AskKind.CALL

    def record_spoken(
        self,
        plan: TurnPlan,
        spoken_text: str,
        *,
        r_sec: float | None = None,
        interrupted: bool = False,
    ) -> None:
        """Record what the learner actually said, so reveals and deliveries are exact."""
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
        if plan.move_id is not None:
            delivery = self.scheduler.confirm_if_spoken(
                plan.move_id, spoken_text, when, interrupted=interrupted
            )
            # The owed F4 pair voices two stall reasons; the advisor's answer to them counts
            # as handled evidence for the grade.
            if delivery is not None and delivery.move_id == F4_PRIMARY:
                self.negotiation.note_reason_voiced(REASON_TIMING, plan.turn)
            elif delivery is not None and delivery.move_id == F4_PUSH:
                self.negotiation.note_reason_voiced(REASON_DECISION_MAKER, plan.turn)
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
        """The plan 6.4 administration checks this module can evaluate."""
        end = self.last_r if r_end is None else r_end
        schedule = self.scheduler.summary(final=True)
        words = self._word_counts
        substantive = sum(1 for count in words if count >= SUBSTANTIVE_WORDS)
        short_share = (
            sum(1 for count in words if count <= STT_SHORT_WORDS) / len(words) if words else 1.0
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
                "late_asks": self._late_asks,
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
            },
            "character_breaks": {
                "ai_questions": self._ai_questions,
                "asides": list(self._asides),
            },
            "communication": {
                "candidate_turns": len(self._word_counts),
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
