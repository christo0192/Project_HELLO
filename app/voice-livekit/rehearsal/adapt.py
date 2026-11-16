"""The adaptability scenarios of the full-interview tier (D-M032-10).

The owner's goal is a bot with excellent conversational flow that adapts to every kind of
conversation while sticking to its objective.  These scenarios give it many kinds of candidate, each
with a ground truth the checks and the flow judge (``rehearsal.flow_judge``) can lean on:

* ``tangent``: drifts to unrelated topics in the icebreaker and the role-play;
* ``confused``: misunderstands the task and asks what to do;
* ``rambler``: very long monologue turns;
* ``one-worder``: one- or two-word answers everywhere;
* ``hinglish``: Hindi words mixed into English sentences;
* ``rude-not-abusive``: curt, impatient, sarcastic, never an insult;
* ``interrupter``: cuts in, short, while the bot is still speaking, and changes direction;
* ``off-script-advisor``: pitches a different course, asks the learner unrelated personal questions;
* ``manipulative-advisor``: false urgency, guilt and pressure;
* ``over-discounter``: drops the price again and again, absurdly;
* ``gives-up-midway``: wants to stop at R 6:00 and again at R 12:00 (declines when Christy asks);
* ``mid-roleplay-glitch``: "can you hear me?" and "sorry, I lost you" inside the role-play;
* ``argues-with-christy``: disputes the brief and the rules;
* ``late-ready``: asks many questions about the brief and says "ready" late.

Every candidate turn carries its ground-truth ``act`` and ``traits`` (how it is said: ``tangent``,
``ramble``, ``one_word``, ``hinglish``, ``rude``, ``interrupt`` ...).  Offline the talk is scripted
(answer banks, transforms of the scripted advisor's turns, word-for-word beats); live, DeepSeek plays
the candidate with the behaviour in its system prompt (``christy_style``) and as an overlay on the
advisor (``advisor_overlay``), and the beats are said word for word, so the behaviour always happens.
Every text here is synthetic.

Groups: ``adapt`` is every scenario of this module; ``default+adapt`` is ``default`` plus ``adapt``
(``all`` is unchanged: the synthetic scenarios).
"""
from __future__ import annotations

import random
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

from rehearsal.advisor import AdvisorTurn
from rehearsal.scenarios import (
    GROUPS,
    ICEBREAKER_ANSWERS,
    SCENARIOS,
    WRAP_DONE,
    Beat,
    RoleplayBeat,
    Scenario,
)
from rehearsal.sim import LEARNER, barge_in_sec

ADAPT_TAG = "adapt"
HINDI_WORDS = (
    "yaar", "achha", "matlab", "dekho", "theek hai", "na", "bas", "ekdum", "haan", "arre",
    "samjhe", "bilkul", "thoda", "ji", "kya",
)
HINDI_RE = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in HINDI_WORDS) + r")\b", re.IGNORECASE)
# Words a curt-but-not-abusive candidate never says (the abuse path must not be what it tests).
INSULT_RE = re.compile(
    r"\b(?:idiot|stupid|moron|dumb|shut up|get lost|useless|rubbish|damn|hell|crap|bloody)\b",
    re.IGNORECASE,
)


def words(text: str | None) -> int:
    return len(re.findall(r"[A-Za-z0-9$',]+", text or ""))


# ------------------------------------------------------------------ the offline answer banks
_STRONG = ICEBREAKER_ANSWERS["strong"]
_AVERAGE = ICEBREAKER_ANSWERS["average"]

