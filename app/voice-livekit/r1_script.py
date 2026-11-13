"""R1 scripted lines (plan 5.2): the text the worker speaks without asking an LLM.

This is the reviewed, SHA-pinned replacement for the provisional line table that the
worker core ships (``r1_lines``).  The ids, texts and the ``{first_name}`` /
``{lead_name}`` / ``{lead_city}`` placeholders are the plan's; ``line`` has the same
call shape, so the follow-up integration swaps the import and nothing else.

Invariants:

* ``{first_name}`` is the candidate's sanitised first name and the ONLY candidate PII in
  any line (``known_first_name``: letters, space, hyphen, apostrophe, at most 24
  characters).  An empty name or the API's placeholder "there" is UNKNOWN: ``line`` then
  deletes the slot with its comma ("Thank you, {first_name}. We'll" -> "Thank you. We'll"),
  so the candidate never hears "Thank you, there.".  Lines without the slot are
  candidate-free, so they can be synthesised once per machine and cached by SHA and
  voice (plan 5.2).
* ``L-PICKUP`` and ``L-ASIDE-COACH`` are persona lines; their values come from the
  rendered persona (``RenderedPersona.line_values``), never from the candidate.
* The learner's objection lines, the commitment lines and the WEAK stall live with the
  scheduler and ``r1_commitment``; they are part of the same content pin
  (``r1_content``).
"""
from __future__ import annotations

import hashlib
import os
import re
import string
from typing import Any

INTERVIEWER_NAME = "Christy"

# M032 S6 (owner go of 2026-11-11, test fda9e9f6 #23-#31; SWEEP-30): ONE body for every brief, so
# the first brief, the brief after Christy's own reaction (S5's bridge), the replay and the short
# recap can never drift apart.  ``BRIEF_GOAL`` is the goal clause the recap reuses word for word.
# No "We'll now move to the role-play" (the move was announced as decided, then asked about), no
# "evaluate", no second "just say 'ready' and she'll pick up": "To begin, just say 'ready'." and the
# either/or question are the brief's ONE start prompt (S6.5).  Consent is unchanged: only a spoken
# "ready" (``is_transition_consent``) or the "I'm ready" button starts the role-play.
BRIEF_GOAL = "understand her needs and help her decide to enrol"
BRIEF_START_PROMPT = (
    "To begin, just say 'ready'. Shall we start the role-play now, or do you have any questions "
    "first?"
)
BRIEF_SCENARIO = (
    "I'll play {lead_name} from {lead_city}, who filled in a form on our website about the Data "
    "Science course a few days ago. You're the Program Advisor calling her back. You'll have up "
    "to twenty minutes, and your goal is to convince her as you would on a real call: "
    + BRIEF_GOAL
    + ", using the course details from your preparation guide. I'll stay in character until I "
    "say, 'Let's pause the role-play here.' "
    + BRIEF_START_PROMPT
)
BRIEF_LEAD_IN = "Next, let's do a sales role-play. "
BRIEF_BODY = BRIEF_LEAD_IN + BRIEF_SCENARIO
BRIEF_THANKS = "Thank you, {first_name}. "
BRIEF_AGAIN = "Of course, here it is again. "

# M032 S7C (SWEEP-35, R1_OPENING_SOUND_CHECK; owner go of 2026-11-11, pattern P33): L-OPEN was one
# 79-word block of about 29 s with no greeting exchange and no hearing check.  The opening is now a
# short hello that carries the AI disclosure and asks whether the candidate can hear Christy, then
# ONE shorter agenda from this shared body.  The owner's durations are kept word for word ("about
# thirty minutes", "up to twenty minutes"); the two filler durations are gone.  The agenda asks the
# icebreaker plan's first objective, as L-OPEN did.
OPEN_HEARD = "Good, I can hear you. "
OPEN_PLAIN = "Let's get started. "
OPEN_AGENDA = (
    "This first-round interview takes about thirty minutes: we'll get to know each other, then do "
    "a sales role-play of up to twenty minutes, and you can ask me questions at the end. "
)
OPEN_FIRST_QUESTION = (
    "So, to begin, tell me a bit about yourself and your sales or customer-facing work."
)
OPEN_CARRY_ON = "Please, carry on with what you were telling me."

