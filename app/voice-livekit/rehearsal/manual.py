"""The owner's manual tests as full-interview scenarios (M032 S8 item 1b).

``scenarios/manual_tests.json`` is the scenario library built from the team's manual R1 sessions.
All of it is PARAPHRASED: the candidate is "Alex", there are no session ids, names, e-mails or
phones and no verbatim candidate sentence.  It has

* a ``behaviour_catalogue`` per phase (what testers did, with example paraphrases), and
* ``replays`` M01-M10: one session's candidate moves in order (phase, time, intent, text).

Two scenario families come from it:

* ``manual-M01`` ... ``manual-M10`` (group ``manual-replay``): the replay's moves, said in order
  whenever the candidate has the floor in the move's phase.  Offline the paraphrase is said as it is;
  live a DeepSeek rewriter keeps the move's intent but rewords it to fit what Christy or the learner
  actually said.  When a phase's moves run out the candidate goes on as the scenario's fallback
  (icebreaker answers from the bank, "ready", the advisor behaviour of the replay's level), so every
  replay runs the WHOLE interview even where the real session ended early.
* ``manual-mix`` (group ``manual-mix``): one call samples answer types, transition questions,
  role-play tactics and wrap-up questions from the catalogue (seeded, so a call id is reproducible).

Placeholders in the library are rendered per call: ``{learner}`` is the learner's first name,
``{wrong_name}`` another name, ``[expletive]`` a mild stand-in, a bracketed stage note is dropped,
and ``[presses the I'm-ready button ...]`` is the button itself.
"""
from __future__ import annotations

import dataclasses
import json
import random
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence

from rehearsal.advisor import AdvisorTurn
from rehearsal.scenarios import (
    GROUPS,
    SCENARIOS,
    WRAP_DONE,
    Beat,
    RoleplayBeat,
    Scenario,
)

LIBRARY_PATH = Path(__file__).resolve().parent / "scenarios" / "manual_tests.json"
MIX = "manual-mix"
REPLAY_PREFIX = "manual-"
CANDIDATE = "Alex"
WRONG_NAMES = ("Priya", "Neha", "Kavya")
# The advisor behaviour each replay falls back to once its role-play moves run out (read from
# the replay's ``advisor_style``): most testers were average or pushy.
REPLAY_LEVEL = {
    "M01": "pushy",
    "M02": "average",
    "M03": "pushy",
    "M04": "average",
    "M05": "pushy",
    "M06": "pushy",
    "M07": "average",
    "M08": "average",
    "M09": "strong",
    "M10": "average",
}
END_AGREE = Beat("end_agree", "Yes, please end it here.")

_PRESS = re.compile(r"^\s*\[(?:silence, then )?presses (?:the )?I'm-ready", re.IGNORECASE)
_STAGE = re.compile(
    r"\[(?:to someone (?:off-call|nearby)|aside(?:, off-call)?|garbled letters)\]\s*", re.IGNORECASE
)
_REPLACE = (
    (re.compile(r"\[expletive\] off", re.IGNORECASE), "get lost, you idiot"),
    (re.compile(r"\[expletive\]", re.IGNORECASE), "rubbish"),
    (re.compile(r"\[crude brush-off\]", re.IGNORECASE), "Oh, get lost."),
    (re.compile(r"\[colleague\]", re.IGNORECASE), "Sam"),
    (re.compile(r"\[one garbled word\]", re.IGNORECASE), "Uh."),
    (re.compile(r"\[learner\]", re.IGNORECASE), "{learner}"),
    (re.compile(r"\[another wrong name\]", re.IGNORECASE), "{other_wrong_name}"),
    (re.compile(r"\[wrong name\]", re.IGNORECASE), "{wrong_name}"),
)
_BRACKET = re.compile(r"\[[^\]]*\]\s*")


# ----------------------------------------------------------------------------- the library
@lru_cache(maxsize=4)
def load_library(path: str | None = None) -> dict[str, Any]:
    """The scenario library (``scenarios/manual_tests.json``)."""
    return json.loads(Path(path or LIBRARY_PATH).read_text(encoding="utf-8"))


