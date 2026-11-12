"""The SDK side of a full-interview call, on the virtual clock (``rehearsal.vloop``).

``R1Interview.run`` is the production phase driver; this module plays everything around it the way
livekit-agents 1.6.4 does on a call, on the same seams the role-play tier's ``Rig`` uses
(``tests.test_r1_integration``) and the test fakes it is built from (``tests.test_r1_core``):

* ``SimSession`` (a ``FakeSession``) plays every scripted ``say`` line for a modelled duration (its
  words at the voice's pace), with ``agent_state_changed`` speaking/listening around it and the
  delivered item at the end, and runs the driver's own ``generate_reply`` (the wrap-up's owed
  answer) through the reply pipeline;
* ``SimContext`` / its room record every attribute write the page would see (``phase``,
  ``awaiting`` ...) on the virtual clock: the phase trace;
* ``SimWriter`` (the integration tests' ``AdminWriter``) keeps every transcript row with all the
  columns the session wrote (the 0136 timing facts included) and every administration row;
* ``SdkDriver.speak`` is one candidate turn: ``user_state_changed`` speaking, the STT finals
  (``user_input_transcribed``; a long answer is several finals, as Sarvam splits it), listening, the
  endpointing delay, then the commit (``R1Agent.on_user_turn_completed``) and, unless it raised
  ``StopResponse``, the reply: ``speech_created``, ``agent_state_changed`` thinking, the
  ``llm_node`` stream, speaking for the reply's modelled duration, ``conversation_item_added``,
  listening.  ``SdkDriver.press_ready`` is the page's "I'm ready" button exactly as the API relays
  it: a server-sent ``data_received`` packet on ``READY_TOPIC`` (``tests.test_r1_core``
  ``TestReadyButton``).

Not emulated: barge-in (the simulated candidate waits for the floor), the STT node's acknowledgement
hold, VAD fragments, TTS audio and the recording.  ``Span`` is the harness's own record of who spoke
when (virtual seconds, the S and R clocks), which the transcript rows are joined with.
"""
from __future__ import annotations

import asyncio
import contextlib
import importlib
import itertools
import json
import random
import re
import sys
from dataclasses import asdict, dataclass, field
from types import SimpleNamespace
from typing import Any, Callable, Iterator

from rehearsal import vloop
from rehearsal.clock import TimingParams
from r1_replies import delta_text
from r1_text import word_count

INTERVIEWER = "interviewer"
LEARNER = "learner"
CANDIDATE = "candidate"
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
FINAL_MAX_WORDS = 28
MIN_FINAL_SEC = 0.5
SETTLE_TICKS = 40
_IDS = itertools.count(1)


@dataclass(frozen=True)
class FullTiming:
    """Seconds of the parts of the interview that are not the model (seeded, reproducible).

    The role-play values are the calibrated ones of ``rehearsal.clock.TimingParams`` (the advisor's
    3.2 words per second, the learner's 2.7, the endpoint, the reaction), so R behaves as in the
    role-play tier.  Christy speaks at the learner's pace; the candidate speaks to Christy at a
    plainer 2.6 words per second.  A scripted line starts from cached audio (0.3 s), a reply after
    the TTS start (0.9 s).  Offline, the scripted models answer after a modelled latency (the
    learner 2.5 s, Christy 1.5 s); live, the latency is the real one.
    """

    params: TimingParams = field(default_factory=TimingParams)
    christy_wps: float = 2.7
    candidate_wps: float = 2.6
    say_start: float = 0.3
    offline_interviewer_llm_sec: float = 1.5

    @property
    def advisor_wps(self) -> float:
        return self.params.advisor_wps

    @property
    def learner_wps(self) -> float:
        return self.params.learner_wps

    @property
    def reply_start(self) -> float:
        return self.params.tts_start

    @property
    def offline_learner_llm_sec(self) -> float:
        return self.params.offline_llm_sec

    def speak_seconds(self, text: str, voice: str | None) -> float:
        wps = self.learner_wps if voice == LEARNER else self.christy_wps
        return max(self.params.min_speak_sec, word_count(text) / wps)


