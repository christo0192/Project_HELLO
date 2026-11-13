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
# The M032 lanes numbered their revisions from 21 each on their own branch; both histories follow,
# then the integration revision that pins them together.
# Christy lane (feat/m032-christy, its revisions 21-23):
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
# Learner lane (feat/m032-learner, its revisions 21-24):
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
#    After the S3 review (still revision 24, unreleased): a goodbye while she is cool is polite, not
#    warm (CLOSE_NOTE_COOL), and a winding reply has its own job line (WINDING_REPLY_NOTE) with no
#    question, opener or length line.
# 25: M032 integration (the simulator, the Christy lane and the learner lane together): every
#    text of the Christy lane's 21-23 and of the learner lane's 21-24 in one manifest.  No text
#    changed in the merge; CONTENT_REVISION = max(23, 24) + 1, as revision 9 did for an earlier
#    merge.
# Learner lane (feat/m032-learner, its revisions 25-26, after the first integration):
# Lane 25: M032 S7L, learner follow-ups from the transcript sweep (owner decisions D-M032-4 and
#    D-M032-7; rollback flags R1_LEARNER_VOICE_V2 for SWEEP-15, R1_PRICE_MEMORY, R1_COME_BACK,
#    R1_PERSONA_TIMELINE_V2, R1_CALL_OPENING, R1_ROLE_CONFUSION_V2 and R1_FLOOR_YIELD).  The new
#    notes, the card's timeline wording, the learner's yield lines and the role-confusion examples
#    join the manifest (``_learner_followups``) beside the texts they replace while their flags are
#    on.  No graded meaning, marker, must-say or deadline changed; with every flag off the card,
#    the prefix and the reminders are the release before.
# Lane 26: Simulation diagnosis 1, learner fixes (rollback flags R1_ECHO_GUARD, R1_MARKERS_V2,
#    R1_PRICE_ASKED_ONCE, R1_NO_ACCEPT_NOTES and R1_COMMIT_READER_V2).  The shorter re-ask notes and
#    the other new notes and wordings join the manifest (``_sim_repairs``) beside the texts they
#    replace while their flags are on.  No graded meaning, must-say or deadline changed; the wider
#    delivery markers are listed beside the old ones; with every flag off the reminders, the
#    markers and the readers are the release before.
# 27: M032 integration 2 (the learner lane's 25-26 merged onto revision 25): every text of both
#    lanes in one manifest.  No text changed in the merge; CONTENT_REVISION = max(25, 26) + 1.
# Christy lane (feat/m032-christy, its revisions 24-25, after the first integration):
# Lane 24: M032 live simulation, diagnosis 1 (R1_TRANSITION_REPAIR): the short recap
#    L-TRANSITION-RECAP ends with its own either/or question ("Would you like to begin now, or ask
#    me something first?", r1_script.RECAP_START_PROMPT), so the brief's start question is never
#    heard three times (CR-1), and the repaired transition note says when "Of course, go ahead."
#    is for, with an example, and that a request to repeat or explain gets that, in one sentence
#    (BR-2).  No other pinned text changed.
# Lane 25: review of diagnosis 1 (BR-2): the turn that answers her repeated icebreaker question
#    gets one more line in the transition note, r1_prompts.TRANSITION_IB_ANSWER_NOTE ("react in
#    one short sentence ... and ask nothing").  No other pinned text changed.
# 28: M032 integration 3 (the Christy lane's 24-25 merged onto revision 27): every text of both
#    lanes in one manifest.  No text changed in the merge; CONTENT_REVISION = max(27, 25) + 1.
# Learner lane (feat/m032-learner, its revisions 27-28, after the third integration):
# Lane 27: Simulation diagnosis 2, learner fixes (rollback flags R1_INTENT_TAIL_V3,
#    R1_LOW_OFFER_READER, R1_PRICE_STORY and R1_ASK_KIND_NOTE carry new texts; R1_DECLINE_SCOPE,
#    R1_OWN_COURSE, R1_DIG_FIRST, R1_F4_ORGANIC, R1_STALL_MEMORY and R1_NO_BARE_REPROACH change
#    readers only).
#    The short completion tails, the counter's completions, the below-$7,000 anchor situations, the
#    latest-price, figures-said and ask-kind notes join the manifest (``_sim2_repairs``) beside the
#    texts they replace while their flags are on.  No graded marker, must-say, meaning or deadline
#    changed; with every flag off the tails, the anchors and the reminders are the release before.
#    After its review (still 27, unreleased): the figures-said note's website example only for the
#    website's price she named herself (``figures_said_source_website``), and narrower tail themes.
# Lane 28: Simulation adaptability (owner decision D-M032-10; rollback flags R1_TANGENT and
#    R1_STALL_GAP).  The tangent notes (a free reply and an owed point on small talk) and the
#    voiced-concerns note for a stall said a moment ago join the manifest (``_adapt_repairs``).
#    No graded marker, must-say, meaning or deadline changed; with both flags off the reminders
#    are the release before.  After its review (still 28, unreleased): the 19:00 stall's reaction-
#    only tangent note (``tangent_react_note``).
# 29: M032 integration 4 (the learner lane's 27-28 merged onto revision 28): every text of both
#    lanes in one manifest.  No text changed in the merge; CONTENT_REVISION = max(28, 28) + 1.
# Christy lane (feat/m032-christy, its revisions 26-28, after the third integration):
# Lane 26: M032 live simulation, diagnosis 2 (Christy lane, R1_TRANSITION_REPAIR): the repaired
#    transition note says a request for the instructions, the brief or the scenario means the
#    role-play brief, never the model's own rules (D2-BR1), and a request that turns her repeated
#    icebreaker question down gets the one before it, "Sure, the one before that: {question}"
#    (r1_icebreaker.IB_REPEAT_OLDER_TEMPLATE), or with none older kept "That one was: {question}"
#    (IB_REPEAT_SAME_TEMPLATE) (D2-IB1).  No other pinned text changed.
# Lane 27: review of diagnosis 2 (D2-BR1-R2): the repaired transition note says what to do with a
#    request for the instructions (say the brief has just been given and offer to go over it
#    again) and keeps the polite decline for asks about the model's own rules or setup, with no
#    line that bans a refusal.  No other pinned text changed.
# Lane 28: M032 christy-ready (R1_START_ASK_ONCE): L-TRANSITION-ASK-PAUSE ("If that covers
#    everything, shall we begin the role-play? Just say 'ready' whenever you like."), the one start
#    prompt a quiet pause gets once Christy's answers before the role-play end without a start
#    question. No other pinned text changed.
# 30: M032 integration 5 (the Christy lane's 26-28 merged onto revision 29): every text of both
#    lanes in one manifest.  No text changed in the merge; CONTENT_REVISION = max(29, 28) + 1.
# Learner lane (feat/m032-learner, its revision 29, after the fifth integration):
# Lane 29: Simulation diagnosis 3 (the int-live-3 flow judge; rollback flags R1_WRAPUP_NEXT_STEPS,
#    R1_LAST_POINT_V2, R1_FAREWELL_EXIT_V2, R1_FOREIGN_PRICE, R1_INTENT_TAIL_V4,
#    R1_QUESTION_DIET_V2, R1_FIGURE_MEMORY, R1_CURIOSITY_TIMING, R1_EASED_ACK_V2, R1_DIG_GATE_V2,
#    R1_FIGURE_NOT_MINE, R1_END_ASIDE_V2 and R1_COACH_AFTER_INROLE).  New scripted lines (the
#    what's-next answer and the short close, two feedback refusals, her short goodbyes, the merged
#    exit and wrap-up line, the reworded last-point, end and early-close asides), the rupee anchor,
#    the last-point brief and the new notes join the manifest (``_diag3_repairs``) beside the texts
#    they replace while their flags are on.  No graded marker, must-say, meaning or deadline
#    changed; with every flag off the lines, reminders and readers are the release before.
#    After its review (still 29, unreleased): L-EXIT-WRAP opens with "Let's stop the role-play
#    here" (D3R-8).
# Christy lane (feat/m032-christy, its revisions 29-30, after the fifth integration):
# Lane 29: M032 live simulation, diagnosis 3 (Christy lane).  R1_BRIEF_VARIETY (D3-BRIEF1): the
#    replay re-explained (L-TRANSITION-AGAIN-PLAIN, "Sure. Think of it as a real sales call. ..."),
#    a second recap (L-TRANSITION-RECAP-2, "No problem, the short version: ..."), and
#    L-TRANSITION-TAKE-TIME ("Take your time, just say 'ready' when you are."). R1_REACTION_VARIETY
#    (D3-ICE1): the voice text's and the rider's react clause
#    (r1_prompts.INTERVIEWER_VOICE_TEXT_REACTIONS, INTERVIEWER_DELIVERY_RIDER_REACTIONS, and the
#    prefix with it) and three thanked briefs (L-TRANSITION-THANKS-A/-B/-C).  R1_IB_REASK_V2
#    (D3-IB-REASK1): "Yes, I'm here. Take your time." (r1_icebreaker.IB_PRESENCE_HOLD), its 20 s
#    window and one re-ask per question.  R1_GUARD_STORY_ECHO (D3-GUARD-IB1): "Got it."
#    (r1_guard.STORY_ACK).  R1_TRANSITION_REPAIR (D3-TRANS-JOB1): the repaired transition note gives
#    a broad job question a one-sentence overview and says times the way people say them (only
#    R1_TRANSITION_REPAIR=0 gives a note without it).  Every other text of revision 28 is unchanged
#    and pinned beside the new ones (each flag off speaks it).
# Lane 30: review of diagnosis 3 (Christy lane).  L-TRANSITION-THANKS-A is "Thanks, {first_name}."
#    (no "that's helpful", a verdict on the answer; D3-ICE1-THANKS-CONTEXT), and the icebreaker
#    repair pins REASK_V2_MAX_REPEATS (2: an explicit request to hear the question again does not
#    use up the one re-ask; D3-IB-REASK1-SECOND-REPEAT).  No other pinned text changed.
# 31: M032 integration 6 (the learner lane's 29 and the Christy lane's 29-30 merged onto
#    revision 30): every text of both lanes in one manifest.  No text changed in the merge;
#    CONTENT_REVISION = max(30, 29, 30) + 1.
CONTENT_REVISION = 31


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
        "close_note_cool": p.CLOSE_NOTE_COOL,
        "winding_reply_note": p.WINDING_REPLY_NOTE,
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


