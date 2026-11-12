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
import r1_end_intent
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
# 18: owner decision 2026-10-30 (meaning-based end detection): the end-intent classifier's system
#    prompt and its two context lines (r1_end_intent: END_INTENT_SYSTEM, ROLEPLAY_CONTEXT,
#    AFTER_ASIDE_CONTEXT) with the prefilter window and the labels.  No spoken line changed: the
#    brief repeat replays L-TRANSITION and the post-pickup brief request plays L-ASIDE-COACH.
#    Reviewed fix, same unreleased revision: the prompt's "no" also covers talk about the learner's
#    OWN job interviews, and its tie-break names THIS interview with Christy or this role-play.
# 19: owner test 8f5bfefc (the learner asked for $7,000 after the advisor offered $3,000): the F1
#    anchor for a figure under $7,000 that was not read as a price (``anchor_after_unclear_low``:
#    react to that number and ask what the total would be, never ask for more) joins the
#    manifest.  No other pinned text changed.
# 20: owner and manager decisions of 2026-11-03 (mock call aa166f09): L-OPEN and L-TRANSITION say
#    "up to twenty minutes" (M3); L-TRANSITION ends by asking whether to start or take questions
#    first, and the new transition lines (L-TRANSITION-ASK, L-TRANSITION-REASK,
#    L-TRANSITION-REASK-2, L-TRANSITION-STEER) and the interviewer's transition note
#    (r1_prompts.TRANSITION_REMINDER) join the manifest (M1: no auto-start); the interviewer
#    prefix no longer calls its facts an "approved list" and the wrap-up note takes a complaint
#    gracefully without a second hiring-team mention (A4).  Leaving the role-play is consensual
#    (M2): the interviewer's offer to wrap up (L-ASIDE-WRAP), her line when the candidate keeps
#    going (L-ASIDE-WRAP-RESUME) and the learner's closing at the end of the time (L-TIME-UP) join
#    the scripted lines.  Same revision, the learner (S03): the card says the advisor is calling her
#    back and gives her workplace, her job and a round salary per persona (M4, L4); three more
#    curiosity topics (L1); the check-in-done note never closes the call (L1); the intent template
#    has two shapes and two lengths and answers a dig first (L2); the F4 push refers back to a
#    decision maker already named (L7), a free reply does not name them again, and a monthly figure
#    above the card's budget is never "workable" (L5: BUDGET_OVER_NOTE, BUDGET_REPLACEMENT).
# 21: M032 S1, learner timing + memory (owner decisions D-M032-1 and D-M032-4, rollback flags
#    R1_NATURAL_TIMING, R1_RESPOND_FIRST, R1_CONCERN_LEDGER, R1_SPLIT_REPLAN).  The idle path's
#    longer quiet stretch while the plan has slack (IDLE_GAP_SLACK_TURNS) and the learner's new
#    notes join the manifest: she responds first to an offer (OFFER_MADE_NOTE), a question put to
#    her (ASKED_DIRECTLY_NOTE), an answer to her own question (ANSWERED_YOU_NOTE) and time given
#    (PRESSURE_EASED_NOTE), and a concern she already voiced is not voiced again
#    (CONCERN_LABELS, VOICED_CONCERNS_NOTE, HOLLOW_CONCERNS_NOTE).  SWEEP-1 (flag
#    R1_PUSH_AFTER_REACTION): an unforced push waits a turn after the advisor answered its
#    primary, and that reply reacts to the answer first (PUSH_REACT_NOTE).  No scripted line,
#    brief, marker or variant changed; the graded moves, their deadlines and the forced path are
#    as before.  After the S1 review PUSH_REACT_NOTE and ANSWERED_YOU_NOTE say how it lands as a
#    feeling (never the advisor's promises as facts) and VOICED_CONCERNS_ASKED_NOTE lets the
#    ledger yield to a direct question.
# 22: M032 S2, learner voice (owner decisions D-M032-4 and D-M032-7; rollback flags
#    R1_LEARNER_VOICE_V2, R1_NO_COMMIT_LEDGER, R1_OFFER_TERMS, R1_ACK_TURN_NOTE, R1_TIC_V2,
#    R1_OFFER_REALISM, R1_REPLY_LENGTH).  New per-turn texts join the manifest, each beside the text
#    it replaces while its flag is on: the intent shapes (an owed point grows out of what the
#    advisor said, or comes as an honest change of subject; a price shape), REACT_SPECIFIC and the
#    free-reply line, the delivery rider, the v2 opening-style notes and the intent opener notes,
#    the F3 and F2 worries with statement fallbacks and the pre-empted suffix, the anti-validation,
#    hinge and verdict notes, the coach-aside re-entry note, the S1 notes without "how it lands",
#    SWEEP-5's single offer notes and offer-terms note, SWEEP-3's not-today notes, F4-PRIMARY's
#    "like I said" suffix and variants and the stall briefs without "before you agree to anything",
#    SWEEP-11's acknowledgement notes, SWEEP-12's soft-tic note, curiosity line and rotated labels,
#    SWEEP-13's careful-buyer notes and the prefix sentence it latches, SWEEP-14's length lines and
#    BUDGET_REPLACEMENT without "though".  No graded meaning, marker, must-say, deadline or
#    scripted line of the release before changed; with every flag off the reminders are the same.
#    After the S2 review (still revision 22, unreleased): OFFER_TERMS_IN_PARTS for a split that is
#    not monthly, the new-topic shape without "something else is on your mind", and the pre-empted
#    labels keyed by what the advisor said ("the schedule", "how the classes are run").
# 23: M032 S2P, probe first (owner decision D-M032-7; rollback flags R1_PROBE_FIRST,
#    R1_OFFER_READER_V2, R1_COUNTER_V2, R1_PRICE_CONFLICT).  The card's course knowledge and the
#    prefix's course sentence and "never correct the advisor" clause have a second wording each
#    (latched per session); the probes (price, again, clarifying, time), F2's and F4's texts without
#    a course fact, the anchors that react to the advisor's number or check the website's (stated,
#    stated with the conflict check, check, free) and the objective offer-anchor briefs, the v2
#    counters (met, far below, hinge-free short and refused, conflict, her number), N-PRICE-FIRST
#    and the first-time money briefs, the early met-price, figure-challenge, conflict, rise and
#    price-reflex notes, the guard's length probes and the two redirect lines (L-REDIRECT-PRICE,
#    L-REDIRECT-TIME) join the manifest.  The world's LEARNER_POLICY was reworded (world revision
#    3).  Markers, deadlines and the scorer's facts are unchanged; with every flag off the card, the
#    prefix and the reminders are the release before.
#    After the S2P review (still revision 23, unreleased): the first money stall about a price the
#    advisor named has its own three variants, none with "still" (they rotate by seed).
# 24: M032 S3, endings and abuse (owner decisions D-M032-2, D-M032-3 and D-M032-4; rollback flags
#    R1_CLOSING_STATE, R1_EARLY_CLOSE_ASIDE, R1_ABUSE_HANGUP, R1_LATE_END_REQUEST, R1_WEAK_EMAIL_V2,
#    R1_COMMIT_REACTION_V2, R1_TIME_CUE_V2, R1_WRAPUP_DECLINE_V2, R1_WRAPUP_ANSWERS,
#    R1_WRAPUP_ONE_MENTION and R1_WRAPUP_NEXT_ROUND).  The early-close, last-point and hang-up
#    asides, the learner's hang-up line, the wrap-up's invitation (L-WRAP-MORE) and deflection
#    (L-FAQ-DEFER-WRAP) join the script; the wrap-up reminder's flagged sentences and the endings'
#    notes join the manifest (``_endings``).  Markers, deadlines, the scorer's facts and every text
#    of the release before are unchanged; with every flag off the reminders are the release before.
CONTENT_REVISION = 24