LINES: dict[str, str] = {
    "L-OPEN": (
        "Hi {first_name}, I'm Christy, an AI interviewer from Interview Kickstart, and "
        "I'll be running your first-round interview for the Sales Program Advisor role. "
        "It takes about thirty minutes. We'll spend a few minutes getting to know you, "
        "then I'll switch into a sales role-play of up to twenty minutes where I play a "
        "prospective learner, "
        "and we'll finish with a couple of minutes for your questions. Let's start: could "
        "you walk me through your background, especially any sales or customer-facing work "
        "you've done?"
    ),
    # M032 S7C (SWEEP-35): the hello and its sound check, then the agenda (L-OPEN is the flag-off
    # line).  The hello is spoken live (it carries the name); the rest is name-free and warmed
    # first.
    "L-OPEN-HELLO": (
        "Hi {first_name}, I'm Christy, an AI interviewer from Interview Kickstart. Can you hear me "
        "okay?"
    ),
    "L-OPEN-HELLO-AGAIN": (
        "Sorry about that. Please check your speaker or headphone volume. Can you hear me now?"
    ),
    "L-OPEN-AGENDA": OPEN_HEARD + OPEN_AGENDA + OPEN_FIRST_QUESTION,
    "L-OPEN-AGENDA-PLAIN": OPEN_PLAIN + OPEN_AGENDA + OPEN_FIRST_QUESTION,
    "L-OPEN-AGENDA-CONTINUE": OPEN_HEARD + OPEN_AGENDA + OPEN_CARRY_ON,
    # M032 S6 item 5 and SWEEP-30: the brief, from the shared body above.
    "L-TRANSITION": BRIEF_THANKS + BRIEF_BODY,
    # M032 S5 item 4: the brief after Christy's own one-sentence reaction to the last icebreaker
    # answer (R1_TRANSITION_BRIDGE, off by default).  L-TRANSITION without "Thank you,
    # {first_name}.", so it carries no candidate name and is cached once per machine.  M032 S6
    # (SWEEP-28): also the brief after a boundary turn that answered nothing (a presence check or
    # a request to repeat), which has nothing to be thanked for.
    "L-TRANSITION-BRIDGED": BRIEF_BODY,
    # M032 S6 item 4 (reverses the 2026-10-30 word-for-word replay under D-M032-4): the brief once
    # more on request, without the thanks and the lead-in, which said it as if for the first time.
    "L-TRANSITION-AGAIN": BRIEF_AGAIN + BRIEF_SCENARIO,
    # M032 S6 item 2 and SWEEP-29: the short recap (public brief fields only, about 15 s) for a
    # request for a shorter brief, a question about the role-play, or a request after the replay.
    "L-TRANSITION-RECAP": (
        "Of course, in short: I'll play {lead_name}, and you're the Program Advisor calling her "
        "back about the Data Science course. "
        + BRIEF_GOAL[:1].upper()
        + BRIEF_GOAL[1:]
        + ", using your preparation guide. Shall we start the role-play now, or do you have any "
        "questions first?"
    ),
    # M032 S6 item 3 and SWEEP-28 (one id): the answer to "Are you there?".
    "L-PRESENT": "Yes, I'm here.",
    # M032 S6 item 6: the "I'm ready" button pressed while a brief was playing; said before the
    # pickup, so the brief's either/or question does not hang unanswered.
    "L-PICKUP-BRIDGE": "Great, here she is.",
    # The briefs as they were before M032 S6 (content revision 21): R1_TRANSITION_REPAIR=0 speaks
    # these in their place (``ROLLBACK_LINES``).
    "L-TRANSITION-V20": (
        "Thank you, {first_name}. We'll now move to the role-play. I'll play a prospective "
        "learner so we can evaluate how you handle a real sales call. The learner is "
        "{lead_name} from {lead_city}, who filled in a form on our website about the Data "
        "Science course a few days ago. You're the Program Advisor calling her back. The "
        "role-play runs for up to twenty minutes, and in that time your goal is to convince "
        "her: understand her needs and help her decide to enrol, as you would on a real call, "
        "using the course details from your preparation guide. I'll stay in character until I "
        "say, 'Let's pause the role-play here.' When you'd like to begin, just say 'ready' and "
        "she'll pick up. Shall we start the role-play now, or do you have any questions first?"
    ),
    "L-TRANSITION-BRIDGED-V20": (
        "We'll now move to the role-play. I'll play a prospective "
        "learner so we can evaluate how you handle a real sales call. The learner is "
        "{lead_name} from {lead_city}, who filled in a form on our website about the Data "
        "Science course a few days ago. You're the Program Advisor calling her back. The "
        "role-play runs for up to twenty minutes, and in that time your goal is to convince "
        "her: understand her needs and help her decide to enrol, as you would on a real call, "
        "using the course details from your preparation guide. I'll stay in character until I "
        "say, 'Let's pause the role-play here.' When you'd like to begin, just say 'ready' and "
        "she'll pick up. Shall we start the role-play now, or do you have any questions first?"
    ),
    "L-TRANSITION-NUDGE": "Whenever you're ready, just say ready.",
    # Owner decision 2026-11-03 (M1): no auto-start.  L-TRANSITION-ASK ends every answer Christy
    # gives before the role-play (it travels inside her reply); the two re-asks follow candidate
    # silence; L-TRANSITION-STEER answers a question past the limit of three.
    "L-TRANSITION-ASK": "Shall we start the role-play now, or do you have another question?",
    # M032 S6 (SWEEP-32): once the brief's either/or question has been heard, the answers' start
    # question rotates through these shorter forms, so the candidate never hears the same words
    # after every answer.  Both stay either/or: a bare "yes" to them still gets the nudge.
    "L-TRANSITION-ASK-2": "Anything else, or shall we start?",
    "L-TRANSITION-ASK-3": "Any other questions, or shall we begin the role-play?",
    "L-TRANSITION-REASK": (
        "Shall we start the role-play now? Just say 'ready' when you are, or ask me a question "
        "first if you have one."
    ),
    "L-TRANSITION-REASK-2": (
        "I'm still here whenever you're ready. Just say 'ready', or press the I'm ready button, "
        "and she'll pick up."
    ),
    "L-TRANSITION-STEER": (
        "Let's keep any other questions for the end of the interview; there'll be time for them "
        "then. Shall we start the role-play now?"
    ),
    # M032 S6 item 8: "Hello? Yes, this is X speaking." answered a question nobody had asked.
    "L-PICKUP": "Hello, {lead_first_name} speaking.",
    "L-PICKUP-V20": "Hello? Yes, this is {lead_first_name} speaking.",
    "L-TIME-CUE": "Just so you know, I've only got a couple of minutes before my next call.",
    "L-EXIT": (
        "Let's pause the role-play here. I'm stepping out of the learner's role now; this "
        "is Christy, your interviewer, again. Thank you, that's the end of the role-play."
    ),
    "L-WRAP": "Before we finish, do you have any questions about the role or the next steps?",
    # No "hiring team" here: L-CLOSE carries the one mention of who reviews the interview, so a
    # candidate who asks for feedback hears it once, not twice a few seconds apart.
    "L-NO-FEEDBACK": "I'm sorry, I can't share any feedback on how it went.",
    "L-FAQ-DEFER": "That's a good question for the hiring team; they'll follow up with you on it.",
    # M032 S3.5 and SWEEP-26 (flags R1_WRAPUP_ANSWERS and R1_WRAPUP_ONE_MENTION).  The wrap-up's
    # one invitation for another question (a tail of Christy's answer, once per session), and her
    # deflection in the wrap-up and the closing in place of L-FAQ-DEFER: L-CLOSE is the one mention
    # of the hiring team.  Both travel inside a reply stream, so neither is warmed.
    "L-WRAP-MORE": "Is there anything else you'd like to ask?",
    "L-FAQ-DEFER-WRAP": "I'm afraid that's not something I can tell you.",
    "L-CLOSE": (
        "Thank you for your time today, {first_name}. The hiring team will review your "
        "interview and get back to you. You can close this window now. Goodbye."
    ),
    # M032 S6 (SWEEP-30): in Christy's own voice, "I'm the learner ... She" mixed the two people up,
    # and it is played exactly when a candidate is confused about roles.  The first-person
    # "playing" framing of L-OPEN and the brief is kept.
    "L-ASIDE-COACH": (
        "Quick note from Christy, your interviewer: in this role-play you're the Program "
        "Advisor, and I'm playing the learner, {lead_name}, who enquired about the Data Science "
        "course; you're calling her back. Please carry on as you would on a real call."
    ),
    "L-ASIDE-COACH-V20": (
        "Quick note from Christy, your interviewer: in this role-play you're the Program "
        "Advisor and I'm the learner, {lead_name}. She enquired about the Data Science "
        "course and you're calling her back. Please carry on as you would on a real call."
    ),
    # Owner test 7f2a25e6: the candidate asked the learner to "disconnect the call".  Asked once,
    # before R = 14:00, with R paused; saying "end the interview" ends the role-play, and L-EXIT and
    # the wrap-up follow (owner decision 2026-10-29; the close L-END-CLOSE that ended the whole
    # session is gone).  Not an either/or question: a bare "yes" would not say which option was
    # meant.  The text is owner-approved and unchanged.
    "L-ASIDE-END": (
        "This is Christy, your interviewer. If you want to end the interview now, please say: end "
        "the interview. Otherwise, just carry on with {lead_name}."
    ),
    # Owner and manager decisions of 2026-11-03 (M2): leaving the role-play is the candidate's
    # choice.  From R = 14:00 the interviewer may OFFER to wrap up (R paused, at most twice, never
    # over a question or a pitch); a yes leads to L-EXIT and the wrap-up, a no gets
    # L-ASIDE-WRAP-RESUME and the role-play goes on.  Like L-ASIDE-END it is not an either/or
    # question, so a bare "yes" says which option it means.
    "L-ASIDE-WRAP": (
        "This is Christy, your interviewer, stepping in for a moment. We're well into the "
        "role-play now, so would you like to wrap it up here? If you'd rather keep going, just "
        "carry on with {lead_first_name}."
    ),
    "L-ASIDE-WRAP-RESUME": "Of course, let's keep going. {lead_first_name} is back on the line.",
    # M032 S3.3 (owner decision D-M032-2, flag R1_EARLY_CLOSE_ASIDE): the advisor closes the call in
    # role before R = 14:00 and no redirect is left, so Christy asks (R paused) instead of the
    # role-play ending without the candidate's word.  A yes ends it (L-EXIT and the wrap-up), a no
    # resumes it (L-ASIDE-WRAP-RESUME, then the learner carries on with a real point).  Below R =
    # 10:00 the variant adds that there is still time (a stop there leaves the attempt unscored).
    # Owner-approved draft wording (D-M032-4), listed for review.
    "L-ASIDE-EARLY-CLOSE": (
        "This is Christy, stepping in for a moment. It sounds like you're wrapping up the call "
        "with {lead_first_name}. You're welcome to keep going with her, or if you'd rather stop "
        "the role-play here, just say so."
    ),
    "L-ASIDE-EARLY-CLOSE-TIME": (
        "This is Christy, stepping in for a moment. It sounds like you're wrapping up the call "
        "with {lead_first_name}. We still have some time for the role-play, so you're welcome to "
        "keep going with her, or if you'd rather stop the role-play here, just say so."
    ),
    # M032 SWEEP-24 (flag R1_LATE_END_REQUEST): from R = 14:00 an explicit request to end the
    # exercise when one owed move would complete the schedule: Christy says it will stop in a
    # moment (R paused), the learner raises that one point, and the next real turn ends it.
    "L-ASIDE-LAST-POINT": (
        "This is Christy, your interviewer. Of course, we'll stop in just a moment; "
        "{lead_first_name} has one last thing she'd like to say first."
    ),
    # M032 S3.4 (owner decision D-M032-3, flag R1_ABUSE_HANGUP): abuse aimed at the learner.  She
    # ends the call in character in one line (her voice), then Christy asks (R paused); a yes ends
    # the role-play, a no resumes it (L-ASIDE-WRAP-RESUME) with her cool.  Scoring is unchanged.
    "L-LEARNER-HANGUP": "I don't think I want to continue this call. Goodbye.",
    "L-ASIDE-HANGUP": (
        "{lead_first_name} has ended the call. Shall we pause the role-play here and move on?"
    ),
    # M2: the end of the role-play's time (R = 20:00, or its S cap) is never abrupt: after the
    # 17:00 time cue, the learner closes in role with this line, and then L-EXIT follows.
    "L-TIME-UP": "I'm sorry, I really have to go now. Thank you for your time.",
    # M032 SWEEP-20 (flag R1_PROBE_FIRST): an early farewell before she knows the price or the
    # time the course takes is stopped with the probe that is due, never "$9,000 is a lot".  In the
    # learner's voice; they deliver nothing graded (the owed move stays owed).
    "L-REDIRECT-PRICE": "Oh wait, before you go... what would the course cost me?",
    "L-REDIRECT-TIME": "Oh wait, before you go... how much time would this take each week?",
    # M032 SWEEP-33 (flag R1_FLOOR_YIELD): the advisor asks for the floor ("Can I talk?", "Let me
    # finish."), so she yields in a few words and makes no point.  The apologetic pair when the
    # request cut her line (or her reply never got out), the plain pair otherwise; rotated.  In the
    # learner's voice; they deliver nothing graded (the owed move stays owed).  New wording under
    # D-M032-4, listed for review.
    "L-LEARNER-YIELD-SORRY": "Sorry, go ahead.",
    "L-LEARNER-YIELD-SORRY-2": "Oh, sorry. Go on.",
    "L-LEARNER-YIELD": "Sure, go ahead.",
    "L-LEARNER-YIELD-2": "Of course, go on.",
    "L-MUTE": (
        "This is Christy. It looks like your microphone may be muted. Please unmute when "
        "you're ready."
    ),
    # M032 S7C (SWEEP-36, R1_MUTE_ASIDE_V2; pattern P62): the mute aside by phase, neither with
    # "ready" in it (b419d478: "Please unmute when you're ready." was answered "I am ready", and in
    # the transition that is a start).  In the role-play Christy names herself, because her voice
    # takes the learner's place; in her own phases she does not introduce herself again.  L-MUTE is
    # the flag-off line, unchanged.
    "L-MUTE-RP": (
        "This is Christy, your interviewer. Your microphone seems to be muted. Please unmute it so "
        "we can carry on."
    ),
    "L-MUTE-IV": "Your microphone seems to be muted. Please unmute it so I can hear you.",
    "L-SIL-IB": "Are you still with me, {first_name}?",
    # M032 S7C (SWEEP-34, R1_NO_AUDIO_LADDER; pattern P25): a candidate who was never heard at all
    # (no final, no speech) is told Christy cannot hear them, not "Are you still with me?" and "we
    # seem to have lost the connection".  Hedged: in every observed case the fault was likely on our
    # side, and it promises nothing about the attempt (the web card says the interview is complete).
    "L-SIL-NOAUDIO": (
        "I can't hear anything from you yet. If you're speaking, please check that your microphone "
        "is switched on and selected."
    ),
    "L-SIL-END-NOAUDIO": (
        "I still can't hear you, so I'll have to stop here for now. The hiring team will be in "
        "touch. Goodbye."
    ),
    "L-SIL-RP1": "Hello? Are you still there?",
    "L-SIL-RP2": (
        "This is Christy, your interviewer. It sounds like we may have lost you. I'll wait "
        "a few more seconds."
    ),
    "L-SIL-END": (
        "I'm going to end the interview here as we seem to have lost the connection. The "
        "hiring team will be in touch. Goodbye."
    ),
    "L-REJOIN": "Welcome back, {first_name}. Let's pick up where we left off.",
    "L-REJOIN-RP": "The learner is back on the line.",
    "L-SYSTEM-STOP": (
        "I'm sorry, {first_name}, we need to stop here because of a technical problem on "
        "our side. This won't count against you, and the hiring team will send you a new "
        "link. Goodbye."
    ),
    "L-FILLER": "Let me think about that for a second.",
    "L-FILLER-INTERVIEWER": "Let me think about that for a second.",
    "L-FILLER-LEARNER": "One second...",
    # M032 S6 (SWEEP-28): Christy's scripted reply to "Can you give me a minute?" in the
    # getting-to-know-you part (R1_ICEBREAKER_REPAIR); it is not counted as an answer.
    "L-IB-HOLD": "Of course, take a moment. I'm here when you're ready.",
}

