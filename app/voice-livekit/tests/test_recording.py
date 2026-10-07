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
import unittest.mock
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


class _FakeInTap:
    """Stand-in for the RecorderIO input tap (RecorderAudioInput). Async-iterable
    with a `label`, so the counting input proxy can wrap it and forward through
    it exactly as it would the real tap."""

    label = "TAP_IN"

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration  # a fake never yields; live frames come from RoomIO


class _FakeOutTap:
    """Stand-in for the RecorderIO output tap (RecorderAudioOutput). Exposes an
    async `capture_frame` and a `label`, so the counting output proxy can wrap it
    and forward pushes through it exactly as it would the real tap."""

    label = "TAP_OUT"

    def __init__(self):
        self.captured = []

    async def capture_frame(self, frame):
        self.captured.append(frame)


class _FakeRecorder:
    """Records call order and the .recording flag transitions RecorderIO exposes."""

    def __init__(self, session, sample_rate, *, fail_start=False, write_ogg=True):
        self.session = session
        self.sample_rate = sample_rate
        self.calls = []
        self.recording = False
        self.recording_started_at = None
        self._fail_start = fail_start
        # write_ogg=False models the LIVE zero-capture failure: start() runs and
        # recording flips True, but NO OGG is ever written (the encode thread
        # muxed nothing because zero frames were captured), so finish() finds a
        # missing OGG. This is the v114/v115/v116 signature.
        self._write_ogg = write_ogg

    def record_input(self, audio):
        self.calls.append(("record_input", audio))
        return _FakeInTap()

    def record_output(self, audio):
        self.calls.append(("record_output", audio))
        return _FakeOutTap()

    async def start(self, *, output_path):
        if self._fail_start:
            raise RuntimeError("boom_start")
        self.calls.append(("start", str(output_path)))
        self.recording = True
        import time
        self.recording_started_at = time.time()
        # A recorder that CAPTURED audio leaves a non-empty OGG on disk. The real
        # RecorderIO defers file creation to the first muxed packet (PyAV 18.1.0),
        # so "captured audio" ⇔ "OGG exists". The default fake writes one so the
        # happy-path tests exercise the normal transcode/upload path; the
        # zero-capture case is modelled explicitly by _NoOggRecorder below (which
        # matches the LIVE v114/v115/v116 failure: no OGG written).
        self._output_path = Path(output_path)
        if self._write_ogg:
            Path(output_path).write_bytes(b"OggS\x00fake-ogg-container-bytes")

    async def aclose(self):
        self.calls.append("aclose")
        self.recording = False


def _make(session=None, *, fail_wire=False, fail_start=False, transcode=None, upload=None,
          uploaded=None, tmp=None, write_ogg=True):
    session = session or _FakeSession()
    holder = {}

    def factory(sess, sr):
        if fail_wire:
            raise RuntimeError("boom_wire")
        r = _FakeRecorder(sess, sr, fail_start=fail_start, write_ogg=write_ogg)
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
        # taps are swapped into the session BEFORE any recording begins. Each is
        # wrapped in a transparent counting proxy (zero-capture instrumentation),
        # so assert the proxy is installed and DELEGATES to the real tap (the fake
        # record_input/record_output return the sentinels "TAP_IN"/"TAP_OUT").
        self.assertIsInstance(session.input.audio, rec._CountingAudioInput)
        self.assertIsInstance(session.output.audio, rec._CountingAudioOutput)
        # __getattr__ passthrough: the wrapped tap's `label` resolves THROUGH the
        # proxy, proving it forwards non-frame attributes verbatim to the real tap.
        self.assertEqual(session.input.audio.label, "TAP_IN")
        self.assertEqual(session.output.audio.label, "TAP_OUT")

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
        # v117 OGG-FIRST-THEN-MP3-UPGRADE order: finish() must PUT the raw OGG
        # FIRST (the durability guarantee, before the slow transcode that the
        # shutdown grace can cancel), then re-PUT the transcoded MP3 to the SAME
        # key as a best-effort upgrade. Record EVERY PUT so the order is proven.
        puts = []

        async def recording_upload(url, body, content_type="audio/mpeg"):
            puts.append((content_type, body))

        r, _session, holder = _make(upload=recording_upload)
        r.wire()
        _begin(r)
        manifest = _finish(r)
        self.assertIsNotNone(manifest)
        self.assertIn("aclose", holder["recorder"].calls)
        # Exactly two PUTs to the same key: OGG durable first, MP3 upgrade second.
        self.assertEqual(len(puts), 2, f"expected OGG-then-MP3 PUTs: {puts}")
        self.assertEqual(puts[0][0], "audio/ogg")   # durable OGG lands FIRST
        self.assertEqual(puts[0][1], b"OggS\x00fake-ogg-container-bytes")
        self.assertEqual(puts[1][0], "audio/mpeg")  # MP3 upgrade re-PUTs same key
        self.assertEqual(puts[1][1], b"ID3fake-mp3-bytes")
        # The returned manifest reflects what LANDED last — the MP3 upgrade.
        self.assertEqual(manifest.size_bytes, len(b"ID3fake-mp3-bytes"))
        self.assertEqual(manifest.content_type, "audio/mpeg")
        self.assertEqual(len(manifest.sha256), 64)

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
        # A transcode failure on a call with NO OGG (the live zero-capture case)
        # is swallowed — never raised into the call path. (With an OGG present a
        # transcode failure instead falls back to the raw OGG; that is covered by
        # TestOggFallbackRetainsAudio.)
        async def boom_transcode(ogg, mp3):
            raise RuntimeError("ffmpeg_missing")

        r, _session, _holder = _make(transcode=boom_transcode, write_ogg=False)
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
    def test_finish_failure_names_upload_leg_when_store_unreachable(self):
        # v117 OGG-FIRST: the durability PUT is the OGG and it happens BEFORE the
        # transcode. If the store is unreachable, that first OGG PUT fails and
        # finish() names `upload_failed` — the transcode is never even attempted
        # (there is no "fallback upload after a transcode leg" anymore; the OGG
        # IS the primary durable write). This is a genuine total loss.
        async def never_called_transcode(ogg, mp3):  # pragma: no cover
            raise AssertionError("transcode must not run if the OGG PUT failed")

        async def boom_upload(url, body, content_type="audio/mpeg"):
            raise RuntimeError("s3_down")

        r, _session, _holder = _make(transcode=never_called_transcode, upload=boom_upload)
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "upload_failed")

    def test_finish_failure_names_missing_ogg_as_no_audio_captured(self):
        # THE RCA (2026-09-04): the live zero-capture failure. The recorder wrote
        # NO OGG (zero frames reached the encoder → PyAV never materialized the
        # file). finish() must report `no_audio_captured` — NOT `transcode_failed`
        # (the mislabel that misdirected #223/#227/#228 into fixing a desync that
        # never existed). The transcode is not even attempted (the no-audio guard
        # fires first).
        async def never_called_transcode(ogg, mp3):  # pragma: no cover
            raise AssertionError("transcode must not run when the OGG is missing")

        r, _session, _holder = _make(transcode=never_called_transcode, write_ogg=False)
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "no_audio_captured")

    def test_finish_failure_names_empty_ogg_as_no_audio_captured(self):
        # A zero-BYTE OGG is the same class of failure as a missing one: the
        # encode thread muxed nothing. Report `no_audio_captured`, not a transcode
        # error. Model it with a recorder that writes an empty OGG at start().
        class _EmptyOggRecorder(_FakeRecorder):
            async def start(self, *, output_path):
                # write_ogg=False so the base start() writes nothing; we then
                # write a 0-byte file to model an OGG that exists but is empty.
                await super().start(output_path=output_path)
                Path(output_path).write_bytes(b"")  # 0-byte OGG

        session = _FakeSession()
        holder = {}

        def factory(sess, sr):
            r = _EmptyOggRecorder(sess, sr, write_ogg=False)
            holder["recorder"] = r
            return r

        r = rec.InWorkerRecorder(session, recorder_factory=factory)
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "no_audio_captured")

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

    def test_synchronous_close_raise_still_cleans_up_and_discard_is_final(self):
        r, _session, holder = _make()
        r.wire()
        _begin(r)

        def broken_close():
            raise RuntimeError("encoder_wedged_before_coroutine")

        holder["recorder"].aclose = broken_close
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "recorder_close_failed")
        self.assertFalse(r._ogg_path.exists())

        other, _session, holder = _make()
        other.wire()
        _begin(other)
        holder["recorder"].aclose = broken_close
        _run(other.discard())
        self.assertFalse(other._ogg_path.exists())
        self.assertTrue(other._failed)

    def test_hanging_close_uploads_flushed_ogg_without_false_duration(self):
        """A close that suppresses cancellation cannot erase already-flushed audio."""
        uploaded = {}
        r, _session, holder = _make(uploaded=uploaded)
        r.wire()
        _begin(r)

        async def suppress_cancel():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                # Model the provider/SDK close that acknowledges cancellation
                # only after its own cleanup. The finish path must not wait for
                # that acknowledgement before shipping the OGG.
                return None

        holder["recorder"].aclose = suppress_cancel
        with unittest.mock.patch.object(rec, "RECORDER_CLOSE_TIMEOUT_SEC", 0.01):
            manifest = _finish(r)

        self.assertIsNotNone(manifest)
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertIsNone(manifest.duration_ms)
        self.assertEqual(uploaded["content_type"], "audio/ogg")
        self.assertEqual(uploaded["body"], b"OggS\x00fake-ogg-container-bytes")
        self.assertEqual(r.finish_failure, "recorder_close_timeout")

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

    # ── v114/v117: the OGG is NEVER silently gone ──────────────────────────
    # On the live v114 call the OGG→MP3 transcode died on a sample/channel
    # desync (`transcode_failed`, "Input is shorter by 46394 samples") and
    # finish()'s cleanup then DELETED the raw OGG: total loss of a recoverable
    # recording. On the live v117 call (session 1a19cee4) the OGG WAS captured
    # (3.9MB) but the inline transcode→PUT was cancelled by the shutdown grace
    # before the presigned PUT ran, so nothing landed. Both are closed by the
    # OGG-FIRST reorder in finish(): the raw OGG is PUT durably BEFORE the slow
    # transcode, and the MP3 is a best-effort upgrade — so a reviewable artifact
    # always survives a transcode/upgrade failure OR a shutdown-grace cancel.


