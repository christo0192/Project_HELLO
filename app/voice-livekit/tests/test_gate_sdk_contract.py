"""M013 S01 (T13): the livekit-agents 1.6.4 behaviours the gate relies on.

Run against the REAL SDK, in CI's "Gate real-SDK contract" step (a venv with
requirements.txt, ``GATE_SDK_CONTRACT_REQUIRED=1``, a skip is a failure). The
bare-python worker step stubs the SDK, so there these tests skip.

What the gate assumes, and where (agent.py / gate_judge.py):

1. ``AgentSession.clear_user_turn()`` exists and runs on a live session
   (`_clear_sdk_user_turn` calls it at every gate question; if it vanished
   the gate would only log ``clear_user_turn_unavailable``);
2. a NON-interruptible ``say`` DROPS a user turn that completes while it plays
   (no chat item, no ``on_user_turn_completed``): the reason the gate captures
   STT finals itself (`gate_judge.GateTurnCapture`, the settle close);
3. ``user_state_changed`` -> speaking carries ``created_at`` = the speech
   START the activity reports, not the handler time (`_user_state_anchor_ms`);
4. ``VADEvent`` has ``speech_duration``, ``silence_duration`` and
   ``inference_duration`` (`GateTurnCapture.on_vad_event` times segments with
   them);
5. MEASURED (2026-10-07, 1.6.4): two back-to-back ``say()`` calls toggle the
   agent state speaking -> listening -> speaking between them. The split
   consent line relies on that toggle to raise the recording anchor to part
   B's first audio (`_GateRecordingAnchor.on_first_audio`); replays default to
   ``state_toggles=True`` for this reason, and the gate stays safe either way
   (the recording-sentence rule applies in every mode).

No candidate data: synthetic text and silent audio only.
"""

from __future__ import annotations

import asyncio
import dataclasses
import os
import time
import unittest

_REQUIRED = os.environ.get("GATE_SDK_CONTRACT_REQUIRED") == "1"


def _real_sdk():
    """The real livekit-agents modules, or None (bare python / the test stub)."""
    try:
        from livekit import rtc  # noqa: PLC0415
        import livekit.agents as agents  # noqa: PLC0415
        from livekit.agents import vad  # noqa: PLC0415
        from livekit.agents.voice import events, io as vio  # noqa: PLC0415
        from livekit.agents.voice import audio_recognition  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(getattr(agents, "__version__", None), str):
        return None  # the test stub
    return {
        "rtc": rtc, "agents": agents, "vad": vad, "events": events, "io": vio,
        "audio_recognition": audio_recognition,
    }


_SDK = _real_sdk()


def setUpModule():  # noqa: N802
    if _SDK is None:
        if _REQUIRED:
            raise RuntimeError(
                "GATE_SDK_CONTRACT_REQUIRED=1 but the real livekit-agents SDK is not importable")
        raise unittest.SkipTest("real livekit-agents SDK not installed (bare-python CI step)")


def _fake_audio_output():
    vio = _SDK["io"]

    class _FakeAudioOutput(vio.AudioOutput):
        """Plays instantly-captured frames out in real time; reports playout."""

        def __init__(self) -> None:
            super().__init__(label="contract", capabilities=vio.AudioOutputCapabilities(pause=False),
                             sample_rate=24000)
            self._pending = 0.0
            self._started = False
            self._tasks: set = set()

        async def capture_frame(self, frame) -> None:
            await super().capture_frame(frame)
            if not self._started:
                self._started = True
                self.on_playback_started(created_at=time.time())
            self._pending += frame.duration

        def flush(self) -> None:
            super().flush()
            duration, self._pending, self._started = self._pending, 0.0, False

            async def _finish() -> None:
                await asyncio.sleep(duration)
                self.on_playback_finished(playback_position=duration, interrupted=False)

            task = asyncio.ensure_future(_finish())
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

        def clear_buffer(self) -> None:
            self._pending = 0.0

    return _FakeAudioOutput()


async def _silence(seconds: float):
    rtc = _SDK["rtc"]
    rate, per = 24000, 480
    for _ in range(int(round(seconds / 0.02))):
        yield rtc.AudioFrame(b"\x00\x00" * per, rate, 1, per)


class _ContractCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        agents = _SDK["agents"]
        test = self

        class _Agent(agents.Agent):
            async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
                test.completed.append(new_message.text_content)

        self.completed: list = []
        self.agent = _Agent(instructions="contract test")
        self.session = agents.AgentSession()
        self.states: list = []
        self.user_states: list = []
        self.session.on("agent_state_changed",
                        lambda ev: self.states.append((ev.old_state, ev.new_state)))
        self.session.on("user_state_changed", self.user_states.append)
        self.session.output.audio = _fake_audio_output()
        await self.session.start(self.agent)

    async def asyncTearDown(self) -> None:
        await self.session.aclose()


