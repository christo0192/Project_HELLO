"""The Saaras v3/v4 A/B tool (``tools/r1_stt_ab.py``).  Pure python: no SDK, no network.

The transports are replaced by a fake; what is checked is everything the tool decides on its
own: the WAV reading, the framing, the normalisation (the same as ``r1_session.fold_speech``),
WER and the diff, the budget guard, the key handling (it never reaches stdout, stderr or the
JSON), the report and the exit codes, and that the worker never ships or imports the tool.
"""
from __future__ import annotations

import ast
import importlib.util
import io
import json
import logging
import os
import re
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

TOOL = HERE / "tools" / "r1_stt_ab.py"
_spec = importlib.util.spec_from_file_location("r1_stt_ab", TOOL)
ab = importlib.util.module_from_spec(_spec)
sys.modules["r1_stt_ab"] = ab
_spec.loader.exec_module(ab)

KEY = "sk_live_FAKE_test_key_0123456789"


def write_wav(path: Path, *, rate: int = 16000, channels: int = 1, width: int = 2,
              seconds: float = 0.5, value: int = 1000) -> Path:
    frames = int(rate * seconds)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(width)
        handle.setframerate(rate)
        sample = value.to_bytes(width, "little", signed=True) if width > 1 else bytes([value % 256])
        handle.writeframes(sample * channels * frames)
    return path


def fold_speech():
    """``r1_session.fold_speech`` (the session imports on bare python; no skip is allowed)."""
    import r1_session

    return r1_session.fold_speech