class SimClockRng:
    """The seeded draws of one call (endpoint, reaction)."""

    def __init__(self, seed: str, timing: FullTiming) -> None:
        self._rng = random.Random(f"rehearsal-full:{seed}")
        self.timing = timing

    def endpoint(self) -> float:
        p = self.timing.params
        return self._rng.uniform(p.endpoint_lo, p.endpoint_hi)

    def reaction(self) -> float:
        p = self.timing.params
        return self._rng.uniform(p.reaction_lo, p.reaction_hi)


@dataclass
class Span:
    """One stretch of speech on the virtual clock (the harness's own record of who spoke when)."""

    speaker: str  # "bot" or "candidate"
    voice: str | None  # interviewer, learner or candidate
    text: str
    source: str  # say, reply or candidate
    t_start: float
    phase: str
    s_sec: float
    r_sec: float | None
    t_end: float | None = None
    act: str | None = None
    role: str | None = None
    interrupted: bool = False
    intent: str | None = None  # the manual library's description of a candidate move

    def as_dict(self) -> dict[str, Any]:
        out = asdict(self)
        out["t_start"] = round(self.t_start, 2)
        out["t_end"] = None if self.t_end is None else round(self.t_end, 2)
        out["s_sec"] = round(self.s_sec, 1)
        out["r_sec"] = None if self.r_sec is None else round(self.r_sec, 1)
        return out


def split_finals(text: str, max_words: int = FINAL_MAX_WORDS) -> list[str]:
    """A spoken turn as the STT hands it over: one final per pause, about a sentence group each."""
    sentences = [part.strip() for part in _SENTENCE.split(text.strip()) if part.strip()]
    if not sentences:
        return [text.strip()] if text.strip() else []
    finals: list[str] = []
    current: list[str] = []
    for sentence in sentences:
        if current and word_count(" ".join(current + [sentence])) > max_words:
            finals.append(" ".join(current))
            current = []
        current.append(sentence)
    if current:
        finals.append(" ".join(current))
    return finals


def _state(old: str, new: str) -> SimpleNamespace:
    return SimpleNamespace(old_state=old, new_state=new, created_at=vloop.epoch_now())


async def settle(ticks: int = SETTLE_TICKS) -> None:
    for _ in range(ticks):
        await asyncio.sleep(0)


# ------------------------------------------------------------------------------- fakes
def _fakes() -> SimpleNamespace:
    """The test fakes the session runs on (imported lazily: they need the tests package)."""
    from tests import test_r1_core as core
    from tests import test_r1_integration as integration

    return SimpleNamespace(core=core, integration=integration)


class Runtime:
    """The shared state of one simulated call: the clock, the spans, the events, the interview."""

    def __init__(self, seed: str, *, offline: bool, timing: FullTiming | None = None) -> None:
        self.seed = seed
        self.offline = offline
        self.timing = timing or FullTiming()
        self.rng = SimClockRng(seed, self.timing)
        self.order: list[Any] = []
        self.spans: list[Span] = []
        self.events: list[dict[str, Any]] = []
        self.attributes: list[dict[str, Any]] = []
        self.page: dict[str, str] = {}
        self.interview: Any = None
        self.saying = 0
        self.replying = 0
        self.candidate_speaking = False
        self.now_playing: Span | None = None
        self.now_playing_seconds = 0.0

    # ------------------------------------------------------------------- clocks
    def now(self) -> float:
        return asyncio.get_running_loop().time()

    def clocks(self) -> tuple[str, float, float | None]:
        machine = getattr(self.interview, "machine", None)
        if machine is None:
            return "opening", 0.0, None
        phase = machine.transcript_phase()
        r_sec = float(machine.roleplay_elapsed) if machine.roleplay_entered else None
        return phase, float(machine.session_clock), r_sec

    def open_span(self, speaker: str, voice: str | None, text: str, source: str, **extra: Any) -> Span:
        phase, s_sec, r_sec = self.clocks()
        span = Span(speaker, voice, text, source, self.now(), phase, s_sec, r_sec, **extra)
        self.spans.append(span)
        return span

    def close_span(self, span: Span, *, interrupted: bool = False) -> None:
        span.t_end = self.now()
        span.interrupted = interrupted

    def note_event(self, kind: str, **detail: Any) -> dict[str, Any]:
        phase, s_sec, r_sec = self.clocks()
        event = {
            "kind": kind,
            "t": round(self.now(), 2),
            "phase": phase,
            "s_sec": round(s_sec, 1),
            "r_sec": None if r_sec is None else round(r_sec, 1),
            **detail,
        }
        self.events.append(event)
        return event

    @property
    def floor_free(self) -> bool:
        """Nobody is speaking or about to: no scripted line, no reply in flight."""
        return not self.saying and not self.replying and not self.candidate_speaking

    def voice_of(self, handle: Any) -> str | None:
        voices = getattr(self.interview, "_voices", None) or {}
        return voices.get(str(getattr(handle, "id", "")))


