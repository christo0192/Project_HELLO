"""R1 reply wiring: persona choice, the per-reply LLM context and the fidelity record.

``r1_session`` owns phases, clocks, I/O and the SDK seams.  The pieces that decide WHAT the
language model may see, and WHAT is recorded about a session, live here as pure functions
so the isolation rules are unit-testable without a session:

* ``choose_persona``: one persona card per session.  The server assigns the persona when it
  creates the attempt (least-used first, migration 0115), so the worker honours that
  ``attempt.persona_id``; only when it is missing or unknown does the worker pick one itself,
  deterministically from the session id, so a restart of the same session gets the same card.
* ``llm_messages``: the context filter (plan 5.3).  A role-play call sees the learner prefix
  (behaviour rules plus the persona's PUBLIC card), the learner's own lines, the candidate's
  role-play turns and the per-turn reminder.  An interviewer-phase call sees the interviewer
  prefix and only its own phase group.  Neither ever sees the scorer's world sheet, the
  rubric, a hidden need that has not been released, or another persona.
* ``fidelity_events`` / ``session_facts_event``: the trusted administration rows
  (``/api/internal/r1/admin-log``) that carry the persona and content pins, the moves
  delivered with their transcript turn, the guard trips and the session facts.  The
  commitment outcome is deliberately NOT part of them: plan 5.8 makes it a logged,
  non-evidence fact, and the scorer reads the administration log.

  THE PAYLOAD KEYS ARE THE API's, NOT THE WORKER'S.  The API stores a payload as sent and
  ``parseR1AdministrationLog`` (``app/api/src/lib/r1/admin-log.ts``) reads exactly the names
  below; any other name parses as unknown, the scorer is told ``NOT PROBED`` / ``slip not
  reported``, and the gate fails closed.  ``tests/test_r1_admin_contract.py`` mirrors that key
  set and fails when either side drifts.  The one exception is ``SESSION_FACT_WORKER_KEYS``:
  counts the worker adds to ``session_facts`` for the owner (the learner's timing holds), which
  the API stores with the row and never parses.

No I/O, no logging, no clock and no candidate text is kept beyond what the caller passes in.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from r1_content import CONTENT_SHA256, CONTENT_VERSION
from r1_guard import HYGIENE_CATEGORIES
from r1_personas import PERSONA_BY_ID, PERSONA_IDS, RenderedPersona, resolve_persona
from r1_prompts import (
    ROLEPLAY_PHASE,
    assemble_messages,
    interviewer_prefix,
    interviewer_reminder,
    learner_prefix,
    select_context,
)
from r1_roleplay import (
    FLAG_WRAPUP_ANSWERS,
    FLAG_WRAPUP_NEXT_ROUND,
    FLAG_WRAPUP_NEXT_STEPS,
    FLAG_WRAPUP_ONE_MENTION,
    TurnPlan,
    flag_on,
)
from r1_world import WORLD_VERSION

SOURCE_ATTEMPT = "attempt"
SOURCE_SEED = "session_seed"
DEFAULT_SEED = "r1"

# The admin-log ``event_type`` CHECK set (migration 0117) has no slot for the commitment stall,
# so that move is logged but never posted (the neutral questions are no longer scheduled).
_MOVE_EVENTS: dict[str, tuple[str, str | None]] = {
    "F3-PRIMARY": ("family_delivered", "F3"),
    "F3-PUSH": ("push_delivered", "F3"),
    "F2-PRIMARY": ("family_delivered", "F2"),
    "F2-PUSH": ("push_delivered", "F2"),
    "F1-ANCHOR": ("family_delivered", "F1"),
    "F1-COUNTER": ("counter_delivered", "F1"),
    "F4-PRIMARY": ("family_delivered", "F4"),
    "F4-PUSH": ("push_delivered", "F4"),
    "L-TIME-CUE": ("time_cue", None),
}

# The guard kinds the API recognises (``GUARD_KINDS`` in admin-log.ts).  The gate acts on
# ``commitment`` and ``concession`` (``out_of_level_*``) and counts every row toward its
# three-hit limit; the rest are recorded for HR.
GUARD_KINDS = ("commitment", "concession", "control", "persona", "feedback", "other")
_GUARD_KIND = {
    "commitment": "commitment",
    "concession": "concession",
    "control": "control",
    "vendor": "control",
    "evaluation": "control",
    "meta": "control",
    "scripted_cue": "control",
    "persona_secret": "persona",
    "volunteered_need": "persona",
    "feedback": "feedback",
    "hiring_comp": "feedback",
}
# The ``session_facts`` payload keys the API reads (admin-log.ts, ``R1SessionFacts``).
SESSION_FACT_KEYS = (
    "roleplay_seconds",
    "talk_share_pct",
    "longest_monologue_seconds",
    "barge_in_count",
    "question_count",
    "interruption_count",
    "first_audio_p95_ms",
)
# M032 S4: the turn reader's shadow record (``r1_turn_reader.ReaderShadowLog.payload``), carried in
# the same row for the owner's comparison.  Worker-only: the API stores it with the payload and its
# parser reads none of it, so no gate or score can depend on it.  Labels and counts only.
READER_FACT_KEYS = ("reader_shadow", "reader_agreement")
# Worker-only ``session_facts`` keys (M032 S1 and SWEEP-1): the API stores them with the row and
# does not parse them, so they never touch the gate or the score.  ``learner_timing`` carries the
# learner's timing holds as counts only (no text), so the owner's next test shows how often each
# fired.  The engine's ``admin_log()["intents"]`` keys it reads, each a count or counts by label:
SESSION_FACT_WORKER_KEYS = (
    "learner_timing",
    "learner_voice",
    "learner_probe_first",
    "learner_endings",
    "learner_followups",
    "wrapup",
)
_LEARNER_TIMING_COUNTS = ("moment_waits", "volunteered_objections", "split_replans")
_LEARNER_TIMING_BY_LABEL = ("push_react_holds", "respond_first_holds", "concerns")
# M032 S2 (learner voice): ``learner_voice`` reads the engine's ``admin_log()["voice"]``, counts
# only: how her replies opened (SWEEP-4), their sentence counts (SWEEP-14), the scripted tails
# bolted onto intent replies (item 8) and how often each S2 note or trim fired.
_LEARNER_VOICE_COUNTS = (
    "learner_replies",
    "learner_ack_hinge_replies",
    "learner_verdict_openers",
    "learner_doubt_opener_replies",
    "intent_turns",
    "intent_tails_appended",
    "intent_tails_after_question",
    "no_commit_notes",
    "volunteered_timing_stalls",
    "ack_turn_notes",
    "soft_tic_trims",
    "implausible_offer_count",
)
_LEARNER_VOICE_BY_LABEL = ("sentence_histogram", "stall_theme_counts", "offer_terms_counts")
# M032 S2P (probe first; review S2P-R8): ``learner_probe_first`` reads the engine's
# ``admin_log()["probe_first"]`` (present only in a session with R1_PROBE_FIRST on; otherwise every
# count is None), counts only: the probes she asked per family, her price questions that got no
# figure, the redirects that asked instead of stating, the course lengths the guard dropped, the
# figure challenges and SWEEP-22's price-reflex notes and price-first turns.
_LEARNER_PROBE_FIRST_COUNTS = (
    "price_dodges",
    "redirect_probes",
    "course_fact_unsaid_count",
    "figure_challenges",
    "price_reflex_notes",
    "price_first_turns",
)
_LEARNER_PROBE_FIRST_BY_LABEL = ("probes",)
# M032 S3 (endings and abuse): ``learner_endings`` reads the engine's ``admin_log()["endings"]``,
# counts only: the closes read in role (hand-over closes, mutual goodbyes), the replies told to say
# one short goodbye, the early-close asides and how they were answered, the late end requests and
# the last-point asides (SWEEP-24), the abuse hits and hang-ups (S3.4, D-M032-3: scoring is
# unchanged), the 19:00 reactions the guard cut a goodbye from (SWEEP-25) and the replies after
# the time cue (SWEEP-27).  ``wrapup`` is the session's own counts of the wrap-up (S3.5 and
# SWEEP-26): the one invitation asked, the hiring-team sentences taken out, the turns said in the
# beat after L-EXIT and the affirmations that did not count as a question.
_LEARNER_ENDINGS_COUNTS = (
    "handover_closes",
    "mutual_goodbyes",
    "winding_replies",
    "early_close_asks",
    "early_close_accepted",
    "early_close_declined",
    "late_end_requests",
    "last_point_asides",
    "abuse_count",
    "abuse_hangups",
    "commit_reaction_dropped",
    "short_on_time_notes",
)
_LEARNER_ENDINGS_BY_LABEL = ("closing_states",)
# M032 S7L (learner follow-ups): ``learner_followups`` reads the engine's
# ``admin_log()["followups"]``, counts only: role-confusion notes (SWEEP-10), floor yields (SWEEP-33), questions dodged and asked
# again (SWEEP-7), call-opening notes (SWEEP-9) and her-number notes (SWEEP-6).
_LEARNER_FOLLOWUPS_COUNTS = (
    "role_confusion_turns",
    "floor_yields",
    "open_q_dodged",
    "open_q_reasked",
    "call_opening_unknown_note",
    "call_opening_name_only_note",
    "call_opening_reciprocal_note",
    "your_number_notes",
)
_WRAPUP_COUNTS = (
    "wrapup_more_asked",
    "wrapup_hiring_team_drops",
    "wrap_beat_turns",
    "wrapup_affirmations",
)
_LABEL_MAX_CHARS = 32
_LABELS_MAX = 16


def guard_kind(category: object) -> str:
    """Map a worker guard category to the API's kind (anything unmapped is ``other``)."""
    return _GUARD_KIND.get(str(category), "other")