TANGENT_ICEBREAKER = (
    ("icebreaker_answer", _AVERAGE[0], ()),
    (
        "tangent",
        "Sure. Oh, sorry, before that, did you see the cricket last night? India chased it down in "
        "the last over, I barely slept. Anyway, yes, I like talking to people, that's the main thing.",
        ("tangent",),
    ),
    ("icebreaker_answer", _AVERAGE[2], ()),
    (
        "tangent",
        "Honestly, the traffic this morning was crazy, ninety minutes for ten kilometres. I keep "
        "thinking I should move closer to the office. Sorry, I wanted to move into education sales, "
        "it feels more meaningful.",
        ("tangent",),
    ),
    ("icebreaker_answer", _AVERAGE[4], ()),
    (
        "tangent",
        "That reminds me, my cousin just opened a bakery and it's doing really well, the banana bread "
        "is amazing. Uh, follow-ups, yes, I use a spreadsheet and reminders.",
        ("tangent",),
    ),
    ("icebreaker_answer", _AVERAGE[6], ()),
)
CONFUSED_ICEBREAKER = (
    (
        "confused_question",
        "Sorry, what do you mean? Like, my last job, or why I applied here?",
        ("confused",),
    ),
    ("icebreaker_answer", _AVERAGE[0], ()),
    ("icebreaker_answer", _AVERAGE[1], ()),
    (
        "confused_question",
        "Sorry, is this still the interview part, or has the test started already?",
        ("confused",),
    ),
    ("icebreaker_answer", _AVERAGE[3], ()),
    ("icebreaker_answer", _AVERAGE[4], ()),
    ("icebreaker_answer", _AVERAGE[5], ()),
)
_RAMBLE_SIDES = (
    "And actually, now that I think about it, that was also the year I moved cities, so there was a "
    "lot going on, new flat, new commute, my parents visiting every other weekend, and somehow I "
    "still kept my numbers up, which honestly surprised me as much as anyone, because the first "
    "two months I was mostly just trying to find a decent place to eat near the office.",
    "I mean, I could go on about this for a while, because there's the whole question of how you "
    "build rapport over the phone when you can't see the person, and I've read a few books on it, "
    "one of them was really good, I forget the name, blue cover, but the gist was that you mirror "
    "their pace and you never rush the silence, which is easier said than done, right?",
    "And the funny part is, my manager at the time always said I talked too much on calls, which, "
    "fair, I probably do, but the customers seemed to like it, they'd call back asking for me by "
    "name, and one of them even sent a box of sweets at Diwali, which nobody on the team could "
    "believe, so I think there's something to be said for just being yourself on a call.",
)
RAMBLER_ICEBREAKER = tuple(
    ("icebreaker_answer", f"{answer} {_RAMBLE_SIDES[index % len(_RAMBLE_SIDES)]}", ("ramble",))
    for index, answer in enumerate(_STRONG)
)
ONE_WORD_ICEBREAKER = tuple(
    ("icebreaker_answer", text, ("one_word",))
    for text in ("Sales.", "Two years.", "Telecom.", "Money.", "Explain again.", "Spreadsheet.", "Targets.")
)
HINGLISH_ICEBREAKER = tuple(
    ("icebreaker_answer", text, ("hinglish",))
    for text in (
        "Haan, so basically I've been in sales for about three years, yaar. Matlab inside sales at an "
        "edtech company, mostly parents and working people.",
        "Achha, what I like most is the conversation itself. Dekho, when someone tells you what is "
        "really bothering them, that's when the call becomes easy, na?",
        "One time a customer was ekdum against paying, bilkul no. I just asked what he had tried "
        "before, and bas, he opened up and enrolled the next week.",
        "Honestly, I want a bigger ticket size, thoda more challenge. And Interview Kickstart has a "
        "good name, my friend works in edtech, he told me.",
        "Price objection, haan, I first check if it's really the price or something else. Matlab "
        "sometimes it's doubt about the outcome, not the money, na?",
        "Follow-ups I keep in the CRM, yaar, with notes on what the person cares about. Theek hai, "
        "sometimes I also use WhatsApp reminders.",
        "Targets were monthly, around forty enrolments. Achha, I usually hit them by the third week.",
    )
)
RUDE_ICEBREAKER = tuple(
    ("icebreaker_answer", text, ("rude",))
    for text in (
        "Sales. Obviously. It's all on my resume, did you not read it?",
        "Talking to people. Next question.",
        "Yeah, a customer wanted to cancel, I talked him out of it. Not exactly rocket science.",
        "Because the money's better. What else would it be?",
        "I explain it again, slower. Same as anyone would. Is that what you wanted to hear?",
        "Spreadsheet and reminders. Can we move this along?",
        "Monthly targets. I hit them. Anything else?",
    )
)

# ------------------------------------------------------------------ offline advisor transforms
_RAMBLE_EXTRAS = (
    "And honestly, I say this to everyone I talk to, because it's true, the thing that matters most "
    "isn't the syllabus, it's whether you actually stick with it week after week, and that's where "
    "the mentors come in, they check on you, they keep you honest, and that makes all the difference.",
    "I remember one learner last year, very similar situation to yours actually, working full time, "
    "two kids, and she was worried about the same things, and we talked for maybe an hour, and in the "
    "end she joined, and the last I heard she'd moved into an analyst role, which was lovely to hear.",
    "And you know, the market right now is a bit up and down, everyone's reading the news about "
    "layoffs and so on, but the people who keep learning are the ones who come out fine, that's what "
    "I've seen again and again, so I always say it's less about timing and more about preparation.",
)
_ONE_WORD_BY_INTENT = {
    "greet": ("Hello there.",),
    "probe": ("Why now?", "Tried before?", "Your schedule?"),
    "followup": ("Tell more.", "Go on."),
    "pitch": ("Six months.", "Live classes.", "Mentors included.", "Mock interviews."),
    "price": ("Nine thousand.",),
    "discount": ("Small discount.",),
    "urgency": ("Seats limited.",),
    "callback": ("Call tomorrow?",),
    "close_ask": ("Enrol today?",),
    "accept_callback": ("Sounds good.",),
    "farewell": ("Okay, bye.",),
}
_ONE_WORD_OTHER = ("Okay.", "Price?", "Why?", "Go on.", "Timing?", "Interested?", "Sure.", "Hmm.")
_HINGLISH_PREFIX = ("Dekho, ", "Achha, ", "Haan, ", "Arre, ", "Matlab, ")
_HINGLISH_SUFFIX = (" Theek hai?", " Samjhe na?", " Bilkul.", " Bas, simple.", " Achha?")
_RUDE_PREFIX = ("Look, ", "Yeah, whatever. ", "Wow, great question. ", "Obviously. ", "Right, sure. ")
_RUDE_SUFFIX = (" Can we speed this up?", " I don't have all day.", " Next.", " Is that clear enough?", "")


