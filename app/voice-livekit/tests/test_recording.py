"""Unit tests for the in-worker recorder lifecycle (PR A).

These exercise the CONSENT-TIMING and FAIL-OPEN logic with fakes — no
livekit-agents, PyAV, ffmpeg, or network required. The audio-fidelity of the
real RecorderIO mix (both streams present on the timeline) is validated
separately with the real recorder / a live call; here we prove the wrapper
never starts recording before consent and never raises into the call path.
"""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path

import recording as rec

try:
    import av as _av  # PyAV — present on the worker (livekit-agents[codecs]), absent in CI
    import numpy as _np
    _HAS_AV = True
except Exception:  # noqa: BLE001
    _HAS_AV = False


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class _FakeIO:
    def __init__(self, audio):
        self.audio = audio


class _FakeSession:
    def __init__(self):
        self.input = _FakeIO("candidate_audio")
        self.output = _FakeIO("bot_audio")


class _FakeRecorder:
    """Records call order and the .recording flag transitions RecorderIO exposes."""

    def __init__(self, session, sample_rate, *, fail_start=False):
        self.session = session
        self.sample_rate = sample_rate
        self.calls = []
        self.recording = False
        self.recording_started_at = None
        self._fail_start = fail_start

    def record_input(self, audio):
        self.calls.append(("record_input", audio))
        return "TAP_IN"

    def record_output(self, audio):
        self.calls.append(("record_output", audio))
        return "TAP_OUT"

    async def start(self, *, output_path):
        if self._fail_start:
            raise RuntimeError("boom_start")
        self.calls.append(("start", str(output_path)))
        self.recording = True
        import time
        self.recording_started_at = time.time()

    async def aclose(self):
        self.calls.append("aclose")
        self.recording = False


def _make(session=None, *, fail_wire=False, fail_start=False, transcode=None, upload=None,
          uploaded=None, tmp=None):
    session = session or _FakeSession()
    holder = {}

    def factory(sess, sr):
        if fail_wire:
            raise RuntimeError("boom_wire")
        r = _FakeRecorder(sess, sr, fail_start=fail_start)
        holder["recorder"] = r
        return r

    async def default_transcode(ogg, mp3):
        Path(mp3).write_bytes(b"ID3fake-mp3-bytes")

    sink = uploaded if uploaded is not None else {}

    async def default_upload(url, body):
        sink["url"] = url
        sink["body"] = body

    r = rec.InWorkerRecorder(
        session,
        work_dir=tmp,
        recorder_factory=factory,
        transcode_fn=transcode or default_transcode,
        upload_fn=upload or default_upload,
    )
    return r, session, holder


OBJECT_KEY = "phone/attempts/abc123.mp3"
UPLOAD_URL = "https://example.test/put?sig=x"


def _begin(r):
    return _run(r.begin(OBJECT_KEY))


def _finish(r):
    return _run(r.finish(UPLOAD_URL))


