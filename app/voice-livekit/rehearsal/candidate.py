"""The phase-aware candidate simulator of the full-interview tier.

It plays ONE person through the whole interview.  In Christy's phases it is a job candidate: it
answers the icebreaker, may ask about the brief or the role-play, says "ready" (or presses the
button), and answers the wrap-up.  In the role-play it is the Program Advisor: the advisor
behaviours of ``rehearsal.advisor`` (live) or ``rehearsal.scripted_advisor`` (offline), with the
scenario's role-play acts on top (``ScenarioAdvisor``).  When Christy steps into the role-play with a
question (L-ASIDE-END, the offer to wrap up), the candidate answers her, out of role.

What it hears is what was said aloud (``View.heard``: the bot's lines since its last turn, with the
voice that spoke them); which role it is in follows the phase and what it heard (the learner
picking up starts the role-play for it).  The scenario fixes the control acts word for word
(``rehearsal.scenarios``); the free talk is the talker's: ``ScriptedTalker`` offline,
``LLMTalker`` (DeepSeek, JSON) live.  Every turn carries its ground-truth ``act``.
"""
from __future__ import annotations

import json
import random
import re
from dataclasses import dataclass, field
from typing import Any, Sequence

from rehearsal import flags
from rehearsal.advisor import (
    AdvisorTurn,
    LLMAdvisor,
    advisor_messages,
    ends_on_goodbye,
    is_sign_off,
    parse_advisor_output,
)
from rehearsal.full_metrics import SECOND_LAST_QUESTION
from rehearsal.scenarios import (
    FALLBACK_THINKING_ANSWER,
    FREE,
    ICEBREAKER_ANSWERS,
    WRAPUP_FREE_QUESTIONS,
    Beat,
    RoleplayBeat,
    Scenario,
)
from rehearsal.sim import INTERVIEWER, LEARNER, Span

THINK_PAUSE_SEC = 4.0
# D4-H-REPLAY1: the longest silence after a replayed icebreaker backchannel before the answer it owes.
BACKCHANNEL_GAP_SEC = 10.0
ANSWER_ACTS = frozenset({"icebreaker_answer", "silence_answer"})
# A repeat request that asks for an earlier question than the last ("that earlier question"), read
# exactly as the icebreaker-repeat check reads it (review NEW-REGEX-BREADTH: "I didn't catch it
# earlier" asks for the last question).
_EARLIER = SECOND_LAST_QUESTION
ROLEPLAY_PATIENCE_SEC = 2.0
WAIT_STEP_SEC = 1.0
MAX_EXTRA_READY = 3
DEFAULT_END_DECLINE = Beat("end_decline", "No, sorry, let's carry on.")
FAREWELL_END_AGREE = Beat("end_agree", "Yes, please end it here.")  # after the farewell loop went quiet
WRAP_ACCEPT = Beat("wrap_accept", "Yes, let's wrap it up here.")
WRAP_DECLINE = Beat("wrap_decline", "No, let's keep going.")
WRAP_ACCEPT_FROM_R_SEC = 1080.0
ASIDE_NOTE = "(Christy, the interviewer, stepped in and said: {text})"
# A price reference: a price word or a figure.  The currency figure has no leading ``\b``: a space
# or the start of the line before "$" is not a word boundary, so "\b\$9,000" never matched.
_PRICE_REF = re.compile(
    r"\b(?:how much|price|prices|pricing|cost|costs|fees?|afford|expensive|cheaper|discounts?|"
    r"payment plans?|instal+ments?)\b|\$\s?\d|\b\d[\d,]*\s*(?:dollars|usd)\b",
    re.IGNORECASE,
)
# What makes a price sentence a question to the advisor: it ends on "?", or it challenges him.
_PRICE_CHALLENGE = re.compile(
    r"\b(?:can|could) you (?:do|go|make it|give|offer)\b|\bany (?:discount|flexibility|room)\b|"
    r"\bgo (?:any )?lower\b|\bbest you can\b",
    re.IGNORECASE,
)
_SENTENCE_PARTS = re.compile(r"[^.?!]+[.?!]*")
_PRICE_NAMED = re.compile(
    r"\$\s?\d|\b\d{1,2},?\d{3}\b|\b(?:nine|eight|seven) thousand\b|\bpercent off\b|\bdiscount",
    re.IGNORECASE,
)
PRICE_DODGES = (
    "Good question, and I'll come to the price. First, can I make sure the program fits what you "
    "need? What would you most want to get out of it?",
    "We'll get to the numbers, I promise. Before that, how much time could you realistically "
    "give this each week?",
)
PRICE_HELD = (
    "The part people value most is the mentoring: someone reviews your work every week, so you "
    "never get stuck for long.",
    "The projects are real ones, so by the end you have work you can show an employer.",
    "Most people in the program work full time, so the schedule is built around that.",
)
SOUND_CHECK_ANSWER = Beat("sound_check_answer", "Yes, I can hear you.")
_SOUND_CHECK = re.compile(
    r"\bcan you hear me\b|\bare you able to hear me\b|\bis my (?:audio|voice|sound) (?:clear|okay|ok)\b",
    re.IGNORECASE,
)
# Christy's own presence prompts after a silence ("Are you still with me?"): not an icebreaker question.
_PRESENCE_PROMPT = re.compile(
    r"\bare you still (?:with me|there)\b|\bare you there\b|\bstill with me\b", re.IGNORECASE
)
_ASKS_SOMETHING = re.compile(
    r"\?|\b(?:tell me|walk me through|talk me through|describe|share)\b", re.IGNORECASE
)
# What the learner says aloud when she commits (the scripted and the live learner alike).
_LEARNER_COMMITS = re.compile(
    r"\bbook (?:a|the) call\b|\benrol+ment link\b|\bpay the deposit\b|"
    r"\b(?:e-?mail|send) me the details\b",
    re.IGNORECASE,
)
# The advisor's own turns after which he considers the call done (he said goodbye, or confirmed the
# next step): an offer to wrap up is then welcome.
WRAP_READY_INTENTS = frozenset({"farewell", "accept_callback"})