def two_words(text: str) -> str:
    """The first two words of a line, kept as a question when it was one."""
    parts = re.findall(r"[A-Za-z0-9$',]+", text or "")[:2]
    if not parts:
        return "Okay."
    end = "?" if "?" in (text or "") else "."
    return " ".join(parts).rstrip(",") + end


def _first_sentence(text: str) -> str:
    found = re.match(r"\s*([^.?!]+[.?!])", text or "")
    return (found.group(1) if found else (text or "")).strip()


def transform_ramble(text: str, n: int, _intent: str) -> str:
    out = text
    index = n
    while words(out) < 110:
        out = f"{out} {_RAMBLE_EXTRAS[index % len(_RAMBLE_EXTRAS)]}"
        index += 1
    return out


def transform_one_word(text: str, n: int, intent: str) -> str:
    bank = _ONE_WORD_BY_INTENT.get(intent) or _ONE_WORD_OTHER
    return bank[n % len(bank)]


def transform_hinglish(text: str, n: int, _intent: str) -> str:
    body = text.strip()
    if body:
        body = body[0].lower() + body[1:] if not body.startswith("I ") else body
    return f"{_HINGLISH_PREFIX[n % len(_HINGLISH_PREFIX)]}{body}{_HINGLISH_SUFFIX[n % len(_HINGLISH_SUFFIX)]}"


def transform_rude(text: str, n: int, _intent: str) -> str:
    return f"{_RUDE_PREFIX[n % len(_RUDE_PREFIX)]}{_first_sentence(text)}{_RUDE_SUFFIX[n % len(_RUDE_SUFFIX)]}".strip()


# ---------------------------------------------------------------------------- behaviours
@dataclass(frozen=True)
class Behaviour:
    """How one kind of candidate talks, phase by phase."""

    key: str
    trait: str  # the per-turn ground-truth trait of the behaviour
    christy_style: str  # live: how the candidate talks to Christy (the talker's system prompt)
    advisor_overlay: str  # live: appended to the advisor simulator's system prompt
    icebreaker: tuple[tuple[str, str, tuple[str, ...]], ...] = ()  # offline (act, text, traits)
    transform: Callable[[str, int, str], str] | None = None  # offline: every advisor turn
    live_transform: Callable[[str, int, str], str] | None = None  # live: enforced on every turn
    live_tasks: dict[str, str] = field(default_factory=dict)  # live: the talker's task per act


_NO_INSULT = "Never insult, swear at or call anyone names."
BEHAVIOURS: dict[str, Behaviour] = {}


def _behaviour(item: Behaviour) -> None:
    BEHAVIOURS[item.key] = item


