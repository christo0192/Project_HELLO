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
* ``fidelity_events``: the trusted administration rows (``/api/internal/r1/admin-log``) that
  carry the persona and content pins, the moves delivered with their transcript turn and the
  guard trips.  The commitment outcome is deliberately NOT part of them: plan 5.8 makes it a
  logged, non-evidence fact, and the scorer reads the administration log.

No I/O, no logging, no clock and no candidate text is kept beyond what the caller passes in.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from r1_content import CONTENT_SHA256, CONTENT_VERSION
from r1_personas import PERSONA_BY_ID, PERSONA_IDS, RenderedPersona, resolve_persona
from r1_prompts import (
    ROLEPLAY_PHASE,
    assemble_messages,
    interviewer_prefix,
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
        None,
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
                "topic": need["topic"],
                "probe_turn": need.get("probe_transcript_turn"),
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
        add(
            event_type,
            move.get("transcript_turn"),
            family,
            {
                "move_id": move["id"],
                "delivered_sec": move.get("delivered_sec"),
                "deadline_sec": move.get("deadline_sec"),
                "slip_sec": move.get("slip_sec"),
                "lateness_sec": move.get("lateness_sec"),
                "forced": move.get("forced"),
                "issued": move.get("issued"),
                "interruptions": move.get("interruptions"),
            },
        )
    discounts = admin.get("tracker", {}).get("discounts", {})
    for offer in discounts.get("offers", []):
        add(
            "discount_detected",
            turn_map.get(offer.get("turn")),
            None,
            {
                "usd": offer.get("usd"),
                "conditional": offer.get("conditional"),
                "value_before": offer.get("value_before"),
            },
        )
    for trip in guard_trips:
        add(
            "guard_hit",
            trip.get("turn_index"),
            None,
            {
                "category": trip.get("category"),
                "rule": trip.get("rule"),
                "phase": trip.get("phase"),
                "digest": trip.get("digest"),
            },
        )
    return events
