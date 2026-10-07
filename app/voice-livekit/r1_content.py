"""R1 content package manifest and SHA-256 pin.

The reviewed, SHA-pinned content package of plan 5.2 and 5.4: every text the role-play
speaks or prompts with (world facts, persona cards, the learner's scripted lines, the
commitment lines, the guard's replacement lines and the prompt prefixes and reminder
templates) is serialised into one canonical manifest and hashed.

* ``CONTENT_SHA256`` is the 64-hex digest the attempt row can store in
  ``interview_round_attempts.content_sha``.
* ``CONTENT_VERSION`` is a short human label that embeds the first 12 hex characters.
* ``tests/test_r1_content_pin.py`` pins the digest.  Editing ANY pinned text changes it
  and fails that test until the change is reviewed and ``CONTENT_REVISION`` is bumped.

Detector regexes and scheduler logic are code, covered by their own tests; they are not
pinned here because they are not candidate- or model-visible text.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

import r1_commitment
import r1_guard
import r1_personas
import r1_prompts
import r1_scheduler
import r1_script
import r1_world

# 2: the icebreaker's interviewer note (the model may not start or announce the role-play).
CONTENT_REVISION = 2


def _persona_manifest(persona: r1_personas.Persona) -> dict[str, Any]:
    return {
        "version": persona.version,
        "label": persona.label,
        "age": persona.age,
        "profile": persona.profile,
        "decision_maker": persona.decision_maker,
        "prior_learning": persona.prior_learning,
        "needs": [
            {
                "topic": need.topic,
                "surface": need.surface,
                "deep": need.deep,
                "markers": list(need.markers),
            }
            for need in persona.needs
        ],
        "variants": [
            {
                "id": v.id,
                "first_name": v.first_name,
                "last_name": v.last_name,
                "city": v.city,
                "employer": v.employer,
            }
            for v in persona.variants
        ],
    }


def manifest() -> dict[str, Any]:
    """The canonical content manifest (JSON-serialisable, key order irrelevant)."""
    sample = r1_personas.resolve_persona("p1_career_switcher", variant="v1")
    return {
        "revision": CONTENT_REVISION,
        "world": {"version": r1_world.WORLD_VERSION, "sha256": r1_world.WORLD_SHA256},
        "personas": {p.id: _persona_manifest(p) for p in r1_personas.PERSONAS},
        "script": {
            "interviewer_name": r1_script.INTERVIEWER_NAME,
            "exit_cue": r1_script.EXIT_CUE,
            "lines": dict(r1_script.LINES),
        },
        "state_names": dict(r1_personas.STATE_NAMES),
        "public_answers": [list(item) for item in r1_personas.PUBLIC_ANSWERS],
        "topic_labels": dict(r1_personas.TOPIC_LABELS),
        "scheduler": {
            "plan_version": r1_scheduler.PLAN_VERSION,
            "moves": [
                {
                    "id": spec.id,
                    "family": spec.family,
                    "role": spec.role,
                    "line": spec.line,
                    "deadline_sec": spec.deadline_sec,
                }
                for spec in r1_scheduler.PLAN
            ],
            "oh_wait": r1_scheduler.OH_WAIT_PREFIX,
            "constants": {
                "slip_limit_sec": r1_scheduler.SLIP_LIMIT_SEC,
                "spacing_turns": r1_scheduler.SPACING_TURNS,
                "q_a_opens_sec": r1_scheduler.Q_A_OPENS_SEC,
                "f3_fallback_open_sec": r1_scheduler.F3_FALLBACK_OPEN_SEC,
                "time_cue_sec": r1_scheduler.TIME_CUE_SEC,
                "early_close_before_sec": r1_scheduler.EARLY_CLOSE_BEFORE_SEC,
            },
        },
        "commitment": {
            "lines": {level.name: text for level, text in r1_commitment.COMMITMENT_LINES.items()},
            "permitted_r_sec": r1_commitment.COMMIT_PERMITTED_R_SEC,
            "stall_r_sec": r1_commitment.COMMIT_STALL_R_SEC,
            "discount_cap_usd": r1_commitment.DISCOUNT_CAP_USD,
            "mask": r1_commitment.MASK_PLACEHOLDER,
        },
        "guard": {
            "fallback": r1_guard.FALLBACK_REPLY,
            "no_feedback": r1_guard.NO_FEEDBACK_LINE,
            "contact": r1_guard.CONTACT_REPLACEMENT,
            "neutral_acks": list(r1_guard.NEUTRAL_ACKS),
            "reply_word_cap": r1_guard.REPLY_WORD_CAP,
            "ack_word_cap": r1_guard.ACK_WORD_CAP,
            "flag_threshold": r1_guard.HIT_FLAG_THRESHOLD,
        },
        "prompts": {
            "interviewer_prefix": r1_prompts.interviewer_prefix(),
            "wrapup_note": r1_prompts.WRAPUP_NOTE,
            "getting_to_know_you_note": r1_prompts.GETTING_TO_KNOW_YOU_NOTE,
            "learner_prefixes": {
                f"{p.id}.{v.id}": r1_prompts.learner_prefix(r1_personas.resolve_persona(
                    p.id, variant=v.id
                ))
                for p in r1_personas.PERSONAS
                for v in p.variants
            },
            "turn_reminder_sample": r1_prompts.turn_reminder(
                sample,
                r_sec=0,
                first_probe_topics=("H1",),
                unlocked_topics=("H2",),
                monologue_sec=61,
                character_break=True,
            ),
            "ack_reminder_sample": r1_prompts.ack_reminder(
                sample,
                r_sec=0,
                first_probe_topics=("H1",),
                monologue_sec=61,
                character_break=True,
            ),
            "character_break_note": r1_prompts.CHARACTER_BREAK_NOTE,
        },
    }


def content_sha256() -> str:
    """SHA-256 (64 lowercase hex) of the canonical manifest."""
    canonical = json.dumps(
        manifest(), sort_keys=True, ensure_ascii=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(canonical).hexdigest()


CONTENT_SHA256 = content_sha256()
CONTENT_VERSION = f"r1-content-v{CONTENT_REVISION}+{CONTENT_SHA256[:12]}"