# M032 S6: ``R1_TRANSITION_REPAIR=0`` (the rollback) speaks each of these lines as it was before
# S6, under its old text's id.  ``active_line_id`` is the one place that choice is made: the
# session's ``render_line`` and the role-play engine's coach aside both go through it, so the warm
# order, the cache and the transcript all follow the flag together.
ROLLBACK_LINES = {
    "L-TRANSITION": "L-TRANSITION-V20",
    "L-TRANSITION-BRIDGED": "L-TRANSITION-BRIDGED-V20",
    "L-PICKUP": "L-PICKUP-V20",
    "L-ASIDE-COACH": "L-ASIDE-COACH-V20",
}
_OFF_VALUES = frozenset({"0", "off", "false", "no"})


def transition_repair_enabled() -> bool:
    """``R1_TRANSITION_REPAIR`` (default on): M032 S6's brief and transition repair.

    The reworded brief and its replay and recap, the wider brief request, the presence answer,
    the rotated start question, the pickup bridge and line, and the coach aside's wording.  Read
    at use.  Rollback: ``fly secrets set R1_TRANSITION_REPAIR=0 -a project-hello-voice`` gives back
    content revision 21's lines and routing exactly.
    """
    return (os.getenv("R1_TRANSITION_REPAIR") or "1").strip().lower() not in _OFF_VALUES