def _measured(value: object) -> int | float | None:
    """A measured, finite, non-negative number; anything else is unknown (``None``).

    The API parses every other value as unknown, so an unmeasured fact is sent as an explicit
    ``None`` rather than a guess.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return value


def _count(value: object) -> int | None:
    """A non-negative whole count, or ``None``."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _bounded_counts(
    section: object, by_label: tuple[str, ...], counts: tuple[str, ...]
) -> dict[str, Any]:
    """``section``'s counts by label and plain counts, bounded; anything else is dropped."""
    if not isinstance(section, Mapping):
        section = {}
    out: dict[str, Any] = {}
    for key in by_label:
        raw = section.get(key)
        labelled: dict[str, int] = {}
        if isinstance(raw, Mapping):
            for label, value in sorted(
                (item for item in raw.items() if isinstance(item[0], str)), key=lambda x: x[0]
            ):
                count = _count(value)
                if count is None or len(label) > _LABEL_MAX_CHARS:
                    continue
                if len(labelled) >= _LABELS_MAX:
                    break
                labelled[label] = count
        out[key] = labelled
    for key in counts:
        out[key] = _count(section.get(key))
    return out


def _learner_timing(admin: Mapping[str, Any] | None) -> dict[str, Any]:
    """The learner's timing holds from the engine's admin log, as bounded counts only."""
    return _bounded_counts(
        (admin or {}).get("intents"), _LEARNER_TIMING_BY_LABEL, _LEARNER_TIMING_COUNTS
    )


