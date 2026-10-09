"""M014 PR-B: the livekit-agents 1.6.4 behaviours the per-question minimum relies on.

Run against the REAL SDK, in CI's "Endpointing real-SDK contract" step (a venv
with requirements.txt, ``ENDPOINTING_SDK_CONTRACT_REQUIRED=1``, a skip is a
failure). The bare-python worker step stubs the SDK, so there these tests skip.

What `endpointing_phase` and its wiring assume, and where (endpointing_phase.py /
agent.py):

1. ``AgentSession.update_options(endpointing_opts={"min_delay": x})`` merges PER
   KEY into the session options AND reaches the running ``AudioRecognition``, so
   the per-question minimum does not clobber the consent turn's ``max_delay``
   update (and vice versa) (`_set_phase_min_delay`, `_set_consent_endpointing_max`);
2. the end-of-turn task reads ``self._endpointing.min_delay`` / ``.max_delay``
   when it RUNS (source pin), so a live update governs the next commit;
3. the reply-start silence gate reads ``options.endpointing["min_delay"] / 2``
   live (behaviour + source pin) while the VAD reports inference results with
   speech still active, BUT the SDK releases it unconditionally at the VAD's
   END_OF_SPEECH, and the deployed Silero VAD
   (``inference.VAD(model="silero")``, the only construction ``_build_phone_vad``
   uses) ends speech after ``min_silence_duration`` = 0.25 s. So the EFFECTIVE
   gate is ``min(min_delay / 2, 0.25)``: an open question's 0.8 s minimum moves
   a reply's start from 0.15 s to about 0.25 s of quiet, not to 0.4 s;
4. ``SpeechCreatedEvent.source`` is ``"say" | "generate_reply"``: how a generated
   reply is told from a spoken line; ``AgentSession.current_speech`` is the
   handle of the speech playing (how a deferral is bound to its own reply).

No candidate data: synthetic text and silent audio only.
"""

from __future__ import annotations

import inspect
import os
import pathlib
import time
import typing
import unittest

_REQUIRED = os.environ.get("ENDPOINTING_SDK_CONTRACT_REQUIRED") == "1"


def _real_sdk():
    """The real livekit-agents modules, or None (bare python / the test stub)."""
    try:
        import livekit.agents as agents  # noqa: PLC0415
        from livekit.agents import vad  # noqa: PLC0415
        from livekit.agents.voice import agent_activity, audio_recognition, events  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(getattr(agents, "__version__", None), str):
        return None  # the test stub
    return {
        "agents": agents, "vad": vad, "events": events,
        "agent_activity": agent_activity, "audio_recognition": audio_recognition,
    }


_SDK = _real_sdk()


def setUpModule():  # noqa: N802
    if _SDK is None:
        if _REQUIRED:
            raise RuntimeError(
                "ENDPOINTING_SDK_CONTRACT_REQUIRED=1 but the real livekit-agents SDK is not importable")
        raise unittest.SkipTest("real livekit-agents SDK not installed (bare-python CI step)")


class _ContractCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        agents = _SDK["agents"]
        self.agent = agents.Agent(instructions="contract test")
        self.session = agents.AgentSession()
        await self.session.start(self.agent)
        self.activity = self.session._activity  # noqa: SLF001
        self.recognition = self.activity._audio_recognition  # noqa: SLF001

    async def asyncTearDown(self) -> None:
        await self.session.aclose()


class TestPinnedVersion(unittest.TestCase):
    def test_the_pinned_sdk_is_what_these_contracts_were_measured_on(self):
        self.assertEqual(_SDK["agents"].__version__, "1.6.4")


class TestUpdateOptionsIsPerKey(_ContractCase):
    async def test_min_delay_alone_reaches_the_session_and_the_running_recognition(self):
        self.session.update_options(endpointing_opts={"max_delay": 2.0})
        self.session.update_options(endpointing_opts={"min_delay": 0.8})
        self.assertEqual(self.session.options.endpointing["min_delay"], 0.8)
        self.assertEqual(self.session.options.endpointing["max_delay"], 2.0)
        self.assertEqual(self.recognition._endpointing.min_delay, 0.8)  # noqa: SLF001
        self.assertEqual(self.recognition._endpointing.max_delay, 2.0)  # noqa: SLF001
        # The same recognition object keeps running (it is not rebuilt).
        self.assertIs(self.activity._audio_recognition, self.recognition)  # noqa: SLF001

    async def test_a_following_max_update_keeps_the_minimum(self):
        self.session.update_options(endpointing_opts={"min_delay": 0.8})
        self.session.update_options(endpointing_opts={"max_delay": 0.5})      # consent tightening
        self.assertEqual(self.session.options.endpointing["min_delay"], 0.8)
        self.assertEqual(self.recognition._endpointing.min_delay, 0.8)  # noqa: SLF001
        self.assertEqual(self.recognition._endpointing.max_delay, 0.5)  # noqa: SLF001
        self.session.update_options(endpointing_opts={"max_delay": 2.0})      # restored
        self.assertEqual(self.recognition._endpointing.min_delay, 0.8)  # noqa: SLF001
        self.assertEqual(self.recognition._endpointing.max_delay, 2.0)  # noqa: SLF001

    async def test_going_back_to_the_static_minimum_reaches_the_recognition(self):
        self.session.update_options(endpointing_opts={"min_delay": 0.8})
        self.session.update_options(endpointing_opts={"min_delay": 0.3})
        self.assertEqual(self.session.options.endpointing["min_delay"], 0.3)
        self.assertEqual(self.recognition._endpointing.min_delay, 0.3)  # noqa: SLF001

    def test_the_signature_takes_endpointing_opts(self):
        params = inspect.signature(_SDK["agents"].AgentSession.update_options).parameters
        self.assertIn("endpointing_opts", params)