def active_line_id(line_id: str) -> str:
    """The id whose text is spoken for ``line_id`` now (``ROLLBACK_LINES`` while S6 is off)."""
    if line_id in ROLLBACK_LINES and not transition_repair_enabled():
        return ROLLBACK_LINES[line_id]
    return line_id


# The learner's thinking filler rotates through three variants so a slow model never makes the
# learner say the same words twice in a row.  The first is ``L-FILLER-LEARNER``; the rotation
# starts at a point derived from the attempt id (``r1_text.pick_variant``).
LEARNER_FILLER_VARIANTS: tuple[str, ...] = (
    LINES["L-FILLER-LEARNER"],
    "Let me think for a second...",
    "Give me a moment...",
)
# When every variant above was already played, the filler is this one-word hum: under four words,
# so it is never a repeat in the sense of ``r1_text.repeat_kind`` (R1-Q round 1).
LEARNER_FILLER_SHORT = "One moment..."

# The exit line's first sentence is the cue the LLM must never imitate (``r1_guard``).
EXIT_CUE = "Let's pause the role-play here."
_NAME = re.compile(r"^[A-Za-z '-]{1,24}$")
# The placeholder the API sends for a name it could not use (``r1.ts``: "there").
PLACEHOLDER_NAME = "there"
# The ``{first_name}`` slot with the comma that leads into it: ", {first_name}" or " {first_name}".
_NAME_SLOT = re.compile(r",? \{first_name\}")
_FORMATTER = string.Formatter()