class TestZeroCaptureInstrumentation(unittest.TestCase):
    """RCA 2026-09-04: the live failure could not be diagnosed from the INFO logs
    (wire OK + `started` fired + clean aclose, yet no OGG). These prove the
    instrumentation the next test call relies on: the counting proxies COUNT
    frames without altering them, and finish() emits the decisive capture line."""

    def test_counting_input_proxy_is_transparent_and_counts(self):
        # The proxy must forward __anext__ verbatim and increment the shared
        # counter once per frame — never dropping, delaying, or mutating a frame.
        counter = rec._FrameCounter()

        class _Inner:
            def __init__(self):
                self.n = 0

            def __aiter__(self):
                return self

            async def __anext__(self):
                self.n += 1
                if self.n > 3:
                    raise StopAsyncIteration
                return f"frame{self.n}"

        proxy = rec._CountingAudioInput(_Inner(), counter)
        got = []

        async def drain():
            it = proxy.__aiter__()
            try:
                while True:
                    got.append(await it.__anext__())
            except StopAsyncIteration:
                pass

        _run(drain())
        self.assertEqual(got, ["frame1", "frame2", "frame3"])  # forwarded verbatim
        self.assertEqual(counter.input, 3)                     # counted each
        self.assertEqual(counter.output, 0)                    # untouched

    def test_counting_output_proxy_is_transparent_and_counts(self):
        counter = rec._FrameCounter()

        class _Inner:
            def __init__(self):
                self.captured = []

            async def capture_frame(self, frame):
                self.captured.append(frame)

        inner = _Inner()
        proxy = rec._CountingAudioOutput(inner, counter)
        _run(proxy.capture_frame("a"))
        _run(proxy.capture_frame("b"))
        self.assertEqual(inner.captured, ["a", "b"])  # forwarded to the real tap
        self.assertEqual(counter.output, 2)           # counted each
        self.assertEqual(counter.input, 0)

    def test_output_proxy_delegates_attributes(self):
        # __getattr__ passthrough: non-capture attributes/methods resolve on the
        # wrapped tap so the SDK's pause/resume/flush/on_playback_finished path is
        # untouched by the proxy.
        counter = rec._FrameCounter()

        class _Inner:
            label = "RecorderIO"

            def flush(self):
                return "flushed"

        proxy = rec._CountingAudioOutput(_Inner(), counter)
        self.assertEqual(proxy.label, "RecorderIO")
        self.assertEqual(proxy.flush(), "flushed")

    def test_capture_log_reports_zero_capture_signature(self):
        # THE DECISIVE LINE. On the live failure the log must show
        # input_frames=0 output_frames=0 ogg_exists=false — the exact zero-capture
        # signature (missing OGG, not a transcode desync). Assert finish() emits
        # `in_worker_recording_capture` with those fields on a no-OGG recorder.
        import logging as _logging

        r, _session, _holder = _make(write_ogg=False)

        log = _logging.getLogger("voice-livekit.recording")
        msgs = []

        class _Cap(_logging.Handler):
            def emit(self, rec_):
                msgs.append(rec_.getMessage())

        cap = _Cap()
        log.addHandler(cap)
        try:
            # Attach BEFORE the lifecycle so wired/started/capture are all seen.
            r.wire()
            _begin(r)
            _finish(r)
        finally:
            log.removeHandler(cap)

        capture = [m for m in msgs if m.startswith("in_worker_recording_capture")]
        self.assertEqual(len(capture), 1, f"expected exactly one capture line: {msgs}")
        line = capture[0]
        self.assertIn("input_frames=0", line)
        self.assertIn("output_frames=0", line)
        self.assertIn("ogg_exists=False", line)
        # and the lifecycle order lines were emitted with the state fields
        self.assertTrue(any(m.startswith("in_worker_recording_wired recording=False") for m in msgs))
        self.assertTrue(any(m.startswith("in_worker_recording_started recording=True") for m in msgs))

    def test_capture_log_reports_engaged_capture(self):
        # The POSITIVE control: a recorder that "captured" (OGG present) and whose
        # taps saw frames must log ogg_exists=True with the frame counts it saw,
        # so a healthy call is distinguishable from the zero-capture failure.
        import logging as _logging

        r, session, _holder = _make()  # default fake writes an OGG at start()
        r.wire()
        _begin(r)

        # Simulate the live pipeline pushing frames THROUGH the installed proxies:
        # the session pushes TTS into session.output.audio (our output proxy) and
        # the recognition loop pulls candidate audio through session.input.audio
        # (our input proxy). Both proxies share r._counter, so the counts they
        # increment are exactly what the capture line reports.
        _run(session.output.audio.capture_frame("bot_tts_frame"))

        log = _logging.getLogger("voice-livekit.recording")
        msgs = []

        class _Cap(_logging.Handler):
            def emit(self, rec_):
                msgs.append(rec_.getMessage())

        cap = _Cap()
        log.addHandler(cap)
        try:
            manifest = _finish(r)
        finally:
            log.removeHandler(cap)

        self.assertIsNotNone(manifest)  # healthy: transcodes + uploads
        capture = [m for m in msgs if m.startswith("in_worker_recording_capture")]
        self.assertEqual(len(capture), 1)
        self.assertIn("ogg_exists=True", capture[0])
        self.assertIn("output_frames=1", capture[0])  # the one push above


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

    def test_ogg_upload_failure_is_total_loss(self):
        # v117 OGG-FIRST: the durability PUT is the OGG, and it happens BEFORE
        # the transcode is ever attempted. If that PUT fails the store is
        # unreachable and nothing landed — a genuine total loss. finish() returns
        # None and names `upload_failed` so the caller latches the loss truthfully
        # (it does NOT fake a success, and it does NOT mislabel it transcode_failed
        # since the transcode was never even reached).
        async def boom_transcode(ogg, mp3):  # pragma: no cover — unreachable
            raise AssertionError("transcode must not run if the OGG PUT failed")

        async def boom_upload(url, body, content_type="audio/mpeg"):
            raise RuntimeError("s3_down")

        r, _holder, _sink = self._make_with_ogg(
            transcode=boom_transcode, upload=boom_upload,
        )
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "upload_failed")

    def test_v117_transcode_raises_after_ogg_put_keeps_durable_ogg(self):
        # THE v117 PROD FAILURE (session 1a19cee4), covered directly. A valid OGG
        # was captured (3.9MB) but the MP3 transcode/upgrade never completed
        # (cancelled/failed) — pre-fix, nothing was ever PUT, so the object was
        # `object_unreadable` and the session hung `recording_egress_status=active`
        # forever. With OGG-first the raw OGG is PUT BEFORE the transcode, so a
        # transcode that raises AFTER the OGG landed is NOT a total loss: the
        # durable OGG remains and finish() returns a valid ogg manifest.
        puts = []
        ogg_put_happened = {"v": False}

        async def upload(url, body, content_type="audio/mpeg"):
            puts.append((content_type, body))
            if content_type == "audio/ogg":
                ogg_put_happened["v"] = True

        async def transcode_raises_after_ogg(ogg, mp3):
            # The OGG durability PUT must already have landed by the time the
            # transcode runs — this is the whole point of the reorder.
            assert ogg_put_happened["v"], "OGG must be PUT before transcode runs"
            raise RuntimeError("Input is shorter by 46394 samples")

        r, _holder, _sink = self._make_with_ogg(
            transcode=transcode_raises_after_ogg, upload=upload,
        )
        r.wire()
        _begin(r)
        manifest = _finish(r)
        self.assertIsNotNone(manifest, "the durable OGG must NOT be a total loss")
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertEqual(manifest.size_bytes, len(b"OggS\x00fake-ogg-container-bytes"))
        self.assertEqual(len(manifest.sha256), 64)
        self.assertIsNone(r.finish_failure)  # a retained artifact, not a failure
        # Only the OGG was PUT (the MP3 upgrade PUT never ran — transcode threw).
        self.assertEqual(len(puts), 1)
        self.assertEqual(puts[0][0], "audio/ogg")

    def test_v117_transcode_cancelled_after_ogg_put_keeps_durable_ogg(self):
        # THE SHUTDOWN-CANCEL SHAPE (v117 root cause): LiveKit's entrypoint-exit
        # grace cancels finish() DURING the transcode. asyncio.CancelledError
        # raised by the transcode step must leave the ALREADY-DURABLE OGG in
        # place and still yield a valid ogg manifest (the audio is safely stored),
        # rather than propagating a total loss.
        puts = []

        async def upload(url, body, content_type="audio/mpeg"):
            puts.append((content_type, body))

        async def transcode_cancelled(ogg, mp3):
            raise asyncio.CancelledError()

        r, _holder, _sink = self._make_with_ogg(
            transcode=transcode_cancelled, upload=upload,
        )
        r.wire()
        _begin(r)
        manifest = _finish(r)
        self.assertIsNotNone(manifest, "a cancel after the OGG PUT is not a loss")
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertEqual(manifest.size_bytes, len(b"OggS\x00fake-ogg-container-bytes"))
        self.assertIsNone(r.finish_failure)
        self.assertEqual(len(puts), 1)
        self.assertEqual(puts[0][0], "audio/ogg")

    def test_v117_upgrade_put_fails_after_ogg_put_keeps_durable_ogg(self):
        # The transcode SUCCEEDS but the upgrade re-PUT of the MP3 fails (e.g. a
        # transient store error on the second write). The durable OGG already
        # landed on the first PUT, so this is NOT a loss: keep the OGG manifest.
        puts = []

        async def upload(url, body, content_type="audio/mpeg"):
            if content_type == "audio/mpeg":
                raise RuntimeError("upgrade_put_500")
            puts.append((content_type, body))

        async def good_transcode(ogg, mp3):
            Path(mp3).write_bytes(b"ID3fake-mp3-bytes")

        r, _holder, _sink = self._make_with_ogg(
            transcode=good_transcode, upload=upload,
        )
        r.wire()
        _begin(r)
        manifest = _finish(r)
        self.assertIsNotNone(manifest, "a failed MP3 upgrade must keep the OGG")
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertIsNone(r.finish_failure)
        # The OGG PUT succeeded; the MP3 upgrade PUT raised and was swallowed.
        self.assertEqual(len(puts), 1)
        self.assertEqual(puts[0][0], "audio/ogg")

    def test_no_ogg_is_no_audio_captured_not_transcode_failed(self):
        # RCA 2026-09-04: NO OGG written (zero frames captured — the LIVE
        # failure). This is NOT a transcode failure: the transcode is never
        # attempted because the no-audio guard fires first. finish() reports
        # `no_audio_captured` so the failure names its real cause instead of the
        # `transcode_failed` mislabel that misdirected #223/#227/#228.
        async def never_called_transcode(ogg, mp3):  # pragma: no cover
            raise AssertionError("transcode must not run when the OGG is missing")

        r, _session, _holder = _make(transcode=never_called_transcode, write_ogg=False)
        r.wire()
        _begin(r)
        self.assertIsNone(_finish(r))
        self.assertEqual(r.finish_failure, "no_audio_captured")


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


