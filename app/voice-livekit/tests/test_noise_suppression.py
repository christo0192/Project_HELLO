"""Phone-path RNNoise suppression (noise_suppression.py).

What is pinned, and why:

1. **Fail-open.** Every way the denoiser can be unavailable (env off, not
   Linux, pyrnnoise not installed, broken .so, unexpected error) yields
   `phone_room_options() -> None` — the call proceeds unfiltered, exactly as
   before this module existed — and NEVER raises into session start.
2. **Import-safety.** The module imports with no livekit/numpy (CI runs a bare
   python3), and importing it does not drag either in.
3. **Frame contract.** rtc.AudioStream feeds `_process` every frame and RoomIO's
   AGC consumes the result, so every output frame has the input's exact
   length/rate/channels, for ANY frame length, and the stream is the backend's
   output delayed by exactly 480 samples (10 ms).
4. **One error, then out of the way.** A bad format or backend exception
   passes the frame through, disables the processor (AudioStream stops calling
   it), and logs once. `_close` destroys the state exactly once.

The DSP tests use an injected FAKE backend (x * gain) so they are exact; they
need numpy + livekit and skip in CI. The real-library tests additionally need
pyrnnoise's librnnoise.so (Linux) and skip everywhere else.
"""

from __future__ import annotations

import dataclasses
import logging
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

_WORKER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_WORKER_DIR))

import noise_suppression as ns  # noqa: E402

_LOGGER = "voice-livekit.noise_suppression"


def _real_livekit():
    """The real livekit.rtc, or None (absent, or another test's stub)."""
    try:
        import numpy  # noqa: F401
        from livekit import rtc
        from livekit.agents.voice import room_io  # noqa: F401
    except Exception:
        return None
    if not getattr(rtc, "__file__", None) or not isinstance(
        getattr(rtc, "FrameProcessor", None), type
    ):
        return None
    return rtc


_RTC = _real_livekit()
_HAVE_DSP = _RTC is not None
_REAL_LIB, _REAL_LIB_REASON = ns._try_load() if _HAVE_DSP else (None, "no_livekit")
_HAVE_REAL = _REAL_LIB is not None

if _HAVE_DSP:
    import numpy as np


class _FakeBackend:
    """Same three methods as the ctypes backend; process() is x * gain in place."""

    def __init__(self, gain: float = 0.5, fail_at_call: int | None = None,
                 fail_create: bool = False) -> None:
        self.gain = gain
        self.fail_at_call = fail_at_call
        self.fail_create = fail_create
        self.created = 0
        self.destroyed: list = []
        self.calls = 0

    def create(self):
        if self.fail_create:
            raise RuntimeError("create failed")
        self.created += 1
        return f"state-{self.created}"

    def destroy(self, state) -> None:
        self.destroyed.append(state)

    def process(self, state, chunk) -> float:
        assert chunk.dtype == np.float32 and chunk.size == ns.RNNOISE_FRAME_SIZE
        self.calls += 1
        if self.fail_at_call is not None and self.calls >= self.fail_at_call:
            raise RuntimeError("backend exploded")
        chunk *= self.gain
        return 0.25


def _env(value):
    env = {k: v for k, v in os.environ.items() if k != "PHONE_NOISE_SUPPRESSION"}
    if value is not None:
        env["PHONE_NOISE_SUPPRESSION"] = value
    return patch.dict(os.environ, env, clear=True)


class ModeParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        ns._unknown_mode_warned = False

    def test_matrix(self) -> None:
        cases = {
            None: "rnnoise", "": "rnnoise", "  ": "rnnoise", "rnnoise": "rnnoise",
            " RNNoise ": "rnnoise", "off": "off", "OFF": "off", " false ": "off",
            "0": "off", "none": "off", "Disabled": "off",
        }
        for raw, want in cases.items():
            with self.subTest(raw=raw), _env(raw):
                self.assertEqual(ns.phone_noise_suppression_mode(), want)

    def test_unknown_value_keeps_rnnoise_and_warns_once(self) -> None:
        with _env("krisp"):
            with self.assertLogs(_LOGGER, level="WARNING") as cm:
                self.assertEqual(ns.phone_noise_suppression_mode(), "rnnoise")
            self.assertEqual(len(cm.records), 1)
            self.assertIn("phone_noise_suppression_unknown_mode", cm.output[0])
            with self.assertNoLogs(_LOGGER, level="WARNING"):
                self.assertEqual(ns.phone_noise_suppression_mode(), "rnnoise")


