"""Unit tests for R1's isolated event driver and persistence contracts.

These use named fakes rather than an SDK shim: the real LiveKit 1.6.4 shapes
are asserted separately in ``test_r1_sdk_contract``.  ``FakeSession`` behaves
like the SDK where it matters to the driver: ``say`` creates a speech, plays it
(``agent_state_changed``), adds an assistant item (``conversation_item_added``)
and finishes the handle; ``FakeContext`` exposes ``delete_room``/``shutdown`` and
deliberately NOT ``close_room``, which 1.6.4 does not have.
"""
from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import os
import re
import sys
import time
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import persistence
import r1_context
import r1_llm
import r1_persistence
import r1_phases
import r1_routing
import r1_session
from r1_guard import FALLBACK_REPLIES, FALLBACK_REPLY, StreamGuard
from r1_prompts import ROLEPLAY_PHASE, select_context
from r1_replies import Reply
import r1_script
from r1_script import LEARNER_FILLER_VARIANTS
from r1_lines import line, safe_first_name
from r1_persistence import OUTCOME_DISPOSITIONS, R1TurnWriter
from r1_phases import (
    MAX_AGENT_RESIDENCY_SEC,
    NORMAL_PATH_MAX_SEC,
    TRANSCRIPT_PHASES,
    R1Phase,
    R1PhaseMachine,
)
from r1_session import (
    DEADLINE,
    SILENCE,
    STOP,
    TURN,
    R1Agent,
    R1Interview,
    bounded_seconds,
    is_no_questions,
    rejoin_grace_seconds,
    residency_seconds,
    run_r1_session,
)


try:  # Use the SDK's real enum values when livekit is installed (.r1-venv).
    from livekit import rtc as _rtc
except ImportError:  # Bare CI stubs livekit; the session falls back to names.
    _rtc = None

STANDARD = _rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD if _rtc else "standard"
EGRESS = _rtc.ParticipantKind.PARTICIPANT_KIND_EGRESS if _rtc else "egress"
SIP = _rtc.ParticipantKind.PARTICIPANT_KIND_SIP if _rtc else "sip"
AUDIO = _rtc.TrackKind.KIND_AUDIO if _rtc else "audio"
VIDEO = _rtc.TrackKind.KIND_VIDEO if _rtc else "video"
MICROPHONE = _rtc.TrackSource.SOURCE_MICROPHONE if _rtc else "microphone"
CAMERA = _rtc.TrackSource.SOURCE_CAMERA if _rtc else "camera"

SESSION_ID = "00000000-0000-4000-8000-000000000001"
ROOM_NAME = f"screening-{SESSION_ID}"
_IDS = itertools.count(1)


class Clock:
    """Manual phase clock; it makes elapsed/paused-clock assertions deterministic."""

    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class Emitter:
    """Synchronous callback emitter matching the event registration surface used by R1."""

    def __init__(self) -> None:
        self.handlers: dict[str, list] = {}

    def on(self, name: str, callback) -> None:
        self.handlers.setdefault(name, []).append(callback)

    def emit(self, name: str, *args) -> None:
        for callback in self.handlers.get(name, []):
            callback(*args)


class FakeSpeechHandle:
    """SDK-shaped SpeechHandle: id, chat_items, interrupted, done callbacks, playout."""

    def __init__(self, text: str, *, allow_interruptions: bool = True) -> None:
        self.id = f"speech_{next(_IDS)}"
        self.text = text
        self.allow_interruptions = allow_interruptions
        self.chat_items: list = []
        self.interrupted = False
        self.interrupt_calls = 0
        self._done = asyncio.Event()
        self._callbacks: list = []

    def add_done_callback(self, callback) -> None:
        if self._done.is_set():
            callback(self)
        else:
            self._callbacks.append(callback)

    async def wait_for_playout(self) -> None:
        await self._done.wait()

    def interrupt(self, *, force: bool = False) -> "FakeSpeechHandle":
        self.interrupt_calls += 1
        self.interrupted = True
        return self

    def finish(self) -> None:
        self._done.set()
        for callback in list(self._callbacks):
            callback(self)


class FakeChatMessage:
    """Assistant ChatMessage shape: role, text_content, id, interrupted."""

    def __init__(self, text: str, *, interrupted: bool = False) -> None:
        self.id = f"item_{next(_IDS)}"
        self.role = "assistant"
        self.text_content = text
        self.interrupted = interrupted


class FakeSession(Emitter):
    """Session fake that behaves like the SDK for speech, and records starts/interrupts."""

    def __init__(
        self,
        *,
        raise_on_say: bool = False,
        playout_seconds: float = 0.0,
        emit_events: bool = True,
        log: list | None = None,
    ) -> None:
        super().__init__()
        self.spoken: list[str] = []
        self.started: dict | None = None
        self.agent = None
        self.interrupts = 0
        self.closed = 0
        self.raise_on_say = raise_on_say
        self.playout_seconds = playout_seconds
        self.emit_events = emit_events
        self.log = log if log is not None else []
        self.handles: list[FakeSpeechHandle] = []
        self.generated: list[FakeSpeechHandle] = []
        self.interrupt_hook = None
        self.interrupt_delay = 0.0
        self.next_interrupted = False
        self.current_speech: FakeSpeechHandle | None = None
        self._tasks: list[asyncio.Task] = []

    def say(self, text: str, **kwargs) -> FakeSpeechHandle:
        if self.raise_on_say:
            raise RuntimeError("tts unavailable")
        self.spoken.append(text)
        handle = FakeSpeechHandle(
            text, allow_interruptions=kwargs.get("allow_interruptions", True)
        )
        self.handles.append(handle)
        if not self.emit_events:
            handle.finish()
            return handle
        self.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="say", user_initiated=True),
        )
        self._tasks.append(asyncio.ensure_future(self._play(handle, text)))
        return handle

    def generate_reply(self, **kwargs) -> FakeSpeechHandle:
        """A reply the driver asked for (the wrap-up's owed answer): created, not played."""
        handle = FakeSpeechHandle("reply")
        self.generated.append(handle)
        self.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
        )
        return handle

    async def _play(self, handle: FakeSpeechHandle, text: str) -> None:
        """Mirror AgentActivity: speaking, then the assistant item, then listening."""
        self.log.append(("play_start", text))
        self.current_speech = handle
        self.emit(
            "agent_state_changed", SimpleNamespace(old_state="listening", new_state="speaking")
        )
        await asyncio.sleep(self.playout_seconds)
        interrupted, self.next_interrupted = self.next_interrupted or handle.interrupted, False
        message = FakeChatMessage(text, interrupted=interrupted)
        handle.chat_items.append(message)
        self.emit("conversation_item_added", SimpleNamespace(item=message))
        self.current_speech = None
        self.emit(
            "agent_state_changed", SimpleNamespace(old_state="speaking", new_state="listening")
        )
        self.log.append(("play_end", text))
        handle.finish()

    async def start(self, agent, **kwargs) -> None:
        self.log.append(("start", None))
        self.agent = agent
        self.started = kwargs

    async def interrupt(self, *, force: bool = False) -> None:
        self.interrupts += int(force)
        if self.interrupt_hook is not None:
            self.interrupt_hook()
        if self.interrupt_delay:
            await asyncio.sleep(self.interrupt_delay)

    async def aclose(self) -> None:
        self.closed += 1


@dataclass
class FakePublication:
    """Minimal publication carrying the properties in the mute filter."""

    kind: object = AUDIO
    source: object = MICROPHONE
    muted: bool = False


@dataclass
class FakeParticipant:
    """Minimal remote participant with the LiveKit identity/kind fields used by R1."""

    identity: str
    kind: object = STANDARD
    track_publications: dict = field(default_factory=dict)


class FakeRoom(Emitter):
    """Room fake with a candidate map matching ``Room.remote_participants``."""

    def __init__(self, log: list | None = None) -> None:
        super().__init__()
        self.name = ROOM_NAME
        self.connected = True
        self.remote_participants: dict[str, FakeParticipant] = {}
        self.local_participant = type("LocalParticipant", (), {"attributes": []})()
        shared = log if log is not None else []

        async def set_attributes(attributes):
            self.local_participant.attributes.append(attributes)
            shared.append(("attributes", dict(attributes)))

        self.local_participant.set_attributes = set_attributes

    def isconnected(self) -> bool:
        return self.connected


class FakeContext:
    """JobContext fake: ``delete_room`` and ``shutdown`` exist, ``close_room`` does NOT."""

    def __init__(self, log: list | None = None) -> None:
        self.log = log if log is not None else []
        self.room = FakeRoom(self.log)
        self.deleted_rooms: list = []
        self.shutdowns: list[str] = []
        self.shutdown_callbacks: list = []
        self.connects = 0
        self.connect_kwargs: dict = {}
        self.connect_error: BaseException | None = None
        self.connect_hangs = False
        self.delete_error: BaseException | None = None
        self.delete_hangs = False

    async def connect(self, **kwargs) -> None:
        self.connects += 1
        self.connect_kwargs = kwargs
        if self.connect_hangs:
            await asyncio.Event().wait()
        if self.connect_error is not None:
            raise self.connect_error

    async def delete_room(self, room_name=None) -> None:
        self.deleted_rooms.append(room_name)
        self.log.append(("delete_room", room_name))
        if self.delete_hangs:
            await asyncio.Event().wait()
        if self.delete_error is not None:
            raise self.delete_error

    def shutdown(self, reason: str = "") -> None:
        self.shutdowns.append(reason)
        self.log.append(("shutdown", reason))

    def add_shutdown_callback(self, callback) -> None:
        self.shutdown_callbacks.append(callback)


class FakeWriter:
    """Writer fake: records the exit order and every argument the terminal write received."""

    def __init__(self, order: list, *, activate_ok: bool = True) -> None:
        self.order = order
        self.activate_ok = activate_ok
        self.activate_kind: str | None = None  # overrides activate_ok: "error", "conflict", ...
        self.activate_hangs = False
        self.saved: list[dict] = []
        self.terminals: list[tuple] = []
        self.outcomes: list[str] = []
        self.activations = 0
        self.save_error: BaseException | None = None
        self.save_hangs = False
        self.save_gate: asyncio.Event | None = None
        self.terminal_hangs = False
        # The turn anchor (``started_at_ms``) each saved row was given, by index, and the exact
        # keyword names every call carried: a row without an anchor must not name one at all.
        self.anchors: dict[int, int | None] = {}
        self.save_kwarg_names: list[frozenset[str]] = []

    async def activate(self):
        self.activations += 1
        self.order.append("activate")
        if self.activate_hangs:
            await asyncio.Event().wait()
        kind = self.activate_kind or ("success" if self.activate_ok else "conflict")
        return SimpleNamespace(ok=kind == "success", kind=kind)

    async def save_turn(self, index, speaker, text, phase, **kwargs) -> None:
        if self.save_hangs:
            await asyncio.Event().wait()
        if self.save_gate is not None:
            await self.save_gate.wait()
        if self.save_error is not None:
            raise self.save_error
        self.anchors[index] = kwargs.get("started_at_ms")
        self.save_kwarg_names.append(frozenset(kwargs))
        self.order.append(("save", index))
        self.saved.append(
            {
                "index": index,
                "speaker": speaker,
                "text": text,
                "phase": phase,
                "interrupted": kwargs.get("interrupted", False),
            }
        )

    async def usage_disconnect(self, *_args) -> None:
        self.order.append("ledger")

    async def terminal(self, outcome, duration, **kwargs) -> None:
        if self.terminal_hangs:
            await asyncio.Event().wait()
        self.order.append("terminal")
        self.terminals.append((outcome, kwargs))

    async def attempt_outcome(self, outcome) -> None:
        self.order.append("outcome")
        self.outcomes.append(outcome)


_SILENT_WRITERS: list = []


def setUpModule() -> None:
    """Swallow StructuredLogger output (it prints by default); tests capture what they need."""
    for logger in (r1_session._log, r1_persistence._log):
        _SILENT_WRITERS.append((logger, logger._writer))
        logger._writer = lambda _raw: None


def tearDownModule() -> None:
    for logger, writer in _SILENT_WRITERS:
        logger._writer = writer
    _SILENT_WRITERS.clear()


@contextlib.contextmanager
def capture_r1_logs():
    """Capture every StructuredLogger line the R1 modules emit, as parsed dicts."""
    lines: list[dict] = []
    loggers = [r1_session._log, r1_persistence._log]
    previous = [logger._writer for logger in loggers]
    for logger in loggers:
        logger._writer = lambda raw: lines.append(json.loads(raw))
    try:
        yield lines
    finally:
        for logger, writer in zip(loggers, previous):
            logger._writer = writer


def error_types(lines: list[dict]) -> list[str]:
    """The ``error_type`` of every captured line, in order."""
    return [line_.get("error_type", "") for line_ in lines]


async def append(items: list, value: str) -> None:
    """Append from an injected async recorder finisher."""
    items.append(value)


def final_event(text: str) -> SimpleNamespace:
    return SimpleNamespace(is_final=True, transcript=text)


def state_event(state: str) -> SimpleNamespace:
    return SimpleNamespace(old_state="x", new_state=state)


class R1TestCase(unittest.IsolatedAsyncioTestCase):
    """Build an interview whose candidate has already passed the standard-kind filter."""

    async def asyncSetUp(self) -> None:
        self.clock = Clock()
        self.order: list = []
        self.ctx = FakeContext(self.order)
        self.session = FakeSession(log=self.order)
        self.writer = FakeWriter(self.order)
        self.interview = R1Interview(
            self.ctx,
            dict(self.LINE_CONTEXT),
            self.session,
            self.writer,
            clock=self.clock,
            recorder_finish=lambda: append(self.order, "recording"),
        )
        self.interview.wire_events()
        self.ctx.room.emit("participant_connected", FakeParticipant("candidate"))
        self.interview.machine.transition(R1Phase.OPENING)
        self.interview.machine.transition(R1Phase.ICEBREAKER)

    def enter_roleplay(self) -> None:
        self.interview.machine.transition(R1Phase.TRANSITION)
        self.interview.machine.transition(R1Phase.ROLEPLAY)

    def final_transcript(self, text: str) -> None:
        self.session.emit("user_input_transcribed", final_event(text))

    def agent_state(self, state: str) -> None:
        self.session.emit("agent_state_changed", state_event(state))

    def user_state(self, state: str) -> None:
        self.session.emit("user_state_changed", state_event(state))

    async def commit_turn(self, text: str, *, agent: R1Agent | None = None) -> bool:
        """The SDK commits the candidate's turn: the hook runs (``prepare_turn``).

        Returns True when the hook suppressed the reply (``StopResponse``).  R1 writes the
        candidate's row, counts an icebreaker answer and decides the icebreaker's exit HERE, at
        the committed turn, never at the raw final transcript.
        """
        hook = agent or self.session.agent or R1Agent(self.interview)
        try:
            await hook.on_user_turn_completed(
                None, SimpleNamespace(text_content=text, id=f"msg_{next(_IDS)}")
            )
        except r1_session.StopResponse:
            await self.settle()
            return True
        return False

    async def answer(self, text: str, *, agent: R1Agent | None = None) -> bool:
        """A candidate answer the way the SDK delivers it: the final transcript, then the commit."""
        self.final_transcript(text)
        await self.settle()
        return await self.commit_turn(text, agent=agent)

    # The context a case's interview is built from: the persona (and so the lead's name and
    # city in the pickup and the transition line) is chosen from it.
    LINE_CONTEXT = {"first_name": "Asha", "candidate_identity": "candidate"}

    def spoken_line(self, line_id: str) -> str:
        """The line as the interview renders it (the persona fills the lead's name and city).

        "L-TRANSITION" is the first brief as this session speaks it: with ``R1_REACTION_VARIETY``
        (D3-ICE1) that is the session's seeded thanked brief (``_thanked_brief_id``).
        """
        interview = R1Interview(self.ctx, dict(self.LINE_CONTEXT), self.session, self.writer)
        if line_id == "L-TRANSITION":
            # D3-ICE1-THANKS-CONTEXT: the seeded B needs the case's own real last answer.
            live = getattr(self, "interview", None)
            interview._ib_last_answer_substantive = bool(
                getattr(live, "_ib_last_answer_substantive", False)
            )
            line_id = interview._thanked_brief_id()
        return interview.render_line(line_id)

    async def flush(self) -> None:
        """Let queued transcript writes finish."""
        await self.interview._drain_background()

    async def until(self, predicate, timeout: float = 10.0) -> None:
        """Poll a condition; the timeout only matters when the test is about to fail."""
        deadline = asyncio.get_running_loop().time() + timeout
        while not predicate():
            if asyncio.get_running_loop().time() > deadline:
                self.fail("condition not reached in time")
            await asyncio.sleep(0.001)

    async def settle(self, turns: int = 40) -> None:
        """Let every ready callback and task run: loop iterations, never wall-clock time."""
        for _ in range(turns):
            await asyncio.sleep(0)

    async def candidate_replies_after(self, line_id: str, text: str) -> None:
        """Say ``text`` the way a candidate can: once the driver has finished the line.

        The phase driver forgets transcripts queued for the previous phase when the next
        one starts, which is right: audio is discarded while an uninterruptible line plays,
        so nothing real can be finalized in the same loop tick the line ends.  The test
        therefore waits for the line to finish AND for the driver to resume and listen.
        """
        await self.until(lambda: self.spoken_and_played(line_id))
        await self.settle()
        self.final_transcript(text)

    def spoken_and_played(self, line_id: str) -> bool:
        """True once the fake session has finished playing the line (not just been asked)."""
        return ("play_end", self.spoken_line(line_id)) in self.order

    def capture_logs(self):
        """Capture every StructuredLogger line the R1 modules emit, as parsed dicts."""
        return capture_r1_logs()

    def bot_rows(self) -> list[dict]:
        return [row for row in self.writer.saved if row["speaker"] == "bot"]

    async def start_interview(self) -> SimpleNamespace:
        """Run the real driver on a fresh interview whose candidate is already in the room.

        Waits for the icebreaker and returns ``interview``, ``context``, ``session``,
        ``clock`` and the running ``task``.  It shares ``self.order`` and ``self.writer``
        with the case, so the usual assertions on both still apply.
        """
        context = FakeContext(self.order)
        context.room.remote_participants["candidate"] = FakeParticipant("candidate")
        session = FakeSession(log=self.order)
        clock = Clock()
        interview = R1Interview(
            context,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            session,
            self.writer,
            clock=clock,
            recorder_finish=lambda: append(self.order, "recording"),
        )
        task = asyncio.create_task(interview.run())
        await self.pass_sound_check(session, interview)
        await self.until(lambda: interview.machine.phase is R1Phase.ICEBREAKER)
        return SimpleNamespace(
            interview=interview, context=context, session=session, clock=clock, task=task
        )

    async def pass_sound_check(
        self, session=None, interview=None, *, reply: str = "Yes, I can hear you."
    ) -> None:
        """M032 S7C (SWEEP-35): answer the hello's "Can you hear me okay?" as a candidate would.

        A no-op when the sound check is off or the no-hearing-check opening is enabled.
        """
        if (not r1_session.opening_sound_check_enabled()
                or r1_session.opening_no_hearing_check_enabled()):
            return
        session = session or self.session
        await self.until(lambda: session.agent is not None)
        interview = interview or session.agent.interview
        hello = interview.render_line("L-OPEN-HELLO")
        await self.until(lambda: ("play_end", hello) in session.log)
        await self.settle()
        session.emit("user_input_transcribed", final_event(reply))
        await self.settle()
        with contextlib.suppress(r1_session.StopResponse):
            await session.agent.on_user_turn_completed(
                None, SimpleNamespace(text_content=reply, id=f"msg_{next(_IDS)}")
            )
        await self.settle()

    @staticmethod
    def opening_line_ids() -> tuple[str, ...]:
        """What the driver says before the icebreaker (M032 S7C: the hello, then the agenda)."""
        if r1_session.opening_no_hearing_check_enabled():
            return ("L-OPEN-HI", "L-OPEN-AGENDA-PLAIN")
        if r1_session.opening_sound_check_enabled():
            return ("L-OPEN-HELLO", "L-OPEN-AGENDA")
        return ("L-OPEN",)

    async def advance_to_transition(self, run: SimpleNamespace) -> None:
        """Skip the icebreaker clock; the driver speaks L-TRANSITION and waits for READY."""
        run.clock.advance(271)
        run.interview._wake()
        await self.until(lambda: run.interview.machine.phase is R1Phase.TRANSITION)
        await self.until(lambda: self.spoken_and_played("L-TRANSITION"))
        await self.settle()

    async def advance_to_roleplay(self, run: SimpleNamespace) -> None:
        await self.advance_to_transition(run)
        run.session.emit("user_input_transcribed", final_event("ready"))
        await self.until(lambda: run.interview.machine.phase is R1Phase.ROLEPLAY)

    async def drain_cancel(self, run: SimpleNamespace) -> None:
        """Do to the entrypoint what a draining worker's job process does: cancel it.

        livekit-agents 1.6.4 gives a drain no other route into a running job (the shutdown
        callbacks only run after the entrypoint has ended; the SDK contract suite pins the
        order), so this IS the drain.
        """
        run.task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(run.task, 10.0)


class TestPhaseAndConfiguration(unittest.TestCase):
    """Pure state and configuration tests that do not need an event loop."""

    def test_phase_machine_pauses_roleplay_clock_for_aside(self) -> None:
        clock = Clock()
        machine = R1PhaseMachine(clock)
        with self.assertRaisesRegex(RuntimeError, "invalid_transition"):
            machine.transition(R1Phase.ROLEPLAY)
        machine.transition(R1Phase.OPENING)
        machine.transition(R1Phase.ICEBREAKER)
        machine.transition(R1Phase.TRANSITION)
        machine.transition(R1Phase.ROLEPLAY)
        clock.advance(60)
        machine.transition(R1Phase.ASIDE)
        clock.advance(30)
        machine.transition(R1Phase.ROLEPLAY)
        clock.advance(20)
        self.assertEqual(machine.roleplay_elapsed, 80)
        # M1 (2026-11-03): role-play cap S <= 29:30, forced close S = 32:00; the residency cap
        # (2160 s) still covers the no-show wait, the forced close, the close line and a rejoin.
        # M2: the cap is S <= 29:15 and its gentle closing (hold + L-TIME-UP) ends by S = 29:30.
        self.assertEqual(r1_phases.ROLEPLAY_CAP_CEILING_SEC, 29 * 60 + 15)
        self.assertEqual(
            r1_phases.ROLEPLAY_CAP_CEILING_SEC + r1_phases.ROLEPLAY_CLOSE_ALLOWANCE_SEC,
            29 * 60 + 30,
        )
        self.assertLessEqual(
            r1_session.ROLEPLAY_END_HOLD_CEILING_SECONDS + 5.0,  # L-TIME-UP is about 4 s
            r1_phases.ROLEPLAY_CLOSE_ALLOWANCE_SEC,
        )
        self.assertEqual(NORMAL_PATH_MAX_SEC, 31 * 60 + 57)
        self.assertEqual(MAX_AGENT_RESIDENCY_SEC, 35 * 60 + 45)
        self.assertLessEqual(MAX_AGENT_RESIDENCY_SEC, r1_session.residency_seconds())
        self.assertLess(NORMAL_PATH_MAX_SEC, r1_phases.FORCED_CLOSE_SEC)

    def test_manual_clock_exposes_hard_phase_budgets(self) -> None:
        clock = Clock()
        machine = R1PhaseMachine(clock)
        machine.transition(R1Phase.OPENING)
        machine.transition(R1Phase.ICEBREAKER)
        clock.advance(270)
        self.assertEqual(machine.remaining_icebreaker_seconds(), 0)
        machine.transition(R1Phase.TRANSITION)
        machine.transition(R1Phase.ROLEPLAY)
        clock.advance(1200)
        self.assertEqual(machine.remaining_roleplay_seconds(), 0)
        machine.transition(R1Phase.ROLEPLAY_EXIT)
        machine.transition(R1Phase.WRAPUP)
        clock.advance(120)
        self.assertEqual(machine.remaining_wrapup_seconds(), 0)

    def test_one_paused_span_covers_aside_and_a_disconnect(self) -> None:
        # ASIDE -> PAUSED_DISCONNECTED -> ASIDE must keep R stopped the whole time.
        clock = Clock()
        machine = R1PhaseMachine(clock)
        for phase in (R1Phase.OPENING, R1Phase.ICEBREAKER, R1Phase.TRANSITION, R1Phase.ROLEPLAY):
            machine.transition(phase)
        clock.advance(60)
        machine.transition(R1Phase.ASIDE)
        clock.advance(30)
        machine.begin_disconnect()
        clock.advance(30)
        self.assertIs(machine.rejoin(), R1Phase.ASIDE)
        clock.advance(30)
        self.assertEqual(machine.roleplay_elapsed, 60)
        machine.transition(R1Phase.ROLEPLAY)
        clock.advance(10)
        self.assertEqual(machine.roleplay_elapsed, 70)

    def test_an_aside_may_end_roleplay_directly(self) -> None:
        clock = Clock()
        machine = R1PhaseMachine(clock)
        for phase in (R1Phase.OPENING, R1Phase.ICEBREAKER, R1Phase.TRANSITION, R1Phase.ROLEPLAY):
            machine.transition(phase)
        machine.transition(R1Phase.ASIDE)
        machine.transition(R1Phase.ROLEPLAY_EXIT)
        self.assertIs(machine.phase, R1Phase.ROLEPLAY_EXIT)

    def test_role_play_time_stops_when_the_role_play_ends(self) -> None:
        # The administration record and the plan 6.4 gate (R >= 10:00) measure the role-play,
        # not the session: R read at the end of the wrap-up must not include the wrap-up.
        clock = Clock()
        machine = R1PhaseMachine(clock)
        for phase in (R1Phase.OPENING, R1Phase.ICEBREAKER, R1Phase.TRANSITION):
            machine.transition(phase)
        self.assertFalse(machine.roleplay_entered)
        machine.transition(R1Phase.ROLEPLAY)
        self.assertTrue(machine.roleplay_entered)
        clock.advance(500)
        self.assertEqual(machine.roleplay_elapsed, 500)
        self.assertFalse(machine.roleplay_finished)
        machine.transition(R1Phase.ROLEPLAY_EXIT)
        self.assertTrue(machine.roleplay_finished)
        clock.advance(120)  # the exit line and the wrap-up
        machine.transition(R1Phase.WRAPUP)
        clock.advance(100)
        self.assertEqual(machine.roleplay_elapsed, 500)
        machine.transition(R1Phase.CLOSING)
        clock.advance(30)
        self.assertEqual(machine.roleplay_elapsed, 500)

    def test_role_play_time_stops_for_every_way_out_of_the_role_play(self) -> None:
        # Ending from an aside or a reconnect pause closes the paused span at that moment.
        for pause in (R1Phase.ASIDE, R1Phase.PAUSED_DISCONNECTED):
            with self.subTest(pause=pause):
                clock = Clock()
                machine = R1PhaseMachine(clock)
                for phase in (
                    R1Phase.OPENING, R1Phase.ICEBREAKER, R1Phase.TRANSITION, R1Phase.ROLEPLAY
                ):
                    machine.transition(phase)
                clock.advance(300)
                if pause is R1Phase.ASIDE:
                    machine.transition(R1Phase.ASIDE)
                else:
                    machine.begin_disconnect()
                clock.advance(40)
                machine.transition(R1Phase.CLOSING)  # a stop while paused: R stays at 300
                clock.advance(60)
                self.assertEqual(machine.roleplay_elapsed, 300)
                self.assertFalse(machine.roleplay_finished)  # CLOSING is not a finished role-play

    def test_session_clock_runs_from_activation_not_from_pre_join(self) -> None:
        clock = Clock()
        machine = R1PhaseMachine(clock)
        clock.advance(100)  # PRE_JOIN wait for the candidate
        machine.transition(R1Phase.OPENING)
        clock.advance(50)
        self.assertEqual(machine.session_elapsed, 150)
        self.assertEqual(machine.session_clock, 50)
        self.assertEqual(machine.remaining_icebreaker_seconds(), 220)
        self.assertEqual(machine.remaining_forced_close_seconds(), 1920 - 50)

    def test_roleplay_budget_is_the_smaller_of_the_r_budget_and_the_s_cap(self) -> None:
        clock = Clock()
        machine = R1PhaseMachine(clock)
        machine.transition(R1Phase.OPENING)
        machine.transition(R1Phase.ICEBREAKER)
        clock.advance(600)
        machine.transition(R1Phase.TRANSITION)
        machine.transition(R1Phase.ROLEPLAY)  # a late pickup: the cap is the S = 29:15 ceiling
        clock.advance(950)  # R = 950 (250 left), S = 1550 (205 left)
        # M2: the ceiling is S = 29:15, so the gentle closing still ends by S = 29:30.
        self.assertEqual(machine.roleplay_cap_sec, 1755)
        self.assertEqual(machine.remaining_roleplay_seconds(), 205)
        self.assertEqual(machine.remaining_roleplay_cap_seconds(), 205)
        clock.advance(205)
        self.assertTrue(machine.roleplay_should_end())

    def test_question_time_before_the_pickup_does_not_shorten_the_role_play(self) -> None:
        # M1 (owner decision 2026-11-03): the role-play starts only on the candidate's consent,
        # after their questions, so its S cap counts from the pickup.  A pickup at S = 7:45
        # (a 4:30 icebreaker, the brief and three questions) still gets R = 20:00, and 1:30 of
        # asides on top; at the old fixed S = 26:00 it got 18:15.  (M2 moved the ceiling from
        # S = 29:30 to 29:15, so the closing after the cap still ends by 29:30.)
        clock = Clock()
        machine = R1PhaseMachine(clock)
        machine.transition(R1Phase.OPENING)
        machine.transition(R1Phase.ICEBREAKER)
        machine.transition(R1Phase.TRANSITION)
        clock.advance(465)
        machine.transition(R1Phase.ROLEPLAY)
        self.assertEqual(machine.remaining_roleplay_seconds(), 1200)
        self.assertEqual(machine.roleplay_cap_sec, 465 + 1200 + 90)
        machine.transition(R1Phase.ASIDE)
        clock.advance(90)  # asides pause R, never S
        machine.transition(R1Phase.ROLEPLAY)
        clock.advance(1199)
        self.assertFalse(machine.roleplay_should_end())
        self.assertEqual(machine.remaining_roleplay_seconds(), 1)
        clock.advance(1)
        self.assertTrue(machine.roleplay_should_end())

    def test_an_early_pickup_keeps_the_old_session_cap_as_its_floor(self) -> None:
        clock = Clock()
        machine = R1PhaseMachine(clock)
        for phase in (R1Phase.OPENING, R1Phase.ICEBREAKER, R1Phase.TRANSITION):
            machine.transition(phase)
        clock.advance(200)
        machine.transition(R1Phase.ROLEPLAY)
        self.assertEqual(machine.roleplay_cap_sec, 1560)  # never sooner than S = 26:00

    def test_wrapup_budget_survives_a_rejoin(self) -> None:
        clock = Clock()
        machine = R1PhaseMachine(clock)
        for phase in (
            R1Phase.OPENING,
            R1Phase.ICEBREAKER,
            R1Phase.TRANSITION,
            R1Phase.ROLEPLAY,
            R1Phase.ROLEPLAY_EXIT,
            R1Phase.WRAPUP,
        ):
            machine.transition(phase)
        clock.advance(60)
        machine.begin_disconnect()
        clock.advance(10)
        machine.rejoin()
        self.assertEqual(machine.remaining_wrapup_seconds(), 50)

    def test_transcript_phase_labels_match_the_0116_check(self) -> None:
        migration = (
            HERE.parent / "supabase" / "migrations" / "0116_r1_shared_session_fields.sql"
        )
        if not migration.exists():
            self.skipTest("migration not present in this checkout")
        check = re.search(r"phase in \(([^)]*)\)", migration.read_text(encoding="utf-8"))
        self.assertIsNotNone(check)
        sql_labels = set(re.findall(r"'([a-z_]+)'", check.group(1)))
        self.assertEqual(set(TRANSCRIPT_PHASES), sql_labels)
        machine = R1PhaseMachine(Clock())
        for phase in R1Phase:
            machine.phase = phase
            machine._resume_phase = R1Phase.ROLEPLAY
            self.assertIn(machine.transcript_phase(), sql_labels, phase)
        machine.phase = R1Phase.PAUSED_DISCONNECTED
        self.assertEqual(machine.transcript_phase(), "roleplay")

    def test_duration_readers_reject_invalid_environment_values(self) -> None:
        prior = dict(os.environ)
        try:
            for raw in ("oops", "-4", "inf", "nan", "999999"):
                os.environ["R1_REJOIN_GRACE_SEC"] = raw
                os.environ["R1_SESSION_MAX_RESIDENCY_SEC"] = raw
                self.assertLessEqual(rejoin_grace_seconds(), 90)
                self.assertLessEqual(residency_seconds(), 2160)
        finally:
            os.environ.clear()
            os.environ.update(prior)

    def test_lines_and_llm_configuration_fail_closed(self) -> None:
        self.assertEqual(safe_first_name("not/a/name"), "there")
        self.assertIn(r1_script.interviewer_name(), line("L-OPEN", first_name="Asha"))
        self.assertIn("I'm Dex,", line("L-OPEN", first_name="Asha"))
        with self.assertRaises(r1_llm.R1LLMConfigurationError):
            r1_llm.r1_llm_config(
                {"DEEPSEEK_API_KEY": "x", "R1_LLM_BASE_URL": "https://bad.example"}
            )
        self.assertEqual(
            r1_llm.r1_llm_config({"DEEPSEEK_API_KEY": "x"})["reasoning_effort"],
            "none",
        )
        for base_url in (
            "http://api.deepseek.com",
            "https://api.deepseek.com:443/v1",
            "https://user@api.deepseek.com/v1",
            "https://api.deepseek.com/v1?x=1",
        ):
            with self.assertRaises(r1_llm.R1LLMConfigurationError):
                r1_llm.r1_llm_config({"DEEPSEEK_API_KEY": "x", "R1_LLM_BASE_URL": base_url})
        with self.assertRaises(r1_llm.R1LLMConfigurationError):
            r1_llm.r1_llm_config({"DEEPSEEK_API_KEY": "x", "R1_LLM_MODEL": "deepseek-v4"})

    def test_r1_routing_requires_mode_and_server_marker(self) -> None:
        marked = '{"lane":"r1"}'
        self.assertTrue(r1_routing.room_is_r1(marked))
        self.assertFalse(r1_routing.room_is_r1('{"lane":"R1"}'))
        self.assertFalse(r1_routing.room_is_r1("not-json"))
        self.assertEqual(r1_routing.routing_decision("r1_only", True), "r1")
        self.assertEqual(r1_routing.routing_decision("r1_only", False), "refuse")
        self.assertEqual(r1_routing.routing_decision("off", True), "refuse")
        self.assertEqual(r1_routing.routing_decision("garbage", True), "refuse")
        self.assertEqual(r1_routing.routing_decision("off", False), "legacy")
        self.assertEqual(r1_routing.routing_decision("garbage", False), "legacy")
        # One predicate: a padded mode value means the same thing everywhere.
        self.assertTrue(r1_routing.r1_mode_allows(" r1_only "))
        self.assertEqual(r1_routing.routing_decision(" r1_only ", True), "r1")

    def test_terminal_mapping_uses_only_existing_terminal_reason_sets(self) -> None:
        # Source: app/api/src/lib/session-lifecycle.ts:60-93 and migration 0006 CHECK.
        completed = {"conversation_complete", "assessment_done"}
        failed = {
            "room_create_error",
            "worker_crash",
            "provider_error",
            "assessment_error",
            "shutdown_forced",
            "drain_timeout",
            "residency_timeout",
        }
        for disposition in OUTCOME_DISPOSITIONS.values():
            allowed = completed if disposition.completed else failed
            self.assertIn(disposition.terminal_reason, allowed)

    def test_terminal_dispositions_do_not_carry_a_source_status(self) -> None:
        # The CAS source status is a property of the SESSION (activation), not the outcome.
        for disposition in OUTCOME_DISPOSITIONS.values():
            self.assertFalse(hasattr(disposition, "expected_status"))

    def test_attempt_outcomes_are_the_r1_0115_text_outcome_vocabulary(self) -> None:
        # Source: 0115_r1_round_foundation.sql: interview_round_attempts.outcome text.
        expected = {
            "complete",
            "candidate_left",
            "no_show",
            "provider_error",
            "residency_timeout",
            "shutdown_forced",
            "configuration_failed",
            "context_failed",
        }
        self.assertEqual(set(OUTCOME_DISPOSITIONS), expected)

    def test_session_factory_keeps_browser_provider_defaults_and_only_r1s_turn_timings(self) -> None:
        source = (HERE / "r1_session.py").read_text(encoding="utf-8")
        factory_start = source.index("async def _default_session_factory")
        factory_end = source.index("class _SpeechSlot")
        factory = source[factory_start:factory_end]
        self.assertIn('os.getenv("SARVAM_LANGUAGE", "en-IN")', factory)
        # The providers are built in r1_sarvam (owner decision 2026-10-30): the STT model is
        # R1's trial switch, today's expression when unset, and the v3 rollback voice is the
        # browser lane's, defined once in r1_tts and shared with the line cache.
        self.assertIn("r1_stt_model()", factory)
        self.assertIn("_build_session_tts(build_r1_tts)", factory)
        providers = (HERE / "r1_sarvam.py").read_text(encoding="utf-8")
        self.assertIn('os.getenv("SARVAM_STT_MODEL", "saaras:v3")', providers)
        self.assertIn("sarvam.TTS(**r1_tts_kwargs())", providers)
        voice = (HERE / "r1_tts.py").read_text(encoding="utf-8")
        self.assertIn('os.getenv("SARVAM_TTS_MODEL", "bulbul:v3")', voice)
        self.assertIn('os.getenv("SARVAM_TTS_VOICE", "simran")', voice)
        self.assertIn('"pace": 1.0', voice)
        self.assertIn('"temperature": 0.8', voice)
        # PR-4c: R1's turn TIMINGS, never the detector (that stays the session's).  The VAD is
        # the SDK's default model, given explicitly only behind R1_VAD_ENDPOINT_ANCHOR (M033 T1).
        self.assertIn("turn_handling = r1_turn_handling()", factory)
        self.assertIn("turn_handling=turn_handling", factory)
        self.assertNotIn("turn_detection", factory)
        self.assertNotIn("vad=", factory)
        self.assertIn('{"vad": inference.VAD(model="silero")} if anchor else {}', factory)
        self.assertIn("anchor = vad_endpoint_anchor_enabled()", factory)

    def test_session_factory_pins_llm_retry_options_and_disables_user_away(self) -> None:
        source = (HERE / "r1_session.py").read_text(encoding="utf-8")
        factory = source[
            source.index("async def _default_session_factory") : source.index("class _SpeechSlot")
        ]
        compact = re.sub(r"\s+", "", factory)
        self.assertIn(
            "conn_options=SessionConnectOptions(llm_conn_options=APIConnectOptions("
            "max_retry=1,retry_interval=0.5,timeout=10.0,)),",
            compact,
        )
        self.assertIn("user_away_timeout=None", compact)

    def test_a_refusal_wrapped_in_nothing_but_courtesy_ends_wrapup(self) -> None:
        for text in (
            "No questions, thanks",
            "nope",
            "I'm good",
            "that's all",
            "that is all",
            "Nothing, that is all",
            "No thank you, that's all",
            "Um, no questions",
            "No thanks and nothing else",
            # The refusal may carry "no" itself, and any amount of courtesy.
            "No, I am good.",
            "I am good, thank you so much",
            "Nothing much",
            "Nope. Thanks a lot",
            "No thanks, bye",
            "Nothing really, thanks again",
            "All good, thank you, great",
        ):
            with self.subTest(text=text):
                self.assertTrue(is_no_questions(text))

    def test_no_questions_is_an_allowlist_not_a_list_of_question_words(self) -> None:
        # Round-5 probes: each carries a real request after a polite refusal, and none of
        # them opens a clause with a question word, so only an allowlist can keep them.
        for text in (
            "No, I am good. Any feedback for me",
            "No thanks, any idea when results come",
            "No questions. Any tips for the next round",
            "Nothing much, please share my feedback",
            "Nothing else, the salary range",
            "That's all, the notice period",
            "Nope, 30 days",
            "Nothing else, one more thing",
        ):
            with self.subTest(text=text):
                self.assertFalse(is_no_questions(text))

    def test_a_question_after_the_refusal_is_never_swallowed(self) -> None:
        # The round-4 probes: the refusal is real, and a real question follows it.
        for text in (
            "",
            "   ",
            "What does the first month look like?",
            "No, but what about the salary range and the notice period for this role please",
            "Nothing else, what about the notice period?",
            # No question word opens the clause, so neither list nor opener could keep these.
            "Nothing else, the notice period?",
            "No questions. Any feedback for me?",
            "All good, how long until I hear back?",
            # Unpunctuated speech-to-text: no question mark and still a question.
            "All good, how long until I hear back",
            "No questions but how long does it take",
            "Nothing really, can you repeat that",
            "Nothing else tell me about the team",
            "Nothing else - when do I hear back",
            "No questions, so what's next",
            # Not in Latin script: never mistaken for courtesy.
            "nope, " + chr(0x0915) + chr(0x094D) + chr(0x092F) + chr(0x093E),
        ):
            with self.subTest(text=text):
                self.assertFalse(is_no_questions(text))

    def test_a_question_mark_alone_keeps_the_turn_for_the_interviewer(self) -> None:
        # Every word here is courtesy, so ONLY the question mark can keep the turn: this
        # is the case that pins it (without the check each of these ends wrap-up).
        for text in ("No questions?", "Nothing else?", "Nope?", "That's all?", "No thanks?"):
            with self.subTest(text=text):
                self.assertFalse(is_no_questions(text))
                self.assertTrue(is_no_questions(text.rstrip("?")))

    # The answers the smoke test hit: every one comes back from the speech-to-text with a capital
    # and a full stop (and often a comma), and none was recognised before the transcript was
    # folded.  The bot then answered, sat through 20 s of silence, and said goodbye twice.
    PUNCTUATED_REFUSALS = (
        "No.",
        "No",
        "no",
        "NO!",
        "No, thank you.",
        "No, thanks.",
        "No. Thank you.",
        "No, thank you so much.",
        "No, I don't have any questions.",
        "No, I don’t have any questions.",  # the curly apostrophe Sarvam may emit
        "I do not have any questions.",
        "I have no questions.",
        "No further questions, thanks.",
        "Nope.",
        "Nope!",
        "Nah.",
        "That's all.",
        "That’s all",
        "That's it.",
        "No, that's it.",
        "I'm good.",
        "I am good, thank you.",
        "Yeah, I'm good.",
        "I think I'm good.",
        "I'm all set.",
        "Not really.",
        "No, nothing from my side.",
        "Nothing, thank you.",
        "Nothing else.",
        "Not at the moment, thanks.",
        # The grammatical answer to "do you have any questions": "I don't", with no noun.
        "No, I don't.",
        "No, I don't, thank you.",
        "No, I don’t.",
        "I don't.",
        "No, I do not.",
        # L-EXIT has just introduced the interviewer by name.
        "No, thank you, Christy.",
        "Thank you, Christy.",
        "No questions from my side.",
        "No questions from my end, thank you.",
        "No. Thank you so much for your time.",
        "No, thank you for your time today.",
        "No sir.",
        "No, ma'am.",
        "No, thank you, sir.",
        "Hmm, no.",
        "Mm, no.",
        "No, I'm okay.",
        "I'm okay, thank you.",
        "No, none.",
        "None.",
        "None, thank you.",
        "No, I'm fine.",
        # A thank-you alone closes it; with a "yes" it may open a question (see below).
        "Thank you.",
        "Thanks!",
        "Okay, thank you.",
        "Okay, thanks a lot.",
        # R1-Q item 8: an acknowledgement is what a candidate with nothing to ask says, both to
        # L-WRAP and to the answer after it ("Alright" was counted as question #2, the model said a
        # goodbye of its own, and L-CLOSE said it again).
        "Alright.",
        "Alright",
        "All right.",
        "Okay.",
        "Okay",
        "OK.",
        "Ok, got it.",
        "Got it.",
        "Got it, thanks.",
        "Sounds good.",
        "Alright, sounds good.",
        "Alright, thank you.",
        "Alright. Thank you so much.",
        "Okay, that's all.",
        "Okay, no, that's all.",
        "No, that's all.",
        "Understood.",
        "Perfect, thank you.",
        "Cool.",
        "Noted.",
        "Great.",
        "Okay, great.",
    )
    # A real question stays a question, however it is punctuated and however polite it is.
    PUNCTUATED_QUESTIONS = (
        "No, but when will I hear back?",
        "No, but when will I hear back",
        "No, what is the salary?",
        "Not really, but what is the notice period",
        "That's it, how long until I get results?",
        "No, I don't have any questions about the role, but what about the team size?",
        "Yeah, I do have one.",
        "Yes, how many rounds are there?",
        "No idea, what happens next?",
        "No questions?",  # a question mark alone keeps the turn for the interviewer
        "Nothing else?",
        "What is the notice period?",
        # "I don't" and the new courtesy words never swallow a request that follows them.
        "No, I don't know when I'll hear back",
        "No, I don't know what happens next",
        "No, what time do I start",
        "No, I don't have time for the next round",
        "I don't, but what about the notice period",
        "Thank you, can you tell me about the next steps",
        "Thank you, any idea when I will hear back",
        "Thanks, what about the salary",
        "None of the above, what about the salary",
        # A thank-you next to a "yes" may open a question: the interviewer answers it.
        "Yes, thank you.",
        "Yeah, thanks",
        "Sure, thank you",
        # An acknowledgement never swallows a request after it, and next to a "yes" it may open one.
        "Alright, one more question about shifts",
        "Alright but how long until I hear back",
        "Okay, so what happens next?",
        "Okay, so what happens next",
        "Okay, what is the notice period",
        "Got it, can you repeat that",
        "Sounds good, what about the team size",
        "Cool, any idea when I hear back",
        "Okay, I do have one",
        "Okay, yes",
        "Yeah, okay",
        "Yes, alright",
        "Okay?",
        "Alright?",
    )

    def test_a_punctuated_refusal_is_a_refusal(self) -> None:
        for text in self.PUNCTUATED_REFUSALS:
            with self.subTest(text=text):
                self.assertTrue(is_no_questions(text))

    def test_a_punctuated_question_is_still_a_question(self) -> None:
        for text in self.PUNCTUATED_QUESTIONS:
            with self.subTest(text=text):
                self.assertFalse(is_no_questions(text))

    def test_folding_speech_removes_case_punctuation_and_spacing_only(self) -> None:
        self.assertEqual(r1_session.fold_speech("  No,   thank you.  "), "no thank you")
        self.assertEqual(r1_session.fold_speech("Let’s start!"), "let's start")
        self.assertEqual(r1_session.fold_speech("“Nope” — that's all…"), "nope that's all")
        self.assertEqual(r1_session.fold_speech("go-ahead"), "go ahead")
        self.assertEqual(r1_session.fold_speech(None), "")
        # Letters of every script survive: a non-Latin word is still a word nobody allowlisted.
        devanagari = chr(0x0915) + chr(0x094D) + chr(0x092F) + chr(0x093E)
        self.assertEqual(r1_session.fold_speech("Nope, " + devanagari + "!"), "nope " + devanagari)
        self.assertFalse(is_no_questions("Nope, " + devanagari + "."))

    def test_ready_shortcuts_match_however_the_speech_to_text_punctuated_them(self) -> None:
        for text in (
            "Yes.", "Yes!", "YES", "Let's start.", "Let’s start", "Lets start",
            "Go ahead.", "Sure!", "Sure.", "Okay.", "OK!", "Yeah.", "I'm ready.", "Ready!",
            "Ready.", "Alright.",
            # A ready phrase with nothing but filler around it is still a ready answer.
            "Yes, let's start.", "Sure, go ahead.", "Okay, sure.", "Yep, go ahead.",
            "Ok, let's go!", "Yeah sure.", "Alright, let's do it.", "Yes please, go ahead.",
            "Okay, thank you, let's start.", "Yup.", "Of course, go on.", "Well, let's begin.",
        ):
            with self.subTest(text=text):
                self.assertTrue(R1Interview.is_ready(text))
        for text in (
            "I am already prepared", "Unready", "What do I do?", "Who is she?", "Not sure yet.",
            "Yes, but what do I say?", "",
            # A negation turns "ready" and the ready phrases around.
            "Not ready yet.", "I'm not ready.", "I am not sure I'm ready.", "We aren't ready.",
            "Don't start.", "Let's not start yet.", "No, not yet, I'm not ready.",
            # A real request next to a ready phrase is not a ready answer.
            "Yes, but where do I start", "Sure, what is her name", "Okay, I'll start in a minute",
        ):
            with self.subTest(text=text):
                self.assertFalse(R1Interview.is_ready(text))

    def test_room_name_must_be_a_server_created_screening_room(self) -> None:
        self.assertEqual(r1_session.session_id_from_room_name(ROOM_NAME), SESSION_ID)
        self.assertIsNone(r1_session.session_id_from_room_name("phone-" + SESSION_ID))
        self.assertIsNone(r1_session.session_id_from_room_name("screening-not-a-uuid"))
        self.assertEqual(bounded_seconds("R1_UNSET_FOR_TEST", 5.0, 1.0, 9.0), 5.0)


class TestCandidateAndStopEvents(R1TestCase):
    """Event tests prove that non-candidate room traffic cannot control R1."""

    @mock.patch.object(r1_session, "MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0)  # M032 S7C: at once
    async def test_only_candidate_microphone_mute_enters_and_exits_aside_silently(self) -> None:
        self.enter_roleplay()
        camera = FakePublication(kind=VIDEO, source=CAMERA)
        other_mic = FakePublication()
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), camera)
        self.ctx.room.emit("track_muted", FakeParticipant("agent"), other_mic)
        await self.interview._handle_attention()
        self.assertEqual(self.interview.machine.phase, R1Phase.ROLEPLAY)
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        await self.interview._handle_attention()
        self.assertEqual(self.interview.machine.phase, R1Phase.ASIDE)
        self.assertTrue(any("microphone" in speech for speech in self.session.spoken))
        speeches_before_unmute = list(self.session.spoken)
        self.ctx.room.emit("track_unmuted", FakeParticipant("candidate"), FakePublication())
        await self.interview._handle_attention()
        self.assertEqual(self.interview.machine.phase, R1Phase.ROLEPLAY)
        self.assertEqual(self.session.spoken, speeches_before_unmute)

    async def test_a_quick_mute_and_unmute_never_leaves_the_phase_in_aside(self) -> None:
        # The driver is busy (never woken between the two events): the room events
        # themselves must enter and leave ASIDE.
        self.enter_roleplay()
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)
        self.ctx.room.emit("track_unmuted", FakeParticipant("candidate"), FakePublication())
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)
        self.assertFalse(self.interview._needs_attention())
        self.assertEqual(self.session.spoken, [])

    @mock.patch.object(r1_session, "MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0)  # M032 S7C: at once
    async def test_mute_then_disconnect_then_rejoin_with_a_live_microphone_restores_roleplay(
        self,
    ) -> None:
        self.enter_roleplay()
        turn = asyncio.create_task(self.interview._roleplay_turn())
        await self.settle()
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)  # entered by the event itself
        await self.until(lambda: self.spoken_and_played("L-MUTE-RP"))
        self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
        await self.until(lambda: self.interview.machine.phase is R1Phase.PAUSED_DISCONNECTED)
        # A page refresh: a NEW, unmuted microphone publication; no track_unmuted event.
        rejoined = FakeParticipant("candidate", track_publications={"TR_new": FakePublication()})
        self.ctx.room.emit("participant_connected", rejoined)
        await self.until(lambda: self.spoken_and_played("L-REJOIN"))
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)
        self.assertFalse(self.interview._muted)
        self.final_transcript("sorry, I refreshed the page")
        self.assertIsNone(await asyncio.wait_for(turn, 10.0))
        self.assertIn(self.spoken_line("L-REJOIN"), self.session.spoken)
        self.assertNotIn(self.spoken_line("L-SIL-RP1"), self.session.spoken)

    async def test_a_republished_live_microphone_clears_a_stale_mute(self) -> None:
        self.enter_roleplay()
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)
        live = FakePublication()
        participant = FakeParticipant("candidate", track_publications={"TR_new": live})
        self.ctx.room.emit("track_published", live, participant)
        self.assertFalse(self.interview._muted)
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)

    async def test_a_muted_publication_in_the_room_is_muted_without_a_mute_event(self) -> None:
        self.enter_roleplay()
        muted = FakePublication(muted=True)
        participant = FakeParticipant("candidate", track_publications={"TR": muted})
        self.ctx.room.emit("track_published", muted, participant)
        self.assertTrue(self.interview._muted)
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)

    async def test_ending_roleplay_from_an_aside_never_raises(self) -> None:
        self.enter_roleplay()
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)
        self.interview._end_roleplay()
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY_EXIT)

    async def test_nonstandard_participants_do_not_select_or_depart_candidate(self) -> None:
        context = FakeContext()
        interview = R1Interview(context, {"first_name": "Asha"}, FakeSession(), FakeWriter([]))
        interview.wire_events()
        context.room.emit("participant_connected", FakeParticipant("egress", EGRESS))
        self.assertIsNone(interview._candidate_identity)
        candidate = FakeParticipant("candidate")
        context.room.emit("participant_connected", candidate)
        context.room.emit("participant_disconnected", FakeParticipant("sip", SIP))
        self.assertTrue(interview._candidate_present)
        self.assertFalse(interview._candidate_departed)

    async def test_r1_registers_no_job_shutdown_callback(self) -> None:
        # livekit-agents 1.6.4 runs those callbacks only after the entrypoint has ended
        # (test_r1_sdk_contract pins the order), so one could never stop an interview: the
        # drain is the cancellation below.  Registering one would only suggest otherwise.
        self.assertEqual(self.ctx.shutdown_callbacks, [])

    async def test_a_drain_cancels_a_long_turn_wait_and_leaves_nothing_behind(self) -> None:
        baseline = asyncio.all_tasks()
        waiter = asyncio.create_task(self.interview._await_turn(30.0))
        await self.settle()
        self.assertFalse(waiter.done())
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(waiter, 10.0)
        await self.settle()
        # asyncio.wait leaves its children running: a leaked Queue.get would swallow the
        # transcript that the closing line is still listening for.
        self.assertEqual(asyncio.all_tasks() - baseline, set())
        self.interview.note_turn("one more thing")
        await self.settle()
        self.assertFalse(self.interview._turns.empty())

    async def test_a_drain_in_role_play_speaks_the_system_line_and_forces_the_shutdown(
        self,
    ) -> None:
        run = await self.start_interview()
        await self.advance_to_roleplay(run)
        await self.drain_cancel(run)
        self.assertEqual(run.session.spoken[-1], self.spoken_line("L-SYSTEM-STOP"))
        self.assertIn("technical problem", run.session.spoken[-1])
        self.assertIs(run.interview.machine.phase, R1Phase.FINISHING)
        self.assertEqual(self.writer.terminals, [("shutdown_forced", {"activated": True})])
        self.assertEqual(run.context.shutdowns, ["r1_exit"])

    async def test_residency_deadline_wakes_a_long_turn_wait(self) -> None:
        waiter = asyncio.create_task(self.interview._await_turn(30.0))
        await self.settle()
        self.assertFalse(waiter.done())
        self.interview._on_residency_deadline()
        self.assertEqual(await asyncio.wait_for(waiter, 10.0), (STOP, "residency_timeout"))

    async def test_forced_close_at_s_32_minutes_is_scheduled_and_stops_the_wait(self) -> None:
        self.clock.advance(1919.95)  # S: 1919.95 s since activation (the M1 ceiling, 32:00)
        self.interview._schedule_forced_close()
        waiter = asyncio.create_task(self.interview._await_turn(30.0))
        self.assertEqual(await asyncio.wait_for(waiter, 10.0), (STOP, "residency_timeout"))
        self.assertTrue(self.interview._forced_close_due)

    async def test_room_loss_after_the_candidate_left_is_candidate_left_not_a_drain(self) -> None:
        self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
        self.ctx.room.emit("disconnected", "room closed")
        self.assertEqual(self.interview._stop_outcome(), "candidate_left")
        self.assertEqual(self.interview._cancel_outcome(), "candidate_left")

    async def test_room_loss_while_the_candidate_is_present_is_not_a_candidate_departure(
        self,
    ) -> None:
        self.ctx.room.emit("disconnected", "connection lost")
        self.assertEqual(self.interview._stop_outcome(), "shutdown_forced")

    async def test_a_cancellation_with_the_room_still_connected_is_a_forced_shutdown(self) -> None:
        # A drain that ran out its timeout: the room is still ours, whoever is in it.
        self.assertEqual(self.interview._cancel_outcome(), "shutdown_forced")
        self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
        self.assertEqual(self.interview._cancel_outcome(), "shutdown_forced")
        # The SDK cancels the entrypoint after a room loss too: that is not a drain.
        self.ctx.room.emit("disconnected", "room closed")
        self.assertEqual(self.interview._cancel_outcome(), "candidate_left")

    async def test_provider_401_aborts_immediately(self) -> None:
        error = type("ProviderError", (), {"status_code": 401})()
        event = type("ProviderEvent", (), {"error": error})()
        self.session.emit("close", event)
        self.assertEqual(await self.interview._handle_attention(), "provider_error")

    async def test_nested_provider_402_aborts_from_error_event(self) -> None:
        api_error = type("APIError", (), {"status_code": 402})()
        llm_error = type("LLMError", (), {"error": api_error})()
        self.session.emit("error", type("ErrorEvent", (), {"error": llm_error})())
        self.assertEqual(await self.interview._handle_attention(), "provider_error")

    async def test_recoverable_and_stt_errors_are_not_generation_failures(self) -> None:
        recoverable = SimpleNamespace(type="llm_error", recoverable=True, error=RuntimeError())
        self.session.emit("error", SimpleNamespace(error=recoverable))
        stt = SimpleNamespace(type="stt_error", recoverable=False, error=RuntimeError())
        self.session.emit("error", SimpleNamespace(error=stt))
        self.assertEqual(self.interview._failures, 0)

    async def test_three_unrecoverable_llm_or_tts_errors_abort(self) -> None:
        for kind in ("llm_error", "tts_error", "llm_error"):
            error = SimpleNamespace(type=kind, recoverable=False, error=RuntimeError())
            self.session.emit("error", SimpleNamespace(error=error))
        self.assertEqual(self.interview._stop_outcome(), "provider_error")

    async def test_a_session_close_carrying_an_error_aborts(self) -> None:
        error = SimpleNamespace(type="llm_error", recoverable=False, error=RuntimeError())
        self.session.emit("close", SimpleNamespace(error=error, reason="error"))
        self.assertEqual(self.interview._stop_outcome(), "provider_error")

    async def test_a_clean_session_close_is_not_an_abort(self) -> None:
        self.session.emit("close", SimpleNamespace(error=None, reason="user_initiated"))
        self.assertIsNone(self.interview._stop_outcome())


class TestLlmGuard(R1TestCase):
    """The 4 s filler and the 12 s deadline belong to ONE generation and to LLM replies only.

    Timing is event-driven wherever possible: streams wait on gates the test opens, and
    the few real timers (the guard's own deadlines) are scaled so that the interval the
    test depends on is at least ten times any plausible scheduling delay.
    """

    @staticmethod
    async def stream(*items):
        for item in items:
            yield item

    @staticmethod
    async def gated(gate: asyncio.Event, *items):
        """Yield ``items`` only after the test opens the gate."""
        await gate.wait()
        for item in items:
            yield item

    @staticmethod
    async def hung_stream():
        await asyncio.Event().wait()
        yield "never"

    async def collect(self, stream) -> list:
        return [item async for item in self.interview.guard_llm_stream(stream)]

    async def test_the_first_llm_chunk_resets_consecutive_failures(self) -> None:
        self.interview._failures = 2
        self.assertEqual(await self.collect(self.stream("a", "b")), ["a", "b"])
        self.assertEqual(self.interview._failures, 0)

    async def test_a_scripted_say_never_resets_failures(self) -> None:
        # say() makes the agent "speaking" exactly like a reply does; it must not count.
        self.interview._failures = 2
        await self.interview.say("L-SIL-IB")
        self.session.emit("agent_state_changed", state_event("speaking"))
        self.assertEqual(self.interview._failures, 2)

    async def test_the_filler_travels_inside_the_reply_and_is_not_a_second_speech(self) -> None:
        gate = asyncio.Event()
        with mock.patch.object(r1_session, "FILLER_AFTER_SECONDS", 0.01):
            guard = self.interview.guard_llm_stream(self.gated(gate, "reply"))
            first = await asyncio.wait_for(guard.__anext__(), 10.0)
            self.assertEqual(first, self.spoken_line("L-FILLER-INTERVIEWER") + " ")
            self.assertEqual(self.interview._failures, 0)
            gate.set()  # the provider answers only after the filler was yielded
            self.assertEqual(await asyncio.wait_for(guard.__anext__(), 10.0), "reply")
            await guard.aclose()
        self.assertEqual(self.session.spoken, [])  # nothing was queued behind the reply

    async def test_the_roleplay_filler_uses_the_learner_voice(self) -> None:
        self.enter_roleplay()
        gate = asyncio.Event()
        with mock.patch.object(r1_session, "FILLER_AFTER_SECONDS", 0.01):
            guard = self.interview.guard_llm_stream(self.gated(gate, "reply"))
            first = await asyncio.wait_for(guard.__anext__(), 10.0)
            await guard.aclose()
        # The learner's filler is a 3-variant rotation seeded by the attempt id (R1-Q), so a
        # slow model never makes the learner say the same words every time.
        self.assertIn(first, [variant + " " for variant in LEARNER_FILLER_VARIANTS])
        self.assertEqual(self.interview.engine.admin_log()["repetition"]["fillers_used"], 1)

    async def test_the_roleplay_filler_rotates_through_its_variants(self) -> None:
        self.enter_roleplay()
        fillers = []
        for _ in range(3):
            gate = asyncio.Event()
            with mock.patch.object(r1_session, "FILLER_AFTER_SECONDS", 0.01):
                guard = self.interview.guard_llm_stream(self.gated(gate, "reply"))
                fillers.append(await asyncio.wait_for(guard.__anext__(), 10.0))
                await guard.aclose()
        self.assertEqual(len(set(fillers)), 3, fillers)
        self.assertEqual(set(fillers), {v + " " for v in LEARNER_FILLER_VARIANTS})

    async def test_no_filler_when_the_reply_is_fast(self) -> None:
        self.assertEqual(await self.collect(self.stream("fast")), ["fast"])

    async def test_a_twelve_second_overrun_counts_before_it_interrupts_and_never_awaits_it(
        self,
    ) -> None:
        seen: list[int] = []
        self.session.interrupt_hook = lambda: seen.append(self.interview._failures)
        self.session.interrupt_delay = 30.0  # an interrupt that cannot finish
        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.05), mock.patch.object(
            r1_session, "FILLER_AFTER_SECONDS", 1.0
        ):
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(self.collect(self.hung_stream()), 10.0)
        self.assertEqual(self.interview._failures, 1)
        await self.until(lambda: bool(seen))
        self.assertEqual(seen, [1])  # the failure was already counted when interrupt ran
        await self.flush()  # cancels the still-pending interrupt

    async def test_three_hung_turns_abort_even_when_scripted_speech_plays_between_them(
        self,
    ) -> None:
        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.03), mock.patch.object(
            r1_session, "FILLER_AFTER_SECONDS", 1.0
        ):
            for _ in range(3):
                with self.assertRaises(TimeoutError):
                    await self.collect(self.hung_stream())
                await self.interview.say("L-SIL-IB")  # agent_state speaking, as the SDK reports
        self.assertEqual(self.interview._failures, 3)
        self.assertEqual(self.interview._stop_outcome(), "provider_error")
        await self.flush()

    async def test_a_filler_playing_inside_a_hung_turn_does_not_reset_the_failure_count(
        self,
    ) -> None:
        # The round-3 P1 scenario: the provider hangs, the 4 s filler plays, and the
        # filler's own audio used to count as "the reply started" and reset the failures.
        self.interview._failures = 2
        yielded: list = []
        with mock.patch.object(r1_session, "FILLER_AFTER_SECONDS", 0.01), mock.patch.object(
            r1_session, "TURN_DEADLINE_SECONDS", 0.5
        ):
            with self.assertRaises(TimeoutError):
                async for item in self.interview.guard_llm_stream(self.hung_stream()):
                    yielded.append(item)
                    self.session.emit("agent_state_changed", state_event("speaking"))
        self.assertEqual(yielded, [self.spoken_line("L-FILLER-INTERVIEWER") + " "])
        self.assertEqual(self.interview._failures, 3)
        self.assertEqual(self.interview._stop_outcome(), "provider_error")
        await self.flush()

    async def test_three_hung_turns_with_a_filler_each_still_abort(self) -> None:
        with mock.patch.object(r1_session, "FILLER_AFTER_SECONDS", 0.01), mock.patch.object(
            r1_session, "TURN_DEADLINE_SECONDS", 0.2
        ):
            for _ in range(3):
                with self.assertRaises(TimeoutError):
                    await self.collect(self.hung_stream())
        self.assertEqual(self.interview._failures, 3)
        self.assertEqual(self.interview._stop_outcome(), "provider_error")
        await self.flush()

    async def test_a_stale_generation_timing_out_does_not_interrupt_a_newer_one(self) -> None:
        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.4), mock.patch.object(
            r1_session, "FILLER_AFTER_SECONDS", 5.0
        ):
            stale = asyncio.create_task(self.collect(self.hung_stream()))
            await self.settle()  # the stale generation is registered first
            self.assertEqual(await self.collect(self.stream("newer", "reply")), ["newer", "reply"])
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(stale, 10.0)
        await self.settle()
        self.assertEqual(self.session.interrupts, 0)  # the newer turn was left alone
        self.assertEqual(self.interview._failures, 1)  # the stale turn still failed
        await self.flush()

    async def test_the_latest_generation_timing_out_interrupts_the_session_once(self) -> None:
        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.03), mock.patch.object(
            r1_session, "FILLER_AFTER_SECONDS", 1.0
        ):
            with self.assertRaises(TimeoutError):
                await self.collect(self.hung_stream())
        await self.until(lambda: self.session.interrupts == 1)
        await self.settle()
        self.assertEqual(self.session.interrupts, 1)
        await self.flush()

    async def test_a_hung_generation_never_cuts_a_protected_scripted_line(self) -> None:
        # session.interrupt(force=True) cuts the current AND every queued speech, so a
        # hung (often discarded preemptive) generation must not interrupt L-EXIT.
        protected = FakeSpeechHandle("L-EXIT", allow_interruptions=False)
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=protected, source="say", user_initiated=True),
        )
        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.03), mock.patch.object(
            r1_session, "FILLER_AFTER_SECONDS", 1.0
        ):
            with self.assertRaises(TimeoutError):
                await self.collect(self.hung_stream())
        await self.settle()
        await self.flush()
        self.assertEqual(self.session.interrupts, 0)
        self.assertEqual(self.interview._failures, 1)  # the hang still counts
        protected.finish()  # done: the protection ends with the line
        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.03), mock.patch.object(
            r1_session, "FILLER_AFTER_SECONDS", 1.0
        ):
            with self.assertRaises(TimeoutError):
                await self.collect(self.hung_stream())
        await self.until(lambda: self.session.interrupts == 1)
        await self.flush()

    async def test_closing_the_guard_closes_the_provider_stream(self) -> None:
        closed = []

        async def provider():
            try:
                yield "one"
                yield "two"
            finally:
                closed.append(True)

        guard = self.interview.guard_llm_stream(provider())
        self.assertEqual(await guard.__anext__(), "one")
        await guard.aclose()
        self.assertEqual(closed, [True])

    async def test_observed_reasoning_tokens_fail_the_reply(self) -> None:
        chunk = SimpleNamespace(usage=SimpleNamespace(reasoning_tokens=7))
        with self.assertRaisesRegex(RuntimeError, "reasoning_tokens"):
            await self.collect(self.stream(chunk))


class TestReplyPolicy(R1TestCase):
    """The SDK must not reply to a transcript the driver owns or that ends a phase."""

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.agent = R1Agent(self.interview)
        self.mutations: list = []

        class RecordingContext:
            """Any attempt to change the turn context is recorded, whatever the method."""

            def __getattr__(inner, name):  # noqa: N805 - records every attribute access
                self.mutations.append(name)
                return lambda *_a, **_k: None

        self.turn_ctx = RecordingContext()

    async def hook(self, text: str = "hello there") -> None:
        await self.agent.on_user_turn_completed(
            self.turn_ctx, SimpleNamespace(text_content=text)
        )

    def move_to(self, *phases: R1Phase) -> None:
        for phase in phases:
            self.interview.machine.transition(phase)

    async def test_transition_is_always_driver_owned(self) -> None:
        self.move_to(R1Phase.TRANSITION)
        with self.assertRaises(r1_session.StopResponse):
            await self.hook("ready")

    async def test_phases_the_driver_owns_never_get_a_reply(self) -> None:
        for phase in (R1Phase.PRE_JOIN, R1Phase.OPENING, R1Phase.CLOSING, R1Phase.FINISHING):
            with self.subTest(phase=phase):
                self.interview.machine.phase = phase
                with self.assertRaises(r1_session.StopResponse):
                    await self.hook()

    async def test_an_early_icebreaker_turn_gets_a_reply(self) -> None:
        self.interview.machine.candidate_turns = 1
        await self.hook()

    async def test_the_turn_context_is_never_modified(self) -> None:
        # Preemptive generation keeps its reply only while the context is unchanged
        # after this hook; any message appended here made the SDK discard every reply
        # and generate it a second time (double LLM calls, no latency win).
        self.interview.machine.candidate_turns = 1
        await self.hook("tell me about the course")
        self.enter_roleplay()
        await self.hook("my pitch")
        self.interview._on_residency_deadline()
        with self.assertRaises(r1_session.StopResponse):
            await self.hook("ready")  # a suppressed turn leaves it alone too
        self.assertEqual(self.mutations, [])

    async def test_the_icebreaker_turn_that_ends_the_phase_gets_no_reply(self) -> None:
        self.clock.advance(215)
        for answer in ("I sell courses", "mostly by phone", "for three years"):
            self.assertFalse(await self.answer(answer))  # three turns: not yet the soft exit
        self.final_transcript("and I enjoy it")
        with self.assertRaises(r1_session.StopResponse):
            await self.hook("and I enjoy it")  # the fourth committed answer is the boundary

    async def test_the_soft_exit_counts_committed_answers_not_transcript_finals(self) -> None:
        # Sarvam splits one spoken answer at its own pauses; the SDK commits it as ONE turn.  Six
        # finals of one answer used to be six "turns" (and the exit fell mid-conversation).
        self.clock.advance(215)
        for fragment in ("I sell courses,", "mostly by phone,", "to working professionals,"):
            self.final_transcript(fragment)
        self.final_transcript("for about three years.")
        self.assertEqual(self.interview.machine.candidate_turns, 0)
        self.assertFalse(self.interview.machine.icebreaker_should_end())
        self.assertFalse(await self.commit_turn("I sell courses, mostly by phone, for years."))
        self.assertEqual(self.interview.machine.candidate_turns, 1)
        self.assertFalse(self.interview.machine.icebreaker_should_end())

    async def test_a_committed_fragment_is_not_an_answer(self) -> None:
        # "Sorry", "Thank you." and "Hello" commit as turns when no reply is pending to protect,
        # but they are not answers: it takes ICEBREAKER_ANSWER_MIN_WORDS words that are not noise.
        for fragment in ("Sorry.", "Thank you.", "Hello", "Yes please"):
            self.assertFalse(await self.answer(fragment))
        self.assertEqual(self.interview.machine.candidate_turns, 0)

    async def test_committed_backchannel_of_three_words_or_more_is_not_an_answer(self) -> None:
        # The SDK's own floor is the WORD count, and the owner's session had all of these: "Sorry"
        # banked and committed with the next "Thank you." (three words), "Hey, are you there?"
        # (four).  None of them answers the question, so none counts toward the soft exit.
        for noise in (
            "Sorry Thank you.",
            "Hey, are you there?",
            "Sorry. Thank you. Hey, are you there?",
            "Hmm. Okay. Right.",
            "Yes. Right, sure.",
            "Alright, thank you.",
            "Okay, got it, thanks.",
            "Hello? Hello? Hello?",
        ):
            with self.subTest(noise=noise):
                self.assertGreaterEqual(r1_session.count_words(noise), 3)  # the SDK commits it
                self.assertFalse(await self.answer(noise))
                self.assertEqual(self.interview.machine.candidate_turns, 0)

    # Requests to hear the question again, and audio checks.  Each is three words or more, so the
    # SDK commits it as a turn, and none of them answers the question.
    CLARIFICATIONS = (
        "Sorry, can you repeat that?",
        "What did you say?",
        "Yes, I can hear you",
        "Sorry, I didn't catch that.",
        "Could you say that again, please?",
        "Can you hear me?",
        "Please repeat the question",
        "Sorry, what was the question again?",
        "I didn't get the question",
        "Sorry I couldn't hear you",
        "You are breaking up",
        "Can you speak a bit louder",
        "Pardon, could you repeat what you said?",
        "What do you mean?",
        "Can you rephrase that?",
        "Sorry I missed the last part",
        "Hello, can you hear me now?",
        # M032 S6 (SWEEP-28, R1_ICEBREAKER_REPAIR on): "once again", "not able to hear", "I'm sorry".
        "Can you repeat that once again?",
        "Sorry, I was not able to hear you.",
        "I'm sorry, could you repeat that?",
    )

    async def test_a_request_to_repeat_or_an_audio_check_is_not_an_answer(self) -> None:
        for clarification in self.CLARIFICATIONS:
            with self.subTest(clarification=clarification):
                self.assertGreaterEqual(r1_session.count_words(clarification), 3)  # the SDK commits it
                self.assertEqual(r1_session.content_word_count(clarification), 0)
                self.assertFalse(await self.answer(clarification))  # the model repeats the question
                self.assertEqual(self.interview.machine.candidate_turns, 0)

    async def test_an_answer_after_a_request_to_repeat_is_still_an_answer(self) -> None:
        for answer_text in (
            "Sorry, can you repeat that? I sell courses to working professionals.",
            "Yes, I can hear you, I sell courses online",
            "Can you repeat that? I work in sales for three years",
        ):
            with self.subTest(answer=answer_text):
                before = self.interview.machine.candidate_turns
                self.assertFalse(await self.answer(answer_text))
                self.assertEqual(self.interview.machine.candidate_turns, before + 1)

    def test_the_words_of_a_real_answer_are_not_cut_as_a_clarification(self) -> None:
        # The phrases are cut out of the turn, never matched loosely: an answer that merely uses
        # the same verbs ("say", "ask", "repeat", "hear", "get", "understand") is left whole.
        for text, words in (
            ("I couldn't get a job at first", 7),
            ("I say what I think to every learner", 8),
            ("We ask learners about their goals", 6),
            ("I explain the program to the learners", 7),
            ("I can hear the objection coming from a mile away", 10),
            ("I repeat the same process every day", 7),
            ("I understand what customers want", 5),
            ("I sell courses", 3),
        ):
            with self.subTest(text=text):
                self.assertEqual(r1_session.content_word_count(text), words)

    async def test_a_request_to_repeat_at_the_boundary_gets_the_question_repeated(self) -> None:
        # S >= 3:30 and three answers in: the next committed answer is the boundary, and the
        # transition line (uninterruptible) answers it.  "Sorry, can you repeat that?" is not an
        # answer, so the model repeats the question; only a real fourth answer ends the phase.
        self.clock.advance(215)
        for answer in ("I sell courses", "mostly by phone", "for three years"):
            self.assertFalse(await self.answer(answer))
        self.assertEqual(self.interview.machine.candidate_turns, 3)
        for clarification in ("Sorry, can you repeat that?", "Yes, I can hear you"):
            with self.subTest(clarification=clarification):
                self.final_transcript(clarification)
                await self.hook(clarification)  # no StopResponse: the SDK generates the reply
                self.assertEqual(self.interview.machine.candidate_turns, 3)
                self.assertFalse(self.interview.machine.icebreaker_should_end())
                self.assertFalse(self.interview._icebreaker_boundary_turn)
        self.final_transcript("and I enjoy it")
        with self.assertRaises(r1_session.StopResponse):
            await self.hook("and I enjoy it")  # the real fourth answer is the boundary
        self.assertTrue(self.interview._icebreaker_boundary_turn)

    async def test_the_real_answers_of_the_owner_session_are_counted(self) -> None:
        for answer_text in (
            "Yeah, so my name is Cristo. I have around 11 years of experience.",
            "I have been, my previous companies are Scalar, Great Learning and Upgrade.",
            "Sorry, I sell courses to working professionals.",  # a filler inside a real answer
            "I sell courses",
            "Yeah I do sales",
        ):
            with self.subTest(answer=answer_text):
                before = self.interview.machine.candidate_turns
                self.assertFalse(await self.answer(answer_text))
                self.assertEqual(self.interview.machine.candidate_turns, before + 1)

    def test_the_noise_filter_works_on_folded_text(self) -> None:
        self.assertEqual(r1_session.content_word_count("Sorry. Thank you!"), 0)
        self.assertEqual(r1_session.content_word_count("SORRY, thank-you"), 0)
        self.assertEqual(r1_session.content_word_count("I sell courses"), 3)
        self.assertEqual(r1_session.content_word_count(""), 0)
        self.assertTrue(r1_session.is_backchannel_turn("Hey, are you there?"))
        self.assertTrue(r1_session.is_backchannel_turn("Okay, right."))
        self.assertFalse(r1_session.is_backchannel_turn("Okay, I sell courses."))
        self.assertFalse(r1_session.is_backchannel_turn(""))
        self.assertFalse(r1_session.is_backchannel_turn("..."))

    def test_an_acknowledgement_is_narrower_than_a_backchannel(self) -> None:
        # Voice barge-in, reviewed fix: after a cut only these get the learner's point finished.
        for text in (
            "Yeah.", "Okay.", "Ok", "Hmm.", "Mm-hmm.", "Uh-huh.", "Right, right.", "Sure.",
            "Got it.", "I see.", "Alright.", "All right.", "Yeah, yeah, okay.", "Go ahead.",
            "Sorry, go ahead.", "No, no, please continue.", "Go on.",
        ):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_acknowledgement_turn(text))
        for text in (
            "Yes.", "No.", "No, no, no.", "Sorry?", "Pardon?", "Sorry.", "Really?", "Okay?",
            "Right?", "Hello? Are you there?", "Great.", "Thank you.", "Okay, thank you, bye.",
            "Yeah, so the course costs nine thousand dollars", "", "...",
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_acknowledgement_turn(text))

    def test_a_repair_request_asks_to_hear_it_again_or_checks_the_line(self) -> None:
        for text in (
            "Sorry?", "Pardon?", "Sorry, again?", "Sorry, what?", "What?", "Come again?",
            "Excuse me?", "Hello? Are you there?", "Are you still there?", "Can you hear me?",
            "Sorry, can you say that again?", "Yes, I can hear you.", "Sorry, sorry.", "Huh?",
        ):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_repair_turn(text))
        for text in (
            "Yeah.", "Okay?", "No, no, no.", "Really?", "So what?", "Okay, thank you, bye.",
            "Sorry, I sell courses.", "What does the course cost?", "Sorry, go ahead.", "", "...",
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_repair_turn(text))

    async def test_an_early_answer_spoken_over_the_opening_still_counts_as_a_turn(self) -> None:
        self.interview.machine.phase = R1Phase.OPENING
        self.assertTrue(await self.answer("I have been selling for six years"))
        self.assertEqual(self.interview.machine.candidate_turns, 1)

    async def test_only_the_icebreaker_phases_count_answers(self) -> None:
        self.enter_roleplay()
        await self.answer("I have been selling for six years")
        self.assertEqual(self.interview.machine.candidate_turns, 0)

    async def test_the_hard_icebreaker_deadline_ends_the_phase_without_a_reply(self) -> None:
        self.clock.advance(271)
        with self.assertRaises(r1_session.StopResponse):
            await self.hook()

    async def test_roleplay_replies_until_the_role_play_ends(self) -> None:
        self.enter_roleplay()
        await self.hook("my pitch")
        self.clock.advance(1201)
        with self.assertRaises(r1_session.StopResponse):
            await self.hook("one last thing")

    async def test_an_aside_still_replies_until_the_role_play_ends(self) -> None:
        self.enter_roleplay()
        self.interview.machine.transition(R1Phase.ASIDE)
        await self.hook("I am back")

    async def test_wrapup_answers_a_question_but_not_a_no_questions(self) -> None:
        self.enter_roleplay()
        self.interview._end_roleplay()
        self.interview.machine.transition(R1Phase.WRAPUP)
        await self.hook("What is the notice period for this role?")
        with self.assertRaises(r1_session.StopResponse):
            await self.hook("No questions, thank you")

    async def test_a_pending_stop_suppresses_the_reply(self) -> None:
        self.enter_roleplay()
        await self.hook()  # nothing is pending yet: the interviewer answers
        self.interview._on_residency_deadline()
        with self.assertRaises(r1_session.StopResponse):
            await self.hook()

    async def test_a_lost_room_or_a_provider_abort_suppresses_the_reply(self) -> None:
        self.enter_roleplay()
        self.session.emit("close", SimpleNamespace(error=RuntimeError(), reason="error"))
        with self.assertRaises(r1_session.StopResponse):
            await self.hook()
        self.interview._provider_abort = False
        await self.hook()
        self.ctx.room.emit("disconnected", "room closed")
        with self.assertRaises(r1_session.StopResponse):
            await self.hook()

    async def test_nothing_is_answered_once_the_exit_has_begun(self) -> None:
        self.enter_roleplay()
        self.interview._begin_exit()
        with self.assertRaises(r1_session.StopResponse):
            await self.hook()


class TestSilenceWindows(R1TestCase):
    """The silence windows measure CANDIDATE silence only (plan section 5.11).

    "Has not finished yet" claims are structural (no timer can be running) or use a
    sleep that only makes them STRONGER under load; "has finished" claims wait on
    events with a generous timeout, never on a short real sleep.
    """

    async def test_agent_speech_is_not_candidate_silence(self) -> None:
        self.agent_state("speaking")
        waiter = asyncio.create_task(self.interview._await_turn(0.05))
        await asyncio.sleep(0.2)  # four windows' worth of agent speech
        self.assertFalse(waiter.done())
        self.assertIsNone(self.interview._quiet_since)  # no window runs while it speaks
        self.agent_state("listening")
        self.assertIsNotNone(self.interview._quiet_since)  # it starts only now
        self.assertEqual(await asyncio.wait_for(waiter, 10.0), (SILENCE, None))

    async def test_the_candidate_talking_is_not_silence_either(self) -> None:
        self.user_state("speaking")
        waiter = asyncio.create_task(self.interview._await_turn(0.05))
        await asyncio.sleep(0.2)
        self.assertFalse(waiter.done())
        self.user_state("listening")
        self.assertEqual(await asyncio.wait_for(waiter, 10.0), (SILENCE, None))

    async def test_a_thinking_agent_holds_the_window(self) -> None:
        self.agent_state("thinking")
        waiter = asyncio.create_task(self.interview._await_turn(0.05))
        await asyncio.sleep(0.15)
        self.assertFalse(waiter.done())
        self.final_transcript("an answer")
        self.assertEqual(await asyncio.wait_for(waiter, 10.0), (TURN, "an answer"))

    async def test_the_window_restarts_when_the_agent_finishes_speaking(self) -> None:
        loop = asyncio.get_running_loop()
        self.agent_state("speaking")
        waiter = asyncio.create_task(self.interview._await_turn(0.1))
        await asyncio.sleep(0.15)  # longer than the whole window, all of it agent speech
        self.assertFalse(waiter.done())
        before = loop.time()
        self.agent_state("listening")
        # The window is measured from the moment the agent stopped, not from the start.
        self.assertGreaterEqual(self.interview._quiet_since, before)
        self.assertEqual(await asyncio.wait_for(waiter, 10.0), (SILENCE, None))

    @mock.patch.object(r1_session, "MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0)  # M032 S7C: at once
    async def test_a_muted_microphone_pauses_the_countdown(self) -> None:
        self.enter_roleplay()
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        turn = asyncio.create_task(self.interview._await_turn(0.05))
        await self.until(lambda: self.spoken_and_played("L-MUTE-RP"))
        await asyncio.sleep(0.2)  # four windows' worth of muted time
        self.assertFalse(turn.done())
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-MUTE-RP")), 1)
        self.ctx.room.emit("track_unmuted", FakeParticipant("candidate"), FakePublication())
        self.assertEqual(await asyncio.wait_for(turn, 10.0), (SILENCE, None))

    async def test_a_muted_wait_is_bounded_by_the_phase_budget(self) -> None:
        self.interview._muted = True
        self.interview._mute_announced = True
        loop = asyncio.get_running_loop()
        started = loop.time()
        result = await asyncio.wait_for(
            self.interview._await_turn(30.0, hard=lambda: 0.05 - (loop.time() - started)), 10.0
        )
        self.assertEqual(result, (DEADLINE, None))

    async def test_a_phase_budget_moving_with_a_paused_clock_is_reread(self) -> None:
        budget = [5.0]
        waiter = asyncio.create_task(self.interview._await_turn(30.0, hard=lambda: budget[0]))
        await self.settle()
        self.assertFalse(waiter.done())
        budget[0] = 0.0
        self.interview._wake()
        self.assertEqual(await asyncio.wait_for(waiter, 10.0), (DEADLINE, None))

    async def test_await_turn_reports_real_silence(self) -> None:
        result = await asyncio.wait_for(self.interview._await_turn(0.01), 10.0)
        self.assertEqual(result, (SILENCE, None))

    async def test_nonterminal_wakeup_is_not_treated_as_silence(self) -> None:
        self.enter_roleplay()
        waiter = asyncio.create_task(self.interview._await_turn(30.0))
        await self.settle()
        self.interview._record_generation_failure()
        await self.settle()
        self.assertFalse(waiter.done())
        self.final_transcript("I am still here")
        self.assertEqual(await asyncio.wait_for(waiter, 10.0), (TURN, "I am still here"))

    async def test_transcript_racing_an_attention_signal_is_not_lost(self) -> None:
        self.interview.note_turn("hello")
        self.interview._attention.set()
        self.assertEqual(
            await self.interview._wait_for_turn_or_attention(1.0), ("turn", "hello")
        )
        self.assertTrue(self.interview._attention.is_set())

    async def test_silence_ladder_speaks_each_prompt_then_ends(self) -> None:
        self.enter_roleplay()
        outcome = await asyncio.wait_for(
            self.interview._silence_ladder([("L-SIL-RP1", 0.01), ("L-SIL-RP2", 0.01)]), 10.0
        )
        self.assertEqual(outcome, "candidate_left")
        tail = self.session.spoken[-3:]
        self.assertEqual(
            tail,
            [self.spoken_line("L-SIL-RP1"), self.spoken_line("L-SIL-RP2"),
             self.spoken_line("L-SIL-END")],
        )
        self.assertTrue(self.interview._goodbye_spoken)

    async def test_silence_ladder_stops_when_the_candidate_answers(self) -> None:
        self.enter_roleplay()
        ladder = asyncio.create_task(self.interview._silence_ladder([("L-SIL-RP1", 60.0)]))
        await self.until(lambda: self.spoken_and_played("L-SIL-RP1"))
        self.final_transcript("yes, sorry")
        self.assertIsNone(await asyncio.wait_for(ladder, 10.0))
        self.assertNotIn(self.spoken_line("L-SIL-END"), self.session.spoken)

    async def test_silence_after_the_end_question_is_the_ordinary_ladder(self) -> None:
        # Owner test 7f2a25e6: an answer to "Hello? Are you still there?" must not be read as the
        # answer to L-ASIDE-END ("say: end the interview"), so the question lapses when silence
        # wins.
        self.enter_roleplay()
        engine = self.interview.engine
        engine.plan_turn("Hi, thanks for taking my call.", 20)
        self.assertTrue(engine.plan_turn("Can you end the call?", 60).aside)
        ladder = mock.AsyncMock(return_value=None)
        with mock.patch.object(r1_session, "ROLEPLAY_PROMPT_SECONDS", 0.01), \
                mock.patch.object(self.interview, "_silence_ladder", ladder):
            self.assertIsNone(await asyncio.wait_for(self.interview._roleplay_turn(), 10.0))
        ladder.assert_awaited_once()
        self.assertFalse(engine.plan_turn("End it.", 100).exit_roleplay)
        self.assertFalse(engine.end_confirmed)
        self.assertFalse(engine.exit_requested)

    async def test_rp2_enters_aside_and_stays_there_on_terminal_silence(self) -> None:
        self.enter_roleplay()
        outcome = await asyncio.wait_for(
            self.interview._silence_ladder([("L-SIL-RP2", 0.01)]), 10.0
        )
        self.assertEqual(outcome, "candidate_left")
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)

    async def test_rp2_is_not_cut_short_by_the_paused_role_play_budget(self) -> None:
        self.enter_roleplay()
        self.clock.advance(1199.0)  # S = 1199 s: the S=26:00 cap still has 361 s
        # R is paused during the aside, so its budget must NOT bound this step. Make the
        # R budget run out in real time (the manual clock cannot) so that a step wrongly
        # bounded by it would end long before the 60 s silence window.
        r_budget = TestPhaseDriver.shrinking(0.2)
        with mock.patch.object(self.interview.machine, "remaining_roleplay_seconds", r_budget):
            ladder = asyncio.create_task(self.interview._silence_ladder([("L-SIL-RP2", 60.0)]))
            await self.until(lambda: self.spoken_and_played("L-SIL-RP2"))
            await asyncio.sleep(0.5)  # well past the R budget
            self.assertFalse(ladder.done())
            self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)
            self.final_transcript("sorry, I am here")
            self.assertIsNone(await asyncio.wait_for(ladder, 10.0))
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)

    async def test_a_non_aside_step_that_the_budget_cannot_cover_ends_the_phase(self) -> None:
        self.enter_roleplay()
        self.clock.advance(1195)  # 5 s of R left
        outcome = await self.interview._silence_ladder([("L-SIL-RP1", 20.0)])
        self.assertEqual(outcome, "phase_deadline")
        self.assertEqual(self.session.spoken, [])

    async def test_rp2_is_skipped_for_the_phase_end_when_no_role_play_time_is_left(self) -> None:
        self.enter_roleplay()
        self.clock.advance(1200)
        outcome = await self.interview._silence_ladder([("L-SIL-RP2", 15.0)])
        self.assertEqual(outcome, "phase_deadline")
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)

    async def test_an_icebreaker_prompt_the_budget_cannot_cover_ends_the_phase(self) -> None:
        self.clock.advance(255)  # 15 s of icebreaker left, L-SIL-IB waits 20
        outcome = await self.interview._silence_ladder([("L-SIL-IB", 20.0)])
        self.assertEqual(outcome, "phase_deadline")

    async def test_roleplay_departure_waits_for_rejoin_instead_of_silence(self) -> None:
        self.enter_roleplay()
        turn = asyncio.create_task(self.interview._roleplay_turn())
        await self.settle()
        self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
        await self.until(lambda: self.interview.machine.phase is R1Phase.PAUSED_DISCONNECTED)
        self.ctx.room.emit("participant_connected", FakeParticipant("candidate"))
        await self.until(lambda: self.spoken_and_played("L-REJOIN"))
        self.final_transcript("sorry, my wifi dropped")
        self.assertIsNone(await asyncio.wait_for(turn, 10.0))
        self.assertNotIn(self.spoken_line("L-SIL-RP1"), self.session.spoken)
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)

    async def test_roleplay_departure_past_grace_ends_without_silence_prompt(self) -> None:
        self.enter_roleplay()
        with mock.patch.object(r1_session, "rejoin_grace_seconds", return_value=0.01):
            turn = asyncio.create_task(self.interview._roleplay_turn())
            await self.settle()
            self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
            self.assertEqual(await asyncio.wait_for(turn, 10.0), "candidate_left")
        self.assertNotIn(self.spoken_line("L-SIL-RP1"), self.session.spoken)

    @mock.patch.object(r1_session, "MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0)  # M032 S7C: at once
    async def test_roleplay_mute_speaks_aside_and_never_counts_down_silence(self) -> None:
        self.enter_roleplay()
        turn = asyncio.create_task(self.interview._roleplay_turn())
        await self.settle()
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        await self.until(lambda: self.spoken_and_played("L-MUTE-RP"))
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)
        self.ctx.room.emit("track_unmuted", FakeParticipant("candidate"), FakePublication())
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)  # left by the event
        self.final_transcript("back now")
        self.assertIsNone(await asyncio.wait_for(turn, 10.0))
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-MUTE-RP")), 1)
        self.assertNotIn(self.spoken_line("L-SIL-RP1"), self.session.spoken)


class TestPhaseDriver(R1TestCase):
    """Transition, wrap-up and reply-settling flows of the deterministic driver."""

    async def test_transition_ready_matching_and_pickup_are_driver_owned(self) -> None:
        self.assertFalse(self.interview.is_ready("I am already prepared"))
        self.assertTrue(self.interview.is_ready("yes"))
        self.assertTrue(self.interview.is_ready("go ahead"))
        await self.interview._speak_pickup_once()
        await self.interview._speak_pickup_once()
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-PICKUP")), 1)

    async def test_transition_nudges_a_bare_no_questions_then_picks_up_on_ready(self) -> None:
        # M1: "No questions." answers the question but agrees to nothing: the nudge asks for the
        # ready, and only the ready (or the button) starts the role-play.
        self.interview.machine.transition(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        self.assertTrue(await self.answer("No questions."))  # no model reply: the driver nudges
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-NUDGE"))
        await self.settle()
        self.assertFalse(task.done())  # a refusal is not a pickup
        self.final_transcript("ok, ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-TRANSITION-NUDGE")), 1)
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-PICKUP")), 1)
        order = [text for text in self.session.spoken]
        self.assertLess(
            order.index(self.spoken_line("L-TRANSITION-NUDGE")),
            order.index(self.spoken_line("L-PICKUP")),
        )

    async def test_transition_never_picks_up_on_a_timer(self) -> None:
        # M1 (mock call aa166f09: the learner picked up on the 20 s deadline while the candidate
        # was asking to ask questions).  Silence gets two gentle re-asks and then the silence
        # close, never the pickup.
        self.interview.machine.transition(R1Phase.TRANSITION)
        with mock.patch.object(
            r1_session,
            "TRANSITION_SILENCE_LADDER",
            ((0.05, "L-TRANSITION-REASK"), (0.05, "L-TRANSITION-REASK-2")),
        ), mock.patch.object(r1_session, "TRANSITION_SILENCE_END_SECONDS", 0.05):
            outcome = await asyncio.wait_for(self.interview._run_transition(), 10.0)
        self.assertEqual(outcome, "candidate_left")
        self.assertEqual(
            self.session.spoken,
            [
                self.spoken_line("L-TRANSITION-REASK"),
                self.spoken_line("L-TRANSITION-REASK-2"),
                self.spoken_line("L-SIL-END"),
            ],
        )
        self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)

    async def test_speaking_after_a_re_ask_starts_the_silence_steps_again(self) -> None:
        self.interview.machine.transition(R1Phase.TRANSITION)
        with mock.patch.object(
            r1_session,
            "TRANSITION_SILENCE_LADDER",
            ((0.05, "L-TRANSITION-REASK"), (5.0, "L-TRANSITION-REASK-2")),
        ):
            task = asyncio.create_task(self.interview._run_transition())
            await self.until(lambda: self.spoken_and_played("L-TRANSITION-REASK"))
            await self.settle()
            self.assertTrue(await self.answer("Hmm."))  # a sound, no question: nothing said
            await self.until(
                lambda: self.session.spoken.count(self.spoken_line("L-TRANSITION-REASK")) == 2
            )
            self.assertNotIn(self.spoken_line("L-TRANSITION-REASK-2"), self.session.spoken)
            self.final_transcript("Yes, let's start.")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_christy_answers_three_questions_then_steers_back_to_the_start(self) -> None:
        # M1: each question is the model's to answer (no StopResponse), with the start question
        # appended to the answer; the fourth gets the scripted steer and the fifth the nudge.
        # M032 S6 (SWEEP-32): once the either/or question has been heard (here, in the first
        # answer's tail), the later answers end with its shorter either/or forms in turn.
        self.interview.machine.transition(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        tails = [
            self.spoken_line(line_id)
            for line_id in ("L-TRANSITION-ASK", "L-TRANSITION-ASK-2", "L-TRANSITION-ASK-3")
        ]
        for question, tail in zip(
            (
                "What are the working days for this role?",
                "Is this a night shift?",
                "How many rounds are there after this one?",
            ),
            tails,
        ):
            self.assertFalse(await self.answer(question))
            self.assertEqual(self.interview._last_reply.tail, tail)
            self.assertEqual(self.interview._last_reply.phase, "transition")
        self.assertEqual(self.interview._transition_answers, 3)
        self.assertTrue(await self.answer("And what about the salary?"))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-STEER"))
        self.assertTrue(await self.answer("And the team size?"))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-NUDGE"))
        self.assertFalse(task.done())
        self.final_transcript("Ready.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-TRANSITION-STEER")), 1)
        self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_asking_to_ask_is_invited_without_using_a_question(self) -> None:
        # aa166f09 turns 17 and 19: "can I ask a couple of questions before we start?"
        self.interview.machine.transition(R1Phase.TRANSITION)
        self.assertFalse(
            await self.answer("So can I ask couple of questions before we start the role play?")
        )
        self.assertEqual(self.interview._last_reply.tail, "")  # "of course", not "shall we"
        self.assertEqual(self.interview._transition_answers, 0)
        self.assertFalse(await self.answer("I want to understand more about the role."))
        self.assertEqual(self.interview._transition_answers, 1)

    async def test_a_consent_is_never_answered_by_the_model(self) -> None:
        self.interview.machine.transition(R1Phase.TRANSITION)
        for text in ("Yes, let's start.", "No questions, let's go.", "Ready.", "Okay."):
            with self.subTest(text=text):
                self.assertTrue(self.interview.reply_suppressed(text))
        self.assertFalse(self.interview.reply_suppressed("What are the shift timings?"))

    async def test_an_answer_ends_with_the_start_question_in_the_same_speech(self) -> None:
        self.interview.machine.transition(R1Phase.TRANSITION)
        self.assertFalse(await self.answer("What are the working days?"))
        reply = self.interview._last_reply
        guard = StreamGuard(self.interview.engine.guard_context("transition", mode="reply"))

        def provider():
            return self_stream("Working days are five and a half days a week.")

        chunks = [chunk async for chunk in self.interview._screened(provider, guard, reply)]
        self.assertEqual(
            "".join(chunks).strip(),
            "Working days are five and a half days a week. "
            + self.spoken_line("L-TRANSITION-ASK"),
        )

    async def test_transition_stops_promptly_on_a_stop_signal(self) -> None:
        self.interview.machine.transition(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        self.assertFalse(task.done())
        self.interview._on_residency_deadline()
        self.assertEqual(await asyncio.wait_for(task, 10.0), "residency_timeout")
        self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)

    async def test_a_drain_during_the_transition_never_picks_up(self) -> None:
        run = await self.start_interview()
        await self.advance_to_transition(run)
        await self.drain_cancel(run)
        self.assertNotIn(self.spoken_line("L-PICKUP"), run.session.spoken)
        self.assertEqual(run.session.spoken[-1], self.spoken_line("L-SYSTEM-STOP"))
        self.assertEqual(self.writer.terminals, [("shutdown_forced", {"activated": True})])

    def enter_wrapup(self) -> None:
        self.enter_roleplay()
        self.interview._end_roleplay()
        self.interview.machine.transition(R1Phase.WRAPUP)

    async def test_wrapup_ends_on_no_questions_once_the_candidate_has_said_no_more(self) -> None:
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.05):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            self.final_transcript("No questions, thanks")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_a_refusal_is_not_believed_before_the_candidate_has_gone_quiet(self) -> None:
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 5.0):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            self.final_transcript("Nothing else.")
            await self.settle()
            self.assertFalse(task.done())  # it waits out the settle window first
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_question_in_a_later_final_of_the_same_turn_is_not_lost(self) -> None:
        # One user turn, two finals: "Nothing else." then the question itself.  Ending
        # wrap-up on the first would play L-CLOSE over a question being answered.
        self.enter_wrapup()
        settled = mock.AsyncMock()  # reached only once TWO questions have been counted
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 5.0):
            with mock.patch.object(self.interview, "_wait_reply_settled", settled):
                task = asyncio.create_task(self.interview._run_wrapup())
                await self.settle()
                self.final_transcript("Nothing else.")
                await self.settle()
                self.final_transcript("how long until I hear back?")
                await self.settle()
                self.assertFalse(task.done())  # ONE question, so wrap-up is still open
                settled.assert_not_awaited()
                self.final_transcript("and who is on the team?")
                self.assertIsNone(await asyncio.wait_for(task, 10.0))
        settled.assert_awaited_once()

    async def test_a_second_courtesy_final_still_ends_wrapup(self) -> None:
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.05):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            self.final_transcript("Nothing else.")
            self.final_transcript("thanks, bye")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.interview._turns.qsize(), 0)  # both finals were consumed

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_the_settle_window_does_not_run_while_the_candidate_is_talking(self) -> None:
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.05):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            self.user_state("speaking")  # the next sentence has started, its final is not in
            self.final_transcript("Nothing else.")
            await asyncio.sleep(0.2)  # four windows' worth of speech
            self.assertFalse(task.done())
            self.assertIsNone(self.interview._quiet_since)  # no countdown while they talk
            self.final_transcript("how long until I hear back?")
            self.user_state("listening")
            await self.settle()
            self.assertFalse(task.done())  # that was a question, so wrap-up stays open
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    def test_the_settle_window_depends_on_how_final_the_words_sound(self) -> None:
        plain = r1_session.WRAPUP_SETTLE_SECONDS
        for text in (
            "No questions.", "No, thanks.", "Nothing else.", "That's all, thank you.", "Nope",
            "I'm good.", "I'm okay.", "No, I don't have any questions.", "Hmm, no.",
        ):
            with self.subTest(explicit=text):
                self.assertTrue(is_no_questions(text))
                self.assertEqual(r1_session.wrapup_settle_seconds(text), plain)
        for text in (
            "Okay.", "Alright.", "Thank you.", "Thanks!", "Okay, got it.", "Great, thanks.",
            "Sounds good.", "Cool",
        ):
            with self.subTest(acknowledgement=text):
                self.assertTrue(is_no_questions(text))
                self.assertEqual(r1_session.wrapup_settle_seconds(text), plain * 2.0)
        for text in (
            "Okay, so", "Okay, so...", "Thank you, and", "Alright, um", "Okay. Well", "No questions, uh",
            # A courtesy word that cannot end a sentence: the candidate is about to say the rest.
            "Okay, I think", "Okay, I think...", "Okay, I", "Thank you for", "Thanks for your",
            "Alright, from my", "Okay, a",
        ):
            with self.subTest(lead_in=text):
                self.assertTrue(is_no_questions(text))
                self.assertEqual(r1_session.wrapup_settle_seconds(text), plain * 2.5)
        # ... while the same words, finished, keep the window of what they say.
        for text, factor in (
            ("Okay, I think I'm good.", 1.0),
            ("Okay, I think that's all.", 1.0),
            ("Thank you for your time.", 2.0),
            ("Thanks for your time, no questions.", 1.0),
        ):
            with self.subTest(finished=text):
                self.assertTrue(is_no_questions(text))
                self.assertEqual(r1_session.wrapup_settle_seconds(text), plain * factor)
        self.assertEqual((plain, plain * 2.0, plain * 2.5), (1.5, 3.0, 3.75))

    def spy_on_waits(self) -> list[float]:
        """Record the silence window of every ``_await_turn`` the driver opens (then run it)."""
        waits: list[float] = []
        real = self.interview._await_turn

        async def spy(timeout, **kwargs):
            waits.append(timeout)
            return await real(timeout, **kwargs)

        self.interview._await_turn = spy
        return waits

    async def test_the_driver_waits_the_window_for_the_words_that_were_said(self) -> None:
        # The windows themselves are checked by value (no wall-clock race): the first wait is the
        # 20 s silence window of the wrap-up, the second is the settle window of the refusal.
        plain = 0.02
        for text, factor in (
            ("Nothing else.", 1.0),
            ("Thank you.", 2.0),
            ("Okay.", 2.0),
            ("Okay, so", 2.5),
            ("Thank you, and", 2.5),
            ("Okay, I think", 2.5),
            ("Thank you for", 2.5),
        ):
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.enter_wrapup()
                with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", plain):
                    waits = self.spy_on_waits()
                    task = asyncio.create_task(self.interview._run_wrapup())
                    await self.settle()
                    self.final_transcript(text)
                    self.assertIsNone(await asyncio.wait_for(task, 10.0))  # and all of them close
                self.assertEqual(len(waits), 2, waits)
                self.assertEqual(waits[0], r1_session.WRAPUP_SILENCE_SECONDS)
                self.assertAlmostEqual(waits[1], plain * factor)

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_okay_so_and_a_pause_does_not_end_the_wrapup_over_the_question_that_follows(
        self,
    ) -> None:
        # The research list for item 8 had no "okay", and the plan added it: "Okay, so ... [two
        # seconds of thinking] what are the next steps?" must not get L-CLOSE, uninterruptibly,
        # spoken over the question.  The refusal is not believed for 2.5 settle windows, and a
        # final that arrives in that time is joined to it and judged with it.
        self.enter_wrapup()
        settled = mock.AsyncMock()  # reached only once TWO questions have been counted
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 4.0):  # lead-in: 10 s
            waits = self.spy_on_waits()
            with mock.patch.object(self.interview, "_wait_reply_settled", settled):
                task = asyncio.create_task(self.interview._run_wrapup())
                await self.settle()
                self.final_transcript("Okay, so")
                await self.settle()
                self.assertFalse(task.done())
                self.assertEqual(waits[-1], 10.0)  # not the plain 4.0
                self.final_transcript("what are the next steps")
                await self.settle()
                self.assertFalse(task.done())  # ONE question: the wrap-up is still open
                settled.assert_not_awaited()
                self.final_transcript("and who is on the team?")
                self.assertIsNone(await asyncio.wait_for(task, 10.0))
        settled.assert_awaited_once()

    async def test_okay_i_think_and_a_pause_does_not_end_the_wrapup_over_the_question_that_follows(
        self,
    ) -> None:
        # The same race as "Okay, so": "I think" is a courtesy word, so "Okay, I think" read as a
        # refusal and only got the 3 s window of a bare "Okay".  It stops on a lead-in now: 3.75 s,
        # and the sentence that follows is joined to it and judged as a question.
        self.enter_wrapup()
        settled = mock.AsyncMock()  # reached only once TWO questions have been counted
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 4.0):  # lead-in: 10 s
            waits = self.spy_on_waits()
            with mock.patch.object(self.interview, "_wait_reply_settled", settled):
                task = asyncio.create_task(self.interview._run_wrapup())
                await self.settle()
                self.final_transcript("Okay, I think")
                await self.settle()
                self.assertFalse(task.done())
                self.assertEqual(waits[-1], 10.0)  # not the 8.0 of an acknowledgement
                self.final_transcript("I have one about the next steps")
                await self.settle()
                self.assertFalse(task.done())  # ONE question: the wrap-up is still open
                settled.assert_not_awaited()
                self.final_transcript("and who is on the team?")
                self.assertIsNone(await asyncio.wait_for(task, 10.0))
        settled.assert_awaited_once()

    async def test_a_lone_okay_so_still_closes_once_nothing_follows(self) -> None:
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.02):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            self.final_transcript("Okay, so")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [])

    async def test_wrapup_ends_after_twenty_seconds_of_silence(self) -> None:
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SILENCE_SECONDS", 0.05):
            self.assertIsNone(await asyncio.wait_for(self.interview._run_wrapup(), 10.0))

    async def test_wrapup_ends_at_its_two_minute_budget(self) -> None:
        self.enter_wrapup()
        self.clock.advance(120)
        self.assertIsNone(await asyncio.wait_for(self.interview._run_wrapup(), 10.0))

    async def test_wrapup_waits_for_the_second_answer_before_ending(self) -> None:
        self.enter_wrapup()
        task = asyncio.create_task(self.interview._run_wrapup())
        await self.settle()
        self.final_transcript("What is the first month like?")
        await self.settle()
        self.assertFalse(task.done())
        self.final_transcript("And how is the team structured?")
        await self.settle()
        handle = FakeSpeechHandle("the reply")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
        )
        await self.settle()
        self.assertFalse(task.done())  # the reply to the second question is still playing
        handle.finish()
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_surplus_icebreaker_answers_are_not_read_as_transition_input(self) -> None:
        # Four candidate turns arrived while the driver was busy: the icebreaker consumed
        # one and ended, leaving three queued.  They answer the icebreaker, not READY.
        for answer in ("one", "two", "three", "four"):
            self.final_transcript(answer)
        self.assertEqual(await self.interview._await_turn(1.0), (TURN, "one"))
        self.interview.machine.transition(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        self.assertEqual(self.session.spoken, [])  # no immediate nudge from a stale turn
        self.assertFalse(task.done())
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])

    async def test_the_last_roleplay_words_are_not_the_first_wrapup_question(self) -> None:
        self.enter_wrapup()
        settled = mock.AsyncMock()  # reached only once TWO questions have been counted
        self.final_transcript("one last thing about the offer")  # queued during role-play
        with mock.patch.object(self.interview, "_wait_reply_settled", settled):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            self.final_transcript("What is the notice period?")
            await self.settle()
            self.assertFalse(task.done())  # ONE real question: wrap-up is still open
            settled.assert_not_awaited()
            self.final_transcript("And the team size?")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
        settled.assert_awaited_once()

    async def test_waiting_for_a_reply_that_never_comes_gives_up(self) -> None:
        with mock.patch.object(r1_session, "REPLY_APPEAR_SECONDS", 0.05):
            await asyncio.wait_for(self.interview._wait_reply_settled(30.0), 10.0)

    def mute_candidate(self) -> None:
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())

    @staticmethod
    def shrinking(seconds: float):
        """A phase budget that really runs out as wall time passes (the manual clock cannot)."""
        started = asyncio.get_running_loop().time()
        return lambda: max(0.0, seconds - (asyncio.get_running_loop().time() - started))

    @mock.patch.object(r1_session, "MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0)  # M032 S7C: at once
    async def test_a_muted_candidate_cannot_stall_the_icebreaker_past_its_deadline(self) -> None:
        self.mute_candidate()
        budget = self.shrinking(0.15)
        with mock.patch.object(
            self.interview.machine, "remaining_icebreaker_seconds", budget
        ), mock.patch.object(
            self.interview.machine, "icebreaker_should_end", lambda: budget() <= 0
        ):
            self.assertIsNone(await asyncio.wait_for(self.interview._run_icebreaker(), 10.0))
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-MUTE-IV")), 1)

    @mock.patch.object(r1_session, "MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0)  # M032 S7C: at once
    async def test_a_muted_candidate_cannot_stall_the_transition(self) -> None:
        # Muted, the silence steps never run; the transition's ceiling ends the wait, and the
        # role-play is still never started without the candidate's consent (M1).
        self.interview.machine.transition(R1Phase.TRANSITION)
        self.mute_candidate()
        with mock.patch.object(r1_session, "TRANSITION_MAX_SECONDS", 0.1):
            outcome = await asyncio.wait_for(self.interview._run_transition(), 10.0)
        self.assertEqual(outcome, "candidate_left")
        self.assertIn(self.spoken_line("L-MUTE-IV"), self.session.spoken)
        self.assertEqual(self.session.spoken[-1], self.spoken_line("L-SIL-END"))
        self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)

    async def test_a_muted_candidate_cannot_stall_the_role_play_cap(self) -> None:
        self.enter_roleplay()
        self.mute_candidate()
        budget = self.shrinking(0.15)
        with mock.patch.object(
            self.interview.machine, "remaining_roleplay_seconds", budget
        ), mock.patch.object(
            self.interview.machine, "roleplay_should_end", lambda: budget() <= 0
        ):
            self.assertIsNone(await asyncio.wait_for(self.interview._run_roleplay(), 10.0))
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)  # still muted: R is paused
        self.interview._end_roleplay()  # and ending role-play from that aside never raises
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY_EXIT)

    async def test_a_muted_candidate_cannot_stall_the_wrapup(self) -> None:
        self.enter_wrapup()
        self.mute_candidate()
        budget = self.shrinking(0.15)
        with mock.patch.object(self.interview.machine, "remaining_wrapup_seconds", budget):
            self.assertIsNone(await asyncio.wait_for(self.interview._run_wrapup(), 10.0))

    async def test_a_roleplay_wait_ends_when_its_budget_runs_out(self) -> None:
        self.enter_roleplay()
        # The wait is bounded by the phase budget, which is re-read as time passes.
        remaining = [0.1]
        with mock.patch.object(
            self.interview.machine, "remaining_roleplay_seconds", lambda: remaining[0]
        ):
            task = asyncio.create_task(self.interview._roleplay_turn())
            await self.settle()
            self.assertFalse(task.done())
            remaining[0] = 0.0
            self.interview._wake()
            self.assertEqual(await asyncio.wait_for(task, 10.0), "phase_deadline")


class TestTranscript(R1TestCase):
    """Every delivered turn is persisted exactly once, ordered, in a legal phase."""

    async def test_a_scripted_line_is_persisted_exactly_once(self) -> None:
        # say() adds the assistant item and fires conversation_item_added, like the SDK.
        await self.interview.say("L-SIL-IB")
        await self.flush()
        rows = self.bot_rows()
        self.assertEqual([row["text"] for row in rows], [self.spoken_line("L-SIL-IB")])

    async def test_bot_and_candidate_turns_share_monotonic_indices_in_event_order(self) -> None:
        await self.interview.say("L-SIL-IB")
        self.final_transcript("I am here")
        await self.interview.say("L-TRANSITION-NUDGE")
        await self.flush()
        self.assertEqual([row["index"] for row in self.writer.saved], [1, 2, 3])
        self.assertEqual(
            [row["speaker"] for row in self.writer.saved], ["bot", "candidate", "bot"]
        )

    async def test_a_candidate_turn_is_recorded_when_it_commits_even_if_nobody_waits(self) -> None:
        self.final_transcript("spoken while the driver was busy")
        await self.flush()
        self.assertEqual(self.writer.saved, [])  # still the open row: the turn has not committed
        await self.commit_turn("spoken while the driver was busy")
        await self.flush()
        self.assertEqual(self.writer.saved[0]["text"], "spoken while the driver was busy")
        self.assertEqual(self.writer.saved[0]["phase"], "icebreaker")

    async def test_a_candidate_turn_is_recorded_when_the_session_exits_uncommitted(self) -> None:
        self.final_transcript("said just before the connection dropped")
        self.interview._begin_exit()
        await self.flush()
        self.assertEqual(
            [(row["index"], row["speaker"], row["text"]) for row in self.writer.saved],
            [(1, "candidate", "said just before the connection dropped")],
        )

    async def test_interim_and_empty_transcripts_are_not_recorded(self) -> None:
        self.session.emit(
            "user_input_transcribed", SimpleNamespace(is_final=False, transcript="hi")
        )
        self.final_transcript("   ")
        await self.flush()
        self.assertEqual(self.writer.saved, [])

    async def test_the_interrupted_flag_comes_from_the_item(self) -> None:
        self.session.next_interrupted = True
        await self.interview.say("L-SIL-IB")
        await self.flush()
        self.assertTrue(self.bot_rows()[0]["interrupted"])

    async def test_an_item_without_a_known_speech_is_still_persisted_once(self) -> None:
        message = FakeChatMessage("orphan")
        self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        await self.flush()
        self.assertEqual([row["text"] for row in self.bot_rows()], ["orphan"])

    async def test_user_items_are_ignored(self) -> None:
        user_item = SimpleNamespace(id="u1", role="user", text_content="candidate")
        self.session.emit("conversation_item_added", SimpleNamespace(item=user_item))
        await self.flush()
        self.assertEqual(self.writer.saved, [])

    async def test_a_failing_write_never_ends_the_interview(self) -> None:
        self.writer.save_error = RuntimeError("database unavailable")
        with self.capture_logs() as logs:
            await self.answer("hello")
            await self.flush()
        self.assertIsNone(self.interview._stop_outcome())
        failed = [
            entry for entry in logs if entry.get("error_type") == "r1_transcript_write_failed"
        ]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["error_category"], "RuntimeError")
        # Fence 10: the exception message and the utterance never reach a log line.
        self.assertNotIn("database unavailable", json.dumps(logs))
        self.assertNotIn("hello", json.dumps(logs))

    async def test_a_hung_write_is_bounded_and_does_not_stall_the_driver(self) -> None:
        self.writer.save_hangs = True
        with mock.patch.object(r1_session, "TURN_WRITE_SECONDS", 0.05):
            self.final_transcript("hello")
            # The driver gets the turn immediately; the write is not on its path.
            self.assertEqual(
                await asyncio.wait_for(self.interview._await_turn(5.0), 10.0), (TURN, "hello")
            )
            await self.commit_turn("hello")  # the row's write starts here, and hangs
            self.assertEqual(len(self.interview._turn_writes), 1)
            await asyncio.wait_for(self.interview._drain_background(), 10.0)
        self.assertEqual(self.writer.saved, [])

    async def test_nothing_is_recorded_once_the_exit_has_begun(self) -> None:
        self.interview._begin_exit()
        self.final_transcript("too late")
        await self.interview.say("L-SIL-IB")
        await self.flush()
        self.assertEqual(self.writer.saved, [])

    async def test_rows_are_saved_before_the_terminal_write_fires_the_scorer(self) -> None:
        # Completing the session enqueues scoring, which reads the transcript: every
        # queued row must be durable BEFORE the terminal write, not after it.
        gate = asyncio.Event()
        self.writer.save_gate = gate
        context = FakeContext(self.order)
        context.room.remote_participants["candidate"] = FakeParticipant("candidate")
        session = FakeSession(log=self.order)
        interview = R1Interview(
            context,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            session,
            self.writer,
            clock=Clock(),
        )
        task = asyncio.create_task(interview.run())
        await self.pass_sound_check(session, interview)
        await self.until(lambda: interview.machine.phase is R1Phase.ICEBREAKER)
        session.emit("user_input_transcribed", final_event("an answer given just before the end"))
        await self.until(lambda: len(interview._turn_writes) > 0)
        task.cancel()
        await self.settle()
        self.assertNotIn("terminal", self.order)  # the exit waits for the pending writes
        gate.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        names = [item if isinstance(item, str) else item[0] for item in self.order]
        self.assertIn("save", names)
        last_save = max(i for i, name in enumerate(names) if name == "save")
        self.assertLess(last_save, names.index("terminal"))
        # The answer was still an open row when the exit began: the exit wrote it, in time.
        self.assertIn(
            "an answer given just before the end",
            [row["text"] for row in self.writer.saved if row["speaker"] == "candidate"],
        )


class TranscriptOrdering:
    """Row order must hold whichever order the SDK reports an item and its handle in.

    livekit-agents 1.6.4 reports an LLM reply FIRST through ``conversation_item_added``
    and only then lists it on ``speech_handle.chat_items`` (``_pipeline_reply_task_impl``);
    ``say()`` does it the other way round (``_tts_task_impl``).  Each concrete subclass
    runs every case under one order.
    """

    sdk_order = "reply"

    def start_reply(self, text: str = "a reply") -> FakeSpeechHandle:
        """An LLM reply is created, as the SDK reports it (it is not speaking yet)."""
        handle = FakeSpeechHandle(text)
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
        )
        return handle

    def begins_speaking(self, handle: FakeSpeechHandle) -> None:
        self.session.current_speech = handle
        self.agent_state("speaking")

    def deliver(self, handle: FakeSpeechHandle, text: str, *, interrupted: bool = False) -> None:
        """Report the finished item in this class's SDK order, then finish the speech."""
        message = FakeChatMessage(text, interrupted=interrupted)
        if self.sdk_order == "say":
            handle.chat_items.append(message)
            self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        else:
            self.session.emit("conversation_item_added", SimpleNamespace(item=message))
            handle.chat_items.append(message)
        handle.finish()
        self.session.current_speech = None

    def rows(self) -> list[dict]:
        return sorted(self.writer.saved, key=lambda row: row["index"])

    async def test_a_preemptive_reply_created_before_the_final_transcript_follows_it(self) -> None:
        # Preemptive generation creates the reply speech on the interim transcript, before
        # the final transcript event; the reply is SPOKEN after it, so its row must be too.
        handle = self.start_reply()
        self.final_transcript("tell me about the course")
        self.begins_speaking(handle)
        self.deliver(handle, "Sure, here is the outline.")
        await self.flush()
        self.assertEqual([row["speaker"] for row in self.rows()], ["candidate", "bot"])
        self.assertEqual([row["index"] for row in self.rows()], [1, 2])

    async def test_a_scripted_line_queued_behind_a_reply_is_ordered_after_it(self) -> None:
        reply = self.start_reply()
        queued = FakeSpeechHandle("queued line")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=queued, source="say", user_initiated=True),
        )
        self.begins_speaking(reply)
        self.deliver(reply, "the reply")
        self.begins_speaking(queued)
        self.deliver(queued, "queued line")
        await self.flush()
        self.assertEqual([row["text"] for row in self.rows()], ["the reply", "queued line"])
        self.assertEqual([row["index"] for row in self.rows()], [1, 2])

    async def test_a_barge_in_reply_keeps_its_place_before_the_interrupting_candidate(self) -> None:
        # The reply starts speaking (position fixed), the candidate talks over it, and the
        # interrupted assistant item is only added afterwards.  No index may be wasted:
        # [(2, candidate), (3, bot)] would mean the slot claimed at speaking time was lost.
        handle = self.start_reply("partial reply")
        self.begins_speaking(handle)
        self.final_transcript("excuse me")
        self.deliver(handle, "partial", interrupted=True)
        await self.commit_turn("excuse me")  # the SDK commits the interrupting turn
        await self.flush()
        rows = self.rows()
        self.assertEqual([row["speaker"] for row in rows], ["bot", "candidate"])
        self.assertEqual([row["index"] for row in rows], [1, 2])
        self.assertTrue(rows[0]["interrupted"])

    async def test_the_oldest_started_speech_owns_an_item_when_no_speech_is_current(self) -> None:
        # Nothing is current and the handle does not list the item yet: the speech that
        # started speaking first (and has not reported) is the producer.
        first = self.start_reply("first")
        second = self.start_reply("second")
        self.begins_speaking(first)
        self.session.current_speech = None
        self.final_transcript("excuse me")
        message = FakeChatMessage("first, interrupted", interrupted=True)
        self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        await self.commit_turn("excuse me")
        await self.flush()
        self.assertEqual([row["speaker"] for row in self.rows()], ["bot", "candidate"])
        self.assertEqual([row["index"] for row in self.rows()], [1, 2])
        second.finish()
        first.finish()

    async def test_with_two_started_speeches_the_oldest_owns_the_first_item_once(self) -> None:
        # Both speeches have started and neither is current nor lists its item: the items
        # are matched oldest first, and a speech that has reported is never matched again.
        first = self.start_reply("first")
        second = self.start_reply("second")
        self.begins_speaking(first)
        self.begins_speaking(second)
        self.session.current_speech = None
        for text in ("first, interrupted", "second, interrupted"):
            message = FakeChatMessage(text, interrupted=True)
            self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        await self.flush()
        self.assertEqual(
            [(row["index"], row["text"]) for row in self.rows()],
            [(1, "first, interrupted"), (2, "second, interrupted")],
        )
        second.finish()
        first.finish()

    async def test_rows_use_the_phase_the_speech_started_in_and_stay_inside_the_check(self) -> None:
        self.enter_roleplay()
        handle = self.start_reply()
        self.begins_speaking(handle)  # the position and phase are fixed here
        # The candidate leaves, and a later reply would otherwise be labelled by the pause.
        self.interview.machine.begin_disconnect()
        self.deliver(handle, "a late reply")
        await self.flush()
        self.assertEqual(self.bot_rows()[0]["phase"], "roleplay")
        self.final_transcript("back")  # a paused phase reports the phase it will resume
        await self.flush()
        for row in self.writer.saved:
            self.assertIn(row["phase"], TRANSCRIPT_PHASES)

    async def test_a_reply_finishing_after_the_closing_line_never_breaks_the_phase_check(
        self,
    ) -> None:
        self.enter_roleplay()
        handle = self.start_reply()
        self.interview.machine.transition(R1Phase.CLOSING)
        self.deliver(handle, "an answer that finished after goodbye")  # never started speaking
        await self.flush()
        self.assertEqual(self.bot_rows()[0]["phase"], "closing")
        self.assertIn(self.bot_rows()[0]["phase"], TRANSCRIPT_PHASES)


class TestTranscriptOrderForReplies(TranscriptOrdering, R1TestCase):
    """The real 1.6.4 order for an LLM reply: the event first, the handle list second."""

    sdk_order = "reply"


class TestTranscriptOrderForScriptedLines(TranscriptOrdering, R1TestCase):
    """The real 1.6.4 order for ``say()``: the handle list first, the event second."""

    sdk_order = "say"


class TestExitInvariant(R1TestCase):
    """Exit tests cover cancellation and speech failure, the two former persistence holes."""

    async def test_exit_order_is_recording_ledger_terminal_outcome_then_room(self) -> None:
        await self.interview._exit("provider_error")
        await self.interview._exit("provider_error")
        self.assertEqual(
            [item for item in self.order if isinstance(item, str)],
            ["recording", "ledger", "terminal", "outcome"],
        )
        self.assertEqual(self.writer.terminals, [("provider_error", {"activated": False})])
        self.assertEqual(self.ctx.deleted_rooms, [None])
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])
        # A provider error is a stop on our side: the page is told so before it is told to leave.
        self.assertEqual(
            self.ctx.room.local_participant.attributes,
            [{"phase": "aborted"}, {"phase": "ended"}],
        )
        self.assertEqual(self.session.closed, 1)

    async def test_the_room_is_deleted_and_the_job_ended_after_the_terminal_write(self) -> None:
        await self.interview._exit("complete")
        names = [item if isinstance(item, str) else item[0] for item in self.order]
        self.assertLess(names.index("outcome"), names.index("delete_room"))
        self.assertLess(names.index("delete_room"), names.index("shutdown"))

    async def test_the_fake_context_matches_the_real_sdk_surface(self) -> None:
        # JobContext 1.6.4 has delete_room and shutdown, and no close_room.
        self.assertFalse(hasattr(self.ctx, "close_room"))
        self.assertTrue(callable(self.ctx.delete_room))
        self.assertTrue(callable(self.ctx.shutdown))

    async def test_a_failed_room_delete_still_shuts_the_job_down(self) -> None:
        self.ctx.delete_error = RuntimeError("livekit api unreachable")
        with self.capture_logs() as logs:
            await self.interview._exit("provider_error")
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])
        self.assertIn("r1_room_delete_failed", error_types(logs))
        self.assertNotIn("unreachable", json.dumps(logs))  # the message never reaches a log

    async def test_the_terminal_write_receives_the_activation_state(self) -> None:
        self.interview._activated = True
        await self.interview._exit("candidate_left")
        self.assertEqual(self.writer.terminals, [("candidate_left", {"activated": True})])

    async def test_phase_ended_is_skipped_when_the_room_is_not_connected(self) -> None:
        self.ctx.room.connected = False
        await self.interview._exit("provider_error")
        self.assertEqual(self.ctx.room.local_participant.attributes, [])
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])

    async def test_phase_ended_before_connect_is_swallowed_not_raised(self) -> None:
        # Before connect, ctx.room.local_participant raises a plain Exception (rtc/room.py:223).
        class UnconnectedRoom:
            name = ROOM_NAME

            def isconnected(self) -> bool:
                return True  # even a room that wrongly claims to be connected

            @property
            def local_participant(self):
                raise RuntimeError("cannot access local participant before connecting")

        self.ctx.room = UnconnectedRoom()
        with self.capture_logs() as logs:
            await self.interview._announce_ended()
        self.assertEqual(error_types(logs), ["r1_phase_ended_failed"])
        await self.interview._exit("provider_error")
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])

    async def test_phase_ended_is_published_once_even_when_requested_twice(self) -> None:
        await self.interview._announce_ended()
        await self.interview._announce_ended()
        await self.interview._exit("provider_error")
        self.assertEqual(self.ctx.room.local_participant.attributes, [{"phase": "ended"}])

    async def test_phase_ended_is_published_when_the_closing_line_has_played(self) -> None:
        # Plan 5.12: L-CLOSE sets phase=ended so the page leaves, BEFORE the exit writes.
        await self.interview._finish("complete")
        self.assertEqual(self.writer.terminals, [])
        self.assertEqual(self.session.spoken[-1], self.spoken_line("L-CLOSE"))
        ended = self.order.index(("attributes", {"phase": "ended"}))
        self.assertLess(self.order.index(("play_end", self.spoken_line("L-CLOSE"))), ended)

    async def test_a_goodbye_already_spoken_is_not_repeated(self) -> None:
        self.interview._goodbye_spoken = True
        await self.interview._finish("candidate_left")
        self.assertEqual(self.session.spoken, [])

    async def test_a_departed_candidate_is_not_spoken_to(self) -> None:
        self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
        await self.interview._finish("candidate_left")
        self.assertEqual(self.session.spoken, [])
        self.assertIs(self.interview.machine.phase, R1Phase.FINISHING)

    async def test_cancellation_mid_interview_runs_exit_once_as_a_forced_shutdown(self) -> None:
        # Skip the bounded icebreaker clock so the real driver reaches the transition.
        context = FakeContext(self.order)
        context.room.remote_participants["candidate"] = FakeParticipant("candidate")
        run_clock = Clock()
        session = FakeSession(log=self.order)
        interview = R1Interview(
            context,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            session,
            self.writer,
            clock=run_clock,
            recorder_finish=lambda: append(self.order, "recording"),
        )
        task = asyncio.create_task(interview.run())
        await self.pass_sound_check(session, interview)
        await self.until(lambda: interview.machine.phase is R1Phase.ICEBREAKER)
        run_clock.advance(271)
        interview._wake()
        await self.until(lambda: interview.machine.phase is R1Phase.TRANSITION)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.writer.terminals, [("shutdown_forced", {"activated": True})])
        self.assertEqual(self.writer.outcomes, ["shutdown_forced"])
        self.assertEqual(context.deleted_rooms, [None])
        self.assertEqual(context.shutdowns, ["r1_exit"])

    async def test_cancellation_after_the_room_closed_is_candidate_left_not_a_drain(self) -> None:
        context = FakeContext(self.order)
        context.room.remote_participants["candidate"] = FakeParticipant("candidate")
        # The driver is inside a long playout, so it does not see the room go away; the
        # SDK then cancels the entrypoint 15 s after the room disconnect (1.6.4).
        interview = R1Interview(
            context,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            FakeSession(log=self.order, playout_seconds=30.0),
            self.writer,
            clock=Clock(),
        )
        task = asyncio.create_task(interview.run())
        first = self.spoken_line(self.opening_line_ids()[0])
        await self.until(lambda: ("play_start", first) in self.order)
        context.room.emit("participant_disconnected", FakeParticipant("candidate"))
        context.room.emit("disconnected", "room closed")
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.writer.terminals, [("candidate_left", {"activated": True})])
        self.assertEqual(self.writer.outcomes, ["candidate_left"])

    async def test_cancellation_before_join_stays_a_cancellation(self) -> None:
        context = FakeContext(self.order)
        interview = R1Interview(
            context,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            FakeSession(log=self.order),
            self.writer,
            recorder_finish=lambda: append(self.order, "recording"),
        )
        task = asyncio.create_task(interview.run())
        await self.settle()
        self.assertIs(interview.machine.phase, R1Phase.PRE_JOIN)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertIs(interview.machine.phase, R1Phase.FINISHING)
        self.assertEqual(
            [item for item in self.order if isinstance(item, str)],
            ["recording", "ledger", "terminal", "outcome"],
        )
        # Never activated, so the terminal CAS must leave `waiting`.
        self.assertEqual(self.writer.terminals, [("shutdown_forced", {"activated": False})])
        self.assertEqual(context.shutdowns, ["r1_exit"])

    async def test_no_candidate_within_the_window_is_a_no_show_from_waiting(self) -> None:
        context = FakeContext(self.order)
        interview = R1Interview(
            context,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            FakeSession(log=self.order),
            self.writer,
            recorder_finish=lambda: append(self.order, "recording"),
        )
        with mock.patch.object(r1_session, "NO_SHOW_SECONDS", 0.03):
            self.assertEqual(await asyncio.wait_for(interview.run(), 10.0), "no_show")
        self.assertEqual(self.writer.terminals, [("no_show", {"activated": False})])
        self.assertEqual(self.writer.activations, 0)

    async def test_the_room_closing_before_any_candidate_joined_is_a_no_show(self) -> None:
        context = FakeContext(self.order)
        interview = R1Interview(
            context,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            FakeSession(log=self.order),
            self.writer,
        )
        task = asyncio.create_task(interview.run())
        await self.settle()
        context.room.emit("disconnected", "room closed")
        self.assertEqual(await asyncio.wait_for(task, 10.0), "no_show")
        self.assertEqual(interview._cancel_outcome(), "no_show")
        self.assertEqual(self.writer.terminals, [("no_show", {"activated": False})])
        self.assertEqual(self.writer.activations, 0)

    async def test_closing_speech_failure_still_runs_full_exit_order(self) -> None:
        self.session.raise_on_say = True
        await self.interview._finish("provider_error", system=True)
        await self.interview._exit("provider_error")
        self.assertEqual(
            [item for item in self.order if isinstance(item, str)],
            ["recording", "ledger", "terminal", "outcome"],
        )
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])

    async def test_a_playout_that_never_finishes_is_bounded(self) -> None:
        self.session.playout_seconds = 30.0
        with mock.patch.object(r1_session, "CLOSING_PLAYOUT_SECONDS", 0.05):
            await asyncio.wait_for(
                self.interview._finish("provider_error", system=True), 10.0
            )
        self.assertIs(self.interview.machine.phase, R1Phase.FINISHING)
        self.assertEqual(self.session.handles[-1].interrupt_calls, 1)
        await self.flush()


class TestTeardownBudget(R1TestCase):
    """The whole cancel path fits in shutdown_process_timeout minus the SDK's 15 s grace."""

    @staticmethod
    def worst_case_seconds() -> float:
        """Every bound of the cancel path at its limit, after scaling for the environment."""
        return r1_session.teardown_scale() * (
            r1_session.CLOSING_PLAYOUT_SECONDS  # the L-SYSTEM-STOP line
            + r1_session.ENDED_ATTRIBUTE_SECONDS  # phase=ended (at most once: _finish or close)
            + r1_session.TRANSCRIPT_DRAIN_SECONDS  # pending transcript rows
            + r1_session.EXIT_STEPS_SECONDS  # recording, ledger, terminal, attempt outcome
            + r1_session.SESSION_CLOSE_SECONDS
            + r1_session.ROOM_DELETE_SECONDS
        )

    def test_the_nominal_bounds_sum_to_exactly_shutdown_minus_the_sdk_grace(self) -> None:
        with mock.patch.dict(os.environ, {"R1_SHUTDOWN_PROCESS_TIMEOUT_SEC": "90"}):
            self.assertEqual(r1_session.shutdown_process_seconds(), 90.0)
            self.assertEqual(r1_session.teardown_scale(), 1.0)
            self.assertEqual(self.worst_case_seconds(), r1_session.NOMINAL_TEARDOWN_SECONDS)
            self.assertEqual(
                self.worst_case_seconds(),
                r1_session.shutdown_process_seconds() - r1_session.SDK_ENTRYPOINT_GRACE_SECONDS,
            )

    def test_the_recording_finish_is_carved_out_of_the_shared_exit_budget(self) -> None:
        """R1-REC: the recorder's 18 s is a share of the 30 s, never added to the 75 s."""
        self.assertEqual(r1_session.RECORDING_FINISH_SECONDS, 18.0)
        # The ledger, the terminal write and the outcome keep at least 12 s of the shared 30 s ...
        self.assertLessEqual(
            r1_session.RECORDING_FINISH_SECONDS, r1_session.EXIT_STEPS_SECONDS - 12.0
        )
        # ... and no bound of the cancel path grew to make room for the recording.
        self.assertEqual(r1_session.EXIT_STEPS_SECONDS, 30.0)
        self.assertEqual(self.worst_case_seconds(), r1_session.NOMINAL_TEARDOWN_SECONDS)
        # Scaled down with every other bound when the shutdown timeout is smaller.
        for seconds in ("30", "60", "90"):
            with self.subTest(shutdown=seconds):
                with mock.patch.dict(os.environ, {"R1_SHUTDOWN_PROCESS_TIMEOUT_SEC": seconds}):
                    self.assertLessEqual(
                        r1_session._scaled(r1_session.RECORDING_FINISH_SECONDS),
                        r1_session._scaled(r1_session.EXIT_STEPS_SECONDS)
                        - 12.0 * r1_session.teardown_scale()
                        + 1e-9,
                    )

    def test_the_exit_backstop_covers_every_bound_it_wraps(self) -> None:
        # The backstop only exists for a bug in one of those bounds.  Below their sum it
        # would fire BEFORE the room close and leave the agent in the room.
        wrapped = (
            r1_session.ENDED_ATTRIBUTE_SECONDS
            + r1_session.EXIT_STEPS_SECONDS
            + r1_session.SESSION_CLOSE_SECONDS
            + r1_session.ROOM_DELETE_SECONDS
        )
        self.assertGreaterEqual(r1_session._EXIT_BACKSTOP_SECONDS, wrapped)
        # ...and, scaled by the same factor for any shutdown timeout, it still does.
        for seconds in ("30", "60", "90"):
            with self.subTest(shutdown=seconds):
                with mock.patch.dict(os.environ, {"R1_SHUTDOWN_PROCESS_TIMEOUT_SEC": seconds}):
                    self.assertGreaterEqual(
                        r1_session._scaled(r1_session._EXIT_BACKSTOP_SECONDS),
                        r1_session.teardown_scale() * wrapped,
                    )

    def interview_that_ends_at_once(self) -> tuple[FakeContext, R1Interview]:
        """A fresh interview whose room is already lost, so ``run`` reaches its exit funnel."""
        ctx = FakeContext(self.order)
        ctx.room.remote_participants["candidate"] = FakeParticipant("candidate")
        interview = R1Interview(
            ctx,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            FakeSession(log=self.order),
            FakeWriter(self.order),
            clock=Clock(),
        )
        interview._room_disconnected = True
        return ctx, interview

    async def test_run_wraps_the_whole_exit_in_exactly_the_derived_backstop(self) -> None:
        # The constants test above proves the value; this proves ``run`` USES it, so a
        # smaller number written into ``run`` (which would cut the exit before the room
        # close) cannot hide behind a correct constant.
        ctx, interview = self.interview_that_ends_at_once()
        timeouts: list[float] = []
        real_wait_for = asyncio.wait_for

        async def spy(awaitable, timeout=None):
            timeouts.append(timeout)
            return await real_wait_for(awaitable, timeout)

        with mock.patch.object(asyncio, "wait_for", spy):
            outcome = await real_wait_for(interview.run(), 10.0)
        self.assertEqual(outcome, "shutdown_forced")
        self.assertIn(r1_session._scaled(r1_session._EXIT_BACKSTOP_SECONDS), timeouts)
        # With every bound met the backstop never fires: the room is closed and the job ended.
        self.assertEqual(ctx.deleted_rooms, [None])
        self.assertEqual(ctx.shutdowns, ["r1_exit"])

    async def test_a_firing_backstop_is_logged_and_never_stops_run_from_returning(self) -> None:
        _ctx, interview = self.interview_that_ends_at_once()
        release = asyncio.Event()

        async def hung_exit(_outcome: str) -> None:
            await release.wait()

        interview._exit = hung_exit
        try:
            with self.capture_logs() as logs:
                with mock.patch.object(r1_session, "_EXIT_BACKSTOP_SECONDS", 0.05):
                    outcome = await asyncio.wait_for(interview.run(), 10.0)
        finally:
            release.set()  # let the shielded exit end, so no task outlives the test
            await self.settle()
        self.assertEqual(outcome, "shutdown_forced")
        self.assertIn("r1_exit_funnel_failed", error_types(logs))

    def test_every_configured_shutdown_timeout_leaves_the_sdk_grace(self) -> None:
        for seconds in ("30", "45", "60", "75", "90", "9999", "bad"):
            with self.subTest(shutdown=seconds):
                with mock.patch.dict(os.environ, {"R1_SHUTDOWN_PROCESS_TIMEOUT_SEC": seconds}):
                    budget = (
                        r1_session.shutdown_process_seconds()
                        - r1_session.SDK_ENTRYPOINT_GRACE_SECONDS
                    )
                    self.assertLessEqual(self.worst_case_seconds(), budget + 1e-9)
                    self.assertGreater(r1_session.teardown_scale(), 0.0)

    def test_the_agent_and_the_session_read_the_same_shutdown_bounds(self) -> None:
        source = (HERE / "agent.py").read_text(encoding="utf-8")
        self.assertIn(
            '_bounded_float_env("R1_SHUTDOWN_PROCESS_TIMEOUT_SEC", 90.0, 30.0, 90.0)', source
        )
        self.assertEqual(
            r1_session.bounded_seconds("R1_SHUTDOWN_PROCESS_TIMEOUT_SEC", 90.0, 30.0, 90.0),
            r1_session.shutdown_process_seconds(),
        )

    async def test_a_hung_terminal_write_never_leaves_the_agent_in_the_room(self) -> None:
        # Round-4 finding: with the terminal write hung the budget ran out and the room
        # close was skipped, so the job (and the single worker slot) outlived the interview.
        self.writer.terminal_hangs = True
        with mock.patch.object(r1_session, "EXIT_STEPS_SECONDS", 0.05):
            await asyncio.wait_for(self.interview._exit("provider_error"), 10.0)
        names = [item if isinstance(item, str) else item[0] for item in self.order]
        self.assertNotIn("terminal", names)  # it never completed
        self.assertEqual(self.ctx.deleted_rooms, [None])
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])
        self.assertEqual(self.session.closed, 1)

    async def test_a_wholly_spent_budget_skips_every_step_but_never_the_room_close(self) -> None:
        # A zero budget is spent before the first step: deterministic, no clock resolution.
        with self.capture_logs() as logs:
            with mock.patch.object(r1_session, "EXIT_STEPS_SECONDS", 0.0):
                await asyncio.wait_for(self.interview._exit("provider_error"), 10.0)
        spent = [entry for entry in logs if entry.get("error_type") == "r1_exit_budget_spent"]
        self.assertEqual(
            [entry["phase"] for entry in spent],
            ["recording", "ledger", "terminal", "attempt_outcome"],
        )
        names = [item if isinstance(item, str) else item[0] for item in self.order]
        self.assertNotIn("terminal", names)
        self.assertEqual(self.ctx.deleted_rooms, [None])
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])

    async def test_a_smaller_shutdown_timeout_shrinks_the_room_close_bounds_too(self) -> None:
        self.ctx.delete_hangs = True
        with mock.patch.dict(os.environ, {"R1_SHUTDOWN_PROCESS_TIMEOUT_SEC": "30"}):
            with mock.patch.object(r1_session, "ROOM_DELETE_SECONDS", 1.0):
                # 1 s x (30 - 15) / 75 = 0.2 s
                self.assertAlmostEqual(r1_session._scaled(r1_session.ROOM_DELETE_SECONDS), 0.2)
                await asyncio.wait_for(self.interview._exit("provider_error"), 10.0)
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])


class TestRunFlow(R1TestCase):
    """The whole phase machine, PRE_JOIN to complete, through an injected session factory."""

    LINE_CONTEXT = {
        "first_name": "Asha",
        "candidate_identity": "candidate",
        "round_id": "round",
        "attempt_id": "attempt",
        "attempt": {},
        "settings": {},
    }

    async def asyncSetUp(self) -> None:
        self.clock = Clock()
        self.order: list = []
        self.ctx = FakeContext(self.order)
        self.ctx.room.remote_participants["candidate"] = FakeParticipant("candidate")
        self.session = FakeSession(log=self.order)
        self.writer = FakeWriter(self.order)
        self.factory_calls = 0

        async def session_factory(_ctx, _context):
            self.factory_calls += 1
            return self.session

        async def fetch(_room):
            return dict(self.LINE_CONTEXT)

        self.session_factory = session_factory
        patches = [
            mock.patch.object(r1_session, "fetch_context", fetch),
            mock.patch.object(r1_session, "R1TurnWriter", lambda *_a, **_k: self.writer),
            # run_r1_session builds its own interview: give its machine the manual clock.
            mock.patch.object(
                r1_session, "R1PhaseMachine", lambda _clock: R1PhaseMachine(self.clock)
            ),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    @mock.patch.dict(os.environ, {"R1_EXIT_WRAP_V2": "0"})  # Simulation diagnosis 4: the release before
    async def test_pre_join_to_complete_with_each_line_persisted_exactly_once(self) -> None:
        task = asyncio.create_task(
            run_r1_session(self.ctx, session_factory=self.session_factory)
        )
        # OPENING: activation happened first, the session started, and the driver spoke the opening
        # (M032 S7C: the hello, the candidate's "yes", then the agenda).
        await self.until(lambda: self.spoken_and_played(self.opening_line_ids()[0]))
        names = [item if isinstance(item, str) else item[0] for item in self.order]
        self.assertLess(names.index("activate"), names.index("start"))
        self.assertLess(names.index("start"), names.index("play_start"))
        self.assertNotIn("terminal", names)  # nothing settles before the interview ran
        self.assertIsInstance(self.session.agent, R1Agent)
        await self.pass_sound_check()
        # ICEBREAKER: four committed candidate answers at S >= 3:30 end it at the boundary turn.
        await self.until(lambda: self._machine_phase() is R1Phase.ICEBREAKER)
        self.clock.advance(215)
        await self.four_icebreaker_answers()
        # TRANSITION then READY then the pickup, then ROLEPLAY.  The candidate answers
        # only after the line has finished playing, as a real candidate would.
        await self.candidate_replies_after("L-TRANSITION", "ready")
        await self.until(lambda: self.spoken_and_played("L-PICKUP"))
        await self.until(lambda: self._machine_phase() is R1Phase.ROLEPLAY)
        # ROLEPLAY ends on R = 20:00; the learner closes in role (M2: L-TIME-UP), then the exit
        # and wrap-up lines follow.
        self.clock.advance(1201)
        self.final_transcript("let me summarise the offer")
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.05):
            await self.candidate_replies_after("L-WRAP", "No questions, thanks")
            self.assertEqual(await asyncio.wait_for(task, 10.0), "complete")

        opening = list(self.opening_line_ids())
        expected_lines = [
            *opening, "L-TRANSITION", "L-PICKUP", "L-TIME-UP", "L-EXIT", "L-WRAP", "L-CLOSE",
        ]
        self.assertEqual(self.session.spoken, [self.spoken_line(name) for name in expected_lines])
        phases = {row["text"]: row["phase"] for row in self.bot_rows()}
        self.assertEqual(
            [phases[self.spoken_line(name)] for name in expected_lines],
            ["opening"] * len(opening)
            + ["transition", "transition", "roleplay", "roleplay_exit", "wrapup", "closing"],
        )
        # Exactly once each, with strictly increasing indices.
        self.assertEqual(len(self.bot_rows()), len(expected_lines))
        indices = [row["index"] for row in self.writer.saved]
        self.assertEqual(len(indices), len(set(indices)))
        # Lifecycle: activated, completed from in_progress, then the room and the job ended.
        self.assertEqual(self.writer.activations, 1)
        self.assertEqual(self.writer.terminals, [("complete", {"activated": True})])
        self.assertEqual(self.ctx.deleted_rooms, [None])
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])
        after_close = [item if isinstance(item, str) else item[0] for item in self.order]
        self.assertLess(after_close.index("activate"), after_close.index("terminal"))
        # phase=ended is published when L-CLOSE has played, before the terminal write.
        ended = self.order.index(("attributes", {"phase": "ended"}))
        self.assertLess(ended, self.order.index("terminal"))
        self.assertLess(self.order.index(("play_end", self.spoken_line("L-CLOSE"))), ended)
        # Every phase change was published on the way, in order (item 6 of the smoke fixes):
        # the page labels the interview from it and shows the lead card only in role-play.
        self.assertEqual(
            [attributes["phase"] for attributes in self.ctx.room.local_participant.attributes],
            [
                "opening", "icebreaker", "transition", "roleplay", "roleplay_exit", "wrapup",
                "closing", "ended",
            ],
        )

    async def four_icebreaker_answers(self) -> None:
        """Four answers, each a final transcript the SDK then commits as a turn (the hook)."""
        for answer in (
            "I sold courses",
            "to working professionals",
            "mostly by phone",
            "yes that is how I work",  # an answer has three words that are not noise
        ):
            await self.answer(answer)

    async def drive_to_the_wrapup(self) -> asyncio.Task:
        """Run the real session until the wrap-up question has been asked."""
        task = asyncio.create_task(
            run_r1_session(self.ctx, session_factory=self.session_factory)
        )
        await self.pass_sound_check()
        await self.until(lambda: self._machine_phase() is R1Phase.ICEBREAKER)
        self.clock.advance(215)
        await self.four_icebreaker_answers()
        await self.candidate_replies_after("L-TRANSITION", "ready")
        await self.until(lambda: self._machine_phase() is R1Phase.ROLEPLAY)
        self.clock.advance(1201)
        self.final_transcript("let me summarise the offer")
        # Simulation diagnosis 4 (R1_EXIT_WRAP_V2): the time cap's one exit line asks the question.
        await self.until(
            lambda: self.spoken_and_played("L-WRAP") or self.spoken_and_played("L-EXIT-WRAP-TIME")
        )
        await self.until(lambda: self._machine_phase() is R1Phase.WRAPUP)
        await self.settle()
        return task

    async def test_a_candidate_who_leaves_during_the_wrapup_still_completes_the_session(
        self,
    ) -> None:
        task = await self.drive_to_the_wrapup()
        with mock.patch.object(r1_session, "rejoin_grace_seconds", return_value=0.05):
            self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
            self.assertEqual(await asyncio.wait_for(task, 10.0), "complete")
        # Completed from in_progress, so the scorer's trigger fires; counted as complete.
        self.assertEqual(self.writer.terminals, [("complete", {"activated": True})])
        self.assertEqual(self.writer.outcomes, ["complete"])
        # Nobody is there to hear a goodbye, and it is not an apology either.
        self.assertNotIn(self.spoken_line("L-CLOSE"), self.session.spoken)
        self.assertNotIn(self.spoken_line("L-SYSTEM-STOP"), self.session.spoken)
        # The page is not told this was a technical stop.
        self.assertNotIn({"phase": "aborted"}, self.ctx.room.local_participant.attributes)
        self.assertEqual(self.ctx.room.local_participant.attributes[-1], {"phase": "ended"})

    async def test_a_candidate_who_leaves_during_the_roleplay_is_still_a_failed_session(
        self,
    ) -> None:
        task = asyncio.create_task(
            run_r1_session(self.ctx, session_factory=self.session_factory)
        )
        await self.pass_sound_check()
        await self.until(lambda: self._machine_phase() is R1Phase.ICEBREAKER)
        self.clock.advance(215)
        await self.four_icebreaker_answers()
        await self.candidate_replies_after("L-TRANSITION", "ready")
        await self.until(lambda: self._machine_phase() is R1Phase.ROLEPLAY)
        with mock.patch.object(r1_session, "rejoin_grace_seconds", return_value=0.05):
            self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
            self.assertEqual(await asyncio.wait_for(task, 10.0), "candidate_left")
        self.assertEqual(self.writer.terminals, [("candidate_left", {"activated": True})])
        self.assertEqual(self.writer.outcomes, ["candidate_left"])

    async def drive_to_the_roleplay(self) -> asyncio.Task:
        """Run the real session until the learner has picked up, at R = 0."""
        task = asyncio.create_task(
            run_r1_session(self.ctx, session_factory=self.session_factory)
        )
        await self.pass_sound_check()
        await self.until(lambda: self._machine_phase() is R1Phase.ICEBREAKER)
        self.clock.advance(215)
        await self.four_icebreaker_answers()
        await self.candidate_replies_after("L-TRANSITION", "ready")
        await self.until(lambda: self._machine_phase() is R1Phase.ROLEPLAY)
        await self.until(lambda: self.spoken_and_played("L-PICKUP"))
        await self.settle()
        return task

    async def finish_the_wrapup_after_a_stop(self, task: asyncio.Task) -> None:
        """The stop ended the role-play: L-EXIT, Christy's wrap-up, then an ordinary completion."""
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.05):
            await self.candidate_replies_after("L-WRAP", "No questions, thanks")
            self.assertEqual(await asyncio.wait_for(task, 10.0), "complete")
        spoken = self.session.spoken
        tail = ["L-EXIT", "L-WRAP", "L-CLOSE"]
        self.assertEqual(spoken[-3:], [self.spoken_line(name) for name in tail])
        phases = {row["text"]: row["phase"] for row in self.bot_rows()}
        self.assertEqual(
            [phases[self.spoken_line(name)] for name in tail],
            ["roleplay_exit", "wrapup", "closing"],
        )
        # The normal completion: completed from in_progress (the scorer's trigger fires) and counted
        # as complete.  Whether it is SCORED is the gate's: R = 1:00 fails ``roleplay_too_short``.
        self.assertEqual(self.writer.terminals, [("complete", {"activated": True})])
        self.assertEqual(self.writer.outcomes, ["complete"])
        self.assertNotIn(self.spoken_line("L-SYSTEM-STOP"), spoken)
        self.assertNotIn({"phase": "aborted"}, self.ctx.room.local_participant.attributes)
        interview = self.session.agent.interview
        self.assertTrue(interview.machine.roleplay_finished)
        self.assertTrue(interview.engine.end_confirmed)
        # The worker's own fidelity check fails it too: R stopped at 1:00.
        fidelity = interview.engine.fidelity(r_end=interview.machine.roleplay_elapsed)
        self.assertFalse(fidelity["checks"]["r_reached_10_min"])
        self.assertFalse(fidelity["passes"])

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0", "R1_EXIT_WRAP_V2": "0"})  # the release before
    async def test_a_confirmed_request_to_stop_ends_the_roleplay_into_the_wrapup(self) -> None:
        # Owner test 7f2a25e6: "can you disconnect the call?" gets the interviewer's question once.
        # Owner decision 2026-10-29 (owner test 1eb18cd4): "End the interview." then ends the
        # ROLE-PLAY, and Christy's normal finishing part follows.  This used to end the whole
        # session at once with L-END-CLOSE as a failed candidate_left.
        task = await self.drive_to_the_roleplay()
        self.clock.advance(60)
        self.assertTrue(await self.answer("Okay, never mind, can you disconnect the call?"))
        await self.until(lambda: self.spoken_and_played("L-ASIDE-END"))
        await self.settle()
        self.assertTrue(await self.answer("End the interview."))
        await self.finish_the_wrapup_after_a_stop(task)
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-ASIDE-END")), 1)

    @mock.patch.dict(os.environ, {"R1_EXIT_WRAP_V2": "0"})  # Simulation diagnosis 4: the release before
    async def test_a_farewell_exit_says_her_bye_then_one_exit_and_wrap_line(self) -> None:
        """Simulation diagnosis 3 (D3-EXIT1, R1_FAREWELL_EXIT_V2): the advisor's goodbye ended the
        call: her short bye, then L-EXIT-WRAP (no beat, no separate L-WRAP)."""
        task = await self.drive_to_the_roleplay()
        self.clock.advance(60)
        interview = self.session.agent.interview
        engine = interview.engine
        engine.exit_farewell = True
        engine.exit_bye = "L-LEARNER-BYE-1"
        engine.exit_requested = True
        interview._wake()
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.05):
            await self.candidate_replies_after("L-EXIT-WRAP", "No questions, thanks")
            self.assertEqual(await asyncio.wait_for(task, 10.0), "complete")
        spoken = self.session.spoken
        tail = ["L-LEARNER-BYE-1", "L-EXIT-WRAP", "L-CLOSE"]
        self.assertEqual(spoken[-3:], [self.spoken_line(name) for name in tail])
        self.assertNotIn(self.spoken_line("L-WRAP"), spoken)
        self.assertTrue(self.spoken_line("L-EXIT-WRAP").startswith("Let's stop the role-play here."))

    @mock.patch.dict(os.environ, {"R1_EXIT_WRAP_V2": "0"})  # Simulation diagnosis 4: the release before
    async def test_an_explicit_first_request_ends_the_roleplay_with_no_question(self) -> None:
        # Owner test 1eb18cd4, 81: "Let's end the interview." names the interview, so it is taken
        # as confirmed: no L-ASIDE-END (it would only ask the candidate to say exactly that).
        task = await self.drive_to_the_roleplay()
        self.clock.advance(60)
        self.assertTrue(await self.answer("Let's end the interview."))
        await self.finish_the_wrapup_after_a_stop(task)
        self.assertNotIn(self.spoken_line("L-ASIDE-END"), self.session.spoken)

    # ------------------------------------------- Simulation diagnosis 4 (D4-EXIT1, R1_EXIT_WRAP_V2)
    async def finish_after_one_exit_line(self, task: asyncio.Task, exit_line: str) -> list[str]:
        """The role-play ended: ONE Christy line leaves it and asks the wrap-up question, then the
        wrap-up and the close.  Returns the spoken line texts."""
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.05):
            await self.candidate_replies_after(exit_line, "No questions, thanks")
            self.assertEqual(await asyncio.wait_for(task, 10.0), "complete")
        spoken = self.session.spoken
        self.assertEqual(spoken[-2:], [self.spoken_line(exit_line), self.spoken_line("L-CLOSE")])
        for old in ("L-EXIT", "L-WRAP", "L-EXIT-WRAP"):
            self.assertNotIn(self.spoken_line(old), spoken)
        text = self.spoken_line(exit_line)
        self.assertIn("let's pause the role-play here", text.lower())
        self.assertIn("do you have any questions for me about the role or the next steps?", text)
        self.assertEqual(text.count("Dex"), 0 if exit_line == "L-EXIT-WRAP-ASIDE" else 1)
        phases = {row["text"]: row["phase"] for row in self.bot_rows()}
        self.assertEqual(phases[text], "roleplay_exit")
        return spoken

    async def test_d4_the_time_cap_says_one_exit_line_after_her_time_up(self) -> None:
        task = await self.drive_to_the_roleplay()
        self.clock.advance(1201)
        self.final_transcript("let me summarise the offer")
        spoken = await self.finish_after_one_exit_line(task, "L-EXIT-WRAP-TIME")
        self.assertEqual(spoken[-3], self.spoken_line("L-TIME-UP"))

    async def test_d4_an_explicit_request_to_stop_gets_one_exit_line_that_answers_it(self) -> None:
        task = await self.drive_to_the_roleplay()
        self.clock.advance(60)
        self.assertTrue(await self.answer("Let's end the interview."))
        await self.finish_after_one_exit_line(task, "L-EXIT-WRAP-END")

    async def test_d4_a_stop_confirmed_to_christys_question_needs_no_second_introduction(
        self,
    ) -> None:
        task = await self.drive_to_the_roleplay()
        self.clock.advance(60)
        self.assertTrue(await self.answer("Okay, never mind, can you disconnect the call?"))
        await self.until(lambda: self.spoken_and_played("L-ASIDE-END-2"))
        await self.settle()
        self.assertTrue(await self.answer("End the interview."))
        await self.finish_after_one_exit_line(task, "L-EXIT-WRAP-ASIDE")

    async def test_d4_a_farewell_exit_says_her_bye_a_beat_then_one_exit_line(self) -> None:
        task = await self.drive_to_the_roleplay()
        self.clock.advance(900)
        engine = self.session.agent.interview.engine
        engine.exit_farewell = True
        engine._exit_via_close = True
        engine.exit_bye = "L-LEARNER-BYE-1"
        engine.exit_requested = True
        self.session.agent.interview._wake()
        spoken = await self.finish_after_one_exit_line(task, "L-EXIT-WRAP-2")
        self.assertEqual(spoken[-3], self.spoken_line("L-LEARNER-BYE-1"))

    def _machine_phase(self):
        # run_r1_session builds its own interview; the agent holds a reference to it.
        agent = self.session.agent
        return agent.interview.machine.phase if agent is not None else None

    async def test_the_icebreaker_prompt_waits_for_the_opening_to_finish_playing(self) -> None:
        self.session.playout_seconds = 0.15
        with mock.patch.object(r1_session, "ICEBREAKER_PROMPT_SECONDS", 0.05), mock.patch.dict(
            os.environ, {"R1_OPENING_NO_HEARING_CHECK": "0"}
        ):
            task = asyncio.create_task(
                run_r1_session(self.ctx, session_factory=self.session_factory)
            )
            await self.pass_sound_check()  # M032 S7C: heard, so the prompt is "Are you still ...?"
            await self.until(lambda: self.spoken_line("L-SIL-IB") in self.session.spoken)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        events = [item for item in self.order if not isinstance(item, str)]
        open_end = events.index(("play_end", self.spoken_line("L-OPEN-AGENDA")))
        prompt_start = events.index(("play_start", self.spoken_line("L-SIL-IB")))
        self.assertLess(open_end, prompt_start)

    async def test_default_icebreaker_prompt_waits_for_the_opening_to_finish_playing(self) -> None:
        self.session.playout_seconds = 0.15
        with mock.patch.object(r1_session, "ICEBREAKER_PROMPT_SECONDS", 0.05):
            task = asyncio.create_task(
                run_r1_session(self.ctx, session_factory=self.session_factory)
            )
            await self.until(lambda: self.spoken_line("L-SIL-NOAUDIO") in self.session.spoken)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        events = [item for item in self.order if not isinstance(item, str)]
        agenda = self.spoken_line(self.opening_line_ids()[-1])
        self.assertLess(events.index(("play_end", agenda)),
                        events.index(("play_start", self.spoken_line("L-SIL-NOAUDIO"))))
        self.assertLess(events.index(("play_end", self.spoken_line("L-OPEN-HI"))),
                        events.index(("play_start", agenda)))

    async def test_activation_failure_fails_closed_before_the_session_starts(self) -> None:
        self.writer.activate_ok = False
        outcome = await asyncio.wait_for(
            run_r1_session(self.ctx, session_factory=self.session_factory), 10.0
        )
        self.assertEqual(outcome, "configuration_failed")
        self.assertEqual(self.session.started, None)
        self.assertEqual(self.session.spoken, [])
        self.assertEqual(self.writer.terminals, [("configuration_failed", {"activated": False})])
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])

    async def run_with_activation(self) -> str:
        return await asyncio.wait_for(
            run_r1_session(self.ctx, session_factory=self.session_factory), 10.0
        )

    async def test_an_activation_that_times_out_is_unknown_not_unactivated(self) -> None:
        # The CAS runs in a thread that wait_for cannot cancel, so it may still land.
        self.writer.activate_hangs = True
        with mock.patch.object(r1_session, "ACTIVATION_SECONDS", 0.05):
            with self.capture_logs() as logs:
                outcome = await self.run_with_activation()
        self.assertEqual(outcome, "configuration_failed")
        self.assertEqual(
            self.writer.terminals, [("configuration_failed", {"activated": None})]
        )
        self.assertIn("r1_activation_unknown", error_types(logs))
        self.assertEqual(self.session.started, None)
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])

    async def test_an_activation_error_is_unknown_but_a_conflict_is_not_applied(self) -> None:
        for kind, expected in (("error", None), ("conflict", False), ("disabled", False)):
            with self.subTest(kind=kind):
                self.writer.terminals.clear()
                self.writer.activate_kind = kind
                self.ctx.shutdowns.clear()
                outcome = await self.run_with_activation()
                self.assertEqual(outcome, "configuration_failed")
                self.assertEqual(
                    self.writer.terminals, [("configuration_failed", {"activated": expected})]
                )

    async def test_a_job_cancelled_during_the_activation_is_unknown_too(self) -> None:
        self.writer.activate_hangs = True
        task = asyncio.create_task(
            run_r1_session(self.ctx, session_factory=self.session_factory)
        )
        await self.until(lambda: self.writer.activations == 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.writer.terminals, [("shutdown_forced", {"activated": None})])
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])


class TestRunR1SessionFailurePaths(R1TestCase):
    """Connect, context and configuration failures still settle through the exit funnel."""

    async def asyncSetUp(self) -> None:
        self.order: list = []
        self.ctx = FakeContext(self.order)
        self.writer = FakeWriter(self.order)
        self.session = FakeSession(log=self.order)
        patch = mock.patch.object(r1_session, "R1TurnWriter", lambda *_a, **_k: self.writer)
        patch.start()
        self.addCleanup(patch.stop)

    async def factory(self, _ctx, _context):
        return self.session

    def assert_settled(self, outcome: str) -> None:
        self.assertEqual(self.writer.terminals, [(outcome, {"activated": False})])
        self.assertEqual(self.writer.outcomes, [outcome])
        self.assertEqual(self.ctx.deleted_rooms, [None])
        self.assertEqual(self.ctx.shutdowns, ["r1_exit"])
        names = [item for item in self.order if isinstance(item, str)]
        self.assertEqual(names, ["ledger", "terminal", "outcome"])

    async def test_a_connect_failure_settles_as_provider_error(self) -> None:
        self.ctx.connect_error = RuntimeError("signal unreachable")
        with self.capture_logs() as logs:
            outcome = await run_r1_session(self.ctx, session_factory=self.factory)
        self.assertEqual(outcome, "provider_error")
        self.assert_settled("provider_error")
        self.assertIn("r1_connect_failed", error_types(logs))
        self.assertNotIn("unreachable", json.dumps(logs))

    async def test_a_context_failure_settles_as_context_failed(self) -> None:
        async def failing_fetch(_room):
            raise r1_context.R1ContextError("r1_context_unavailable")

        with mock.patch.object(r1_session, "fetch_context", failing_fetch):
            with self.capture_logs() as logs:
                outcome = await run_r1_session(self.ctx, session_factory=self.factory)
        self.assertEqual(outcome, "context_failed")
        self.assert_settled("context_failed")
        self.assertIn("r1_context_failed", error_types(logs))

    async def test_a_configuration_failure_settles_as_configuration_failed(self) -> None:
        async def fetch(_room):
            return {
                "first_name": "Asha",
                "round_id": "r",
                "attempt_id": "a",
                "attempt": {},
                "settings": {},
            }

        async def broken_factory(_ctx, _context):
            raise r1_llm.R1LLMConfigurationError("r1_llm_key_missing")

        with mock.patch.object(r1_session, "fetch_context", fetch):
            with self.capture_logs() as logs:
                outcome = await run_r1_session(self.ctx, session_factory=broken_factory)
        self.assertEqual(outcome, "configuration_failed")
        self.assert_settled("configuration_failed")
        self.assertIn("r1_configuration_failed", error_types(logs))
        self.assertNotIn("r1_llm_key_missing", json.dumps(logs))

    async def test_a_cancellation_during_connect_settles_as_shutdown_forced(self) -> None:
        self.ctx.connect_hangs = True
        task = asyncio.create_task(run_r1_session(self.ctx, session_factory=self.factory))
        await self.until(lambda: self.ctx.connects == 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assert_settled("shutdown_forced")

    async def test_a_cancellation_during_context_fetch_settles_as_shutdown_forced(self) -> None:
        async def hanging_fetch(_room):
            await asyncio.Event().wait()

        with mock.patch.object(r1_session, "fetch_context", hanging_fetch):
            task = asyncio.create_task(run_r1_session(self.ctx, session_factory=self.factory))
            await self.settle()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assert_settled("shutdown_forced")


class TestPersistence(unittest.IsolatedAsyncioTestCase):
    """The attempt-outcome seam must stay fail-soft while PR-3's route is absent."""

    async def test_attempt_outcome_404_is_nonfatal(self) -> None:
        def missing_route(*_args):
            raise HTTPError("https://internal", 404, "not found", {}, None)

        writer = R1TurnWriter(SESSION_ID, ROOM_NAME, requester=missing_route)
        await writer.attempt_outcome("complete")

    def outcome(self, kind: str):
        return persistence.LifecycleOutcome(kind)

    async def test_a_turn_anchor_is_written_only_inside_the_columns_check_window(self) -> None:
        """``turn_started_at_ms`` has CHECK 0 < ms < 4102444800000 (0026): never risk the insert."""
        rows: list[dict] = []

        class Table:
            def insert(self, row):
                rows.append(dict(row))
                return SimpleNamespace(execute=lambda: SimpleNamespace(error=None))

        writer = R1TurnWriter(SESSION_ID, ROOM_NAME)
        cases = [
            (1_760_000_000_123, True), (1, True), (4_102_444_799_999, True),
            (None, False), (0, False), (-5, False), (4_102_444_800_000, False),
            (True, False), (1.76e12, False), ("1760000000123", False),
        ]
        with mock.patch.object(persistence, "_table", lambda _name: Table()):
            for anchor, written in cases:
                await writer.save_turn(7, "bot", "hello", "opening", started_at_ms=anchor)
        for (anchor, written), row in zip(cases, rows):
            with self.subTest(anchor=anchor):
                if written:
                    self.assertEqual(row["turn_started_at_ms"], anchor)
                else:
                    self.assertNotIn("turn_started_at_ms", row)
                self.assertEqual(
                    {k: v for k, v in row.items() if k != "turn_started_at_ms"},
                    {"session_id": SESSION_ID, "turn_index": 7, "speaker": "bot", "text": "hello",
                     "phase": "opening", "interrupted": False},
                )

    async def test_a_turn_without_an_anchor_inserts_exactly_the_old_row(self) -> None:
        rows: list[dict] = []

        class Table:
            def insert(self, row):
                rows.append(dict(row))
                return SimpleNamespace(execute=lambda: SimpleNamespace(error=None))

        writer = R1TurnWriter(SESSION_ID, ROOM_NAME)
        with mock.patch.object(persistence, "_table", lambda _name: Table()):
            await writer.save_turn(2, "candidate", " hi ", "icebreaker", interrupted=True)
        self.assertEqual(
            rows,
            [{"session_id": SESSION_ID, "turn_index": 2, "speaker": "candidate", "text": "hi",
              "phase": "icebreaker", "interrupted": True}],
        )

    async def test_terminal_source_status_follows_activation(self) -> None:
        writer = R1TurnWriter(SESSION_ID, ROOM_NAME)
        fail = mock.AsyncMock(return_value=self.outcome(persistence.LifecycleOutcome.SUCCESS))
        complete = mock.AsyncMock(return_value=self.outcome(persistence.LifecycleOutcome.SUCCESS))
        with mock.patch.object(persistence, "fail_session", fail), mock.patch.object(
            persistence, "complete_session", complete
        ):
            for outcome in OUTCOME_DISPOSITIONS:
                for activated in (True, False):
                    fail.reset_mock()
                    complete.reset_mock()
                    await writer.terminal(outcome, 12, activated=activated)
                    if outcome == "complete":
                        complete.assert_awaited_once_with(SESSION_ID, 12, "conversation_complete")
                        fail.assert_not_awaited()
                        continue
                    fail.assert_awaited_once_with(
                        SESSION_ID,
                        OUTCOME_DISPOSITIONS[outcome].terminal_reason,
                        expected_status="in_progress" if activated else "waiting",
                    )

    async def test_an_unactivated_terminal_defaults_to_waiting(self) -> None:
        writer = R1TurnWriter(SESSION_ID, ROOM_NAME)
        fail = mock.AsyncMock(return_value=self.outcome(persistence.LifecycleOutcome.SUCCESS))
        with mock.patch.object(persistence, "fail_session", fail):
            await writer.terminal("no_show", 3)
        self.assertEqual(fail.await_args.kwargs["expected_status"], "waiting")

    async def test_a_cas_conflict_is_logged_not_silent(self) -> None:
        writer = R1TurnWriter(SESSION_ID, ROOM_NAME)
        conflict = mock.AsyncMock(return_value=self.outcome(persistence.LifecycleOutcome.CONFLICT))
        with mock.patch.object(persistence, "fail_session", conflict):
            with capture_r1_logs() as logs:
                result = await writer.terminal("provider_error", 3, activated=True)
        self.assertEqual(result.kind, persistence.LifecycleOutcome.CONFLICT)
        self.assertEqual(
            [(entry["error_type"], entry["error_category"]) for entry in logs],
            [("r1_terminal_not_applied:provider_error", "in_progress_conflict")],
        )

    async def test_an_unknown_activation_tries_in_progress_then_waiting(self) -> None:
        writer = R1TurnWriter(SESSION_ID, ROOM_NAME)
        success = self.outcome(persistence.LifecycleOutcome.SUCCESS)
        conflict = self.outcome(persistence.LifecycleOutcome.CONFLICT)
        # The activation DID land: the first CAS (from in_progress) applies, once.
        fail = mock.AsyncMock(return_value=success)
        with mock.patch.object(persistence, "fail_session", fail):
            result = await writer.terminal("provider_error", 3, activated=None)
        self.assertTrue(result.ok)
        self.assertEqual(
            [call.kwargs["expected_status"] for call in fail.await_args_list], ["in_progress"]
        )
        # It did NOT land: the row is still waiting, so the second CAS applies.
        fail = mock.AsyncMock(side_effect=[conflict, success])
        with mock.patch.object(persistence, "fail_session", fail):
            with capture_r1_logs() as logs:
                result = await writer.terminal("provider_error", 3, activated=None)
        self.assertTrue(result.ok)
        self.assertEqual(
            [call.kwargs["expected_status"] for call in fail.await_args_list],
            ["in_progress", "waiting"],
        )
        self.assertEqual(len(logs), 1)  # only the first, unapplied CAS is reported
        # Neither applies (another writer settled it): both are reported, the last returned.
        fail = mock.AsyncMock(return_value=conflict)
        with mock.patch.object(persistence, "fail_session", fail):
            with capture_r1_logs() as logs:
                result = await writer.terminal("provider_error", 3, activated=None)
        self.assertFalse(result.ok)
        self.assertEqual(
            [entry["error_category"] for entry in logs],
            ["in_progress_conflict", "waiting_conflict"],
        )

    async def test_a_known_activation_state_tries_exactly_one_source(self) -> None:
        writer = R1TurnWriter(SESSION_ID, ROOM_NAME)
        conflict = self.outcome(persistence.LifecycleOutcome.CONFLICT)
        for activated, source in ((True, "in_progress"), (False, "waiting")):
            with self.subTest(activated=activated):
                fail = mock.AsyncMock(return_value=conflict)
                with mock.patch.object(persistence, "fail_session", fail):
                    with capture_r1_logs():
                        await writer.terminal("no_show", 3, activated=activated)
                self.assertEqual(
                    [call.kwargs["expected_status"] for call in fail.await_args_list], [source]
                )

    async def test_a_completion_is_never_attempted_from_waiting(self) -> None:
        writer = R1TurnWriter(SESSION_ID, ROOM_NAME)
        complete = mock.AsyncMock(return_value=self.outcome(persistence.LifecycleOutcome.SUCCESS))
        fail = mock.AsyncMock()
        with mock.patch.object(persistence, "complete_session", complete), mock.patch.object(
            persistence, "fail_session", fail
        ):
            await writer.terminal("complete", 9, activated=None)
        complete.assert_awaited_once_with(SESSION_ID, 9, "conversation_complete")
        fail.assert_not_awaited()

    async def test_activate_delegates_to_the_lifecycle_cas(self) -> None:
        writer = R1TurnWriter(SESSION_ID, ROOM_NAME)
        activate = mock.AsyncMock(return_value=self.outcome(persistence.LifecycleOutcome.SUCCESS))
        with mock.patch.object(persistence, "activate_session", activate):
            result = await writer.activate()
        activate.assert_awaited_once_with(SESSION_ID)
        self.assertTrue(result.ok)

    async def test_a_room_without_a_session_id_cannot_activate(self) -> None:
        result = await R1TurnWriter(None, "screening-x").activate()
        self.assertFalse(result.ok)


class TestR1Context(unittest.IsolatedAsyncioTestCase):
    """Context lookup has no permissive fallback to room metadata."""

    async def test_context_fetch_rejects_transport_failure(self) -> None:
        def unavailable(*_args):
            raise OSError("offline")

        with self.assertRaises(r1_context.R1ContextError):
            await r1_context.fetch_context("screening-x", requester=unavailable)


class TestWrapupAndReadyDriveTheDriver(R1TestCase):
    """The smoke test's two matching bugs, through the real driver and the real reply hook.

    A phrasing that is not recognised costs a free-form interviewer reply, then 20 s of
    silence and a second goodbye (wrap-up), or a needless nudge (transition).  Each loop
    rebuilds the interview (``asyncSetUp``) because a driver run changes its flags.
    """

    async def test_agent_instructions_follow_persona(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertTrue(r1_session.r1_agent_instructions().startswith("You are Dex."))
            if r1_session.Agent is not object:
                self.assertIn("You are Dex.", R1Agent(self.interview).instructions)
            else:
                with mock.patch.object(
                    r1_session, "r1_agent_instructions", wraps=r1_session.r1_agent_instructions
                ) as instructions:
                    R1Agent(self.interview)
                instructions.assert_called_once_with()
        with mock.patch.dict(os.environ, {"R1_INTERVIEWER_DEX": "0"}, clear=True):
            self.assertTrue(r1_session.r1_agent_instructions().startswith("You are Christy."))

    async def hook(self, text: str) -> None:
        agent = R1Agent(self.interview)
        await agent.on_user_turn_completed(
            None, SimpleNamespace(text_content=text, id=f"msg_{next(_IDS)}")
        )

    def enter_wrapup(self) -> None:
        self.enter_roleplay()
        self.interview._end_roleplay()
        self.interview.machine.transition(R1Phase.WRAPUP)

    async def test_every_common_no_questions_answer_ends_wrapup_without_a_reply(self) -> None:
        for text in TestPhaseAndConfiguration.PUNCTUATED_REFUSALS:
            if "?" in text:
                continue
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.enter_wrapup()
                with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.02):
                    task = asyncio.create_task(self.interview._run_wrapup())
                    await self.settle()
                    self.final_transcript(text)
                    # The SDK's end of turn: the model must NOT answer a refusal.
                    with self.assertRaises(r1_session.StopResponse):
                        await self.hook(text)
                    # ...and the driver ends the wrap-up now, not after WRAPUP_SILENCE_SECONDS.
                    self.assertIsNone(await asyncio.wait_for(task, 5.0))
                self.assertEqual(self.session.spoken, [])
                self.assertEqual(self.interview._turns.qsize(), 0)

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_real_question_is_still_answered_and_keeps_wrapup_open(self) -> None:
        for text in (
            "What is the notice period for this role?",
            "No, but when will I hear back",
            "Not really, but what is the salary range",
            "That's it, how long until I get results",
        ):
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.enter_wrapup()
                with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.02):
                    task = asyncio.create_task(self.interview._run_wrapup())
                    await self.settle()
                    self.final_transcript(text)
                    await self.hook(text)  # not suppressed: the interviewer answers it
                    await asyncio.sleep(0.1)  # well past the settle window
                    self.assertFalse(task.done())  # counted as a question, wrap-up stays open
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task

    async def test_punctuated_ready_answers_pick_up_at_once_without_a_nudge(self) -> None:
        for text in (
            "Let's start.", "Let’s start", "Yes, let's start.", "Alright, let's do it.",
            "Ready.", "Yeah, let's start the role play.",
        ):
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.interview.machine.transition(R1Phase.TRANSITION)
                task = asyncio.create_task(self.interview._run_transition())
                await self.settle()
                self.final_transcript(text)
                # Not the 20 s TRANSITION_DEADLINE_SECONDS: the answer itself is the pickup.
                self.assertIsNone(await asyncio.wait_for(task, 5.0))
                self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])

    async def test_a_short_yes_picks_up_only_after_a_yes_no_start_question(self) -> None:
        # M1 review fix: "Yes." to "Shall we start now?" (L-TRANSITION-REASK) is a consent; the
        # same "Yes." to the either/or "now, or questions first?" could mean either.
        for text in (
            "Yes.", "Go ahead.", "Sure!", "OK.", "Sure, go ahead.", "Okay, sure.", "Yeah sure.",
        ):
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.interview.machine.transition(R1Phase.TRANSITION)
                await self.interview.say("L-TRANSITION-REASK")
                task = asyncio.create_task(self.interview._run_transition())
                await self.settle()
                self.final_transcript(text)
                self.assertIsNone(await asyncio.wait_for(task, 5.0))
                self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))


class TestWrapupAnswersTheQuestionBeforeTheClose(R1TestCase):
    """Owner test 8f5bfefc turns 70-73: "Christy, so. How what will be the next step?" got no
    answer.  The STT split it into two finals (two "questions": the limit), the reply was cut
    before any audio by "Christie.", and the settled-but-unheard reply was taken for an answer."""

    DEFER = "That's a good question for the hiring team; they'll follow up with you on it."

    def enter_wrapup(self) -> None:
        self.enter_roleplay()
        self.interview._end_roleplay()
        self.interview.machine.transition(R1Phase.WRAPUP)

    def reply_created(self) -> FakeSpeechHandle:
        handle = FakeSpeechHandle("reply")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
        )
        return handle

    async def lost(self, handle: FakeSpeechHandle) -> None:
        """The reply is cancelled before any audio (voice barge-in): no item, no row."""
        handle.interrupted = True
        handle.finish()
        await self.settle()

    async def play(self, handle: FakeSpeechHandle, text: str) -> None:
        self.session.current_speech = handle
        self.agent_state("speaking")
        self.session.emit("conversation_item_added", SimpleNamespace(item=FakeChatMessage(text)))
        self.session.current_speech = None
        self.agent_state("listening")
        handle.finish()
        await self.settle()

    async def ask(self, text: str) -> FakeSpeechHandle:
        """A wrap-up question: its final, the SDK's commit (answered), and the reply speech."""
        self.final_transcript(text)
        await self.settle()
        self.assertFalse(await self.commit_turn(text))
        handle = self.reply_created()
        await self.settle()
        return handle

    def wrapup_bot_rows(self) -> list[str]:
        return [
            r["text"] for r in self.writer.saved if r["speaker"] == "bot" and r["phase"] == "wrapup"
        ]

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_session_8f5bfefc_the_next_step_question_is_answered_before_the_close(self):
        self.enter_wrapup()
        with mock.patch.object(r1_session, "REPLY_APPEAR_SECONDS", 0.2), mock.patch.object(
            r1_session, "WRAPUP_SETTLE_SECONDS", 0.02
        ):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            self.final_transcript("Christy, so.")
            await self.settle()
            self.final_transcript("How what will be the next step?")
            await self.settle()
            self.assertFalse(await self.commit_turn("Christy, so. How what will be the next step?"))
            first = self.reply_created()
            await self.settle()
            await self.lost(first)  # "Christie." barges in before any audio
            self.final_transcript("Christie.")
            await self.settle()
            await asyncio.sleep(0.3)  # past REPLY_APPEAR_SECONDS and the settle window
            self.assertFalse(task.done(), "L-CLOSE would play over an unanswered question")
            self.assertFalse(await self.commit_turn("Christie."))  # the model answers now
            await self.play(self.reply_created(), self.DEFER)
            self.assertEqual(self.wrapup_bot_rows(), [self.DEFER])
            # ONE question was asked (split by the STT) and answered: room for another.
            await asyncio.sleep(0.1)
            self.assertFalse(task.done())
            self.final_transcript("No, thank you.")
            self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(self.session.spoken, [])

    async def retried(self) -> FakeSpeechHandle:
        """The one reply the driver itself asked for (the owed answer, said again).

        Polled against a loop-time deadline, not a count of sleeps: a loaded CI box may need
        longer than a second (review round 2: 2 of 30 runs failed under a parallel suite)."""
        deadline = asyncio.get_running_loop().time() + 5.0
        while not self.session.generated and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        self.assertEqual(len(self.session.generated), 1, "the owed answer is asked for once")
        return self.session.generated[0]

    async def cut_after(self, handle: FakeSpeechHandle, words: str) -> None:
        """A few words of the reply play, then the candidate's barge-in cuts it."""
        self.session.current_speech = handle
        self.agent_state("speaking")
        message = FakeChatMessage(words, interrupted=True)
        self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        self.session.current_speech = None
        self.agent_state("listening")
        handle.interrupted = True
        handle.finish()
        await self.settle()

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_an_answer_cut_before_audio_at_the_question_limit_is_said_again(self):
        self.enter_wrapup()
        with mock.patch.object(r1_session, "REPLY_APPEAR_SECONDS", 0.2):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            await self.play(await self.ask("What are the shift timings?"), "Monday to Friday.")
            await self.lost(await self.ask("And how many days a week is that?"))
            again = await self.retried()
            self.assertFalse(task.done(), "the second answer was never heard")
            # It is the owed question's reply: its context still holds the question.
            self.assertEqual(
                self.interview._speeches[again.id].reply.candidate_text,
                "And how many days a week is that?",
            )
            await self.play(again, "It is 5.5 days a week.")
            self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(self.wrapup_bot_rows(), ["Monday to Friday.", "It is 5.5 days a week."])
        self.assertIsNone(self.interview._wrapup_answer_owed)

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_heard_answer_at_the_question_limit_still_closes(self):
        self.enter_wrapup()
        task = asyncio.create_task(self.interview._run_wrapup())
        await self.settle()
        await self.play(await self.ask("What are the shift timings?"), "Monday to Friday.")
        second = await self.ask("And how many days a week is that?")
        self.assertFalse(task.done())
        await self.play(second, "It is 5.5 days a week.")
        self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(self.session.generated, [])

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_the_owed_answer_is_said_again_once_and_the_wrapup_stays_bounded(self):
        self.enter_wrapup()
        with mock.patch.object(r1_session, "REPLY_APPEAR_SECONDS", 0.2):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            await self.play(await self.ask("What are the shift timings?"), "Monday to Friday.")
            await self.lost(await self.ask("And how many days a week is that?"))
            await self.lost(await self.retried())  # lost again: one retry only, then the close
            self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(len(self.session.generated), 1)

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_no_retry_once_the_wrapup_budget_is_spent(self):
        self.enter_wrapup()
        with mock.patch.object(r1_session, "REPLY_APPEAR_SECONDS", 0.2), mock.patch.object(
            self.interview.machine, "remaining_wrapup_seconds", return_value=0.0
        ):
            self.interview._wrapup_answer_owed = r1_session.Reply(
                phase="wrapup", candidate_text="What will be the next step?"
            )
            self.assertIsNone(await asyncio.wait_for(self.interview._end_wrapup(), 5.0))
        self.assertEqual(self.session.generated, [])

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_thank_you_after_a_lost_answer_gets_the_answer_before_the_close(self):
        """Review of the 8f5bfefc fix: "Thank you." cancels the reply before any audio (the
        logged 4/10 pattern), a refusal gets no reply of its own, and L-CLOSE followed."""
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.02):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            await self.lost(await self.ask("What will be the next step?"))
            self.final_transcript("Thank you.")
            await self.settle()
            self.assertTrue(await self.commit_turn("Thank you."))  # no reply to the refusal
            again = await self.retried()
            self.assertFalse(task.done(), "L-CLOSE would follow an unanswered question")
            await self.play(again, self.DEFER)
            self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(self.wrapup_bot_rows(), [self.DEFER])

    async def spoken_ask(self, text: str) -> FakeSpeechHandle:
        """``ask`` the way a real turn runs it: the candidate is speaking until the turn commits.

        The silence window then starts after the question, never during it: with a 0.1 s window,
        a stall of the test process before the commit was "silence" before any question was owed
        (review round 2: the flaky failure of the silence test)."""
        self.user_state("speaking")
        await self.settle()
        handle = await self.ask(text)
        self.user_state("listening")
        await self.settle()
        return handle

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_silence_after_a_lost_answer_gets_the_answer_before_the_close(self):
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SILENCE_SECONDS", 0.1):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            await self.lost(await self.spoken_ask("What will be the next step?"))
            again = await self.retried()
            self.assertFalse(task.done())
            await self.play(again, self.DEFER)
            self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(self.wrapup_bot_rows(), [self.DEFER])

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_an_answer_cut_after_two_words_at_the_limit_waits_for_the_barge_in(self):
        """Review of the 8f5bfefc fix: "That's a" counted as the answer, and the wrap-up closed
        while the candidate's barge-in was still mid-turn."""
        self.enter_wrapup()
        task = asyncio.create_task(self.interview._run_wrapup())
        await self.settle()
        await self.play(await self.ask("What are the shift timings?"), "Monday to Friday.")
        await self.cut_after(await self.ask("And what will be the next step?"), "That's a")
        await asyncio.sleep(0.1)
        self.assertFalse(task.done(), "L-CLOSE would play over the candidate's barge-in")
        self.assertIsNotNone(self.interview._wrapup_answer_owed)
        # Their own turn's reply answers it; it is not said again by the driver.
        await self.play(await self.ask("Christy, can you hear me?"), self.DEFER)
        self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(self.session.generated, [])
        self.assertEqual(self.wrapup_bot_rows(), ["Monday to Friday.", "That's a", self.DEFER])

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_partly_heard_answer_is_not_said_again_after_a_refusal(self):
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.02):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            await self.cut_after(await self.ask("What will be the next step?"), "The hiring team")
            self.final_transcript("Okay, no more questions, thank you.")
            await self.settle()
            self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(self.session.generated, [])

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_lone_lead_in_is_still_a_question_when_nothing_follows(self):
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.02):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            self.final_transcript("Christy, so.")
            await asyncio.sleep(0.2)  # past the lead-in window
            self.assertFalse(task.done())  # not a refusal: the wrap-up stays open
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})  # Simulation diagnosis 3: the release before
    def test_the_classifiers(self):
        for text in ("Christy, so.", "So.", "Um, and", "Christie, um, so"):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_lead_in_only(text))
        for text in ("Christy, so?", "How what will be the next step?", "Christie.", "No."):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_lead_in_only(text))
        for text in ("Christie.", "Christy?", "Hey, Kristy.", "Christy, so."):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_name_only(text))
                self.assertFalse(r1_session.is_no_questions(text))
        for text in ("Christy, what's next?", "So.", "Thank you.", ""):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_name_only(text))
        # The STT's spellings of her name are courtesy around a refusal too.
        self.assertTrue(r1_session.is_no_questions("No, thank you, Christie."))


class TestWrapupEndingsM032(R1TestCase):
    """M032 S3.5 and SWEEP-26: the wrap-up says what is left, invites one more question, and
    "No, we are good." ends it (fda9e9f6 #94-95, a95398ab #66-68; synthetic text only)."""

    MORE = "Is there anything else you'd like to ask?"

    def enter_wrapup(self) -> None:
        self.enter_roleplay()
        self.interview._end_roleplay()
        self.interview.machine.transition(R1Phase.WRAPUP)

    async def answered(self, question: str, *answer: str) -> str:
        """The interviewer's reply to ``question`` as streamed (the guard and the tail)."""
        self.interview.prepare_turn(question, f"msg_{next(_IDS)}")
        stream = self.interview.llm_node_stream(
            SimpleNamespace(items=[]), lambda _messages: self_stream(*answer)
        )
        return "".join([chunk async for chunk in stream]).strip()

    def test_we_are_good_refuses_like_im_good(self) -> None:
        for text in ("No, we are good.", "We're good.", "No no, we're all set, thank you.",
                     "We are good, thanks Christy.", "All good.", "Nothing from my side."):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_no_questions(text))
        for text in ("We're good?", "We're good, but what is the salary?",
                     "We are good at sales, what is the next round?"):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_no_questions(text))
        with mock.patch.dict(os.environ, {"R1_WRAPUP_DECLINE_V2": "0"}):
            self.assertFalse(r1_session.is_no_questions("No, we are good."))
            self.assertTrue(r1_session.is_no_questions("All good."))  # as before

    def test_a_bare_yes_or_leave_to_ask_is_no_question_of_its_own(self) -> None:
        for text in ("Yes.", "Yeah, one more.", "Can I ask one more?", "Yes, I have a question.",
                     "Sure, one more question.", "I do."):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_affirmation_only(text))
        for text in ("Yes, what is the salary?", "Okay.", "One more thing: the shift timings?",
                     "Can I ask about the notice period?"):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_affirmation_only(text))

    async def test_the_first_answer_ends_with_the_invitation_once(self) -> None:
        self.enter_wrapup()
        first = await self.answered("What are the shift timings?", "Monday to Friday, nights.")
        self.assertEqual(first, f"Monday to Friday, nights. {self.MORE}")
        self.assertTrue(self.interview._wrap_more_used)
        second = await self.answered("And the weekends?", "Saturday is half a day.")
        self.assertEqual(second, "Saturday is half a day.")
        self.assertEqual(self.interview._wrapup_counts()["wrapup_more_asked"], 1)

    async def test_no_invitation_after_an_answer_that_already_asks(self) -> None:
        self.enter_wrapup()
        asked = await self.answered("What is the role like?", "It is a sales role. Does that help?")
        self.assertEqual(asked, "It is a sales role. Does that help?")
        self.assertFalse(self.interview._wrap_more_used)  # not used up
        # Review S3R-6: but the next answer is the last the wrap-up takes (L-CLOSE follows it at
        # once), so it never invites a question nobody would answer.
        later = await self.answered("Yes. And the shift?", "Nights, Monday to Friday.")
        self.assertEqual(later, "Nights, Monday to Friday.")
        self.assertFalse(self.interview._wrap_more_used)

    async def test_an_answer_cut_before_its_tail_hands_no_invitation_to_the_last_one(self) -> None:
        """Review S3R-6: Q1's answer is cut before its first sentence by the follow-up."""
        self.enter_wrapup()
        self.interview.prepare_turn("What is the role like?", f"msg_{next(_IDS)}")  # never heard
        last = await self.answered("And the shift?", "Nights, Monday to Friday.")
        self.assertEqual(last, "Nights, Monday to Friday.")
        self.assertFalse(self.interview._wrap_more_used)

    async def test_no_invitation_late_in_the_wrapup_or_with_the_flag_off(self) -> None:
        self.enter_wrapup()
        with mock.patch.object(
            self.interview.machine, "remaining_wrapup_seconds", return_value=29.0
        ):
            late = await self.answered("What is the shift?", "Nights.")
        self.assertEqual(late, "Nights.")
        with mock.patch.dict(os.environ, {"R1_WRAPUP_ANSWERS": "0"}):
            off = await self.answered("What is the shift?", "Nights.")
        self.assertEqual(off, "Nights.")
        self.assertFalse(self.interview._wrap_more_used)

    async def test_the_hiring_team_mention_of_the_model_is_taken_out(self) -> None:
        self.enter_wrapup()
        said = await self.answered(
            "Is any part of the interview left?",
            "That's everything for today's interview.",
            "The hiring team will follow up with you on next steps.",
        )
        self.assertEqual(said, f"That's everything for today's interview. {self.MORE}")
        self.assertEqual(self.interview._wrapup_counts()["wrapup_hiring_team_drops"], 1)
        self.assertNotIn("hiring", said.lower())

    async def test_a_yes_does_not_use_up_a_question_so_the_invited_one_is_answered(self) -> None:
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.02), mock.patch.object(
            r1_session, "REPLY_SETTLE_SECONDS", 0.05
        ):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            self.final_transcript("What are the shift timings?")
            await self.settle()
            self.final_transcript("Yes.")
            await self.settle()
            await asyncio.sleep(0.1)
            self.assertFalse(task.done(), "a bare yes is not the second question")
            self.final_transcript("How many days a week is it?")
            self.assertIsNone(await asyncio.wait_for(task, 5.0))  # the limit of two: the close
        self.assertEqual(self.interview._wrapup_counts()["wrapup_affirmations"], 1)
        with mock.patch.dict(os.environ, {"R1_WRAPUP_ANSWERS": "0"}), mock.patch.object(
            r1_session, "REPLY_SETTLE_SECONDS", 0.05
        ):
            await self.asyncSetUp()
            self.enter_wrapup()
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            self.final_transcript("What are the shift timings?")
            await self.settle()
            self.final_transcript("Yes.")
            self.assertIsNone(await asyncio.wait_for(task, 5.0))  # flag off: it counted

    async def test_the_owed_answer_said_again_has_no_invitation(self) -> None:
        self.enter_wrapup()
        owed = r1_session.Reply(
            phase="wrapup", candidate_text="What is next?", tail=self.MORE, tail_id="L-WRAP-MORE"
        )
        self.interview._wrapup_answer_owed = owed
        with mock.patch.object(r1_session, "REPLY_SETTLE_SECONDS", 0.05):
            self.assertIsNone(await asyncio.wait_for(self.interview._end_wrapup(), 5.0))
        self.assertEqual(len(self.session.generated), 1)
        self.assertEqual((owed.tail, owed.tail_id), ("", ""))

    async def test_a_beat_after_the_exit_line_and_a_turn_in_it_is_waited_for(self) -> None:
        self.enter_roleplay()
        self.interview._end_roleplay()
        with mock.patch.object(r1_session, "WRAP_BEAT_SECONDS", 0.05):
            self.user_state("speaking")
            task = asyncio.create_task(self.interview._wrap_beat())
            await asyncio.sleep(0.15)
            self.assertFalse(task.done(), "L-WRAP would be said over the candidate")
            self.user_state("listening")
            await asyncio.wait_for(task, 5.0)
        self.assertEqual(self.interview._wrapup_counts()["wrap_beat_turns"], 1)
        # A turn committed inside the beat gets no reply of its own (L-WRAP invites it).
        self.assertTrue(await self.commit_turn("Thank you, that was fun."))
        # Nothing in flight: the beat alone, and none at all with the flag off.
        with mock.patch.object(r1_session, "WRAP_BEAT_SECONDS", 0.05):
            started = asyncio.get_running_loop().time()
            await self.interview._wrap_beat()
            self.assertGreaterEqual(asyncio.get_running_loop().time() - started, 0.04)
            with mock.patch.dict(os.environ, {"R1_WRAPUP_DECLINE_V2": "0"}):
                started = asyncio.get_running_loop().time()
                await self.interview._wrap_beat()
                self.assertLess(asyncio.get_running_loop().time() - started, 0.04)
        self.assertEqual(self.interview._wrapup_counts()["wrap_beat_turns"], 1)

    def test_the_counts_ride_along_in_session_facts_as_counts_only(self) -> None:
        facts = r1_session.session_facts_event(
            None,
            {},
            roleplay_seconds=1.0,
            wrapup={"wrapup_more_asked": 1, "wrapup_hiring_team_drops": 2, "text": "never sent",
                    "wrap_beat_turns": -1},
        )["payload"]["wrapup"]
        self.assertEqual(facts["wrapup_more_asked"], 1)
        self.assertEqual(facts["wrapup_hiring_team_drops"], 2)
        self.assertIsNone(facts["wrap_beat_turns"])
        self.assertNotIn("text", facts)
        self.assertIsNone(facts["wrapup_affirmations"])


class TestUnknownAndSpokenFirstName(R1TestCase):
    """R1-Q item 6: "Thank you, there." is never spoken; the name the candidate gave is used.

    The API sends the literal "there" for a name it cannot use, and the lines that splice the
    name in read badly with it.  An unknown name drops out of the line; when the candidate says
    their own name in the opening or the icebreaker, later lines use it.
    """

    LINE_CONTEXT = {"first_name": "there", "candidate_identity": "candidate"}
    NAME_LINES = ("L-OPEN", "L-TRANSITION", "L-CLOSE", "L-SIL-IB", "L-REJOIN", "L-SYSTEM-STOP")

    def spoken_lines(self) -> dict[str, str]:
        return {line_id: self.interview.render_line(line_id) for line_id in self.NAME_LINES}

    async def test_the_placeholder_name_is_dropped_from_every_line(self) -> None:
        rendered = self.spoken_lines()
        self.assertTrue(rendered["L-OPEN"].startswith("Hi, I'm Dex,"))
        self.assertTrue(rendered["L-TRANSITION"].startswith("Thank you. Next, let's do a sales"))
        self.assertIn("for your time today. The hiring team", rendered["L-CLOSE"])
        self.assertEqual(rendered["L-SIL-IB"], "Are you still with me?")
        self.assertEqual(rendered["L-REJOIN"], "Welcome back. Let's pick up where we left off.")
        self.assertTrue(rendered["L-SYSTEM-STOP"].startswith("I'm sorry, we need to stop here"))
        for line_id, text in rendered.items():
            with self.subTest(line=line_id):
                self.assertNotIn("there", text)
                self.assertNotIn("{", text)

    async def test_an_empty_or_unusable_record_name_is_unknown_too(self) -> None:
        for value in ("", None, "THERE", "A", "Ar<script>"):
            with self.subTest(value=value):
                self.interview.context["first_name"] = value
                self.assertEqual(self.interview.render_line("L-SIL-IB"), "Are you still with me?")

    async def test_a_usable_record_name_is_spoken_and_the_candidate_cannot_replace_it(self) -> None:
        self.interview.context["first_name"] = "Asha"
        self.assertEqual(self.interview.render_line("L-SIL-IB"), "Are you still with me, Asha?")
        await self.answer("Hi, my name is Cristo and I sell courses.")
        self.assertEqual(self.interview.render_line("L-SIL-IB"), "Are you still with me, Asha?")

    async def test_the_name_the_candidate_gives_is_used_in_the_later_lines(self) -> None:
        await self.answer("Yeah, so my name is Cristo, and I have eleven years in sales.")
        rendered = self.spoken_lines()
        self.assertEqual(rendered["L-SIL-IB"], "Are you still with me, Cristo?")
        self.assertTrue(rendered["L-TRANSITION"].startswith("Thank you, Cristo. Next, let's do"))
        self.assertIn("for your time today, Cristo. The hiring team", rendered["L-CLOSE"])
        self.assertEqual(
            rendered["L-REJOIN"], "Welcome back, Cristo. Let's pick up where we left off."
        )
        self.assertTrue(rendered["L-SYSTEM-STOP"].startswith("I'm sorry, Cristo, we need to stop"))

    async def test_the_first_introduction_wins(self) -> None:
        await self.answer("My name is Cristo.")
        await self.answer("Myself Bina, I mean.")  # a valid introduction, but the second one
        self.assertEqual(self.interview.render_line("L-SIL-IB"), "Are you still with me, Cristo?")

    async def test_the_introduction_may_be_split_across_the_speech_to_texts_finals(self) -> None:
        self.final_transcript("Hello, my name is")
        self.final_transcript("Cristo.")
        await self.settle()
        self.assertEqual(self.interview.render_line("L-SIL-IB"), "Are you still with me, Cristo?")

    async def test_a_remark_in_the_roleplay_is_not_an_introduction(self) -> None:
        self.enter_roleplay()  # the rig starts in the icebreaker, where the same words count
        self.final_transcript("My name is Cristo.")
        await self.settle()
        self.assertEqual(self.interview.render_line("L-SIL-IB"), "Are you still with me?")

    async def test_words_that_only_look_like_an_introduction_are_not_a_name(self) -> None:
        for text in (
            "I taught myself Python.",
            "This is great, honestly.",
            "I worked at a firm where this is Salesforce.",
            "My name is not on the list.",
            "I'm Cristo.",
        ):
            with self.subTest(text=text):
                await self.answer(text)
                self.assertEqual(self.interview.render_line("L-SIL-IB"), "Are you still with me?")

    async def test_a_name_that_belongs_to_the_learner_or_the_interviewer_is_not_adopted(self) -> None:
        variant = self.interview.persona.variant
        for name in (variant.first_name, variant.last_name, "Christy", "Dex"):
            with self.subTest(name=name):
                await self.answer(f"Hello, my name is {name}.")
                self.assertEqual(self.interview.render_line("L-SIL-IB"), "Are you still with me?")

    async def test_dex_introduction_is_not_adopted(self) -> None:
        self.interview.machine.phase = R1Phase.OPENING
        self.interview._learn_spoken_name("This is Dex.")
        self.assertEqual(self.interview.render_line("L-SIL-IB"), "Are you still with me?")

    async def test_the_guard_may_repeat_the_name_the_candidate_gave(self) -> None:
        from r1_guard import guard_text
        from r1_personas import PERSONAS

        chosen = self.interview.persona.variant
        # The first name of a persona this session is NOT playing: the guard blocks it in the
        # interviewer's mouth after the reveal, unless it is the candidate's own name.
        other = next(
            v.first_name
            for p in PERSONAS
            for v in p.variants
            if v.first_name not in (chosen.first_name, chosen.last_name)
        )
        engine = self.interview.engine  # built before the name is known
        self.assertEqual(engine.candidate_first_name, "")
        blocked = guard_text(f"Thanks, {other}.", engine.guard_context("wrapup"))
        self.assertNotEqual(blocked.text, f"Thanks, {other}.")
        await self.answer(f"Hi, my name is {other}.")
        self.assertEqual(engine.candidate_first_name, other)
        allowed = guard_text(f"Thanks, {other}.", engine.guard_context("wrapup"))
        self.assertEqual(allowed.text, f"Thanks, {other}.")

    async def test_an_engine_built_later_starts_with_the_name(self) -> None:
        await self.answer("Hi, my name is Cristo.")
        self.assertEqual(self.interview.engine.candidate_first_name, "Cristo")

    async def test_the_name_is_never_logged(self) -> None:
        with self.capture_logs() as logs:
            await self.answer("Hi, my name is Cristo and I sell courses.")
            self.interview.render_line("L-CLOSE")
        self.assertIn("r1_spoken_name_adopted", error_types(logs))
        self.assertNotIn("Cristo", json.dumps(logs))

    async def test_no_name_is_adopted_when_the_record_has_one(self) -> None:
        self.interview.context["first_name"] = "Asha"
        with self.capture_logs() as logs:
            await self.answer("Hi, my name is Cristo.")
        self.assertNotIn("r1_spoken_name_adopted", error_types(logs))


class TestIcebreakerEndRace(R1TestCase):
    """The soft exit (four turns, S >= 3:30) is decided at the end of a COMMITTED turn.

    The SDK commits a turn some 0.8-3 s after the candidate's last word.  The soft exit counts
    committed answers and is judged there (``prepare_turn``): when S crosses 3:30 while the
    4th answer is still being said, that turn's reply is suppressed and the driver is told.  The
    driver never ends the phase at a raw transcript: the transition line is uninterruptible, so
    starting it in the middle of an answer would talk over the candidate.
    """

    # Three words each: the floor for an answer (ICEBREAKER_ANSWER_MIN_WORDS).
    ANSWERS = ("one two three", "four five six", "seven eight nine", "ten eleven twelve")

    async def four_turns_with_the_soft_exit_due_in_between(self) -> asyncio.Task:
        self.clock.advance(209.6)
        task = asyncio.create_task(self.interview._run_icebreaker())
        await self.settle()
        for answer in self.ANSWERS[:3]:
            await self.answer(answer)  # committed before the soft exit is due
        self.final_transcript(self.ANSWERS[3])  # the 4th lands at S = 209.6: not over yet
        await self.settle()
        self.assertFalse(task.done())
        self.clock.advance(0.6)  # S = 210.2 when the SDK's end of turn arrives
        return task

    async def test_the_transition_follows_promptly_when_the_boundary_is_crossed_mid_turn(
        self,
    ) -> None:
        task = await self.four_turns_with_the_soft_exit_due_in_between()
        agent = R1Agent(self.interview)
        with self.assertRaises(r1_session.StopResponse):  # the reply is suppressed...
            await agent.on_user_turn_completed(
                None, SimpleNamespace(text_content=self.ANSWERS[3], id="msg_race")
            )
        started = asyncio.get_running_loop().time()
        # ...and the driver is woken: it ends the phase at once (the transition line plays)
        # instead of waiting out ICEBREAKER_PROMPT_SECONDS and asking "Are you still with me?".
        self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertLess(asyncio.get_running_loop().time() - started, 2.0)
        self.assertNotIn(self.spoken_line("L-SIL-IB"), self.session.spoken)
        self.assertEqual(self.session.spoken, [])

    async def test_a_driver_that_ends_the_phase_goes_on_to_the_transition_line(self) -> None:
        context = FakeContext(self.order)
        context.room.remote_participants["candidate"] = FakeParticipant("candidate")
        clock = Clock()
        session = FakeSession(log=self.order)
        interview = R1Interview(
            context,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            session,
            self.writer,
            clock=clock,
        )
        task = asyncio.create_task(interview.run())
        await self.pass_sound_check(session, interview)
        await self.until(lambda: interview.machine.phase is R1Phase.ICEBREAKER)
        clock.advance(209.6)
        agent = R1Agent(interview)
        for number, answer in enumerate(self.ANSWERS):
            session.emit("user_input_transcribed", final_event(answer))
            await self.settle()
            if number < 3:  # committed before the soft exit is due
                await agent.on_user_turn_completed(
                    None, SimpleNamespace(text_content=answer, id=f"msg_{number}")
                )
        clock.advance(0.6)
        with self.assertRaises(r1_session.StopResponse):
            await agent.on_user_turn_completed(
                None, SimpleNamespace(text_content=self.ANSWERS[3], id="msg_race")
            )
        await self.until(lambda: interview.machine.phase is R1Phase.TRANSITION)
        brief = interview.render_line(interview._thanked_brief_id())  # D3-ICE1: seeded thanks
        await self.until(lambda: ("play_end", brief) in self.order)
        self.assertNotIn(interview.render_line("L-SIL-IB"), session.spoken)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def four_answers_before_the_soft_exit(self) -> None:
        """Four committed answers at S = 205: the rule's turns are in, its clock is not (S < 3:30)."""
        self.clock.advance(205)
        for answer in self.ANSWERS:
            self.assertFalse(await self.answer(answer))  # none is a boundary turn yet
        self.clock.advance(10)  # S = 215: the soft exit is due from now on

    async def test_no_silence_prompt_is_spoken_once_the_soft_exit_is_due(self) -> None:
        await self.four_answers_before_the_soft_exit()
        outcome = await self.interview._silence_ladder([("L-SIL-IB", 20.0)])
        self.assertEqual(outcome, "phase_deadline")
        self.assertEqual(self.session.spoken, [])

    async def four_answered_turns_then_a_follow_up_question_plays(
        self, *, turn_ends_at: float, question_ends_at: float
    ) -> tuple[asyncio.Task, R1Agent]:
        """Four committed answers, the 4th turn ending at ``turn_ends_at`` (before the soft exit), and
        the interviewer's follow-up question playing until ``question_ends_at`` (S seconds)."""
        self.clock.advance(turn_ends_at)
        task = asyncio.create_task(self.interview._run_icebreaker())
        await self.settle()
        agent = R1Agent(self.interview)
        for answer in self.ANSWERS[:3]:
            await self.answer(answer, agent=agent)
        # The SDK's end of the 4th turn: S < 3:30, so the reply is NOT suppressed and the model asks.
        self.final_transcript(self.ANSWERS[3])
        await self.settle()
        await agent.on_user_turn_completed(
            None, SimpleNamespace(text_content=self.ANSWERS[3], id="msg_follow_up")
        )
        self.agent_state("thinking")
        self.agent_state("speaking")
        await self.settle()
        self.assertFalse(task.done())
        self.clock.advance(question_ends_at - turn_ends_at)  # S crosses 3:30 mid-question
        self.agent_state("listening")  # the question ends: every waiter is woken
        await self.settle()
        return task, agent

    async def test_a_follow_up_question_finishing_after_the_soft_exit_is_still_answered(
        self,
    ) -> None:
        # Fix-branch regression: the end of turn fell at S=205, the follow-up question finished
        # at S=211, and the wake-up read "soft exit due" as "phase over": L-TRANSITION played
        # right after the interviewer's own question, which the candidate never got to answer.
        task, agent = await self.four_answered_turns_then_a_follow_up_question_plays(
            turn_ends_at=205.0, question_ends_at=211.0
        )
        self.assertFalse(task.done())  # still waiting for the answer
        self.assertIs(self.interview.machine.phase, R1Phase.ICEBREAKER)
        self.assertEqual(self.session.spoken, [])
        self.assertGreater(self.interview._icebreaker_budget_left(), 0)
        # The answer's transcript alone does not end the phase (it may be half an answer); the
        # turn the SDK commits does, and it is the boundary turn the transition line answers.
        self.final_transcript("five six seven")
        await self.settle()
        self.assertFalse(task.done())
        self.assertTrue(await self.commit_turn("five six seven", agent=agent))
        self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(self.session.spoken, [])

    async def test_the_candidate_starting_an_answer_after_the_soft_exit_is_not_talked_over(
        self,
    ) -> None:
        # The question ended at S=208, the candidate started answering at S=211: the wake-up
        # from their speaking must not play the (non-interruptible) boundary line over them.
        task, agent = await self.four_answered_turns_then_a_follow_up_question_plays(
            turn_ends_at=205.0, question_ends_at=208.0
        )
        self.clock.advance(3)  # S = 211
        self.user_state("speaking")
        await self.settle()
        self.assertFalse(task.done())
        self.assertIs(self.interview.machine.phase, R1Phase.ICEBREAKER)
        self.assertEqual(self.session.spoken, [])
        self.final_transcript("five six seven")
        self.user_state("listening")
        await self.settle()
        self.assertFalse(task.done())  # a final is half an answer until the SDK commits it
        self.assertTrue(await self.commit_turn("five six seven", agent=agent))
        self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(self.session.spoken, [])

    async def test_a_raw_final_never_ends_the_icebreaker_even_when_the_exit_is_due(self) -> None:
        # The owner's session: a fragment final at S >= 3:30 started the uninterruptible
        # transition line while the candidate was still answering.
        task, _agent = await self.four_answered_turns_then_a_follow_up_question_plays(
            turn_ends_at=205.0, question_ends_at=211.0
        )
        for fragment in ("and that is why", "I moved into", "this kind of work"):
            self.final_transcript(fragment)
            await self.settle()
            self.assertFalse(task.done())
        self.assertEqual(self.session.spoken, [])
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_only_the_suppressed_boundary_turn_zeroes_the_icebreaker_budget(self) -> None:
        await self.four_answers_before_the_soft_exit()
        self.assertTrue(self.interview.machine.icebreaker_should_end())
        # The soft-exit rule alone is not the end of the phase for a waiter: 55 s remain.
        self.assertEqual(self.interview._icebreaker_budget_left(), 55)
        agent = R1Agent(self.interview)
        with self.assertRaises(r1_session.StopResponse):  # this turn IS the boundary turn
            await agent.on_user_turn_completed(
                None, SimpleNamespace(text_content="five six seven", id="msg_boundary")
            )
        self.assertEqual(self.interview._icebreaker_budget_left(), 0)

    async def test_an_empty_turn_after_the_soft_exit_is_not_a_boundary_turn(self) -> None:
        await self.four_answers_before_the_soft_exit()
        agent = R1Agent(self.interview)
        with self.assertRaises(r1_session.StopResponse):
            await agent.on_user_turn_completed(None, SimpleNamespace(text_content="", id="m"))
        self.assertEqual(self.interview._icebreaker_budget_left(), 55)

    async def test_the_icebreaker_still_waits_for_an_answer_before_the_soft_exit(self) -> None:
        self.clock.advance(100)
        task = asyncio.create_task(self.interview._run_icebreaker())
        await self.settle()
        self.interview._wake()  # a stray wake-up is not the end of the phase
        await self.settle()
        self.assertFalse(task.done())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task


class TestIcebreakerHardCapWaitsForTheAnswerInFlight(R1TestCase):
    """The S=4:30 cap is the phase's deadline, not the candidate's: it never talks over an answer.

    The transition line is uninterruptible, so starting it while the candidate is mid-answer
    discards what they say.  The cap waits for the turn in flight to commit, but only briefly:
    one endpointing maximum plus a second after the last sign of speech, and 30 s in all.
    """

    GRACE = 3.0 + 1.0  # R1_ENDPOINT_MAX_DELAY_SEC default + ICEBREAKER_HOLD_MARGIN_SECONDS

    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in ("R1_ENDPOINT_MIN_DELAY_SEC", "R1_ENDPOINT_MAX_DELAY_SEC"):
            os.environ.pop(key, None)

    async def test_past_the_cap_with_nobody_mid_turn_the_budget_is_zero(self) -> None:
        self.clock.advance(271)
        self.assertEqual(self.interview._icebreaker_budget_left(), 0)

    async def test_a_speaking_candidate_is_given_the_endpointing_window(self) -> None:
        self.clock.advance(271)
        self.user_state("speaking")
        self.assertEqual(self.interview._icebreaker_budget_left(), self.GRACE)
        self.clock.advance(2.0)  # still speaking: the window is renewed, not spent
        self.assertEqual(self.interview._icebreaker_budget_left(), self.GRACE)

    async def test_an_uncommitted_final_holds_the_cap_until_the_window_after_it_runs_out(self) -> None:
        self.clock.advance(271)
        self.final_transcript("and that is how I would handle it")
        self.assertEqual(self.interview._icebreaker_budget_left(), self.GRACE)
        self.clock.advance(3.0)
        self.assertAlmostEqual(self.interview._icebreaker_budget_left(), 1.0)
        self.clock.advance(1.5)
        self.assertEqual(self.interview._icebreaker_budget_left(), 0)

    async def test_the_hold_never_lasts_beyond_its_ceiling(self) -> None:
        self.clock.advance(271)
        self.user_state("speaking")
        self.assertGreater(self.interview._icebreaker_budget_left(), 0)
        self.clock.advance(29.5)
        self.assertAlmostEqual(self.interview._icebreaker_budget_left(), 0.5)
        self.clock.advance(1.0)
        self.assertEqual(self.interview._icebreaker_budget_left(), 0)

    async def test_the_hold_starts_afresh_for_the_next_turn(self) -> None:
        self.clock.advance(271)
        self.user_state("speaking")
        self.interview._icebreaker_budget_left()
        self.user_state("listening")
        self.clock.advance(100)  # nobody mid-turn for a long time: the ceiling is forgotten
        self.assertEqual(self.interview._icebreaker_budget_left(), 0)
        self.user_state("speaking")
        self.assertEqual(self.interview._icebreaker_budget_left(), self.GRACE)

    async def test_the_driver_does_not_leave_while_the_candidate_is_still_speaking(self) -> None:
        self.clock.advance(268)
        task = asyncio.create_task(self.interview._run_icebreaker())
        await self.settle()
        self.user_state("speaking")
        self.clock.advance(4.0)  # S = 272: the cap has passed in the middle of the answer
        self.interview._wake()
        await self.settle()
        self.assertFalse(task.done())
        self.assertEqual(self.session.spoken, [])
        self.final_transcript("so that is what I would do")
        self.user_state("listening")
        await self.settle()
        self.assertFalse(task.done())  # the final is half an answer until the SDK commits it
        self.assertTrue(await self.commit_turn("so that is what I would do"))  # the boundary turn
        self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(self.session.spoken, [])

    async def test_a_turn_the_sdk_never_commits_cannot_hold_the_phase_open(self) -> None:
        self.clock.advance(268)
        task = asyncio.create_task(self.interview._run_icebreaker())
        await self.settle()
        self.clock.advance(4.0)  # S = 272
        self.final_transcript("Yes")  # a fragment the SDK banks and never commits
        await self.settle()
        self.assertFalse(task.done())
        self.clock.advance(self.GRACE + 0.1)
        self.interview._wake()
        self.assertIsNone(await asyncio.wait_for(task, 5.0))


class TestSoftExitBoundaryWaitsForTheAnswerInFlight(R1TestCase):
    """The boundary turn ends the icebreaker, but not over a candidate who goes on speaking.

    The SDK commits a turn at its endpoint (0.8 s after a sentence that sounds finished); a
    candidate who pauses that long and goes on is mid-answer again when the commit arrives.  The
    transition line is uninterruptible and discards their audio, so the boundary waits for them
    exactly as the hard S=4:30 cap does: until the continued speech is committed (and answered by
    the transition line in its turn), bounded by the endpointing maximum plus a second, and by 30 s.
    """

    GRACE = 3.0 + 1.0  # R1_ENDPOINT_MAX_DELAY_SEC default + ICEBREAKER_HOLD_MARGIN_SECONDS

    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in ("R1_ENDPOINT_MIN_DELAY_SEC", "R1_ENDPOINT_MAX_DELAY_SEC"):
            os.environ.pop(key, None)

    LAST = TestIcebreakerEndRace.ANSWERS[3]

    async def due_and_driving(self) -> asyncio.Task:
        """The driver waits; the 4th answer's final has landed at S = 205 and S passes 3:30 before
        the SDK commits it, so that commit is the boundary turn (not yet committed here)."""
        self.clock.advance(205)
        task = asyncio.create_task(self.interview._run_icebreaker())
        await self.settle()
        for answer in TestIcebreakerEndRace.ANSWERS[:3]:
            self.assertFalse(await self.answer(answer))
        self.final_transcript(self.LAST)
        await self.settle()
        self.clock.advance(10)  # S = 215
        self.assertFalse(task.done())
        return task

    async def test_a_boundary_commit_while_the_candidate_goes_on_speaking_is_not_talked_over(
        self,
    ) -> None:
        task = await self.due_and_driving()
        self.user_state("speaking")  # they paused 0.8 s, the SDK committed, they went on
        self.assertTrue(await self.commit_turn(self.LAST))  # suppressed: the boundary turn
        self.assertTrue(self.interview._icebreaker_boundary_turn)
        self.assertEqual(self.interview._icebreaker_budget_left(), self.GRACE)
        await self.settle()
        self.assertFalse(task.done())
        self.assertEqual(self.session.spoken, [])  # the transition line has NOT started
        self.final_transcript("and the other thing I did was")
        self.user_state("listening")
        await self.settle()
        self.assertFalse(task.done())  # half an answer until the SDK commits it
        self.assertTrue(await self.commit_turn("and the other thing I did was"))
        self.assertIsNone(await asyncio.wait_for(task, 5.0))  # now the transition line plays
        self.assertEqual(self.session.spoken, [])

    async def test_a_boundary_commit_with_nobody_mid_turn_still_ends_the_phase_at_once(self) -> None:
        task = await self.due_and_driving()
        self.assertTrue(await self.commit_turn(self.LAST))
        self.assertEqual(self.interview._icebreaker_budget_left(), 0)
        self.assertIsNone(await asyncio.wait_for(task, 5.0))

    async def test_a_final_that_the_sdk_has_not_committed_holds_the_boundary_too(self) -> None:
        task = await self.due_and_driving()
        self.assertTrue(await self.commit_turn(self.LAST))
        self.assertIsNone(await asyncio.wait_for(task, 5.0))  # nobody mid-turn: over
        # Same state, but a final of the continued speech was heard before the driver looked.
        self.interview._icebreaker_boundary_turn = True
        self.final_transcript("and one more thing")
        self.assertEqual(self.interview._icebreaker_budget_left(), self.GRACE)

    async def test_continued_speech_that_is_never_committed_cannot_hold_the_phase_open(self) -> None:
        task = await self.due_and_driving()
        self.user_state("speaking")
        self.assertTrue(await self.commit_turn(self.LAST))
        self.final_transcript("and one more thing")  # a fragment the SDK banks and never commits
        self.user_state("listening")
        await self.settle()
        self.assertFalse(task.done())
        self.clock.advance(self.GRACE + 0.1)
        self.interview._wake()
        self.assertIsNone(await asyncio.wait_for(task, 5.0))

    async def test_the_boundary_hold_never_lasts_beyond_its_ceiling(self) -> None:
        await self.due_and_driving()
        self.user_state("speaking")
        self.assertTrue(await self.commit_turn(self.LAST))
        self.assertEqual(self.interview._icebreaker_budget_left(), self.GRACE)
        self.clock.advance(29.5)  # still speaking: the window is renewed, up to the ceiling
        self.assertAlmostEqual(self.interview._icebreaker_budget_left(), 0.5)
        self.clock.advance(1.0)
        self.assertEqual(self.interview._icebreaker_budget_left(), 0)


class TestRepliesCancelledBeforeAnyAudio(R1TestCase):
    """The owner's 4/10 session lost three replies to "Sorry", "Thank you" and "Hey, are you there?"

    The candidate heard nothing and the transcript showed no bot turn.  The SDK reports such a
    reply as a speech that ended ``interrupted`` without ever speaking; R1 counts and logs it
    (no text), and when the icebreaker's exit is due the lost turn is answered by the transition.
    """

    def create_reply(self, source: str = "generate_reply") -> FakeSpeechHandle:
        handle = FakeSpeechHandle("a reply")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source=source, user_initiated=False),
        )
        return handle

    @staticmethod
    def lost(logs: list[dict]) -> list[dict]:
        return [entry for entry in logs if entry.get("error_type") == "r1_reply_cancelled_before_audio"]

    async def test_a_reply_cancelled_before_it_spoke_is_logged_with_a_running_count(self) -> None:
        with self.capture_logs() as logs:
            for _ in range(2):
                handle = self.create_reply()
                handle.interrupted = True
                handle.finish()
        lines = self.lost(logs)
        self.assertEqual([entry["option_count"] for entry in lines], [1, 2])
        self.assertEqual(lines[0]["phase"], "icebreaker")
        self.assertEqual(set(lines[0]) - {"timestamp", "level", "component", "event", "correlationId"},
                         {"error_type", "phase", "option_count"})
        self.assertEqual(self.interview._replies_cancelled_before_audio, 2)

    async def test_a_reply_that_began_speaking_is_not_a_lost_reply(self) -> None:
        handle = self.create_reply()
        self.session.current_speech = handle
        self.agent_state("speaking")  # claims its transcript position: the candidate heard it
        with self.capture_logs() as logs:
            handle.interrupted = True
            handle.finish()
        self.assertEqual(self.lost(logs), [])

    async def test_a_reply_that_finished_unharmed_is_not_a_lost_reply(self) -> None:
        handle = self.create_reply()
        with self.capture_logs() as logs:
            handle.finish()
        self.assertEqual(self.lost(logs), [])

    async def test_a_scripted_line_is_not_a_lost_reply(self) -> None:
        handle = self.create_reply("say")
        handle.interrupted = True
        with self.capture_logs() as logs:
            handle.finish()
        self.assertEqual(self.lost(logs), [])

    async def test_nothing_is_counted_once_the_exit_has_begun(self) -> None:
        handle = self.create_reply()
        self.interview._begin_exit()
        handle.interrupted = True
        with self.capture_logs() as logs:
            handle.finish()
        self.assertEqual(self.lost(logs), [])

    async def test_a_lost_reply_when_the_exit_is_due_is_answered_by_the_transition(self) -> None:
        self.clock.advance(205)
        task = asyncio.create_task(self.interview._run_icebreaker())
        await self.settle()
        for answer in TestIcebreakerEndRace.ANSWERS:
            self.assertFalse(await self.answer(answer))
        handle = self.create_reply()  # the 4th turn's reply is being thought of...
        self.clock.advance(10)  # ...and S crosses 3:30 meanwhile
        await self.settle()
        self.assertFalse(task.done())
        handle.interrupted = True  # ...then it is cancelled before any audio
        handle.finish()
        self.assertIsNone(await asyncio.wait_for(task, 5.0))  # the transition speaks, not silence
        self.assertEqual(self.session.spoken, [])

    async def test_a_lost_reply_before_the_exit_is_due_changes_nothing(self) -> None:
        self.clock.advance(100)
        task = asyncio.create_task(self.interview._run_icebreaker())
        await self.settle()
        handle = self.create_reply()
        handle.interrupted = True
        handle.finish()
        await self.settle()
        self.assertFalse(task.done())
        self.assertFalse(self.interview._icebreaker_boundary_turn)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_a_lost_reply_while_the_candidate_is_mid_turn_leaves_the_decision_to_the_commit(
        self,
    ) -> None:
        self.clock.advance(215)
        for answer in TestIcebreakerEndRace.ANSWERS:
            self.interview.machine.candidate_turns += 1
        self.user_state("speaking")
        handle = self.create_reply()
        handle.interrupted = True
        handle.finish()
        self.assertFalse(self.interview._icebreaker_boundary_turn)


class TestBackchannelsOverAPendingReply(R1TestCase):
    """"Sorry" then "Thank you." is ONE committed turn of three words, and it cancels the pending reply.

    livekit-agents 1.6.4 refuses a turn of fewer than ``min_words`` words only while it can still
    cut the reply, and it KEEPS the refused words (``AudioRecognition`` clears its transcript when
    a turn is committed, not when one is refused): the next final is judged together with them
    (``AgentActivity.on_end_of_turn``).  So "Sorry" (1 word) is banked, "Thank you." (2) makes
    three, the SDK commits, and ``_user_turn_completed_task`` interrupts the reply it was still
    thinking of BEFORE it calls R1's hook.  ``min_words=3`` therefore stops one short fragment, not
    a sequence of them, and the owner's rows 12-14 still end in dead air.  R1 cannot stop the SDK
    from committing, so these tests pin what it does about the committed turn: it does not count
    it as an answer, it does not restart the candidate's wait for the next reply, and the reply it
    cost is counted in the p95.

    ``min_words`` 3 is the runbook's ROLLBACK since the owner chose voice barge-in (0 words) on
    2026-10-28, so the banking cases run at 3; ``TestBackchannelsAtZeroWords`` covers the default,
    where every one of these fragments is its own committed turn.
    """

    ANSWER = "I have been selling courses to working professionals for eleven years now"

    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {"R1_INTERRUPT_MIN_WORDS": "3"}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    async def hung_stream():
        await asyncio.Event().wait()
        yield "never"

    @staticmethod
    async def gated(gate: asyncio.Event, *items):
        await gate.wait()
        for item in items:
            yield item

    async def collect(self, stream) -> list:
        return [item async for item in self.interview.guard_llm_stream(stream)]

    async def reply_pending_for(self, text: str) -> tuple[FakeSpeechHandle, asyncio.Task]:
        """The candidate's answer is committed and the model starts to think of the reply."""
        self.final_transcript(text)
        await self.settle()
        self.assertFalse(await self.commit_turn(text))
        handle = FakeSpeechHandle("the reply")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
        )
        self.session.current_speech = handle
        generation = asyncio.create_task(self.collect(self.hung_stream()))
        await self.settle()
        return handle, generation

    async def sdk_commits(
        self, handle: FakeSpeechHandle, generation: asyncio.Task, text: str
    ) -> bool:
        """``_user_turn_completed_task``: cut the pending reply FIRST, then call the hook."""
        handle.interrupted = True
        generation.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await generation
        handle.finish()
        self.session.current_speech = None
        return await self.commit_turn(text)

    async def owner_sequence(self) -> tuple[FakeSpeechHandle, asyncio.Task]:
        """Rows 12-14 of the owner's session: an answer, its reply pending, "Sorry", "Thank you."."""
        handle, generation = await self.reply_pending_for(self.ANSWER)
        self.final_transcript("Sorry")
        await self.settle()
        self.assertTrue(self.interview._fragment_held_back())  # one word: refused and banked
        self.final_transcript("Thank you.")
        await self.settle()
        self.assertEqual(self.interview._banked_words, 3)
        self.assertFalse(self.interview._fragment_held_back())  # three words: the SDK commits
        return handle, generation

    def lost(self, logs: list[dict]) -> list[dict]:
        return [e for e in logs if e.get("error_type") == "r1_reply_cancelled_before_audio"]

    async def test_the_sdk_commits_sorry_and_thank_you_together_and_the_pending_reply_is_lost(
        self,
    ) -> None:
        handle, generation = await self.owner_sequence()
        with self.capture_logs() as logs:
            self.assertFalse(await self.sdk_commits(handle, generation, "Sorry Thank you."))
        # The reply was cut before it spoke: that is the owner's dead air, and it is logged.
        self.assertEqual(len(self.lost(logs)), 1)
        await self.flush()
        self.assertEqual(
            [r["text"] for r in self.writer.saved if r["speaker"] == "candidate"],
            [self.ANSWER, "Sorry Thank you."],
        )
        self.assertEqual(self.bot_rows(), [])  # and the candidate heard nothing

    async def test_that_committed_turn_is_not_an_answer(self) -> None:
        handle, generation = await self.owner_sequence()
        self.assertEqual(self.interview.machine.candidate_turns, 1)  # the real answer
        await self.sdk_commits(handle, generation, "Sorry Thank you.")
        self.assertEqual(self.interview.machine.candidate_turns, 1)  # not a second one

    async def test_noise_never_brings_the_soft_exit_closer(self) -> None:
        # Four turns of noise at S >= 3:30 used to END the icebreaker (each was three words or more).
        self.clock.advance(215)
        for noise in ("Sorry Thank you.", "Hey, are you there?", "Hmm. Okay. Right.", "Yes. Right, sure."):
            self.assertFalse(await self.answer(noise))  # the reply is not suppressed
        self.assertEqual(self.interview.machine.candidate_turns, 0)
        self.assertFalse(self.interview.machine.icebreaker_should_end())

    async def test_the_next_replys_filler_is_counted_from_the_real_answer(self) -> None:
        handle, generation = await self.owner_sequence()
        self.clock.advance(3.99)  # the candidate has waited this long when the SDK cuts the reply
        await self.sdk_commits(handle, generation, "Sorry Thank you.")
        with mock.patch.object(r1_session, "FILLER_RESTART_MIN_SECONDS", 0.02):
            guard = self.interview.guard_llm_stream(self.gated(asyncio.Event()))
            # Counted from the start of THIS generation the filler would come 4 s from now.
            first = await asyncio.wait_for(guard.__anext__(), 3.0)
            await guard.aclose()
        self.assertEqual(first, self.spoken_line("L-FILLER-INTERVIEWER") + " ")

    async def test_the_filler_keeps_a_floor_so_a_reply_about_to_arrive_is_not_pre_empted(
        self,
    ) -> None:
        handle, generation = await self.owner_sequence()
        self.clock.advance(3.99)
        await self.sdk_commits(handle, generation, "Sorry Thank you.")
        delay = self.interview._filler_delay()
        self.assertEqual(delay, r1_session.FILLER_RESTART_MIN_SECONDS)
        self.assertGreater(delay, 0.0)

    async def test_a_candidate_who_has_waited_only_a_little_gets_the_rest_of_the_four_seconds(
        self,
    ) -> None:
        handle, generation = await self.owner_sequence()
        self.clock.advance(1.0)
        await self.sdk_commits(handle, generation, "Sorry Thank you.")
        self.assertAlmostEqual(self.interview._filler_delay(), 3.0)

    async def test_without_a_cancelled_reply_the_filler_still_waits_its_full_four_seconds(
        self,
    ) -> None:
        guard = self.interview.guard_llm_stream(self.gated(asyncio.Event()))
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(guard.__anext__(), 0.3)
        self.assertEqual(r1_session.FILLER_AFTER_SECONDS, 4.0)
        self.interview._unvoiced_since = None
        self.assertEqual(self.interview._filler_delay(), 4.0)

    async def test_something_real_said_after_the_noise_starts_the_wait_afresh(self) -> None:
        handle, generation = await self.owner_sequence()
        self.clock.advance(3.5)
        await self.sdk_commits(handle, generation, "Sorry Thank you.")
        self.assertIsNotNone(self.interview._unvoiced_since)  # the wait is still the old one
        await self.answer("Actually I also spent two years in enterprise sales")
        self.assertIsNone(self.interview._unvoiced_since)
        self.assertEqual(self.interview._filler_delay(), 4.0)

    async def test_any_speech_that_begins_ends_the_wait(self) -> None:
        handle, generation = await self.owner_sequence()
        await self.sdk_commits(handle, generation, "Sorry Thank you.")
        self.assertIsNotNone(self.interview._unvoiced_since)
        self.interview._filler_delay()
        reply = FakeSpeechHandle("the next reply")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=reply, source="generate_reply", user_initiated=False),
        )
        self.session.current_speech = reply
        self.agent_state("speaking")  # the candidate hears something
        self.assertIsNone(self.interview._unvoiced_since)

    async def test_a_new_phase_is_a_new_wait(self) -> None:
        handle, generation = await self.owner_sequence()
        await self.sdk_commits(handle, generation, "Sorry Thank you.")
        self.assertIsNotNone(self.interview._unvoiced_since)
        self.interview._enter(R1Phase.TRANSITION)
        self.assertIsNone(self.interview._unvoiced_since)

    async def test_an_old_wait_is_not_the_current_one(self) -> None:
        handle, generation = await self.owner_sequence()
        await self.sdk_commits(handle, generation, "Sorry Thank you.")
        self.clock.advance(r1_session.FILLER_ANCHOR_MAX_SECONDS + 1.0)
        self.assertEqual(self.interview._filler_delay(), 4.0)

    async def test_the_anchor_never_makes_the_filler_later_than_the_plain_four_seconds(self) -> None:
        self.interview._unvoiced_since = 0.0
        for waited in (0.0, 0.1, 2.0, 3.9, 4.0, 10.0, 19.9):
            self.clock.value = waited
            self.interview._unvoiced_since = 0.0
            delay = self.interview._filler_delay()
            self.assertLessEqual(delay, 4.0, waited)
            self.assertGreaterEqual(delay, min(0.5, 4.0), waited)

    async def test_a_clock_that_stepped_back_is_not_a_wait(self) -> None:
        self.interview._unvoiced_since = 100.0  # the manual clock reads 0.0
        self.assertEqual(self.interview._filler_delay(), 4.0)

    # ------------------------------------------------ the p95 does not lose the cancelled turn

    async def roleplay_turn_with_a_reply_pending(self) -> tuple[FakeSpeechHandle, int | None]:
        self.enter_roleplay()
        self.final_transcript("Hi Meera, thanks for taking my call today")
        await self.settle()
        self.assertFalse(await self.commit_turn("Hi Meera, thanks for taking my call today"))
        handle = FakeSpeechHandle("the learner's reply")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
        )
        return handle, self.interview._latency.open_turn_id()

    async def test_a_cancelled_role_play_reply_adds_its_wait_to_the_p95_as_a_lower_bound(self) -> None:
        tracker = self.interview._latency
        for number in range(8):  # eight prompt answers, 1 s each
            self.clock.advance(10.0)
            tracker.begin_turn(100 + number, "roleplay")
            self.clock.advance(1.0)
            tracker.first_audio()
        self.assertEqual(tracker.first_audio_p95_ms(), 1000)
        handle, _turn = await self.roleplay_turn_with_a_reply_pending()
        with self.capture_logs() as logs:
            self.clock.advance(6.0)  # the candidate has waited 6 s when the reply is cut
            handle.interrupted = True
            handle.finish()
        self.assertEqual(tracker.replies_lost("roleplay"), 1)
        self.assertEqual(tracker.first_audio_samples(), 9)
        self.assertEqual(tracker.first_audio_p95_ms(), 6000)  # it can no longer look fast
        (line_,) = [e for e in logs if e.get("schema") == "eou_to_reply_lost"]
        self.assertEqual((line_["phase"], line_["duration_sec"]), ("roleplay", 6.0))

    async def test_audio_that_plays_afterwards_is_not_that_turns_first_audio(self) -> None:
        tracker = self.interview._latency
        handle, _turn = await self.roleplay_turn_with_a_reply_pending()
        self.clock.advance(5.0)
        handle.interrupted = True
        handle.finish()
        samples = tracker.first_audio_samples(None)
        self.clock.advance(1.0)
        later = FakeSpeechHandle("an unrelated scripted line")
        self.session.current_speech = later
        self.agent_state("speaking")  # some speech starts before the next turn is opened
        self.assertEqual(tracker.first_audio_samples(None), samples)

    async def test_the_session_posts_the_count_of_lost_replies_beside_the_p95(self) -> None:
        handle, _turn = await self.roleplay_turn_with_a_reply_pending()
        self.clock.advance(5.0)
        handle.interrupted = True
        handle.finish()
        with self.capture_logs() as logs:
            self.assertIsNone(self.interview._first_audio_p95_ms())  # one turn: unknown, not a number
        lost = [e for e in logs if e.get("error_category") == "lost_replies"]
        self.assertEqual([e["option_count"] for e in lost], [1])

    async def test_a_reply_that_spoke_is_not_counted_as_lost(self) -> None:
        tracker = self.interview._latency
        handle, _turn = await self.roleplay_turn_with_a_reply_pending()
        self.clock.advance(1.0)
        self.session.current_speech = handle
        self.agent_state("speaking")  # the candidate hears it
        handle.interrupted = True  # cut later, while speaking
        handle.finish()
        self.assertEqual(tracker.replies_lost(None), 0)
        self.assertEqual(tracker.first_audio_samples(None), 1)

    async def test_a_lost_reply_does_not_pay_for_another_turns_wait(self) -> None:
        # The reply is tied to the turn that was open when it was created, not to the newest turn.
        tracker = self.interview._latency
        handle, turn = await self.roleplay_turn_with_a_reply_pending()
        self.clock.advance(2.0)
        await self.answer("and the second part of my opening pitch")  # a newer turn opens
        self.clock.advance(1.0)
        handle.interrupted = True  # the OLD reply is cut afterwards
        handle.finish()
        self.assertEqual(tracker.replies_lost(None), 1)
        (sample,) = [s for s in tracker._headline if s[1] > 2.5]
        self.assertAlmostEqual(sample[1], 3.0)  # the old turn's own wait, not the new one's
        self.assertIsNotNone(turn)


class TestBackchannelsAtZeroWords(R1TestCase):
    """Voice barge-in (owner decision 2026-10-28): ``min_words`` 0, nothing is refused or banked.

    A lone "Sorry" over a pending reply is committed on its own and cancels the reply (the SDK
    applies no word floor at 0).  What R1 does about that turn is unchanged from the 3-word case:
    it is not an answer, the candidate's wait is not restarted, and the lost reply counts in the
    p95 as a lower bound.
    """

    ANSWER = TestBackchannelsOverAPendingReply.ANSWER
    hung_stream = staticmethod(TestBackchannelsOverAPendingReply.hung_stream)
    collect = TestBackchannelsOverAPendingReply.collect
    reply_pending_for = TestBackchannelsOverAPendingReply.reply_pending_for
    sdk_commits = TestBackchannelsOverAPendingReply.sdk_commits
    lost = TestBackchannelsOverAPendingReply.lost

    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("R1_INTERRUPT_MIN_WORDS", None)  # the default

    async def test_a_single_sorry_is_not_held_back_and_its_own_turn_cancels_the_reply(self) -> None:
        handle, generation = await self.reply_pending_for(self.ANSWER)
        self.final_transcript("Sorry")
        await self.settle()
        self.assertFalse(self.interview._fragment_held_back())  # nothing is banked at 0
        self.clock.advance(2.0)
        with self.capture_logs() as logs:
            self.assertFalse(await self.sdk_commits(handle, generation, "Sorry"))
        self.assertEqual(len(self.lost(logs)), 1)
        await self.flush()
        self.assertEqual(
            [r["text"] for r in self.writer.saved if r["speaker"] == "candidate"],
            [self.ANSWER, "Sorry"],  # its own row, not prepended to a later turn
        )
        self.assertEqual(self.interview.machine.candidate_turns, 1)  # not an answer
        self.assertIsNotNone(self.interview._unvoiced_since)  # the old wait keeps running
        self.assertAlmostEqual(self.interview._filler_delay(), 2.0)

    async def test_the_lost_reply_still_counts_in_the_p95_at_zero_words(self) -> None:
        tracker = self.interview._latency
        self.enter_roleplay()
        for number in range(8):
            self.clock.advance(10.0)
            tracker.begin_turn(100 + number, "roleplay")
            self.clock.advance(1.0)
            tracker.first_audio()
        handle, generation = await self.reply_pending_for(self.ANSWER)
        self.final_transcript("Okay")
        await self.settle()
        self.clock.advance(6.0)
        await self.sdk_commits(handle, generation, "Okay")
        self.assertEqual(tracker.replies_lost("roleplay"), 1)
        self.assertEqual(tracker.first_audio_p95_ms(), 6000)

    async def test_a_learner_reply_lost_to_an_okay_is_planned_again(self) -> None:
        # Reviewed fix: the lost reply's plan (its ask, its commitment line) is the answer still
        # owed, so the lone "Okay." that cancelled it gets that same plan, not a fresh free reply.
        self.enter_roleplay()
        engine = self.interview.engine
        with mock.patch.object(engine, "reply_lost", wraps=engine.reply_lost) as lost, \
                mock.patch.object(self.interview, "_spawn_judge") as judge:
            handle, generation = await self.reply_pending_for(self.ANSWER)
            planned = self.interview._last_reply.plan
            self.final_transcript("Okay.")
            await self.settle()
            self.assertFalse(await self.sdk_commits(handle, generation, "Okay."))
        lost.assert_called_once_with(planned)
        again = self.interview._last_reply.plan
        self.assertIn("replanned_after_lost_reply", again.reasons)
        self.assertEqual(again.turn, planned.turn)
        # The turn was judged on the real answer; the "Okay." is not judged for it a second time.
        self.assertEqual([c.args[0] for c in judge.call_args_list], [self.ANSWER])

    async def test_a_reply_that_was_heard_or_not_a_role_play_reply_is_not_lost(self) -> None:
        engine = self.interview.engine
        with mock.patch.object(engine, "reply_lost") as lost, mock.patch.object(
            engine, "record_spoken", wraps=engine.record_spoken
        ) as spoken:
            # The icebreaker: Christy's reply has no role-play plan.
            handle, generation = await self.reply_pending_for(self.ANSWER)
            await self.sdk_commits(handle, generation, "Okay.")
            self.enter_roleplay()
            # A learner reply cut after some of its words were heard (a barge-in cut): the SDK
            # adds the item with the synchronised words inside the reply task, before the handle
            # is done, so the engine records what was said.
            handle, generation = await self.reply_pending_for(self.ANSWER)
            planned = self.interview._last_reply.plan
            self.agent_state("speaking")
            message = FakeChatMessage("Honestly I keep wondering whether I could", interrupted=True)
            self.session.emit("conversation_item_added", SimpleNamespace(item=message))
            handle.chat_items.append(message)
            await self.sdk_commits(handle, generation, "Okay.")
        lost.assert_not_called()
        self.assertEqual([c.args[0] for c in spoken.call_args_list], [planned])
        self.assertTrue(spoken.call_args.kwargs["interrupted"])

    async def test_a_learner_reply_cut_after_its_first_audio_but_before_a_word_is_lost(
        self,
    ) -> None:
        # Reviewed fix: the first audio frame claimed the slot ("speaking"), but the candidate's
        # "Okay." cut the reply before any word was synchronised, so the SDK added no item
        # (forwarded text ""): neither reply_lost nor record_spoken reached the engine, and the
        # plan's ask, next-step question and commitment line were used up as if heard.
        self.enter_roleplay()
        engine = self.interview.engine
        tracker = self.interview._latency
        with mock.patch.object(engine, "reply_lost", wraps=engine.reply_lost) as lost, \
                mock.patch.object(engine, "record_spoken", wraps=engine.record_spoken) as spoken, \
                mock.patch.object(self.interview, "_spawn_judge"):
            handle, generation = await self.reply_pending_for(self.ANSWER)
            planned = self.interview._last_reply.plan
            self.session.current_speech = handle
            self.agent_state("speaking")  # the first audio frame played: the slot is claimed
            self.final_transcript("Okay.")
            await self.settle()
            with self.capture_logs() as logs:
                self.assertFalse(await self.sdk_commits(handle, generation, "Okay."))
        lost.assert_called_once_with(planned)
        spoken.assert_not_called()
        again = self.interview._last_reply.plan
        self.assertIn("replanned_after_lost_reply", again.reasons)
        self.assertEqual(again.turn, planned.turn)
        # The audio did start: it is not a reply cancelled before audio, for the count or the p95.
        self.assertEqual(self.lost(logs), [])
        self.assertEqual(tracker.replies_lost(None), 0)
        self.assertEqual(self.interview._replies_cancelled_before_audio, 0)
        await self.flush()
        self.assertEqual(self.bot_rows(), [])  # and no row: nothing of it was heard

    async def test_an_unheard_cut_is_reported_once_and_never_also_recorded(self) -> None:
        # The SDK adds an item only inside the reply task, before the handle is done; one that
        # arrived anyway after the done callback reported the plan lost finds no slot, so
        # record_spoken can never follow reply_lost for the same plan.
        self.enter_roleplay()
        engine = self.interview.engine
        with mock.patch.object(engine, "reply_lost") as lost, \
                mock.patch.object(engine, "record_spoken") as spoken:
            handle, generation = await self.reply_pending_for(self.ANSWER)
            reply = self.interview._last_reply
            self.session.current_speech = handle
            self.agent_state("speaking")
            await self.sdk_commits(handle, generation, "Okay.")
            self.assertTrue(reply.recorded)
            late = FakeChatMessage("Honestly", interrupted=True)
            self.session.emit("conversation_item_added", SimpleNamespace(item=late))
            self.interview._record_learner_speech(
                SimpleNamespace(reply=reply, cut_by_r1=False), "Honestly", True
            )
        lost.assert_called_once_with(reply.plan)
        spoken.assert_not_called()


class TestInterruptedLearnerRowKeepsOnlyWhatWasHeard(R1TestCase):
    """A learner line the candidate cut off is persisted ``interrupted`` with only the played text.

    The SDK hands R1 the assistant item with the text that was synchronised up to the cut and
    ``interrupted=True``; R1 writes that row, puts that same text in the learner's context, and
    tells the engine (``record_spoken(..., interrupted=True)``), whose next plan answers the
    candidate first.  ``backchannel`` reaches the engine from the worker's own judgement.
    """

    PLAYED = "Honestly I keep wondering whether I could"

    async def cut_learner(self) -> FakeSpeechHandle:
        if self.interview.machine.phase is not R1Phase.ROLEPLAY:
            self.enter_roleplay()
        self.assertFalse(await self.answer("Hi Meera, thanks for taking my call today"))
        handle = FakeSpeechHandle("the learner's reply")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
        )
        self.session.current_speech = handle
        self.agent_state("speaking")
        return handle

    def deliver_cut(self, handle: FakeSpeechHandle) -> None:
        message = FakeChatMessage(self.PLAYED, interrupted=True)
        self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        handle.chat_items.append(message)
        handle.interrupted = True
        handle.finish()
        self.session.current_speech = None
        self.agent_state("listening")

    async def test_the_row_is_interrupted_and_holds_only_what_was_played(self) -> None:
        handle = await self.cut_learner()
        with mock.patch.object(
            self.interview.engine, "record_spoken", wraps=self.interview.engine.record_spoken
        ) as record:
            self.final_transcript("Wait, can I ask something first?")
            self.deliver_cut(handle)
            await self.flush()
        (row,) = self.bot_rows()
        self.assertEqual((row["text"], row["interrupted"], row["phase"]), (self.PLAYED, True, "roleplay"))
        self.assertTrue(record.call_args.kwargs["interrupted"])
        self.assertEqual(record.call_args.args[1], self.PLAYED)
        learner = [e for e in self.interview._history if e["role"] == "bot"]
        self.assertEqual(learner[-1]["text"], self.PLAYED)  # her context sees what was heard
        # The candidate's turn that cut her is its own row, after hers.
        self.assertFalse(await self.commit_turn("Wait, can I ask something first?"))
        await self.flush()
        rows = sorted(self.writer.saved, key=lambda r: r["index"])
        self.assertEqual(
            [(r["speaker"], r["interrupted"]) for r in rows[-2:]],
            [("bot", True), ("candidate", False)],
        )
        from r1_prompts import INTERRUPTED_NOTE_V2 as INTERRUPTED_NOTE

        self.assertIn(INTERRUPTED_NOTE, self.interview._last_reply.plan.reminder)

    async def test_a_lone_yeah_that_cut_her_gets_her_point_finished(self) -> None:
        handle = await self.cut_learner()
        self.final_transcript("Yeah.")
        self.deliver_cut(handle)
        await self.settle()
        self.assertFalse(await self.commit_turn("Yeah."))
        plan = self.interview._last_reply.plan
        self.assertIn("backchannel_continuation", plan.reasons)
        self.assertIsNone(plan.move_id)

    async def test_a_line_that_played_out_is_not_a_cut_and_a_yeah_is_a_plain_turn(self) -> None:
        handle = await self.cut_learner()
        message = FakeChatMessage("Honestly I keep wondering whether I could do this.")
        self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        handle.chat_items.append(message)
        handle.finish()
        self.session.current_speech = None
        await self.flush()
        self.assertFalse(self.bot_rows()[0]["interrupted"])
        self.assertFalse(await self.answer("Yeah."))
        self.assertNotIn("backchannel_continuation", self.interview._last_reply.plan.reasons)

    async def test_a_real_answer_that_cut_her_is_not_a_backchannel(self) -> None:
        handle = await self.cut_learner()
        self.final_transcript("Yeah, so the course costs nine thousand dollars")
        self.deliver_cut(handle)
        await self.settle()
        self.assertFalse(await self.commit_turn("Yeah, so the course costs nine thousand dollars"))
        self.assertNotIn("backchannel_continuation", self.interview._last_reply.plan.reasons)

    async def plan_after_cut_by(self, text: str) -> Any:
        handle = await self.cut_learner()
        self.final_transcript(text)
        self.deliver_cut(handle)
        await self.settle()
        self.assertFalse(await self.commit_turn(text))
        return self.interview._last_reply.plan

    async def test_a_sorry_or_pardon_that_cut_her_gets_her_point_again(self) -> None:
        # Reviewed fix: "Sorry?" was planned as a backchannel and told not to repeat anything.
        for text in ("Sorry?", "Pardon?", "Sorry, can you say that again?", "Hello? You there?"):
            with self.subTest(text=text):
                plan = await self.plan_after_cut_by(text)
                self.assertIn("repeat_after_cut", plan.reasons)
                self.assertNotIn("backchannel_continuation", plan.reasons)

    async def test_an_uh_huh_or_a_hand_back_that_cut_her_gets_her_point_finished(self) -> None:
        for text in ("Uh-huh.", "Mm-hmm.", "Sorry, go ahead."):
            with self.subTest(text=text):
                plan = await self.plan_after_cut_by(text)
                self.assertIn("backchannel_continuation", plan.reasons)

    async def test_a_denial_or_a_yes_that_cut_her_is_answered_first(self) -> None:
        from r1_prompts import BACKCHANNEL_CUT_NOTE, INTERRUPTED_NOTE_V2 as INTERRUPTED_NOTE

        for text in ("No, no, no.", "Yes.", "Really?"):
            with self.subTest(text=text):
                plan = await self.plan_after_cut_by(text)
                self.assertNotIn("backchannel_continuation", plan.reasons)
                self.assertNotIn("repeat_after_cut", plan.reasons)
                self.assertNotIn(BACKCHANNEL_CUT_NOTE, plan.reminder)
                self.assertIn(INTERRUPTED_NOTE, plan.reminder)

    async def test_a_hung_reply_r1_cut_itself_is_not_a_cut_by_the_candidate(self) -> None:
        # Reviewed fix: the filler of a reply that hung past its deadline is cut by R1
        # (``_interrupt_session``); the candidate's next turn is not answered as a barge-in.
        handle = await self.cut_learner()
        filler: list[str] = []
        with mock.patch.object(
            self.interview.engine, "record_spoken", wraps=self.interview.engine.record_spoken
        ) as record:
            with mock.patch.object(r1_session, "FILLER_AFTER_SECONDS", 0.01), mock.patch.object(
                r1_session, "TURN_DEADLINE_SECONDS", 0.2
            ):
                with self.assertRaises(TimeoutError):
                    async for item in self.interview.guard_llm_stream(
                        TestLlmGuard.hung_stream()
                    ):
                        filler.append(item)
            await self.until(lambda: self.session.interrupts >= 1)
            message = FakeChatMessage(filler[0].strip(), interrupted=True)
            self.session.emit("conversation_item_added", SimpleNamespace(item=message))
            handle.chat_items.append(message)
            handle.interrupted = True
            handle.finish()
            self.session.current_speech = None
            await self.flush()
        self.assertTrue(record.call_args.kwargs["interrupted"])
        self.assertFalse(record.call_args.kwargs["by_candidate"])
        self.assertFalse(self.interview.engine._learner_cut)

    async def test_a_reply_the_candidate_cut_is_a_cut_by_the_candidate(self) -> None:
        handle = await self.cut_learner()
        with mock.patch.object(
            self.interview.engine, "record_spoken", wraps=self.interview.engine.record_spoken
        ) as record:
            self.deliver_cut(handle)
            await self.flush()
        self.assertTrue(record.call_args.kwargs["by_candidate"])
        self.assertTrue(self.interview.engine._learner_cut)


class TestWhatTheCandidateCanCut(R1TestCase):
    """Barge-in may cut LLM replies only: every scripted ``say()`` line stays uninterruptible.

    Consent and disclosure (L-OPEN), the transition instructions, the wrap-up and close, the
    interviewer's asides and the system stop must be heard whole, exactly as before 2026-10-28.
    """

    MUST_BE_HEARD = (
        "L-OPEN", "L-PICKUP", "L-TRANSITION", "L-TRANSITION-NUDGE", "L-SIL-IB", "L-SIL-RP1",
        "L-SIL-RP2", "L-SIL-END", "L-MUTE", "L-REJOIN", "L-REJOIN-RP", "L-EXIT", "L-WRAP",
        "L-CLOSE", "L-SYSTEM-STOP",
        # M032 S7C: the sound check and its agendas, the never-heard ladder, the mute asides.
        "L-OPEN-HI", "L-OPEN-HELLO", "L-OPEN-HELLO-AGAIN", "L-OPEN-AGENDA", "L-OPEN-AGENDA-PLAIN",
        "L-OPEN-AGENDA-CONTINUE", "L-SIL-NOAUDIO", "L-SIL-END-NOAUDIO", "L-MUTE-RP", "L-MUTE-IV",
    )

    async def test_every_scripted_line_is_spoken_uninterruptible(self) -> None:
        for line_id in self.MUST_BE_HEARD:
            with self.subTest(line=line_id):
                await self.interview.say(line_id)
                self.assertFalse(self.session.handles[-1].allow_interruptions)

    async def test_the_interviewers_asides_are_uninterruptible(self) -> None:
        self.enter_roleplay()
        for line_id in ("L-ASIDE-COACH", "L-ASIDE-END"):
            with self.subTest(line=line_id):
                plan = SimpleNamespace(scripted_text=self.spoken_line(line_id), line_id=line_id)
                await self.interview._play_aside(plan)
                self.assertFalse(self.session.handles[-1].allow_interruptions)

    async def test_the_recovery_line_in_place_of_a_reply_may_be_cut(self) -> None:
        self.enter_roleplay()
        await self.interview._speak_recovery(R1Phase.ROLEPLAY)
        # D5-RELIAB1 (R1_LLM_RECOVERY_V2): the learner's recovery line is a holding line.
        self.assertIn(self.session.spoken[-1], FALLBACK_REPLIES)
        self.assertTrue(self.session.handles[-1].allow_interruptions)
        with mock.patch.dict(os.environ, {"R1_LLM_RECOVERY_V2": "0"}):
            await self.interview._speak_recovery(R1Phase.ROLEPLAY)
        self.assertEqual(self.session.spoken[-1], FALLBACK_REPLY)

    def test_no_scripted_call_site_asks_for_an_interruptible_line(self) -> None:
        source = Path(r1_session.__file__).read_text(encoding="utf-8")
        calls = re.findall(r"await self\.say\((.*?)\)", source, flags=re.S)
        # 12 since L-END-CLOSE's call site went (owner decision 2026-10-29: a confirmed stop ends
        # the role-play into L-EXIT and the wrap-up).
        self.assertGreaterEqual(len(calls), 12)
        for call in calls:
            self.assertNotIn("interruptible", call)
        self.assertIn("interruptible: bool = False", source)  # say()'s own default
        self.assertEqual(source.count("interruptible=True"), 1)  # the llm_recovery line only
        # _play_aside: the asides; _say_brief: the transition bridge's reaction (M032 S5), which
        # comes right before the uninterruptible brief and cannot be cut either, and that brief
        # (L-TRANSITION-BRIDGED), queued together with the reaction (review of S5); and "Yes, I'm
        # here." queued right before them after a presence check ends the icebreaker (M032 S6);
        # and the icebreaker's quiet nudge, "So, {question}" (M032 diagnosis 4, D4-IB-QUIET-NUDGE).
        self.assertEqual(source.count("interruptible=False"), 5)


class TestTransitionKeepsTheSessionsEndpointing(R1TestCase):
    """M1 (owner decision 2026-11-03): the transition is a conversation now, not a lone "ready".

    It used to commit turns at 0.4 / 1.2 s, and mock call aa166f09 split one question into two
    rows at a pause.  Christy answers questions there now, so the session's own endpointing stays
    (a "ready" is still read at its final, without waiting for the commit).
    """

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.updates: list[dict] = []
        self.session.update_options = lambda **kwargs: self.updates.append(kwargs)

    async def test_no_phase_changes_the_endpointing(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._begin_disconnect()
        self.interview._rejoin()
        self.interview._enter(R1Phase.ROLEPLAY)
        self.assertEqual(self.updates, [])

    async def test_a_ready_final_picks_up_before_any_commit(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        self.final_transcript("Okay, ready.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])


class TestCandidateRowCoalescing(R1TestCase):
    """One transcript row per committed candidate turn, not one per STT final.

    Sarvam closes an utterance at each of its own pauses, and the SDK merges those finals into
    one turn.  In the owner's session a single answer was 5-6 rows, and 13.7% of the role-play
    rows were two words or fewer, which alone fails the gate's ``stt_sanity`` (below 10%).
    """

    ANSWER = (
        "Yeah, so, um, I just got a call from you and, uh,",
        "realized that you have been looking through our programs",
        "Hello",
        "whether are you looking for upskilling or like",
        "know what you do in your career.",
    )

    def candidate_rows(self) -> list[dict]:
        return [row for row in self.writer.saved if row["speaker"] == "candidate"]

    async def test_the_finals_of_one_answer_are_one_row_written_when_the_turn_commits(self) -> None:
        for fragment in self.ANSWER:
            self.final_transcript(fragment)
        await self.flush()
        self.assertEqual(self.writer.saved, [])  # one open row, not written yet
        await self.commit_turn(" ".join(self.ANSWER))
        await self.flush()
        self.assertEqual(
            [(r["index"], r["speaker"], r["phase"], r["text"]) for r in self.writer.saved],
            [(1, "candidate", "icebreaker", " ".join(self.ANSWER))],
        )

    async def test_the_driver_still_reads_every_final_one_at_a_time(self) -> None:
        # Ready and wrap-up matching works on single finals: only the PERSISTENCE is coalesced.
        for fragment in ("Not ready yet.", "Okay, ready now."):
            self.final_transcript(fragment)
        self.assertEqual(await self.interview._await_turn(5.0), (TURN, "Not ready yet."))
        self.assertEqual(await self.interview._await_turn(5.0), (TURN, "Okay, ready now."))

    async def test_the_row_is_placed_at_its_first_final_ahead_of_a_later_bot_speech(self) -> None:
        self.final_transcript("tell me about the course")
        self.final_transcript("and the fees")
        await self.interview.say("L-SIL-IB")  # a bot speech starts: the candidate's turn is over
        await self.flush()
        self.assertEqual(
            [(r["index"], r["speaker"]) for r in self.writer.saved], [(1, "candidate"), (2, "bot")]
        )
        self.assertEqual(self.writer.saved[0]["text"], "tell me about the course and the fees")

    async def test_what_the_candidate_says_after_a_bot_speech_starts_is_a_new_row(self) -> None:
        self.final_transcript("first thing")
        await self.interview.say("L-SIL-IB")
        self.final_transcript("second thing")
        await self.commit_turn("second thing")
        await self.flush()
        self.assertEqual(
            [(r["index"], r["speaker"], r["text"]) for r in self.writer.saved if r["speaker"] == "candidate"],
            [(1, "candidate", "first thing"), (3, "candidate", "second thing")],
        )

    async def test_a_row_never_straddles_a_phase(self) -> None:
        self.final_transcript("the end of my answer")
        self.interview._enter(R1Phase.TRANSITION)
        self.final_transcript("ready")
        await self.commit_turn("ready")
        await self.flush()
        self.assertEqual(
            [(r["index"], r["phase"], r["text"]) for r in self.writer.saved],
            [(1, "icebreaker", "the end of my answer"), (2, "transition", "ready")],
        )

    async def test_a_disconnect_closes_the_open_row(self) -> None:
        self.final_transcript("said just before dropping")
        self.interview._begin_disconnect()
        await self.flush()
        self.assertEqual([r["text"] for r in self.writer.saved], ["said just before dropping"])

    async def test_words_the_sdk_banked_are_part_of_the_committed_row(self) -> None:
        # The SDK banks the words it refuses and judges the next final together with them, so
        # "Sorry" + "Thank you." is already a committed turn of three words (and that commit cuts
        # a pending reply: TestBackchannelsOverAPendingReply).  Whatever turn commits carries
        # every banked word, and so does its one row.
        for fragment in ("Sorry", "Thank you.", "Hey, are you there?"):
            self.final_transcript(fragment)
        await self.commit_turn("Sorry Thank you. Hey, are you there?")
        await self.flush()
        self.assertEqual(
            [r["text"] for r in self.writer.saved], ["Sorry Thank you. Hey, are you there?"]
        )

    async def test_the_history_entry_and_the_row_share_the_turn_index(self) -> None:
        self.final_transcript("one part,")
        self.final_transcript("and another.")
        await self.commit_turn("one part, and another.")
        entry = [item for item in self.interview._history if item["role"] == "candidate"][-1]
        self.assertEqual(entry["seq"], 1)
        await self.flush()
        self.assertEqual(self.writer.saved[0]["index"], 1)

    async def test_an_empty_commit_with_no_finals_writes_nothing(self) -> None:
        await self.commit_turn("")
        await self.flush()
        self.assertEqual(self.writer.saved, [])

    async def test_each_row_is_written_exactly_once(self) -> None:
        self.final_transcript("an answer")
        await self.commit_turn("an answer")
        await self.commit_turn("")  # a second, empty commit
        self.interview._begin_exit()
        await self.flush()
        self.assertEqual(len(self.writer.saved), 1)

    async def test_the_owner_sessions_fragments_pass_the_gates_stt_sanity(self) -> None:
        # The role-play rows of b58c7d9c (19-28, 32-40): the same speech, as the SDK commits it.
        turns = [
            ["Hey Meera, how are you doing?"],
            list(self.ANSWER),
            ["Okay, so what brings you here like", "Do you want?",
             "Like I wanted to know why you are looking at our programs and what the blocker is"],
            ["Um yeah, so I I mean, we as an interview kickstart, have a professionals program.",
             "You know, you will land on something where you wanted in your career,",
             "We really kill it and we have a good conversion rate as well.", "Good",
             "They don't, we don't give it for free. I mean, usually that's how the world is."],
            ["Of course, that's why we are well known for like.",
             "So when it comes to layoffs, people will be panicking, they don't know what to do."],
            ["Okay"],
            ["Like fall behind, can you please elaborate it?"],
            ["Yeah, we have our own portal, so when you miss the live classes, you can always "
             "request a recorded clip of that session."],
            ["Um, actually you, uh, how do you get to know that 9000 USD is the program value?"],
            ["Um, yeah, I mean we can", "So 9000, okay, so you want the deal to be in 7000 "
             "and it also includes live classes."],
            ["So you're saying you need $7000. Okay, let's make it $8500 and I will talk to my manager."],
            ["When it comes to the course it depends on which program you pick up."],
        ]
        self.enter_roleplay()
        finals = 0
        for fragments in turns:
            for fragment in fragments:
                self.final_transcript(fragment)
                finals += 1
            await self.commit_turn(" ".join(fragments))
        await self.flush()
        rows = [r for r in self.candidate_rows() if r["phase"] == "roleplay"]
        self.assertEqual(len(rows), len(turns))  # one row per committed turn
        short = [r for r in rows if len(r["text"].split()) <= 2]
        self.assertEqual([r["text"] for r in short], ["Okay"])  # only the genuine one-word turn
        self.assertLess(len(short) / len(rows), 0.1)  # R1_GATE_LIMITS.STT_SUSPECT_SHARE_FAIL_AT
        # Row per final it would have been 5 short rows of 25 (20%): the gate would have failed.
        per_final_short = sum(
            1 for fragments in turns for f in fragments if len(f.split()) <= 2
        )
        self.assertGreaterEqual(per_final_short / finals, 0.1)


class TestAcknowledgementTurns(R1TestCase):
    """Owner test 1eb18cd4: speech-to-text sanity leaves acknowledgement-only turns out.

    The session judges each role-play turn with ``is_acknowledgement_turn`` and hands the verdict
    to the engine (``backchannel=``), whose ``stt_sanity`` then leaves the turn out; the API gate
    leaves the same turns out of its own check through a TypeScript port of the classifier, pinned
    by ``r1-acknowledgement-cross-language.test.ts`` on the shared fixture read here.
    """

    FIXTURE = HERE / "tests" / "fixtures" / "r1_acknowledgement_turns.json"

    def test_the_shared_fixture_is_the_classifiers_verdict(self) -> None:
        rows = json.loads(self.FIXTURE.read_text(encoding="utf-8"))
        self.assertGreater(len(rows), 50)
        for row in rows:
            with self.subTest(text=row["text"]):
                self.assertIs(
                    r1_session.is_acknowledgement_turn(row["text"]), row["acknowledgement"]
                )
        # The owner's real short turns: the hand-back "Okay, continue." is one (the classifier's
        # "continue" / "go on" / "go ahead"), a greeting or a goodbye is not.
        verdicts = {row["text"]: row["acknowledgement"] for row in rows}
        for text in ("Okay", "Yeah, Okay", "Okay, continue.", "Hmm", "Yeah, okay."):
            self.assertTrue(verdicts[text], text)
        for text in ("Hi Pooja", "So Bye", "the price", "Yes."):
            self.assertFalse(verdicts[text], text)

    def test_the_engine_tests_are_told_what_the_session_would_tell_them(self) -> None:
        from tests.test_r1_roleplay import (
            OWNER_1EB18CD4_ACKNOWLEDGEMENTS,
            OWNER_1EB18CD4_ROLEPLAY,
        )

        self.assertEqual(
            {i for i, text in OWNER_1EB18CD4_ROLEPLAY if r1_session.is_acknowledgement_turn(text)},
            OWNER_1EB18CD4_ACKNOWLEDGEMENTS,
        )

    async def replay_the_owners_roleplay(self, min_words: str) -> None:
        """The owner's role-play turns (before the end requests) through the real session."""
        from tests.test_r1_roleplay import OWNER_1EB18CD4_ROLEPLAY

        turns = [text for index, text in OWNER_1EB18CD4_ROLEPLAY if index <= 71]
        with mock.patch.dict(os.environ, {"R1_INTERRUPT_MIN_WORDS": min_words}):
            self.assertEqual(r1_session.interrupt_min_words(), int(min_words))
            self.enter_roleplay()
            engine = self.interview.engine
            with mock.patch.object(engine, "plan_turn", wraps=engine.plan_turn) as plan:
                for text in turns:
                    self.clock.advance(20)
                    await self.answer(text)
            told = [call.kwargs["backchannel"] for call in plan.call_args_list]
        self.assertEqual(sum(told), 8)  # the session told the engine of each acknowledgement
        fidelity = engine.fidelity(r_end=self.interview.machine.roleplay_elapsed)
        self.assertTrue(fidelity["checks"]["stt_sanity"], fidelity)
        self.assertEqual(fidelity["acknowledgement_turns"], 8)
        await self.flush()
        rows = [
            row["text"] for row in self.writer.saved
            if row["speaker"] == "candidate" and row["phase"] == "roleplay"
        ]
        self.assertEqual(len(rows), len(turns))
        # What the gate's computeTranscriptStats reads: 1 short row of the 25 that are not
        # acknowledgements (4%) passes R1_GATE_LIMITS.STT_SUSPECT_SHARE_FAIL_AT; counting the
        # acknowledgements (before this fix) it was 8 of 33 (24%).
        speech = [text for text in rows if not r1_session.is_acknowledgement_turn(text)]
        self.assertLess(sum(1 for t in speech if len(t.split()) <= 2) / len(speech), 0.1)
        self.assertGreaterEqual(sum(1 for t in rows if len(t.split()) <= 2) / len(rows), 0.1)

    async def test_the_owners_roleplay_passes_stt_sanity_at_zero_words(self) -> None:
        await self.replay_the_owners_roleplay("0")

    async def test_the_owners_roleplay_passes_stt_sanity_at_the_three_word_rollback(self) -> None:
        await self.replay_the_owners_roleplay("3")


class TestIcebreakerNote(unittest.TestCase):
    """The icebreaker prompt tells the model never to start or announce the role-play."""

    def test_the_icebreaker_and_opening_replies_carry_the_note(self) -> None:
        from r1_personas import resolve_persona
        from r1_prompts import GETTING_TO_KNOW_YOU_NOTE, interviewer_prefix, interviewer_reminder
        from r1_replies import Reply, llm_messages

        persona = resolve_persona("p1_career_switcher", variant="v1")
        for phase in ("opening", "icebreaker"):
            for voice in (True, False):
                with self.subTest(phase=phase, voice=voice):
                    messages = llm_messages(
                        Reply(phase=phase, candidate_text="I sell courses."),
                        persona,
                        [],
                        voice=voice,
                    )
                    self.assertEqual(
                        messages[0], {"role": "system", "content": interviewer_prefix(voice=voice)}
                    )  # the cache prefix is untouched by the per-turn note
                    # M032 S5: with the voice on, the delivery rider follows the note.
                    self.assertEqual(
                        messages[-2],
                        {"role": "system", "content": interviewer_reminder(phase, rider=voice)},
                    )
                    self.assertTrue(messages[-2]["content"].startswith(GETTING_TO_KNOW_YOU_NOTE))
                    if not voice:
                        self.assertEqual(messages[-2]["content"], GETTING_TO_KNOW_YOU_NOTE)
                    self.assertEqual(messages[-1], {"role": "user", "content": "I sell courses."})
        lowered = GETTING_TO_KNOW_YOU_NOTE.lower()
        self.assertIn("never start, announce", lowered)
        self.assertIn("role-play", lowered)
        self.assertIn("goodbye", lowered)

    def test_no_other_interviewer_phase_gets_it(self) -> None:
        from r1_personas import resolve_persona
        from r1_prompts import GETTING_TO_KNOW_YOU_NOTE
        from r1_replies import Reply, llm_messages

        persona = resolve_persona("p1_career_switcher", variant="v1")
        for phase in ("transition", "roleplay_exit", "wrapup", "closing"):
            with self.subTest(phase=phase):
                messages = llm_messages(Reply(phase=phase, candidate_text="Hello."), persona, [])
                self.assertNotIn(
                    GETTING_TO_KNOW_YOU_NOTE, "\n".join(m["content"] for m in messages)
                )


class TestLlmFailureRecovery(R1TestCase):
    """A failed model reply is never silence: the candidate hears the safe fallback.

    Before, the failed reply yielded nothing, the candidate waited 20-30 s and then heard
    "Are you still there?" as if they had gone.  The 3-failure abort is unchanged.
    """

    FALLBACK = FALLBACK_REPLY

    async def asyncSetUp(self) -> None:
        # M032 S5: with the icebreaker plan on, an icebreaker reply falls back to the plan's
        # current question (TestLlmFailureRecoveryWithThePlan); these pin the guard's own line.
        patcher = mock.patch.dict(os.environ, {"R1_ICEBREAKER_PLAN": "0"})
        patcher.start()
        self.addCleanup(patcher.stop)
        await super().asyncSetUp()

    def provider(self, error: BaseException | None = None, *, reported: bool = False):
        interview = self.interview

        def make(_messages):
            async def stream():
                if reported:  # the SDK emits its error event BEFORE the call raises
                    interview._on_provider_error(
                        SimpleNamespace(error=SimpleNamespace(type="llm_error", recoverable=False))
                    )
                raise error or RuntimeError("provider unavailable")
                yield ""  # pragma: no cover - makes this an async generator

            return stream()

        return make

    async def reply(self, provider, text: str = "I sold courses") -> list[str]:
        self.interview.machine.candidate_turns = 1
        self.interview.prepare_turn(text, f"msg_{next(_IDS)}")
        stream = self.interview.llm_node_stream(SimpleNamespace(items=[]), provider)
        return [chunk async for chunk in stream]

    async def test_a_failed_reply_speaks_the_fallback_instead_of_nothing(self) -> None:
        with self.capture_logs() as logs:
            spoken = await self.reply(self.provider())
        self.assertEqual("".join(spoken).strip(), self.FALLBACK)
        self.assertEqual(self.interview._failures, 1)  # counted
        self.assertIn("r1_llm_reply_failed", error_types(logs))
        self.assertNotIn("provider unavailable", json.dumps(logs))
        # Not an answer from the provider: the failure count survives the fallback line.
        self.assertEqual(self.interview._failures, 1)
        self.assertFalse(self.interview._skip_failure_reset)
        # The page is not left to wonder: no "Are you still there?" was queued by the failure.
        self.assertEqual(self.session.spoken, [])

    async def test_a_later_good_reply_resets_the_count(self) -> None:
        await self.reply(self.provider())
        spoken = await self.reply(lambda _messages: self_stream("Tell me more."))
        self.assertEqual("".join(spoken).strip(), "Tell me more.")
        self.assertEqual(self.interview._failures, 0)

    async def test_three_failures_in_a_row_still_abort_and_the_third_says_nothing(self) -> None:
        for _ in range(2):
            spoken = await self.reply(self.provider())
            self.assertEqual("".join(spoken).strip(), self.FALLBACK)
        self.assertIsNone(self.interview._stop_outcome())
        with self.assertRaises(RuntimeError):  # the abort is due: the driver ends the interview
            await self.reply(self.provider())
        self.assertEqual(self.interview._failures, 3)
        self.assertEqual(self.interview._stop_outcome(), "provider_error")

    async def test_a_failure_the_sdk_already_reported_is_counted_once(self) -> None:
        spoken = await self.reply(self.provider(reported=True))
        self.assertEqual("".join(spoken).strip(), self.FALLBACK)
        self.assertEqual(self.interview._failures, 1)

    async def test_a_reply_that_failed_after_it_began_is_not_papered_over(self) -> None:
        async def partial():
            yield "Thanks for sharing that. "
            yield "And how"
            raise RuntimeError("connection reset")

        collected: list[str] = []
        self.interview.machine.candidate_turns = 1
        self.interview.prepare_turn("I sold courses", "msg_partial")
        with self.assertRaises(RuntimeError):
            async for chunk in self.interview.llm_node_stream(
                SimpleNamespace(items=[]), lambda _messages: partial()
            ):
                collected.append(chunk)
        self.assertEqual("".join(collected).strip(), "Thanks for sharing that.")
        self.assertNotIn(self.FALLBACK, "".join(collected))

    async def test_the_fallback_is_a_wrapup_reply_too(self) -> None:
        self.enter_roleplay()
        self.interview._end_roleplay()
        self.interview.machine.transition(R1Phase.WRAPUP)
        spoken = await self.reply(self.provider(), "What is the notice period?")
        self.assertEqual("".join(spoken).strip(), self.FALLBACK)

    async def test_a_hung_reply_is_followed_by_the_fallback_not_by_dead_air(self) -> None:
        async def hung(_messages):
            await asyncio.Event().wait()
            yield "never"

        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.05), mock.patch.object(
            r1_session, "FILLER_AFTER_SECONDS", 5.0
        ):
            with self.assertRaises(TimeoutError):
                await self.reply(lambda messages: hung(messages))
        await self.until(lambda: self.FALLBACK in self.session.spoken)
        self.assertEqual(self.session.spoken.count(self.FALLBACK), 1)
        self.assertEqual(self.interview._failures, 1)
        await self.flush()

    async def test_the_fallback_after_a_hung_roleplay_reply_is_the_learners(self) -> None:
        self.enter_roleplay()
        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.05), mock.patch.object(
            r1_session, "FILLER_AFTER_SECONDS", 5.0
        ), mock.patch.dict(os.environ, {"R1_LLM_RECOVERY_V2": "0"}):
            with self.assertRaises(TimeoutError):
                await self.interview.guard_llm_stream(self.hung_stream()).__anext__()
        await self.until(lambda: ("play_end", self.FALLBACK) in self.order)
        await self.flush()
        spoken = [item for item in self.interview._history if item["text"] == self.FALLBACK]
        self.assertEqual([item["voice"] for item in spoken], ["learner"])

    @staticmethod
    async def hung_stream():
        await asyncio.Event().wait()
        yield "never"

    async def test_three_hung_replies_abort_and_the_third_is_not_followed_by_the_fallback(
        self,
    ) -> None:
        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.03), mock.patch.object(
            r1_session, "FILLER_AFTER_SECONDS", 5.0
        ):
            for index in range(3):
                with self.assertRaises(TimeoutError):
                    async for _ in self.interview.guard_llm_stream(self.hung_stream()):
                        pass
                if index < 2:
                    await self.until(
                        lambda index=index: self.session.spoken.count(self.FALLBACK) == index + 1
                    )
        await self.settle()
        self.assertEqual(self.session.spoken.count(self.FALLBACK), 2)
        self.assertEqual(self.interview._stop_outcome(), "provider_error")
        await self.flush()

    async def test_no_fallback_for_a_phase_that_is_over_or_a_candidate_who_left(self) -> None:
        self.interview.machine.transition(R1Phase.TRANSITION)  # the reply was for the icebreaker
        await self.interview._speak_recovery(R1Phase.ICEBREAKER)
        self.assertEqual(self.session.spoken, [])
        # M1: Christy answers questions in the transition, so a hung answer there gets the line.
        await self.interview._speak_recovery(R1Phase.TRANSITION)
        self.assertEqual(self.session.spoken, [FALLBACK_REPLY])
        self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
        self.enter_roleplay_from_transition()
        await self.interview._speak_recovery(R1Phase.ROLEPLAY)
        self.assertEqual(self.session.spoken, [FALLBACK_REPLY])

    def enter_roleplay_from_transition(self) -> None:
        self.interview.machine.transition(R1Phase.ROLEPLAY)


class TestLlmFailureRecoveryWithThePlan(R1TestCase):
    """M032 S5: with the icebreaker plan on, a failed icebreaker reply asks the plan's question.

    The candidate was clear; the provider was not, so "Sorry, what were you saying?" is the wrong
    line (phone map, the missed recovery item).  The 3-failure abort is unchanged.
    """

    async def asyncSetUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {"R1_ICEBREAKER_PLAN": "1"})
        patcher.start()
        self.addCleanup(patcher.stop)
        await super().asyncSetUp()

    ANSWER = "I spent six years selling insurance policies to young families across the city."

    async def test_a_failed_and_a_hung_icebreaker_reply_ask_the_current_question(self) -> None:
        import r1_icebreaker as ib

        def failing(_messages):
            async def stream():
                raise RuntimeError("provider unavailable")
                yield ""  # pragma: no cover - makes this an async generator

            return stream()

        self.interview.prepare_turn(self.ANSWER, f"msg_{next(_IDS)}")
        stream = self.interview.llm_node_stream(SimpleNamespace(items=[]), failing)
        spoken = "".join([chunk async for chunk in stream]).strip()
        self.assertEqual(spoken, ib.OBJECTIVES[1].restate)
        self.assertEqual(self.interview._failures, 1)

        async def hung(_messages):
            await asyncio.Event().wait()
            yield "never"

        self.interview.prepare_turn(self.ANSWER, f"msg_{next(_IDS)}")
        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.05), mock.patch.object(
            r1_session, "FILLER_AFTER_SECONDS", 5.0
        ):
            with self.assertRaises(TimeoutError):
                async for _ in self.interview.llm_node_stream(
                    SimpleNamespace(items=[]), lambda messages: hung(messages)
                ):
                    pass
        restate = ib.OBJECTIVES[2].restate
        await self.until(lambda: restate in self.session.spoken)
        self.assertNotIn(FALLBACK_REPLY, self.session.spoken)
        self.assertEqual(self.interview._failures, 2)
        await self.flush()


async def self_stream(*sentences: str):
    """A provider stream of ``sentences`` (module level so a lambda can build one)."""
    for sentence in sentences:
        yield sentence + " "


class TestPhaseAttribute(R1TestCase):
    """The worker publishes the page's ``phase`` attribute on every change (and ``aborted``)."""

    def published(self) -> list[str]:
        return [item["phase"] for item in self.ctx.room.local_participant.attributes]

    async def test_the_attribute_key_is_one_plain_lowercase_word(self) -> None:
        # The livekit SDK rewrites separators in attribute keys (`lk.agent.name` arrives as
        # `lkAgentName`, #332), so the key must not have any: the page reads `phase`.
        self.assertEqual(r1_session.PHASE_ATTRIBUTE, "phase")
        self.assertRegex(r1_session.PHASE_ATTRIBUTE, r"^[a-z]+$")

    async def test_every_published_value_is_one_the_page_understands(self) -> None:
        web = HERE.parent / "web" / "src" / "lib" / "r1" / "r1-phase.ts"
        if not web.exists():
            self.skipTest("the web app is not part of this checkout")
        source = web.read_text(encoding="utf-8")
        self.assertIn(f"R1_PHASE_ATTRIBUTE = '{r1_session.PHASE_ATTRIBUTE}'", source)
        listing = re.search(r"R1_PHASES = \[(.*?)\] as const", source, re.DOTALL)
        self.assertIsNotNone(listing)
        vocabulary = set(re.findall(r"'([a-z_]+)'", listing.group(1)))
        worker = {phase.value for phase in R1Phase} | {"ended"}
        self.assertEqual(vocabulary, worker)

    async def test_each_phase_change_is_published_in_order(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._enter(R1Phase.ROLEPLAY)
        await self.settle()
        self.assertEqual(self.published(), ["transition", "roleplay"])
        self.interview._enter(R1Phase.ROLEPLAY_EXIT)
        self.interview._enter(R1Phase.WRAPUP)
        await self.settle()
        # The live-UI signals (R1-Q) ride in the same writes: ``leadname`` and ``awaiting`` with the
        # transition, ``awaiting`` cleared and ``rpleft`` set with the role-play, ``rpleft`` cleared
        # with the phase after it, and a plain ``phase`` for every phase that touches none of them.
        self.assertEqual(
            self.ctx.room.local_participant.attributes,
            [
                {
                    "phase": "transition",
                    "leadname": self.interview.persona.lead_name,
                    "awaiting": "ready",
                },
                {"phase": "roleplay", "awaiting": "", "rpleft": "1200"},
                {"phase": "roleplay_exit", "rpleft": ""},
                {"phase": "wrapup"},
            ],
        )

    async def test_mute_aside_and_reconnect_pauses_are_published(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._enter(R1Phase.ROLEPLAY)
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        self.ctx.room.emit("track_unmuted", FakeParticipant("candidate"), FakePublication())
        self.interview._begin_disconnect()
        self.interview._rejoin()
        await self.settle()
        self.assertEqual(
            self.published(),
            ["transition", "roleplay", "aside", "roleplay", "paused_disconnected", "roleplay"],
        )

    async def test_a_phase_is_not_published_twice_in_a_row(self) -> None:
        self.interview._publish_phase("roleplay")
        self.interview._publish_phase("roleplay")
        await self.settle()
        self.assertEqual(self.published(), ["roleplay"])

    async def test_a_slow_write_never_blocks_the_interview_or_reorders_the_values(self) -> None:
        gate = asyncio.Event()
        sent: list[dict] = []

        async def slow(attributes):
            await gate.wait()
            sent.append(dict(attributes))

        self.ctx.room.local_participant.set_attributes = slow
        self.interview._enter(R1Phase.TRANSITION)  # returns at once
        self.interview._enter(R1Phase.ROLEPLAY)
        await self.settle()
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)
        self.assertEqual(sent, [])
        gate.set()
        await self.until(lambda: len(sent) == 2)
        self.assertEqual([item["phase"] for item in sent], ["transition", "roleplay"])

    async def test_a_failing_write_is_logged_by_type_and_swallowed(self) -> None:
        async def broken(_attributes):
            raise RuntimeError(POISON_TEXT)

        self.ctx.room.local_participant.set_attributes = broken
        with self.capture_logs() as logs:
            self.interview._enter(R1Phase.TRANSITION)
            await self.settle()
        self.assertEqual(error_types(logs), ["r1_phase_publish_failed"])
        self.assertNotIn(POISON_TEXT, json.dumps(logs))

    async def test_the_ended_write_replaces_a_writer_that_is_stuck(self) -> None:
        calls = {"n": 0}
        sent: list[dict] = []

        async def first_call_hangs(attributes):
            calls["n"] += 1
            if calls["n"] == 1:
                await asyncio.Event().wait()
            sent.append(dict(attributes))

        self.ctx.room.local_participant.set_attributes = first_call_hangs
        self.interview._enter(R1Phase.TRANSITION)
        await self.settle()
        await asyncio.wait_for(self.interview._announce_ended(), 5.0)
        self.assertEqual(sent, [{"phase": "ended"}])
        # Nothing is published after ended: the page has left.
        self.interview._enter(R1Phase.ROLEPLAY)
        await self.settle()
        self.assertEqual(sent, [{"phase": "ended"}])

    async def test_a_normal_finish_publishes_closing_then_ended_and_never_finishing(self) -> None:
        await self.interview._finish("complete")
        self.assertEqual(self.published(), ["closing", "ended"])
        self.assertIs(self.interview.machine.phase, R1Phase.FINISHING)

    async def test_a_technical_stop_publishes_aborted_before_the_apology_and_then_ended(
        self,
    ) -> None:
        await self.interview._finish("provider_error", system=True)
        self.assertEqual(self.published(), ["aborted", "ended"])
        aborted = self.order.index(("attributes", {"phase": "aborted"}))
        apology = ("play_end", self.spoken_line("L-SYSTEM-STOP"))
        self.assertLess(aborted, self.order.index(apology))
        self.assertLess(self.order.index(apology), self.order.index(("attributes", {"phase": "ended"})))

    async def test_nothing_but_aborted_follows_an_abort(self) -> None:
        # The page reads the phase BEFORE `ended`: a later value would turn "technical stop"
        # into "Interview complete".
        self.interview._publish_abort()
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._publish_phase("closing")
        await self.settle()
        self.assertEqual(self.published(), ["aborted"])

    async def test_an_abort_that_never_went_out_is_written_before_ended(self) -> None:
        # No time for the background writer (no candidate to speak to, so no pause): the
        # funnel writes `aborted` itself, inside the same bound as `ended`.
        self.interview._publish_abort()
        await self.interview._announce_ended()
        self.assertEqual(self.published(), ["aborted", "ended"])

    async def test_a_stop_on_our_side_that_skipped_the_closing_speech_still_aborts(self) -> None:
        for outcome in ("provider_error", "shutdown_forced", "residency_timeout",
                        "configuration_failed", "context_failed"):
            with self.subTest(outcome=outcome):
                await self.asyncSetUp()
                await self.interview._exit(outcome)
                self.assertEqual(self.published(), ["aborted", "ended"])

    async def test_a_candidate_ending_and_a_completion_are_not_aborted(self) -> None:
        for outcome in ("candidate_left", "complete", "no_show"):
            with self.subTest(outcome=outcome):
                await self.asyncSetUp()
                await self.interview._exit(outcome)
                self.assertEqual(self.published(), ["ended"])


READY_BYTES = b'{"v":1,"kind":"ready"}'


def ready_packet(
    *,
    topic: str | None = "r1ready",
    data: object = READY_BYTES,
    participant: object = None,
) -> SimpleNamespace:
    """A ``DataPacket`` as the SDK delivers it: data, kind, the sending participant, topic.

    ``participant`` is None for a message sent by a server SDK, which is the only kind the
    "I'm ready" button produces (the API relays it).
    """
    return SimpleNamespace(data=data, kind=0, participant=participant, topic=topic)


class TestLiveUiSignals(R1TestCase):
    """``leadname``, ``awaiting`` and ``rpleft`` ride on the one ordered phase writer (R1-Q).

    The contract is in ``.gsd/milestones/R1-Q/IMPLEMENTER-RULES.md``: keys are single plain
    lowercase words, values are strings, an empty string deletes, and the page reads them only
    from the agent participant.
    """

    def writes(self) -> list[dict]:
        return list(self.ctx.room.local_participant.attributes)

    async def until_writes(self, count: int) -> list[dict]:
        await self.until(lambda: len(self.writes()) >= count)
        return self.writes()

    async def test_the_keys_and_values_are_the_contracts(self) -> None:
        self.assertEqual(
            (
                r1_session.LEADNAME_ATTRIBUTE,
                r1_session.AWAITING_ATTRIBUTE,
                r1_session.RPLEFT_ATTRIBUTE,
                r1_session.AWAITING_READY,
            ),
            ("leadname", "awaiting", "rpleft", "ready"),
        )
        for key in (
            r1_session.PHASE_ATTRIBUTE,
            r1_session.LEADNAME_ATTRIBUTE,
            r1_session.AWAITING_ATTRIBUTE,
            r1_session.RPLEFT_ATTRIBUTE,
        ):
            self.assertRegex(key, r"^[a-z]+$")  # the SDK camel-cases keys with separators (#332)
        self.assertEqual(r1_session.RPLEFT_HEARTBEAT_SECONDS, 30.0)
        self.assertEqual(r1_session.RPLEFT_MAX_SECONDS, 3600)
        self.assertEqual(r1_session.LEADNAME_MAX_CHARS, 40)

    async def test_the_transition_write_carries_the_learner_name_and_awaiting_in_one_call(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        writes = await self.until_writes(1)
        self.assertEqual(
            writes,
            [
                {
                    "phase": "transition",
                    "leadname": self.interview.persona.lead_name,
                    "awaiting": "ready",
                }
            ],
        )
        # Every value is a string, and the name is the one the interviewer says aloud.
        self.assertTrue(all(isinstance(value, str) for value in writes[0].values()))
        self.assertIn(writes[0]["leadname"], self.spoken_line("L-TRANSITION"))

    async def test_awaiting_is_cleared_once_when_the_transition_is_left_and_leadname_is_kept(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._enter(R1Phase.ROLEPLAY)
        self.interview._enter(R1Phase.ROLEPLAY_EXIT)
        self.interview._enter(R1Phase.WRAPUP)
        writes = await self.until_writes(4)
        self.assertEqual(writes[1]["awaiting"], "")
        for later in writes[2:]:
            self.assertNotIn("awaiting", later)
        # `leadname` is written once with the transition and never deleted ("kept afterwards").
        self.assertEqual(sum("leadname" in write for write in writes), 1)
        for write in writes:
            self.assertNotEqual(write.get("leadname"), "")

    async def test_no_awaiting_or_leadname_before_the_transition(self) -> None:
        self.interview._publish_phase("icebreaker")  # the fixture is in the icebreaker
        writes = await self.until_writes(1)
        self.assertEqual(writes, [{"phase": "icebreaker"}])

    async def test_rpleft_goes_with_every_roleplay_phase_write_and_is_the_machines_budget(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._enter(R1Phase.ROLEPLAY)
        self.clock.advance(100)  # R = S = 100 s into the role-play
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        self.clock.advance(50)  # the aside pauses R; S keeps running
        self.ctx.room.emit("track_unmuted", FakeParticipant("candidate"), FakePublication())
        writes = await self.until_writes(4)
        self.assertEqual([write["phase"] for write in writes], ["transition", "roleplay", "aside", "roleplay"])
        self.assertEqual(writes[1]["rpleft"], "1200")
        self.assertEqual(writes[2]["rpleft"], "1100")
        # The paused clock: the budget has not moved while the aside lasted.
        self.assertEqual(writes[3]["rpleft"], "1100")
        self.assertNotIn("rpleft", writes[0])

    async def test_rpleft_is_the_shorter_of_the_role_play_and_the_session_cap(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.clock.advance(1460)  # S = 1460 s: only 295 s to the S = 29:15 ceiling are left
        self.interview._enter(R1Phase.ROLEPLAY)
        writes = await self.until_writes(2)
        self.assertEqual(writes[1]["rpleft"], "295")
        self.assertEqual(
            writes[1]["rpleft"], str(int(self.interview.machine.remaining_roleplay_seconds()))
        )

    async def test_rpleft_is_an_integer_string_clamped_to_zero_and_3600(self) -> None:
        for budget, expected in ((99999.0, "3600"), (-5.0, "0"), (0.4, "0"), (1199.9, "1199"),
                                 (float("nan"), "0"), (float("inf"), "0")):
            with self.subTest(budget=budget):
                with mock.patch.object(
                    self.interview.machine, "remaining_roleplay_seconds", return_value=budget
                ):
                    self.assertEqual(self.interview._rpleft_value(), expected)

    async def test_a_pause_inside_the_roleplay_keeps_rpleft_and_the_rejoin_refreshes_it(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._enter(R1Phase.ROLEPLAY)
        self.clock.advance(30)
        self.interview._begin_disconnect()
        self.clock.advance(20)  # R is paused by the disconnect, S is not
        self.interview._rejoin()
        writes = await self.until_writes(4)
        self.assertEqual(
            [(write["phase"], write.get("rpleft")) for write in writes[1:]],
            [("roleplay", "1200"), ("paused_disconnected", "1170"), ("roleplay", "1170")],
        )

    async def test_a_disconnect_before_the_roleplay_publishes_no_rpleft(self) -> None:
        self.interview._begin_disconnect()
        self.interview._rejoin()
        writes = await self.until_writes(2)
        self.assertEqual(writes, [{"phase": "paused_disconnected"}, {"phase": "icebreaker"}])

    async def test_a_disconnect_in_the_transition_withdraws_awaiting_and_the_rejoin_asks_again(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._begin_disconnect()
        self.interview._rejoin()
        writes = await self.until_writes(3)
        self.assertEqual(
            writes,
            [
                {
                    "phase": "transition",
                    "leadname": self.interview.persona.lead_name,
                    "awaiting": "ready",
                },
                {"phase": "paused_disconnected", "awaiting": ""},
                {
                    "phase": "transition",
                    "leadname": self.interview.persona.lead_name,
                    "awaiting": "ready",
                },
            ],
        )

    async def test_once_the_button_was_pressed_a_rejoin_does_not_ask_again(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.ctx.room.emit("data_received", ready_packet())
        self.interview._begin_disconnect()
        self.interview._rejoin()
        writes = await self.until_writes(3)
        self.assertEqual(writes[1], {"phase": "paused_disconnected", "awaiting": ""})
        self.assertEqual(
            writes[2], {"phase": "transition", "leadname": self.interview.persona.lead_name}
        )

    async def test_rpleft_is_cleared_once_by_the_first_phase_after_the_roleplay(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._enter(R1Phase.ROLEPLAY)
        self.interview._end_roleplay()
        self.interview._enter(R1Phase.WRAPUP)
        writes = await self.until_writes(4)
        self.assertEqual(
            [(write["phase"], write.get("rpleft")) for write in writes],
            [("transition", None), ("roleplay", "1200"), ("roleplay_exit", ""), ("wrapup", None)],
        )

    async def test_a_technical_stop_in_the_roleplay_clears_the_signals_with_aborted(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._enter(R1Phase.ROLEPLAY)
        await self.interview._finish("provider_error", system=True)
        self.assertEqual(
            self.writes()[-2:],
            [{"phase": "aborted", "rpleft": ""}, {"phase": "ended"}],
        )

    async def test_a_name_the_page_would_refuse_is_not_published(self) -> None:
        with mock.patch.object(R1Interview, "_lead_name", return_value=""):
            self.interview._enter(R1Phase.TRANSITION)
            writes = await self.until_writes(1)
        self.assertEqual(writes, [{"phase": "transition", "awaiting": "ready"}])

    async def test_a_persona_that_cannot_be_read_costs_only_the_name(self) -> None:
        with mock.patch.object(
            R1Interview, "persona", new_callable=mock.PropertyMock, side_effect=RuntimeError(POISON_TEXT)
        ):
            with self.capture_logs() as logs:
                self.interview._enter(R1Phase.TRANSITION)
                writes = await self.until_writes(1)
        self.assertEqual(writes, [{"phase": "transition", "awaiting": "ready"}])
        self.assertEqual(error_types(logs), ["r1_leadname_unavailable"])
        self.assertNotIn(POISON_TEXT, json.dumps(logs))


class TestLeadDisplayName(unittest.TestCase):
    """The name goes to a page that refuses anything outside letters, spaces, ' and -."""

    def test_the_contracts_names_are_accepted_as_they_are(self) -> None:
        for name in ("Meera Iyer", "Mary-Ann O'Neil", "Li", "Åsa Öberg", "A" * 40):
            with self.subTest(name=name):
                self.assertEqual(r1_session.lead_display_name(name), name)

    def test_whitespace_is_normalised(self) -> None:
        self.assertEqual(r1_session.lead_display_name("  Meera \t Iyer\n"), "Meera Iyer")

    def test_everything_else_is_not_published(self) -> None:
        for name in (
            "", "   ", None, 7, "A" * 41, "-Meera", "'Meera", "Meera1", "Meera_Iyer",
            "Meera <b>", "Meera, Iyer", "Meera.Iyer", "Meera​Iyer", "Meera (Edison)",
        ):
            with self.subTest(name=name):
                self.assertEqual(r1_session.lead_display_name(name), "")

    def test_every_persona_in_the_pool_is_publishable(self) -> None:
        from r1_personas import PERSONAS

        for persona in PERSONAS:
            for variant in persona.variants:
                with self.subTest(variant=variant.id):
                    self.assertEqual(r1_session.lead_display_name(variant.full_name), variant.full_name)


class TestRpleftHeartbeat(R1TestCase):
    """``rpleft`` is refreshed every 30 s while the role-play phase itself is running."""

    def writes(self) -> list[dict]:
        return list(self.ctx.room.local_participant.attributes)

    def heartbeats(self) -> list[dict]:
        return [write for write in self.writes() if set(write) == {"rpleft"}]

    async def test_it_publishes_only_rpleft_through_the_phase_writer_while_the_roleplay_runs(self) -> None:
        with mock.patch.object(r1_session, "RPLEFT_HEARTBEAT_SECONDS", 0.01):
            self.interview._enter(R1Phase.TRANSITION)
            self.interview._enter(R1Phase.ROLEPLAY)
            await self.until(lambda: len(self.heartbeats()) >= 2)
            first = int(self.heartbeats()[0]["rpleft"])
            self.clock.advance(60)
            await self.until(lambda: int(self.heartbeats()[-1]["rpleft"]) < first)
        self.assertLessEqual(int(self.heartbeats()[-1]["rpleft"]), first - 60)
        for beat in self.heartbeats():
            self.assertEqual(set(beat), {"rpleft"})
            self.assertTrue(beat["rpleft"].isdigit())
            self.assertLessEqual(int(beat["rpleft"]), 3600)

    async def test_the_default_interval_is_thirty_seconds_and_nothing_is_sent_before_it(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._enter(R1Phase.ROLEPLAY)
        await self.settle()
        self.assertEqual(self.heartbeats(), [])
        self.assertIsNotNone(self.interview._rpleft_heartbeat)
        self.assertFalse(self.interview._rpleft_heartbeat.done())

    async def test_it_is_silent_during_an_aside_and_resumes_after_it(self) -> None:
        with mock.patch.object(r1_session, "RPLEFT_HEARTBEAT_SECONDS", 0.01):
            self.interview._enter(R1Phase.TRANSITION)
            self.interview._enter(R1Phase.ROLEPLAY)
            await self.until(lambda: len(self.heartbeats()) >= 1)
            self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
            await self.settle()
            frozen = len(self.writes())
            await asyncio.sleep(0.1)
            self.assertEqual(len(self.writes()), frozen)  # the aside is a phase of its own
            self.ctx.room.emit("track_unmuted", FakeParticipant("candidate"), FakePublication())
            await self.until(lambda: len(self.writes()) > frozen + 1)

    async def test_it_stops_when_the_roleplay_is_over_and_nothing_follows_the_clearing_write(self) -> None:
        with mock.patch.object(r1_session, "RPLEFT_HEARTBEAT_SECONDS", 0.01):
            self.interview._enter(R1Phase.TRANSITION)
            self.interview._enter(R1Phase.ROLEPLAY)
            await self.until(lambda: len(self.heartbeats()) >= 1)
            self.interview._end_roleplay()
            self.interview._enter(R1Phase.WRAPUP)
            await self.settle()
            task = self.interview._rpleft_heartbeat
            self.assertIsNone(task)
            sent = len(self.writes())
            await asyncio.sleep(0.1)
        self.assertEqual(len(self.writes()), sent)
        self.assertEqual(self.writes()[-1], {"phase": "wrapup"})
        cleared = [write for write in self.writes() if write.get("rpleft") == ""]
        self.assertEqual(cleared, [{"phase": "roleplay_exit", "rpleft": ""}])

    async def test_it_does_not_run_before_the_roleplay_or_after_the_end(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.assertIsNone(self.interview._rpleft_heartbeat)
        self.interview._enter(R1Phase.ROLEPLAY)
        self.assertIsNotNone(self.interview._rpleft_heartbeat)
        task = self.interview._rpleft_heartbeat
        await self.interview._announce_ended()
        await self.settle()
        self.assertTrue(task.cancelled() or task.done())
        self.assertIsNone(self.interview._rpleft_heartbeat)

    async def test_a_reconnect_pause_keeps_the_heartbeat_and_a_pause_before_the_roleplay_never_starts_it(self) -> None:
        self.interview._begin_disconnect()
        self.assertIsNone(self.interview._rpleft_heartbeat)
        self.interview._rejoin()
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._enter(R1Phase.ROLEPLAY)
        task = self.interview._rpleft_heartbeat
        self.interview._begin_disconnect()
        self.assertIs(self.interview._rpleft_heartbeat, task)
        self.interview._rejoin()
        self.assertIs(self.interview._rpleft_heartbeat, task)
        self.assertFalse(task.done())

    async def test_a_stuck_writer_is_not_flooded_by_heartbeats(self) -> None:
        gate = asyncio.Event()
        sent: list[dict] = []

        async def stuck(attributes):
            await gate.wait()
            sent.append(dict(attributes))

        self.ctx.room.local_participant.set_attributes = stuck
        with mock.patch.object(r1_session, "RPLEFT_HEARTBEAT_SECONDS", 0.001):
            self.interview._enter(R1Phase.TRANSITION)
            self.interview._enter(R1Phase.ROLEPLAY)
            await asyncio.sleep(0.2)  # hundreds of ticks while the first write is stuck
            queued = list(self.interview._phase_queue)
        # The roleplay phase write is still queued, followed by at most ONE pending heartbeat.
        self.assertEqual(queued[0]["phase"], "roleplay")
        self.assertLessEqual(len(queued), 2)
        gate.set()
        await self.until(lambda: len(sent) >= 2)
        self.assertEqual([item.get("phase") for item in sent[:2]], ["transition", "roleplay"])

    async def test_writes_are_never_concurrent(self) -> None:
        in_flight = {"now": 0, "max": 0}
        sent: list[dict] = []

        async def tracked(attributes):
            in_flight["now"] += 1
            in_flight["max"] = max(in_flight["max"], in_flight["now"])
            await asyncio.sleep(0.002)
            sent.append(dict(attributes))
            in_flight["now"] -= 1

        self.ctx.room.local_participant.set_attributes = tracked
        with mock.patch.object(r1_session, "RPLEFT_HEARTBEAT_SECONDS", 0.001):
            self.interview._enter(R1Phase.TRANSITION)
            self.interview._enter(R1Phase.ROLEPLAY)
            await self.until(lambda: len(sent) >= 6)
            self.interview._end_roleplay()
        await self.settle()
        self.assertEqual(in_flight["max"], 1)

    async def test_a_failing_heartbeat_write_is_swallowed_and_does_not_stop_the_next(self) -> None:
        calls = {"n": 0}
        sent: list[dict] = []

        async def flaky(attributes):
            calls["n"] += 1
            if "rpleft" in attributes and "phase" not in attributes and calls["n"] == 3:
                raise RuntimeError(POISON_TEXT)
            sent.append(dict(attributes))

        self.ctx.room.local_participant.set_attributes = flaky
        with mock.patch.object(r1_session, "RPLEFT_HEARTBEAT_SECONDS", 0.01):
            with self.capture_logs() as logs:
                self.interview._enter(R1Phase.TRANSITION)
                self.interview._enter(R1Phase.ROLEPLAY)
                await self.until(lambda: calls["n"] >= 5)
        self.assertIn("r1_phase_publish_failed", error_types(logs))
        self.assertNotIn(POISON_TEXT, json.dumps(logs))
        self.assertGreaterEqual(len([item for item in sent if set(item) == {"rpleft"}]), 1)


class TestReadyButton(R1TestCase):
    """The page's "I'm ready" button reaches the worker as a server-sent ``r1ready`` message."""

    async def start_transition(self) -> asyncio.Task:
        """Enter the transition and start its driver, as ``run`` does after the briefing."""
        self.interview._enter(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        return task

    def press(self, **over) -> None:
        self.ctx.room.emit("data_received", ready_packet(**over))

    def rejected(self, logs: list[dict]) -> list[str]:
        return [
            line_.get("error_category", "")
            for line_ in logs
            if line_.get("error_type") == "r1_ready_rejected"
        ]

    async def test_the_topic_and_payload_are_the_contracts(self) -> None:
        self.assertEqual(r1_session.READY_TOPIC, "r1ready")
        self.assertRegex(r1_session.READY_TOPIC, r"^[a-z0-9]+$")
        self.assertEqual(
            (r1_session.READY_PAYLOAD_VERSION, r1_session.READY_PAYLOAD_KIND), (1, "ready")
        )
        self.assertIn("data_received", self.ctx.room.handlers)  # wired by wire_events

    async def test_the_topic_and_payload_are_the_ones_the_api_relays(self) -> None:
        api = HERE.parent / "api" / "src" / "routes" / "r1-candidate.ts"
        if not api.exists():
            self.skipTest("the API is not part of this checkout")
        source = api.read_text(encoding="utf-8")
        topic = re.search(r"R1_READY_TOPIC = '([^']+)'", source)
        payload = re.search(r"R1_READY_PAYLOAD = \{ v: (\d+), kind: '([^']+)' \}", source)
        self.assertIsNotNone(topic)
        self.assertIsNotNone(payload)
        self.assertEqual(topic.group(1), r1_session.READY_TOPIC)
        self.assertEqual(
            (int(payload.group(1)), payload.group(2)),
            (r1_session.READY_PAYLOAD_VERSION, r1_session.READY_PAYLOAD_KIND),
        )
        # The API sends JSON.stringify of that object; the worker accepts exactly those bytes.
        self.assertTrue(
            r1_session.ready_payload_ok(
                json.dumps(
                    {"v": int(payload.group(1)), "kind": payload.group(2)}, separators=(",", ":")
                ).encode("utf-8")
            )
        )

    async def test_a_press_while_waiting_picks_up_at_once_without_a_nudge(self) -> None:
        task = await self.start_transition()
        self.assertFalse(task.done())
        self.press()
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])
        self.assertNotIn(self.spoken_line("L-TRANSITION-NUDGE"), self.session.spoken)

    async def test_a_press_while_the_briefing_is_still_playing_is_not_lost(self) -> None:
        # The driver has not started waiting yet: `_run_transition` forgets the turns queued
        # before it begins, and a queued "ready" would go with them.  The press is latched.
        self.interview._enter(R1Phase.TRANSITION)
        self.press()
        self.interview.note_turn("a stray answer from the briefing")
        self.assertIsNone(await asyncio.wait_for(self.interview._run_transition(), 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])

    async def test_a_press_during_the_nudge_ends_the_wait_right_after_it(self) -> None:
        task = await self.start_transition()
        self.assertTrue(await self.answer("No questions."))  # the nudge (M1: no consent yet)
        await self.until(
            lambda: self.session.spoken.count(self.spoken_line("L-TRANSITION-NUDGE")) == 1
        )
        self.press()
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-TRANSITION-NUDGE")), 1)
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-PICKUP")), 1)

    async def test_a_press_is_not_a_transcript_row_or_a_turn(self) -> None:
        task = await self.start_transition()
        self.press()
        await asyncio.wait_for(task, 10.0)
        await self.flush()
        self.assertEqual([row for row in self.writer.saved if row["speaker"] == "candidate"], [])
        self.assertTrue(self.interview._turns.empty())

    async def test_the_spoken_ready_still_works_and_is_not_a_button_press(self) -> None:
        task = await self.start_transition()
        self.final_transcript("ok, ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertFalse(self.interview._ready_latched)
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])

    async def test_a_message_that_names_a_sender_is_never_the_button(self) -> None:
        # Server-sent data has no participant.  A candidate's token cannot publish data at all;
        # if a grant ever changed, a participant's message must still not move the interview.
        await self.start_transition()
        with self.capture_logs() as logs:
            self.press(participant=FakeParticipant("candidate"))
            self.press(participant=FakeParticipant("someone-else", kind=SIP))
        self.assertFalse(self.interview._ready_latched)
        self.assertEqual(self.rejected(logs), ["sender", "sender"])
        self.assertTrue(self.interview._awaiting_ready)

    async def test_only_the_exact_payload_is_the_button(self) -> None:
        await self.start_transition()
        bad = [
            b"",
            b"ready",
            b"not json",
            b"\xff\xfe",
            b'["ready"]',
            b'"ready"',
            b"null",
            b'{"v":1}',
            b'{"kind":"ready"}',
            b'{"v":2,"kind":"ready"}',
            b'{"v":"1","kind":"ready"}',
            b'{"v":true,"kind":"ready"}',
            b'{"v":1.0,"kind":"ready"}',
            b'{"v":1,"kind":"READY"}',
            b'{"v":1,"kind":"go"}',
            b'{"v":1,"kind":"ready","extra":1}',
            b'{"v":1,"kind":"ready","phase":"roleplay"}',
            b'{"v":1,"kind":"ready"}' + b" " * 200,
            None,
            "not bytes",
            12,
        ]
        with self.capture_logs() as logs:
            for data in bad:
                self.press(data=data)
        self.assertFalse(self.interview._ready_latched)
        self.assertEqual(self.rejected(logs), ["payload"] * len(bad))
        for variant in (bytearray(READY_BYTES), memoryview(READY_BYTES), b' {"v": 1, "kind": "ready"} '):
            with self.subTest(variant=type(variant).__name__):
                self.assertTrue(r1_session.ready_payload_ok(variant))

    async def test_another_topic_is_never_the_button_and_leaves_one_line_while_awaited(self) -> None:
        # Another topic is none of our business.  While the button is awaited, the FIRST message of
        # another topic is logged once (a closed label for the topic, nothing of the payload): the
        # relay has only run against fakes, and a topic the real SFU changed would otherwise be
        # invisible.
        await self.start_transition()
        topics = (None, "", "lk.chat", "R1READY", "r1ready ", "r1.ready", "ready")
        with self.capture_logs() as logs:
            for topic in topics:
                self.press(topic=topic)
        self.assertFalse(self.interview._ready_latched)
        self.assertEqual(error_types(logs), ["r1_data_ignored"])
        self.assertEqual(logs[0]["error_category"], "topic")
        self.assertEqual(logs[0]["schema"], "none")  # the first one had no topic at all
        self.assertEqual(logs[0]["phase"], "transition")
        self.assertNotIn("data", logs[0])
        self.assertTrue(self.interview._awaiting_ready)  # and the real button still works
        self.press()
        self.assertTrue(self.interview._ready_latched)

    def test_the_topic_label_is_a_closed_vocabulary_never_the_topic(self) -> None:
        label = r1_session.topic_label
        for topic, expected in (
            (None, "none"), ("", "none"), (12, "none"), (b"r1ready", "none"),
            ("R1READY", "spelling"), ("r1.ready", "spelling"), ("r1ready ", "spelling"),
            ("R1_Ready", "spelling"),
            ("lk.chat", "livekit"), ("lk.transcription", "livekit"),
            ("ready", "other"), ("r1ready2", "other"), ("candidate.secret.name", "other"),
        ):
            with self.subTest(topic=topic):
                self.assertEqual(label(topic), expected)
        self.assertEqual(label("r1ready"), "spelling")  # only logged when it was rejected anyway

    async def test_a_misspelt_topic_is_labelled_so_a_mismatch_on_the_sfu_can_be_diagnosed(
        self,
    ) -> None:
        await self.start_transition()
        with self.capture_logs() as logs:
            self.press(topic="R1Ready")
        self.assertEqual(logs[0]["schema"], "spelling")
        self.assertNotIn("R1Ready", json.dumps(logs))

    async def test_another_topic_is_silent_when_the_button_is_not_awaited(self) -> None:
        with self.capture_logs() as logs:  # the icebreaker: nobody asked for a press
            self.press(topic="lk.chat")
            self.press(topic=None)
        self.assertEqual(logs, [])

    async def test_it_is_accepted_only_in_the_transition(self) -> None:
        def roleplay() -> None:
            self.interview._enter(R1Phase.TRANSITION)
            self.interview._enter(R1Phase.ROLEPLAY)

        def aside() -> None:
            roleplay()
            self.interview._enter(R1Phase.ASIDE)

        def roleplay_exit() -> None:
            roleplay()
            self.interview._end_roleplay()

        def wrapup() -> None:
            roleplay_exit()
            self.interview._enter(R1Phase.WRAPUP)

        for name, reach in (
            ("icebreaker", lambda: None),
            ("roleplay", roleplay),
            ("aside", aside),
            ("roleplay_exit", roleplay_exit),
            ("wrapup", wrapup),
        ):
            with self.subTest(phase=name):
                await self.asyncSetUp()
                reach()
                self.assertEqual(self.interview.machine.phase.value, name)
                with self.capture_logs() as logs:
                    self.press()
                self.assertFalse(self.interview._ready_latched)
                self.assertEqual(self.rejected(logs), ["not_awaiting"])

    async def test_it_is_not_accepted_before_the_worker_asked(self) -> None:
        # The fixture is in the icebreaker: the page was never told `awaiting=ready`.
        with self.capture_logs() as logs:
            self.press()
        self.assertFalse(self.interview._ready_latched)
        self.assertEqual(self.rejected(logs), ["not_awaiting"])

    async def test_it_is_not_accepted_while_the_candidate_is_disconnected(self) -> None:
        await self.start_transition()
        self.interview._begin_disconnect()
        with self.capture_logs() as logs:
            self.press()
        self.assertFalse(self.interview._ready_latched)
        self.assertEqual(self.rejected(logs), ["not_awaiting"])
        self.interview._rejoin()
        self.press()  # asked again at the rejoin: now it counts
        self.assertTrue(self.interview._ready_latched)

    async def test_a_press_after_the_wait_is_over_is_ignored(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        self.final_transcript("ready")
        await asyncio.wait_for(task, 10.0)
        # The learner is picking up; the phase has not moved on yet, but nothing is awaited.
        self.assertIs(self.interview.machine.phase, R1Phase.TRANSITION)
        with self.capture_logs() as logs:
            self.press()
        self.assertFalse(self.interview._ready_latched)
        self.assertEqual(self.rejected(logs), ["not_awaiting"])

    async def test_a_second_press_changes_nothing(self) -> None:
        task = await self.start_transition()
        with self.capture_logs() as logs:
            self.press()
            self.press()
        await asyncio.wait_for(task, 10.0)
        self.assertEqual(self.rejected(logs), ["not_awaiting"])
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-PICKUP")), 1)

    async def test_nothing_is_accepted_once_the_exit_has_begun(self) -> None:
        await self.start_transition()
        self.interview._begin_exit()
        with self.capture_logs() as logs:
            self.press()
        self.assertFalse(self.interview._ready_latched)
        self.assertEqual(logs, [])

    async def test_the_press_is_logged_by_label_only(self) -> None:
        await self.start_transition()
        with self.capture_logs() as logs:
            self.press()
        self.assertEqual(error_types(logs), ["r1_ready_button"])
        self.assertNotIn(self.interview.persona.lead_name, json.dumps(logs))

    async def test_a_stop_during_the_wait_still_wins(self) -> None:
        task = await self.start_transition()
        self.interview._on_residency_deadline()
        self.assertEqual(await asyncio.wait_for(task, 10.0), "residency_timeout")
        self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)

    async def test_await_turn_returns_pressed_when_the_condition_holds(self) -> None:
        flag = {"on": False}
        task = asyncio.create_task(
            self.interview._await_turn(30.0, until=lambda: flag["on"])
        )
        await self.settle()
        self.assertFalse(task.done())
        flag["on"] = True
        self.interview._wake()
        self.assertEqual(await asyncio.wait_for(task, 10.0), (r1_session.PRESSED, None))

    async def test_a_whole_interview_takes_a_press_made_while_the_briefing_plays(self) -> None:
        # Through ``run``: the press arrives while L-TRANSITION is still being spoken, before
        # the driver has started waiting for "ready" (and so before it forgets queued turns).
        run = await self.start_interview()
        run.session.playout_seconds = 0.2  # the briefing takes a moment to play
        run.clock.advance(271)
        run.interview._wake()
        await self.until(lambda: run.interview.machine.phase is R1Phase.TRANSITION)
        self.assertFalse(self.spoken_and_played("L-TRANSITION"))
        run.context.room.emit("data_received", ready_packet())
        await self.until(lambda: run.interview.machine.phase is R1Phase.ROLEPLAY)
        self.assertEqual(run.session.spoken.count(self.spoken_line("L-PICKUP")), 1)
        self.assertNotIn(self.spoken_line("L-TRANSITION-NUDGE"), run.session.spoken)
        await self.until(lambda: len(run.context.room.local_participant.attributes) >= 2)
        writes = run.context.room.local_participant.attributes
        self.assertEqual(
            [write["phase"] for write in writes if write["phase"] in ("transition", "roleplay")],
            ["transition", "roleplay"],
        )
        self.assertEqual(writes[-1]["awaiting"], "")
        self.assertTrue(writes[-1]["rpleft"].isdigit())
        await self.drain_cancel(run)


POISON_TEXT = "Quokka-utterance-4417"


class TestEarlyFailureSettlesTheAttempt(R1TestCase):
    """A failure before the context arrived still posts its attempt outcome.

    The attempt id IS the session id, so the writer is built with it from the start.  The
    audit's 'r1_attempt_outcome_skipped_no_attempt' came from the pre-context writer.
    """

    async def asyncSetUp(self) -> None:
        self.order: list = []
        self.ctx = FakeContext(self.order)
        self.posted: list[tuple[str, dict]] = []

        def requester(path, payload, _timeout=10.0):
            self.posted.append((path, dict(payload)))
            return {}

        self.session = FakeSession(log=self.order)
        patches = [
            # The REAL writer, with a recording requester and the lifecycle CAS faked.
            mock.patch.object(
                r1_session, "R1TurnWriter",
                lambda *args, **kwargs: R1TurnWriter(*args, requester=requester, **kwargs),
            ),
            mock.patch.object(
                persistence, "fail_session",
                mock.AsyncMock(return_value=persistence.LifecycleOutcome(
                    persistence.LifecycleOutcome.SUCCESS)),
            ),
            mock.patch.object(
                persistence, "complete_session",
                mock.AsyncMock(return_value=persistence.LifecycleOutcome(
                    persistence.LifecycleOutcome.SUCCESS)),
            ),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    async def factory(self, _ctx, _context):
        return self.session

    def outcomes(self) -> list[dict]:
        return [payload for path, payload in self.posted
                if path == "/api/internal/r1/attempt-outcome"]

    async def test_a_connect_failure_posts_provider_error_for_the_session(self) -> None:
        self.ctx.connect_error = RuntimeError("peer connection failed")
        outcome = await run_r1_session(self.ctx, session_factory=self.factory)
        self.assertEqual(outcome, "provider_error")
        self.assertEqual(
            self.outcomes(), [{"attempt_id": SESSION_ID, "outcome": "provider_error"}]
        )

    async def test_a_context_failure_posts_context_failed_for_the_session(self) -> None:
        async def failing_fetch(_room):
            raise r1_context.R1ContextError("r1_context_unavailable")

        with mock.patch.object(r1_session, "fetch_context", failing_fetch):
            outcome = await run_r1_session(self.ctx, session_factory=self.factory)
        self.assertEqual(outcome, "context_failed")
        self.assertEqual(
            self.outcomes(), [{"attempt_id": SESSION_ID, "outcome": "context_failed"}]
        )

    async def test_a_cancellation_before_the_context_posts_shutdown_forced(self) -> None:
        self.ctx.connect_hangs = True
        task = asyncio.create_task(run_r1_session(self.ctx, session_factory=self.factory))
        await self.until(lambda: self.ctx.connects == 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(
            self.outcomes(), [{"attempt_id": SESSION_ID, "outcome": "shutdown_forced"}]
        )

    async def test_a_configuration_failure_posts_with_the_contexts_attempt_id(self) -> None:
        async def fetch(_room):
            return {"first_name": "Asha", "attempt_id": SESSION_ID, "attempt": {}, "settings": {}}

        async def broken_factory(_ctx, _context):
            raise r1_llm.R1LLMConfigurationError("r1_llm_key_missing")

        with mock.patch.object(r1_session, "fetch_context", fetch):
            outcome = await run_r1_session(self.ctx, session_factory=broken_factory)
        self.assertEqual(outcome, "configuration_failed")
        self.assertEqual(
            self.outcomes(), [{"attempt_id": SESSION_ID, "outcome": "configuration_failed"}]
        )

    async def test_a_room_without_a_session_id_posts_no_outcome(self) -> None:
        self.ctx.room.name = "not-a-screening-room"
        self.ctx.connect_error = RuntimeError("peer connection failed")
        await run_r1_session(self.ctx, session_factory=self.factory)
        self.assertEqual(self.outcomes(), [])


class TestEndsAfterTheRoleplay(R1TestCase):
    """A candidate who leaves or goes silent after the role-play has finished completes it.

    ``complete`` is the only status the scorer takes (the 0116 trigger enqueues r1.assessment
    on 'completed'), and ``r1_settle_attempt`` counts the attempt as complete.  Before the
    role-play is over the same departure stays ``candidate_left`` (a failed, unscored session).
    """

    def enter_wrapup(self) -> None:
        self.enter_roleplay()
        self.interview._end_roleplay()
        self.interview.machine.transition(R1Phase.WRAPUP)

    def leave(self) -> None:
        self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))

    async def test_leaving_during_the_wrapup_completes_the_session(self) -> None:
        self.enter_wrapup()
        with mock.patch.object(r1_session, "rejoin_grace_seconds", return_value=0.01):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            self.leave()
            self.assertEqual(await asyncio.wait_for(task, 10.0), "complete")

    async def test_leaving_during_the_exit_line_completes_the_session(self) -> None:
        self.enter_roleplay()
        self.interview._end_roleplay()  # ROLEPLAY_EXIT: the learner has just stepped out
        with mock.patch.object(r1_session, "rejoin_grace_seconds", return_value=0.01):
            self.leave()
            self.assertEqual(await self.interview._handle_attention(), "complete")

    async def test_leaving_during_the_roleplay_stays_candidate_left(self) -> None:
        self.enter_roleplay()
        with mock.patch.object(r1_session, "rejoin_grace_seconds", return_value=0.01):
            task = asyncio.create_task(self.interview._roleplay_turn())
            await self.settle()
            self.leave()
            self.assertEqual(await asyncio.wait_for(task, 10.0), "candidate_left")

    async def test_leaving_before_the_roleplay_is_over_stays_candidate_left(self) -> None:
        for phase in ("icebreaker", "roleplay"):
            with self.subTest(phase=phase):
                await self.asyncSetUp()  # a fresh interview per phase
                if phase == "roleplay":
                    self.enter_roleplay()
                with mock.patch.object(r1_session, "rejoin_grace_seconds", return_value=0.01):
                    self.leave()
                    self.assertEqual(await self.interview._handle_attention(), "candidate_left")

    async def test_a_candidate_who_comes_back_within_the_grace_resumes_the_wrapup(self) -> None:
        self.enter_wrapup()
        task = asyncio.create_task(self.interview._run_wrapup())
        await self.settle()
        self.leave()
        await self.until(lambda: self.interview.machine.phase is R1Phase.PAUSED_DISCONNECTED)
        self.ctx.room.emit("participant_connected", FakeParticipant("candidate"))
        await self.until(lambda: self.spoken_and_played("L-REJOIN"))
        self.assertIs(self.interview.machine.phase, R1Phase.WRAPUP)
        self.assertFalse(task.done())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_losing_the_room_after_the_candidate_left_in_wrapup_completes(self) -> None:
        self.enter_wrapup()
        self.leave()
        self.ctx.room.emit("disconnected", "room closed")
        self.assertEqual(self.interview._stop_outcome(), "complete")
        self.assertEqual(self.interview._cancel_outcome(), "complete")

    async def test_losing_the_room_in_the_roleplay_stays_candidate_left(self) -> None:
        self.enter_roleplay()
        self.leave()
        self.ctx.room.emit("disconnected", "room closed")
        self.assertEqual(self.interview._stop_outcome(), "candidate_left")

    async def test_a_room_lost_while_the_candidate_is_present_is_still_a_system_stop(self) -> None:
        self.enter_wrapup()
        self.ctx.room.emit("disconnected", "room closed")
        self.assertEqual(self.interview._stop_outcome(), "shutdown_forced")

    async def test_the_clock_running_out_in_the_wrapup_completes_the_role_play_does_not(
        self,
    ) -> None:
        self.enter_wrapup()
        self.interview._on_residency_deadline()
        self.assertEqual(self.interview._stop_outcome(), "complete")
        await self.asyncSetUp()
        self.enter_roleplay()
        self.interview._on_forced_close_deadline()
        self.assertEqual(self.interview._stop_outcome(), "residency_timeout")

    async def test_a_provider_failure_in_the_wrapup_is_still_a_stop_on_our_side(self) -> None:
        self.enter_wrapup()
        self.interview._provider_abort = True
        self.assertEqual(self.interview._stop_outcome(), "provider_error")

    async def test_a_complete_stop_says_the_closing_line_not_the_apology(self) -> None:
        self.enter_wrapup()
        self.assertEqual(await self.interview._finish_stop("complete"), "complete")
        self.assertEqual(self.session.spoken, [self.spoken_line("L-CLOSE")])
        self.assertNotIn(self.spoken_line("L-SYSTEM-STOP"), self.session.spoken)

    async def test_a_complete_stop_for_a_candidate_who_is_gone_says_nothing(self) -> None:
        self.enter_wrapup()
        self.leave()
        self.assertEqual(await self.interview._finish_stop("complete"), "complete")
        self.assertEqual(self.session.spoken, [])


class TestRecordingSeams(R1TestCase):
    """The recorder is optional: three seams, none of which can reach the interview or its exit.

    ``r1_recorder.R1Recorder`` is covered by ``test_r1_recorder``; these tests use plain hooks, so
    they prove WHERE the interview calls them and that nothing they do can change the interview.
    """

    def seam_run(self, **hooks) -> SimpleNamespace:
        ctx = FakeContext(self.order)
        ctx.room.remote_participants["candidate"] = FakeParticipant("candidate")
        session = FakeSession(log=self.order)
        interview = R1Interview(
            ctx,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            session,
            self.writer,
            clock=Clock(),
            **hooks,
        )
        task = asyncio.create_task(interview.run())
        return SimpleNamespace(interview=interview, context=ctx, session=session, task=task)

    async def to_icebreaker(self, run: SimpleNamespace) -> None:
        await self.pass_sound_check(run.session, run.interview)
        await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)

    def names(self) -> list:
        return [item if isinstance(item, str) else item[0] for item in self.order]

    def shared_exit_steps(self) -> list:
        """The exit steps that share the 30 s budget, in the order they ran."""
        return [name for name in self.names() if name in ("recording", "ledger", "terminal", "outcome")]

    async def test_the_recorder_starts_after_the_sdk_session_and_before_the_opening_line(self) -> None:
        async def start(identity):
            self.order.append(("recorder_start", identity))

        run = self.seam_run(recorder_start=start)
        await self.to_icebreaker(run)
        opening = ("play_start", self.spoken_line(self.opening_line_ids()[0]))
        await self.until(lambda: opening in self.order)
        order = self.order
        self.assertLess(order.index(("start", None)), order.index(("recorder_start", "candidate")))
        self.assertLess(order.index(("recorder_start", "candidate")), order.index(opening))
        await self.drain_cancel(run)

    async def test_stop_is_the_first_exit_step_and_finish_the_first_shared_one(self) -> None:
        run = self.seam_run(
            recorder_stop=lambda outcome: self.order.append(("recorder_stop", outcome)),
            recorder_finish=lambda: append(self.order, "recording"),
        )
        await self.to_icebreaker(run)
        await self.drain_cancel(run)
        order = self.order
        self.assertEqual(self.names().count("recorder_stop"), 1)  # `_begin_exit` runs twice; stop once
        stop = order.index(("recorder_stop", "shutdown_forced"))  # the outcome rides along
        self.assertLess(stop, order.index("recording"))
        self.assertLess(order.index("recording"), order.index("ledger"))
        self.assertLess(order.index("ledger"), order.index("terminal"))

    async def test_capture_stops_before_the_transcript_drain_so_the_finish_overlaps_it(self) -> None:
        stamps: dict[str, float] = {}

        def stop(_outcome) -> None:
            stamps["stop"] = asyncio.get_running_loop().time()

        async def ledger(*_args) -> None:
            stamps["ledger"] = asyncio.get_running_loop().time()

        self.writer.usage_disconnect = ledger
        self.writer.save_hangs = True  # a transcript write that never ends: the drain waits it out
        run = self.seam_run(recorder_stop=stop)
        await self.to_icebreaker(run)
        first = self.spoken_line(self.opening_line_ids()[0])
        await self.until(lambda: ("play_end", first) in self.order)
        with mock.patch.object(r1_session, "TRANSCRIPT_DRAIN_SECONDS", 0.4):
            await self.drain_cancel(run)
        self.assertGreaterEqual(stamps["ledger"] - stamps["stop"], 0.3)

    async def test_a_failing_start_is_logged_by_type_and_the_interview_goes_on(self) -> None:
        async def start(_identity):
            raise RuntimeError("boom with a url https://r2.example.test/x?X-Amz-Signature=deadbeef")

        run = self.seam_run(recorder_start=start)
        with self.capture_logs() as logs:
            await self.to_icebreaker(run)
            first = self.spoken_line(self.opening_line_ids()[0])
            await self.until(lambda: ("play_end", first) in self.order)
            await self.drain_cancel(run)
        failed = [l for l in logs if l["error_type"] == "r1_recorder_start_failed"]
        self.assertEqual([l["error_category"] for l in failed], ["RuntimeError"])
        self.assertNotIn("X-Amz-Signature", json.dumps(logs))
        self.assertIn(("play_start", self.spoken_line(self.opening_line_ids()[0])), self.order)

    async def test_a_start_that_never_returns_is_bounded_and_skipped(self) -> None:
        release = asyncio.Event()
        self.addCleanup(release.set)

        async def start(_identity):
            await release.wait()

        with mock.patch.object(r1_session, "RECORDER_START_SECONDS", 0.05):
            run = self.seam_run(recorder_start=start)
            with self.capture_logs() as logs:
                await self.to_icebreaker(run)
                first = self.spoken_line(self.opening_line_ids()[0])
                await self.until(lambda: ("play_end", first) in self.order)
                await self.drain_cancel(run)
        self.assertIn("r1_recorder_start_failed", error_types(logs))

    async def test_a_failing_stop_never_touches_the_exit(self) -> None:
        def stop(_outcome) -> None:
            raise RuntimeError("stop exploded")

        run = self.seam_run(recorder_stop=stop, recorder_finish=lambda: append(self.order, "recording"))
        with self.capture_logs() as logs:
            await self.to_icebreaker(run)
            await self.drain_cancel(run)
        self.assertEqual(error_types(logs).count("r1_recorder_stop_failed"), 1)
        for step in ("recording", "ledger", "terminal", "outcome"):
            self.assertIn(step, self.names())
        self.assertEqual(run.context.deleted_rooms, [None])

    async def test_a_failing_finish_does_not_skip_the_ledger_the_terminal_write_or_the_outcome(self) -> None:
        async def finish() -> None:
            raise RuntimeError("finish exploded")

        run = self.seam_run(recorder_finish=finish)
        with self.capture_logs() as logs:
            await self.to_icebreaker(run)
            await self.drain_cancel(run)
        failed = [l for l in logs if l["error_type"] == "r1_exit_step_failed" and l["phase"] == "recording"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(self.shared_exit_steps(), ["ledger", "terminal", "outcome"])

    async def test_a_finish_that_never_returns_cannot_spend_the_budget_of_the_terminal_write(self) -> None:
        release = asyncio.Event()
        self.addCleanup(release.set)

        async def finish() -> None:
            await release.wait()

        # The recording's cap is its share of the exit budget, not the whole 30 s.
        with mock.patch.object(r1_session, "RECORDING_FINISH_SECONDS", 0.1):
            run = self.seam_run(recorder_finish=finish)
            with self.capture_logs() as logs:
                await self.to_icebreaker(run)
                started = asyncio.get_running_loop().time()
                await self.drain_cancel(run)
        self.assertLess(asyncio.get_running_loop().time() - started, 5.0)
        for step in ("ledger", "terminal", "outcome"):
            self.assertIn(step, self.names())
        timed_out = [l for l in logs if l["error_type"] == "r1_exit_step_failed" and l["phase"] == "recording"]
        self.assertEqual([l["error_category"] for l in timed_out], ["TimeoutError"])

    async def test_without_hooks_the_interview_behaves_exactly_as_before(self) -> None:
        run = self.seam_run()
        await self.to_icebreaker(run)
        await self.drain_cancel(run)
        self.assertEqual(self.shared_exit_steps(), ["ledger", "terminal", "outcome"])
        self.assertEqual(run.context.deleted_rooms, [None])

class TestRecordingWiringInTheRunner(unittest.IsolatedAsyncioTestCase):
    """``run_r1_session``: the connect option, and what it hands the interview."""

    def rig(self) -> SimpleNamespace:
        order: list = []
        ctx = FakeContext(order)
        ctx.room.remote_participants["candidate"] = FakeParticipant("candidate")
        writer = FakeWriter(order, activate_ok=False)  # the run ends at once: only the wiring is tested
        session = FakeSession(log=order)
        seen: dict = {}
        original = R1Interview.__init__

        def spy(self_, *args, **kwargs):
            seen.update(kwargs)
            original(self_, *args, **kwargs)

        async def fetch(_room):
            return {
                "first_name": "Asha", "candidate_identity": "candidate", "attempt": {}, "settings": {},
                "recording": {"mode": "audio"},
            }

        async def factory(_ctx, _context):
            return session

        return SimpleNamespace(ctx=ctx, writer=writer, seen=seen, spy=spy, fetch=fetch, factory=factory, order=order)

    async def run_it(self, rig: SimpleNamespace):
        with mock.patch.object(r1_session, "fetch_context", rig.fetch), mock.patch.object(
            r1_session, "R1TurnWriter", lambda *_a, **_k: rig.writer
        ), mock.patch.object(R1Interview, "__init__", rig.spy):
            return await asyncio.wait_for(run_r1_session(rig.ctx, session_factory=rig.factory), 10.0)

    async def test_the_worker_connects_audio_only_so_the_camera_is_not_forwarded(self) -> None:
        rig = self.rig()
        await self.run_it(rig)
        self.assertEqual(rig.ctx.connects, 1)
        self.assertEqual(list(rig.ctx.connect_kwargs), ["auto_subscribe"])
        try:
            from livekit.agents import AutoSubscribe
        except ImportError:  # bare python: the stand-in is the enum's value
            self.assertEqual(rig.ctx.connect_kwargs["auto_subscribe"], "audio_only")
        else:
            self.assertIs(rig.ctx.connect_kwargs["auto_subscribe"], AutoSubscribe.AUDIO_ONLY)

    async def test_with_the_locks_off_nothing_recording_related_exists(self) -> None:
        import r1_recorder

        rig = self.rig()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("R1_RECORDING", None)
            os.environ.pop("R1_VIDEO_RECORDING", None)
            with mock.patch.object(r1_recorder, "EncoderProcess", side_effect=AssertionError("encoder")), \
                    mock.patch.object(r1_recorder.Spool, "create", side_effect=AssertionError("spool")), \
                    mock.patch.object(r1_recorder.subprocess, "Popen", side_effect=AssertionError("process")), \
                    mock.patch.object(r1_recorder.HttpClient, "request", side_effect=AssertionError("network")):
                outcome = await self.run_it(rig)
        self.assertEqual(outcome, "configuration_failed")
        self.assertFalse({"recorder_start", "recorder_stop", "recorder_finish"} & set(rig.seen))

    async def test_a_recorder_that_is_built_gets_its_three_seams_and_its_own_finish_budget(self) -> None:
        import r1_recorder

        rig = self.rig()
        calls: list = []

        class Recorder:
            async def start(self, identity):
                calls.append(("start", identity))

            def stop(self, outcome=None):
                calls.append(("stop", outcome))

            async def finish(self):
                calls.append(("finish",))

        recorder = Recorder()
        builds: list = []

        def build(ctx, context, session, room, session_id, **kwargs):
            builds.append((context.get("recording"), room, session_id, kwargs))
            return recorder

        with mock.patch.object(r1_recorder, "build_r1_recorder", build):
            await self.run_it(rig)
        self.assertEqual(builds[0][0], {"mode": "audio"})
        self.assertEqual(builds[0][1:3], (ROOM_NAME, SESSION_ID))
        self.assertEqual(
            builds[0][3], {"finish_seconds": r1_session._scaled(r1_session.RECORDING_FINISH_SECONDS)}
        )
        self.assertEqual(rig.seen["recorder_start"], recorder.start)
        self.assertEqual(rig.seen["recorder_stop"], recorder.stop)
        self.assertEqual(rig.seen["recorder_finish"], recorder.finish)
        # The run never reached the opening (activation failed): the recorder was stopped and
        # finished (so it can clean its spool) but never started.
        self.assertEqual(calls, [("stop", "configuration_failed"), ("finish",)])

    async def test_a_recorder_that_cannot_be_built_is_logged_and_the_interview_still_runs(self) -> None:
        import r1_recorder

        rig = self.rig()

        def build(*_args, **_kwargs):
            raise RuntimeError("no encoder " + "https://r2.example.test/x?X-Amz-Signature=deadbeef")

        with mock.patch.object(r1_recorder, "build_r1_recorder", build):
            with capture_r1_logs() as logs:
                outcome = await self.run_it(rig)
        self.assertEqual(outcome, "configuration_failed")
        self.assertIn("r1_recorder_unavailable", error_types(logs))
        self.assertNotIn("X-Amz-Signature", json.dumps(logs))
        self.assertFalse({"recorder_start", "recorder_stop", "recorder_finish"} & set(rig.seen))


class TestTurnAnchors(R1TestCase):
    """Every transcript row can carry the epoch time its turn began, from the SDK's own clocks."""

    T0 = 1_760_000_000.0  # a plausible wall-clock second

    def speak(self, text: str, *, created_at=None, metrics=None, claim: bool = True) -> int:
        """Play a bot line the way the SDK reports it; returns the row's transcript index."""
        handle = FakeSpeechHandle(text)
        self.session.current_speech = handle
        self.session.emit(
            "speech_created", SimpleNamespace(speech_handle=handle, source="say", user_initiated=True)
        )
        if claim:
            extra = {} if created_at is None else {"created_at": created_at}
            self.session.emit(
                "agent_state_changed",
                SimpleNamespace(old_state="listening", new_state="speaking", **extra),
            )
        message = FakeChatMessage(text)
        if metrics is not None:
            message.metrics = metrics
        handle.chat_items.append(message)
        self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        self.session.current_speech = None
        return self.interview._turn_index

    async def anchor_of(self, index: int):
        await self.flush()
        return self.writer.anchors[index]

    async def test_a_bot_row_takes_the_sdks_started_speaking_metric(self) -> None:
        index = self.speak("one", metrics={"started_speaking_at": self.T0 + 0.25, "stopped_speaking_at": self.T0 + 3})
        self.assertEqual(await self.anchor_of(index), 1_760_000_000_250)

    async def test_the_metric_wins_over_the_speaking_event(self) -> None:
        index = self.speak("two", created_at=self.T0 + 9.0, metrics={"started_speaking_at": self.T0 + 1.0})
        self.assertEqual(await self.anchor_of(index), 1_760_000_001_000)

    async def test_without_a_metric_the_claiming_speaking_event_is_the_anchor(self) -> None:
        index = self.speak("three", created_at=self.T0 + 2.5)
        self.assertEqual(await self.anchor_of(index), 1_760_000_002_500)

    async def test_an_unusable_metric_falls_back_to_the_event_and_then_to_nothing(self) -> None:
        for bad in (None, 0, -5, float("nan"), float("inf"), "soon", True, 5e12, [1]):
            with self.subTest(metric=bad):
                index = self.speak("x", created_at=self.T0 + 4.0, metrics={"started_speaking_at": bad})
                self.assertEqual(await self.anchor_of(index), 1_760_000_004_000)
        index = self.speak("y", metrics={"started_speaking_at": float("nan")})
        self.assertIsNone(await self.anchor_of(index))

    async def test_a_row_with_no_anchor_is_written_exactly_as_before_never_with_the_write_time(self) -> None:
        index = self.speak("bare")  # no metric, and the speaking event carries no created_at
        await self.flush()
        self.assertIsNone(self.writer.anchors[index])
        self.assertIn(frozenset({"interrupted"}), self.writer.save_kwarg_names)
        self.assertNotIn("started_at_ms", set().union(*self.writer.save_kwarg_names))

    async def test_a_row_that_never_reported_speaking_has_no_event_anchor(self) -> None:
        index = self.speak("silent claim", claim=False)
        self.assertIsNone(await self.anchor_of(index))

    def say_as_candidate(self, text: str, *, spoke_at=None, final_at=None) -> int:
        if spoke_at is not None:
            self.session.emit(
                "user_state_changed",
                SimpleNamespace(old_state="listening", new_state="speaking", created_at=spoke_at),
            )
        extra = {} if final_at is None else {"created_at": final_at}
        self.session.emit(
            "user_input_transcribed", SimpleNamespace(is_final=True, transcript=text, **extra)
        )
        index = self.interview._open_row.index
        self.interview._flush_candidate_row()
        return index

    async def test_a_candidate_row_starts_where_the_latest_speaking_event_before_its_final_began(self) -> None:
        index = self.say_as_candidate("hello there", spoke_at=self.T0 + 5.0, final_at=self.T0 + 6.4)
        self.assertEqual(await self.anchor_of(index), 1_760_000_005_000)

    def candidate_speaks(self, *offsets: float) -> None:
        for offset in offsets:
            self.session.emit(
                "user_state_changed",
                SimpleNamespace(old_state="listening", new_state="speaking", created_at=self.T0 + offset),
            )

    async def test_the_latest_speaking_event_at_or_before_the_final_is_the_one_used(self) -> None:
        self.candidate_speaks(1.0, 8.0, 15.0)  # far enough apart to be three separate answers
        index = self.say_as_candidate("again", final_at=self.T0 + 10.0)  # the 15 s event is AFTER it
        self.assertEqual(await self.anchor_of(index), 1_760_000_008_000)
        index = self.say_as_candidate("exactly", final_at=self.T0 + 15.0)  # "at or before"
        self.assertEqual(await self.anchor_of(index), 1_760_000_015_000)

    async def test_a_pause_and_resume_before_the_first_final_anchors_on_the_start_of_the_answer(self) -> None:
        """Review round 1: speech from T+10, a 0.6 s pause, speech again at T+12.6, the first segment's
        final only at T+13.0.  The row used to start at the resumption, 2.6 s into the answer."""
        self.candidate_speaks(10.0, 12.6)
        index = self.say_as_candidate("so in my last role", final_at=self.T0 + 13.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_010_000)

    async def test_several_pauses_in_a_row_are_still_one_burst(self) -> None:
        self.candidate_speaks(10.0, 13.5, 16.9, 20.2)  # each resumption within 4 s of the one before
        index = self.say_as_candidate("a long answer", final_at=self.T0 + 21.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_010_000)

    async def test_speaking_events_exactly_the_burst_gap_apart_are_one_burst(self) -> None:
        self.candidate_speaks(10.0, 14.0)  # exactly the gap: still the same burst
        index = self.say_as_candidate("one", final_at=self.T0 + 15.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_010_000)

    async def test_speaking_events_more_than_the_burst_gap_apart_are_separate_answers(self) -> None:
        """A test of its own, on a fresh interview: the floors of an earlier row in the same test would
        hold the walk-back at the wall and let the gap constant change unnoticed (4.0 -> 5.0)."""
        self.candidate_speaks(10.0, 14.001)  # a hair more: the earlier event is another answer
        index = self.say_as_candidate("two", final_at=self.T0 + 15.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_014_001)

    async def test_a_burst_never_reaches_back_past_thirty_seconds_before_the_final(self) -> None:
        self.candidate_speaks(*[0.0, 3.5, 7.0, 10.5, 14.0, 17.5, 21.0, 24.5])  # (8 kept: all within 4 s of each other)
        index = self.say_as_candidate("long", final_at=self.T0 + 30.5)
        self.assertEqual(await self.anchor_of(index), 1_760_000_003_500, "the 0.0 s event is 30.5 s old")

    async def test_events_after_the_final_are_not_part_of_its_burst(self) -> None:
        self.candidate_speaks(10.0, 12.0)
        index = self.say_as_candidate("early final", final_at=self.T0 + 11.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_010_000)  # (12.0 is a resumption AFTER the final)

    # ---- Review round 3: a burst stays inside its own turn -------------------------------------

    def final(self, text: str, at: float) -> None:
        """One more final transcript for the candidate's row (opens it when none is open)."""
        self.session.emit(
            "user_input_transcribed",
            SimpleNamespace(is_final=True, transcript=text, created_at=self.T0 + at),
        )

    async def test_a_burst_never_reaches_back_into_the_previous_row_across_a_bot_line(self) -> None:
        """Speech at T+10 and T+12 (an answer with a pause), committed; the bot speaks from T+15; the next
        answer starts at T+16, within 4 s of the old resumption.  A committed row and a bot line lie
        between them, so the anchor is T+16, not T+10 in the previous row."""
        self.candidate_speaks(10.0, 12.0)
        first = self.say_as_candidate("my first answer", final_at=self.T0 + 13.0)
        self.speak("And then?", created_at=self.T0 + 15.0)
        self.candidate_speaks(16.0)
        second = self.say_as_candidate("my second answer", final_at=self.T0 + 18.0)
        self.assertEqual(await self.anchor_of(first), 1_760_000_010_000)
        self.assertEqual(await self.anchor_of(second), 1_760_000_016_000)

    async def test_a_burst_never_reaches_back_past_the_previous_rows_commit(self) -> None:
        """No bot line in between (the reply was suppressed): the commit of the previous row alone is the wall."""
        self.candidate_speaks(10.0)
        first = self.say_as_candidate("one", final_at=self.T0 + 11.5)  # (flushed = committed)
        self.candidate_speaks(13.0)  # 3 s after the old start: inside the burst gap
        second = self.say_as_candidate("two", final_at=self.T0 + 15.0)
        self.assertEqual(await self.anchor_of(first), 1_760_000_010_000)
        self.assertEqual(await self.anchor_of(second), 1_760_000_013_000)

    async def test_the_previous_rows_commit_is_after_its_last_final_not_its_first(self) -> None:
        """Row one holds speech from T+10 to T+13.5, finals at T+11 and T+14.  Speech at T+17 is the next
        answer; T+13.5 is after row one's FIRST final but before its last, so it is still row one's."""
        self.candidate_speaks(10.0, 13.5)
        self.final("the first part", 11.0)
        self.final("and the second part", 14.0)
        first = self.interview._open_row.index
        self.interview._flush_candidate_row()
        self.candidate_speaks(17.0)
        second = self.say_as_candidate("the next answer", final_at=self.T0 + 19.0)
        self.assertEqual(await self.anchor_of(first), 1_760_000_010_000)
        self.assertEqual(await self.anchor_of(second), 1_760_000_017_000)

    async def test_a_burst_never_reaches_back_before_the_start_of_a_bot_line(self) -> None:
        """A blip of speech (no final, no row), the bot speaks, the candidate answers 2 s later."""
        self.candidate_speaks(20.0)
        self.speak("Take your time.", created_at=self.T0 + 21.0)
        self.candidate_speaks(23.0)
        index = self.say_as_candidate("here is my answer", final_at=self.T0 + 25.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_023_000)

    async def test_a_bot_line_with_no_time_of_its_own_still_walls_off_everything_before_it(self) -> None:
        """The claim came with the delivered item, no speaking event (so no created_at): the wall is the
        moment of the claim, never earlier, so nothing already heard can be walked back to."""
        self.candidate_speaks(10.0, 12.0)
        self.speak("silent claim", claim=False)
        self.candidate_speaks(13.0)
        index = self.say_as_candidate("the answer", final_at=self.T0 + 14.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_013_000)

    async def test_a_pause_and_resume_after_a_boundary_is_still_one_burst(self) -> None:
        """The wall is not a reason to give up the start of an answer that came after it."""
        self.candidate_speaks(1.0)
        first = self.say_as_candidate("one", final_at=self.T0 + 2.5)
        self.speak("Go on.", created_at=self.T0 + 4.0)
        self.candidate_speaks(10.0, 12.6, 15.0)  # pause, resume, pause, resume: every gap under 4 s
        second = self.say_as_candidate("so in my last role", final_at=self.T0 + 16.0)
        self.assertEqual(await self.anchor_of(first), 1_760_000_001_000)
        self.assertEqual(await self.anchor_of(second), 1_760_000_010_000)

    async def test_speech_at_the_instant_a_bot_line_begins_is_the_candidates_not_behind_the_wall(self) -> None:
        """The candidate started talking as the line began (talking over it): that start is theirs."""
        self.candidate_speaks(12.0)
        self.speak("Let me ask", created_at=self.T0 + 12.0)
        self.candidate_speaks(15.0)
        index = self.say_as_candidate("sorry, to answer that", final_at=self.T0 + 16.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_012_000)

    async def test_a_bot_line_that_starts_over_an_uncommitted_row_closes_it_and_walls_it_off(self) -> None:
        """No commit yet (the SDK is still waiting out the pause): the bot's claim closes the row, and
        what the candidate says next is a new row that cannot be anchored back into the first."""
        self.candidate_speaks(10.0)
        self.final("an answer nobody has committed", 11.0)
        first = self.interview._open_row.index
        self.speak("If I may.", created_at=self.T0 + 12.0)
        self.assertIsNone(self.interview._open_row)
        self.candidate_speaks(13.0)
        second = self.say_as_candidate("what I mean is", final_at=self.T0 + 15.0)
        self.assertEqual(await self.anchor_of(first), 1_760_000_010_000)
        self.assertEqual(await self.anchor_of(second), 1_760_000_013_000)

    async def test_the_wall_only_moves_forward_and_ignores_what_is_not_a_time(self) -> None:
        self.interview._raise_anchor_floor(self.T0 + 5)
        for bad in (None, True, "soon", float("nan"), float("inf"), [1]):
            with self.subTest(value=bad):
                self.assertFalse(self.interview._raise_anchor_floor(bad))
                self.assertEqual(self.interview._anchor_floor, self.T0 + 5)
        self.assertTrue(self.interview._raise_anchor_floor(self.T0 + 2))  # a usable time, but earlier
        self.assertEqual(self.interview._anchor_floor, self.T0 + 5)
        self.assertTrue(self.interview._raise_anchor_floor(self.T0 + 9))
        self.assertEqual(self.interview._anchor_floor, self.T0 + 9)

    async def test_a_bot_line_whose_time_is_garbage_is_walled_at_the_claim_not_ignored(self) -> None:
        self.candidate_speaks(10.0, 12.0)
        self.interview._reserve_bot_index(float("nan"))
        self.candidate_speaks(13.0)
        index = self.say_as_candidate("the answer", final_at=self.T0 + 14.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_013_000)

    async def test_the_wall_only_limits_the_walk_back_the_latest_event_is_still_the_base(self) -> None:
        """Speech that began just before a bot line and carried on into it (no new speaking event after
        the line began) still anchors where it began: the base event is the SDK's latest, as before."""
        self.candidate_speaks(11.9)
        self.speak("Mm-hm.", created_at=self.T0 + 12.0)
        index = self.say_as_candidate("and so I decided", final_at=self.T0 + 14.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_011_900)

    # ---- Review round 4: a row never reuses the previous answer's start -------------------------

    async def test_a_row_with_no_new_speaking_event_does_not_reuse_the_previous_answers_start(self) -> None:
        """Probe p2: row 1 speaks from T+10 (final T+11); a bot line begins at T+13; row 2's final comes at
        T+16 and the VAD gave no new speaking event (a miss, or the candidate talked across a line that
        cannot be interrupted).  The latest event is row 1's own start, 6 s old: row 2 has no anchor."""
        self.candidate_speaks(10.0)
        first = self.say_as_candidate("my first answer", final_at=self.T0 + 11.0)
        self.speak("Thanks. And then?", created_at=self.T0 + 13.0)
        second = self.say_as_candidate("my second answer", final_at=self.T0 + 16.0)
        self.assertEqual(await self.anchor_of(first), 1_760_000_010_000)
        self.assertIsNone(await self.anchor_of(second))

    async def test_the_same_with_no_bot_line_between_the_rows(self) -> None:
        """The reply was suppressed, so the previous row's commit alone is the wall the base is held to."""
        self.candidate_speaks(10.0)
        first = self.say_as_candidate("one", final_at=self.T0 + 11.5)
        second = self.say_as_candidate("two", final_at=self.T0 + 14.0)
        self.assertEqual(await self.anchor_of(first), 1_760_000_010_000)
        self.assertIsNone(await self.anchor_of(second))

    async def test_a_late_final_after_the_commit_is_not_given_the_committed_rows_start(self) -> None:
        """The STT's last final of an answer already written lands after the bot line began:
        it opens a row of its own, and the only speaking events it can see are the ones that began the row
        before it.  That row owns them; this one has no anchor."""
        self.candidate_speaks(10.0, 12.0)
        first = self.say_as_candidate("my answer", final_at=self.T0 + 12.5)
        self.speak("Mm-hm.", created_at=self.T0 + 13.0)
        late = self.say_as_candidate("and that is why", final_at=self.T0 + 14.0)
        self.assertEqual(await self.anchor_of(first), 1_760_000_010_000)
        self.assertIsNone(await self.anchor_of(late))

    async def test_a_speaking_event_at_the_instant_of_the_previous_rows_last_final_is_the_new_answers(self) -> None:
        """`<`, not `<=`: speech that begins in the very instant the previous row's last final arrived is the
        new answer's, and its burst does not reach back into the old one."""
        self.candidate_speaks(10.0)
        first = self.say_as_candidate("one", final_at=self.T0 + 11.0)
        self.candidate_speaks(11.0)
        second = self.say_as_candidate("two", final_at=self.T0 + 13.0)
        self.assertEqual(await self.anchor_of(first), 1_760_000_010_000)
        self.assertEqual(await self.anchor_of(second), 1_760_000_011_000)

    async def test_only_the_commit_holds_the_base_a_bot_line_does_not(self) -> None:
        """After a committed row, speech that began 0.1 s before a bot line (and carried on into it) still
        anchors where it began: the base is exempt from the bot-line wall, not from the commit."""
        self.candidate_speaks(1.0)
        first = self.say_as_candidate("one", final_at=self.T0 + 2.0)
        self.candidate_speaks(11.9)
        self.speak("Mm-hm.", created_at=self.T0 + 12.0)
        second = self.say_as_candidate("and so I decided", final_at=self.T0 + 14.0)
        self.assertEqual(await self.anchor_of(first), 1_760_000_001_000)
        self.assertEqual(await self.anchor_of(second), 1_760_000_011_900)

    async def test_a_floor_time_far_ahead_of_now_is_ignored(self) -> None:
        """The floors only rise, so a far-future time would pin them for the rest of the session."""
        future = time.time() + 3600
        for bad in (future, 5e12, 1e18):
            for commit in (False, True):
                with self.subTest(value=bad, commit=commit):
                    self.assertFalse(self.interview._raise_anchor_floor(bad, commit=commit))
                    self.assertEqual(self.interview._anchor_floor, 0.0)
                    self.assertEqual(self.interview._commit_floor, 0.0)
        self.assertTrue(self.interview._raise_anchor_floor(time.time() + 30, commit=True))  # skew is fine
        self.assertGreater(self.interview._anchor_floor, 0.0)
        self.assertEqual(self.interview._commit_floor, self.interview._anchor_floor)

    async def test_the_commit_floor_moves_only_for_a_commit_and_only_forward(self) -> None:
        self.assertTrue(self.interview._raise_anchor_floor(self.T0 + 5))  # a bot line: not a commit
        self.assertEqual((self.interview._anchor_floor, self.interview._commit_floor), (self.T0 + 5, 0.0))
        self.assertTrue(self.interview._raise_anchor_floor(self.T0 + 3, commit=True))
        self.assertEqual((self.interview._anchor_floor, self.interview._commit_floor), (self.T0 + 5, self.T0 + 3))
        self.assertTrue(self.interview._raise_anchor_floor(self.T0 + 1, commit=True))
        self.assertEqual((self.interview._anchor_floor, self.interview._commit_floor), (self.T0 + 5, self.T0 + 3))

    async def test_one_far_future_timestamp_does_not_end_the_walk_back_for_the_session(self) -> None:
        """A final stamped an hour ahead (a clock jump, a bad event): its row's commit used to raise the
        floor to that time, and with it no later burst could be walked back for the rest of the session."""
        self.candidate_speaks(1.0)
        self.say_as_candidate("a garbled clock", final_at=time.time() + 3600)
        self.assertEqual(self.interview._anchor_floor, 0.0)
        self.candidate_speaks(10.0, 12.6)
        index = self.say_as_candidate("so in my last role", final_at=self.T0 + 13.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_010_000)

    async def test_a_bot_line_stamped_far_ahead_is_walled_at_the_claim_instead(self) -> None:
        self.candidate_speaks(10.0, 12.0)
        self.interview._reserve_bot_index(time.time() + 3600)
        self.assertGreater(self.interview._anchor_floor, self.T0 + 100)  # the moment of the claim
        self.assertLessEqual(self.interview._anchor_floor, time.time() + 1)  # not the far-future time
        self.candidate_speaks(13.0)
        index = self.say_as_candidate("the answer", final_at=self.T0 + 14.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_013_000)

    async def test_a_speaking_event_more_than_30_seconds_earlier_is_another_utterance(self) -> None:
        index = self.say_as_candidate("late", spoke_at=self.T0, final_at=self.T0 + 30.0)
        self.assertEqual(await self.anchor_of(index), 1_760_000_000_000)  # exactly 30 s: still this turn
        index = self.say_as_candidate("later", final_at=self.T0 + 30.001)
        self.assertIsNone(await self.anchor_of(index))

    async def test_no_speaking_event_before_the_final_means_no_anchor(self) -> None:
        for spoke_at in (self.T0 + 9.0, None):
            with self.subTest(spoke_at=spoke_at):
                self.interview._user_speaking_at.clear()
                index = self.say_as_candidate("x", spoke_at=spoke_at, final_at=self.T0 + 1.0)
                self.assertIsNone(await self.anchor_of(index))

    async def test_events_without_a_created_at_give_no_anchor(self) -> None:
        self.session.emit("user_state_changed", SimpleNamespace(old_state="listening", new_state="speaking"))
        self.assertEqual(len(self.interview._user_speaking_at), 0)
        index = self.say_as_candidate("plain")
        self.assertIsNone(await self.anchor_of(index))

    async def test_listening_events_are_not_speech_starts(self) -> None:
        self.session.emit(
            "user_state_changed",
            SimpleNamespace(old_state="speaking", new_state="listening", created_at=self.T0),
        )
        self.assertEqual(len(self.interview._user_speaking_at), 0)

    async def test_an_out_of_range_anchor_is_dropped_not_written(self) -> None:
        index = self.say_as_candidate("far", spoke_at=5e12, final_at=5e12 + 1)  # year 2128
        self.assertIsNone(await self.anchor_of(index))

    async def test_only_a_few_speaking_events_are_remembered(self) -> None:
        for i in range(50):
            self.session.emit(
                "user_state_changed",
                SimpleNamespace(old_state="listening", new_state="speaking", created_at=self.T0 + i),
            )
        self.assertLessEqual(len(self.interview._user_speaking_at), r1_session._USER_SPEECH_ANCHORS_KEPT)

    def test_the_epoch_helper_accepts_only_the_columns_window(self) -> None:
        self.assertEqual(r1_session._epoch_ms(1.0), 1000)
        self.assertEqual(r1_session._epoch_ms(4_102_444_799.9994), 4_102_444_799_999)
        for bad in (0, 0.0, -1, 4_102_444_800, 4_102_444_800.5, float("nan"), None, "1", True, False, b"1"):
            with self.subTest(value=bad):
                self.assertIsNone(r1_session._epoch_ms(bad))


class TestPhoneIsolation(unittest.TestCase):
    """The shared entrypoint must return from phone before lazily importing any R1 module."""

    def test_phone_early_return_precedes_r1_lazy_import(self) -> None:
        source = (HERE / "agent.py").read_text(encoding="utf-8")
        entrypoint = source.index("async def entrypoint")
        phone_branch = source.index("if _phone_agent_name():", entrypoint)
        r1_import = source.index("import r1_session", phone_branch)
        self.assertLess(source.index("return", phone_branch), r1_import)
        # No MODULE-LEVEL r1_* import anywhere: every one is lazy and off the phone path.
        self.assertIsNone(re.search(r"^(?:from|import) r1_", source, re.MULTILINE))

    def test_r1_worker_options_import_is_lazy_and_inside_the_non_phone_branch(self) -> None:
        source = (HERE / "agent.py").read_text(encoding="utf-8")
        r1_branch = source.index("if not _phone_agent_name():\n        # Lazy and inside")
        browser_name_branch = source.index("if browser_named:", r1_branch)
        r1_options = source[r1_branch:browser_name_branch]
        self.assertIn("from r1_routing import r1_mode_allows", r1_options)
        self.assertIn('r1_mode_allows(os.getenv("R1_LANE_MODE"))', r1_options)
        self.assertIn('_bounded_float_env("R1_DRAIN_TIMEOUT_SEC", 60.0, 30.0, 60.0)', r1_options)
        self.assertIn(
            '_bounded_float_env("R1_SHUTDOWN_PROCESS_TIMEOUT_SEC", 90.0, 30.0, 90.0)',
            r1_options,
        )
        # The old exact comparison (which disagreed with routing's trimmed one) is gone.
        self.assertNotIn('== "r1_only"', source)

    def test_the_refuse_path_uses_the_real_jobcontext_surface(self) -> None:
        source = (HERE / "agent.py").read_text(encoding="utf-8")
        start = source.index("async def _refuse_r1_room")
        refuse = source[start : source.index("async def entrypoint", start)]
        self.assertIn("ctx.delete_room(room_name)", refuse)
        self.assertIn('ctx.shutdown(reason="r1_routing_refused")', refuse)
        self.assertNotIn("ctx.close_room", source)
        self.assertNotIn('getattr(ctx, "close_room"', source)
        self.assertNotIn("_log.warning", source)


class TestVoicePerSpeech(R1TestCase):
    """One voice per speech, fixed when it is created (owner decision 2026-10-30).

    The TTS speaker, the filler, the recovery line and the transcript label all read the one
    value stored for the speech.  ``r1_session.current_speech_id`` (the SDK's speech-handle
    variable) is patched to name the speech whose task is "running".
    """

    def reply_speech(self, reply=None) -> FakeSpeechHandle:
        """An LLM reply's speech is created, right after the hook prepared ``reply``."""
        self.interview._latest_reply = reply
        handle = FakeSpeechHandle("a reply")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
        )
        return handle

    def running(self, handle):
        return mock.patch.object(r1_session, "current_speech_id", lambda: str(handle.id))

    def deliver(self, handle: FakeSpeechHandle, text: str) -> None:
        self.session.current_speech = handle
        self.agent_state("speaking")
        message = FakeChatMessage(text)
        self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        handle.chat_items.append(message)
        handle.finish()
        self.session.current_speech = None

    async def test_scripted_lines_are_bound_by_the_line_table(self) -> None:
        self.assertEqual(
            r1_session._LEARNER_LINES,
            {"L-PICKUP", "L-SIL-RP1", "L-FILLER-LEARNER", "L-TIME-CUE", "L-TIME-UP",
             "L-LEARNER-HANGUP",  # M032 S3.4: her one-line hang-up is hers
             # Simulation diagnosis 3 (D3-EXIT1): her short goodbye back is hers too.
             "L-LEARNER-BYE-1", "L-LEARNER-BYE-2", "L-LEARNER-BYE-3"},
        )
        for line_id in [*sorted(r1_session._LEARNER_LINES), "L-SIL-IB", "L-EXIT", "L-SIL-RP2"]:
            with self.subTest(line_id=line_id):
                await self.interview.say(line_id)
                expected = "learner" if line_id in r1_session._LEARNER_LINES else "interviewer"
                self.assertEqual(self.interview._history[-1]["voice"], expected)
        self.enter_roleplay()
        for line_id in ("L-ASIDE-COACH", "L-ASIDE-END"):
            with self.subTest(line_id=line_id):
                plan = SimpleNamespace(scripted_text=self.spoken_line(line_id), line_id=line_id)
                with mock.patch.object(self.interview, "_close_coach_aside", lambda: None):
                    await self.interview._play_aside(plan)
                self.assertEqual(self.interview._history[-1]["voice"], "interviewer")

    async def test_a_roleplay_reply_is_bound_to_the_learner_at_creation(self) -> None:
        voices = self.interview._voices
        icebreaker = self.reply_speech(Reply(phase="icebreaker", candidate_text="hi"))
        self.assertEqual(voices[icebreaker.id], "interviewer")
        unplanned = self.reply_speech(None)  # no prepared reply: the phase rule
        self.assertEqual(voices[unplanned.id], "interviewer")
        self.enter_roleplay()
        roleplay = self.reply_speech(Reply(phase=ROLEPLAY_PHASE, candidate_text="hello"))
        self.assertEqual(voices[roleplay.id], "learner")
        self.assertEqual(voices[self.reply_speech(None).id], "learner")
        self.interview.machine.transition(R1Phase.ASIDE)
        # A reply planned in ASIDE is the learner's (``_plan_learner_reply`` always plans one).
        aside = self.reply_speech(Reply(phase=ROLEPLAY_PHASE, candidate_text="ok"))
        self.assertEqual(voices[aside.id], "learner")
        self.assertEqual(voices[self.reply_speech(None).id], "learner")
        wrapup = self.reply_speech(Reply(phase="wrapup", candidate_text="a question"))
        self.assertEqual(voices[wrapup.id], "interviewer")

    async def test_the_bound_voice_is_the_transcript_label(self) -> None:
        self.enter_roleplay()
        reply = self.reply_speech(Reply(phase=ROLEPLAY_PHASE, candidate_text="hello"))
        # The phase moves on before the learner's reply starts speaking (an aside began): its
        # audio is the learner's, so its label is too.  It used to read "interviewer".
        self.interview.machine.transition(R1Phase.ASIDE)
        self.deliver(reply, "Nine thousand still feels like a lot.")
        item = self.interview._history[-1]
        self.assertEqual((item["voice"], item["phase"]), ("learner", "aside"))
        learner_context = select_context(self.interview._history, ROLEPLAY_PHASE)
        self.assertIn(
            {"role": "assistant", "content": "Nine thousand still feels like a lot."},
            learner_context,
        )
        wrapup_context = select_context(self.interview._history, "wrapup")
        self.assertNotIn("Nine thousand", json.dumps(wrapup_context))
        # A scripted line's label is its line voice; a speech R1 never tagged keeps the rule.
        await self.interview.say("L-SIL-RP1")
        self.assertEqual(self.interview._history[-1]["voice"], "learner")
        self.interview._remember_bot_turn(99, ROLEPLAY_PHASE, "untracked", None)
        self.assertEqual(self.interview._history[-1]["voice"], "learner")
        self.interview._remember_bot_turn(100, "wrapup", "untracked", None)
        self.assertEqual(self.interview._history[-1]["voice"], "interviewer")

    async def test_tts_node_stream_binds_the_voice_of_its_own_speech(self) -> None:
        import r1_tts

        self.enter_roleplay()
        # An interviewer say line is the CURRENT speech while a learner reply is already being
        # synthesised behind it: the reply's TTS must still speak the learner.
        say_line = FakeSpeechHandle("Are you still there?")
        self.interview._voices[str(say_line.id)] = "interviewer"
        self.session.current_speech = say_line
        reply = self.reply_speech(Reply(phase=ROLEPLAY_PHASE, candidate_text="hello"))
        seen: list = []

        def synth(stream):
            async def frames():
                seen.append(r1_tts.current_voice())
                async for _ in stream:
                    pass
                yield "frame"

            return frames()

        async def tts_task(handle) -> list:
            with self.running(handle):
                node = self.interview.tts_node_stream("Hmm, okay. Tell me more about it.", synth)
                return [frame async for frame in node]

        await asyncio.create_task(tts_task(reply))
        self.assertTrue(seen)
        self.assertEqual(set(seen), {"learner"})  # every downstream call of the reply
        seen.clear()
        await asyncio.create_task(tts_task(say_line))
        self.assertEqual(set(seen), {"interviewer"})
        self.assertIsNone(r1_tts.current_voice())  # bound only inside each TTS task
        self.session.current_speech = None

    async def test_an_untracked_speech_falls_back_to_the_phase_and_is_logged_once(self) -> None:
        self.enter_roleplay()
        with self.capture_logs() as lines, mock.patch.object(
            r1_session, "current_speech_id", lambda: None
        ):
            self.assertEqual(self.interview.speech_voice(), "learner")
            self.interview.machine.transition(R1Phase.ASIDE)
            self.assertEqual(self.interview.speech_voice(), "learner")
        self.assertEqual(error_types(lines).count("r1_tts_voice_unbound"), 1)

    async def test_the_filler_is_in_the_replys_voice(self) -> None:
        # A learner reply whose filler fires after the phase moved still says the learner's.
        self.enter_roleplay()
        reply = self.reply_speech(Reply(phase=ROLEPLAY_PHASE, candidate_text="hello"))
        self.interview.machine.transition(R1Phase.ASIDE)
        with self.running(reply):
            self.assertIn(
                self.interview._filler_text(), [v + " " for v in LEARNER_FILLER_VARIANTS]
            )
        # And a Christy reply never gets the learner's filler, whatever the phase.
        christy = self.reply_speech(Reply(phase="wrapup", candidate_text="a question"))
        with self.running(christy):
            self.assertEqual(
                self.interview._filler_text(), self.spoken_line("L-FILLER-INTERVIEWER") + " "
            )

    async def test_the_recovery_line_takes_the_hung_replys_voice(self) -> None:
        self.enter_roleplay()
        # A reply the hook planned for Christy hangs while the phase says role-play: the
        # recovery line is Christy's, not the learner's (the phase rule would say learner).
        reply = self.reply_speech(Reply(phase="roleplay_exit", candidate_text="a question"))
        self.assertEqual(self.interview._voices[reply.id], "interviewer")

        async def hung():
            await asyncio.Event().wait()
            yield "never"

        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.05), mock.patch.object(
            r1_session, "FILLER_AFTER_SECONDS", 5.0
        ), self.running(reply):
            with self.assertRaises(TimeoutError):
                await self.interview.guard_llm_stream(hung()).__anext__()
        await self.until(lambda: ("play_end", FALLBACK_REPLY) in self.order)
        await self.flush()
        spoken = [item for item in self.interview._history if item["text"] == FALLBACK_REPLY]
        self.assertEqual([item["voice"] for item in spoken], ["interviewer"])

    async def test_a_cached_learner_line_is_looked_up_in_the_learner_voice(self) -> None:
        lookups: list = []

        class Cache:
            def lookup(self, text, voice="interviewer"):
                lookups.append((text, voice))
                return None

        self.interview._line_cache = Cache()
        try:
            await self.interview.say("L-PICKUP")
            await self.interview.say("L-SIL-IB")
        finally:
            self.interview._line_cache = None
        self.assertEqual(
            lookups,
            [
                (self.spoken_line("L-PICKUP"), "learner"),
                (self.spoken_line("L-SIL-IB"), "interviewer"),
            ],
        )

    async def test_warm_specs_carry_each_lines_voice(self) -> None:
        free = self.interview._warm_specs(candidate_free=True)
        named = self.interview._warm_specs(candidate_free=False)
        order = list(self.interview._warm_order())  # M032 S7C: L-MUTE gives way to the v2 asides
        self.assertEqual(sorted(spec.line_id for spec in free + named), sorted(order))
        for group in (free, named):
            ids = [spec.line_id for spec in group]
            self.assertEqual(ids, [line_id for line_id in order if line_id in ids])
        for spec in free + named:
            with self.subTest(line_id=spec.line_id):
                learner = spec.line_id in r1_session._LEARNER_LINES
                self.assertEqual(spec.voice, "learner" if learner else "interviewer")
        self.assertEqual(
            {spec.line_id for spec in free + named if spec.voice == "learner"},
            {"L-PICKUP", "L-SIL-RP1", "L-TIME-UP", "L-LEARNER-HANGUP",
             "L-LEARNER-BYE-1", "L-LEARNER-BYE-2", "L-LEARNER-BYE-3"},
        )

    async def test_voices_are_forgotten_when_a_speech_ends(self) -> None:
        reply = self.reply_speech(Reply(phase="icebreaker", candidate_text="hi"))
        self.assertIn(str(reply.id), self.interview._voices)
        reply.finish()
        self.assertNotIn(str(reply.id), self.interview._voices)
        await self.interview.say("L-SIL-IB")
        self.assertEqual(self.interview._voices, {})

# ------------------------------------------------------------------------------------------------
# Owner decisions 2026-10-30 (owner test 1eb18cd4): no "okay" stutter, meaning-based end detection,
# a bare yes that confirms L-ASIDE-END, and the brief repeated on request.
# ------------------------------------------------------------------------------------------------
try:  # The SDK's own speech events when livekit is installed (.r1-venv); shaped fakes otherwise.
    from livekit.agents import stt as _stt
except ImportError:  # pragma: no cover - bare CI
    _stt = None


def stt_event(text: str, kind: str = "final_transcript"):
    """A speech event as ``Agent.default.stt_node`` yields it."""
    if _stt is not None:
        return _stt.SpeechEvent(
            type=_stt.SpeechEventType(kind),
            alternatives=[_stt.SpeechData(language="en", text=text)],
        )
    return SimpleNamespace(
        type=SimpleNamespace(value=kind), alternatives=[SimpleNamespace(text=text)]
    )


# The owner's turns #33-#41: what was said over the learner's reply, and whether R1 now holds it.
OWNER_ACK_CUTS = (
    ("Okay", True),
    ("Yeah, Okay", True),
    ("Yeah, okay, perfect.", False),  # not an acknowledgement today (owner decision pending)
    ("Okay, continue.", True),
)


class AckHoldCase(R1TestCase):
    """The learner is mid-reply: an interruptible, live speech in the role-play."""

    def learner_speaking(self, **flags) -> FakeSpeechHandle:
        if self.interview.machine.phase is not R1Phase.ROLEPLAY:
            self.enter_roleplay()
        handle = FakeSpeechHandle("My contract keeps me", allow_interruptions=True)
        for name, value in flags.items():
            setattr(handle, name, value)
        self.session.current_speech = handle
        return handle


class TestAcknowledgementsDoNotCutTheLearner(AckHoldCase):
    """Owner decision 2026-10-30 item 3: an "okay" over the learner no longer cuts her."""

    def test_an_acknowledgement_over_the_learner_is_held(self) -> None:
        self.learner_speaking()
        for text, held in OWNER_ACK_CUTS:
            with self.subTest(text=text):
                self.assertIs(self.interview.hold_ack_transcript(stt_event(text)), held)
        for text in ("Hmm", "Mm-hmm.", "Sorry, go ahead", "No, no, please continue"):
            with self.subTest(text=text):
                self.assertTrue(self.interview.hold_ack_transcript(stt_event(text)))
        for kind in ("interim_transcript", "preflight_transcript"):
            with self.subTest(kind=kind):
                self.assertTrue(self.interview.hold_ack_transcript(stt_event("Okay", kind)))

    def test_a_real_interruption_still_reaches_the_sdk(self) -> None:
        self.learner_speaking()
        for text in (
            "Okay?", "Sorry?", "what is your name", "Hey, what is your name?", "Yes.", "No, no.",
            "Okay, but the EMI is the problem.", "Pooja, wait.", "",
        ):
            with self.subTest(text=text):
                self.assertFalse(self.interview.hold_ack_transcript(stt_event(text)))
        for kind in ("end_of_speech", "start_of_speech", "recognition_usage"):
            with self.subTest(kind=kind):
                self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay", kind)))

    def test_only_a_live_interruptible_learner_speech_is_protected(self) -> None:
        self.enter_roleplay()
        self.session.current_speech = None
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))
        for flags in (
            {"allow_interruptions": False},
            {"interrupted": True},
            {"done": lambda: True},
        ):
            with self.subTest(flags=list(flags)):
                self.learner_speaking(**flags)
                self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))
        handle = self.learner_speaking()
        slot = r1_session._SpeechSlot(handle, source="generate_reply")
        slot.cut_by_r1 = True
        self.interview._speeches[handle.id] = slot
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))

    def test_only_the_roleplay_is_covered(self) -> None:
        self.session.current_speech = FakeSpeechHandle("Tell me more.", allow_interruptions=True)
        self.assertIs(self.interview.machine.phase, R1Phase.ICEBREAKER)
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))
        self.interview.machine.transition(R1Phase.TRANSITION)
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))
        self.interview.machine.transition(R1Phase.ROLEPLAY)
        self.assertTrue(self.interview.hold_ack_transcript(stt_event("Okay")))
        self.interview.machine.transition(R1Phase.ROLEPLAY_EXIT)
        self.interview.machine.transition(R1Phase.WRAPUP)
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))

    def test_the_kill_switch_restores_todays_behaviour(self) -> None:
        self.learner_speaking()
        for raw in ("0", "off", "false"):
            with self.subTest(raw=raw), mock.patch.dict(os.environ, {"R1_ACK_HOLD": raw}):
                self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))
        with mock.patch.dict(os.environ, {"R1_ACK_HOLD": "1"}):
            self.assertTrue(self.interview.hold_ack_transcript(stt_event("Okay")))

    def test_it_holds_at_the_three_word_rollback_too(self) -> None:
        self.learner_speaking()
        with mock.patch.dict(os.environ, {"R1_INTERRUPT_MIN_WORDS": "3"}):
            self.assertEqual(r1_session.interrupt_min_words(), 3)
            for text in ("Okay", "Yeah, Okay", "Okay, continue."):
                self.assertTrue(self.interview.hold_ack_transcript(stt_event(text)))
            # Nothing was banked toward the SDK's 3 words: the acks can never add up to a turn.
            self.assertEqual(self.interview._banked_words, 0)

    async def test_a_held_ack_is_written_but_counted_for_nothing_else(self) -> None:
        self.learner_speaking()
        self.interview._latency._final_at = None
        self.assertTrue(self.interview.hold_ack_transcript(stt_event("Okay")))
        self.assertTrue(self.interview._turns.empty())  # the driver is not told
        self.assertEqual(self.interview._banked_words, 0)  # the SDK banked nothing
        self.assertIsNone(self.interview._latency._final_at)  # no stale latency anchor
        self.assertEqual(self.interview._turn_finals, [])  # no end-intent text either
        self.assertEqual(self.interview._acks_held, 1)
        row = self.interview._open_row
        self.assertEqual(row.parts, ["Okay"])
        self.assertEqual(self.interview._latest_candidate_index, row.index)
        # The candidate's next real turn joins the row (one row, as the SDK never saw the ack).
        self.final_transcript("So what is your budget?")
        await self.settle()
        self.assertEqual(self.interview._open_row.parts, ["Okay", "So what is your budget?"])
        await self.commit_turn("So what is your budget?")
        await self.flush()
        rows = [row for row in self.writer.saved if row["speaker"] == "candidate"]
        self.assertEqual([row["text"] for row in rows], ["Okay So what is your budget?"])

    async def test_an_ack_row_alone_is_written_at_the_learners_next_line(self) -> None:
        self.learner_speaking()
        self.interview.hold_ack_transcript(stt_event("Okay"))
        self.interview._flush_candidate_row()
        await self.flush()
        self.assertEqual(
            [(row["text"], row["phase"]) for row in self.writer.saved], [("Okay", "roleplay")]
        )

    async def test_a_held_ack_never_starts_or_lengthens_the_next_answer(self) -> None:
        self.learner_speaking()
        self.user_state("speaking")
        self.clock.advance(1.0)
        self.user_state("listening")
        self.interview.hold_ack_transcript(stt_event("Yeah, okay, continue."))
        self.assertIsNone(self.interview._user_turn_started)
        self.clock.advance(10.0)  # the learner finishes her point
        self.user_state("speaking")
        self.clock.advance(5.0)
        self.user_state("listening")
        self.final_transcript("So how many hours can you give it?")
        await self.settle()
        engine = self.interview.engine
        with mock.patch.object(engine, "plan_turn", wraps=engine.plan_turn) as plan:
            await self.commit_turn("So how many hours can you give it?")
        self.assertEqual(plan.call_args.kwargs["candidate_seconds"], 5.0)

    async def test_an_ack_heard_while_the_candidate_still_speaks_is_judged_when_they_stop(
        self,
    ) -> None:
        self.learner_speaking()
        self.user_state("speaking")
        self.interview.hold_ack_transcript(stt_event("Okay"))
        self.assertTrue(self.interview._ack_unjudged)
        self.clock.advance(1.0)
        self.user_state("listening")
        self.assertFalse(self.interview._ack_unjudged)
        self.assertIsNone(self.interview._user_turn_started)

    async def test_the_agents_stt_node_drops_only_held_events(self) -> None:
        self.learner_speaking()
        events = [
            stt_event("", "start_of_speech"),
            stt_event("Okay", "interim_transcript"),
            stt_event("Okay"),
            stt_event("Yeah, okay, perfect."),
            stt_event("Hey, what is your name?"),
            stt_event("", "end_of_speech"),
        ]

        async def default_stt_node(agent, audio, model_settings):
            for event in events:
                yield event

        agent = R1Agent(self.interview)
        default = getattr(r1_session.Agent, "default", None)
        if default is None:  # bare CI: the node passes its input through the filter
            stream = agent.stt_node(default_stt_node(agent, None, None), None)
        else:
            with mock.patch.object(default, "stt_node", default_stt_node):
                stream = agent.stt_node(None, None)
        seen = [event async for event in stream]
        self.assertEqual(
            [(getattr(e.type, "value", e.type), e.alternatives[0].text if e.alternatives else "")
             for e in seen],
            [
                ("start_of_speech", ""),
                ("final_transcript", "Yeah, okay, perfect."),
                ("final_transcript", "Hey, what is your name?"),
                ("end_of_speech", ""),
            ],
        )

    async def test_the_owners_turns_33_to_41_no_longer_restart_the_learner(self) -> None:
        # Owner test 1eb18cd4 #33-#41: "Okay", "Yeah, Okay", "Yeah, okay, perfect." and "Okay,
        # continue." each cut her and she restarted four times.  Now three of them never reach the
        # SDK: no cut, no committed turn, no restart; only "Yeah, okay, perfect." still does.
        self.learner_speaking()
        reached = [
            text for text, _ in OWNER_ACK_CUTS
            if not self.interview.hold_ack_transcript(stt_event(text))
        ]
        self.assertEqual(reached, ["Yeah, okay, perfect."])
        self.assertTrue(self.interview._turns.empty())
        self.assertEqual(self.interview._acks_held, 3)

    def test_a_failure_passes_the_event_on(self) -> None:
        self.learner_speaking()
        with mock.patch.object(
            r1_session, "is_acknowledgement_turn", side_effect=RuntimeError("boom")
        ), self.capture_logs() as logs:
            self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))
        self.assertIn("r1_ack_hold_failed", error_types(logs))

    async def test_a_failure_writing_the_held_row_never_breaks_the_stt_stream(self) -> None:
        # Reviewed fix: an exception in ``_note_held_ack`` left ``stt_node_stream`` and ended the
        # SDK's speech-to-text pump, so the question after the "Okay" was never delivered.
        self.learner_speaking()
        events = [stt_event("Okay"), stt_event("What is your name?")]

        async def source():
            for event in events:
                yield event

        with mock.patch.object(
            self.interview, "_candidate_turn_anchor", side_effect=ValueError("anchor failed")
        ), self.capture_logs() as logs:
            seen = [event async for event in self.interview.stt_node_stream(source())]
        self.assertEqual([event.alternatives[0].text for event in seen], ["What is your name?"])
        self.assertIn("r1_ack_note_failed", error_types(logs))
        with mock.patch.object(
            self.interview, "_note_held_ack", side_effect=RuntimeError("boom")
        ), self.capture_logs() as logs:
            self.assertTrue(self.interview.hold_ack_transcript(stt_event("Okay")))
        self.assertIn("r1_ack_note_failed", error_types(logs))


class TestHeldAckFastResume(AckHoldCase):
    """A paused line comes back ``R1_ACK_RESUME_SEC`` after its acknowledgement was held."""

    def activity(self, handle, *, timer=True, when=None, start=None):
        timer_obj = None
        if timer:
            timer_obj = SimpleNamespace(when=when) if when is not None else object()
        activity = SimpleNamespace(
            _paused_speech=SimpleNamespace(handle=handle),
            _current_speech=handle,
            _false_interruption_timer=timer_obj,
            _start_false_interruption_timer=start or mock.Mock(),
        )
        self.session._activity = activity
        return activity

    async def test_the_sdks_countdown_is_shortened(self) -> None:
        handle = self.learner_speaking()
        activity = self.activity(handle)
        self.interview.hold_ack_transcript(stt_event("Yeah, okay, continue."))
        activity._start_false_interruption_timer.assert_called_once_with(0.3)

    async def test_nothing_is_done_without_a_countdown_or_for_another_speech(self) -> None:
        handle = self.learner_speaking()
        activity = self.activity(handle, timer=False)
        self.interview.hold_ack_transcript(stt_event("Okay"))
        activity._start_false_interruption_timer.assert_not_called()
        activity = self.activity(handle)
        activity._current_speech = FakeSpeechHandle("another")
        self.interview.hold_ack_transcript(stt_event("Okay"))
        activity._start_false_interruption_timer.assert_not_called()
        # An interim never resumes anything (only a held final does).
        activity = self.activity(handle)
        self.interview.hold_ack_transcript(stt_event("Okay", "interim_transcript"))
        activity._start_false_interruption_timer.assert_not_called()

    async def test_a_sooner_sdk_resume_is_left_alone(self) -> None:
        handle = self.learner_speaking()
        now = asyncio.get_running_loop().time()
        activity = self.activity(handle, when=lambda: now + 0.1)
        self.interview.hold_ack_transcript(stt_event("Okay"))
        activity._start_false_interruption_timer.assert_not_called()

    async def test_zero_turns_it_off_and_a_failure_is_swallowed(self) -> None:
        handle = self.learner_speaking()
        activity = self.activity(handle)
        with mock.patch.dict(os.environ, {"R1_ACK_RESUME_SEC": "0"}):
            self.interview.hold_ack_transcript(stt_event("Okay"))
        activity._start_false_interruption_timer.assert_not_called()
        self.activity(handle, start=mock.Mock(side_effect=RuntimeError("sdk drift")))
        with self.capture_logs() as logs:
            self.assertTrue(self.interview.hold_ack_transcript(stt_event("Okay")))
        self.assertIn("r1_ack_resume_failed", error_types(logs))

    def test_the_bounds(self) -> None:
        for raw, expected in ((None, 0.3), ("0", 0.0), ("1.0", 1.0), ("9", 2.0), ("x", 0.3)):
            with self.subTest(raw=raw), mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("R1_ACK_RESUME_SEC", None)
                if raw is not None:
                    os.environ["R1_ACK_RESUME_SEC"] = raw
                self.assertEqual(r1_session.ack_resume_seconds(), expected)


class TestIcebreakerAcksDoNotCutChristy(R1TestCase):
    """M032 S6 (SWEEP-31; owner test b58c7d9c #4-#6, paraphrased): a two-word thank-you said over
    Christy's icebreaker reply cut it, and she restarted with a new reaction and question.  With
    ``R1_ICEBREAKER_ACK_HOLD`` on, an acknowledgement or a reflexive courtesy over her live model
    reply is held back from the SDK like an "Okay" over the learner.  Synthetic texts only."""

    HELD = ("Okay", "Mm-hmm.", "Thank you", "Thanks so much, sir", "Okay, thank you.", "Yeah.")
    NOT_HELD = (
        "Yes", "Okay?", "Thank you, but what does the role pay?",
        "Thank you. So in my last role I handled inbound leads.", "Sorry?", "Thank you?",
        "Hello? Are you there?",
    )

    def christy_replying(self, *, source: str = "generate_reply", **flags) -> FakeSpeechHandle:
        handle = FakeSpeechHandle("Thanks. So what does a typical", allow_interruptions=True)
        for name, value in flags.items():
            setattr(handle, name, value)
        self.session.current_speech = handle
        self.interview._speeches[handle.id] = r1_session._SpeechSlot(handle, source=source)
        return handle

    def test_an_ack_or_a_courtesy_over_her_live_reply_is_held(self) -> None:
        self.assertIs(self.interview.machine.phase, R1Phase.ICEBREAKER)
        self.christy_replying()
        for text in self.HELD:
            with self.subTest(text=text):
                self.assertTrue(self.interview.hold_ack_transcript(stt_event(text)))
        for kind in ("interim_transcript", "preflight_transcript"):
            with self.subTest(kind=kind):
                self.assertTrue(self.interview.hold_ack_transcript(stt_event("Thank you", kind)))

    def test_a_turn_of_their_own_still_reaches_the_sdk(self) -> None:
        self.christy_replying()
        for text in self.NOT_HELD + ("",):
            with self.subTest(text=text):
                self.assertFalse(self.interview.hold_ack_transcript(stt_event(text)))
        for kind in ("end_of_speech", "start_of_speech"):
            with self.subTest(kind=kind):
                self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay", kind)))

    def test_only_a_live_interruptible_model_reply_is_protected(self) -> None:
        self.session.current_speech = None
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Thank you")))
        # A scripted line ("Are you still with me?"), an untracked speech, a finished, cut or
        # uninterruptible one, and one R1 cut itself: nothing is held.
        self.christy_replying(source="say")
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))
        self.session.current_speech = FakeSpeechHandle("untracked", allow_interruptions=True)
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))
        for flags in (
            {"allow_interruptions": False},
            {"interrupted": True},
            {"done": lambda: True},
        ):
            with self.subTest(flags=list(flags)):
                self.christy_replying(**flags)
                self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))
        handle = self.christy_replying()
        self.interview._speeches[handle.id].cut_by_r1 = True
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))

    def test_the_opening_transition_and_wrap_up_are_not_covered(self) -> None:
        opening = R1Interview(self.ctx, dict(self.LINE_CONTEXT), self.session, self.writer)
        opening.machine.transition(R1Phase.OPENING)
        handle = self.christy_replying()
        opening._speeches[handle.id] = r1_session._SpeechSlot(handle, source="generate_reply")
        self.assertFalse(opening.hold_ack_transcript(stt_event("Thank you")))
        self.interview.machine.transition(R1Phase.TRANSITION)
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Thank you")))
        self.interview.machine.transition(R1Phase.ROLEPLAY)
        # The role-play's held set is unchanged: "Okay" yes, a "Thank you" no.
        self.assertTrue(self.interview.hold_ack_transcript(stt_event("Okay")))
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Thank you")))
        self.interview.machine.transition(R1Phase.ROLEPLAY_EXIT)
        self.interview.machine.transition(R1Phase.WRAPUP)
        self.assertFalse(self.interview.hold_ack_transcript(stt_event("Okay")))

    async def test_the_held_final_is_written_in_the_icebreaker_and_counts_for_nothing(
        self,
    ) -> None:
        self.christy_replying()
        answers = self.interview.machine.candidate_turns
        cursor = self.interview._icebreaker_plan.cursor
        activity = self.interview._candidate_activity_at
        self.assertTrue(self.interview.hold_ack_transcript(stt_event("Thanks so much, sir")))
        self.assertTrue(self.interview._turns.empty())  # the driver is not told
        self.assertEqual(self.interview.machine.candidate_turns, answers)  # no answer counted
        self.assertEqual(self.interview._icebreaker_plan.cursor, cursor)  # the plan never saw it
        self.assertEqual(self.interview._icebreaker_carry, "")
        self.assertFalse(self.interview._icebreaker_reply_cut)
        self.assertEqual(self.interview._candidate_activity_at, activity)
        self.assertFalse(self.interview._candidate_turn_open())  # it is no turn in flight
        self.assertEqual(self.interview._icebreaker_acks_held, 1)
        self.assertEqual(self.interview._repair_facts()["icebreaker_acks_held"], 1)
        self.interview._flush_candidate_row()  # Christy's next line
        await self.flush()
        rows = [
            (row["text"], row["phase"]) for row in self.writer.saved
            if row["speaker"] == "candidate"
        ]
        self.assertEqual(rows, [("Thanks so much, sir", "icebreaker")])

    async def test_a_real_answer_joins_the_held_row_as_one_turn(self) -> None:
        self.christy_replying()
        self.assertTrue(self.interview.hold_ack_transcript(stt_event("Okay")))
        self.final_transcript("In my last role I handled inbound leads every day for a year.")
        await self.settle()
        self.assertTrue(self.interview._candidate_turn_open())  # now a turn is in flight
        self.assertFalse(
            await self.commit_turn("In my last role I handled inbound leads every day for a year.")
        )
        await self.flush()
        rows = [row["text"] for row in self.writer.saved if row["speaker"] == "candidate"]
        self.assertEqual(
            rows, ["Okay In my last role I handled inbound leads every day for a year."]
        )

    def test_a_held_ack_never_stretches_the_hold_at_the_cap(self) -> None:
        self.clock.advance(275)  # past the hard S=4:30 cap
        self.christy_replying()
        self.assertTrue(self.interview.hold_ack_transcript(stt_event("Thank you")))
        self.assertEqual(self.interview._icebreaker_hold_left(), 0.0)
        self.assertEqual(self.interview._icebreaker_budget_left(), 0.0)

    def test_the_flags_restore_todays_icebreaker(self) -> None:
        self.christy_replying()
        for env in ({"R1_ICEBREAKER_ACK_HOLD": "0"}, {"R1_ACK_HOLD": "0"}):
            with self.subTest(env=env), mock.patch.dict(os.environ, env):
                for text in ("Okay", "Thank you"):
                    self.assertFalse(self.interview.hold_ack_transcript(stt_event(text)))
                self.assertNotIn("icebreaker_acks_held", self.interview._repair_facts())

    def test_the_courtesy_reader(self) -> None:
        for text in ("Thank you", "Thanks.", "Okay, thank you so much.", "Thank you, ma'am."):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_courtesy_turn(text))
        for text in ("Yes, thank you.", "Thank you?", "Okay.", "Thank you for asking, I sell",
                     "No thanks", ""):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_courtesy_turn(text))


class TestIcebreakerRepairReaders(unittest.TestCase):
    """M032 S6 (SWEEP-28, ``R1_ICEBREAKER_REPAIR``): the wider repair readers.  Synthetic texts;
    owner test b419d478 (paraphrased) had "Can you repeat it once again?" and "Sorry, I was not
    able to hear you" read as answers."""

    NEW_CLARIFICATIONS = (
        "Can you repeat that once again?",
        "Sorry, I was not able to hear you.",
        "I'm sorry, could you repeat that?",
        "I am sorry, can you say that again?",
        "Sorry, we were unable to hear you properly.",
        "I'm not able to catch that.",
    )
    REPEATS = (
        "Sorry, could you repeat the question?",
        "Can you repeat that once again?",
        "Could you say that again, please?",
        "Sorry, what was the question?",
        "I didn't catch that.",
        "Sorry, I was not able to hear you.",
        "What did you say?",
        "Can you rephrase that?",
        "Sorry?",
        "Pardon?",
        "Come again?",
    )
    NOT_REPEATS = (
        "Hello? Are you there?",
        "Can you hear me?",
        "Yes, I can hear you.",
        "Sorry.",
        "What do you mean?",
        "Sorry, can you repeat that? I sell courses to working professionals.",
        "Could you give me a second?",
        "I repeat the same process every day.",
        "",
    )

    def test_the_new_forms_are_repairs_with_no_content_words(self) -> None:
        for text in self.NEW_CLARIFICATIONS:
            with self.subTest(text=text):
                self.assertEqual(r1_session.content_word_count(text), 0)
                self.assertTrue(r1_session.is_repair_turn(text))
        with mock.patch.dict(os.environ, {"R1_ICEBREAKER_REPAIR": "0"}):
            for text in self.NEW_CLARIFICATIONS:
                with self.subTest(text=text, flag="off"):
                    self.assertGreater(r1_session.content_word_count(text), 0)
                    self.assertFalse(r1_session.is_repair_turn(text))

    def test_the_pinned_clarifications_and_answers_read_as_before(self) -> None:
        for text in TestReplyPolicy.CLARIFICATIONS:
            with self.subTest(text=text):
                self.assertEqual(r1_session.content_word_count(text), 0)
        for text in (
            "I couldn't get a job at first",
            "I say what I think to every learner",
            "I was not able to close that one deal",
            "We were unable to follow up in time",
        ):
            with self.subTest(text=text):
                wide = r1_session.content_word_count(text)
                with mock.patch.dict(os.environ, {"R1_ICEBREAKER_REPAIR": "0"}):
                    self.assertEqual(wide, r1_session.content_word_count(text))
                self.assertFalse(r1_session.is_repair_turn(text))

    def test_a_repeat_request_only_asks_to_hear_it_again(self) -> None:
        for text in self.REPEATS:
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_repeat_request(text))
        for text in self.NOT_REPEATS:
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_repeat_request(text))

    def test_the_icebreaker_view_looks_past_how_christy_is_addressed(self) -> None:
        # Review of S6: "sir", "ma'am" and her name, and a leading "hold on" / "wait", are not
        # words of the request.  The role-play's own reader is unchanged.
        repeats = (
            "Could you please repeat the question, Christy?",
            "Sorry ma'am, can you repeat the question?",
            "Sir, can you repeat the question?",
            "Can you please repeat the question once again, ma'am?",
            "Hold on, can you repeat the question?",
            "Wait, what was the question?",
            "Pardon, madam?",
        )
        for text in repeats:
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_repeat_request(r1_session._ib_repair_view(text)))
        for text in ("Christy, are you there?", "Hello ma'am, are you there?"):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_repair_turn(r1_session._ib_repair_view(text)))
        self.assertFalse(r1_session.is_repair_turn("Sir, can you repeat the question?"))
        for text in (
            "Sir, I sold courses for five years.",
            "Hold on, I worked in a bank before that.",
            "Christy is a nice name.",
            "Hold on.",
            "",
        ):
            with self.subTest(text=text):
                view = r1_session._ib_repair_view(text)
                self.assertFalse(r1_session.is_repeat_request(view))
                self.assertFalse(r1_session.is_repair_turn(view))

    def test_real_advisor_turns_read_the_same_but_for_a_folded_sorry(self) -> None:
        # The 2,136-turn advisor corpus and its held-out set (the role-play's barge-in repair reads
        # them too): no turn becomes or stops being a repair turn, none is a repeat request, and
        # the only count that moves is one word fewer where "I'm sorry" folds to "sorry" (two turns).
        fixtures = Path(__file__).resolve().parent / "fixtures"
        moved: list[int] = []
        for name in ("r1_advisor_corpus.jsonl", "r1_advisor_heldout.jsonl"):
            for raw in (fixtures / name).read_text(encoding="utf-8").splitlines():
                if not raw:
                    continue
                text = json.loads(raw)["text"]
                wide = (r1_session.content_word_count(text), r1_session.is_repair_turn(text))
                self.assertFalse(r1_session.is_repeat_request(text))
                # Review of S6: nor through the icebreaker's view, nor as a hold request.
                view = r1_session._ib_repair_view(text)
                self.assertFalse(r1_session.is_repeat_request(view))
                self.assertEqual(r1_session.is_repair_turn(view), wide[1])
                self.assertFalse(r1_session.is_hold_request(text))
                with mock.patch.dict(os.environ, {"R1_ICEBREAKER_REPAIR": "0"}):
                    narrow = (r1_session.content_word_count(text), r1_session.is_repair_turn(text))
                self.assertEqual(wide[1], narrow[1])
                if wide[0] != narrow[0]:
                    self.assertIn("i'm sorry", r1_session.fold_speech(text))
                    moved.append(narrow[0] - wide[0])
        self.assertEqual(moved, [1, 1])

    def test_the_new_readers_are_linear_on_long_input(self) -> None:
        import time as _time

        for text in (
            "i was " + "not able to " * 3000 + "hear",
            "can you say " + "that " * 5000 + "once again",
            "sorry " * 5000 + "pardon",
            "i'm sorry " * 3000,
        ):
            started = _time.perf_counter()
            r1_session.content_word_count(text)
            r1_session.is_repair_turn(text)
            r1_session.is_repeat_request(text)
            self.assertLess(_time.perf_counter() - started, 1.0)


class EndIntentRunner:
    """A fake classifier: records its calls, answers ``verdict`` (or raises, or hangs)."""

    def __init__(self, verdict='{"intent": "end"}', *, hang=False, error=None, gate=None):
        self.verdict = verdict
        self.hang = hang
        self.error = error
        self.gate = gate
        self.calls: list[list[dict]] = []
        self.cancelled = 0

    async def __call__(self, messages):
        self.calls.append(messages)
        try:
            if self.gate is not None:
                await self.gate.wait()
            if self.hang:
                await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        if self.error is not None:
            raise self.error
        return self.verdict


class TestEndIntentClassification(R1TestCase):
    """Owner decision 2026-10-30 item 1: a quick model decides what the lexical detectors miss."""

    def use(self, runner: EndIntentRunner) -> EndIntentRunner:
        self.interview._end_intent_runner = runner
        return runner

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.enter_roleplay()
        self.interview.engine  # built, as the first role-play turn builds it

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_the_call_starts_at_the_final_and_is_reused_at_the_hook(self) -> None:
        runner = self.use(EndIntentRunner())
        text = "Okay, we can wrap up the interview here."
        self.final_transcript(text)
        self.assertIsNotNone(self.interview._end_intent_call)  # started at the final
        await self.settle()
        self.assertEqual(len(runner.calls), 1)  # before the hook
        with self.capture_logs() as logs:
            self.assertTrue(await self.commit_turn(text))
        self.assertEqual(len(runner.calls), 1)  # reused
        self.assertTrue(self.interview.engine.end_confirmed)
        self.assertTrue(self.interview.engine.exit_requested)
        latency = [line_ for line_ in logs if line_.get("error_type") == "r1_latency"]
        waits = [line_ for line_ in latency if line_.get("schema") == "end_intent_wait"]
        self.assertEqual([line_["error_category"] for line_ in waits], ["reused"])
        await self.flush()
        rows = [row for row in self.writer.saved if row["speaker"] == "candidate"]
        self.assertEqual([(row["text"], row["phase"]) for row in rows], [(text, "aside")])

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_the_call_reports_its_own_time_and_verdict(self) -> None:
        self.use(EndIntentRunner('{"intent": "maybe"}'))
        with self.capture_logs() as logs:
            self.final_transcript("Let's call it a day.")
            await self.settle()
            self.assertTrue(await self.commit_turn("Let's call it a day."))
        calls = [line_ for line_ in logs if line_.get("schema") == "end_intent_call"]
        self.assertEqual([line_["error_category"] for line_ in calls], ["maybe"])
        self.assertIn(self.spoken_line("L-ASIDE-END"), self.session.spoken)
        self.assertTrue(self.interview.engine.end_question_open)

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_changed_text_starts_a_fresh_call(self) -> None:
        runner = self.use(EndIntentRunner())
        self.final_transcript("Okay, so we can wrap up.")
        first = self.interview._end_intent_call
        self.final_transcript("The interview, I mean.")
        self.assertIsNot(self.interview._end_intent_call, first)
        self.assertTrue(first.task.cancelled() or first.task.cancelling())
        await self.settle()
        self.assertEqual(len(runner.calls), 1)  # the first never ran; the joined text's did
        self.assertIn("The interview, I mean.", runner.calls[0][1]["content"])
        await self.commit_turn("Okay, so we can wrap up. The interview, I mean.")
        self.assertEqual(len(runner.calls), 1)  # the hook reused it
        # The model's "end" reached the plan; the turn does not END on the request (its last
        # sentence is "The interview, I mean."), so it is asked, not exited (``strictly_names_end``).
        self.assertFalse(self.interview.engine.end_confirmed)
        self.assertTrue(self.interview.engine.end_question_open)
        await self.asyncSetUp()  # a fresh role-play: the hook's text differs from the finals'
        runner_two = self.use(EndIntentRunner('{"intent": "no"}'))
        self.final_transcript("Let's close the deal")
        await self.settle()
        self.assertFalse(
            await self.commit_turn("Let's close the deal today, the festival price ends Sunday.")
        )
        self.assertEqual(len(runner_two.calls), 2)  # the hook's text differed: a call at the hook

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_timeout_an_error_or_nonsense_is_the_lexical_reading(self) -> None:
        for runner in (
            EndIntentRunner(hang=True),
            EndIntentRunner(error=RuntimeError("provider down")),
            EndIntentRunner("I think they want to stop"),
        ):
            with self.subTest(runner=vars(runner)), mock.patch.dict(
                os.environ, {"R1_END_INTENT_TIMEOUT_SEC": "0.3"}
            ):
                self.use(runner)
                loop = asyncio.get_running_loop()
                started = loop.time()
                with self.capture_logs() as logs:
                    suppressed = await self.commit_turn("Kindly end the interview.")
                self.assertLess(loop.time() - started, 1.0)
                self.assertFalse(suppressed)  # "Kindly end the interview." alone: a free reply
                self.assertFalse(self.interview.engine.exit_requested)
                categories = [
                    line_.get("error_category")
                    for line_ in logs
                    if line_.get("error_type") == "r1_end_intent"
                ]
                self.assertTrue({"timeout", "error", "parse_failed"} & set(categories), categories)
                self.assertIn("none", categories)
        self.assertEqual(self.use(EndIntentRunner(hang=True)).cancelled, 0)

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_timed_out_call_is_cancelled(self) -> None:
        runner = self.use(EndIntentRunner(hang=True))
        with mock.patch.dict(os.environ, {"R1_END_INTENT_TIMEOUT_SEC": "0.3"}):
            await self.commit_turn("Kindly end the interview.")
        await self.settle()
        self.assertEqual(runner.cancelled, 1)

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_turns_the_model_is_never_asked_about(self) -> None:
        runner = self.use(EndIntentRunner())
        # A prefilter miss: no call, no wait.
        self.final_transcript("What's your budget for this?")
        await self.commit_turn("What's your budget for this?")
        # The lexical fast path: an explicit request exits without the model.
        self.final_transcript("End the interview.")
        self.assertTrue(await self.commit_turn("End the interview."))
        self.assertTrue(self.interview.engine.end_confirmed)
        self.assertEqual(runner.calls, [])

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_the_kill_switch_and_a_session_without_a_client(self) -> None:
        runner = self.use(EndIntentRunner())
        with mock.patch.dict(os.environ, {"R1_END_INTENT_LLM": "0"}):
            self.final_transcript("Kindly end the interview.")
            self.assertFalse(await self.commit_turn("Kindly end the interview."))
        self.assertEqual(runner.calls, [])
        self.interview._end_intent_runner = None
        self.assertIsNone(getattr(self.session, "llm", None))
        self.assertIsNone(self.interview._end_intent_runner_or_none())

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_an_unbuildable_client_disables_the_classifier_once(self) -> None:
        self.session.llm = object()
        self.assertEqual(
            self.interview._end_intent_runner_or_none(), self.interview._default_end_intent
        )
        with mock.patch.object(
            r1_llm, "build_r1_judge_llm", side_effect=r1_llm.R1LLMConfigurationError("x")
        ), self.capture_logs() as logs:
            self.assertFalse(await self.commit_turn("Kindly end the interview."))
        self.assertIn("r1_end_intent_unusable", error_types(logs))
        self.assertTrue(self.interview._end_intent_unusable)
        self.assertIsNone(self.interview._end_intent_runner_or_none())

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_final_during_the_wait_opens_the_next_row(self) -> None:
        gate = asyncio.Event()
        self.use(EndIntentRunner('{"intent": "no"}', gate=gate))
        text = "Let's close this deal now, I can hold the price."
        self.user_state("speaking")
        self.clock.advance(4.0)
        self.user_state("listening")
        self.final_transcript(text)
        index = self.interview._open_row.index
        engine = self.interview.engine
        with mock.patch.object(engine, "plan_turn", wraps=engine.plan_turn) as plan:
            hook = asyncio.create_task(self.commit_turn(text))
            await self.settle()
            self.assertFalse(hook.done())  # waiting for the verdict
            self.user_state("speaking")
            self.clock.advance(2.0)
            self.user_state("listening")
            self.final_transcript("Hello?")
            gate.set()
            await hook
        kwargs = plan.call_args.kwargs
        self.assertEqual((kwargs["turn_index"], kwargs["candidate_seconds"]), (index, 4.0))
        self.assertEqual(kwargs["end_intent"], "no")
        self.assertEqual(self.interview._open_row.parts, ["Hello?"])
        self.assertGreater(self.interview._open_row.index, index)
        self.assertEqual(self.interview._latest_candidate_index, self.interview._open_row.index)
        await self.flush()
        self.assertEqual(
            [row["text"] for row in self.writer.saved if row["speaker"] == "candidate"], [text]
        )

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_the_owners_missed_phrasings_end_the_roleplay_with_the_model(self) -> None:
        from tests.test_r1_end_intent import OWNER_MISSED

        for text in OWNER_MISSED:
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.use(EndIntentRunner())
                self.final_transcript(text)
                await self.settle()
                self.assertTrue(await self.commit_turn(text))
                self.assertTrue(self.interview.engine.end_confirmed, text)

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_the_question_is_the_context_after_the_aside(self) -> None:
        runner = self.use(EndIntentRunner('{"intent": "maybe"}'))
        await self.commit_turn("Can you end the call?")  # lexical "maybe": the model may raise it
        await self.until(lambda: self.spoken_and_played("L-ASIDE-END"))
        await self.settle()
        self.assertEqual(len(runner.calls), 1)
        self.assertNotIn("Dex has just asked", runner.calls[0][1]["content"])
        self.assertTrue(await self.commit_turn("Okay, let's wrap it up then."))
        self.assertIn("Dex has just asked", runner.calls[-1][1]["content"])
        self.assertTrue(self.interview.engine.end_confirmed)


class TestBareYesConfirmsTheEnd(R1TestCase):
    """Owner decision 2026-10-30 item 2: after L-ASIDE-END a bare yes confirms the stop."""

    async def asked(self) -> None:
        self.enter_roleplay()
        self.assertTrue(await self.commit_turn("Okay, never mind, can you disconnect the call?"))
        await self.until(lambda: self.spoken_and_played("L-ASIDE-END"))
        await self.settle()
        self.assertTrue(self.interview.engine.end_question_open)

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_yes_that_stands_confirms_and_exits_into_the_wrap_up(self) -> None:
        await self.asked()
        for answer in ("Yes.",):
            with mock.patch.dict(os.environ, {"R1_BARE_YES_SETTLE_SEC": "0.2"}):
                self.final_transcript(answer)
                await self.settle()
                self.assertTrue(await self.commit_turn(answer))
        self.assertTrue(self.interview.engine.end_confirmed)
        self.assertTrue(self.interview._roleplay_exit_requested())
        await self.flush()
        rows = [row for row in self.writer.saved if row["speaker"] == "candidate"]
        self.assertEqual((rows[-1]["text"], rows[-1]["phase"]), ("Yes.", "aside"))

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_the_owners_answers_confirm(self) -> None:
        for answer in ("yes please", "sure", "haan", "go ahead", "Haan ji."):
            with self.subTest(answer=answer):
                await self.asyncSetUp()
                await self.asked()
                with mock.patch.dict(os.environ, {"R1_BARE_YES_SETTLE_SEC": "0.05"}):
                    self.assertTrue(await self.commit_turn(answer))
                self.assertTrue(self.interview.engine.end_confirmed)

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_yes_the_candidate_goes_on_from_waits_for_the_next_turn(self) -> None:
        await self.asked()
        self.final_transcript("Yeah.")
        await self.settle()
        with mock.patch.dict(os.environ, {"R1_BARE_YES_SETTLE_SEC": "1.0"}):
            hook = asyncio.create_task(self.commit_turn("Yeah."))
            await self.settle()
            self.user_state("speaking")
            self.final_transcript("no, let's carry on")
            self.assertTrue(await asyncio.wait_for(hook, 3.0))  # StopResponse: no answer alone
        engine = self.interview.engine
        self.assertFalse(engine.end_confirmed)
        self.assertTrue(engine.end_question_open)
        await self.flush()
        rows = [row for row in self.writer.saved if row["speaker"] == "candidate"]
        self.assertEqual((rows[-1]["text"], rows[-1]["phase"]), ("Yeah.", "aside"))
        self.user_state("listening")
        self.assertFalse(await self.commit_turn("no, let's carry on"))  # declined: role-play on
        self.assertFalse(engine.end_confirmed)
        self.assertFalse(engine.end_question_open)

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_speech_without_a_transcript_was_noise_and_the_yes_stands(self) -> None:
        await self.asked()
        with mock.patch.dict(os.environ, {"R1_BARE_YES_SETTLE_SEC": "1.0"}), mock.patch.object(
            r1_session, "endpoint_max_delay_sec", return_value=0.05
        ), mock.patch.object(r1_session, "BARE_YES_FINAL_MARGIN_SECONDS", 0.05):
            hook = asyncio.create_task(self.commit_turn("Yes."))
            await self.settle()
            self.user_state("speaking")
            self.user_state("listening")
            self.assertTrue(await asyncio.wait_for(hook, 3.0))
        self.assertTrue(self.interview.engine.end_confirmed)

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_yes_never_confirms_while_the_candidate_is_still_speaking(self) -> None:
        # Reviewed fix: the transcript wait ran from when the speech STARTED, so a continuation
        # longer than it ("... no wait, I want to carry on") timed out as noise and Christy's
        # wrap-up began mid-sentence.
        await self.asked()
        engine = self.interview.engine
        with mock.patch.dict(os.environ, {"R1_BARE_YES_SETTLE_SEC": "0.2"}), mock.patch.object(
            r1_session, "endpoint_max_delay_sec", return_value=0.1
        ), mock.patch.object(r1_session, "BARE_YES_FINAL_MARGIN_SECONDS", 0.1):
            self.final_transcript("Yes.")
            await self.settle()
            hook = asyncio.create_task(self.commit_turn("Yes."))
            await self.settle()
            self.user_state("speaking")
            await asyncio.sleep(0.8)  # four times settle + maximum delay + margin, still speaking
            self.assertFalse(hook.done())
            self.assertFalse(engine.end_confirmed)
            self.assertFalse(self.interview._roleplay_exit_requested())
            self.user_state("listening")
            self.final_transcript("no wait, I want to carry on with the role play")
            self.assertTrue(await asyncio.wait_for(hook, 3.0))  # deferred: no answer alone
        self.assertFalse(engine.end_confirmed)
        self.assertTrue(engine.end_question_open)
        self.assertFalse(await self.commit_turn("no wait, I want to carry on with the role play"))
        self.assertFalse(engine.end_confirmed)
        self.assertFalse(self.interview._roleplay_exit_requested())

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_speech_that_stops_with_no_transcript_was_noise_after_it_stopped(self) -> None:
        # The noise wait starts when the speech stops: a long noise still confirms, only later.
        await self.asked()
        with mock.patch.dict(os.environ, {"R1_BARE_YES_SETTLE_SEC": "0.2"}), mock.patch.object(
            r1_session, "endpoint_max_delay_sec", return_value=0.1
        ), mock.patch.object(r1_session, "BARE_YES_FINAL_MARGIN_SECONDS", 0.1):
            hook = asyncio.create_task(self.commit_turn("Yes."))
            await self.settle()
            self.user_state("speaking")
            await asyncio.sleep(0.5)
            self.assertFalse(hook.done())
            self.user_state("listening")
            self.assertTrue(await asyncio.wait_for(hook, 3.0))
        self.assertTrue(self.interview.engine.end_confirmed)

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_yes_to_the_learner_after_a_fragment_never_confirms(self) -> None:
        # Reviewed fix: "Okay." left the question open while the learner answered in role, so a
        # "Yes." to her confirmed the stop, and the model was still told "Christy has just asked".
        await self.asked()
        engine = self.interview.engine
        self.assertFalse(await self.commit_turn("Okay."))  # the learner replies
        self.assertFalse(engine.end_question_open)
        with mock.patch.dict(os.environ, {"R1_BARE_YES_SETTLE_SEC": "0.05"}):
            self.final_transcript("Yes.")
            await self.settle()
            self.assertFalse(await self.commit_turn("Yes."))
        self.assertFalse(engine.end_confirmed)
        self.assertFalse(self.interview._roleplay_exit_requested())
        runner = EndIntentRunner('{"intent": "end"}')
        self.interview._end_intent_runner = runner
        text = "So Priya, once you finish the course you will clear the interview easily."
        self.final_transcript(text)
        await self.settle()
        self.assertFalse(await self.commit_turn(text))
        self.assertTrue(runner.calls)
        self.assertNotIn("Dex has just asked", runner.calls[-1][1]["content"])
        self.assertFalse(engine.end_confirmed)
        self.assertFalse(self.interview._roleplay_exit_requested())

    @mock.patch.dict(os.environ, {"R1_END_ASIDE_V2": "0"})  # Simulation diagnosis 3: the release before
    async def test_a_yes_with_no_question_open_is_an_ordinary_turn(self) -> None:
        self.enter_roleplay()
        loop = asyncio.get_running_loop()
        started = loop.time()
        self.assertFalse(await self.commit_turn("Yes."))
        self.assertLess(loop.time() - started, 0.5)  # no settle wait
        self.assertFalse(self.interview.engine.end_confirmed)


class TestBriefRepeatOnRequest(R1TestCase):
    """Owner decision 2026-10-30 item 4 (owner test 1eb18cd4 #13-#18): the brief once more.

    M032 S6: these pin the rollback (``R1_TRANSITION_REPAIR=0``): the brief replayed word for word,
    once, and the nudge for a later request.  ``TestBriefRepairOnRequest`` pins the repair.
    """

    async def asyncSetUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": "0"})
        patcher.start()
        self.addCleanup(patcher.stop)
        await super().asyncSetUp()

    OWNER_14 = (
        "But yeah, for my personal growth, I wanted to switch so that I'll get a new environment. "
        "Okay, could you please explain me again like what this round is about, the role play in "
        "a small brief kind of thing?"
    )

    def press(self) -> None:
        self.ctx.room.emit("data_received", ready_packet())

    async def start_transition(self) -> asyncio.Task:
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        return task

    def briefs(self) -> int:
        return self.session.spoken.count(self.spoken_line("L-TRANSITION"))

    def test_the_detector(self) -> None:
        for text in (
            self.OWNER_14,
            "I wanted to understand this, uh, this round, the role play brief.",
            "Can you repeat that?",
            "What should I do?",
            "Sorry, could you explain the scenario again?",
            "I didn't understand.",
            "Who is the learner?",
            "I'm the advisor?",
            "Come again?",
            # Reviewed fix: common phrasings the first cut missed (and the SDK then dropped).
            "Explain me again.", "Can you tell me again?",
            "Could you tell me once more what I need to do?", "Please tell me again.",
            "Repeat please.", "Pardon?", "What is my role?", "what's my role here?",
            "What exactly do I have to do?", "I didn't get you.", "I'm not clear.",
            "Brief me again.", "Once again please.", "Sorry, one more time.",
            "I want to understand what I have to do.",
        ):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_brief_request(text))
        for text in (
            "Ready", "Okay", "Yes", "Sure, let's start", "Thank you", "Okay got it",
            "Yes, I can hear you", "Alright, I'm ready", "So Bye", "I'm the advisor.",
            "Hmm, hold on a second.",
            "But yeah, for my personal growth, I wanted to switch so that I'll get a new "
            "environment.",
            # Reviewed fix: courtesies and statements that end an icebreaker answer over
            # L-TRANSITION, which replayed the whole brief nobody asked for.
            "Thank you once again.", "Okay, thank you once again.",
            "Yeah, that's it. Thank you once again for this opportunity.",
            "So I wanted to understand how sales works in edtech.",
            "That's why I wanted to understand the customer side better.",
            "And yeah, I would like to understand more about this role.",
            "I got promoted once again last year.", "Let me try one more time.",
            "So I need to understand her pain points, right?",
            "Just to recap everything one more time, the course has six modules.",
            "I'd like to understand your goals before we talk about enrolment.",
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_brief_request(text))

    def test_real_advisor_turns_never_ask_for_the_brief(self) -> None:
        # Reviewed fix: 5 of the 2,136 corpus and held-out turns matched the first cut.
        fixtures = Path(__file__).resolve().parent / "fixtures"
        for name in ("r1_advisor_corpus.jsonl", "r1_advisor_heldout.jsonl"):
            for line in (fixtures / name).read_text(encoding="utf-8").splitlines():
                if line:
                    text = json.loads(line)["text"]
                    with self.subTest(text=text[:80]):
                        self.assertFalse(r1_session.is_brief_request(text))

    async def test_a_request_during_the_briefing_replays_it_once(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.final_transcript(self.OWNER_14)  # spoken over L-TRANSITION: the SDK drops the turn
        self.assertTrue(self.interview._brief_requested)
        with self.capture_logs() as logs:
            task = await self.start_transition()
            await self.until(lambda: self.briefs() == 1)
            await self.until(lambda: self.spoken_and_played("L-TRANSITION"))
            await self.settle()
            self.assertFalse(task.done())  # waiting for ready again
            self.final_transcript("ready")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.briefs(), 1)
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-PICKUP")), 1)
        self.assertNotIn(self.spoken_line("L-TRANSITION-NUDGE"), self.session.spoken)
        self.assertIn("r1_brief_repeat", error_types(logs))

    async def test_a_second_request_gets_the_nudge_and_no_second_replay(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        task = await self.start_transition()
        self.final_transcript("Can you repeat that?")
        await self.until(lambda: self.briefs() == 1 and self.spoken_and_played("L-TRANSITION"))
        await self.settle()
        # The brief was replayed once already: the hook's nudge answers the second request.
        self.assertTrue(await self.answer("Sorry, can you repeat that?"))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-NUDGE"))
        await self.settle()
        self.final_transcript("Okay, ready.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.briefs(), 1)
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-TRANSITION-NUDGE")), 1)

    async def test_ready_said_during_the_replay_picks_up_right_after_it(self) -> None:
        self.session.playout_seconds = 0.2
        self.interview._enter(R1Phase.TRANSITION)
        self.final_transcript("What do I do?")
        task = await self.start_transition()
        await self.until(lambda: ("play_start", self.spoken_line("L-TRANSITION")) in self.order)
        self.final_transcript("Okay, ready.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.briefs(), 1)
        self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_the_button_during_the_replay_picks_up_after_it(self) -> None:
        self.session.playout_seconds = 0.2
        self.interview._enter(R1Phase.TRANSITION)
        self.final_transcript("What do I do?")
        task = await self.start_transition()
        await self.until(lambda: ("play_start", self.spoken_line("L-TRANSITION")) in self.order)
        self.press()
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertTrue(self.spoken_and_played("L-TRANSITION"))
        self.assertEqual(self.session.spoken, [
            self.spoken_line("L-TRANSITION"), self.spoken_line("L-PICKUP")
        ])

    async def test_a_press_before_the_replay_means_no_replay(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.final_transcript("What do I do?")
        self.press()
        self.assertIsNone(await asyncio.wait_for(self.interview._run_transition(), 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])

    async def test_the_replay_never_starts_the_role_play_by_itself(self) -> None:
        # M1: no deadline after the replay either; the wait goes on until the candidate agrees.
        self.interview._enter(R1Phase.TRANSITION)
        task = await self.start_transition()
        self.final_transcript("Can you repeat that?")
        await self.until(lambda: self.spoken_and_played("L-TRANSITION"))
        await asyncio.sleep(0.2)
        self.assertFalse(task.done())
        self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)
        self.final_transcript("Yes, let's start.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_a_request_with_ready_in_it_replays_the_brief_and_never_picks_up(self) -> None:
        # M1 review fix: a turn that asks something is no consent, even with "ready" in it.
        self.assertTrue(r1_session.is_brief_request("Okay, ready. Can you repeat that?"))
        self.interview._enter(R1Phase.TRANSITION)
        task = await self.start_transition()
        self.final_transcript("Okay, ready. Can you repeat that?")
        await self.until(lambda: self.briefs() == 1)
        await self.settle()
        self.assertFalse(task.done())
        self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)
        self.final_transcript("Ready.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_an_audio_check_is_no_request(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        task = await self.start_transition()
        # Christy's to answer (M1), never a replay of the brief.
        self.assertFalse(await self.answer("Yes, I can hear you."))
        self.final_transcript("ready")
        await asyncio.wait_for(task, 10.0)
        self.assertEqual(self.briefs(), 0)

    async def test_the_owners_transition_through_the_real_driver(self) -> None:
        run = await self.start_interview()
        run.clock.advance(271)
        run.interview._wake()
        await self.until(lambda: run.interview.machine.phase is R1Phase.TRANSITION)
        run.session.emit("user_input_transcribed", final_event(self.OWNER_14))
        await self.until(
            lambda: run.session.spoken.count(self.spoken_line("L-TRANSITION")) == 2
        )
        await self.until(lambda: self.order.count(("play_end", self.spoken_line("L-TRANSITION")))
                         == 2)
        await self.settle()
        run.session.emit("user_input_transcribed", final_event("ready"))
        await self.until(lambda: run.interview.machine.phase is R1Phase.ROLEPLAY)
        self.assertEqual(run.session.spoken.count(self.spoken_line("L-PICKUP")), 1)
        await self.drain_cancel(run)

    async def test_after_the_pickup_the_brief_request_gets_the_coach_aside(self) -> None:
        # Owner row #18 ("I wanted to understand this, uh, this round, the role play brief."),
        # already in the role-play: L-TRANSITION cannot follow the pickup, the coach aside does.
        self.enter_roleplay()
        text = "I wanted to understand this, uh, this round, the role play brief."
        self.assertTrue(await self.commit_turn(text))
        await self.until(lambda: self.spoken_and_played("L-ASIDE-COACH"))
        self.assertNotIn(self.spoken_line("L-TRANSITION"), self.session.spoken)


class TestBriefRepairOnRequest(R1TestCase):
    """M032 S6 (R1_TRANSITION_REPAIR on, the default): the brief and the transition, repaired.

    The owner's call fda9e9f6 #23-#31, paraphrased: two requests for the brief were answered with
    "What would you like to know?" and the JOB's shift timings, "Are you there?" got nothing, and
    the replay said "Thank you ... We'll now move to the role-play." again three minutes in.  Owner
    test 8f5bfefc #25-#28: the brief "in about four lines" got the nudge and then the whole brief.
    All texts here are synthetic.
    """

    LEADS = ("Meera Iyer", "Meera")

    def press(self) -> None:
        self.ctx.room.emit("data_received", ready_packet())

    async def start_transition(self) -> asyncio.Task:
        self.interview._enter(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        return task

    def count(self, line_id: str) -> int:
        return self.session.spoken.count(self.spoken_line(line_id))

    def transition_facts(self) -> dict:
        """The transition repair's ``session_facts`` labels and counts (the icebreaker's apart)."""
        keys = ("start_by", "pressed_during", "transition_recaps")
        return {k: v for k, v in self.interview._repair_facts().items() if k in keys}

    def test_the_brief_ids_for_every_flag_combination(self) -> None:
        # SWEEP-30 item 6: one helper picks the first brief and the replay for both ``say`` sites;
        # R1_TRANSITION_REPAIR=0 speaks revision 21's texts (bridged or not) byte for byte.
        import r1_script

        values = dict(first_name=self.interview._first_name(), **self.interview.persona.line_values)
        self.interview._reaction_variety = False  # D3-ICE1's thanked briefs: below the loop
        for bridged in (False, True):
            heard = "L-TRANSITION-BRIDGED" if bridged else "L-TRANSITION"
            self.interview._brief_line = heard
            for repair in ("0", "1"):
                with self.subTest(bridged=bridged, repair=repair), mock.patch.dict(
                    os.environ,
                    {
                        "R1_TRANSITION_REPAIR": repair,
                        "R1_BRIEF_VARIETY": "0",
                        "R1_BRIEF_WORDING_V2": "0",  # D4-BRIEF2: revision 30's wording here
                    },
                ):
                    first = self.interview._brief_line_id(bridged=bridged)
                    replay = self.interview._brief_line_id(replay=True)
                    self.assertEqual(first, heard)
                    if repair == "0":
                        self.assertEqual(replay, heard)  # word for word, as before
                        old = r1_script.line(f"{heard}-V20", **values)
                        self.assertEqual(self.interview.render_line(first), old)
                        self.assertEqual(self.interview.render_line(replay), old)
                        self.assertIn("We'll now move to the role-play.", old)
                    else:
                        self.assertEqual(replay, "L-TRANSITION-AGAIN")
                        for line_id in (first, replay):
                            text = self.interview.render_line(line_id)
                            self.assertNotIn("We'll now move", text)
                            self.assertTrue(text.endswith(
                                "Shall we start the role-play now, or do you have any questions "
                                "first?"
                            ))
                        self.assertEqual(
                            self.interview.render_line(first).startswith("Thank you"), not bridged
                        )
            # D3-BRIEF1 (R1_BRIEF_VARIETY on, the default): the replay is re-explained.
            self.assertEqual(self.interview._brief_line_id(bridged=bridged), heard)
            self.assertEqual(
                self.interview._brief_line_id(replay=True), "L-TRANSITION-AGAIN-PLAIN"
            )
        # D3-ICE1 (R1_REACTION_VARIETY on, the default): the first brief's thanks is seeded; the
        # bridged brief has none.
        self.interview._reaction_variety = True
        self.assertIn(self.interview._brief_line_id(), r1_session._THANKED_BRIEFS)
        self.assertEqual(self.interview._brief_line_id(bridged=True), "L-TRANSITION-BRIDGED")

    def test_the_wider_brief_request(self) -> None:
        for text in (
            "Can you give me a quick summary of this role play again?",
            "Tell me about the role play again.",
            "Could you tell me a bit more about the role play?",
            "I'd like more details about the scenario.",
            "Can I get more information on this role play?",
            "Tell me a little more about Meera.",
            "Who is Meera Iyer?",
            "Please recap the brief for me.",
        ):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS))
                self.assertFalse(r1_session.is_brief_request(text))  # revision 21 missed them
        for text in (
            "And yeah, I would like to understand more about this role.",
            "Just to recap everything one more time, the course has six modules.",
            "That is a summary of my experience.",
            "Tell me about the role.",
            "Can you give me more details about the salary?",
            "I want more information on this.",
            "Okay, ready, let's go.",
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS))

    def test_the_shorter_brief_request(self) -> None:
        # SWEEP-29: a marker plus an ask plus a brief object, or (right after a brief) a pronoun or
        # bare form; never "shortly", a bare "brief", or a summary of something else.
        for text, after_brief in (
            ("Can you say this instruction, like, in about four lines?", False),
            ("Can you explain it again briefly?", True),
            ("Just give me a quick summary of the role play.", False),
            ("Can you summarise?", True),
            ("Give me the short version.", True),
            ("Say it in short, please.", True),
            ("Could you quickly tell me what I have to do?", False),
        ):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_short_brief_request(
                    text, after_brief=after_brief, lead_names=self.LEADS
                ))
        for text, after_brief in (
            ("Can you repeat the brief?", True),
            ("What is the brief?", True),
            ("I'll keep it short.", True),
            ("That is a summary of my experience.", True),
            ("In short, I sold courses for five years.", True),
            ("Can you quickly tell me the salary?", True),
            ("Just quickly, what are the shifts?", True),
            ("Can you explain that briefly?", False),  # after a shift-timings answer
            ("Can you give me a quick summary of the salary structure?", True),
            ("Shortly I will be ready.", True),
            ("Okay, ready, let's go.", True),
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_short_brief_request(
                    text, after_brief=after_brief, lead_names=self.LEADS
                ))

    def test_presence_and_role_play_questions(self) -> None:
        for text in ("Hello? Are you there?", "Are you still there?", "Hello?", "Can you hear me?",
                     "Christy, are you there?", "Sorry, are you there?"):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_presence_check(text))
        for text in ("Hello? What?", "Yes, I can hear you.", "Sorry, can you repeat that?",
                     "Pardon?", "Are you there to help me with the course?"):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_presence_check(text))
        for text in ("How long does the role play last?", "What does Meera do for a living?",
                     "Is the learner the one who pays?", "Can I take notes during the role play?"):
            with self.subTest(text=text):
                self.assertTrue(r1_session.names_the_roleplay(text, self.LEADS))
        for text in ("I understood the role play.", "What are the shift timings?",
                     "The role play sounds good."):
            with self.subTest(text=text):
                self.assertFalse(r1_session.names_the_roleplay(text, self.LEADS))
        self.assertTrue(
            r1_session.no_questions_about_the_roleplay("No questions about the role play.")
        )

    # Review of S6: paraphrased transition questions about the JOB that use the words "lead",
    # "learner", "prospect" or "scenario", and scenario questions that name none of the brief.
    JOB_QUESTIONS = (
        "How does the lead generation work for this role?",
        "Will the lead quality be good?",
        "What is the learner profile we usually sell to?",
        "What is the prospect of growth in this role?",
        "In what scenario would I have to work weekends?",
        "Who handles the learner support after a sale?",
        "Is the lead allocation done by the team lead?",
        "What course will I be trained on?",
        "Will I have to make cold calls in this job?",
        "Do I have to do a cold call every day?",
        "Who will I report to?",
    )
    SCENARIO_QUESTIONS = (
        "Who will I be calling?",
        "Which course is it about?",
        "What course am I selling?",
        "Do I call her or does she call me?",
        "Okay. Is it a cold call?",
        "Who is the lead?",
        "What's the lead's background?",
        "Is the learner a working professional?",
        "What is the scenario?",
    )

    def test_job_questions_are_not_about_the_role_play(self) -> None:
        for text in self.JOB_QUESTIONS:
            with self.subTest(text=text):
                self.assertFalse(r1_session.names_the_roleplay(text, self.LEADS))
        for text in self.SCENARIO_QUESTIONS:
            with self.subTest(text=text):
                self.assertTrue(r1_session.names_the_roleplay(text, self.LEADS))
        for text in ("I'll be calling her.", "It is a cold call."):
            with self.subTest(text=text):
                self.assertFalse(r1_session.names_the_roleplay(text, self.LEADS))

    def test_a_generic_ask_about_the_job_is_no_brief_request(self) -> None:
        # Review of S6: "can you explain / clarify ..." and "what do I need to do ..." name what
        # they ask about; a job topic, or "that" right after Christy's answer, is not the brief.
        for text in (
            "Could you explain the incentive structure?",
            "Can you clarify the working hours?",
            "Please explain the salary part.",
            "What do I need to do on the first day of the job?",
            "Can you explain the role?",
        ):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_brief_request(text, wide=True))
                for after_answer in (False, True):
                    self.assertTrue(r1_session.asks_about_the_job(
                        text, after_answer=after_answer, lead_names=self.LEADS
                    ))
        for text in ("Can you explain that briefly?", "Can you repeat that?", "Can you explain?"):
            with self.subTest(text=text):
                self.assertTrue(r1_session.asks_about_the_job(text, after_answer=True))
                self.assertFalse(r1_session.asks_about_the_job(text, after_answer=False))
        for text in (
            "Can you explain the role play?",
            "Could you explain the scenario again?",
            "Can you explain that again?",
            "What do I need to do?",
            "What do I say when she picks up?",
            "Can you explain how I should start the call?",
            "Who is the learner?",
            "Can you explain what I have to do?",
            "Can you tell me about Meera?",
            "Could you explain how the incentives work in this role play?",
            "",
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.asks_about_the_job(
                    text, after_answer=True, lead_names=self.LEADS
                ))

    async def test_job_questions_reach_the_model_and_never_use_the_brief_budget(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        self.interview._last_transition_line = "reply"  # Christy just answered about the shifts
        self.agent_state("listening")
        asks = self.JOB_QUESTIONS + (
            "Could you explain the incentive structure?",
            "Can you clarify the working hours?",
            "Can you explain that briefly?",  # SWEEP-29's negative, at the route
        )
        for replay_used in (False, True):
            self.interview._brief_repeated = replay_used
            for text in asks:
                with self.subTest(text=text, replay_used=replay_used):
                    self.assertEqual(
                        self.interview._transition_action(text), r1_session._TRANSITION_ANSWER
                    )
        self.interview._brief_repeated = False
        for text in self.SCENARIO_QUESTIONS:
            with self.subTest(text=text):
                # D4-TRANS-Q1 (R1_TRANSITION_ANSWERS): a field question gets its own answer.
                expected = (
                    r1_session._TRANSITION_FIELD
                    if r1_session.roleplay_fields(text)
                    else r1_session._TRANSITION_BRIEF
                )
                self.assertEqual(self.interview._transition_action(text), expected)
                with mock.patch.dict(os.environ, {"R1_TRANSITION_ANSWERS": "0"}):
                    self.assertEqual(
                        self.interview._transition_action(text), r1_session._TRANSITION_BRIEF
                    )
        # Right after the brief, "Can you explain that briefly?" asks for the short recap.
        self.interview._last_transition_line = "L-TRANSITION"
        self.assertEqual(
            self.interview._transition_action("Can you explain that briefly?"),
            r1_session._TRANSITION_RECAP,
        )

    async def test_a_bare_yes_or_no_to_her_own_question_is_answered(self) -> None:
        # Review of S6: her answer ended with a question, so its start question was dropped; a
        # bare "Yes." is answered by the model, never 20 s of dead air.  It is no consent.
        self.interview._enter(R1Phase.TRANSITION)
        guard = StreamGuard(self.interview.engine.guard_context("transition", mode="reply"))
        self.assertFalse(await self.answer("What are the shifts like?"))
        reply = self.interview._last_reply
        asked = "They run at night. Do you mean the weekly hours?"
        chunks = [
            chunk async for chunk in self.interview._screened(
                lambda: self_stream(asked), guard, reply
            )
        ]
        self.assertEqual("".join(chunks).strip(), asked)  # no start question after hers
        self.assertIsNone(self.interview._start_question)
        self.interview._last_transition_line = "reply"  # her answer finished playing
        self.agent_state("listening")
        for text in ("Yes.", "Yeah, okay.", "No.", "Not really."):
            with self.subTest(text=text):
                self.assertEqual(
                    self.interview._transition_action(text), r1_session._TRANSITION_ANSWER
                )
        self.assertEqual(self.interview._transition_action("Hmm."), r1_session._TRANSITION_QUIET)
        self.assertFalse(await self.answer("Yes."))  # the model replies
        self.assertIs(self.interview.machine.phase, R1Phase.TRANSITION)
        self.assertFalse(self.interview._transition_consented)
        self.assertFalse(self.interview._ready_latched)
        # Past the answer limit the yes/no start question is asked instead.
        self.interview._start_question = None
        self.interview._transition_answers = r1_session.TRANSITION_QUESTION_LIMIT
        self.assertEqual(
            self.interview._transition_action("Yes."), r1_session._TRANSITION_REASK_YES_NO
        )

    async def test_the_button_while_the_brief_is_on_its_way_or_her_answer_plays(self) -> None:
        # Review of S6: "Yes, I'm here." and the bridge's compose come before the brief, and her
        # answer ends with a question too: a press then gets "Great, here she is." first.
        self.interview._bridging = True
        self.assertEqual(self.interview._press_label(), "brief")
        self.interview._bridging = False
        self.assertEqual(self.interview._press_label(), "wait")
        task = await self.start_transition()
        self.assertFalse(await self.answer("What are the working days?"))
        handle = FakeSpeechHandle("reply")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=True),
        )
        self.session.current_speech = handle
        self.press()
        self.session.current_speech = None
        handle.finish()
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken[-2:], [
            self.spoken_line("L-PICKUP-BRIDGE"), self.spoken_line("L-PICKUP")
        ])
        self.assertEqual(self.transition_facts()["pressed_during"], "answer")

    def test_real_advisor_turns_are_none_of_the_new_requests(self) -> None:
        # The 2,136-turn advisor corpus and its held-out set: no wider brief request, no shorter
        # brief request (even right after a brief), no presence check among them.
        from r1_personas import PERSONAS, resolve_persona

        leads: list[str] = []
        for persona in PERSONAS:
            for variant in persona.variants:
                rendered = resolve_persona(persona.id, variant=variant.id)
                leads += [rendered.lead_name, rendered.first_name]
        leads_t = tuple(leads)
        fixtures = Path(__file__).resolve().parent / "fixtures"
        hits: list[str] = []
        for name in ("r1_advisor_corpus.jsonl", "r1_advisor_heldout.jsonl"):
            for raw in (fixtures / name).read_text(encoding="utf-8").splitlines():
                if not raw:
                    continue
                text = json.loads(raw)["text"]
                if (
                    r1_session.is_brief_request(text, wide=True, lead_names=leads_t)
                    or r1_session.is_short_brief_request(text, after_brief=True, lead_names=leads_t)
                    or r1_session.is_presence_check(text)
                ):
                    hits.append(text[:60])
        self.assertEqual(hits, [])

    def test_the_new_detectors_are_linear_on_long_input(self) -> None:
        # ReDoS fuzz: long runs of the words the patterns repeat must stay fast.
        import time as _time

        for text in (
            "say " + "like " * 4000 + "x",
            "tell me " + "a bit more " * 3000,
            "summary " * 5000 + "of my day",
            "hello " * 5000 + "are you there what",
            "in " + "about " * 5000 + "four",
            "can you explain " * 3000 + "that",
            "can you explain that " * 3000,
            "who will i be " * 3000 + "calling",
            "which course " * 3000 + "is it about",
            "the lead " * 4000,
        ):
            started = _time.perf_counter()
            r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS)
            r1_session.is_short_brief_request(text, after_brief=True, lead_names=self.LEADS)
            r1_session.is_presence_check(text)
            r1_session.names_the_roleplay(text, self.LEADS)
            r1_session.asks_about_the_job(text, after_answer=True, lead_names=self.LEADS)
            self.assertLess(_time.perf_counter() - started, 1.0)

    async def test_a_request_during_the_briefing_gets_the_again_brief_once(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.final_transcript("Sorry, I missed that. Could you explain the scenario again?")
        self.assertTrue(self.interview._brief_requested)  # over L-TRANSITION
        task = asyncio.create_task(self.interview._run_transition())
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-AGAIN-PLAIN"))
        await self.settle()
        self.assertFalse(task.done())
        again = self.spoken_line("L-TRANSITION-AGAIN-PLAIN")
        # D3-BRIEF1: re-explained, not "Of course, here it is again." and the brief verbatim.
        self.assertTrue(again.startswith("Sure. Think of it as a real sales call. I'll play "))
        self.assertNotIn("Thank you", again)
        self.assertNotIn(self.spoken_line("L-TRANSITION"), self.session.spoken)
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [again, self.spoken_line("L-PICKUP")])

    @mock.patch.dict(os.environ, {"R1_BRIEF_VARIETY": "0"})
    async def test_after_the_replay_requests_get_two_recaps_then_the_start_question(self) -> None:
        # SWEEP-29 budgets: one replay, then the recap twice, then L-TRANSITION-REASK; the nudge
        # never answers a request for the brief.  With R1_BRIEF_VARIETY off (D3-BRIEF1 changes the
        # recaps and the replay; TestBriefVariety).
        task = await self.start_transition()
        self.final_transcript("Can you repeat that?")
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-AGAIN"))
        await self.settle()
        for expected in (1, 2):
            self.assertTrue(await self.answer("Sorry, could you explain the scenario again?"))
            await self.until(lambda: self.count("L-TRANSITION-RECAP") == expected)
            await self.until(lambda: self.spoken_and_played("L-TRANSITION-RECAP"))
            await self.settle()
        self.assertTrue(await self.answer("Can you go over the task once more?"))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-REASK"))
        await self.settle()
        self.assertEqual(self.count("L-TRANSITION-AGAIN"), 1)
        self.assertEqual(self.count("L-TRANSITION-RECAP"), 2)
        self.assertEqual(self.count("L-TRANSITION-NUDGE"), 0)
        self.assertEqual(self.interview._transition_answers, 0)
        self.final_transcript("Okay, ready.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.interview._repair_facts()["transition_recaps"], 2)

    @mock.patch.dict(os.environ, {"R1_BRIEF_VARIETY": "0"})
    async def test_a_request_for_a_shorter_brief_gets_the_recap_and_a_later_repeat_the_replay(
        self,
    ) -> None:
        # With R1_BRIEF_VARIETY off; on, a repeat after the recap gets the second recap (D3-BRIEF1,
        # TestBriefVariety).
        task = await self.start_transition()
        self.interview._last_transition_line = "L-TRANSITION"  # the brief was the last line
        self.assertTrue(await self.answer("Can you explain it again briefly?"))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-RECAP"))
        await self.settle()
        self.assertEqual(self.count("L-TRANSITION-AGAIN"), 0)
        self.assertTrue(await self.answer("Sorry, can you repeat that?"))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-AGAIN"))
        await self.settle()
        self.assertEqual(self.count("L-TRANSITION-AGAIN"), 1)
        self.assertEqual(self.count("L-TRANSITION-RECAP"), 1)
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_four_lines_with_fillers_gets_the_recap(self) -> None:
        # 8f5bfefc #25 (paraphrased): the instruction "in about four lines".
        task = await self.start_transition()
        self.assertTrue(
            await self.answer("Um, can you say this instruction in, like, about four lines?")
        )
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-RECAP"))
        await self.settle()
        self.assertEqual(self.count("L-TRANSITION-NUDGE"), 0)
        self.assertEqual(self.count("L-TRANSITION-AGAIN"), 0)
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_ready_said_during_the_recap_picks_up_right_after_it(self) -> None:
        self.session.playout_seconds = 0.2
        task = await self.start_transition()
        self.interview._last_transition_line = "L-TRANSITION"
        self.assertTrue(await self.answer("Just give me a quick summary of the role play."))
        recap = self.spoken_line("L-TRANSITION-RECAP")
        await self.until(lambda: ("play_start", recap) in self.order)
        self.final_transcript("Okay, ready.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [recap, self.spoken_line("L-PICKUP")])

    async def test_a_role_play_question_never_reaches_the_model(self) -> None:
        # fda9e9f6 #26 (paraphrased): a question about the role-play got the job's shift timings.
        task = await self.start_transition()
        # D4-TRANS-Q1 (R1_TRANSITION_ANSWERS): the length and the notes get their own answers
        # (``TestDiagnosis4Transition`` in test_r1_integration); this is the brief route.
        self.assertTrue(await self.answer("What is this role play about again?"))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-AGAIN-PLAIN"))
        await self.settle()
        lead = self.interview.persona.first_name  # the learner's name is the role-play's too
        self.assertTrue(await self.answer(f"And what does {lead} do for a living?"))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-RECAP"))
        await self.settle()
        self.assertTrue(await self.answer("Is the learner the one who decides?"))
        # D3-BRIEF1: the second recap is worded differently (R1_BRIEF_VARIETY).
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-RECAP-2"))
        await self.settle()
        self.assertTrue(await self.answer("Is the role play recorded?"))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-NUDGE"))
        self.assertEqual(self.interview._transition_answers, 0)
        # A question about the job is still Christy's to answer.
        self.assertFalse(await self.answer("What are the working days?"))
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_no_questions_about_the_role_play_is_the_nudge(self) -> None:
        task = await self.start_transition()
        self.assertTrue(await self.answer("I don't have any questions about the role play."))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-NUDGE"))
        self.assertEqual(self.count("L-TRANSITION-AGAIN"), 0)
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_a_presence_check_gets_yes_im_here_and_the_start_question(self) -> None:
        # fda9e9f6 #28: "Are you there?" got 12 s of nothing.
        task = await self.start_transition()
        self.assertTrue(await self.answer("Hello? Are you there?"))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-REASK"))
        await self.settle()
        self.assertEqual(
            self.session.spoken,
            [self.spoken_line("L-PRESENT"), self.spoken_line("L-TRANSITION-REASK")],
        )
        self.assertEqual(self.spoken_line("L-PRESENT"), "Yes, I'm here.")
        self.assertEqual(self.interview._start_question, r1_session._YES_NO)
        self.assertEqual(self.interview._transition_answers, 0)
        self.final_transcript("Yes, let's start.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_with_the_repair_off_a_presence_check_gets_nothing(self) -> None:
        with mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": "0"}):
            self.interview._enter(R1Phase.TRANSITION)
            self.assertEqual(
                self.interview._transition_action("Hello? Are you there?"),
                r1_session._TRANSITION_QUIET,
            )
            self.assertEqual(
                self.interview._transition_action("Tell me about the role play again."),
                r1_session._TRANSITION_ANSWER,
            )

    async def test_the_same_request_through_the_transcript_and_the_hook_is_answered_once(
        self,
    ) -> None:
        # The RCA's latent double prompt: the latch replays, then the hook judged the same turn
        # again (the nudge on revision 21, a recap now).  The latched row gets nothing more.
        task = await self.start_transition()
        self.final_transcript("Can you repeat that?")
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-AGAIN-PLAIN"))
        await self.settle()
        self.assertTrue(await self.commit_turn("Can you repeat that?"))
        await asyncio.sleep(0.05)
        await self.settle()
        self.assertEqual(self.session.spoken, [self.spoken_line("L-TRANSITION-AGAIN-PLAIN")])
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_the_button_during_the_replay_gets_the_bridge_before_the_pickup(self) -> None:
        self.session.playout_seconds = 0.2
        self.interview._enter(R1Phase.TRANSITION)
        self.final_transcript("What do I do?")
        task = asyncio.create_task(self.interview._run_transition())
        again = self.spoken_line("L-TRANSITION-AGAIN-PLAIN")
        await self.until(lambda: ("play_start", again) in self.order)
        self.press()
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [
            again, self.spoken_line("L-PICKUP-BRIDGE"), self.spoken_line("L-PICKUP")
        ])
        # D4-TRANS-PRESENT1 (R1_BRIEF_VARIETY): the press is acknowledged by name.
        lead = self.interview.persona.first_name
        self.assertEqual(self.spoken_line("L-PICKUP-BRIDGE"), f"Got it, you're ready. Here's {lead}.")
        self.assertEqual(
            self.transition_facts(),
            {"start_by": "button", "pressed_during": "replay", "transition_recaps": 0},
        )

    async def test_the_button_during_the_first_brief_gets_the_bridge(self) -> None:
        self.session.playout_seconds = 0.2
        self.interview._enter(R1Phase.TRANSITION)
        brief = asyncio.create_task(self.interview._say_brief())
        await self.until(lambda: ("play_start", self.spoken_line("L-TRANSITION")) in self.order)
        self.press()
        await brief
        self.assertIsNone(await asyncio.wait_for(self.interview._run_transition(), 10.0))
        self.assertEqual(self.session.spoken[-2:], [
            self.spoken_line("L-PICKUP-BRIDGE"), self.spoken_line("L-PICKUP")
        ])
        self.assertEqual(self.interview._pressed_during, "brief")

    async def test_the_button_in_the_wait_and_a_spoken_ready_get_no_bridge(self) -> None:
        task = await self.start_transition()
        self.press()
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])
        self.assertEqual(
            self.transition_facts(),
            {"start_by": "button", "pressed_during": "wait", "transition_recaps": 0},
        )

    async def test_a_spoken_ready_is_recorded_as_spoken(self) -> None:
        task = await self.start_transition()
        self.final_transcript("Ready.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])
        lead = self.interview.persona.first_name
        self.assertEqual(self.spoken_line("L-PICKUP"), f"Hello, {lead} speaking.")
        self.assertEqual(
            self.transition_facts(), {"start_by": "spoken", "transition_recaps": 0}
        )

    async def test_with_the_repair_off_the_button_during_the_replay_gets_no_bridge(self) -> None:
        with mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": "0"}):
            self.session.playout_seconds = 0.2
            self.interview._enter(R1Phase.TRANSITION)
            self.final_transcript("What do I do?")
            task = asyncio.create_task(self.interview._run_transition())
            brief = self.spoken_line("L-TRANSITION")
            await self.until(lambda: ("play_start", brief) in self.order)
            self.press()
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
            self.assertEqual(self.session.spoken, [brief, self.spoken_line("L-PICKUP")])
            self.assertTrue(self.spoken_line("L-PICKUP").startswith("Hello? Yes, this is "))
            self.assertEqual(self.transition_facts(), {})

    async def test_answers_rotate_the_start_question_and_a_bare_yes_still_gets_the_nudge(
        self,
    ) -> None:
        # SWEEP-32: after the brief's either/or question, two answers in a row end with two
        # different shorter either/or questions; a bare "Yes." after each is no consent.
        task = await self.start_transition()
        self.interview._start_question = r1_session._EITHER_OR  # the brief has been heard
        self.interview._last_transition_line = "L-TRANSITION"
        tails = []
        for question in ("What are the working days?", "Is it a night shift?"):
            self.assertFalse(await self.answer(question))
            tails.append(self.interview._last_reply.tail)
            self.agent_state("listening")
            self.assertEqual(
                self.interview._transition_action("Yes."), r1_session._TRANSITION_NUDGE
            )
        self.assertEqual(
            tails,
            [self.spoken_line("L-TRANSITION-ASK-2"), self.spoken_line("L-TRANSITION-ASK-3")],
        )
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_an_answer_that_asks_drops_the_tail_but_never_twice_in_a_row(self) -> None:
        # S6 item 7 (fda9e9f6 #25: two questions in one breath).
        self.interview._enter(R1Phase.TRANSITION)
        guard = StreamGuard(self.interview.engine.guard_context("transition", mode="reply"))

        async def spoken(answer: str) -> str:
            reply = self.interview._last_reply
            chunks = [
                chunk async for chunk in self.interview._screened(
                    lambda: self_stream(answer), guard, reply
                )
            ]
            return "".join(chunks).strip()

        self.assertFalse(await self.answer("Can I ask about the shifts and the team?"))
        self.assertEqual(self.interview._transition_answers, 1)
        text = await spoken("Of course, which one first?")
        self.assertEqual(text, "Of course, which one first?")
        self.assertEqual(self.interview._transition_answers, 0)
        self.assertIsNone(self.interview._start_question)
        self.assertFalse(await self.answer("What are the working days, and the shift?"))
        text = await spoken("It's five and a half days a week. Does that help?")
        self.assertTrue(text.endswith(self.interview._last_reply.tail))  # not twice in a row
        self.assertEqual(self.interview._transition_answers, 1)
        self.assertFalse(await self.answer("Is it a night shift?"))
        text = await spoken("Yes, it runs overnight India time.")
        # M032 christy-ready (R1_START_ASK_ONCE): the start question was heard after the second
        # answer, so the third ends without one (a quiet pause gets L-TRANSITION-ASK-PAUSE).
        self.assertEqual(text, "Yes, it runs overnight India time.")

    async def test_with_the_repair_off_the_tail_is_always_today_s(self) -> None:
        with mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": "0"}):
            self.interview._enter(R1Phase.TRANSITION)
            self.interview._start_question = r1_session._EITHER_OR
            guard = StreamGuard(self.interview.engine.guard_context("transition", mode="reply"))
            self.assertFalse(await self.answer("What are the working days?"))
            reply = self.interview._last_reply
            self.assertEqual(reply.tail, self.spoken_line("L-TRANSITION-ASK"))
            self.assertFalse(reply.tail_optional)
            chunks = [
                chunk async for chunk in self.interview._screened(
                    lambda: self_stream("Which part would you like first?"), guard, reply
                )
            ]
            self.assertTrue("".join(chunks).strip().endswith(self.spoken_line("L-TRANSITION-ASK")))
            self.assertEqual(self.interview._transition_answers, 1)

    async def test_the_owners_transition_through_the_real_driver(self) -> None:
        # 1eb18cd4 #14 asked for the role-play "in a small brief kind of thing": a request for a
        # SHORTER brief, so it gets the recap (SWEEP-29), and the replay stays for a later ask.
        self.assertTrue(r1_session.is_short_brief_request(TestBriefRepeatOnRequest.OWNER_14))
        run = await self.start_interview()
        run.clock.advance(271)
        run.interview._wake()
        await self.until(lambda: run.interview.machine.phase is R1Phase.TRANSITION)
        run.session.emit("user_input_transcribed", final_event(TestBriefRepeatOnRequest.OWNER_14))
        recap = run.interview.render_line("L-TRANSITION-RECAP")
        await self.until(lambda: ("play_end", recap) in self.order)
        await self.settle()
        brief = run.interview.render_line(run.interview._thanked_brief_id())
        self.assertEqual(run.session.spoken.count(brief), 1)
        self.assertNotIn(run.interview.render_line("L-TRANSITION-AGAIN"), run.session.spoken)
        self.assertNotIn("We'll now move", brief)
        run.session.emit("user_input_transcribed", final_event("ready"))
        await self.until(lambda: run.interview.machine.phase is R1Phase.ROLEPLAY)
        self.assertEqual(run.session.spoken.count(self.spoken_line("L-PICKUP")), 1)
        await self.drain_cancel(run)


class TestTransitionSimulationFixes(R1TestCase):
    """M032 live simulation, diagnosis 1 (Christy lane, ``R1_TRANSITION_REPAIR`` on).

    BR-1: a request for the brief that names it but asks with "go over ... again" or "get a handle
    on" (no question mark) reached the model and got "Of course, go ahead." or "What would you like
    to know?".  BR-2: a request to hear an icebreaker question again got "Of course, go ahead.".
    CR-1: the brief, the replay and the recap all ended with the same start question.  DA-1: a
    stray backchannel after the recap's either/or question restarted the 20 s silence window.
    Every text here is synthetic.
    """

    LEADS = ("Meera Iyer", "Meera")

    async def start_transition(self) -> asyncio.Task:
        self.interview._enter(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        return task

    def count(self, line_id: str) -> int:
        return self.session.spoken.count(self.spoken_line(line_id))

    # --- BR-1 -------------------------------------------------------------------------------

    # Paraphrased by shape: the brief named, asked for with a verb the detectors missed.
    BRIEF_ASKS = (
        "Okay, just go over the role play again for me.",
        "Could you run me through the scenario once more?",
        "Please walk me through the scenario again.",
        "Yeah, so I'm clear on this round, the role play brief, I want to get a handle on it.",
        "I'd like to understand the role play a bit better.",
        "I need to make sense of the scenario first.",
        "Just go through the role play one more time.",
    )

    def test_a_named_brief_asked_for_without_a_question_mark_is_a_brief_request(self) -> None:
        for text in self.BRIEF_ASKS:
            with self.subTest(text=text):
                routed = r1_session.is_brief_request(
                    text, wide=True, lead_names=self.LEADS
                ) or r1_session.names_the_roleplay(text, self.LEADS)
                self.assertTrue(routed)
                self.assertFalse(
                    r1_session.asks_about_the_job(text, after_answer=True, lead_names=self.LEADS)
                )
        # The "go over ... again" form is a brief request at the transcript too (said over a line).
        for text in self.BRIEF_ASKS[:3] + (self.BRIEF_ASKS[-1],):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS))
                self.assertFalse(r1_session.is_brief_request(text))  # revision 23 missed them

    def test_the_new_brief_asks_leave_the_job_and_a_start_alone(self) -> None:
        for text in (
            "I want to get a handle on the sales targets.",
            "I'd like to understand the incentive structure.",
            "Let's go through the role play.",
            "Okay, we can go over the role play now.",
            "I'll be clear on the call, don't worry.",
            "I went over my notes again.",
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS))
                self.assertFalse(r1_session.names_the_roleplay(text, self.LEADS))
        # A job topic asked "again" is still Christy's to answer.
        text = "Can you go over the shift timings again?"
        self.assertTrue(r1_session.asks_about_the_job(text, lead_names=self.LEADS))

    async def test_the_brief_asks_route_to_the_replay_then_the_recap(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        self.interview._last_transition_line = "L-TRANSITION"
        self.agent_state("listening")
        for replay_used, expected in (
            (False, r1_session._TRANSITION_BRIEF),
            (True, r1_session._TRANSITION_RECAP),
        ):
            self.interview._brief_repeated = replay_used
            for text in self.BRIEF_ASKS:
                with self.subTest(text=text, replay_used=replay_used):
                    self.assertEqual(self.interview._transition_action(text), expected)
        self.interview._brief_repeated = False
        self.assertEqual(
            self.interview._transition_action("Can you go over the shift timings again?"),
            r1_session._TRANSITION_ANSWER,
        )

    async def test_with_the_repair_off_the_new_brief_asks_are_answered_as_before(self) -> None:
        with mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": "0"}):
            self.interview._enter(R1Phase.TRANSITION)
            for text in (self.BRIEF_ASKS[0], self.BRIEF_ASKS[3]):
                with self.subTest(text=text):
                    self.assertEqual(
                        self.interview._transition_action(text), r1_session._TRANSITION_ANSWER
                    )

    def test_the_new_brief_asks_are_linear_on_long_input(self) -> None:
        import time as _time

        for text in (
            "go over " * 4000 + "the role play",
            "run me through " * 3000 + "x",
            "walk me through the brief " * 2000,
            "i want to understand " * 3000 + "the role play",
            "go back to the earlier question " * 2000,
            "the question before the last one " * 2000,
            # Review of diagnosis 1: the aimed go-over, the understand object, own questions.
            "okay just go over the role play " * 2000 + "again",
            "i want to understand meera " * 3000,
            "can you repeat your previous question about the " * 1500 + "salary",
            "my first question is what is the " * 2000,
        ):
            started = _time.perf_counter()
            r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS)
            r1_session.names_the_roleplay(text, self.LEADS)
            r1_session.is_icebreaker_question_request(text)
            self.assertLess(_time.perf_counter() - started, 1.0)

    # --- BR-2 -------------------------------------------------------------------------------

    QUESTION_ASKS = (
        "Hang on, can we go back to that earlier question? Just repeat it.",
        "Wait, could you go back to the icebreaker question and say it again?",
        "Actually, could you go back to the question before the last one and ask it again?",
        "Sorry, what was the question you asked me earlier?",
        "Can you repeat your previous question?",
    )

    def test_a_request_for_an_icebreaker_question_again(self) -> None:
        for text in self.QUESTION_ASKS:
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_icebreaker_question_request(text))
        for text in (
            "Can you repeat that?",
            "Can you repeat the brief?",
            "Can you repeat the question about the role play?",
            "Before we begin, can I ask a few questions?",
            "I have a question before we start.",
            "Do I ask the questions in the role play?",
            "What was the last thing you said?",
            "My earlier question was about the shifts.",
            "",
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_icebreaker_question_request(text))

    async def test_the_question_asks_get_the_question_again_not_the_model(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        self.agent_state("listening")
        for text in self.QUESTION_ASKS:
            with self.subTest(text=text):
                self.assertEqual(
                    self.interview._transition_action(text), r1_session._TRANSITION_IB_REPEAT
                )
                self.assertFalse(self.interview.reply_suppressed(text))
        # A permission to ask is still invited, and a brief request still gets the brief.
        self.assertEqual(
            self.interview._transition_action("Before we begin, can I ask a few questions?"),
            r1_session._TRANSITION_INVITE,
        )
        self.assertEqual(
            self.interview._transition_action("Can you repeat the brief?"),
            r1_session._TRANSITION_BRIEF,
        )
        with mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": "0"}):
            self.assertEqual(
                self.interview._transition_action(self.QUESTION_ASKS[0]),
                r1_session._TRANSITION_ANSWER,
            )

    async def test_the_question_repeat_picks_the_last_or_the_one_before(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._ib_questions = [
            "How do you usually prepare before a call?",
            "How do you keep track of your customers each day?",
        ]
        self.assertEqual(
            self.interview._transition_question_to_repeat(self.QUESTION_ASKS[0]),
            "How do you keep track of your customers each day?",
        )
        self.assertEqual(
            self.interview._transition_question_to_repeat(self.QUESTION_ASKS[2]),
            "How do you usually prepare before a call?",
        )
        self.interview._ib_questions = ["How do you usually prepare before a call?"]
        self.assertEqual(
            self.interview._transition_question_to_repeat(self.QUESTION_ASKS[2]),
            "How do you usually prepare before a call?",
        )
        self.interview._ib_questions = []
        self.assertTrue(self.interview._transition_question_to_repeat(self.QUESTION_ASKS[0]))

    async def test_a_question_ask_over_the_brief_is_never_latched_as_a_brief_request(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.final_transcript("Can you repeat your previous question?")
        await self.settle()
        self.assertFalse(self.interview._brief_requested)
        self.assertFalse(self.interview._recap_requested)

    def test_the_transition_note_never_answers_a_repeat_request_with_go_ahead(self) -> None:
        from r1_prompts import TRANSITION_REMINDER_REPAIRED

        lowered = TRANSITION_REMINDER_REPAIRED.lower()
        self.assertIn('say "of course, go ahead." and stop', lowered)
        self.assertIn("only ask whether they may ask something", lowered)
        self.assertIn('never answer "go ahead"', lowered)
        self.assertIn("repeat or explain it in one sentence", lowered)

    # --- Review of diagnosis 1 (BR-2): the candidate's own questions ------------------------

    # Answers to "do you have any questions first?" that name a "first", "other" or "previous"
    # question of the candidate's own: none asks to hear an icebreaker question again.
    OWN_QUESTIONS = (
        "My first question is, what is the training period?",
        "One other question: what is the shift timing?",
        "I have one other question, what is the dress code?",
        "First question, what is the work mode?",
        "Going back to the previous question, what's the salary?",
        "Okay, another question, how many leaves do we get?",
        "Can we go back to the first question? What is the work mode?",
        "My previous question was about the incentives, can you repeat the answer?",
        "I'll repeat my first question, what is the notice period?",
    )

    def test_a_candidate_question_is_never_an_icebreaker_repeat(self) -> None:
        for text in self.OWN_QUESTIONS:
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_icebreaker_question_request(text))
        # Her questions asked for again, in other words, still are.
        for text in (
            "Can you repeat the first question?",
            "Could you ask me that earlier question again?",
            "Remind me of your previous question.",
            "What was your earlier question again?",
            "Can you repeat the question you asked me earlier about my targets?",
            "Please repeat your opening question.",
        ):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_icebreaker_question_request(text))

    async def test_a_candidate_question_is_answered_not_given_her_question(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        self.interview._last_transition_line = "L-TRANSITION"
        self.agent_state("listening")
        for text in self.OWN_QUESTIONS[:5]:
            with self.subTest(text=text):
                self.assertEqual(
                    self.interview._transition_action(text), r1_session._TRANSITION_ANSWER
                )

    async def test_a_question_after_her_repeated_question_is_counted_as_one(self) -> None:
        # The repeat is open, but the next turn asks about the job: it is one of their questions.
        self.interview._enter(R1Phase.TRANSITION)
        self.agent_state("listening")
        self.interview._transition_ib_repeat_open = True
        self.assertFalse(
            self.interview._answers_her_repeated_question(
                "No, I meant what is the training period?"
            )
        )
        self.assertFalse(
            self.interview._answers_her_repeated_question("Sorry, what are the shift timings")
        )
        self.assertTrue(
            self.interview._answers_her_repeated_question(
                "I usually read the lead's notes and plan two questions before I dial."
            )
        )

    async def test_the_first_question_gets_her_first_question(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        questions = [
            "How do you usually prepare before a call?",
            "How do you keep track of your customers each day?",
            "What do you do when a customer goes quiet?",
        ]
        self.interview._ib_questions = list(questions)
        for text in ("Can you repeat the first question?", "Please repeat your opening question."):
            with self.subTest(text=text):
                self.assertEqual(self.interview._transition_question_to_repeat(text), questions[0])
        self.assertEqual(
            self.interview._transition_question_to_repeat("Can you repeat your previous question?"),
            questions[-1],
        )

    async def test_the_answer_to_her_repeated_question_gets_a_reaction_note(self) -> None:
        from r1_prompts import TRANSITION_IB_ANSWER_NOTE
        from r1_prompts import TRANSITION_REMINDER_ANSWERS as TRANSITION_REMINDER_REPAIRED

        self.interview._enter(R1Phase.TRANSITION)
        self.agent_state("listening")
        self.interview._ib_questions = ["How do you usually prepare before a call?"]
        reply = r1_session.Reply(phase="transition", candidate_text="x")
        self.interview._transition_ib_repeat_reply(reply, "Can you repeat your previous question?")
        self.assertTrue(self.interview._transition_ib_repeat_open)
        answer = "I read the lead's notes and plan my first two questions."
        self.assertEqual(self.interview._transition_action(answer), r1_session._TRANSITION_ANSWER)
        reply = r1_session.Reply(phase="transition", candidate_text=answer)
        self.interview._note_ib_answer(reply)
        self.assertTrue(reply.note.startswith(TRANSITION_REMINDER_REPAIRED))
        self.assertTrue(reply.note.endswith(TRANSITION_IB_ANSWER_NOTE))
        lowered = TRANSITION_IB_ANSWER_NOTE.lower()
        self.assertIn("answering your earlier question", lowered)
        self.assertIn("one short sentence", lowered)
        self.assertIn("ask nothing", lowered)

    # --- Review of diagnosis 1 (BR-1): a start or a plan is no brief request ----------------

    # Said by a candidate who is ready to start, or who describes their plan for the call.
    STARTS_AND_PLANS = (
        "Sure, I can go through the role play now.",
        "No questions, I'd like to go through the role play now.",
        "Fine, I'm happy to go through the role play.",
        "Yes, go through the role play.",
        "Alright, let me go through the role play then.",
        "I think I can go through the scenario now.",
        "In the role play, I will be clear about the fees.",
        "In the role play I would like to understand her needs first.",
        "I want to understand Meera's background before I pitch.",
        "I'll go through the scenario once more in my head.",
    )

    def test_a_start_or_a_plan_is_never_a_brief_request(self) -> None:
        for text in self.STARTS_AND_PLANS:
            with self.subTest(text=text):
                self.assertFalse(
                    r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS)
                )
                self.assertFalse(r1_session.names_the_roleplay(text, self.LEADS))
        # Asks aimed at Christy still are, with or without "again".
        for text in (
            "Can you walk me through the role play?",
            "Could you go through the scenario for me?",
            "Go over the role play again for me, please.",
            "Sorry, I missed some of that. Go through the scenario again.",
            "I want to understand the role play first.",
        ):
            with self.subTest(text=text):
                self.assertTrue(
                    r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS)
                    or r1_session.names_the_roleplay(text, self.LEADS)
                )

    async def test_a_start_or_a_plan_never_replays_the_brief(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        self.interview._last_transition_line = "L-TRANSITION"
        self.agent_state("listening")
        for text in self.STARTS_AND_PLANS:
            with self.subTest(text=text):
                self.assertNotIn(
                    self.interview._transition_action(text),
                    (r1_session._TRANSITION_BRIEF, r1_session._TRANSITION_RECAP),
                )

    # --- CR-1 -------------------------------------------------------------------------------

    def test_brief_replay_and_recap_never_say_one_sentence_three_times(self) -> None:
        import re as _re

        spoken = [
            self.spoken_line(line_id)
            for line_id in ("L-TRANSITION", "L-TRANSITION-AGAIN", "L-TRANSITION-RECAP")
        ]
        counts: dict[str, int] = {}
        for text in spoken:
            for sentence in _re.split(r"(?<=[.?!])\s+", text):
                if len(sentence.split()) >= 6:
                    counts[sentence] = counts.get(sentence, 0) + 1
        self.assertEqual([s for s, n in counts.items() if n >= 3], [])
        recap = self.spoken_line("L-TRANSITION-RECAP")
        self.assertTrue(recap.endswith("Would you like to begin now, or ask me something first?"))
        self.assertEqual(r1_session._START_QUESTION_OF_LINE["L-TRANSITION-RECAP"],
                         r1_session._EITHER_OR)

    # --- DA-1 -------------------------------------------------------------------------------

    async def _after_the_recap(self, text: str | None, *, env: dict | None = None) -> float | None:
        """The recap's either/or question has played; ``text`` (a stray backchannel) is said, or
        nothing.  Returns how long the reask took, or None when none came within 0.3 s."""
        with mock.patch.object(
            r1_session,
            "TRANSITION_SILENCE_LADDER",
            ((5.0, "L-TRANSITION-REASK"), (5.0, "L-TRANSITION-REASK-2")),
        ), mock.patch.object(
            r1_session, "TRANSITION_QUIET_TURN_REASK_SECONDS", 0.05
        ), mock.patch.dict(os.environ, env or {}):
            task = await self.start_transition()
            await self.interview.say("L-TRANSITION-RECAP")
            self.assertEqual(self.interview._start_question, r1_session._EITHER_OR)
            self.agent_state("listening")
            started = asyncio.get_running_loop().time()
            if text is not None:
                self.assertTrue(await self.answer(text))
            took = None
            while asyncio.get_running_loop().time() - started < 0.3:
                if self.count("L-TRANSITION-REASK"):
                    took = asyncio.get_running_loop().time() - started
                    break
                await asyncio.sleep(0.005)
            self.assertEqual(self.count("L-TRANSITION-REASK-2"), 0)
            self.final_transcript("ready")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
            return took

    async def test_so_bye_after_the_recap_gets_the_reask_soon(self) -> None:
        self.assertIsNotNone(await self._after_the_recap("So bye."))

    async def test_a_hmm_after_the_recap_gets_the_reask_soon(self) -> None:
        self.assertIsNotNone(await self._after_the_recap("Hmm."))

    async def test_pure_silence_after_the_recap_keeps_the_long_window(self) -> None:
        self.assertIsNone(await self._after_the_recap(None))

    async def test_with_the_repair_off_a_stray_backchannel_keeps_the_long_window(self) -> None:
        self.assertIsNone(
            await self._after_the_recap("So bye.", env={"R1_TRANSITION_REPAIR": "0"})
        )

    async def test_a_backchannel_over_christy_or_without_an_open_question_waits(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        self.agent_state("speaking")  # said over her line
        self.assertTrue(await self.commit_turn("So bye."))
        self.assertFalse(self.interview._quiet_reask_pending)
        self.agent_state("listening")
        self.interview._start_question = r1_session._YES_NO  # the reask was already said
        self.assertTrue(await self.commit_turn("So bye."))
        self.assertFalse(self.interview._quiet_reask_pending)
        self.interview._start_question = r1_session._EITHER_OR
        self.assertTrue(await self.commit_turn("So bye."))
        self.assertTrue(self.interview._quiet_reask_pending)

    # --- Diagnosis 2 (D2-BR1): "those instructions", "your instructions" ---------------------

    # manual-M03 (S 4:31): refused as a prompt-extraction attempt and answered with job facts.
    M03_SHORT = "Could you give me those instructions in, like, just 4 lines?"
    DETERMINER_ASKS = (
        "Can you repeat your instructions?",
        "Could you go over your instructions again?",
        "Go over those instructions once more for me.",
        "Can you give me a summary of these instructions?",
    )

    def test_those_instructions_in_four_lines_is_a_short_brief_request(self) -> None:
        for after_brief in (False, True):
            with self.subTest(after_brief=after_brief):
                self.assertTrue(
                    r1_session.is_short_brief_request(
                        self.M03_SHORT, after_brief=after_brief, lead_names=self.LEADS
                    )
                )
        for text in self.DETERMINER_ASKS:
            with self.subTest(text=text):
                self.assertTrue(
                    r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS)
                    or r1_session.is_short_brief_request(text, lead_names=self.LEADS)
                )
                self.assertFalse(r1_session.asks_about_the_job(text, lead_names=self.LEADS))

    def test_instructions_about_the_job_stay_a_job_question(self) -> None:
        for text in (
            "What are the instructions for the first day of the job?",
            "Could you give me a quick summary of those incentives?",
            "Those instructions were clear, thank you.",
            "In short, your instructions were clear.",
        ):
            with self.subTest(text=text):
                self.assertFalse(
                    r1_session.is_short_brief_request(text, after_brief=True, lead_names=self.LEADS)
                )
                self.assertFalse(
                    r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS)
                )

    async def test_those_instructions_get_the_recap_and_your_instructions_the_replay(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        self.interview._last_transition_line = "L-TRANSITION"
        self.agent_state("listening")
        self.assertEqual(
            self.interview._transition_action(self.M03_SHORT), r1_session._TRANSITION_RECAP
        )
        self.assertEqual(
            self.interview._transition_action("Can you repeat your instructions?"),
            r1_session._TRANSITION_BRIEF,
        )
        self.assertEqual(
            self.interview._transition_action(
                "What are the instructions for the first day of the job?"
            ),
            r1_session._TRANSITION_ANSWER,
        )
        with mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": "0"}):
            self.assertEqual(
                self.interview._transition_action(self.M03_SHORT), r1_session._TRANSITION_ANSWER
            )

    def test_the_transition_note_reads_instructions_as_the_brief(self) -> None:
        from r1_prompts import TRANSITION_REMINDER, TRANSITION_REMINDER_REPAIRED

        lowered = TRANSITION_REMINDER_REPAIRED.lower()
        self.assertIn("instructions, the brief or the scenario", lowered)
        self.assertIn("they mean the role-play brief", lowered)
        self.assertNotIn("instructions", TRANSITION_REMINDER.lower())  # the flag-off note

    # --- Diagnosis 2 (D2-IB1): "put it to me again", "no, I mean ..." -------------------------

    # manual-M06 (S 4:17 and S 4:32): the second was taken as the answer to her repeated question.
    M06_FIRST = "Can you jump back to the question before the last one and ask me it again?"
    M06_INSIST = (
        "No, I mean go back to that earlier one, the question before last, and put it to me again."
    )
    M06_QUESTIONS = [
        "And before that introduction, how did you usually find your customers?",
        "Which of those did you find people asked the most about?",
        "What did you enjoy most about the customer conversations themselves?",
    ]

    def test_put_it_to_me_again_is_a_request_for_her_question(self) -> None:
        for text in (
            self.M06_FIRST,
            self.M06_INSIST,
            "Could you pose that earlier question to me again?",
            "Go back to your previous question and ask me that again.",
            "Can you throw the question before last at me again? Put it to me again.",
        ):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_icebreaker_question_request(text))
        for text in self.OWN_QUESTIONS + (
            "Let me put it again, what is the salary?",
            "I'll put that to you again later.",
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_icebreaker_question_request(text))

    async def _m06_first_repeat(self, questions: list[str]) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        self.interview._last_transition_line = "L-TRANSITION"
        self.agent_state("listening")
        self.interview._ib_questions = list(questions)
        self.assertEqual(
            self.interview._transition_action(self.M06_FIRST), r1_session._TRANSITION_IB_REPEAT
        )
        reply = r1_session.Reply(phase="transition", candidate_text=self.M06_FIRST)
        self.interview._transition_ib_repeat_reply(reply, self.M06_FIRST)
        self.assertEqual(reply.scripted, f"Of course. {questions[-2]}")

    async def test_an_insisted_request_offers_the_one_before(self) -> None:
        await self._m06_first_repeat(self.M06_QUESTIONS)
        self.assertEqual(
            self.interview._transition_action(self.M06_INSIST), r1_session._TRANSITION_IB_REPEAT
        )
        self.assertFalse(self.interview._answers_her_repeated_question(self.M06_INSIST))
        reply = r1_session.Reply(phase="transition", candidate_text=self.M06_INSIST)
        self.interview._transition_ib_repeat_reply(reply, self.M06_INSIST)
        self.assertEqual(reply.scripted, f"Sure, the one before that: {self.M06_QUESTIONS[0]}")
        # TRANSITION_IB_REPEAT_LIMIT stays 2: a third ask is no scripted repeat.
        self.assertNotEqual(
            self.interview._transition_action(self.M06_INSIST), r1_session._TRANSITION_IB_REPEAT
        )

    async def test_an_insisted_request_with_no_older_question_names_it_again(self) -> None:
        await self._m06_first_repeat(self.M06_QUESTIONS[1:])
        reply = r1_session.Reply(phase="transition", candidate_text=self.M06_INSIST)
        self.interview._transition_ib_repeat_reply(reply, self.M06_INSIST)
        self.assertEqual(reply.scripted, f"That one was: {self.M06_QUESTIONS[1]}")

    async def test_the_other_one_after_a_repeat_is_her_other_question(self) -> None:
        await self._m06_first_repeat(self.M06_QUESTIONS)
        text = "No, not that one, the other one."
        self.assertEqual(self.interview._transition_action(text), r1_session._TRANSITION_IB_REPEAT)
        reply = r1_session.Reply(phase="transition", candidate_text=text)
        self.interview._transition_ib_repeat_reply(reply, text)
        self.assertEqual(reply.scripted, f"Of course. {self.M06_QUESTIONS[-1]}")

    async def test_a_plain_no_still_answers_her_repeated_question(self) -> None:
        await self._m06_first_repeat(self.M06_QUESTIONS)
        for text in (
            "No, not really, I never tracked that.",
            "I mean, mostly the fees and the placement support.",
        ):
            with self.subTest(text=text):
                self.assertTrue(self.interview._answers_her_repeated_question(text))
                self.assertEqual(
                    self.interview._transition_action(text), r1_session._TRANSITION_ANSWER
                )
        # Naming one of her questions, or turning the repeat down, is no answer.
        for text in (
            "No, I mean the question before last.",
            "That's not the one I meant.",
            "The earlier question, the one before that.",
        ):
            with self.subTest(text=text):
                self.assertFalse(self.interview._answers_her_repeated_question(text))

    async def test_an_own_question_after_a_repeat_is_still_theirs(self) -> None:
        await self._m06_first_repeat(self.M06_QUESTIONS)
        for text in (
            "No, I meant what is the training period?",
            "Going back to the previous question, what's the salary?",
            "No, I mean, what are the shift timings",
        ):
            with self.subTest(text=text):
                self.assertNotEqual(
                    self.interview._transition_action(text), r1_session._TRANSITION_IB_REPEAT
                )

    def test_the_new_repeat_forms_are_linear_on_long_input(self) -> None:
        import time as _time

        for text in (
            "go back to " * 4000 + "and ask it",
            "no i mean " * 4000 + "the question before last",
            "put it " * 4000 + "to me again",
            "could you give me those " * 3000 + "instructions in 4 lines",
        ):
            started = _time.perf_counter()
            r1_session.is_icebreaker_question_request(text)
            r1_session.is_icebreaker_question_insist(text)
            r1_session.is_short_brief_request(text, after_brief=True, lead_names=self.LEADS)
            r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS)
            self.assertLess(_time.perf_counter() - started, 1.0)

    # --- Review of diagnosis 2 (D2-IB1-R1, D2-BR1-R1, D2-BR1-R2) ----------------------------

    # Answers, declines and start requests that open like an insist ("No, I mean ...", "Not that
    # one ...", "The other one ...") right after her repeated question: answers, never a repeat.
    INSIST_LIKE_ANSWERS = (
        "No, I mean, not really. I mostly helped at my dad's shop.",
        "Nope, I mean it was mostly word of mouth.",
        "Not that one specifically, but I enjoyed the follow ups.",
        "The other one was harder for me, the cold calls.",
        "No, I mean, I have no questions.",
        "No, I mean, can we just start?",
        "No I mean I'm ready.",
        "No, I mean honestly I never enjoyed them much, the fees talk was hard.",
        "That's not it really, I just liked talking to people.",
    )

    async def test_an_answer_opening_like_an_insist_is_no_repeat_request(self) -> None:
        await self._m06_first_repeat(self.M06_QUESTIONS)
        for text in self.INSIST_LIKE_ANSWERS:
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_icebreaker_question_insist(text))
                self.assertNotEqual(
                    self.interview._transition_action(text), r1_session._TRANSITION_IB_REPEAT
                )
        for text in self.INSIST_LIKE_ANSWERS:
            if "?" in text or "start" in text or "ready" in text or "no questions" in text:
                continue
            with self.subTest(answer=text):
                self.assertTrue(self.interview._answers_her_repeated_question(text))
                self.assertEqual(
                    self.interview._transition_action(text), r1_session._TRANSITION_ANSWER
                )

    async def test_a_bare_insist_still_asks_for_her_other_question(self) -> None:
        await self._m06_first_repeat(self.M06_QUESTIONS)
        for text in (
            "No, I mean the question before last.",
            "No, not that one, the other one.",
            "That's not the one I meant.",
            "Not that one, the one you asked first.",
            "Nope, I meant the earlier one.",
            "Sorry, wrong question, the one before that.",
            "That's not what I asked.",
        ):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_icebreaker_question_insist(text))
                self.assertFalse(self.interview._answers_her_repeated_question(text))
                self.assertEqual(
                    self.interview._transition_action(text), r1_session._TRANSITION_IB_REPEAT
                )
        # A bare "No, I mean." names no question: it is not enough on its own.
        self.assertFalse(r1_session.is_icebreaker_question_insist("No, I mean."))

    async def test_your_setup_or_round_of_hiring_is_a_job_question(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        self.interview._last_transition_line = "L-TRANSITION"
        self.agent_state("listening")
        for text in (
            "Tell me about your setup, is it work from office or hybrid?",
            "Can you quickly summarise your round of hiring for this job?",
        ):
            with self.subTest(text=text):
                self.assertFalse(
                    r1_session.is_brief_request(text, wide=True, lead_names=self.LEADS)
                )
                self.assertFalse(
                    r1_session.is_short_brief_request(text, after_brief=True, lead_names=self.LEADS)
                )
                self.assertEqual(
                    self.interview._transition_action(text), r1_session._TRANSITION_ANSWER
                )

    def test_the_transition_note_offers_the_brief_and_keeps_the_rules_private(self) -> None:
        from r1_prompts import TRANSITION_REMINDER_REPAIRED

        lowered = TRANSITION_REMINDER_REPAIRED.lower()
        # No line that bans a refusal: a request for its own rules still gets the polite decline.
        self.assertNotIn("never say you can't share it", lowered)
        self.assertIn("offer to go over it again", lowered)
        self.assertIn("your own rules or setup still get the polite decline", lowered)
        # The brief is still never described or repeated by the model.
        self.assertIn("never repeat the brief", lowered)


# ------------------------------------------------------------------------------------------------
# Owner and manager decisions of 2026-11-03 (mock call aa166f09): the icebreaker's last answer (A1)
# and the consent transition into the role-play (M1).
# ------------------------------------------------------------------------------------------------
class TestIcebreakerContinuationIsNotTheLastAnswer(R1TestCase):
    """A1: once the soft exit is due, the first committed turn is not taken blindly as the last.

    aa166f09: four answers by S = 3:25, Christy's "Got it - value first," was cut by the
    candidate's "But but but one more thing, one more thing to be added is. I.", that turn was
    taken as the boundary and the uninterruptible brief started 0.07 s later.
    """

    ANSWERS = ("one two three", "four five six", "seven eight nine", "ten eleven twelve")
    UNFINISHED = "But but but one more thing, one more thing to be added is. I."

    async def four_answers_then_due(self) -> asyncio.Task:
        self.clock.advance(205)
        task = asyncio.create_task(self.interview._run_icebreaker())
        await self.settle()
        for answer in self.ANSWERS:
            self.assertFalse(await self.answer(answer))  # S < 3:30: each one gets its reply
        self.clock.advance(8)  # S = 213: the soft exit is due from the next committed turn
        self.assertTrue(self.interview.machine.icebreaker_should_end())
        return task

    def cut_christys_reply(self, played: str = "Got it - value first,") -> None:
        handle = FakeSpeechHandle("the reply")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
        )
        self.session.current_speech = handle
        self.agent_state("speaking")
        message = FakeChatMessage(played, interrupted=True)
        self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        handle.chat_items.append(message)
        handle.interrupted = True
        handle.finish()
        self.session.current_speech = None
        self.agent_state("listening")

    async def test_the_owners_unfinished_turn_waits_for_the_rest_of_the_thought(self) -> None:
        task = await self.four_answers_then_due()
        self.cut_christys_reply()
        self.assertTrue(await self.answer(self.UNFINISHED))  # no reply over the rest of it...
        self.assertFalse(self.interview._icebreaker_boundary_turn)  # ...and not the boundary
        self.assertGreater(self.interview._icebreaker_budget_left(), 0)
        await self.settle()
        self.assertFalse(task.done())
        self.assertTrue(await self.answer("I mean value is what builds trust with a customer."))
        self.assertTrue(self.interview._icebreaker_boundary_turn)
        self.assertIsNone(await asyncio.wait_for(task, 5.0))  # now the brief may start

    async def test_a_quiet_after_the_unfinished_turn_ends_the_icebreaker_shortly(self) -> None:
        task = await self.four_answers_then_due()
        self.assertTrue(await self.answer("And the other reason was"))
        self.assertAlmostEqual(
            self.interview._icebreaker_budget_left(),
            r1_session.ICEBREAKER_CONTINUATION_WAIT_SECONDS,
        )
        await self.settle()
        self.assertFalse(task.done())
        self.clock.advance(r1_session.ICEBREAKER_CONTINUATION_WAIT_SECONDS + 0.1)
        self.interview._wake()
        self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertNotIn(self.spoken_line("L-SIL-IB"), self.session.spoken)

    async def test_a_complete_turn_that_cut_christy_off_is_answered_not_the_boundary(self) -> None:
        task = await self.four_answers_then_due()
        self.cut_christys_reply()
        # The candidate's own point goes on: Christy answers it, the turn after it is the last.
        self.assertFalse(await self.answer("And value also means following up after the sale."))
        self.assertFalse(self.interview._icebreaker_boundary_turn)
        self.assertFalse(task.done())
        self.assertTrue(await self.answer("That is how I would describe my approach."))
        self.assertTrue(self.interview._icebreaker_boundary_turn)
        self.assertIsNone(await asyncio.wait_for(task, 5.0))

    async def test_a_lone_yes_that_cut_christy_off_is_still_the_boundary(self) -> None:
        task = await self.four_answers_then_due()
        self.cut_christys_reply()
        self.assertTrue(await self.answer("Yes."))  # no point of their own: the brief may start
        self.assertTrue(self.interview._icebreaker_boundary_turn)
        self.assertIsNone(await asyncio.wait_for(task, 5.0))

    async def test_a_finished_answer_is_still_the_boundary_at_once(self) -> None:
        task = await self.four_answers_then_due()
        self.assertTrue(await self.answer("So that is what I would do."))
        self.assertTrue(self.interview._icebreaker_boundary_turn)
        self.assertIsNone(await asyncio.wait_for(task, 5.0))

    async def test_the_hard_cap_is_not_deferred(self) -> None:
        task = await self.four_answers_then_due()
        self.clock.advance(60)  # S = 4:33: the hard cap; only the bounded hold applies
        self.cut_christys_reply()
        self.assertTrue(await self.answer(self.UNFINISHED))
        self.assertTrue(self.interview._icebreaker_boundary_turn)
        self.assertIsNone(await asyncio.wait_for(task, 5.0))

    def test_unfinished_turns_are_read_from_the_folded_words(self) -> None:
        unfinished = (
            self.UNFINISHED,
            "And the other reason was",
            "I worked there for three years and",
            "One more thing.",
            "I would also like to add,",
        )
        finished = (
            "I stick on to the value addition.",
            "I think so.",
            "So that is what I would do.",
            "Can I ask what the shift timings are?",
            "One more thing: I also led a team of five and beat quota every quarter.",
        )
        for text in unfinished:
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_unfinished_turn(text))
        for text in finished:
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_unfinished_turn(text))


class TestTransitionConsent(R1TestCase):
    """M1 (owner decision 2026-11-03): the role-play starts only when the candidate agrees."""

    def test_consent_phrases(self) -> None:
        agrees = (
            "Ready.", "Yes, let's start.", "Okay, let's go.", "No questions, let's start.",
            "No, I'm good, let's go.", "No, I don't have any questions, let's begin.",
            # M1 review fix: ordinary consent to Christy's own question (rev_consent2).
            "Yeah, let's start the role play.", "Okay, let's start the role play.",
            "Yes, let's begin the role-play.", "Yes, we can start.", "We can begin.",
            "Let's get started.", "Start the role-play please.", "Yes, let us start.",
            "Go for it.", "Ready when you are.", "I think we can start now with the role play.",
        )
        does_not = (
            "No questions.", "Yes, I have a question.", "Not ready yet.", "Don't start yet.",
            "Can I ask a couple of questions before we start?", "Let me think.",
            # M1 review fix: a question with "ready" in it, and a short yes or backchannel alone
            # (``R1Interview._transition_consent`` decides those from what Christy asked last).
            "What do I need to have ready?", "Am I ready to talk about the price with her?",
            "I'll be ready in a second, what is the salary for this role?",
            "Okay.", "Yeah.", "Sure.", "Yes.", "Okay, thank you.", "Alright.", "Yeah, okay.",
            "Sure, go ahead.", "Okay, I'll start in a minute",
        )
        for text in agrees:
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_transition_consent(text))
        for text in does_not:
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_transition_consent(text))

    def test_asking_permission_is_told_apart_from_a_question(self) -> None:
        self.assertTrue(r1_session.is_permission_to_ask("Can I ask a couple of questions first?"))
        self.assertTrue(r1_session.is_permission_to_ask("I have a few questions."))
        self.assertFalse(r1_session.is_permission_to_ask("Can I ask what the shifts are?"))
        self.assertFalse(r1_session.is_permission_to_ask("What are the working days?"))

    def test_owner_style_consents_are_consents(self) -> None:
        # Repair (round 2): these never matched a start phrase, were answered as questions,
        # used up the three answers and got L-TRANSITION-STEER.
        for text in (
            "Let's do the role play.", "Okay, let's do the role play.",
            "Let's move to the role play.", "Haan, let's start.", "I'm good to go.",
            "Okay, I'm all set.", "Let's continue.", "Nope, let's begin.", "Let's get going.",
            "Let's move on.",
        ):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_transition_consent(text))
        for text in (
            "I want to do the role play later, what is the salary?", "Can I continue?",
            "I'm good.", "Nope.", "Let's move on to the salary.",
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_transition_consent(text))

    def test_a_permission_that_also_asks_the_question_is_a_question(self) -> None:
        # Repair (round 2, aa166f09 rows 19+20 merged): invited, not counted, and no start
        # question after Christy's answer, so dead air until the re-ask.
        self.interview._enter(R1Phase.TRANSITION)
        for text in (
            "Can can I ask a couple of other questions before we start this? I want to "
            "understand more about the role.",
            "I have a question, tell me about the shift timings.",
            "Can I ask a couple of questions, like the salary and the targets?",
            "Can I ask a question? I want to understand about Interview Kickstart and the "
            "senior program advisor role.",
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_permission_to_ask(text))
                self.assertEqual(
                    self.interview._transition_action(text), r1_session._TRANSITION_ANSWER
                )

    async def test_a_hand_back_after_the_either_or_question_picks_up(self) -> None:
        # Repair (round 2): main's is_ready picked these up at once; after L-TRANSITION's
        # "now, or do you have any questions first?" they went to the model as questions.
        for text in ("Go ahead.", "Sure, go ahead.", "Okay, go ahead.", "Yes, go ahead."):
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.interview._enter(R1Phase.TRANSITION)
                await self.interview.say("L-TRANSITION")
                task = asyncio.create_task(self.interview._run_transition())
                await self.settle()
                self.assertTrue(await self.answer(text))  # never the model's to answer
                self.assertIsNone(await asyncio.wait_for(task, 5.0))
                self.assertEqual(self.interview._transition_answers, 0)
                self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_owner_style_consents_pick_up_through_the_driver(self) -> None:
        for text in (
            "Okay, let's do the role play.", "Let's move to the role play.",
            "Haan, let's start.", "I'm good to go.",
        ):
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.interview._enter(R1Phase.TRANSITION)
                await self.interview.say("L-TRANSITION")
                task = asyncio.create_task(self.interview._run_transition())
                await self.settle()
                self.assertTrue(await self.answer(text))
                self.assertIsNone(await asyncio.wait_for(task, 5.0))
                self.assertEqual(self.interview._transition_answers, 0)
                self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_a_bare_no_to_any_questions_first_gets_the_nudge(self) -> None:
        # Repair (round 2): "No." / "Nope." / "No, thank you." are backchannel words and got
        # nothing at all: 20 s of dead air until L-TRANSITION-REASK.
        for text in ("No.", "Nope.", "No, thank you."):
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.interview._enter(R1Phase.TRANSITION)
                await self.interview.say("L-TRANSITION")
                task = asyncio.create_task(self.interview._run_transition())
                await self.settle()
                self.assertTrue(await self.answer(text))
                await self.until(lambda: self.spoken_and_played("L-TRANSITION-NUDGE"))
                self.assertFalse(task.done())
                self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    async def test_a_no_said_over_christy_is_still_nothing(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        await self.interview.say("L-TRANSITION")
        self.agent_state("speaking")
        self.assertEqual(self.interview._transition_action("No."), r1_session._TRANSITION_QUIET)

    async def test_the_transition_ceiling_pauses_while_the_candidate_is_away(self) -> None:
        # Repair (round 2): a rejoin after the wall-clock ceiling got L-REJOIN and then the
        # lost-connection close (L-SIL-END), and the interview ended as candidate_left.
        self.interview._enter(R1Phase.TRANSITION)
        with mock.patch.object(r1_session, "TRANSITION_MAX_SECONDS", 1.5), mock.patch.object(
            r1_session, "rejoin_grace_seconds", return_value=10.0
        ):
            task = asyncio.create_task(self.interview._run_transition())
            await self.settle()
            self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
            await self.until(
                lambda: self.interview.machine.phase is R1Phase.PAUSED_DISCONNECTED
            )
            await asyncio.sleep(2.0)  # away for longer than the whole ceiling
            self.ctx.room.emit("participant_connected", FakeParticipant("candidate"))
            await self.until(lambda: self.spoken_and_played("L-REJOIN"))
            await asyncio.sleep(0.2)
            self.assertFalse(task.done())
            self.assertNotIn(self.spoken_line("L-SIL-END"), self.session.spoken)
            self.final_transcript("Ready.")
            self.assertIsNone(await asyncio.wait_for(task, 5.0))
        self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_the_owners_transition_answers_the_questions_and_waits(self) -> None:
        # aa166f09 turns 17-20 through the real driver: two requests to ask, then a question.
        # Nothing picks up; Christy answers; the role-play starts on "Yes, let's start".
        run = await self.start_interview()
        await self.advance_to_transition(run)
        brief = self.spoken_line("L-TRANSITION")
        # D4-BRIEF2 (R1_BRIEF_WORDING_V2): one start prompt, no instruction before a question.
        self.assertTrue(brief.endswith(
            "Any questions before we start? If not, just say 'ready' and she'll pick up."
        ))
        agent = R1Agent(run.interview)
        for text in (
            "So can I ask couple of questions before we start the role play?",
            "Can can I ask a couple of other questions before we start this?",
            "I want to understand more about the role.",
        ):
            run.session.emit("user_input_transcribed", final_event(text))
            await self.settle()
            self.assertFalse(
                await self.commit_turn(text, agent=agent)
            )  # Christy's to answer
        run.clock.advance(120)
        await asyncio.sleep(0.1)
        self.assertIs(run.interview.machine.phase, R1Phase.TRANSITION)
        self.assertNotIn(self.spoken_line("L-PICKUP"), run.session.spoken)
        self.assertEqual(run.interview._transition_answers, 1)
        run.session.emit("user_input_transcribed", final_event("Yes, let's start."))
        await self.until(lambda: run.interview.machine.phase is R1Phase.ROLEPLAY)
        self.assertEqual(run.session.spoken.count(self.spoken_line("L-PICKUP")), 1)
        await self.drain_cancel(run)

    async def test_ordinary_spoken_consent_picks_up_and_uses_no_answer(self) -> None:
        # Review (rev_t3): these were answered as questions, used up the three answers and got
        # L-TRANSITION-STEER, and the role-play never started.
        for text in (
            "Yeah, let's start the role play.", "Yes, we can start.", "Okay, let's get started.",
            "Let's begin the role play.", "Go for it.", "Yes, let us start.",
        ):
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.interview._enter(R1Phase.TRANSITION)
                task = asyncio.create_task(self.interview._run_transition())
                await self.settle()
                self.assertTrue(await self.answer(text))  # never the model's to answer
                self.final_transcript(text)
                self.assertIsNone(await asyncio.wait_for(task, 5.0))
                self.assertEqual(self.interview._transition_answers, 0)
                self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_a_question_with_ready_in_it_never_picks_up(self) -> None:
        # Review (rev_t1): "What do I need to have ready?" started the role-play.
        for text in (
            "What do I need to have ready?", "Am I ready to talk about the price with her?",
        ):
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.interview._enter(R1Phase.TRANSITION)
                task = asyncio.create_task(self.interview._run_transition())
                await self.settle()
                self.final_transcript(text)
                await asyncio.sleep(0.2)
                self.assertFalse(await self.answer(text))  # Christy answers it
                await asyncio.sleep(0.2)
                self.assertFalse(task.done())
                self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)
                task.cancel()

    async def test_a_backchannel_while_christy_answers_never_picks_up(self) -> None:
        # Review (rv_contracts): "Okay." over Christy's interruptible answer started the role-play.
        for text in ("Okay.", "Yeah.", "Sure.", "Alright.", "Yes.", "Yeah, okay."):
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.interview._enter(R1Phase.TRANSITION)
                await self.interview.say("L-TRANSITION-REASK")  # even after a yes/no question
                task = asyncio.create_task(self.interview._run_transition())
                await self.settle()
                agent = R1Agent(self.interview)
                self.assertFalse(
                    await self.answer("What are the working hours for this role?", agent=agent)
                )
                self.agent_state("speaking")
                await self.settle()
                self.final_transcript(text)
                await asyncio.sleep(0.3)
                self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)
                self.assertTrue(await self.answer(text, agent=agent))  # no reply, no pickup
                self.agent_state("listening")
                await asyncio.sleep(0.3)
                self.assertFalse(task.done())
                self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)
                task.cancel()

    async def test_a_bare_yes_to_the_either_or_question_gets_the_nudge(self) -> None:
        # Review: "Shall we start now, or do you have any questions first?" - "Yes." says neither.
        # (The reworded brief asks "Any questions before we start?": there "Yes." is invited,
        # review of diagnosis 4; this pins the either/or brief, R1_BRIEF_WORDING_V2=0.)
        patcher = mock.patch.dict(os.environ, {"R1_BRIEF_WORDING_V2": "0"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.interview._enter(R1Phase.TRANSITION)
        await self.interview.say("L-TRANSITION")
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        self.final_transcript("Yes.")
        self.assertTrue(await self.answer("Yes."))
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-NUDGE"))
        await self.settle()
        self.assertFalse(task.done())
        self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)
        self.final_transcript("Ready.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_an_okay_during_the_replayed_brief_is_no_consent(self) -> None:
        # Review: ``_repeat_brief`` drained the queue with the consent test; "Okay." picked up.
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._brief_requested = True
        real_say = self.interview.say

        replay = self.interview._brief_line_id(replay=True)  # M032 S6: L-TRANSITION-AGAIN

        async def say_and_ack(line_id: str, **kwargs) -> None:
            await real_say(line_id, **kwargs)
            if line_id == replay:
                self.final_transcript("Okay.")  # said over the replay

        with mock.patch.object(self.interview, "say", side_effect=say_and_ack):
            task = asyncio.create_task(self.interview._run_transition())
            await self.until(lambda: self.spoken_and_played(replay))
            await asyncio.sleep(0.3)
            self.assertFalse(task.done())
            self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)
            self.final_transcript("Let's start.")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_the_pickup_waits_while_the_candidate_is_still_speaking(self) -> None:
        # The challenge to the aa166f09 RCA: nothing checked that the candidate had stopped
        # before the uninterruptible pickup.  A consent that goes on is not talked over.
        self.interview.machine.transition(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        self.user_state("speaking")
        self.final_transcript("Yes, let's start.")
        await asyncio.sleep(0.2)
        self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)
        self.user_state("listening")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])

    async def test_christys_transition_context_leaves_the_brief_out(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        await self.interview.say("L-TRANSITION")
        self.assertFalse(await self.answer("What are the working days?"))
        messages = select_context(self.interview._history, "transition")
        blob = " ".join(message["content"] for message in messages)
        self.assertNotIn(self.interview.persona.lead_name, blob)
        self.assertNotIn(self.spoken_line("L-TRANSITION"), blob)


# --------------------------------------------------------------- M032 S7C: the Christy follow-ups


@dataclass
class FakeMicPublication(FakePublication):
    """A microphone publication with the subscription state ``RemoteTrackPublication`` exposes."""

    subscribed: bool = False


def _s7c_env(**values: str):
    """Patch the S7C flags (and any other variable) for one block."""
    return mock.patch.dict(os.environ, values)


class TestTheNoAudioLadder(R1TestCase):
    """M032 S7C (SWEEP-34, ``R1_NO_AUDIO_LADDER``, pattern P25).  Four sessions on 2026-10-13 each
    had only the opening, then "Are you still with me?" and the lost-connection close: no candidate
    audio ever reached the worker.  A candidate who was never heard (no final, no speech) is told
    Christy cannot hear them; one heard even once keeps today's ladder.  Synthetic text only."""

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        for name, value in (
            ("ICEBREAKER_PROMPT_SECONDS", 0.05),
            ("ICEBREAKER_END_SECONDS", 0.05),
            ("NO_AUDIO_END_SECONDS", 0.05),
            ("MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0),
        ):
            patcher = mock.patch.object(r1_session, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def lines(self, *line_ids: str) -> list[str]:
        return [self.spoken_line(line_id) for line_id in line_ids]

    async def run_icebreaker(self) -> str | None:
        return await asyncio.wait_for(self.interview._run_icebreaker(), 10.0)

    async def test_a_candidate_never_heard_is_told_christy_cannot_hear_them(self) -> None:
        with self.capture_logs() as logs:
            self.assertEqual(await self.run_icebreaker(), "candidate_left")
        self.assertEqual(self.session.spoken, self.lines("L-SIL-NOAUDIO", "L-SIL-END-NOAUDIO"))
        self.assertTrue(self.interview._goodbye_spoken)  # no L-CLOSE after it
        (noted,) = [line_ for line_ in logs if line_.get("error_type") == "r1_no_audio"]
        self.assertEqual(noted["error_category"], "no_mic_track")
        self.assertNotIn("Asha", json.dumps(logs))

    async def test_an_answer_after_the_no_audio_line_keeps_the_icebreaker_going(self) -> None:
        with mock.patch.object(r1_session, "NO_AUDIO_END_SECONDS", 5.0):
            task = asyncio.create_task(self.interview._run_icebreaker())
            await self.until(lambda: self.spoken_and_played("L-SIL-NOAUDIO"))
            await self.settle()
            self.final_transcript("Sorry, my microphone was off.")
            await self.settle()
            self.assertFalse(task.done())
            self.assertNotIn(self.spoken_line("L-SIL-END-NOAUDIO"), self.session.spoken)
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def test_one_final_then_silence_is_todays_ladder(self) -> None:
        self.final_transcript("Hello")
        self.assertEqual(await self.run_icebreaker(), "candidate_left")
        self.assertEqual(self.session.spoken, self.lines("L-SIL-IB", "L-SIL-END"))

    async def test_speaking_then_listening_with_no_final_counts_as_heard(self) -> None:
        self.user_state("speaking")
        self.user_state("listening")
        self.assertEqual(await self.run_icebreaker(), "candidate_left")
        self.assertEqual(self.session.spoken, self.lines("L-SIL-IB", "L-SIL-END"))

    async def test_away_alone_is_not_heard(self) -> None:
        self.user_state("away")
        self.assertEqual(await self.run_icebreaker(), "candidate_left")
        self.assertEqual(self.session.spoken, self.lines("L-SIL-NOAUDIO", "L-SIL-END-NOAUDIO"))

    async def test_heard_is_never_reset_by_a_rejoin(self) -> None:
        self.user_state("speaking")
        self.user_state("listening")
        self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
        self.ctx.room.emit("participant_connected", FakeParticipant("candidate"))
        self.assertTrue(self.interview._candidate_ever_heard)

    async def test_a_muted_candidate_gets_only_the_mute_aside(self) -> None:
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        budget = TestPhaseDriver.shrinking(0.3)
        with mock.patch.object(
            self.interview.machine, "remaining_icebreaker_seconds", budget
        ), mock.patch.object(
            self.interview.machine, "icebreaker_should_end", lambda: budget() <= 0
        ):
            self.assertIsNone(await self.run_icebreaker())
        self.assertEqual(self.session.spoken, self.lines("L-MUTE-IV"))

    async def test_the_microphone_state_is_logged_as_a_label(self) -> None:
        cases = (
            ({}, "no_mic_track"),
            ({"TR_mic": FakeMicPublication(subscribed=False)}, "not_subscribed"),
            ({"TR_mic": FakeMicPublication(subscribed=True)}, "no_voice"),
            ({"TR_cam": FakeMicPublication(kind=VIDEO, source=CAMERA, subscribed=True)},
             "no_mic_track"),
        )
        for publications, expected in cases:
            with self.subTest(expected=expected):
                self.ctx.room.remote_participants["candidate"] = FakeParticipant(
                    "candidate", track_publications=publications
                )
                self.assertEqual(self.interview._no_audio_category(), expected)

    async def test_it_is_logged_once_per_session(self) -> None:
        with self.capture_logs() as logs:
            self.interview._note_no_audio()
            self.interview._note_no_audio()
        self.assertEqual(error_types(logs).count("r1_no_audio"), 1)

    async def test_the_transition_close_is_still_the_lost_connection_line(self) -> None:
        self.interview.machine.transition(R1Phase.TRANSITION)
        self.assertEqual(await self.interview._end_transition_unstarted(), "candidate_left")
        self.assertEqual(self.session.spoken, self.lines("L-SIL-END"))

    async def test_the_flag_off_is_todays_ladder(self) -> None:
        with _s7c_env(R1_NO_AUDIO_LADDER="0"), self.capture_logs() as logs:
            self.assertEqual(await self.run_icebreaker(), "candidate_left")
        self.assertEqual(self.session.spoken, self.lines("L-SIL-IB", "L-SIL-END"))
        self.assertNotIn("r1_no_audio", error_types(logs))

    async def test_the_new_lines_are_uninterruptible(self) -> None:
        for line_id in ("L-SIL-NOAUDIO", "L-SIL-END-NOAUDIO"):
            with self.subTest(line=line_id):
                await self.interview.say(line_id)
                self.assertFalse(self.session.handles[-1].allow_interruptions)


class TestTheMuteAsideV2(R1TestCase):
    """M032 S7C (SWEEP-36, ``R1_MUTE_ASIDE_V2``, pattern P62).  b419d478: "Please unmute when you're
    ready." came in Christy's own phase and was answered "I am ready"; a sub-second blip got the
    uninterruptible line after the candidate had unmuted.  The aside waits for a real mute (the
    debounce), never talks over a turn in flight (up to a cap), and fits the phase."""

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        for name, value in (
            ("MUTE_ASIDE_DEBOUNCE_SECONDS", 0.3),
            ("MUTE_ASIDE_TURN_WAIT_SECONDS", 0.6),
        ):
            patcher = mock.patch.object(r1_session, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def mute(self) -> None:
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())

    def unmute(self) -> None:
        self.ctx.room.emit("track_unmuted", FakeParticipant("candidate"), FakePublication())

    def mute_lines(self) -> list[str]:
        ids = ("L-MUTE", "L-MUTE-RP", "L-MUTE-IV")
        texts = {self.spoken_line(line_id) for line_id in ids}
        return [text for text in self.session.spoken if text in texts]

    async def waiting(self, timeout: float = 30.0) -> asyncio.Task:
        task = asyncio.create_task(self.interview._await_turn(timeout))
        self.addCleanup(task.cancel)
        await self.settle()
        return task

    async def test_a_blip_undone_within_the_debounce_gets_no_line(self) -> None:
        self.enter_roleplay()
        await self.waiting()
        self.mute()
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)  # R paused at the event
        await asyncio.sleep(0.1)
        self.unmute()
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)
        await asyncio.sleep(0.5)
        self.assertEqual(self.mute_lines(), [])
        self.assertFalse(self.interview._mute_announced)

    async def test_a_real_mute_gets_one_line_once_the_debounce_has_passed(self) -> None:
        self.enter_roleplay()
        await self.waiting()
        loop = asyncio.get_running_loop()
        muted_at = loop.time()
        self.mute()
        await self.settle()
        self.assertEqual(self.mute_lines(), [])  # not at the first wake-up
        await self.until(lambda: self.spoken_and_played("L-MUTE-RP"))
        self.assertGreaterEqual(loop.time() - muted_at, 0.25)
        await asyncio.sleep(0.4)
        self.assertEqual(self.mute_lines(), [self.spoken_line("L-MUTE-RP")])  # one per episode
        self.unmute()
        self.mute()
        await self.until(lambda: len(self.mute_lines()) == 2)  # a new episode, a new line

    async def test_a_mute_over_a_turn_in_flight_waits_for_it_to_end(self) -> None:
        await self.waiting()
        self.user_state("speaking")
        self.mute()
        await asyncio.sleep(0.45)  # past the debounce, the candidate still mid-turn
        self.assertEqual(self.mute_lines(), [])
        self.user_state("listening")
        await self.until(lambda: self.spoken_and_played("L-MUTE-IV"))

    async def test_a_final_waiting_for_its_commit_is_a_turn_in_flight(self) -> None:
        task = asyncio.create_task(self.interview._run_icebreaker())  # waits on through turns
        self.addCleanup(task.cancel)
        await self.settle()
        self.final_transcript("I was saying that")
        self.mute()
        await asyncio.sleep(0.45)
        self.assertEqual(self.mute_lines(), [])
        with contextlib.suppress(r1_session.StopResponse):
            await self.commit_turn("I was saying that")
        await self.until(lambda: self.spoken_and_played("L-MUTE-IV"))

    async def test_a_role_play_final_waiting_for_its_commit_is_a_turn_in_flight(self) -> None:
        # Review of S7C: the mute moves the role-play to ASIDE, which writes the open row, so the
        # aside started at the debounce and the SDK skipped the turn that ended under it (the
        # learner never heard the advisor's last turn).
        self.enter_roleplay()

        async def keep_waiting() -> None:
            while True:
                await self.interview._await_turn(30.0)

        task = asyncio.create_task(keep_waiting())
        self.addCleanup(task.cancel)
        await self.settle()
        self.final_transcript("So the course runs for six months")
        await self.settle()
        self.mute()
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)
        self.assertIsNone(self.interview._open_row)  # written by the move to ASIDE
        await asyncio.sleep(0.45)  # past the debounce, the turn not committed yet
        self.assertEqual(self.mute_lines(), [])
        with contextlib.suppress(r1_session.StopResponse):
            await self.commit_turn("So the course runs for six months")
        await self.until(lambda: self.spoken_and_played("L-MUTE-RP"))
        self.assertIsNone(self.interview._mute_turn_index)

    async def test_an_unmute_forgets_the_turn_in_flight(self) -> None:
        self.enter_roleplay()
        self.final_transcript("So the course runs for six months")
        await self.settle()
        self.mute()
        self.assertIsNotNone(self.interview._mute_turn_index)
        self.unmute()
        self.assertIsNone(self.interview._mute_turn_index)

    async def test_a_turn_that_never_ends_waits_no_longer_than_the_cap(self) -> None:
        await self.waiting()
        self.user_state("speaking")
        loop = asyncio.get_running_loop()
        muted_at = loop.time()
        self.mute()
        await self.until(lambda: self.spoken_and_played("L-MUTE-IV"))
        self.assertGreaterEqual(loop.time() - muted_at, 0.55)

    async def test_the_line_fits_the_phase(self) -> None:
        for phases, expected in (
            ((), "L-MUTE-IV"),  # the icebreaker
            ((R1Phase.TRANSITION,), "L-MUTE-IV"),
            ((R1Phase.TRANSITION, R1Phase.ROLEPLAY), "L-MUTE-RP"),
            (
                (R1Phase.TRANSITION, R1Phase.ROLEPLAY, R1Phase.ROLEPLAY_EXIT, R1Phase.WRAPUP),
                "L-MUTE-IV",
            ),
        ):
            with self.subTest(expected=expected, phases=phases):
                await self.asyncSetUp()  # a fresh interview (it patches the debounce again)
                for phase in phases:
                    self.interview.machine.transition(phase)
                with mock.patch.object(r1_session, "MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0):
                    self.mute()
                    await self.interview._handle_attention()
                self.assertEqual(self.mute_lines(), [self.spoken_line(expected)])

    async def test_the_opening_gets_the_interviewers_line(self) -> None:
        interview = R1Interview(
            self.ctx, dict(self.LINE_CONTEXT), self.session, self.writer, clock=self.clock
        )
        interview.wire_events()
        self.ctx.room.emit("participant_connected", FakeParticipant("candidate"))
        interview.machine.transition(R1Phase.OPENING)
        with mock.patch.object(r1_session, "MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0):
            self.mute()
            await interview._handle_attention()
        self.assertIn(self.spoken_line("L-MUTE-IV"), self.session.spoken)

    async def test_it_rechecks_the_mute_before_speaking(self) -> None:
        self.mute()
        self.interview._muted = False  # unmuted between the wake-up and the line
        await self.interview._handle_mute()
        self.assertEqual(self.mute_lines(), [])
        self.assertFalse(self.interview._mute_announced)

    async def test_nothing_is_announced_to_a_candidate_who_is_not_there(self) -> None:
        with mock.patch.object(r1_session, "MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0):
            self.mute()
            self.interview._candidate_present = False
            self.assertFalse(self.interview._needs_attention())
            await self.interview._handle_mute()
        self.assertEqual(self.mute_lines(), [])
        self.assertFalse(self.interview._mute_announced)

    async def test_an_unmute_echo_in_the_transition_never_starts_the_role_play(self) -> None:
        self.interview.machine.transition(R1Phase.TRANSITION)
        with mock.patch.object(r1_session, "MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0):
            task = asyncio.create_task(self.interview._run_transition())
            self.addCleanup(task.cancel)
            await self.settle()
            self.mute()
            await self.until(lambda: self.spoken_and_played("L-MUTE-IV"))
            self.assertNotIn("ready", self.spoken_line("L-MUTE-IV").lower())
            self.unmute()
            await self.settle()
            self.final_transcript("Okay, I have unmuted now.")
            await asyncio.sleep(0.2)
            self.assertFalse(task.done())
            self.assertNotIn(self.spoken_line("L-PICKUP"), self.session.spoken)
            self.final_transcript("Ready.")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_the_new_lines_are_uninterruptible(self) -> None:
        for line_id in ("L-MUTE-RP", "L-MUTE-IV"):
            with self.subTest(line=line_id):
                await self.interview.say(line_id)
                self.assertFalse(self.session.handles[-1].allow_interruptions)

    async def test_the_flag_off_is_todays_immediate_l_mute(self) -> None:
        with _s7c_env(R1_MUTE_ASIDE_V2="0"):
            self.enter_roleplay()
            self.user_state("speaking")
            self.mute()
            self.assertTrue(self.interview._needs_attention())
            await self.interview._handle_attention()
            self.assertEqual(self.mute_lines(), [self.spoken_line("L-MUTE")])
            self.assertTrue(self.interview._mute_announced)
            self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)


class TestTheSoundCheckReader(unittest.TestCase):
    """M032 S7C (SWEEP-35): how the reply to "Can you hear me okay?" is read.  Synthetic text."""

    CANT_HEAR = (
        "Sorry, I can't hear you.",
        "I cannot hear you properly.",
        "I couldn't hear anything.",
        "I can barely hear you.",
        "I'm not able to hear you clearly.",
        "No.",
        "No, not really.",
        "Not really.",
        "Not clearly.",
        "Nope.",
        "Barely.",
        "Hardly.",
        "It's a bit low.",
        "Yes, but it's a bit low.",
        "It is very faint.",
        "There's an echo.",
        "You're breaking up.",
        "Your voice is very low.",
        "You sound a bit muffled, Christy.",
        "Can you speak up a little?",
        "Sorry?",
        "Pardon?",
        "Could you repeat that?",
        "Hello? Are you there?",
        "Hello?",
        "Nahi.",
    )
    HEARD = (
        "Yes, I can hear you.",
        "Yes.",
        "Yeah, loud and clear.",
        "Hi Christy!",
        "Hello.",
        "Hi.",
        "Can you hear me?",
        "Yes I can, can you hear me?",
        "Okay.",
        "Yes, perfectly.",
        "Hi, yes, all good.",
        "Yes, I can hear you fine. Can you hear me?",
        "Haan.",
        "No problem.",
        "",
    )
    ANSWERS = (
        "Yes I can hear you. I have been working in inside sales for five years, selling software "
        "subscriptions to small business owners.",
        "Hi, yes. So I started my career in retail banking and then moved to an edtech company "
        "where I handled admissions calls.",
        # A long answer that mentions hearing is still an answer: the reading is directed.
        "Yes. In my last job our customers often could not hear the offer clearly on the phone, "
        "so I learned to follow up by email.",
    )

    def read(self, text: str) -> str:
        return r1_session.sound_check_reading(text)

    def test_a_cant_hear_reply(self) -> None:
        for text in self.CANT_HEAR:
            with self.subTest(text=text):
                self.assertEqual(self.read(text), r1_session.SOUND_CANT_HEAR)

    def test_a_reply_that_hears_us(self) -> None:
        for text in self.HEARD:
            with self.subTest(text=text):
                self.assertEqual(self.read(text), r1_session.SOUND_HEARD)

    def test_an_early_answer(self) -> None:
        for text in self.ANSWERS:
            with self.subTest(text=text):
                self.assertEqual(self.read(text), r1_session.SOUND_ANSWER)

    def test_a_long_reply_with_a_bare_no_inside_is_not_a_complaint(self) -> None:
        self.assertNotEqual(
            self.read("No, no, I can hear you, I was just getting my notes ready for this."),
            r1_session.SOUND_CANT_HEAR,
        )

    # Review of S7C: the complaints this candidate pool says most, Indian-English forms included.
    # Each read as heard before, so Christy said "Good, I can hear you." to someone who could not.
    CANT_HEAR_RECALL = (
        "I can't hear your voice.",
        "I can't hear your voice clearly.",
        "I cannot hear the audio.",
        "Not audible.",
        "Not audible, ma'am.",
        "Sorry, not audible.",
        "Not clear.",
        "It's not clear.",
        "Audio is not clear.",
        "Voice is not clear.",
        "Your voice is not clear.",
        "Not able to hear you.",
        "Not able to hear you properly.",
        "Unable to hear you.",
        "I not able to hear you.",
        "Your voice is breaking.",
        "Voice is breaking.",
        "Your voice is cutting.",
        "Your voice is little low.",
        "Little low.",
        "Low.",
        "Volume is low.",
        "Sound is very low.",
        "There is some disturbance.",
        "I can hear you but it is very low.",
        "I can hear you, but not clearly.",
        "Yes, but not clearly.",
        "Yes I can hear you but your voice is breaking.",
        "Can you increase the volume?",
        "Louder, please.",
        "What?",
        "Hmm?",
    )
    # Review of S7C: long replies that tell nothing about the candidate.  They read as an early
    # answer before, so Christy said "Please, carry on with what you were telling me." and counted
    # an icebreaker answer that was never given.
    NOT_AN_EARLY_ANSWER = (
        "Yes I can hear you, I hope my voice is also clear to you, please let me know if there is "
        "any issue.",
        "Yes, I can hear you. Just give me one second, let me plug in my headphones so the audio "
        "is better.",
        "Yes I can hear you perfectly fine, I hope you can hear me as well, my internet connection "
        "is stable now.",
        "Hi Christy, yes I can hear you. Just give me one second, I'm closing the door because "
        "there is a lot of noise outside.",
        "Yes, I can hear you clearly. Thank you so much for giving me this opportunity, I am "
        "really excited and a little nervous to be talking with you today.",
        # An answer that ends on a question to her: the agenda says how long it takes.
        "Yes. I have been working in sales for four years, but before we start, how long will "
        "this interview take?",
    )

    def test_the_complaints_candidates_say_most_read_as_cant_hear(self) -> None:
        for text in self.CANT_HEAR_RECALL:
            with self.subTest(text=text):
                self.assertEqual(self.read(text), r1_session.SOUND_CANT_HEAR)

    def test_a_long_reply_that_tells_nothing_about_them_is_no_early_answer(self) -> None:
        for text in self.NOT_AN_EARLY_ANSWER:
            with self.subTest(text=text):
                self.assertGreaterEqual(
                    r1_session.content_word_count(text), r1_session.OPEN_CHECK_ANSWER_WORDS
                )
                self.assertEqual(self.read(text), r1_session.SOUND_HEARD)

    def test_an_early_answer_tells_about_them(self) -> None:
        for text in (
            "Hi, I am Priya. I have done my MBA in marketing and am currently working at a bank "
            "as a relationship executive.",
            "Yes, I can hear you. I did my graduation in commerce and since then I have been "
            "handling inbound sales calls.",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.read(text), r1_session.SOUND_ANSWER)

    def test_a_questioning_hello_that_names_her_heard_her(self) -> None:
        for text in ("Hello Christy?", "Hi Christy?"):
            with self.subTest(text=text):
                self.assertEqual(self.read(text), r1_session.SOUND_HEARD)
        self.assertEqual(self.read("Hello sir?"), r1_session.SOUND_CANT_HEAR)

    def test_a_hello_said_over_the_hello_is_no_complaint(self) -> None:
        # Review of S7C: said before the question was heard (a line check on joining), "Hello?"
        # says nothing about hearing it.  A complaint is one whenever it is said.
        for text in ("Hello?", "Hello? Are you there?", "Hi, hello?", "What?"):
            with self.subTest(text=text):
                self.assertEqual(
                    r1_session.sound_check_reading(text, after_question=False),
                    r1_session.SOUND_HEARD,
                )
        for text in ("Sorry, I can't hear you.", "Not audible.", "Could you repeat that?"):
            with self.subTest(text=text):
                self.assertEqual(
                    r1_session.sound_check_reading(text, after_question=False),
                    r1_session.SOUND_CANT_HEAR,
                )

    def test_the_readers_are_linear_on_long_input(self) -> None:
        for text in (
            "no " * 5000,
            "i can " * 4000 + "not hear",
            "you are " + "a bit " * 4000 + "low",
            "yes but " * 4000 + "it's low",
            "hello " * 5000 + "?",
            "voice is " + "very " * 4000 + "low",
            "i can hear you but " * 2000 + "low",
            "i have been " * 3000 + "working",
            "a bit " * 5000 + "louder",
            "sorry " * 5000 + "not audible",
            "four " * 5000 + "years",
        ):
            started = time.perf_counter()
            self.read(text)
            self.assertLess(time.perf_counter() - started, 1.0)

    def test_real_advisor_turns_are_rarely_a_complaint(self) -> None:
        # The 2,136-turn advisor corpus and its held-out set are role-play turns, not replies to the
        # sound check; the directed patterns that read anywhere in a turn must not fire on them.
        fixtures = Path(__file__).resolve().parent / "fixtures"
        hits: list[str] = []
        for name in ("r1_advisor_corpus.jsonl", "r1_advisor_heldout.jsonl"):
            for raw in (fixtures / name).read_text(encoding="utf-8").splitlines():
                if not raw:
                    continue
                text = json.loads(raw)["text"]
                if len(text.split()) > r1_session.OPEN_CHECK_COMPLAINT_MAX_WORDS and (
                    self.read(text) == r1_session.SOUND_CANT_HEAR
                ):
                    hits.append(text)
        self.assertEqual(hits, [])


class TestTheOpeningWithoutHearingCheck(R1TestCase):
    """Owner 2026-11-19, R1_OPENING_NO_HEARING_CHECK: hello without the hearing question,
    then the plain agenda at once. Synthetic text only."""

    async def opening(self, *, playout=0.0):
        ctx = FakeContext(self.order)
        ctx.room.remote_participants["candidate"] = FakeParticipant("candidate")
        session = FakeSession(log=self.order, playout_seconds=playout)
        clock = Clock()
        interview = R1Interview(ctx, {"first_name": "Arjun", "candidate_identity": "candidate"},
                                session, self.writer, clock=clock)
        task = asyncio.create_task(interview.run())
        run = SimpleNamespace(interview=interview, session=session, clock=clock, task=task)
        self.addCleanup(self.stop_opening, run)
        await self.until(lambda: session.agent is not None)
        return run

    async def stop_opening(self, run):
        if not run.task.done():
            run.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await run.task

    async def test_default_opening_reaches_icebreaker_without_input(self):
        with mock.patch.dict(os.environ, {"R1_OPENING_SOUND_CHECK": "1",
                                        "R1_OPENING_NO_HEARING_CHECK": "1",
                                        "R1_BRIEF_WORDING_V2": "1", "R1_AGENDA_W3": "1"}):
            with self.capture_logs() as logs:
                run = await self.opening()
                await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
            hello = run.interview.render_line("L-OPEN-HI")
            agenda = run.interview.render_line("L-OPEN-AGENDA-PLAIN")
            self.assertEqual(agenda, r1_script.LINES["L-OPEN-AGENDA-PLAIN-W3"])
            self.assertEqual(run.session.spoken, [hello, agenda])
            self.assertNotIn("?", hello)
            self.assertEqual(run.session.generated, [])
            self.assertFalse(any(row.get("error_type") == "r1_sound_check" for row in logs))
            rows = [row for row in logs if row.get("error_type") == "r1_opening"]
            self.assertEqual([row.get("error_category") for row in rows], ["no_hearing_check"])

    async def test_greeting_over_hello_is_not_an_answer(self):
        with mock.patch.dict(os.environ, {"R1_OPENING_NO_HEARING_CHECK": "1"}):
            run = await self.opening(playout=0.2)
            hello = run.interview.render_line("L-OPEN-HI")
            await self.until(lambda: ("play_start", hello) in self.order)
            run.session.emit("user_input_transcribed", final_event("Hi Christy"))
            await self.settle()
            with contextlib.suppress(r1_session.StopResponse):
                await run.session.agent.on_user_turn_completed(
                    None, SimpleNamespace(text_content="Hi Christy", id=f"msg_{next(_IDS)}"))
            await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
            self.assertEqual(run.interview.machine.candidate_turns, 0)

    async def test_sound_check_rollback_waits(self):
        with mock.patch.dict(os.environ, {"R1_OPENING_NO_HEARING_CHECK": "0"}):
            run = await self.opening()
            await self.until(lambda: len(run.session.spoken) == 1)
            self.assertEqual(run.session.spoken, [run.interview.render_line("L-OPEN-HELLO")])
            await self.settle()
            self.assertEqual(len(run.session.spoken), 1)

    async def test_sound_check_off_uses_original_opening(self):
        for value in ("0", "1"):
            with self.subTest(value=value), mock.patch.dict(os.environ, {
                "R1_OPENING_SOUND_CHECK": "0", "R1_OPENING_NO_HEARING_CHECK": value
            }):
                run = await self.opening()
                await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
                self.assertEqual(run.session.spoken, [run.interview.render_line("L-OPEN")])

    async def test_base_agenda_when_brief_wording_off(self):
        with mock.patch.dict(os.environ, {"R1_BRIEF_WORDING_V2": "0",
                                        "R1_OPENING_NO_HEARING_CHECK": "1"}):
            run = await self.opening()
            await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
            self.assertEqual(run.session.spoken[1], r1_script.LINES["L-OPEN-AGENDA-PLAIN"])

    def test_flag_defaults_and_rollbacks(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertTrue(r1_session.opening_no_hearing_check_enabled())
        with mock.patch.dict(os.environ, {"R1_OPENING_NO_HEARING_CHECK": "0"}):
            self.assertFalse(r1_session.opening_no_hearing_check_enabled())
        with mock.patch.dict(os.environ, {"R1_OPENING_SOUND_CHECK": "0"}):
            self.assertFalse(r1_session.opening_no_hearing_check_enabled())


class TestTheOpeningSoundCheck(R1TestCase):
    """M032 S7C (SWEEP-35, ``R1_OPENING_SOUND_CHECK``, pattern P33).  L-OPEN was one 29 s block with
    no greeting exchange and no hearing check.  The driver says a short hello ("Can you hear me
    okay?"), reads the reply (never with the model), and then one shorter agenda that asks the first
    icebreaker question.  Synthetic text only."""

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        patcher = mock.patch.dict(os.environ, {"R1_OPENING_NO_HEARING_CHECK": "0"})
        patcher.start()
        self.addCleanup(patcher.stop)
        for name, value in (
            ("OPEN_CHECK_SILENCE_SECONDS", 0.2),
            ("OPEN_HELLO_FOLLOW_SECONDS", 0.6),
            ("NO_AUDIO_END_SECONDS", 0.2),
            ("ICEBREAKER_PROMPT_SECONDS", 30.0),
            ("MUTE_ASIDE_DEBOUNCE_SECONDS", 0.0),
        ):
            patcher = mock.patch.object(r1_session, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def opening(self, *, playout: float = 0.0, context: dict | None = None):
        ctx = FakeContext(self.order)
        ctx.room.remote_participants["candidate"] = FakeParticipant("candidate")
        session = FakeSession(log=self.order, playout_seconds=playout)
        clock = Clock()
        interview = R1Interview(
            ctx,
            dict(context or {"first_name": "Asha", "candidate_identity": "candidate"}),
            session,
            self.writer,
            clock=clock,
        )
        task = asyncio.create_task(interview.run())
        run = SimpleNamespace(interview=interview, context=ctx, session=session, clock=clock,
                              task=task)
        self.addCleanup(self.stop, run)
        await self.until(lambda: session.agent is not None)
        return run

    async def stop(self, run) -> None:
        if not run.task.done():
            run.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await run.task

    def played(self, run, line_id: str) -> bool:
        return ("play_end", run.interview.render_line(line_id)) in self.order

    async def hello_played(self, run) -> None:
        await self.until(lambda: self.played(run, "L-OPEN-HELLO"))
        await self.settle()

    async def reply(self, run, text: str) -> None:
        """A reply the way the SDK delivers it: the final, then the committed turn (no reply)."""
        run.session.emit("user_input_transcribed", final_event(text))
        await self.settle()
        with self.assertRaises(r1_session.StopResponse):
            await run.session.agent.on_user_turn_completed(
                None, SimpleNamespace(text_content=text, id=f"msg_{next(_IDS)}")
            )
        await self.settle()

    def spoken_ids(self, run, *line_ids: str) -> list[str]:
        return [run.interview.render_line(line_id) for line_id in line_ids]

    async def test_a_yes_gets_the_agenda_with_no_model_and_no_answer_counted(self) -> None:
        run = await self.opening()
        await self.hello_played(run)
        with self.capture_logs() as logs:
            await self.reply(run, "Yes, I can hear you.")
            await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(run.session.spoken, self.spoken_ids(run, "L-OPEN-HELLO", "L-OPEN-AGENDA"))
        self.assertEqual(run.interview.machine.candidate_turns, 0)
        self.assertEqual(run.session.generated, [])  # no model reply was asked for
        await self.flush_run(run)
        rows = [row for row in self.writer.saved if row["speaker"] == "candidate"]
        self.assertEqual([(row["text"], row["phase"]) for row in rows],
                         [("Yes, I can hear you.", "opening")])
        (check,) = [line_ for line_ in logs if line_.get("error_type") == "r1_sound_check"]
        self.assertEqual(check["error_category"], "heard")
        self.assertNotIn("hear you", json.dumps(logs))

    async def flush_run(self, run) -> None:
        await run.interview._drain_background()

    async def test_the_first_line_carries_the_ai_disclosure(self) -> None:
        run = await self.opening()
        await self.hello_played(run)
        self.assertIn("AI interviewer", run.session.spoken[0])
        self.assertTrue(run.session.spoken[0].startswith("Hi Asha, I'm Dex"))
        self.assertFalse(run.session.handles[0].allow_interruptions)

    async def test_a_hi_during_the_hello_waits_for_the_answer_to_the_question(self) -> None:
        run = await self.opening(playout=0.3)
        hello = run.interview.render_line("L-OPEN-HELLO")
        await self.until(lambda: ("play_start", hello) in self.order)
        run.session.emit("user_input_transcribed", final_event("Hi."))  # over the hello
        await self.hello_played(run)
        await asyncio.sleep(0.3)  # within the follow-up quiet
        self.assertEqual(run.session.spoken, [hello])
        await self.reply(run, "Yes.")
        await self.until(lambda: len(run.session.spoken) == 2)
        self.assertEqual(run.session.spoken[1], run.interview.render_line("L-OPEN-AGENDA"))

    async def test_a_hi_during_the_hello_and_then_nothing_is_still_heard(self) -> None:
        run = await self.opening(playout=0.3)
        hello = run.interview.render_line("L-OPEN-HELLO")
        await self.until(lambda: ("play_start", hello) in self.order)
        run.session.emit("user_input_transcribed", final_event("Hi."))
        await self.hello_played(run)
        await self.until(lambda: len(run.session.spoken) == 2, timeout=5.0)
        self.assertEqual(run.session.spoken[1], run.interview.render_line("L-OPEN-AGENDA"))

    async def test_a_long_early_answer_gets_the_continue_agenda_and_counts_once(self) -> None:
        run = await self.opening()
        await self.hello_played(run)
        answer = (
            "Yes I can. I have spent four years in inside sales, mostly calling small business "
            "owners about accounting software."
        )
        await self.reply(run, answer)
        await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(
            run.session.spoken, self.spoken_ids(run, "L-OPEN-HELLO", "L-OPEN-AGENDA-CONTINUE")
        )
        self.assertEqual(run.interview.machine.candidate_turns, 1)

    async def test_a_late_commit_of_the_reply_is_not_counted_again(self) -> None:
        with _s7c_env(R1_ENDPOINT_MAX_DELAY_SEC="1"), mock.patch.object(
            r1_session, "ICEBREAKER_HOLD_MARGIN_SECONDS", 0.0
        ):
            run = await self.opening()
            await self.hello_played(run)
            answer = (
                "Yes I can. I have spent four years in inside sales, mostly calling small business "
                "owners about accounting software."
            )
            run.session.emit("user_input_transcribed", final_event(answer))
            await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
            self.assertEqual(run.interview.machine.candidate_turns, 1)
            # Committed in the icebreaker: the agenda answered it, so no model reply, no count.
            with self.assertRaises(r1_session.StopResponse):
                await run.session.agent.on_user_turn_completed(
                    None, SimpleNamespace(text_content=answer, id="msg_late")
                )
            self.assertEqual(run.interview.machine.candidate_turns, 1)

    async def test_cant_hear_gets_the_hello_again_once_then_the_plain_agenda(self) -> None:
        run = await self.opening()
        await self.hello_played(run)
        await self.reply(run, "Sorry, I can't hear you.")
        await self.until(lambda: self.played(run, "L-OPEN-HELLO-AGAIN"))
        await self.settle()
        await self.reply(run, "No.")
        await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(
            run.session.spoken,
            self.spoken_ids(run, "L-OPEN-HELLO", "L-OPEN-HELLO-AGAIN", "L-OPEN-AGENDA-PLAIN"),
        )
        self.assertEqual(run.interview.machine.candidate_turns, 0)

    async def test_cant_hear_then_a_yes_gets_the_agenda(self) -> None:
        run = await self.opening()
        await self.hello_played(run)
        await self.reply(run, "Not really.")
        await self.until(lambda: self.played(run, "L-OPEN-HELLO-AGAIN"))
        await self.settle()
        await self.reply(run, "Yes, now I can.")
        await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(
            run.session.spoken,
            self.spoken_ids(run, "L-OPEN-HELLO", "L-OPEN-HELLO-AGAIN", "L-OPEN-AGENDA"),
        )

    async def test_silence_from_a_candidate_never_heard_is_the_no_audio_ladder(self) -> None:
        run = await self.opening()
        self.assertEqual(await asyncio.wait_for(run.task, 10.0), "candidate_left")
        self.assertEqual(
            run.session.spoken,
            self.spoken_ids(run, "L-OPEN-HELLO", "L-SIL-NOAUDIO", "L-SIL-END-NOAUDIO"),
        )
        phases = [a["phase"] for a in run.context.room.local_participant.attributes if "phase" in a]
        self.assertNotIn("icebreaker", phases)
        self.assertNotIn("transition", phases)
        self.assertEqual(self.writer.terminals[0][0], "candidate_left")

    async def test_a_turn_after_the_no_audio_line_gets_the_plain_agenda(self) -> None:
        with mock.patch.object(r1_session, "NO_AUDIO_END_SECONDS", 5.0):
            run = await self.opening()
            await self.until(lambda: self.played(run, "L-SIL-NOAUDIO"))
            await self.settle()
            await self.reply(run, "Sorry, is it working now?")
            await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(
            run.session.spoken,
            self.spoken_ids(run, "L-OPEN-HELLO", "L-SIL-NOAUDIO", "L-OPEN-AGENDA-PLAIN"),
        )

    async def test_silence_after_speech_the_stt_never_finalised_gets_the_plain_agenda(self) -> None:
        run = await self.opening()
        await self.hello_played(run)
        run.session.emit("user_state_changed", state_event("speaking"))
        run.session.emit("user_state_changed", state_event("listening"))
        await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(
            run.session.spoken, self.spoken_ids(run, "L-OPEN-HELLO", "L-OPEN-AGENDA-PLAIN")
        )

    async def test_silence_with_the_no_audio_ladder_off_gets_the_plain_agenda(self) -> None:
        with _s7c_env(R1_NO_AUDIO_LADDER="0"):
            run = await self.opening()
            await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(
            run.session.spoken, self.spoken_ids(run, "L-OPEN-HELLO", "L-OPEN-AGENDA-PLAIN")
        )

    async def test_a_candidate_muted_at_the_hello_gets_the_mute_aside(self) -> None:
        run = await self.opening()
        run.context.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        await self.until(lambda: self.played(run, "L-MUTE-IV"))
        run.clock.advance(r1_session.OPEN_CHECK_HARD_SECONDS + 1)  # the sound check's budget
        run.interview._wake()
        await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(
            run.session.spoken,
            self.spoken_ids(run, "L-OPEN-HELLO", "L-MUTE-IV", "L-OPEN-AGENDA-PLAIN"),
        )

    async def test_the_sound_check_is_bounded(self) -> None:
        run = await self.opening()
        await self.hello_played(run)
        run.session.emit("user_state_changed", state_event("speaking"))  # never stops
        run.clock.advance(r1_session.OPEN_CHECK_HARD_SECONDS + 1)
        run.interview._wake()
        await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(run.session.spoken[-1], run.interview.render_line("L-OPEN-AGENDA-PLAIN"))

    async def test_a_name_said_in_the_reply_is_used_from_then_on(self) -> None:
        run = await self.opening(context={"first_name": "there", "candidate_identity": "candidate"})
        await self.hello_played(run)
        self.assertTrue(run.session.spoken[0].startswith("Hi, I'm Dex"))
        await self.reply(run, "Yes, hi, my name is Ravi.")
        await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(run.interview._first_name(), "Ravi")

    async def test_the_room_closing_during_the_sound_check_stops_the_interview(self) -> None:
        run = await self.opening()
        await self.hello_played(run)
        run.context.room.emit("participant_disconnected", FakeParticipant("candidate"))
        run.context.room.emit("disconnected", "room closed")
        self.assertEqual(await asyncio.wait_for(run.task, 10.0), "candidate_left")
        self.assertEqual(run.session.spoken, self.spoken_ids(run, "L-OPEN-HELLO"))

    # ------------------------------------------------------------- review of S7C

    async def test_a_reply_that_goes_on_is_not_talked_over_and_is_read_whole(self) -> None:
        # The settle waited one fixed grace from the FIRST final: the uninterruptible agenda then
        # played over a candidate still speaking, chosen from the first words of the reply.
        rest = (
            "I have been working in inside sales for five years, selling software subscriptions "
            "to small business owners."
        )
        with mock.patch.object(
            r1_session, "endpoint_max_delay_sec", lambda: 0.2
        ), mock.patch.object(r1_session, "ICEBREAKER_HOLD_MARGIN_SECONDS", 0.0):
            run = await self.opening()
            await self.hello_played(run)
            run.session.emit("user_state_changed", state_event("speaking"))
            run.session.emit("user_input_transcribed", final_event("Yes, I can hear you."))
            await asyncio.sleep(0.6)  # three graces, and still speaking
            self.assertEqual(run.session.spoken, self.spoken_ids(run, "L-OPEN-HELLO"))
            run.session.emit("user_input_transcribed", final_event(rest))
            run.session.emit("user_state_changed", state_event("listening"))
            await self.settle()
            self.assertEqual(run.session.spoken, self.spoken_ids(run, "L-OPEN-HELLO"))
            with self.assertRaises(r1_session.StopResponse):
                await run.session.agent.on_user_turn_completed(
                    None, SimpleNamespace(text_content=f"Yes, I can hear you. {rest}", id="m1")
                )
            await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(
            run.session.spoken, self.spoken_ids(run, "L-OPEN-HELLO", "L-OPEN-AGENDA-CONTINUE")
        )
        self.assertEqual(run.interview.machine.candidate_turns, 1)

    async def test_a_reply_that_never_ends_waits_no_longer_than_the_ceiling(self) -> None:
        with mock.patch.object(
            r1_session, "endpoint_max_delay_sec", lambda: 0.1
        ), mock.patch.object(r1_session, "ICEBREAKER_HOLD_MARGIN_SECONDS", 0.0), mock.patch.object(
            r1_session, "ICEBREAKER_HOLD_CEILING_SECONDS", 0.4
        ):
            run = await self.opening()
            await self.hello_played(run)
            loop = asyncio.get_running_loop()
            run.session.emit("user_state_changed", state_event("speaking"))  # never stops
            run.session.emit("user_input_transcribed", final_event("Yes, I can hear you."))
            heard_at = loop.time()
            await self.until(lambda: len(run.session.spoken) == 2, timeout=5.0)
            self.assertGreaterEqual(loop.time() - heard_at, 0.35)
        self.assertEqual(run.session.spoken[1], run.interview.render_line("L-OPEN-AGENDA"))

    async def test_muted_after_the_no_audio_line_the_opening_still_ends(self) -> None:
        # The opening's never-heard ladder had no budget: muted after L-SIL-NOAUDIO, its silence
        # window never ran and the session waited for the S=30:00 cap (a system stop).  It now
        # ends in the plain agenda, and the icebreaker's own budget follows, as on main.
        with mock.patch.object(r1_session, "NO_AUDIO_END_SECONDS", 5.0), self.capture_logs() as logs:
            run = await self.opening()
            await self.until(lambda: self.played(run, "L-SIL-NOAUDIO"))
            await self.settle()
            run.context.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
            await self.until(lambda: self.played(run, "L-MUTE-IV"))
            await self.settle()
            self.assertIs(run.interview.machine.phase, R1Phase.OPENING)
            run.clock.advance(r1_session.OPEN_NO_AUDIO_HARD_SECONDS + 1)
            run.interview._wake()
            await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(
            run.session.spoken,
            self.spoken_ids(
                run, "L-OPEN-HELLO", "L-SIL-NOAUDIO", "L-MUTE-IV", "L-OPEN-AGENDA-PLAIN"
            ),
        )
        self.assertFalse(run.task.done())
        (check,) = [line_ for line_ in logs if line_.get("error_type") == "r1_sound_check"]
        self.assertEqual(check["error_category"], "no_audio_deadline")

    async def test_an_answer_begun_over_the_agenda_is_an_icebreaker_answer(self) -> None:
        # Finals over the agenda were tagged as sound-check replies, so the answer to the
        # agenda's question, committed after it, got no reply and was not counted.
        run = await self.opening(playout=0.3)
        await self.hello_played(run)
        await self.reply(run, "Yes.")
        agenda = run.interview.render_line("L-OPEN-AGENDA")
        await self.until(lambda: ("play_start", agenda) in self.order)
        answer = "I work in inside sales at a software firm, four years now."
        run.session.emit("user_input_transcribed", final_event(answer))  # over the agenda's tail
        await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        await self.settle()
        await run.session.agent.on_user_turn_completed(  # no StopResponse: the model answers it
            None, SimpleNamespace(text_content=answer, id="msg_after_agenda")
        )
        self.assertEqual(run.interview.machine.candidate_turns, 1)

    async def test_a_hello_said_over_the_hello_and_then_nothing_gets_the_agenda(self) -> None:
        run = await self.opening(playout=0.3)
        hello = run.interview.render_line("L-OPEN-HELLO")
        await self.until(lambda: ("play_start", hello) in self.order)
        run.session.emit("user_input_transcribed", final_event("Hello?"))  # a line check
        await self.hello_played(run)
        await self.until(lambda: len(run.session.spoken) == 2, timeout=5.0)
        self.assertEqual(run.session.spoken[1], run.interview.render_line("L-OPEN-AGENDA"))

    async def test_a_hello_or_not_audible_after_the_question_gets_the_hello_again(self) -> None:
        for text in ("Hello?", "Not audible."):
            with self.subTest(text=text):
                run = await self.opening()
                await self.hello_played(run)
                await self.reply(run, text)
                await self.until(lambda: len(run.session.spoken) == 2, timeout=5.0)
                self.assertEqual(
                    run.session.spoken[1], run.interview.render_line("L-OPEN-HELLO-AGAIN")
                )
                await self.stop(run)

    async def test_a_long_check_back_gets_the_agenda_and_is_not_counted(self) -> None:
        run = await self.opening()
        await self.hello_played(run)
        await self.reply(
            run,
            "Yes I can hear you perfectly fine, I hope you can hear me as well, my internet "
            "connection is stable now.",
        )
        await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(run.session.spoken, self.spoken_ids(run, "L-OPEN-HELLO", "L-OPEN-AGENDA"))
        self.assertEqual(run.interview.machine.candidate_turns, 0)

    async def test_the_flag_off_speaks_l_open_and_goes_straight_on(self) -> None:
        with _s7c_env(R1_OPENING_SOUND_CHECK="0"):
            run = await self.opening()
            await self.until(lambda: run.interview.machine.phase is R1Phase.ICEBREAKER)
        self.assertEqual(run.session.spoken, self.spoken_ids(run, "L-OPEN"))


class TestTransitionReadyAnywhere(R1TestCase):
    """M032 christy-ready (``R1_CONSENT_WIDE``, default on): a spoken "ready" counts wherever it
    sits in the turn.  The live simulation's candidates said "Got it. Okay, I'm ready." and "Haan,
    theek hai, I'm ready.", and Christy answered them as questions.  Every text here is synthetic
    (the simulation's own candidate lines, and shapes written for this test)."""

    # The simulation's transition turns tagged "ready" (offline adapt run and live int-live-2).
    SIM_READY = (
        "Fine, whatever. I'm ready.", "Fine. I'm ready. Let's get it over with.",
        "Got it. Okay, I'm ready.", "Haan, theek hai, I'm ready.", "I am ready", "I am ready.",
        "I'm ready.", "No questions, I'm ready.", "Okay, I think I get it now. I'm ready.",
        "Okay, I'm ready.",
        "Okay, okay, so yes, I think I've got the picture now, the learner, the course, the "
        "twenty minutes, all of it, and honestly I've done calls like this a hundred times, so "
        "let's do it, I'm ready.",
        "Okay, ready.", "Okay. I think I'm ready now.", "Ready.",
        "Sure, I'm ready whenever you are.",
        "Um, okay. Ready.", "Yeah, I'm ready.", "Yeah, ready.", "Yes, I'm ready.", "Yes, ready.",
    )
    # The ones the strict reading turned down (answered as questions before christy-ready).
    WIDENED = (
        "Fine, whatever. I'm ready.", "Fine. I'm ready. Let's get it over with.",
        "Got it. Okay, I'm ready.", "Haan, theek hai, I'm ready.",
        "Okay, I think I get it now. I'm ready.",
        "Okay, okay, so yes, I think I've got the picture now, the learner, the course, the "
        "twenty minutes, all of it, and honestly I've done calls like this a hundred times, so "
        "let's do it, I'm ready.",
    )
    MORE_READY = (
        "I'm ready if you are.", "Thanks for answering my questions, I'm ready.",
        "Chalo, let's start.", "Okay, I see how it works now, I'm ready.",
        "It sounds a bit tricky but yeah, I suppose I'm ready, let's do it.",
        "Achha, theek hai. I'm ready, chalo.", "Alright, makes sense. I'm all set.",
        "Got it, thanks Christy. Ready when you are.", "Right, that's clear. I'm ready to start.",
        # christy-ready review: a "then" after nothing but filler or an acknowledgement.
        "Okay then, let's start.", "Alright then, I'm ready.", "Got it. Okay then, I'm ready.",
        "So then, let's begin.", "Okay, that's clear, then let's do it.",
    )
    # A question, a conditional or deferral, a negation, or a turn that still asks for something.
    NOT_READY = (
        "am I ready?", "Am I ready", "I'm not ready", "I'm not ready yet.", "ready? what do I do",
        "Ready, what do I do", "I'll be ready in a minute", "I'll be ready in a minute.",
        "are you ready", "Are you ready?", "I'm ready but I have one question.",
        "I'm almost ready.", "I don't think I'm ready.", "I'm ready to learn more about the pay",
        "Okay, I'm ready, wait.", "I want to know the timings, then we can start.",
        "I was ready.", "You're ready.", "I'll get ready.", "Ready once I've read the guide.",
        "Okay, can you repeat the goal, I'm ready.", "Is she ready", "Maybe I'm ready.",
        "I'm ready, just one thing first.", "Give me a second, then I'm ready.",
        "I'll be ready soon.", "Not yet, but I'll be ready after this.",
        "I'm ready if I can ask one more thing.", "Hang on, I'm nearly ready.",
        "Could you say it again? I'm ready after that.", "What do I do once I'm ready?",
    )
    # christy-ready review: a readiness put off behind "then" / "otherwise", a query or concern
    # still pending, time asked for, or a question without a question mark.
    NOT_READY_DEFERRED = (
        "Just one query, otherwise I'm ready.",
        "I have a query regarding the fee, otherwise I'm ready.",
        "Let me check my notes, then let's start.", "Let me quickly read it, then I'm ready.",
        "Allow me a minute, then let's start.", "Two seconds, I'm ready.",
        "Just a moment, I'm ready", "Let me unmute and then let's start.",
        "One more thing and then let's begin", "I need to know the fee, then I'm ready",
        "Please answer my question, then I'm ready", "Finish explaining the card, then I'm ready",
        "Is the course online. Okay, let's start.", "I have one concern otherwise let's start",
        "Let me get some water and then let's start", "Two minutes, then let's start",
        "Let me grab a pen, I'm ready.", "Does the learner know the fee. Okay, I'm ready.",
    )
    # The simulation's other transition turns: none of them becomes a consent.
    SIM_NOT_READY = (
        "And this rule that I can't leave before fourteen minutes, that's unfair. Who decided "
        "that?",
        "Actually, before we start, can we go back to that earlier question, the icebreaker, "
        "and repeat it?",
        "Christy, could you say that again? Just go over the instructions once more.",
        "Could you sum up this role-play for me once more? I'd like a bit more detail.",
        "I wanted to get a handle on this round, uh, the role-play brief.",
        "No, I mean the role-play, the one with Meera. Can you say all that again? I zoned out a "
        "bit.",
        "Sorry, I didn't catch all of that. Could you repeat it?",
        "Yeah, just go over the role-play again for me.",
        "So I'm the one selling the course, and she's the student? What do I actually do?",
        "Wait, sorry, I'm a bit lost. Who am I supposed to be in this?", "Hello? Are you there?",
        "And how long will the role-play take?",
        "Yeah, before we begin the role-play, can I ask a few questions?",
        "Before we start, am I calling her, or is she calling me?",
        "Can I take notes while we talk?",
        "Could I, could I check a few other things first?",
        "Can you give me a shorter version? That was a lot.",
        "Actually, I'd like to know more about the job itself.", "No option.", "So bye.",
        "Yeah, yeah, I got it the first time. You didn't need to explain all that.",
    )

    def test_every_simulated_ready_is_a_consent(self) -> None:
        for text in self.SIM_READY + self.MORE_READY:
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_transition_consent(text))

    def test_a_question_a_deferral_or_a_negation_is_never_a_consent(self) -> None:
        for text in self.NOT_READY + self.SIM_NOT_READY:
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_transition_consent(text))

    def test_a_ready_put_off_or_with_something_pending_is_never_a_consent(self) -> None:
        for text in self.NOT_READY_DEFERRED:
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_transition_consent(text))
        with mock.patch.dict(os.environ, {"R1_CONSENT_WIDE": "0"}):
            for text in self.NOT_READY_DEFERRED:
                with self.subTest(text=text, wide="0"):
                    self.assertFalse(r1_session.is_transition_consent(text))

    def test_the_flag_off_restores_the_strict_reading(self) -> None:
        with mock.patch.dict(os.environ, {"R1_CONSENT_WIDE": "0"}):
            for text in self.WIDENED:
                with self.subTest(text=text):
                    self.assertFalse(r1_session.is_transition_consent(text))
            for text in ("Ready.", "Okay, ready.", "Yes, I'm ready.", "Ready when you are."):
                with self.subTest(text=text):
                    self.assertTrue(r1_session.is_transition_consent(text))
            for text in self.NOT_READY + self.SIM_NOT_READY:
                with self.subTest(text=text):
                    self.assertFalse(r1_session.is_transition_consent(text))

    async def test_a_ready_with_a_run_up_picks_up_through_the_driver(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        self.final_transcript("Got it. Okay, I'm ready.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])
        self.assertEqual(self.interview._start_by, "spoken")

    async def test_the_committed_turn_is_the_pickup_s_never_an_answer(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        self.agent_state("listening")
        for text in self.WIDENED:
            with self.subTest(text=text):
                self.assertEqual(
                    self.interview._transition_action(text), r1_session._TRANSITION_READY
                )

    def test_the_wide_reading_never_reaches_the_icebreaker_or_the_role_play(self) -> None:
        # Consent is still read only in the transition: the detectors that defer to it there
        # (brief and icebreaker-question requests) treat a run-up ready as no request.
        for text in self.WIDENED:
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_brief_request(text, wide=True))
                self.assertFalse(r1_session.is_icebreaker_question_request(text))


class TestTransitionStartAskedOnce(R1TestCase):
    """M032 christy-ready (``R1_START_ASK_ONCE``, default on with ``R1_TRANSITION_REPAIR``).

    The simulation's candidates who asked several questions heard a start question after every
    answer.  Now only the first answer ends with one; later answers end without it, and a quiet
    pause after one gets L-TRANSITION-ASK-PAUSE, once.  Every text here is synthetic.
    """

    QUESTIONS = ("What are the working days?", "Is it a night shift?", "Is there a team lead?")

    async def start_transition(self) -> asyncio.Task:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR  # the brief has been heard
        self.interview._last_transition_line = "L-TRANSITION"
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        return task

    def count(self, line_id: str) -> int:
        return self.session.spoken.count(self.spoken_line(line_id))

    async def spoken_answer(self, question: str, answer: str) -> str:
        """The candidate asks; Christy's answer streams through the screen (with any tail)."""
        self.assertFalse(await self.answer(question))
        reply = self.interview._last_reply
        guard = StreamGuard(self.interview.engine.guard_context("transition", mode="reply"))
        chunks = [
            chunk async for chunk in self.interview._screened(
                lambda: self_stream(answer), guard, reply
            )
        ]
        return "".join(chunks).strip()

    def start_questions_in(self, text: str) -> int:
        lines = ("L-TRANSITION-ASK", "L-TRANSITION-ASK-2", "L-TRANSITION-ASK-3")
        return sum(text.count(self.spoken_line(line_id)) for line_id in lines)

    async def test_only_the_first_answer_ends_with_a_start_question(self) -> None:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        self.interview._last_transition_line = "L-TRANSITION"
        heard = []
        for question in self.QUESTIONS:
            heard.append(await self.spoken_answer(question, "It's five days a week."))
        self.assertTrue(heard[0].endswith(self.spoken_line("L-TRANSITION-ASK-2")))
        self.assertEqual([self.start_questions_in(text) for text in heard], [1, 0, 0])
        self.assertEqual(heard[1], "It's five days a week.")
        self.assertIsNone(self.interview._start_question)
        self.assertTrue(self.interview._start_prompt_owed)
        self.assertEqual(self.interview._transition_answers, 3)  # each still counts

    async def test_a_tail_never_heard_is_still_asked_after_the_next_answer(self) -> None:
        # The first answer asked a question of its own (S6 item 7 dropped its tail): the second
        # answer carries the start question, and only then do the answers go without one.
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR
        first = await self.spoken_answer("Can I ask about the shifts?", "Sure, which shift?")
        second = await self.spoken_answer(*self.QUESTIONS[:1], "It's five days a week.")
        third = await self.spoken_answer(self.QUESTIONS[1], "It's a day shift.")
        self.assertEqual(
            [self.start_questions_in(text) for text in (first, second, third)], [0, 1, 0]
        )

    async def test_a_quiet_pause_gets_the_pause_prompt_once_and_a_yes_starts(self) -> None:
        with mock.patch.object(
            r1_session,
            "TRANSITION_SILENCE_LADDER",
            ((5.0, "L-TRANSITION-REASK"), (5.0, "L-TRANSITION-REASK-2")),
        ), mock.patch.object(r1_session, "TRANSITION_QUIET_TURN_REASK_SECONDS", 0.05):
            task = await self.start_transition()
            self.interview._start_asked_after_answer = True  # one answer already ended with it
            self.assertFalse(await self.answer(self.QUESTIONS[1]))
            self.assertEqual(self.interview._last_reply.tail, "")
            self.agent_state("listening")  # her answer has played
            await self.until(
                lambda: self.count("L-TRANSITION-ASK-PAUSE") == 1
                and not self.interview._start_prompt_owed,
                timeout=2.0,
            )
            self.assertEqual(self.count("L-TRANSITION-REASK"), 0)
            self.assertEqual(self.interview._start_question, r1_session._YES_NO)
            await asyncio.sleep(0.2)  # the next rung is the long one: no second prompt
            self.assertEqual(self.count("L-TRANSITION-ASK-PAUSE"), 1)
            self.assertEqual(self.count("L-TRANSITION-REASK-2"), 0)
            self.final_transcript("Yes.")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
            self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_a_second_quiet_pause_gets_the_reask_never_the_pause_prompt_again(self) -> None:
        # christy-ready review: L-TRANSITION-ASK-PAUSE is said once per transition; a later
        # tailless answer's pause gets the ladder's own L-TRANSITION-REASK, worded differently.
        with mock.patch.object(
            r1_session,
            "TRANSITION_SILENCE_LADDER",
            ((5.0, "L-TRANSITION-REASK"), (5.0, "L-TRANSITION-REASK-2")),
        ), mock.patch.object(r1_session, "TRANSITION_QUIET_TURN_REASK_SECONDS", 0.05):
            task = await self.start_transition()
            self.interview._start_asked_after_answer = True  # one answer already ended with it
            for question, line_id in zip(
                self.QUESTIONS[1:], ("L-TRANSITION-ASK-PAUSE", "L-TRANSITION-REASK")
            ):
                self.assertFalse(await self.answer(question))
                self.assertEqual(self.interview._last_reply.tail, "")
                self.agent_state("listening")
                await self.until(
                    lambda: self.count(line_id) == 1 and not self.interview._start_prompt_owed,
                    timeout=2.0,
                )
            self.assertEqual(self.count("L-TRANSITION-ASK-PAUSE"), 1)
            self.assertEqual(self.count("L-TRANSITION-REASK-2"), 0)
            self.final_transcript("ready")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))
            self.assertEqual(self.session.spoken[-1], self.spoken_line("L-PICKUP"))

    async def test_an_okay_after_a_tailless_answer_keeps_the_short_pause(self) -> None:
        with mock.patch.object(
            r1_session,
            "TRANSITION_SILENCE_LADDER",
            ((5.0, "L-TRANSITION-REASK"), (5.0, "L-TRANSITION-REASK-2")),
        ), mock.patch.object(r1_session, "TRANSITION_QUIET_TURN_REASK_SECONDS", 0.3):
            task = await self.start_transition()
            self.interview._start_asked_after_answer = True
            self.assertFalse(await self.answer(self.QUESTIONS[1]))
            self.agent_state("listening")
            self.assertTrue(await self.answer("Okay."))  # a backchannel: no reply, no start
            self.assertIsNone(self.interview._start_question)
            await self.until(lambda: self.count("L-TRANSITION-ASK-PAUSE") == 1, timeout=2.0)
            self.final_transcript("ready")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_ready_or_the_button_still_start_at_any_time(self) -> None:
        task = await self.start_transition()
        self.interview._start_asked_after_answer = True
        self.assertFalse(await self.answer(self.QUESTIONS[1]))
        self.final_transcript("Okay, got it. I'm ready.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])

    async def _every_answer_asks(self, env: dict) -> None:
        with mock.patch.dict(os.environ, env):
            self.interview._enter(R1Phase.TRANSITION)
            self.interview._start_question = r1_session._EITHER_OR
            self.interview._last_transition_line = "L-TRANSITION"
            heard = [
                await self.spoken_answer(question, "It's five days a week.")
                for question in self.QUESTIONS[:2]
            ]
            self.assertEqual([self.start_questions_in(text) for text in heard], [1, 1])
            self.assertFalse(self.interview._start_prompt_owed)
            self.assertFalse(r1_session.start_ask_once_enabled())

    async def test_with_the_flag_off_every_answer_ends_with_a_start_question(self) -> None:
        await self._every_answer_asks({"R1_START_ASK_ONCE": "0"})

    async def test_with_the_repair_off_every_answer_ends_with_a_start_question(self) -> None:
        await self._every_answer_asks({"R1_TRANSITION_REPAIR": "0"})

    def test_the_pause_prompt_is_one_clear_yes_no_start_question(self) -> None:
        line = self.spoken_line("L-TRANSITION-ASK-PAUSE")
        self.assertEqual(line.count("?"), 1)
        self.assertIn("ready", line)
        self.assertEqual(
            r1_session._START_QUESTION_OF_LINE["L-TRANSITION-ASK-PAUSE"], r1_session._YES_NO
        )
        others = (
            "L-TRANSITION", "L-TRANSITION-ASK", "L-TRANSITION-ASK-2", "L-TRANSITION-ASK-3",
            "L-TRANSITION-REASK", "L-TRANSITION-REASK-2", "L-TRANSITION-STEER",
        )
        question = line.split("?")[0] + "?"
        for line_id in others:
            with self.subTest(line_id=line_id):
                self.assertNotIn(question, self.spoken_line(line_id))


class TestWrapupNextStepsScripted(R1TestCase):
    """Simulation diagnosis 3 (D3-WRAP1, R1_WRAPUP_NEXT_STEPS): "what happens next?" gets the
    scripted L-WRAP-NEXT and the close names nobody again; two feedback asks get two different
    refusals; "No, no questions from me. Thanks." closes.  Synthetic text."""

    def enter_wrapup(self) -> None:
        self.enter_roleplay()
        self.interview._end_roleplay()
        self.interview.machine.transition(R1Phase.WRAPUP)

    async def run_wrapup_with(self, *turns: str) -> None:
        self.enter_wrapup()
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.02):
            task = asyncio.create_task(self.interview._run_wrapup())
            await self.settle()
            for text in turns:
                self.final_transcript(text)
                await self.settle()
                self.assertTrue(await self.commit_turn(text))  # no model reply
                await self.settle()
            self.assertIsNone(await asyncio.wait_for(task, 5.0))

    async def test_whats_next_gets_the_scripted_answer_and_the_short_close(self) -> None:
        # Review D3R-3: the wrap-up goes on after the answer (one invitation), so the candidate may
        # still ask about the role; "No, that's all, thanks." closes it.
        await self.run_wrapup_with("Okay, and what happens next?", "No, that's all, thanks.")
        self.assertIn(self.spoken_line("L-WRAP-NEXT"), self.session.spoken)
        self.assertIn(self.spoken_line("L-WRAP-MORE"), self.session.spoken)
        self.assertLess(
            self.session.spoken.index(self.spoken_line("L-WRAP-NEXT")),
            self.session.spoken.index(self.spoken_line("L-WRAP-MORE")),
        )
        self.assertTrue(self.interview._close_short)
        self.assertTrue(self.interview._close_short)
        self.assertEqual(self.session.generated, [])
        self.assertEqual(self.interview._wrapup_counts()["wrapup_next_scripted"], 1)
        close = self.spoken_line("L-CLOSE-SHORT")
        self.assertNotIn("hiring team", close.lower())
        self.assertIn("hiring team", self.spoken_line("L-WRAP-NEXT").lower())

    async def test_two_feedback_asks_get_two_different_refusals(self) -> None:
        await self.run_wrapup_with("How did I do in the role-play?", "Will I be selected, though?")
        first = self.spoken_line("L-NO-FEEDBACK-2")
        second = self.spoken_line("L-FAQ-DEFER-WRAP-2")
        self.assertIn(first, self.session.spoken)
        self.assertIn(second, self.session.spoken)
        self.assertNotEqual(first, second)
        self.assertEqual(self.interview._wrapup_refusals, 2)

    @mock.patch.dict(os.environ, {"R1_WRAPUP_NEXT_STEPS": "0"})
    async def test_flag_off_is_the_release_before(self) -> None:
        self.assertIsNone(self.interview._wrapup_scripted_kind("What happens next?"))
        self.assertFalse(r1_session.is_no_questions("No, no questions from me. Thanks."))

    async def test_no_questions_from_me_closes(self) -> None:
        self.assertTrue(r1_session.is_no_questions("No, no questions from me. Thanks."))
        self.assertTrue(r1_session.is_no_questions("No, no questions. Thanks, that was lovely."))
        self.assertFalse(r1_session.is_no_questions("No questions from me, but what's the pay?"))

    async def test_the_readers(self) -> None:
        kind = r1_session.wrapup_ask_kind
        self.assertEqual(kind("What's the next stage?"), r1_session.WRAPUP_NEXT)
        self.assertEqual(kind("Is there anything more to the interview?"), r1_session.WRAPUP_NEXT)
        self.assertEqual(kind("When will I hear back?"), r1_session.WRAPUP_NEXT)
        self.assertEqual(kind("Can I get some feedback?"), r1_session.WRAPUP_FEEDBACK)
        self.assertIsNone(kind("What's the next step after joining, the training?"))
        self.assertIsNone(kind("What are the shift timings?"))

    async def test_role_questions_are_not_read_as_next_steps_or_feedback(self) -> None:
        # Review D3R-3: questions about the job are the model's to answer.
        kind = r1_session.wrapup_ask_kind
        for text in (
            "When do I get paid?",
            "When would I know my shift timings?",
            "When would I get my first incentive?",
            "What's the next step in the sales process here?",
            "When do I get to start if selected?",
            "What's the salary? And what happens next?",
            "Do advisors get feedback from managers in this role?",
            "How are my results measured?",
            "What is my rating based on in the job?",
            "I have some feedback, the audio was laggy.",
        ):
            with self.subTest(text=text):
                self.assertIsNone(kind(text))
        for text, want in (
            ("When will I know if I'm selected?", r1_session.WRAPUP_NEXT),
            ("When would I get the result?", r1_session.WRAPUP_NEXT),
            ("When do I find out?", r1_session.WRAPUP_NEXT),
            ("What happens next? When will I hear back?", r1_session.WRAPUP_NEXT),
            ("How did I do?", r1_session.WRAPUP_FEEDBACK),
            ("Could you give me feedback on my interview?", r1_session.WRAPUP_FEEDBACK),
            ("Is there any feedback for me?", r1_session.WRAPUP_FEEDBACK),
            ("What's my score?", r1_session.WRAPUP_FEEDBACK),
            ("Will I be selected?", r1_session.WRAPUP_FEEDBACK),
        ):
            with self.subTest(text=text):
                self.assertEqual(kind(text), want)

    async def test_the_answer_closes_when_no_question_is_left(self) -> None:
        # Review D3R-3: with the question limit reached the close follows the answer at once.
        await self.run_wrapup_with("How did I do in the role-play?", "And what happens next?")
        self.assertIn(self.spoken_line("L-WRAP-NEXT"), self.session.spoken)
        self.assertNotIn(self.spoken_line("L-WRAP-MORE"), self.session.spoken)
        self.assertTrue(self.interview._close_short)



class TestBriefVariety(R1TestCase):
    """M032 diagnosis 3 (D3-BRIEF1, ``R1_BRIEF_VARIETY`` on, the default).

    int-live-3 M01: "sum it up once more, a bit more detail" got the 110-word brief again word for
    word, two later requests got the same recap twice, and "Are you there?" got the start question
    again 20 s after the recap had asked it.  M03: after the recap, "say it again" got the full
    replay, longer than what the candidate had just asked to shorten.  Every text is synthetic.
    """

    async def start_transition(self) -> asyncio.Task:
        self.interview._enter(R1Phase.TRANSITION)
        self.interview._start_question = r1_session._EITHER_OR  # the brief has been heard
        self.interview._last_transition_line = "L-TRANSITION"
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        return task

    def count(self, line_id: str) -> int:
        return self.session.spoken.count(self.spoken_line(line_id))

    async def heard(self, line_id: str, times: int = 1) -> None:
        await self.until(lambda: self.count(line_id) == times)
        await self.until(lambda: self.spoken_and_played(line_id))
        await self.settle()

    async def test_the_m01_sequence_gets_four_different_texts(self) -> None:
        task = await self.start_transition()
        self.assertTrue(await self.answer(
            "Could you sum up this role-play for me once more? I'd like a bit more detail."
        ))
        await self.heard("L-TRANSITION-AGAIN-PLAIN")
        self.assertTrue(await self.answer("Yeah, just go over the role-play again for me."))
        await self.heard("L-TRANSITION-RECAP")
        self.clock.advance(19)  # the recap's own start question finished 19 s ago
        self.assertTrue(await self.answer("Are you there?"))
        await self.heard("L-PRESENT-TAKE-TIME")  # D4-TRANS-PRESENT1: one line
        self.assertTrue(await self.answer(
            "No, I mean the role-play, the one with Meera. Can you say all that again? I zoned "
            "out a bit."
        ))
        await self.heard("L-TRANSITION-RECAP-2")
        expected = [
            self.spoken_line(line_id)
            for line_id in (
                "L-TRANSITION-AGAIN-PLAIN",
                "L-TRANSITION-RECAP",
                "L-PRESENT-TAKE-TIME",  # D4-TRANS-PRESENT1: one line, not two
                "L-TRANSITION-RECAP-2",
            )
        ]
        self.assertEqual(self.session.spoken, expected)
        self.assertEqual(len(set(self.session.spoken)), len(self.session.spoken))
        self.assertEqual(self.count("L-TRANSITION-REASK"), 0)
        self.assertEqual(self.count("L-TRANSITION-AGAIN"), 0)
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.interview._repair_facts()["transition_recaps"], 2)

    async def test_the_m03_sequence_gets_the_recap_then_the_second_recap(self) -> None:
        task = await self.start_transition()
        self.assertTrue(await self.answer(
            "Could you give me those instructions in, like, just 4 lines?"
        ))
        await self.heard("L-TRANSITION-RECAP")
        self.assertTrue(await self.answer(
            "Christy, could you say it again? Go over the instructions once more."
        ))
        await self.heard("L-TRANSITION-RECAP-2")
        self.assertEqual(self.session.spoken, [
            self.spoken_line("L-TRANSITION-RECAP"), self.spoken_line("L-TRANSITION-RECAP-2")
        ])
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_more_detail_after_a_recap_still_gets_the_replay(self) -> None:
        task = await self.start_transition()
        self.assertTrue(await self.answer("Can you explain the role play briefly?"))
        await self.heard("L-TRANSITION-RECAP")
        self.assertTrue(await self.answer(
            "Actually, can you go over the role play again in more detail?"
        ))
        await self.heard("L-TRANSITION-AGAIN-PLAIN")
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_past_every_budget_no_request_gets_a_line_it_just_got(self) -> None:
        task = await self.start_transition()
        request = "Can you go over the role play again?"
        self.assertTrue(await self.answer(request))
        await self.heard("L-TRANSITION-AGAIN-PLAIN")
        self.assertTrue(await self.answer(request))
        await self.heard("L-TRANSITION-RECAP")
        self.assertTrue(await self.answer(request))
        await self.heard("L-TRANSITION-RECAP-2")
        # Review of diagnosis 3 (D3-BRIEF1-REASK-ROTATION): never "I'm still here whenever you're
        # ready." (REASK-2, a silence line) in reply to something the candidate just said.
        for line_id in ("L-TRANSITION-REASK", "L-TRANSITION-NUDGE"):
            self.assertTrue(await self.answer(request))
            await self.heard(line_id)
        self.assertTrue(await self.answer(request))  # all heard: the one heard longest ago
        await self.heard("L-TRANSITION-REASK", times=2)
        spoken = self.session.spoken
        self.assertTrue(all(a != b for a, b in zip(spoken, spoken[1:])))
        self.assertEqual(len(set(spoken[:5])), 5)
        self.assertEqual(self.count("L-TRANSITION-REASK-2"), 0)
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_a_yes_to_her_own_question_gets_the_yes_no_start_question(self) -> None:
        # Review of diagnosis 3 (D3-BRIEF1-REASK-ROTATION): the silence ladder already played the
        # reask; her answer then ended with a question of its own, past the answer limit.  "Yes."
        # to it gets the yes/no start question again (never REASK-2 or the nudge, after which a
        # bare "Yes." is no consent), and the next "Yes." starts the role-play.
        task = await self.start_transition()
        self.interview._transition_said.append("L-TRANSITION-REASK")
        self.interview._start_question = None
        self.interview._last_answer_tailless = True
        self.interview._last_transition_line = "reply"
        self.interview._transition_answers = r1_session.TRANSITION_QUESTION_LIMIT
        self.agent_state("listening")
        self.assertEqual(
            self.interview._transition_action("Yes."), r1_session._TRANSITION_REASK_YES_NO
        )
        self.assertTrue(await self.answer("Yes."))
        await self.heard("L-TRANSITION-REASK")
        self.assertEqual(self.count("L-TRANSITION-REASK-2"), 0)
        self.assertEqual(self.count("L-TRANSITION-NUDGE"), 0)
        self.final_transcript("Yes.")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertTrue(self.interview._transition_consented or self.interview._ready_latched)

    async def test_a_presence_check_long_after_the_start_question_gets_it_again(self) -> None:
        task = await self.start_transition()
        self.assertTrue(await self.answer("Can you go over the role play again?"))
        await self.heard("L-TRANSITION-AGAIN-PLAIN")
        self.clock.advance(r1_session.PRESENCE_TAKE_TIME_SECONDS + 1)
        self.assertTrue(await self.answer("Hello? Are you there?"))
        await self.heard("L-TRANSITION-REASK")
        self.assertEqual(self.session.spoken[-2:], [
            self.spoken_line("L-PRESENT"), self.spoken_line("L-TRANSITION-REASK")
        ])
        self.assertEqual(self.count("L-TRANSITION-TAKE-TIME"), 0)
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    async def test_a_second_presence_check_soon_after_gets_yes_im_here_alone(self) -> None:
        task = await self.start_transition()
        self.interview._start_prompt_heard_at = self.clock()
        self.assertTrue(await self.answer("Are you there?"))
        await self.heard("L-PRESENT-TAKE-TIME")  # D4-TRANS-PRESENT1: one line
        self.clock.advance(5)
        self.assertTrue(await self.answer("Hello? Are you there?"))
        await self.heard("L-PRESENT")
        self.assertEqual(self.count("L-PRESENT-TAKE-TIME"), 1)
        self.assertEqual(self.count("L-TRANSITION-REASK"), 0)
        self.final_transcript("ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))

    def test_the_new_lines(self) -> None:
        again = self.spoken_line("L-TRANSITION-AGAIN-PLAIN")
        recap_2 = self.spoken_line("L-TRANSITION-RECAP-2")
        take_time = self.spoken_line("L-TRANSITION-TAKE-TIME")
        lead = self.interview.persona.first_name
        self.assertIn(self.interview.persona.lead_name, again)
        self.assertIn("'Let's pause the role-play here.'", again)  # the exit cue, unchanged
        self.assertIn(lead, recap_2)
        for text in (again, recap_2, take_time):
            with self.subTest(text=text[:30]):
                self.assertFalse(text.startswith("Of course"))
                self.assertIn("'ready'", text)
                self.assertNotIn("?", text)
        brief = self.spoken_line("L-TRANSITION")
        self.assertNotIn(again[len("Sure. "):60], brief)  # re-explained, not the brief again
        for line_id in ("L-TRANSITION-AGAIN-PLAIN", "L-TRANSITION-RECAP-2", "L-TRANSITION-TAKE-TIME"):
            self.assertEqual(r1_session._START_QUESTION_OF_LINE[line_id], r1_session._SAY_READY)

    def test_the_detail_detector(self) -> None:
        for text in (
            "I'd like a bit more detail.",
            "Can you give me the full version again?",
            "Could you explain the whole thing again, from the start?",
            "Please go over it in more detail.",
        ):
            with self.subTest(text=text):
                self.assertTrue(r1_session.is_detail_brief_request(text))
        for text in (
            "Can you say all that again?",
            "Just the short version please.",
            "I don't need the full version.",
            "Okay, I'm ready.",
            "",
        ):
            with self.subTest(text=text):
                self.assertFalse(r1_session.is_detail_brief_request(text))

    def test_the_warm_order_follows_the_flag(self) -> None:
        # D4-TRANS-PRESENT1: L-PRESENT-TAKE-TIME takes L-TRANSITION-TAKE-TIME's place.
        new = {"L-TRANSITION-AGAIN-PLAIN", "L-TRANSITION-RECAP-2", "L-PRESENT-TAKE-TIME"}
        order = set(self.interview._warm_order())
        self.assertTrue(new <= order)
        self.assertNotIn("L-TRANSITION-TAKE-TIME", order)
        self.assertNotIn("L-TRANSITION-AGAIN", order)
        with mock.patch.dict(os.environ, {"R1_BRIEF_VARIETY": "0"}):
            order = set(self.interview._warm_order())
        self.assertFalse((new | {"L-TRANSITION-TAKE-TIME"}) & order)
        self.assertIn("L-TRANSITION-AGAIN", order)

    async def test_with_the_flag_off_the_lines_and_routing_are_revision_28_s(self) -> None:
        for env in ({"R1_BRIEF_VARIETY": "0"}, {"R1_TRANSITION_REPAIR": "0"}):
            with self.subTest(env=env), mock.patch.dict(os.environ, env):
                self.assertFalse(r1_session.brief_variety_enabled())
        with mock.patch.dict(os.environ, {"R1_BRIEF_VARIETY": "0"}):
            self.assertEqual(self.interview._brief_line_id(replay=True), "L-TRANSITION-AGAIN")
            task = await self.start_transition()
            self.assertTrue(await self.answer("Can you explain the role play briefly?"))
            await self.heard("L-TRANSITION-RECAP")
            self.assertTrue(await self.answer("Can you go over the role play again?"))
            await self.heard("L-TRANSITION-AGAIN")  # the full replay after a recap, as before
            self.assertTrue(await self.answer("Can you go over the role play again?"))
            await self.heard("L-TRANSITION-RECAP", times=2)  # the same recap again, as before
            self.clock.advance(2)
            self.assertTrue(await self.answer("Are you there?"))
            await self.heard("L-TRANSITION-REASK")
            self.assertEqual(self.count("L-TRANSITION-TAKE-TIME"), 0)
            self.final_transcript("ready")
            self.assertIsNone(await asyncio.wait_for(task, 10.0))



class TestConsentEchoAtPickup(R1TestCase):
    """M032 diagnosis 3 (D3-PICKUP1).  int-live-3 strong and M07: "Okay, I'm ready." ended about a
    second before the pickup, the driver heard it at its final and played "Hello, Meera speaking.",
    and the SDK's commit of the same turn (its endpointing delay outlasted the 1.4 s pickup) was then
    planned as the first role-play turn: "Hi, who's calling?" 3 s later, with no advisor turn
    between.  The livekit-agents rule the harness mirrors (a turn whose commit lands after an
    uninterruptible line has FINISHED runs the hook) makes this real timing, not a harness artefact.
    Synthetic text."""

    async def run_to_roleplay(self) -> SimpleNamespace:
        run = await self.start_interview()
        await self.advance_to_transition(run)
        await self.until(lambda: run.interview.machine.phase is R1Phase.TRANSITION)
        brief = run.interview.render_line(run.interview._thanked_brief_id())
        await self.until(lambda: ("play_end", brief) in self.order)
        await self.settle()
        run.session.emit("user_input_transcribed", final_event("Okay, I'm ready."))
        pickup = run.interview.render_line("L-PICKUP")
        await self.until(lambda: ("play_end", pickup) in self.order)
        await self.until(lambda: run.interview.machine.phase is R1Phase.ROLEPLAY)
        await self.settle()
        return run

    async def test_the_consent_committed_after_the_pickup_gets_no_learner_reply(self) -> None:
        run = await self.run_to_roleplay()
        spoken = len(run.session.spoken)
        with self.capture_logs() as logs:
            suppressed = await self.commit_turn("Okay, I'm ready.", agent=R1Agent(run.interview))
        self.assertTrue(suppressed)
        self.assertEqual(len(run.session.spoken), spoken)
        self.assertIn("r1_consent_echo_dropped", error_types(logs))
        # The advisor's real opening is the learner's first turn.
        run.clock.advance(5)
        self.assertFalse(
            await self.commit_turn(
                "Hi Meera, this is Asha from the course team.", agent=R1Agent(run.interview)
            )
        )
        await self.drain_cancel(run)

    async def test_an_advisor_opening_that_ends_in_let_s_begin_is_answered(self) -> None:
        # Review of PR #429 (A1): the wide consent reading took "Hi Meera! Okay, let's begin."
        # (committed inside the echo window) for the late consent and the learner said nothing.
        run = await self.run_to_roleplay()
        with self.capture_logs() as logs:
            suppressed = await self.commit_turn(
                "Hi Meera! Okay, let's begin.", agent=R1Agent(run.interview)
            )
        self.assertFalse(suppressed)
        self.assertNotIn("r1_consent_echo_dropped", error_types(logs))
        await self.drain_cancel(run)

    async def test_with_the_flag_off_the_consent_is_a_role_play_turn(self) -> None:
        with mock.patch.dict(os.environ, {"R1_CONSENT_ECHO_DROP": "0"}):
            run = await self.run_to_roleplay()
            self.assertFalse(
                await self.commit_turn("Okay, I'm ready.", agent=R1Agent(run.interview))
            )
            await self.drain_cancel(run)

    async def test_a_consent_long_after_the_pickup_is_the_advisor_s(self) -> None:
        run = await self.run_to_roleplay()
        run.clock.advance(r1_session.ROLEPLAY_CONSENT_ECHO_SECONDS + 5)
        run.session.emit("user_input_transcribed", final_event("Okay, ready when you are."))
        await self.settle()
        self.assertFalse(
            await self.commit_turn("Okay, ready when you are.", agent=R1Agent(run.interview))
        )
        await self.drain_cancel(run)


class TestHungRolePlayRetry(R1TestCase):
    """D5-RELIAB1 (R1_LLM_RECOVERY_V2): the first hung role-play reply in a row is asked for once
    more; a retry that hangs too, and a second hang in a row, get the learner's holding line, and
    the third hang in a row still aborts (synthetic text only)."""

    @staticmethod
    def hung(_messages):
        async def stream():
            await asyncio.Event().wait()
            yield "never"

        return stream()

    async def hang(self, text: str = "Hi, this is the Program Advisor. Thanks for taking my call."):
        """One role-play turn whose model reply hangs past its deadline (nothing said)."""
        self.interview.prepare_turn(text, f"msg_{next(_IDS)}")
        stream = self.interview.llm_node_stream(SimpleNamespace(items=[]), self.hung)
        with self.assertRaises(TimeoutError):
            async for _ in stream:
                pass
        return self.interview._last_reply

    async def again(self) -> None:
        """The SDK calls the LLM node for the retry speech: the same prepared reply hangs again."""
        stream = self.interview.llm_node_stream(SimpleNamespace(items=[]), self.hung)
        with self.assertRaises(TimeoutError):
            async for _ in stream:
                pass

    def patched(self):
        return (
            mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.05),
            mock.patch.object(r1_session, "LLM_RETRY_DEADLINE_SECONDS", 0.05),
            mock.patch.object(r1_session, "FILLER_AFTER_SECONDS", 5.0),
        )

    def holding(self) -> list[str]:
        return [text for text in self.session.spoken if text in FALLBACK_REPLIES]

    async def test_one_retry_then_the_holding_line(self) -> None:
        self.enter_roleplay()
        a, b, c = self.patched()
        with a, b, c, self.capture_logs() as logs:
            reply = await self.hang()
            await self.until(lambda: len(self.session.generated) == 1)
            self.assertTrue(reply.retry)
            self.assertEqual(self.interview._failures, 1)
            self.assertEqual(self.holding(), [])  # no recovery line: the retry is under way
            self.assertNotIn(FALLBACK_REPLY, self.session.spoken)
            await self.again()  # the retry hangs as well
            await self.until(lambda: len(self.holding()) == 1)
        self.assertEqual(self.interview._failures, 1)  # the retry is not counted again
        self.assertIn("r1_llm_retry", error_types(logs))
        self.assertIn("r1_llm_recovery", error_types(logs))
        await self.flush()

    async def test_a_second_hang_in_a_row_gets_the_holding_line_and_a_third_aborts(self) -> None:
        self.enter_roleplay()
        a, b, c = self.patched()
        with a, b, c:
            await self.hang()
            await self.until(lambda: len(self.session.generated) == 1)
            await self.again()
            await self.until(lambda: len(self.holding()) == 1)
            await self.hang("Okay, so what made you look into data science?")
            self.assertEqual(self.interview._failures, 2)
            await self.until(lambda: len(self.holding()) == 2)
            self.assertEqual(len(self.session.generated), 1)  # no second retry
            self.assertEqual(len(set(self.holding())), 2)  # never the same holding line twice
            await self.hang("And how many hours a week could you give it?")
        self.assertEqual(self.interview._failures, 3)
        self.assertEqual(self.interview._stop_outcome(), "provider_error")
        await self.flush()

    async def test_a_retry_that_answers_never_resets_the_failure_count(self) -> None:
        self.enter_roleplay()
        a, b, c = self.patched()
        with a, b, c:
            await self.hang()
            await self.until(lambda: len(self.session.generated) == 1)
            stream = self.interview.llm_node_stream(
                SimpleNamespace(items=[]), lambda _messages: self_stream("Just exploring for now.")
            )
            spoken = "".join([chunk async for chunk in stream]).strip()
        self.assertEqual(spoken, "Just exploring for now.")
        self.assertEqual(self.interview._failures, 1)
        await self.flush()

    async def test_flag_off_speaks_todays_line_and_never_retries(self) -> None:
        self.enter_roleplay()
        a, b, c = self.patched()
        with a, b, c, mock.patch.dict(os.environ, {"R1_LLM_RECOVERY_V2": "0"}):
            await self.hang()
            await self.until(lambda: FALLBACK_REPLY in self.session.spoken)
        self.assertEqual(self.session.generated, [])
        await self.flush()

    # Review D5R-6 and D5R-7: the engine's bookkeeping across a retry, and the retry's timing.
    LINE = "Just exploring for now, honestly."

    def deliver_item(self, handle, text: str, *, interrupted: bool = False) -> None:
        message = FakeChatMessage(text, interrupted=interrupted)
        self.session.emit("conversation_item_added", SimpleNamespace(item=message))
        handle.chat_items.append(message)
        handle.interrupted = interrupted
        handle.finish()
        self.session.current_speech = None

    async def hang_spoken(self, *, filler_heard: bool):
        """A hung reply with its own speech: its filler was heard (an interrupted item) or not
        (the speech is cut before any word, so no item)."""
        text = "Hi, this is the Program Advisor. Thanks for taking my call."
        self.interview.prepare_turn(text, f"msg_{next(_IDS)}")
        handle = FakeSpeechHandle("hung")
        self.session.emit(
            "speech_created",
            SimpleNamespace(speech_handle=handle, source="generate_reply", user_initiated=False),
        )
        self.session.current_speech = handle
        self.agent_state("speaking")
        stream = self.interview.llm_node_stream(SimpleNamespace(items=[]), self.hung)
        with self.assertRaises(TimeoutError):
            async for _ in stream:
                pass
        if filler_heard:
            self.deliver_item(handle, "Hmm, let me think.", interrupted=True)
        else:
            handle.interrupted = True
            handle.finish()
            self.session.current_speech = None
        return self.interview._last_reply

    async def retry_heard(self) -> None:
        await self.until(lambda: len(self.session.generated) == 1)
        retry = self.session.generated[0]
        self.session.current_speech = retry
        self.agent_state("speaking")
        self.deliver_item(retry, self.LINE)
        self.agent_state("listening")
        await self.flush()

    async def record_once(self, *, filler_heard: bool) -> None:
        self.enter_roleplay()
        a, b, c = self.patched()
        engine = self.interview.engine
        with a, b, c, mock.patch.object(
            engine, "record_spoken", wraps=engine.record_spoken
        ) as record, mock.patch.object(engine, "reply_lost", wraps=engine.reply_lost) as lost:
            await self.hang_spoken(filler_heard=filler_heard)
            await self.retry_heard()
        self.assertEqual([call.args[1] for call in record.call_args_list], [self.LINE])
        self.assertEqual(lost.call_count, 0)
        self.assertIsNone(engine._lost_plan)

    async def test_the_retry_records_the_plan_once_after_a_heard_filler(self) -> None:
        await self.record_once(filler_heard=True)

    async def test_the_retry_records_the_plan_once_after_an_unheard_cut(self) -> None:
        await self.record_once(filler_heard=False)

    async def test_an_abandoned_retry_gives_the_plan_back(self) -> None:
        self.enter_roleplay()
        a, b, c = self.patched()
        engine = self.interview.engine
        with a, b, c, mock.patch.object(engine, "reply_lost", wraps=engine.reply_lost) as lost:
            self.interview._user_state = "speaking"  # the candidate has started talking again
            await self.hang_spoken(filler_heard=True)
            await self.flush()
            await self.flush()
        self.assertEqual(self.session.generated, [])  # nothing generated over the candidate
        self.assertEqual(self.holding(), [])
        self.assertEqual(lost.call_count, 1)

    async def test_the_retry_plays_no_second_filler(self) -> None:
        self.enter_roleplay()
        with mock.patch.object(r1_session, "TURN_DEADLINE_SECONDS", 0.05), mock.patch.object(
            r1_session, "LLM_RETRY_DEADLINE_SECONDS", 0.2
        ), mock.patch.object(r1_session, "FILLER_AFTER_SECONDS", 0.01):
            await self.hang()
            await self.until(lambda: len(self.session.generated) == 1)
            chunks: list = []
            stream = self.interview.llm_node_stream(SimpleNamespace(items=[]), self.hung)
            with self.assertRaises(TimeoutError):
                async for chunk in stream:
                    chunks.append(chunk)
        self.assertEqual(chunks, [])
        await self.flush()
