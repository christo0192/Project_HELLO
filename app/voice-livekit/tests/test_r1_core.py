"""Unit tests for R1's isolated event driver and persistence contracts.

These use named fakes rather than an SDK shim: the real LiveKit 1.6.4 shapes
are asserted separately in ``test_r1_sdk_contract``.
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_context
import r1_llm
import r1_persistence
import r1_session
from r1_lines import INTERVIEWER_NAME, line, safe_first_name
from r1_persistence import OUTCOME_DISPOSITIONS, R1TurnWriter
from r1_phases import MAX_AGENT_RESIDENCY_SEC, NORMAL_PATH_MAX_SEC, R1Phase, R1PhaseMachine
from r1_session import (
    SILENCE,
    STOP,
    TURN,
    R1Interview,
    bounded_seconds,
    rejoin_grace_seconds,
    residency_seconds,
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


class FakePlayout:
    """Completed speech handle returned from fake ``say`` calls."""

    async def wait_for_playout(self) -> None:
        return None


class FakeSession(Emitter):
    """Session fake that records speech, starts, interrupts, and event registration."""

    def __init__(self, *, raise_on_say: bool = False) -> None:
        super().__init__()
        self.spoken: list[str] = []
        self.started: dict | None = None
        self.interrupts = 0
        self.raise_on_say = raise_on_say

    def say(self, text: str, **_kwargs) -> FakePlayout:
        if self.raise_on_say:
            raise RuntimeError("tts unavailable")
        self.spoken.append(text)
        return FakePlayout()

    async def start(self, agent, **kwargs) -> None:
        self.agent = agent
        self.started = kwargs

    async def interrupt(self, *, force: bool = False) -> None:
        self.interrupts += int(force)


@dataclass
class FakeParticipant:
    """Minimal remote participant with the LiveKit identity/kind fields used by R1."""

    identity: str
    kind: object = STANDARD


@dataclass
class FakePublication:
    """Minimal publication carrying the two properties in the mute filter."""

    kind: object = AUDIO
    source: object = MICROPHONE


class FakeRoom(Emitter):
    """Room fake with a candidate map matching ``Room.remote_participants``."""

    def __init__(self) -> None:
        super().__init__()
        self.name = "screening-00000000-0000-0000-0000-000000000000"
        self.remote_participants: dict[str, FakeParticipant] = {}


class FakeContext:
    """Job context fake exposing room close and the real SDK shutdown registration seam."""

    def __init__(self) -> None:
        self.room = FakeRoom()
        self.closed = 0
        self.shutdown_callbacks: list = []

    async def close_room(self) -> None:
        self.closed += 1

    def add_shutdown_callback(self, callback) -> None:
        self.shutdown_callbacks.append(callback)


class FakeWriter:
    """Writer fake that exposes the mandatory exit order as a concise list."""

    def __init__(self, order: list[str]) -> None:
        self.order = order
        self.saved: list[tuple] = []

    async def save_turn(self, *args, **_kwargs) -> None:
        self.saved.append(args)

    async def usage_disconnect(self, *_args) -> None:
        self.order.append("ledger")

    async def terminal(self, *_args) -> None:
        self.order.append("terminal")

    async def attempt_outcome(self, *_args) -> None:
        self.order.append("outcome")


async def append(items: list[str], value: str) -> None:
    """Append from an injected async recorder finisher."""
    items.append(value)


class R1TestCase(unittest.IsolatedAsyncioTestCase):
    """Build an interview whose candidate has already passed the standard-kind filter."""

    async def asyncSetUp(self) -> None:
        self.clock = Clock()
        self.order: list[str] = []
        self.ctx = FakeContext()
        self.session = FakeSession()
        self.interview = R1Interview(
            self.ctx,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            self.session,
            FakeWriter(self.order),
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
        factory_end = source.index("class R1Interview")
        factory = source[factory_start:factory_end]
        self.assertIn('os.getenv("SARVAM_STT_MODEL", "saaras:v3")', factory)
        self.assertIn('os.getenv("SARVAM_LANGUAGE", "en-IN")', factory)
        self.assertIn('os.getenv("SARVAM_TTS_MODEL", "bulbul:v3")', factory)
        self.assertIn('os.getenv("SARVAM_TTS_VOICE", "simran")', factory)
        self.assertIn("pace=1.0", factory)
        self.assertIn("temperature=0.8", factory)
        self.assertNotIn("turn_handling", factory)
        self.assertNotIn("vad=", factory)


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

    async def test_attention_wakes_a_long_turn_wait_for_job_shutdown(self) -> None:
        waiter = asyncio.create_task(self.interview._await_turn(30.0))
        await asyncio.sleep(0)
        await self.ctx.shutdown_callbacks[0]("drain")
        self.assertEqual(await asyncio.wait_for(waiter, 0.2), (STOP, "shutdown_forced"))

    async def test_job_shutdown_uses_system_closing_line_before_finishing(self) -> None:
        self.enter_roleplay()
        await self.ctx.shutdown_callbacks[0]("drain")
        outcome = await self.interview._handle_attention()
        await self.interview._finish(outcome or "provider_error", system=True)
        self.assertEqual(outcome, "shutdown_forced")
        self.assertEqual(self.interview.machine.phase, R1Phase.FINISHING)
        self.assertTrue(any("technical problem" in speech for speech in self.session.spoken))

    async def test_residency_deadline_wakes_a_long_turn_wait(self) -> None:
        waiter = asyncio.create_task(self.interview._await_turn(30.0))
        await asyncio.sleep(0)
        self.interview._on_residency_deadline()
        self.assertEqual(await asyncio.wait_for(waiter, 0.2), (STOP, "residency_timeout"))

    async def test_provider_401_aborts_immediately(self) -> None:
        error = type("ProviderError", (), {"status_code": 401})()
        event = type("ProviderEvent", (), {"error": error})()
        self.session.emit("close", event)
        self.assertEqual(await self.interview._handle_attention(), "provider_error")

    async def test_speaking_resets_consecutive_generation_failures(self) -> None:
        self.interview._record_generation_failure()
        self.interview._record_generation_failure()
        self.session.emit("agent_state_changed", type("State", (), {"new_state": "speaking"})())
        self.assertEqual(self.interview._failures, 0)

    async def test_watchdog_interrupts_a_twelve_second_generation_overrun(self) -> None:
        async def immediate_sleep(_seconds: float) -> None:
            return None

        self.interview._reply_active = True
        with mock.patch.object(r1_session.asyncio, "sleep", immediate_sleep):
            await self.interview._watch_turn()
        self.assertEqual(self.session.interrupts, 1)
        self.assertEqual(self.interview._failures, 1)


class TestExitInvariant(R1TestCase):
    """Exit tests cover cancellation and speech failure, the two former persistence holes."""

    async def test_exit_order_is_recording_ledger_terminal_outcome_then_room(self) -> None:
        await self.interview._exit("provider_error")
        await self.interview._exit("provider_error")
        self.assertEqual(self.order, ["recording", "ledger", "terminal", "outcome"])
        self.assertEqual(self.ctx.closed, 1)

    async def test_cancellation_mid_roleplay_runs_exit_once(self) -> None:
        # Skip the bounded icebreaker clock so the real driver enters its
        # role-play wait before this task is cancelled.
        context = FakeContext()
        context.room.remote_participants["candidate"] = FakeParticipant("candidate")
        run_clock = Clock()
        interview = R1Interview(
            context,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            FakeSession(),
            FakeWriter(self.order),
            clock=run_clock,
            recorder_finish=lambda: append(self.order, "recording"),
        )
        run_clock.advance(270)
        task = asyncio.create_task(interview.run())
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.order, ["recording", "ledger", "terminal", "outcome"])
        self.assertEqual(context.closed, 1)

    def final_transcript(self, text: str) -> None:
        event = type("Transcribed", (), {"is_final": True, "transcript": text})()
        self.session.emit("user_input_transcribed", event)

    def spoken_line(self, line_id: str) -> str:
        return line(line_id, first_name="Asha")

    async def test_roleplay_departure_waits_for_rejoin_instead_of_silence(self) -> None:
        self.enter_roleplay()
        turn = asyncio.create_task(self.interview._roleplay_turn())
        await asyncio.sleep(0.01)
        self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
        await asyncio.sleep(0.01)
        self.assertIs(self.interview.machine.phase, R1Phase.PAUSED_DISCONNECTED)
        self.ctx.room.emit("participant_connected", FakeParticipant("candidate"))
        await asyncio.sleep(0.01)
        self.final_transcript("sorry, my wifi dropped")
        self.assertIsNone(await asyncio.wait_for(turn, 1.0))
        self.assertIn(self.spoken_line("L-REJOIN"), self.session.spoken)
        self.assertNotIn(self.spoken_line("L-SIL-RP1"), self.session.spoken)
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)

    async def test_roleplay_departure_past_grace_ends_without_silence_prompt(self) -> None:
        self.enter_roleplay()
        with mock.patch.object(r1_session, "rejoin_grace_seconds", return_value=0.01):
            turn = asyncio.create_task(self.interview._roleplay_turn())
            await asyncio.sleep(0.01)
            self.ctx.room.emit("participant_disconnected", FakeParticipant("candidate"))
            self.assertEqual(await asyncio.wait_for(turn, 1.0), "candidate_left")
        self.assertNotIn(self.spoken_line("L-SIL-RP1"), self.session.spoken)

    async def test_roleplay_mute_speaks_aside_and_never_counts_down_silence(self) -> None:
        self.enter_roleplay()
        turn = asyncio.create_task(self.interview._roleplay_turn())
        await asyncio.sleep(0.01)
        self.ctx.room.emit("track_muted", FakeParticipant("candidate"), FakePublication())
        await asyncio.sleep(0.01)
        self.assertIs(self.interview.machine.phase, R1Phase.ASIDE)
        self.ctx.room.emit("track_unmuted", FakeParticipant("candidate"), FakePublication())
        await asyncio.sleep(0.01)
        self.assertIs(self.interview.machine.phase, R1Phase.ROLEPLAY)
        self.final_transcript("back now")
        self.assertIsNone(await asyncio.wait_for(turn, 1.0))
        self.assertEqual(self.session.spoken.count(self.spoken_line("L-MUTE")), 1)
        self.assertNotIn(self.spoken_line("L-SIL-RP1"), self.session.spoken)

    async def test_nonterminal_wakeup_is_not_treated_as_silence(self) -> None:
        self.enter_roleplay()
        waiter = asyncio.create_task(self.interview._await_turn(30.0))
        await asyncio.sleep(0.01)
        self.interview._record_generation_failure()
        await asyncio.sleep(0.01)
        self.assertFalse(waiter.done())
        self.final_transcript("I am still here")
        self.assertEqual(await asyncio.wait_for(waiter, 1.0), (TURN, "I am still here"))

    async def test_transcript_racing_an_attention_signal_is_not_lost(self) -> None:
        self.interview.note_turn("hello")
        self.interview._attention.set()
        self.assertEqual(
            await self.interview._wait_for_turn_or_attention(1.0), ("turn", "hello")
        )
        self.assertTrue(self.interview._attention.is_set())

    async def test_silence_ladder_speaks_each_prompt_then_ends(self) -> None:
        self.enter_roleplay()
        outcome = await self.interview._silence_ladder([("L-SIL-RP1", 0.01), ("L-SIL-RP2", 0.01)])
        self.assertEqual(outcome, "candidate_left")
        tail = self.session.spoken[-3:]
        self.assertEqual(
            tail,
            [self.spoken_line("L-SIL-RP1"), self.spoken_line("L-SIL-RP2"),
             self.spoken_line("L-SIL-END")],
        )

    async def test_silence_ladder_stops_when_the_candidate_answers(self) -> None:
        self.enter_roleplay()
        ladder = asyncio.create_task(self.interview._silence_ladder([("L-SIL-RP1", 1.0)]))
        await asyncio.sleep(0.01)
        self.final_transcript("yes, sorry")
        self.assertIsNone(await asyncio.wait_for(ladder, 1.0))
        self.assertNotIn(self.spoken_line("L-SIL-END"), self.session.spoken)

    async def test_await_turn_reports_real_silence(self) -> None:
        self.assertEqual(await self.interview._await_turn(0.01), (SILENCE, None))

    async def test_cancellation_before_join_stays_a_cancellation(self) -> None:
        context = FakeContext()
        interview = R1Interview(
            context,
            {"first_name": "Asha", "candidate_identity": "candidate"},
            FakeSession(),
            FakeWriter(self.order),
            recorder_finish=lambda: append(self.order, "recording"),
        )
        task = asyncio.create_task(interview.run())
        await asyncio.sleep(0.01)
        self.assertIs(interview.machine.phase, R1Phase.PRE_JOIN)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertIs(interview.machine.phase, R1Phase.FINISHING)
        self.assertEqual(self.order, ["recording", "ledger", "terminal", "outcome"])
        self.assertEqual(context.closed, 1)

    async def test_closing_speech_failure_still_runs_full_exit_order(self) -> None:
        self.session.raise_on_say = True
        await self.interview._finish("provider_error", system=True)
        await self.interview._exit("provider_error")
        self.assertEqual(self.order, ["recording", "ledger", "terminal", "outcome"])
        self.assertEqual(self.ctx.closed, 1)


class TestPersistence(unittest.IsolatedAsyncioTestCase):
    """The attempt-outcome seam must stay fail-soft while PR-3's route is absent."""

    async def test_attempt_outcome_404_is_nonfatal(self) -> None:
        def missing_route(*_args):
            raise HTTPError("https://internal", 404, "not found", {}, None)

        writer = R1TurnWriter(
            "00000000-0000-0000-0000-000000000000",
            "screening-x",
            requester=missing_route,
        )
        await writer.attempt_outcome("complete")