class TestAudio(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.dir = Path(self._dir.name)

    def test_wavs_are_read_at_any_rate_and_stereo_is_downmixed(self) -> None:
        for rate in (8000, 16000, 22050, 44100, 48000):
            with self.subTest(rate=rate):
                pcm, got = ab.read_wav(write_wav(self.dir / f"m{rate}.wav", rate=rate))
                self.assertEqual(got, rate)
                self.assertEqual(len(pcm), int(rate * 0.5) * 2)
        path = self.dir / "stereo.wav"
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(16000)
            left, right = (1000).to_bytes(2, "little", signed=True), (-200).to_bytes(
                2, "little", signed=True
            )
            handle.writeframes((left + right) * 100)
        pcm, rate = ab.read_wav(path)
        self.assertEqual((rate, len(pcm)), (16000, 200))
        self.assertEqual(int.from_bytes(pcm[:2], "little", signed=True), 400)

    def test_anything_but_16_bit_pcm_is_refused(self) -> None:
        for width in (1, 3):
            with self.subTest(width=width):
                path = write_wav(self.dir / f"w{width}.wav", width=width, value=10)
                with self.assertRaises(ab.UsageError):
                    ab.read_wav(path)
        garbage = self.dir / "garbage.wav"
        garbage.write_bytes(b"not a wav")
        with self.assertRaises(ab.UsageError):
            ab.read_wav(garbage)
        with self.assertRaises(ab.UsageError):
            ab.read_wav(self.dir / "missing.wav")

    def test_frames_are_10_ms_with_the_lead_and_tail_of_silence(self) -> None:
        rate = 22050
        pcm = b"\x01\x00" * (rate // 10 + 7)  # 100 ms and 7 samples
        chunks = list(ab.frames(pcm, rate))
        self.assertTrue(all(len(chunk) == 220 * 2 for chunk in chunks))
        lead, tail = 50, 250  # 0.5 s and 2.5 s of 10 ms frames
        self.assertEqual(len(chunks), lead + 11 + tail)
        self.assertTrue(all(chunk == b"\x00" * 440 for chunk in chunks[:lead]))
        self.assertTrue(all(chunk == b"\x00" * 440 for chunk in chunks[-tail:]))
        self.assertEqual(b"".join(chunks[lead : lead + 11])[: len(pcm)], pcm)
        self.assertEqual(ab.speech_frame_count(pcm, rate), lead + 11)
        chunks = list(ab.frames(b"\x00\x00" * 1600, 16000, frame_ms=100))
        self.assertEqual(len(chunks[0]), 3200)
        self.assertEqual(len(chunks), 5 + 1 + 25)


class TestScoring(unittest.TestCase):
    CORPUS = (
        "No, thank you.",
        "Let’s start!",
        "$9,000 feels like a lot",
        "  Is there an EMI   option? ",
        "'quoted' words, rock 'n' roll",
        "₹3 lakh — for a similar course.",
        "Okay, let's end the interview now.",
        "नमस्ते, कैसे हो?",
        "",
    )

    def test_normalisation_is_fold_speech(self) -> None:
        self.assertEqual(ab.normalise("No, thank you."), "no thank you")
        self.assertEqual(ab.normalise("Let’s start!"), "let's start")
        fold = fold_speech()
        for text in self.CORPUS:
            with self.subTest(text=text):
                self.assertEqual(ab.normalise(text), fold(text))

    def test_known_wer_values(self) -> None:
        self.assertEqual(ab.wer("a b c d", "a b c d"), 0.0)
        self.assertEqual(
            ab.wer("Okay, let's END the interview.", "okay let's end the interview"), 0.0
        )
        self.assertEqual(ab.wer("a b c d", "a x c d"), 0.25)  # one substitution
        self.assertEqual(ab.wer("a b c d", "a c d"), 0.25)  # one deletion
        self.assertEqual(ab.wer("a b", "a b c d"), 1.0)  # two insertions
        self.assertEqual(ab.wer("a b c", ""), 1.0)
        self.assertEqual(ab.wer("", ""), 0.0)
        self.assertEqual(ab.wer("", "noise"), 1.0)

    def test_the_diff_marks_words_only_in_one_model(self) -> None:
        self.assertEqual(
            ab.word_diff("Nine thousand dollars feels like a lot", "$9,000 feels like a lot"),
            "-nine -thousand -dollars +9 +000 feels like a lot",
        )
        self.assertEqual(ab.word_diff("same words", "Same, words."), "same words")

    def test_status_keeps_no_finals_apart_from_an_error(self) -> None:
        self.assertEqual(ab.status_of({"finals": ["hi"]}), "ok")
        self.assertEqual(ab.status_of({"finals": []}), "no_finals")
        self.assertEqual(ab.status_of({"finals": ["hi"], "error": {"type": "X"}}), "error")


class TestKey(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("SARVAM_API_KEY", None)
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.dir = Path(self._dir.name)

    def test_the_env_file_gives_only_the_sarvam_key(self) -> None:
        env = self.dir / ".env"
        env.write_text(
            "DEEPSEEK_API_KEY=other-secret\n# SARVAM_API_KEY=commented\n"
            f'SARVAM_API_KEY="{KEY}"\nLIVEKIT_API_SECRET=also-secret\n',
            encoding="utf-8",
        )
        self.assertEqual(ab.read_key(str(env)), KEY)
        self.assertNotIn("DEEPSEEK_API_KEY", os.environ.get("SARVAM_API_KEY", ""))
        os.environ["SARVAM_API_KEY"] = "from-env"
        self.assertEqual(ab.read_key(str(env)), "from-env")  # the environment wins
        os.environ.pop("SARVAM_API_KEY")
        self.assertIsNone(ab.read_key(str(self.dir / "missing.env")))
        self.assertIsNone(ab.read_key(None))
        empty = self.dir / "empty.env"
        empty.write_text("SARVAM_API_KEY=\n", encoding="utf-8")
        self.assertIsNone(ab.read_key(str(empty)))

    def test_redact_removes_the_key_and_key_shaped_headers(self) -> None:
        self.assertNotIn(KEY, ab.redact(f"failed with {KEY} inside", (KEY,)))
        self.assertEqual(
            ab.redact("api-subscription-key: abc123", ()), "api-subscription-key: [redacted]"
        )
        self.assertEqual(
            ab.redact('{"API-SUBSCRIPTION-KEY": "abc123"}', ()),
            '{"API-SUBSCRIPTION-KEY": "[redacted]"}',
        )

    def test_the_log_filter_redacts_tracebacks_and_stacks_too(self) -> None:
        # The formatter renders exc_info and stack_info after the filter ran; a filter that
        # scrubbed only the message let logger.exception() print the key in the traceback.
        err = io.StringIO()
        handler = logging.StreamHandler(err)
        handler.addFilter(ab._RedactingFilter((KEY,)))
        log = logging.getLogger("test_r1_stt_ab.redact")
        log.propagate = False
        log.addHandler(handler)
        self.addCleanup(log.removeHandler, handler)
        try:
            raise RuntimeError(f"handshake failed key={KEY}")
        except RuntimeError:
            log.exception("connect %s", KEY)
        try:
            raise ValueError(f"bad {KEY}")
        except ValueError as exc:
            log.warning("retry", exc_info=exc, stack_info=True)
        text = err.getvalue()
        self.assertNotIn(KEY, text)
        self.assertIn("RuntimeError: handshake failed key=[redacted]", text)
        self.assertIn("ValueError: bad [redacted]", text)
        self.assertIn("Stack (most recent call last)", text)
        self.assertIn("connect [redacted]", text)


class FakeTransport:
    """Answers from a script: a result dict, or an exception to raise, per (model, call)."""

    def __init__(self, answers) -> None:
        self.answers = answers
        self.calls: list[tuple[str, int, str, str]] = []

    async def __call__(self, model, pcm, rate, *, language, key):
        self.calls.append((model, rate, language, key))
        answer = self.answers(model, len(self.calls))
        if isinstance(answer, BaseException):
            raise answer
        return dict(answer)


class TestEndToEnd(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {"SARVAM_API_KEY": KEY})
        patcher.start()
        self.addCleanup(patcher.stop)
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.dir = Path(self._dir.name)
        self.clip = write_wav(self.dir / "end.wav", rate=22050, seconds=2.0)
        (self.dir / "end.txt").write_text("Okay, let's end the interview now.\n", encoding="utf-8")

    def run_tool(self, *argv, transport=None):
        out, err = io.StringIO(), io.StringIO()
        code = ab.main(
            [str(self.clip), *argv],
            transports={"stream": transport, "rest": transport, "realtime": transport},
            stdout=out,
            stderr=err,
        )
        return code, out.getvalue(), err.getvalue()

    @staticmethod
    def answers(model, _call):
        if model == "saaras:v3":
            return {"finals": ["Okay, let's end the interview now."], "final_latency_s": 0.4,
                    "events": ["START", "END", "FINAL"], "url": "wss://x/ws?model=saaras:v3"}
        return {"finals": ["Okay,", "let's end the interview."], "final_latency_s": 0.6,
                "events": ["FINAL", "FINAL"], "url": "wss://x/ws?model=saaras:v4"}

    def test_a_fake_transport_runs_end_to_end_side_by_side(self) -> None:
        transport = FakeTransport(self.answers)
        report = self.dir / "out.json"
        code, out, err = self.run_tool("--json", str(report), transport=transport)
        self.assertEqual(code, 0, err)
        self.assertEqual(sorted(call[0] for call in transport.calls), ["saaras:v3", "saaras:v4"])
        self.assertEqual({call[1:3] for call in transport.calls}, {(22050, "en-IN")})
        self.assertIn("budget: 5.0 s of audio x 2 model(s) = 10.0 s", out)
        self.assertIn("expected: Okay, let's end the interview now.", out)
        self.assertIn("saaras:v3: status=ok finals=1 words=[6] wer=0.0 latency_s=0.4", out)
        self.assertIn("saaras:v4: status=ok finals=2 words=[1, 4] wer=0.1667", out)
        self.assertIn("diff: okay let's end the interview -now", out)
        self.assertIn("saaras:v4: clips=1 failures=0 no_finals=0 mean_wer=0.1667", out)
        self.assertIn("short_finals=1", out)
        document = json.loads(report.read_text(encoding="utf-8"))
        self.assertEqual(document["models"], ["saaras:v3", "saaras:v4"])
        clip = document["clips"][0]
        self.assertNotIn("pcm", clip)
        self.assertEqual(
            clip["results"]["saaras:v4"]["transcript"], "Okay, let's end the interview."
        )
        self.assertEqual(document["summary"]["saaras:v3"]["median_final_latency_s"], 0.4)
        self.assertNotIn(KEY, out + err + report.read_text(encoding="utf-8"))

    def test_no_text_prints_numbers_only(self) -> None:
        report = self.dir / "numbers.json"
        code, out, _ = self.run_tool(
            "--no-text", "--json", str(report), transport=FakeTransport(self.answers)
        )
        self.assertEqual(code, 0)
        written = out + report.read_text(encoding="utf-8")
        for word in ("interview", "Okay", "okay", "expected:", "diff:"):
            self.assertNotIn(word, written)
        self.assertIn("wer=0.1667", out)

    def test_the_budget_guard_exits_2_before_any_transport_call(self) -> None:
        transport = FakeTransport(self.answers)
        code, out, err = self.run_tool("--max-audio-seconds", "9", transport=transport)
        self.assertEqual(code, 2)
        self.assertEqual(transport.calls, [])
        self.assertIn("over the audio budget", err)
        code, _, _ = self.run_tool(
            "--max-audio-seconds", "9", "--models", "saaras:v4", transport=transport
        )
        self.assertEqual(code, 0)  # one model: 5 s fits
        self.assertEqual(len(transport.calls), 1)

    def test_a_missing_key_or_bad_input_exits_2(self) -> None:
        os.environ.pop("SARVAM_API_KEY")
        transport = FakeTransport(self.answers)
        code, _, err = self.run_tool(transport=transport)
        self.assertEqual(code, 2)
        self.assertIn("no SARVAM_API_KEY", err)
        os.environ["SARVAM_API_KEY"] = KEY
        self.assertEqual(self.run_tool("--models", ",", transport=transport)[0], 2)
        self.assertEqual(self.run_tool("--models", "a,a", transport=transport)[0], 2)
        self.assertEqual(self.run_tool("--transport", "carrier-pigeon", transport=transport)[0], 2)
        bad = write_wav(self.dir / "bad.wav", width=1, value=3)
        out, err = io.StringIO(), io.StringIO()
        self.assertEqual(ab.main([str(bad)], transports={}, stdout=out, stderr=err), 2)
        self.assertEqual(transport.calls, [])

    def test_the_key_never_leaks_even_inside_a_raised_error(self) -> None:
        class Boom(Exception):
            status_code = 403

        def answers(model, _call):
            if model == "saaras:v4":
                return Boom(f"handshake refused for key {KEY} (api-subscription-key={KEY})")
            return self.answers(model, _call)

        report = self.dir / "error.json"
        code, out, err = self.run_tool("--json", str(report), transport=FakeTransport(answers))
        self.assertEqual(code, 3)  # v4 failed every clip
        written = out + err + report.read_text(encoding="utf-8")
        self.assertNotIn(KEY, written)
        self.assertIn("saaras:v4: status=error", out)
        self.assertIn("error: Boom status=403", out)
        self.assertIn("[redacted]", out)

    def test_zero_finals_is_not_an_error(self) -> None:
        def answers(model, _call):
            return {"finals": [], "events": [], "final_latency_s": None}

        code, out, _ = self.run_tool(transport=FakeTransport(answers))
        self.assertEqual(code, 0)
        self.assertIn("status=no_finals finals=0 words=[] wer=1.0", out)
        self.assertIn("failures=0 no_finals=1", out)

    def test_sequential_runs_one_model_at_a_time(self) -> None:
        transport = FakeTransport(self.answers)
        self.assertEqual(self.run_tool("--sequential", transport=transport)[0], 0)
        self.assertEqual([call[0] for call in transport.calls], ["saaras:v3", "saaras:v4"])

    def test_the_realtime_url_never_carries_the_key(self) -> None:
        url = ab.realtime_url("saaras:v4", "en-IN")
        self.assertTrue(url.startswith("wss://api.sarvam.ai/speech-to-text-realtime/ws?"))
        for part in ("model=saaras%3Av4", "language_code=en-IN", "mode=transcribe",
                     "stream_type=fast", "endpointing=vad", "encoding=linear16",
                     "sample_rate=16000"):
            self.assertIn(part, url)
        self.assertNotIn("key", url.lower())


def imports_of(path: Path, *, everywhere: bool) -> set[str]:
    """The top-level package names ``path`` imports (at module level, or anywhere)."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree) if everywhere else tree.body:
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            names.add((node.module or "").split(".")[0])
    return names


class TestModuleSurface(unittest.TestCase):
    def test_the_tool_is_not_shipped_or_imported_by_the_worker(self) -> None:
        dockerfile = (HERE / "Dockerfile").read_text(encoding="utf-8")
        self.assertNotIn("r1_stt_ab", dockerfile)
        self.assertNotIn("tools", dockerfile.split("COPY agent.py", 1)[1].splitlines()[0])
        for module in HERE.glob("*.py"):
            with self.subTest(module=module.name):
                self.assertNotIn("r1_stt_ab", imports_of(module, everywhere=True))
                self.assertNotIn("tools", imports_of(module, everywhere=True))
        top_level = imports_of(TOOL, everywhere=False)
        self.assertTrue(top_level.isdisjoint({"livekit", "aiohttp", "r1_session", "phone"}))

    def test_the_tool_reads_no_environment_but_the_sarvam_key(self) -> None:
        source = TOOL.read_text(encoding="utf-8")
        names = set(re.findall(r"os\.(?:getenv|environ\.get)\(\s*[\"']([A-Z0-9_]+)", source))
        self.assertEqual(names, {"SARVAM_API_KEY"})


if __name__ == "__main__":
    unittest.main()