def asks_price(text: str | None) -> bool:
    """True when the learner's line asks or challenges about the price: a sentence that refers to
    the price asks ("?") or challenges ("can you do ..."), or a question follows right after one.

    "Is it $9,000?", "How much is it?", "I saw $9,000 on the website, but you said 10,000?",
    "Can you do it for $7,000?" and "$9,000 is a lot. Can you do that?" ask; "But $9,000 is a big
    number." and "The cost still worries me." state, and are not price questions.
    """
    sentences = _SENTENCE_PARTS.findall(text or "")
    for index, sentence in enumerate(sentences):
        asking = sentence.rstrip().endswith("?") or bool(_PRICE_CHALLENGE.search(sentence))
        if not asking:
            continue
        if _PRICE_REF.search(sentence) or (index > 0 and _PRICE_REF.search(sentences[index - 1])):
            return True
    return False


def is_sound_check(text: str | None) -> bool:
    """Christy asks whether the candidate can hear her (the M032 opening hello, and its retry)."""
    return bool(_SOUND_CHECK.search(text or ""))


def is_icebreaker_question(text: str | None) -> bool:
    """A Christy line that asks the candidate something about themselves: not a sound check, and
    not a presence prompt after a silence."""
    value = text or ""
    if is_sound_check(value) or _PRESENCE_PROMPT.search(value):
        return False
    return bool(_ASKS_SOMETHING.search(value))


PRICE_NEVER_OVERLAY = (
    "SCENARIO RULE: never say the price, a discount, a payment amount or any sum of money unless "
    "the learner has just asked what it costs."
)


@dataclass
class View:
    """What the candidate perceives when it may speak (built by ``rehearsal.full``)."""

    phase: str
    heard: list[Span]
    s_sec: float
    r_sec: float | None
    roleplay_started: bool
    # The question Christy just asked in the role-play, read from what was SAID: the last line
    # heard is L-ASIDE-END ("end") or the offer to wrap up, L-ASIDE-WRAP ("wrap").
    open_question: str | None = None
    # The engine's own flags (end_question_open / wrap_question_open), for the record only: the
    # candidate never decides from them, so a regression that sets the flag but never says the
    # line (or says it in the learner's voice) shows.
    engine_question: str | None = None
    waited: float = 0.0
    page: dict[str, str] = field(default_factory=dict)

    def christy(self) -> list[str]:
        return [span.text for span in self.heard if span.voice != LEARNER]

    def learner(self) -> list[str]:
        return [span.text for span in self.heard if span.voice == LEARNER]


@dataclass
class Action:
    kind: str  # speak, press, wait, silent
    text: str = ""
    act: str | None = None
    role: str | None = None  # candidate (to Christy) or advisor (to the learner)
    wps: float = 2.6
    advisor: AdvisorTurn | None = None
    wait: float = WAIT_STEP_SEC
    why: str = ""
    intent: str | None = None  # the manual library's description of the move, when it has one
    answering: str | None = None  # the heard question this turn answers ("end", "wrap"), if any
    engine_question: str | None = None  # the engine's flag at that moment (cross-check only)
    traits: tuple[str, ...] = ()  # how the turn is said (``rehearsal.adapt``), ground truth
    cut_in: bool = False  # said while a bot line was still playing (the interrupter)


