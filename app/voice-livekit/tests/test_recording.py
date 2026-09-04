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

    async def default_upload(url, body, content_type="audio/mpeg"):
        sink["url"] = url
        sink["body"] = body
        sink["content_type"] = content_type

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

    def test_wire_refuses_when_audio_io_absent(self):
        # THE SILENT-CALL REGRESSION (both-directions-dead). RoomIO attaches
        # session.input.audio / .output.audio only DURING session.start(); before
        # that (or if the room has no audio I/O) either is None. wire() MUST refuse
        # to wrap None — a None-wrapped RecorderAudioInput raises NoneType in
        # __anext__ and the output tap feeds a null sink, silencing the call in
        # both directions. So: return False, self-disable, construct no recorder,
        # and leave the session's real audio streams untouched.
        for label, in_audio, out_audio in (
            ("both_none", None, None),
            ("input_none", None, "bot_audio"),
            ("output_none", "candidate_audio", None),
        ):
            with self.subTest(label):
                session = _FakeSession()
                session.input.audio = in_audio
                session.output.audio = out_audio
                r, _s, holder = _make(session=session)
                self.assertFalse(r.wire())              # refused
                self.assertFalse(r.active)              # self-disabled
                self.assertNotIn("recorder", holder)    # RecorderIO never built
                # the real room I/O is left exactly as-is — no tap installed
                self.assertEqual(session.input.audio, in_audio)
                self.assertEqual(session.output.audio, out_audio)
                # begin() is a no-op after a refused wire; finish() records nothing
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
        async def boom_upload(url, body, content_type="audio/mpeg"):
            raise RuntimeError("s3_down")

        r, _session, _holder = _make(upload=boom_upload)
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))

    # ── finish_failure — the failure must be NAMEABLE (live 2026-09-03) ──
    # finish() fail-opened to a bare None on every failure, so the caller could
    # not distinguish "failed" from "nothing to do": the API was never told, its
    # finalizer retried a never-uploaded object key to exhaustion
    # (`object_unreadable` x6) and the session sat at "Recording is still
    # processing" forever. Each failure leg now stamps a bounded reason the
    # caller reports via /recording/failed.
    def test_finish_failure_names_the_transcode_leg(self):
        async def boom_transcode(ogg, mp3):
            raise RuntimeError("codec_died")

        r, _session, _holder = _make(transcode=boom_transcode)
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "transcode_failed")

    def test_finish_failure_names_the_empty_output_as_transcode(self):
        async def empty_transcode(ogg, mp3):
            Path(mp3).write_bytes(b"")

        r, _session, _holder = _make(transcode=empty_transcode)
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "transcode_failed")

    def test_finish_failure_names_the_upload_leg(self):
        async def boom_upload(url, body, content_type="audio/mpeg"):
            raise RuntimeError("upload_failed_status_403")

        r, _session, _holder = _make(upload=boom_upload)
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "upload_failed")

    def test_finish_failure_names_the_recorder_close_leg(self):
        r, _session, holder = _make()
        r.wire()
        _begin(r)

        async def boom_close():
            raise RuntimeError("encoder_wedged")

        holder["recorder"].aclose = boom_close
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "recorder_close_failed")

    def test_finish_failure_is_none_on_success_and_when_never_begun(self):
        ok, _session, _holder = _make()
        ok.wire()
        _begin(ok)
        self.assertIsNotNone(_finish(ok))
        self.assertIsNone(ok.finish_failure)

        never, _s2, _h2 = _make()
        never.wire()
        self.assertIsNone(_finish(never))  # nothing begun — not a failure
        self.assertIsNone(never.finish_failure)

    def test_finish_success_declares_mpeg_content_type(self):
        # The normal path uploads the MP3 and declares audio/mpeg to the PUT.
        uploaded = {}
        r, _session, _holder = _make(uploaded=uploaded)
        r.wire()
        _begin(r)
        manifest = _finish(r)
        self.assertIsNotNone(manifest)
        self.assertEqual(manifest.content_type, "audio/mpeg")
        self.assertEqual(uploaded["content_type"], "audio/mpeg")

    # ── v114 (2026-09-04): the OGG FALLBACK — audio is NEVER silently gone ──
    # On the live v114 call the OGG→MP3 transcode died on a sample/channel
    # desync (`transcode_failed`, "Input is shorter by 46394 samples") and
    # finish()'s cleanup then DELETED the raw OGG: total loss of a recoverable
    # recording. A failed transcode must now retain the raw OGG by uploading it
    # as a fallback, so a reviewable artifact survives.


