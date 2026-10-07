"""R1 role-play engine: the single integration surface for the learner's content.

One ``RolePlayEngine`` per interview ties together the owed-move scheduler, the
disclosure gate and coverage tracker, the earned-close logic and the output guard.  The
session (``r1_session``, a follow-up change) owns phases, clocks, I/O and the LLM; the
engine only DECIDES, deterministically, what the learner does on each candidate turn:

    plan = engine.plan_turn(candidate_text, r_sec, turn_index=..., candidate_seconds=...)

``plan.mode`` is one of

``SAY_ONLY``
    Speak ``plan.scripted_text`` verbatim and call no LLM: a commitment line, the WEAK
    stall, "Oh wait, before you go..." plus the next owed move, or (``plan.aside``) the
    interviewer's one-off L-ASIDE-COACH, which the session speaks in the ASIDE phase with
    ``plan.voice == "interviewer"`` and which is excluded from evidence (plan 5.10).
``ACK_THEN_SAY``
    Escalation step 1 from S0-B.  The LLM gives a short acknowledgement using
    ``plan.reminder`` (<= 15 words, no facts, no question); then the worker speaks
    ``plan.scripted_text`` (the owed line) VERBATIM.  ``compose_speech`` builds the final
    text and falls back to the scripted line alone if the LLM failed.
``LLM_REPLY``
    A free, constrained reply using ``plan.reminder`` (surface answers for first probes,
    deep needs only after release), screened sentence by sentence by ``plan.guard_ctx``.
``EXIT``
    The candidate said goodbye again: the session moves to ROLEPLAY_EXIT.

Nothing here can change a phase, a grade or the schedule from candidate or model text
beyond the deterministic rules: the LLM has no tools, the judge's JSON is whitelisted,
and farewell/ask detection is lexical.  The engine never stores candidate text; its logs
hold turn indices, counts and booleans only.

Integration sketch for ``r1_session`` (the follow-up change; one call per final candidate
transcript in ROLEPLAY, with ``r_sec`` read from the phase machine's role-play clock)::

    engine = RolePlayEngine(resolve_persona(pid, variant=v, seed=attempt_id,
                                            avoid_first_name=first_name),
                            candidate_first_name=first_name, seed=attempt_id)
    plan = engine.plan_turn(text, machine.roleplay_elapsed, turn_index=i)
    if plan.exit_roleplay:            -> machine.transition(ROLEPLAY_EXIT)
    elif plan.aside:                  -> ASIDE phase, say(plan.scripted_text), back to ROLEPLAY
    elif plan.mode is SAY_ONLY:       -> raise StopResponse; say(plan.scripted_text)
    elif plan.mode is ACK_THEN_SAY:   -> raise StopResponse; ack = <one short LLM call using
                                         plan.reminder, <= plan.ack_word_cap words>;
                                         say(engine.compose_speech(plan, ack).text)
    else (LLM_REPLY):                 -> add plan.reminder as the ephemeral system message;
                                         llm_node streams through engine.stream_guard(plan)
    afterwards: engine.record_spoken(plan, spoken_text, interrupted=...),
                messages = engine.judge_messages(text, learner_last, turn=plan.turn)
                ... later, off the speech path (possibly after the NEXT plan_turn):
                engine.apply_judge(shadow_judge_output, plan.turn)  (the turn it judged)
    at the end: post engine.admin_log(final=True, r_end=...) and persist
                ``interview_round_attempts.content_sha`` = ``r1_content.CONTENT_SHA256``.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from r1_commitment import (
    AskKind,
    Level,
    classify_learner_commitment,
    commitment_line,
    detect_ask,
    grade,
    stall_line,
)
from r1_content import CONTENT_SHA256, CONTENT_VERSION
from r1_guard import (
    ACK_WORD_CAP,
    GuardContext,
    GuardLedger,
    GuardResult,
    StreamGuard,
    guard_text,
    has_concession,
)
from r1_personas import RenderedPersona
from r1_prompts import (
    ack_reminder,
    control_prose,
    interviewer_prefix,
    learner_prefix,
    turn_reminder,
)
from r1_scheduler import COMMIT_STALL, F1_COUNTER, TIME_CUE, OwedMoveScheduler
from r1_script import line as script_line
from r1_text import dollar_amounts, fuzzy_contains, word_count
from r1_tracker import (
    CoverageTracker,
    build_judge_messages,
    detect_character_break,
    parse_judge_output,
)
from r1_world import WORLD_VERSION

REVEAL_OFFERS = 2
MAX_EARLY_STALLS = 2
MAX_ASIDES = 3
MIN_SUBSTANTIVE_TURNS = 8
SUBSTANTIVE_WORDS = 3
STT_SHORT_WORDS = 2
STT_SHORT_SHARE_LIMIT = 0.10
FIDELITY_MIN_R_SEC = 600


class TurnMode(str, Enum):
    SAY_ONLY = "say_only"
    ACK_THEN_SAY = "ack_then_say"
    LLM_REPLY = "llm_reply"
    EXIT = "exit"


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
    ack_word_cap: int
    guard_ctx: GuardContext
    voice: str = "learner"
    aside: bool = False
    character_break: str | None = None

    @property
    def needs_llm(self) -> bool:
        return self.mode in (TurnMode.ACK_THEN_SAY, TurnMode.LLM_REPLY)

    @property
    def exit_roleplay(self) -> bool:
        return self.mode is TurnMode.EXIT


@dataclass(frozen=True)
class Speech:
    """The text to hand to ``session.say``, and how it was built."""

    text: str
    ack_text: str
    scripted_text: str
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
        self._offers: dict[str, int] = {}
        self._violations = 0
        self._ai_questions = 0
        self._asides: list[dict[str, Any]] = []
        self._coach_played = False
        self._break_kind: str | None = None
        self._learner_control = control_prose(learner_prefix(persona))
        self._interviewer_control = control_prose(interviewer_prefix())
        self.exit_requested = False

    # ------------------------------------------------------------------- properties
    @property
    def commitment_resolved(self) -> bool:
        return self.scheduler.commitment_resolved

    @property
    def commitment_level(self) -> Level | None:
        return self._commitment_level

    def guard_context(
        self,
        phase: str = "roleplay",
        *,
        mode: str = "reply",
        turn: int | None = None,
        reminder: str | None = None,
    ) -> GuardContext:
        """The guard context for an LLM reply now.  An acknowledgement may reveal nothing.

        Its ``control_texts`` are the private instruction prose of the prompts in play
        (never the words the model is meant to say), for the guard's echo check.
        """
        released = self.tracker.gate.released_topics if mode == "reply" else frozenset()
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
            released_topics=released,
            advisor_amounts=frozenset(self._advisor_amounts),
            mode=mode,
            commitment_cap=Level.WEAK,
            turn=self.turn if turn is None else turn,
            control_texts=control,
            keep_excerpts=self.keep_excerpts,
        )

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
        if turn_index is not None:
            self._turn_map[turn] = turn_index
        if candidate_seconds is not None:
            self._longest_turn_sec = max(self._longest_turn_sec, candidate_seconds)
        self._word_counts.append(word_count(candidate_text))
        signals = self.scheduler.observe_candidate_turn(candidate_text, r_sec)
        obs = self.tracker.observe_candidate_turn(candidate_text, turn)
        self._advisor_amounts.update(dollar_amounts(candidate_text))
        ask = detect_ask(candidate_text)
        reasons: list[str] = []
        if obs.injection:
            reasons.append("injection_phrase_flagged")
        if break_kind:
            reasons.append(f"character_break:{break_kind}")
        self._break_kind = break_kind
        decision = None
        if signals.close_attempt:
            decision = self.scheduler.register_close_attempt(r_sec)
            if decision.action == "exit":
                self.exit_requested = True
                reasons.append("close_attempt_exit")
                return self._plan(TurnMode.EXIT, reasons)
        if ask is not None:
            planned = self._plan_ask(ask.kind, r_sec, reasons)
            if planned is not None:
                return planned
        if decision is not None and decision.move is not None:
            move = decision.move
            self.scheduler.issue(move)
            if decision.action == "redirect":
                reasons.append("close_attempt_redirect")
                text = f"{decision.prefix} {move.text}"
                return self._plan(TurnMode.SAY_ONLY, reasons, scripted=text, move_id=move.id)
            reasons.append("close_attempt_stall")
            return self._plan(
                TurnMode.SAY_ONLY,
                reasons,
                scripted=move.text,
                move_id=move.id,
                level=Level.WEAK,
                resolves=True,
            )
        move = self.scheduler.select(r_sec)
        if move is not None:
            reveal_due = bool(obs.gate.released) or self._reveal_pending()
            if reveal_due and not move.forced and move.id not in (COMMIT_STALL, TIME_CUE):
                reasons.append("owed_deferred_for_reveal")
            else:
                self.scheduler.issue(move)
                reasons.append(f"owed:{move.id}" + (":forced" if move.forced else ""))
                is_stall = move.id == COMMIT_STALL
                return self._plan(
                    TurnMode.ACK_THEN_SAY,
                    reasons,
                    scripted=move.text,
                    move_id=move.id,
                    first_probes=obs.gate.first_probes,
                    monologue=candidate_seconds,
                    level=Level.WEAK if is_stall else None,
                    resolves=is_stall,
                )
        reasons.append("free_reply")
        return self._plan(
            TurnMode.LLM_REPLY,
            reasons,
            first_probes=obs.gate.first_probes,
            monologue=candidate_seconds,
        )

    def _reveal_pending(self) -> bool:
        """A released deep need that has been offered fewer than REVEAL_OFFERS times."""
        return any(
            self._offers.get(topic, 0) < REVEAL_OFFERS
            for topic in self.tracker.gate.pending_reveal_topics
        )

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

    def _plan_ask(self, kind: AskKind, r_sec: float, reasons: list[str]) -> TurnPlan | None:
        """Answer an ask; None means "carry on with the owed move" (see MAX_EARLY_STALLS)."""
        dm = self.persona.decision_maker
        self._asks.append({"turn": self.turn, "kind": kind.value})
        if not self.scheduler.commit_permitted(r_sec):
            if self._stalls >= MAX_EARLY_STALLS and self.scheduler.select(r_sec) is not None:
                # A candidate who asks every turn must not freeze the schedule forever.
                reasons.append("ask_yields_to_owed_move")
                return None
            self._stalls += 1
            reasons.append("ask_before_close_window")
            return self._plan(
                TurnMode.SAY_ONLY,
                reasons,
                scripted=stall_line(dm),
                level=Level.WEAK,
                resolves=False,
            )
        level = self._commitment_level
        if level is None:
            level = grade(self.tracker.commitment_evidence(kind))
        reasons.append(f"ask_in_window:grade_{level.name.lower()}")
        return self._plan(
            TurnMode.SAY_ONLY,
            reasons,
            scripted=commitment_line(level, dm),
            level=level,
            resolves=True,
        )

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
        monologue: float | None = None,
        voice: str = "learner",
        aside: bool = False,
    ) -> TurnPlan:
        reminder: str | None = None
        kind = None if aside else self._break_kind
        price_wrap = self.scheduler.price_wrap_turn == self.scheduler.turn
        if mode is TurnMode.ACK_THEN_SAY:
            reminder = ack_reminder(
                self.persona,
                r_sec=self.last_r,
                first_probe_topics=first_probes,
                monologue_sec=monologue,
                character_break=kind is not None,
                price_wrap=price_wrap,
            )
            ctx = self.guard_context(mode="ack", reminder=reminder)
        elif mode is TurnMode.LLM_REPLY:
            unlocked = [
                topic
                for topic in self.tracker.gate.pending_reveal_topics
                if self._offers.get(topic, 0) < REVEAL_OFFERS
            ]
            for topic in unlocked:
                self._offers[topic] = self._offers.get(topic, 0) + 1
            reminder = turn_reminder(
                self.persona,
                r_sec=self.last_r,
                first_probe_topics=first_probes,
                unlocked_topics=unlocked,
                monologue_sec=monologue,
                character_break=kind is not None,
                price_wrap=price_wrap,
            )
            ctx = self.guard_context(mode="reply", reminder=reminder)
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
            ack_word_cap=ACK_WORD_CAP,
            guard_ctx=ctx,
            voice=voice,
            aside=aside,
            character_break=kind,
        )

    # ---------------------------------------------------------------------- speech
    def compose_speech(self, plan: TurnPlan, ack_raw: str = "") -> Speech:
        """The text to say for a SAY_ONLY or ACK_THEN_SAY plan.

        The acknowledgement is guarded and word-capped; an empty or failed LLM call
        simply yields the scripted line alone, so an owed move is never lost.
        """
        if plan.mode is TurnMode.EXIT:
            return Speech("", "", "", None, plan.voice)  # nothing is said on an exit
        if plan.mode is TurnMode.SAY_ONLY:
            return Speech(plan.scripted_text, "", plan.scripted_text, None, plan.voice)
        if plan.mode is not TurnMode.ACK_THEN_SAY:
            raise ValueError("an LLM_REPLY plan is streamed through stream_guard")
        ack = ""
        result: GuardResult | None = None
        if ack_raw.strip():
            result = guard_text(ack_raw, plan.guard_ctx)
            self.ledger.record(result)
            ack = result.text
        text = f"{ack} {plan.scripted_text}".strip()
        return Speech(text, ack, plan.scripted_text, result, plan.voice)

    def stream_guard(self, plan: TurnPlan) -> StreamGuard:
        """A per-reply sentence guard; pass its ``result`` to ``record_guard`` afterwards."""
        return StreamGuard(plan.guard_ctx)

    def sanitize_reply(self, plan: TurnPlan, raw: str) -> GuardResult:
        """Guard a whole LLM reply at once and count its hits."""
        result = guard_text(raw, plan.guard_ctx)
        self.ledger.record(result)
        return result

    def record_guard(self, result: GuardResult) -> None:
        self.ledger.record(result)

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
        self.tracker.note_learner_text(spoken_text, plan.turn)
        if plan.move_id is not None:
            self.scheduler.confirm_if_spoken(
                plan.move_id, spoken_text, when, interrupted=interrupted
            )
        scripted_commitment = plan.commitment_level is not None and bool(plan.scripted_text)
        if plan.resolves_commitment and scripted_commitment:
            if fuzzy_contains(spoken_text, plan.scripted_text):
                if self._commitment_level is None:
                    self._commitment_level = plan.commitment_level
                    self._commitment_turn = plan.turn
                self.scheduler.mark_commitment_resolved()
        if not scripted_commitment or plan.commitment_level is Level.WEAK:
            if classify_learner_commitment(spoken_text) > Level.WEAK or has_concession(
                spoken_text
            ):
                self._violations += 1

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
                "level": None if self._commitment_level is None else self._commitment_level.name,
                "turn": self._commitment_turn,
                "resolved": self.commitment_resolved,
            },
            "guard": self.ledger.summary(),
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