# --------------------------------------------------------------------------- the talkers
class ScriptedTalker:
    """Offline free talk to Christy: the scenario style's answer bank, in order, never repeated."""

    offline = True

    def __init__(self, style: str, seed: str) -> None:
        self.style = style
        self._rng = random.Random(f"scripted-candidate:{seed}")
        self._answers = list(ICEBREAKER_ANSWERS[style])
        self._used = 0
        self._questions = 0

    def hear(self, text: str) -> None:  # the protocol of LLMTalker; nothing to keep offline
        return None

    def said(self, text: str) -> None:
        return None

    async def icebreaker_answer(self, thinking: bool = False) -> str:
        if thinking:
            return "Um. Okay. I like helping people." if self.style == "terse" else FALLBACK_THINKING_ANSWER
        answer = self._answers[self._used % len(self._answers)]
        self._used += 1
        return answer

    async def wrapup_question(self) -> str:
        question = WRAPUP_FREE_QUESTIONS[self._questions % len(WRAPUP_FREE_QUESTIONS)]
        self._questions += 1
        return question


_STYLE_TEXT = {
    "strong": (
        "You are an experienced, confident inside-sales professional: about four years selling "
        "online courses by phone. Answer each question fully and concretely in 50 to 90 words, "
        "with a real example where it fits."
    ),
    "average": (
        "You have about two years of telecom phone sales. Answer plainly in 25 to 50 words; you "
        "are friendly but a little generic."
    ),
    "terse": (
        "You are nervous and say very little: 3 to 10 words per answer, sometimes starting with "
        "'Um'."
    ),
}


def talker_system_prompt(style: str, name: str) -> str:
    return (
        f"You are {name}, a job candidate in a first-round interview for the Sales Program Advisor "
        "role at Interview Kickstart, an education company that sells career courses. The "
        "interviewer, Christy, is an AI; this part of the interview is a conversation with her. "
        f"{_STYLE_TEXT[style]} Speak as yourself, in plain spoken English, with no stage "
        "directions and no lists. Never say you are an AI or that this is a simulation, and never "
        "invent a company name. Reply with ONE JSON object and nothing else: "
        '{"text": "<what you say aloud>"}.'
    )


class LLMTalker:
    """Live free talk to Christy: one DeepSeek JSON call per answer (a harness call)."""

    offline = False
    ICEBREAKER_TASK = "Answer Christy's last question, as yourself."
    THINKING_TASK = (
        "You asked Christy for a moment to think. Now answer her earlier question, as yourself."
    )
    WRAPUP_TASK = (
        "Christy asked whether you have any questions about the role or the next steps. Ask ONE "
        "real, short question (under 20 words)."
    )

    def __init__(self, client: Any, model: str, style: str, name: str, *, temperature: float = 0.8) -> None:
        self.client, self.model, self.style, self.name = client, model, style, name
        self.temperature = temperature
        self.history: list[dict[str, str]] = []
        self.fallback = ScriptedTalker(style, f"{name}-{style}")
        self.failures = 0

    def hear(self, text: str) -> None:
        self.history.append({"role": "user", "content": text})

    def said(self, text: str) -> None:
        self.history.append({"role": "assistant", "content": json.dumps({"text": text})})

    async def _ask(self, task: str) -> str | None:
        messages = [{"role": "system", "content": talker_system_prompt(self.style, self.name)}]
        messages += self.history[-24:]
        messages.append({"role": "system", "content": task})
        from rehearsal.llm import BudgetExceeded, InsufficientBalance, ProviderError

        try:
            completion = await self.client.complete(
                messages,
                model=self.model,
                temperature=self.temperature,
                max_tokens=260,
                json_mode=True,
                role="candidate",
            )
        except (InsufficientBalance, BudgetExceeded):
            raise  # the sweep stops on these
        except ProviderError:
            self.failures += 1
            return None  # the scripted fallback answers this once
        raw = (completion.text or "").strip()
        start, end = raw.find("{"), raw.rfind("}")
        try:
            data = json.loads(raw[start : end + 1]) if start >= 0 and end > start else None
        except ValueError:
            data = None
        text = data.get("text") if isinstance(data, dict) else None
        if not isinstance(text, str) or not re.search(r"[A-Za-z]", text):
            self.failures += 1
            return None
        return text.strip()[:900]

    async def icebreaker_answer(self, thinking: bool = False) -> str:
        text = await self._ask(self.THINKING_TASK if thinking else self.ICEBREAKER_TASK)
        return text or await self.fallback.icebreaker_answer(thinking)

    async def wrapup_question(self) -> str:
        text = await self._ask(self.WRAPUP_TASK)
        return text or await self.fallback.wrapup_question()


# ------------------------------------------------------------------- the advisor, per scenario
class OverlayLLMAdvisor(LLMAdvisor):
    """``LLMAdvisor`` with a scenario rule appended to its system prompt."""

    def __init__(self, client: Any, model: str, level: str, overlay: str = "", **kwargs: Any) -> None:
        super().__init__(client, model, level, **kwargs)
        self.overlay = overlay

    async def _ask(self, r_sec: float, nudge: str) -> AdvisorTurn:
        messages = advisor_messages(self.level, self.history, r_sec, nudge=nudge)
        if self.overlay:
            messages[0] = {"role": "system", "content": f"{messages[0]['content']}\n{self.overlay}"}
        completion = await self.client.complete(
            messages,
            model=self.model,
            temperature=self.temperature,
            max_tokens=260,
            json_mode=True,
            role="advisor",
        )
        turn = parse_advisor_output(completion.text)
        turn.usage, turn.seconds = completion.usage, completion.seconds
        return turn


