"""R1's Sarvam providers (owner decision 2026-10-30): the voiced TTS, its fallback, the STT trial.

The SDK cases build the REAL plugin TTS with a dummy key and never touch the network (the
socket connect is patched to fail if anything tries).  They skip on bare CI and run, with no
skip allowed, in the ``Test R1 SDK contract`` step of ``quality.yml``.  The pure cases (the STT
setting, the module surface, the missing-SDK path) run everywhere.
"""
from __future__ import annotations

import ast
import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_sarvam
import r1_tts
from r1_tts import r1_tts_kwargs

try:
    from livekit.plugins import sarvam
    from livekit.agents.voice.agent_activity import _SpeechHandleContextVar
    from livekit.agents.voice.speech_handle import SpeechHandle
except ImportError:  # bare CI
    sarvam = None
    _SpeechHandleContextVar = SpeechHandle = None

VOICE_ENV = (
    "R1_TTS_PROFILE",
    "R1_TTS_INTERVIEWER_VOICE",
    "R1_TTS_LEARNER_VOICE",
    "SARVAM_TTS_MODEL",
    "SARVAM_TTS_VOICE",
    "R1_STT_MODEL",
    "SARVAM_STT_MODEL",
)


class EnvCase(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in VOICE_ENV:
            os.environ.pop(key, None)
        os.environ["SARVAM_API_KEY"] = "test-key-not-real"


class TestSttModelSetting(EnvCase):
    def test_the_stt_model_setting(self) -> None:
        # Unset or empty is R1's default, saaras:v4 (owner decision 2026-10-30), whatever the
        # browser lane's SARVAM_STT_MODEL says.
        self.assertEqual(r1_sarvam.r1_stt_model(), ("saaras:v4", None))
        os.environ["R1_STT_MODEL"] = ""
        self.assertEqual(r1_sarvam.r1_stt_model(), ("saaras:v4", None))
        os.environ["SARVAM_STT_MODEL"] = "saaras:v3"
        self.assertEqual(r1_sarvam.r1_stt_model(), ("saaras:v4", None))
        os.environ.pop("R1_STT_MODEL")
        self.assertEqual(r1_sarvam.r1_stt_model(), ("saaras:v4", None))
        # The rollback: R1_STT_MODEL=saaras:v3.
        os.environ["R1_STT_MODEL"] = "saaras:v3"
        self.assertEqual(r1_sarvam.r1_stt_model(), ("saaras:v3", None))
        # A typo falls back to the browser lane's model, not to the new default.
        os.environ["SARVAM_STT_MODEL"] = "saarika:v2.5"
        os.environ["R1_STT_MODEL"] = "saaras-v4"
        self.assertEqual(r1_sarvam.r1_stt_model(), ("saarika:v2.5", "stt_model_rejected"))
        os.environ.pop("R1_STT_MODEL")
        os.environ.pop("SARVAM_STT_MODEL")
        # The trial values are accepted (stripped).
        for raw, model in (("saaras:v4", "saaras:v4"), (" saaras:v4\n", "saaras:v4"),
                           ("saaras:v3", "saaras:v3")):
            with self.subTest(raw=raw):
                os.environ["R1_STT_MODEL"] = raw
                self.assertEqual(r1_sarvam.r1_stt_model(), (model, None))
        # Anything else falls back to today's model, with a note.
        for raw in ("saaras-v4", "SAARAS:V4", "v4", "   ", "saarika:v2.5"):
            with self.subTest(raw=raw):
                os.environ["R1_STT_MODEL"] = raw
                self.assertEqual(r1_sarvam.r1_stt_model(), ("saaras:v3", "stt_model_rejected"))
        self.assertEqual(r1_sarvam.R1_STT_MODELS, frozenset({"saaras:v3", "saaras:v4"}))


class TestSpeechIdWithoutTheSdk(unittest.TestCase):
    def test_a_failing_import_returns_none(self) -> None:
        r1_sarvam._speech_handle_var.cache_clear()
        self.addCleanup(r1_sarvam._speech_handle_var.cache_clear)
        with mock.patch.dict(sys.modules, {"livekit.agents.voice.agent_activity": None}):
            self.assertIsNone(r1_sarvam.current_speech_id())
        r1_sarvam._speech_handle_var.cache_clear()


class TestModuleSurface(unittest.TestCase):
    def test_the_module_imports_only_stdlib_and_r1_tts_at_import_time(self) -> None:
        source = Path(r1_sarvam.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        top_level = set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                top_level.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                top_level.add((node.module or "").split(".")[0])
        self.assertEqual(
            top_level, {"__future__", "contextlib", "functools", "os", "typing", "r1_tts"}
        )
        # The pins the factory used to carry now live here (test_r1_core reads them too).
        self.assertIn('os.getenv("SARVAM_STT_MODEL", "saaras:v3")', source)
        self.assertIn("sarvam.TTS(**r1_tts_kwargs())", source)
        self.assertIn('os.getenv("R1_STT_MODEL")', source)

    def test_the_worker_ships_the_module(self) -> None:
        dockerfile = (HERE / "Dockerfile").read_text(encoding="utf-8")
        copy = next(line for line in dockerfile.splitlines() if line.startswith("COPY agent.py"))
        self.assertIn("r1_sarvam.py", copy.split())


@unittest.skipUnless(sarvam is not None, "livekit-plugins-sarvam is not installed (bare CI)")
class TestBuildR1Tts(EnvCase):
    def test_v3_builds_the_plain_plugin_tts_with_todays_kwargs(self) -> None:
        os.environ["R1_TTS_PROFILE"] = "v3"
        made = mock.Mock(return_value="plain")
        with mock.patch.object(sarvam, "TTS", made):
            built = r1_sarvam.build_r1_tts(r1_tts.r1_voice_set())
            self.assertEqual(r1_sarvam.build_r1_tts(None), "plain")
        self.assertEqual(built, "plain")
        self.assertEqual(made.call_count, 2)
        for call in made.call_args_list:
            self.assertEqual(call.args, ())
            self.assertEqual(call.kwargs, r1_tts_kwargs())
        real = r1_sarvam.build_r1_tts(r1_tts.r1_voice_set())
        self.assertIs(type(real), sarvam.TTS)  # today's class, not the subclass
        self.assertFalse(hasattr(real, "r1_voice_set"))

    def test_v4_builds_one_voiced_tts(self) -> None:
        voices = r1_tts.r1_voice_set()
        tts = r1_sarvam.build_r1_tts(voices)
        self.assertIsInstance(tts, sarvam.TTS)
        self.assertEqual(type(tts).__name__, "R1SarvamTTS")
        self.assertEqual(tts.label, "r1_sarvam.R1SarvamTTS")
        self.assertEqual(tts.model, "bulbul:v4-flash")
        self.assertEqual(tts.provider, "Sarvam")
        self.assertEqual(tts._opts.speaker, "simran_en_customer")
        self.assertEqual(tts._opts.pace, 1.0)
        self.assertEqual(str(tts._opts.target_language_code), "en-IN")
        self.assertEqual((tts.sample_rate, tts.num_channels), (22050, 1))
        self.assertTrue(tts.capabilities.streaming)
        self.assertIs(tts.r1_voice_set, voices)
        self.assertIs(r1_sarvam._voiced_tts_class(), type(tts))  # built once

    def test_the_subclass_never_takes_a_patched_package_attribute_as_its_base(self) -> None:
        with mock.patch.object(sarvam, "TTS", lambda **_kwargs: "patched"):
            r1_sarvam._voiced_tts_class.cache_clear()
            try:
                tts = r1_sarvam.build_r1_tts(r1_tts.r1_voice_set())
            finally:
                r1_sarvam._voiced_tts_class.cache_clear()
        self.assertEqual(type(tts).__name__, "R1SarvamTTS")

    def test_a_v4_build_failure_falls_back_to_the_v3_voice(self) -> None:
        seen: list[BaseException] = []

        class Broken:
            def __init__(self, _voice_set) -> None:
                raise ValueError("bad options")

        made = mock.Mock(return_value="plain")
        with mock.patch.object(r1_sarvam, "_voiced_tts_class", lambda: Broken), \
                mock.patch.object(sarvam, "TTS", made):
            built = r1_sarvam.build_r1_tts(r1_tts.r1_voice_set(), on_fallback=seen.append)
        self.assertEqual(built, "plain")
        made.assert_called_once_with(**r1_tts_kwargs())
        self.assertEqual([type(exc) for exc in seen], [ValueError])

        def broken_sink(_exc) -> None:
            raise RuntimeError("sink bug")

        with mock.patch.object(r1_sarvam, "_voiced_tts_class", lambda: Broken), \
                mock.patch.object(sarvam, "TTS", made):
            self.assertEqual(
                r1_sarvam.build_r1_tts(r1_tts.r1_voice_set(), on_fallback=broken_sink), "plain"
            )


@unittest.skipUnless(sarvam is not None, "livekit-plugins-sarvam is not installed (bare CI)")
class TestVoicedStreams(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {"SARVAM_API_KEY": "test-key-not-real"})
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in VOICE_ENV:
            os.environ.pop(key, None)
        self.tts = r1_sarvam.build_r1_tts(r1_tts.r1_voice_set())

        async def no_network(_timeout: float):
            raise AssertionError("a test stream must never open a socket")

        self.tts._connect_ws = no_network
        self.streams: list = []

    async def asyncTearDown(self) -> None:
        for stream in self.streams:
            await stream.aclose()
        await self.tts.aclose()

    def open(self):
        stream = self.tts.stream()
        self.streams.append(stream)
        return stream

    async def test_each_stream_speaks_the_voice_bound_in_its_task(self) -> None:
        async def speech(voice):
            if voice is not None:
                r1_tts.bind_voice(voice)
            return self.open()._opts.speaker

        self.assertEqual(await asyncio.create_task(speech("learner")), "zarina_en_conversation")
        self.assertEqual(await asyncio.create_task(speech("interviewer")), "simran_en_customer")
        self.assertEqual(await asyncio.create_task(speech(None)), "simran_en_customer")
        # The instance's own options are never touched.
        self.assertEqual(self.tts._opts.speaker, "simran_en_customer")
        self.assertEqual(self.tts._opts.model, "bulbul:v4-flash")
        for stream in self.streams:
            self.assertEqual(stream._opts.model, "bulbul:v4-flash")

    async def test_two_speeches_in_flight_never_mix_voices(self) -> None:
        both_first = asyncio.Event()
        ready = []

        async def speech(voice: str) -> list[str]:
            r1_tts.bind_voice(voice)
            first = self.open()  # the early flush's first fragment
            ready.append(voice)
            if len(ready) == 2:
                both_first.set()
            await both_first.wait()  # the other speech opens its streams meanwhile
            await asyncio.sleep(0)
            second = self.open()  # the rest of the reply, after the first audio
            return [first._opts.speaker, second._opts.speaker]

        learner, interviewer = await asyncio.gather(
            asyncio.create_task(speech("learner")), asyncio.create_task(speech("interviewer"))
        )
        self.assertEqual(learner, ["zarina_en_conversation"] * 2)
        self.assertEqual(interviewer, ["simran_en_customer"] * 2)
        self.assertEqual(self.tts._opts.speaker, "simran_en_customer")

    async def test_an_override_voice_is_what_the_stream_speaks(self) -> None:
        os.environ["R1_TTS_LEARNER_VOICE"] = "neha_en_customer"
        await self.tts.aclose()
        self.tts = r1_sarvam.build_r1_tts(r1_tts.r1_voice_set())

        async def speech():
            r1_tts.bind_voice("learner")
            return self.open()._opts.speaker

        self.assertEqual(await asyncio.create_task(speech()), "neha_en_customer")


@unittest.skipUnless(sarvam is not None, "livekit-agents is not installed (bare CI)")
class TestCurrentSpeechId(unittest.IsolatedAsyncioTestCase):
    async def test_current_speech_id_reads_the_sdks_speech_handle(self) -> None:
        r1_sarvam._speech_handle_var.cache_clear()
        self.assertIsNone(r1_sarvam.current_speech_id())
        handle = SpeechHandle.create()

        async def in_speech_task() -> str | None:
            _SpeechHandleContextVar.set(handle)
            return r1_sarvam.current_speech_id()

        self.assertEqual(await asyncio.create_task(in_speech_task()), str(handle.id))
        self.assertIsNone(r1_sarvam.current_speech_id())  # the task's context, not ours


if __name__ == "__main__":
    unittest.main()
