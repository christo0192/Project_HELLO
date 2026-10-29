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
import r1_text
import r1_tracker
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
# 11: R1-Q learner iteration 2 (the second live sweep): the learner asks a question only now and
#    then (prefix, a one-question-per-reply guard and a question diet for free replies), "a stretch"
#    and "what would that call involve" are used once per call, the price notes know where the price
#    stands (never "a stretch" at or below the $7,000 ask), the figures are listed without quote
#    marks, the anchor is told to the advisor (no "you say"), a calm reached anchor, a call-back
#    WEAK line for a call ask and a MEDIUM line that books without a slot, the F4 push never says
#    the decision maker dislikes calls, hold / answered-facts notes, wider F3 / F4 delivery markers.
# 12: R1-Q learner iteration 3 (the third live sweep): the MEDIUM line books only a slot the learner
#    can stand behind (stale, refused and absent slots lead to a deferred line; a firm "I'd rather
#    reach out myself" downgrades a booking), an e-mailed WEAK line, a thin or pressing advisor
#    caps the grade at WEAK, the money stall yields once cost is said to be secondary, an "e-mail
#    yes" spec for an offer that listed its contents, an anchor below $7,000 is "even below the
#    $7,000", the unchanged-price replacement, three "thinking" fallbacks, a once-per-call
#    concession tag, a hollow-advisor note (no second goodbye), the H3 first-probe reminder (answer
#    only the part that was asked) and three wordings of the time cue.
# 13: R1-Q final review round 1 (the third live sweep and two Opus reviews): a repeated "That's" is
#    swapped for "It's" and never cut to a fragment (prefix and style note ask for varied
#    openers), one decider only (the prefix says nobody else has a say and the decision is never
#    the learner's alone), a quota and a spacing window for the decider stall, the "get back to
#    you" closer and the "still more than I planned for" line (PHRASE_QUOTA, PHRASE_WINDOW), the
#    STRONG line names no plan, a persona-neutral time cue (scripted variants, wrap-up markers), a
#    deep layer given back when its reply missed it (MAX_DEEP_MISSES) and a wait window for STRONG
#    (WAIT_RECENT_TURNS).
# 14: R1-Q ship restore (owner decision 2026-10-09: ship only what is proven better than
#    production): the guard rules that were worse than production are deleted (the hearsay, the
#    "better" and the decider rules, the before-I-go strip) together with their canned lines
#    (ANCHOR_HEARD_REPLACEMENT, ANCHOR_HEARD_BELOW, PRICE_UNCHANGED_REPLACEMENT); no other pinned
#    text changed.
# 15: the 20-minute role-play (owner decision 2026-10-16): L-TRANSITION announces twenty minutes and
#    the goal (convince the learner), L-OPEN says about thirty minutes and a twenty-minute
#    role-play, and the owed-move deadlines stretch to the longer call (F3 430 / F2 640 / F1 810 /
#    F4 930).
# 16: owner test 7f2a25e6 keyword misfires: the one question about the next step is worded by the
#    advisor's ask ("what would I be signing up for / what's included" after an enrolment ask, "the
#    call" only after a call ask; N_QUESTION_ENROL_BRIEF / N_QUESTION_ENROL_VARIANTS) and its
#    markers also accept "include", "signing up" and "would I get"; a challenge to the learner's own
#    words or questions is answered plainly first (CHALLENGE_NOTE); an out-of-role "end the call"
#    request gets the interviewer's one-off question (L-ASIDE-END: say "end the interview" to stop,
#    otherwise carry on) and, on end words, a short close (L-END-CLOSE).  Voice barge-in (owner
#    decision 2026-10-28): after the advisor cut the learner off, an owed move waits one turn and is
#    answered first (INTERRUPTED_NOTE), and a lone backchannel that cut her gets her point finished
#    in one sentence (BACKCHANNEL_CUT_NOTE), and one that only asked her to say it again ("Sorry?",
#    "Pardon?") or checked she was there gets it said again (CUT_REPEAT_NOTE).
# 17: owner test 1eb18cd4 (owner decision 2026-10-29): a confirmed out-of-role stop ends the
#    role-play, not the interview, so L-EXIT and the interviewer's wrap-up follow it and the short
#    close that ended the whole session (L-END-CLOSE) is deleted.  No other pinned text changed
#    (L-ASIDE-END is unchanged).
CONTENT_REVISION = 17


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
            "answered_labels": [list(item) for item in r1_scheduler.ANSWERED_LABELS],
            "time_cue_alternatives": list(r1_scheduler.TIME_CUE_BRIEF_ALTERNATIVES),
            "f4_push_call_suffix": r1_scheduler.F4_PUSH_CALL_SUFFIX,
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
            "question_enrol": {
                "brief": r1_negotiation.N_QUESTION_ENROL_BRIEF,
                "variants": list(r1_negotiation.N_QUESTION_ENROL_VARIANTS),
            },
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
                "defer_recent_turns": r1_negotiation.DEFER_RECENT_TURNS,
                "slot_recent_turns": r1_negotiation.SLOT_RECENT_TURNS,
                "wait_recent_turns": r1_negotiation.WAIT_RECENT_TURNS,
            },
        },
        "tracker": {
            "max_deep_offers": r1_tracker.MAX_DEEP_OFFERS,
            "max_deep_misses": r1_tracker.MAX_DEEP_MISSES,
        },
        "commitment": {
            "lines": {level.name: text for level, text in r1_commitment.COMMITMENT_LINES.items()},
            "default_slot": r1_commitment.DEFAULT_SLOT,
            "moved_line": r1_commitment.MEDIUM_MOVED_LINE,
            "defer_line": r1_commitment.MEDIUM_DEFER_LINE,
            "weak_call_line": r1_commitment.WEAK_CALL_LINE,
            "weak_email_done_line": r1_commitment.WEAK_EMAIL_DONE_LINE,
            "thin_advisor_mean_words": r1_commitment.THIN_ADVISOR_MEAN_WORDS,
            "thin_min_turns": r1_commitment.THIN_MIN_TURNS,
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
                "phrase_quota": dict(r1_guard.PHRASE_QUOTA),
                "phrase_window": dict(r1_guard.PHRASE_WINDOW),
                "question_diet_window": r1_guard.QUESTION_DIET_WINDOW,
                "thin_reply_words": r1_guard.THIN_REPLY_WORDS,
                "stretch_alternatives": list(r1_text.STRETCH_ALTERNATIVES),
                "hollow_max_words": r1_text.HOLLOW_MAX_WORDS,
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
            "h3_first_probe_sample": r1_prompts.turn_reminder(
                sample, r_sec=0, first_probe_topics=("H3",)
            ),
            "style_notes": list(r1_prompts.STYLE_NOTES),
            "hollow_note": r1_prompts.HOLLOW_NOTE,
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
            "offer_met_note": r1_prompts.OFFER_MET_NOTE,
            "price_met_note": r1_prompts.PRICE_MET_NOTE,
            "price_unchanged_note": r1_prompts.PRICE_UNCHANGED_NOTE,
            "hold_note": r1_prompts.HOLD_NOTE,
            "answered_note": r1_prompts.ANSWERED_NOTE,
            "stretch_used_note": r1_prompts.STRETCH_USED_NOTE,
            "template_used_note": r1_prompts.TEMPLATE_USED_NOTE,
            "next_step_note": r1_prompts.NEXT_STEP_NOTE,
            "new_offer_note": r1_prompts.NEW_OFFER_NOTE,
            "resolved_note": r1_prompts.RESOLVED_NOTE,
            "checkin_note": r1_prompts.CHECKIN_NOTE,
            "checkin_done_note": r1_prompts.CHECKIN_DONE_NOTE,
            "challenge_note": r1_prompts.CHALLENGE_NOTE,
            "interrupted_note": r1_prompts.INTERRUPTED_NOTE,
            "backchannel_cut_note": r1_prompts.BACKCHANNEL_CUT_NOTE,
            "cut_repeat_note": r1_prompts.CUT_REPEAT_NOTE,
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