def _learner_voice(admin: Mapping[str, Any] | None) -> dict[str, Any]:
    """M032 S2: the learner's voice counts from the engine's admin log, bounded counts only."""
    return _bounded_counts(
        (admin or {}).get("voice"), _LEARNER_VOICE_BY_LABEL, _LEARNER_VOICE_COUNTS
    )


def _learner_probe_first(admin: Mapping[str, Any] | None) -> dict[str, Any]:
    """M032 S2P: the probe-first counts from the engine's admin log, bounded counts only."""
    return _bounded_counts(
        (admin or {}).get("probe_first"),
        _LEARNER_PROBE_FIRST_BY_LABEL,
        _LEARNER_PROBE_FIRST_COUNTS,
    )


def _learner_endings(admin: Mapping[str, Any] | None) -> dict[str, Any]:
    """M032 S3: the endings and abuse counts from the engine's admin log, bounded counts only."""
    return _bounded_counts(
        (admin or {}).get("endings"), _LEARNER_ENDINGS_BY_LABEL, _LEARNER_ENDINGS_COUNTS
    )


def _learner_followups(admin: Mapping[str, Any] | None) -> dict[str, Any]:
    """M032 S7L: the learner follow-ups' counts from the engine's admin log, bounded counts only."""
    return _bounded_counts((admin or {}).get("followups"), (), _LEARNER_FOLLOWUPS_COUNTS)


def _wrapup_counts(wrapup: Mapping[str, Any] | None) -> dict[str, Any]:
    """M032 S3.5 and SWEEP-26: the session's wrap-up counts, bounded counts only."""
    return _bounded_counts(wrapup, (), _WRAPUP_COUNTS)


@dataclass(frozen=True)
class PersonaChoice:
    """The persona card a session plays, and where the choice came from."""

    persona: RenderedPersona
    source: str
    seed: str

    @property
    def label(self) -> str:
        """``persona_id.variant``: an identifier-shaped label that is safe to log."""
        return f"{self.persona.id}.{self.persona.variant_id}"