def _learner_followups(sample: r1_personas.RenderedPersona) -> dict[str, Any]:
    """M032 S7L (revision 25): the learner follow-ups' new texts, beside the ones they replace."""
    p = r1_prompts
    return {
        # SWEEP-8: the card's timeline wording (latched per session) and a prefix rendered with it.
        "backstory_timeline_v2": dict(r1_personas.BACKSTORY_TIMELINE_V2),
        "success_answer_v2": r1_personas.SUCCESS_ANSWER_V2,
        "learner_prefix_timeline_v2_sample": p.learner_prefix(
            sample, offer_realism=True, probe_first=True, price_check=True, timeline_v2=True
        ),
        # SWEEP-10: the role note, its rotated examples, and a reminder rendered with it.
        "role_confusion_note": p.ROLE_CONFUSION_NOTE,
        "role_confusion_examples": list(p.ROLE_CONFUSION_EXAMPLES),
        "role_confusion_reminder_sample": p.turn_reminder(
            sample,
            r_sec=0,
            character_break=True,
            voice_v2=True,
            role_confusion=p.ROLE_CONFUSION_NOTE.format(example=p.ROLE_CONFUSION_EXAMPLES[0]),
        ),
        # SWEEP-15: the cut notes without a frame to narrate.
        "interrupted_note_v2": p.INTERRUPTED_NOTE_V2,
        "cut_repeat_note_v2": p.CUT_REPEAT_NOTE_V2,
        # SWEEP-33: the forced-move note (the yield lines are in ``script.lines``).
        "floor_note": p.FLOOR_NOTE,
        # SWEEP-7: the come-back notes, the swapped no-repeat line and the topic labels.
        "open_question_note": p.OPEN_QUESTION_NOTE,
        "open_question_after_ask_note": p.OPEN_QUESTION_AFTER_ASK_NOTE,
        "no_repeat_reask_note": p.NO_REPEAT_REASK_NOTE,
        # SWEEP-9: the call-opening notes and their rotated examples.
        "caller_unknown_note": p.CALLER_UNKNOWN_NOTE,
        "caller_unknown_examples": list(p.CALLER_UNKNOWN_EXAMPLES),
        "caller_name_only_note": p.CALLER_NAME_ONLY_NOTE,
        "caller_name_only_examples": list(p.CALLER_NAME_ONLY_EXAMPLES),
        "how_are_you_note": p.HOW_ARE_YOU_NOTE,
        "how_are_you_examples": list(p.HOW_ARE_YOU_EXAMPLES),
        # SWEEP-6: her own number, total, monthly and already met.
        "your_number_total_note": p.YOUR_NUMBER_TOTAL_NOTE,
        "your_number_monthly_note": p.YOUR_NUMBER_MONTHLY_NOTE,
        "your_number_met_note": p.YOUR_NUMBER_MET_NOTE,
        "open_question_labels": {
            topic: list(labels) for topic, labels in r1_scheduler.OPEN_QUESTION_LABELS.items()
        },
    }