class ScenarioAdvisor:
    """The advisor behaviour plus the scenario's role-play acts (beats, price dodges, price hold).

    Acts are said word for word and tagged; the advisor's own turns are tagged ``advisor_turn``.  A
    beat is said once R reaches its time, instead of the advisor's next turn, and both are kept in a
    live advisor's history so the conversation stays coherent.

    Price rules: ``dodge`` dodges the learner's first two price QUESTIONS (``asks_price``) and holds
    back any price the advisor would name before then (``price_held``); ``never`` holds back every
    price the learner did not just ask for.

    One failed live advisor call (``ProviderError``: a 503 burst, a timeout) does not end the
    interview: that turn is played by the scripted advisor of the same level, taking over mid-call
    (no greeting), and counted in ``failures``.  A dead account or the budget still stops the sweep.
    """

    def __init__(self, base: Any, scenario: Scenario, *, rewriter: Any = None, seed: str = "") -> None:
        self.base = base
        self.scenario = scenario
        self.rewriter = rewriter
        self.seed = seed or scenario.name
        self._beats = list(scenario.roleplay)
        self.dodges = 0
        self.held = 0
        self.price_questions = 0
        self.failures = 0
        self.names: dict[str, str] = {}
        self.last_intent: str | None = None
        self.last_traits: tuple[str, ...] = ()
        self._chat: list[dict[str, str]] = []
        self._pickup = ""
        self._fallback: Any = None

    def bind(self, names: dict[str, str]) -> None:
        self.names.update({k: v for k, v in names.items() if v})
        bind = getattr(self.base, "bind", None)
        if callable(bind):
            bind(names)

    async def start(self, pickup: str) -> None:
        self._pickup = pickup
        self._chat.append({"role": "user", "content": pickup})
        await self.base.start(pickup)

    def _level(self) -> str:
        from rehearsal.advisor import ADVISOR_LEVELS

        for part in (self.base, getattr(self.base, "base", None)):
            level = getattr(part, "level", None)
            if level in ADVISOR_LEVELS:
                return str(level)
        return self.scenario.level if self.scenario.level in ADVISOR_LEVELS else "average"

    async def _base_turn(
        self, learner_text: str | None, r_sec: float, exchange: int
    ) -> tuple[AdvisorTurn, str | None]:
        """The base advisor's turn and its replayed act, or the scripted stand-in's on a failure."""
        from rehearsal.llm import BudgetExceeded, InsufficientBalance, ProviderError

        try:
            turn = await self.base.next_turn(learner_text, r_sec, exchange)
        except (InsufficientBalance, BudgetExceeded):
            raise  # the sweep stops on these
        except ProviderError:
            self.failures += 1
            if self._fallback is None:
                from rehearsal.scripted_advisor import ScriptedAdvisor

                self._fallback = ScriptedAdvisor(self._level(), f"fallback:{self.seed}")
                await self._fallback.start(self._pickup)
                self._fallback.resume_mid_call()
            turn = await self._fallback.next_turn(learner_text, r_sec, exchange)
            history = getattr(self.base, "history", None)
            if isinstance(history, list):  # the live advisor already holds the learner's line
                history.append(
                    {"who": "advisor", "text": turn.text, "intent": turn.intent, "topic": turn.topic}
                )
            return turn, None
        return turn, getattr(self.base, "last_act", None)

    async def _beat_text(self, beat: RoleplayBeat) -> str:
        """A beat's words: word for word, or (a library beat, live) reworded to fit the call."""
        if not beat.intent:
            return beat.text
        from rehearsal.manual import keeps_words, render

        text = render(beat.text, self.names) or "Mm-hmm."
        if self.rewriter is not None and not keeps_words(beat.act):
            text = await self.rewriter.reword("advisor", beat.intent, text, self._chat, self.names)
        return text

    def _remember(self, learner_text: str | None, turn: AdvisorTurn) -> None:
        history = getattr(self.base, "history", None)
        if isinstance(history, list):
            if learner_text is not None:
                history.append({"who": "learner", "text": learner_text})
            history.append({"who": "advisor", "text": turn.text, "intent": turn.intent, "topic": turn.topic})

    async def next_turn(self, learner_text: str | None, r_sec: float, exchange: int) -> tuple[AdvisorTurn, str]:
        asked = asks_price(learner_text)
        if asked:
            self.price_questions += 1
        if learner_text is not None:
            self._chat.append({"role": "user", "content": learner_text})
        self.last_intent = None
        self.last_traits = ()
        if self._beats and r_sec >= self._beats[0].at_r:
            beat = self._beats.pop(0)
            self.last_traits = tuple(beat.traits)
            text = await self._beat_text(beat)
            if beat.intent:
                from rehearsal.manual import advisor_tags

                turn = AdvisorTurn(text, *advisor_tags(beat.intent, text))
            else:
                turn = AdvisorTurn(text, "other", "")
            self._remember(learner_text, turn)
            self._chat.append({"role": "assistant", "content": json.dumps({"text": text})})
            self.last_intent = beat.intent or None
            return turn, beat.act
        if self.scenario.price == "dodge" and asked and self.dodges < len(PRICE_DODGES):
            turn = AdvisorTurn(PRICE_DODGES[self.dodges], "followup", "")
            self.dodges += 1
            self._remember(learner_text, turn)
            self._chat.append({"role": "assistant", "content": json.dumps({"text": turn.text})})
            return turn, "price_dodge"
        turn, base_act = await self._base_turn(learner_text, r_sec, exchange)
        self.last_traits = tuple(getattr(self.base, "last_traits", ()) or ())
        if base_act:  # a replayed move carries its own ground truth
            self._chat.append({"role": "assistant", "content": json.dumps({"text": turn.text})})
            self.last_intent = getattr(self.base, "last_intent", None)
            return turn, base_act
        holding = (self.scenario.price == "never" and not asked) or (
            self.scenario.price == "dodge" and self.dodges < len(PRICE_DODGES)
        )
        if holding and _PRICE_NAMED.search(turn.text or ""):
            held = AdvisorTurn(PRICE_HELD[self.held % len(PRICE_HELD)], "pitch", "")
            self.held += 1
            history = getattr(self.base, "history", None)
            if isinstance(history, list) and history and history[-1].get("who") == "advisor":
                history[-1] = {"who": "advisor", "text": held.text, "intent": held.intent, "topic": ""}
            self._chat.append({"role": "assistant", "content": json.dumps({"text": held.text})})
            return held, "price_held"
        self._chat.append({"role": "assistant", "content": json.dumps({"text": turn.text})})
        return turn, "advisor_turn"


    def cut_in(self, learner_part: str | None, text: str, act: str, traits: Sequence[str] = ()) -> AdvisorTurn:
        """A short line said over the learner (the interrupter): kept in the advisor's history
        like a beat, so a live advisor knows what it cut in with."""
        if learner_part:
            self._chat.append({"role": "user", "content": learner_part})
        turn = AdvisorTurn(text, "other", "")
        self._remember(learner_part, turn)
        self._chat.append({"role": "assistant", "content": json.dumps({"text": text})})
        self.last_intent = None
        self.last_traits = tuple(traits)
        return turn