def build_session(runtime: Runtime) -> Any:
    """A ``FakeSession`` whose ``say`` lines take their modelled time on the virtual clock."""
    fakes = _fakes()

    class SimSession(fakes.core.FakeSession):
        def __init__(self) -> None:
            super().__init__(log=runtime.order)
            self.driver: "SdkDriver | None" = None

        async def _play(self, handle: Any, text: str) -> None:  # mirrors FakeSession._play
            runtime.saying += 1
            try:
                self.log.append(("play_start", text))
                self.current_speech = handle
                voice = runtime.voice_of(handle)
                span = runtime.open_span("bot", voice, text, "say")
                seconds = runtime.timing.say_start + runtime.timing.speak_seconds(text, voice)
                runtime.now_playing, runtime.now_playing_seconds = span, seconds
                self.emit("agent_state_changed", _state("listening", "speaking"))
                await asyncio.sleep(seconds)
                interrupted, self.next_interrupted = self.next_interrupted or handle.interrupted, False
                message = fakes.core.FakeChatMessage(text, interrupted=interrupted)
                handle.chat_items.append(message)
                runtime.close_span(span, interrupted=interrupted)
                runtime.now_playing = None
                self.emit("conversation_item_added", SimpleNamespace(item=message))
                self.current_speech = None
                self.emit("agent_state_changed", _state("speaking", "listening"))
                self.log.append(("play_end", text))
                handle.finish()
            finally:
                runtime.saying -= 1

        def generate_reply(self, **kwargs: Any) -> Any:
            """The driver asked for a reply itself (the wrap-up's owed answer): it is generated
            and spoken, as the SDK does, from the reply the hook prepared."""
            handle = fakes.core.FakeSpeechHandle("reply")
            self.generated.append(handle)
            self.emit(
                "speech_created",
                SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
            )
            if self.driver is not None:
                runtime.replying += 1  # claimed now: the floor is taken from this moment
                self._tasks.append(asyncio.ensure_future(self.driver.driven_reply(handle)))
            return handle

    return SimSession()


def build_context(runtime: Runtime, identity: str = "candidate") -> Any:
    """A ``FakeContext`` with the candidate in the room and the page's attributes on the clock."""
    fakes = _fakes()
    ctx = fakes.core.FakeContext(runtime.order)
    ctx.room.remote_participants[identity] = fakes.core.FakeParticipant(identity)
    local = ctx.room.local_participant
    inner = local.set_attributes

    async def set_attributes(attributes: dict[str, str]) -> None:
        values = {str(k): str(v) for k, v in dict(attributes).items()}
        runtime.page.update(values)
        phase, s_sec, r_sec = runtime.clocks()
        runtime.attributes.append(
            {"t": round(runtime.now(), 2), "s_sec": round(s_sec, 1), "attributes": values}
        )
        await inner(attributes)

    local.set_attributes = set_attributes
    return ctx


