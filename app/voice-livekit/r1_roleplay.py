"""R1 role-play engine: the single integration surface for the learner's content.

One ``RolePlayEngine`` per interview ties together the owed-move scheduler, the
disclosure gate and coverage tracker, the earned-close logic and the output guard.  The
session (``r1_session``, a follow-up change) owns phases, clocks, I/O and the LLM; the
engine only DECIDES, deterministically, what the learner does on each candidate turn:

    plan = engine.plan_turn(candidate_text, r_sec, turn_index=..., candidate_seconds=...)

``plan.mode`` is one of

``SAY_ONLY``
    Speak ``plan.scripted_text`` verbatim and call no LLM: the graded commitment line (STRONG,
    MEDIUM with its call slot, or the WEAK resolution), the close-attempt stall, or
    (``plan.aside``) the interviewer's one-off L-ASIDE-COACH or L-ASIDE-END (``plan.line_id``),
    which the session speaks in the ASIDE phase with ``plan.voice == "interviewer"`` and which
    is excluded from evidence (plan 5.10).  The WEAK line is spoken at most once per session
    (``r1_negotiation``).
``INTENT``
    R1-Q option B, intent-voiced moves.  The worker decides WHAT the learner raises (an owed
    objection, an early-farewell redirect, the time cue, and, from the negotiation, a stall
    reason, the e-mail yes, one question about the call) and the model voices it in context,
    in the same single call: it reacts to the advisor first and then raises
    ``plan.intent.brief`` in its own words.  Delivery is proven by ``plan.intent.markers`` in
    the text that was played.  If the model's reply misses them, ``intent_tail`` returns a
    scripted variant (``plan.intent.fallbacks``, vetted by the repetition check) that the
    session appends, so an owed move is never lost to the model (a reply that already asked
    a question gets no second negotiation question: that line then waits).
    ``compose_speech`` builds the final text for callers that do not stream.  The 19:00 stall
    is an INTENT without markers: one short model reaction, then the scripted WEAK line, always.
``LLM_REPLY``
    A free, constrained reply using ``plan.reminder`` (a HINT for a first probe, the DEEP
    need's facts only on the turn that asks about a released topic, and now and then one
    curiosity topic), screened sentence by sentence by ``plan.guard_ctx``.
``EXIT``
    The candidate said goodbye again, or (``"end_confirmed"`` in ``plan.reasons``) confirmed an
    out-of-role request to stop before R = 14:00 with no commitment on record: the session moves
    to ROLEPLAY_EXIT and the interviewer's normal wrap-up follows (owner decision 2026-10-29).  An
    early end is scored only when the normal fidelity checks pass (``fidelity``: R reached 10:00,
    every family delivered, and the rest).  From 14:00, or with a commitment on record, an end
    request is a farewell on the close ladder instead.  ``"wrap_offer_accepted"``: the candidate
    said yes to the interviewer's offer to wrap up (M2, below).  Owner decision 2026-10-30: the
    session may hand ``plan_turn`` the end-intent model's verdict (``end_intent``), which can only
    raise the lexical reading ("wrap up the interview", "kindly end the interview", "end the inter
    view"), and a settled bare yes ("Yes.", "Haan ji.") answers L-ASIDE-END (``confirmed_yes``).

The wrap-up offer (owner and manager decisions of 2026-11-03, M2): the role-play no longer ends by
itself once the commitment is resolved.  From R = 14:00, when the commitment is resolved or the
call is going nowhere, the interviewer OFFERS to wrap up (``plan.aside`` with ``plan.line_id``
L-ASIDE-WRAP), only at a natural pause: a candidate turn that asks, digs and pitches nothing and
does not answer a question of the learner's, or (``wrap_offer_at_pause``) a quiet after her line.
At most ``WRAP_OFFER_LIMIT`` offers, none for ``WRAP_OFFER_COOLDOWN_SEC`` after a no, none from
``WRAP_OFFER_UNTIL_R_SEC``.  The next turn answers it: a yes is the EXIT (``wrap_offer_accepted``),
a no gets L-ASIDE-WRAP-RESUME and the role-play goes on, and talk to the learner is a no that she
answers.  The hard end at 20:00 stays the session's (with the learner's L-TIME-UP before L-EXIT).

Repetition control (R1-Q): ``record_spoken`` feeds every sentence the learner actually
played into a ``SpokenMemory``; each plan's guard context carries a snapshot (``said``), so
the output guard drops a sentence the learner already said (a ``repeat`` hit: hygiene, never
posted).  The thinking filler and the guard fallback are 3-variant rotations seeded by the
attempt id (``filler_text``, ``GuardContext.variant``), and so are the scripted variants of
every intent.

Negotiation (R1-Q): ``self.negotiation`` (``r1_negotiation``) remembers what the advisor put on
the table (prices, callbacks, an e-mail offer, check-ins), which of the learner's stall reasons
(timing, money, decision maker) were raised and which the advisor handled.  An ask before the
close window is met with the next unused reason (or the owed F4 move, or any forced move; timing
and the decision maker are the F4 pair's own reasons and are never voiced early as well); an
ask inside the window is graded with the handled reasons as evidence.  The price counter
follows the advisor's actual answer, the anchor reacts to a price already on the table, and the
wrap turn reacts to the number on the table.  Once a scripted commitment line is on record, the
guard's commitment cap is that level, so the learner can confirm the call it booked.

Nothing here can change a phase, a grade or the schedule from candidate or model text
beyond the deterministic rules: the LLM has no tools, the judge's JSON is whitelisted,
and farewell/ask detection is lexical.  An intent's brief is worker-authored and never holds
candidate text.  The engine never stores candidate text; its logs hold turn indices, counts
and booleans only.

Integration sketch for ``r1_session`` (the follow-up change; one call per final candidate
transcript in ROLEPLAY, with ``r_sec`` read from the phase machine's role-play clock)::

    engine = RolePlayEngine(resolve_persona(pid, variant=v, seed=attempt_id,
                                            avoid_first_name=first_name),
                            candidate_first_name=first_name, seed=attempt_id)
    plan = engine.plan_turn(text, machine.roleplay_elapsed, turn_index=i,
                            backchannel=is_acknowledgement_turn(text),
                            repair=is_repair_turn(text),
                            answers_nothing=is_backchannel_turn(text))
    (after a barge-in cut the learner's line: an owed move it did not deliver waits one turn
     while the plan has a turn to spare, a lone acknowledgement only gets her point finished and
     a "Sorry?" gets it again, and a graded commitment line she did not finish is said again;
     see ``record_spoken``.  A reply cancelled before any audio is reported with
     ``engine.reply_lost(plan)``)
    if plan.exit_roleplay:            -> machine.transition(ROLEPLAY_EXIT), L-EXIT, the wrap-up
    elif plan.aside:                  -> ASIDE phase, say(plan.scripted_text), back to ROLEPLAY
    elif plan.mode is SAY_ONLY:       -> raise StopResponse; say(plan.scripted_text)
    else (INTENT or LLM_REPLY):       -> add plan.reminder as the ephemeral system message;
                                         llm_node streams through engine.stream_guard(plan);
                                         for an INTENT, once the stream ended, append
                                         engine.intent_tail(plan, <what was streamed>)
    afterwards: engine.record_spoken(plan, spoken_text, interrupted=...),
                messages = engine.judge_messages(text, learner_last, turn=plan.turn)
                ... later, off the speech path (possibly after the NEXT plan_turn):
                engine.apply_judge(shadow_judge_output, plan.turn)  (the turn it judged)
    at the end: post engine.admin_log(final=True, r_end=...) and persist
                ``interview_round_attempts.content_sha`` = ``r1_content.CONTENT_SHA256``.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, replace
from enum import Enum
from typing import Any, Iterable

from r1_commitment import (
    COMMIT_STALL_R_SEC,
    THIN_ADVISOR_MEAN_WORDS,
    THIN_MIN_TURNS,
    AskKind,
    CommitmentEvidence,
    Level,
    classify_learner_commitment,
    commitment_line,
    detect_ask,
    grade,
)
from r1_content import CONTENT_SHA256, CONTENT_VERSION
from r1_guard import (
    COURSE_FACT,
    ONE_MENTION_PHASES,
    QUESTION_DIET_WINDOW,
    REPEAT,
    GuardContext,
    GuardLedger,
    GuardResult,
    StreamGuard,
    advisor_terms_in,
    advisor_text_of,
    course_length_unsaid,
    durations_said,
    echoed_need_topics,
    guard_text,
    has_concession,
    hours_said,
    offers_choice,
)
from r1_negotiation import (
    ANCHOR_STATED_CONFLICT,
    ANCHOR_USD,
    COMMIT_REACTION_BRIEF,
    COMMIT_REACTION_BRIEF_V2,
    CONFLICT_RISE,
    CONFLICT_WEBSITE,
    IMPLAUSIBLE_FREE,
    IMPLAUSIBLE_LOW,
    IMPLAUSIBLE_NET_USD,
    KIND_COMMIT,
    KIND_STALL,
    MIN_FRAMED_NET_USD,
    N_PRICE_FIRST,
    PRICE_CUE_BUDGET,
    PRICE_FIRST_SPEC,
    SITUATION_SHORT,
    SITUATION_UNCLEAR,
    YOUR_NUMBER_COUNTER_SUFFIX,
    YOUR_NUMBER_MONTHLY,
    AnchorSituation,
    anchor_after_free,
    anchor_after_stated,
    anchor_check,
    asks_price,
    conflict_counter,
    money_spec,
    price_cue,
    stated_price_usd,
    OFFER_TERMS,
    TERM_FREE_EXTRA,
    TERM_INSTALMENTS,
    N_DECISION_MAKER,
    N_EMAIL,
    N_EMAIL_YES,
    N_MONEY,
    N_TIMING,
    REASON_DECISION_MAKER,
    REASON_MONEY,
    REASON_TIMING,
    SPEC_BY_ID,
    SPEC_BY_REASON,
    Negotiation,
    NegotiationSpec,
    NegotiationTurn,
    anchor_after_offer,
    anchor_after_unclear_low,
    declines_call,
    fill_decision_maker,
    filled_markers,
    her_number_question,
    implausible_offer_in,
    monthly_amounts,
    instalments_are_monthly,
    no_commit_spec,
    offer_terms_in,
    question_spec,
)
from r1_personas import (
    H_TOPICS,
    MONTHLY_BUDGET_MAX_USD,
    RenderedPersona,
    asks_about_learner,
    detect_probes,
    has_question,
)
from r1_prompts import (
    ACK_TURN_CONCERNS_NOTE,
    ACK_TURN_CONCERNS_NOTE_V2,
    ACK_TURN_NOTE,
    ACK_TURN_NOTE_V2,
    ANCHOR_NOT_OFFERED_NOTE,
    ANSWERED_NOTE,
    ANSWERED_YOU_NOTE,
    ANSWERED_YOU_NOTE_V2,
    ASKED_DIRECTLY_NOTE,
    BACKCHANNEL_CUT_NOTE,
    CHALLENGE_NOTE,
    CALLER_NAME_ONLY_EXAMPLES,
    CALLER_NAME_ONLY_NOTE,
    CALLER_UNKNOWN_EXAMPLES,
    CALLER_UNKNOWN_NOTE,
    CHECKIN_DONE_NOTE,
    BUDGET_OVER_NOTE,
    CHECKIN_NOTE,
    CLOSE_NOTE,
    CLOSE_NOTE_COOL,
    COACH_RESUME_NOTE,
    CONTINUE_NOTE,
    COOL_NOTE,
    CONCERN_LABELS,
    DECIDER_ASKED_NOTE,
    DECIDER_SAID_NOTE,
    EMAIL_AGAIN_NOTE,
    EMAIL_OFFER_NOTE,
    FIGURE_CHALLENGE_NOTE,
    FINAL_ASKED_NOTE,
    FLOOR_NOTE,
    PROPOSAL_UNANSWERED_NOTE,
    HOW_ARE_YOU_EXAMPLES,
    HOW_ARE_YOU_NOTE,
    NO_REPEAT_REASK_NOTE,
    YOUR_NUMBER_MET_NOTE,
    YOUR_NUMBER_MONTHLY_NOTE,
    YOUR_NUMBER_TOTAL_NOTE,
    OPEN_QUESTION_AFTER_ASK_NOTE,
    OPEN_QUESTION_NOTE,
    PRICE_CONFLICT_WEBSITE_NOTE,
    PRICE_MET_NOTE_EARLY,
    PRICE_MET_NOTE_EARLY_V2,
    PRICE_REFLEX_BUDGET_NOTE,
    PRICE_REFLEX_EXAMPLES,
    PRICE_REFLEX_NOTE,
    PRICE_RISE_NOTE,
    HINGE_USED_NOTE,
    HOLD_NOTE,
    HOLD_NOTE_V2,
    HOLLOW_CONCERNS_NOTE,
    HOLLOW_NOTE,
    CUT_REPEAT_NOTE,
    CUT_REPEAT_NOTE_V2,
    IMPLAUSIBLE_FREE_NOTE,
    IMPLAUSIBLE_PRICE_NOTE,
    INTENT_OPENER_NOTES,
    INTERRUPTED_NOTE,
    INTERRUPTED_NOTE_V2,
    LENGTH_LONG,
    LENGTH_ONE,
    LENGTH_ONE_OR_TWO,
    LENGTH_VERY_SHORT,
    NEXT_STEP_PROPOSED_NOTE,
    NO_COMMIT_INTENT_NOTE,
    NOT_ANSWERED_NOTE,
    NOT_TODAY_RESERVED_NOTE,
    OFFER_MADE_NOTE,
    OFFER_MADE_NOTE_V2,
    OFFER_TERMS_FREE_EXTRA,
    OFFER_TERMS_HEADER,
    OFFER_TERMS_IN_PARTS,
    OFFER_TERMS_INSTALMENTS,
    PRESSURE_EASED_NOTE,
    PRICE_MET_NOTE,
    PRICE_UNCHANGED_NOTE,
    PUSH_REACT_NOTE,
    PUSH_REACT_NOTE_V2,
    RESOLVED_NOTE,
    ROLE_CONFUSION_EXAMPLES,
    ROLE_CONFUSION_NOTE,
    SHORT_ON_TIME_CONCERNS_NOTE,
    SHORT_ON_TIME_NOTE,
    SOFT_TIC_NOTE,
    STRETCH_USED_NOTE,
    STYLE_NOTES,
    STYLE_NOTES_V2,
    TEMPLATE_USED_NOTE,
    TRY_NOT_GRANTED_NOTE,
    VERDICT_USED_NOTE,
    VOICED_CONCERNS_ASKED_NOTE,
    VOICED_CONCERNS_NOTE,
    control_prose,
    format_usd,
    interviewer_prefix,
    learner_prefix,
    turn_reminder,
)
from r1_scheduler import (
    ANSWERED_LABELS,
    COMMIT_STALL,
    CURIOSITY_EVERY,
    CURIOSITY_LABELS_V2,
    OPEN_QUESTION_LABELS,
    CURIOSITY_TOPICS,
    EARLY_CLOSE_BEFORE_SEC,
    CloseDecision,
    F4_PRIMARY_SAID_SUFFIX,
    F4_PRIMARY_SAID_VARIANTS,
    PREEMPTED_F2_FORMAT,
    PREEMPTED_LABELS,
    PREEMPTED_SUFFIX,
    SPEC_BY_ID as MOVE_SPEC_BY_ID,
    F1_ANCHOR,
    F1_COUNTER,
    F2_PRIMARY,
    F2_PUSH,
    F3_PRIMARY,
    F3_PUSH,
    F4_PRIMARY,
    F4_PUSH,
    F4_PUSH_CALL_SUFFIX,
    FAMILIES,
    TIME_CUE_SEC,
    IDLE_GAP_TURNS,
    LAST_POINT_BRIEF,
    PLAN,
    REDIRECT_BRIEF,
    REDIRECT_OPENERS,
    TIME_CUE,
    TIME_CUE_BRIEF_ALTERNATIVES,
    TIME_CUE_BRIEF_V2,
    PROBE_F1,
    PROBE_F1_AGAIN,
    PROBE_F1_CLARIFY,
    PROBE_F2,
    F2_PRIMARY_WORRY_V2,
    Moment,
    OwedMove,
    OwedMoveScheduler,
    ProbeSpec,
    asks_her_number,
    probe_first_texts,
    answered_topics,
    answers_substantively,
    asks_for_floor,
    asks_her_directly,
    dodged_question,
    backs_off,
    courtesy_goodbye,
    courtesy_only,
    hands_over_close,
    curiosity_asked_in,
    curiosity_covered,
    f4_push_said,
    is_close_attempt,
    is_pitch_statement,
    markers_match,
    offers_floor,
    offers_something,
    open_question_covered,
    open_question_topics,
    preempting_topics,
    quotes_price,
    tells_something,
    worry_answered,
)
from r1_script import LEARNER_FILLER_SHORT, LEARNER_FILLER_VARIANTS
from r1_script import line as script_line
from r1_text import (
    CALLER_KNOWN,
    CALLER_NAME_ONLY,
    asked_who_is_calling,
    asks_for_email,
    asks_how_she_is,
    caller_introduced,
    PHRASE_DECIDER_STALL,
    PHRASE_STRETCH,
    PHRASE_TEMPLATE_Q,
    SOFT_TICS,
    SpokenMemory,
    CONCERN_NOT_TODAY,
    CONCERN_PRESSURE,
    CONCERN_THINK_OVER,
    ack_hinge,
    canonical_amounts,
    concern_themes,
    doubt_opener,
    dollar_amounts,
    expand_shorthand_amounts,
    fold,
    fuzzy_contains,
    is_closer,
    is_hollow_turn,
    is_sign_off,
    normalize,
    not_deciding,
    pick_variant,
    repeat_kind,
    reply_opener,
    reply_phrases,
    reply_tics,
    reply_verdict,
    split_sentences,
    word_count,
)
from r1_tracker import (
    END_INTENT_LEVELS,
    CoverageTracker,
    NeedState,
    accepts_wrap_offer,
    build_judge_messages,
    confirms_end,
    declines_end,
    declines_wrap_offer,
    detect_abuse,
    detect_character_break,
    role_confusion_in,
    end_intent_level,
    is_bare_yes,
    is_short_wrap_yes,
    parse_judge_output,
    promises_call_back,
    urgency_levers,
)
from r1_world import WORLD_VERSION

STALL_DEFER_GRACE_SEC = 30
# An ask in the very first advisor turn is the greeting, not a close (it is not graded, not held
# open for a farewell, and does not make the learner voice a stall reason).
EARLY_ASK_IGNORE_SEC = 30
MAX_ASIDES = 3
MIN_SUBSTANTIVE_TURNS = 8
SUBSTANTIVE_WORDS = 3
STT_SHORT_WORDS = 2
STT_SHORT_SHARE_LIMIT = 0.10
FIDELITY_MIN_R_SEC = 600
# The advisor text one turn's readers parse (its last characters): a cost bound only.
MAX_CANDIDATE_CHARS = 4000

KIND_OBJECTION = "objection"
KIND_REDIRECT = "redirect"
KIND_CUE = "cue"
# M032 S2P (S2 item 10): a probe, the short price or time question before a family's owed point.
KIND_PROBE = "probe"
# Her price questions the advisor answered without a figure, before she checks the website's price.
MAX_PRICE_DODGES = 2
# A probe spends a turn only while every owed graded move can still land by its family's deadline
# at this many turns each (``RolePlayEngine._probe_slack``).  On the bunching grid (2026-11-12) 2.0,
# 2.5 and 3.0 gave the same rows; with no slack check the probes at 35-65 s an exchange forced 13
# more moves and made F1 and F4 late for three patterns.  After the S2P review (R 10:00 no longer
# bounds a probe) 1.5 forced one move more than the release before, 2.0 none.
PROBE_TURNS_PER_MOVE = 2.0
# SWEEP-20: the early-close redirect's probe lines (scripted and pinned in ``r1_script``; a SAY_ONLY
# plan's text, spoken in the learner's voice through the reply stream like the redirect before them,
# so, like it, not warm-cached: only a ``session.say`` line can play cached audio).
REDIRECT_PRICE_LINE = "L-REDIRECT-PRICE"
REDIRECT_TIME_LINE = "L-REDIRECT-TIME"
# SWEEP-22: at most this many price-reflex notes per session.
PRICE_REFLEX_LIMIT = 2
# Review S2P-R1 (naturalness): the advisor's "free" is what the anchor or the counter reacts to only
# on the turn it was said and the next (``RolePlayEngine._free_fresh``).
FREE_FRESH_TURNS = 1
_PROBE_MARKERS = {"F1": PROBE_F1.markers, "F2": PROBE_F2.markers}
# How many of the learner's last replies the style rules look back over (``r1_guard``).
STYLE_HISTORY = 8
# Situation notes that belong to a free reply: an intent has its own brief to voice.
_FREE_REPLY_NOTES = frozenset({ANCHOR_NOT_OFFERED_NOTE, TRY_NOT_GRANTED_NOTE, ASKED_DIRECTLY_NOTE})
# The advisor challenges the learner's own words or how the learner is asking (owner test
# 7f2a25e6: 56 "where did you get that number?", 58 "you are asking too many questions").  Read
# sentence by sentence; "where did you get your degree?" is a dig, not a challenge.  A sales point
# that opens the same way is not one either (reviewed fix): "I didn't mention it earlier, but we
# also have EMI", "why do you ask? Is budget a big concern?" (a sales technique), "you keep asking
# great questions".
_CHALLENGE = re.compile(
    r"\bwhere did you (?:get|hear|read) (?:that|this|it|those|these|the idea|the number)\b"
    r"|\bi (?:didn'?t|did not|never) (?:say|said|mention|mentioned|tell you|told you) "
    r"(?:anything|that|this|it|so)\b(?!.*\b(?:but|earlier|before|yet|however|also)\b)"
    r"|\bwhy (?:are|do) you keep ask(?:ing)?\b"
    r"|\bwhy are you (?:still |always )?asking (?:me )?"
    r"(?:so many|the same|all th(?:is|ese)|again)\b"
    r"|\btoo many questions\b"
    r"|\byou keep asking (?:me|so many|the same|all th(?:is|ese)|again|questions)\b",
    re.IGNORECASE,
)
# Owed moves held back for a challenge in one session: a combative advisor cannot stall the plan.
MAX_CHALLENGE_DEFERRALS = 2
# A cut or challenged objection waits a turn only while the plan is ahead of its pacing map
# (``RolePlayEngine._ahead_of_pacing``).  Each objection still owed is given this many turns: the
# idle gap a primary waits when the advisor never invites it, plus one for a cut.  On the final
# review's bunching grid (six advisor patterns x 20, 25, 35, 50 and 65 s an exchange) 4 is never
# worse than the release without holds on forced moves, slip or deliveries; 2.5 forced the F4 pair
# at 35 s, and 3 or 3.5 delivered the time cue up to 12 s later.
SLACK_TURNS_PER_MOVE = IDLE_GAP_TURNS + 1
# Each family's required moves and their shared deadline, in plan order (the pacing map).
_PACING_MAP: tuple[tuple[int, tuple[str, ...]], ...] = tuple(
    (
        max(spec.deadline_sec or 0 for spec in PLAN if spec.family == family and spec.required),
        tuple(spec.id for spec in PLAN if spec.family == family and spec.required),
    )
    for family in FAMILIES
)
# A turn this short that says no "no" leaves L-ASIDE-END's question open: speech-to-text finalises
# a lone "Hmm", "Okay." or "Yeah." about a second before the rest (owner test 7f2a25e6, 43/55/70).
END_FRAGMENT_WORDS = 2
# Voice barge-in: how often a graded commitment line that was played and then cut by a barge-in is
# said again on a later turn, per session.  A line the candidate never heard a word of (cancelled
# before any audio, ``reply_lost``) is said again as well, without counting.
COMMITMENT_REVOICE_LIMIT = 2
# Owner and manager decisions of 2026-11-03 (M2, mock call aa166f09: L-EXIT cut off a discovery
# question at 15:42).  Leaving the role-play is the candidate's choice: the early exit (commitment
# resolved and R >= 14:00, then L-EXIT at the next turn) is now the interviewer's OFFER to wrap up,
# L-ASIDE-WRAP, an aside with R paused.  14:00 is still the earliest point; the offer is made when
# the commitment is resolved or the call is going nowhere, never on a turn that asks something,
# digs or pitches and never right after the learner asked a question (it waits for a natural pause,
# a candidate turn that only acknowledges or closes, or ``WRAP_OFFER_PAUSE_SEC`` of quiet in the
# session), at most ``WRAP_OFFER_LIMIT`` times and not again for ``WRAP_OFFER_COOLDOWN_SEC`` of R
# after a no.  From ``WRAP_OFFER_UNTIL_R_SEC`` on it is not made: the 17:00 time cue has been said
# and the closing line at 20:00 is close.
WRAP_OFFER_LINE = "L-ASIDE-WRAP"
WRAP_RESUME_LINE = "L-ASIDE-WRAP-RESUME"
WRAP_OFFER_FROM_R_SEC = float(EARLY_CLOSE_BEFORE_SEC)
WRAP_OFFER_UNTIL_R_SEC = 1110.0
WRAP_OFFER_LIMIT = 2
WRAP_OFFER_COOLDOWN_SEC = 180.0
WRAP_OFFER_PAUSE_SEC = 6.0
# A no this short (and with no question) is said to the interviewer alone: she hands back with
# L-ASIDE-WRAP-RESUME.  A longer one goes on to the learner, who answers it.
WRAP_NO_WORDS = 8
# A candidate turn longer than this (or one that quotes a price) is a pitch: no offer over it.
WRAP_PITCH_WORDS = 20
# A next step put on the table is selling too ("Let me book fifteen minutes with you and your
# partner on Friday.", "I'll send you the payment link."): no offer over it.
_WRAP_NEXT_STEP = re.compile(
    r"\b(?:book|schedule|set up|arrange|enrol+|sign (?:you )?up|register|pay|payment|link|"
    r"deposit|demo|session|meeting|call (?:you|back)|meet)\b",
    re.IGNORECASE,
)
# Discovery that speech-to-text left without its question mark ("so you said you want to move to
# a proper corporate from academia what is your challenge currently"): no offer over it either.
_WRAP_DISCOVERY = re.compile(
    r"\b(?:what|how|why|when|where|which|who)(?: exactly)? (?:is|are|was|were|do|does|did|would|"
    r"could|can|should|will|kind|made|makes|about)\b"
    r"|\b(?:you said|you mentioned|tell me|help me understand|i want to understand|"
    r"can i (?:ask|understand|know)|may i (?:ask|know))\b",
    re.IGNORECASE,
)
# Review fix: the words a pause turn may be made of (on folded text, apostrophes dropped):
# acknowledgement, courtesy, a closing and "I'll send it over".  Any other word (a noun, a
# question word, "explain", "hear", "budget", "your") leaves the turn to the learner.
_WRAP_PAUSE_WORDS = frozenset(
    {
        "okay", "ok", "alright", "all", "right", "sure", "yes", "yeah", "yep", "yup",
        "great", "good", "perfect", "fine", "cool", "nice", "wonderful", "awesome",
        "excellent", "lovely", "brilliant", "thanks", "thank", "you", "so", "much",
        "very", "for", "your", "time", "the", "call", "chat", "talking", "chatting",
        "speaking", "hmm", "hm", "mm", "mhm", "uh", "um", "oh", "ah", "well", "noted",
        "got", "it", "understood", "no", "problem", "worries", "absolutely", "definitely",
        "of", "course", "sounds", "thats", "that", "fair", "enough", "makes", "sense",
        "i", "ill", "will", "send", "share", "over", "across", "then", "bye", "goodbye",
        "take", "care", "have", "a", "day", "evening", "appreciate", "glad", "to",
        "hear", "see", "im", "happy", "is", "was", "really", "indeed", "exactly",
        "lot",
    }
)
# Only as a whole closing ("glad to hear that", "I'll see"), never as a lead-in: "hear"
# with "me out" or "about", "your" with anything but "time" are not pause words above,
# because their neighbours are not.  A turn that stops on one of these is unfinished.
_WRAP_DANGLING_WORDS = frozenset(
    {"and", "but", "or", "so", "the", "a", "to", "for", "your", "is", "was", "i",
     "of", "have", "will", "ill", "very"}
)
# A lead-in to a pitch or a question, however short ("Let me explain ...", "Hear me out").
_WRAP_LEAD_IN = re.compile(
    r"\b(?:let me|hear me|here's the thing|heres the thing|have you|do you|would you|"
    r"are you|is it|is that|is there|any|anything)\b"
)
# "Going nowhere": this many advisor turns in a row that raised nothing new (no topic the advisor
# had not covered, no probe, no new figure), this many hollow turns in a row ("Okay.", "Sure."), or
# this many stall reasons the learner gave from 14:00 on.
WRAP_STALE_TURNS = 5
WRAP_HOLLOW_TURNS = 3
WRAP_LATE_STALLS = 2
_STALL_REASON_IDS = frozenset({N_TIMING, N_MONEY, N_DECISION_MAKER})
# L1 (mock call aa166f09).  A curiosity topic handed over this many times without the learner
# asking it is not handed over again (it is not "asked" either: a check-in may still raise it).
CURIOSITY_OFFER_LIMIT = 2
# L2 (mock call aa166f09: 18 of 41 replies tacked a new worry onto a short acknowledgement).  While
# the advisor is mid-discovery (a question about the learner), an owed move that no deadline forces
# waits up to this many more turns, beyond the one dig deferral, as long as the plan has slack
# (``_may_hold``): the forced path and the deadlines are unchanged, so every family still lands.
DISCOVERY_HOLD_LIMIT = 2
# L5: a monthly figure above the card's budget is checked by the guard for this many turns after
# the advisor named it (``GuardContext.monthly_quote_usd``).
MONTHLY_QUOTE_TURNS = 3
# M032 S3 (endings and abuse).  The closing state (S3.2): OPEN, WINDING (the advisor is closing the
# call and her reply is one short goodbye), CLOSED (she said it).  The early-close question (S3.3,
# D-M032-2) is asked at most this often per session, with its own line below R = 10:00, where a stop
# leaves the attempt unscored; the hang-up (S3.4, D-M032-3) at most this often.  Both are offers
# answered like L-ASIDE-WRAP (``_wrap_answer_plan``), told apart by their trigger.
CLOSING_OPEN = "open"
CLOSING_WINDING = "winding"
CLOSING_CLOSED = "closed"
EARLY_CLOSE_ASK_LIMIT = 2
EARLY_CLOSE_LINE = "L-ASIDE-EARLY-CLOSE"
EARLY_CLOSE_TIME_LINE = "L-ASIDE-EARLY-CLOSE-TIME"
LAST_POINT_LINE = "L-ASIDE-LAST-POINT"
HANGUP_LINE = "L-LEARNER-HANGUP"
HANGUP_ASIDE_LINE = "L-ASIDE-HANGUP"
HANGUP_LIMIT = 2
# M032 SWEEP-33 (R1_FLOOR_YIELD): at most this many scripted yields a session; the pairs rotate.
FLOOR_YIELD_LIMIT = 3
# M032 SWEEP-7 (R1_COME_BACK): at most this many come-backs a session (one per topic), given on a
# free reply within this many learner turns of the dodge.
COME_BACK_LIMIT = 2
COME_BACK_WINDOW_TURNS = 2
FLOOR_YIELD_LINES = ("L-LEARNER-YIELD", "L-LEARNER-YIELD-2")
FLOOR_YIELD_SORRY_LINES = ("L-LEARNER-YIELD-SORRY", "L-LEARNER-YIELD-SORRY-2")
TRIGGER_EARLY_CLOSE = "early_close"
TRIGGER_ABUSE = "abuse"
# The asides whose triggering turn was said to the learner, in role: its row stays a role-play row.
IN_ROLE_ASIDE_REASONS = ("wrap_offer:", "early_close:", "abuse_hangup")

# M032 S1 (learner timing + memory, owner decisions D-M032-1 and D-M032-4).  Each behaviour has a
# rollback flag, read at use, default ON; "0", "off", "false" or "no" restores the behaviour of
# before (``fly secrets set R1_NATURAL_TIMING=0 -a project-hello-voice``, and the same for the
# others):
#
# * R1_NATURAL_TIMING: while the plan has slack, an owed primary on the idle path waits for a
#   natural moment (``r1_scheduler.Moment``); a decision-maker stall she volunteers in a free reply
#   counts as an objection for spacing (never as a voiced reason for grading).
# * R1_RESPOND_FIRST: an offer, a back-off, a question put to her or an answer to her own question
#   is responded to first (one-turn hold of an unforced owed move, once per move, only with slack;
#   no curiosity hand-over that turn); a back-off clears the standing hold on a proposed next step.
# * R1_CONCERN_LEDGER: a theme she already voiced (pressure twice) is not voiced again in a free
#   reply.
# * R1_SPLIT_REPLAN: a real continuation after a reply lost before any audio is planned from both
#   halves (their text for the readers, the monologue, the disclosure layers and their hold) and
#   the move the lost plan issued is issued once.
# * R1_PUSH_AFTER_REACTION (SWEEP-1, folded into item 2): when her last heard line delivered a
#   family's primary, its unforced F2, F3 or F4 push waits ONE turn and that reply reacts to the
#   advisor's answer first (PUSH_REACT_NOTE); it shares the respond-first once-per-move budget.
FLAG_NATURAL_TIMING = "R1_NATURAL_TIMING"
FLAG_RESPOND_FIRST = "R1_RESPOND_FIRST"
FLAG_CONCERN_LEDGER = "R1_CONCERN_LEDGER"
FLAG_SPLIT_REPLAN = "R1_SPLIT_REPLAN"
FLAG_PUSH_AFTER_REACTION = "R1_PUSH_AFTER_REACTION"
# M032 S2, learner voice (owner decisions D-M032-4 and D-M032-7), each default ON with the same
# rollback (``fly secrets set <FLAG>=0 -a project-hello-voice``):
#
# * R1_LEARNER_VOICE_V2 (items 1-9, SWEEP-4, SWEEP-5's note texts): an owed point grows out of what
#   the advisor said or comes as an honest change of subject, never "[ack], but"; an opener note and
#   the delivery rider on every reply; F3 and F2 worries as objectives with statement fallbacks
#   first; a pre-empted topic is raised in light of what she was told; no grading of an answer that
#   did not answer her; the next reply after a hinge or a verdict opener is told so; she carries on
#   after the coach aside without greeting again; the offer notes have one text each.
# * R1_NO_COMMIT_LEDGER (SWEEP-3): the not-today stall belongs to F4-PRIMARY.
# * R1_OFFER_TERMS (SWEEP-5): she reacts to instalments or a free extra that came with an offer.
# * R1_ACK_TURN_NOTE (SWEEP-11): a lone "okay" or "hmm" gets a short reply that keeps her question.
# * R1_TIC_V2 (SWEEP-12): the wider honesty tic, the soft tics and rotated curiosity labels.
# * R1_OFFER_REALISM (SWEEP-13): a price far below expectation or a free course gets a careful
#   buyer's surprise (latched per session: it changes one prefix sentence).
# * R1_REPLY_LENGTH (SWEEP-14): a free reply's length follows the advisor's turn.
FLAG_LEARNER_VOICE_V2 = "R1_LEARNER_VOICE_V2"
FLAG_NO_COMMIT_LEDGER = "R1_NO_COMMIT_LEDGER"
FLAG_OFFER_TERMS = "R1_OFFER_TERMS"
FLAG_ACK_TURN_NOTE = "R1_ACK_TURN_NOTE"
FLAG_TIC_V2 = "R1_TIC_V2"
FLAG_OFFER_REALISM = "R1_OFFER_REALISM"
FLAG_REPLY_LENGTH = "R1_REPLY_LENGTH"
# M032 S2P, probe first (owner decision D-M032-7), each default ON with the same rollback:
#
# * R1_PROBE_FIRST (S2 item 10, SWEEP-2, 16, 17, 20, 22, 23): she knows no course fact (the card and
#   the prefix say so, latched per session), asks before she states, reacts to the advisor's own
#   figures, and raises the website price only as a check; the guard allows only figures that were
#   said or are owed.
# * R1_OFFER_READER_V2 (SWEEP-18): a dollar discount comes off the price the advisor named, an
#   explicit net wins, and the base carries over a split turn.
# * R1_COUNTER_V2 (SWEEP-19): the F1 counter matches the number on the table.
# * R1_PRICE_CONFLICT (SWEEP-21): one check, as a question, when the advisor's price differs from
#   the website or from his own earlier offer (latched per session: it changes one prefix
#   clause).
FLAG_PROBE_FIRST = "R1_PROBE_FIRST"
FLAG_OFFER_READER_V2 = "R1_OFFER_READER_V2"
FLAG_COUNTER_V2 = "R1_COUNTER_V2"
FLAG_PRICE_CONFLICT = "R1_PRICE_CONFLICT"
# M032 S3, endings and abuse (owner decisions D-M032-2, D-M032-3 and D-M032-4), each default ON with
# the same rollback, except R1_WRAPUP_NEXT_ROUND (default OFF until the owner and HR confirm the
# second round):
#
# * R1_CLOSING_STATE (S3.1, S3.2): an advisor's hand-over close ("call me back later", "get back to
#   me") and a courtesy turn after her own sign-off are read as closes; the engine's closing state
#   (OPEN, WINDING, CLOSED) gives a free reply in WINDING one short goodbye and no new question; and
#   HOLD_NOTE no longer tells her to keep the conversation going.
# * R1_EARLY_CLOSE_ASIDE (S3.3): before R = 14:00 an in-role close the ladder would end the
#   role-play on is asked about instead (L-ASIDE-EARLY-CLOSE, at most twice); a yes ends it, a no
#   resumes it and the learner carries on with a real point.
# * R1_ABUSE_HANGUP (S3.4): abuse aimed at her ends the call in character (L-LEARNER-HANGUP), and
#   Christy asks (L-ASIDE-HANGUP); scoring is unchanged.
# * R1_LATE_END_REQUEST (SWEEP-24): from R = 14:00 an explicit request to end the exercise is
#   never answered in role: it exits, or (one owed move left) L-ASIDE-LAST-POINT and that point.
# * R1_WEAK_EMAIL_V2 and R1_COMMIT_REACTION_V2 (SWEEP-25), R1_TIME_CUE_V2 (SWEEP-27), and the
#   wrap-up's R1_WRAPUP_DECLINE_V2 (S3.5), R1_WRAPUP_ANSWERS, R1_WRAPUP_ONE_MENTION and
#   R1_WRAPUP_NEXT_ROUND (SWEEP-26), read by the session.
FLAG_CLOSING_STATE = "R1_CLOSING_STATE"
FLAG_EARLY_CLOSE_ASIDE = "R1_EARLY_CLOSE_ASIDE"
FLAG_ABUSE_HANGUP = "R1_ABUSE_HANGUP"
FLAG_LATE_END_REQUEST = "R1_LATE_END_REQUEST"
FLAG_WEAK_EMAIL_V2 = "R1_WEAK_EMAIL_V2"
FLAG_COMMIT_REACTION_V2 = "R1_COMMIT_REACTION_V2"
FLAG_TIME_CUE_V2 = "R1_TIME_CUE_V2"
FLAG_WRAPUP_DECLINE_V2 = "R1_WRAPUP_DECLINE_V2"
FLAG_WRAPUP_ANSWERS = "R1_WRAPUP_ANSWERS"
FLAG_WRAPUP_ONE_MENTION = "R1_WRAPUP_ONE_MENTION"
FLAG_WRAPUP_NEXT_ROUND = "R1_WRAPUP_NEXT_ROUND"
# M032 S7L, learner follow-ups from the transcript sweep (owner decisions D-M032-4 and D-M032-7),
# each default ON with the same rollback (SWEEP-15's notes ride on R1_LEARNER_VOICE_V2):
#
# * R1_PRICE_MEMORY (SWEEP-6): "what number works for you?" after her anchor gets her own figure
#   from the card (total, monthly, or "what you offered is about what I hoped"), and the guard drops
#   "I'll take the price" (a MISREAD hygiene rule).
# * R1_COME_BACK (SWEEP-7): a question of hers the advisor dodged is asked again once, in other
#   words (at most twice a session); a dodge is no answer for the respond-first notes.
# * R1_PERSONA_TIMELINE_V2 (SWEEP-8): the card says she is at home when they call, the webinars are
#   dated, and her goal has no competing deadline (latched per session: it changes the card).
# * R1_CALL_OPENING (SWEEP-9): when the advisor has not said who is calling she asks, and she asks
#   back "and you?" when asked how she is.
# * R1_ROLE_CONFUSION_V2 (SWEEP-10): "sell it to me" and "I want to buy, not sell" are read as the
#   advisor mixing up the roles; after the coach aside a repeat gets a role note, not the AI note.
# * R1_FLOOR_YIELD (SWEEP-33): "Can I talk?" or "Let me finish" gets a scripted yield and no point.
FLAG_PRICE_MEMORY = "R1_PRICE_MEMORY"
FLAG_COME_BACK = "R1_COME_BACK"
FLAG_PERSONA_TIMELINE_V2 = "R1_PERSONA_TIMELINE_V2"
FLAG_CALL_OPENING = "R1_CALL_OPENING"
FLAG_ROLE_CONFUSION_V2 = "R1_ROLE_CONFUSION_V2"
FLAG_FLOOR_YIELD = "R1_FLOOR_YIELD"
# Simulation diagnosis 1 (the live full-interview run of the integration branch), learner fixes,
# each default ON with the same rollback:
#
# * R1_ECHO_GUARD (L1, U2, U3, U5, L5, U4 (3)): what she echoes from the advisor's latest turns (a
#   format, schedule or deep-need word), a wish about a policy and how her course work is graded
#   are no leak; an echo question ("Wait, $1,000?") is not the reply's one question; an emptied free
#   reply is a back-channel unless she was asked to decide; the asked-for re-ask is shortened; a
#   clause answering his either/or question is no stall closer, and a short "that" sentence goes
#   with the clause it pointed at.
# * R1_MARKERS_V2 (U1, U2, L4): wider delivery markers for F2, F4 and F1-COUNTER (latched per
#   session: the schedule's markers), a tail never repeats the reply's opener, and the e-mail tail
#   asks nothing when she already asked.
# * R1_PRICE_ASKED_ONCE (L3): a challenged anchor is no unclear price, and the final price is asked
#   once until a new figure is named.
# * R1_NO_ACCEPT_NOTES (L7, U4 (2)): an owed move that answers a proposal she may not accept yet
#   says so in its prompt, and the early price-met note gives no sayable phrase.
FLAG_ECHO_GUARD = "R1_ECHO_GUARD"
FLAG_MARKERS_V2 = "R1_MARKERS_V2"
FLAG_PRICE_ASKED_ONCE = "R1_PRICE_ASKED_ONCE"
FLAG_NO_ACCEPT_NOTES = "R1_NO_ACCEPT_NOTES"
# The advisor turns whose words she may echo (R1_ECHO_GUARD).
ADVISOR_TERM_TURNS = 4
# R1_PRICE_ASKED_ONCE: the replies after her final-price question that are told not to ask it again.
FINAL_ASKED_TURNS = 3
_FINAL_PRICE_QUESTION = re.compile(
    r"\b(?:final|real|actual|total|full)\b[^.?!]{0,25}\b(?:price|number|figure|cost)\b"
    r"|\b(?:price|number|figure)\b[^.?!]{0,20}\bfinal\b",
    re.IGNORECASE,
)
_FLAG_OFF_VALUES = frozenset({"0", "off", "false", "no"})
# The flags that are OFF unless set (every other flag is on unless set to 0/off/false/no).
_FLAG_DEFAULT_OFF = frozenset({FLAG_WRAPUP_NEXT_ROUND})
# One literal read per flag, so the repository's env-contract scanner (and
# config/environment.schema.json) sees every one of them (review S1R-7).
_FLAG_READS = {
    FLAG_NATURAL_TIMING: lambda: os.getenv("R1_NATURAL_TIMING"),
    FLAG_RESPOND_FIRST: lambda: os.getenv("R1_RESPOND_FIRST"),
    FLAG_CONCERN_LEDGER: lambda: os.getenv("R1_CONCERN_LEDGER"),
    FLAG_SPLIT_REPLAN: lambda: os.getenv("R1_SPLIT_REPLAN"),
    FLAG_PUSH_AFTER_REACTION: lambda: os.getenv("R1_PUSH_AFTER_REACTION"),
    FLAG_LEARNER_VOICE_V2: lambda: os.getenv("R1_LEARNER_VOICE_V2"),
    FLAG_NO_COMMIT_LEDGER: lambda: os.getenv("R1_NO_COMMIT_LEDGER"),
    FLAG_OFFER_TERMS: lambda: os.getenv("R1_OFFER_TERMS"),
    FLAG_ACK_TURN_NOTE: lambda: os.getenv("R1_ACK_TURN_NOTE"),
    FLAG_TIC_V2: lambda: os.getenv("R1_TIC_V2"),
    FLAG_OFFER_REALISM: lambda: os.getenv("R1_OFFER_REALISM"),
    FLAG_REPLY_LENGTH: lambda: os.getenv("R1_REPLY_LENGTH"),
    FLAG_PROBE_FIRST: lambda: os.getenv("R1_PROBE_FIRST"),
    FLAG_OFFER_READER_V2: lambda: os.getenv("R1_OFFER_READER_V2"),
    FLAG_COUNTER_V2: lambda: os.getenv("R1_COUNTER_V2"),
    FLAG_PRICE_CONFLICT: lambda: os.getenv("R1_PRICE_CONFLICT"),
    FLAG_CLOSING_STATE: lambda: os.getenv("R1_CLOSING_STATE"),
    FLAG_EARLY_CLOSE_ASIDE: lambda: os.getenv("R1_EARLY_CLOSE_ASIDE"),
    FLAG_ABUSE_HANGUP: lambda: os.getenv("R1_ABUSE_HANGUP"),
    FLAG_LATE_END_REQUEST: lambda: os.getenv("R1_LATE_END_REQUEST"),
    FLAG_WEAK_EMAIL_V2: lambda: os.getenv("R1_WEAK_EMAIL_V2"),
    FLAG_COMMIT_REACTION_V2: lambda: os.getenv("R1_COMMIT_REACTION_V2"),
    FLAG_TIME_CUE_V2: lambda: os.getenv("R1_TIME_CUE_V2"),
    FLAG_WRAPUP_DECLINE_V2: lambda: os.getenv("R1_WRAPUP_DECLINE_V2"),
    FLAG_WRAPUP_ANSWERS: lambda: os.getenv("R1_WRAPUP_ANSWERS"),
    FLAG_WRAPUP_ONE_MENTION: lambda: os.getenv("R1_WRAPUP_ONE_MENTION"),
    FLAG_WRAPUP_NEXT_ROUND: lambda: os.getenv("R1_WRAPUP_NEXT_ROUND"),
    FLAG_PRICE_MEMORY: lambda: os.getenv("R1_PRICE_MEMORY"),
    FLAG_COME_BACK: lambda: os.getenv("R1_COME_BACK"),
    FLAG_PERSONA_TIMELINE_V2: lambda: os.getenv("R1_PERSONA_TIMELINE_V2"),
    FLAG_CALL_OPENING: lambda: os.getenv("R1_CALL_OPENING"),
    FLAG_ROLE_CONFUSION_V2: lambda: os.getenv("R1_ROLE_CONFUSION_V2"),
    FLAG_FLOOR_YIELD: lambda: os.getenv("R1_FLOOR_YIELD"),
    FLAG_ECHO_GUARD: lambda: os.getenv("R1_ECHO_GUARD"),
    FLAG_MARKERS_V2: lambda: os.getenv("R1_MARKERS_V2"),
    FLAG_PRICE_ASKED_ONCE: lambda: os.getenv("R1_PRICE_ASKED_ONCE"),
    FLAG_NO_ACCEPT_NOTES: lambda: os.getenv("R1_NO_ACCEPT_NOTES"),
}


def _cut_repeat_note() -> str:
    """CUT_REPEAT_NOTE, frame-free with R1_LEARNER_VOICE_V2 (M032 SWEEP-15)."""
    return CUT_REPEAT_NOTE_V2 if flag_on(FLAG_LEARNER_VOICE_V2) else CUT_REPEAT_NOTE


def flag_on(name: str) -> bool:
    """An M032 rollback flag, read now: unset or anything but 0/off/false/no is on.

    A flag in ``_FLAG_DEFAULT_OFF`` (R1_WRAPUP_NEXT_ROUND) is off while unset instead.
    """
    raw = _FLAG_READS[name]() or ("0" if name in _FLAG_DEFAULT_OFF else "1")
    return raw.strip().lower() not in _FLAG_OFF_VALUES


# What the advisor's turn left open for her (S1 item 2), in the order the notes are added.
RESPOND_OFFER = "offer"
RESPOND_BACK_OFF = "back_off"
RESPOND_QUESTION = "question"
RESPOND_ANSWERED = "answered"
_RESPOND_ORDER = (RESPOND_OFFER, RESPOND_BACK_OFF, RESPOND_QUESTION, RESPOND_ANSWERED)
# S1 item 5: a theme counts as said after this many of her lines voiced it.
CONCERN_THRESHOLDS = {CONCERN_PRESSURE: 2}
# The urgency levers that press again, so "take your time" in the same turn eases nothing.
_PRESSING_LEVERS = frozenset({"limited_spots", "application_deadline", "seasonal_discount"})
# SWEEP-1: the pushes that wait for her reaction to the advisor's answer, with their primaries.
# Never F1-COUNTER (the negotiation answers a price), the 19:00 stall, the time cue or a primary.
_REACT_PUSHES = {F2_PUSH: F2_PRIMARY, F3_PUSH: F3_PRIMARY, F4_PUSH: F4_PRIMARY}
# The S1 waits and holds spend slack only while every graded move still owed can land by R 10:00 at
# this many turns each (``RolePlayEngine._s1_slack``; reviews S1-R2 and S1R-4).
S1_FINISH_BY_SEC = FIDELITY_MIN_R_SEC
S1_FINISH_TURNS_PER_MOVE = 2.5
# M032 S2 item 5: the family whose worry a negotiation stall voiced (the F4 pair's reasons, money).
_STALL_FAMILY = {N_TIMING: "F4", N_DECISION_MAKER: "F4", N_MONEY: "F1"}
# SWEEP-4: a verdict opener in either of her last this-many lines gets VERDICT_USED_NOTE.
VERDICT_LOOKBACK = 2
# SWEEP-12: a soft tic (or "I'd rather") in this many of her last ``SOFT_TIC_LOOKBACK`` replies gets
# SOFT_TIC_NOTE.  "I'd rather" is steered only (``declines_call`` and the wait reader read it).
SOFT_TIC_LOOKBACK = 4
SOFT_TIC_REPEATS = 2
_RATHER = "I'd rather"
# Review S2R-8: notes that tell her not to open with a quick reaction or a verdict.
_OPENER_STEERING_NOTES = (HINGE_USED_NOTE, VERDICT_USED_NOTE, NOT_ANSWERED_NOTE)
_SAYS_RATHER = re.compile(r"\bi(?:'d| would) rather\b", re.IGNORECASE)
# Review S2R-6: a question of hers that a bare "yes" answers (no wh-word, no "or" alternative), and
# a lone advisor turn that is such a yes ("Yeah.", "Yep, sure.", "Right.").
_NOT_YES_NO = re.compile(r"\b(?:what|why|how|where|when|who|whom|which|whose|or)\b", re.IGNORECASE)
_YES_LIKE_TURN = re.compile(
    r"^\W*(?:(?:yeah|yep|yup|yes|yah|ya|sure|right|correct|absolutely|definitely|exactly|"
    r"of course|indeed|true|haan|ji)\b\W*){1,3}$",
    re.IGNORECASE,
)
# Review S2R-5: item 4's "the advisor already told you something about ..." only once the advisor
# said every must-say figure of the owed primary himself (F2's "six months" until S2P), so she never
# puts a course fact he did not say in his mouth (D-M032-7).
_NUMBER_WORDS = {
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
    "eleven": "11",
    "twelve": "12",
}


def _figure_pattern(figure: str) -> re.Pattern[str]:
    """A reader for a must-say figure in the advisor's words ("six months": "6-month" too)."""
    parts = []
    for word in figure.split():
        digit = _NUMBER_WORDS.get(word.lower())
        if digit is not None:
            parts.append(f"(?:{re.escape(word)}|{digit})")
        else:
            parts.append(re.escape(word.rstrip("s")) + "s?")
    return re.compile(r"\b" + r"[\s-]{1,3}".join(parts) + r"\b", re.IGNORECASE)


