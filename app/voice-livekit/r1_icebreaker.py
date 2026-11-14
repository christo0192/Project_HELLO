"""R1 icebreaker plan (M032 S5 item 3): the getting-to-know-you part runs on a plan code owns.

The phone bot is scripted too; what makes it feel natural is the manners around the script.  Here
code chooses what each of Christy's icebreaker questions is FOR (``OBJECTIVES``) and the model only
words it, after a few words of reaction to what the candidate just said.  L-OPEN already asks the
first objective (background and sales work), so the cursor starts there; so does the opening's
agenda (M032 S7C, ``R1_OPENING_SOUND_CHECK``), or it invites an early answer to carry on.

One decision per committed icebreaker answer (``IcebreakerPlan.next_job``), read by
``disposition``:

* answered: the cursor moves on, past any later objective the answer already reached;
* thin (few substantive words, a fragment): ONE follow-up on the same objective, then on;
* declined ("I'd rather not say", "nothing comes to mind"): accepted, and the cursor moves on;
* not an answer (a question to Christy, "can you repeat that?") and a request to skip ahead: the
  same objective again, after a short answer or one warm clause, at most ``MAX_HOLDS`` times;
* "let me think": "Take your time." and nothing else (no advance, nothing counted).

Once every objective is reached Christy follows up on what they said, and the same manners hold
(``FREE_JOB_NOTES``): a decline is accepted, and a repeat request or a skip request gets her last
question again, bounded like a hold.

The transition bridge (M032 S5 item 4) lives here too, as pure pieces: whether the answer that
ended the icebreaker deserves a reaction (``bridge_wanted``), the note the reaction is composed
under (``BRIDGE_NOTE``) and the vetting of what came back (``clean_bridge``).  The session composes
it out of band at the boundary and speaks it, then the brief without its "Thank you, {first_name}."
(L-TRANSITION-BRIDGED); anything not clean says nothing extra and the brief plays as before.

Invariants: pure (no I/O, no clock, no SDK, no asyncio) and never imports the phone lane; the plan
keeps labels and counters only, never candidate text; every note keeps the getting-to-know-you
note's guard rails word for word and never names this part of the interview; the pacing (the soft
exit at S >= 3:30 with four answers, the hard stop at S = 4:30) is ``r1_phases``' and unchanged.
``R1_ICEBREAKER_PLAN=0`` turns the plan off and the session is exactly as before.  The bridge
ships OFF (``R1_TRANSITION_BRIDGE``, see ``transition_bridge_enabled``).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any

from r1_guard import GuardContext, check_sentence, praise_detected
from r1_text import fold, split_sentences


def _reaction_variety_v2() -> bool:
    """``R1_REACTION_VARIETY_V2`` (``r1_prompts.reaction_variety_v2_enabled``), imported late:
    r1_prompts is not needed for anything else here."""
    from r1_prompts import reaction_variety_v2_enabled

    return reaction_variety_v2_enabled()

# Dispositions of one committed icebreaker answer.
ANSWERED = "answered"
THIN = "thin"
DECLINED = "declined"
NONANSWER = "nonanswer"
SKIP = "skip"
THINKING = "thinking"
DISPOSITIONS = (ANSWERED, THIN, DECLINED, NONANSWER, SKIP, THINKING)

# What Christy's reply to it does.
JOB_ASK = "ask"
JOB_FOLLOW_UP = "follow_up"
JOB_REASK = "reask"
JOB_SKIP = "skip_ahead"
JOB_DECLINED = "declined"
JOB_FREE = "free"
JOB_TAKE_TIME = "take_time"
JOBS = (JOB_ASK, JOB_FOLLOW_UP, JOB_REASK, JOB_SKIP, JOB_DECLINED, JOB_FREE, JOB_TAKE_TIME)

# An answer with fewer substantive words than this (words that are not pronouns, auxiliaries,
# articles, prepositions or fillers) is thin.  The owner's #4 was a fragment of a dozen words with
# five substantive ones; the real answers of that call had nine or more.
THIN_WORDS = 7
# A decline is only a decline when it is short: "I'd rather not name the company, but I sold
# courses for six years ..." answers the question.
DECLINE_MAX_WORDS = 12
# How often one objective is asked again for a turn that did not answer it before the plan moves on
# anyway (the phone's lesson: a decline is final and a re-ask is capped, so nothing loops).
MAX_HOLDS = 2
# One follow-up per objective for a thin answer.
MAX_FOLLOW_UPS = 1
# "Let me think" gets this, and nothing else (the phone's patience line).
TAKE_YOUR_TIME = "Take your time."

_OFF_VALUES = frozenset({"0", "off", "false", "no"})


def icebreaker_plan_enabled() -> bool:
    """``R1_ICEBREAKER_PLAN`` (default on).  Rollback: ``fly secrets set R1_ICEBREAKER_PLAN=0``."""
    return (os.getenv("R1_ICEBREAKER_PLAN") or "1").strip().lower() not in _OFF_VALUES


# M032 live simulation, diagnosis 3 (D3-IB-REASK1): int-live-3 M10 heard one question three times in
# 30 s ("Sorry, thank you." and "Hey, are you there?" each got it again).  With ``R1_IB_REASK_V2``
# a question is re-asked once at most: a second turn that does not answer it moves the plan on.
REASK_V2_MAX_HOLDS = 1
# Review of diagnosis 3 (D3-IB-REASK1-SECOND-REPEAT): an explicit request to hear the question again
# ("Sorry, can you say that again?") is not a turn that answered nothing: up to this many per
# question get it word for word without using up the one hold (revision 28 repeated it twice too).
REASK_V2_MAX_REPEATS = 2


def ib_reask_v2_enabled() -> bool:
    """``R1_IB_REASK_V2`` (default on, only with ``R1_ICEBREAKER_REPAIR``; D3-IB-REASK1).

    One re-ask per question (``REASK_V2_MAX_HOLDS``; an explicit repeat request does not use it up,
    ``REASK_V2_MAX_REPEATS``), a backchannel or courtesy right after her question gets no reply (a
    bare yes, no or verdict word does), "Are you there?" just after it gets "Yes, I'm here. Take
    your time." (no question), and a request to repeat it gets that question word for word ("Of
    course. {question}"), scripted.  Read at use.  Rollback: ``fly secrets set R1_IB_REASK_V2=0 -a
    project-hello-voice`` (content revision 28's re-asks).
    """
    return icebreaker_repair_enabled() and (
        (os.getenv("R1_IB_REASK_V2") or "1").strip().lower() not in _OFF_VALUES
    )


def max_holds() -> int:
    """How often one question is asked again before the plan moves on (``MAX_HOLDS``, or
    ``REASK_V2_MAX_HOLDS`` with ``R1_IB_REASK_V2``)."""
    return REASK_V2_MAX_HOLDS if ib_reask_v2_enabled() else MAX_HOLDS


# M032 live simulation, diagnosis 4 (D4-ICE-SKIP1): "Can we skip ahead to the role-play?" got the
# question just asked again, and "<an answer>. Now can we do the role-play?" threw the answer away
# and asked the question it had just answered.  With ``R1_IB_SKIP_V2`` a skip request that also
# answers is an answer (the plan moves on), a pure skip moves past the current question to the next
# one (never the same one again), and a second skip request leaves one more question before the
# brief.
SKIP_V2_CAP_AFTER = 2


def ib_skip_v2_enabled() -> bool:
    """``R1_IB_SKIP_V2`` (default on, only with ``R1_ICEBREAKER_PLAN``; D4-ICE-SKIP1).  Read at use.
    Rollback: ``fly secrets set R1_IB_SKIP_V2=0 -a project-hello-voice`` (content revision 30's skip
    handling and follow-up note)."""
    return icebreaker_plan_enabled() and (
        (os.getenv("R1_IB_SKIP_V2") or "1").strip().lower() not in _OFF_VALUES
    )


# M032 live simulation, diagnosis 4 (D4-IB-QUIET-NUDGE): "Thank you." right after her question got
# no reply (D3-IB-REASK1) and then 30 s of silence and "Are you still with me?" seconds after the
# candidate had spoken.  With ``R1_IB_QUIET_NUDGE`` the silence after such a quiet ack is shorter
# and she asks the same question once more, short, using the question's one re-ask.
IB_QUIET_NUDGE_SECONDS = 7.0
IB_QUIET_NUDGE_TEMPLATE = "So, {question}"
# The nudge is only promised with at least this much of the hard icebreaker budget left.
IB_QUIET_NUDGE_MIN_BUDGET_SECONDS = 20.0
_NUDGE_LEAD_RE = re.compile(
    r"^(?:(?:and|so|now|okay|ok|right|also|but|well|alright|got it|sure|then)\b[\s,]*)+",
    re.IGNORECASE,
)
# Review of diagnosis 4 (NUDGE-LINE-CASING): the words an asking clause opens with.  Only these are
# lowered after "So," (a name or an acronym never is: "hDFC", "priya"), and a lead before the last
# clause that opens with one (a name, her own reaction: "HDFC sounds busy, what did you sell?") is
# left out of the nudge.
_NUDGE_QUESTION_WORDS = frozenset(
    {"what", "how", "which", "why", "where", "when", "who", "whose", "whom", "tell", "could", "can",
     "would", "will", "should", "do", "did", "does", "is", "are", "was", "were", "have", "has",
     "had", "walk", "talk", "share", "describe", "any", "anything"}
)
_NUDGE_MIN_WORDS = 2


def _first_word(text: str) -> str:
    words = re.findall(r"[a-z']+", text.lower())
    return words[0] if words else ""


def ib_quiet_nudge_enabled() -> bool:
    """``R1_IB_QUIET_NUDGE`` (default on, only with ``R1_IB_REASK_V2``; D4-IB-QUIET-NUDGE).  Read at
    use.  Rollback: ``fly secrets set R1_IB_QUIET_NUDGE=0 -a project-hello-voice`` (the 30 s window
    and "Are you still with me?" as before)."""
    return ib_reask_v2_enabled() and (
        (os.getenv("R1_IB_QUIET_NUDGE") or "1").strip().lower() not in _OFF_VALUES
    )


def quiet_nudge_line(question: str) -> str:
    """Her question once more, short: "So, what does a typical day look like?".  A lead-in word of
    her own ("And", "Right,") is dropped, and so is a lead before the asking clause ("Priya, what
    ..." -> "So, what ...").  Only a question word is lowered (never a name or an acronym), and a
    question with under two words left gives no nudge ("")."""
    rest = _NUDGE_LEAD_RE.sub("", str(question or "").strip()).strip()
    clauses = rest.split(", ")
    for index in range(len(clauses) - 1, 0, -1):
        if _first_word(clauses[index]) in _NUDGE_QUESTION_WORDS:
            rest = ", ".join(clauses[index:])
            break
    if len(re.findall(r"[A-Za-z0-9']+", rest)) < _NUDGE_MIN_WORDS:
        return ""
    head = rest.split()[0]
    if head[:1].isupper() and not head.isupper() and _first_word(head) in _NUDGE_QUESTION_WORDS:
        rest = rest[:1].lower() + rest[1:]
    return IB_QUIET_NUDGE_TEMPLATE.format(question=rest)


# M032 live simulation, diagnosis 4 (D4-SIL-IB1): 30 s of silence after an open icebreaker question
# got only "Are you still with me?".  With ``R1_SIL_IB_RESTATE`` the first silence prompt restates
# what she asked (one scripted line per objective, L-SIL-IB-<id>), and "Are you still with me?" is
# kept for a second silence.
def sil_ib_restate_enabled() -> bool:
    """``R1_SIL_IB_RESTATE`` (default on, only with ``R1_IB_REASK_V2``, which tracks an open
    question).  Read at use.  Rollback: ``fly secrets set R1_SIL_IB_RESTATE=0 -a
    project-hello-voice`` (L-SIL-IB alone, as before)."""
    return ib_reask_v2_enabled() and (
        (os.getenv("R1_SIL_IB_RESTATE") or "1").strip().lower() not in _OFF_VALUES
    )


def silence_line_id(objective: Objective | None) -> str:
    """The first silence prompt for an open question of ``objective`` (L-SIL-IB-<id>), or L-SIL-IB
    once every objective is reached."""
    return "L-SIL-IB" if objective is None else f"L-SIL-IB-{objective.id}"


@dataclass(frozen=True)
class Objective:
    """One thing an icebreaker question is for.

    ``goal`` is what the model is told to reach, in its own words (quoted in the note, so the
    guard's echo check never treats it as instruction prose).  ``restate`` is the question Christy
    says when her whole reply was blocked or failed, instead of "Sorry, what were you saying?".
    ``covers`` says, narrowly, that an answer already reached this objective (it is then skipped):
    "this role because ...", never "the job because ..." (a past job; review of S5).
    """

    id: str
    goal: str
    restate: str
    covers: re.Pattern[str] | None = None


OBJECTIVES: tuple[Objective, ...] = (
    Objective(
        "I1",
        "their background, especially any sales or customer-facing work",
        "Could you tell me a bit about your background, especially any sales or customer-facing "
        "work?",
    ),
    Objective(
        "I2",
        "what a typical day, or a typical conversation with a customer, looks like in their sales "
        "work",
        "What does a typical day, or a typical conversation with a customer, look like in your "
        "sales work?",
        re.compile(
            r"\b(?:(?:a|my|the) (?:typical|normal|usual) (?:day|week|call|conversation)|"
            r"my day (?:starts|begins|usually)|every (?:day|morning) i|"
            r"on a (?:daily|typical) basis)\b"
        ),
    ),
    Objective(
        "I3",
        "what draws them to this role",
        "What draws you to this role?",
        re.compile(
            r"\b(?:this (?:role|job|position|opportunity) (?:because|since|appeals|"
            r"excites|interests)|why i (?:applied|want this|chose this)|what (?:draws|attracts|"
            r"excites) me|(?:that's|that is) why i(?:'m| am) (?:opting|applying|interested)|"
            r"i(?:'m| am)? ?(?:applied|applying) (?:for this|here) because)\b"
        ),
    ),
    Objective(
        "I4",
        "one moment with a customer that they are proud of",
        "Could you tell me about one moment with a customer that you're proud of?",
        re.compile(
            r"\b(?:i(?:'m| am| was| felt) (?:really |very |most |so )?proud|proudest|"
            r"my (?:best|biggest) (?:moment|achievement|win))\b"
        ),
    ),
)
OBJECTIVE_BY_ID = {objective.id: objective for objective in OBJECTIVES}
# Once every objective is reached, Christy follows up on something they already said.
FREE_RESTATE = "Could you tell me a little more about your sales work?"

# The per-turn note.  It replaces the getting-to-know-you note while the plan is on: it keeps that
# note's guard rails word for word and no longer names this part of the interview (the owner's #7
# read the old label back: "we're still in the getting-to-know-you part").
PLAN_NOTE_HEAD = (
    "INTERVIEW NOTE (not spoken; never mention it, and never name or describe this part of the "
    "interview). You are getting to know the candidate, one question at a time."
)
PLAN_NOTE_TAIL = (
    "Ask nothing about selling scenarios, prices or how they would handle a learner. Never "
    "start, announce, describe or hint at the role-play, never say the interview is moving on "
    "or ending, and never say goodbye: the interview moves on by itself."
)
# The tail of a note that asks for the warm "you will get there soon" clause (a request to skip
# ahead): the same rails, with that one clause excepted, so the note never contradicts itself
# (review of S5).
PLAN_NOTE_TAIL_SKIP = (
    "Ask nothing about selling scenarios, prices or how they would handle a learner. Apart from "
    "that one warm clause, never start, announce, describe or hint at the role-play, never say "
    "the interview is moving on or ending, and never say goodbye: the interview moves on by "
    "itself."
)
ASKED_NOTE = "They asked you something: answer it first, in one short sentence, then go on."
SKIP_NOTE = (
    "They also asked to skip ahead: say warmly, in one short clause, that you will get there "
    'soon, without naming any part of the interview. Never start with "I understand, but".'
)
JOB_NOTES: dict[str, str] = {
    JOB_ASK: (
        "React in a few words to one specific thing they just said, then ask one short "
        'question, in your own words, that gets at this: "{goal}".'
    ),
    JOB_FOLLOW_UP: (
        "Their answer was short. React in a few words to what they said, then ask one short "
        "follow-up on the same subject, for instance for one concrete example. The subject: "
        '"{goal}".'
    ),
    JOB_REASK: (
        "They have not answered your question yet. If they asked you something, answer it "
        "first in one short sentence; then ask your question again, simply and in other "
        'words: "{goal}".'
    ),
    JOB_SKIP: (
        "They asked to skip ahead. Say warmly, in one short clause, that you will get there "
        "soon, without naming any part of the interview, then ask your question again: "
        '"{goal}". Never start with "I understand, but".'
    ),
    JOB_DECLINED: (
        "They would rather not answer that, and that is fine: accept it in a few words, "
        "without pressing or asking again, then ask one short question, in your own words, "
        'that gets at this: "{goal}".'
    ),
    JOB_FREE: (
        "React in a few words to one specific thing they just said, then ask one short "
        "follow-up question about something they already told you about their sales or "
        "customer-facing work."
    ),
}
# D4-ICE-SKIP1 (``R1_IB_SKIP_V2``): a pure skip request moves on to the NEXT objective (never the
# same one again), and a thin answer's follow-up asks for one detail of what they said, never the
# original question again (int-live-4: "Just one more for now: walk me through a typical day").
JOB_SKIP_V2_NOTE = (
    "They asked to skip ahead. Say warmly, in one short clause, that you'll get there in a couple "
    "of minutes, then ask one short question, in your own words, that gets at this: \"{goal}\". "
    'Never start with "I understand, but".'
)
FREE_SKIP_V2_NOTE = (
    "They asked to skip ahead. Say warmly, in one short clause, that you'll get there in a couple "
    "of minutes, then ask one short follow-up question about something else they already told you "
    'about their sales or customer-facing work. Never start with "I understand, but".'
)
SKIP_NOTE_V2 = (
    "They also asked to skip ahead: say warmly, in one short clause, that you'll get there in a "
    'couple of minutes, without naming any part of the interview. Never start with "I '
    'understand, but".'
)
JOB_FOLLOW_UP_V2_NOTE = (
    "Their answer was short. Ask for one concrete detail of what they just said, in one short "
    'question; do not ask the original question again. The subject: "{goal}".'
)
# M032 live simulation, diagnosis 4 (D4-ICE-ECHO1, ``R1_REACTION_VARIETY_V2``): "React in a few
# words to one specific thing they just said" made 57% of her icebreaker questions open with "Right,
# <their words>.".  Most turns need no reaction: the question is tied to what they said instead.
REACTION_V2_NOTES: dict[str, str] = {
    JOB_ASK: (
        "Ask one short question, in your own words, that gets at this: \"{goal}\". Tie it to one "
        "specific thing they just said; a word or two of reaction at most, never their words back."
    ),
    JOB_FREE: (
        "Ask one short follow-up question about something they already told you about their sales "
        "or customer-facing work, tied to what they just said; a word or two of reaction at most, "
        "never their words back."
    ),
}
# D4-ICE-HOLD1 (``R1_IB_HOLD_V2``): a request to wait was refused ("I'd rather keep us on
# track"); a pause request is always granted.
HOLD_NOTE = 'If they ask you to wait or pause, never refuse: say "Of course, take your time."'
# Once every objective is reached (or the last one was declined) there is no objective to quote,
# but a decline is still accepted, and a request to hear the question again or to skip ahead still
# gets the last question again (review of S5: the phone's "a decline never loops" and "a repeat
# restates the current item" held only while an objective was left).
FREE_JOB_NOTES: dict[str, str] = {
    JOB_DECLINED: (
        "They would rather not answer that, and that is fine: accept it in a few words, "
        "without pressing or asking again, then ask one short follow-up question about "
        "something else they already told you about their sales or customer-facing work."
    ),
    JOB_REASK: (
        "They have not answered your last question yet. If they asked you something, answer it "
        "first in one short sentence; then ask your last question again, simply and in other "
        "words."
    ),
    JOB_SKIP: (
        "They asked to skip ahead. Say warmly, in one short clause, that you will get there "
        "soon, without naming any part of the interview, then ask your last question again, "
        'simply. Never start with "I understand, but".'
    ),
}
# The holds counter of the free follow-ups (no objective of its own).
_FREE_HOLDS = "free"

# --- reading one turn -------------------------------------------------------------------------


def _plain(text: object) -> str:
    """Lower-case words separated by single spaces, apostrophes kept inside a word."""
    folded = re.sub(r"[^a-z0-9']+", " ", fold(text).lower())
    return " ".join(word.strip("'") for word in folded.split() if word.strip("'"))


# Words that carry no answer by themselves.  Content words, numbers and names are what is left.
_FUNCTION_WORDS = frozenset(
    {
        "i", "me", "my", "mine", "myself", "we", "us", "our", "you", "your", "he", "him", "his",
        "she", "her", "it", "its", "they", "them", "their", "this", "that", "these", "those",
        "a", "an", "the", "and", "or", "but", "so", "because", "as", "if", "then", "than",
        "to", "of", "in", "on", "at", "for", "with", "from", "by", "about", "into", "up", "out",
        "is", "am", "are", "was", "were", "be", "been", "being", "do", "does", "did", "have",
        "has", "had", "will", "would", "can", "could", "shall", "should", "may", "might", "must",
        "i'm", "i've", "i'll", "i'd", "it's", "that's", "there's", "don't", "didn't", "can't",
        "just", "like", "um", "umm", "uh", "er", "erm", "hmm", "yeah", "yes", "okay", "ok",
        "well", "also", "very", "really", "actually", "basically", "there", "here", "what",
        "which", "who", "how", "when", "where", "why", "all", "some", "any", "not", "no",
        "etc", "thing", "things", "kind", "sort", "lot", "go", "going", "get", "got", "ahead",
        "will", "sure", "right", "sorry", "please", "now", "then", "too",
    }
)


def substantive_words(text: object) -> int:
    """How many words of ``text`` carry content (``_FUNCTION_WORDS`` left out)."""
    return sum(1 for word in _plain(text).split() if word not in _FUNCTION_WORDS)


_FILLER_WORDS = frozenset(
    {
        "um", "umm", "uh", "uhh", "er", "erm", "hmm", "hm", "mm", "well", "okay", "ok", "so",
        "sorry", "yeah", "yes", "right", "alright", "actually", "just", "oh", "ah", "please",
        "christy", "ma'am", "madam", "sir",
    }
)
# "Let me think", "give me a second", "one moment please", "I'm just thinking": a thinking
# statement, only when it is (nearly) the whole turn.  NOT "let me check" (the phone map's
# correction: "I can check with my manager" is a move in the role-play, and it is ambiguous here).
_THINKING_RE = re.compile(
    r"\b(?:let me (?:just )?(?:think|see|gather my thoughts|collect my thoughts)|"
    r"give me (?:a|one) (?:moment|second|sec|minute)|"
    r"(?:one|a|just a) (?:moment|second|sec|minute)|"
    r"(?:i'm|i am|im) (?:just )?thinking|"
    r"(?:i )?need (?:a|one) (?:moment|second|minute)(?: to think)?|"
    r"hold on)\b"
)
# What may follow the thinking phrase and keep the turn a thinking statement.
_THINKING_TAIL_RE = re.compile(
    r"\b(?:about (?:it|that|this|the question)|for a (?:moment|second|sec|minute|bit)|"
    r"(?:about )?how (?:to|i'd|i would|i should) (?:put|phrase|say|word|answer) (?:it|this|that)|"
    r"to think)\b"
)
# A request to skip ahead.  Narrow: it needs a role-play object, or "skip ahead" / the
# introductions named as the thing to skip ("I ran role plays for new joiners" asks nothing).
_ROLEPLAY_OBJECT = (
    r"(?:the )?(?:role ?play(?:ing)?|roleplay(?:ing)?|main (?:part|round|task|exercise)|"
    r"simulation|actual (?:task|round|exercise)|mock (?:call|interview|round))(?: part| round)?"
)
_SKIP_RE = re.compile(
    r"\b(?:"
    r"(?:can|could|shall|may) we (?:just |please |directly )?(?:go|move|skip|jump|get|head|"
    r"proceed)(?: on)?(?: directly| straight| right)?(?: ahead)? (?:to|into) " + _ROLEPLAY_OBJECT
    + r"|(?:let's|let us|i'd like to|i want to|i would like to|can i|can we) (?:just )?"
    r"(?:start|begin|do|go to|skip to|jump to|move to|get to) (?:with )?(?:the )?"
    + _ROLEPLAY_OBJECT
    + r"|(?:go|jump|move|skip) (?:directly|straight|right) (?:to|into) " + _ROLEPLAY_OBJECT
    + r"|skip (?:ahead|the (?:intro|introductions?|small talk|getting to know))"
    r")\b"
)
# "I'd rather not say", "nothing comes to mind", "I can't think of one": declining this question.
# "I don't have one" / "I can't recall any" decline only when the thing they lack is the question's
# own (one, an example, a specific moment) and nothing but a filler follows it: "I don't have any
# sales experience" and "I don't have one fixed routine, I call leads" answer (review of S5).
_DECLINE_OBJECT = (
    r"(?:one|any|anything(?: specific| in particular| like that)?|an example|"
    r"any (?:such |specific |particular |good )?(?:examples?|moments?|stories|story|instances?)|"
    r"a (?:specific|particular|good)(?: (?:one|example|moment|story|instance|time))?|"
    r"such (?:a|an) (?:example|moment|story|instance))"
)
_DECLINE_END = (
    r"(?=(?: (?:right now|at the moment|off the top of my head|to be honest|honestly|really|"
    r"sorry|i'm afraid|that i can think of|that comes to mind|can we move on|let's move on|"
    r"next question)){0,3}$)"
)
_DECLINE_RE = re.compile(
    r"\b(?:"
    r"(?:i'd|i would|id) (?:rather|prefer to) not (?:say|share|talk|answer|discuss|go into|get "
    r"into)"
    r"|(?:don't|do not|dont) (?:want|wish|like) to (?:talk|say|share|answer|discuss|go into|"
    r"get into)"
    r"|(?:prefer|rather) not to (?:say|share|answer|discuss|talk)"
    r"|(?:can|could) (?:we|i) (?:skip|pass on) (?:this|that|it)(?: one| question)?"
    r"|(?:i'll|i will|let me) (?:skip|pass on) (?:this|that|it)"
    r"|(?:nothing|none) (?:really |specific |in particular )?comes to mind"
    r"|(?:(?:can't|cannot|cant|can not) (?:really )?(?:think of|recall|remember)|"
    r"(?:don't|do not|dont) (?:really )?(?:have|recall|remember)) " + _DECLINE_OBJECT
    + r"\b" + _DECLINE_END
    + r")\b"
)
# A question aimed at Christy (the phone lesson about directedness: a broad interrogative check
# fired on answer openings).  With a question mark: an interrogative opening that is not an answer
# opening ("What I do is ...", "How we start is ...").  Without one: the directed shape only, a
# question word with an auxiliary and "you" ("what do you mean", "how did you"), "what's your", or
# an auxiliary with "you" ("could you repeat that"); "What matters to me is that you ...", "What you
# get here is ..." and "When you're ready ..." are answers.  A bare "?" is never enough:
# speech-to-text marks rising answers with one.
_ASK_LEAD = r"^(?:(?:so|and|but|okay|ok|sorry|um|uh|yeah|yes|well|christy|actually|just) ){0,4}"
_ASK_WH = r"(?:what|why|how|where|who|which|when)"
_ASK_AUX = (
    r"(?:do|does|did|is|are|was|were|would|will|can|could|should|have|has|shall|may|might)"
    r"(?:n't)?"
)
_ASK_OPEN_RE = re.compile(
    _ASK_LEAD + r"(?:" + _ASK_WH + r"(?! (?:i|we)\b)|" + _ASK_AUX
    + r" (?:you|i|we|it|this|that|there|they|my)\b)"
)
_DIRECTED_RE = re.compile(
    _ASK_LEAD + r"(?:" + _ASK_WH + r" " + _ASK_AUX + r" (?:you|your)\b|" + _ASK_WH
    + r"(?:'s| is) your\b|" + _ASK_AUX + r" (?:you|your)\b)"
)


# "Yes.", "No, not really.", "Yeah, I have.": the whole answer to a closed question.  "Yeah." or
# "Okay." alone is a lead-in or a backchannel and stays a non-answer.
_YES_NO_RE = re.compile(
    r"^(?:yes|no|nope)(?: (?:not really|not yet|i have|i haven't|i did|i didn't|i do|i don't|"
    r"definitely|absolutely|of course|sure|exactly|correct|that's right))?$"
    r"|^(?:yeah|yep|yup) (?:not really|i have|i haven't|i did|i didn't|i do|i don't|definitely|"
    r"absolutely|of course|exactly|correct|that's right)$"
)


# A question the candidate asks themselves and answers in the same turn ("What do I do? I call
# leads ...", "Why sales? Because ...", review of S5): a "wh" question about themselves (I, me, my)
# or a bare "why" with a word or two, never one that names "you".
_WH_OPEN_RE = re.compile(_ASK_LEAD + _ASK_WH + r"\b")
_WHY_SHORT_RE = re.compile(_ASK_LEAD + r"why(?: [a-z']+){1,2}$")
_FIRST_PERSON = frozenset({"i", "me", "my", "myself", "i'm", "i've", "i'd", "i'll"})
_SECOND_PERSON = frozenset({"you", "your", "yours", "you're", "you've", "you'd", "you'll"})


def _sentence_asks(sentence: str) -> bool:
    plain = _plain(sentence)
    if not plain:
        return False
    if "?" in sentence:
        return _ASK_OPEN_RE.match(plain) is not None
    return _DIRECTED_RE.match(plain) is not None


def _self_question(sentence: str) -> bool:
    """A "wh" question about the candidate themselves, or a bare "why sales?"."""
    plain = _plain(sentence)
    words = set(plain.split())
    if words & _SECOND_PERSON or _WH_OPEN_RE.match(plain) is None:
        return False
    return bool(words & _FIRST_PERSON) or _WHY_SHORT_RE.match(plain) is not None


def _asking_sentences(text: object) -> list[tuple[str, bool]]:
    """Each sentence of ``text`` with whether it asks the interviewer something.

    A question the candidate asks themselves (``_self_question``) and answers with a statement
    in the same turn is the opening of their answer, not a question to Christy.
    """
    sentences = split_sentences(text)
    flags = [_sentence_asks(sentence) for sentence in sentences]
    for index, sentence in enumerate(sentences[:-1]):
        if flags[index] and not flags[index + 1] and _self_question(sentence):
            flags[index] = False
    return list(zip(sentences, flags))


def asks_christy(text: object) -> bool:
    """True when some sentence of ``text`` is a question aimed at the interviewer."""
    return any(asks for _, asks in _asking_sentences(text))


def _statement_substance(text: object) -> int:
    """Substantive words in the sentences of ``text`` that do not ask the interviewer anything."""
    return sum(
        substantive_words(sentence) for sentence, asks in _asking_sentences(text) if not asks
    )


def is_thinking(text: object) -> bool:
    """True for a turn that only says the candidate is thinking ("Let me think about that.")."""
    raw = str(text or "")
    if "?" in raw:
        return False
    plain = _plain(raw)
    if _THINKING_RE.search(plain) is None:
        return False
    # The tail first (review of S5): the head's "(a) second" would otherwise take "a second" out
    # of "for a second" and leave a bare "for".
    rest = _THINKING_RE.sub(" ", _THINKING_TAIL_RE.sub(" ", plain))
    return all(word in _FILLER_WORDS for word in rest.split())


@dataclass(frozen=True)
class Reading:
    """What one committed icebreaker turn is: a disposition, whether it asked Christy something,
    and whether it asked to skip ahead.  Labels only."""

    kind: str
    asked: bool = False
    skip: bool = False


def disposition(text: object, *, content_words: int) -> Reading:
    """Read one committed icebreaker turn.

    ``content_words`` is the session's count of the words that answer something
    (``r1_session.content_word_count``: backchannel words, repeat requests and audio checks are
    left out), so "Sorry, can you repeat that?" counts 0.
    """
    raw = str(text or "")
    plain = _plain(raw)
    if not plain:
        return Reading(NONANSWER)
    if is_thinking(raw):
        return Reading(THINKING)
    asked = asks_christy(raw)
    skip = _SKIP_RE.search(plain) is not None
    if skip:
        rest = substantive_words(_SKIP_RE.sub(" ", plain))
        # D4-ICE-SKIP1 (``R1_IB_SKIP_V2``): a skip request that also answers (THIN_WORDS or more
        # words outside the skip phrase) is that answer, read below with ``skip`` set.
        limit = THIN_WORDS if ib_skip_v2_enabled() else THIN_WORDS + 3
        if rest < limit:
            return Reading(SKIP, asked=asked, skip=True)
    if _DECLINE_RE.search(plain) is not None and content_words <= DECLINE_MAX_WORDS:
        return Reading(DECLINED, asked=asked)
    if content_words <= 0:
        if not asked and _YES_NO_RE.match(plain) is not None:
            return Reading(THIN)
        return Reading(NONANSWER, asked=asked)
    if asked and _statement_substance(raw) < THIN_WORDS:
        return Reading(NONANSWER, asked=True, skip=skip)
    if substantive_words(raw) < THIN_WORDS:
        return Reading(THIN, asked=asked, skip=skip)
    return Reading(ANSWERED, asked=asked, skip=skip)


# --- the plan ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class IcebreakerJob:
    """What Christy's reply to one icebreaker turn must do (labels and pinned text only).

    ``undo`` is the plan's state before this decision (counters, never text), so a reply that was
    never heard can be taken back (``IcebreakerPlan.reply_lost``).
    """

    kind: str
    disposition: str
    objective: Objective | None
    asked: bool
    skip: bool
    serial: int
    undo: tuple[Any, ...] = field(repr=False, default=())
    # D4-ICE-SKIP1 (``R1_IB_SKIP_V2``): the second skip request's reply is the icebreaker's last
    # question (the session ends the icebreaker at the answer to it).
    last: bool = False

    @property
    def scripted(self) -> str:
        """The whole reply when it is scripted ("Take your time."), else ""."""
        return TAKE_YOUR_TIME if self.kind == JOB_TAKE_TIME else ""

    @property
    def note(self) -> str:
        """The reminder for this reply ("" for the scripted one)."""
        if self.kind == JOB_TAKE_TIME:
            return ""
        skip_v2 = ib_skip_v2_enabled()
        reactions_v2 = _reaction_variety_v2()
        if self.objective is not None:
            template = JOB_NOTES[self.kind]
            if skip_v2 and self.kind == JOB_SKIP:
                template = JOB_SKIP_V2_NOTE
            elif skip_v2 and self.kind == JOB_FOLLOW_UP:
                template = JOB_FOLLOW_UP_V2_NOTE
            elif reactions_v2 and self.kind in REACTION_V2_NOTES:
                template = REACTION_V2_NOTES[self.kind]
            body = template.format(goal=self.objective.goal)
        elif skip_v2 and self.kind == JOB_SKIP:
            body = FREE_SKIP_V2_NOTE
        elif reactions_v2 and self.kind not in FREE_JOB_NOTES:
            body = REACTION_V2_NOTES[JOB_FREE]
        else:
            body = FREE_JOB_NOTES.get(self.kind, JOB_NOTES[JOB_FREE])
        lines = [PLAN_NOTE_HEAD, body]
        if self.skip and self.kind != JOB_SKIP:
            lines.append(SKIP_NOTE_V2 if skip_v2 else SKIP_NOTE)
        if self.asked and self.kind not in (JOB_REASK, JOB_SKIP):
            lines.append(ASKED_NOTE)
        if ib_hold_v2_enabled():
            lines.append(HOLD_NOTE)  # D4-ICE-HOLD1
        lines.append(PLAN_NOTE_TAIL_SKIP if self.skip or self.kind == JOB_SKIP else PLAN_NOTE_TAIL)
        return "\n".join(lines)

    @property
    def fallback(self) -> str:
        """The question said when the reply had nothing usable left (or the model failed)."""
        if self.kind == JOB_TAKE_TIME:
            return TAKE_YOUR_TIME
        return FREE_RESTATE if self.objective is None else self.objective.restate


class IcebreakerPlan:
    """The cursor over ``OBJECTIVES`` and the per-objective counters (no candidate text)."""

    def __init__(self) -> None:
        self.cursor = 0  # OBJECTIVES[0] is asked by L-OPEN (or by the opening agenda, M032 S7C)
        self.follow_ups: dict[str, int] = {}
        self.holds: dict[str, int] = {}
        self.repeats: dict[str, int] = {}  # D3-IB-REASK1-SECOND-REPEAT, per objective
        self.credited: list[str] = []
        self.jobs: dict[str, int] = {}
        self.serial = 0
        self.skips = 0  # D4-ICE-SKIP1: skip requests read so far

    @property
    def current(self) -> Objective | None:
        """The objective the last question was for (None once the plan is through)."""
        return OBJECTIVES[self.cursor] if self.cursor < len(OBJECTIVES) else None

    def _snapshot(self) -> tuple[Any, ...]:
        return (
            self.cursor,
            dict(self.follow_ups),
            dict(self.holds),
            list(self.credited),
            dict(self.jobs),
            dict(self.repeats),
            self.skips,
        )

    def _advance(self, text: str) -> None:
        """Move past the current objective, and past any later one the answer already reached."""
        self.cursor += 1
        plain = _plain(text)
        while self.cursor < len(OBJECTIVES):
            nxt = OBJECTIVES[self.cursor]
            if nxt.covers is None or nxt.covers.search(plain) is None:
                break
            self.credited.append(nxt.id)
            self.cursor += 1

    def _hold(self, current: Objective, reading: Reading, text: str) -> str:
        """The same objective again (bounded), or on to the next one once the holds are used."""
        if self.holds.get(current.id, 0) < max_holds():
            self.holds[current.id] = self.holds.get(current.id, 0) + 1
            return JOB_SKIP if reading.kind == SKIP else JOB_REASK
        self._advance(text)
        return JOB_ASK

    def _repeat(self, key: str, reading: Reading, repeat_asked: bool) -> bool:
        """D3-IB-REASK1-SECOND-REPEAT (``R1_IB_REASK_V2``): an explicit request to hear the question
        again is re-asked without using up the hold, ``REASK_V2_MAX_REPEATS`` times per question;
        past that it is an ordinary turn that answered nothing (the hold, then the next one)."""
        if not (repeat_asked and reading.kind == NONANSWER and ib_reask_v2_enabled()):
            return False
        if self.repeats.get(key, 0) >= REASK_V2_MAX_REPEATS:
            return False
        self.repeats[key] = self.repeats.get(key, 0) + 1
        return True

    def _free_job(self, reading: Reading, repeat_asked: bool = False) -> str:
        """The reply once every objective is reached: a decline is still accepted, and a turn
        that did not answer still gets the last question again (bounded like a hold)."""
        if reading.kind == DECLINED:
            return JOB_DECLINED
        if reading.kind == SKIP and ib_skip_v2_enabled():
            return JOB_SKIP  # D4-ICE-SKIP1: a follow-up about something else, never the same one
        if self._repeat(_FREE_HOLDS, reading, repeat_asked):
            return JOB_REASK
        if reading.kind in (NONANSWER, SKIP) and self.holds.get(_FREE_HOLDS, 0) < max_holds():
            self.holds[_FREE_HOLDS] = self.holds.get(_FREE_HOLDS, 0) + 1
            return JOB_SKIP if reading.kind == SKIP else JOB_REASK
        return JOB_FREE

    def next_job(
        self, text: str, *, content_words: int, repeat_asked: bool = False
    ) -> IcebreakerJob:
        """Decide what Christy's reply to this committed icebreaker turn is for.

        ``repeat_asked``: the session read the turn as a request to hear her question again
        (``r1_session.is_repeat_request``); with ``R1_IB_REASK_V2`` it does not use up the hold.
        """
        undo = self._snapshot()
        reading = disposition(text, content_words=content_words)
        current = self.current
        skip_v2 = ib_skip_v2_enabled()
        if skip_v2 and reading.skip:
            self.skips += 1
        if reading.kind == THINKING:
            kind = JOB_TAKE_TIME
        elif skip_v2 and reading.kind == SKIP and current is not None:
            # D4-ICE-SKIP1: past the current objective, never the same question again.
            self._advance(text)
            kind = JOB_SKIP
        elif current is None:
            kind = self._free_job(reading, repeat_asked)
        elif self._repeat(current.id, reading, repeat_asked):
            kind = JOB_REASK
        elif reading.kind == ANSWERED:
            self._advance(text)
            kind = JOB_ASK
        elif reading.kind == THIN and skip_v2 and reading.skip:
            self._advance(text)  # D4-ICE-SKIP1: a short answer with a skip request moves on
            kind = JOB_ASK
        elif reading.kind == THIN:
            if self.follow_ups.get(current.id, 0) < MAX_FOLLOW_UPS:
                self.follow_ups[current.id] = self.follow_ups.get(current.id, 0) + 1
                kind = JOB_FOLLOW_UP
            else:
                self._advance(text)
                kind = JOB_ASK
        elif reading.kind == DECLINED:
            self._advance(text)
            kind = JOB_DECLINED
        else:  # NONANSWER or SKIP: the same objective again, a bounded number of times
            kind = self._hold(current, reading, text)
        objective = self.current
        if kind == JOB_ASK and objective is None:
            kind = JOB_FREE  # a decline of the last objective stays a decline (FREE_JOB_NOTES)
        self.jobs[kind] = self.jobs.get(kind, 0) + 1
        self.serial += 1
        return IcebreakerJob(
            kind=kind,
            disposition=reading.kind,
            objective=None if kind == JOB_FREE else objective,
            asked=reading.asked,
            skip=reading.skip,
            serial=self.serial,
            undo=undo,
            last=skip_v2 and reading.skip and self.skips >= SKIP_V2_CAP_AFTER,
        )

    def can_hold(self) -> bool:
        """Review of diagnosis 4 (QUIET-NUDGE-SHORT-LADDER): the current question still has its
        re-ask (``use_hold`` would spend it); a peek that spends nothing."""
        current = self.current
        key = _FREE_HOLDS if current is None else current.id
        return self.holds.get(key, 0) < max_holds()

    def use_hold(self) -> bool:
        """D4-IB-QUIET-NUDGE: spend the current question's re-ask (``max_holds``) on a nudge after
        a quiet ack; False when it is used up (no nudge then)."""
        current = self.current
        key = _FREE_HOLDS if current is None else current.id
        if self.holds.get(key, 0) >= max_holds():
            return False
        self.holds[key] = self.holds.get(key, 0) + 1
        return True

    def reply_lost(self, job: IcebreakerJob) -> bool:
        """Undo ``job`` when its reply was never heard and nothing was decided after it.

        A reply the SDK cancelled before any word was heard asked nothing, so the objective it
        moved on to was never put to the candidate: the turn that follows (often the rest of the
        same answer) is decided against the objective before it.
        """
        if job.serial != self.serial or not job.undo:
            return False
        cursor, follow_ups, holds, credited, jobs, repeats, skips = job.undo
        self.cursor = cursor
        self.skips = skips
        self.follow_ups = dict(follow_ups)
        self.holds = dict(holds)
        self.repeats = dict(repeats)
        self.credited = list(credited)
        self.jobs = dict(jobs)
        self.serial += 1
        return True

    def summary(self) -> dict[str, Any]:
        """Counts and labels only (for the log line at the end of the icebreaker)."""
        return {
            "cursor": self.cursor,
            "reached": [objective.id for objective in OBJECTIVES[: self.cursor]],
            "credited": list(self.credited),
            "follow_ups": sum(self.follow_ups.values()),
            "holds": sum(self.holds.values()),
            "jobs": dict(self.jobs),
        }

    def log_labels(self) -> tuple[str, str]:
        """The end-of-icebreaker log line's category and schema: fixed words and counts only."""
        summary = self.summary()
        reached = len(summary["reached"])
        follow_ups = summary["follow_ups"]
        holds = summary["holds"]
        credited = len(summary["credited"])
        return (
            f"reached_{reached}",
            f"follow_ups_{follow_ups}_holds_{holds}_credited_{credited}",
        )


# --- the icebreaker repair (M032 S6, SWEEP-28) ------------------------------------------------
#
# Owner tests b419d478 and a95398ab (paraphrased): a request to repeat Christy's question at the
# soft exit got the brief instead, and a request for a minute's pause got "I can't pause" and a new
# question in one breath.  The session decides WHEN these apply (``r1_session``); the pieces here
# are pure: the hold-request reader, the question a repeat request gets again, and the opener note
# a reply to "Are you there?" gets.  ``R1_ICEBREAKER_REPAIR=0`` turns all of it off.


def icebreaker_repair_enabled() -> bool:
    """``R1_ICEBREAKER_REPAIR`` (default on).  Rollback: ``fly secrets set R1_ICEBREAKER_REPAIR=0
    -a project-hello-voice`` (the icebreaker's repeat, presence and hold handling as before)."""
    return (os.getenv("R1_ICEBREAKER_REPAIR") or "1").strip().lower() not in _OFF_VALUES


def ib_hold_v2_enabled() -> bool:
    """``R1_IB_HOLD_V2`` (default on, only with ``R1_ICEBREAKER_REPAIR``; M032 diagnosis 4,
    D4-ICE-HOLD1, given its own flag by the review of diagnosis 4, NO-ISOLATED-ROLLBACK): the wider
    hold reader ("could you just hold this for a minute?", "can we pause for a second?"), a turn
    whose LAST sentence is a direct request for a moment, and the plan note's "never refuse a
    pause" line (``HOLD_NOTE``).  Read at use.  Rollback: ``fly secrets set R1_IB_HOLD_V2=0 -a
    project-hello-voice`` (revision 30's hold reader and plan notes exactly; the rest of the
    icebreaker repair stays on)."""
    return icebreaker_repair_enabled() and (
        (os.getenv("R1_IB_HOLD_V2") or "1").strip().lower() not in _OFF_VALUES
    )


# After "Can you give me a minute?", the next silence window (once per session), never longer than
# the icebreaker's hard budget; with less than ``HOLD_MIN_BUDGET_SECONDS`` of it left nothing is
# promised and the turn ends the icebreaker.
ICEBREAKER_HOLD_WAIT_SECONDS = 60.0
HOLD_MIN_BUDGET_SECONDS = 15.0
# Christy's question again, for a request to repeat it once the soft exit is due (a runtime
# template: ``{question}`` is the last question of her own last model reply).
IB_REPEAT_TEMPLATE = "Of course. {question}"
# M032 live simulation, diagnosis 2 (D2-IB1, R1_TRANSITION_REPAIR): in the transition, a request
# that turns her repeated question down ("No, I mean the question before last") gets the one
# before it, or, with none older kept, the same question named once more.
IB_REPEAT_OLDER_TEMPLATE = "Sure, the one before that: {question}"
IB_REPEAT_SAME_TEMPLATE = "That one was: {question}"
# The opener of a model reply to a turn that checks she is there (the quoted words are dropped
# from the guard's echo check), and its apology after a wait of ``PRESENCE_LATE_SECONDS`` or more.
PRESENCE_OPENER_NOTE = 'If they asked whether you are there, start with "Yes, I\'m here."'
PRESENCE_OPENER_NOTE_LATE = (
    'If they asked whether you are there, start with "Sorry about that, yes, I\'m here."'
)
PRESENCE_LATE_SECONDS = 6.0
# D3-IB-REASK1 (R1_IB_REASK_V2): "Are you there?" this soon after her question finished playing gets
# this, scripted, once per question: the question is still fresh, so it is not asked again.
IB_PRESENCE_HOLD = "Yes, I'm here. Take your time."
IB_PRESENCE_HOLD_SECONDS = 20.0

# A request for a moment ("Can you give me a minute?", "Hold on a sec", "Can we pause?").  Narrow
# and DIRECTED (review of S6): "give me", "wait" and "hold" need a time object ("give me an
# example", "wait for my answer" and "hold that thought" are not holds), and "wait"/"hold" a
# request shape too: a modal ("can you wait a minute"), "please", or the start of the turn ("Wait
# a minute, please.").  So "I usually wait a minute and then follow up" and "I hold on for a second
# and let them vent" are answers, as are "there was a pause in my career" and "I hold on to my
# customers".  "Pause" and "hold on" stand alone only as a request or at the start of the turn.
_HOLD_TIME = r"(?:a|one|just a|a quick|a short) (?:minute|moment|second|sec|bit)"
_HOLD_MODAL = r"(?:(?:can|could|would|will) you (?:please |just |kindly )?|please |just )"
# D4-ICE-HOLD1: "could you just hold this for a minute?" has an object between the verb and the
# time.
_HOLD_OBJECT = r"(?: (?:this|it|that|on|things|the interview|the call))?"
_HOLD_RE = re.compile(
    r"\b(?:"
    + _HOLD_MODAL + r"?give (?:me|us) " + _HOLD_TIME
    + r"|(?:" + _HOLD_MODAL + r"|(?:can|could) we (?:please |just )?)(?:wait|hold(?: on)?|pause)"
    + _HOLD_OBJECT + r"(?: for)? " + _HOLD_TIME
    + r"|(?:can|could|may) (?:i|we) (?:please |just )?(?:have|take|get) a (?:quick |short )?"
    r"(?:minute|moment|second|sec|break)"
    r"|(?:can|could|would|will) (?:you|we) (?:please |just |quickly )?"
    r"(?:pause|take a (?:quick |short )?break)"
    r"|(?:please|let's|let us) (?:pause|take a (?:quick |short )?break)"
    r")\b"
    r"|^(?:(?:sorry|um|uh|okay|ok|oh|yeah|just|christy|ma'am|madam|sir|hey) )*"
    r"(?:(?:wait|hold(?: on)?)" + _HOLD_OBJECT + r"(?: for)? " + _HOLD_TIME + r"|hold on|pause)\b"
)
# Revision 30's reader exactly (``R1_IB_HOLD_V2=0``, review of diagnosis 4: NO-ISOLATED-ROLLBACK).
_HOLD_RE_V1 = re.compile(
    r"\b(?:"
    + _HOLD_MODAL + r"?give (?:me|us) " + _HOLD_TIME
    + r"|" + _HOLD_MODAL + r"(?:wait|hold(?: on)?)(?: for)? " + _HOLD_TIME
    + r"|(?:can|could|may) (?:i|we) (?:please |just )?(?:have|take|get) a (?:quick |short )?"
    r"(?:minute|moment|second|sec|break)"
    r"|(?:can|could|would|will) (?:you|we) (?:please |just |quickly )?"
    r"(?:pause|take a (?:quick |short )?break)"
    r"|(?:please|let's|let us) (?:pause|take a (?:quick |short )?break)"
    r")\b"
    r"|^(?:(?:sorry|um|uh|okay|ok|oh|yeah|just|christy|ma'am|madam|sir) )*"
    r"(?:(?:wait|hold(?: on)?)(?: for)? " + _HOLD_TIME + r"|hold on|pause)\b"
)
# The direct request shapes alone (a modal, "please", "let's"): the last sentence of a turn is read
# as a hold only in one of these, so "I hold on for a second and let them vent." never is.
_HOLD_DIRECT_RE = re.compile(
    r"\b(?:"
    + _HOLD_MODAL + r"?give (?:me|us) " + _HOLD_TIME
    + r"|(?:(?:can|could|would|will) you (?:please |just |kindly )?|please |(?:can|could) we "
    r"(?:please |just )?)(?:wait|hold(?: on)?|pause)" + _HOLD_OBJECT + r"(?: for)? " + _HOLD_TIME
    + r"|(?:can|could|may) (?:i|we) (?:please |just )?(?:have|take|get) a (?:quick |short )?"
    r"(?:minute|moment|second|sec|break)"
    r"|(?:can|could|would|will) (?:you|we) (?:please |just |quickly )?"
    r"(?:pause|take a (?:quick |short )?break)"
    r"|(?:please|let's|let us) (?:pause|take a (?:quick |short )?break)"
    r")\b"
)
# What may follow the hold phrase and keep the turn a hold request: its object and time ("pause
# this for a minute"), thinking ("to think", "to gather my thoughts") and "I'll be right back".
_HOLD_TAIL_RE = re.compile(
    r"\b(?:(?:this|it|the interview|the call) )?(?:for )?" + _HOLD_TIME
    + r"|(?:let me |i need to )?(?:to )?(?:think|gather my thoughts|collect my thoughts)"
    r"(?: about it| about that)?"
    r"|(?:i'll|i will) (?:just )?be (?:right )?back"
    r"|(?:this|it)\b"
)
# The only words allowed around the hold phrase once the tail is cut (an allowlist, as in
# ``is_thinking``): "Hold on, what was the question?", "Wait a minute, I didn't say that." and
# "Hold on a sec, are you there?" ask or say something of their own, and get it answered.
_HOLD_REST_WORDS = _FILLER_WORDS | frozenset(
    {"thanks", "thank", "you", "for", "me", "us", "quick", "quickly", "kindly", "now", "maam",
     "mam", "real", "hey"}
)
_HOLD_REST_WORDS_V1 = _HOLD_REST_WORDS - {"hey"}


def is_hold_request(text: object) -> bool:
    """True for a turn that asks Christy for a moment, and says nothing else.

    Every word left once the hold phrase and its tail (``_HOLD_TAIL_RE``) are cut must be a
    filler or a courtesy (``_HOLD_REST_WORDS``): "Give me a moment to explain: I sold software
    ..." is an answer, and "Hold on, can you repeat the question?" a repeat request.  Checked
    before ``disposition``, so a hold never takes S5's "Take your time." route.  With
    ``R1_IB_HOLD_V2`` (D4-ICE-HOLD1) a turn whose last sentence is a direct request for a moment
    is one too; what it said before that is still an answer (``hold_request_answer``).
    """
    plain = _plain(text)
    if not ib_hold_v2_enabled():
        if not plain or _HOLD_RE_V1.search(plain) is None:
            return False
        rest = _HOLD_TAIL_RE.sub(" ", _HOLD_RE_V1.sub(" ", plain))
        return all(word in _HOLD_REST_WORDS_V1 for word in rest.split())
    if not plain or _HOLD_RE.search(plain) is None:
        return False
    if _hold_only(plain):
        return True
    # D4-ICE-HOLD1: "Never mentioned it to anyone. Hey, could you just hold this for a minute?"
    # ends with a direct request for a moment; whatever came before it, the turn asks for one.
    return _before_a_closing_hold(text) is not None


def _before_a_closing_hold(text: object) -> str | None:
    """The sentences before a LAST sentence that is a direct request for a moment, or None."""
    sentences = [sentence for sentence in split_sentences(text) if _plain(sentence)]
    if len(sentences) < 2:
        return None
    last = _plain(sentences[-1])
    if _HOLD_DIRECT_RE.search(last) is None or not _hold_only(last):
        return None
    return " ".join(sentence.strip() for sentence in sentences[:-1]).strip()


def hold_request_answer(text: object) -> str:
    """Review of diagnosis 4 (HOLD-TAIL-DROPS-ANSWER, ``R1_IB_HOLD_V2``): what a hold request said
    before the direct request for a moment that ends it, or "" (a hold request alone, or a turn
    that is no hold request).

    "I sold home loans for three years. Could I have a moment?" asks for a moment AND answers: the
    session counts the answer, carries it to the plan and lets the bridge react to it.
    """
    if not ib_hold_v2_enabled() or _hold_only(_plain(text)):
        return ""
    before = _before_a_closing_hold(text)
    if not before or not is_hold_request(text):
        return ""
    words = _plain(before).split()
    if all(word in _HOLD_REST_WORDS or word in ("wait", "sorry", "okay", "ok") for word in words):
        return ""  # "Wait. Could you give me a minute?" said nothing else
    return before


def _hold_only(plain: str) -> bool:
    """Every word of ``plain`` (folded) is the hold phrase, its tail or a filler."""
    rest = _HOLD_TAIL_RE.sub(" ", _HOLD_RE.sub(" ", plain))
    return all(word in _HOLD_REST_WORDS for word in rest.split())


# A lead-in before the last ":" or " - " of a question ("Here's my next question: how ...").  It is
# cut only when what follows is itself a question's opening, so "What do you sell - courses or
# software?" stays whole.
_LEAD_IN_SEPARATORS = (":", " - ", " \u2013 ", " \u2014 ")


def repeat_question(text: object) -> str | None:
    """The last question of one of Christy's replies, ready to be said again, or None.

    The last sentence that ends with "?"; any lead-in before its last ":" or " - " is cut when
    what follows opens a question, and the first letter is capitalised.
    """
    asked = [sentence for sentence in split_sentences(text) if sentence.rstrip().endswith("?")]
    if not asked:
        return None
    question = asked[-1].strip()
    end = 0  # just past the last separator, 0 for none
    for sep in _LEAD_IN_SEPARATORS:
        at = question.rfind(sep)
        if at >= 0:
            end = max(end, at + len(sep))
    if end:
        rest = question[end:].strip()
        if rest and _ASK_OPEN_RE.match(_plain(rest)) is not None:
            question = rest
    if not _plain(question):
        return None
    return question[:1].upper() + question[1:]


# An imperative prompt that asks without a "?" ("Tell me about a customer conversation you're proud
# of."), as the last sentence of a reply the candidate heard in full.
_PROMPT_OPEN_RE = re.compile(
    r"^(?:(?:so|and|now|okay|ok|then) )?(?:please )?"
    r"(?:tell|describe|walk|share|talk|give|take) (?:me|us)\b"
)


def reply_question(text: object, *, complete: bool) -> str | None:
    """What a request to repeat Christy's question gets again, read from ONE reply of hers.

    Its last question (``repeat_question``), or, for a reply heard in full (``complete``) that
    asks with an imperative instead ("Tell me about ..."), that last sentence.  None for a reply
    that asked nothing the candidate heard (cut before its question, or a reaction only): the
    caller then falls back to the plan's current question.
    """
    question = repeat_question(text)
    if question is not None or not complete:
        return question
    sentences = [sentence.strip() for sentence in split_sentences(text) if sentence.strip()]
    if not sentences or _PROMPT_OPEN_RE.match(_plain(sentences[-1])) is None:
        return None
    last = sentences[-1]
    return last[:1].upper() + last[1:]


_CLOSED_OPEN_RE = re.compile(
    r"^(?:(?:so|and|or|but|okay|ok) )?" + _ASK_AUX + r" (?:you|your|it|that|this|there|they)\b"
)


def is_closed_question(question: object) -> bool:
    """True for a yes/no question ("Do you enjoy cold calls?"), which "Okay." or "Sure." can
    answer; "How do you keep track of your leads?" is open."""
    return _CLOSED_OPEN_RE.match(_plain(question)) is not None


def repeat_line(question: str) -> str:
    """``IB_REPEAT_TEMPLATE`` with ``question`` (``repeat_question``'s, or an objective's)."""
    return IB_REPEAT_TEMPLATE.format(question=question)


def presence_opener_note(*, waited: float | None) -> str:
    """The opener note for a reply to "Are you there?"; the apology after a long wait."""
    if waited is not None and waited >= PRESENCE_LATE_SECONDS:
        return PRESENCE_OPENER_NOTE_LATE
    return PRESENCE_OPENER_NOTE


# --- the transition bridge (M032 S5 item 4) ---------------------------------------------------
#
# The owner's #22 -> #23: a reflective last answer got only "Thank you, {first_name}." and then the
# 44 s brief.  The turn that ends the icebreaker gets no reply of its own (the boundary line answers
# it), so the reaction is composed out of band, under its own note, and spoken only when it is one
# plain sentence that asks nothing, thanks nobody, praises nothing and says nothing about what
# comes next.  Otherwise nothing extra is said and L-TRANSITION plays exactly as before.
#
# It ships OFF.  The plan allows about 1.5 s at the boundary.  The added silence before Christy's
# first word is the compose call (the whole sentence before any of it can be vetted), the first
# request on a client the replies have not warmed, and the live synthesis of a line the cache
# cannot hold, where today the cached brief starts at once.  An estimate from the owner's call
# fda9e9f6 (no live measurement was possible offline): Christy's generated icebreaker replies
# started 2.5-3.7 s after the candidate stopped (median 2.95 s, 8 replies), her cached lines
# 1.4-2.3 s (the brief itself 2.3 s).  That difference, plus a cold client, is about 1.2-1.8 s
# typically and up to about 2.6 s; a compose that times out is BRIDGE_TIMEOUT_SEC of extra
# silence and no reaction at all.  Measure ``transition_bridge`` and ``say_to_first_audio``
# (``transition_bridge``) on a test call before turning it on.
BRIDGE_NOTE = (
    "INTERVIEW NOTE (not spoken; never mention it). Reply with one short sentence, at most "
    "twelve words, that reacts warmly to one specific thing they just said. No question, no "
    "thanks, no praise or judgement of the answer, nothing about what comes next, and no "
    "goodbye."
)
# The compose budget, from the start of the call; a reaction that is later says nothing.
BRIDGE_TIMEOUT_SEC = 1.5
# A reaction is a few words about something they said ("Right." is not one), and short.
BRIDGE_MIN_WORDS = 4
BRIDGE_MAX_WORDS = 16
# What the brief already does or must not be pre-empted: what comes next, thanks, a goodbye.
# Broad on purpose: a word too many only means the brief plays without a reaction, as today.
_BRIDGE_FORWARD_RE = re.compile(
    r"\b(?:role ?plays?|roleplays?|role playing|next|move on|moving on|move (?:to|into|ahead)|"
    r"moving (?:to|into|ahead)|let's|let us|brings? us|interview|learner|scenario|brief|ready|"
    r"begin|start (?:the|our|with))\b"
)
_BRIDGE_THANKS_RE = re.compile(r"\b(?:thank you|thanks|thank|appreciate|grateful)\b")
_BRIDGE_GOODBYE_RE = re.compile(r"\b(?:goodbye|good bye|bye|farewell|take care|see you)\b")
_BRIDGE_QUOTES = "\"'\u201c\u201d\u2018\u2019 "
_ON_VALUES = frozenset({"1", "on", "true", "yes"})


def transition_bridge_enabled() -> bool:
    """``R1_TRANSITION_BRIDGE`` (default OFF: its boundary cost is above the plan's ~1.5 s).

    Turn it on with ``fly secrets set R1_TRANSITION_BRIDGE=1 -a project-hello-voice``; unset or
    ``0`` is today's transition exactly.
    """
    return (os.getenv("R1_TRANSITION_BRIDGE") or "0").strip().lower() in _ON_VALUES


def bridge_wanted(text: object, *, content_words: int) -> bool:
    """True when the answer that ended the icebreaker is one worth reacting to.

    Only a real answer (``disposition`` ANSWERED) that asks Christy nothing and asks to skip
    nothing: a fragment, a yes, "let me think", a question or a decline gets the brief alone.
    """
    reading = disposition(text, content_words=content_words)
    return reading.kind == ANSWERED and not reading.asked and not reading.skip


def clean_bridge(text: object, ctx: GuardContext) -> str | None:
    """The composed reaction when it may be spoken as it is, else None (nothing extra is said).

    One sentence of ``BRIDGE_MIN_WORDS`` to ``BRIDGE_MAX_WORDS`` words with no question mark, no
    thanks (the brief's own opener is gone, not moved), no goodbye, nothing about what comes next,
    no praise of the answer (``praise_detected``) and no hit of the output guard in ``ctx`` (the
    icebreaker's rules, with the echo check over the prompts in play).  Never rewritten: a
    sentence that needs an edit is dropped.
    """
    raw = " ".join(str(text or "").split()).strip(_BRIDGE_QUOTES)
    if not raw or "?" in raw or len(split_sentences(raw)) != 1:
        return None
    plain = _plain(raw)
    if not BRIDGE_MIN_WORDS <= len(plain.split()) <= BRIDGE_MAX_WORDS:
        return None
    for pattern in (_BRIDGE_FORWARD_RE, _BRIDGE_THANKS_RE, _BRIDGE_GOODBYE_RE):
        if pattern.search(plain) is not None:
            return None
    if praise_detected(raw) or check_sentence(raw, ctx):
        return None
    return raw