class TestAudioHealthHeartbeat(unittest.TestCase):
    """FIX 4 (2026-09-06, live call ac7c8c77): the outbound audio path died while
    the worker kept speaking and nothing surfaced it until the candidate hung up.
    The recorder taps already count frames; this heartbeat turns those counters
    into a periodic content-free health signal (input/output deltas) plus a WARN
    when input audio stalls, so a starved path is visible DURING the call."""

    def test_frame_count_properties_reflect_the_counter(self):
        r, _, _ = _make()
        r.wire()
        _begin(r)
        self.assertEqual(r.input_frames, 0)
        self.assertEqual(r.output_frames, 0)
        r._counter.input = 7
        r._counter.output = 3
        self.assertEqual(r.input_frames, 7)
        self.assertEqual(r.output_frames, 3)

    def test_heartbeat_logs_health_and_stops_when_inactive(self):
        r, _, _ = _make()
        r.wire()
        _begin(r)
        self.assertTrue(r.active)

        async def drive():
            # Simulate frames arriving between ticks, then flip inactive so the
            # loop terminates.
            with unittest.mock.patch.object(rec.logger, "info") as info, \
                 unittest.mock.patch.object(rec.logger, "warning") as warn:
                task = asyncio.ensure_future(
                    r.audio_health_heartbeat(
                        interval_sec=0.01, no_input_warn_sec=10.0,
                    )
                )
                await asyncio.sleep(0.005)
                r._counter.input = 40
                r._counter.output = 25
                await asyncio.sleep(0.02)
                # Active flag off → the loop must exit on its own.
                r._failed = True
                await asyncio.wait_for(task, timeout=1)
                return info, warn

        info, warn = _run(drive())
        health = [c for c in info.call_args_list
                  if c.args and "phone_audio_health" in str(c.args[0])]
        self.assertTrue(health, "expected at least one phone_audio_health line")
        # No stall WARN on a path that received input.
        self.assertFalse([c for c in warn.call_args_list
                          if c.args and "no_input_audio" in str(c.args[0])])

    def test_heartbeat_warns_when_input_stalls_while_output_flows(self):
        r, _, _ = _make()
        r.wire()
        _begin(r)

        async def drive():
            with unittest.mock.patch.object(rec.logger, "warning") as warn:
                task = asyncio.ensure_future(
                    r.audio_health_heartbeat(
                        interval_sec=0.01, no_input_warn_sec=0.02,
                    )
                )
                # Output keeps flowing; input stays frozen → stall must WARN.
                for _ in range(8):
                    r._counter.output += 5
                    await asyncio.sleep(0.01)
                r._failed = True
                await asyncio.wait_for(task, timeout=1)
                return warn

        warn = _run(drive())
        stalls = [c for c in warn.call_args_list
                  if c.args and "no_input_audio" in str(c.args[0])]
        self.assertTrue(stalls, "a frozen input tap must emit no_input_audio")

    def test_heartbeat_is_fail_open_on_a_never_begun_recorder(self):
        r, _, _ = _make()
        r.wire()
        # Not begun → not active → the heartbeat returns immediately, no raise.
        _run(r.audio_health_heartbeat(interval_sec=0.01))

    def test_begin_logs_answered_offset_when_provided(self):
        r, _, _ = _make()
        r.wire()
        with unittest.mock.patch.object(rec.logger, "info") as info:
            _run(r.begin(OBJECT_KEY, answered_epoch_ms=1))
        started = [c for c in info.call_args_list
                   if c.args and "in_worker_recording_started" in str(c.args[0])]
        self.assertTrue(started)
        # The started line carries the answered_to_begin_ms field (>0, since a
        # begin_at_ms far exceeds the epoch=1 sentinel).
        fmt = str(started[-1].args[0])
        self.assertIn("answered_to_begin_ms", fmt)