def pick_persona_id(seed: str) -> str:
    """Deterministically map a session id to one of the persona ids."""
    digest = hashlib.sha256(f"r1-persona:{seed}".encode("utf-8")).digest()
    return PERSONA_IDS[int.from_bytes(digest[:4], "big") % len(PERSONA_IDS)]


def choose_persona(
    context: Mapping[str, Any], *, seed: str, candidate_first_name: str = ""
) -> PersonaChoice:
    """Pick the persona card: the attempt's own when valid, else a pick seeded by the session."""
    seed = seed or DEFAULT_SEED
    attempt = context.get("attempt")
    if isinstance(attempt, Mapping):
        persona_id = attempt.get("persona_id")
        if isinstance(persona_id, str) and persona_id in PERSONA_BY_ID:
            variant = attempt.get("persona_variant")
            rendered = resolve_persona(
                persona_id,
                variant=variant if isinstance(variant, str) and variant else "default",
                seed=seed,
                avoid_first_name=candidate_first_name,
            )
            return PersonaChoice(rendered, SOURCE_ATTEMPT, seed)
    rendered = resolve_persona(
        pick_persona_id(seed), variant="default", seed=seed, avoid_first_name=candidate_first_name
    )
    return PersonaChoice(rendered, SOURCE_SEED, seed)


@dataclass
class Reply:
    """What ONE LLM generation must do, decided in ``on_user_turn_completed``.

    ``plan`` is the role-play engine's decision for a learner turn, ``None`` for an
    interviewer phase.  ``entry`` is the candidate's own history entry, so the context
    builder can leave it out of the history and send it as the newest user message.
    """

    phase: str
    candidate_text: str
    entry: Mapping[str, Any] | None = None
    candidate_index: int | None = None
    plan: TurnPlan | None = None
    r_sec: float = 0.0
    recorded: bool = False
    guard_recorded: bool = False
    # A scripted sentence spoken after the model's reply in the same speech (M1: Christy's
    # L-TRANSITION-ASK after an answer before the role-play); "" for none.
    tail: str = ""
    # M032 S6 item 7: the tail is left out when the model's reply already ends with a question
    # (never two questions in one turn); False keeps it whatever the reply says.
    tail_optional: bool = False
    # M032 S5, the icebreaker plan (``r1_icebreaker``): the per-turn note that takes the
    # getting-to-know-you note's place ("" for the phase's own note), the line spoken INSTEAD of
    # a model call ("Take your time."; "" for a model reply), the line a reply with nothing usable
    # left falls back to (the current objective's question; "" for the guard's own fallback),
    # and the plan's decision itself (``IcebreakerJob``; labels only, kept to undo it when the
    # reply is never heard).
    note: str = ""
    scripted: str = ""
    fallback: str = ""
    job: Any = None
    # M032 S6 (SWEEP-28, review): "hold" or "repeat" for the icebreaker's scripted repair line
    # (L-IB-HOLD, "Of course. {question}"), so a line nobody heard gives its once-per-session
    # budget back; "" for every other reply.
    repair: str = ""
    # The line id of ``tail`` (M032 SWEEP-26: the wrap-up's L-WRAP-MORE is counted, and used up,
    # only when it is actually spoken); "" for none.
    tail_id: str = ""