def build_writer(runtime: Runtime) -> Any:
    """The integration tests' ``AdminWriter`` that also keeps every column the session wrote."""
    fakes = _fakes()

    class SimWriter(fakes.integration.AdminWriter):
        def __init__(self) -> None:
            super().__init__(runtime.order)
            self.columns: dict[int, dict[str, Any]] = {}

        async def save_turn(self, index, speaker, text, phase, **kwargs) -> None:
            self.columns[index] = {
                key: kwargs.get(key)
                for key in ("started_at_ms", "ended_at_ms", "voice", "played_ms")
                if key in kwargs
            }
            self.columns[index]["written_at"] = round(runtime.now(), 2)
            await super().save_turn(index, speaker, text, phase, **kwargs)

    return SimWriter()


# ------------------------------------------------------------------------- the SDK seams
class SdkDriver:
    """One candidate turn, the reply to it, and the "I'm ready" button (see the module docstring)."""

    def __init__(self, runtime: Runtime, session: Any, ctx: Any, recorders: dict[str, Any]) -> None:
        self.rt = runtime
        self.session = session
        self.ctx = ctx
        self.recorders = recorders
        session.driver = self

    @property
    def interview(self) -> Any:
        return self.rt.interview

    def recorder(self) -> Any:
        phase = self.interview.machine.phase.value
        return self.recorders["learner" if phase in ("roleplay", "aside") else "interviewer"]

    def press_ready(self, why: str) -> None:
        """The page's button: the API relays ``{"v": 1, "kind": "ready"}`` server-side."""
        from r1_session import READY_PAYLOAD_KIND, READY_PAYLOAD_VERSION, READY_TOPIC

        data = json.dumps(
            {"v": READY_PAYLOAD_VERSION, "kind": READY_PAYLOAD_KIND}, separators=(",", ":")
        ).encode("utf-8")
        playing = self.rt.now_playing
        self.rt.note_event(
            "ready_button",
            why=why,
            awaiting=self.rt.page.get("awaiting"),
            during_line=None if playing is None else playing.text[:60],
        )
        packet = SimpleNamespace(data=data, kind=0, participant=None, topic=READY_TOPIC)
        self.ctx.room.emit("data_received", packet)

    async def speak(
        self, text: str, *, wps: float, act: str | None, role: str | None, intent: str | None = None
    ) -> dict[str, Any]:
        """One candidate turn through the SDK seams; returns what happened to it."""
        from r1_session import StopResponse

        rt = self.rt
        session = self.session
        finals = split_finals(text)
        if not finals:
            return {"suppressed": True, "why": "empty", "spoken": None}
        rt.candidate_speaking = True
        span = rt.open_span(
            "candidate", CANDIDATE, " ".join(finals), "candidate", act=act, role=role, intent=intent
        )
        try:
            session.emit("user_state_changed", _state("listening", "speaking"))
            for final in finals:
                await asyncio.sleep(max(MIN_FINAL_SEC, word_count(final) / wps))
                session.emit(
                    "user_input_transcribed",
                    SimpleNamespace(is_final=True, transcript=final, created_at=vloop.epoch_now()),
                )
                await settle()
            session.emit("user_state_changed", _state("speaking", "listening"))
        finally:
            rt.close_span(span)
            rt.candidate_speaking = False
        await asyncio.sleep(rt.rng.endpoint())
        interview = self.interview
        if getattr(interview, "_exiting", False) or session.agent is None:
            return {"suppressed": True, "why": "exiting", "spoken": None, "span": span}
        recorder = self.recorder()
        previous = getattr(interview, "_last_reply", None)
        recorder.take()
        message_id = f"msg_{next(_IDS)}"
        rt.replying += 1
        try:
            try:
                await session.agent.on_user_turn_completed(
                    None, SimpleNamespace(text_content=span.text, id=message_id)
                )
            except StopResponse:
                await settle()
                return {"suppressed": True, "why": "stop_response", "spoken": None, "span": span}
            handle = _fakes().core.FakeSpeechHandle("reply")
            session.emit(
                "speech_created",
                SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=True),
            )
            spoken = await self._play_reply(handle, message_id, recorder)
        finally:
            rt.replying -= 1
        reply = getattr(interview, "_last_reply", None)
        return {
            "suppressed": False,
            "spoken": spoken,
            "span": span,
            "calls": recorder.take(),
            "plan": reply.plan if (reply is not None and reply is not previous) else None,
        }

    async def driven_reply(self, handle: Any) -> None:
        """A reply the driver asked for (``generate_reply``); the floor was claimed for it."""
        try:
            await self._play_reply(handle, None, self.recorders["interviewer"])
        finally:
            self.rt.replying -= 1

    async def _play_reply(self, handle: Any, message_id: str | None, recorder: Any) -> str | None:
        rt = self.rt
        session = self.session
        session.emit("agent_state_changed", _state("listening", "thinking"))
        items = [SimpleNamespace(role="user", id=message_id)] if message_id else []
        stream = self.interview.llm_node_stream(SimpleNamespace(items=items), recorder)
        parts: list[str] = []
        async for chunk in stream:
            parts.append(chunk if isinstance(chunk, str) else delta_text(chunk))
        spoken = "".join(parts).strip()
        if not spoken:
            session.emit("agent_state_changed", _state("thinking", "listening"))
            handle.finish()
            await settle()
            return None
        voice = rt.voice_of(handle)
        await asyncio.sleep(rt.timing.reply_start)
        session.current_speech = handle
        session.emit("agent_state_changed", _state("thinking", "speaking"))
        span = rt.open_span("bot", voice, spoken, "reply")
        await asyncio.sleep(rt.timing.speak_seconds(spoken, voice))
        message = _fakes().core.FakeChatMessage(spoken, interrupted=False)
        handle.chat_items.append(message)
        rt.close_span(span)
        session.emit("conversation_item_added", SimpleNamespace(item=message))
        session.current_speech = None
        session.emit("agent_state_changed", _state("speaking", "listening"))
        handle.finish()
        await settle()
        return spoken