def render(text: str, names: Mapping[str, str]) -> str:
    """A library text with its placeholders filled in for this call (see the module docstring)."""
    out = _STAGE.sub("", text or "")
    for pattern, value in _REPLACE:
        out = pattern.sub(value, out)
    out = _BRACKET.sub("", out)
    out = out.replace("{learner}", names.get("learner") or "there")
    out = out.replace("{wrong_name}", names.get("wrong_name") or WRONG_NAMES[0])
    out = out.replace("{other_wrong_name}", names.get("other_wrong_name") or WRONG_NAMES[1])
    out = out.replace("{candidate}", names.get("candidate") or CANDIDATE)
    return re.sub(r"\s+", " ", out).strip()


def is_press(text: str) -> bool:
    return bool(_PRESS.search(text or ""))


def act_of(phase: str, intent: str, text: str) -> str:
    """The ground-truth act of a library move, read from its intent (and the text)."""
    what = f"{intent} || {text}".lower()
    if is_press(text):
        return "ready_button"
    if phase in ("opening", "icebreaker"):
        if re.search(r"\bskip(?:s)? (?:straight )?to|jump (?:straight )?to|straight to the role", what):
            return "skip_request"
        if "repeat the question" in what:
            return "repeat_request"
        if re.search(r"presence check|are you there|can you hear", what):
            return "presence_check"
        if re.search(r"\bready\b", intent.lower()):
            return "ready"
        if re.search(r"^(?:backchannel|acknowledg|thanks|filler|fragment|stt noise)", intent.lower()):
            return "backchannel"
        return "icebreaker_answer"
    if phase == "transition":
        if re.search(r"\bready\b", intent.lower()):
            return "ready"
        if re.search(r"short(?:er)? version|condensed|shorter|short version", what):
            return "short_brief_request"
        if re.search(r"presence|are you there", what):
            return "presence_check"
        if re.search(r"brief|again|repeat|go over|instructions|sum up|summary|role-play part", what):
            return "brief_request"
        if re.search(r"question|asks|ask about|role", intent.lower()):
            return "roleplay_question"
        return "transition_other"
    if phase == "roleplay":
        if re.search(r"swears at|hostile|abus|crude line", intent.lower()):
            return "insult"
        if re.search(
            r"steps out of role|end (?:or close )?the role-?play|close the role-?play|end the interview|"
            r"wrap up this interview|end phrase|command phrase|finish the role-?play|wants to stop",
            what,
        ):
            return "end_request"
        return "advisor_turn"
    if phase == "wrapup":
        if re.search(r"^no questions|no questions, thanks", intent.lower()):
            return "wrapup_none"
        if "?" in text or re.search(r"^asks|complains|didn't hear|did not hear", intent.lower()):
            return "wrapup_question"
        return "wrapup_other"
    return "other"


def advisor_tags(intent: str, text: str) -> tuple[str, str]:
    """(intent, topic) of a replayed advisor move, in the advisor simulator's tag set."""
    what = f"{intent} {text}".lower()
    topic = ""
    if re.search(r"\$|price|discount|emi|instal|pay|cost|scholarship|off\b|rupees", what):
        topic = "F1"
    elif re.search(r"\btime\b|hours|schedule|busy|fall behind|recording|weekend|days", what):
        topic = "F2"
    elif re.search(r"free|layoff|job|alumni|placed|hired", what):
        topic = "F3"
    elif re.search(r"husband|wife|partner|parent|family|think it over|talk it over|decide", what):
        topic = "F4"
    if re.search(r"sign(?:s)? off|signs off|bye\b|goodbye", what):
        return "farewell", ""
    if re.search(r"^greet|greets|how's it going|how are you", what):
        return "greet", ""
    if re.search(r"discount|\boff\b|scholarship|free month|festival offer|emi|instal", what):
        return "discount", "F1"
    if re.search(r"today-only|limited|urgen|scarcity|batch closing|threat", what):
        return "urgency", topic
    if re.search(r"call back|callback|when she'll decide|follow-up: when", what):
        return "callback", topic
    if re.search(r"enrol|sign up|close|pay today|take payment|next step", what):
        return "close_ask", topic
    if topic == "F1":
        return "price", "F1"
    if re.search(r"^asks|discovery|probe|why|what|how many|which", intent.lower()):
        return "probe", ""
    if topic:
        return "answer_objection", topic
    return "pitch", ""


@dataclass(frozen=True)
class Move:
    """One move of a replay: its phase, when it happened, what it was for and how it was said."""

    phase: str
    at: str
    intent: str
    text: str
    act: str

    @property
    def is_press(self) -> bool:
        return self.act == "ready_button"