class TestInWorkerRecorderLifecycle(unittest.TestCase):
    def test_wire_installs_both_taps_and_reassigns_audio(self):
        r, session, holder = _make()
        self.assertTrue(r.wire())
        rec_obj = holder["recorder"]
        names = [c[0] for c in rec_obj.calls]
        self.assertIn("record_input", names)
        self.assertIn("record_output", names)
        # taps are swapped into the session BEFORE any recording begins
        self.assertEqual(session.input.audio, "TAP_IN")
        self.assertEqual(session.output.audio, "TAP_OUT")

    def test_wire_does_not_start_recording_ask_first_record_second(self):
        # The invariant: wiring the taps must NOT begin recording. start() may
        # only be called by begin() at the consent moment.
        r, _session, holder = _make()
        self.assertTrue(r.wire())
        rec_obj = holder["recorder"]
        self.assertFalse(any(c[0] == "start" for c in rec_obj.calls if isinstance(c, tuple)))
        self.assertFalse(rec_obj.recording)
        self.assertFalse(r.active)

    def test_begin_starts_recording_once_and_is_idempotent(self):
        r, _session, holder = _make()
        r.wire()
        self.assertTrue(_begin(r))
        self.assertTrue(_begin(r))  # idempotent
        rec_obj = holder["recorder"]
        starts = [c for c in rec_obj.calls if isinstance(c, tuple) and c[0] == "start"]
        self.assertEqual(len(starts), 1)
        self.assertTrue(rec_obj.recording)
        self.assertTrue(r.active)
        # the object-key basename anchors the local file
        self.assertIn("abc123.mp3.ogg", starts[0][1])

    def test_finish_closes_transcodes_uploads_and_returns_manifest(self):
        uploaded = {}
        r, _session, holder = _make(uploaded=uploaded)
        r.wire()
        _begin(r)
        manifest = _finish(r)
        self.assertIsNotNone(manifest)
        self.assertEqual(manifest.size_bytes, len(b"ID3fake-mp3-bytes"))
        self.assertEqual(len(manifest.sha256), 64)
        self.assertIn("aclose", holder["recorder"].calls)
        self.assertEqual(uploaded["url"], "https://example.test/put?sig=x")
        self.assertEqual(uploaded["body"], b"ID3fake-mp3-bytes")

    def test_discard_closes_without_uploading_and_disables_finish(self):
        # No-consent path: close the recorder, upload NOTHING, and a later
        # finish() must be a no-op so a non-consenting call is never retained.
        uploaded = {}
        r, _session, holder = _make(uploaded=uploaded)
        r.wire()
        _begin(r)
        _run(r.discard())
        self.assertIn("aclose", holder["recorder"].calls)
        self.assertNotIn("url", uploaded)
        self.assertIsNone(_finish(r))
        self.assertNotIn("url", uploaded)

    def test_finish_without_begin_returns_none(self):
        r, _session, _holder = _make()
        r.wire()
        self.assertIsNone(_finish(r))

    # ── fail-open guarantees ─────────────────────────────────────────────
    def test_wire_failure_is_fail_open(self):
        r, session, _holder = _make(fail_wire=True)
        self.assertFalse(r.wire())
        self.assertFalse(r.active)
        # audio untouched — the call proceeds with no recording, not a crash
        self.assertEqual(session.input.audio, "candidate_audio")
        self.assertFalse(_begin(r))
        self.assertIsNone(_finish(r))

    def test_begin_failure_is_fail_open(self):
        r, _session, _holder = _make(fail_start=True)
        r.wire()
        self.assertFalse(_begin(r))
        self.assertFalse(r.active)
        self.assertIsNone(_finish(r))

    def test_transcode_failure_is_fail_open(self):
        async def boom_transcode(ogg, mp3):
            raise RuntimeError("ffmpeg_missing")

        r, _session, _holder = _make(transcode=boom_transcode)
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))  # swallowed, no raise

    def test_upload_failure_is_fail_open(self):
        async def boom_upload(url, body):
            raise RuntimeError("s3_down")

        r, _session, _holder = _make(upload=boom_upload)
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))


@unittest.skipUnless(_HAS_AV, "PyAV/numpy not installed (CI worker env) — validated where present")
class TestRealPyAvTranscode(unittest.TestCase):
    """The real fix: OGG→MP3 must transcode IN-PROCESS via PyAV (no ffmpeg binary,
    which the python:3.12-slim worker image lacks). Round-trips a synthesized
    stereo OGG through `_default_transcode` and asserts a valid stereo MP3."""

    def test_pyav_transcode_produces_valid_stereo_mp3(self):
        with tempfile.TemporaryDirectory() as d:
            ogg = Path(d) / "in.ogg"
            mp3 = Path(d) / "out.mp3"
            # synth ~0.4s stereo OGG (libopus): L=tone, R=tone
            oc = _av.open(str(ogg), mode="w")
            st = oc.add_stream("libopus", rate=48000, layout="stereo")
            sr = 48000
            t = _np.arange(int(sr * 0.4)) / sr
            l = (0.4 * _np.sin(2 * _np.pi * 440 * t) * 32767).astype(_np.int16)
            r = (0.4 * _np.sin(2 * _np.pi * 880 * t) * 32767).astype(_np.int16)
            inter = _np.empty(l.size + r.size, dtype=_np.int16)
            inter[0::2] = l
            inter[1::2] = r
            frame = _av.AudioFrame.from_ndarray(inter.reshape(1, -1), format="s16", layout="stereo")
            frame.sample_rate = sr
            for p in st.encode(frame):
                oc.mux(p)
            for p in st.encode(None):
                oc.mux(p)
            oc.close()

            _run(rec._default_transcode(ogg, mp3))

            self.assertTrue(mp3.exists() and mp3.stat().st_size > 0)
            c = _av.open(str(mp3))
            try:
                astream = c.streams.audio[0]
                self.assertEqual(len(astream.layout.channels), 2)  # stereo preserved
                self.assertGreater(sum(1 for _ in c.decode(astream)), 0)  # decodes
            finally:
                c.close()


class TestRecordingProvider(unittest.TestCase):
    def test_provider_defaults_to_egress(self):
        prior = os.environ.pop("RECORDING_PROVIDER", None)
        try:
            self.assertEqual(rec.recording_provider(), "egress")
            os.environ["RECORDING_PROVIDER"] = "worker"
            self.assertEqual(rec.recording_provider(), "worker")
            os.environ["RECORDING_PROVIDER"] = "anything_else"
            self.assertEqual(rec.recording_provider(), "egress")
        finally:
            if prior is None:
                os.environ.pop("RECORDING_PROVIDER", None)
            else:
                os.environ["RECORDING_PROVIDER"] = prior


if __name__ == "__main__":
    unittest.main()