def llm_messages(
    reply: Reply,
    persona: RenderedPersona,
    history: Sequence[Mapping[str, Any]],
    *,
    voice: bool | None = None,
    reactions: bool | None = None,
    reactions_v2: bool | None = None,
) -> list[dict[str, str]]:
    """The only messages the model may see for ``reply`` (the llm_node context filter).

    ``history`` is every transcript item so far (both voices, every phase); the filter
    picks from it by phase and voice.  The reminder is a ``system`` message because
    DeepSeek rejects ``developer``.  ``voice`` (M032 S5) is the session's reading of
    ``R1_INTERVIEWER_VOICE`` (``None`` reads it now): Christy's voice text in the prefix and
    the delivery rider on the note.  ``reactions`` (D3-ICE1) is its reading of
    ``R1_REACTION_VARIETY`` (``None`` reads it now): the reworded react clause in both.
    ``reactions_v2`` (D4-ICE-ECHO1) is its reading of ``R1_REACTION_VARIETY_V2``.
    """
    ordered = sorted(
        (item for item in history if item is not reply.entry),
        key=lambda item: item.get("seq", 0),
    )
    if reply.plan is not None:
        return assemble_messages(
            # M032 SWEEP-8, SWEEP-13, SWEEP-17 and SWEEP-21: the session's latched prefix
            # (byte-stable for the whole session).
            learner_prefix(
                persona,
                offer_realism=reply.plan.offer_realism,
                probe_first=reply.plan.probe_first,
                price_check=reply.plan.price_check,
                timeline_v2=reply.plan.timeline_v2,
            ),
            select_context(ordered, ROLEPLAY_PHASE),
            reply.candidate_text,
            reply.plan.reminder,
        )
    return assemble_messages(
        interviewer_prefix(voice=voice, reactions=reactions, reactions_v2=reactions_v2),
        select_context(ordered, reply.phase),
        reply.candidate_text,
        interviewer_reminder(
            reply.phase,
            note=reply.note or None,
            rider=voice,
            # M032 SWEEP-26: the wrap-up's sentences, by their rollback flags (read per reply).
            wrapup_answers=flag_on(FLAG_WRAPUP_ANSWERS),
            wrapup_one_mention=flag_on(FLAG_WRAPUP_ONE_MENTION),
            wrapup_next_round=flag_on(FLAG_WRAPUP_NEXT_ROUND),
            wrapup_next_steps=flag_on(FLAG_WRAPUP_NEXT_STEPS),
            reactions=reactions,
            reactions_v2=reactions_v2,
        ),
    )


def delta_text(item: Any) -> str:
    """The text an LLM stream item carries: a plain string or a ``ChatChunk`` delta."""
    if isinstance(item, str):
        return item
    delta = getattr(item, "delta", None)
    content = getattr(delta, "content", None)
    return content if isinstance(content, str) else ""


def fidelity_pins(choice: PersonaChoice) -> dict[str, Any]:
    """The persona and content pins every administration row carries."""
    persona = choice.persona
    return {
        "persona_id": persona.id,
        "persona_version": persona.version,
        "persona_variant": persona.variant_id,
        "persona_source": choice.source,
        "content_sha256": CONTENT_SHA256,
        "content_version": CONTENT_VERSION,
        "world_version": WORLD_VERSION,
    }


def fidelity_events(
    admin: Mapping[str, Any],
    pins: Mapping[str, Any],
    guard_trips: Sequence[Mapping[str, Any]] = (),
) -> list[dict[str, Any]]:
    """Admin-log rows (``event_type``, ``turn_index``, ``family_id``, ``payload``).

    ``admin`` is ``RolePlayEngine.admin_log``.  Every row names transcript turn indices and
    carries the pins; none holds candidate text, a commitment outcome or a score.

    The payload keys are the API parser's (see the module docstring): ``need`` and
    ``probed_turn`` for a reveal, ``slip_seconds`` for a delivery, ``roleplay_seconds`` for the
    time cue, ``amount_usd`` for a discount and ``kind`` for a guard hit.  The worker's own
    finer detail (delivery clocks, release turns, the guard rule) rides along under names the
    parser ignores.  Acknowledgement-format and repeat trips are hygiene, not leaks
    (``HYGIENE_CATEGORIES``, outside ``LEAK_CATEGORIES``), and the API counts EVERY guard row
    toward its three-hit limit, so they are not posted.
    """
    events: list[dict[str, Any]] = []
    turn_map = {
        item["roleplay_turn"]: item["transcript_turn"] for item in admin.get("turn_map", [])
    }

    def add(event_type: str, turn: int | None, family: str | None, detail: dict[str, Any]) -> None:
        events.append(
            {
                "event_type": event_type,
                "turn_index": turn,
                "family_id": family,
                "payload": {"pins": dict(pins), **detail},
            }
        )

    for need in admin.get("needs", []):
        if need.get("revealed_turn") is None:
            continue
        add(
            "need_revealed",
            need.get("revealed_transcript_turn"),
            None,
            {
                "need": need["topic"],
                "probed_turn": need.get("probe_transcript_turn"),
                "followup_turn": need.get("followup_transcript_turn"),
                "released_turn": need.get("released_transcript_turn"),
                "revealed_turn": need.get("revealed_transcript_turn"),
                "probe_source": need.get("probe_source"),
            },
        )
    schedule = admin.get("schedule", {})
    delivered = [m for m in schedule.get("moves", []) if m.get("status") == "delivered"]
    for move in sorted(delivered, key=lambda m: m.get("delivered_sec") or 0.0):
        mapped = _MOVE_EVENTS.get(move["id"])
        if mapped is None:
            continue
        event_type, family = mapped
        detail = {
            "move_id": move["id"],
            "slip_seconds": move.get("slip_sec"),
            "delivered_sec": move.get("delivered_sec"),
            "deadline_sec": move.get("deadline_sec"),
            "lateness_sec": move.get("lateness_sec"),
            "forced": move.get("forced"),
            "issued": move.get("issued"),
            "interruptions": move.get("interruptions"),
        }
        if event_type == "time_cue":
            # The learner's time cue is read as the role-play clock R at delivery (about 17:00).
            detail["roleplay_seconds"] = move.get("delivered_sec")
        add(event_type, move.get("transcript_turn"), family, detail)
    discounts = admin.get("tracker", {}).get("discounts", {})
    for offer in discounts.get("offers", []):
        add(
            "discount_detected",
            turn_map.get(offer.get("turn")),
            None,
            {
                "amount_usd": offer.get("usd"),
                "conditional": offer.get("conditional"),
                "value_before": offer.get("value_before"),
            },
        )
    for trip in guard_trips:
        if trip.get("category") in HYGIENE_CATEGORIES:
            continue
        add(
            "guard_hit",
            trip.get("turn_index"),
            None,
            {
                "kind": guard_kind(trip.get("category")),
                "rule": trip.get("rule"),
                "phase": trip.get("phase"),
                "digest": trip.get("digest"),
            },
        )
    return events