# ── M013 S02: TAIL FLUSH (fakes; the real-SDK replay is test_recorder_flush) ──
# A STRUCTURAL fake of the livekit-agents 1.6.4 RecorderIO internals the flush
# touches: `_started`, `_in_record`/`_out_record`, `_in_q`/`_out_q`,
# `_write_cb`, and the name-mangled `__acc_frames` lists (the fake classes are
# NAMED RecorderAudioInput / RecorderAudioOutput so the mangled attribute names
# match the SDK's exactly). Frames are duration-only stand-ins.
import queue as _queue  # noqa: E402


class _Frame:
    def __init__(self, duration, tag="f"):
        self.duration = duration
        self.tag = tag


def _fake_split(frame, position):
    position = max(0.0, min(position, frame.duration))
    return _Frame(position, frame.tag), _Frame(frame.duration - position, frame.tag)


def _frames(total_sec, tag, frame_sec=0.02):
    n = int(round(total_sec / frame_sec))
    return [_Frame(frame_sec, tag) for _ in range(n)]


def _dur(frames):
    return round(sum(f.duration for f in frames), 6)


class RecorderAudioInput:
    def __init__(self, io):
        self.__io = io
        self.__acc_frames = []
        self.label = "TAP_IN"

    def push(self, frame):
        # Mirrors RecorderAudioInput.__anext__: accumulate only while recording.
        if self.__io.recording:
            self.__acc_frames.append(frame)

    def take_buf(self, pad_since=None):
        frames = self.__acc_frames
        self.__acc_frames = []
        return frames

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class RecorderAudioOutput:
    def __init__(self, io, write):
        self.__io = io
        self.__write = write
        self.__acc_frames = []
        self._last_speech_end_time = None
        self._last_speech_start_time = None
        self.label = "TAP_OUT"

    @property
    def has_pending_data(self):
        return len(self.__acc_frames) > 0

    def capture(self, frame, now):
        # Mirrors RecorderAudioOutput.capture_frame's recording bookkeeping.
        if self.__io.recording:
            self.__acc_frames.append(frame)
        if self._last_speech_start_time is None:
            self._last_speech_start_time = now

    async def capture_frame(self, frame):
        self.capture(frame, 0.0)

    def on_playback_finished(self, *, playback_position, now):
        # Mirrors the SDK's write-relevant branch of on_playback_finished.
        if not self.__io.recording:
            return
        if not self.__acc_frames:
            self._last_speech_end_time = now
            self._last_speech_start_time = None
            return
        buf, acc = [], 0.0
        for f in self.__acc_frames:
            if acc + f.duration > playback_position:
                head, _ = _fake_split(f, playback_position - acc)
                buf.append(head)
                break
            buf.append(f)
            acc += f.duration
        buf = [f for f in buf if f.duration > 0]
        if buf:
            self.__write(buf)
        self.__acc_frames = []
        self._last_speech_end_time = now
        self._last_speech_start_time = None


class _FakeSdkRecorderIO:
    def __init__(self, *, agent_session=None, sample_rate=48000):
        self._session = agent_session
        self._sample_rate = sample_rate
        self._started = False
        self._in_record = None
        self._out_record = None
        self._in_q = _queue.Queue()
        self._out_q = _queue.Queue()
        self.recording_started_at = None

    @property
    def recording(self):
        return self._started

    def record_input(self, audio_input):
        self._in_record = RecorderAudioInput(self)
        return self._in_record

    def record_output(self, audio_output):
        self._out_record = RecorderAudioOutput(self, self._write_cb)
        return self._out_record

    def _write_cb(self, buf):
        input_buf = self._in_record.take_buf(
            pad_since=self._out_record._last_speech_end_time,
        )
        self._in_q.put_nowait(input_buf)
        self._out_q.put_nowait(buf)

    async def start(self, *, output_path):
        self._started = True
        Path(output_path).write_bytes(b"OggS\x00fake-ogg-container-bytes")

    async def aclose(self):
        if not self._started:
            return
        self._in_q.put_nowait(None)
        self._out_q.put_nowait(None)
        self._started = False

    def drain(self):
        """Every (input, output) chunk the encode thread would consume, in
        FIFO order, including the None sentinel pair."""
        pairs = []
        while not self._in_q.empty():
            pairs.append((self._in_q.get_nowait(), self._out_q.get_nowait()))
        return pairs


def _flushing_cls(split=_fake_split):
    return rec.build_flushing_recorder_cls(_FakeSdkRecorderIO, split)


class _FakeRoom:
    def __init__(self):
        self.handlers = {}

    def on(self, event, handler):
        self.handlers.setdefault(event, []).append(handler)
        return handler

    def off(self, event, handler):
        self.handlers.get(event, []).remove(handler)

    def emit(self, event, participant):
        for h in list(self.handlers.get(event, [])):
            h(participant)


