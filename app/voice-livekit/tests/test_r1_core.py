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
import r1_routing
import r1_session
from r1_guard import FALLBACK_REPLY
from r1_lines import INTERVIEWER_NAME, line, safe_first_name
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
        self.connect_error: BaseException | None = None
        self.connect_hangs = False
        self.delete_error: BaseException | None = None
        self.delete_hangs = False

    async def connect(self) -> None:
        self.connects += 1
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

    # The context a case's interview is built from: the persona (and so the lead's name and
    # city in the pickup and the transition line) is chosen from it.
    LINE_CONTEXT = {"first_name": "Asha", "candidate_identity": "candidate"}

    def spoken_line(self, line_id: str) -> str:
        """The line as the interview renders it (the persona fills the lead's name and city)."""
        return R1Interview(
            self.ctx, dict(self.LINE_CONTEXT), self.session, self.writer
        ).render_line(line_id)

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
        await self.until(lambda: interview.machine.phase is R1Phase.ICEBREAKER)
        return SimpleNamespace(
            interview=interview, context=context, session=session, clock=clock, task=task
        )

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
        self.assertEqual(NORMAL_PATH_MAX_SEC, 22 * 60 + 27)
        self.assertEqual(MAX_AGENT_RESIDENCY_SEC, 27 * 60 + 45)

    def test_manual_clock_exposes_hard_phase_budgets(self) -> None:
        clock = Clock()
        machine = R1PhaseMachine(clock)
        machine.transition(R1Phase.OPENING)
        machine.transition(R1Phase.ICEBREAKER)
        clock.advance(270)
        self.assertEqual(machine.remaining_icebreaker_seconds(), 0)
        machine.transition(R1Phase.TRANSITION)
        machine.transition(R1Phase.ROLEPLAY)
        clock.advance(840)
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
        self.assertEqual(machine.remaining_forced_close_seconds(), 1440 - 50)

    def test_roleplay_budget_is_the_smaller_of_the_r_budget_and_the_s_cap(self) -> None:
        clock = Clock()
        machine = R1PhaseMachine(clock)
        machine.transition(R1Phase.OPENING)
        machine.transition(R1Phase.ICEBREAKER)
        clock.advance(600)
        machine.transition(R1Phase.TRANSITION)
        machine.transition(R1Phase.ROLEPLAY)
        clock.advance(590)  # R = 590 (250 left), S = 1190 (10 left)
        self.assertEqual(machine.remaining_roleplay_seconds(), 10)
        self.assertEqual(machine.remaining_roleplay_cap_seconds(), 10)
        clock.advance(10)
        self.assertTrue(machine.roleplay_should_end())

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
                self.assertLessEqual(residency_seconds(), 1800)
        finally:
            os.environ.clear()
            os.environ.update(prior)

    def test_lines_and_llm_configuration_fail_closed(self) -> None:
        self.assertEqual(safe_first_name("not/a/name"), "there")
        self.assertIn(INTERVIEWER_NAME, line("L-OPEN", first_name="Asha"))
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

    def test_session_factory_keeps_browser_provider_defaults_without_turn_overrides(self) -> None:
        source = (HERE / "r1_session.py").read_text(encoding="utf-8")
        factory_start = source.index("async def _default_session_factory")
        factory_end = source.index("class _SpeechSlot")
        factory = source[factory_start:factory_end]
        self.assertIn('os.getenv("SARVAM_STT_MODEL", "saaras:v3")', factory)
        self.assertIn('os.getenv("SARVAM_LANGUAGE", "en-IN")', factory)
        self.assertIn('os.getenv("SARVAM_TTS_MODEL", "bulbul:v3")', factory)
        self.assertIn('os.getenv("SARVAM_TTS_VOICE", "simran")', factory)
        self.assertIn("pace=1.0", factory)
        self.assertIn("temperature=0.8", factory)
        self.assertNotIn("turn_handling", factory)
        self.assertNotIn("vad=", factory)

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
        ):
            with self.subTest(text=text):
                self.assertTrue(R1Interview.is_ready(text))
        for text in (
            "I am already prepared", "Unready", "What do I do?", "Who is she?", "Not sure yet.",
            "Yes, but what do I say?", "",
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

    async def test_mute_then_disconnect_then_rejoin_with_a_live_microphone_restores_roleplay(
        self,
    ) -> None:
        self.enter_roleplay()
        turn = asyncio.create_task(self.interview._roleplay_turn())
        await self.settle()
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)  # entered by the event itself
        await self.until(lambda: self.spoken_and_played("L-MUTE"))
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

    async def test_forced_close_at_s_24_minutes_is_scheduled_and_stops_the_wait(self) -> None:
        self.clock.advance(1439.95)  # S: 1439.95 s since activation
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
        self.assertEqual(first, self.spoken_line("L-FILLER-LEARNER") + " ")

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
        self.final_transcript("one")
        self.final_transcript("two")
        self.final_transcript("three")
        await self.hook()  # three turns: not yet the soft exit
        self.final_transcript("four")
        with self.assertRaises(r1_session.StopResponse):
            await self.hook()

    async def test_an_early_answer_spoken_over_the_opening_still_counts_as_a_turn(self) -> None:
        self.interview.machine.phase = R1Phase.OPENING
        self.final_transcript("I have been selling for six years")
        self.assertEqual(self.interview.machine.candidate_turns, 1)

    async def test_the_hard_icebreaker_deadline_ends_the_phase_without_a_reply(self) -> None:
        self.clock.advance(271)
        with self.assertRaises(r1_session.StopResponse):
            await self.hook()

    async def test_roleplay_replies_until_the_role_play_ends(self) -> None:
        self.enter_roleplay()
        await self.hook("my pitch")
        self.clock.advance(841)
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

    async def test_a_muted_microphone_pauses_the_countdown(self) -> None:
        self.enter_roleplay()
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        turn = asyncio.create_task(self.interview._await_turn(0.05))
        await self.until(lambda: self.spoken_and_played("L-MUTE"))
        await asyncio.sleep(0.2)  # four windows' worth of muted time
        self.assertFalse(turn.done())
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-MUTE")), 1)
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

    async def test_rp2_enters_aside_and_stays_there_on_terminal_silence(self) -> None:
        self.enter_roleplay()
        outcome = await asyncio.wait_for(
            self.interview._silence_ladder([("L-SIL-RP2", 0.01)]), 10.0
        )
        self.assertEqual(outcome, "candidate_left")
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)

    async def test_rp2_is_not_cut_short_by_the_paused_role_play_budget(self) -> None:
        self.enter_roleplay()
        self.clock.advance(839.0)  # S = 839 s: the S=20:00 cap still has 361 s
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
        self.clock.advance(835)  # 5 s of R left
        outcome = await self.interview._silence_ladder([("L-SIL-RP1", 20.0)])
        self.assertEqual(outcome, "phase_deadline")
        self.assertEqual(self.session.spoken, [])

    async def test_rp2_is_skipped_for_the_phase_end_when_no_role_play_time_is_left(self) -> None:
        self.enter_roleplay()
        self.clock.advance(840)
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

    async def test_roleplay_mute_speaks_aside_and_never_counts_down_silence(self) -> None:
        self.enter_roleplay()
        turn = asyncio.create_task(self.interview._roleplay_turn())
        await self.settle()
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        await self.until(lambda: self.spoken_and_played("L-MUTE"))
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)
        self.ctx.room.emit("track_unmuted", FakeParticipant("candidate"), FakePublication())
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)  # left by the event
        self.final_transcript("back now")
        self.assertIsNone(await asyncio.wait_for(turn, 10.0))
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-MUTE")), 1)
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

    async def test_transition_nudges_once_then_picks_up_on_ready(self) -> None:
        self.interview.machine.transition(R1Phase.TRANSITION)
        task = asyncio.create_task(self.interview._run_transition())
        await self.settle()
        self.final_transcript("what do I do?")
        await self.until(lambda: self.spoken_and_played("L-TRANSITION-NUDGE"))
        self.final_transcript("hmm, one more question")
        await self.settle()
        self.assertFalse(task.done())  # a second non-ready answer is not a pickup
        self.final_transcript("ok, ready")
        self.assertIsNone(await asyncio.wait_for(task, 10.0))
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-TRANSITION-NUDGE")), 1)
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-PICKUP")), 1)
        order = [text for text in self.session.spoken]
        self.assertLess(
            order.index(self.spoken_line("L-TRANSITION-NUDGE")),
            order.index(self.spoken_line("L-PICKUP")),
        )

    async def test_transition_without_an_answer_picks_up_after_the_deadline(self) -> None:
        self.interview.machine.transition(R1Phase.TRANSITION)
        with mock.patch.object(r1_session, "TRANSITION_DEADLINE_SECONDS", 0.05):
            self.assertIsNone(await asyncio.wait_for(self.interview._run_transition(), 10.0))
        self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])

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

    async def test_a_muted_candidate_cannot_stall_the_icebreaker_past_its_deadline(self) -> None:
        self.mute_candidate()
        budget = self.shrinking(0.15)
        with mock.patch.object(
            self.interview.machine, "remaining_icebreaker_seconds", budget
        ), mock.patch.object(
            self.interview.machine, "icebreaker_should_end", lambda: budget() <= 0
        ):
            self.assertIsNone(await asyncio.wait_for(self.interview._run_icebreaker(), 10.0))
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-MUTE")), 1)

    async def test_a_muted_candidate_cannot_stall_the_transition(self) -> None:
        self.interview.machine.transition(R1Phase.TRANSITION)
        self.mute_candidate()
        with mock.patch.object(r1_session, "TRANSITION_DEADLINE_SECONDS", 0.1):
            self.assertIsNone(await asyncio.wait_for(self.interview._run_transition(), 10.0))
        self.assertIn(self.spoken_line("L-PICKUP"), self.session.spoken)

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

    async def test_a_candidate_turn_is_recorded_at_event_time_even_if_nobody_waits(self) -> None:
        self.final_transcript("spoken while the driver was busy")
        await self.flush()
        self.assertEqual(self.writer.saved[0]["text"], "spoken while the driver was busy")
        self.assertEqual(self.writer.saved[0]["phase"], "icebreaker")

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
            self.final_transcript("hello")
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
        interview = R1Interview(
            context,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            FakeSession(log=self.order),
            self.writer,
            clock=run_clock,
            recorder_finish=lambda: append(self.order, "recording"),
        )
        task = asyncio.create_task(interview.run())
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
        await self.until(lambda: ("play_start", self.spoken_line("L-OPEN")) in self.order)
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

    async def test_pre_join_to_complete_with_each_line_persisted_exactly_once(self) -> None:
        task = asyncio.create_task(
            run_r1_session(self.ctx, session_factory=self.session_factory)
        )
        # OPENING: activation happened first, the session started, and the driver spoke L-OPEN.
        await self.until(lambda: self.spoken_and_played("L-OPEN"))
        names = [item if isinstance(item, str) else item[0] for item in self.order]
        self.assertLess(names.index("activate"), names.index("start"))
        self.assertLess(names.index("start"), names.index("play_start"))
        self.assertNotIn("terminal", names)  # nothing settles before the interview ran
        self.assertIsInstance(self.session.agent, R1Agent)
        # ICEBREAKER: four candidate turns at S >= 3:30 end it at the next boundary.
        await self.until(lambda: self._machine_phase() is R1Phase.ICEBREAKER)
        self.clock.advance(215)
        for answer in ("I sold courses", "to working professionals", "mostly by phone", "yes"):
            self.final_transcript(answer)  # counted and queued synchronously, at event time
        # TRANSITION then READY then the pickup, then ROLEPLAY.  The candidate answers
        # only after the line has finished playing, as a real candidate would.
        await self.candidate_replies_after("L-TRANSITION", "ready")
        await self.until(lambda: self.spoken_and_played("L-PICKUP"))
        await self.until(lambda: self._machine_phase() is R1Phase.ROLEPLAY)
        # ROLEPLAY ends on R = 14:00; the exit and wrap-up lines follow.
        self.clock.advance(841)
        self.final_transcript("let me summarise the offer")
        with mock.patch.object(r1_session, "WRAPUP_SETTLE_SECONDS", 0.05):
            await self.candidate_replies_after("L-WRAP", "No questions, thanks")
            self.assertEqual(await asyncio.wait_for(task, 10.0), "complete")

        expected_lines = ["L-OPEN", "L-TRANSITION", "L-PICKUP", "L-EXIT", "L-WRAP", "L-CLOSE"]
        self.assertEqual(self.session.spoken, [self.spoken_line(name) for name in expected_lines])
        phases = {row["text"]: row["phase"] for row in self.bot_rows()}
        self.assertEqual(
            [phases[self.spoken_line(name)] for name in expected_lines],
            ["opening", "transition", "transition", "roleplay_exit", "wrapup", "closing"],
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

    async def drive_to_the_wrapup(self) -> asyncio.Task:
        """Run the real session until the wrap-up question has been asked."""
        task = asyncio.create_task(
            run_r1_session(self.ctx, session_factory=self.session_factory)
        )
        await self.until(lambda: self._machine_phase() is R1Phase.ICEBREAKER)
        self.clock.advance(215)
        for answer in ("I sold courses", "to working professionals", "mostly by phone", "yes"):
            self.final_transcript(answer)
        await self.candidate_replies_after("L-TRANSITION", "ready")
        await self.until(lambda: self._machine_phase() is R1Phase.ROLEPLAY)
        self.clock.advance(841)
        self.final_transcript("let me summarise the offer")
        await self.until(lambda: self.spoken_and_played("L-WRAP"))
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
        await self.until(lambda: self._machine_phase() is R1Phase.ICEBREAKER)
        self.clock.advance(215)
        for answer in ("I sold courses", "to working professionals", "mostly by phone", "yes"):
            self.final_transcript(answer)
        await self.candidate_replies_after("L-TRANSITION", "ready")
        await self.until(lambda: self._machine_phase() is R1Phase.ROLEPLAY)
        with mock.patch.object(r1_session, "rejoin_grace_seconds", return_value=0.05):
            self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
            self.assertEqual(await asyncio.wait_for(task, 10.0), "candidate_left")
        self.assertEqual(self.writer.terminals, [("candidate_left", {"activated": True})])
        self.assertEqual(self.writer.outcomes, ["candidate_left"])

    def _machine_phase(self):
        # run_r1_session builds its own interview; the agent holds a reference to it.
        agent = self.session.agent
        return agent.interview.machine.phase if agent is not None else None

    async def test_the_icebreaker_prompt_waits_for_the_opening_to_finish_playing(self) -> None:
        self.session.playout_seconds = 0.15
        with mock.patch.object(r1_session, "ICEBREAKER_PROMPT_SECONDS", 0.05):
            task = asyncio.create_task(
                run_r1_session(self.ctx, session_factory=self.session_factory)
            )
            await self.until(lambda: self.spoken_line("L-SIL-IB") in self.session.spoken)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        events = [item for item in self.order if not isinstance(item, str)]
        open_end = events.index(("play_end", self.spoken_line("L-OPEN")))
        prompt_start = events.index(("play_start", self.spoken_line("L-SIL-IB")))
        self.assertLess(open_end, prompt_start)

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
        for text in ("Yes.", "Let's start.", "Go ahead.", "Sure!", "Let’s start", "OK."):
            with self.subTest(text=text):
                await self.asyncSetUp()
                self.interview.machine.transition(R1Phase.TRANSITION)
                task = asyncio.create_task(self.interview._run_transition())
                await self.settle()
                self.final_transcript(text)
                # Not the 20 s TRANSITION_DEADLINE_SECONDS: the answer itself is the pickup.
                self.assertIsNone(await asyncio.wait_for(task, 5.0))
                self.assertEqual(self.session.spoken, [self.spoken_line("L-PICKUP")])


class TestIcebreakerEndRace(R1TestCase):
    """The soft exit (four turns, S >= 3:30) is judged twice: at the transcript and at end of turn.

    The driver judges the transcript, the SDK judges the end of the same turn some 0.3-1.5 s
    later.  When S crosses 3:30 in between, the reply is suppressed and the driver must be told.
    """

    async def four_turns_with_the_soft_exit_due_in_between(self) -> asyncio.Task:
        self.clock.advance(209.6)
        task = asyncio.create_task(self.interview._run_icebreaker())
        await self.settle()
        for answer in ("one", "two", "three", "four"):
            self.final_transcript(answer)  # the 4th lands at S = 209.6: not over yet
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
                None, SimpleNamespace(text_content="four", id="msg_race")
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
        await self.until(lambda: interview.machine.phase is R1Phase.ICEBREAKER)
        clock.advance(209.6)
        for answer in ("one", "two", "three", "four"):
            session.emit("user_input_transcribed", final_event(answer))
            await self.settle()
        clock.advance(0.6)
        agent = R1Agent(interview)
        with self.assertRaises(r1_session.StopResponse):
            await agent.on_user_turn_completed(
                None, SimpleNamespace(text_content="four", id="msg_race")
            )
        await self.until(lambda: interview.machine.phase is R1Phase.TRANSITION)
        await self.until(
            lambda: ("play_end", interview.render_line("L-TRANSITION")) in self.order
        )
        self.assertNotIn(interview.render_line("L-SIL-IB"), session.spoken)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_no_silence_prompt_is_spoken_once_the_soft_exit_is_due(self) -> None:
        self.clock.advance(215)
        for answer in ("one", "two", "three", "four"):
            self.final_transcript(answer)
        outcome = await self.interview._silence_ladder([("L-SIL-IB", 20.0)])
        self.assertEqual(outcome, "phase_deadline")
        self.assertEqual(self.session.spoken, [])

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


class TestIcebreakerNote(unittest.TestCase):
    """The icebreaker prompt tells the model never to start or announce the role-play."""

    def test_the_icebreaker_and_opening_replies_carry_the_note(self) -> None:
        from r1_personas import resolve_persona
        from r1_prompts import GETTING_TO_KNOW_YOU_NOTE, interviewer_prefix
        from r1_replies import Reply, llm_messages

        persona = resolve_persona("p1_career_switcher", variant="v1")
        for phase in ("opening", "icebreaker"):
            with self.subTest(phase=phase):
                messages = llm_messages(
                    Reply(phase=phase, candidate_text="I sell courses."), persona, []
                )
                self.assertEqual(
                    messages[0], {"role": "system", "content": interviewer_prefix()}
                )  # the cache prefix is untouched
                self.assertEqual(
                    messages[-2], {"role": "system", "content": GETTING_TO_KNOW_YOU_NOTE}
                )
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
        ):
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
        await self.interview._speak_recovery(R1Phase.TRANSITION)  # not a model-reply phase
        self.assertEqual(self.session.spoken, [])
        self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
        self.enter_roleplay_from_transition()
        await self.interview._speak_recovery(R1Phase.ROLEPLAY)
        self.assertEqual(self.session.spoken, [])

    def enter_roleplay_from_transition(self) -> None:
        self.interview.machine.transition(R1Phase.ROLEPLAY)


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
        self.assertEqual(
            self.ctx.room.local_participant.attributes,
            [{"phase": value} for value in ("transition", "roleplay", "roleplay_exit", "wrapup")],
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
        self.assertEqual(sent, [{"phase": "transition"}, {"phase": "roleplay"}])

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