def replay_moves(replay: Mapping[str, Any]) -> list[Move]:
    phases = {"opening": "icebreaker"}  # the driver enters the icebreaker right after L-OPEN
    moves = []
    for turn in replay.get("turns") or []:
        phase = phases.get(turn["phase"], turn["phase"])
        moves.append(
            Move(phase, str(turn.get("at", "")), str(turn["intent"]), str(turn["text"]),
                 act_of(phase, str(turn["intent"]), str(turn["text"])))
        )
    return moves


def _persona(replay: Mapping[str, Any]) -> str | None:
    from r1_personas import PERSONA_IDS

    token = str(replay.get("learner_persona") or "").split(" ")[0]
    return token if token in PERSONA_IDS else None


def replay_scenario(replay: Mapping[str, Any]) -> Scenario:
    rid = str(replay["id"])
    moves = replay_moves(replay)
    acts = {move.act for move in moves}
    transition = tuple(
        Beat(move.act, move.text, move.intent) for move in moves if move.phase == "transition"
    )
    wrapup = tuple(Beat(move.act, move.text, move.intent) for move in moves if move.phase == "wrapup")
    ends = sum(1 for move in moves if move.act == "end_request")
    tags = ["manual_replay", rid]
    for act, tag in (
        ("end_request", "early_end"),
        ("insult", "abuse"),
        ("ready_button", "ready_button"),
        ("brief_request", "brief_repeat"),
        ("short_brief_request", "short_brief"),
        ("presence_check", "presence_check"),
        ("skip_request", "icebreaker_skip"),
        ("roleplay_question", "transition_questions"),
    ):
        if act in acts:
            tags.append(tag)
    return Scenario(
        f"{REPLAY_PREFIX}{rid}",
        f"Manual replay {rid}: " + str(replay.get("advisor_style") or "")[:160],
        level=REPLAY_LEVEL.get(rid, "average"),
        style="average",
        tags=tuple(tags),
        transition=transition,
        end_answers=(END_AGREE,) * max(1, ends),
        wrapup=wrapup or (WRAP_DONE,),
        persona=_persona(replay),
        candidate_name=CANDIDATE,
        replay_id=rid,
    )


_REGISTERED = False


def register(path: str | None = None) -> tuple[str, ...]:
    """Add the library's scenarios and groups to ``SCENARIOS`` / ``GROUPS`` (idempotent)."""
    global _REGISTERED
    if _REGISTERED and path is None:
        return GROUPS["manual-replay"]
    library = load_library(path)
    names = []
    for replay in library.get("replays") or []:
        scenario = replay_scenario(replay)
        SCENARIOS[scenario.name] = scenario
        names.append(scenario.name)
    SCENARIOS[MIX] = Scenario(
        MIX,
        "A mix sampled from the manual-test catalogue: answer types, transition questions, "
        "role-play tactics at their usual times, wrap-up questions.",
        level="average",
        style="average",
        tags=("manual_mix",),
        transition=(Beat("ready", "Okay, I'm ready."),),
        wrapup=(WRAP_DONE,),
        candidate_name=CANDIDATE,
        mix=True,
    )
    GROUPS["manual-replay"] = tuple(names)
    GROUPS["manual"] = (*names, MIX)
    GROUPS["default"] = (*names, MIX, *GROUPS["synthetic"])
    GROUPS["everything"] = GROUPS["default"]
    _REGISTERED = True
    return tuple(names)


def replay_of(scenario: Scenario) -> Mapping[str, Any] | None:
    if scenario.replay_id is None:
        return None
    for replay in load_library().get("replays") or []:
        if replay["id"] == scenario.replay_id:
            return replay
    return None


# ------------------------------------------------------------------------------ the mix
_SKIP_OPENING = {"opening-6", "opening-7", "opening-8", "icebreaker-21", "icebreaker-11"}
_TRANSITION_ASKS = ("transition-1", "transition-2", "transition-3", "transition-4", "transition-7")
_SKIP_ROLEPLAY = {"roleplay-5", "roleplay-61", "roleplay-64", "roleplay-69"}
_R_TIME = re.compile(r"R\s*~?(\d{1,2}):(\d{2})")


def _items(library: Mapping[str, Any], phase: str) -> list[Mapping[str, Any]]:
    """The catalogue's items of a phase, each keeping only examples that are something to say."""
    items = []
    for item in (library.get("behaviour_catalogue") or {}).get(phase) or []:
        examples = [ex for ex in item.get("examples") or [] if is_press(ex) or render(ex, {"learner": "x"})]
        if examples:
            items.append({**item, "examples": examples})
    return items