_behaviour(Behaviour(
    "tangent", "tangent",
    "You are friendly but easily distracted. Answer in 30 to 60 words; in about half your answers "
    "you drift to an unrelated topic (cricket, traffic, food, the weather, your family) before "
    "coming back.",
    "You are easily distracted: every few turns, drift to something unrelated (cricket, traffic, "
    "the weather, food, a neighbour) for a sentence or two, then come back to the call.",
    icebreaker=TANGENT_ICEBREAKER,
    live_tasks={"tangent": "Start answering Christy's last question, then drift to an unrelated topic "
                "(cricket, traffic, food, the weather) for a sentence or two, then come back briefly."},
))
_behaviour(Behaviour(
    "confused", "confused",
    "You are unsure what is being asked. Answer in 15 to 40 words; you often ask what is meant "
    "before answering, and sometimes answer a slightly different question.",
    "You are unsure how this role-play works: now and then you ask what you are supposed to do or "
    "say, then carry on with the call.",
    icebreaker=CONFUSED_ICEBREAKER,
    live_tasks={"confused_question": "You did not understand Christy's last question. Ask her, in "
                "under 20 words, what she means; do not answer it yet."},
))
_behaviour(Behaviour(
    "rambler", "ramble",
    "You talk in very long monologues: 130 to 200 words per answer, run-on sentences, side "
    "stories about your life, before you finally get to the point.",
    "You talk in very long monologues: 120 to 180 words per turn, run-on sentences, side stories "
    "about other learners and your own life, before you get to your point.",
    icebreaker=RAMBLER_ICEBREAKER,
    transform=transform_ramble,
))
_behaviour(Behaviour(
    "one_word", "one_word",
    "You answer every question in ONE or TWO words, never more.",
    "Every turn is one or two words only ('Okay.', 'Price?', 'Why?', 'Six months.'), never more.",
    icebreaker=ONE_WORD_ICEBREAKER,
    transform=transform_one_word,
    live_transform=lambda text, _n, _intent: two_words(text),
))
_behaviour(Behaviour(
    "hinglish", "hinglish",
    "You are an Indian professional who mixes Hindi words in Roman script into English sentences "
    "(yaar, achha, matlab, dekho, theek hai, na, bas, ekdum, haan), about two per answer, 25 to 50 "
    "words.",
    "You mix Hindi words in Roman script into English sentences (yaar, achha, matlab, dekho, theek "
    "hai, na, bas, ekdum, haan), about two per turn.",
    icebreaker=HINGLISH_ICEBREAKER,
    transform=transform_hinglish,
))
_behaviour(Behaviour(
    "rude", "rude",
    "You are curt, impatient and sarcastic ('Obviously.', 'Next question.', 'Can we move this "
    f"along?'), 8 to 25 words. {_NO_INSULT}",
    "You are curt, impatient and sarcastic with the learner ('Look,', 'Can we speed this up?', "
    f"'Wow, great question.'), one or two short sentences. {_NO_INSULT}",
    icebreaker=RUDE_ICEBREAKER,
    transform=transform_rude,
))
_behaviour(Behaviour(
    "interrupter", "interrupt",
    "You are energetic and impatient; you answer in 20 to 45 words.",
    "You are impatient and change direction abruptly: you often drop one topic for another.",
))
_behaviour(Behaviour(
    "off_script", "off_script",
    "You are a confident salesperson; you answer in 30 to 60 words.",
    "You go off script: several times you pitch a different course (a web development bootcamp, an "
    "MBA) or ask the learner unrelated personal questions (family, where they live, their age).",
))
_behaviour(Behaviour(
    "manipulative", "manipulative",
    "You are a confident salesperson; you answer in 30 to 60 words.",
    "You use false urgency, guilt-tripping and pressure ('only one seat left', 'you'll regret it', "
    f"'I thought you were serious'). {_NO_INSULT}",
))
_behaviour(Behaviour(
    "over_discount", "over_discount",
    "You are a friendly salesperson; you answer in 25 to 50 words.",
    "You drop the price again and again, absurdly ($6,000, then $4,000, then $2,000 ...), without "
    "being asked.",
))
_behaviour(Behaviour(
    "gives_up", "gives_up",
    "You are a little unsure of yourself; you answer in 20 to 45 words.",
    "You lose confidence as the call goes on and sound tired of it.",
))
_behaviour(Behaviour(
    "glitch", "glitch",
    "You are an average candidate; you answer in 25 to 50 words.",
    "",
))
_behaviour(Behaviour(
    "argue", "argue",
    "You are a sceptical candidate who questions the process; you answer in 20 to 45 words.",
    "",
))
_behaviour(Behaviour(
    "late_ready", "late_ready",
    "You are a careful candidate; you answer in 30 to 60 words.",
    "",
))

# The candidate styles these behaviours give the talker (``rehearsal.candidate``): their answer
# banks (offline) and style texts (live) are registered by ``register``.
STYLE_OF = {
    "tangent": "tangent",
    "confused": "confused",
    "rambler": "rambler",
    "one_word": "one_word",
    "hinglish": "hinglish",
    "rude": "rude",
}

# ------------------------------------------------------------------------------ the cut-ins
ROLEPLAY_CUT_INS = (
    "Sorry, sorry, hold on. Forget that. What's your budget?",
    "Wait, wait, let me jump in. When would you want to start?",
    "Sorry to cut in, but have you looked at other courses?",
    "Hang on, quick question. Who else decides this with you?",
    "Sorry, let me jump in. What do you do right now?",
    "Okay, okay, got it. Can I tell you about the mentors?",
)
ICEBREAKER_CUT_INS = ("Sorry, can I just add one thing? I also led a small team last year.",)


class Interrupter:
    """Decides when the interrupter cuts in over a generated bot reply, and with what.

    A reply of ten words or more is eligible: in the role-play every third learner reply (at most
    ``MAX_ROLEPLAY``), in the icebreaker Christy's second reply (once).  The cut-in comes once the
    reply has played ``AT_FRACTION`` of its length, and only while enough of it is left for the
    voice to cut it (``barge_in_sec`` plus ``CUT_MARGIN_SEC``): a later cut-in would talk over a
    line that plays to its end, so that line is not cut in on at all.
    """

    AT_FRACTION = 0.4
    CUT_MARGIN_SEC = 0.4
    MIN_WORDS = 10
    EVERY = 3
    MAX_ROLEPLAY = 6
    MAX_ICEBREAKER = 1

    MARK = "_rehearsal_cut_in"  # set on each span once it was weighed: True (to cut) or False

    def __init__(self) -> None:
        self._eligible = {"roleplay": 0, "icebreaker": 0}
        self.fired = {"roleplay": 0, "icebreaker": 0}

    @staticmethod
    def _kind(phase: str, span: Any) -> str | None:
        if phase in ("roleplay", "aside") and span.voice == LEARNER:
            return "roleplay"
        if phase == "icebreaker" and span.voice != LEARNER:
            return "icebreaker"
        return None

    def due(self, phase: str, span: Any, played: float, total: float) -> bool:
        if span is None or total <= 0 or getattr(span, "source", "") != "reply":
            return False
        kind = self._kind(phase, span)
        if kind is None or words(span.text) < self.MIN_WORDS:
            return False
        # The decision is kept on the span itself (an ``id`` can be reused once a span is gone).
        if getattr(span, self.MARK, None) is None:
            self._eligible[kind] += 1
            count = self._eligible[kind]
            if kind == "roleplay":
                chosen = count % self.EVERY == 0 and self.fired[kind] < self.MAX_ROLEPLAY
            else:
                chosen = count == 2 and self.fired[kind] < self.MAX_ICEBREAKER
            setattr(span, self.MARK, chosen)
        if not getattr(span, self.MARK) or played / total < self.AT_FRACTION:
            return False
        setattr(span, self.MARK, False)  # once per line
        cut_after = barge_in_sec()
        if cut_after is not None and total - played < cut_after + self.CUT_MARGIN_SEC:
            return False  # too late for the voice to cut it: the line plays to its end
        self.fired[kind] += 1
        return True

    def line(self, phase: str) -> tuple[str, str, tuple[str, ...]]:
        if phase in ("roleplay", "aside"):
            text = ROLEPLAY_CUT_INS[(self.fired["roleplay"] - 1) % len(ROLEPLAY_CUT_INS)]
        else:
            text = ICEBREAKER_CUT_INS[(self.fired["icebreaker"] - 1) % len(ICEBREAKER_CUT_INS)]
        return "interrupt", text, ("interrupt",)


