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

from rehearsal.advisor import (
    AdvisorTurn,
    LLMAdvisor,
    advisor_messages,
    parse_advisor_output,
)
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
ROLEPLAY_PATIENCE_SEC = 2.0
WAIT_STEP_SEC = 1.0
MAX_EXTRA_READY = 3
DEFAULT_END_DECLINE = Beat("end_decline", "No, sorry, let's carry on.")
WRAP_ACCEPT = Beat("wrap_accept", "Yes, let's wrap it up here.")
WRAP_DECLINE = Beat("wrap_decline", "No, let's keep going.")
WRAP_ACCEPT_FROM_R_SEC = 1080.0
ASIDE_NOTE = "(Christy, the interviewer, stepped in and said: {text})"
_PRICE_ASK = re.compile(
    r"\b(?:how much|price|cost|costs|fees?|afford|expensive|\$\s?\d|\d[\d,]*\s*(?:dollars|usd))\b",
    re.IGNORECASE,
)
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
    open_question: str | None = None  # "end" (L-ASIDE-END) or "wrap" (the offer to wrap up)
    commitment_resolved: bool = False
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
        completion = await self.client.complete(
            messages,
            model=self.model,
            temperature=self.temperature,
            max_tokens=260,
            json_mode=True,
            role="candidate",
        )
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
    """

    def __init__(self, base: Any, scenario: Scenario, *, rewriter: Any = None) -> None:
        self.base = base
        self.scenario = scenario
        self.rewriter = rewriter
        self._beats = list(scenario.roleplay)
        self.dodges = 0
        self.held = 0
        self.price_questions = 0
        self.names: dict[str, str] = {}
        self.last_intent: str | None = None
        self._chat: list[dict[str, str]] = []

    def bind(self, names: dict[str, str]) -> None:
        self.names.update({k: v for k, v in names.items() if v})
        bind = getattr(self.base, "bind", None)
        if callable(bind):
            bind(names)

    async def start(self, pickup: str) -> None:
        self._chat.append({"role": "user", "content": pickup})
        await self.base.start(pickup)

    async def _beat_text(self, beat: RoleplayBeat) -> str:
        """A beat's words: word for word, or (a library beat, live) reworded to fit the call."""
        if not beat.intent:
            return beat.text
        from rehearsal.manual import render

        text = render(beat.text, self.names) or "Mm-hmm."
        if self.rewriter is not None and beat.act != "insult":
            text = await self.rewriter.reword("advisor", beat.intent, text, self._chat, self.names)
        return text

    def _remember(self, learner_text: str | None, turn: AdvisorTurn) -> None:
        history = getattr(self.base, "history", None)
        if isinstance(history, list):
            if learner_text is not None:
                history.append({"who": "learner", "text": learner_text})
            history.append({"who": "advisor", "text": turn.text, "intent": turn.intent, "topic": turn.topic})

    async def next_turn(self, learner_text: str | None, r_sec: float, exchange: int) -> tuple[AdvisorTurn, str]:
        asks_price = bool(learner_text and _PRICE_ASK.search(learner_text))
        if asks_price:
            self.price_questions += 1
        if learner_text is not None:
            self._chat.append({"role": "user", "content": learner_text})
        self.last_intent = None
        if self._beats and r_sec >= self._beats[0].at_r:
            beat = self._beats.pop(0)
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
        if self.scenario.price == "dodge" and asks_price and self.dodges < len(PRICE_DODGES):
            turn = AdvisorTurn(PRICE_DODGES[self.dodges], "followup", "")
            self.dodges += 1
            self._remember(learner_text, turn)
            return turn, "price_dodge"
        turn = await self.base.next_turn(learner_text, r_sec, exchange)
        self._chat.append({"role": "assistant", "content": json.dumps({"text": turn.text})})
        base_act = getattr(self.base, "last_act", None)
        if base_act:  # a replayed move carries its own ground truth
            self.last_intent = getattr(self.base, "last_intent", None)
            return turn, base_act
        if self.scenario.price == "never" and not asks_price and _PRICE_NAMED.search(turn.text or ""):
            held = AdvisorTurn(PRICE_HELD[self.held % len(PRICE_HELD)], "pitch", "")
            self.held += 1
            history = getattr(self.base, "history", None)
            if isinstance(history, list) and history and history[-1].get("who") == "advisor":
                history[-1] = {"who": "advisor", "text": held.text, "intent": held.intent, "topic": ""}
            return held, "price_held"
        return turn, "advisor_turn"


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
        self._christy_lines = 0
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

    def bind(self, names: dict[str, str]) -> None:
        """The names the library texts fill in (the learner's, a wrong one, the candidate's)."""
        for part in (self.talker, self.advisor):
            bind = getattr(part, "bind", None)
            if callable(bind):
                bind(names)

    # --------------------------------------------------------------------- the button
    def press_due(self, phase: str, playing: Span | None, played: float, total: float) -> bool:
        """The mid-brief press: the transition's first line is playing and is past 40 %."""
        if self.pressed or self.scenario.press_button != "mid_brief" or phase != "transition":
            return False
        if playing is None or playing.voice == LEARNER or total <= 0:
            return False
        return played / total >= 0.4

    # ----------------------------------------------------------------------- deciding
    async def next_action(self, view: View) -> Action:
        for text in view.christy():
            self.talker.hear(text)
        if view.phase in ("closing", "finishing", "aborted") or self.done or self.scenario.silent_all:
            return Action("silent", why="no audio" if self.scenario.silent_all else "")
        if view.open_question == "end":
            return self._say(self._end_answer(), role="candidate")
        if view.open_question == "wrap":
            accept = view.commitment_resolved or (view.r_sec or 0.0) >= WRAP_ACCEPT_FROM_R_SEC
            return self._say(WRAP_ACCEPT if accept else WRAP_DECLINE, role="candidate")
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
            "speak", text=beat.text, act=beat.act, role=role, wps=self.candidate_wps, intent=beat.intent or None
        )

    async def _beat_text(self, beat: Beat) -> str:
        """A control beat is said word for word; a library beat goes through the talker (rendered,
        and reworded live)."""
        reword = getattr(self.talker, "reword", None)
        if beat.intent and callable(reword):
            return await reword(beat)
        return beat.text

    def _end_answer(self) -> Beat:
        if self._end_answers:
            return self._end_answers.pop(0)
        return DEFAULT_END_DECLINE

    async def _icebreaker(self, view: View) -> Action:
        if not view.heard:
            if self.last_act == "hold_request" and view.waited >= THINK_PAUSE_SEC:
                text = await self.talker.icebreaker_answer(thinking=True)
                return self._spoken("icebreaker_answer", text, role="candidate")
            return Action("wait")
        self._christy_lines += sum(1 for span in view.heard if span.voice != LEARNER)
        if self._silence_pending:
            self._silence_pending = False
            return self._spoken("silence_answer", self.scenario.silence_answer, role="candidate")
        if (
            self.scenario.silent_after_question is not None
            and not self._silence_done
            and self._christy_lines >= self.scenario.silent_after_question  # L-OPEN is line 1
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
        if act == "ready_button":
            self.pressed = True
            return Action("press", why="scenario", intent=intent)
        return self._spoken(act, text, role="candidate", intent=intent)

    async def _transition_action(self, view: View) -> Action:
        if self.scenario.press_button == "mid_brief":
            if self.pressed:
                return Action("wait")
            self.pressed = True  # the brief ended before the 40 % mark could be seen: press now
            return Action("press", why="after_brief")
        if not view.heard:
            return Action("wait")
        if self._transition:
            beat = self._transition.pop(0)
            if beat.act == "ready_button":
                self.pressed = True
                return Action("press", why="scenario", intent=beat.intent or None)
            text = await self._beat_text(beat)
            if not text:
                return Action("wait")
            return self._spoken(beat.act, text, role="candidate", intent=beat.intent or None)
        fallbacks = self.scenario.ready_fallbacks
        if self._extra_ready < len(fallbacks) + MAX_EXTRA_READY:
            text = fallbacks[min(self._extra_ready, len(fallbacks) - 1)]
            self._extra_ready += 1
            return self._spoken("ready", text, role="candidate")
        self.pressed = True
        return Action("press", why="ready_not_taken")

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
        return self._spoken(beat.act, text, role="candidate", intent=beat.intent or None)

    def _spoken(self, act: str, text: str, *, role: str, intent: str | None = None) -> Action:
        self.last_act = act
        self.talker.said(text)
        return Action("speak", text=text, act=act, role=role, wps=self.candidate_wps, intent=intent)

    async def _advisor_action(self, view: View) -> Action:
        learner = view.learner()
        christy = view.christy()
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
    "heard_since",
    "INTERVIEWER",
]