def _typical_r(item: Mapping[str, Any], rng: random.Random) -> float:
    found = _R_TIME.search(str(item.get("typical_timing") or ""))
    if found is None:
        return rng.uniform(120.0, 720.0)
    return max(30.0, min(780.0, int(found.group(1)) * 60 + int(found.group(2)) + rng.uniform(0, 45)))


def mix_scenario(seed: str, library: Mapping[str, Any] | None = None) -> tuple[Scenario, list[Beat]]:
    """One call's sampled mix: the scenario (transition, role-play tactics, wrap-up) and the
    icebreaker answers in order (seeded by the call)."""
    library = library or load_library()
    rng = random.Random(f"manual-mix:{seed}")
    answers: list[Beat] = []
    pool = [i for i in _items(library, "opening") + _items(library, "icebreaker") if i["id"] not in _SKIP_OPENING]
    opening = [i for i in pool if i["id"].startswith("opening")]
    first = rng.choice(opening) if opening else rng.choice(pool)
    answers.append(Beat("icebreaker_answer", rng.choice(first["examples"]), str(first["kind"])))
    for item in rng.sample(pool, k=min(7, len(pool))):
        if item is first:
            continue
        text = rng.choice(item["examples"])
        answers.append(Beat(act_of("icebreaker", str(item["kind"]), text), text, str(item["kind"])))
    transition: list[Beat] = []
    asks = [i for i in _items(library, "transition") if i["id"] in _TRANSITION_ASKS]
    for item in rng.sample(asks, k=min(len(asks), rng.choice((0, 1, 1, 2)))):
        text = rng.choice(item["examples"])
        transition.append(Beat(act_of("transition", str(item["kind"]), text), text, str(item["kind"])))
    ready_items = {i["id"]: i for i in _items(library, "transition")}
    press = rng.random() < 0.25
    if press:
        transition.append(Beat("ready_button", "[presses the I'm-ready button; says nothing]", "starts with the button"))
    else:
        item = ready_items.get("transition-5")
        text = rng.choice(item["examples"]) if item else "Okay, I'm ready."
        transition.append(Beat("ready", text, "says ready"))
    tactics: list[RoleplayBeat] = []
    usable = [i for i in _items(library, "roleplay") if i["id"] not in _SKIP_ROLEPLAY]
    hostile = {"roleplay-58", "roleplay-52", "roleplay-53", "roleplay-17"}
    calm = [i for i in usable if i["id"] not in hostile]
    chosen = rng.sample(calm, k=min(5, len(calm)))
    if rng.random() < 0.3:
        chosen.append(rng.choice([i for i in usable if i["id"] in hostile]))
    for item in chosen:
        text = rng.choice(item["examples"])
        act = act_of("roleplay", str(item["kind"]), text)
        if act == "advisor_turn":
            act = "tactic"
        tactics.append(RoleplayBeat(act, text, _typical_r(item, rng), str(item["kind"])))
    tactics.sort(key=lambda beat: beat.at_r)
    wrapup: list[Beat] = []
    wraps = [i for i in _items(library, "wrapup") if i["id"] != "wrapup-8"]
    for item in rng.sample(wraps, k=min(len(wraps), rng.choice((1, 2)))):
        text = rng.choice(item["examples"])
        wrapup.append(Beat(act_of("wrapup", str(item["kind"]), text), text, str(item["kind"])))
    if wrapup[-1].act != "wrapup_none":
        wrapup.append(WRAP_DONE)
    base = SCENARIOS.get(MIX) or Scenario(MIX, "", "average", "average")
    level = rng.choice(("strong", "average", "average", "pushy"))
    scenario = dataclasses.replace(
        base,
        level=level,
        transition=tuple(transition),
        roleplay=tuple(tactics),
        end_answers=(Beat("end_decline", "No, sorry, let's carry on."), END_AGREE),
        wrapup=tuple(wrapup),
        tags=tuple(dict.fromkeys((*base.tags, *(["ready_button"] if press else [])))),
    )
    return scenario, answers


