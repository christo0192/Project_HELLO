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
import r1_negotiation
import r1_personas
import r1_prompts
import r1_scheduler
import r1_script
import r1_world

# 2: the icebreaker's interviewer note (the model may not start or announce the role-play).
# 3: R1-Q learner voice: no verbatim deflection, public backstory, speaking-style prefix,
#    no "answer exactly" stall rule, 3-variant filler and fallback rotations.
# 4: R1-Q probe-driven disclosure: a hint layer per need (first probe), the deep need handed
#    over as facts plus stems on the turn that asks, the first-probe and deep reminder lines.
# 5: R1-Q intent-voiced moves: every owed objection carries a brief, must-say figures, delivery
#    markers and three scripted variants (the model voices it, the variants are the fallback);
#    Q-A and Q-B became curiosity topics; deadlines F2 450 / F1 570; the early-farewell redirect
#    has three scripted openers; PLAN_VERSION 2.
# 6: R1-Q negotiation: graded commitment with stall-reason evidence, the MEDIUM line's call slot,
#    stall reasons / e-mail yes / call question as intents, the price counter by situation, the
#    WEAK line at most once (a reaction before the 13:00 stall), offer-on-the-table and
#    check-in notes, "pleasant surprise" only on a new offer.
# 7: R1-Q round 1 review fixes: the reaction notes say "how it lands for you" and never repeat a
#    course detail (guard-safe), the anchor reacts to a price already on the table, the filler
#    falls back to a one-word hum, and the next-step / e-mail-yield notes.
# 8: R1-Q round 2 review fixes: the reached anchor (a price at or below $7,000 already on the
#    table) asks what the price includes instead of "is that the final price?" (the counter owns
#    that question) and names the amount in every variant.
# 9: merge of origin/main (R1-Q PR-B #369) into the learner branch: PR-B's revision 3 joins 3..8
#    above (L-NO-FEEDBACK is one short refusal that does not name the hiring team, L-CLOSE is the
#    one mention of who reviews the interview; the wrap-up reply note forbids a goodbye).
# 10: R1-Q learner iteration 1 (owner decisions of 2026-10-08): the learner no longer teaches
#    itself "hmm"/"honestly" (prefix, scripted lines, hints, fillers; a rotating opening-style note
#    and the guard's style rules), a warm confirmation after a booked call (never a new doubt), the
#    decision maker on the public card and in a note, the $7,000 anchor is never an offer, "I can
#    check with my manager" grants nothing, the time cue is the learner's own next call.
CONTENT_REVISION = 10