def safe_first_name(value: object) -> str:
    """A short display-safe first name, or the neutral greeting "there"."""
    name = str(value or "").strip()
    return name if _NAME.fullmatch(name) else PLACEHOLDER_NAME


def known_first_name(value: object) -> str:
    """The candidate's display-safe first name, or "" when the name is UNKNOWN.

    Unknown is an empty value, a value ``safe_first_name`` rejects, the API's placeholder
    "there" (any case), and a name with fewer than two letters (an initial is not a name to
    greet someone by).  ``line`` renders an unknown name by dropping the slot, never by
    speaking "there" into it.
    """
    name = str(value or "").strip()
    if not _NAME.fullmatch(name) or name.lower() == PLACEHOLDER_NAME:
        return ""
    return name if sum(char.isalpha() for char in name) >= 2 else ""


# A spoken self-introduction: "my name is X" and "my name's X" anywhere, "myself X" as the opener of
# a sentence ("I taught myself Python" is not one) and "this is X" as the opener of the turn
# ("this is Salesforce" mid-answer is not one), each after an optional greeting.  The name must
# start with a capital letter as the speech-to-text wrote it ("my name is not on it" and "this is
# great" are not names) and is letters only.
_HELLO = r"hi|hello|hey|christy|good (?:morning|afternoon|evening)"
_FILLER = r"yeah|yes|yep|so|um|uh|well|okay|ok|sure|alright"
_NAME_TAIL = r"\s+([A-Z][A-Za-z]{1,23})(?![A-Za-z0-9'-])"
_SPOKEN_NAME = (
    re.compile(r"(?i:\bmy name(?: is|'s|\u2019s))" + _NAME_TAIL),
    re.compile(
        r"(?:^|[.!?]\s+)(?i:(?:(?:" + _HELLO + "|" + _FILLER + r")[\s,.!-]*)*myself)" + _NAME_TAIL
    ),
    re.compile(r"^(?i:(?:(?:" + _HELLO + r")[\s,.!-]*)*this is)" + _NAME_TAIL),
)
# Capitalised words that follow those openers without being a name.
_NOT_A_NAME = frozenset(
    {
        "a", "an", "the", "and", "but", "or", "so", "um", "uh", "from", "not", "very", "really",
        "basically", "currently", "working", "just", "also", "actually", "honestly", "quite",
        "pretty", "sort", "kind", "one", "first", "new", "good", "great", "nice", "fine", "okay",
        "interesting", "important", "awesome", "amazing", "yes", "no", "sir", "madam", "maam",
        "my", "our", "your", "his", "her", "it", "its", "in", "on", "at", "to", "for", "with",
        "what", "why", "how", "when", "who", "which", "where", "that", "this", "there", "here",
        "christy", "interviewer", "interview", "kickstart",
    }
)
SPOKEN_NAME_MIN_LETTERS = 2
SPOKEN_NAME_MAX_LETTERS = 24