# ----------------------------------------------------------------------- the live rewriter
REWRITE_SYSTEM = (
    "You voice {who}. The conversation so far is below. Your NEXT move is fixed by a test script: "
    "{intent}. This is a paraphrase of how a real tester said it: \"{text}\". Say that move now, in "
    "your own words, so that it fits what was just said to you: keep its intent, its rough length "
    "(about {words} words) and its tone, rough edges included (fillers, hesitations, bluntness), and "
    "add no new topic. Plain spoken English, no stage directions. Reply with ONE JSON object and "
    'nothing else: {{"text": "<what you say aloud>"}}.'
)
WHO = {
    "candidate": (
        "Alex, a job candidate in a first-round interview for the Sales Program Advisor role at "
        "Interview Kickstart, talking to Christy, the AI interviewer"
    ),
    "advisor": (
        "Alex, playing the Program Advisor in a sales role-play: you called back {learner}, a "
        "prospective learner who filled in a web form about the Data Science course"
    ),
}


class Rewriter:
    """Live only: one DeepSeek JSON call rewords a library move to fit the conversation."""

    def __init__(self, client: Any, model: str, *, temperature: float = 0.7) -> None:
        self.client, self.model, self.temperature = client, model, temperature
        self.failures = 0

    async def reword(
        self, role: str, intent: str, text: str, history: Sequence[Mapping[str, str]], names: Mapping[str, str]
    ) -> str:
        who = WHO[role].format(learner=names.get("learner") or "the learner")
        words = max(3, len(text.split()))
        messages = [
            {
                "role": "system",
                "content": REWRITE_SYSTEM.format(who=who, intent=intent, text=text.replace('"', "'"), words=words),
            }
        ]
        messages += [dict(item) for item in list(history)[-16:]]
        messages.append({"role": "system", "content": "Now say your next move."})
        try:
            completion = await self.client.complete(
                messages,
                model=self.model,
                temperature=self.temperature,
                max_tokens=320,
                json_mode=True,
                role="candidate",
            )
        except Exception:  # noqa: BLE001 - the 402 / budget stops are re-raised by the caller's next call
            self.failures += 1
            raise
        raw = (completion.text or "").strip()
        start, end = raw.find("{"), raw.rfind("}")
        try:
            data = json.loads(raw[start : end + 1]) if start >= 0 and end > start else None
        except ValueError:
            data = None
        said = data.get("text") if isinstance(data, dict) else None
        if not isinstance(said, str) or not re.search(r"[A-Za-z]", said):
            self.failures += 1
            return text
        return said.strip()[:900]


# ------------------------------------------------------------------- the replay's talker
class ReplayTalker:
    """Free talk to Christy from a queue of library moves (a replay's, or a mix's answers).

    ``icebreaker_answer`` says the next icebreaker move; ``reword`` says a transition or wrap-up
    beat.  Offline the paraphrase is said as it is (placeholders filled in); live the rewriter
    rewords it to fit what Christy said.  When the queue is empty the fallback talker answers.
    """

    def __init__(self, answers: Sequence[Beat], fallback: Any, *, rewriter: Rewriter | None = None) -> None:
        self._answers = list(answers)
        self.fallback = fallback
        self.rewriter = rewriter
        self.offline = rewriter is None
        self.names: dict[str, str] = {"candidate": CANDIDATE}
        self.history: list[dict[str, str]] = []
        self.last_act: str | None = None
        self.last_intent: str | None = None

    def bind(self, names: Mapping[str, str]) -> None:
        self.names.update({k: v for k, v in names.items() if v})

    def hear(self, text: str) -> None:
        self.history.append({"role": "user", "content": text})
        self.fallback.hear(text)

    def said(self, text: str) -> None:
        self.history.append({"role": "assistant", "content": json.dumps({"text": text})})
        self.fallback.said(text)

    async def _say(self, beat: Beat) -> str:
        text = render(beat.text, self.names)
        if self.rewriter is None or not text:
            return text
        return await self.rewriter.reword("candidate", beat.intent or beat.act, text, self.history, self.names)

    async def icebreaker_answer(self, thinking: bool = False) -> str:
        if self._answers and not thinking:
            beat = self._answers.pop(0)
            self.last_act, self.last_intent = beat.act, beat.intent
            text = await self._say(beat)
            if text:
                return text
        self.last_act, self.last_intent = None, None
        return await self.fallback.icebreaker_answer(thinking)

    async def wrapup_question(self) -> str:
        return await self.fallback.wrapup_question()

    async def reword(self, beat: Beat) -> str:
        self.last_act, self.last_intent = beat.act, beat.intent
        return await self._say(beat)


