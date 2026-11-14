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
import r1_icebreaker
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
# 21: M032 S5, Christy as interviewer (owner go of 2026-11-11 after the RCA of test fda9e9f6): her
#    persona and register inside the interviewer prefix (r1_prompts.INTERVIEWER_VOICE_TEXT) and a
#    per-turn delivery rider on the opening, icebreaker, transition and wrap-up notes
#    (INTERVIEWER_DELIVERY_RIDER), both behind R1_INTERVIEWER_VOICE.  The manifest pins the prefix
#    WITH the voice text, whatever the flag says, so the digest never depends on the environment.
#    Same revision: the icebreaker plan (r1_icebreaker, R1_ICEBREAKER_PLAN): its objectives, their
#    fallback questions, the per-turn notes that take the getting-to-know-you note's place and
#    "Take your time." for a candidate who is thinking.  Same revision: the transition bridge
#    (R1_TRANSITION_BRIDGE, off by default): the note Christy's one-sentence reaction to the last
#    icebreaker answer is composed under, its limits, and L-TRANSITION-BRIDGED, the brief without
#    "Thank you, {first_name}." that follows the reaction.
#    Same revision (review fixes): the note tail for a request to skip ahead
#    (PLAN_NOTE_TAIL_SKIP) and the notes once every objective is reached (FREE_JOB_NOTES).
# 22: M032 S6, the brief and the transition repaired (owner go of 2026-11-11, tests fda9e9f6 and
#    8f5bfefc; R1_TRANSITION_REPAIR): one shared body for every brief (r1_script.BRIEF_BODY), so
#    L-TRANSITION, L-TRANSITION-BRIDGED, the replay L-TRANSITION-AGAIN ("Of course, here it is
#    again.") and the short recap L-TRANSITION-RECAP cannot drift apart, with no "We'll now move to
#    the role-play", no "evaluate" and ONE start prompt; L-PRESENT ("Yes, I'm here."),
#    L-PICKUP-BRIDGE, the rotated start questions L-TRANSITION-ASK-2/-3, the pickup "Hello, {lead}
#    speaking.", and L-ASIDE-COACH saying Christy is PLAYING the learner.  Revision 21's texts stay
#    pinned under their -V20 ids, which R1_TRANSITION_REPAIR=0 speaks.  The transition note that
#    asks nothing itself (r1_prompts.TRANSITION_REMINDER_REPAIRED) joins the manifest.  Same
#    revision, the icebreaker repair (r1_icebreaker, R1_ICEBREAKER_REPAIR): "Of course, take a
#    moment. I'm here when you're ready." (L-IB-HOLD), the repeated question's template "Of course.
#    {question}", the opener notes for a reply to "Are you there?" and the hold's limits.
# 23: M032 S7C, the Christy follow-ups of the sweep (owner go of 2026-11-11).  The opening as a
#    short hello with a sound check, then a shorter agenda from one shared body
#    (R1_OPENING_SOUND_CHECK, SWEEP-35): L-OPEN-HELLO ("Can you hear me okay?"),
#    L-OPEN-HELLO-AGAIN, L-OPEN-AGENDA, L-OPEN-AGENDA-PLAIN and L-OPEN-AGENDA-CONTINUE; L-OPEN is
#    the flag-off line, unchanged.  A candidate who was never heard gets L-SIL-NOAUDIO and
#    L-SIL-END-NOAUDIO (R1_NO_AUDIO_LADDER, SWEEP-34).  The mute aside by phase, neither with
#    "ready" in it: L-MUTE-RP and L-MUTE-IV (R1_MUTE_ASIDE_V2, SWEEP-36); L-MUTE is the flag-off
#    line, unchanged.
# 24: M032 live simulation, diagnosis 1 (Christy lane, R1_TRANSITION_REPAIR): the short recap
#    L-TRANSITION-RECAP ends with its own either/or question ("Would you like to begin now, or ask
#    me something first?", r1_script.RECAP_START_PROMPT), so the brief's start question is never
#    heard three times (CR-1), and the repaired transition note says when "Of course, go ahead."
#    is for, with an example, and that a request to repeat or explain gets that, in one sentence
#    (BR-2).  No other pinned text changed.
# 25: review of diagnosis 1 (BR-2): the turn that answers her repeated icebreaker question gets one
#    more line in the transition note, r1_prompts.TRANSITION_IB_ANSWER_NOTE ("react in one short
#    sentence ... and ask nothing").  No other pinned text changed.
# 26: M032 live simulation, diagnosis 2 (Christy lane, R1_TRANSITION_REPAIR): the repaired
#    transition note says a request for the instructions, the brief or the scenario means the
#    role-play brief, never the model's own rules (D2-BR1), and a request that turns her repeated
#    icebreaker question down gets the one before it, "Sure, the one before that: {question}"
#    (r1_icebreaker.IB_REPEAT_OLDER_TEMPLATE), or with none older kept "That one was: {question}"
#    (IB_REPEAT_SAME_TEMPLATE) (D2-IB1).  No other pinned text changed.
# 27: review of diagnosis 2 (D2-BR1-R2): the repaired transition note says what to do with a
#    request for the instructions (say the brief has just been given and offer to go over it
#    again) and keeps the polite decline for asks about the model's own rules or setup, with no
#    line that bans a refusal.  No other pinned text changed.
# 28: M032 christy-ready (R1_START_ASK_ONCE): L-TRANSITION-ASK-PAUSE ("If that covers everything,
#    shall we begin the role-play? Just say 'ready' whenever you like."), the one start prompt a
#    quiet pause gets once Christy's answers before the role-play end without a start question.
#    No other pinned text changed.
# 29: M032 live simulation, diagnosis 3 (Christy lane).  R1_BRIEF_VARIETY (D3-BRIEF1): the replay
#    re-explained (L-TRANSITION-AGAIN-PLAIN, "Sure. Think of it as a real sales call. ..."), a
#    second recap (L-TRANSITION-RECAP-2, "No problem, the short version: ..."), and
#    L-TRANSITION-TAKE-TIME ("Take your time, just say 'ready' when you are.").
#    R1_REACTION_VARIETY (D3-ICE1): the voice text's and the rider's react clause
#    (r1_prompts.INTERVIEWER_VOICE_TEXT_REACTIONS, INTERVIEWER_DELIVERY_RIDER_REACTIONS, and the
#    prefix with it) and three thanked briefs (L-TRANSITION-THANKS-A/-B/-C).  R1_IB_REASK_V2
#    (D3-IB-REASK1): "Yes, I'm here. Take your time." (r1_icebreaker.IB_PRESENCE_HOLD), its 20 s
#    window and one re-ask per question.  R1_GUARD_STORY_ECHO (D3-GUARD-IB1): "Got it."
#    (r1_guard.STORY_ACK).  R1_TRANSITION_REPAIR (D3-TRANS-JOB1): the repaired transition note gives
#    a broad job question a one-sentence overview and says times the way people say them (only
#    R1_TRANSITION_REPAIR=0 gives a note without it).  Every other text of revision 28 is unchanged
#    and pinned beside the new ones (each flag off speaks it).
# 30: review of diagnosis 3 (Christy lane).  L-TRANSITION-THANKS-A is "Thanks, {first_name}." (no
#    "that's helpful", a verdict on the answer; D3-ICE1-THANKS-CONTEXT), and the icebreaker repair
#    pins REASK_V2_MAX_REPEATS (2: an explicit request to hear the question again does not use up
#    the one re-ask; D3-IB-REASK1-SECOND-REPEAT).  No other pinned text changed.
# 31: M032 live simulation, diagnosis 4 (Christy lane).  R1_BRIEF_WORDING_V2 (D4-BRIEF2): the agenda
#    and every brief in a person's words, "Great, I can hear you too.", "Any questions before we
#    start? If not, just say 'ready' and she'll pick up." (r1_script *-W2 lines, WORDING_LINES).
#    R1_BRIEF_VARIETY (D4-TRANS-PRESENT1): L-PRESENT-TAKE-TIME and L-PICKUP-BRIDGE-2.
#    R1_TRANSITION_ANSWERS (D4-TRANS-Q1): the role-play field answers L-RP-*, "Fair enough."
#    (r1_script.TRANSITION_QUIET_FALLBACK) and the transition note without a phrase to copy
#    (r1_prompts.TRANSITION_REMINDER_ANSWERS).  R1_SIL_IB_RESTATE (D4-SIL-IB1): L-SIL-IB-I1..I4.
#    R1_IB_QUIET_NUDGE (D4-IB-QUIET-NUDGE): "So, {question}" and its 7 s window.  R1_IB_SKIP_V2
#    (D4-ICE-SKIP1): the skip and follow-up notes and the cap after two skips.
#    R1_REACTION_VARIETY_V2 (D4-ICE-ECHO1): the voice text's, the rider's and the plan notes' react
#    clause (and the prefix with it).  R1_ICEBREAKER_REPAIR (D4-ICE-HOLD1): the plan note's
#    "never refuse a pause" line.  Every text of revision 30 is unchanged and pinned beside the new
#    ones (each flag off speaks it).
# 32: integration 7 offline sweep (dead_air): the quiet-nudge window is 7 s, not 10 s
#    (r1_icebreaker.IB_QUIET_NUDGE_SECONDS), so a lone "Thank you." after her question is never
#    followed by more than the harness's 8 s of dead air.  No spoken text changed.
# 33: M032 live simulation, diagnosis 5 (Christy lane).  R1_AGENDA_W3 (D5-AGENDA1): the agenda as
#    one sentence whose parts add up to the whole, after "Good, I can hear you." (L-OPEN-AGENDA-W3,
#    -PLAIN-W3, -CONTINUE-W3; r1_script.AGENDA_W3_LINES).  R1_WRAP_OFFER_VARIANT (D5-ASIDE-WRAP2):
#    L-ASIDE-WRAP-AGAIN for every offer to wrap up after the first.  R1_REACTION_VARIETY_V2
#    (D5-ICE-AWITH1): the react clause without the quoted example the model copied, and the guard's
#    "And with <their thing>," opener kept once (r1_guard._WITH_OPENER).  R1_IB_SKIP_V2 (D5-SKIP1):
#    the skip notes say one or two quick questions are left.  R1_IB_QUIET_NUDGE (D5-NUDGE1): the
#    nudge keeps the asking clause and says "I was asking, {question}" after a lead of her own.
#    R1_TRANSITION_ANSWERS (D5-TRANS1): the answers note keeps "has just been given" for a request
#    to hear the brief again and says how to answer "how do I approach it?".  Every other text of
#    revision 32 is unchanged.
# 34: review of diagnosis 5 (Christy lane).  R1_AGENDA_W3 (D5-AGENDA1-R1): the W3 agenda's heard
#    line is "Lovely, thanks." ("Good, I can hear you." was the echo D4-BRIEF2 removed).
#    R1_IB_QUIET_NUDGE (D5-NUDGE1-R1): an elaboration that holds a wh-word is never cut, the end
#    punctuation is kept, and an instruction keeps "So," (r1_icebreaker._NUDGE_WH_WORDS,
#    _NUDGE_INSTRUCTIONS).  No other pinned text changed.
CONTENT_REVISION = 34


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
            # Revision 31 (D4-BRIEF2, D4-TRANS-PRESENT1, D4-TRANS-Q1).
            "wording_lines": dict(r1_script.WORDING_LINES),
            "variety_lines": dict(r1_script.VARIETY_LINES),
            # Revision 33 (D5-AGENDA1).
            "agenda_w3_lines": dict(r1_script.AGENDA_W3_LINES),
            "transition_quiet_fallback": r1_script.TRANSITION_QUIET_FALLBACK,
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
                }
                for spec in r1_scheduler.PLAN
            ],
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
            "story_ack": r1_guard.STORY_ACK,  # revision 29 (D3-GUARD-IB1)
            "gratitude_replacement": r1_guard.GRATITUDE_REPLACEMENT,
            "budget_replacement": r1_guard.BUDGET_REPLACEMENT,
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
                # Revision 33 (D5-ICE-AWITH1).
                "with_opener": r1_guard._WITH_OPENER.pattern,
            },
            "reply_word_cap": r1_guard.REPLY_WORD_CAP,
            "ack_word_cap": r1_guard.ACK_WORD_CAP,
            "flag_threshold": r1_guard.HIT_FLAG_THRESHOLD,
        },
        "prompts": {
            "interviewer_prefix": r1_prompts.interviewer_prefix(
                voice=True, reactions=False, reactions_v2=False
            ),
            "interviewer_voice_text": r1_prompts.INTERVIEWER_VOICE_TEXT,
            "interviewer_delivery_rider": r1_prompts.INTERVIEWER_DELIVERY_RIDER,
            # Revision 29 (D3-ICE1, R1_REACTION_VARIETY): the reworded react clause.
            "interviewer_prefix_reactions": r1_prompts.interviewer_prefix(
                voice=True, reactions=True, reactions_v2=False
            ),
            # Revision 31 (D4-ICE-ECHO1, R1_REACTION_VARIETY_V2; D4-TRANS-Q1).
            "interviewer_prefix_reactions_v2": r1_prompts.interviewer_prefix(
                voice=True, reactions=True, reactions_v2=True
            ),
            "interviewer_voice_text_reactions_v2": r1_prompts.INTERVIEWER_VOICE_TEXT_REACTIONS_V2,
            "interviewer_delivery_rider_reactions_v2": (
                r1_prompts.INTERVIEWER_DELIVERY_RIDER_REACTIONS_V2
            ),
            "transition_reminder_answers": r1_prompts.TRANSITION_REMINDER_ANSWERS,
            "interviewer_voice_text_reactions": r1_prompts.INTERVIEWER_VOICE_TEXT_REACTIONS,
            "interviewer_delivery_rider_reactions": r1_prompts.INTERVIEWER_DELIVERY_RIDER_REACTIONS,
            "wrapup_note": r1_prompts.WRAPUP_NOTE,
            "wrapup_reminder": r1_prompts.WRAPUP_REMINDER,
            "transition_reminder": r1_prompts.TRANSITION_REMINDER,
            "transition_reminder_repaired": r1_prompts.TRANSITION_REMINDER_REPAIRED,
            "transition_ib_answer_note": r1_prompts.TRANSITION_IB_ANSWER_NOTE,
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
        },
        "icebreaker": {
            "objectives": [
                {"id": item.id, "goal": item.goal, "restate": item.restate}
                for item in r1_icebreaker.OBJECTIVES
            ],
            "free_restate": r1_icebreaker.FREE_RESTATE,
            "take_your_time": r1_icebreaker.TAKE_YOUR_TIME,
            "plan_note_head": r1_icebreaker.PLAN_NOTE_HEAD,
            "plan_note_tail": r1_icebreaker.PLAN_NOTE_TAIL,
            "plan_note_tail_skip": r1_icebreaker.PLAN_NOTE_TAIL_SKIP,
            "asked_note": r1_icebreaker.ASKED_NOTE,
            "skip_note": r1_icebreaker.SKIP_NOTE,
            "job_notes": dict(r1_icebreaker.JOB_NOTES),
            "free_job_notes": dict(r1_icebreaker.FREE_JOB_NOTES),
            "constants": {
                "thin_words": r1_icebreaker.THIN_WORDS,
                "decline_max_words": r1_icebreaker.DECLINE_MAX_WORDS,
                "max_holds": r1_icebreaker.MAX_HOLDS,
                "max_follow_ups": r1_icebreaker.MAX_FOLLOW_UPS,
            },
            "transition_bridge": {
                "note": r1_icebreaker.BRIDGE_NOTE,
                "timeout_sec": r1_icebreaker.BRIDGE_TIMEOUT_SEC,
                "min_words": r1_icebreaker.BRIDGE_MIN_WORDS,
                "max_words": r1_icebreaker.BRIDGE_MAX_WORDS,
            },
            # M032 S6 (SWEEP-28, R1_ICEBREAKER_REPAIR): the repeated question's template, the
            # presence opener notes and the hold's limits (L-IB-HOLD and L-PRESENT are lines).
            "repair": {
                "repeat_template": r1_icebreaker.IB_REPEAT_TEMPLATE,
                "repeat_older_template": r1_icebreaker.IB_REPEAT_OLDER_TEMPLATE,
                "repeat_same_template": r1_icebreaker.IB_REPEAT_SAME_TEMPLATE,
                "presence_opener_note": r1_icebreaker.PRESENCE_OPENER_NOTE,
                "presence_opener_note_late": r1_icebreaker.PRESENCE_OPENER_NOTE_LATE,
                "presence_late_seconds": r1_icebreaker.PRESENCE_LATE_SECONDS,
                "hold_wait_seconds": r1_icebreaker.ICEBREAKER_HOLD_WAIT_SECONDS,
                "hold_min_budget_seconds": r1_icebreaker.HOLD_MIN_BUDGET_SECONDS,
                # Revision 29 (D3-IB-REASK1, R1_IB_REASK_V2).
                "presence_hold": r1_icebreaker.IB_PRESENCE_HOLD,
                "presence_hold_seconds": r1_icebreaker.IB_PRESENCE_HOLD_SECONDS,
                "reask_v2_max_holds": r1_icebreaker.REASK_V2_MAX_HOLDS,
                # Revision 30 (review of diagnosis 3, D3-IB-REASK1-SECOND-REPEAT).
                "reask_v2_max_repeats": r1_icebreaker.REASK_V2_MAX_REPEATS,
                # Revision 31 (D4-IB-QUIET-NUDGE, D4-ICE-HOLD1).
                "quiet_nudge_template": r1_icebreaker.IB_QUIET_NUDGE_TEMPLATE,
                "quiet_nudge_seconds": r1_icebreaker.IB_QUIET_NUDGE_SECONDS,
                "quiet_nudge_min_budget_seconds": r1_icebreaker.IB_QUIET_NUDGE_MIN_BUDGET_SECONDS,
                "hold_note": r1_icebreaker.HOLD_NOTE,
                # Revision 33 (D5-NUDGE1).
                "quiet_nudge_recall": r1_icebreaker.IB_QUIET_NUDGE_RECALL,
                "quiet_nudge_elaboration": r1_icebreaker._NUDGE_ELABORATION_RE.pattern,
                "quiet_nudge_recall_leads": sorted(r1_icebreaker._NUDGE_RECALL_LEADS),
                # Revision 34 (review of diagnosis 5, D5-NUDGE1-R1).
                "quiet_nudge_wh_words": sorted(r1_icebreaker._NUDGE_WH_WORDS),
                "quiet_nudge_instructions": sorted(r1_icebreaker._NUDGE_INSTRUCTIONS),
            },
            # Revision 31 (D4-ICE-SKIP1, R1_IB_SKIP_V2; D4-ICE-ECHO1, R1_REACTION_VARIETY_V2).
            "skip_v2": {
                "job_skip_note": r1_icebreaker.JOB_SKIP_V2_NOTE,
                "free_skip_note": r1_icebreaker.FREE_SKIP_V2_NOTE,
                "skip_note": r1_icebreaker.SKIP_NOTE_V2,
                "follow_up_note": r1_icebreaker.JOB_FOLLOW_UP_V2_NOTE,
                "cap_after": r1_icebreaker.SKIP_V2_CAP_AFTER,
            },
            "reaction_v2_notes": dict(r1_icebreaker.REACTION_V2_NOTES),
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