def _persona_manifest(persona: r1_personas.Persona) -> dict[str, Any]:
    return {
        "version": persona.version,
        "label": persona.label,
        "age": persona.age,
        "profile": persona.profile,
        "decision_maker": persona.decision_maker,
        "prior_learning": persona.prior_learning,
        "backstory": list(persona.backstory),
        "role": persona.role,
        "salary": persona.salary,
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
                "workplace": v.workplace,
            }
            for v in persona.variants
        ],
    }


def _learner_voice_v2(sample: r1_personas.RenderedPersona) -> dict[str, Any]:
    """M032 S2 (revision 22): every new learner text, and reminders rendered with the flags on."""
    p = r1_prompts
    worry = r1_scheduler.SPEC_BY_ID[r1_scheduler.F3_PRIMARY].worry
    return {
        "react_specific": p.REACT_SPECIFIC,
        "free_reply_note": p.FREE_REPLY_NOTE,
        "free_reply_note_v2": p.FREE_REPLY_NOTE_V2,
        "intent_answering_note": p.INTENT_ANSWERING_NOTE,
        "intent_shape_topic_fresh": p.INTENT_SHAPE_TOPIC_FRESH,
        "intent_shape_new_topic": p.INTENT_SHAPE_NEW_TOPIC,
        "intent_shape_price": p.INTENT_SHAPE_PRICE,
        "worry_line": p.WORRY_LINE,
        "delivery_rider_base": p.LEARNER_DELIVERY_RIDER_BASE,
        "delivery_rider": p.LEARNER_DELIVERY_RIDER,
        "style_notes_v2": list(p.STYLE_NOTES_V2),
        "intent_opener_notes": list(p.INTENT_OPENER_NOTES),
        "hinge_used_note": p.HINGE_USED_NOTE,
        "verdict_used_note": p.VERDICT_USED_NOTE,
        "not_answered_note": p.NOT_ANSWERED_NOTE,
        "coach_resume_note": p.COACH_RESUME_NOTE,
        "offer_made_note_v2": p.OFFER_MADE_NOTE_V2,
        "answered_you_note_v2": p.ANSWERED_YOU_NOTE_V2,
        "push_react_note_v2": p.PUSH_REACT_NOTE_V2,
        "new_offer_note_v2": p.NEW_OFFER_NOTE_V2,
        "new_offer_above_ask_note": p.NEW_OFFER_ABOVE_ASK_NOTE,
        "offer_on_table_note_v2": p.OFFER_ON_TABLE_NOTE_V2,
        "offer_met_note_v2": p.OFFER_MET_NOTE_V2,
        "offer_terms": [
            p.OFFER_TERMS_HEADER,
            p.OFFER_TERMS_INSTALMENTS,
            p.OFFER_TERMS_IN_PARTS,
            p.OFFER_TERMS_FREE_EXTRA,
        ],
        "implausible_notes": [p.IMPLAUSIBLE_PRICE_NOTE, p.IMPLAUSIBLE_FREE_NOTE],
        "not_today_reserved_note": p.NOT_TODAY_RESERVED_NOTE,
        "no_commit_intent_note": p.NO_COMMIT_INTENT_NOTE,
        "ack_turn_notes": [p.ACK_TURN_NOTE, p.ACK_TURN_CONCERNS_NOTE],
        "soft_tic_note": p.SOFT_TIC_NOTE,
        "curiosity_notes": [p.CURIOSITY_NOTE, p.CURIOSITY_NOTE_V2],
        "length_lines": [p.LENGTH_VERY_SHORT, p.LENGTH_ONE, p.LENGTH_ONE_OR_TWO, p.LENGTH_LONG],
        "prefix_offer_sentences": [p.PREFIX_OFFER_SENTENCE, p.PREFIX_OFFER_SENTENCE_V2],
        "learner_prefix_offer_realism_sample": p.learner_prefix(sample, offer_realism=True),
        "free_reminder_sample": p.turn_reminder(
            sample,
            r_sec=0,
            style_note=p.STYLE_NOTES_V2[1],
            curiosity=r1_scheduler.CURIOSITY_LABELS_V2["format"][0],
            voice_v2=True,
            length_note=p.LENGTH_ONE,
            curiosity_v2=True,
            price_wrap=True,
            offer_usd=8500,
            new_offer_usd=8500,
        ),
        "intent_reminder_sample": p.turn_reminder(
            sample,
            r_sec=0,
            intent_brief=worry,
            intent_forced=True,
            voice_v2=True,
            intent_join="topic_fresh",
            intent_worry=worry,
            style_note=p.INTENT_OPENER_NOTES[0],
        ),
        "confirm_reminder_sample": p.turn_reminder(
            sample, r_sec=0, confirm=True, style_note=p.STYLE_NOTES_V2[0], voice_v2=True
        ),
        "reaction_only_sample": p.turn_reminder(
            sample, r_sec=0, reaction_only=True, voice_v2=True
        ),
    }