def spoken_first_name(text: object) -> str:
    """The first name a candidate introduced themselves with in ``text``, or "".

    Narrow on purpose: a wrong name spoken back to the candidate is worse than none.  Only the
    forms in ``_SPOKEN_NAME`` count, the first match wins, and a word from ``_NOT_A_NAME`` is
    skipped.  The result is letters only, 2 to 24 of them, in capital-then-lower case.
    """
    raw = str(text or "")
    for pattern in _SPOKEN_NAME:
        for match in pattern.finditer(raw):
            word = match.group(1)
            if word.lower() in _NOT_A_NAME:
                continue
            if not SPOKEN_NAME_MIN_LETTERS <= len(word) <= SPOKEN_NAME_MAX_LETTERS:
                continue
            name = word[:1].upper() + word[1:].lower()
            if known_first_name(name):
                return name
    return ""


def placeholders(line_id: str) -> frozenset[str]:
    """The placeholder names a line uses."""
    return frozenset(
        field for _, field, _, _ in _FORMATTER.parse(LINES[line_id]) if field
    )


def is_candidate_free(line_id: str) -> bool:
    """True when the line carries no candidate PII, so it may be cached across sessions."""
    return "first_name" not in placeholders(line_id)


NAME_FREE_LINES = tuple(line_id for line_id in LINES if not placeholders(line_id))
CANDIDATE_FREE_LINES = tuple(line_id for line_id in LINES if is_candidate_free(line_id))