# --------------------------------------------------------------------------- latency
class ModelledLatency:
    """An offline provider whose first token comes after a modelled model latency."""

    def __init__(self, inner: Callable[[list], Any], seconds: Callable[[list], float]) -> None:
        self._inner = inner
        self._seconds = seconds

    def __call__(self, messages: list) -> Any:
        return self._stream(messages)

    async def _stream(self, messages: list) -> Any:
        await asyncio.sleep(self._seconds(messages))
        source = self._inner(messages)
        if asyncio.iscoroutine(source):
            source = await source
        async for item in source:
            yield item


# ------------------------------------------------------------------------------ logs
@contextlib.contextmanager
def capture_logs(clock: Callable[[], float]) -> Iterator[list[dict[str, Any]]]:
    """Every structured line of every loaded ``r1_*`` module, stamped with the virtual clock.

    The lines carry labels and numbers only (the session never logs candidate text); the harness
    keeps their ``error_type`` / ``error_category`` / ``phase`` and the clock.
    """
    lines: list[dict[str, Any]] = []
    patched: list[tuple[Any, Any]] = []
    seen: set[int] = set()
    for name, module in list(sys.modules.items()):
        if not name.startswith("r1_") or module is None:
            continue
        logger = getattr(module, "_log", None)
        if logger is None or not hasattr(logger, "_writer") or id(logger) in seen:
            continue
        seen.add(id(logger))
        patched.append((logger, logger._writer))

        def writer(raw: str, _lines: list = lines) -> None:
            try:
                data = json.loads(raw)
            except ValueError:
                return
            data["_t"] = round(clock(), 2)
            _lines.append(data)

        logger._writer = writer
    try:
        yield lines
    finally:
        for logger, previous in patched:
            logger._writer = previous


def import_optional(name: str) -> Any:
    """A module of the code base, or None where this checkout does not have it (feature detect)."""
    try:
        return importlib.import_module(name)
    except ImportError:
        return None