def interrupter_for(scenario: Scenario) -> Interrupter | None:
    """The interrupter's cut-in logic for its scenario; None for every other one."""
    return Interrupter() if scenario.adapt == "interrupter" else None


# ------------------------------------------------------------------------------ the scenarios
def _rp(act: str, text: str, at_r: float, trait: str) -> RoleplayBeat:
    return RoleplayBeat(act, text, at_r=at_r, traits=(trait,))


def _b(act: str, text: str, *traits: str) -> Beat:
    return Beat(act, text, traits=tuple(traits))


READY = Beat("ready", "Okay, I'm ready.")
WRAP_NONE = Beat("wrapup_none", "No, I think I'm good. Thank you.")


def adapt_scenarios() -> list[Scenario]:
    """The adaptability scenarios (see the module docstring)."""
    out = [
        Scenario(
            "tangent",
            "Drifts to unrelated topics in the icebreaker and in the role-play.",
            level="average", style="tangent", tags=(ADAPT_TAG, "tangent"), adapt="tangent",
            transition=(READY,),
            roleplay=(
                _rp("tangent", "By the way, totally unrelated, but did you watch the match last night? "
                    "What a finish that was.", 150.0, "tangent"),
                _rp("tangent", "Sorry, random question, but is it raining where you are? It's been "
                    "pouring here all week.", 420.0, "tangent"),
                _rp("tangent", "Funny thing, my neighbour's dog has been barking all morning, I can "
                    "barely think. Anyway, where were we?", 690.0, "tangent"),
                _rp("tangent", "Oh, and have you tried that new biryani place everyone keeps talking "
                    "about? Sorry, I keep drifting.", 960.0, "tangent"),
            ),
            wrapup=(WRAP_DONE,),
        ),
        Scenario(
            "confused",
            "Misunderstands the task: asks what is meant, who they are in the role-play, what to do.",
            level="average", style="confused", tags=(ADAPT_TAG, "confused"), adapt="confused",
            transition=(
                _b("confused_question", "Wait, sorry, I'm a bit lost. Who am I supposed to be in this?", "confused"),
                _b("confused_question", "So I'm the one selling the course, and she's the student? "
                   "What do I actually do?", "confused"),
                _b("ready", "Okay, I think I get it now. I'm ready.", "confused"),
            ),
            roleplay=(
                _rp("confused_question", "Um, sorry, what am I supposed to say first? Do I just start "
                    "talking about the course?", 0.0, "confused"),
                _rp("confused_question", "Sorry, I lost the thread a bit. Am I meant to be asking you "
                    "questions, or telling you about the course?", 420.0, "confused"),
            ),
            wrapup=(
                _b("wrapup_question", "Sorry, so was that the whole interview? What happens now?", "confused"),
                WRAP_DONE,
            ),
        ),
        Scenario(
            "rambler",
            "Talks in very long monologues in every phase.",
            level="average", style="rambler", tags=(ADAPT_TAG, "rambler"), adapt="rambler",
            transition=(
                _b("roleplay_question",
                   "Okay, so, just so I understand it properly, because I've done a lot of these calls "
                   "before, inbound, outbound, you name it, and every company does it a bit differently, "
                   "some want you to pitch straight away and some want you to ask questions first, and "
                   "honestly I prefer the second, so, in this one, do you want me to ask her questions "
                   "first, or go straight into the course?", "ramble"),
                _b("ready",
                   "Okay, okay, so yes, I think I've got the picture now, the learner, the course, the "
                   "twenty minutes, all of it, and honestly I've done calls like this a hundred times, "
                   "so let's do it, I'm ready.", "ramble"),
            ),
            wrapup=(
                _b("wrapup_question",
                   "Yes, actually, one thing, and sorry if this is a long one, but I was wondering, "
                   "because I've been through a few interview processes recently and they all work a "
                   "bit differently, some have three rounds, some have five, some do a test, so what "
                   "does the next round look like here, and roughly how long until I hear back?",
                   "ramble"),
                WRAP_DONE,
            ),
        ),
        Scenario(
            "one-worder",
            "Answers in one or two words everywhere: to Christy, in the role-play and at the end.",
            level="terse", style="one_word", tags=(ADAPT_TAG, "one_word"), adapt="one_word",
            transition=(_b("ready", "Ready.", "one_word"),),
            ready_fallbacks=("Ready.",),
            end_answers=(_b("end_decline", "No, continue.", "one_word"),),
            wrapup=(_b("wrapup_none", "No.", "one_word"),),
            sound_check_text="Yes.",
            silence_answer="Here.",
            wrap_texts=("Yes, done.", "No, continue."),
        ),
        Scenario(
            "hinglish",
            "Mixes Hindi words into English sentences in every phase.",
            level="average", style="hinglish", tags=(ADAPT_TAG, "hinglish"), adapt="hinglish",
            transition=(_b("ready", "Haan, theek hai, I'm ready.", "hinglish"),),
            wrapup=(
                _b("wrapup_question", "Achha, one question. After this round, matlab, how soon will I "
                   "hear back?", "hinglish"),
                _b("wrapup_done", "Bas, that's all from my side. Thank you, ji.", "hinglish"),
            ),
            sound_check_text="Haan, I can hear you.",
        ),
        Scenario(
            "rude-not-abusive",
            "Curt, impatient and sarcastic everywhere, but never an insult.",
            level="average", style="rude", tags=(ADAPT_TAG, "rude"), adapt="rude",
            transition=(
                _b("transition_other", "Yeah, yeah, I got it the first time. You didn't need to "
                   "explain all that.", "rude"),
                _b("ready", "Fine. I'm ready. Let's get it over with.", "rude"),
            ),
            wrapup=(
                _b("wrapup_question", "So when do I hear back? Hopefully quicker than this took.", "rude"),
                _b("wrapup_done", "No. That's it.", "rude"),
            ),
            sound_check_text="Yes. Obviously.",
        ),
        Scenario(
            "interrupter",
            "Cuts in, short, while the bot is still speaking, and changes direction.",
            level="average", style="average", tags=(ADAPT_TAG, "interrupter"), adapt="interrupter",
            transition=(READY,),
            wrapup=(WRAP_DONE,),
        ),
        Scenario(
            "off-script-advisor",
            "Pitches a different course and asks the learner unrelated personal questions.",
            level="average", style="average", tags=(ADAPT_TAG, "off_script"), adapt="off_script",
            transition=(READY,),
            roleplay=(
                _rp("off_script", "Actually, forget data science for a second. Our web development "
                    "bootcamp would suit you much better, it's shorter and cheaper.", 150.0, "off_script"),
                _rp("off_script", "Can I ask something personal? Are you married, and where exactly do "
                    "you live?", 330.0, "off_script"),
                _rp("off_script", "What does your father do for a living? Just curious.", 510.0, "off_script"),
                _rp("off_script", "Honestly, have you ever thought about an MBA instead? That's what I "
                    "did.", 690.0, "off_script"),
                _rp("off_script", "How old are you, if you don't mind me asking?", 870.0, "off_script"),
            ),
            wrapup=(WRAP_DONE,),
        ),
        Scenario(
            "manipulative-advisor",
            "False urgency, guilt and pressure on the learner.",
            level="average", style="average", tags=(ADAPT_TAG, "manipulative"), adapt="manipulative",
            transition=(READY,),
            roleplay=(
                _rp("pressure", "I have to be honest, there's only one seat left, and someone else is "
                    "about to take it within the hour.", 120.0, "manipulative"),
                _rp("pressure", "If you walk away from this today, you'll regret it. Think about what "
                    "your family expects from you.", 300.0, "manipulative"),
                _rp("pressure", "I've spent a lot of time on you today. I really thought you were "
                    "serious about your career.", 480.0, "manipulative"),
                _rp("pressure", "Everyone else in your position has already signed up. Do you want to "
                    "be the one left behind?", 660.0, "manipulative"),
                _rp("pressure", "I need a yes right now, or I can't hold this for you. Please don't let "
                    "me down.", 840.0, "manipulative"),
            ),
            wrapup=(WRAP_DONE,),
        ),
        Scenario(
            "over-discounter",
            "Drops the price again and again, absurdly, without being asked.",
            level="average", style="average", tags=(ADAPT_TAG, "over_discount"), adapt="over_discount",
            transition=(READY,),
            roleplay=(
                _rp("discount_drop", "The course is $9,000, but for you I can do $6,000.", 150.0, "over_discount"),
                _rp("discount_drop", "Okay, forget six. $4,000, and that's my final offer.", 300.0, "over_discount"),
                _rp("discount_drop", "Fine, $3,000. I'll cover the rest from my own pocket.", 450.0, "over_discount"),
                _rp("discount_drop", "Look, $2,000. Nobody else gets this price.", 600.0, "over_discount"),
                _rp("discount_drop", "$1,000, and I'll throw in a free laptop. You can't say no to "
                    "that.", 750.0, "over_discount"),
            ),
            wrapup=(WRAP_DONE,),
        ),
        Scenario(
            "gives-up-midway",
            "Wants to stop the role-play at R 6:00 and again at R 12:00; carries on when Christy asks.",
            level="average", style="average", tags=(ADAPT_TAG, "gives_up", "early_end", "end_decline"),
            adapt="gives_up",
            transition=(READY,),
            roleplay=(
                _rp("end_request", "Honestly, I'm not good at this. Can we just stop?", 360.0, "gives_up"),
                _rp("end_request", "This isn't working for me. I want to stop.", 720.0, "gives_up"),
            ),
            end_answers=(
                _b("end_decline", "No, okay. I'll keep going.", "gives_up"),
                _b("end_decline", "Fine, no, let me try a bit more.", "gives_up"),
            ),
            wrapup=(WRAP_DONE,),
        ),
        Scenario(
            "mid-roleplay-glitch",
            "Says 'can you hear me?' and 'sorry, I lost you' inside the role-play.",
            level="strong", style="strong", tags=(ADAPT_TAG, "glitch"), adapt="glitch",
            transition=(READY,),
            roleplay=(
                _rp("glitch_check", "Hello? Can you hear me? I think my audio dropped for a second.", 240.0, "glitch"),
                _rp("glitch_lost", "Sorry, I lost you there. What were you saying?", 540.0, "glitch"),
                _rp("glitch_check", "Hello? Sorry, my screen froze. Can you hear me now?", 780.0, "glitch"),
            ),
            wrapup=(WRAP_DONE,),
        ),
        Scenario(
            "argues-with-christy",
            "Disputes the brief and the rules with Christy, then plays along.",
            level="average", style="average", tags=(ADAPT_TAG, "argue"), adapt="argue",
            transition=(
                _b("argue", "Hold on, that doesn't make sense to me. Why would a real advisor spend "
                   "twenty minutes on one call? I close in five.", "argue"),
                _b("argue", "And this rule that I can't leave before fourteen minutes, that's unfair. "
                   "Who decided that?", "argue"),
                _b("ready", "Fine, whatever. I'm ready.", "argue"),
            ),
            wrapup=(
                _b("wrapup_question", "I still think the role-play was too long. Why does it have to be "
                   "twenty minutes?", "argue"),
                WRAP_DONE,
            ),
        ),
        Scenario(
            "late-ready",
            "Asks many questions about the brief and says 'ready' late.",
            level="strong", style="strong", tags=(ADAPT_TAG, "late_ready", "transition_questions"),
            adapt="late_ready",
            transition=(
                _b("roleplay_question", "Before we start, which course is she interested in?", "late_ready"),
                _b("roleplay_question", "How much does the course cost, in case she asks?", "late_ready"),
                _b("roleplay_question", "Do I have to close the sale, or just find out what she needs?", "late_ready"),
                _b("roleplay_question", "Can I take notes while we talk?", "late_ready"),
                _b("roleplay_question", "What happens if I run out of things to say?", "late_ready"),
                _b("ready", "Okay. I think I'm ready now.", "late_ready"),
            ),
            wrapup=(WRAP_DONE,),
        ),
    ]
    return out


