"""The SDK side of a full-interview call, on the virtual clock (``rehearsal.vloop``).

``R1Interview.run`` is the production phase driver; this module plays everything around it the way
livekit-agents 1.6.4 does on a call, on the same seams the role-play tier's ``Rig`` uses
(``tests.test_r1_integration``) and the test fakes it is built from (``tests.test_r1_core``):

* ``SimSession`` (a ``FakeSession``) plays every scripted ``say`` line for a modelled duration (its
  words at the voice's pace), with ``agent_state_changed`` speaking/listening around it and the
  delivered item at the end, and runs the driver's own ``generate_reply`` (the wrap-up's owed
  answer) through the reply pipeline.  Speech is serialized as the SDK's ``_scheduling_task`` does:
  one speech at a time in creation order, ``current_speech`` the one at the head, ``interrupt()``
  cutting the playing line and every queued one;
* ``SimContext`` / its room record every attribute write the page would see (``phase``,
  ``awaiting`` ...) on the virtual clock: the phase trace;
* ``SimWriter`` (the integration tests' ``AdminWriter``) keeps every transcript row with all the
  columns the session wrote (the 0136 timing facts included) and every administration row;
* ``SdkDriver.speak`` is one candidate turn: ``user_state_changed`` speaking, the STT finals
  (``user_input_transcribed``; a long answer is several finals, as Sarvam splits it), listening, the
  endpointing delay, then (unless an uninterruptible line is current: the SDK then drops the turn)
  the commit (``R1Agent.on_user_turn_completed``) and, unless it raised
  ``StopResponse``, the reply: ``speech_created``, ``agent_state_changed`` thinking, the
  ``llm_node`` stream, speaking for the reply's modelled duration, ``conversation_item_added``,
  listening.  ``SdkDriver.press_ready`` is the page's "I'm ready" button exactly as the API relays
  it: a server-sent ``data_received`` packet on ``READY_TOPIC`` (``tests.test_r1_core``
  ``TestReadyButton``).

Voice barge-in is emulated for the adapt interrupter only (every other simulated candidate waits for
the floor): its cut-in is said over a playing reply, and ``SdkDriver.speak(barge_in=True)`` cuts that
reply once the voice has lasted R1's interruption ``min_duration`` (``barge_in_sec``).  The SDK
pauses the line at that moment and the final transcript cuts it; a simulated turn always has a
final, so the line is cut at the pause and keeps the words played until then.  Not emulated: the
false-interruption resume, the STT node's acknowledgement hold, VAD fragments, TTS audio and the
recording.  ``Span`` is the harness's own record of who spoke
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
from r1_latency import INTERRUPT_MIN_DURATION_SEC, interrupt_min_duration_sec, interrupt_min_words
from r1_replies import delta_text
from r1_text import word_count

INTERVIEWER = "interviewer"
LEARNER = "learner"
CANDIDATE = "candidate"
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
FINAL_MAX_WORDS = 28
MIN_FINAL_SEC = 0.5
SETTLE_TICKS = 40
INTERRUPT_SETTLE_SEC = 5.0  # how long session.interrupt() waits for the cut speeches to finish
# Voice barge-in (``r1_latency``): R1's interruption ``min_duration`` of the candidate's voice
# pauses an interruptible line, and the final transcript that follows cuts it.
BARGE_IN_SEC = INTERRUPT_MIN_DURATION_SEC
_IDS = itertools.count(1)


def barge_in_sec() -> float | None:
    """Seconds of the candidate's voice after which an interruptible line stops, as R1 configures
    the session (read at use, like ``r1_turn_handling``); None at the ``min_words`` rollback, where
    the voice never cuts a line by itself and only the committed turn does."""
    if interrupt_min_words() > 0:
        return None
    return interrupt_min_duration_sec()


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
        # The generated reply that is playing (a ``say`` line is ``now_playing``): what an
        # interrupting candidate can cut in over.
        self.reply_playing: Span | None = None
        self.reply_playing_seconds = 0.0

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


def speech_handle(text: str, *, allow_interruptions: bool = True) -> Any:
    """A ``FakeSpeechHandle`` whose ``interrupt`` really cuts its playback (``cut``)."""
    fakes = _fakes()

    class SimSpeechHandle(fakes.core.FakeSpeechHandle):
        def __init__(self) -> None:
            super().__init__(text, allow_interruptions=allow_interruptions)
            self.cut = asyncio.Event()
            self.turn = asyncio.Event()

        def interrupt(self, *, force: bool = False) -> Any:
            super().interrupt(force=force)
            self.cut.set()
            return self

        def done(self) -> bool:
            return self._done.is_set()

    return SimSpeechHandle()


def played_part(text: str, played: float, total: float) -> str:
    """The words of a line that were played before it was cut (at least the first one)."""
    words = text.split()
    if total <= 0 or played >= total or not words:
        return text
    keep = max(1, min(len(words), int(len(words) * played / total)))
    return " ".join(words[:keep])


def build_session(runtime: Runtime) -> Any:
    """A ``FakeSession`` that plays speech the way livekit-agents 1.6.4 schedules it.

    One speech plays at a time, in creation order (``_scheduling_task``): a ``say`` made while a
    reply is playing waits behind it, and ``current_speech`` is the speech at the head of that
    queue (a reply is current while it is generated, as in the SDK).  ``interrupt()`` on a handle
    cuts its playback (the transcript keeps the words played), and ``session.interrupt()`` cuts
    the current speech and every queued one (``force`` also cuts an uninterruptible one).
    """
    fakes = _fakes()

    class SimSession(fakes.core.FakeSession):
        def __init__(self) -> None:
            super().__init__(log=runtime.order)
            self.driver: "SdkDriver | None" = None
            self.queue: list[Any] = []

        # --------------------------------------------------------- the speech queue
        def schedule(self, handle: Any) -> None:
            """Queue a speech behind the ones already queued (the SDK's ``_schedule_speech``)."""
            self.queue.append(handle)
            self._advance()

        def _advance(self) -> None:
            while (self.current_speech is None or self.current_speech.done()) and self.queue:
                handle = self.queue.pop(0)
                if handle.done():
                    continue  # cut while it waited: skipped, as the SDK skips a done speech
                self.current_speech = handle
                handle.turn.set()
            if self.current_speech is not None and self.current_speech.done() and not self.queue:
                self.current_speech = None

        def release(self, handle: Any) -> None:
            """A speech is over (played, cut or skipped): the next one may play."""
            if handle in self.queue:
                self.queue.remove(handle)
            if self.current_speech is handle:
                self.current_speech = None
            self._advance()

        async def wait_turn(self, handle: Any) -> bool:
            """Until ``handle`` is the current speech (True), or it was cut while queued (False)."""
            if not handle.turn.is_set() and not handle.cut.is_set():
                turn = asyncio.ensure_future(handle.turn.wait())
                cut = asyncio.ensure_future(handle.cut.wait())
                await asyncio.wait({turn, cut}, return_when=asyncio.FIRST_COMPLETED)
                for waiter in (turn, cut):
                    waiter.cancel()
            return handle.turn.is_set() and not handle.interrupted

        async def play_for(self, handle: Any, seconds: float) -> float:
            """Play for ``seconds`` unless the handle is cut first; returns the seconds played."""
            if handle.cut.is_set():
                return 0.0
            started = asyncio.get_running_loop().time()
            try:
                await asyncio.wait_for(handle.cut.wait(), seconds)
            except asyncio.TimeoutError:
                return seconds
            return asyncio.get_running_loop().time() - started

        # ---------------------------------------------------------------- speech
        def say(self, text: str, **kwargs: Any) -> Any:
            if self.raise_on_say:
                raise RuntimeError("tts unavailable")
            self.spoken.append(text)
            handle = speech_handle(text, allow_interruptions=kwargs.get("allow_interruptions", True))
            self.handles.append(handle)
            self.emit(
                "speech_created",
                SimpleNamespace(speech_handle=handle, source="say", user_initiated=True),
            )
            runtime.saying += 1  # claimed now: a queued line holds the floor too
            self.schedule(handle)
            self._tasks.append(asyncio.ensure_future(self._play(handle, text)))
            return handle

        async def _play(self, handle: Any, text: str) -> None:  # mirrors FakeSession._play
            try:
                if not await self.wait_turn(handle):
                    handle.finish()  # cut before it could play: nothing is said, nothing kept
                    return
                self.log.append(("play_start", text))
                voice = runtime.voice_of(handle)
                span = runtime.open_span("bot", voice, text, "say")
                seconds = runtime.timing.say_start + runtime.timing.speak_seconds(text, voice)
                runtime.now_playing, runtime.now_playing_seconds = span, seconds
                self.emit("agent_state_changed", _state("listening", "speaking"))
                played = await self.play_for(handle, seconds)
                interrupted, self.next_interrupted = self.next_interrupted or handle.interrupted, False
                said = played_part(text, played, seconds) if handle.cut.is_set() else text
                span.text = said
                message = fakes.core.FakeChatMessage(said, interrupted=interrupted)
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
                self.release(handle)

        def generate_reply(self, **kwargs: Any) -> Any:
            """The driver asked for a reply itself (the wrap-up's owed answer): it is generated
            and spoken, as the SDK does, from the reply the hook prepared."""
            handle = speech_handle("reply")
            self.generated.append(handle)
            self.emit(
                "speech_created",
                SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
            )
            if self.driver is not None:
                runtime.replying += 1  # claimed now: the floor is taken from this moment
                self.schedule(handle)
                self._tasks.append(asyncio.ensure_future(self.driver.driven_reply(handle)))
            return handle

        async def interrupt(self, *, force: bool = False) -> None:
            """Cut the current speech and every queued one (``AgentActivity.interrupt``)."""
            cut = []
            for handle in [self.current_speech, *self.queue]:
                if handle is None or handle.done():
                    continue
                if force or handle.allow_interruptions:
                    handle.interrupt(force=force)
                    cut.append(handle)
            await super().interrupt(force=force)
            if cut:
                await asyncio.wait(
                    [asyncio.ensure_future(handle.wait_for_playout()) for handle in cut],
                    timeout=INTERRUPT_SETTLE_SEC,
                )

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

    def barge_in(self) -> bool:
        """The candidate's voice cuts the current speech, if it is an interruptible one (voice
        barge-in: a scripted ``say`` line is uninterruptible and plays on).  Returns whether it cut."""
        current = getattr(self.session, "current_speech", None)
        if current is None or current.done() or not getattr(current, "allow_interruptions", False):
            return False
        current.interrupt()
        return True

    async def speak(
        self,
        text: str,
        *,
        wps: float,
        act: str | None,
        role: str | None,
        intent: str | None = None,
        barge_in: bool = False,
    ) -> dict[str, Any]:
        """One candidate turn through the SDK seams; returns what happened to it.

        ``barge_in``: the turn is said over a playing line (the adapt interrupter), which is cut
        once the voice has lasted ``barge_in_sec()`` (an interruptible line only), not when the
        turn ends."""
        from r1_session import StopResponse

        rt = self.rt
        session = self.session
        finals = split_finals(text)
        if not finals:
            return {"suppressed": True, "why": "empty", "spoken": None}
        cut_after = barge_in_sec() if barge_in else None
        rt.candidate_speaking = True
        span = rt.open_span(
            "candidate", CANDIDATE, " ".join(finals), "candidate", act=act, role=role, intent=intent
        )
        try:
            session.emit("user_state_changed", _state("listening", "speaking"))
            voiced = 0.0
            for final in finals:
                seconds = max(MIN_FINAL_SEC, word_count(final) / wps)
                if cut_after is not None and voiced + seconds > cut_after:
                    await asyncio.sleep(max(0.0, cut_after - voiced))
                    self.barge_in()
                    seconds -= max(0.0, cut_after - voiced)
                    voiced, cut_after = cut_after, None
                await asyncio.sleep(seconds)
                voiced += seconds
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
        current = getattr(session, "current_speech", None)
        if current is not None and not current.done():
            # livekit-agents 1.6.4 ``_user_turn_completed_task``: a turn that ends while an
            # uninterruptible speech is current gets no reply at all (the hook is never called);
            # an interruptible one is cut first, and the hook runs once it is over.
            if not current.allow_interruptions:
                await settle()
                return {"suppressed": True, "why": "uninterruptible_speech", "spoken": None, "span": span}
            current.interrupt()
            await current.wait_for_playout()
        recorder = self.recorder()
        previous = getattr(interview, "_last_reply", None)
        recorder.take()
        message_id = f"msg_{next(_IDS)}"
        # The R at which the session hands the turn to the engine: the learner's line is decided
        # (and its window rules judged) at this moment, not when the advisor began speaking.
        decided_r_sec = rt.clocks()[2]
        rt.replying += 1
        try:
            try:
                await session.agent.on_user_turn_completed(
                    None, SimpleNamespace(text_content=span.text, id=message_id)
                )
            except StopResponse:
                await settle()
                return {"suppressed": True, "why": "stop_response", "spoken": None, "span": span}
            handle = speech_handle("reply")
            session.emit(
                "speech_created",
                SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=True),
            )
            session.schedule(handle)
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
            "decided_r_sec": decided_r_sec,
        }

    async def driven_reply(self, handle: Any) -> None:
        """A reply the driver asked for (``generate_reply``); the floor was claimed for it."""
        try:
            await self._play_reply(handle, None, self.recorders["interviewer"])
        finally:
            self.rt.replying -= 1

    async def _play_reply(self, handle: Any, message_id: str | None, recorder: Any) -> str | None:
        """Generate the reply at once (the SDK runs the LLM node before the speech's turn), then
        play it when it reaches the head of the speech queue, unless it was cut meanwhile."""
        rt = self.rt
        session = self.session
        try:
            session.emit("agent_state_changed", _state("listening", "thinking"))
            items = [SimpleNamespace(role="user", id=message_id)] if message_id else []
            stream = self.interview.llm_node_stream(SimpleNamespace(items=items), recorder)
            parts: list[str] = []
            async for chunk in stream:
                parts.append(chunk if isinstance(chunk, str) else delta_text(chunk))
            spoken = "".join(parts).strip()
            if not spoken or not await session.wait_turn(handle):
                session.emit("agent_state_changed", _state("thinking", "listening"))
                handle.finish()
                await settle()
                return None
            voice = rt.voice_of(handle)
            await session.play_for(handle, rt.timing.reply_start)
            if handle.cut.is_set():
                session.emit("agent_state_changed", _state("thinking", "listening"))
                handle.finish()
                await settle()
                return None
            session.emit("agent_state_changed", _state("thinking", "speaking"))
            span = rt.open_span("bot", voice, spoken, "reply")
            seconds = rt.timing.speak_seconds(spoken, voice)
            rt.reply_playing, rt.reply_playing_seconds = span, seconds
            try:
                played = await session.play_for(handle, seconds)
            finally:
                rt.reply_playing = None
            interrupted = handle.cut.is_set()
            said = played_part(spoken, played, seconds) if interrupted else spoken
            span.text = said
            message = _fakes().core.FakeChatMessage(said, interrupted=interrupted)
            handle.chat_items.append(message)
            rt.close_span(span, interrupted=interrupted)
            session.emit("conversation_item_added", SimpleNamespace(item=message))
            session.current_speech = None
            session.emit("agent_state_changed", _state("speaking", "listening"))
            handle.finish()
            session.release(handle)
            await settle()
            return said
        finally:
            if not handle.done():
                handle.finish()
            session.release(handle)


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