class TestR1Context(unittest.IsolatedAsyncioTestCase):
    """Context lookup has no permissive fallback to room metadata."""

    async def test_context_fetch_rejects_transport_failure(self) -> None:
        def unavailable(*_args):
            raise OSError("offline")

        with self.assertRaises(r1_context.R1ContextError):
            await r1_context.fetch_context("screening-x", requester=unavailable)


class TestPhoneIsolation(unittest.TestCase):
    """The shared entrypoint must return from phone before lazily importing any R1 module."""

    def test_phone_early_return_precedes_r1_lazy_import(self) -> None:
        source = (HERE / "agent.py").read_text(encoding="utf-8")
        entrypoint = source.index("async def entrypoint")
        phone_branch = source.index("if _phone_agent_name():", entrypoint)
        r1_import = source.index("import r1_session", phone_branch)
        self.assertLess(source.index("return", phone_branch), r1_import)
        self.assertNotIn("import r1_", source[:entrypoint])

    def test_r1_worker_drain_values_are_bounded_without_changing_phone_options(self) -> None:
        source = (HERE / "agent.py").read_text(encoding="utf-8")
        r1_branch = source.index('if os.getenv("R1_LANE_MODE") == "r1_only":')
        browser_name_branch = source.index("if browser_named:", r1_branch)
        r1_options = source[r1_branch:browser_name_branch]
        self.assertIn('_bounded_float_env("R1_DRAIN_TIMEOUT_SEC", 60.0, 30.0, 60.0)', r1_options)
        self.assertIn(
            '_bounded_float_env("R1_SHUTDOWN_PROCESS_TIMEOUT_SEC", 90.0, 30.0, 90.0)',
            r1_options,
        )