def _anchor_entry(item: Any) -> dict[str, Any]:
    return {
        "id": item.id,
        "brief": item.brief,
        "must_say": list(item.must_say),
        "variants": list(item.variants),
    }


def _probe_first(sample: r1_personas.RenderedPersona) -> dict[str, Any]:
    """M032 S2P (revision 23): every new probe-first text, and the latched prefix with it on."""
    p = r1_prompts
    s = r1_scheduler
    n = r1_negotiation
    return {
        "card_course_knowledge": [
            r1_personas.CARD_COURSE_KNOWLEDGE,
            r1_personas.CARD_COURSE_KNOWLEDGE_V2,
        ],
        "prefix_course_sentences": [p.PREFIX_COURSE_SENTENCE, p.PREFIX_COURSE_SENTENCE_V2],
        "prefix_correct_clauses": [p.PREFIX_CORRECT_CLAUSE, p.PREFIX_CORRECT_CLAUSE_V2],
        "learner_prefix_probe_first_sample": p.learner_prefix(
            sample, offer_realism=True, probe_first=True, price_check=True
        ),
        "probes": [
            {
                "family": probe.family,
                "brief": probe.brief,
                "markers": [list(group) for group in probe.markers],
                "variants": list(probe.variants),
            }
            for probe in s.PROBES
        ],
        "f2_primary": {
            "brief": s.F2_PRIMARY_BRIEF_V2,
            "worry": s.F2_PRIMARY_WORRY_V2,
            "line": s.F2_PRIMARY_LINE_V2,
            "variants": list(s.F2_PRIMARY_VARIANTS_V2),
        },
        "f4_primary": {
            "brief": s.F4_PRIMARY_BRIEF_V2,
            "line": s.F4_PRIMARY_LINE_V2,
            "variants": list(s.F4_PRIMARY_VARIANTS_V2),
        },
        "anchors": [
            _anchor_entry(item)
            for item in (
                n.anchor_after_stated(9000),
                n.anchor_after_stated(10000),
                n.anchor_check(),
                n.anchor_after_free(),
                n.anchor_after_offer(8500, probe_first=True, counter_v2=True),
                n.anchor_after_offer(7000, probe_first=True, counter_v2=True),
                n.anchor_after_offer(6500, probe_first=True, counter_v2=True),
            )
        ],
        "counters_v2": [
            {"id": item.id, "brief": item.brief, "variants": list(item.variants)}
            for item in n.COUNTERS_V2
        ],
        "conflict_counter": {
            "brief": n.SITUATION_CONFLICT_BRIEF,
            "website_variants": list(n.SITUATION_CONFLICT_WEBSITE_VARIANTS),
            "rise_variants": list(n.SITUATION_CONFLICT_RISE_VARIANTS),
        },
        "your_number_counter_suffix": n.YOUR_NUMBER_COUNTER_SUFFIX,
        "price_first": {
            "id": n.PRICE_FIRST_SPEC.id,
            "brief": n.PRICE_FIRST_SPEC.brief,
            "markers": [list(group) for group in n.PRICE_FIRST_SPEC.markers],
            "variants": list(n.PRICE_FIRST_SPEC.variants),
        },
        "money_first_briefs": [n.N_MONEY_NAMED_BRIEF, n.N_MONEY_UNKNOWN_BRIEF],
        "money_unknown_variants": list(n.N_MONEY_UNKNOWN_VARIANTS),
        "money_named_variants": list(n.N_MONEY_NAMED_VARIANTS),
        "notes": {
            "price_met_note_early": p.PRICE_MET_NOTE_EARLY,
            "figure_challenge_note": p.FIGURE_CHALLENGE_NOTE,
            "price_conflict_website_note": p.PRICE_CONFLICT_WEBSITE_NOTE,
            "price_rise_note": p.PRICE_RISE_NOTE,
            "price_reflex_note": p.PRICE_REFLEX_NOTE,
            "price_reflex_examples": list(p.PRICE_REFLEX_EXAMPLES),
            "price_reflex_budget_note": p.PRICE_REFLEX_BUDGET_NOTE,
        },
        "length_probes": list(r1_guard.LENGTH_PROBES),
        "constants": {
            "stated_carry_turns": n.STATED_CARRY_TURNS,
            "conflict_min_gap_usd": n.CONFLICT_MIN_GAP_USD,
            "max_conflicts": n.MAX_CONFLICTS,
            "rise_min_usd": n.RISE_MIN_USD,
        },
    }