class _Participant:
    def __init__(self, identity):
        self.identity = identity


class _EmittingSession(_FakeSession):
    def __init__(self):
        super().__init__()
        self.handlers = {}

    def on(self, event, handler):
        self.handlers.setdefault(event, []).append(handler)
        return handler

    def off(self, event, handler):
        self.handlers.get(event, []).remove(handler)

    def emit(self, event, payload=None):
        for h in list(self.handlers.get(event, [])):
            h(payload)


SIP_IDENTITY = "phone-attempt-under-test"


def _make_flushing(*, split=_fake_split, room=None, session=None, uploaded=None):
    session = session or _EmittingSession()
    holder = {}
    cls = _flushing_cls(split)

    def factory(sess, sr):
        r = cls(agent_session=sess, sample_rate=sr)
        holder["recorder"] = r
        return r

    sink = uploaded if uploaded is not None else {}

    async def upload(url, body, content_type="audio/mpeg"):
        sink["body"] = body
        sink["content_type"] = content_type

    async def transcode(ogg, mp3):
        Path(mp3).write_bytes(b"ID3fake-mp3-bytes")

    r = rec.InWorkerRecorder(
        session, recorder_factory=factory, transcode_fn=transcode, upload_fn=upload,
        room=room, sip_identity=SIP_IDENTITY if room is not None else None,
    )
    return r, session, holder, sink


class TestTailFlushFakes(unittest.TestCase):
    """M013 S02-1 with fakes (bare python in CI)."""

    def _started(self, **kw):
        r, session, holder, sink = _make_flushing(**kw)
        self.assertTrue(r.wire())
        self.assertTrue(_begin(r))
        return r, session, holder["recorder"], sink

    def test_flush_writes_played_part_before_the_end_sentinels(self):
        r, _s, io, _sink = self._started()
        t0 = 1000.0
        for f in _frames(2.0, "cand"):
            io._in_record.push(f)
        for f in _frames(3.0, "bot"):  # 3 s captured, faster than real time
            io._out_record.capture(f, t0)
        io.mark_leg_end(t0 + 1.25)  # the hang-up 1.25 s into the utterance
        _run(io.aclose())
        pairs = io.drain()
        self.assertEqual(len(pairs), 2, pairs)
        (inp, out), sentinel = pairs
        self.assertEqual(sentinel, (None, None))  # flush strictly BEFORE sentinels
        self.assertAlmostEqual(_dur(out), 1.25, places=3)  # played part only
        self.assertTrue(all(f.tag == "bot" for f in out))
        self.assertAlmostEqual(_dur(inp), 2.0, places=3)  # held-back input too
        self.assertTrue(io.tail_flushed)
        self.assertEqual(io.tail_flush_result, {"out_ms": 1250, "in_ms": 2000})

    def test_no_pending_output_flushes_input_only(self):
        r, _s, io, _sink = self._started()
        for f in _frames(1.2, "cand"):
            io._in_record.push(f)
        io.mark_leg_end(2000.0)
        _run(io.aclose())
        pairs = io.drain()
        self.assertEqual(len(pairs), 2)
        self.assertAlmostEqual(_dur(pairs[0][0]), 1.2, places=3)
        self.assertEqual(pairs[0][1], [])  # paired with an empty output chunk
        self.assertEqual(pairs[1], (None, None))

    def test_zero_position_writes_no_bot_audio_but_flushes_input(self):
        # The utterance began AFTER the leg end: position clamps to 0.
        r, _s, io, _sink = self._started()
        for f in _frames(0.6, "cand"):
            io._in_record.push(f)
        for f in _frames(1.0, "bot"):
            io._out_record.capture(f, 500.0)
        io.flush_tail(499.0)
        pairs = io.drain()
        self.assertEqual(len(pairs), 1)
        self.assertAlmostEqual(_dur(pairs[0][0]), 0.6, places=3)
        self.assertEqual(pairs[0][1], [])
        self.assertFalse(io._out_record.has_pending_data)  # accumulator cleared

    def test_playback_finished_after_flush_writes_nothing_twice(self):
        r, _s, io, _sink = self._started()
        for f in _frames(2.0, "bot"):
            io._out_record.capture(f, 10.0)
        io.flush_tail(11.0)
        first = io.drain()
        self.assertEqual(len(first), 1)
        # A late playback_finished for the same segment must not re-write it.
        io._out_record.on_playback_finished(playback_position=2.0, now=12.0)
        self.assertEqual(io.drain(), [])

    def test_leg_end_closes_capture_so_late_audio_is_never_written(self):
        # The cut-off follows the hang-up, not the close: after the mark the
        # taps accumulate nothing, and the session-close interrupt's
        # playback_finished cannot write bot audio the candidate never heard.
        r, _s, io, _sink = self._started()
        for f in _frames(1.0, "bot"):
            io._out_record.capture(f, 100.0)
        io.mark_leg_end(100.5)
        self.assertFalse(io.recording)
        for f in _frames(2.5, "late"):
            io._out_record.capture(f, 100.0)
            io._in_record.push(_Frame(0.02, "late-in"))
        io._out_record.on_playback_finished(playback_position=3.0, now=103.0)
        self.assertEqual(io.drain(), [])  # nothing written by the interrupt
        _run(io.aclose())
        pairs = io.drain()
        out = pairs[0][1]
        self.assertAlmostEqual(_dur(out), 0.5, places=3)
        self.assertFalse(any(f.tag == "late" for f in out))
        self.assertFalse(any(f.tag == "late-in" for f in pairs[0][0]))

    def test_reopen_capture_undoes_a_spurious_mark(self):
        r, _s, io, _sink = self._started()
        io.mark_leg_end(5.0)
        self.assertFalse(io.recording)
        io.reopen_capture()
        self.assertTrue(io.recording)
        self.assertIsNone(io.leg_end)

    def test_flush_exception_is_fail_open_and_the_recording_still_uploads(self):
        def boom_split(frame, position):
            raise RuntimeError("sdk_internals_moved")

        import logging as _logging

        msgs = []

        class _Cap(_logging.Handler):
            def emit(self, rec_):
                msgs.append(rec_.getMessage())

        r, _s, holder, sink = _make_flushing(split=boom_split)
        r.wire()
        _begin(r)
        io = holder["recorder"]
        for f in _frames(1.0, "bot"):
            io._out_record.capture(f, 1.0)
        r.mark_leg_end(1.5, source="sip_left")  # mid-frame cut → split runs
        cap = _Cap()
        rec.logger.addHandler(cap)
        try:
            manifest = _finish(r)
        finally:
            rec.logger.removeHandler(cap)
        self.assertIsNotNone(manifest)  # still uploaded
        self.assertEqual(sink["content_type"], "audio/mpeg")
        self.assertIn("in_worker_recording_tail_flush_skipped category=RuntimeError", msgs)
        self.assertFalse(r.tail_flushed)
        # The close itself still ran: the sentinels were enqueued.
        self.assertIn((None, None), io.drain())

    def test_missing_sdk_internal_is_fail_open(self):
        r, _s, io, _sink = self._started()
        del io._out_record._RecorderAudioOutput__acc_frames  # an SDK refactor
        _run(io.aclose())
        self.assertEqual(io.drain(), [(None, None)])
        self.assertFalse(io.tail_flushed)

    def test_flush_is_noop_before_begin(self):
        io = _flushing_cls()(agent_session=None, sample_rate=48000)
        io.record_input(None)
        io.record_output(None)
        self.assertEqual(io.flush_tail(1.0), {"out_ms": 0, "in_ms": 0})
        self.assertEqual(io.drain(), [])

    def test_discard_skips_the_flush(self):
        r, _s, io, sink = self._started()
        for f in _frames(1.0, "cand"):
            io._in_record.push(f)
        _run(r.discard())
        self.assertEqual(io.drain(), [(None, None)])  # sentinels only
        self.assertFalse(io.tail_flushed)
        self.assertNotIn("body", sink)

    def test_finish_flushes_and_reports_tail_flushed(self):
        r, _s, io, _sink = self._started()
        for f in _frames(1.0, "cand"):
            io._in_record.push(f)
        self.assertIsNotNone(_finish(r))
        self.assertTrue(r.tail_flushed)
        self.assertEqual(r.leg_end_source, "finish")  # last-resort mark