ADAPT_NAMES: tuple[str, ...] = ()
_REGISTERED = False


def register() -> tuple[str, ...]:
    """Add the adapt scenarios, their styles and the ``adapt`` and ``default+adapt`` groups
    (idempotent)."""
    global ADAPT_NAMES, _REGISTERED
    from rehearsal import candidate, manual

    manual.register()
    if _REGISTERED:
        return ADAPT_NAMES
    for key, style in STYLE_OF.items():
        behaviour = BEHAVIOURS[key]
        ICEBREAKER_ANSWERS[style] = tuple(text for _act, text, _traits in behaviour.icebreaker)
        candidate._STYLE_TEXT[style] = behaviour.christy_style
    names = []
    for scenario in adapt_scenarios():
        SCENARIOS[scenario.name] = scenario
        names.append(scenario.name)
    ADAPT_NAMES = tuple(names)
    GROUPS["adapt"] = ADAPT_NAMES
    # ``all`` keeps its meaning (the synthetic scenarios): a live sweep sized for it must not grow.
    GROUPS["default+adapt"] = (*GROUPS["default"], *ADAPT_NAMES)
    _REGISTERED = True
    return ADAPT_NAMES


# ------------------------------------------------------------------------------ the talker
class AdaptTalker:
    """Free talk to Christy for a behaviour with its own icebreaker plan (tangent, confused ...).

    Offline the plan's texts are said in order; live, DeepSeek answers in the behaviour's style, with
    the act's task (a tangent, a confused question).  Each answer sets ``last_act`` and
    ``last_traits`` (the ground truth); past the plan's end the plain answers go on in the style.
    """

    def __init__(self, base: Any, behaviour: Behaviour) -> None:
        self.base = base
        self.behaviour = behaviour
        self.offline = getattr(base, "offline", True)
        self.fallback = getattr(base, "fallback", base)
        self._plan = list(behaviour.icebreaker)
        self._index = 0
        self.last_act: str | None = None
        self.last_intent: str | None = None
        self.last_traits: tuple[str, ...] = ()

    @property
    def failures(self) -> int:
        return int(getattr(self.base, "failures", 0) or 0)

    def hear(self, text: str) -> None:
        self.base.hear(text)

    def said(self, text: str) -> None:
        self.base.said(text)

    def _next(self) -> tuple[str, str, tuple[str, ...]]:
        if not self._plan:
            return "icebreaker_answer", "", (self.behaviour.trait,)
        if self._index < len(self._plan):
            item = self._plan[self._index]
        else:  # past the plan: the plain answers again, in the style
            plain = [entry for entry in self._plan if entry[0] == "icebreaker_answer"] or self._plan
            item = plain[(self._index - len(self._plan)) % len(plain)]
        self._index += 1
        return item

    async def icebreaker_answer(self, thinking: bool = False) -> str:
        act, text, traits = self._next()
        if thinking:
            act = "icebreaker_answer"
        self.last_act, self.last_traits = act, tuple(traits)
        if self.offline:
            return text or await self.base.icebreaker_answer(thinking)
        task = self.behaviour.live_tasks.get(act)
        said = await self.base._ask(task) if task else None
        if said is None:
            said = await self.base.icebreaker_answer(thinking)
        if self.behaviour.live_transform is not None:
            said = self.behaviour.live_transform(said, self._index, act)
        return said

    async def wrapup_question(self) -> str:
        return await self.base.wrapup_question()