def _sim_repairs() -> dict[str, Any]:
    """Simulation diagnosis 1 (revision 26): the learner fixes' new texts and markers."""
    p = r1_prompts
    return {
        # L5 (R1_ECHO_GUARD): the re-ask is shorter and in other words.
        "ack_turn_notes_v2": [p.ACK_TURN_NOTE_V2, p.ACK_TURN_CONCERNS_NOTE_V2],
        # L3 (R1_PRICE_ASKED_ONCE): the final price asked once, and the unclear counter's brief.
        "final_asked_note": p.FINAL_ASKED_NOTE,
        "unclear_counter_v3": {
            "brief": r1_negotiation.UNCLEAR_COUNTER_V3.brief,
            "variants": list(r1_negotiation.UNCLEAR_COUNTER_V3.variants),
        },
        # L7, U4 (2) (R1_NO_ACCEPT_NOTES).
        "proposal_unanswered_note": p.PROPOSAL_UNANSWERED_NOTE,
        "price_met_note_early_v2": p.PRICE_MET_NOTE_EARLY_V2,
        # U1, U2 (R1_MARKERS_V2): the alternatives added to each marker group.
        "extra_markers_v2": {
            move_id: [list(group) for group in groups]
            for move_id, groups in r1_scheduler.EXTRA_MARKERS_V2.items()
        },
    }