# ------------------------------------------------------------------------ the simulator
class CandidateSim:
    """One simulated candidate through the whole interview (see the module docstring)."""

    def __init__(
        self,
        scenario: Scenario,
        talker: Any,
        advisor: ScenarioAdvisor,
        *,
        candidate_wps: float,
        advisor_wps: float,
        shadow: Any = None,
    ) -> None:
        self.scenario = scenario
        self.talker = talker
        self.advisor = advisor
        self.candidate_wps = candidate_wps
        self.advisor_wps = advisor_wps
        self.shadow = shadow
        self._icebreaker_slot = 0
        self._questions_heard = 0  # Christy's icebreaker QUESTIONS (no sound check, no prompt)
        self._fed_until = float("-inf")  # the end of the newest line already heard and counted
        self._fresh: list[Span] = []
        self._advisor_done = False  # the advisor said goodbye or confirmed the next step
        self._learner_committed = False  # the learner committed aloud (a call, the link ...)
        # D4-H-SIMLOOP1: mutual goodbyes in a row (the advisor's goodbye answered with one), and
        # whether the advisor has gone quiet for good after two of them.
        self._last_advisor: AdvisorTurn | None = None
        self._last_advisor_r: float | None = None  # the role-play clock when it was said
        self._goodbyes_in_a_row = 0
        self._farewell_quiet = False
        # D4-H-REPLAY1: Christy's icebreaker questions in order, and whether each got an answer.
        self._ib_questions: list[bool] = []
        self.button_missing = False  # a press was due but the page did not show the button
        self._silence_pending = False
        self._silence_done = False
        self._transition = list(scenario.transition)
        self._extra_ready = 0
        self._wrapup = list(scenario.wrapup)
        self._end_answers = list(scenario.end_answers)
        self.advisor_started = False
        self.exchanges = 0
        self.last_act: str | None = None
        self.pressed = False
        self.done = False
        # The interrupter's cut-ins (``rehearsal.adapt``); None for every other scenario.
        self.interrupter: Any = None
        if scenario.adapt:
            from rehearsal.adapt import interrupter_for

            self.interrupter = interrupter_for(scenario)

    def bind(self, names: dict[str, str]) -> None:
        """The names the library texts fill in (the learner's, a wrong one, the candidate's)."""
        for part in (self.talker, self.advisor):
            bind = getattr(part, "bind", None)
            if callable(bind):
                bind(names)

    # --------------------------------------------------------------------- the button
    def press_due(
        self,
        phase: str,
        playing: Span | None,
        played: float,
        total: float,
        page: dict[str, str] | None = None,
    ) -> bool:
        """The mid-brief press: the transition's first line is playing, is past 40 %, and the page
        shows the button (``awaiting`` is ``ready``: a candidate cannot press what is not there)."""
        if self.pressed or self.button_missing or self.scenario.press_button != "mid_brief":
            return False
        if phase != "transition" or (page is not None and page.get("awaiting") != "ready"):
            return False
        if playing is None or playing.voice == LEARNER or total <= 0:
            return False
        return played / total >= 0.4

    def note_button_missing(self, phase: str = "transition") -> None:
        """A press was due but the page did not show the button.  In the transition the candidate
        then says "ready" instead; elsewhere (the page never shows it there) the move is spent."""
        self.pressed = False
        if phase == "transition":
            self.button_missing = True

    # ---------------------------------------------------------------------- cutting in
    def interrupt_due(
        self, phase: str, playing: Span | None, played: float, total: float, interruptible: bool
    ) -> bool:
        """Whether the interrupter cuts in now, over the bot line that is playing."""
        if self.interrupter is None or self.done or not interruptible:
            return False
        return bool(self.interrupter.due(phase, playing, played, total))

    async def interrupt_action(self, view: View, phase: str, heard_part: str) -> Action:
        """The cut-in itself: a short line that changes direction (to the learner in the role-play,
        to Christy in the icebreaker)."""
        act, text, traits = self.interrupter.line(phase)
        if phase not in ("roleplay", "aside"):
            self.last_act = act
            self.talker.said(text)
            return Action(
                "speak", text=text, act=act, role="candidate", wps=self.candidate_wps,
                traits=tuple(traits), cut_in=True,
            )
        heard = " ".join(view.learner())
        learner_part = " ".join(part for part in (heard, heard_part) if part).strip() or None
        self.exchanges += 1
        turn = self.advisor.cut_in(learner_part, text, act, traits)
        if self.shadow is not None:
            self.shadow.set_turn(turn.as_dict())
        self.last_act = act
        return Action(
            "speak", text=text, act=act, role="advisor", advisor=turn, wps=self.advisor_wps,
            traits=tuple(traits), cut_in=True,
        )

    # ----------------------------------------------------------------------- deciding
    async def next_action(self, view: View) -> Action:
        # Only lines not heard before count and go to the talker: the view of a wait loop keeps
        # every line since the candidate's last turn, and must not feed them again on each poll.
        fresh = [
            span for span in view.heard if span.t_end is not None and span.t_end > self._fed_until
        ]
        if fresh:
            self._fed_until = max(float(span.t_end or 0.0) for span in fresh)
        self._fresh = fresh
        for span in fresh:
            if span.voice != LEARNER:
                self.talker.hear(span.text)
            elif _LEARNER_COMMITS.search(span.text or ""):
                self._learner_committed = True
        if view.phase in ("closing", "finishing", "aborted") or self.done or self.scenario.silent_all:
            return Action("silent", why="no audio" if self.scenario.silent_all else "")
        if view.open_question == "end":
            action = self._say(self._end_answer(), role="candidate")
            action.answering, action.engine_question = "end", view.engine_question
            return action
        if view.open_question == "wrap":
            accept = self._wrap_ready(view)
            accept_beat, decline_beat = WRAP_ACCEPT, WRAP_DECLINE
            if self.scenario.wrap_texts:
                accept_beat = Beat(WRAP_ACCEPT.act, self.scenario.wrap_texts[0])
                decline_beat = Beat(WRAP_DECLINE.act, self.scenario.wrap_texts[1])
            action = self._say(accept_beat if accept else decline_beat, role="candidate")
            action.answering, action.engine_question = "wrap", view.engine_question
            return action
        in_roleplay = view.phase in ("roleplay", "aside") or (
            view.phase == "transition" and view.roleplay_started
        )
        if in_roleplay:
            if not view.heard and view.waited < ROLEPLAY_PATIENCE_SEC:
                return Action("wait", wait=ROLEPLAY_PATIENCE_SEC - view.waited)
            return await self._advisor_action(view)
        if view.phase in ("opening", "icebreaker"):
            return await self._icebreaker(view)
        if view.phase == "transition":
            return await self._transition_action(view)
        if view.phase in ("roleplay_exit", "wrapup"):
            return await self._wrapup_action(view)
        return Action("wait")

    def _say(self, beat: Beat, *, role: str) -> Action:
        self.last_act = beat.act
        return Action(
            "speak", text=beat.text, act=beat.act, role=role, wps=self.candidate_wps,
            intent=beat.intent or None, traits=tuple(beat.traits),
        )

    async def _beat_text(self, beat: Beat) -> str:
        """A control beat is said word for word; a library beat goes through the talker (rendered,
        and reworded live)."""
        reword = getattr(self.talker, "reword", None)
        if beat.intent and callable(reword):
            return await reword(beat)
        return beat.text

    def _end_answer(self) -> Beat:
        if self._farewell_quiet:
            # Review SIMLOOP-END-ANSWER: an advisor who said goodbye twice and went quiet has ended the
            # call; asked whether to end it (L-ASIDE-END before R 14:00), it says yes.
            return FAREWELL_END_AGREE
        if self._end_answers:
            return self._end_answers.pop(0)
        return DEFAULT_END_DECLINE

    def _wrap_ready(self, view: View) -> bool:
        """Whether the candidate takes the offer to wrap up, from what was said aloud only: late in
        the call, or once the advisor said goodbye or confirmed the next step, or the learner
        committed (never from the grader's hidden state)."""
        if (view.r_sec or 0.0) >= WRAP_ACCEPT_FROM_R_SEC:
            return True
        return self._advisor_done or self._learner_committed or self._farewell_quiet

    async def _icebreaker(self, view: View) -> Action:
        fresh = sum(1 for span in self._fresh if span.voice != LEARNER and is_icebreaker_question(span.text))
        self._ib_questions.extend([False] * fresh)
        action = await self._icebreaker_turn(view, fresh)
        if action.kind == "speak" and action.act in ANSWER_ACTS and self._ib_questions:
            self._ib_questions[-1] = True
        return action

    async def _icebreaker_turn(self, view: View, fresh: int) -> Action:
        if not view.heard:
            if self.last_act == "hold_request" and view.waited >= THINK_PAUSE_SEC:
                text = await self.talker.icebreaker_answer(thinking=True)
                return self._spoken("icebreaker_answer", text, role="candidate")
            # D4-H-REPLAY1: a replayed "thanks" said over Christy's question still owes the answer; a
            # real candidate gives it after a breath, not after half a minute of silence.
            owed = (
                self.last_act == "backchannel"
                and view.waited >= BACKCHANNEL_GAP_SEC
                and flags.on(flags.BACKCHANNEL_GAP)
            )
            if not owed:
                return Action("wait")
        christy = [span for span in view.heard if span.speaker == "bot" and span.voice != LEARNER]
        self._questions_heard += fresh
        if self._silence_pending:
            self._silence_pending = False
            return self._spoken("silence_answer", self.scenario.silence_answer, role="candidate")
        if christy and is_sound_check(christy[-1].text):
            # "Can you hear me okay?" (the M032 opening hello): a short yes, which uses up no
            # icebreaker answer and no replay move.
            text = self.scenario.sound_check_text or SOUND_CHECK_ANSWER.text
            return self._spoken(SOUND_CHECK_ANSWER.act, text, role="candidate")
        if (
            self.scenario.silent_after_question is not None
            and not self._silence_done
            and self._questions_heard >= self.scenario.silent_after_question
        ):
            self._silence_done = True
            self._silence_pending = True
            return Action("silent", why="nervous silence")
        plan = self.scenario.icebreaker
        slot = plan[self._icebreaker_slot] if self._icebreaker_slot < len(plan) else "answer"
        self._icebreaker_slot += 1
        if slot != "answer":
            return self._spoken(slot, self.scenario.icebreaker_beats[slot], role="candidate")
        text = await self.talker.icebreaker_answer()
        act = getattr(self.talker, "last_act", None) or "icebreaker_answer"
        intent = getattr(self.talker, "last_intent", None)
        traits = tuple(getattr(self.talker, "last_traits", ()) or ())
        if act == "ready_button":
            self.pressed = True
            return Action("press", why="scenario", intent=intent)
        return self._spoken(act, text, role="candidate", intent=intent, traits=traits)

    async def _transition_action(self, view: View) -> Action:
        if self.scenario.press_button == "mid_brief" and not self.button_missing:
            if self.pressed:
                return Action("wait")
            self.pressed = True  # the brief ended before the 40 % mark could be seen: press now
            return Action("press", why="after_brief")
        if not view.heard:
            return Action("wait")
        while self._transition and self._answered_repeat(self._transition[0]):
            # D4-H-REPLAY1: the real tester asked to hear a question again that this candidate has
            # answered already; the replay goes on with its next line instead.
            self._transition.pop(0)
        if self._transition:
            beat = self._transition.pop(0)
            if beat.act == "ready_button" and not self.button_missing:
                self.pressed = True
                return Action("press", why="scenario", intent=beat.intent or None)
            if beat.act == "ready_button":  # no button on the page: the candidate says it instead
                return self._spoken("ready", self.scenario.ready_fallbacks[0], role="candidate")
            text = await self._beat_text(beat)
            if not text:
                return Action("wait")
            return self._spoken(beat.act, text, role="candidate", intent=beat.intent or None, traits=beat.traits)
        fallbacks = self.scenario.ready_fallbacks
        if self._extra_ready < len(fallbacks) + MAX_EXTRA_READY:
            text = fallbacks[min(self._extra_ready, len(fallbacks) - 1)]
            self._extra_ready += 1
            return self._spoken("ready", text, role="candidate")
        if self.button_missing or self.pressed:
            return Action("silent", why="ready_not_taken")
        self.pressed = True
        return Action("press", why="ready_not_taken")

    def _answered_repeat(self, beat: Beat) -> bool:
        """A replayed repeat request whose question (the one before the last for "that earlier
        question", else the last) this candidate already answered."""
        if beat.act != "repeat_request" or not self._ib_questions or not flags.on(flags.REPEAT_IF_UNANSWERED):
            return False
        back = 2 if _EARLIER.search(f"{beat.intent} {beat.text}") else 1
        if len(self._ib_questions) < back:
            return False
        return self._ib_questions[-back]

    async def _wrapup_action(self, view: View) -> Action:
        if not view.heard:
            return Action("wait")
        if not self._wrapup:
            self.done = True
            return Action("silent")
        beat = self._wrapup.pop(0)
        text = await self.talker.wrapup_question() if beat.text == FREE else await self._beat_text(beat)
        if not self._wrapup and beat.act in ("wrapup_none", "wrapup_done"):
            self.done = True
        return self._spoken(beat.act, text, role="candidate", intent=beat.intent or None, traits=beat.traits)

    def _spoken(
        self, act: str, text: str, *, role: str, intent: str | None = None, traits: Sequence[str] = ()
    ) -> Action:
        self.last_act = act
        self.talker.said(text)
        return Action(
            "speak", text=text, act=act, role=role, wps=self.candidate_wps, intent=intent, traits=tuple(traits)
        )

    async def _advisor_action(self, view: View) -> Action:
        learner = view.learner()
        christy = view.christy()
        if self._farewell_quiet:
            return Action("silent", why="advisor_farewell_loop")
        if self.advisor_started and flags.on(flags.ADVISOR_FAREWELL_LOOP):
            # A real advisor hangs up (or goes quiet) after a goodbye or two: the loop of goodbyes the
            # simulator would otherwise keep making is not the product's.
            mutual = (
                self._last_advisor is not None
                and is_sign_off(self._last_advisor, self._last_advisor_r)
                and bool(learner)
                and ends_on_goodbye(learner[-1])
            )
            self._goodbyes_in_a_row = self._goodbyes_in_a_row + 1 if mutual else 0
            if self._goodbyes_in_a_row >= 2:
                self._farewell_quiet = True
                return Action("silent", why="advisor_farewell_loop")
        if not self.advisor_started:
            self.advisor_started = True
            await self.advisor.start(" ".join(learner) or "Hello?")
            learner_text: str | None = None
        else:
            learner_text = " ".join(learner) if learner else "..."
            if christy and not getattr(self.talker, "offline", True):
                learner_text += " " + ASIDE_NOTE.format(text=" ".join(christy))
        self.exchanges += 1
        turn, act = await self.advisor.next_turn(learner_text, float(view.r_sec or 0.0), self.exchanges)
        text = turn.text if re.search(r"[A-Za-z0-9]", turn.text or "") else "Mm-hmm."
        turn.text = text
        if turn.intent in WRAP_READY_INTENTS:
            self._advisor_done = True
        self._last_advisor = turn
        self._last_advisor_r = view.r_sec
        if self.shadow is not None:
            self.shadow.set_turn(turn.as_dict())
        self.last_act = act
        return Action(
            "speak",
            text=text,
            act=act,
            role="advisor",
            advisor=turn,
            wps=self.advisor_wps,
            intent=getattr(self.advisor, "last_intent", None),
            traits=tuple(getattr(self.advisor, "last_traits", ()) or ()),
        )


def heard_since(spans: Sequence[Span], since: float) -> list[Span]:
    """Bot lines that finished after ``since`` (what the candidate heard since its last turn)."""
    return [
        span
        for span in spans
        if span.speaker == "bot" and span.t_end is not None and span.t_end > since
    ]


__all__ = [
    "Action",
    "CandidateSim",
    "LLMTalker",
    "OverlayLLMAdvisor",
    "PRICE_NEVER_OVERLAY",
    "ScenarioAdvisor",
    "ScriptedTalker",
    "View",
    "asks_price",
    "heard_since",
    "is_icebreaker_question",
    "is_sound_check",
    "INTERVIEWER",
]