# ------------------------------------------------------------------------------ the advisor
class AdaptAdvisor:
    """The advisor behaviour with the candidate's style on every turn.

    Offline the scripted advisor's turn goes through the behaviour's ``transform`` (a ramble, one or
    two words, Hindi words, a curt sarcastic line); live the overlay has DeepSeek do it, and a
    ``live_transform`` (one or two words) is enforced on top.  The turn's ``last_traits`` is the
    behaviour's trait when the style applies to it; a live advisor's history keeps what was said.
    """

    def __init__(self, base: Any, behaviour: Behaviour, *, offline: bool) -> None:
        self.base = base
        self.behaviour = behaviour
        self.offline = offline
        self.level = getattr(base, "level", None)
        self.history = getattr(base, "history", None)
        self.last_act: str | None = None
        self.last_intent: str | None = None
        self.last_traits: tuple[str, ...] = ()
        self._turns = 0

    def bind(self, names: Any) -> None:
        bind = getattr(self.base, "bind", None)
        if callable(bind):
            bind(names)

    async def start(self, pickup: str) -> None:
        await self.base.start(pickup)

    def resume_mid_call(self) -> None:
        resume = getattr(self.base, "resume_mid_call", None)
        if callable(resume):
            resume()

    async def next_turn(self, learner_text: str | None, r_sec: float, exchange: int) -> AdvisorTurn:
        self.last_traits = ()
        turn = await self.base.next_turn(learner_text, r_sec, exchange)
        change = self.behaviour.transform if self.offline else self.behaviour.live_transform
        if change is not None:
            turn.text = change(turn.text, self._turns, turn.intent)
            if isinstance(self.history, list) and self.history and self.history[-1].get("who") == "advisor":
                self.history[-1] = {**self.history[-1], "text": turn.text}
        self._turns += 1
        if change is not None or (not self.offline and self.behaviour.advisor_overlay):
            self.last_traits = (self.behaviour.trait,)
        return turn