def _sim2_repairs() -> dict[str, Any]:
    """Simulation diagnosis 2 (revision 27): the learner fixes' new texts."""
    p = r1_prompts
    neg = r1_negotiation
    below = {
        name: {
            "brief": item.brief,
            "must_say": list(item.must_say),
            "variants": list(item.variants),
        }
        for name, item in (
            ("echoed", neg.anchor_after_offer(3000, situational=True, advisor_said_anchor=True)),
            ("reacted", neg.anchor_after_offer(5000, situational=True, reacted=True)),
            ("wary", neg.anchor_after_offer(2500, situational=True)),
            ("plain", neg.anchor_after_offer(6000, situational=True)),
        )
    }
    return {
        # HF3, U1 (R1_INTENT_TAIL_V3): the short completion tails.
        "tail_completions": {
            move_id: list(texts) for move_id, texts in r1_scheduler.TAIL_COMPLETIONS.items()
        },
        "tail_themes": dict(r1_scheduler.TAIL_THEMES),
        "counter_completions": {key: list(texts) for key, texts in neg.COUNTER_COMPLETIONS.items()},
        "negotiation_completions": {
            key: list(texts) for key, texts in neg.NEGOTIATION_COMPLETIONS.items()
        },
        # MF2 (R1_LOW_OFFER_READER), MF4 and MF3 (R1_PRICE_STORY), MF5 (R1_ASK_KIND_NOTE).
        "latest_price_note": p.LATEST_PRICE_NOTE,
        "voiced_concerns_other_q_note": p.VOICED_CONCERNS_OTHER_Q_NOTE,
        "figures_said_note": p.FIGURES_SAID_NOTE,
        "figures_said_source_website": p.FIGURES_SAID_SOURCE_WEBSITE,
        "figures_said": [p.FIGURES_SAID_WEBSITE, p.FIGURES_SAID_HEARD, p.FIGURES_SAID_BOTH],
        "anchor_below_situations": below,
        "ask_kind_notes": [
            p.NEXT_STEP_PROPOSED_NOTE_ENROL,
            p.NEXT_STEP_PROPOSED_NOTE_CALL,
            p.PROPOSAL_UNANSWERED_NOTE_ENROL,
            p.PROPOSAL_UNANSWERED_NOTE_CALL,
        ],
    }