class TestLegEndMarks(unittest.TestCase):
    def test_sip_leave_beats_a_later_session_close(self):
        room = _FakeRoom()
        r, session, holder, _sink = _make_flushing(room=room)
        r.wire()
        _begin(r)
        with unittest.mock.patch.object(rec.time, "time", return_value=1000.0):
            room.emit("participant_disconnected", _Participant(SIP_IDENTITY))
        with unittest.mock.patch.object(rec.time, "time", return_value=1002.5):
            session.emit("close")
        self.assertEqual(r.leg_ended_at, 1000.0)
        self.assertEqual(r.leg_end_source, "sip_left")
        self.assertEqual(holder["recorder"].leg_end, 1000.0)
        # finish() stamps later still; the earliest mark survives.
        _finish(r)
        self.assertEqual(r.leg_ended_at, 1000.0)
        self.assertEqual(r.leg_end_source, "sip_left")

    def test_other_identity_is_ignored(self):
        room = _FakeRoom()
        r, session, holder, _sink = _make_flushing(room=room)
        r.wire()
        _begin(r)
        room.emit("participant_disconnected", _Participant("phone-some-other-attempt"))
        room.emit("participant_disconnected", _Participant("agent-x"))
        self.assertIsNone(r.leg_ended_at)
        self.assertTrue(holder["recorder"].recording)
        with unittest.mock.patch.object(rec.time, "time", return_value=50.0):
            session.emit("close")
        self.assertEqual(r.leg_ended_at, 50.0)
        self.assertEqual(r.leg_end_source, "session_close")

    def test_same_identity_reconnecting_reopens_capture(self):
        room = _FakeRoom()
        r, _session, holder, _sink = _make_flushing(room=room)
        r.wire()
        _begin(r)
        room.emit("participant_disconnected", _Participant(SIP_IDENTITY))
        self.assertFalse(holder["recorder"].recording)
        room.emit("participant_connected", _Participant(SIP_IDENTITY))
        self.assertTrue(holder["recorder"].recording)
        self.assertIsNone(r.leg_ended_at)

    def test_listeners_unregistered_on_finish(self):
        room = _FakeRoom()
        r, session, _holder, _sink = _make_flushing(room=room)
        r.wire()
        _begin(r)
        self.assertEqual(len(room.handlers["participant_disconnected"]), 1)
        self.assertEqual(len(session.handlers["close"]), 1)
        _finish(r)
        self.assertEqual(room.handlers["participant_disconnected"], [])
        self.assertEqual(room.handlers["participant_connected"], [])
        self.assertEqual(session.handlers["close"], [])

    def test_listeners_unregistered_on_discard(self):
        room = _FakeRoom()
        r, session, _holder, _sink = _make_flushing(room=room)
        r.wire()
        _begin(r)
        _run(r.discard())
        self.assertEqual(room.handlers["participant_disconnected"], [])
        self.assertEqual(session.handlers["close"], [])

    def test_watch_leg_end_after_construction_registers_once_wired(self):
        room = _FakeRoom()
        r, _session, _holder, _sink = _make_flushing()
        r.watch_leg_end(room, SIP_IDENTITY)
        self.assertEqual(room.handlers, {})  # nothing until wired
        r.wire()
        self.assertEqual(len(room.handlers["participant_disconnected"]), 1)
        _begin(r)  # begin re-checks; still exactly one listener
        self.assertEqual(len(room.handlers["participant_disconnected"]), 1)

    def test_no_identity_registers_no_room_listener(self):
        room = _FakeRoom()
        r, _session, _holder, _sink = _make_flushing()
        r.watch_leg_end(room, None)
        r.wire()
        self.assertEqual(room.handlers, {})

    def test_mark_before_wire_is_kept_and_harmless(self):
        r, _session, _holder, _sink = _make_flushing()
        r.mark_leg_end(7.0, source="sip_left")
        self.assertEqual(r.leg_ended_at, 7.0)


class TestTailFlushKillSwitch(unittest.TestCase):
    """`_default_recorder_factory` against a fake livekit module tree."""

    def _fake_livekit(self, version="1.6.4"):
        import sys
        import types

        rio_mod = types.ModuleType("livekit.agents.voice.recorder_io.recorder_io")
        rio_mod.RecorderIO = _FakeSdkRecorderIO
        rio_mod._split_frame = _fake_split
        pkg = types.ModuleType("livekit.agents.voice.recorder_io")
        pkg.RecorderIO = _FakeSdkRecorderIO
        pkg.recorder_io = rio_mod
        voice = types.ModuleType("livekit.agents.voice")
        voice.recorder_io = pkg
        agents = types.ModuleType("livekit.agents")
        agents.__version__ = version
        agents.voice = voice
        lk = types.ModuleType("livekit")
        lk.agents = agents
        return unittest.mock.patch.dict(sys.modules, {
            "livekit": lk,
            "livekit.agents": agents,
            "livekit.agents.voice": voice,
            "livekit.agents.voice.recorder_io": pkg,
            "livekit.agents.voice.recorder_io.recorder_io": rio_mod,
        })

    def _factory_type(self, env_value):
        env = {} if env_value is None else {"PHONE_RECORDING_TAIL_FLUSH": env_value}
        with self._fake_livekit(), unittest.mock.patch.dict(os.environ, env, clear=False):
            if env_value is None:
                os.environ.pop("PHONE_RECORDING_TAIL_FLUSH", None)
            return type(rec._default_recorder_factory(None, 48000))

    def test_default_is_the_flushing_recorder(self):
        t = self._factory_type(None)
        self.assertIsNot(t, _FakeSdkRecorderIO)
        self.assertTrue(issubclass(t, _FakeSdkRecorderIO))
        self.assertEqual(t.__name__, "_FlushingRecorderIO")
        self.assertTrue(issubclass(self._factory_type("on"), _FakeSdkRecorderIO))

    def test_off_returns_the_plain_recorder(self):
        for v in ("off", "OFF", "false", "0"):
            with self.subTest(v):
                self.assertIs(self._factory_type(v), _FakeSdkRecorderIO)

    def test_off_is_byte_identical_plain_close(self):
        # Kill switch: the plain recorder never flushes — only the sentinels.
        io = _FakeSdkRecorderIO()
        io.record_input(None)
        io.record_output(None)
        with tempfile.TemporaryDirectory() as d:
            _run(io.start(output_path=Path(d) / "killswitch.ogg"))
            io._in_record.push(_Frame(0.5, "cand"))
            _run(io.aclose())
        self.assertEqual(io.drain(), [(None, None)])

    def test_unverified_sdk_version_warns_and_still_flushes(self):
        with self._fake_livekit(version="9.9.9"), \
             unittest.mock.patch.object(rec.logger, "warning") as warn:
            os.environ.pop("PHONE_RECORDING_TAIL_FLUSH", None)
            t = type(rec._default_recorder_factory(None, 48000))
        self.assertIsNot(t, _FakeSdkRecorderIO)
        self.assertTrue(any(
            "tail_flush_sdk_unverified" in str(c.args[0]) for c in warn.call_args_list
        ))