_PREEMPT_FIGURES: dict[str, re.Pattern[str]] = {
    figure: _figure_pattern(figure)
    for spec in PLAN
    if spec.worry and spec.role == "primary"
    for figure in spec.must_say
    if not figure.startswith("$")
}
# SWEEP-13: at most this many careful-buyer notes per session, never on two learner turns in a row;
# and the "payment" curiosity topic waits while the latest price the advisor named is under this.
IMPLAUSIBLE_NOTE_LIMIT = 2
CHEAP_PRICE_USD = 1000
# SWEEP-14: an advisor turn this long gets the long length line.
LONG_ADVISOR_WORDS = 60
# The learner sentence-count histogram's last bucket (``SENTENCE_BUCKETS`` or more).
SENTENCE_BUCKETS = 4


@dataclass(frozen=True)
class _LostHalf:
    """What a plan whose reply was cancelled before any audio had read and handed over (S1 item 7).

    ``text`` is the first half of the candidate's answer, held in memory only until the next turn
    is planned (never logged or stored); the rest are turn indices, seconds and topic ids.
    ``hold``: the one-turn hold the lost plan spent on the owed move (its kind, the move and the
    key it was counted under), given back so that the reply that is heard can hold it again.
    """

    turn: int
    text: str
    seconds: float | None
    first_probes: tuple[str, ...]
    reveal_topics: tuple[str, ...]
    kinds: frozenset[str]
    issued: str | None
    intent_key: str | None
    hold: tuple[str, str, str] | None = None
    # Review S2R-6: the S2 state its planning used up (``RolePlayEngine._turn_s2_undo``).
    s2_undo: tuple[Any, ...] | None = None
    # M032 S2P (review S2P-R5): the price conflict the lost half raised, (kind, usd, earlier usd).
    conflict: tuple[str, int, int | None] | None = None


# M032 SWEEP-17 item 6 (flag R1_PROBE_FIRST): the advisor says he never gave the figure she used
# ("I never said six months", "I didn't mention eight months, I was talking about minutes"),
# with the same negative lookahead as the other arm, so a sales point ("I didn't mention the six
# months earlier, but there's also EMI") is none.
_CHALLENGE_FIGURE = re.compile(
    r"\bi (?:didn'?t|did not|never) (?:say|said|mention|mentioned|tell you|told you) "
    r"(?:anything about )?(?:the )?(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|"
    r"eleven|twelve|eighteen|twenty[- ]four|twenty)[\s-]+(?:months?|weeks?)\b"
    r"(?!.*\b(?:but|earlier|before|yet|however|also)\b)",
    re.IGNORECASE,
)


# M032 SWEEP-25 A2: the advisor agrees to e-mail what she asked for ("Sure, I can do that.", "Of
# course, will do."): a short turn that opens with an agreement, asks nothing and declines nothing
# ("Sure, but let's decide now." is no agreement).
_AGREES = re.compile(
    r"^\W*(?:(?:sure|of course|yes|yeah|yep|absolutely|definitely|no problem|no worries|"
    r"will do|i can do that|i(?:'ll| will) do that|done|okay|ok|alright)\b[\s,.!]*){1,4}",
    re.IGNORECASE,
)
_AGREE_DECLINE = re.compile(
    r"\b(?:but|however|instead|rather|can'?t|cannot|won'?t|not|no need|"
    r"let'?s (?:decide|do it|finish|close|lock|go ahead)|decide (?:now|today|right now)|"
    r"enrol\w*|pay|payment|sign up)\b",
    re.IGNORECASE,
)
AGREE_MAX_WORDS = 15


def agrees_to_send(text: object) -> bool:
    """SWEEP-25 A2: a short advisor turn that agrees to send what she asked for."""
    folded = fold(text)
    return (
        "?" not in folded
        and word_count(folded) <= AGREE_MAX_WORDS
        and _AGREES.match(folded) is not None
        and _AGREE_DECLINE.search(folded) is None
    )


def challenges_figure(text: object) -> bool:
    """The advisor says he never said the course length she used (SWEEP-17 item 6)."""
    return any(_CHALLENGE_FIGURE.search(fold(sentence)) for sentence in split_sentences(text))


def challenges_learner(text: object, *, figure: bool = False) -> bool:
    """The advisor pushes back on something the learner said or on how the learner asks.

    ``figure`` (M032 SWEEP-17, probe first) also reads "I never said six months".
    """
    if figure and challenges_figure(text):
        return True
    return any(_CHALLENGE.search(fold(sentence)) for sentence in split_sentences(text))


class TurnMode(str, Enum):
    SAY_ONLY = "say_only"
    INTENT = "intent"
    LLM_REPLY = "llm_reply"
    EXIT = "exit"


@dataclass(frozen=True)
class LearnerIntent:
    """What the model must voice this turn (R1-Q).

    ``brief`` is a plain-language goal written by the worker (never candidate text);
    ``must_say`` are figures that must be written exactly; ``markers`` are all-of groups of
    any-of regexes that prove the move was raised (``r1_scheduler.markers_match``);
    ``fallbacks`` are the scripted variants to append, in the order to try them, if the
    reply misses the markers, and ``fallback`` is the first of them.
    """

    kind: str
    brief: str
    must_say: tuple[str, ...]
    markers: tuple[tuple[str, ...], ...]
    fallback: str
    fallbacks: tuple[str, ...] = ()
    forced: bool = False
    # M032 S2 item 3: ``brief`` is an owed worry, rendered as an objective (``WORRY_LINE``).
    worry: bool = False


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
    guard_ctx: GuardContext
    voice: str = "learner"
    aside: bool = False
    character_break: str | None = None
    intent: LearnerIntent | None = None
    # R1-Q: the negotiation spec an INTENT plan voices (a stall reason, the e-mail yes ...), if any.
    negotiation_id: str | None = None
    # The scripted interviewer line an aside speaks (L-ASIDE-COACH or L-ASIDE-END).
    line_id: str | None = None
    # Voice barge-in: an owed move this plan does not voice but may complete.  The advisor cut the
    # learner off while she was raising it and she is told to finish (or repeat) her point: when the
    # played text proves the move it counts as delivered then (``record_spoken``), never twice.
    credit_move_id: str | None = None
    # M032 SWEEP-13: which learner prefix the session sends (``learner_prefix(offer_realism=...)``),
    # latched for the whole session so the prefix stays byte-stable.
    offer_realism: bool = False
    # M032 SWEEP-13: this plan's reminder carries a careful-buyer note (counts and the trust theme).
    implausible: bool = False
    # M032 S2P: the session's latched card and prefix sentences (``learner_prefix(probe_first=...,
    # price_check=...)``, SWEEP-17 and SWEEP-21), and the probe this plan voices (S2.10: its family,
    # or None), which delivers no graded move.
    probe_first: bool = False
    price_check: bool = False
    probe: str | None = None
    # M032 SWEEP-8: the session's latched card timeline (``learner_prefix(timeline_v2=...)``).
    timeline_v2: bool = False
    # M032 S3: a scripted LEARNER line the session says before this aside (S3.4: her one-line
    # hang-up before Christy's question), and whether the learner carries on right after the aside
    # (S3.3's resume and SWEEP-24's last point: the session asks ``continuation_plan``).
    prelude_line: str | None = None
    continuation: bool = False

    @property
    def needs_llm(self) -> bool:
        return self.mode in (TurnMode.INTENT, TurnMode.LLM_REPLY)

    @property
    def exit_roleplay(self) -> bool:
        return self.mode is TurnMode.EXIT