def line(line_id: str, **values: Any) -> str:
    """Render a reviewed line.  ``first_name`` is sanitised; unknown ids raise KeyError.

    An unknown first name (``known_first_name`` is "": empty, rejected, or the placeholder
    "there") is not spoken: the slot is deleted with its comma, so "Thank you, {first_name}.
    We'll" reads "Thank you. We'll" and "Are you still with me, {first_name}?" reads "Are you
    still with me?".

    Persona placeholders must be supplied (``**persona.line_values``); a missing one is a
    programming error and raises KeyError rather than speaking a literal ``{lead_name}``.
    """
    text = LINES[line_id]
    needed = placeholders(line_id)
    fields: dict[str, str] = {}
    if "first_name" in needed:
        first_name = known_first_name(values.get("first_name"))
        if first_name:
            fields["first_name"] = first_name
        else:
            text = _NAME_SLOT.sub("", text)
    for name in needed - {"first_name"}:
        fields[name] = str(values[name])
    return text.format(**fields)


def filler_line(voice: str) -> str:
    """The thinking filler for the interviewer or the learner voice (the first variant)."""
    return LINES["L-FILLER-LEARNER" if voice == "learner" else "L-FILLER-INTERVIEWER"]


def line_sha256(text: str) -> str:
    """Cache key for a synthesised line: the digest of its exact rendered text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