def _adapt_repairs() -> dict[str, Any]:
    """Simulation adaptability (revision 28): the tangent and stall-gap notes."""
    p = r1_prompts
    return {
        "tangent_note": p.TANGENT_NOTE,
        "tangent_intent_note": p.TANGENT_INTENT_NOTE,
        "tangent_react_note": p.TANGENT_REACT_NOTE,
        "voiced_concerns_recent_note": p.VOICED_CONCERNS_RECENT_NOTE,
    }


def _diag3_repairs() -> dict[str, Any]:
    """Simulation diagnosis 3 (revision 29): the new notes, anchor, brief and wrap-up wording."""
    p = r1_prompts
    anchor = r1_negotiation.anchor_after_foreign()
    return {
        "pressure_eased_note_v2": p.PRESSURE_EASED_NOTE_V2,
        "figure_not_mine_note": p.FIGURE_NOT_MINE_NOTE,
        "next_step_answer_note": p.NEXT_STEP_ANSWER_NOTE,
        "figure_reacted_note": p.FIGURE_REACTED_NOTE,
        "wrapup_noted_sentence": p.WRAPUP_NOTED_SENTENCE,
        "wrapup_noted_sentence_v2": p.WRAPUP_NOTED_SENTENCE_V2,
        "wrapup_reminder_next_steps": p.wrapup_reminder(
            answers=True, one_mention=True, next_steps=True
        ),
        "last_point_brief_v2": r1_scheduler.LAST_POINT_BRIEF_V2,
        "anchor_foreign": {
            "id": anchor.id,
            "brief": anchor.brief,
            "must_say": list(anchor.must_say),
            "variants": list(anchor.variants),
        },
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
            "story_ack": r1_guard.STORY_ACK,  # revision 29 (D3-GUARD-IB1)
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
            "interviewer_prefix": r1_prompts.interviewer_prefix(voice=True, reactions=False),
            "interviewer_voice_text": r1_prompts.INTERVIEWER_VOICE_TEXT,
            "interviewer_delivery_rider": r1_prompts.INTERVIEWER_DELIVERY_RIDER,
            # Revision 29 (D3-ICE1, R1_REACTION_VARIETY): the reworded react clause.
            "interviewer_prefix_reactions": r1_prompts.interviewer_prefix(
                voice=True, reactions=True
            ),
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
            "learner_followups": _learner_followups(sample),
            "sim_repairs": _sim_repairs(),
            "sim2_repairs": _sim2_repairs(),
            "adapt_repairs": _adapt_repairs(),
            "diag3_repairs": _diag3_repairs(),
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
            },
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