class RoomOptionsFailOpenTests(unittest.TestCase):
    def setUp(self) -> None:
        ns._unknown_mode_warned = False

    def test_off_returns_none_without_loading(self) -> None:
        def _boom():
            raise AssertionError("loader must not run when off")

        with _env("off"), patch.object(ns, "_load_backend", _boom):
            self.assertIsNone(ns.phone_room_options())

    def test_unavailable_returns_none_and_logs_one_error(self) -> None:
        def _missing():
            raise ns.RNNoiseUnavailable("not_installed")

        with _env(None), patch.object(ns, "_load_backend", _missing):
            with self.assertLogs(_LOGGER, level="ERROR") as cm:
                self.assertIsNone(ns.phone_room_options())
        self.assertEqual(len(cm.records), 1)
        self.assertIn("phone_noise_suppression_unavailable", cm.output[0])
        self.assertIn("reason=not_installed", cm.output[0])

    def test_unexpected_error_returns_none(self) -> None:
        def _weird():
            raise ValueError("anything at all")

        with _env(None), patch.object(ns, "_load_backend", _weird):
            with self.assertLogs(_LOGGER, level="ERROR") as cm:
                self.assertIsNone(ns.phone_room_options())
        self.assertIn("reason=unexpected_error", cm.output[0])

    def test_loader_reasons(self) -> None:
        self.assertEqual(ns._try_load(platform="win32"), (None, "unsupported_platform"))
        self.assertEqual(
            ns._try_load(find_spec=lambda _n: None, platform="linux"),
            (None, "not_installed"),
        )
        with tempfile.TemporaryDirectory() as d:
            spec = types.SimpleNamespace(submodule_search_locations=[d])
            self.assertEqual(
                ns._try_load(find_spec=lambda _n: spec, platform="linux"),
                (None, "library_missing"),
            )
            Path(d, "librnnoise.so").write_bytes(b"not a shared object")
            self.assertEqual(
                ns._try_load(find_spec=lambda _n: spec, platform="linux"),
                (None, "load_failed"),
            )

    def test_load_backend_raises_stable_reason_and_caches(self) -> None:
        calls = []

        def _fake_try_load():
            calls.append(1)
            return None, "not_installed"

        with patch.object(ns, "_backend_cache", None), patch.object(
            ns, "_try_load", _fake_try_load
        ):
            for _ in range(2):
                with self.assertRaises(ns.RNNoiseUnavailable) as cm:
                    ns._load_backend()
                self.assertEqual(cm.exception.reason, "not_installed")
        self.assertEqual(len(calls), 1)

    def test_import_needs_no_livekit_or_numpy(self) -> None:
        # A fresh interpreter: importing must not pull livekit/numpy in, and
        # with both made unimportable the module still imports and fails open.
        script = (
            "import sys\n"
            "import noise_suppression as ns\n"
            "assert 'livekit' not in sys.modules, 'livekit imported eagerly'\n"
            "assert 'numpy' not in sys.modules, 'numpy imported eagerly'\n"
            "for m in [k for k in sys.modules if k == 'numpy' or k.startswith('livekit')]:\n"
            "    del sys.modules[m]\n"
            "sys.modules['livekit'] = None\n"
            "sys.modules['numpy'] = None\n"
            "assert ns.phone_room_options() is None\n"
            "print('IMPORT_OK')\n"
        )
        env = {k: v for k, v in os.environ.items() if k != "PHONE_NOISE_SUPPRESSION"}
        proc = subprocess.run(
            [sys.executable, "-c", script], cwd=str(_WORKER_DIR), env=env,
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("IMPORT_OK", proc.stdout)


@unittest.skipUnless(_HAVE_DSP, "needs numpy + livekit")
class FrameProcessorFakeBackendTests(unittest.TestCase):
    def _frames(self, x, sizes, rate=48000):
        frames, i = [], 0
        for n in sizes:
            frames.append(_RTC.AudioFrame(x[i:i + n].tobytes(), rate, 1, n))
            i += n
        return frames

    def _run(self, backend, x, sizes):
        proc = ns.RNNoiseFrameProcessor(backend=backend)
        outs = []
        for frame in self._frames(x, sizes):
            out = proc._process(frame)
            self.assertIsNot(out, frame)
            self.assertEqual(out.samples_per_channel, frame.samples_per_channel)
            self.assertEqual(out.sample_rate, frame.sample_rate)
            self.assertEqual(out.num_channels, frame.num_channels)
            outs.append(np.frombuffer(out.data, dtype=np.int16,
                                      count=out.samples_per_channel).copy())
        return proc, np.concatenate(outs)

    @staticmethod
    def _expected(x, gain):
        f = x.astype(np.float32) * np.float32(gain)
        y = np.clip(np.rint(f), -32768, 32767).astype(np.int16)
        return np.concatenate((np.zeros(480, np.int16), y))[: x.size]

    def test_any_frame_length_is_preserved_and_delayed_exactly_480(self) -> None:
        sizes = [2400, 480, 1000, 7, 2400, 7, 7, 1000, 480, 2400, 1, 479, 2400]
        x = np.random.default_rng(7).integers(
            -32768, 32768, size=sum(sizes), dtype=np.int16)
        backend = _FakeBackend(gain=0.5)
        proc, y = self._run(backend, x, sizes)
        np.testing.assert_array_equal(y, self._expected(x, 0.5))
        self.assertTrue(proc.enabled)
        self.assertEqual(backend.calls, sum(sizes) // 480)

    def test_output_is_clipped_to_int16(self) -> None:
        x = np.random.default_rng(3).integers(
            -32768, 32768, size=4800, dtype=np.int16)
        _proc, y = self._run(_FakeBackend(gain=4.0), x, [2400, 2400])
        np.testing.assert_array_equal(y, self._expected(x, 4.0))
        self.assertEqual(int(y.max()), 32767)
        self.assertEqual(int(y.min()), -32768)

    def test_wrong_sample_rate_passes_through_and_disables(self) -> None:
        proc = ns.RNNoiseFrameProcessor(backend=_FakeBackend())
        frame = _RTC.AudioFrame(bytes(2 * 800), 16000, 1, 800)
        with self.assertLogs(_LOGGER, level="WARNING") as cm:
            self.assertIs(proc._process(frame), frame)
        self.assertIn("phone_noise_suppression_bad_format", cm.output[0])
        self.assertFalse(proc.enabled)
        ok = _RTC.AudioFrame(bytes(2 * 2400), 48000, 1, 2400)
        self.assertIs(proc._process(ok), ok)  # stays out of the way

    def test_stereo_passes_through_and_disables(self) -> None:
        proc = ns.RNNoiseFrameProcessor(backend=_FakeBackend())
        frame = _RTC.AudioFrame(bytes(2 * 2 * 480), 48000, 2, 480)
        with self.assertLogs(_LOGGER, level="WARNING"):
            self.assertIs(proc._process(frame), frame)
        self.assertFalse(proc.enabled)

    def test_backend_exception_passes_through_disables_logs_once(self) -> None:
        proc = ns.RNNoiseFrameProcessor(backend=_FakeBackend(fail_at_call=2))
        frames = [_RTC.AudioFrame(bytes(2 * 480), 48000, 1, 480) for _ in range(3)]
        proc._process(frames[0])  # call 1 fine
        with self.assertLogs(_LOGGER, level="ERROR") as cm:
            self.assertIs(proc._process(frames[1]), frames[1])
            self.assertIs(proc._process(frames[2]), frames[2])
        self.assertEqual(len(cm.records), 1)
        self.assertIn("phone_noise_suppression_failed", cm.output[0])
        self.assertIsNotNone(cm.records[0].exc_info)
        self.assertFalse(proc.enabled)
        proc.enabled = True  # a failed processor cannot be re-armed
        self.assertFalse(proc.enabled)

    def test_close_is_idempotent_and_summarises_once(self) -> None:
        backend = _FakeBackend()
        proc = ns.RNNoiseFrameProcessor(backend=backend)
        proc._process(_RTC.AudioFrame(bytes(2 * 2400), 48000, 1, 2400))
        with self.assertLogs(_LOGGER, level="INFO") as cm:
            proc._close()
            proc._close()
        self.assertEqual(backend.destroyed, ["state-1"])
        summary = [r for r in cm.output if "phone_noise_suppression_summary" in r]
        self.assertEqual(len(summary), 1)
        self.assertIn("frames_processed=1", summary[0])
        self.assertIn("mean_speech_prob=0.250", summary[0])
        self.assertFalse(proc.enabled)
        frame = _RTC.AudioFrame(bytes(2 * 480), 48000, 1, 480)
        self.assertIs(proc._process(frame), frame)

    def test_is_a_livekit_frame_processor(self) -> None:
        self.assertIsInstance(
            ns.RNNoiseFrameProcessor(backend=_FakeBackend()), _RTC.FrameProcessor)

    def test_room_options_shape_and_selector_ownership(self) -> None:
        from livekit.agents.voice import room_io

        backend = _FakeBackend()
        with _env(None), patch.object(ns, "_load_backend", lambda: backend):
            with self.assertLogs(_LOGGER, level="INFO") as cm:
                opts = ns.phone_room_options()
        self.assertIsInstance(opts, room_io.RoomOptions)
        self.assertTrue(any("phone_noise_suppression_enabled" in o for o in cm.output))
        ai = opts.audio_input
        self.assertIsInstance(ai, room_io.AudioInputOptions)
        self.assertEqual(ai.sample_rate, 48000)
        self.assertTrue(callable(ai.noise_cancellation))
        default_ai = room_io.AudioInputOptions()
        for fld in dataclasses.fields(room_io.AudioInputOptions):
            if fld.name not in ("sample_rate", "noise_cancellation"):
                self.assertEqual(getattr(ai, fld.name), getattr(default_ai, fld.name),
                                 fld.name)
        default_ro = room_io.RoomOptions()
        for fld in dataclasses.fields(room_io.RoomOptions):
            if fld.name != "audio_input":
                self.assertEqual(getattr(opts, fld.name), getattr(default_ro, fld.name),
                                 fld.name)
        # RoomIO closes what the selector returns: every call is a new one.
        p1, p2 = ai.noise_cancellation(None), ai.noise_cancellation(None)
        self.assertIsInstance(p1, _RTC.FrameProcessor)
        self.assertIsNot(p1, p2)
        self.assertEqual(backend.created, 2)

    def test_selector_create_failure_returns_none(self) -> None:
        backend = _FakeBackend(fail_create=True)
        with _env(None), patch.object(ns, "_load_backend", lambda: backend):
            opts = ns.phone_room_options()
        with self.assertLogs(_LOGGER, level="ERROR") as cm:
            self.assertIsNone(opts.audio_input.noise_cancellation(None))
        self.assertIn("reason=processor_create_failed", cm.output[0])


@unittest.skipUnless(_HAVE_REAL, f"needs librnnoise ({_REAL_LIB_REASON})")
class RealLibraryTests(unittest.TestCase):
    def test_real_processor_matches_offline_reference(self) -> None:
        rng = np.random.default_rng(11)
        t = np.arange(48000 * 2) / 48000.0
        x = (6000 * np.sin(2 * np.pi * 220 * t) + rng.normal(0, 1500, t.size))
        x = np.clip(x, -32768, 32767).astype(np.int16)
        proc = ns.RNNoiseFrameProcessor()
        outs = []
        for i in range(0, x.size, 2400):
            fr = _RTC.AudioFrame(x[i:i + 2400].tobytes(), 48000, 1, 2400)
            out = proc._process(fr)
            self.assertEqual(out.samples_per_channel, 2400)
            outs.append(np.frombuffer(out.data, dtype=np.int16, count=2400).copy())
        proc._close()
        y = np.concatenate(outs)
        # Offline reference: same library, whole signal in 480-sample chunks.
        lib = _REAL_LIB
        st = lib.create()
        f = x.astype(np.float32)
        for i in range(0, f.size - f.size % 480, 480):
            lib.process(st, f[i:i + 480])
        lib.destroy(st)
        ref = np.clip(np.rint(f), -32768, 32767).astype(np.int16)
        ref = np.concatenate((np.zeros(480, np.int16), ref))[: x.size]
        np.testing.assert_array_equal(y, ref)
        self.assertLess(float(np.abs(y.astype(np.float64)).mean()),
                        float(np.abs(x.astype(np.float64)).mean()))

    def test_room_options_real_without_pyrnnoise_python_deps(self) -> None:
        script = (
            "import sys\n"
            "import noise_suppression as ns\n"
            "opts = ns.phone_room_options()\n"
            "assert opts is not None\n"
            "assert opts.audio_input.sample_rate == 48000\n"
            "p = opts.audio_input.noise_cancellation(None)\n"
            "assert type(p).__name__ == 'RNNoiseFrameProcessor'\n"
            "p._close()\n"
            "bad = [m for m in sys.modules if m.split('.')[0] in "
            "('audiolab', 'matplotlib', 'pyrnnoise')]\n"
            "assert not bad, bad\n"
            "print('REAL_OK')\n"
        )
        env = {k: v for k, v in os.environ.items() if k != "PHONE_NOISE_SUPPRESSION"}
        proc = subprocess.run(
            [sys.executable, "-c", script], cwd=str(_WORKER_DIR), env=env,
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("REAL_OK", proc.stdout)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    unittest.main()