def _persona_manifest(persona: r1_personas.Persona) -> dict[str, Any]:
    return {
        "version": persona.version,
        "label": persona.label,
        "age": persona.age,
        "profile": persona.profile,
        "decision_maker": persona.decision_maker,
        "prior_learning": persona.prior_learning,
        "backstory": list(persona.backstory),
        "needs": [
            {
                "topic": need.topic,
                "surface": need.surface,
                "hint": need.hint,
                "deep": need.deep,
                "facts": list(need.facts),
                "stems": list(need.stems),
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
    intent_sample = r1_scheduler.SPEC_BY_ID[r1_scheduler.F1_ANCHOR]
    return {
        "revision": CONTENT_REVISION,
        "world": {"version": r1_world.WORLD_VERSION, "sha256": r1_world.WORLD_SHA256},
        "personas": {p.id: _persona_manifest(p) for p in r1_personas.PERSONAS},
        "script": {
            "interviewer_name": r1_script.INTERVIEWER_NAME,
            "exit_cue": r1_script.EXIT_CUE,
            "lines": dict(r1_script.LINES),
            "learner_filler_variants": list(r1_script.LEARNER_FILLER_VARIANTS),
            "learner_filler_short": r1_script.LEARNER_FILLER_SHORT,
        },
        "learner_policy": r1_world.LEARNER_POLICY,
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
                    "brief": spec.brief,
                    "must_say": list(spec.must_say),
                    "markers": [list(group) for group in spec.markers],
                    "variants": list(spec.variants),
                }
                for spec in r1_scheduler.PLAN
            ],
            "redirect_openers": list(r1_scheduler.REDIRECT_OPENERS),
            "redirect_brief": r1_scheduler.REDIRECT_BRIEF,
            "curiosity_topics": [list(item) for item in r1_scheduler.CURIOSITY_TOPICS],
            "constants": {
                "slip_limit_sec": r1_scheduler.SLIP_LIMIT_SEC,
                "spacing_turns": r1_scheduler.SPACING_TURNS,
                "idle_gap_turns": r1_scheduler.IDLE_GAP_TURNS,
                "substantive_answer_words": r1_scheduler.SUBSTANTIVE_ANSWER_WORDS,
                "push_patience_turns": r1_scheduler.PUSH_PATIENCE_TURNS,
                "curiosity_every": r1_scheduler.CURIOSITY_EVERY,
                "f3_fallback_open_sec": r1_scheduler.F3_FALLBACK_OPEN_SEC,
                "time_cue_sec": r1_scheduler.TIME_CUE_SEC,
                "early_close_before_sec": r1_scheduler.EARLY_CLOSE_BEFORE_SEC,
            },
        },
        "negotiation": {
            "specs": [
                {
                    "id": spec.id,
                    "kind": spec.kind,
                    "reason": spec.reason,
                    "brief": spec.brief,
                    "markers": [list(group) for group in spec.markers],
                    "variants": list(spec.variants),
                }
                for spec in r1_negotiation.SPECS
            ],
            "counters": [
                {"id": item.id, "brief": item.brief, "variants": list(item.variants)}
                for item in r1_negotiation.COUNTERS
            ],
            "commit_reaction_brief": r1_negotiation.COMMIT_REACTION_BRIEF,
            "anchor_after_offer": [
                {
                    "id": item.id,
                    "brief": item.brief,
                    "must_say": list(item.must_say),
                    "variants": list(item.variants),
                }
                for item in (
                    r1_negotiation.anchor_after_offer(8500),
                    r1_negotiation.anchor_after_offer(7000),
                    r1_negotiation.anchor_after_offer(6500),
                )
            ],
            "reasons": list(r1_negotiation.REASONS),
            "constants": {
                "max_stall_rounds": r1_negotiation.MAX_STALL_ROUNDS,
                "anchor_usd": r1_negotiation.ANCHOR_USD,
                "min_net_usd": r1_negotiation.MIN_NET_USD,
                "preferred_time": r1_negotiation.PREFERRED_TIME,
                "moved_day": r1_negotiation.MOVED_DAY,
            },
        },
        "commitment": {
            "lines": {level.name: text for level, text in r1_commitment.COMMITMENT_LINES.items()},
            "default_slot": r1_commitment.DEFAULT_SLOT,
            "moved_line": r1_commitment.MEDIUM_MOVED_LINE,
            "permitted_r_sec": r1_commitment.COMMIT_PERMITTED_R_SEC,
            "stall_r_sec": r1_commitment.COMMIT_STALL_R_SEC,
            "discount_cap_usd": r1_commitment.DISCOUNT_CAP_USD,
            "mask": r1_commitment.MASK_PLACEHOLDER,
        },
        "guard": {
            "fallback": r1_guard.FALLBACK_REPLY,
            "fallback_replies": list(r1_guard.FALLBACK_REPLIES),
            "no_feedback": r1_guard.NO_FEEDBACK_LINE,
            "contact": r1_guard.CONTACT_REPLACEMENT,
            "neutral_acks": list(r1_guard.NEUTRAL_ACKS),
            "anchor_replacement": r1_guard.ANCHOR_REPLACEMENT,
            "gratitude_replacement": r1_guard.GRATITUDE_REPLACEMENT,
            "confirm_fallbacks": list(r1_guard.CONFIRM_FALLBACKS),
            "style": {
                "tic_window": r1_guard.STYLE_TIC_WINDOW,
                "opener_window": r1_guard.STYLE_OPENER_WINDOW,
                "max_chars": r1_guard.STYLE_MAX_CHARS,
            },
            "reply_word_cap": r1_guard.REPLY_WORD_CAP,
            "ack_word_cap": r1_guard.ACK_WORD_CAP,
            "flag_threshold": r1_guard.HIT_FLAG_THRESHOLD,
        },
        "prompts": {
            "interviewer_prefix": r1_prompts.interviewer_prefix(),
            "wrapup_note": r1_prompts.WRAPUP_NOTE,
            "wrapup_reminder": r1_prompts.WRAPUP_REMINDER,
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
            "intent_reminder_sample": r1_prompts.turn_reminder(
                sample,
                r_sec=0,
                first_probe_topics=("H1",),
                monologue_sec=61,
                character_break=True,
                price_wrap=True,
                intent_brief=intent_sample.brief,
                must_say=intent_sample.must_say,
                intent_forced=True,
            ),
            "curiosity_reminder_sample": r1_prompts.turn_reminder(
                sample, r_sec=0, curiosity=r1_scheduler.CURIOSITY_TOPICS[0][1]
            ),
            "negotiation_reminder_sample": r1_prompts.turn_reminder(
                sample,
                r_sec=0,
                price_wrap=True,
                offer_usd=8500,
                new_offer_usd=8500,
                notes=(r1_prompts.RESOLVED_NOTE, r1_prompts.CHECKIN_NOTE),
            ),
            "reaction_only_sample": r1_prompts.turn_reminder(sample, r_sec=0, reaction_only=True),
            "confirm_reminder_sample": r1_prompts.turn_reminder(
                sample, r_sec=0, confirm=True, style_note=r1_prompts.STYLE_NOTES[0]
            ),
            "style_reminder_sample": r1_prompts.turn_reminder(
                sample, r_sec=0, style_note=r1_prompts.STYLE_NOTES[1]
            ),
            "style_notes": list(r1_prompts.STYLE_NOTES),
            "confirm_note": r1_prompts.CONFIRM_NOTE,
            "decider_asked_note": r1_prompts.DECIDER_ASKED_NOTE.format(
                answer=sample.decider_answer
            ),
            "anchor_not_offered_note": r1_prompts.ANCHOR_NOT_OFFERED_NOTE,
            "try_not_granted_note": r1_prompts.TRY_NOT_GRANTED_NOTE,
            "character_break_note": r1_prompts.CHARACTER_BREAK_NOTE,
            "intent_price_note": r1_prompts.INTENT_PRICE_NOTE,
            "price_wrap_note": r1_prompts.PRICE_WRAP_NOTE,
            "offer_on_table_note": r1_prompts.OFFER_ON_TABLE_NOTE,
            "new_offer_note": r1_prompts.NEW_OFFER_NOTE,
            "resolved_note": r1_prompts.RESOLVED_NOTE,
            "checkin_note": r1_prompts.CHECKIN_NOTE,
            "checkin_done_note": r1_prompts.CHECKIN_DONE_NOTE,
            "email_again_note": r1_prompts.EMAIL_AGAIN_NOTE,
            "email_offer_note": r1_prompts.EMAIL_OFFER_NOTE,
            "next_step_proposed_note": r1_prompts.NEXT_STEP_PROPOSED_NOTE,
            "react_how_it_lands": r1_prompts.REACT_HOW_IT_LANDS,
            "reaction_only_note": r1_prompts.REACTION_ONLY_NOTE,
            "forced_note": r1_prompts.FORCED_NOTE,
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