# ── M013 S02 T02: truthful recording metadata ────────────────────────────────


class _Clock:
    def __init__(self, t):
        self.t = t

    def time(self):
        return self.t


class _Tap:
    def __init__(self, started_wall_time):
        self.started_wall_time = started_wall_time


class _AnchoredRecorder(_FakeRecorder):
    """A fake recorder exposing the SDK's per-tap ``started_wall_time``."""

    in_started = None
    out_started = None

    async def start(self, *, output_path):
        await super().start(output_path=output_path)
        self._in_record = _Tap(self.in_started)
        self._out_record = _Tap(self.out_started)


def _make_tmp(test, **kw):
    d = tempfile.TemporaryDirectory()
    test.addCleanup(d.cleanup)
    return _make(tmp=Path(d.name), **kw)


class TestTruthfulManifest(unittest.TestCase):
    def test_mp3_path_duration_is_the_encoded_length(self):
        async def transcode(ogg, mp3):
            Path(mp3).write_bytes(b"ID3fake-mp3-bytes")
            return 2000

        r, _s, _h = _make_tmp(self, transcode=transcode)
        r.wire()
        _begin(r)
        with unittest.mock.patch.object(rec, "_ogg_duration_ms",
                                        side_effect=AssertionError("not needed")):
            manifest = _finish(r)
        self.assertEqual(manifest.content_type, "audio/mpeg")
        self.assertEqual(manifest.duration_ms, 2000)

    def test_zero_negative_or_unknown_length_is_none(self):
        for value in (0, -5, None, True, "2000", 0.4):
            with self.subTest(value=value):
                async def transcode(ogg, mp3, _v=value):
                    Path(mp3).write_bytes(b"ID3fake-mp3-bytes")
                    return _v

                r, _s, _h = _make_tmp(self, transcode=transcode)
                r.wire()
                _begin(r)
                with unittest.mock.patch.object(rec, "_ogg_duration_ms", return_value=None):
                    manifest = _finish(r)
                self.assertIsNotNone(manifest)
                self.assertIsNone(manifest.duration_ms)

    def test_unknown_encoded_length_falls_back_to_the_ogg_container(self):
        async def transcode(ogg, mp3):
            Path(mp3).write_bytes(b"ID3fake-mp3-bytes")
            return None

        r, _s, _h = _make_tmp(self, transcode=transcode)
        r.wire()
        _begin(r)
        with unittest.mock.patch.object(rec, "_ogg_duration_ms", return_value=1987):
            manifest = _finish(r)
        self.assertEqual(manifest.content_type, "audio/mpeg")
        self.assertEqual(manifest.duration_ms, 1987)

    def test_ogg_fallback_reads_the_container_before_cleanup(self):
        async def boom(ogg, mp3):
            raise RuntimeError("transcode_failed")

        seen = []

        def probe(path):
            seen.append(Path(path).exists())
            return 1999

        r, _s, _h = _make_tmp(self, transcode=boom)
        r.wire()
        _begin(r)
        with unittest.mock.patch.object(rec, "_ogg_duration_ms", side_effect=probe):
            manifest = _finish(r)
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertEqual(manifest.duration_ms, 1999)
        self.assertEqual(seen, [True])  # read while the OGG still existed
        self.assertFalse(r._ogg_path.exists())  # then cleaned up

    def test_cancelled_upgrade_manifest_reads_the_ogg_before_cleanup(self):
        async def cancelled(ogg, mp3):
            raise asyncio.CancelledError()

        seen = []

        def probe(path):
            seen.append(Path(path).exists())
            return 1500

        r, _s, _h = _make_tmp(self, transcode=cancelled)
        r.wire()
        _begin(r)
        with unittest.mock.patch.object(rec, "_ogg_duration_ms", side_effect=probe):
            manifest = _finish(r)
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertEqual(manifest.duration_ms, 1500)
        self.assertEqual(seen, [True])
        self.assertFalse(r._ogg_path.exists())

    def test_cancelled_upgrade_zero_length_is_none(self):
        async def cancelled(ogg, mp3):
            raise asyncio.CancelledError()

        r, _s, _h = _make_tmp(self, transcode=cancelled)
        r.wire()
        _begin(r)
        with unittest.mock.patch.object(rec, "_ogg_duration_ms", return_value=None):
            manifest = _finish(r)
        self.assertIsNone(manifest.duration_ms)

    def test_ogg_duration_helper_never_raises(self):
        self.assertIsNone(rec._ogg_duration_ms(None))
        with tempfile.TemporaryDirectory() as d:
            junk = Path(d) / "junk.ogg"
            junk.write_bytes(b"OggS\x00not-a-real-container")
            self.assertIsNone(rec._ogg_duration_ms(junk))
            self.assertIsNone(rec._ogg_duration_ms(Path(d) / "missing.ogg"))

    def test_manifest_carries_the_leg_timing_and_tail_flushed(self):
        room = _FakeRoom()
        r, _s, holder, _sink = _make_flushing(room=room)
        clock = _Clock(1_000.0)
        with unittest.mock.patch.object(rec.time, "time", clock.time):
            self.assertTrue(r.wire())
            self.assertTrue(_begin(r))
            io = holder["recorder"]
            for f in _frames(2.0, "cand"):
                io._in_record.push(f)
            for f in _frames(3.0, "bot"):
                io._out_record.capture(f, 1_001.0)
            clock.t = 1_003.5
            room.emit("participant_disconnected", _Participant(SIP_IDENTITY))
            clock.t = 1_010.0
            manifest = _finish(r)
        self.assertEqual(manifest.leg_ended_at_ms, 1_003_500)
        self.assertEqual(manifest.recording_started_at_ms, 1_000_000)
        self.assertIs(manifest.tail_flushed, True)
        self.assertEqual(manifest.leg_end_source, "sip_left")
        self.assertEqual(manifest.timing_kwargs(), {
            "recording_started_at_ms": 1_000_000,
            "leg_ended_at_ms": 1_003_500,
            "leg_end_source": "sip_left",
            "tail_flushed": True,
        })

    def test_plain_recorder_reports_the_tail_not_flushed(self):
        r, _s, _h = _make_tmp(self)
        clock = _Clock(2_000.0)
        with unittest.mock.patch.object(rec.time, "time", clock.time):
            r.wire()
            _begin(r)
            clock.t = 2_012.25
            manifest = _finish(r)
        self.assertIs(manifest.tail_flushed, False)
        # finish() is the last-resort leg end, and says so: the API must not
        # record a teardown time as an observed SIP leave.
        self.assertEqual(manifest.leg_ended_at_ms, 2_012_250)
        self.assertEqual(manifest.leg_end_source, "finish")
        self.assertEqual(manifest.timing_kwargs()["leg_end_source"], "finish")
        self.assertEqual(manifest.recording_started_at_ms, 2_000_000)

    def test_close_timeout_is_not_reported_flushed(self):
        room = _FakeRoom()
        r, _s, holder, _sink = _make_flushing(room=room)
        r.wire()
        _begin(r)
        io = holder["recorder"]
        io.tail_flushed = True  # the flush ran, but the encoder never acked

        async def hang():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                return None

        io.aclose = hang
        with unittest.mock.patch.object(rec, "RECORDER_CLOSE_TIMEOUT_SEC", 0.01):
            manifest = _finish(r)
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertIsNone(manifest.duration_ms)
        self.assertIs(manifest.tail_flushed, False)
        self.assertIsNotNone(manifest.leg_ended_at_ms)

    def _anchored(self, *, in_started, out_started, sdk_started=None):
        holder = {}

        def factory(sess, sr):
            x = _AnchoredRecorder(sess, sr)
            x.in_started = in_started
            x.out_started = out_started
            holder["recorder"] = x
            return x

        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        async def transcode(ogg, mp3):
            Path(mp3).write_bytes(b"ID3fake-mp3-bytes")
            return 1000

        r = rec.InWorkerRecorder(_FakeSession(), work_dir=Path(d.name),
                                 recorder_factory=factory, transcode_fn=transcode,
                                 upload_fn=_noop_upload)
        with unittest.mock.patch.object(rec.time, "time", _Clock(5_000.0).time):
            r.wire()
            _begin(r)
        return r

    def test_pre_begin_output_frame_does_not_move_the_anchor_earlier(self):
        # The SDK stamps the OUTPUT start on the first capture_frame even when
        # not recording: a bot frame 1 s before begin() must not pull the
        # anchor before the file's t = 0.
        r = self._anchored(in_started=5_000.02, out_started=4_999.0)
        self.assertEqual(r.recording_started_at_ms, 5_000_020)
        self.assertGreaterEqual(r.recording_started_at_ms, 5_000_000)
        manifest = _finish(r)
        self.assertEqual(manifest.recording_started_at_ms, 5_000_020)

    def test_anchor_floor_is_begin_when_no_tap_started_after_it(self):
        r = self._anchored(in_started=None, out_started=4_999.0)
        self.assertEqual(r.recording_started_at_ms, 5_000_000)

    def test_anchor_is_the_earliest_post_begin_tap(self):
        r = self._anchored(in_started=5_000.3, out_started=5_000.1)
        self.assertEqual(r.recording_started_at_ms, 5_000_100)

    def test_combined_sdk_value_is_floored_at_begin(self):
        for sdk, expected in ((4_990.0, 5_000_000), (5_000.5, 5_000_500)):
            with self.subTest(sdk=sdk):
                r, _s, holder = _make_tmp(self)
                with unittest.mock.patch.object(rec.time, "time", _Clock(5_000.0).time):
                    r.wire()
                    _begin(r)
                holder["recorder"].recording_started_at = sdk
                self.assertEqual(r.recording_started_at_ms, expected)

    def test_no_anchor_or_leg_end_before_begin(self):
        r, _s, _h = _make_tmp(self)
        r.wire()
        self.assertIsNone(r.recording_started_at_ms)
        self.assertIsNone(r.leg_ended_at_ms)

    def test_manifest_timing_kwargs_helper(self):
        import types

        m = rec.RecordingManifest(sha256="a" * 64, size_bytes=1, duration_ms=None)
        self.assertEqual(m.timing_kwargs(), {
            "recording_started_at_ms": None, "leg_ended_at_ms": None,
            "leg_end_source": None, "tail_flushed": None,
        })
        # A source without a leg end is never sent.
        m2 = rec.RecordingManifest(sha256="a" * 64, size_bytes=1, duration_ms=None,
                                   leg_end_source="sip_left")
        self.assertIsNone(m2.timing_kwargs()["leg_end_source"])
        self.assertEqual(rec.manifest_timing_kwargs(m), m.timing_kwargs())
        # A test double / older shape: the legacy body, never a raise.
        legacy = types.SimpleNamespace(sha256="s", size_bytes=1, duration_ms=2)
        self.assertEqual(rec.manifest_timing_kwargs(legacy), {})

        class _Broken:
            def timing_kwargs(self):
                raise RuntimeError("boom")

        self.assertEqual(rec.manifest_timing_kwargs(_Broken()), {})
        self.assertEqual(rec.manifest_timing_kwargs(None), {})