def _endings() -> dict[str, Any]:
    """M032 S3 (revision 24): the endings' and the wrap-up's new texts and constants."""
    p = r1_prompts
    return {
        "wrapup": {
            "everything_line": p.WRAPUP_EVERYTHING_LINE,
            "next_round_line": p.WRAPUP_NEXT_ROUND_LINE,
            "whats_left_note": p.WRAPUP_WHATS_LEFT_NOTE,
            "cannot_answer_note": p.WRAPUP_CANNOT_ANSWER_NOTE,
            "reminders": {
                f"answers={answers},one_mention={one},next_round={nxt}": p.wrapup_reminder(
                    answers=answers, one_mention=one, next_round=nxt
                )
                for answers in (False, True)
                for one in (False, True)
                for nxt in (False, True)
            },
            "own_content_words": r1_guard.OWN_CONTENT_WORDS,
        },
        # S3.2, S3.3, S3.4 and SWEEP-24.
        "close_note": p.CLOSE_NOTE,
        "hold_note_v2": p.HOLD_NOTE_V2,
        "continue_note": p.CONTINUE_NOTE,
        "cool_note": p.COOL_NOTE,
        "last_point_brief": r1_scheduler.LAST_POINT_BRIEF,
        "early_close_ask_limit": 2,
        "hangup_limit": 2,
        # SWEEP-25 B and SWEEP-27.
        "commit_reaction_brief_v2": r1_negotiation.COMMIT_REACTION_BRIEF_V2,
        "time_cue_brief_v2": r1_scheduler.TIME_CUE_BRIEF_V2,
        "short_on_time_note": p.SHORT_ON_TIME_NOTE,
        "short_on_time_concerns_note": p.SHORT_ON_TIME_CONCERNS_NOTE,
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
        "monthly_budget_max_usd": r1_personas.MONTHLY_BUDGET_MAX_USD,
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
                    "worry": spec.worry,
                    "worry_variants": list(spec.worry_variants),
                }
                for spec in r1_scheduler.PLAN
            ],
            "f4_primary_said_suffix": r1_scheduler.F4_PRIMARY_SAID_SUFFIX,
            "f4_primary_said_variants": list(r1_scheduler.F4_PRIMARY_SAID_VARIANTS),
            "preempted_suffix": r1_scheduler.PREEMPTED_SUFFIX,
            "preempted_labels": [list(item) for item in r1_scheduler.PREEMPTED_LABELS],
            "curiosity_labels_v2": {
                topic: list(labels) for topic, labels in r1_scheduler.CURIOSITY_LABELS_V2.items()
            },
            "redirect_openers": list(r1_scheduler.REDIRECT_OPENERS),
            "redirect_brief": r1_scheduler.REDIRECT_BRIEF,
            "answered_labels": [list(item) for item in r1_scheduler.ANSWERED_LABELS],
            "time_cue_alternatives": list(r1_scheduler.TIME_CUE_BRIEF_ALTERNATIVES),
            "f4_push_call_suffix": r1_scheduler.F4_PUSH_CALL_SUFFIX,
            "f4_push_said_suffix": r1_scheduler.F4_PUSH_SAID_SUFFIX,
            "f4_push_said_variants": list(r1_scheduler.F4_PUSH_SAID_VARIANTS),
            "curiosity_topics": [list(item) for item in r1_scheduler.CURIOSITY_TOPICS],
            "constants": {
                "slip_limit_sec": r1_scheduler.SLIP_LIMIT_SEC,
                "spacing_turns": r1_scheduler.SPACING_TURNS,
                "idle_gap_turns": r1_scheduler.IDLE_GAP_TURNS,
                "idle_gap_slack_turns": r1_scheduler.IDLE_GAP_SLACK_TURNS,
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
            "no_commit_briefs": dict(r1_negotiation.NO_COMMIT_BRIEFS),
            "no_commit_variants": {
                key: list(value) for key, value in r1_negotiation.NO_COMMIT_VARIANTS.items()
            },
            "question_enrol_v2": {
                "brief": r1_negotiation.N_QUESTION_ENROL_BRIEF_V2,
                "variants": list(r1_negotiation.N_QUESTION_ENROL_VARIANTS_V2),
            },
            "implausible_net_usd": r1_negotiation.IMPLAUSIBLE_NET_USD,
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
                    r1_negotiation.anchor_after_unclear_low(3000),
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
            "budget_replacement": r1_guard.BUDGET_REPLACEMENT,
            "budget_replacement_v2": r1_guard.BUDGET_REPLACEMENT_V2,
            "soft_tic_window": r1_guard.SOFT_TIC_WINDOW,
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
            "transition_reminder": r1_prompts.TRANSITION_REMINDER,
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
            "decider_said_note": r1_prompts.DECIDER_SAID_NOTE,
            "budget_over_note": r1_prompts.BUDGET_OVER_NOTE,
            "intent_shapes": list(r1_prompts.INTENT_SHAPES),
            "intent_lengths": list(r1_prompts.INTENT_LENGTHS),
            "intent_answering_sample": r1_prompts.turn_reminder(
                sample,
                r_sec=0,
                intent_brief=intent_sample.brief,
                must_say=intent_sample.must_say,
                answering=True,
                intent_shape=1,
            ),
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
            "offer_made_note": r1_prompts.OFFER_MADE_NOTE,
            "asked_directly_note": r1_prompts.ASKED_DIRECTLY_NOTE,
            "answered_you_note": r1_prompts.ANSWERED_YOU_NOTE,
            "pressure_eased_note": r1_prompts.PRESSURE_EASED_NOTE,
            "push_react_note": r1_prompts.PUSH_REACT_NOTE,
            "concern_labels": [list(item) for item in r1_prompts.CONCERN_LABELS],
            "voiced_concerns_note": r1_prompts.VOICED_CONCERNS_NOTE,
            "voiced_concerns_asked_note": r1_prompts.VOICED_CONCERNS_ASKED_NOTE,
            "hollow_concerns_note": r1_prompts.HOLLOW_CONCERNS_NOTE,
            "learner_voice_v2": _learner_voice_v2(sample),
            "probe_first": _probe_first(sample),
            "endings": _endings(),
        },
        "end_intent": {
            "system": r1_end_intent.END_INTENT_SYSTEM,
            "roleplay_context": r1_end_intent.ROLEPLAY_CONTEXT,
            "after_aside_context": r1_end_intent.AFTER_ASIDE_CONTEXT,
            "window_words": r1_end_intent.END_INTENT_WINDOW_WORDS,
            "labels": list(r1_end_intent.END_INTENT_LABELS),
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