class TestEndpointingIsReadWhenTheCommitTaskRuns(unittest.TestCase):
    def test_source_pin(self):
        source = inspect.getsource(_SDK["audio_recognition"].AudioRecognition._run_eou_detection)  # noqa: SLF001
        self.assertIn("endpointing_delay = self._endpointing.min_delay", source)
        self.assertIn("endpointing_delay = self._endpointing.max_delay", source)


class TestReplyStartSilenceGate(_ContractCase):
    def _inference(self, silence: float):
        vad = _SDK["vad"]
        return vad.VADEvent(
            type=vad.VADEventType.INFERENCE_DONE, samples_index=0, timestamp=time.time(),
            speech_duration=0.0, silence_duration=silence, speaking=True,
            raw_accumulated_silence=silence,
        )

    async def test_the_gate_follows_the_live_minimum_over_two(self):
        # Pins the SDK's FORMULA with synthetic inference events. The deployed
        # VAD never reports speaking=True beyond 0.25 s of silence (it emits
        # END_OF_SPEECH first, see TestTheDeployedVadBoundsTheGate), so in
        # production this gate is bounded at about 0.25 s.
        # 0.3 s of quiet inside active speech.
        self.session.update_options(endpointing_opts={"min_delay": 0.3})
        self.activity.on_vad_inference_done(self._inference(0.3))  # noqa: SLF001
        self.assertTrue(self.activity._user_silence_event.is_set(),  # noqa: SLF001
                        "0.3 > 0.3 / 2: a reply may start")
        self.session.update_options(endpointing_opts={"min_delay": 0.8})
        self.activity.on_vad_inference_done(self._inference(0.3))  # noqa: SLF001
        self.assertFalse(self.activity._user_silence_event.is_set(),  # noqa: SLF001
                         "0.3 <= 0.8 / 2: the reply still waits")
        self.activity.on_vad_inference_done(self._inference(0.45))  # noqa: SLF001
        self.assertTrue(self.activity._user_silence_event.is_set(),  # noqa: SLF001
                        "0.45 > 0.4: the reply may start")

    def test_source_pin(self):
        source = inspect.getsource(_SDK["agent_activity"].AgentActivity.on_vad_inference_done)
        self.assertIn('self._session.options.endpointing["min_delay"] / 2', source)


class TestTheDeployedVadBoundsTheGate(_ContractCase):
    """The effective reply-start gate is bounded by the VAD's end of speech."""

    def test_the_deployed_vad_ends_speech_after_0_25_s(self):
        from livekit.agents import inference  # noqa: PLC0415

        self.assertEqual(inference.VAD(model="silero").min_silence_duration, 0.25)
        # `_build_phone_vad` passes nothing but the model: the default stands.
        agent_source = (
            pathlib.Path(__file__).resolve().parent.parent / "agent.py"
        ).read_text(encoding="utf-8")
        self.assertIn('_observe_phone_vad(factory(model="silero"), on_event)', agent_source)

    async def test_end_of_speech_releases_the_gate_whatever_the_minimum_is(self):
        self.session.update_options(endpointing_opts={"min_delay": 0.8})
        self.activity.on_vad_inference_done(  # noqa: SLF001
            _SDK["vad"].VADEvent(
                type=_SDK["vad"].VADEventType.INFERENCE_DONE, samples_index=0,
                timestamp=time.time(), speech_duration=0.0, silence_duration=0.2,
                speaking=True, raw_accumulated_silence=0.2))
        self.assertFalse(self.activity._user_silence_event.is_set(),  # noqa: SLF001
                         "0.2 <= 0.8 / 2: the reply still waits")
        # The deployed VAD reports END_OF_SPEECH once 0.25 s of silence builds up.
        self.activity.on_end_of_speech(None)  # noqa: SLF001
        self.assertTrue(self.activity._user_silence_event.is_set(),  # noqa: SLF001
                        "END_OF_SPEECH releases the reply regardless of min_delay")

    def test_interruptible_replies_wait_on_the_silence_event(self):
        source = inspect.getsource(_SDK["agent_activity"].AgentActivity)
        self.assertIn("self._user_silence_event.wait()", source)


class TestCurrentSpeech(unittest.TestCase):
    def test_the_session_exposes_the_playing_speech_handle(self):
        self.assertIsInstance(
            _SDK["agents"].AgentSession.current_speech, property)


class TestSpeechCreatedSource(unittest.TestCase):
    def test_source_is_say_or_generate_reply(self):
        annotation = _SDK["events"].SpeechCreatedEvent.model_fields["source"].annotation
        self.assertEqual(set(typing.get_args(annotation)), {"say", "generate_reply"})


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