class TestPinnedVersion(unittest.TestCase):
    def test_the_pinned_sdk_is_what_these_contracts_were_measured_on(self):
        self.assertEqual(_SDK["agents"].__version__, "1.6.4")


class TestClearUserTurn(_ContractCase):
    async def test_clear_user_turn_exists_and_runs_on_a_live_session(self):
        clear = getattr(self.session, "clear_user_turn", None)
        self.assertTrue(callable(clear))
        clear()  # must not raise while the session runs


class TestNonInterruptibleSayDropsACompletedTurn(_ContractCase):
    async def test_a_turn_completed_during_a_non_interruptible_say_is_dropped(self):
        ar = _SDK["audio_recognition"]
        handle = self.session.say("gate line", audio=_silence(1.0),
                                  allow_interruptions=False, add_to_chat_ctx=False)
        await asyncio.sleep(0.2)
        now = time.time()
        info = ar._EndOfTurnInfo(
            skip_reply=False, new_transcript="Yes.", transcript_confidence=1.0,
            metrics=ar._EndOfTurnMetrics(
                started_speaking_at=now - 0.6, stopped_speaking_at=now - 0.2,
                transcription_delay=0.1, end_of_turn_delay=0.2),
        )
        await self.session._activity._user_turn_completed_task(None, info)  # noqa: SLF001
        await handle.wait_for_playout()
        self.assertEqual(self.completed, [], "on_user_turn_completed ran for a dropped turn")
        users = [i for i in self.agent.chat_ctx.items if getattr(i, "role", None) == "user"]
        self.assertEqual(users, [], "the dropped turn reached the chat context")

    async def test_an_interruptible_say_does_not_drop_it(self):
        # Control: the same turn during an interruptible say is processed.
        ar = _SDK["audio_recognition"]
        handle = self.session.say("ordinary line", audio=_silence(1.0),
                                  allow_interruptions=True, add_to_chat_ctx=False)
        await asyncio.sleep(0.2)
        now = time.time()
        info = ar._EndOfTurnInfo(
            skip_reply=False, new_transcript="Yes.", transcript_confidence=1.0,
            metrics=ar._EndOfTurnMetrics(
                started_speaking_at=now - 0.6, stopped_speaking_at=now - 0.2,
                transcription_delay=0.1, end_of_turn_delay=0.2),
        )
        try:
            await asyncio.wait_for(
                self.session._activity._user_turn_completed_task(None, info), 5)  # noqa: SLF001
        except Exception:  # noqa: BLE001 — no LLM configured; the turn was still taken
            pass
        handle.interrupt()
        self.assertEqual(self.completed, ["Yes."])


class TestUserStateCarriesTheSpeechStart(_ContractCase):
    async def test_speaking_created_at_is_the_reported_speech_start(self):
        started = time.time() - 0.75
        self.session._activity.on_start_of_speech(None, speech_start_time=started)  # noqa: SLF001
        speaking = [e for e in self.user_states if e.new_state == "speaking"]
        self.assertTrue(speaking)
        self.assertAlmostEqual(speaking[-1].created_at, started, places=6)

    def test_the_event_type_declares_created_at(self):
        fields = _SDK["events"].UserStateChangedEvent.model_fields
        self.assertIn("created_at", fields)


class TestVadEventFields(unittest.TestCase):
    def test_vad_event_has_the_timing_fields(self):
        names = {f.name for f in dataclasses.fields(_SDK["vad"].VADEvent)}
        for name in ("speech_duration", "silence_duration", "inference_duration"):
            self.assertIn(name, names)


class TestBackToBackSayTogglesTheAgentState(_ContractCase):
    async def test_two_say_calls_toggle_speaking_listening_speaking(self):
        a = self.session.say("part A", audio=_silence(0.4),
                             allow_interruptions=False, add_to_chat_ctx=False)
        b = self.session.say("part B", audio=_silence(0.4),
                             allow_interruptions=False, add_to_chat_ctx=False)
        await a.wait_for_playout()
        await b.wait_for_playout()
        await asyncio.sleep(0.1)
        speaking_runs = [s for s in self.states if s == ("listening", "speaking")]
        self.assertEqual(len(speaking_runs), 2, self.states)
        self.assertIn(("speaking", "listening"), self.states[:-1])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