# ------------------------------------------------------------------ the replay's advisor
class ReplayAdvisor:
    """The replay's role-play moves in order; then the fallback advisor of the replay's level.

    Every move and every learner line also goes into the fallback's ``history`` (live), so the
    advisor that takes over knows the conversation.
    """

    def __init__(self, moves: Sequence[Move], base: Any, *, rewriter: Rewriter | None = None) -> None:
        self._moves = [move for move in moves if move.phase == "roleplay"]
        self.base = base
        self.rewriter = rewriter
        self.names: dict[str, str] = {"candidate": CANDIDATE}
        self.history = getattr(base, "history", None)
        self._chat: list[dict[str, str]] = []
        self.last_act: str | None = None
        self.last_intent: str | None = None
        self.replayed = 0

    def bind(self, names: Mapping[str, str]) -> None:
        self.names.update({k: v for k, v in names.items() if v})

    async def start(self, learner_pickup: str) -> None:
        await self.base.start(learner_pickup)
        match = re.search(r"this is (\w+)", learner_pickup or "", re.IGNORECASE)
        if match and "learner" not in self.names:
            self.names["learner"] = match.group(1)
        self._chat.append({"role": "user", "content": learner_pickup})

    async def next_turn(self, learner_text: str | None, r_sec: float, exchange: int) -> AdvisorTurn:
        if learner_text is not None:
            self._chat.append({"role": "user", "content": learner_text})
        if not self._moves:
            self.last_act, self.last_intent = None, None
            return await self.base.next_turn(learner_text, r_sec, exchange)
        move = self._moves.pop(0)
        self.replayed += 1
        text = render(move.text, self.names) or "Mm-hmm."
        if self.rewriter is not None and move.act != "insult":
            text = await self.rewriter.reword("advisor", move.intent, text, self._chat, self.names)
        intent, topic = advisor_tags(move.intent, text)
        turn = AdvisorTurn(text, intent, topic)
        self._chat.append({"role": "assistant", "content": json.dumps({"text": text})})
        if isinstance(self.history, list):
            if learner_text is not None:
                self.history.append({"who": "learner", "text": learner_text})
            self.history.append({"who": "advisor", "text": text, "intent": intent, "topic": topic})
        self.last_act, self.last_intent = move.act, move.intent
        return turn


# --------------------------------------------------------------------------- per call
@dataclass
class CandidateParts:
    """What one call's candidate is made of: the (realized) scenario, the talker, the advisor."""

    scenario: Scenario
    talker: Any
    advisor: Any


def candidate_parts(
    name: str,
    seed: str,
    level: str,
    *,
    offline: bool,
    client: Any = None,
    model: str = "",
    candidate_name: str = CANDIDATE,
) -> CandidateParts:
    """The scenario, talker and base advisor of one call (offline: scripted; live: DeepSeek)."""
    from rehearsal.candidate import PRICE_NEVER_OVERLAY, LLMTalker, OverlayLLMAdvisor, ScriptedTalker
    from rehearsal.scripted_advisor import ScriptedAdvisor

    register()
    scenario = SCENARIOS[name]
    rewriter = None if offline else Rewriter(client, model)

    def fallback_talker(style: str) -> Any:
        if offline:
            return ScriptedTalker(style, seed)
        return LLMTalker(client, model, style, candidate_name)

    def base_advisor(level_: str, overlay: str = "") -> Any:
        if offline:
            return ScriptedAdvisor(level_, seed)
        return OverlayLLMAdvisor(client, model, level_, overlay)

    if scenario.mix:
        realized, answers = mix_scenario(seed)
        talker = ReplayTalker(answers, fallback_talker(realized.style), rewriter=rewriter)
        return CandidateParts(realized, talker, base_advisor(realized.level))
    replay = replay_of(scenario)
    if replay is not None:
        moves = replay_moves(replay)
        answers = [Beat(m.act, m.text, m.intent) for m in moves if m.phase == "icebreaker"]
        talker = ReplayTalker(answers, fallback_talker(scenario.style), rewriter=rewriter)
        advisor = ReplayAdvisor(moves, base_advisor(level), rewriter=rewriter)
        return CandidateParts(scenario, talker, advisor)
    overlay = PRICE_NEVER_OVERLAY if scenario.price == "never" else ""
    return CandidateParts(scenario, fallback_talker(scenario.style), base_advisor(level, overlay))


__all__ = [
    "CandidateParts",
    "Move",
    "ReplayAdvisor",
    "ReplayTalker",
    "Rewriter",
    "act_of",
    "advisor_tags",
    "candidate_parts",
    "load_library",
    "mix_scenario",
    "register",
    "render",
    "replay_moves",
    "replay_scenario",
]