def _synth_ogg(path, seconds):
    """A synthetic stereo Opus OGG of exactly ``seconds`` of input audio."""
    sr = 48000
    oc = _av.open(str(path), mode="w")
    st = oc.add_stream("libopus", rate=sr, layout="stereo")
    n = int(sr * seconds)
    t = _np.arange(n) / sr
    left = (0.3 * _np.sin(2 * _np.pi * 440 * t) * 32767).astype(_np.int16)
    right = (0.3 * _np.sin(2 * _np.pi * 880 * t) * 32767).astype(_np.int16)
    step = 960  # 20 ms frames, as the recorder writes
    for i in range(0, n, step):
        inter = _np.empty(2 * len(left[i:i + step]), dtype=_np.int16)
        inter[0::2] = left[i:i + step]
        inter[1::2] = right[i:i + step]
        frame = _av.AudioFrame.from_ndarray(inter.reshape(1, -1), format="s16", layout="stereo")
        frame.sample_rate = sr
        for p in st.encode(frame):
            oc.mux(p)
    for p in st.encode(None):
        oc.mux(p)
    oc.close()


@unittest.skipUnless(_HAS_AV, "PyAV/numpy not installed (CI worker env) — validated where present")
class TestTruthfulDurationRealPyAv(unittest.TestCase):
    """duration_ms is the encoded length (±50 ms) of a synthetic 2 s file, on
    both manifest paths (MP3 upgrade and raw-OGG fallback)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.src = self.dir / "synth.ogg"
        _synth_ogg(self.src, 2.0)

    def tearDown(self):
        self._tmp.cleanup()

    def test_transcode_returns_the_encoded_length(self):
        ms = _run(rec._default_transcode(self.src, self.dir / "out.mp3"))
        self.assertIsInstance(ms, int)
        self.assertAlmostEqual(ms, 2000, delta=50)

    def test_ogg_container_length(self):
        ms = rec._ogg_duration_ms(self.src)
        self.assertIsInstance(ms, int)
        self.assertAlmostEqual(ms, 2000, delta=50)

    def _finish_with(self, transcode):
        src = self.src.read_bytes()

        class _RealOggRecorder(_FakeRecorder):
            async def start(self, *, output_path):
                await super().start(output_path=output_path)
                Path(output_path).write_bytes(src)

        def factory(sess, sr):
            return _RealOggRecorder(sess, sr)

        work = self.dir / "work"
        r = rec.InWorkerRecorder(
            _FakeSession(), work_dir=work, recorder_factory=factory,
            transcode_fn=transcode, upload_fn=_noop_upload,
        )
        r.wire()
        _begin(r)
        return _finish(r)

    def test_mp3_manifest_duration(self):
        manifest = self._finish_with(rec._default_transcode)
        self.assertEqual(manifest.content_type, "audio/mpeg")
        self.assertAlmostEqual(manifest.duration_ms, 2000, delta=50)

    def test_ogg_fallback_manifest_duration(self):
        async def boom(ogg, mp3):
            raise RuntimeError("transcode_failed")

        manifest = self._finish_with(boom)
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertAlmostEqual(manifest.duration_ms, 2000, delta=50)

    def test_cancelled_upgrade_manifest_duration(self):
        async def cancelled(ogg, mp3):
            raise asyncio.CancelledError()

        manifest = self._finish_with(cancelled)
        self.assertEqual(manifest.content_type, "audio/ogg")
        self.assertAlmostEqual(manifest.duration_ms, 2000, delta=50)


async def _noop_upload(url, body, content_type="audio/mpeg"):
    return None


if __name__ == "__main__":
    unittest.main()
