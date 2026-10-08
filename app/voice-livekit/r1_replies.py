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
  set and fails when either side drifts.

No I/O, no logging, no clock and no candidate text is kept beyond what the caller passes in.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from r1_content import CONTENT_SHA256, CONTENT_VERSION
from r1_guard import ACK_FORMAT
from r1_personas import PERSONA_BY_ID, PERSONA_IDS, RenderedPersona, resolve_persona
from r1_prompts import (
    ROLEPLAY_PHASE,
    assemble_messages,
    interviewer_prefix,
    interviewer_reminder,
    learner_prefix,
    select_context,
)
from r1_roleplay import TurnPlan
from r1_world import WORLD_VERSION

SOURCE_ATTEMPT = "attempt"
SOURCE_SEED = "session_seed"
DEFAULT_SEED = "r1"

# The admin-log ``event_type`` CHECK set (migration 0117) has no slot for the neutral
# questions or the commitment stall, so those moves are logged but never posted.
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


def llm_messages(
    reply: Reply, persona: RenderedPersona, history: Sequence[Mapping[str, Any]]
) -> list[dict[str, str]]:
    """The only messages the model may see for ``reply`` (the llm_node context filter).

    ``history`` is every transcript item so far (both voices, every phase); the filter
    picks from it by phase and voice.  The reminder is a ``system`` message because
    DeepSeek rejects ``developer``.
    """
    ordered = sorted(
        (item for item in history if item is not reply.entry),
        key=lambda item: item.get("seq", 0),
    )
    if reply.plan is not None:
        return assemble_messages(
            learner_prefix(persona),
            select_context(ordered, ROLEPLAY_PHASE),
            reply.candidate_text,
            reply.plan.reminder,
        )
    return assemble_messages(
        interviewer_prefix(),
        select_context(ordered, reply.phase),
        reply.candidate_text,
        interviewer_reminder(reply.phase),
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
    parser ignores.  Acknowledgement-format trips are hygiene, not leaks (``LEAK_CATEGORIES``),
    and the API counts EVERY guard row toward its three-hit limit, so they are not posted.
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
            # The learner's time cue is read as the role-play clock R at delivery (about 11:00).
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
        if trip.get("category") == ACK_FORMAT:
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


def session_facts_event(
    admin: Mapping[str, Any] | None,
    pins: Mapping[str, Any],
    *,
    roleplay_seconds: float,
    first_audio_p95_ms: float | None = None,
) -> dict[str, Any]:
    """The one ``session_facts`` row the plan 6.4 gate cannot pass without.

    Every key the API parser reads is present, so the row is the contract and not a subset of
    it.  A value is a measured, finite, non-negative number, or ``None`` when the worker does
    not measure it yet: the API parses ``None`` as unknown, which the gate fails closed on.
    Measured today: the role-play clock R at its end, the candidate's longest turn and, from
    the PR-4c latency tracker, ``first_audio_p95_ms`` (milliseconds, role-play turns only; the
    caller passes ``None`` when fewer than 8 turns were measured, so the gate says
    ``latency_unknown`` instead of reading a number nobody measured).
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
    return {
        "event_type": "session_facts",
        "turn_index": None,
        "family_id": None,
        "payload": {"pins": dict(pins), **facts},
    }