@dataclass(frozen=True)
class Speech:
    """The text to hand to ``session.say``, and how it was built.

    ``model_text`` is what survived the guard of the model's reply, ``tail_text`` the scripted
    line or variant appended after it (an intent's fallback), ``guard`` the guard result.
    """

    text: str
    model_text: str
    tail_text: str
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
        # Simulation diagnosis 1 (R1_MARKERS_V2, latched per session): the wider delivery markers.
        self._markers_v2 = flag_on(FLAG_MARKERS_V2)
        self.scheduler = OwedMoveScheduler(persona.decision_maker, markers_v2=self._markers_v2)
        self.tracker = CoverageTracker(persona, seed=self.seed)
        self.ledger = GuardLedger()
        self.turn = 0
        self.last_r = 0.0
        self._advisor_amounts: set[int] = set()
        # The word count of every planned turn (the substantive-turn count, the thin-advisor
        # evidence and the turn count), and of the turns that are not acknowledgement-only
        # (``plan_turn(backchannel=...)``), which the speech-to-text sanity check reads: a lone
        # "Okay." or "Yeah, go on." is a whole turn the candidate meant, not a long answer that
        # speech-to-text chopped into fragments.  Voice barge-in (min_words 0) commits each such
        # acknowledgement as its own turn, where the SDK used to bank it into the next one (owner
        # test 1eb18cd4: 7 of its 8 short role-play turns were acknowledgements, 21% short, and
        # ``stt_sanity`` failed a normal session).
        self._word_counts: list[int] = []
        self._stt_word_counts: list[int] = []
        self._turn_map: dict[int, int] = {}
        self._longest_turn_sec = 0.0
        self._asks: list[dict[str, Any]] = []
        self._stalls = 0
        self._commitment_level: Level | None = None
        self._commitment_turn: int | None = None
        self._violations = 0
        self._ai_questions = 0
        self._asides: list[dict[str, Any]] = []
        self._coach_played = False
        self._break_kind: str | None = None
        # ``_learner_control`` is set below, with the session's latched prefix (M032 SWEEP-13).
        self._interviewer_control = control_prose(interviewer_prefix())
        self.exit_requested = False
        # Repetition control: every learner sentence actually played, so the guard can drop
        # a sentence the learner already said; and how often a rotating line was used.
        self._spoken = SpokenMemory()
        self._fallbacks = 0
        self._fillers = 0
        # Intent-voiced moves: how often each move was handed to the model and how often its
        # scripted fallback had to be appended (counts only; logged, not posted).
        self._intent_uses: dict[str, int] = {}
        self._intent_fallbacks: dict[str, int] = {}
        # Curiosity: the topics already asked (or answered by the advisor) and the free replies
        # since the last one was suggested.
        self._curiosity_asked: set[str] = set()
        self._free_replies = 0
        self._free_at_last_curiosity = 0
        # L1: how often each topic was handed over (a topic is "asked" only once she asked it).
        self._curiosity_offered: dict[str, int] = {}
        # L2: the extra mid-discovery holds per owed move, and whether this advisor turn asked the
        # learner about herself (an intent then answers it first).
        self._discovery_holds: dict[str, int] = {}
        self._dig_now = False
        # L7: the turn the learner first said she would talk to her decision maker (the F4 push's
        # own markers: "my partner and I usually talk these things through" counts).
        self._decider_said_turn: int | None = None
        # L5: the latest monthly payment the advisor named and the turn it was named on.
        self._monthly_quote_usd: int | None = None
        self._monthly_quote_turn = 0
        # Negotiation (R1-Q): what is on the table, the stall reasons used and the commitment
        # on record.  ``_notes`` are this turn's situation notes for the reminder, and
        # ``_new_offer_usd`` the price an advisor turn added (the only "pleasant surprise" turn).
        self.negotiation = Negotiation(persona.decision_maker)
        self._notes: list[str] = []
        self._price_notes: list[str] = []
        self._new_offer_usd: int | None = None
        self._force_curiosity = False
        # R1-Q iteration 1.  How the learner's replies opened and which tic words they held
        # (the style rules vary the next reply), the ask that could not be answered before the
        # close window (a farewell inside the window answers it), and whether the advisor only
        # said they would check on the price (nothing granted: no thanks for a discount).
        self._styles: list[tuple[str, tuple[str, ...]]] = []
        self._pending_ask: AskKind | None = None
        self._nothing_granted = False
        # R1-Q iteration 2.  Whether each reply held a question and how often each tracked phrase
        # tic was used (the guard's question diet and phrase quotas); the hours-a-week figures the
        # advisor gave (the learner may repeat them); what the advisor already answered; the moves
        # held back once for a dig; the call ask of the current turn; the price talk of the turn;
        # and whether the learner turned a proposed call down.
        self._asked: list[bool] = []
        self._phrases: dict[str, int] = {}
        self._advisor_hours: set[float] = set()
        # Simulation diagnosis 1 (R1_ECHO_GUARD): the word stems of the advisor's latest turns
        # (memory only, never logged), and whether this turn's question offered her a choice.
        self._advisor_term_turns: list[frozenset[str]] = []
        self._advisor_said_turns: list[str] = []
        self._choice_offered = False
        # Simulation diagnosis 1 (R1_PRICE_ASKED_ONCE, L3): the turn of her last final-price
        # question and how many offers the negotiation held then (None: none asked).
        self._final_asked: tuple[int, int] | None = None
        self._answered: list[str] = []
        self._dig_deferred: set[str] = set()
        self._call_ask_now = False
        self._price_talk = False
        self._declined_calls = 0
        self._organic_pushes: list[str] = []
        # R1-Q iteration 3.  Whether the advisor's turn put a LOWER price on the table (the only
        # turn a reaction may call a price better), how many advisor turns in a row said (almost)
        # nothing, whether the learner's last reply was a goodbye (it is not said twice to a
        # silent advisor), whether the advisor asked who else decides this turn, and the topics
        # of the digs that already held an owed move back.
        self._fresh_price = False
        self._hollow_run = 0
        self._last_reply_closer = False
        self._decider_asked_now = False
        self._dig_deferred_topics: set[str] = set()
        # R1-Q final review round 1.  The tracked phrases of each reply (the guard's spacing window
        # for the stall phrases).
        self._phrase_history: list[tuple[str, ...]] = []
        # Owner test 7f2a25e6.  The owed move held back by each turn on which the advisor challenged
        # the learner, in order (at most ``MAX_CHALLENGE_DEFERRALS`` per session; one move can be
        # held by two challenges in a row).
        self._challenge_deferred: list[str] = []
        # Owner test 7f2a25e6 ("can you disconnect the call?").  The one-off L-ASIDE-END question
        # (when it played) or the explicit request that needed none, whether the question is still
        # open (a fragment leaves it open), and whether the candidate confirmed the stop.  A
        # confirmed stop exits the role-play into the wrap-up exactly as a farewell exit does
        # (``exit_requested``; owner decision 2026-10-29) and changes no grade, disclosure or
        # schedule state.  From 14:00, or with a commitment on record, an end request is a
        # farewell instead and reaches only what "bye" reaches.
        self._end_aside: dict[str, Any] | None = None
        self._end_pending = False
        # Whether L-ASIDE-END is still the last line said (``end_question_open``), and the plan
        # that made it stale (a reply lost before it was heard makes it fresh again).
        self._end_question_last = False
        self._end_stale_by: TurnPlan | None = None
        self.end_confirmed = False
        # M2 (owner and manager decisions of 2026-11-03).  Every L-ASIDE-WRAP offer made (R, what
        # triggered it, how it was answered), whether the latest one still waits for its answer,
        # the R of the last no (a declined L-ASIDE-END counts for the cool-down too), and whether
        # the candidate took the offer.  The "going nowhere" counters: advisor turns in a row that
        # raised nothing new, and the stall reasons the learner gave from 14:00 on.
        self._wrap_offers: list[dict[str, Any]] = []
        self._wrap_open = False
        self._wrap_declined_at: float | None = None
        self.wrap_accepted = False
        self._stale_run = 0
        self._late_stalls = 0
        # Whether the learner's last line raised something for the advisor to answer (an owed move
        # or a negotiation line): a quiet after it is the advisor thinking, not a pause to fill.
        self._raised_last = False
        # Voice barge-in (owner decision 2026-10-28).  Whether the advisor cut the learner's last
        # line off after part of it was heard, the owed move that line carried and did not
        # deliver, and the moves already held back once for a cut (at most once per move).  The
        # first two describe the last line only: the next ``plan_turn`` consumes them.
        self._learner_cut = False
        self._cut_move: str | None = None
        self._interrupt_deferred: set[str] = set()
        # The graded commitment line the candidate did not hear whole (a barge-in cut it before the
        # end, or the SDK cancelled it before any word was heard), and whether part of it WAS heard
        # (a cut): it is said again on the next turn, and only a cut line's revoice counts toward
        # ``COMMITMENT_REVOICE_LIMIT``.  And the plan whose reply was cancelled before any audio
        # (``reply_lost``), with what its planning consumed: a turn that answers nothing ("Okay.",
        # "Sorry?") gets that very plan again; any other turn is planned afresh, with the ask, the
        # next-step question, the stall counts and the close-ladder count the lost plan used up
        # given back.
        self._unheard_commitment: TurnPlan | None = None
        self._unheard_was_cut = False
        self._commitment_revoices = 0
        self._lost_plan: TurnPlan | None = None
        self._lost_undo: tuple[Any, ...] | None = None
        self._turn_undo: tuple[Any, ...] | None = None
        self._turn_ask: AskKind | None = None
        # M032 S1.  What this advisor turn left open for her (``RESPOND_*``) and the owed moves held
        # once to respond first (with a count per kind); whether her last line was a question that
        # did not carry an owed move, and the curiosity topics it asked; the themes of her lines;
        # the free replies that volunteered a stall; the turns whose idle primary waited for a
        # moment.  And for the split-answer replan: this turn's text (memory only, only while
        # R1_SPLIT_REPLAN is on), seconds, layers and issued move, and the half a lost reply left.
        self._turn_kinds: frozenset[str] = frozenset()
        self._respond_held: set[str] = set()
        self._respond_holds: dict[str, int] = {}
        self._her_question_topics: frozenset[str] = frozenset()
        self._last_owed_line = False
        self._concerns: dict[str, int] = {}
        self._volunteered_objections = 0
        self._moment_waits = 0
        self._split_replans = 0
        self._turn_text = ""
        self._turn_seconds: float | None = None
        self._turn_layers: tuple[int, tuple[str, ...], tuple[str, ...]] | None = None
        self._turn_issued: str | None = None
        self._turn_hold: tuple[str, str, str] | None = None
        self._lost_half: _LostHalf | None = None
        # SWEEP-1: the primary her last HEARD line delivered (None when it delivered none; a reply
        # lost before any audio changes nothing), and the pushes held for her reaction, by family.
        self._heard_primary: str | None = None
        self._push_react_holds: dict[str, int] = {}
        # M032 S2 (learner voice).  SWEEP-13's prefix sentence is latched for the session (the
        # prefix is the DeepSeek cache prefix), and the guard's echo check reads that very prefix.
        self._offer_realism = flag_on(FLAG_OFFER_REALISM)
        # M032 S2P (SWEEP-17, SWEEP-21): latched for the session as well (see below).
        self._probe_first = flag_on(FLAG_PROBE_FIRST)
        self._price_conflict = flag_on(FLAG_PRICE_CONFLICT)
        # M032 SWEEP-8: the card's timeline wording, latched for the session as well.
        self._timeline_v2 = flag_on(FLAG_PERSONA_TIMELINE_V2)
        self._learner_control = control_prose(self.learner_prefix_text())
        # Item 7: the coach aside just played (the next reply carries on, no new greeting).
        self._after_coach = False
        # Item 4: the topics (``PREEMPTED_LABELS`` keys) the advisor talked about so far, this turn
        # included (review S2R-5: F3-PRIMARY fires exactly when its topic is fresh, so the very
        # turn that answered it counts), and the must-say figures the advisor said himself.
        self._preempted: set[str] = set()
        self._advisor_figures: set[str] = set()
        # Item 5: the family whose worry her last heard line raised, and whether this advisor turn
        # left it untouched.
        self._worry_family: str | None = None
        self._unanswered_worry = False
        # This turn's reading for the per-turn notes: a lone acknowledgement, a cut, the reading
        # itself (memory only, never logged), an ask.
        self._turn_backchannel = False
        self._turn_cut = False
        self._turn_reading = ""
        # SWEEP-4 (counts only): her heard lines that opened with a hinge, a verdict or "My worry
        # is"; the last flags steer the next reply.  And a sentence-count histogram (SWEEP-14).
        self._hinges: list[bool] = []
        self._verdicts: list[bool] = []
        self._voice_replies = 0
        self._doubt_openers = 0
        self._sentence_counts: dict[int, int] = {}
        # Item 8 (counts only): scripted tails appended to an intent reply, and how many of them
        # followed model text that had already asked a question.
        self._tails_appended = 0
        self._tails_after_question = 0
        # SWEEP-3: the turn she first said the not-today stall in a line of her own (F4-PRIMARY
        # still owed), the free replies that did so, the notes given, and the stall themes counted.
        self._timing_said_turn: int | None = None
        self._volunteered_timing = 0
        self._no_commit_notes = 0
        self._stall_themes: dict[str, int] = {}
        # SWEEP-5: the offer terms already reacted to (each once per session), and their counts.
        self._terms_used: set[str] = set()
        self._terms_counts: dict[str, int] = {}
        self._turn_terms: tuple[str, ...] = ()
        self._turn_terms_monthly = False
        # SWEEP-11: replies told to answer a lone "okay" or "hmm" briefly; whether her last heard
        # question was a yes/no one (a lone "Yeah." answers it; review S2R-6), and its normalised
        # question sentences, which a re-ask on a lone "okay" may repeat (review S2R-4; memory only,
        # like ``SpokenMemory``).
        self._ack_turn_notes = 0
        self._asked_yes_no = False
        self._last_questions: tuple[str, ...] = ()
        # SWEEP-12: soft tics trimmed, and the soft tics (and "I'd rather") of each heard reply.
        self._soft_tic_trims = 0
        self._soft_history: list[tuple[str, ...]] = []
        # SWEEP-13: careful-buyer notes given, the turn of the last one, this turn's note, and the
        # latest price the advisor named (the "payment" topic waits while it is under $1,000).
        self._implausible_count = 0
        self._implausible_turn: int | None = None
        self._implausible_note = ""
        self._latest_price_usd: int | None = None
        # Review S2R-6: what this turn's planning used up of the S2 state (the coach flag, the
        # careful-buyer and offer-terms notes, the note counts), given back when its reply is lost.
        self._turn_s2_undo: tuple[Any, ...] | None = None
        # M032 S2P, probe first (D-M032-7).  R1_PROBE_FIRST and R1_PRICE_CONFLICT change the card
        # and the prefix (the DeepSeek cache prefix), so both are latched for the session, like
        # SWEEP-13's sentence; every probe-first behaviour reads the latched value, so a session is
        # one release or the other from start to end (``self._probe_first`` and
        # ``self._price_conflict`` are set above, before the prefix).  The state, ints and ids only:
        # the learner turn on which she last asked the price (S2.10's probe, SWEEP-20's redirect
        # probe, or her own question; SWEEP-22), her price questions the advisor answered with no
        # figure, the probes she said per family, the course lengths the advisor said (months), the
        # figures she was allowed to say (a check or a conflict) and said, and SWEEP-22's notes.
        self._price_asked_turn: int | None = None
        self._price_dodges = 0
        self._probes: dict[str, int] = {}
        self._advisor_months: set[float] = set()
        self._figures_said: set[int] = set()
        self._durations_said: set[float] = set()
        self._allowed_extra: frozenset[int] = frozenset()
        self._price_reflexes = 0
        self._price_first_turns = 0
        self._figure_challenges = 0
        self._redirect_probes = 0
        # The kind of the last price the advisor named that SWEEP-13's reader called far below
        # ("low" or "free"; None after an ordinary offer), the family of the probe her last heard
        # line asked, whether that line held a figure the advisor never said, and this turn's
        # price conflict (SWEEP-21) with its note.
        self._last_price_kind: str | None = None
        self._free_turn: int | None = None  # the turn of the last "free" (review S2P-R1)
        # The F1-ANCHOR form planned on a turn, as (turn, anchor id, the stated price it checked),
        # noted on the negotiation when that line is heard (review S2P-R2, naturalness).
        self._anchor_planned: tuple[int, str, int | None] | None = None
        self._last_probe_family: str | None = None
        self._last_line_unsaid_figure = False
        self._turn_conflict: tuple[str, int, int | None] | None = None
        self._conflict_note = ""
        self._asks_number_now = False  # SWEEP-19 item 6: this turn asked what number works for her
        self._number_moment = False  # ... before the anchor, with probe first: the F1 step answers
        self._split_turn: int | None = None  # the lost first half's turn of a continuation
        # M032 S3, endings (ints and booleans only).  SWEEP-25 A2: the turn of her own request for
        # the details by e-mail, until the advisor's next turn answers it, and whether he agreed;
        # B: reaction sentences the guard took out before the 19:00 WEAK line.  SWEEP-27: free
        # replies told she is short on time.
        self._email_request_turn: int | None = None
        self._learner_asked_email = False
        self._commit_reaction_dropped = 0
        self._short_on_time_notes = 0
        # S3.1 and S3.2: the closing state, whether her last heard line signed off (a line that
        # carried no owed move or negotiation line), how often each state was entered, and the
        # closes read in role.  S3.3: the learner line owed right after an aside (("resume", None)
        # or ("last_point", move id)).  SWEEP-24: the last point asked for and whether the next
        # real turn ends the role-play.  S3.4: abusive turns, and whether she is cool after a
        # resumed hang-up.
        self._closing = CLOSING_OPEN
        self._closing_states: dict[str, int] = {}
        self._last_reply_signoff = False
        self._handover_closes = 0
        self._mutual_goodbyes = 0
        self._winding_replies = 0
        self._continuation_due: tuple[str, str | None] | None = None
        self._last_point: dict[str, Any] | None = None
        self._exit_after_last_point = False
        self._late_end_requests = 0
        self._abuse_count = 0
        self._cool = False
        self._hangup_prelude = False
        self._unclear_offer = 0  # review S3R-2: the early-close question a bare yes heard again
        # M032 S7L, learner follow-ups (ints and booleans only).  SWEEP-10: whether this turn has
        # the roles the wrong way round, and the reminders that got the role note.
        self._role_confused = False
        self._role_confusion_turns = 0
        # SWEEP-33: the scripted yields, the cut they re-arm for the next real turn, and a carried
        # first half (S1 item 7) kept for it.
        self._floor_yields = 0
        self._floor_rearm: tuple[bool, str | None] | None = None
        self._floor_half: _LostHalf | None = None
        # SWEEP-7: her open question (topic, label, the turn that asked it, the turn that dodged
        # it, whether she already came back to it), the topics spent, the counts, and this turn's
        # come-back (its topic for the guard).
        self._open_q: dict[str, Any] | None = None
        self._come_back_spent: set[str] = set()
        self._open_q_dodged = 0
        self._open_q_reasked = 0
        self._dodge_now = False
        self._come_back_topic = ""
        self._last_heard_turn: int | None = None
        # SWEEP-6: the "what number works for you?" notes given.
        self._your_number_notes = 0
        # SWEEP-9: who is calling is known (latched), she asked, and the opening notes used.
        self._caller_known = False
        self._caller_intro = ""
        self._asked_who = False
        self._opening_notes: dict[str, int] = {}
        self._how_spent = False

    # ------------------------------------------------------------------- properties
    def learner_prefix_text(self) -> str:
        """The session's learner prefix, with the session's latched S2 and S2P sentences."""
        return learner_prefix(
            self.persona,
            offer_realism=self._offer_realism,
            probe_first=self._probe_first,
            price_check=self._price_conflict,
            timeline_v2=self._timeline_v2,
        )

    def _price_probe_answer_due(self, turn: int, *, before_anchor: bool = True) -> bool:
        """SWEEP-19 item 4: her last heard line asked the price (before the anchor, unless
        ``before_anchor`` is False), so an amount in this advisor turn needs no pricing word ("It's
        around 6000 dollars"), as after the anchor.  Review S2P-R4/R5: a continuation whose lost
        first half was the turn right after her question answers it too."""
        asked = self._price_asked_turn
        split = self._split_turn
        return (
            self._probe_first
            and asked is not None
            and (asked == turn - 1 or (split is not None and asked == split - 1))
            and not (before_anchor and self.scheduler.is_delivered(F1_ANCHOR))
        )

    @property
    def commitment_resolved(self) -> bool:
        return self.scheduler.commitment_resolved

    @property
    def commitment_level(self) -> Level | None:
        return self._commitment_level

    def _commitment_cap(self) -> Level:
        """The highest commitment level a model sentence may reach.

        The stall (WEAK) until a scripted line is on record; afterwards the recorded level, so
        the learner can confirm the call it has already booked ("Great, talk to you Thursday
        then.") instead of being cut off into a guard hit that counts toward the gate.  The
        scripted lines themselves are never guarded.
        """
        on_record = self._commitment_level
        return Level.WEAK if on_record is None else max(Level.WEAK, on_record)

    def _confirming(self) -> bool:
        """A call or a start is agreed (MEDIUM or STRONG on record): the learner only confirms."""
        return self._commitment_level in (Level.MEDIUM, Level.STRONG)

    def guard_context(
        self,
        phase: str = "roleplay",
        *,
        mode: str = "reply",
        turn: int | None = None,
        reminder: str | None = None,
        quiet_empty: bool = False,
        released: Iterable[str] | None = None,
        confirm: bool = False,
        free_reply: bool = False,
        carries_move: bool = False,
        reask: tuple[str, ...] = (),
        must_say: tuple[str, ...] = (),
        winding: bool = False,
        closing_exempt: bool = False,
        reaction_only: bool = False,
        reask_topic: str = "",
    ) -> GuardContext:
        """The guard context for an LLM reply now.

        M032 S3: ``winding`` and ``closing_exempt`` (R1_CLOSING_STATE: the advisor is closing the
        call, so one short goodbye passes), ``reaction_only`` (R1_COMMIT_REACTION_V2: the 19:00
        reaction before the WEAK line says no goodbye), and Christy's wrap-up and closing name the
        hiring team only in L-CLOSE (R1_WRAPUP_ONE_MENTION, ``one_mention``).

        M032 S2P (SWEEP-17, the session's latched R1_PROBE_FIRST): the card's figures are gone, so
        the context carries the amounts and course lengths this reply may say beyond it (the plan's
        ``must_say`` on the check or conflict path, what she already said on such a path, this
        turn's conflict figures, the advisor's lengths); and while a price rise is open (SWEEP-21)
        ``offer_usd`` is the later of the latest total and the latest offer.

        M032 S2: ``carries_move`` says the plan voices or may complete an owed move (SWEEP-12 never
        trims a soft tic from such a reply); the S2 flags are read here, once per plan.

        Its ``control_texts`` are the private instruction prose of the prompts in play
        (never the words the model is meant to say), for the guard's echo check.
        ``quiet_empty`` is for an intent reply: an empty result stays empty, because the
        session appends the intent's own scripted variant instead of "Sorry, what were you
        saying?".

        ``released`` (a plan's own call) is the deep needs that may be told in THIS reply, the ones
        the turn asked about: a need told earlier is not told again, and one never asked about
        is never dumped (R1-Q iteration 1).  Without it every unlocked need counts as released.
        """
        if mode != "reply":
            released_topics: frozenset[str] = frozenset()
        elif released is None:
            released_topics = self.tracker.gate.released_topics
        else:
            released_topics = frozenset(released)
        gate = self.tracker.gate
        spent = frozenset(topic for topic in H_TOPICS if gate.state(topic) is NeedState.REVEALED)
        if phase == "roleplay":
            control = (self._learner_control,)
            if reminder:
                control += (control_prose(reminder),)
        else:
            control = (self._interviewer_control,)
        extra_amounts: frozenset[int] = frozenset()
        extra_months: frozenset[float] = frozenset()
        if self._probe_first and phase == "roleplay":
            extra_amounts, extra_months = self._guard_extras(must_say)
        return GuardContext(
            phase=phase,
            persona=self.persona,
            candidate_first_name=self.candidate_first_name,
            released_topics=released_topics,
            advisor_amounts=frozenset(self._advisor_amounts),
            mode=mode,
            commitment_cap=self._commitment_cap(),
            turn=self.turn if turn is None else turn,
            control_texts=control,
            keep_excerpts=self.keep_excerpts,
            said=self._spoken.snapshot() if phase == "roleplay" else (),
            seed=self.seed,
            variant=self._fallbacks,
            quiet_empty=quiet_empty,
            spent_topics=spent,
            nothing_granted=self._nothing_granted,
            recent_styles=tuple(self._styles[-STYLE_HISTORY:]),
            confirm=confirm,
            offer_usd=self._offer_on_table(),
            recent_questions=tuple(self._asked[-STYLE_HISTORY:]),
            phrase_counts=tuple(sorted(self._phrases.items())),
            free_reply=free_reply,
            advisor_hours=frozenset(self._advisor_hours),
            fresh_price=self._fresh_price,
            hollow=self._hollow_run >= 1 and self._last_reply_closer,
            decider_asked=self._decider_asked_now,
            recent_phrases=tuple(self._phrase_history[-STYLE_HISTORY:]),
            monthly_quote_usd=(
                self._monthly_quote_usd
                if self.turn - self._monthly_quote_turn <= MONTHLY_QUOTE_TURNS
                else None
            ),
            voice_v2=flag_on(FLAG_LEARNER_VOICE_V2),
            tic_v2=flag_on(FLAG_TIC_V2),
            carries_move=carries_move,
            reask=reask,
            probe_first=self._probe_first,
            allowed_extra=extra_amounts,
            advisor_durations=extra_months,
            # M032 SWEEP-26: Christy's wrap-up and closing name the hiring team only in L-CLOSE.
            one_mention=phase in ONE_MENTION_PHASES and flag_on(FLAG_WRAPUP_ONE_MENTION),
            winding=winding,
            closing_exempt=closing_exempt,
            reaction_only=reaction_only,
            reask_topic=reask_topic,
            price_memory=flag_on(FLAG_PRICE_MEMORY),
            echo_guard=flag_on(FLAG_ECHO_GUARD),
            advisor_terms=(
                frozenset().union(*self._advisor_term_turns) if phase == "roleplay" else frozenset()
            ),
            advisor_said=tuple(self._advisor_said_turns) if phase == "roleplay" else (),
            asked_her=(
                self._turn_ask is not None
                or RESPOND_QUESTION in self._turn_kinds
                or "?" in str(self._turn_reading or "")
                or asks_her_directly(self._turn_reading)
            ),
            choice_offered=self._choice_offered,
        )

    def _offer_on_table(self) -> int | None:
        """The best offer; while a price rise is open (SWEEP-21 (d)), the latest price named."""
        if self._price_conflict and self.negotiation.rise_open_turn is not None:
            return self.negotiation.price_now_usd()
        return self.negotiation.best_offer_usd

    def filler_text(self) -> str:
        """The learner's thinking filler: a 3-variant rotation seeded by the attempt id.

        A variant whose sentences the learner already played is skipped (a slow provider makes
        the fourth filler repeat the first word for word); when all of them were played the
        filler is the short "One moment...", which can never be a repeat.
        """
        said = self._spoken.snapshot()
        text = LEARNER_FILLER_SHORT
        for step in range(len(LEARNER_FILLER_VARIANTS)):
            candidate = pick_variant(LEARNER_FILLER_VARIANTS, self.seed, self._fillers + step)
            if not _repeats(candidate, said):
                text = candidate
                break
        self._fillers += 1
        return text

    # ------------------------------------------------------------------ the decision
    def plan_turn(
        self,
        candidate_text: str,
        r_sec: float,
        *,
        turn_index: int | None = None,
        candidate_seconds: float | None = None,
        backchannel: bool = False,
        repair: bool = False,
        answers_nothing: bool = False,
        end_intent: str | None = None,
        confirmed_yes: bool = False,
    ) -> TurnPlan:
        """Decide what the learner does after this candidate turn (``_decide_plan``).

        Reviewed fix (2026-10-30): L-ASIDE-END stops being the line the candidate answers as soon
        as anything else is said after it.  A fragment ("Okay.", "Hmm.", "Sorry?") still leaves the
        question pending (``_end_pending``: end words confirm), but the learner answers it in role,
        so a plain "Yes." three lines later is said to her: it confirmed the stop, and the model
        was still told "Christy has just asked" (``end_question_open``).  Any plan but the aside
        itself and the exit makes the question stale; a reply the candidate never heard
        (``reply_lost``) makes it fresh again.
        """
        plan = self._decide_plan(
            candidate_text,
            r_sec,
            turn_index=turn_index,
            candidate_seconds=candidate_seconds,
            backchannel=backchannel,
            repair=repair,
            answers_nothing=answers_nothing,
            end_intent=end_intent,
            confirmed_yes=confirmed_yes,
        )
        if (
            self._end_question_last
            and plan.line_id != "L-ASIDE-END"
            and plan.mode is not TurnMode.EXIT
        ):
            self._end_question_last = False
            self._end_stale_by = plan
        if r_sec >= WRAP_OFFER_FROM_R_SEC and plan.negotiation_id in _STALL_REASON_IDS:
            self._late_stalls += 1  # M2: a stall reason from 14:00 on (going nowhere)
        return plan

    def _decide_plan(
        self,
        candidate_text: str,
        r_sec: float,
        *,
        turn_index: int | None = None,
        candidate_seconds: float | None = None,
        backchannel: bool = False,
        repair: bool = False,
        answers_nothing: bool = False,
        end_intent: str | None = None,
        confirmed_yes: bool = False,
    ) -> TurnPlan:
        """Decide what the learner does after this candidate turn (see module docstring).

        The worker's judgement of a short turn (``r1_session``):

        * ``backchannel``: nothing but acknowledgement ("yeah", "okay", "mm-hmm", "okay,
          continue"; ``is_acknowledgement_turn``).  When this turn cut the learner's last line off
          (``record_spoken(..., interrupted=True)``) she only finishes her point.  Such a turn is
          never counted by the speech-to-text sanity check (``fidelity``): it is not a fragment.
        * ``repair``: only a request to hear it again or a check that she is there ("Sorry?",
          "Pardon?", "Hello? Are you there?"; ``is_repair_turn``).  After a cut she says it again.
        * ``answers_nothing``: courtesy words alone (``is_backchannel_turn``).  With the two above
          it decides whether a plan whose reply was cancelled before any audio (``reply_lost``)
          is simply planned again.

        Owner decisions of 2026-10-30 (meaning-based end detection, ``r1_end_intent``):

        * ``end_intent``: the end-intent model's verdict on this turn ("end", "maybe" or "no"),
          or None when it was not asked (the prefilter missed, the lexical fast path already
          decided, the classifier is off) or gave no usable answer in time.  It can only RAISE the
          lexical reading (``r1_tracker.end_intent_level``): "end" exits before 14:00 like an
          explicit request, "maybe" gets L-ASIDE-END, and with None every plan is exactly what
          it was before.
        * ``confirmed_yes``: the session let a bare yes settle (``is_bare_yes``: "yes", "yes
          please", "haan ji", "go ahead"; nothing followed it), so it confirms the stop while
          L-ASIDE-END's question is open.  A decline still wins.
        """
        # Ship restore, a pure cost bound: every reader below is lexical and linear in the text, and
        # no real advisor turn comes near this (longest live turn 1,072 characters, the owner's
        # longest grouped turn 1,039), so the bound only shortens pathological speech-to-text.
        if isinstance(candidate_text, str) and len(candidate_text) > MAX_CANDIDATE_CHARS:
            candidate_text = candidate_text[-MAX_CANDIDATE_CHARS:]
        # Voice barge-in: whether THIS turn is the one that cut the learner's last line off, and the
        # owed move that line failed to deliver.  Consumed here, whatever the turn turns out to be.
        cut, self._learner_cut = self._learner_cut, False
        cut_move, self._cut_move = self._cut_move, None
        lone_backchannel = cut and backchannel
        repeat_request = cut and repair and not backchannel
        # A plan whose reply the SDK cancelled before any audio, and what its planning consumed.
        lost, self._lost_plan = self._lost_plan, None
        lost_undo, self._lost_undo = self._lost_undo, None
        lost_half, self._lost_half = self._lost_half, None
        self._turn_kinds = frozenset()
        carried: _LostHalf | None = None  # M032 S1: the first half of a split answer
        if self._exit_after_last_point:
            # M032 SWEEP-24: her last point was said after an explicit request to end; the next
            # real turn ends the role-play.
            if (
                lost is not None
                and "continuation:last_point" in lost.reasons
                and not (declines_end(candidate_text) and not confirms_end(candidate_text))
            ):
                # Review S3R-1: the last point itself was cancelled before any audio (an "Okay." in
                # the think gap).  Nobody heard it, so it is the answer still owed: said again, and
                # the exit stays latched for the turn after it.
                return replace(lost, reasons=lost.reasons + ("replanned_after_lost_reply",))
            latched = self._after_last_point(
                candidate_text, turn_index, backchannel=backchannel, repair=repair
            )
            if latched is not None:
                self._restore_lost(lost_undo)
                return latched
        if self._wrap_open and self._hangup_prelude:
            # Review S3R-5: her hang-up line is still playing and Christy has asked nothing yet, so
            # this turn answers nothing: it waits (said to nobody; the question follows).
            self._restore_lost(lost_undo)
            return self._wrap_line_plan(None, ["wrap_offer_pending", "hangup_prelude"])
        if self._wrap_open:
            # M2: this turn answers the interviewer's offer to wrap up (L-ASIDE-WRAP).
            answer = self._wrap_answer_plan(
                candidate_text,
                r_sec,
                turn_index,
                repair=repair and not backchannel,
                end_intent=end_intent,
                confirmed_yes=confirmed_yes,
            )
            if answer is not None:
                self._restore_lost(lost_undo)
                return answer
        # An out-of-role request to end the call (owner test 7f2a25e6, turns 64 and 71).  Before
        # R = 14:00 and with no commitment on record it is answered by the interviewer, never by an
        # owed move and never by the close ladder: she asks once (L-ASIDE-END: say "end the
        # interview" to stop).  End words in answer, or the request again at a later turn of that
        # stretch, confirm the stop; anything else resumes the role-play with this very turn, and a
        # backchannel or a speech-to-text fragment ("Hmm", "Okay.") leaves the question open.  A
        # first request that names the interview or the role play ("End the interview.", "Can we
        # end this role play?"; ``explicit_end_request``) and that the turn ends on is confirmed
        # at once, without the question, which would only ask the candidate to say exactly that
        # (owner test 1eb18cd4); one that says more ("Please stop the interview, I need a
        # moment.") gets the question, so a candidate who wants something else can carry on.
        # A confirmed stop ends the ROLE-PLAY, not the session (owner decision 2026-10-29): the
        # plan is the role-play exit, and L-EXIT and the interviewer's wrap-up follow, as after a
        # farewell exit.  The session completes normally and is scored only if the fidelity checks
        # pass (R reached 10:00, every family delivered ...), so asking to stop earns nothing a
        # second "bye" before 14:00 (the close ladder's exit) would not.
        #
        # From 14:00, or once a commitment is on record, the role-play has already earned its score
        # and the request is the advisor's way of saying goodbye (reviewed fix: "Okay Priya, let's
        # disconnect the call now, I'll send you the email" at 18:20, after a complete role-play,
        # ended it as a failed session, and "End the interview." right after a booked call
        # did too, where "Thank you so much, bye!" exits and is scored).  So the request, or end
        # words answering a question asked earlier, is a farewell: it gets exactly what "bye" gets
        # on the close ladder (the redirect once before 14:00, the WEAK stall in the close window,
        # otherwise the exit) and nothing more, so it stays injection-neutral.
        #
        # The lexical reading (``detect_end_request``, ``explicit_end_request``) is the floor of
        # ``end_level``; the end-intent model's verdict (``end_intent``) may raise it within the
        # rails of ``end_intent_level`` (owner decision 2026-10-30).  A first request at level
        # "end" is confirmed at once, one at "maybe" gets the question.
        # M032 SWEEP-24 (c): "You can disconnect the call." is a request too ("maybe" only), and
        # only in place of the end-intent model's verdict (a timeout, a failure, a prefilter miss
        # or the model's flag off): a verdict the model did give is its reading of the turn.
        late_on = flag_on(FLAG_LATE_END_REQUEST)
        permission = late_on and end_intent not in END_INTENT_LEVELS
        end_level = end_intent_level(candidate_text, end_intent, permission=permission)
        lexical_level = end_intent_level(candidate_text, None, permission=permission)
        if end_level != "no" and self._abuse_hangs_up(candidate_text):
            # Simulation diagnosis 1, AB-1 (R1_ABUSE_HANGUP): abuse that also says "stop" or "end"
            # ("stop wasting my time, you idiot") is abuse first.  It is no end request here, so
            # the turn goes on to the hang-up below (said to her, it stays evidence), and
            # L-LEARNER-HANGUP's own question covers ending.  Past the hang-up limit, or with a
            # question open, the end path is unchanged.
            end_level = lexical_level = "no"
        # Reviewed fix (2026-10-30): once the question has been asked and has closed (declined, or
        # answered by talk about the sale), a "later request" that confirms the stop at once must
        # be the candidate's own words, never a model-only "maybe": after a declined aside, "At the
        # end of the day, the course pays for itself." with a model "maybe" exited the role-play
        # with no question at all.  A model "end" still counts (``end_intent_level`` lets it
        # through only for a turn that ends on a request to stop the interview or the role play),
        # and while the question is open a model "maybe" is still an answer to it (only right
        # after it: once anything else was said, ``end_question_open`` is False; reviewed fix).
        if (
            end_level == "maybe"
            and lexical_level == "no"
            and self._end_aside is not None
            and not self.end_question_open
        ):
            end_level = lexical_level
        by_model = end_level != lexical_level
        end_request = end_level != "no"
        # Once the aside has been asked, an answer that also declines is a no whatever end words it
        # holds: "No, I don't think I want to stop", "No, why would you end the call?" (reviewed
        # fix: these ended the session).
        declined = self._end_aside is not None and declines_end(candidate_text)
        # After the question a bare yes confirms too, once the session has let it settle
        # (``confirmed_yes``; owner decision 2026-10-30): "Yes.", "Yes please.", "Haan ji.".  Only
        # as the answer to the question itself: a yes after the learner spoke again is said to her.
        end_words = (end_request and not declined) or (
            self._end_pending
            and (
                confirms_end(candidate_text)
                or (confirmed_yes and self.end_question_open and is_bare_yes(candidate_text))
            )
        )
        # "Let's cut the call now, I'll call you tomorrow": a call-back promise is the advisor
        # closing the sale's call in role, so it is a farewell, never the out-of-role stop (reviewed
        # fix: after a declined aside it ended the session).
        out_of_role = (
            r_sec < EARLY_CLOSE_BEFORE_SEC
            and not self.commitment_resolved
            and not promises_call_back(candidate_text)
        )
        if out_of_role and self._end_aside is not None and end_words:
            return self._end_plan(turn_index, r_sec=r_sec, by_model=by_model)
        farewell_end = end_words and not out_of_role
        if self._end_pending and (
            farewell_end
            or word_count(candidate_text) > END_FRAGMENT_WORDS
            or declines_end(candidate_text)
        ):
            self._end_pending = False
            if not farewell_end:
                # M2: a declined L-ASIDE-END is a no to stopping: no wrap-up offer right after it.
                self._wrap_declined_at = r_sec
        if end_request and self._end_aside is None and out_of_role:
            # The aside is no answer to the lost plan either: what that plan used up is given back.
            self._restore_lost(lost_undo)
            if end_level == "end":
                return self._end_plan(turn_index, r_sec=r_sec, by_model=by_model)
            return self._end_aside_plan(r_sec, turn_index, by_model=by_model)
        if (
            late_on
            and end_level == "end"
            and not out_of_role
            and not promises_call_back(candidate_text)
        ):
            # M032 SWEEP-24: from 14:00 (or with a commitment on record) an explicit request to end
            # the interview or the role play is never answered in role (the farewell ladder said
            # "Oh wait, before you go..." and an owed move, and only a second request exited).
            self._end_pending = False
            self._restore_lost(lost_undo)
            return self._late_end_request(turn_index, r_sec=r_sec, by_model=by_model)
        # M032 SWEEP-10: a role reversal is read on its first phrasing ("can you sell this to me?").
        role_v2 = flag_on(FLAG_ROLE_CONFUSION_V2)
        break_kind = detect_character_break(candidate_text, role_v2=role_v2)
        self._role_confused = (
            role_v2 and break_kind == "coach" and role_confusion_in(candidate_text)
        )
        if lost is not None:
            if (
                (backchannel or repair or answers_nothing)
                and not farewell_end
                and break_kind is None
                and not is_close_attempt(candidate_text, r_sec)
            ):
                # Voice barge-in (min_words 0): a lone "Okay.", "Sorry" or "Hello?" in the think gap
                # cancelled the reply before the candidate heard any of it.  That turn answers
                # nothing, so the lost plan is the answer still owed: the very same plan (its turn,
                # its ask, its commitment line) is voiced now.  A commitment line the candidate
                # never heard is no revoice: the replay spends nothing of the revoice limit.
                if self._unheard_commitment is lost:
                    self._unheard_commitment = None
                return replace(lost, reasons=lost.reasons + ("replanned_after_lost_reply",))
            self._restore_lost(lost_undo)
            if lost_half is not None and lost_half.turn == lost.turn:
                carried = lost_half
                if carried.s2_undo is not None:
                    self._give_back_s2(carried.s2_undo)
        split = carried if carried is not None and flag_on(FLAG_SPLIT_REPLAN) else None
        if split is not None:
            self._give_back_lost(split)
        # M032 SWEEP-33: a first half kept through a scripted yield is this real turn's to carry
        # (what it used up was given back on the yield turn).
        kept_half, self._floor_half = self._floor_half, None
        if split is None and kept_half is not None and carried is None:
            split = kept_half
        if self._wants_aside(break_kind):
            return self._aside_plan(break_kind or "ai", r_sec, turn_index)
        # M032 S2 item 7: the first turn after the coach aside (its turn is not in her context).
        self._turn_s2_undo = (
            self._after_coach,
            self._implausible_count,
            self._implausible_turn,
            frozenset(self._terms_used),
            dict(self._terms_counts),
            self._ack_turn_notes,
            self._no_commit_notes,
            # M032 S2P (review S2P-R4/R5): her price dodges, the conflicts checked and the open
            # rise, the price-reflex notes and the price-first turns this turn's planning counts.
            self._price_dodges,
            tuple(self.negotiation.conflicts),
            self.negotiation.rise_open_turn,
            self._price_reflexes,
            self._price_first_turns,
        )
        resumed, self._after_coach = self._after_coach, False
        if break_kind == "ai":
            self._ai_questions += 1
        self._turn_undo = (
            self._pending_ask,
            self.negotiation.question_used,
            self.negotiation.stall_rounds,
            self._stalls,
            self.scheduler.close_attempts,
        )
        self.turn += 1
        turn = self.turn
        self.last_r = r_sec
        self._notes = []
        self._price_notes = []
        self._nothing_granted = False
        self._force_curiosity = False
        self._dodge_now = False
        self._come_back_topic = ""
        voice_v2 = flag_on(FLAG_LEARNER_VOICE_V2)
        if resumed and voice_v2:
            self._notes.append(COACH_RESUME_NOTE)
        if turn_index is not None:
            self._turn_map[turn] = turn_index
        if candidate_seconds is not None:
            self._longest_turn_sec = max(self._longest_turn_sec, candidate_seconds)
        # M032 S1 item 7: the readers below see both halves of a split answer; the observers
        # (scheduler, tracker, negotiation, figures) saw the first half on its own turn already.
        reading = candidate_text
        monologue = candidate_seconds
        if split is not None:
            reading = f"{split.text} {candidate_text}"[-MAX_CANDIDATE_CHARS:]
            if split.seconds is not None or candidate_seconds is not None:
                monologue = (split.seconds or 0.0) + (candidate_seconds or 0.0)
            self._split_replans += 1
        self._turn_text = reading if flag_on(FLAG_SPLIT_REPLAN) else ""
        # M032 S2P (review S2P-R4/R5): a continuation answers what the lost first half answered.
        self._split_turn = None if split is None else split.turn
        self._turn_seconds = monologue
        self._turn_issued = None
        self._turn_hold = None
        words = word_count(candidate_text)
        self._word_counts.append(words)
        if not backchannel:
            self._stt_word_counts.append(words)
        self._hollow_run = self._hollow_run + 1 if is_hollow_turn(reading) else 0
        self._decider_asked_now = False
        # M032 S2: this turn's reading for the per-turn notes (memory only, never logged), the
        # topics the advisor talked about so far (item 4), and the must-say figures he said.
        self._turn_backchannel = backchannel
        self._turn_cut = cut
        self._turn_reading = reading
        self._preempted.update(preempting_topics(reading))
        for figure, pattern in _PREEMPT_FIGURES.items():
            if isinstance(reading, str) and pattern.search(reading):
                self._advisor_figures.add(figure)
        signals = self.scheduler.observe_candidate_turn(candidate_text, r_sec)
        # Item 5: the worry her last heard line raised, and whether this turn left it untouched:
        # neither its topic nor any answer to it (``worry_answered``; review S2R-1: "our learners
        # still get hired every month" answers the layoffs worry).  F2 and F3 only.
        worry, self._worry_family = self._worry_family, None
        self._unanswered_worry = (
            worry is not None
            and worry not in signals.topics
            and not worry_answered(worry, reading)
        )
        obs = self.tracker.observe_candidate_turn(candidate_text, turn)
        known = (len(self._advisor_amounts), len(self._answered))
        self._advisor_amounts.update(
            advisor_amounts_in(candidate_text, shorthand=self._probe_first)
        )
        self._advisor_hours.update(hours_said(candidate_text))
        self._advisor_term_turns = [
            *self._advisor_term_turns[-(ADVISOR_TERM_TURNS - 1) :],
            advisor_terms_in(reading),
        ]
        self._advisor_said_turns = [
            *self._advisor_said_turns[-(ADVISOR_TERM_TURNS - 1) :],
            advisor_text_of(reading),
        ]
        self._choice_offered = offers_choice(reading)
        if self._probe_first:
            # SWEEP-17 item 4: the course lengths the advisor said, and a price he stated without
            # a "$" ("the price is 9000"), are figures she may refer to.
            self._advisor_months.update(durations_said(candidate_text))
            stated = stated_price_usd(candidate_text)
            if stated is not None:
                self._advisor_amounts.add(stated)
        self._price_talk = quotes_price(reading)
        for topic in answered_topics(reading):
            if topic not in self._answered:
                self._answered.append(topic)
        negotiated = self._observe_negotiation(candidate_text, turn)
        self._read_email_agreement(reading, negotiated, turn)
        self._turn_conflict = negotiated.conflict if self._price_conflict else None
        if (
            split is not None
            and split.conflict is not None
            and self._turn_conflict is None
            and self._price_conflict
        ):
            # Review S2P-R5 (naturalness): the conflict the lost first half raised (given back
            # with it) is this continuation's to check, read over both halves.
            self._turn_conflict = self.negotiation.reapply_conflict(split.conflict, turn)
        # Review S7L-R2: what the per-turn readers below may count or close, so a floor yield
        # (SWEEP-33) can leave it as it was.
        before_readers = self._yield_snapshot()
        if self._price_probe_answer_due(turn, before_anchor=False) and not self._price_named():
            self._price_dodges += 1  # S2.10: her price question got no figure
        number_question = asks_her_number(reading)
        self._asks_number_now = flag_on(FLAG_COUNTER_V2) and number_question
        self._number_moment = (
            self._probe_first and number_question and not self.scheduler.is_delivered(F1_ANCHOR)
        )
        if self._number_moment:
            # SWEEP-19 item 6: before the anchor, "which number works for you?" is a fresh moment
            # for the F1 probe or anchor, so the question is answered by it, never left open.
            self.scheduler.note_topic("F1")
        self._note_situation(negotiated)
        # Review S2R-6: a split answer's terms are read over both halves (S1 item 7).
        self._read_offer_extras(reading, negotiated, turn)
        self._note_curiosity_covered(reading)
        self._note_monthly_quote(candidate_text, turn)
        self._dig_now = asks_about_learner(reading)
        # Nothing in the very first advisor turn is an ask: it is the greeting ("is now a good
        # time?", "I thought I'd give you a quick call"), and it gets a free reply.
        early = turn == 1 and r_sec < EARLY_ASK_IGNORE_SEC
        ask = None if early else detect_ask(candidate_text)
        wants = ask.kind if ask is not None else None
        if wants is None and negotiated.callback is not None and not early:
            wants = AskKind.CALL  # a concrete callback or time proposal is a call ask
        self._call_ask_now = wants is AskKind.CALL
        self._turn_ask = wants
        reasons: list[str] = []
        if obs.injection:
            reasons.append("injection_phrase_flagged")
        if break_kind:
            reasons.append(f"character_break:{break_kind}")
        self._break_kind = break_kind
        if split is not None:
            reasons.append("split_replan")
        # M032 S1 items 1, 2 and 6: what this turn left open for her.  A first half whose reply was
        # never heard counts too (fda9e9f6 #58/#59: the answer to her question was in the half that
        # was lost).
        self._read_open_question(reading, turn)
        self._read_call_opening(reading, turn)
        natural = flag_on(FLAG_NATURAL_TIMING)
        respond = flag_on(FLAG_RESPOND_FIRST)
        kinds: frozenset[str] = frozenset()
        if natural or respond:
            kinds = self._respond_kinds(reading, negotiated, wants, carried=carried)
        self._turn_kinds = kinds
        if (
            flag_on(FLAG_FLOOR_YIELD)
            and self._floor_yields < FLOOR_YIELD_LIMIT
            and asks_for_floor(candidate_text, names=(self.persona.first_name,))
        ):
            owed = self.scheduler.select(r_sec)
            if owed is None or self._may_defer(owed, r_sec):
                self._worry_family = worry  # the yield answers nothing: still the next turn's
                self._yield_restore(before_readers, turn)
                return self._floor_yield_plan(
                    reasons, cut=cut, cut_move=cut_move, live=lost is not None, split=split
                )
            # A forced move (or the time cue or the stall past its grace) still fires: she says
            # sorry in a few words and makes her point briefly.
            self._notes.append(FLOOR_NOTE)
            reasons.append("floor_request_forced")
        if respond and kinds:
            self._respond_notes(kinds)
        decision = None
        if farewell_end:
            reasons.append("end_request_as_farewell")
            if by_model:
                reasons.append("end_intent_model")
        # M032 S3.4 (D-M032-3): abuse aimed at her.  She hangs up in role and Christy asks; the
        # turn was said to her and stays evidence, and scoring is unchanged.
        if detect_abuse(reading, names=(self.persona.first_name,)):
            self._abuse_count += 1
            if (
                flag_on(FLAG_ABUSE_HANGUP)
                and self._hangups() < HANGUP_LIMIT
                and not self._question_open()
            ):
                return self._hangup_plan(r_sec, turn_index, reasons)
        if self._unheard_commitment is not None:
            revoiced = self._revoice_commitment(r_sec, reasons)
            if revoiced is not None:
                return revoiced
        close_attempt = signals.close_attempt
        if flag_on(FLAG_CLOSING_STATE):
            close_attempt = self._read_close(reading, close_attempt, reasons)
        held_close = False
        if close_attempt or farewell_end:
            decision = self.scheduler.register_close_attempt(r_sec)
            if (
                decision.action == "exit"
                and r_sec < EARLY_CLOSE_BEFORE_SEC
                and flag_on(FLAG_EARLY_CLOSE_ASIDE)
            ):
                # M032 S3.3 (D-M032-2): before 14:00 an in-role close never ends the role-play
                # without the candidate's word: Christy asks (at most twice), and once asked out
                # she says one short goodbye and the role-play goes on.
                if self._early_asks() < EARLY_CLOSE_ASK_LIMIT and not self._question_open():
                    return self._early_close_plan(r_sec, turn_index, reasons)
                reasons.append("close_attempt_held")
                held_close = True
                decision = CloseDecision("held", None, "")
            if decision.action == "exit":
                self.exit_requested = True
                reasons.append("close_attempt_exit")
                return self._plan(TurnMode.EXIT, reasons)
        if held_close:
            owed_now = self.scheduler.select(r_sec)
            if owed_now is None or not owed_now.forced:
                # S3.2: the advisor is closing and the question was asked out: one short, warm
                # goodbye, no new question (a forced move still lands below).
                return self._winding_plan(reasons)
        # Disclosure is tied to the turn that asks about the topic: a first probe is answered
        # with the HINT layer and a follow-up (or a repeat probe of a released need) with the
        # DEEP layer, in that very reply.  An owed move that is not forced waits one turn.
        reveal_topics = self.tracker.gate.deep_due(obs.gate)
        first_probes = obs.gate.first_probes
        if split is not None:
            # The lost reply's layers (and so its reveal hold) go to the reply that is heard.
            first_probes = tuple(dict.fromkeys((*split.first_probes, *first_probes)))
            reveal_topics = tuple(dict.fromkeys((*split.reveal_topics, *reveal_topics)))
        # M2 "going nowhere": did this advisor turn raise anything new (a topic, a figure, a probe)?
        fresh = (
            (len(self._advisor_amounts), len(self._answered)) != known
            or bool(first_probes)
            or bool(reveal_topics)
            or asks_about_learner(reading)
            or self._wrap_engaged(negotiated)
        )
        self._stale_run = 0 if fresh else self._stale_run + 1
        if wants is not None or negotiated.email_offer or negotiated.checkin:
            planned = self._negotiate(
                negotiated,
                wants,
                r_sec,
                reasons,
                first_probes=first_probes,
                reveal_topics=reveal_topics,
                monologue=monologue,
            )
            if planned is not None:
                return planned
        if decision is not None and decision.move is not None:
            move = decision.move
            self.scheduler.issue(move)
            self._turn_issued = move.id
            if decision.action == "redirect":
                # Ship restore: production's scripted redirect, "Oh wait, before you go..." and the
                # owed line (a model-voiced redirect said its goodbye and then the opener).
                reasons.append("close_attempt_redirect")
                if self._probe_first:
                    # M032 SWEEP-20: the probe-first step that is due, never "$9,000 is a lot".
                    return self._redirect_plan(move, decision.prefix, reasons, r_sec)
                text = f"{decision.prefix} {move.text}"
                return self._plan(TurnMode.SAY_ONLY, reasons, scripted=text, move_id=move.id)
            reasons.append("close_attempt_stall")
            return self._plan(
                TurnMode.SAY_ONLY,
                reasons,
                scripted=self._weak_text(move.text),
                move_id=move.id,
                level=Level.WEAK,
                resolves=True,
            )
        reveal_due = bool(first_probes) or bool(reveal_topics)
        challenged = False
        held_for_cut = False
        reacting = False  # SWEEP-1: the push waits for her reaction (quiet, like a challenge)
        # An ask the negotiation left to the owed move (``ask_yields_to_owed_move``) is answered by
        # the move it selected, with no moment to wait for.
        moment = (
            self._moment(reading, negotiated, kinds, r_sec)
            if natural and "ask_yields_to_owed_move" not in reasons
            else None
        )
        move = self.scheduler.select(r_sec, moment=moment)
        if moment is not None and moment.slack_ok:
            # Logged only: the idle primary the rule of before would have raised waits (item 1).
            baseline = self.scheduler.select(r_sec)
            if baseline is not None and (move is None or move.id != baseline.id):
                self._moment_waits += 1
                reasons.append("owed_waits_for_moment")
        if move is not None:
            if reveal_due and self._may_defer(move, r_sec):
                reasons.append("owed_deferred_for_reveal")
            elif (
                move.id in (F1_ANCHOR, F1_COUNTER)
                and wants is not None
                and "ask_yields_to_owed_move" not in reasons
                and self._may_defer(move, r_sec)
            ):
                # The advisor proposed a call or a time: that is answered first, and the price
                # reaction waits one turn unless its deadline forces it (R1-Q final review round 1:
                # "That's even below the $7,000 ..." answered "Does seven tomorrow work?").  Not
                # when the negotiation left the ask to this very move (M032 S2P, review S2P-R5: her
                # price question went unanswered, so the F1 step that is due answers the ask).
                reasons.append("owed_deferred_for_ask")
            elif (
                (lone_backchannel or repeat_request)
                and not (repeat_request and move.id == cut_move)
                and self._may_defer(move, r_sec)
            ):
                # Voice barge-in (owner decision 2026-10-28).  A lone "yeah" that cut the learner
                # off raises no move: she finishes her point, and when that point was the owed move
                # her continuation completes it (``credit_move_id``).  A "Sorry?" or a "Pardon?"
                # gets what she was saying said again and no other move (when her cut line WAS the
                # owed move, the move itself is that repeat, below).  Neither spends the move's one
                # interrupt deferral, which is for a real answer over her line; however often it
                # happens, a deadline still forces the move (``_may_defer``).
                held_for_cut = True
                reasons.append(
                    "owed_deferred_for_backchannel"
                    if lone_backchannel
                    else "owed_deferred_for_repeat"
                )
            elif not repeat_request and move.id == cut_move and self._may_hold_for_cut(move, r_sec):
                # The advisor said something real over the learner's line: the move it carried is
                # not started again on the very next turn, she answers what they said first.  The
                # move waits ONE turn, once per move and only while the plan has a turn to spare
                # (``_may_hold``), and a deadline still forces it.
                self._interrupt_deferred.add(move.id)
                held_for_cut = True
                reasons.append("owed_deferred_for_interrupt")
            elif (
                challenges_learner(reading, figure=self._probe_first)
                and self._may_hold_for_challenge(move, r_sec)
            ):
                # The advisor pushed back on the learner's own words or on how it asks (owner test
                # 7f2a25e6: "where did you get that number?" got a one-line answer and the F2 push).
                # That is answered first and the owed move waits ONE turn; twice per session and
                # only while the plan has a turn to spare (``_may_hold``), so a combative advisor
                # cannot hold the plan back, and a deadline still forces it.  Two challenges in a
                # row hold the same move twice (reviewed fix: the owner's 56 and 58 were both
                # challenges, and under a once-per-move rule 58 got the F4 primary on top of "you
                # are asking too many questions").
                self._challenge_deferred.append(move.id)
                self._turn_hold = ("challenge", move.id, "")
                challenged = True
                self._notes.append(self._challenge_note())
                reasons.append("owed_deferred_for_challenge")
            elif (
                move.id not in self._dig_deferred
                and self._dig_key(reading) not in self._dig_deferred_topics
                and asks_about_learner(reading)
                and self._may_defer(move, r_sec)
            ):
                # The advisor asked the learner a direct question about themselves (a dig the
                # probe rules did not catch: "is he more of a sounding board, or does he need to be
                # convinced?"): that question is answered first, the owed move waits ONE turn
                # (R1-Q iteration 2: F1-ANCHOR and F3-PRIMARY answered a question about the husband
                # and the father).  A deadline still forces it, so the gate's slip limit holds.  One
                # deferral per topic of dig (iteration 3): a run of digs on the same topic would
                # otherwise hold every owed move back in turn.
                self._dig_deferred.add(move.id)
                self._dig_deferred_topics.add(self._dig_key(reading))
                self._turn_hold = ("dig", move.id, self._dig_key(reading))
                reasons.append("owed_deferred_for_dig")
            elif (
                self._dig_now
                and self._discovery_holds.get(move.id, 0) < DISCOVERY_HOLD_LIMIT
                and self._may_hold(move, r_sec)
            ):
                # L2: the advisor is still asking about the learner and the plan has slack: she
                # answers, and the owed move waits (``DISCOVERY_HOLD_LIMIT``).  A forced move, the
                # time cue and the 19:00 stall never wait here (``_may_hold``).
                self._discovery_holds[move.id] = self._discovery_holds.get(move.id, 0) + 1
                self._turn_hold = ("discovery", move.id, "")
                reasons.append("owed_deferred_for_discovery")
            elif (
                respond
                and kinds
                and move.id not in self._respond_held
                and not (move.family == "F1" and self._price_talk)
                # M032 S2P: after her probe the owed point IS her response to the answer, and the
                # F1 step is her answer to "which number works for you?" (SWEEP-19 item 6).
                and not (self._probe_first and move.family == self._last_probe_family)
                and not (self._number_moment and move.id == F1_ANCHOR)
                and self._may_hold_s1(move, r_sec)
            ):
                # M032 S1 item 2 (D-M032-1): the advisor made an offer, gave her time, asked her
                # something or answered her own question.  She responds to that first and the owed
                # move waits ONE turn: once per move, only while the plan has slack
                # (``_may_hold_s1``), never a forced move, the time cue or the 19:00 stall, and
                # never an F1 move on a turn about price (the negotiation reads that turn).
                self._respond_held.add(move.id)
                kind = next(item for item in _RESPOND_ORDER if item in kinds)
                self._respond_holds[kind] = self._respond_holds.get(kind, 0) + 1
                self._turn_hold = ("respond", move.id, kind)
                reasons.append("owed_deferred_to_respond")
            elif (
                self._heard_primary is not None
                and _REACT_PUSHES.get(move.id) == self._heard_primary
                and move.id not in self._respond_held
                and wants is None
                and not offers_floor(reading)
                and flag_on(FLAG_PUSH_AFTER_REACTION)
                and self._may_hold_s1(move, r_sec)
            ):
                # M032 SWEEP-1: her last heard line raised this family's primary and the advisor
                # has answered it; the push waits ONE turn so that she reacts to that answer first
                # (in every role-play the push was her very next line, after a token "[ack], but").
                # Once per push and shared with the respond-first budget (``_respond_held``), only
                # with slack (``_may_hold_s1``): never forced, never F1-COUNTER, the time cue or
                # the 19:00 stall.  Not when the advisor handed her the floor ("what else is on
                # your mind?"): that invites her next point, the natural moment for it (D-M032-1).
                # A confirmation check-in ("does that make sense?") is held through: the reply is
                # quiet, so it gets no CHECKIN_NOTE (review S1-R5).  Never on a call or enrolment
                # ask: the negotiation left that ask to this very move, which answers it in context
                # (``ask_yields_to_owed_move``; review S1R-1, the owner's late-call shape).  On the
                # next turn the scheduler releases the push as before.
                self._respond_held.add(move.id)
                family = move.family or move.id
                self._push_react_holds[family] = self._push_react_holds.get(family, 0) + 1
                self._turn_hold = ("push_react", move.id, family)
                reacting = True
                self._notes.append(PUSH_REACT_NOTE_V2 if voice_v2 else PUSH_REACT_NOTE)
                reasons.append("owed_deferred_for_reaction")
            else:
                probe = self._probe_step(move, r_sec) if self._probe_first else None
                if probe is not None:
                    # M032 S2P (S2.10): she asks before she states; the owed move stays owed.
                    return self._probe_plan(
                        probe,
                        reasons,
                        first_probes=first_probes,
                        reveal_topics=reveal_topics,
                        monologue=monologue,
                    )
                self.scheduler.issue(move)
                self._turn_issued = move.id
                reasons.append(f"owed:{move.id}" + (":forced" if move.forced else ""))
                if repeat_request and move.id == cut_move:
                    reasons.append("repeat_after_cut")  # her cut line again: the repeat asked for
                if move.id == COMMIT_STALL:
                    # The 19:00 stall: a short reaction, then the scripted WEAK line, spoken
                    # and masked exactly, and never a second time (``Negotiation``).
                    stall = self._commit_stall_plan(
                        move,
                        reasons,
                        first_probes=first_probes,
                        reveal_topics=reveal_topics,
                        monologue=monologue,
                    )
                    if stall is not None:
                        return stall
                else:
                    return self._intent_plan(
                        move,
                        reasons,
                        redirect=False,
                        first_probes=first_probes,
                        reveal_topics=reveal_topics,
                        monologue=monologue,
                    )
        if lone_backchannel or repeat_request:
            # "Yeah" said over the learner cut her off: she finishes her point in one sentence and
            # raises nothing new (no owed move above unless forced, no curiosity, no check-in).  A
            # "Sorry?" gets her point said again.  Either way the move her cut line carried counts
            # as delivered if what she says now proves it (``credit_move_id``).
            reasons.append("backchannel_continuation" if lone_backchannel else "repeat_after_cut")
            self._notes.append(BACKCHANNEL_CUT_NOTE if lone_backchannel else _cut_repeat_note())
            return self._plan(
                TurnMode.LLM_REPLY,
                reasons,
                first_probes=first_probes,
                reveal_topics=reveal_topics,
                monologue=monologue,
                credit_move_id=cut_move,
            )
        trigger = self._wrap_trigger(r_sec)
        if (
            trigger is not None
            and not cut
            and not (
                reveal_due or break_kind is not None or challenged or held_for_cut or reacting
            )
            and wants is None
            and not (negotiated.email_offer or negotiated.checkin)
            and not self._wrap_engaged(negotiated)
            and self._wrap_turn_is_pause(reading)
        ):
            # M2: a natural pause, and an offer is due: the interviewer offers to wrap up in place
            # of the learner's free reply (this turn was said to her and stays evidence).
            reasons.append(f"wrap_offer:{trigger}")
            return self._wrap_offer_plan(r_sec, trigger, turn_index, reasons=reasons)
        reasons.append("free_reply")
        quiet_turn = (
            reveal_due or break_kind is not None or challenged or held_for_cut or reacting
        )
        # M032 SWEEP-6: his question about her own number is answered from her card; it is this
        # reply's one job (no come-back, no curiosity hand-over that turn).
        your_number = self._your_number_note(reading, negotiated, quiet=quiet_turn)
        if your_number:
            reasons.append("your_number")
        come_back = not your_number and self._come_back_note(reading, quiet=quiet_turn)
        # M032 SWEEP-9: her first or second reply, when the opening left something to ask.
        opening = "" if your_number or come_back else self._call_opening_note(reading, quiet_turn)
        if opening:
            reasons.append(f"call_opening:{opening}")
        if come_back:
            reasons.append("come_back")
        if cut:
            # The advisor cut in: what they said is answered, the cut line is not started again.
            # M032 SWEEP-15: with R1_LEARNER_VOICE_V2 the note gives her no frame to narrate.
            self._notes.append(INTERRUPTED_NOTE_V2 if voice_v2 else INTERRUPTED_NOTE)
        if (
            self._probe_first
            and not challenged
            and self._last_line_unsaid_figure
            and challenges_figure(reading)
        ):
            # SWEEP-17 item 6: "I never said six months" with no owed move to hold: she still owns
            # the mix-up instead of saying the figure again.
            self._figure_challenges += 1
            self._notes.append(FIGURE_CHALLENGE_NOTE)
        reflex = "" if not self._probe_first else self._price_reflex_note(reading)
        if reflex:
            reasons.append("price_reflex")
            self._notes.append(reflex)
        curiosity = ""
        # A challenge is only answered (``CHALLENGE_NOTE``): no curiosity question, no check-in.
        # Neither is the turn that cut the learner off while she was raising an owed move, nor
        # (SWEEP-1) the turn whose reply reacts to the advisor's answer before the push.
        quiet = reveal_due or break_kind is not None or challenged or held_for_cut or reacting
        # M032 S1 item 4: a turn that left something open for her hands over no curiosity topic;
        # her reply answers it (a check-in still asks for one real question).
        responding = respond and bool(kinds) and not self._force_curiosity
        if come_back or your_number or opening:
            # M032 SWEEP-7: the come-back is this reply's one question, and SWEEP-6's answer and
            # SWEEP-9's opening are its one job; no curiosity hand-over or check-in note.  The
            # free reply still counts toward the hand-over's cadence, as it did before them.
            if not quiet and (self._force_curiosity or not responding):
                self._curiosity_for_free_reply(skip=True)
        elif self._force_curiosity and not quiet:
            # The advisor checked in ("what do you think?", "anything else?"): an honest
            # reaction and one real question, never the stall.
            curiosity = self._curiosity_for_free_reply(force=True)
            # L1: before the 17:00 time cue an empty pool still gets the ordinary check-in (an
            # honest reaction, a question only if she has one), never "say you have no more".
            # M032 SWEEP-27: after her time cue a check-in is told she has no more questions.
            done = self._short_on_time() or (not curiosity and r_sec >= TIME_CUE_SEC)
            self._notes.append(CHECKIN_DONE_NOTE if done else CHECKIN_NOTE)
        elif not quiet and not responding:
            # M032 SWEEP-12: no hand-over on a turn that put a new price or offer on the table;
            # SWEEP-22: the price reflex wins over a curiosity hand-over.
            figure = flag_on(FLAG_TIC_V2) and (
                bool(negotiated.offers) or bool(self._implausible_note)
            )
            curiosity = self._curiosity_for_free_reply(skip=figure or bool(reflex))
        return self._plan(
            TurnMode.LLM_REPLY,
            reasons,
            first_probes=first_probes,
            reveal_topics=reveal_topics,
            monologue=monologue,
            curiosity=curiosity,
        )

    def _revoice_commitment(self, r_sec: float, reasons: list[str]) -> TurnPlan | None:
        """The graded commitment line the candidate did not hear whole, said again, or None.

        Voice barge-in: a "Great." over "Okay, let's do it. Send me the ..." cut the line before
        its end, or an "Okay." cancelled it before any audio.  The learner earned it and was saying
        it, so the same scripted line (same level, same slot) is said again on this turn, whatever
        the advisor said over it, instead of the commitment being lost to a free reply that may
        only stall.  Not once the commitment is on record, and a forced owed move (other than the
        19:00 stall the line resolves) is spoken first: the line then waits for the following turn.

        Only a line that was played and then cut counts toward ``COMMITMENT_REVOICE_LIMIT`` (and
        only it is stopped by the limit): a line the candidate never heard a word of
        (``reply_lost``) was never said, so saying it now is its first hearing, not a revoice
        (reviewed fix: two lost replays used the limit up, so the first real cut dropped the
        commitment).
        """
        unheard = self._unheard_commitment
        counts = self._unheard_was_cut
        if self.commitment_resolved or (
            counts and self._commitment_revoices >= COMMITMENT_REVOICE_LIMIT
        ):
            self._unheard_commitment = None
            return None
        owed = self.scheduler.select(r_sec)
        if (
            owed is not None
            and owed.forced
            and owed.id != COMMIT_STALL
            and owed.id != unheard.move_id
        ):
            return None
        self._unheard_commitment = None
        if counts:
            self._commitment_revoices += 1
        reasons.append("commitment_revoiced")
        return self._plan(
            TurnMode.SAY_ONLY,
            reasons,
            scripted=unheard.scripted_text,
            move_id=unheard.move_id,
            level=unheard.commitment_level,
            resolves=True,
        )

    def _restore_lost(self, undo: tuple[Any, ...] | None) -> None:
        """Give back what the plan of a reply cancelled before any audio used up when planned.

        Nothing of it was heard: the advisor's ask is still open (that turn's ask, else the one
        open before it), and the next-step question, the stall rounds inside the close window, the
        count of stalls before it and the farewells on the close ladder are as they were before
        that turn.  The last matters for a farewell that speech-to-text split in two ("... have a
        great day." and "Bye."): the "Bye." cancelled the redirect before any audio, and counting
        that unheard redirect made the "Bye." the second farewell, so the role-play exited before
        14:00 without the candidate ever hearing "Oh wait, before you go..." (reviewed fix).  Now
        the "Bye." is the first farewell again and gets the redirect.
        """
        if undo is None:
            return
        pending, question_used, stall_rounds, stalls, close_attempts, ask = undo
        self._pending_ask = ask if ask is not None else pending
        self.negotiation.question_used = question_used
        self.negotiation.stall_rounds = stall_rounds
        self._stalls = stalls
        self.scheduler.close_attempts = close_attempts

    def reply_lost(self, plan: TurnPlan) -> None:
        """The SDK cancelled ``plan``'s reply before the candidate heard any of it.

        At ``min_words`` 0 an "Okay.", a "Sorry" or a "Hello?" in the one or two seconds the reply
        is being thought of is a turn of its own, and it cancels the reply (the session's
        ``r1_reply_cancelled_before_audio``).  Nothing was heard, so nothing is recorded; the next
        ``plan_turn`` either plans this very plan again (a turn that answers nothing) or plans
        afresh with what this plan used up given back.  A graded commitment line is said again
        either way, and since the candidate heard none of it that is no revoice (it spends nothing
        of ``COMMITMENT_REVOICE_LIMIT``).  The session also reports a reply cut after its first
        audio frame but before any word was heard: that too is a line nobody heard.  Only the
        latest plan counts: a newer turn was already planned otherwise.

        The line that made L-ASIDE-END's question stale was never heard either, so the question is
        the last line said again (``end_question_open``).
        """
        if plan is self._end_stale_by:
            self._end_stale_by = None
            self._end_question_last = self._end_pending
        if plan.aside or plan.mode is TurnMode.EXIT or plan.turn != self.turn:
            return
        self._lost_plan = plan
        layers = self._turn_layers
        if layers is None or layers[0] != plan.turn:
            layers = (plan.turn, (), ())
        self._lost_half = _LostHalf(
            turn=plan.turn,
            text=self._turn_text,
            seconds=self._turn_seconds,
            first_probes=layers[1],
            reveal_topics=layers[2],
            kinds=self._turn_kinds,
            issued=self._turn_issued,
            hold=self._turn_hold,
            s2_undo=self._turn_s2_undo,
            conflict=self._turn_conflict,
            intent_key=(
                (plan.move_id or plan.negotiation_id) if plan.mode is TurnMode.INTENT else None
            ),
        )
        self._lost_undo = None if self._turn_undo is None else (*self._turn_undo, self._turn_ask)
        if (
            plan.resolves_commitment
            and plan.commitment_level is not None
            and plan.scripted_text
            and not self.commitment_resolved
        ):
            self._unheard_commitment = plan
            self._unheard_was_cut = False

    @staticmethod
    def _dig_key(candidate_text: str) -> str:
        """The topic of a dig: the needs the question probes, else ``other`` (a third party)."""
        topics = sorted(detect_probes(candidate_text))
        return ",".join(topics) if topics else "other"

    @staticmethod
    def _may_defer(move: Any, r_sec: float) -> bool:
        """Whether a reveal turn may hold ``move`` back for one turn.

        A forced move (its deadline is near) never waits, so the gate's slip limit holds.
        The time cue and the COMMIT-STALL wait too (R1-Q: at turn 79 the cue landed on top of
        a due reveal), except that the stall is the end-game backstop: past
        ``STALL_DEFER_GRACE_SEC`` it is spoken even on a reveal turn, because the role-play
        hard-ends at 20:00.
        """
        if move.forced:
            return False
        past_grace = r_sec >= COMMIT_STALL_R_SEC + STALL_DEFER_GRACE_SEC
        return not (move.id == COMMIT_STALL and past_grace)

    def _may_hold_for_cut(self, move: OwedMove, r_sec: float) -> bool:
        """Whether the owed move a cut line carried may wait one turn (``..._for_interrupt``).

        Once per move, and only while the plan has slack (``_may_hold``).
        """
        return move.id not in self._interrupt_deferred and self._may_hold(move, r_sec)

    def _may_hold_for_challenge(self, move: OwedMove, r_sec: float) -> bool:
        """Whether the owed move may wait one turn for a challenge (``..._for_challenge``).

        Twice per session (two challenges in a row may hold the same move), and only while the plan
        has slack (``_may_hold``).
        """
        return len(self._challenge_deferred) < MAX_CHALLENGE_DEFERRALS and self._may_hold(
            move, r_sec
        )

    def _may_hold(self, move: OwedMove, r_sec: float) -> bool:
        """Whether a cut or a challenge may hold ``move`` back one turn (reviewed fix m4).

        Both holds came with voice barge-in and owner test 7f2a25e6 (before them a cut objection was
        raised again on the very next turn, and a challenge held nothing back).  Stacked with each
        other and with spacing they pushed the later families into forced runs the release before
        them never had: a candidate who cut every objection and challenged the learner every third
        turn got F1 and F4 forced at 35 s an exchange and the time cue never said, and one who cut
        at 65 s lost the F4 push (a missing family, so no score).  So a hold needs:

        * a move that is not forced (``_may_defer``): the deadlines and the forced path are
          unchanged;
        * a move with a deadline: the time cue and the 19:00 stall have no forced path to fall
          back on, so a hold can push the cue out of its 17:00-19:00 window; they are raised again
          at once;
        * slack in the plan (``_ahead_of_pacing``).

        Without them the move is raised again at once, as before the holds (the model still reacts
        to what the advisor said first, and the scripted variants rotate, so it is not word for
        word).
        """
        return (
            move.deadline_sec is not None
            and self._may_defer(move, r_sec)
            and self._ahead_of_pacing(r_sec)
        )

    def _ahead_of_pacing(self, r_sec: float) -> bool:
        """Whether one more turn now still lets every open family land by its deadline.

        At the current pace (the scheduler's expected turn length), the objections still owed up
        to and including each family are given ``SLACK_TURNS_PER_MOVE`` turns each, after the one
        turn the hold costs; every family that is not finished must still make its deadline.  At
        the owner's pace (20-25 s an exchange) there is slack and a cut objection waits; at 35 s
        and slower the plan has no turn to spare until most of it is delivered.
        """
        pace = self.scheduler.lookahead_sec
        owed = 0
        for deadline, move_ids in _PACING_MAP:
            left = sum(1 for move_id in move_ids if not self.scheduler.is_delivered(move_id))
            owed += left
            if left and r_sec + pace * (1 + SLACK_TURNS_PER_MOVE * owed) > deadline:
                return False
        return True

    def _may_hold_s1(self, move: OwedMove, r_sec: float) -> bool:
        """``_may_hold`` for the holds M032 S1 added (respond first, SWEEP-1's push reaction)."""
        return self._may_hold(move, r_sec) and self._s1_slack(r_sec)

    def _s1_slack(self, r_sec: float) -> bool:
        """Whether the M032 S1 waits and holds may spend a turn now (reviews S1-R1, S1-R2, S1R-4).

        Stricter than ``_ahead_of_pacing``, which the holds of before keep (flags off is unchanged):

        * the pace is the slowest recent turn (``cautious_lookahead_sec``), not the 4-turn
          average, so a candidate who slows down mid-call stops the S1 waits at once instead of
          four turns later (on a step from 20 s to 55-80 s an exchange the average let natural-
          moment waits and respond-first holds push F4 past its deadline);
        * and the graded moves still owed can all land by ``S1_FINISH_BY_SEC`` (R 10:00) at
          ``S1_FINISH_TURNS_PER_MOVE`` turns each.  From 10:00 on a stop is scored (the gate's
          10-minute minimum) but only with every family delivered, so S1 spreads the families
          inside the first ten minutes and never makes a stop after 10:00 unscored that the
          release before it would have scored; past that point the moves come as before.
        """
        pace = self.scheduler.cautious_lookahead_sec
        owed = 0
        for deadline, move_ids in _PACING_MAP:
            left = sum(1 for move_id in move_ids if not self.scheduler.is_delivered(move_id))
            owed += left
            if left and r_sec + pace * (1 + SLACK_TURNS_PER_MOVE * owed) > deadline:
                return False
        return r_sec + pace * (1 + S1_FINISH_TURNS_PER_MOVE * owed) <= S1_FINISH_BY_SEC

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
        self._after_coach = True  # M032 S2 item 7: the next reply carries on, no new greeting
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
            line_id="L-ASIDE-COACH",
        )

    def _end_aside_plan(
        self, r_sec: float, turn_index: int | None, *, by_model: bool = False
    ) -> TurnPlan:
        """L-ASIDE-END, once: say "end the interview" to stop, otherwise carry on.

        Like the coach aside it is excluded from evidence (nothing observes the candidate's
        words, no owed move is issued, the schedule does not move) and the session pauses R.
        It is asked only before R = 14:00 with no commitment on record, and not for a request that
        names the interview or the role play (that one is confirmed at once, ``_end_plan``).  The
        next candidate turn that is more than a fragment answers it (``_end_pending``); only end
        words confirm (``confirms_end``), and so does a later end request, while R < 14:00 and no
        commitment is on record.  After that both are farewells (the close ladder, see
        ``plan_turn``).  ``by_model``: the end-intent model, not the lexical detector, heard the
        request (reason ``end_intent_model``).
        """
        self._end_aside = {
            "after_roleplay_turn": self.turn,
            "transcript_turn": turn_index,
            "r_sec": round(r_sec, 1),
            "question_asked": True,
            "confirmed": False,
        }
        self._end_pending = True
        self._end_question_last = True
        return self._plan(
            TurnMode.SAY_ONLY,
            ["aside_end_request"] + (["end_intent_model"] if by_model else []),
            scripted=script_line("L-ASIDE-END", **self.persona.line_values),
            voice="interviewer",
            aside=True,
            line_id="L-ASIDE-END",
        )

    def end_question_lapsed(self) -> None:
        """The candidate said nothing after L-ASIDE-END: the silence ladder's prompt comes next.

        Silence is handled as it always was, so an answer to "Are you still there?" is not an
        answer to L-ASIDE-END: the question is no longer pending (a later end request still ends).
        """
        self._end_pending = False
        self._end_question_last = False

    @property
    def end_question_open(self) -> bool:
        """True while L-ASIDE-END's question waits for its answer and is the last line said.

        Only then may a bare yes confirm (``confirmed_yes``), a model "maybe" answer it, and the
        end-intent model be told the question was just asked.  A fragment leaves the question
        pending, but once the learner answers it in role (``plan_turn``) the next turn is said to
        her, not to the interviewer (reviewed fix: "Okay.", her reply, then "Yes." ended the
        role-play).
        """
        return self._end_pending and self._end_question_last

    def _end_plan(
        self, turn_index: int | None, *, r_sec: float, by_model: bool = False, late: bool = False
    ) -> TurnPlan:
        """The candidate confirmed the stop: the role-play exits into the interviewer's wrap-up.

        Owner decision 2026-10-29 ("the role play should end and the finishing part of Christy the
        interviewer should come in"; "score it if checks pass").  The plan is the role-play exit
        (``exit_requested``, as the close ladder's exit sets it), so the session says L-EXIT and
        runs the wrap-up and the ordinary completion; the fidelity checks then decide whether the
        early end is scored (R reached 10:00, every family delivered and the rest), so at 5:00 it
        never is.  No new outcome and no new path: a second "bye" before 14:00 reaches this exit
        too.  The turn is excluded from evidence (the scheduler, the tracker and the word counts
        never see it; the session writes its row as ``aside``, so the API gate's speech-to-text
        check leaves it out as well) and changes no commitment, disclosure or schedule state.  A
        FIRST request that names the interview or the role play, and that the turn ends on, gets
        here with no question asked: it is then recorded with ``question_asked`` false and the
        reason ``end_request_explicit``.  So does one the end-intent model judged "end" and that
        names the interview or the role play (owner decision 2026-10-30; reason
        ``end_intent_model`` as well, which also marks a confirmation only the model heard).
        """
        reasons = ["end_confirmed"] + (["end_intent_model"] if by_model else [])
        if self._end_aside is None or late:
            reasons.insert(0, "end_request_explicit")
        if late:
            reasons.append("end_request_late")  # M032 SWEEP-24: from 14:00, never in role
        if self._end_aside is None:
            self._end_aside = {
                "after_roleplay_turn": self.turn,
                "transcript_turn": turn_index,
                "r_sec": round(r_sec, 1),
                "question_asked": False,
                "confirmed": False,
            }
        self._end_aside["confirmed"] = True
        self._end_aside["answer_transcript_turn"] = turn_index
        self._end_pending = False
        self._end_question_last = False
        self.end_confirmed = True
        self.exit_requested = True
        return self._plan(TurnMode.EXIT, reasons)

    # ------------------------------------------------- M032 S3: endings, the asides and abuse
    def _question_open(self) -> bool:
        """An interviewer question or the last point waits for its answer: no new aside now."""
        return self._wrap_open or self._end_pending or self._exit_after_last_point

    def _early_asks(self) -> int:
        """How often Christy asked about an in-role close before 14:00 (S3.3)."""
        return sum(1 for offer in self._wrap_offers if offer["trigger"] == TRIGGER_EARLY_CLOSE)

    def _hangups(self) -> int:
        """How often the learner hung up on abuse (S3.4)."""
        return sum(1 for offer in self._wrap_offers if offer["trigger"] == TRIGGER_ABUSE)

    def _final_price_asked(self, move_id: str | None) -> bool:
        """L3 (R1_PRICE_ASKED_ONCE): she asked for the final price lately and no offer came since.

        The F1 pair carry the price in their own brief and are never told this.
        """
        if self._final_asked is None or move_id in (F1_ANCHOR, F1_COUNTER):
            return False
        turn, offers = self._final_asked
        if len(self.negotiation.offers) != offers or self.turn - turn > FINAL_ASKED_TURNS:
            self._final_asked = None  # a new figure, or long enough ago: she may ask again
            return False
        return flag_on(FLAG_PRICE_ASKED_ONCE)

    def _abuse_hangs_up(self, text: str) -> bool:
        """S3.4: ``text`` is abuse aimed at her that the hang-up below would answer now."""
        return (
            flag_on(FLAG_ABUSE_HANGUP)
            and self._hangups() < HANGUP_LIMIT
            and not self._question_open()
            and detect_abuse(text, names=(self.persona.first_name,))
        )

    def _enter_closing(self, state: str) -> None:
        """S3.2: move the closing state (counted per state entered; no text)."""
        if self._closing != state:
            self._closing = state
            self._closing_states[state] = self._closing_states.get(state, 0) + 1

    def _read_close(self, reading: str, close_attempt: bool, reasons: list[str]) -> bool:
        """S3.1 (R1_CLOSING_STATE): whether this advisor turn closes the call in role.

        Besides ``is_close_attempt``: a hand-over close ("Take your time and call me back
        later.", ``hands_over_close``), and a courtesy-only or hollow turn right after her own
        sign-off or her goodbye (a mutual goodbye).  Anything with substance releases the closing
        state (a question, a pitch, more than courtesy).
        """
        signed_off = self._last_reply_signoff or self._closing != CLOSING_OPEN
        courtesy = courtesy_only(reading) or is_hollow_turn(reading)
        handover = not close_attempt and hands_over_close(reading, after_sign_off=signed_off)
        # Review S3R-3 / S3R-1 (naturalness): a mutual goodbye takes leave ("Sure. Thank you.");
        # a hollow or acknowledging turn ("Hmm.", "Okay, so", "We have EMI options.") is the
        # advisor thinking or going on, and only keeps the closing state where it is.
        mutual = (
            not close_attempt and not handover and signed_off and courtesy_goodbye(reading)
        )
        if handover:
            self._handover_closes += 1
            reasons.append("handover_close")
        elif mutual:
            self._mutual_goodbyes += 1
            reasons.append("mutual_goodbye")
        elif not close_attempt and not courtesy and self._closing != CLOSING_OPEN:
            self._enter_closing(CLOSING_OPEN)  # the advisor said something real: the call goes on
        return close_attempt or handover or mutual

    def _yield_snapshot(self) -> tuple[Any, ...]:
        """Review S7L-R2: the state this turn's readers may change before the floor check."""
        open_q = None if self._open_q is None else dict(self._open_q)
        return (
            self._price_dodges,
            open_q,
            self._open_q_dodged,
            frozenset(self._come_back_spent),
            self._dodge_now,
        )

    def _yield_restore(self, snapshot: tuple[Any, ...], turn: int) -> None:
        """Review S7L-R2: a floor-yield turn is transparent ("Sure, go ahead." asked nothing).

        Its readers counted no price dodge and closed no open question, and the windows that
        expect the answer on the turn right after her question (her price probe, her SWEEP-7
        question, a dodge's come-back window) move on by one turn, so the advisor's real answer on
        the next turn is read as the answer it is.
        """
        dodges, open_q, dodged, spent, dodge_now = snapshot
        self._price_dodges = dodges
        self._open_q_dodged = dodged
        self._come_back_spent = set(spent)
        self._dodge_now = dodge_now
        if self._price_asked_turn is not None and self._price_asked_turn == turn - 1:
            self._price_asked_turn = turn
        if open_q is not None:
            if open_q["asked_turn"] == turn - 1:
                # The line that asked it is still the one she was last heard on.
                open_q.setdefault("heard_turn", open_q["asked_turn"])
                open_q["asked_turn"] = turn
            if open_q["dodged_turn"] is not None:
                open_q["dodged_turn"] += 1
        self._open_q = open_q

    def _floor_yield_plan(
        self,
        reasons: list[str],
        *,
        cut: bool,
        cut_move: str | None,
        live: bool,
        split: _LostHalf | None,
    ) -> TurnPlan:
        """M032 SWEEP-33: the advisor asked for the floor, so she yields in a few scripted words.

        Nothing is issued and no hold budget is spent: the owed move simply stays owed (it was not
        forced, ``_may_defer``).  The cut this turn consumed is re-armed for the next real turn
        (which gets the cut-move hold and the interrupted note as it would have), never counted in
        ``_interrupt_deferred``; a carried first half (S1 item 7) is kept for that turn too.  The
        apologetic pair when the request cut her line or her reply never got out.
        """
        self._floor_yields += 1
        self._learner_cut, self._cut_move = cut, cut_move
        self._floor_rearm = (cut, cut_move)
        if split is not None:
            self._floor_half = split
            self._split_replans = max(0, self._split_replans - 1)  # counted on the real turn
        self._turn_kinds = frozenset()
        self._notes = []
        pair = FLOOR_YIELD_SORRY_LINES if cut or live else FLOOR_YIELD_LINES
        line_id = pick_variant(pair, self.seed, self._floor_yields - 1)
        reasons.append("floor_yield")
        return self._plan(TurnMode.SAY_ONLY, reasons, scripted=script_line(line_id))

    def _winding_plan(self, reasons: list[str]) -> TurnPlan:
        """S3.2: the advisor is closing the call: one short, warm goodbye in her own words."""
        self._enter_closing(CLOSING_WINDING)
        reasons.append("closing_winding")
        return self._plan(TurnMode.LLM_REPLY, reasons, winding=True)

    def _early_close_plan(
        self, r_sec: float, turn_index: int | None, reasons: list[str]
    ) -> TurnPlan:
        """S3.3 (D-M032-2): Christy asks before an in-role close ends the role-play before 14:00.

        R is paused (an aside).  The turn was said to the learner and stays evidence.  Below R =
        10:00 the line adds that there is still time (a stop there leaves the attempt unscored).
        A yes ends the role-play, a no resumes it and the learner carries on with a real point
        (``continuation_plan``); answered like L-ASIDE-WRAP (``_wrap_answer_plan``).
        """
        line_id = EARLY_CLOSE_TIME_LINE if r_sec < FIDELITY_MIN_R_SEC else EARLY_CLOSE_LINE
        self._enter_closing(CLOSING_WINDING)
        self._wrap_open = True
        self._wrap_offers.append(
            {
                "r_sec": round(r_sec, 1),
                "trigger": TRIGGER_EARLY_CLOSE,
                "after_roleplay_turn": self.turn,
                "transcript_turn": turn_index,
                "answer": None,
                "line": line_id,
            }
        )
        return self._wrap_line_plan(line_id, [*reasons, "early_close:offer"])

    def _hangup_plan(self, r_sec: float, turn_index: int | None, reasons: list[str]) -> TurnPlan:
        """S3.4 (D-M032-3): she ends the call in role in one line, then Christy asks (R paused).

        The session says L-LEARNER-HANGUP in her voice (``prelude_line``), then L-ASIDE-HANGUP.
        A yes ends the role-play; a no resumes it with her cool (``COOL_NOTE``).  The abusive
        turn was said to her and stays evidence; nothing is graded here.
        """
        self._wrap_open = True
        self._wrap_offers.append(
            {
                "r_sec": round(r_sec, 1),
                "trigger": TRIGGER_ABUSE,
                "after_roleplay_turn": self.turn,
                "transcript_turn": turn_index,
                "answer": None,
                "line": HANGUP_ASIDE_LINE,
            }
        )
        plan = self._wrap_line_plan(HANGUP_ASIDE_LINE, [*reasons, "abuse_hangup"])
        # Review S3R-5: until the session has said her hang-up line and Christy's question begins
        # (``hangup_prelude_done``), a turn cannot answer that question: it waits.
        self._hangup_prelude = True
        return replace(plan, prelude_line=HANGUP_LINE)

    def hangup_prelude_done(self) -> None:
        """S3.4: her hang-up line is over and Christy's question starts (or will not be said)."""
        self._hangup_prelude = False

    def _late_end_request(
        self, turn_index: int | None, *, r_sec: float, by_model: bool
    ) -> TurnPlan:
        """SWEEP-24: an explicit request to end the exercise from 14:00 is never answered in role.

        Nothing required owed: the role-play exit (no WEAK line, no close-ladder count).  One owed
        move that completes the schedule (the only required move pending, F1-COUNTER delivered):
        L-ASIDE-LAST-POINT, then the learner raises it (forced) and the next real turn exits, once
        per session.  More owed: the exit at once, as an explicit request before 14:00 does.
        """
        self._late_end_requests += 1
        pending = self.scheduler.required_pending()
        if (
            len(pending) == 1
            and self.scheduler.is_delivered(F1_COUNTER)
            and self._last_point is None
        ):
            move = self.scheduler.next_forced_peek(r_sec)
            if move is not None and move.id == pending[0]:
                return self._last_point_plan(move.id, r_sec, turn_index, by_model=by_model)
        return self._end_plan(turn_index, r_sec=r_sec, by_model=by_model, late=True)

    def _last_point_plan(
        self, move_id: str, r_sec: float, turn_index: int | None, *, by_model: bool
    ) -> TurnPlan:
        """SWEEP-24: Christy says it will stop in a moment; the learner's last point follows."""
        self._last_point = {
            "move_id": move_id,
            "r_sec": round(r_sec, 1),
            "after_roleplay_turn": self.turn,
            "transcript_turn": turn_index,
            "answer": None,
        }
        self._exit_after_last_point = True
        self._continuation_due = ("last_point", move_id)
        reasons = ["end_request_explicit", "end_request_late", "last_point_aside"]
        if by_model:
            reasons.append("end_intent_model")
        plan = self._wrap_line_plan(LAST_POINT_LINE, reasons)
        return replace(plan, continuation=True)

    def _after_last_point(
        self, text: str, turn_index: int | None, *, backchannel: bool, repair: bool
    ) -> TurnPlan | None:
        """SWEEP-24: the turn after her last point (None: plan it as usual).

        A real turn ends the role-play (``end_request_late_exit``); "No, carry on" resumes it; a
        "Sorry?" gets her point again; a back-channel or a fragment waits.
        """
        point = self._last_point or {}
        if declines_end(text) and not confirms_end(text):
            self._exit_after_last_point = False
            point["answer"] = "resumed"
            return None
        if repair and not backchannel:
            self._notes = [_cut_repeat_note()]
            self._price_notes = []
            return self._plan(TurnMode.LLM_REPLY, ["last_point_repeat"])
        if backchannel or word_count(text) <= END_FRAGMENT_WORDS:
            return self._wrap_line_plan(None, ["last_point_pending"])
        self._exit_after_last_point = False
        point["answer"] = "exit"
        point["answer_transcript_turn"] = turn_index
        # Review S3R-4: this turn answers her last point in role, so it is a role-play turn (the
        # session keeps its row as evidence): counted like any other, so the engine's fidelity and
        # the API gate's transcript stats read the same turns.
        words = word_count(text)
        self._word_counts.append(words)
        self._stt_word_counts.append(words)
        self.exit_requested = True
        return self._plan(TurnMode.EXIT, ["end_request_late_exit"])

    def last_point_lapsed(self) -> bool:
        """SWEEP-24: a quiet after her last point ends the role-play (True when it did)."""
        if not self._exit_after_last_point:
            return False
        self._exit_after_last_point = False
        if self._last_point is not None:
            self._last_point["answer"] = "quiet"
        self.exit_requested = True
        return True

    def drop_resume_continuation(self) -> bool:
        """Review S3R-7: the resume line after an aside is not owed once a newer turn was planned.

        Only S3.3's resume ("No." to the early-close question): her last point (SWEEP-24) is still
        owed whatever the candidate said.  True when one was dropped.
        """
        if self._continuation_due is None or self._continuation_due[0] != "resume":
            return False
        self._continuation_due = None
        return True

    def continuation_plan(self, r_sec: float) -> TurnPlan | None:
        """The learner's line right after an aside (S3.3's resume, SWEEP-24's last point), or None.

        The session asks for it once the aside has played and speaks it as her reply (no candidate
        turn: the turn and its evidence are the ones before the aside).  The last point is the owed
        move, forced, with the last-point brief and no "Oh wait" opener; the resume picks the call
        up with an owed move or one real question, never a greeting or a goodbye.
        """
        due, self._continuation_due = self._continuation_due, None
        if due is None or self.exit_requested:
            return None
        kind, move_id = due
        self.last_r = r_sec
        # Review S3R-1: a continuation answers no candidate turn, so nothing of the turn before the
        # aside is given back if its reply is cancelled before any audio (``reply_lost``).
        self._turn_undo = None
        self._notes = []
        self._price_notes = []
        self._force_curiosity = False
        if kind == "last_point":
            move = self.scheduler.next_forced_peek(r_sec)
            if move is None or move.id != move_id:
                return None  # it was delivered meanwhile: nothing is left to say
            move = self.scheduler._force_next(r_sec) or move
            self.scheduler.issue(move)
            self._turn_issued = move.id
            return self._intent_plan(
                move,
                ["continuation:last_point", f"owed:{move.id}:forced"],
                redirect=False,
                last_point=True,
                first_probes=(),
                reveal_topics=(),
                monologue=None,
            )
        self._notes.append(CONTINUE_NOTE)
        reasons = ["continuation:resume"]
        move = self.scheduler.select(r_sec)
        if move is not None and move.id != COMMIT_STALL:
            probe = self._probe_step(move, r_sec) if self._probe_first else None
            if probe is not None:
                return self._probe_plan(
                    probe, reasons, first_probes=(), reveal_topics=(), monologue=None
                )
            self.scheduler.issue(move)
            self._turn_issued = move.id
            reasons.append(f"owed:{move.id}" + (":forced" if move.forced else ""))
            return self._intent_plan(
                move,
                reasons,
                redirect=False,
                first_probes=(),
                reveal_topics=(),
                monologue=None,
            )
        reasons.append("free_reply")
        curiosity = self._curiosity_for_free_reply(force=True)
        return self._plan(TurnMode.LLM_REPLY, reasons, curiosity=curiosity)

    # ------------------------------------------------------------- M2: the wrap-up offer
    @property
    def wrap_question_open(self) -> bool:
        """True while L-ASIDE-WRAP waits for its answer (the next candidate turn answers it)."""
        return self._wrap_open

    @property
    def open_question_line(self) -> str | None:
        """The interviewer's question the next candidate turn answers, if any (its line id)."""
        if self.end_question_open:
            return "L-ASIDE-END"
        if not self._wrap_open:
            return None
        # M032 S3: the early-close and hang-up questions are answered like the offer.
        return str(self._wrap_offers[-1].get("line") or WRAP_OFFER_LINE)

    def settles_as_yes(self, text: object) -> bool:
        """True for a short yes to an open question: the session lets it settle before planning.

        A bare yes to L-ASIDE-END (``is_bare_yes``), or a short yes to L-ASIDE-WRAP
        (``is_short_wrap_yes``, which also takes "Okay." and "Sounds good.").
        """
        if self.end_question_open and is_bare_yes(text):
            return True
        if self._wrap_open and self._wrap_offers[-1]["trigger"] == TRIGGER_EARLY_CLOSE:
            # M032 S3.3: "you're welcome to keep going, or if you'd rather stop, just say so": a
            # bare "Okay.", "Sure.", "Yes." or "Go ahead." could mean either (review S3R-2,
            # naturalness), so nothing settles as a yes; only words that stop do.
            return False
        return self._wrap_open and is_short_wrap_yes(text)

    def _wrap_trigger(self, r_sec: float) -> str | None:
        """Why the interviewer may offer to wrap up now, or None (M2, ``WRAP_OFFER_*``).

        Never before 14:00 or from 18:30, never while an interviewer question is open or after the
        exit, at most ``WRAP_OFFER_LIMIT`` times, and not within ``WRAP_OFFER_COOLDOWN_SEC`` of a
        no.  Then: the commitment is resolved, or the call is going nowhere (``WRAP_STALE_TURNS``
        advisor turns in a row that raised nothing new, ``WRAP_HOLLOW_TURNS`` hollow turns in a
        row, or ``WRAP_LATE_STALLS`` stall reasons from 14:00 on).
        """
        if (
            self.exit_requested
            or self._wrap_open
            or self._end_pending
            or self._exit_after_last_point  # M032 SWEEP-24: the role-play is already ending
            or self._wrap_offers_made() >= WRAP_OFFER_LIMIT
            or not WRAP_OFFER_FROM_R_SEC <= r_sec < WRAP_OFFER_UNTIL_R_SEC
        ):
            return None
        if (
            self._wrap_declined_at is not None
            and r_sec - self._wrap_declined_at < WRAP_OFFER_COOLDOWN_SEC
        ):
            return None
        if self.commitment_resolved:
            return "commitment_resolved"
        if (
            self._stale_run >= WRAP_STALE_TURNS
            or self._hollow_run >= WRAP_HOLLOW_TURNS
            or self._late_stalls >= WRAP_LATE_STALLS
        ) and not self.scheduler.graded_moves_owed(r_sec):
            # Review fix: not while a graded move is owed (F4 is due by 15:30): an
            # accepted offer would end the role-play before it and fail the gate.
            return "going_nowhere"
        return None

    def _wrap_offers_made(self) -> int:
        """The offers to wrap up from 14:00 (M032 S3's early-close and hang-up asks not counted)."""
        return sum(
            1
            for offer in self._wrap_offers
            if offer["trigger"] not in (TRIGGER_EARLY_CLOSE, TRIGGER_ABUSE)
        )

    def _learner_asked_last(self) -> bool:
        """The learner's last line asked the advisor something: the next words are theirs."""
        return bool(self._asked) and self._asked[-1]

    # ------------------------------------------------- M032 SWEEP-7: the come-back
    def _read_open_question(self, reading: str, turn: int) -> None:
        """Whether this advisor turn answered, dodged or left her open question (R1_COME_BACK).

        Read on the advisor turn right after the line that asked it (``asked_turn``): an answer on
        the topic closes it, a dodge (``dodged_question``) opens the come-back window, and anything
        else closes it (a plain pitch is no dodge).  A second dodge after the come-back closes it
        for good (course facts after two dodges are S2P's), and so does a dodge once the session's
        come-backs are spent.  A window that passed with no free reply closes it.
        """
        open_q = self._open_q
        if open_q is None or not flag_on(FLAG_COME_BACK):
            return
        topic = open_q["topic"]
        if open_question_covered(topic, reading):
            self._open_q = None
            return
        if open_q["dodged_turn"] is not None:
            if turn - open_q["dodged_turn"] >= COME_BACK_WINDOW_TURNS:
                self._open_q = None  # the window passed with no free reply
            return
        if open_q["asked_turn"] != turn - 1:
            self._open_q = None
            return
        if challenges_learner(reading, figure=self._probe_first) or not dodged_question(
            reading, (topic,)
        ):
            # A challenge ("where did you get that number?") answers her line, with its own hold.
            self._open_q = None
            return
        self._dodge_now = True
        self._open_q_dodged += 1
        if open_q["reasked"] or self._open_q_reasked >= COME_BACK_LIMIT:
            self._come_back_spent.add(topic)
            self._open_q = None
            return
        open_q["dodged_turn"] = turn

    def _come_back_note(self, reading: str, *, quiet: bool) -> bool:
        """SWEEP-7: this free reply comes back once to her dodged question; the note is added.

        Never while she is winding up or closed, on a confirmation, after a commitment, when the
        advisor handed the decision back or backed off, nor on a quiet turn (a challenge, a cut, a
        disclosure).  On a lone "okay" SWEEP-11's note keeps her last question, and that counts as
        the come-back when her last line asked it.  The note replaces ASKED_DIRECTLY_NOTE (the
        after-ask form answers his question first) and S2's not-answered note.
        """
        open_q = self._open_q
        if open_q is None or open_q["dodged_turn"] is None or open_q["reasked"]:
            return False
        if (
            quiet
            or self._closing != CLOSING_OPEN
            or self._confirming()
            or self.commitment_resolved
            or self._commitment_level is not None
            or RESPOND_BACK_OFF in self._turn_kinds
            or backs_off(reading)
            or hands_over_close(reading)
            or self._open_q_reasked >= COME_BACK_LIMIT
        ):
            return False
        if self._ack_turn():
            heard = open_q.get("heard_turn", open_q["asked_turn"])  # review S7L-R2: a yield
            if self._learner_asked_last() and self._last_heard_turn == heard:
                self._mark_come_back(open_q)
            return False
        asked = RESPOND_QUESTION in self._turn_kinds or asks_her_directly(reading)
        if ASKED_DIRECTLY_NOTE in self._notes:
            self._notes.remove(ASKED_DIRECTLY_NOTE)
        template = OPEN_QUESTION_AFTER_ASK_NOTE if asked else OPEN_QUESTION_NOTE
        self._notes.append(template.format(label=open_q["label"]))
        self._come_back_topic = open_q["topic"]
        return True

    def _your_number_note(self, reading: str, negotiated: NegotiationTurn, *, quiet: bool) -> bool:
        """M032 SWEEP-6 (R1_PRICE_MEMORY): he asked what she could pay; the note is added.

        Only once F1-ANCHOR is delivered (before it, SWEEP-19 makes the question a moment for the
        F1 probe or anchor), on a free reply that is not quiet, a confirmation, a check-in or a
        challenge.  The met form when the best offer is already at or below what she hoped for.
        It replaces ASKED_DIRECTLY_NOTE (never both).
        """
        if (
            quiet
            or not flag_on(FLAG_PRICE_MEMORY)
            or not self.scheduler.is_delivered(F1_ANCHOR)
            or self._confirming()
            or negotiated.checkin
            or challenges_learner(reading, figure=self._probe_first)
        ):
            return False
        kind = her_number_question(reading)
        if kind is None:
            return False
        best = self.negotiation.best_offer_usd
        if best is not None and best <= ANCHOR_USD:
            note = YOUR_NUMBER_MET_NOTE
        elif kind == YOUR_NUMBER_MONTHLY:
            note = YOUR_NUMBER_MONTHLY_NOTE
        else:
            note = YOUR_NUMBER_TOTAL_NOTE
        if ASKED_DIRECTLY_NOTE in self._notes:
            self._notes.remove(ASKED_DIRECTLY_NOTE)
        self._notes.append(note)
        self._your_number_notes += 1
        return True

    def _read_call_opening(self, reading: str, turn: int) -> None:
        """M032 SWEEP-9: who is calling, read on the advisor's first two turns (latched)."""
        if turn > 2 or self._caller_known or not flag_on(FLAG_CALL_OPENING):
            self._caller_intro = ""
            return
        self._caller_intro = caller_introduced(reading, names=(self.persona.first_name,))
        if self._caller_intro == CALLER_KNOWN:
            self._caller_known = True

    def _call_opening_note(self, reading: str, quiet: bool) -> str:
        """M032 SWEEP-9 (R1_CALL_OPENING): her first or second reply asks who is calling.

        A free reply only (a move always wins), never a quiet one.  Unknown caller: she answers the
        greeting and asks who is calling, once a session, unless she already asked.  A name only:
        she asks where from, once.  Otherwise, asked how she is: she says and asks back, once; a
        caller note on a turn that also asked how she is spends it (she answered it then).
        """
        if self.turn > 2 or quiet or not flag_on(FLAG_CALL_OPENING):
            return ""
        how = asks_how_she_is(reading)
        kind = ""
        if not self._caller_known and not self._asked_who:
            if self._caller_intro == "" and not self._opening_notes.get("unknown"):
                kind = "unknown"
                template, examples = CALLER_UNKNOWN_NOTE, CALLER_UNKNOWN_EXAMPLES
            elif self._caller_intro == CALLER_NAME_ONLY and not self._opening_notes.get(
                "name_only"
            ):
                kind = "name_only"
                template, examples = CALLER_NAME_ONLY_NOTE, CALLER_NAME_ONLY_EXAMPLES
        if kind:
            self._how_spent = self._how_spent or how
        elif how and not self._how_spent:
            kind = "reciprocal"
            template, examples = HOW_ARE_YOU_NOTE, HOW_ARE_YOU_EXAMPLES
            self._how_spent = True
        else:
            return ""
        example = pick_variant(examples, f"{self.seed}:opening", 0)
        if kind != "reciprocal" and ASKED_DIRECTLY_NOTE in self._notes:
            self._notes.remove(ASKED_DIRECTLY_NOTE)
        self._notes.append(template.format(example=example))
        self._opening_notes[kind] = self._opening_notes.get(kind, 0) + 1
        return kind

    def _mark_come_back(self, open_q: dict[str, Any]) -> None:
        """SWEEP-7: she came back to it; a further dodge closes it for good."""
        open_q["reasked"] = True
        open_q["dodged_turn"] = None
        self._open_q_reasked += 1
        self._come_back_spent.add(open_q["topic"])

    def _note_open_question(self, plan: TurnPlan, spoken_text: str) -> None:
        """SWEEP-7: what her heard line asked, read in ``record_spoken`` (free replies only)."""
        if not flag_on(FLAG_COME_BACK):
            return
        free = (
            plan.mode is TurnMode.LLM_REPLY
            and plan.move_id is None
            and plan.negotiation_id is None
            and plan.credit_move_id is None
            and plan.commitment_level is None
        )
        open_q = self._open_q
        if "come_back" in plan.reasons and open_q is not None:
            if open_q["topic"] in open_question_topics(spoken_text):
                self._mark_come_back(open_q)
                open_q["asked_turn"] = plan.turn
                open_q.pop("heard_turn", None)
            else:
                self._come_back_spent.add(open_q["topic"])  # the guard cut it: let it go
                self._open_q = None
            return
        if not free:
            return
        topics = [
            topic
            for topic in OPEN_QUESTION_LABELS
            if topic in open_question_topics(spoken_text) and topic not in self._come_back_spent
        ]
        if not topics:
            if open_q is not None and open_q["dodged_turn"] is None:
                self._open_q = None
            return
        topic = topics[0]
        labels = OPEN_QUESTION_LABELS[topic]
        self._open_q = {
            "topic": topic,
            "label": pick_variant(labels, f"{self.seed}:{topic}", 0),
            "asked_turn": plan.turn,
            "dodged_turn": None,
            "reasked": False,
        }

    # ------------------------------------------------- M032 S1: respond first, natural moments
    def _respond_kinds(
        self,
        text: str,
        negotiated: NegotiationTurn,
        wants: AskKind | None,
        *,
        carried: _LostHalf | None = None,
    ) -> frozenset[str]:
        """What the advisor's turn left open for her (``RESPOND_*``), or nothing.

        A turn the negotiation answers (a call or enrolment ask, a callback, an e-mail offer or a
        price on the table) leaves nothing here: the negotiation has its own lines for it.  A
        check-in is not a question put to her (it hands her the floor and asks her for one real
        question).  ``carried``: the first half of a split answer, whose reply was never heard.
        """
        if (
            wants is not None
            or negotiated.email_offer
            or negotiated.callback is not None
            or negotiated.offers
        ):
            return frozenset()
        kinds: set[str] = set() if carried is None else set(carried.kinds)
        if offers_something(text):
            kinds.add(RESPOND_OFFER)
        if backs_off(text):
            levers, coercive = urgency_levers(text)
            if not coercive and not levers & _PRESSING_LEVERS:
                kinds.add(RESPOND_BACK_OFF)
        if asks_her_directly(text) and not negotiated.checkin and not challenges_learner(text):
            # A challenge has its own hold (twice per session) and its own note.
            kinds.add(RESPOND_QUESTION)
        if self._answers_her_question(text):
            kinds.add(RESPOND_ANSWERED)
        return frozenset(kinds)

    def _answers_her_question(self, text: str) -> bool:
        """Her last line asked something of her own (not an owed move) and this turn answers it."""
        if not self._learner_asked_last() or self._last_owed_line or is_hollow_turn(text):
            return False
        if self._dodge_now:
            return False  # M032 SWEEP-7: a deferral, a vague answer or a pivot answers nothing
        if self._her_question_topics:
            # Her question had a topic: only an answer on it counts (review S1R-3: "our alumni
            # work at big tech" after "how many hours a week?" is no answer, and telling her it
            # was invites the token "That helps" the owner complained about).
            return any(curiosity_covered(topic, text) for topic in self._her_question_topics)
        return tells_something(text)

    def _respond_notes(self, kinds: frozenset[str]) -> None:
        """The reply's job on a turn that left something open for her (S1 items 2 and 6).

        M032 SWEEP-4: with R1_LEARNER_VOICE_V2 the offer and answer notes ask what it means for
        her, never "how it lands" (the cue for a graded "That sounds reasonable").
        """
        voice_v2 = flag_on(FLAG_LEARNER_VOICE_V2)
        if RESPOND_OFFER in kinds:
            self._notes.append(OFFER_MADE_NOTE_V2 if voice_v2 else OFFER_MADE_NOTE)
        if RESPOND_BACK_OFF in kinds:
            # RCA END-5: the advisor gave her time, so the proposed next step no longer stands
            # (HOLD_NOTE stops) and, if there was pressure to ease, she lets it go.  A new ask
            # later sets the hold again.
            eased = (
                self._pending_ask is not None
                or self._concerns.get(CONCERN_PRESSURE, 0) > 0
                or self.scheduler.is_delivered(F4_PRIMARY)
            )
            self._pending_ask = None
            if eased and not self._cool:
                # Review S3R-6 (naturalness): never "acknowledge it warmly" beside COOL_NOTE's
                # "no warmth" after a resumed hang-up.
                self._notes.append(PRESSURE_EASED_NOTE)
        if RESPOND_QUESTION in kinds:
            self._notes.append(ASKED_DIRECTLY_NOTE)  # a free reply's; an intent answers it first
        if RESPOND_ANSWERED in kinds:
            self._notes.append(ANSWERED_YOU_NOTE_V2 if voice_v2 else ANSWERED_YOU_NOTE)

    # ------------------------------------------------------------- M032 S2: learner voice
    def _read_offer_extras(self, text: str, seen: NegotiationTurn, turn: int) -> None:
        """What an offer carried for her reaction this turn (SWEEP-5 terms, SWEEP-13 realism).

        Only candidates are kept here; ``_plan`` adds the note to a reply that is voiced by the
        model (never a scripted line or the reaction before one) and counts it there.
        """
        self._implausible_note = ""
        self._turn_terms = ()
        found = None
        realism = flag_on(FLAG_OFFER_REALISM)
        if realism or self._probe_first or flag_on(FLAG_COUNTER_V2):
            found = implausible_offer_in(text, self.negotiation.own_amounts)
        # M032 SWEEP-19: the kind of the last price named (far below or free, or an ordinary one),
        # for the far-below counter and the free anchor; and a reader-confirmed figure under
        # $1,000 is a low mention the anchor reacts to (probe first).
        if found is not None:
            self._last_price_kind = found[0]
            if found[0] == IMPLAUSIBLE_FREE:
                self._free_turn = turn
            usd = found[1]
            if (
                self._probe_first
                and found[0] == IMPLAUSIBLE_LOW
                and usd is not None
                and 0 < usd < MIN_FRAMED_NET_USD
                and (turn, usd) not in self.negotiation.low_mentions
            ):
                self.negotiation.low_mentions.append((turn, usd))
        elif (
            any(offer.net_usd > IMPLAUSIBLE_NET_USD for offer in seen.offers)
            or (self._probe_first and (seen.totals or seen.named))
        ):
            # Review S2P-R1 (naturalness): a price he stated afterwards is the price now, so a
            # hypothetical "free" said earlier is no longer what she reacts to.
            self._last_price_kind = None
        if not realism:
            found = None  # the careful-buyer note itself stays SWEEP-13's
        named = [offer.net_usd for offer in seen.offers]
        if found is not None and found[0] == IMPLAUSIBLE_LOW and found[1] is not None:
            named.append(found[1])
        if named:
            self._latest_price_usd = min(named)
        if (
            found is not None
            and self._implausible_count < IMPLAUSIBLE_NOTE_LIMIT
            and self._implausible_turn != turn - 1
        ):
            kind, usd = found
            if kind == IMPLAUSIBLE_FREE:
                self._implausible_note = IMPLAUSIBLE_FREE_NOTE
            elif usd is not None:
                self._implausible_note = IMPLAUSIBLE_PRICE_NOTE.format(amount=format_usd(usd))
        self._turn_terms_monthly = False
        if flag_on(FLAG_OFFER_TERMS):
            terms = offer_terms_in(text)
            fresh = [term for term in OFFER_TERMS if term in terms and term not in self._terms_used]
            if self._implausible_note == IMPLAUSIBLE_FREE_NOTE:
                fresh = [term for term in fresh if term != TERM_FREE_EXTRA]  # its note wins
            self._turn_terms = tuple(fresh)
            # Review S2R-8: only a monthly plan gets "what it would come to each month".
            self._turn_terms_monthly = TERM_INSTALMENTS in fresh and instalments_are_monthly(text)

    def _offer_extra_notes(self) -> tuple[str, ...]:
        """This turn's careful-buyer note and offer-terms note, counted as given (``_plan``)."""
        notes: list[str] = []
        if self._implausible_note:
            notes.append(self._implausible_note)
            self._implausible_count += 1
            self._implausible_turn = self.turn
        terms = self._turn_terms
        if terms:
            clauses = {
                TERM_INSTALMENTS: (
                    OFFER_TERMS_INSTALMENTS if self._turn_terms_monthly else OFFER_TERMS_IN_PARTS
                ),
                TERM_FREE_EXTRA: OFFER_TERMS_FREE_EXTRA,
            }
            notes.append(" ".join((OFFER_TERMS_HEADER, *(clauses[term] for term in terms[:2]))))
            for term in terms:
                self._terms_used.add(term)
                self._terms_counts[term] = self._terms_counts.get(term, 0) + 1
        self._implausible_note = ""
        self._turn_terms = ()
        self._turn_terms_monthly = False
        return tuple(notes)

    def _give_back_s2(self, undo: tuple[Any, ...]) -> None:
        """Review S2R-6: what a lost reply's plan used up of the S2 state, given back.

        Nobody heard that reply, so its careful-buyer and offer-terms notes were never given (the
        reply that is heard may carry them, and they are not counted twice), its note counts did
        not happen, and the coach aside it followed still wants the "carry on" note.
        """
        (
            after_coach,
            count,
            turn,
            used,
            counts,
            acks,
            no_commit,
            dodges,
            conflicts,
            rise_open,
            reflexes,
            price_first,
        ) = undo
        self._after_coach = self._after_coach or after_coach
        # M032 S2P (review S2P-R4/R5): the dodge the lost half counted, the conflict it raised (a
        # continuation checks it, ``reapply_conflict``) and the notes it used up are given back.
        self._price_dodges = dodges
        self.negotiation.conflicts = list(conflicts)
        self.negotiation.rise_open_turn = rise_open
        self._price_reflexes = reflexes
        self._price_first_turns = price_first
        self._implausible_count = count
        self._implausible_turn = turn
        self._terms_used = set(used)
        self._terms_counts = dict(counts)
        self._ack_turn_notes = acks
        self._no_commit_notes = no_commit

    def _preempted_label(self, family: str | None) -> str:
        """Item 4: the label of what the advisor already said about ``family`` ("" for none)."""
        labels = dict(PREEMPTED_LABELS)
        if family == "F2" and "F2" not in self._preempted:
            family = PREEMPTED_F2_FORMAT if PREEMPTED_F2_FORMAT in self._preempted else None
        if family is None or family not in self._preempted:
            return ""
        return labels.get(family, "")
    def _length_note(self) -> str:
        """SWEEP-14: a free reply's length line, keyed to the advisor's turn."""
        reading = self._turn_reading
        if offers_floor(reading):
            return LENGTH_LONG
        if self._turn_backchannel:
            return LENGTH_VERY_SHORT
        if RESPOND_QUESTION in self._turn_kinds or asks_her_directly(reading):
            return LENGTH_LONG
        if RESPOND_ANSWERED in self._turn_kinds or self._answers_her_question(reading):
            return LENGTH_VERY_SHORT
        if word_count(reading) >= LONG_ADVISOR_WORDS:
            return LENGTH_LONG
        rotation = (LENGTH_ONE, LENGTH_ONE_OR_TWO, LENGTH_ONE_OR_TWO)  # one in three: one sentence
        return pick_variant(rotation, self.seed, self.turn)

    def _ack_turn(self) -> bool:
        """SWEEP-11: a lone acknowledgement that did not cut her, after a line that was no goodbye,
        with no interviewer question open."""
        return (
            flag_on(FLAG_ACK_TURN_NOTE)
            and self._turn_backchannel
            and not self._turn_cut
            and not (self._hollow_run >= 1 and self._last_reply_closer)
            and not self.end_question_open
            and not self._wrap_open
            # Review S2R-6: "Yeah." after her yes/no question answers it; asking again would
            # sound as if she had not heard him.
            and not (
                self._learner_asked_last()
                and self._asked_yes_no
                and _YES_LIKE_TURN.match(self._turn_reading) is not None
            )
        )

    def _soft_tic_words(self) -> str:
        """SWEEP-12: the soft tics (and "I'd rather") in two of her last four replies, quoted."""
        recent = self._soft_history[-SOFT_TIC_LOOKBACK:]
        words = []
        for word in (*SOFT_TICS, _RATHER):
            if word == _RATHER and self._pending_ask is not None:
                continue  # "I'd rather not book it" may be the very answer to the open ask
            if sum(1 for tics in recent if word in tics) >= SOFT_TIC_REPEATS:
                words.append(f'"{word}"')
        if not words:
            return ""
        return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]

    def _moment(
        self, text: str, negotiated: NegotiationTurn, kinds: frozenset[str], r_sec: float
    ) -> Moment:
        """The natural-moment reading of this turn for the scheduler (S1 item 1, D-M032-1)."""
        thread_open = bool(kinds) or self._dig_now
        thread_closed = not thread_open and (
            answers_substantively(text)
            or (is_hollow_turn(text) and not self._learner_asked_last())
        )
        return Moment(
            slack_ok=self._s1_slack(r_sec),
            floor_offered=negotiated.checkin or offers_floor(text),
            thread_open=thread_open,
            thread_closed=thread_closed,
        )

    def _give_back_lost(self, half: _LostHalf) -> None:
        """S1 item 7: what the lost reply's plan used up and nobody heard, given back.

        The move it issued (so a move is issued once per heard reply), its turn with the model
        (the variants rotate as if it never happened), the disclosure layers it marked (the
        replan hands them to the reply that is heard) and the one-turn hold it spent on the owed
        move (to respond first, for a dig, for discovery or for a challenge): the replan reads
        both halves and may hold the move again, so the reply that is heard is the one that
        answers first.
        """
        # A lost graded commitment line (the 19:00 stall, or a close-window WEAK stall carrying a
        # family move) keeps its issue: ``_revoice_commitment`` says that very line again without
        # issuing it (review S1-R7: it was delivered with "issued": 0).
        unheard = self._unheard_commitment
        if half.issued is not None and not (
            unheard is not None and unheard.turn == half.turn and unheard.move_id == half.issued
        ):
            self.scheduler.unissue(half.issued)
        key = half.intent_key
        if key is not None and self._intent_uses.get(key, 0) > 0:
            self._intent_uses[key] -= 1
        self.tracker.gate.give_back_offers(half.turn)
        if half.hold is None:
            return
        kind, move_id, counted = half.hold
        if kind in ("respond", "push_react"):
            self._respond_held.discard(move_id)
            counts = self._respond_holds if kind == "respond" else self._push_react_holds
            left = counts.get(counted, 0) - 1
            if left > 0:
                counts[counted] = left
            else:
                counts.pop(counted, None)
        elif kind == "dig":
            self._dig_deferred.discard(move_id)
            self._dig_deferred_topics.discard(counted)
        elif kind == "discovery":
            left = self._discovery_holds.get(move_id, 0) - 1
            if left > 0:
                self._discovery_holds[move_id] = left
            else:
                self._discovery_holds.pop(move_id, None)
        elif kind == "challenge" and move_id in self._challenge_deferred:
            self._challenge_deferred.remove(move_id)

    def _voiced_concerns(self, *, skip: frozenset[str] = frozenset()) -> str:
        """The themes she already voiced, as worker-authored clauses joined by "and" (item 5)."""
        labels = [
            label
            for theme, label in CONCERN_LABELS
            if theme not in skip
            and self._concerns.get(theme, 0) >= CONCERN_THRESHOLDS.get(theme, 1)
        ]
        return " and ".join(labels)

    @staticmethod
    def _wrap_engaged(negotiated: NegotiationTurn) -> bool:
        """The advisor worked the sale this turn: handled a reason, proposed a call or a price."""
        return bool(
            negotiated.reasons_handled
            or negotiated.callback is not None
            or negotiated.offer_added
            or negotiated.decider_asked
        )

    def _wrap_turn_is_pause(self, text: str) -> bool:
        """M2: a candidate turn the offer may follow: it asks, digs and pitches nothing.

        Conservative (review fix): only a turn made of acknowledgement, courtesy and
        closing words (``_WRAP_PAUSE_WORDS``) is a pause, so a question the speech-to-text
        left without its mark ("And your budget", "Any other doubts you have"), a
        statement-question, a discovery prompt or a pitch lead-in ("Let me explain how the
        program works", "Hear me out") is not; every other quiet is left to the pause
        path (``wrap_offer_at_pause``).  On top of that it is not a question or a dig (the
        aa166f09 turn 115, "what is your challenge currently?"), not unfinished, not a
        pitch (more than ``WRAP_PITCH_WORDS`` words, a sales topic such as the curriculum
        or the mentors, a price or a figure, a new offer), and not the answer to a question
        the learner just asked.  "Okay.", "Great, I'll send it over." and "Thank you
        for your time." are pauses.
        """
        words = normalize(text).split()
        if not words or not all(word in _WRAP_PAUSE_WORDS for word in words):
            return False
        if words[-1] in _WRAP_DANGLING_WORDS or _WRAP_LEAD_IN.search(normalize(text)):
            return False
        return not (
            self._learner_asked_last()
            or has_question(text)
            or asks_about_learner(text)
            or _WRAP_DISCOVERY.search(fold(text)) is not None
            or word_count(text) > WRAP_PITCH_WORDS
            or bool(answered_topics(text))
            or is_pitch_statement(text)
            or _WRAP_NEXT_STEP.search(fold(text)) is not None
            or quotes_price(text)
            or bool(advisor_amounts_in(text))
            or self._new_offer_usd is not None
        )

    def wrap_pause_due(self, r_sec: float) -> bool:
        """True when a quiet after the learner's line may carry the offer (``wrap_offer_at_pause``).

        The session then waits ``WRAP_OFFER_PAUSE_SEC`` of quiet instead of the silence window.
        """
        return (
            self.turn > 0
            and self._wrap_trigger(r_sec) is not None
            and not self._learner_asked_last()
            and self._unheard_commitment is None
            and not self._raised_last
        )

    def wrap_offer_at_pause(self, r_sec: float) -> TurnPlan | None:
        """M2: the offer in a natural pause: ``WRAP_OFFER_PAUSE_SEC`` of quiet after her line.

        The session calls it once that quiet has passed (nothing is observed: there is no candidate
        turn).  None when no offer is due, when her last line asked the advisor something or raised
        an objection or a stall (the quiet is theirs to think in), or when a commitment line she
        must say again is pending.
        """
        if not self.wrap_pause_due(r_sec):
            return None
        trigger = self._wrap_trigger(r_sec) or ""
        return self._wrap_offer_plan(
            r_sec, trigger, None, reasons=[f"wrap_offer:{trigger}", "wrap_offer_at_pause"]
        )

    def _wrap_offer_plan(
        self, r_sec: float, trigger: str, turn_index: int | None, *, reasons: list[str]
    ) -> TurnPlan:
        """L-ASIDE-WRAP, spoken by the interviewer with R paused; the next turn answers it."""
        self._wrap_open = True
        self._wrap_offers.append(
            {
                "r_sec": round(r_sec, 1),
                "trigger": trigger,
                "after_roleplay_turn": self.turn,
                "transcript_turn": turn_index,
                "answer": None,
            }
        )
        return self._wrap_line_plan(WRAP_OFFER_LINE, reasons)

    def _wrap_line_plan(self, line_id: str | None, reasons: list[str]) -> TurnPlan:
        """An interviewer aside of the offer (``line_id`` None: nothing is said, the turn waits)."""
        return self._plan(
            TurnMode.SAY_ONLY,
            reasons,
            scripted="" if line_id is None else script_line(line_id, **self.persona.line_values),
            voice="interviewer",
            aside=True,
            line_id=line_id,
        )

    def _wrap_closed(self, answer: str, r_sec: float, turn_index: int | None) -> None:
        """The offer is answered without a yes: record it, and start the cool-down."""
        self._wrap_open = False
        offer = self._wrap_offers[-1]
        offer["answer"] = answer
        offer["answer_transcript_turn"] = turn_index
        self._wrap_declined_at = r_sec
        if offer["trigger"] == TRIGGER_EARLY_CLOSE:
            self._enter_closing(CLOSING_OPEN)  # M032 S3.3: they chose to carry on
        elif offer["trigger"] == TRIGGER_ABUSE:
            self._cool = True  # M032 S3.4: the call goes on, and she is cool

    def _wrap_answer_plan(
        self,
        text: str,
        r_sec: float,
        turn_index: int | None,
        *,
        repair: bool,
        end_intent: str | None,
        confirmed_yes: bool,
    ) -> TurnPlan | None:
        """M2: what the candidate's answer to L-ASIDE-WRAP gets; None to plan the turn as usual.

        * A yes (words that ask to stop, a short yes that settled, a goodbye, or the end-intent
          model's "end") is the role-play exit, reason ``wrap_offer_accepted``: L-EXIT and the
          wrap-up follow, as after a confirmed stop.  The turn is said to the interviewer.
        * A short no ("No.", "Let's keep going.") gets L-ASIDE-WRAP-RESUME, and the role-play goes
          on in character with the candidate's next turn; a no that goes on to the learner ("No,
          let me tell you about the mentors.") is answered by her.
        * "Sorry?" hears the offer again; a fragment ("Hmm.") or a short yes that has not settled
          yet says nothing and leaves the question open.
        * Anything else is the candidate carrying on with the learner: no is the answer, and the
          learner answers this very turn (None).
        Neither a no nor carrying on changes a grade, a disclosure or the schedule.
        """
        offer = self._wrap_offers[-1]
        trigger = offer["trigger"]
        early = trigger == TRIGGER_EARLY_CLOSE
        declined = declines_wrap_offer(text)
        # M032 S3.3 (review S3R-2, naturalness): the early-close question is either/or ("keep going
        # with her, or ... just say so"), so a bare yes, sure or go-ahead never stops it.
        accepted = not declined and (
            accepts_wrap_offer(text)
            or (confirmed_yes and not early and is_short_wrap_yes(text))
            or end_intent == "end"
            or is_close_attempt(text, r_sec)
        )
        if accepted:
            self._wrap_open = False
            offer["answer"] = "yes"
            offer["answer_transcript_turn"] = turn_index
            self.wrap_accepted = True
            self.exit_requested = True
            reasons = ["wrap_offer_accepted"]
            if early:
                reasons.append("early_close_accepted")
            elif trigger == TRIGGER_ABUSE:
                reasons.append("abuse_hangup_accepted")
            if end_intent == "end" and not accepts_wrap_offer(text):
                reasons.append("end_intent_model")
            return self._plan(TurnMode.EXIT, reasons)
        if declined and word_count(text) <= WRAP_NO_WORDS and not has_question(text):
            self._wrap_closed("no", r_sec, turn_index)
            plan = self._wrap_line_plan(WRAP_RESUME_LINE, ["wrap_offer_declined"])
            if early:
                # M032 S3.3: the role-play resumes and the learner carries on with a real point.
                self._continuation_due = ("resume", None)
                return replace(plan, continuation=True)
            return plan
        if declined:
            # "No, I'd like to continue. What budget did you have in mind?": the no is said and the
            # rest is for the learner, who answers it (no resume line over the advisor's point).
            self._wrap_closed("no", r_sec, turn_index)
            return None
        if repair:
            line_id = str(offer.get("line") or WRAP_OFFER_LINE)
            return self._wrap_line_plan(line_id, ["wrap_offer_repeated"])
        if early and is_bare_yes(text) and self._unclear_offer != len(self._wrap_offers):
            # Review S3R-2 (naturalness): which option the yes meant is unknown, so the choice is
            # put again once per question; after that a bare yes waits like any fragment.
            self._unclear_offer = len(self._wrap_offers)
            line_id = str(offer.get("line") or EARLY_CLOSE_LINE)
            return self._wrap_line_plan(line_id, ["wrap_offer_repeated", "early_close_unclear"])
        if word_count(text) <= END_FRAGMENT_WORDS or is_short_wrap_yes(text):
            return self._wrap_line_plan(None, ["wrap_offer_pending"])
        self._wrap_closed("carried_on", r_sec, turn_index)
        return None

    def wrap_question_lapsed(self, r_sec: float | None = None) -> None:
        """Nobody answered L-ASIDE-WRAP: the silence ladder takes over and the offer is a no."""
        if self._wrap_open:
            self._wrap_closed("no_answer", self.last_r if r_sec is None else r_sec, None)

    # ----------------------------------------------------------------- negotiation
    def _observe_negotiation(self, candidate_text: str, turn: int) -> NegotiationTurn:
        """Let the negotiation read this advisor turn (offers, callbacks, e-mail, check-ins)."""
        anchor = self.scheduler.deliveries_by_id().get(F1_ANCHOR)
        seen = self.negotiation.observe(
            turn,
            candidate_text,
            anchor_turn=None if anchor is None else anchor.turn,
            reader_v2=flag_on(FLAG_OFFER_READER_V2),
            probed=self._price_probe_answer_due(turn),
            read_totals=self._probe_first or self._price_conflict,
            email_v2=flag_on(FLAG_WEAK_EMAIL_V2),
        )
        if seen.price_answer:
            self.scheduler.note_price_answered()
        for offer in seen.offers:
            self._advisor_amounts.add(offer.net_usd)  # the learner may name a price it heard
        # ... and a low figure the anchor reacts to, however it was said ("for 3000 only").
        self._advisor_amounts.update(
            usd for said, usd in self.negotiation.low_mentions if said == turn
        )
        # A price that is not LOWER than the best on the table is no news (R1-Q iteration 3: the
        # $8,000 instalment option, offered after $7,500, was "a little better than I expected").
        self._new_offer_usd = seen.lower_offer_usd
        self._fresh_price = seen.lower_offer_usd is not None
        return seen

    def _note_situation(self, seen: NegotiationTurn) -> None:
        """Worker notes for what this advisor turn did that the learner must not misread.

        Who else decides is always the persona's decision maker (a model answered "it's just me
        deciding" and, two minutes later, "I'd want to talk to my husband first"); the $7,000 is the
        learner's own number until the advisor plainly offers it (a model said "Oh, $7,000, that's
        better than I expected" after raising it itself); and "I can check with my manager" grants
        nothing (the judge flagged the thanks that followed it).
        """
        if seen.decider_asked:
            self._decider_asked_now = True
            self._notes.append(DECIDER_ASKED_NOTE.format(answer=self.persona.decider_answer))
        best = self.negotiation.best_offer_usd
        if seen.anchor_mentioned and (best is None or best > ANCHOR_USD):
            self._notes.append(ANCHOR_NOT_OFFERED_NOTE)
        if seen.tentative:
            self._notes.append(TRY_NOT_GRANTED_NOTE)
            self._nothing_granted = True
        # Where the price stands, whenever it comes up (the live sweep: "that's the number I was
        # hoping for" at $6,000 and, one turn later, "still a stretch for me"; "that's better than
        # before" at an unchanged $7,500).  The anchor and the counter carry the price in their own
        # brief, and the wrap turn names it in the offer note, so they skip these.
        # M032 SWEEP-21 (d): while a price rise is open the price notes would contradict it.
        rise_open = self._price_conflict and self.negotiation.rise_open_turn is not None
        if best is not None and self._price_talk and not rise_open:
            if best <= ANCHOR_USD:
                # M032 SWEEP-2 (salvage): before the anchor she has asked for nothing yet.
                early = self._probe_first and not self.scheduler.is_delivered(F1_ANCHOR)
                note = PRICE_MET_NOTE_EARLY if early else PRICE_MET_NOTE
                if early and flag_on(FLAG_NO_ACCEPT_NOTES):
                    note = PRICE_MET_NOTE_EARLY_V2  # simulation diagnosis 1 (U4 (2))
                self._price_notes.append(note.format(amount=format_usd(best)))
            elif seen.lower_offer_usd is None:
                self._price_notes.append(PRICE_UNCHANGED_NOTE.format(amount=format_usd(best)))
        self._conflict_note = ""
        self._allowed_extra = frozenset()
        conflict = self._turn_conflict
        if conflict is not None:
            # SWEEP-21 (a) and (e): one check, as a question; the figures it names may be said.
            kind, usd, earlier = conflict
            if kind == CONFLICT_RISE and earlier is not None:
                self._conflict_note = PRICE_RISE_NOTE.format(
                    earlier=format_usd(earlier), amount=format_usd(usd)
                )
                self._allowed_extra = frozenset({earlier, usd})
            elif kind == CONFLICT_WEBSITE:
                self._conflict_note = PRICE_CONFLICT_WEBSITE_NOTE.format(amount=format_usd(usd))
                self._allowed_extra = frozenset({9000, usd})

    def _standing_notes(
        self,
        *,
        mode: TurnMode,
        move_id: str | None,
        price_wrap: bool,
        intent: LearnerIntent | None,
        negotiation_id: str | None = None,
        credit_move_id: str | None = None,
        reveal: bool = False,
        winding: bool = False,
    ) -> tuple[str, ...]:
        """Worker notes that hold on every reply of a situation, not only the turn that began it.

        * a proposed call that was not accepted yet stays unaccepted until the close window opens
          (the live sweep: "Since you asked, yes, let's talk tomorrow" two turns after the ask);
        * what the advisor already answered is not asked again (a free reply only);
        * a tracked phrase tic already used ("a stretch", "what would that call involve") is not
          used again;
        * where the price stands, unless the turn carries the price in its own brief.

        M032 S2 adds, each behind its flag: no grading of a turn that did not answer her worry
        (item 5); the next reply after a hinge or a verdict opener is told so (SWEEP-4); the
        not-today stall is F4-PRIMARY's (SWEEP-3); a lone "okay" gets a short reply that keeps her
        question (SWEEP-11); a soft tic leaned on lately is named (SWEEP-12).
        """
        notes: list[str] = []
        if (
            self._pending_ask is not None
            and not (self.negotiation.resolved or self.commitment_resolved)
            and not self.scheduler.commit_permitted(self.last_r)
        ):
            # M032 S3.2: without "keep the conversation going" (R1_CLOSING_STATE).
            notes.append(HOLD_NOTE_V2 if flag_on(FLAG_CLOSING_STATE) else HOLD_NOTE)
        if mode is TurnMode.LLM_REPLY and self._answered:
            labels = dict(ANSWERED_LABELS)
            topics = "; ".join(labels[topic] for topic in self._answered if topic in labels)
            if topics:
                notes.append(ANSWERED_NOTE.format(topics=topics))
        # M032 S1 item 5.  The ledger never contradicts another note of the same reply (review
        # S1R-2): on a price-wrap turn the price notes tell her to say she needs to think, so that
        # theme is left out; and a question put to her directly may get the honest answer again.
        # SWEEP-3: an ask turn is never told to dodge the ask, so neither the not-today theme nor
        # the think-it-over theme is in its ledger note.
        voice_v2 = flag_on(FLAG_LEARNER_VOICE_V2)
        no_commit = flag_on(FLAG_NO_COMMIT_LEDGER)
        ask_turn = self._turn_ask is not None
        skip = {CONCERN_THINK_OVER} if price_wrap else set()
        if no_commit and ask_turn:
            skip |= {CONCERN_NOT_TODAY, CONCERN_THINK_OVER}
        concerns = (
            self._voiced_concerns(skip=frozenset(skip))
            if mode is TurnMode.LLM_REPLY and flag_on(FLAG_CONCERN_LEDGER)
            else ""
        )
        ack_turn = mode is TurnMode.LLM_REPLY and self._ack_turn()
        # M032 SWEEP-27: after her time cue a free reply is short and opens nothing new; the note
        # takes the place of the hollow, the acknowledgement and the ledger notes (merged, never
        # stacked) and is not given on a turn that hands over a disclosure layer.
        short = mode is TurnMode.LLM_REPLY and not reveal and self._short_on_time()
        if winding and mode is TurnMode.LLM_REPLY:
            # M032 S3.2: the advisor is closing the call: one short goodbye (it wins over the
            # time cue's note and the hollow, acknowledgement and ledger notes).
            # Review S3R-6 (naturalness): polite, never warm, while she is cool (COOL_NOTE).
            notes.append(CLOSE_NOTE_COOL if self._cool else CLOSE_NOTE)
        elif short:
            notes.append(
                SHORT_ON_TIME_CONCERNS_NOTE.format(concerns=concerns)
                if concerns
                else SHORT_ON_TIME_NOTE
            )
            self._short_on_time_notes += 1
        elif mode is TurnMode.LLM_REPLY and self._hollow_run >= 1 and self._last_reply_closer:
            # Merged with what she already said, so the two never pull apart.
            notes.append(
                HOLLOW_CONCERNS_NOTE.format(concerns=concerns) if concerns else HOLLOW_NOTE
            )
        elif ack_turn:
            # SWEEP-11: never together with VOICED_CONCERNS_NOTE (its concerns clause is merged in).
            # Simulation diagnosis 1 (L5, R1_ECHO_GUARD): the re-ask is shorter and in other words.
            short = flag_on(FLAG_ECHO_GUARD)
            with_concerns = ACK_TURN_CONCERNS_NOTE_V2 if short else ACK_TURN_CONCERNS_NOTE
            notes.append(
                with_concerns.format(concerns=concerns)
                if concerns
                else (ACK_TURN_NOTE_V2 if short else ACK_TURN_NOTE)
            )
            self._ack_turn_notes += 1
        elif concerns and RESPOND_QUESTION in self._turn_kinds:
            notes.append(VOICED_CONCERNS_ASKED_NOTE.format(concerns=concerns))
        elif concerns:
            notes.append(VOICED_CONCERNS_NOTE.format(concerns=concerns))
        if (
            mode is TurnMode.LLM_REPLY
            and self._decider_said
            and not self._decider_asked_now
        ):
            # L7: said once is said; only a question about who else decides gets it again.
            notes.append(
                DECIDER_SAID_NOTE.format(decision_maker=self.persona.decision_maker)
            )
        if self._final_price_asked(move_id):
            notes.append(FINAL_ASKED_NOTE)  # simulation diagnosis 1 (L3)
        if self._phrases.get(PHRASE_STRETCH, 0) >= 1:
            notes.append(STRETCH_USED_NOTE)
        if self._phrases.get(PHRASE_TEMPLATE_Q, 0) >= 1:
            notes.append(TEMPLATE_USED_NOTE)
        if not price_wrap and move_id not in (F1_ANCHOR, F1_COUNTER):
            notes.extend(self._price_notes)
        commit_line = intent is not None and intent.kind == KIND_COMMIT
        if voice_v2 and not commit_line:
            # Item 5 (anti-validation): her worry was not answered, so she does not call the reply
            # reasonable or good (a lone acknowledgement has its own note).
            # M032 SWEEP-7: the come-back is the one note about what went unanswered.
            unanswered = self._unanswered_worry and not ack_turn and not self._come_back_topic
            if unanswered:
                notes.append(NOT_ANSWERED_NOTE)
            # SWEEP-4: steering only, never both, and never on a confirmation (not called then).
            if self._hinges and self._hinges[-1]:
                notes.append(HINGE_USED_NOTE)
            elif not unanswered and any(self._verdicts[-VERDICT_LOOKBACK:]):
                notes.append(VERDICT_USED_NOTE)
        # Review S2R-1 (naturalness): a question put to her directly that ``detect_ask`` misses ("So
        # what's holding you back from deciding today?") wants the honest answer, like an ask turn.
        direct = RESPOND_QUESTION in self._turn_kinds or asks_her_directly(self._turn_reading)
        if no_commit and not self.scheduler.is_delivered(F4_PRIMARY):
            # SWEEP-3: while F4-PRIMARY is owed, a free reply does not voice the not-today stall
            # (not on an ask turn, a direct question or a check-in, which want a real answer).
            # Never on a continuation of a cut owed line (review S2R-3: it may be F4-PRIMARY's
            # own), nor beside the v1 price-wrap notes that tell her to say she needs to think
            # (review S2R-7: R1_LEARNER_VOICE_V2 rolled back alone).
            if (
                mode is TurnMode.LLM_REPLY
                and not ask_turn
                and not direct
                and not self._force_curiosity
                and credit_move_id is None
                and not (price_wrap and not voice_v2)
            ):
                notes.append(NOT_TODAY_RESERVED_NOTE)
                self._no_commit_notes += 1
        if (
            no_commit
            and mode is TurnMode.INTENT
            and (
                self._concerns.get(CONCERN_NOT_TODAY, 0) >= 1
                or self._stall_themes.get(CONCERN_NOT_TODAY, 0) >= 1
            )
            and move_id != F4_PRIMARY
            and negotiation_id != N_TIMING
            and not commit_line
            and not ask_turn
            and not direct
        ):
            # SWEEP-3: once said, an owed point does not add the stall again.
            notes.append(NO_COMMIT_INTENT_NOTE)
            self._no_commit_notes += 1
        if mode is TurnMode.LLM_REPLY and flag_on(FLAG_TIC_V2):
            words = self._soft_tic_words()
            if words:
                notes.append(SOFT_TIC_NOTE.format(words=words))
        if self._cool and not commit_line:
            notes.append(COOL_NOTE)  # M032 S3.4: after a resumed hang-up she stays cool
        return tuple(notes)

    def _evidence(self, kind: AskKind) -> CommitmentEvidence:
        """The commitment evidence, with the stall reasons the advisor handled added."""
        words = self._word_counts
        thin = len(words) >= THIN_MIN_TURNS and sum(words) / len(words) < THIN_ADVISOR_MEAN_WORDS
        return replace(
            self.tracker.commitment_evidence(kind),
            reasons_handled=self.negotiation.reasons_handled_count,
            thin=thin,
        )

    def _negotiate(
        self,
        seen: NegotiationTurn,
        wants: AskKind | None,
        r_sec: float,
        reasons: list[str],
        *,
        first_probes: tuple[str, ...],
        reveal_topics: tuple[str, ...],
        monologue: float | None,
    ) -> TurnPlan | None:
        """The learner's answer to an ask, a callback, an e-mail offer or a check-in.

        None means "carry on with the normal path" (an owed move, or a free reply), possibly with
        a situation note added for the reminder.  The responses are the table of R1-Q 4.4:

        * a commitment is already on record: never repeat it, react in a free reply;
        * an ask before the close window: the owed F4 move if it can land now (or any forced
          move), else the next unused stall reason, else one question about the call;
        * an ask inside the window: the graded scripted line (STRONG, MEDIUM with the slot),
          or, when the grade is WEAK and a reason is left (at most two rounds), that reason;
          with none left, the scripted WEAK resolution line;
        * an e-mail offer: yes, and what will it include (once); a check-in: an honest reaction
          and one real question, never the stall.
        """
        negotiation = self.negotiation
        layers = {
            "first_probes": first_probes,
            "reveal_topics": reveal_topics,
            "monologue": monologue,
        }
        if wants is not None:
            self._asks.append({"turn": self.turn, "kind": wants.value})
            # A call or enrolment ask is answered with a stall reason, a question or the commitment
            # line, not with a need (R1-Q final review round 1: the H3 deep layer was told in reply
            # to "Would your husband join a short call?").  The layers are not given, so the need
            # stays released and is offered on the next turn that digs for it.
            layers["first_probes"] = ()
            layers["reveal_topics"] = ()
        if negotiation.resolved or self.commitment_resolved:
            if wants is not None or seen.email_offer or seen.checkin:
                reasons.append("commitment_on_record")
                self._notes.append(RESOLVED_NOTE)
            return None
        if wants is not None:
            if not self.scheduler.commit_permitted(r_sec):
                self._pending_ask = wants  # open until the close window (a farewell answers it)
                owed = self.scheduler.select(r_sec)
                # M032 S2P: her price question went unanswered and F1-ANCHOR can be raised now, so
                # the ask gets its probe-first step (the price asked again, or the website's price
                # checked) instead of a money stall about a price nobody named; on the bunching grid
                # that stall's spacing pushed the F1 pair onto the forced path.
                price_unknown = (
                    self._probe_first
                    and owed is not None
                    and owed.id == F1_ANCHOR
                    and self._price_asked_turn is not None
                    and not self._price_named()
                )
                if owed is not None and (owed.forced or owed.family == "F4" or price_unknown):
                    # The owed objection lands in context (the advisor just proposed a next
                    # step), and a deadline is never starved by an advisor who asks every turn.
                    # A forced move that is not the F4 stall is a different topic from the
                    # proposal, so the learner is also told to react to the proposal.
                    reasons.append("ask_yields_to_owed_move")
                    if owed.family != "F4":
                        self._notes.append(NEXT_STEP_PROPOSED_NOTE)
                    elif flag_on(FLAG_NO_ACCEPT_NOTES):
                        # Simulation diagnosis 1 (L7): the F4 point answers the turn, and the
                        # proposal is still not hers to accept before the window.
                        self._notes.append(PROPOSAL_UNANSWERED_NOTE)
                    return None
                if self._price_first_due():
                    # M032 SWEEP-22: she asks the price before she worries about it.  No stall:
                    # no reason voiced, no stall round, no objection for spacing; HOLD_NOTE stays.
                    reasons.append("ask_before_close_window")
                    reasons.append("price_first")
                    self._price_first_turns += 1
                    return self._spec_plan(PRICE_FIRST_SPEC, reasons, **layers)
                self._stalls += 1
                reasons.append("ask_before_close_window")
                return self._reason_plan(reasons, ask=wants, **layers)
            self._pending_ask = None
            evidence = self._evidence(wants)
            level = grade(evidence)
            reasons.append(f"ask_in_window:grade_{level.name.lower()}")
            if evidence.pressured:
                reasons.append("advisor_pressured")  # an invented offer or a coercive deadline
            if evidence.thin:
                reasons.append("advisor_thin")  # answers in a handful of words, all call
            if level is Level.STRONG:
                # The learner's own words come first (R1-Q final review round 1): it said it has
                # a decision maker to consult that the advisor did not answer, it will wait, or it
                # turned a call down.  It books a call at most, and a declined call is no booking.
                blocked = negotiation.strong_blocked(self.turn)
                if blocked is not None:
                    level = Level.MEDIUM
                    reasons.append(f"strong_blocked:{blocked}")
            if level is Level.MEDIUM and negotiation.call_declined():
                # The learner turned a call or a time down in so many words ("I'd rather reach out
                # myself", "I'd rather not lock in a time yet"): it does not book one now.  In the
                # live sweep it booked the call anyway in nine of twenty calls, two minutes after
                # the refusal, and the pushy and terse advisors earned a MEDIUM they had not.
                level = Level.WEAK
                reasons.append("call_declined")
            if level > Level.WEAK:
                return self._commit_plan(level, reasons, ask=wants)
            if negotiation.can_stall(self._stall_skip()):
                negotiation.stall_rounds += 1
                planned = self._reason_plan(reasons, ask=wants, **layers)
                if planned is not None:
                    return planned
            # A stall that answers a CALL ask does not ask for an e-mail nobody offered.
            return self._commit_plan(Level.WEAK, reasons, call=wants is AskKind.CALL, ask=wants)
        if seen.email_offer:
            if negotiation.email_answered or (
                flag_on(FLAG_WEAK_EMAIL_V2) and self._learner_asked_email
            ):
                # SWEEP-25 A3: she asked for it herself and he agreed, so a later offer is not
                # met with a second "yes, send it".
                self._notes.append(EMAIL_AGAIN_NOTE)
            else:
                owed = self.scheduler.select(r_sec)
                if owed is not None and owed.forced:
                    # A deadline is never starved by an e-mail offer: the owed move lands now and
                    # the e-mail is thanked in a few words.
                    reasons.append("email_yields_to_owed_move")
                    self._notes.append(EMAIL_OFFER_NOTE)
                else:
                    reasons.append("email_offer")
                    # The advisor already said what is in it: the learner says yes and asks nothing.
                    spec_id = N_EMAIL_YES if seen.email_listed else N_EMAIL
                    return self._spec_plan(SPEC_BY_ID[spec_id], reasons, **layers)
        if seen.checkin:
            reasons.append("checkin")
            self._force_curiosity = True
        return None

    def _reasons_owned_by_f4(self) -> frozenset[str]:
        """Stall reasons the owed F4 moves still have to voice (timing, the decision maker).

        Voicing one of them early as well is the same stall twice in a row (R1-Q round 1), so
        the negotiation skips them until the F4 move that owns them was delivered.
        """
        owned: set[str] = set()
        if not self.scheduler.is_delivered(F4_PRIMARY):
            owned.add(REASON_TIMING)
        if not self.scheduler.is_delivered(F4_PUSH):
            owned.add(REASON_DECISION_MAKER)
        return frozenset(owned)

    def _stall_skip(self) -> frozenset[str]:
        """Stall reasons the learner does not voice now.

        The F4 pair's own reasons (see above), and the money stall once the price stopped being the
        worry: the $7,000 was met, or the learner called the cost the lesser worry ("The cost is
        still the sticking point for me" after "my worry is more about time than money").
        """
        skip = set(self._reasons_owned_by_f4())
        if self.negotiation.money_is_settled():
            skip.add(REASON_MONEY)
        return frozenset(skip)

    def _reason_plan(
        self, reasons: list[str], *, ask: AskKind | None = None, **layers: Any
    ) -> TurnPlan | None:
        """Voice the next unused stall reason, else the one question about the next step, else None.

        The question is worded for ``ask`` (``question_spec``: "the call" only after a call ask) and
        is used up when it is planned, so a reply that missed its markers does not bring the same
        question back on the next early ask.
        """
        reason = self.negotiation.next_reason(self._stall_skip())
        if reason is not None:
            spec = SPEC_BY_REASON[reason]
        elif not self.negotiation.question_used:
            spec = question_spec(ask, no_commit=flag_on(FLAG_NO_COMMIT_LEDGER))
            self.negotiation.question_used = True
        else:
            return None  # every reason is spent: react in a free reply (the next-step note)
        reasons.append(f"stall_reason:{spec.reason or spec.kind}")
        price_unknown = (
            self._probe_first
            and spec.id == N_MONEY
            and self._price_asked_turn is not None
            and not self._price_named()
            and not self.scheduler.is_delivered(F1_ANCHOR)
        )
        if spec.kind == KIND_STALL and not price_unknown:
            # M032 S2P: the money stall about a price nobody named (SWEEP-22's "still don't know
            # what it costs") leaves F1-ANCHOR's spacing alone: the anchor is its continuation, and
            # on the bunching grid the gap it added pushed the F1 pair onto the forced path.
            self.scheduler.note_objection()
        return self._spec_plan(spec, reasons, **layers)

    def _spec_plan(
        self,
        spec: NegotiationSpec,
        reasons: list[str],
        *,
        first_probes: tuple[str, ...],
        reveal_topics: tuple[str, ...],
        monologue: float | None,
    ) -> TurnPlan:
        """The plan for a negotiation spec the model voices (a reason, a question, e-mail yes).

        M032 SWEEP-3: without the "before you agree to anything" priming (R1_NO_COMMIT_LEDGER).
        """
        if flag_on(FLAG_NO_COMMIT_LEDGER):
            spec = no_commit_spec(spec)
        if self._probe_first and spec.id == N_MONEY:
            # M032 SWEEP-22 item 4: the first money stall is about the price he named, or about
            # not knowing it after her price question went unanswered.
            first = money_spec(
                price_named=self._price_named(),
                price_asked=self._price_asked_turn is not None,
                first=REASON_MONEY not in self.negotiation.voiced,
            )
            if first is not None:
                spec = first
        dm = self.persona.decision_maker
        variants = tuple(fill_decision_maker(text, dm) for text in spec.variants)
        fallbacks = self._fallback_order(spec.id, variants)
        self._intent_uses[spec.id] = self._intent_uses.get(spec.id, 0) + 1
        intent = LearnerIntent(
            kind=spec.kind,
            brief=fill_decision_maker(spec.brief, dm),
            must_say=(),
            markers=filled_markers(spec.markers, dm),
            fallback=fallbacks[0],
            fallbacks=fallbacks,
        )
        self.negotiation.note_response(self.turn, spec.id)
        return self._plan(
            TurnMode.INTENT,
            reasons,
            intent=intent,
            negotiation_id=spec.id,
            first_probes=first_probes,
            reveal_topics=reveal_topics,
            monologue=monologue,
        )

    def _weak_kwargs(self, call: bool = False) -> dict[str, bool]:
        """Which wording of the WEAK line fits the call so far.

        The e-mail was offered or accepted: "I'll read through the email and get back to you", not a
        second request for it.  A call ask and no declined call: "call me back after I've talked to
        my husband".  Otherwise (also after a declined call) the plain "email me the details".
        M032 SWEEP-25 A3 (R1_WEAK_EMAIL_V2): her own request for the e-mail that the advisor agreed
        to counts as e-mailed too.
        """
        negotiation = self.negotiation
        emailed = bool(negotiation.email_offers) or negotiation.email_answered
        if flag_on(FLAG_WEAK_EMAIL_V2) and self._learner_asked_email:
            emailed = True
        return {"emailed": emailed, "call": call and not negotiation.call_declined()}

    def _read_email_agreement(self, text: str, seen: NegotiationTurn, turn: int) -> None:
        """SWEEP-25 A2: the advisor's answer to her own request for the details by e-mail.

        Only the advisor turn right after her request answers it: an e-mail offer, or a short
        agreement with no decline ("Sure, I can do that.") confirms it; anything else (ignored,
        "Let's decide now") leaves the plain WEAK line.
        """
        asked, self._email_request_turn = self._email_request_turn, None
        if asked is None or turn != asked + 1 or not flag_on(FLAG_WEAK_EMAIL_V2):
            return
        if seen.email_offer or agrees_to_send(text):
            self._learner_asked_email = True

    def _weak_text(self, default: str) -> str:
        """The WEAK line of a farewell or the 19:00 stall, in the wording that fits."""
        kwargs = self._weak_kwargs()
        if not kwargs["emailed"]:
            return default
        return commitment_line(Level.WEAK, self.persona.decision_maker, **kwargs)

    def _commit_plan(
        self,
        level: Level,
        reasons: list[str],
        *,
        call: bool = False,
        ask: AskKind | None = None,
    ) -> TurnPlan | None:
        """The scripted commitment line for ``level`` (MEDIUM carries the call slot).

        ``call`` says the WEAK stall answers a call ask: its second sentence then says the learner
        will talk to its decision maker and be called back, not "e-mail me the details".  A MEDIUM
        line books the call without a slot when the advisor named none and the learner had just
        said it must talk to its decision maker first, when the slot is one the learner refused or
        the advisor named long ago, or when the ask was not for a call at all (``ask`` is the
        enrolment ask: the learner does not invent "Thursday at 7 PM" for it).
        """
        negotiation = self.negotiation
        dm = self.persona.decision_maker
        if level is Level.WEAK and negotiation.weak_line_said:
            self._notes.append(RESOLVED_NOTE)  # the WEAK line is said at most once
            return None
        if level is Level.MEDIUM:
            choice = negotiation.slot_choice(self.turn, picks_own=ask is not AskKind.ENROL)
            text = commitment_line(
                level, dm, choice.phrase, moved=choice.moved, deferred=choice.deferred
            )
        elif level is Level.WEAK:
            text = commitment_line(level, dm, **self._weak_kwargs(call))
        else:
            text = commitment_line(level, dm)
        negotiation.note_response(self.turn, f"commit:{level.name.lower()}")
        return self._plan(
            TurnMode.SAY_ONLY,
            reasons,
            scripted=text,
            level=level,
            resolves=True,
        )

    def _commit_stall_plan(
        self,
        move: OwedMove,
        reasons: list[str],
        *,
        first_probes: tuple[str, ...],
        reveal_topics: tuple[str, ...],
        monologue: float | None,
    ) -> TurnPlan | None:
        """The 19:00 stall: one short reaction by the model, then the scripted WEAK line.

        The intent has no markers on purpose: the line is always appended after the reaction
        (``intent_tail``), and the model is told to say nothing about thinking it over, so the
        WEAK wording is spoken exactly once and stays maskable.
        """
        if self.negotiation.weak_line_said:
            self._notes.append(RESOLVED_NOTE)
            return None
        text = self._weak_text(move.text)
        intent = LearnerIntent(
            kind=KIND_COMMIT,
            # M032 SWEEP-25 B: no goodbye and no "I have to go" either (R1_COMMIT_REACTION_V2).
            brief=(
                COMMIT_REACTION_BRIEF_V2
                if flag_on(FLAG_COMMIT_REACTION_V2)
                else COMMIT_REACTION_BRIEF
            ),
            must_say=(),
            markers=(),
            fallback=text,
            fallbacks=(text,),
        )
        self.negotiation.note_response(self.turn, "commit:weak_at_stall")
        return self._plan(
            TurnMode.INTENT,
            reasons,
            scripted=text,
            move_id=move.id,
            level=Level.WEAK,
            resolves=True,
            intent=intent,
            first_probes=first_probes,
            reveal_topics=reveal_topics,
            monologue=monologue,
        )

    # --------------------------------------------------------- M032 S2P: probe first
    def _price_named(self) -> bool:
        """SWEEP-22 item 1: the advisor named a course price AMOUNT (an offer, a stated total, a
        price named in any other frame such as "We charge $9,000" or "It's 9k", review S2P-R2, or a
        low figure); a figure-less "it costs money" is none, and so is "if I give it to you for
        free" (review S2P-R1, naturalness: she still asks what it costs).  Read from the
        negotiation only."""
        negotiation = self.negotiation
        return (
            negotiation.best_offer_usd is not None
            or negotiation.latest_stated_usd() is not None
            or bool(negotiation.low_mentions)
            or negotiation.low_cleared_turn is not None
        )

    def _free_fresh(self) -> bool:
        """The advisor's "free" is the latest price talk and was said this turn or the one before
        (review S2P-R1, naturalness): the anchor never reacts to a hypothetical from minutes ago,
        and a price he stated since (which resets the reading) wins."""
        return (
            self._last_price_kind == IMPLAUSIBLE_FREE
            and self._free_turn is not None
            and self.turn - self._free_turn <= FREE_FRESH_TURNS
        )

    def _time_known(self) -> bool:
        """SWEEP-23: the advisor said how long the course runs or its weekly hours, or she already
        asked the hours (an answer that only says "about two hours" counts)."""
        return (
            bool(self._advisor_months or self._advisor_hours)
            or "weekly_hours" in self._answered
            or "weekly_hours" in self._curiosity_asked
        )

    def _probe_allowed(self, move: OwedMove, r_sec: float) -> bool:
        """S2.10: the probe deadline is the family's deadline less one exchange at the lookahead
        pace, so the reaction to the answer still lands by the family's unchanged deadline.

        The probe also spends a turn the plan must have (``_probe_slack``): on the bunching grid a
        probe at 50-65 s an exchange, with no slack left, pushed the families after it onto the
        forced path.  Without the slack the move itself is due (the check form for F1: "the
        family's deadline forces it").
        """
        deadline = move.deadline_sec
        return (
            not move.forced
            and deadline is not None
            and r_sec + 2 * self.scheduler.lookahead_sec < deadline
            and self._probe_slack(r_sec)
        )

    def _probe_slack(self, r_sec: float) -> bool:
        """One more turn now still lets every owed graded move land by its family's deadline, at
        ``PROBE_TURNS_PER_MOVE`` turns each and the slowest recent pace: S2.10's "probe deadline =
        family deadline minus about one exchange", for the probe's family and the families due
        before it.

        Review S2P-R3: the R 10:00 bound the S1 waits keep (``_s1_slack``) is not applied here.
        D-M032-7 lets her state the website's price unasked only after two dodges or when the
        family's deadline forces it, and that bound switched the probe off from the first turn at
        35 s an exchange or slower (0 F1 and F2 probes in 33 grid runs, the check form asked
        unprompted in 9).  Without it the grid has no newly late or excluded run and no more forced
        moves (``rehearsal/bunching_grid.py --compare-s2p``, ``probe_table``).
        """
        pace = self.scheduler.cautious_lookahead_sec
        owed = 0
        for deadline, move_ids in _PACING_MAP:
            left = sum(1 for move_id in move_ids if not self.scheduler.is_delivered(move_id))
            owed += left
            if left and r_sec + pace * (1 + PROBE_TURNS_PER_MOVE * owed) > deadline:
                return False
        return True

    def _probe_step(self, move: OwedMove, r_sec: float) -> ProbeSpec | None:
        """The probe S2.10 owes before ``move`` now, or None (the move itself is due).

        F1-ANCHOR: while no price was named, before the probe deadline and until two of her price
        questions went unanswered: the price question (a clarifying one after price talk without a
        figure, a second one after a dodge).  F2-PRIMARY: once, while the advisor said nothing about
        the time the course takes and she did not ask the hours.  F4-PRIMARY has no probe (its line
        no longer presumes the cohort).
        """
        if move.id == F1_ANCHOR:
            if (
                self._price_named()
                or self._price_dodges >= MAX_PRICE_DODGES
                or not self._probe_allowed(move, r_sec)
            ):
                return None
            if self._price_talk:
                return PROBE_F1_CLARIFY
            return PROBE_F1_AGAIN if self._price_dodges else PROBE_F1
        if move.id == F2_PRIMARY:
            if self._time_known() or self._probes.get("F2") or not self._probe_allowed(move, r_sec):
                return None
            return PROBE_F2
        return None

    def _probe_plan(
        self,
        probe: ProbeSpec,
        reasons: list[str],
        *,
        first_probes: tuple[str, ...],
        reveal_topics: tuple[str, ...],
        monologue: float | None,
    ) -> TurnPlan:
        """The probe as an intent the model voices; its scripted questions are the fallback.

        No graded move is issued: the owed move stays pending (its deadline, its enabled time and
        its issued count are untouched) and reacts to the advisor's answer on a later turn.
        """
        key = f"probe:{probe.family}"
        fallbacks = self._fallback_order(key, probe.variants)
        self._intent_uses[key] = self._intent_uses.get(key, 0) + 1
        intent = LearnerIntent(
            kind=KIND_PROBE,
            brief=probe.brief,
            must_say=(),
            markers=probe.markers,
            fallback=fallbacks[0],
            fallbacks=fallbacks,
        )
        reasons.append(f"probe:{probe.family}")
        return self._plan(
            TurnMode.INTENT,
            reasons,
            intent=intent,
            probe=probe.family,
            first_probes=first_probes,
            reveal_topics=reveal_topics,
            monologue=monologue,
        )

    def _far_below(self) -> bool:
        """SWEEP-19: the best price is $3,000 or less, or the last price read was low, or free
        and still fresh (``_free_fresh``)."""
        best = self.negotiation.best_offer_usd
        return (
            (best is not None and best <= IMPLAUSIBLE_NET_USD)
            or self._last_price_kind == IMPLAUSIBLE_LOW
            or self._free_fresh()
        )

    def _anchor_situation(self) -> AnchorSituation:
        """F1-ANCHOR under probe first: it reacts to the advisor's own number, read from the
        negotiation only (SWEEP-19 item 4), or checks the website's price when nobody said one.

        A price under the $7,000 not read as an offer: the unclear-low anchor; an offer: the
        above / reached / below anchors; free, said this turn or the one before and not followed by
        a stated price (review S2P-R1, naturalness): what is the catch; a stated price, in any frame
        (review S2P-R2): his number (the website's when that turn named it, review S2P-R4; with the
        one conflict check when it is $300 or more away from the website's); none: the check.
        """
        negotiation = self.negotiation
        best = negotiation.best_offer_usd
        unread = negotiation.unread_low_usd()
        if unread is not None and (best is None or best > ANCHOR_USD):
            return anchor_after_unclear_low(unread)
        if best is not None:
            return anchor_after_offer(
                best, probe_first=True, counter_v2=flag_on(FLAG_COUNTER_V2)
            )
        if self._free_fresh():
            return anchor_after_free()
        stated = negotiation.latest_stated_usd()
        if stated is not None:
            return anchor_after_stated(stated)
        return anchor_check()

    def _probe_first_variants(self, move: OwedMove, variants: tuple[str, ...]) -> tuple[str, ...]:
        """F2-PRIMARY's probe-first line says "a long course", which is for the forced path
        (SWEEP-17 item 7) or a length the advisor said; otherwise (review S2P-R3, naturalness: on a
        turn with no slack for the probe) her packed schedule is said without calling the course
        long."""
        if move.id == F2_PRIMARY and not move.forced and not self._advisor_months:
            return tuple(text for text in variants if " long course" not in text) or variants
        return variants

    def _plan_anchor(self, anchor_id: str) -> None:
        """Remember the F1-ANCHOR form this turn planned, noted when the line is heard."""
        stated = (
            self.negotiation.latest_stated_usd() if anchor_id == ANCHOR_STATED_CONFLICT else None
        )
        self._anchor_planned = (self.turn, anchor_id, stated)

    def _redirect_plan(
        self, move: OwedMove, prefix: str, reasons: list[str], r_sec: float
    ) -> TurnPlan:
        """SWEEP-20: the early-close redirect speaks the probe-first step that is due.

        The redirect is forced by the farewell, not by the family's deadline: that is NOT S2.10's
        "the deadline forces it" exception, so a probe that is still due (no price or time known,
        before the probe deadline) is what she says, and it delivers nothing (the move goes back to
        pending, its deadline unchanged; the farewell still used up the one redirect).  Otherwise
        the redirect speaks the move's probe-first form: the anchor that reacts to the advisor's
        number or checks the website's, F2's and F4's lines without a course fact, and with
        R1_COUNTER_V2 the counter that fits the number on the table.
        """
        probe = self._probe_step(replace(move, forced=False), r_sec)
        if probe is not None:
            self.scheduler.return_to_pending(move.id)
            self._turn_issued = None
            line_id = REDIRECT_TIME_LINE if probe.family == "F2" else REDIRECT_PRICE_LINE
            reasons.append(f"redirect_probe:{probe.family}")
            self._redirect_probes += 1
            return self._plan(
                TurnMode.SAY_ONLY, reasons, scripted=script_line(line_id), probe=probe.family
            )
        text = move.text
        if move.id == F1_ANCHOR:
            anchor = self._anchor_situation()
            text = self._fallback_order(move.id, anchor.variants)[0]
            self._intent_uses[move.id] = self._intent_uses.get(move.id, 0) + 1
            self.negotiation.note_response(self.turn, f"anchor:{anchor.id}")
            self._plan_anchor(anchor.id)
        elif move.id in (F2_PRIMARY, F4_PRIMARY):
            texts = probe_first_texts(move.id)
            if texts is not None:
                text = self._probe_first_variants(replace(move, forced=False), texts[3])[0]
        elif move.id == F1_COUNTER and flag_on(FLAG_COUNTER_V2):
            situation = self.negotiation.counter_situation(
                counter_v2=True,
                far_below=self._far_below(),
                asked_once=flag_on(FLAG_PRICE_ASKED_ONCE),
            )
            text = self._fallback_order(move.id, situation.variants)[0]
            self.negotiation.note_response(self.turn, f"counter:{situation.id}")
        return self._plan(TurnMode.SAY_ONLY, reasons, scripted=f"{prefix} {text}", move_id=move.id)

    def _guard_extras(self, must_say: tuple[str, ...]) -> tuple[frozenset[int], frozenset[float]]:
        """SWEEP-17 item 4: the amounts and course lengths this reply may say beyond the card.

        The figures the plan owes (its must-say: the check or conflict path), the figures she
        already said on such a path (they stay allowed for the session), this turn's conflict
        figures (SWEEP-21: the website's $9,000 and the earlier offer), and the course lengths the
        advisor said.
        """
        owed = " ".join(must_say)
        amounts = set(dollar_amounts(canonical_amounts(owed))) | self._figures_said
        amounts |= self._allowed_extra
        months = set(durations_said(owed)) | self._durations_said | self._advisor_months
        return frozenset(amounts), frozenset(months)

    def _price_first_due(self) -> bool:
        """SWEEP-22 item 3: an early ask that would get the money stall gets N-PRICE-FIRST while no
        price was named, she has not asked it, and F1-ANCHOR is still owed."""
        return (
            self._probe_first
            and not self._price_named()
            and self._price_asked_turn is None
            and not self.scheduler.is_delivered(F1_ANCHOR)
            and self.negotiation.next_reason(self._stall_skip()) == REASON_MONEY
        )

    def _challenge_note(self) -> str:
        """CHALLENGE_NOTE, or with probe first FIGURE_CHALLENGE_NOTE when her last heard line held
        a figure the advisor never said (SWEEP-17 item 6)."""
        if self._probe_first and self._last_line_unsaid_figure:
            self._figure_challenges += 1
            return FIGURE_CHALLENGE_NOTE
        return CHALLENGE_NOTE

    def _price_reflex_note(self, reading: str) -> str:
        """SWEEP-22 item 5: the cost or her budget came up with no figure and nobody told her the
        price: after reacting she asks what the course costs (at most twice a call)."""
        if (
            self._price_reflexes >= PRICE_REFLEX_LIMIT
            or self._price_named()
            or self._price_asked_turn is not None
            or self.scheduler.is_delivered(F1_ANCHOR)
            or self.commitment_resolved
            or self.last_r >= TIME_CUE_SEC
            or not self._question_budget()
        ):
            return ""
        cue = price_cue(reading)
        if cue is None:
            return ""
        self._price_reflexes += 1
        if cue == PRICE_CUE_BUDGET:
            return PRICE_REFLEX_BUDGET_NOTE
        example = pick_variant(PRICE_REFLEX_EXAMPLES, f"{self.seed}:reflex", self._price_reflexes)
        return PRICE_REFLEX_NOTE.format(example=example)

    def _unsaid_figure_in(self, spoken: str) -> bool:
        """SWEEP-17 item 6: her line holds a figure the advisor never said (not her own $7,000,
        her budget or her salary): an amount, or a course length."""
        # The website's price she checked on an allowed path is "something I saw", not a mix-up.
        own = {ANCHOR_USD, 500, 700, *self.persona.card_amounts, *self._figures_said}
        amounts = set(dollar_amounts(canonical_amounts(spoken)))
        if any(amount not in self._advisor_amounts and amount not in own for amount in amounts):
            return True
        return course_length_unsaid(
            spoken, frozenset(self._advisor_months), persona=self.persona
        )

    # ------------------------------------------------------------------- intents
    def _fallback_order(
        self, key: str, variants: tuple[str, ...], openers: tuple[str, ...] = ()
    ) -> tuple[str, ...]:
        """The scripted variants in the order to try them: seeded rotation, fresh ones first.

        The start of the rotation comes from the attempt id and the move (so two sessions do
        not open with the same variant), and each time the move is handed to the model the
        rotation moves on.  A variant whose sentences the learner already said is tried last.
        ``openers`` (the early-farewell redirect) are paired with the variants one for one.
        """
        count = self._intent_uses.get(key, 0)
        seed = f"{self.seed}:{key}"
        ordered: list[str] = []
        for step in range(len(variants)):
            text = pick_variant(variants, seed, count + step)
            if openers:
                text = f"{pick_variant(openers, seed, count + step)} {text}"
            ordered.append(text)
        said = self._spoken.snapshot()
        fresh = [text for text in ordered if not _repeats(text, said)]
        return tuple(fresh + [text for text in ordered if text not in fresh])

    def _intent_plan(
        self,
        move: OwedMove,
        reasons: list[str],
        *,
        redirect: bool,
        first_probes: tuple[str, ...],
        reveal_topics: tuple[str, ...],
        monologue: float | None,
        last_point: bool = False,
    ) -> TurnPlan:
        """The plan for an owed move the model voices (the move is already issued).

        M032 SWEEP-24: ``last_point`` (after L-ASIDE-LAST-POINT) raises it with
        ``LAST_POINT_BRIEF`` in place of the redirect's and with no "Oh wait" opener.

        The price counter depends on how the advisor answered the anchor (R1-Q): push for a bit
        more after a concession short of the ask, "is there nothing at all?" after a refusal,
        "so what is the final price?" when the answer was unclear.

        M032 S2P (probe first, the session's latched R1_PROBE_FIRST): F2-PRIMARY and F4-PRIMARY
        are worded without a course fact, and F1-ANCHOR reacts to the advisor's own number or
        checks the website's price (``_anchor_situation``); R1_COUNTER_V2 (SWEEP-19) words the
        counter for the number on the table and R1_PRICE_CONFLICT (SWEEP-21) asks about a conflict.
        Markers are unchanged on every path.
        """
        if self._probe_first:
            texts = probe_first_texts(move.id)
            if texts is not None:
                brief, _worry, _line, variants = texts
                variants = self._probe_first_variants(move, variants)
                move = replace(move, brief=brief, must_say=(), text=variants[0], variants=variants)
        if move.id == F1_COUNTER:
            counter_v2 = flag_on(FLAG_COUNTER_V2)
            situation = self.negotiation.counter_situation(
                counter_v2=counter_v2,
                far_below=counter_v2 and self._far_below(),
                asked_once=flag_on(FLAG_PRICE_ASKED_ONCE),
            )
            conflict = self._turn_conflict
            if conflict is not None:
                situation = conflict_counter(conflict[0], conflict[1], conflict[2])
            brief = situation.brief
            if self._asks_number_now and situation.id in (SITUATION_SHORT, SITUATION_UNCLEAR):
                brief += YOUR_NUMBER_COUNTER_SUFFIX  # SWEEP-19 item 6
            best = self.negotiation.best_offer_usd
            if best is not None:
                # What is actually on the table, so the reaction names the real number (and never
                # calls the same price better than before).
                brief += f"; the advisor's best price so far is {format_usd(best)}"
            move = replace(move, brief=brief, variants=situation.variants)
            self.negotiation.note_response(self.turn, f"counter:{situation.id}")
        elif move.id == F1_ANCHOR and self._probe_first:
            # S2.10 and SWEEP-19 item 4: the anchor reacts to the advisor's number (from the
            # negotiation only) or, nobody having said one, checks the website's price; it keeps
            # its $7,000 marker and must-say and its request on every path.
            anchor = self._anchor_situation()
            move = replace(
                move, brief=anchor.brief, must_say=anchor.must_say, variants=anchor.variants
            )
            self.negotiation.note_response(self.turn, f"anchor:{anchor.id}")
            self._plan_anchor(anchor.id)
        elif move.id == F1_ANCHOR and (
            self.negotiation.best_offer_usd is not None
            or self.negotiation.unread_low_usd() is not None
        ):
            # A price is already on the table (the advisor offered before the learner asked):
            # the anchor keeps its exact $9,000 / $7,000 but reacts to that number.  A figure under
            # the $7,000 that was not read as an offer is never answered by asking for more (owner
            # test 8f5bfefc): the learner asks what the total would be.
            best = self.negotiation.best_offer_usd
            unread = self.negotiation.unread_low_usd()
            if unread is not None and (best is None or best > ANCHOR_USD):
                anchor = anchor_after_unclear_low(unread)
            else:
                anchor = anchor_after_offer(best)
            move = replace(
                move, brief=anchor.brief, must_say=anchor.must_say, variants=anchor.variants
            )
            self.negotiation.note_response(self.turn, f"anchor:{anchor.id}")
        elif move.id == F4_PUSH:
            if self._decider_said:
                # L7: she already said she would talk to her decision maker: the push refers back
                # to it ("Like I said, ...") instead of saying it again as news.
                suffix, said_variants = f4_push_said(self.persona.decision_maker)
                move = replace(move, brief=move.brief + suffix, variants=said_variants)
            if self._call_ask_now:
                # The advisor just proposed a call: "I'd need to talk to my father" must not turn
                # into "he's not really one for these things", and the call stays welcome.
                move = replace(move, brief=move.brief + F4_PUSH_CALL_SUFFIX)
        elif move.id == TIME_CUE:
            # Three wordings of the cue, one per attempt ("before my own next call": 8 of 20).
            # M032 SWEEP-27: the first is neutral for a learner at home (R1_TIME_CUE_V2).
            first = TIME_CUE_BRIEF_V2 if flag_on(FLAG_TIME_CUE_V2) else move.brief
            briefs = (first, *TIME_CUE_BRIEF_ALTERNATIVES)
            move = replace(move, brief=pick_variant(briefs, self.seed, 0))
        elif (
            move.id == F4_PRIMARY
            and self._timing_said_turn is not None
            and flag_on(FLAG_NO_COMMIT_LEDGER)
        ):
            # SWEEP-3: she already said she is not deciding today in a line of her own, so the owed
            # primary refers back to it; markers and must-say unchanged.
            move = replace(
                move,
                brief=move.brief + F4_PRIMARY_SAID_SUFFIX,
                variants=F4_PRIMARY_SAID_VARIANTS,
            )
        worry = False
        statements: tuple[str, ...] = ()
        spec = MOVE_SPEC_BY_ID.get(move.id)
        if spec is not None and spec.worry and flag_on(FLAG_LEARNER_VOICE_V2):
            # M032 S2 items 3 and 4: the worry as an objective, raised in light of what the advisor
            # already said about its topic; statement fallbacks first, then the question ones.
            # Review S2R-5: this turn's own words count (F3-PRIMARY fires when its topic is fresh),
            # the label names what was said, and never while she must say a figure he did not.
            brief = spec.worry
            if self._probe_first and move.id == F2_PRIMARY:
                brief = F2_PRIMARY_WORRY_V2  # S2.10: no "a course this long" she was never told
            label = self._preempted_label(spec.family) if spec.role == "primary" else ""
            if label and all(figure in self._advisor_figures for figure in move.must_say):
                brief += PREEMPTED_SUFFIX.format(label=label)
            move = replace(move, brief=brief)
            worry = True
            statements = spec.worry_variants
        variants = move.variants or (move.text,)
        if move.id == TIME_CUE:
            # The scripted cue never puts the learner on another call when a variant without it
            # exists ("before my next call" was said by a learner who had just got home).
            neutral = tuple(
                text for text in variants if "next call" not in text and "another call" not in text
            )
            variants = neutral or variants
        fallbacks = self._fallback_order(
            move.id, variants, REDIRECT_OPENERS if redirect else ()
        )
        if statements and not redirect:
            first = self._fallback_order(move.id, statements)
            said = self._spoken.snapshot()
            ordered = (*first, *fallbacks)
            fresh = tuple(text for text in ordered if not _repeats(text, said))
            fallbacks = fresh + tuple(text for text in ordered if text not in fresh)
        self._intent_uses[move.id] = self._intent_uses.get(move.id, 0) + 1
        brief = f"{REDIRECT_BRIEF} {move.brief}" if redirect else move.brief
        if last_point:
            brief = f"{LAST_POINT_BRIEF} {move.brief}"
        kind = KIND_REDIRECT if redirect else (KIND_CUE if move.id == TIME_CUE else KIND_OBJECTION)
        intent = LearnerIntent(
            kind=kind,
            brief=brief,
            must_say=move.must_say,
            markers=move.markers,
            fallback=fallbacks[0],
            fallbacks=fallbacks,
            forced=move.forced and not redirect,
            worry=worry and not redirect,
        )
        return self._plan(
            TurnMode.INTENT,
            reasons,
            move_id=move.id,
            intent=intent,
            first_probes=first_probes,
            reveal_topics=reveal_topics,
            monologue=monologue,
        )

    def intent_tail(self, plan: TurnPlan, spoken_so_far: str) -> str:
        """The scripted variant to append after an intent reply, or "" if it already delivered.

        ``spoken_so_far`` is what the guard let through of the model's reply.  If it proves
        the move (the markers hit) nothing is appended.  Otherwise the first variant that does
        not repeat something the learner already said, in this call or in this very reply,
        is returned (the repetition check; the first one if every variant repeats), so the
        owed move is never lost to the model and is never said twice word for word.  A reply
        that already asked a question gets no second negotiation question: when no variant
        proves a negotiation line without its question, nothing is appended (an owed move, the
        farewell redirect and the WEAK line are always appended).
        """
        intent = plan.intent
        if intent is None or markers_match(intent.markers, spoken_so_far):
            return ""
        if intent.kind == KIND_COMMIT and fuzzy_contains(spoken_so_far, plan.scripted_text):
            return ""  # the model already said the closing line: it is never said twice
        said = self._spoken.snapshot() + tuple(
            normalize(sentence) for sentence in split_sentences(spoken_so_far)
        )
        candidates = intent.fallbacks or (intent.fallback,)
        if "?" in spoken_so_far:
            # The model already asked something in this reply: a second question in the scripted
            # tail is the same question twice in other words ("... what would I actually end up
            # paying? Sorry, so what's the final number you can do for me?").  A statement that
            # proves the move goes first, then the tail without its question if that still proves
            # it.
            quiet = [text for text in candidates if "?" not in text]
            stripped = [_without_questions(text) for text in candidates if "?" in text]
            stripped = [text for text in stripped if text and markers_match(intent.markers, text)]
            if (
                intent.markers
                and plan.move_id is None
                and (plan.negotiation_id is not None or plan.probe is not None)
            ):
                # M032 S2P: a probe is a question too, so it is never asked as a second one.
                # When no variant proves a negotiation line without a question, nothing is appended
                # (owner test 7f2a25e6 turn 32: "What exactly would I be getting for it? What
                # exactly would that call involve?"); the stall reason stays unused.  A graded owed
                # move, the farewell redirect and the marker-less WEAK line always keep their tail:
                # an owed move dropped here was often held until its deadline forced it, which
                # bunched primaries and pushes there and slipped a family (reviewed fix).
                proven = [text for text in quiet if markers_match(intent.markers, text)]
                proven += stripped
                if not proven:
                    return ""
                candidates = tuple(proven)
            else:
                candidates = (*quiet, *stripped, *candidates)
        chosen = next((text for text in candidates if not _repeats(text, said)), candidates[0])
        opener = _first_word(spoken_so_far)
        if self._markers_v2 and opener in _TAIL_OPENERS and _first_word(chosen) == opener:
            # Simulation diagnosis 1 (U2): "Wait, $1,000? ... Wait, that's far lower than I
            # expected." A tail never opens with the interjection her reply opened with.  Review:
            # a reply that already asked keeps to the question-free options (no second question
            # comes back through this rule); with none left the first choice stands.
            pool = (
                tuple(text for text in candidates if "?" not in text)
                if "?" in spoken_so_far
                else candidates
            )
            chosen = next(
                (
                    text
                    for text in pool
                    if _first_word(text) != opener and not _repeats(text, said)
                ),
                chosen,
            )
        key = plan.move_id or plan.negotiation_id or (
            f"probe:{plan.probe}" if plan.probe is not None else None
        )
        if key is not None:
            self._intent_fallbacks[key] = self._intent_fallbacks.get(key, 0) + 1
        # M032 S2 item 8 (counts only): how often a scripted tail was bolted on, and how often the
        # model's own text had already asked a question when it was.
        self._tails_appended += 1
        if "?" in spoken_so_far:
            self._tails_after_question += 1
        return chosen

    # ------------------------------------------------------------------- curiosity
    def _note_curiosity_covered(self, advisor_text: str) -> None:
        """A topic the advisor already answered is not asked about."""
        for topic, _label in CURIOSITY_TOPICS:
            if topic not in self._curiosity_asked and curiosity_covered(topic, advisor_text):
                self._curiosity_asked.add(topic)

    @property
    def _decider_said(self) -> bool:
        """L7: the learner already said she would talk to her decision maker."""
        return self._decider_said_turn is not None or self.negotiation.decider_said_turn is not None

    def _note_monthly_quote(self, advisor_text: str, turn: int) -> None:
        """L5: a monthly payment the advisor named; above the card's budget she says so."""
        figures = monthly_amounts(advisor_text)
        if not figures:
            return
        self._monthly_quote_usd = min(figures)
        self._monthly_quote_turn = turn
        if self._monthly_quote_usd > MONTHLY_BUDGET_MAX_USD:
            self._notes.append(BUDGET_OVER_NOTE.format(amount=format_usd(self._monthly_quote_usd)))

    def _short_on_time(self) -> bool:
        """M032 SWEEP-27 (R1_TIME_CUE_V2): she has said her time cue, so she opens nothing new.

        Keyed on the cue's delivery, never on R: the cue may come late or not at all.
        """
        return flag_on(FLAG_TIME_CUE_V2) and self.scheduler.is_delivered(TIME_CUE)

    def _question_budget(self) -> bool:
        """The learner may ask a question now: none of its last replies held one.

        The guard drops the question of a free reply otherwise (``QUESTION_DIET_WINDOW``), so a
        curiosity topic handed over then would be wasted and marked as asked.
        """
        return not any(self._asked[-QUESTION_DIET_WINDOW:])

    def _curiosity_for_free_reply(self, *, force: bool = False, skip: bool = False) -> str:
        """One unasked question topic every ``CURIOSITY_EVERY`` free replies, else "".

        These are the neutral questions that used to be scheduled (live or recorded, what
        would I build) plus more; the model is only told what it is curious about and
        may ask in its own words, so nothing is owed and nothing is graded.  ``force`` (the
        advisor checked in) ignores the cadence, never the question budget.

        L1: handing a topic over does not use it up; her spoken question does (``record_spoken``,
        ``curiosity_asked_in``), whether the topic was handed over or she asked on her own.  The
        topic handed over least often comes next (in the attempt's seeded order), and one handed
        over ``CURIOSITY_OFFER_LIMIT`` times without being asked is not handed over again.

        M032: ``skip`` (SWEEP-12, a turn that put a new price or offer on the table) counts the free
        reply but hands nothing over.  With R1_TIC_V2 the label is a rotated noun phrase
        (``CURIOSITY_LABELS_V2``), and with R1_OFFER_REALISM "payment" waits while the latest price
        the advisor named is under $1,000 (SWEEP-13).
        """
        self._free_replies += 1
        if skip or not self._question_budget() or self._short_on_time():
            # M032 SWEEP-27: after her time cue she opens no new question, check-in or not.
            return ""
        if not force and self._free_replies - self._free_at_last_curiosity < CURIOSITY_EVERY:
            return ""
        ids = tuple(topic for topic, _label in CURIOSITY_TOPICS)
        labels = dict(CURIOSITY_TOPICS)
        order = [pick_variant(ids, self.seed, step) for step in range(len(ids))]
        cheap = (
            flag_on(FLAG_OFFER_REALISM)
            and self._latest_price_usd is not None
            and self._latest_price_usd < CHEAP_PRICE_USD
        )
        open_topics = [
            topic
            for topic in dict.fromkeys(order)
            if topic not in self._curiosity_asked
            and self._curiosity_offered.get(topic, 0) < CURIOSITY_OFFER_LIMIT
            and not (cheap and topic == "payment")
        ]
        if not open_topics:
            return ""
        topic = min(open_topics, key=lambda item: self._curiosity_offered.get(item, 0))
        offered = self._curiosity_offered.get(topic, 0)
        self._curiosity_offered[topic] = offered + 1
        self._free_at_last_curiosity = self._free_replies
        if flag_on(FLAG_TIC_V2):
            return pick_variant(CURIOSITY_LABELS_V2[topic], f"{self.seed}:{topic}", offered)
        return labels[topic]

    # ------------------------------------------------------------------ the plan
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
        reveal_topics: tuple[str, ...] = (),
        monologue: float | None = None,
        voice: str = "learner",
        aside: bool = False,
        intent: LearnerIntent | None = None,
        curiosity: str = "",
        negotiation_id: str | None = None,
        line_id: str | None = None,
        credit_move_id: str | None = None,
        probe: str | None = None,
        winding: bool = False,
    ) -> TurnPlan:
        reminder: str | None = None
        kind = None if aside else self._break_kind
        price_wrap = self.scheduler.price_wrap_turn == self.scheduler.turn
        if mode in (TurnMode.INTENT, TurnMode.LLM_REPLY):
            # After a MEDIUM or STRONG commitment a free reply only confirms it: no new doubt,
            # no probe answered, no curiosity (in the smoke test the learner answered the
            # advisor's confirmation with "hold on, what would that call involve?").
            confirm = mode is TurnMode.LLM_REPLY and self._confirming()
            if confirm:
                first_probes = ()
                reveal_topics = ()
                curiosity = ""
            elif reveal_topics:
                # One layer of disclosure per reply, the deep need first: a reply that is handed a
                # deep need about one topic and a hint about another voices only one of them (the
                # live sweep: the hint answered and the deep need of the other topic was never
                # told).  The hint topic is probed again later or not at all; its deep need stays
                # locked.
                first_probes = tuple(topic for topic in first_probes if topic in reveal_topics)
            # One opening style per free reply, rotated (an intent opens with its own reaction).
            # M032 S2 item 2: with R1_LEARNER_VOICE_V2 an intent gets one too, from the notes that
            # fit an owed point (``INTENT_OPENER_NOTES``), never the 19:00 stall's reaction.
            voice_v2 = flag_on(FLAG_LEARNER_VOICE_V2)
            reaction_only = intent is not None and intent.kind == KIND_COMMIT
            # SWEEP-11: a lone "okay" or "hmm" (read before the standing notes count it).
            ack = mode is TurnMode.LLM_REPLY and not confirm and self._ack_turn()
            notes = tuple(
                note for note in self._notes if intent is None or note not in _FREE_REPLY_NOTES
            )
            if not confirm:
                notes += self._standing_notes(
                    mode=mode,
                    move_id=move_id,
                    price_wrap=price_wrap,
                    intent=intent,
                    negotiation_id=negotiation_id,
                    credit_move_id=credit_move_id,
                    reveal=bool(first_probes) or bool(reveal_topics),
                    winding=winding,
                )
            if mode is TurnMode.LLM_REPLY:
                style_note = pick_variant(
                    STYLE_NOTES_V2 if voice_v2 else STYLE_NOTES, self.seed, self.turn
                )
                if (
                    voice_v2
                    and style_note == STYLE_NOTES_V2[1]
                    and any(note in notes for note in _OPENER_STEERING_NOTES)
                ):
                    # Review S2R-8: "start with a word or two of acknowledgement" never sits with
                    # a note that tells her not to open with a quick reaction or a verdict.
                    style_note = pick_variant(INTENT_OPENER_NOTES, self.seed, self.turn)
            elif voice_v2 and intent is not None and not reaction_only:
                style_note = pick_variant(INTENT_OPENER_NOTES, self.seed, self.turn)
            else:
                style_note = ""
            # SWEEP-5 and SWEEP-13: what came with an offer, on a reply the model voices.
            if self._probe_first and move_id == F1_ANCHOR:
                # Review S2P-R6 (naturalness): the anchor's own brief reacts to the price on the
                # table ("below the $7,000 you heard ... no surprise"); SWEEP-13's careful-buyer
                # note would contradict it on the same turn (the far-below counter is wary later).
                self._implausible_note = ""
            implausible = bool(self._implausible_note) and not confirm and not reaction_only
            if not confirm and not reaction_only:
                notes += self._offer_extra_notes()
            # M032 SWEEP-21 (a): a free reply checks a price conflict once; its note replaces the
            # new-offer note of the turn (one price note per turn).
            conflict_note = (
                self._conflict_note if mode is TurnMode.LLM_REPLY and not confirm else ""
            )
            if conflict_note:
                notes += (conflict_note,)
            intent_join = ""
            if voice_v2 and intent is not None:
                if move_id in (F1_ANCHOR, F1_COUNTER):
                    intent_join = "price"
                elif negotiation_id is not None:
                    intent_join = "topic_fresh"  # it answers the advisor's own ask or offer
                elif probe is not None:
                    # M032 S2P: the probe grows out of what he said when its topic came up.
                    fresh = self.scheduler._topic_fresh(probe)
                    intent_join = "topic_fresh" if fresh else "new_topic"
                else:
                    spec = MOVE_SPEC_BY_ID.get(move_id or "")
                    family = None if spec is None else spec.family
                    fresh = self.scheduler._topic_fresh(family)
                    intent_join = "topic_fresh" if fresh else "new_topic"
            # Review S2R-2 (naturalness): a turn that hands over a disclosure layer has its own
            # length in the hint or reveal note ("one short sentence, going only this far").
            length_note = (
                self._length_note()
                if mode is TurnMode.LLM_REPLY
                and not confirm
                and "free_reply" in reasons
                and flag_on(FLAG_REPLY_LENGTH)
                and not first_probes
                and not reveal_topics
                else ""
            )
            # The layers are handed over only here, on the turn that asked about the topic.
            self.tracker.gate.mark_hint_offered(first_probes)
            self.tracker.gate.mark_deep_offered(reveal_topics)
            self._turn_layers = (self.turn, tuple(first_probes), tuple(reveal_topics))
            # M032 S1 item 2: an intent on a turn that put a question to her answers it first.
            answering = self._dig_now or (
                intent is not None
                and RESPOND_QUESTION in self._turn_kinds
                and flag_on(FLAG_RESPOND_FIRST)
            )
            # M032 SWEEP-10: after the coach aside a role reversal gets the role note, never the
            # AI or test note (an AI or test break keeps CHARACTER_BREAK_NOTE).
            role_note = ""
            if self._role_confused and kind == "coach" and not confirm:
                role_note = ROLE_CONFUSION_NOTE.format(
                    example=pick_variant(
                        ROLE_CONFUSION_EXAMPLES, self.seed, self._role_confusion_turns
                    )
                )
                self._role_confusion_turns += 1
            reminder = turn_reminder(
                self.persona,
                r_sec=self.last_r,
                first_probe_topics=first_probes,
                unlocked_topics=reveal_topics,
                monologue_sec=monologue,
                character_break=kind is not None,
                role_confusion=role_note,
                come_back=bool(self._come_back_topic) and mode is TurnMode.LLM_REPLY,
                # Review S7L-R3: her own number is this reply's one price note; "do not push on
                # price again" would contradict "answer with your figure" on the same turn.
                price_wrap=price_wrap and "your_number" not in reasons,
                intent_brief="" if intent is None else intent.brief,
                must_say=() if intent is None else intent.must_say,
                intent_forced=False if intent is None else intent.forced,
                curiosity=curiosity,
                offer_usd=self._offer_on_table(),
                # The anchor already reacts to the price on the table: no "pleasant surprise"; and
                # a careful-buyer note (SWEEP-13) or a conflict note (SWEEP-21) replaces the
                # new-offer note on its turn.
                new_offer_usd=(
                    None
                    if move_id == F1_ANCHOR
                    or implausible
                    or conflict_note
                    or (move_id == F1_COUNTER and self._turn_conflict is not None)
                    else self._new_offer_usd
                ),
                notes=notes,
                reaction_only=reaction_only,
                style_note=style_note,
                confirm=confirm,
                answering=answering,
                intent_shape=pick_variant((0, 1), self.seed, self.turn),
                voice_v2=voice_v2,
                intent_join=intent_join,
                intent_worry=(
                    intent.brief if voice_v2 and intent is not None and intent.worry else ""
                ),
                length_note=length_note,
                # Review S2R-9: on a lone "okay" the handed-over topic IS the question to ask, so
                # never "otherwise leave it for later".
                curiosity_v2=flag_on(FLAG_TIC_V2) and not ack,
                # Review S3R-6 (naturalness): a goodbye's reminder asks for no question.
                winding=winding and mode is TurnMode.LLM_REPLY,
            )
            ctx = self.guard_context(
                mode="reply",
                reminder=reminder,
                quiet_empty=mode is TurnMode.INTENT,
                released=reveal_topics,
                confirm=confirm,
                free_reply=mode is TurnMode.LLM_REPLY and not confirm,
                carries_move=move_id is not None or credit_move_id is not None,
                # Review S2R-4: ACK_TURN_NOTE asks her to ask her last question again.
                reask=self._last_questions if ack and self._learner_asked_last() else (),
                must_say=() if intent is None else intent.must_say,
                # M032 SWEEP-25 B: the 19:00 reaction says no goodbye and asks for no e-mail.
                reaction_only=reaction_only and flag_on(FLAG_COMMIT_REACTION_V2),
                # M032 S3.2: one short goodbye passes the guard (no closer_again drop, and the
                # stall-closer quota is lifted for this one reply).
                winding=winding,
                closing_exempt=winding,
                # M032 SWEEP-7: her come-back question passes the diet and the near-repeat drop.
                reask_topic=self._come_back_topic if mode is TurnMode.LLM_REPLY else "",
            )
        else:
            implausible = False
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
            guard_ctx=ctx,
            voice=voice,
            aside=aside,
            character_break=kind,
            intent=intent,
            negotiation_id=negotiation_id,
            line_id=line_id,
            credit_move_id=credit_move_id,
            offer_realism=self._offer_realism,
            implausible=implausible,
            probe_first=self._probe_first,
            price_check=self._price_conflict,
            probe=probe,
            timeline_v2=self._timeline_v2,
        )

    # ---------------------------------------------------------------------- speech
    def compose_speech(self, plan: TurnPlan, model_raw: str = "") -> Speech:
        """The text to say for a SAY_ONLY or INTENT plan, for callers that do not stream.

        An INTENT plan's ``model_raw`` is guarded like a streamed reply; when it does not
        prove the move, the scripted variant follows it (``intent_tail``).  An empty or failed
        model call therefore yields the scripted variant alone, so an owed move is never lost.
        """
        if plan.mode is TurnMode.EXIT:
            return Speech("", "", "", None, plan.voice)  # nothing is said on an exit
        if plan.mode is TurnMode.SAY_ONLY:
            return Speech(plan.scripted_text, "", plan.scripted_text, None, plan.voice)
        if plan.mode is not TurnMode.INTENT:
            raise ValueError("an LLM_REPLY plan is streamed through stream_guard")
        model_text = ""
        result: GuardResult | None = None
        if model_raw.strip():
            result = guard_text(model_raw, plan.guard_ctx)
            self.record_guard(result)
            model_text = result.text
        tail = self.intent_tail(plan, model_text)
        text = f"{model_text} {tail}".strip()
        return Speech(text, model_text, tail, result, plan.voice)

    def stream_guard(self, plan: TurnPlan) -> StreamGuard:
        """A per-reply sentence guard; pass its ``result`` to ``record_guard`` afterwards."""
        return StreamGuard(plan.guard_ctx)

    def sanitize_reply(self, plan: TurnPlan, raw: str) -> GuardResult:
        """Guard a whole LLM reply at once and count its hits."""
        result = guard_text(raw, plan.guard_ctx)
        self.record_guard(result)
        return result

    def record_guard(self, result: GuardResult) -> None:
        self.ledger.record(result)
        if result.fallback_used:
            self._fallbacks += 1  # the next fallback starts at the next variant
        self._soft_tic_trims += result.soft_tic_trims  # M032 SWEEP-12 (a count)
        # M032 SWEEP-25 B (a count): goodbyes taken out of the 19:00 reaction.
        self._commit_reaction_dropped += sum(
            1 for hit in result.hits if hit.rule == "reaction_leave_taking"
        )

    def record_spoken(
        self,
        plan: TurnPlan,
        spoken_text: str,
        *,
        r_sec: float | None = None,
        interrupted: bool = False,
        by_candidate: bool = True,
    ) -> None:
        """Record what the learner actually said, so reveals and deliveries are exact.

        ``interrupted``: the line was cut before its end; ``by_candidate`` is False when R1 cut it
        itself (a hung generation past its deadline): only a cut by the candidate is answered as one
        on the next turn, while what was not heard stays owed either way.
        """
        if plan.aside:
            return  # the interviewer's aside is scripted and excluded from evidence
        rearm, self._floor_rearm = self._floor_rearm, None
        if "floor_yield" in plan.reasons:
            # M032 SWEEP-33: "Sure, go ahead." raises, proves and asks nothing, so it leaves her
            # memory of the last real line (its primary, its worry, its question) as it was; the
            # cut its turn consumed, and the move that cut line carried, are still the next real
            # turn's to answer.
            self._spoken.add(spoken_text)
            cut_now = interrupted and by_candidate and bool(spoken_text.strip())
            if rearm is not None:
                self._learner_cut = rearm[0] or cut_now
                self._cut_move = rearm[1]
            return
        when = self.last_r if r_sec is None else r_sec
        cap = self._commitment_cap()  # the level on record BEFORE this turn's line
        # SWEEP-1: the primaries already delivered before this line, to tell which one it delivered.
        primaries_before = {
            primary for primary in _REACT_PUSHES.values() if self.scheduler.is_delivered(primary)
        }
        f4_owed = not self.scheduler.is_delivered(F4_PRIMARY)  # SWEEP-3, before this line
        tic_v2 = flag_on(FLAG_TIC_V2)
        self._spoken.add(spoken_text)
        if spoken_text.strip():
            tics = reply_tics(spoken_text, v2=tic_v2)
            self._styles.append((reply_opener(spoken_text), tics))
            self._asked.append("?" in spoken_text)
            # Review S2R-4 and S2R-6: her questions in this line (normalised, memory only), and
            # whether the last one is a yes/no question.
            questions = [sentence for sentence in split_sentences(spoken_text) if "?" in sentence]
            self._last_questions = tuple(
                norm for norm in (normalize(question) for question in questions) if norm
            )
            self._asked_yes_no = bool(questions) and _NOT_YES_NO.search(questions[-1]) is None
            if flag_on(FLAG_PRICE_ASKED_ONCE) and any(
                _FINAL_PRICE_QUESTION.search(question) for question in questions
            ):
                # Simulation diagnosis 1 (L3): her final-price question, and the offers it saw.
                self._final_asked = (self.turn, len(self.negotiation.offers))
            self._note_voice(plan, spoken_text, tics)
            if (
                plan.commitment_level is None
                and asks_for_email(spoken_text)
                and flag_on(FLAG_WEAK_EMAIL_V2)
            ):
                # SWEEP-25 A2: she asked for the details by e-mail herself (not in a scripted
                # commitment line); the advisor's next turn says whether he agreed.
                self._email_request_turn = plan.turn
            closing_on = flag_on(FLAG_CLOSING_STATE)
            # M032 S3.1: her own sign-off ("I'll give it some proper thought", "let's leave it
            # there"), never on a line that carried an owed move, a negotiation line or a scripted
            # commitment (the stall wording of those is graded, not a goodbye).
            self._last_reply_signoff = (
                closing_on
                and plan.move_id is None
                and plan.negotiation_id is None
                and plan.credit_move_id is None
                and plan.commitment_level is None
                and is_sign_off(spoken_text)
            )
            self._last_reply_closer = is_closer(spoken_text) or self._last_reply_signoff
            if closing_on and "closing_winding" in plan.reasons:
                self._winding_replies += 1
                self._enter_closing(CLOSING_CLOSED)  # S3.2: she said her goodbye
            self._raised_last = plan.move_id is not None or plan.negotiation_id is not None
            # M032 S1: whether her line carried an owed move or a negotiation line (her question in
            # it is the move's, answered by its push), what her own question asked about, and the
            # themes of her line (counts).
            self._last_owed_line = (
                plan.move_id is not None
                or plan.negotiation_id is not None
                or plan.credit_move_id is not None
            )
            self._her_question_topics = curiosity_asked_in(spoken_text, wide=tic_v2)
            shared = flag_on(FLAG_NO_COMMIT_LEDGER)
            for theme in concern_themes(spoken_text, shared_think_over=shared):
                self._concerns[theme] = self._concerns.get(theme, 0) + 1
            phrases = reply_phrases(spoken_text)
            self._phrase_history.append(phrases)
            for key in phrases:
                self._phrases[key] = self._phrases.get(key, 0) + 1
        # Review of simulation diagnosis 1, L1 (b): a deep-need phrase the guard let through as
        # the advisor's own words echoed is no need told before it was asked about.
        echoed = (
            echoed_need_topics(self.persona, spoken_text, tuple(self._advisor_said_turns))
            if flag_on(FLAG_ECHO_GUARD)
            else frozenset()
        )
        self.tracker.note_learner_text(spoken_text, plan.turn, echoed=echoed)
        if spoken_text.strip():
            self._note_open_question(plan, spoken_text)  # M032 SWEEP-7
            if asked_who_is_calling(spoken_text):
                self._asked_who = True  # M032 SWEEP-9: she asked already
            self._last_heard_turn = plan.turn
        # L1: her own questions.
        self._curiosity_asked.update(curiosity_asked_in(spoken_text, wide=tic_v2))
        if self._decider_said_turn is None and self.scheduler.spoken_proves(F4_PUSH, spoken_text):
            self._decider_said_turn = plan.turn  # L7: the decision maker is named
        if (
            plan.mode is TurnMode.LLM_REPLY
            and plan.move_id is None
            and plan.negotiation_id is None
            and plan.credit_move_id is None
            and spoken_text.strip()
            and flag_on(FLAG_NATURAL_TIMING)
            and self.scheduler.spoken_proves(F4_PUSH, spoken_text)
            and self._s1_slack(when)
        ):
            # M032 S1 item 3 (RCA LR-5, fda9e9f6 #48): she volunteered the decision-maker stall in a
            # free reply.  It is an objection for spacing, so the idle fuse does not fire the next
            # primary right after it; it is NOT a voiced reason (grading reads those) and the owed
            # F4 push is not marked delivered.  Only while the plan has S1 slack (``_s1_slack``,
            # review S1-R1): at 50-65 s an exchange the spacing it adds pushed F2 past its slip
            # limit, an attempt the release before it scored.
            self.scheduler.note_objection(turn=plan.turn)
            self._volunteered_objections += 1
        if spoken_text.strip():
            self._note_not_today(plan, spoken_text, when, f4_owed=f4_owed)
            if self._probe_first:
                self._note_probe_first(plan, spoken_text)
        self.negotiation.note_learner_text(
            spoken_text,
            plan.turn,
            stall=plan.move_id == F4_PRIMARY or plan.negotiation_id == N_TIMING,
        )
        if self._pending_ask is not None and declines_call(spoken_text):
            # The learner turned the proposed call down in its own words ("I'd rather keep it to
            # email", "I'd rather reach out myself", "I'd rather you didn't"): a farewell inside the
            # close window must not book it after all (R1-Q iterations 2 and 3).
            self._pending_ask = None
            self._declined_calls += 1
        carried = plan.move_id if plan.move_id is not None else plan.credit_move_id
        if carried is not None:
            delivery = self.scheduler.confirm_if_spoken(
                carried, spoken_text, when, interrupted=interrupted
            )
            # The owed F4 pair voices two stall reasons; the advisor's answer to them counts
            # as handled evidence for the grade.
            if delivery is not None and delivery.move_id == F4_PRIMARY:
                self.negotiation.note_reason_voiced(REASON_TIMING, plan.turn)
            elif delivery is not None and delivery.move_id == F4_PUSH:
                self.negotiation.note_reason_voiced(REASON_DECISION_MAKER, plan.turn)
        # Voice barge-in: the next turn is the one that cut her off.  A move the played part
        # already proved is delivered above (it was heard); one it did not prove stays owed.
        self._learner_cut = interrupted and by_candidate and bool(spoken_text.strip())
        self._cut_move = (
            carried
            if self._learner_cut
            and carried is not None
            and not self.scheduler.is_delivered(carried)
            else None
        )
        if not interrupted:
            self._credit_organic_push(plan, spoken_text, when)
        if plan.negotiation_id is not None:
            self.negotiation.note_spoken(plan.negotiation_id, spoken_text, plan.turn)
        scripted_commitment = plan.commitment_level is not None and bool(plan.scripted_text)
        if plan.resolves_commitment and scripted_commitment:
            if fuzzy_contains(spoken_text, plan.scripted_text):
                if self._commitment_level is None:
                    self._commitment_level = plan.commitment_level
                    self._commitment_turn = plan.turn
                self.scheduler.mark_commitment_resolved()
                if plan.commitment_level is not None:
                    self.negotiation.note_commitment(plan.commitment_level, plan.turn)
                self._unheard_commitment = None
            elif interrupted and not self.commitment_resolved:
                # Voice barge-in: the line was cut before the candidate heard it whole, so nothing
                # is on record; it is said again on the next turn (``_revoice_commitment``), and
                # that revoice counts toward the limit when some of it was heard.
                self._unheard_commitment = plan
                self._unheard_was_cut = bool(spoken_text.strip())
        if not scripted_commitment or plan.commitment_level is Level.WEAK:
            if classify_learner_commitment(spoken_text) > cap or has_concession(spoken_text):
                self._violations += 1
        if spoken_text.strip():
            # SWEEP-1: a heard line; the primary it delivered, if any (lost replies never get here).
            self._heard_primary = next(
                (
                    primary
                    for primary in _REACT_PUSHES.values()
                    if primary not in primaries_before and self.scheduler.is_delivered(primary)
                ),
                None,
            )
            # M032 S2 item 5: the family whose worry this heard line raised (an owed move it
            # delivered, or a stall reason), so the next turn can tell whether it was answered.
            spec = MOVE_SPEC_BY_ID.get(plan.move_id or "")
            if spec is not None and spec.family in FAMILIES and self.scheduler.is_delivered(
                spec.id
            ):
                self._worry_family = spec.family
            else:
                self._worry_family = _STALL_FAMILY.get(plan.negotiation_id or "")
            if (
                plan.move_id == F4_PRIMARY
                and self.scheduler.is_delivered(F4_PRIMARY)
                and flag_on(FLAG_NO_COMMIT_LEDGER)
            ):
                # SWEEP-3: F4-PRIMARY's own delivery voices the not-today theme.
                self._concerns[CONCERN_NOT_TODAY] = self._concerns.get(CONCERN_NOT_TODAY, 0) + 1
            # SWEEP-13: the trust theme is on record once she VOICES it (``concern_themes`` above);
            # a careful-buyer note alone records nothing (review S2R-4: "Okay." after it put "you
            # would want proof before trusting it" in every later ledger note).

    def _note_voice(self, plan: TurnPlan, spoken_text: str, tics: tuple[str, ...]) -> None:
        """M032 S2: how her heard line opened (SWEEP-4), its soft tics (SWEEP-12) and its sentence
        count (SWEEP-14).  Counts and flags only; the text is not kept."""
        hinge = ack_hinge(spoken_text)
        verdict = reply_verdict(spoken_text)
        self._hinges.append(hinge)
        self._verdicts.append(verdict)
        soft = tuple(tic for tic in tics if tic in SOFT_TICS)
        if _SAYS_RATHER.search(fold(spoken_text)):
            soft += (_RATHER,)
        self._soft_history.append(soft)
        if plan.mode in (TurnMode.LLM_REPLY, TurnMode.INTENT):
            self._voice_replies += 1
            if doubt_opener(spoken_text):
                self._doubt_openers += 1
            count = min(len(split_sentences(spoken_text)), SENTENCE_BUCKETS)
            self._sentence_counts[count] = self._sentence_counts.get(count, 0) + 1

    def _note_not_today(
        self, plan: TurnPlan, spoken_text: str, when: float, *, f4_owed: bool
    ) -> None:
        """SWEEP-3: her heard line said the not-today stall (``not_deciding``).

        Counted as a theme (the ledger note), and while F4-PRIMARY is owed the first such line sets
        ``_timing_said_turn`` (F4-PRIMARY then refers back to it).  A free reply that does so counts
        as an objection for spacing, once and only with S1 slack (mirroring S1 item 3); it is never
        a voiced reason for grading and never delivers F4-PRIMARY.
        """
        said = not_deciding(spoken_text)
        if said:
            self._stall_themes[CONCERN_NOT_TODAY] = self._stall_themes.get(CONCERN_NOT_TODAY, 0) + 1
        shared = flag_on(FLAG_NO_COMMIT_LEDGER)
        if CONCERN_THINK_OVER in concern_themes(spoken_text, shared_think_over=shared):
            self._stall_themes[CONCERN_THINK_OVER] = (
                self._stall_themes.get(CONCERN_THINK_OVER, 0) + 1
            )
        if PHRASE_DECIDER_STALL in reply_phrases(spoken_text):
            self._stall_themes["decider"] = self._stall_themes.get("decider", 0) + 1
        if not said or not flag_on(FLAG_NO_COMMIT_LEDGER):
            return
        if not_deciding(spoken_text, think_over=False):
            # A think-over line is on the ledger as think_over already (``concern_themes``): the
            # ledger never says the same stall twice.
            self._concerns[CONCERN_NOT_TODAY] = self._concerns.get(CONCERN_NOT_TODAY, 0) + 1
        if (
            not f4_owed
            or self._timing_said_turn is not None
            or plan.move_id == F4_PRIMARY
            or plan.negotiation_id == N_TIMING
        ):
            return
        self._timing_said_turn = plan.turn
        free = (
            plan.mode is TurnMode.LLM_REPLY
            and plan.move_id is None
            and plan.negotiation_id is None
            and plan.credit_move_id is None
        )
        if free and self._s1_slack(when):
            self.scheduler.note_objection(turn=plan.turn)
            self._volunteered_timing += 1

    def _note_probe_first(self, plan: TurnPlan, spoken_text: str) -> None:
        """M032 S2P: what her heard line did for probe first (ints and flags; no text is kept).

        A probe she asked (its markers in the played text) is counted, and a price question of any
        line (the probe, the redirect's, N-PRICE-FIRST or her own) sets ``_price_asked_turn``
        (SWEEP-22 item 6), so the probe is never asked again and F1-ANCHOR reacts to the answer.  A
        figure she said on an allowed path stays allowed for the session (SWEEP-17 item 4); and
        whether the line held a figure the advisor never said is kept for a figure challenge.
        """
        probe = plan.probe
        if probe is not None and markers_match(_PROBE_MARKERS[probe], spoken_text):
            self._probes[probe] = self._probes.get(probe, 0) + 1
            self._last_probe_family = probe
            if probe == "F1":
                self._price_asked_turn = plan.turn
        else:
            self._last_probe_family = None
        if asks_price(spoken_text):
            self._price_asked_turn = plan.turn
        planned = self._anchor_planned
        if plan.move_id == F1_ANCHOR and planned is not None and planned[0] == plan.turn:
            # Review S2P-R2 (naturalness): the website's price was checked once, by this anchor.
            self.negotiation.note_anchor(planned[1], planned[2])
            self._anchor_planned = None
        allowed = plan.guard_ctx.allowed_extra
        if plan.mode is TurnMode.SAY_ONLY and plan.move_id == F1_ANCHOR:
            allowed = allowed | frozenset(dollar_amounts(canonical_amounts(plan.scripted_text)))
        for amount in dollar_amounts(canonical_amounts(spoken_text)):
            if amount in allowed:
                self._figures_said.add(amount)
        for months in durations_said(spoken_text):
            if months in plan.guard_ctx.advisor_durations:
                self._durations_said.add(months)
        self._last_line_unsaid_figure = self._unsaid_figure_in(spoken_text)

    def _credit_organic_push(self, plan: TurnPlan, spoken_text: str, when: float) -> None:
        """A push the learner already voiced in a free reply is not owed again.

        "What happens if someone falls behind?" asked in a free reply, answered by the advisor, and
        then "What actually happens if someone does?" as the owed F2 push was a re-ask (R1-Q
        iteration 2: four calls).  When the primary of a family was delivered at least one turn ago
        and the played text proves its push, the push counts as delivered now.
        """
        for push_id, primary_id in ((F2_PUSH, F2_PRIMARY), (F3_PUSH, F3_PRIMARY)):
            if plan.move_id == push_id or self.scheduler.is_delivered(push_id):
                continue
            since = self.scheduler.turns_since_delivery(primary_id)
            if since is None or since < 1:
                continue
            if self.scheduler.confirm_if_spoken(push_id, spoken_text, when) is not None:
                self._organic_pushes.append(push_id)

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
        """The plan 6.4 administration checks this module can evaluate.

        ``stt_sanity`` (fewer than ``STT_SHORT_SHARE_LIMIT`` of the turns of at most
        ``STT_SHORT_WORDS`` words) reads only the turns that are not acknowledgement-only: an
        "Okay." or "Okay, continue." is the candidate's whole turn, which voice barge-in commits on
        its own, not speech-to-text chopping a long answer into fragments.  A short turn that is
        anything else ("Hi Pooja", "the price", "So bye") still counts, and a role-play of nothing
        but acknowledgements fails closed, as an empty one does.
        """
        end = self.last_r if r_end is None else r_end
        schedule = self.scheduler.summary(final=True)
        substantive = sum(1 for count in self._word_counts if count >= SUBSTANTIVE_WORDS)
        stt = self._stt_word_counts
        short_share = (
            sum(1 for count in stt if count <= STT_SHORT_WORDS) / len(stt) if stt else 1.0
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
            "acknowledgement_turns": len(self._word_counts) - len(stt),
        }

    def _endings_log(self) -> dict[str, Any]:
        """M032 S3: the endings' counts, no text (SWEEP-25 e-mail and reaction, SWEEP-27 notes)."""
        early = [o for o in self._wrap_offers if o["trigger"] == TRIGGER_EARLY_CLOSE]
        hangups = [o for o in self._wrap_offers if o["trigger"] == TRIGGER_ABUSE]
        return {
            "closing_state": self._closing,
            "closing_states": dict(sorted(self._closing_states.items())),
            "handover_closes": self._handover_closes,
            "mutual_goodbyes": self._mutual_goodbyes,
            "winding_replies": self._winding_replies,
            "early_close_asks": len(early),
            "early_close_accepted": sum(1 for o in early if o["answer"] == "yes"),
            "early_close_declined": sum(1 for o in early if o["answer"] in ("no", "carried_on")),
            "late_end_requests": self._late_end_requests,
            "last_point": None if self._last_point is None else dict(self._last_point),
            "last_point_asides": int(self._last_point is not None),
            "abuse_count": self._abuse_count,
            "abuse_hangups": len(hangups),
            "learner_asked_email": self._learner_asked_email,
            "commit_reaction_dropped": self._commit_reaction_dropped,
            "short_on_time_notes": self._short_on_time_notes,
        }

    def _followups_log(self) -> dict[str, Any]:
        """M032 S7L: the learner follow-ups' counts, no text."""
        return {
            "role_confusion_turns": self._role_confusion_turns,
            "floor_yields": self._floor_yields,
            "open_q_dodged": self._open_q_dodged,
            "open_q_reasked": self._open_q_reasked,
            "your_number_notes": self._your_number_notes,
            "call_opening_unknown_note": self._opening_notes.get("unknown", 0),
            "call_opening_name_only_note": self._opening_notes.get("name_only", 0),
            "call_opening_reciprocal_note": self._opening_notes.get("reciprocal", 0),
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
            # Which layer of each need was handed to the model on which role-play turn
            # (indices only; logged for the rehearsal metrics, not posted).
            "disclosure": self.tracker.gate.offers_view(),
            "repetition": {
                "remembered_sentences": len(self._spoken),
                "repeats_dropped": self.ledger.counts.get(REPEAT, 0),
                "fallbacks_used": self._fallbacks,
                "fillers_used": self._fillers,
            },
            # Intent-voiced moves (counts only; logged for the rehearsal metrics, not posted):
            # how often each move went to the model and how often its scripted variant had to
            # be appended because the model's reply missed the markers.
            "intents": {
                "handed_to_model": dict(self._intent_uses),
                "fallback_appended": dict(self._intent_fallbacks),
                "curiosity_asked": sorted(self._curiosity_asked),
                "curiosity_offered": dict(sorted(self._curiosity_offered.items())),
                "discovery_holds": dict(sorted(self._discovery_holds.items())),
                # Pushes the learner voiced in a free reply (not owed again), and calls it declined.
                "organic_pushes": list(self._organic_pushes),
                "declined_calls": self._declined_calls,
                # M032 S1 (counts only): owed moves held to respond first, by what was open; idle
                # primaries that waited for a natural moment; stalls she volunteered; the themes
                # of her lines; continuations planned from both halves of a split answer.
                "respond_first_holds": dict(sorted(self._respond_holds.items())),
                "moment_waits": self._moment_waits,
                "volunteered_objections": self._volunteered_objections,
                "concerns": dict(sorted(self._concerns.items())),
                "split_replans": self._split_replans,
                # SWEEP-1 (counts only): pushes held one turn for her reaction, by family.
                "push_react_holds": dict(sorted(self._push_react_holds.items())),
            },
            # M032 S2, learner voice (counts only; ``session_facts.learner_voice``): how her replies
            # opened, how long they were, how often a scripted tail was bolted on, and how often
            # each S2 note or trim fired.
            "voice": {
                "learner_replies": self._voice_replies,
                "learner_ack_hinge_replies": sum(1 for flag in self._hinges if flag),
                "learner_verdict_openers": sum(1 for flag in self._verdicts if flag),
                "learner_doubt_opener_replies": self._doubt_openers,
                "sentence_histogram": {
                    str(count): number for count, number in sorted(self._sentence_counts.items())
                },
                "intent_turns": sum(self._intent_uses.values()),
                "intent_tails_appended": self._tails_appended,
                "intent_tails_after_question": self._tails_after_question,
                "stall_theme_counts": dict(sorted(self._stall_themes.items())),
                "no_commit_notes": self._no_commit_notes,
                "volunteered_timing_stalls": self._volunteered_timing,
                "offer_terms_counts": dict(sorted(self._terms_counts.items())),
                "ack_turn_notes": self._ack_turn_notes,
                "soft_tic_trims": self._soft_tic_trims,
                "implausible_offer_count": self._implausible_count,
            },
            # M032 S2P, probe first (counts only; only in a session with R1_PROBE_FIRST on, so the
            # log of a session with it off is the release before): the probes she asked per family,
            # her price questions that got no figure, the redirects that asked instead of stating,
            # the course lengths the guard dropped, the figure challenges, SWEEP-22's notes.
            **(
                {
                    "probe_first": {
                        "probes": dict(sorted(self._probes.items())),
                        "price_dodges": self._price_dodges,
                        "price_asked": self._price_asked_turn is not None,
                        "redirect_probes": self._redirect_probes,
                        "course_fact_unsaid_count": self.ledger.counts.get(COURSE_FACT, 0),
                        "figure_challenges": self._figure_challenges,
                        "price_reflex_notes": self._price_reflexes,
                        "price_first_turns": self._price_first_turns,
                    }
                }
                if self._probe_first
                else {}
            ),
            # M032 S3, endings and abuse (counts and booleans; ``session_facts.learner_endings``).
            "endings": self._endings_log(),
            # M032 S7L, learner follow-ups (counts only; ``session_facts.learner_followups``).
            "followups": self._followups_log(),
            # Counts only (logged for the rehearsal metrics, not posted): replies that held a
            # question, the tracked phrase tics, and what the advisor already answered.
            "style": {
                "replies": len(self._asked),
                "questions": sum(1 for asked in self._asked if asked),
                "phrases": dict(self._phrases),
                "answered": list(self._answered),
            },
            # What the learner remembers about the price, callbacks, reasons and the close
            # (turn indices, integers and ids only; logged, not posted).
            "negotiation": self.negotiation.log(),
            "early_close": {
                "attempts": self.scheduler.close_attempts,
                "exit_requested": self.exit_requested,
                # The one-off out-of-role end request: the "end the interview now, or carry on?"
                # aside, or an explicit request that needed none (``question_asked`` false).
                "end_request": None if self._end_aside is None else dict(self._end_aside),
                # M2: every offer to wrap up (R, trigger, answer) and whether one was taken.
                "wrap_offers": [dict(offer) for offer in self._wrap_offers],
                "wrap_accepted": self.wrap_accepted,
            },
            "character_breaks": {
                "ai_questions": self._ai_questions,
                "asides": list(self._asides),
            },
            "communication": {
                "candidate_turns": len(self._word_counts),
                "acknowledgement_turns": len(self._word_counts) - len(self._stt_word_counts),
                "longest_candidate_turn_sec": round(self._longest_turn_sec, 1),
            },
            "excluded_from_auto_status": schedule["excluded_from_auto_status"],
            "exclusion_reasons": schedule["exclusion_reasons"],
            "fidelity": fidelity,
        }