class _OggWritingRecorder(_FakeRecorder):
    """A fake recorder whose start() writes a NON-EMPTY OGG at output_path, so
    finish()'s transcode-failure fallback has a raw OGG to retain."""

    async def start(self, *, output_path):
        await super().start(output_path=output_path)
        Path(output_path).write_bytes(b"OggS\x00fake-ogg-container-bytes")


class TestOggFallbackRetainsAudio(unittest.TestCase):
    def _make_with_ogg(self, *, transcode, upload=None, uploaded=None):
        session = _FakeSession()
        holder = {}

        def factory(sess, sr):
            r = _OggWritingRecorder(sess, sr)
            holder["recorder"] = r
            return r

        sink = uploaded if uploaded is not None else {}

        async def default_upload(url, body, content_type="audio/mpeg"):
            sink["url"] = url
            sink["body"] = body
            sink["content_type"] = content_type

        r = rec.InWorkerRecorder(
            session,
            recorder_factory=factory,
            transcode_fn=transcode,
            upload_fn=upload or default_upload,
        )
        return r, holder, sink

    def test_transcode_failure_uploads_raw_ogg_and_returns_manifest(self):
        # The v114 case: transcode throws, but a non-empty OGG exists. finish()
        # must upload the OGG (audio/ogg) and return a manifest — NOT None, NOT a
        # silent loss.
        async def boom_transcode(ogg, mp3):
            raise RuntimeError("Input is shorter by 46394 samples")

        r, _holder, sink = self._make_with_ogg(transcode=boom_transcode)
        r.wire()
        _begin(r)
        manifest = _finish(r)
        self.assertIsNotNone(manifest, "audio must NOT be silently lost")
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertEqual(sink["content_type"], "audio/ogg")
        self.assertEqual(sink["body"], b"OggS\x00fake-ogg-container-bytes")
        self.assertEqual(len(manifest.sha256), 64)
        # The fallback is a retained artifact, not a reported failure.
        self.assertIsNone(r.finish_failure)

    def test_truncated_transcode_falls_back_to_raw_ogg(self):
        # The completeness floor makes _default_transcode RAISE when most frames
        # were skipped (a truncated MP3). finish() must then treat it exactly
        # like any transcode failure and retain the FULL raw OGG — never upload
        # the partial MP3 as a clean success. Here the fake transcode writes a
        # short "truncated" MP3 AND raises, mimicking the floor's behavior.
        async def truncating_transcode(ogg, mp3):
            Path(mp3).write_bytes(b"ID3short-truncated-mp3")  # partial output...
            raise RuntimeError("transcode_truncated_below_floor")  # ...but rejected

        r, _holder, sink = self._make_with_ogg(transcode=truncating_transcode)
        r.wire()
        _begin(r)
        manifest = _finish(r)
        self.assertIsNotNone(manifest, "truncated audio must fall back, not be lost")
        # The FULL raw OGG was uploaded, not the truncated MP3.
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertEqual(sink["content_type"], "audio/ogg")
        self.assertEqual(sink["body"], b"OggS\x00fake-ogg-container-bytes")

    def test_empty_mp3_falls_back_to_raw_ogg(self):
        # An empty MP3 (the encoder produced nothing usable) is treated exactly
        # like a transcode throw: retain the raw OGG rather than lose everything.
        async def empty_transcode(ogg, mp3):
            Path(mp3).write_bytes(b"")

        r, _holder, sink = self._make_with_ogg(transcode=empty_transcode)
        r.wire()
        _begin(r)
        manifest = _finish(r)
        self.assertIsNotNone(manifest)
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertEqual(sink["content_type"], "audio/ogg")

    def test_ogg_fallback_upload_failure_is_total_loss(self):
        # If even the OGG fallback upload fails, there is genuinely nothing left:
        # finish() returns None and names transcode_failed so the caller latches
        # the loss truthfully (it does NOT fake a success).
        async def boom_transcode(ogg, mp3):
            raise RuntimeError("desync")

        async def boom_upload(url, body, content_type="audio/mpeg"):
            raise RuntimeError("s3_down")

        r, _holder, _sink = self._make_with_ogg(
            transcode=boom_transcode, upload=boom_upload,
        )
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "transcode_failed")

    def test_transcode_failure_with_no_ogg_is_total_loss(self):
        # No MP3 AND no readable OGG (the default fake recorder writes no OGG):
        # this is the only genuine total-loss case, reported as transcode_failed.
        async def boom_transcode(ogg, mp3):
            raise RuntimeError("desync")

        r, _session, _holder = _make(transcode=boom_transcode)  # plain _FakeRecorder
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "transcode_failed")


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

    def test_pyav_transcode_survives_channel_desync(self):
        # THE v114 REPRODUCER. The candidate (left) and bot (right) channels
        # finished with MISMATCHED sample counts, so a decoded frame arrived
        # short/desynced and the un-hardened encode threw `transcode_failed`
        # ("Input is shorter by 46394 samples"). Feed a frame stream whose second
        # frame is a SHORTER, MONO frame (the shape that previously threw) and
        # assert the hardened resampler coerces it and still produces a valid MP3
        # rather than losing the whole recording.
        with tempfile.TemporaryDirectory() as d:
            ogg = Path(d) / "in.ogg"
            mp3 = Path(d) / "out.mp3"
            oc = _av.open(str(ogg), mode="w")
            st = oc.add_stream("libopus", rate=48000, layout="stereo")
            sr = 48000

            def _stereo_frame(n):
                t = _np.arange(n) / sr
                l = (0.4 * _np.sin(2 * _np.pi * 440 * t) * 32767).astype(_np.int16)
                r = (0.4 * _np.sin(2 * _np.pi * 880 * t) * 32767).astype(_np.int16)
                inter = _np.empty(l.size + r.size, dtype=_np.int16)
                inter[0::2] = l
                inter[1::2] = r
                f = _av.AudioFrame.from_ndarray(
                    inter.reshape(1, -1), format="s16", layout="stereo")
                f.sample_rate = sr
                return f

            # A full stereo frame, then a SHORTER stereo frame (the desync tail).
            for n in (int(sr * 0.30), int(sr * 0.05)):
                for p in st.encode(_stereo_frame(n)):
                    oc.mux(p)
            for p in st.encode(None):
                oc.mux(p)
            oc.close()

            # Must NOT raise, and must produce a non-empty, decodable MP3.
            _run(rec._default_transcode(ogg, mp3))
            self.assertTrue(mp3.exists() and mp3.stat().st_size > 0)
            c = _av.open(str(mp3))
            try:
                astream = c.streams.audio[0]
                self.assertGreater(sum(1 for _ in c.decode(astream)), 0)
            finally:
                c.close()

    def test_pyav_transcode_fails_when_most_frames_skipped(self):
        # THE COMPLETENESS-FLOOR GUARANTEE (adversarial-review MED). A desync
        # that corrupts MOST frames but encodes a FEW must NOT pass a truncated
        # MP3 off as success — it must RAISE so finish() takes the OGG fallback
        # and preserves the full raw audio. We simulate the corruption by making
        # the resampler throw on all but the first frame, driving the skipped
        # fraction far above the 2% floor.
        import unittest.mock as _mock

        with tempfile.TemporaryDirectory() as d:
            ogg = Path(d) / "in.ogg"
            mp3 = Path(d) / "out.mp3"
            oc = _av.open(str(ogg), mode="w")
            st = oc.add_stream("libopus", rate=48000, layout="stereo")
            sr = 48000
            # ~1.5s of audio → enough Opus frames that "all but the first fail"
            # is well above the 2% floor.
            t = _np.arange(int(sr * 1.5)) / sr
            l = (0.4 * _np.sin(2 * _np.pi * 440 * t) * 32767).astype(_np.int16)
            r = (0.4 * _np.sin(2 * _np.pi * 880 * t) * 32767).astype(_np.int16)
            inter = _np.empty(l.size + r.size, dtype=_np.int16)
            inter[0::2] = l
            inter[1::2] = r
            frame = _av.AudioFrame.from_ndarray(
                inter.reshape(1, -1), format="s16", layout="stereo")
            frame.sample_rate = sr
            for p in st.encode(frame):
                oc.mux(p)
            for p in st.encode(None):
                oc.mux(p)
            oc.close()

            from av.audio.resampler import AudioResampler as _RealResampler

            class _FlakyResampler:
                """Encodes the first input frame, throws on every subsequent one
                — the "most of the stream is corrupt" shape."""

                def __init__(self, *a, **k):
                    self._inner = _RealResampler(*a, **k)
                    self._n = 0

                def resample(self, frame):
                    if frame is not None:
                        self._n += 1
                        if self._n > 1:
                            raise RuntimeError("simulated desync corruption")
                    return self._inner.resample(frame)

            with _mock.patch(
                "av.audio.resampler.AudioResampler", _FlakyResampler,
            ):
                with self.assertRaises(RuntimeError):
                    _run(rec._default_transcode(ogg, mp3))


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