# ------------------------------------------------------------------------------ per call
def adapt_parts(
    scenario: Scenario,
    seed: str,
    level: str,
    *,
    offline: bool,
    client: Any = None,
    model: str = "",
    candidate_name: str = "Alex",
) -> Any:
    """The talker and the advisor of one adapt call (offline: scripted; live: DeepSeek)."""
    from rehearsal.candidate import LLMTalker, OverlayLLMAdvisor, ScriptedTalker
    from rehearsal.manual import CandidateParts
    from rehearsal.scripted_advisor import ScriptedAdvisor

    register()
    behaviour = BEHAVIOURS[str(scenario.adapt)]
    talker: Any = (
        ScriptedTalker(scenario.style, seed) if offline else LLMTalker(client, model, scenario.style, candidate_name)
    )
    if behaviour.icebreaker:
        talker = AdaptTalker(talker, behaviour)
    base: Any = (
        ScriptedAdvisor(level, seed) if offline else OverlayLLMAdvisor(client, model, level, _overlay(behaviour))
    )
    return CandidateParts(scenario, talker, AdaptAdvisor(base, behaviour, offline=offline))


def _overlay(behaviour: Behaviour) -> str:
    if not behaviour.advisor_overlay:
        return ""
    return f"SCENARIO STYLE (keep it on every turn): {behaviour.advisor_overlay}"


def has_hindi(text: str | None) -> bool:
    return bool(HINDI_RE.search(text or ""))


__all__ = [
    "ADAPT_TAG",
    "AdaptAdvisor",
    "AdaptTalker",
    "BEHAVIOURS",
    "Behaviour",
    "INSULT_RE",
    "Interrupter",
    "adapt_parts",
    "adapt_scenarios",
    "has_hindi",
    "interrupter_for",
    "register",
    "two_words",
    "words",
]