# "it works out to 200 a month" / "about 150 per month": a bare number next to a monthly cue.
_BARE_MONTHLY = re.compile(
    r"(?<![\d$,.])(\d{2,4})(?:\s*(?:dollars|usd|bucks))?\s*(?:a|per|each|every|/)\s*month\b",
    re.IGNORECASE,
)


def advisor_amounts_in(text: object, *, shorthand: bool = False) -> set[int]:
    """The whole-dollar amounts the advisor's ``text`` names, however they are written.

    The learner may repeat any of them.  Spoken amounts ("two hundred a month", "fifteen hundred
    dollars a month") and a bare number beside "a month" count as well as "$N" (R1-Q final review
    round 1: the guard read the learner's "two hundred a month" in canonical form but only the
    advisor's digits with a dollar sign, so repeating the advisor's own figure was an "invented"
    amount and cost the learner its reply).  ``shorthand`` (M032 S2P, the session's latched
    R1_PROBE_FIRST; review S2P-R6): "9k" and "nine grand" count too, since the website's $9,000 is
    no longer a figure she may always say.
    """
    folded = canonical_amounts(expand_shorthand_amounts(text) if shorthand else text)
    amounts = set(dollar_amounts(folded))
    amounts.update(int(match.group(1)) for match in _BARE_MONTHLY.finditer(folded))
    return amounts


def _without_questions(text: str) -> str:
    """``text`` without its question sentences ("A statement. A question?" -> "A statement.")."""
    return " ".join(s for s in split_sentences(text) if "?" not in s).strip()


def _repeats(text: str, said: tuple[str, ...]) -> bool:
    """True when any sentence of ``text`` repeats something in ``said`` (``repeat_kind``)."""
    return any(repeat_kind(sentence, said) is not None for sentence in split_sentences(text))


# Simulation diagnosis 1 (U2), review: the interjections a tail must not open with twice ("Wait,
# ... Wait, ..."); a common opener such as "I'm" or "That's" is no tic.
_TAIL_OPENERS = frozenset(
    {"wait", "okay", "ok", "really", "oh", "hmm", "hm", "so", "well", "right", "sorry", "alright",
     "look", "huh", "um", "uh"}
)


def _first_word(text: object) -> str:
    """The first word of ``text``, lower-cased ("" when there is none)."""
    match = re.match(r"\W*([A-Za-z']+)", str(text or ""))
    return match.group(1).lower() if match else ""