# M032 S6: what the transition and the icebreaker repairs add to the ``session_facts`` row (labels
# and counts only; the API's parser reads none of them, so the gate is unchanged).  ``start_by`` is
# "button" or "spoken"; ``pressed_during`` is "brief", "replay", "recap", "answer" or "wait".
EXTRA_FACT_KEYS = (
    "start_by",
    "pressed_during",
    "transition_recaps",
    "icebreaker_repeat_deferrals",
    "boundary_presence_lines",
    "ib_holds",
    "icebreaker_acks_held",
)


def session_facts_event(
    admin: Mapping[str, Any] | None,
    pins: Mapping[str, Any],
    *,
    roleplay_seconds: float,
    first_audio_p95_ms: float | None = None,
    reader: Mapping[str, Any] | None = None,
    extra: Mapping[str, Any] | None = None,
    wrapup: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The one ``session_facts`` row the plan 6.4 gate cannot pass without.

    Every key the API parser reads is present, so the row is the contract and not a subset of
    it.  A value is a measured, finite, non-negative number, or ``None`` when the worker does
    not measure it yet: the API parses ``None`` as unknown, which the gate fails closed on.
    Measured today: the role-play clock R at its end, the candidate's longest turn and, from
    the PR-4c latency tracker, ``first_audio_p95_ms`` (milliseconds, role-play turns only; the
    caller passes ``None`` when fewer than 8 turns were measured, so the gate says
    ``latency_unknown`` instead of reading a number nobody measured).

    ``reader`` is the turn reader's shadow record (M032 S4): only its ``READER_FACT_KEYS`` are
    added, and only when it ran, so a session without it posts exactly the row of before.
    ``extra`` (M032 S6) adds only its ``EXTRA_FACT_KEYS``, and only those it has, so a session with
    the repairs off posts exactly the row of before.
    """
    communication = (admin or {}).get("communication", {})
    # The engine starts the longest turn at 0.0 and only raises it for a turn whose speaking
    # time it was given; a real turn is never 0.0 s, so 0.0 means "never measured".
    longest = _measured(communication.get("longest_candidate_turn_sec")) or None
    facts = {
        "roleplay_seconds": _measured(round(float(roleplay_seconds), 1)),
        "talk_share_pct": None,
        "longest_monologue_seconds": longest,
        "barge_in_count": None,
        "question_count": None,
        "interruption_count": None,
        "first_audio_p95_ms": _measured(first_audio_p95_ms),
    }
    shadow = {key: reader[key] for key in READER_FACT_KEYS if key in (reader or {})}
    added = {key: extra[key] for key in EXTRA_FACT_KEYS if key in (extra or {})}
    return {
        "event_type": "session_facts",
        "turn_index": None,
        "family_id": None,
        "payload": {
            "pins": dict(pins),
            **facts,
            "learner_timing": _learner_timing(admin),
            "learner_voice": _learner_voice(admin),
            "learner_probe_first": _learner_probe_first(admin),
            "learner_endings": _learner_endings(admin),
            "learner_followups": _learner_followups(admin),
            "wrapup": _wrapup_counts(wrapup),
            **shadow,
            **added,
        },
    }
