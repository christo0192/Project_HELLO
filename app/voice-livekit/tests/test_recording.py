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


class TestDefaultUploadUpsert(unittest.TestCase):
    """v115 (2026-09-04): the OGG fallback FIRED but its upload failed and nothing
    landed. Root cause: the presigned PUT was insert-only, so a second write to
    the key (a retry, or the fallback re-PUT after the MP3 leg touched the object)
    collided 409. The mint now uses `upsert:true` and the raw PUT mirrors
    Supabase's own `uploadToSignedUrl` by sending `x-upsert: true`, so the write
    OVERWRITES instead of colliding.

    These exercise the REAL `_default_upload` against a fake httpx that models an
    insert-only-vs-upsert Supabase signed-upload endpoint — a server that would
    have rejected the fallback before the fix and accepts it now."""

    def _patched_httpx(self, server):
        """Return a context-manager patch installing a fake httpx module whose
        AsyncClient.put delegates to `server(url, content, headers)`."""
        import types
        import unittest.mock as _mock

        class _Resp:
            def __init__(self, status_code):
                self.status_code = status_code

        class _Client:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def put(self, url, content=None, headers=None):
                return _Resp(server(url, content, headers or {}))

        fake = types.ModuleType("httpx")
        fake.AsyncClient = _Client
        fake.Timeout = lambda *a, **k: None
        return _mock.patch.dict("sys.modules", {"httpx": fake})

    def test_upload_sends_x_upsert_and_content_type(self):
        seen = {}

        def server(url, content, headers):
            seen["url"] = url
            seen["content"] = content
            seen["headers"] = {k.lower(): v for k, v in headers.items()}
            return 200

        with self._patched_httpx(server):
            _run(rec._default_upload("https://s/put?token=x", b"OggS\x00audio", "audio/ogg"))
        self.assertEqual(seen["content"], b"OggS\x00audio")
        self.assertEqual(seen["headers"]["content-type"], "audio/ogg")
        # THE FIX: the PUT declares upsert so an overwrite is permitted.
        self.assertEqual(seen["headers"]["x-upsert"], "true")

    def test_insert_only_server_would_reject_but_upsert_succeeds(self):
        # Models Supabase: an insert-only signed PUT 409s when the key exists;
        # an upsert PUT (x-upsert:true) overwrites and returns 200. Before the
        # fix the header was absent, so this server would have failed the
        # fallback with upload_failed_status_409.
        existing = {"phone-obj.mp3"}

        def server(url, content, headers):
            hs = {k.lower(): v for k, v in headers.items()}
            key = "phone-obj.mp3"
            if key in existing and hs.get("x-upsert") != "true":
                return 409  # insert-only collision — the v115 failure
            existing.add(key)
            return 200

        # With the x-upsert header the fallback OVERWRITES rather than colliding.
        with self._patched_httpx(server):
            _run(rec._default_upload("https://s/put?token=x", b"OggS\x00fallback", "audio/ogg"))

    def test_upload_surfaces_server_error_status(self):
        with self._patched_httpx(lambda *a: 500):
            with self.assertRaises(RuntimeError) as ctx:
                _run(rec._default_upload("https://s/put?token=x", b"x", "audio/mpeg"))
        self.assertIn("upload_failed_status_500", str(ctx.exception))


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

    def test_pyav_transcode_unequal_channel_length_yields_complete_mp3(self):
        # THE v115 CASE, sharpened. The mixed OGG has channels of UNEQUAL length,
        # so decoded frames arrive at VARYING sample counts (and a short tail).
        # The v114 resampler-only path fed those odd-sized frames straight to
        # libmp3lame, which needs frame_size (1152) input — so most frames were
        # SKIPPED and the completeness floor tripped (`transcode_truncated`),
        # dropping a fully-recoverable call to the OGG fallback. With the FIFO
        # chunker the desync is absorbed into the sample timeline: the transcode
        # must produce a COMPLETE, decodable MP3 and skip effectively nothing.
        import logging as _logging

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

            # A long run of IRREGULAR frame lengths (never a multiple of 1152),
            # then a very short desync tail — the shape that previously skipped.
            for n in (1000, 1500, 777, 2049, 333, 1201, 1153, 999, 60):
                for p in st.encode(_stereo_frame(n)):
                    oc.mux(p)
            for p in st.encode(None):
                oc.mux(p)
            oc.close()

            # Capture the recorder's warnings: after the fix a normal desynced
            # call must skip ZERO frames (so no `transcode_skipped_frames`).
            handler = _logging.getLogger("voice-livekit.recording")
            records = []

            class _Cap(_logging.Handler):
                def emit(self, rec_):
                    records.append(rec_.getMessage())

            cap = _Cap()
            handler.addHandler(cap)
            try:
                _run(rec._default_transcode(ogg, mp3))
            finally:
                handler.removeHandler(cap)

            self.assertTrue(mp3.exists() and mp3.stat().st_size > 0)
            c = _av.open(str(mp3))
            try:
                astream = c.streams.audio[0]
                self.assertGreater(sum(1 for _ in c.decode(astream)), 0)
            finally:
                c.close()
            # No frames were skipped — the desync was absorbed, not dropped.
            self.assertFalse(
                any("transcode_skipped_frames" in m or "transcode_truncated" in m
                    for m in records),
                f"unexpected skip/truncate on a normal desynced call: {records}",
            )

    def test_pyav_transcode_rebuilds_resampler_on_layout_change(self):
        # THE TRUE v114/v115 ROOT CAUSE. `av.AudioResampler` locks to the layout
        # of the FIRST frame and raises `ValueError: Frame does not match
        # AudioResampler setup` on any later frame whose input layout differs —
        # exactly what the channel-desync's short MONO tail frame is. The v114
        # resampler-only path (and a FIFO alone) skipped that whole tail and the
        # floor tripped. The fix REBUILDS the resampler for the new input shape
        # and retries the same frame, dropping nothing.
        #
        # We drive `_default_transcode` with a decoder STUB that yields stereo
        # frames then a mono tail — the shape a real desync produces — and assert
        # a complete MP3 with ZERO skipped frames.
        import logging as _logging
        import unittest.mock as _mock

        sr = 48000

        def _frame(n, layout):
            ch = 2 if layout == "stereo" else 1
            a = (0.3 * _np.sin(2 * _np.pi * 440 * _np.arange(n) / sr) * 32767).astype(_np.int16)
            arr = _np.tile(a, (ch, 1))  # planar s16p, ch planes
            f = _av.AudioFrame.from_ndarray(arr, format="s16p", layout=layout)
            f.sample_rate = sr
            return f

        # Stereo body, then a MONO desync tail (the frame that made the resampler
        # raise mid-stream on the live calls).
        frames = [_frame(1152, "stereo"), _frame(900, "stereo"),
                  _frame(1152, "stereo"), _frame(240, "mono")]

        class _FakeStream:
            rate = sr

            class layout:  # noqa: N801
                channels = (0, 1)  # len==2 → out_layout stereo

        class _FakeInContainer:
            streams = type("S", (), {"audio": [_FakeStream()]})()

            def decode(self, _stream):
                yield from frames

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as d:
            mp3 = Path(d) / "out.mp3"
            real_open = _av.open

            def fake_open(path, mode="r", **kw):
                if mode == "r":
                    return _FakeInContainer()
                return real_open(path, mode=mode, **kw)

            log = _logging.getLogger("voice-livekit.recording")
            records = []

            class _Cap(_logging.Handler):
                def emit(self, rec_):
                    records.append(rec_.getMessage())

            cap = _Cap()
            log.addHandler(cap)
            try:
                with _mock.patch.object(_av, "open", side_effect=fake_open):
                    _run(rec._default_transcode(Path("ignored.ogg"), mp3))
            finally:
                log.removeHandler(cap)

            self.assertTrue(mp3.exists() and mp3.stat().st_size > 0)
            c = real_open(str(mp3))
            try:
                astream = c.streams.audio[0]
                self.assertGreater(sum(1 for _ in c.decode(astream)), 0)
            finally:
                c.close()
            # The mono tail was NOT skipped — the resampler rebuilt and absorbed it.
            self.assertFalse(
                any("transcode_skipped_frames" in m or "transcode_truncated" in m
                    for m in records),
                f"the mono desync tail was skipped, not absorbed: {records}",
            )

    def _transcode_with_decoded_frames(self, frames, out_channels):
        """Drive `_default_transcode` with a decoder STUB yielding `frames`, and
        return (mp3_total_samples, warning_messages). Lets a test control exact
        sample counts and compare the output length against the input."""
        import logging as _logging
        import unittest.mock as _mock

        class _FakeStream:
            rate = 48000

            class layout:  # noqa: N801
                channels = tuple(range(out_channels))

        class _FakeInContainer:
            streams = type("S", (), {"audio": [_FakeStream()]})()

            def decode(self, _stream):
                yield from frames

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as d:
            mp3 = Path(d) / "out.mp3"
            real_open = _av.open

            def fake_open(path, mode="r", **kw):
                return _FakeInContainer() if mode == "r" else real_open(path, mode=mode, **kw)

            log = _logging.getLogger("voice-livekit.recording")
            records = []

            class _Cap(_logging.Handler):
                def emit(self, rec_):
                    records.append(rec_.getMessage())

            cap = _Cap()
            log.addHandler(cap)
            try:
                with _mock.patch.object(_av, "open", side_effect=fake_open):
                    _run(rec._default_transcode(Path("ignored.ogg"), mp3))
            finally:
                log.removeHandler(cap)

            self.assertTrue(mp3.exists() and mp3.stat().st_size > 0)
            c = real_open(str(mp3))
            try:
                astream = c.streams.audio[0]
                total = sum(fr.samples for fr in c.decode(astream))
            finally:
                c.close()
            return total, records

    @staticmethod
    def _pcm_frame(n, layout, sample_rate=48000):
        ch = 2 if layout == "stereo" else 1
        a = (0.3 * _np.sin(2 * _np.pi * 440 * _np.arange(n) / sample_rate) * 32767).astype(_np.int16)
        arr = _np.tile(a, (ch, 1))  # planar s16p, ch planes
        f = _av.AudioFrame.from_ndarray(arr, format="s16p", layout=layout)
        f.sample_rate = sample_rate
        return f

    def test_pyav_transcode_layout_change_loses_zero_samples(self):
        # BUG 3. Rebuilding the resampler on a layout change must FLUSH the old
        # resampler's buffer first — otherwise its buffered conversion state
        # vanishes silently (no skip increment, no short encode), so the floor
        # never sees the loss and a truncated MP3 uploads as "clean".
        #
        # To make the loss OBSERVABLE the resampler must actually buffer: the
        # stub stream advertises 48 kHz (so `_default_transcode` targets 48 kHz)
        # but the frames are 44.1 kHz, forcing rate conversion — the old
        # resampler then holds ~17 samples of conversion tail at EACH rebuild
        # boundary. One boundary is sub-millisecond and encoder delay would mask
        # it, so the input ALTERNATES layout ~120 times: the pre-fix path drops
        # the buffer ~119 times for a cumulative loss of ~2000 samples (~45 ms),
        # well over one MP3 frame. The fixed path flushes each time and loses
        # none. Output must match the RESAMPLED input length within one MP3 frame.
        n_frames = 120
        per = 1200  # not a frame_size multiple; realistic decoded chunk
        frames = [
            self._pcm_frame(per, "stereo" if i % 2 == 0 else "mono", sample_rate=44100)
            for i in range(n_frames)
        ]
        total, records = self._transcode_with_decoded_frames(frames, out_channels=2)

        # Expected OUTPUT samples ≈ input × (48000/44100).
        expected = round(n_frames * per * 48000 / 44100)
        # One MP3 frame of slack for encoder delay/padding — but NOT the ~2000
        # samples the pre-fix rebuild silently dropped across the boundaries.
        self.assertGreaterEqual(
            total, expected - 1152,
            f"samples lost across the rebuilds: got {total}, expected ~{expected} "
            f"(records={records})",
        )
        # And it must NOT have been laundered as a skip/truncate either.
        self.assertFalse(
            any("transcode_skipped_frames" in m or "transcode_truncated" in m for m in records),
            f"a rebuild loss was hidden as a skip/truncate: {records}",
        )

    def test_pyav_transcode_final_tail_over_frame_size_is_fully_encoded(self):
        # BUG 4 (robustness/guarantee). After the resampler's tail is flushed
        # post-loop, the FIFO can hold MORE than frame_size (1152) samples. The
        # final drain now CHUNKS those into frame_size frames plus the short
        # remainder rather than encoding one oversized frame.
        #
        # NB: in the currently-pinned PyAV (18.1.0) libmp3lame happens to accept
        # an oversized input frame and chunk it internally, so the OLD single
        # `fifo.read()` did not lose audio HERE — this is therefore a GUARANTEE
        # test, not a version-specific reproducer. The chunked drain removes the
        # reliance on that undocumented tolerance (stricter FFmpeg/libmp3lame
        # builds raise on a non-frame_size input frame, which the wrapping
        # `except` would then silently swallow). Either way the invariant must
        # hold: a >frame_size final tail is FULLY encoded, never truncated.
        n = 5 * 1152  # 5760 samples, all delivered as one final-drain batch
        frames = [self._pcm_frame(n, "stereo")]
        total, records = self._transcode_with_decoded_frames(frames, out_channels=2)
        # The whole tail must be encoded (within one MP3 frame of encoder slack),
        # never truncated.
        self.assertGreaterEqual(
            total, n - 1152,
            f"the >frame_size final tail was truncated: got {total} of {n} "
            f"(records={records})",
        )
        self.assertFalse(
            any("transcode_skipped_frames" in m or "transcode_truncated" in m for m in records),
            f"the tail drop was hidden as a skip/truncate: {records}",
        )

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
