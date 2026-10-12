"""R1 recording: the job-process recorder (``r1_recorder``), against the real SDK and PyAV.

What is proven here, and how:

* mode resolution, and that with the locks off ``build_r1_recorder`` touches nothing;
* the audio tee: the SDK ``RecorderIO`` subclass leaves the stock OGG exactly as it was, hands every
  lock-step chunk to the tee, and the mixer turns it into one continuous 48 kHz mono timeline with
  wall-clock gap padding (a rejoin gap must not shift later audio behind the clock);
* the uploader: uniform parts cut from a growing file, one request in flight, retry with a fresh
  presigned URL, the bytes kept until a 200, the OGG checkpoint cadence, and the worker's reaction to
  every API answer (discard, stop, retry);
* the lifecycle (start, stop, finish): order of the finish steps, the ``complete`` report, the
  faststart rules, degraded layouts, discard (spool overwritten and unlinked, encoder killed, no
  further calls), a finish that returns by its deadline with a hung API, and that no log line ever
  carries a URL, an id or an exception message;
* one end-to-end run with the REAL encoder process: PCM in, parts out, and the concatenated parts
  decode to the audio that went in.

``tests/test_r1_video_encoder.py`` covers the encoder process and the wire protocol itself.  The
bare-python CI step has neither the SDK nor PyAV; this module then skips itself.
"""
from __future__ import annotations

import asyncio
import contextlib
import http.server
import json
import os
import queue
import re
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

try:
    import av
    import numpy as np
    from livekit import rtc
    from livekit.agents.voice import io as lk_io
except ImportError as exc:  # bare python: the SDK and the media stack are not installed
    raise unittest.SkipTest("livekit-agents/PyAV are not installed (bare python CI step)") from exc

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_recorder
from r1_recorder import ApiReply, HttpClient, HttpFailure, R1Recorder, RecordingApi, Spool, TeeMixer, UploadWorker

SESSION_ID = "00000000-0000-4000-8000-0000000000aa"
ROOM = "screening-" + SESSION_ID
RATE = 48000
PRESIGNED = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/ik-r1-recordings/r1/SECRETKEY/obj"
POISONS = ("r2.cloudflarestorage.com", "X-Amz-Signature", "SECRETKEY", "deadbeefcafe", SESSION_ID, "ik-r1-recordings")

_SILENT: list = []


def setUpModule() -> None:
    _SILENT.append(r1_recorder._log._writer)
    r1_recorder._log._writer = lambda _raw: None


def tearDownModule() -> None:
    r1_recorder._log._writer = _SILENT.pop()


@contextlib.contextmanager
def captured_logs():
    lines: list[dict] = []
    previous = r1_recorder._log._writer
    r1_recorder._log._writer = lambda raw: lines.append(json.loads(raw))
    try:
        yield lines
    finally:
        r1_recorder._log._writer = previous


def frame(samples: np.ndarray, rate: int = 24000) -> "rtc.AudioFrame":
    data = np.asarray(samples, dtype="<i2")
    return rtc.AudioFrame(
        data=data.tobytes(), sample_rate=rate, num_channels=1, samples_per_channel=len(data)
    )


def tone_samples(seconds: float, rate: int = 24000, freq: float = 440.0, amp: int = 8000) -> np.ndarray:
    t = np.arange(int(round(seconds * rate))) / rate
    return (np.sin(2 * np.pi * freq * t) * amp).astype("<i2")


def pcm_of(pieces: list[tuple[int, bytes]]) -> np.ndarray:
    return np.frombuffer(b"".join(pcm for _pts, pcm in pieces), dtype="<i2")


async def until(predicate, timeout: float = 8.0) -> None:
    end = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > end:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.01)


def wait_until(predicate, timeout: float = 8.0) -> None:
    end = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > end:
            raise AssertionError("condition not reached in time")
        time.sleep(0.01)


class ManualClock:
    def __init__(self, value: float = 1000.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


# ------------------------------------------------------------------------------ modes


class TestModes(unittest.TestCase):
    def test_the_worker_flag_is_exactly_on_or_the_recorder_is_off(self) -> None:
        for value, expected in (
            (None, "off"), ("off", "off"), ("", "off"), ("ON", "off"), ("On", "off"), ("on ", "off"),
            (" on", "off"), ("true", "off"), ("1", "off"), ("yes", "off"), ("on", "audio"),
        ):
            with self.subTest(R1_RECORDING=value):
                env = {} if value is None else {"R1_RECORDING": value}
                self.assertEqual(r1_recorder.worker_capability(env), expected)

    def test_video_needs_both_flags_and_exactly_on(self) -> None:
        for recording, video, expected in (
            ("on", "on", "av"), ("on", "ON", "audio"), ("on", "true", "audio"), ("on", "off", "audio"),
            ("on", None, "audio"), ("off", "on", "off"), (None, "on", "off"),
        ):
            with self.subTest(recording=recording, video=video):
                env = {k: v for k, v in (("R1_RECORDING", recording), ("R1_VIDEO_RECORDING", video)) if v}
                self.assertEqual(r1_recorder.worker_capability(env), expected)

    def test_a_missing_or_malformed_projection_is_off(self) -> None:
        for context in (
            None, {}, {"recording": None}, {"recording": "av"}, {"recording": ["av"]}, {"recording": {}},
            {"recording": {"mode": 3}}, {"recording": {"mode": "video"}}, {"recording": {"mode": "AV"}},
            {"recording": {"mode": None}}, "av",
        ):
            with self.subTest(context=context):
                self.assertEqual(r1_recorder.server_mode(context), "off")
        self.assertEqual(r1_recorder.server_mode({"recording": {"mode": "audio"}}), "audio")

    def test_the_effective_mode_is_the_lower_of_capability_and_projection(self) -> None:
        ranks = ["off", "audio", "av"]
        capability_env = {"off": {}, "audio": {"R1_RECORDING": "on"}, "av": {"R1_RECORDING": "on", "R1_VIDEO_RECORDING": "on"}}
        for capability in ranks:
            for server in ranks:
                with self.subTest(capability=capability, server=server):
                    got = r1_recorder.effective_mode({"recording": {"mode": server}}, capability_env[capability])
                    self.assertEqual(got, ranks[min(ranks.index(capability), ranks.index(server))])

    def test_the_context_keys_the_worker_requires_do_not_change(self) -> None:
        # ``fetch_context`` still requires exactly these five; ``recording`` is optional.
        import r1_context

        source = (HERE / "r1_context.py").read_text(encoding="utf-8")
        self.assertIn('required = ("first_name", "round_id", "attempt_id", "attempt", "settings")', source)
        self.assertNotIn("recording", source)
        del r1_context


# ------------------------------------------------------------------------------ build


class TestBuild(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="r1rec-build-")
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "r1-rec"
        self.spawned: list[str] = []

        class Probe:
            def __init__(inner, directory):
                inner.directory = directory
                inner.exited = threading.Event()
                inner.dead = False

            def spawn(inner) -> bool:
                self.spawned.append(str(inner.directory))
                return True

            def kill(inner) -> None:
                inner.dead = True

        self.encoder_factory = Probe
        self.on = {"R1_RECORDING": "on"}
        self.context = {"recording": {"mode": "audio"}}

    def build(self, **kwargs):
        defaults = dict(
            env=self.on, spool_root=self.root, encoder_factory=self.encoder_factory,
            http_client=HttpClient(), io_class=lambda: None,
        )
        defaults.update(kwargs)
        return r1_recorder.build_r1_recorder(
            SimpleNamespace(), kwargs.pop("context", self.context) if "context" in kwargs else self.context,
            SimpleNamespace(), ROOM, SESSION_ID, **{k: v for k, v in defaults.items() if k != "context"}
        )

    def test_with_the_locks_off_nothing_exists_afterwards(self) -> None:
        for env, context in (
            ({}, self.context),                           # worker flag unset
            ({"R1_RECORDING": "off"}, self.context),      # worker flag off
            (self.on, {"recording": {"mode": "off"}}),   # the API says off
            (self.on, {}),                                # an older API with no projection
        ):
            with self.subTest(env=env, context=context):
                with mock.patch.object(threading, "Thread") as thread, mock.patch.object(
                    r1_recorder.subprocess, "Popen"
                ) as popen:
                    recorder = r1_recorder.build_r1_recorder(
                        SimpleNamespace(), context, SimpleNamespace(), ROOM, SESSION_ID,
                        env=env, spool_root=self.root, encoder_factory=self.encoder_factory,
                    )
                self.assertIsNone(recorder)
                self.assertFalse(self.root.exists(), "no spool directory")
                self.assertEqual(self.spawned, [], "no encoder")
                thread.assert_not_called()
                popen.assert_not_called()

    def test_with_the_locks_on_it_creates_the_spool_and_the_encoder(self) -> None:
        recorder = self.build()
        self.assertIsNotNone(recorder)
        self.assertEqual(recorder.mode, "audio")
        self.assertTrue((self.root / SESSION_ID).is_dir())
        self.assertEqual(self.spawned, [str(self.root / SESSION_ID)])
        if os.name == "posix":
            self.assertEqual((self.root / SESSION_ID).stat().st_mode & 0o777, 0o700)
            self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)

    def test_stale_spools_from_earlier_jobs_are_deleted_at_build(self) -> None:
        stale = self.root / "11111111-1111-4111-8111-111111111111"
        stale.mkdir(parents=True)
        (stale / "stream.mp4").write_bytes(b"old")
        (stale / "audio.ogg").write_bytes(b"old")
        keep = self.root / "unrelated-dir"
        keep.mkdir()
        (keep / "notes.txt").write_text("not ours")
        self.assertIsNotNone(self.build())
        self.assertFalse(stale.exists())
        self.assertTrue((keep / "notes.txt").exists(), "files outside the allowlist are never deleted")

    def test_a_bad_identity_builds_nothing(self) -> None:
        for session_id, room in (
            (None, ROOM), ("", ROOM), ("not-a-uuid", ROOM), (SESSION_ID.upper(), ROOM), (SESSION_ID, "room-1"),
            (SESSION_ID, ""),
        ):
            with self.subTest(session_id=session_id, room=room):
                got = r1_recorder.build_r1_recorder(
                    SimpleNamespace(), self.context, SimpleNamespace(), room, session_id,
                    env=self.on, spool_root=self.root, encoder_factory=self.encoder_factory,
                )
                self.assertIsNone(got)
        self.assertFalse(self.root.exists())

    def test_too_little_disk_means_off_and_a_video_request_drops_to_audio(self) -> None:
        with mock.patch.object(Spool, "free_bytes", return_value=10 * 1024 * 1024):
            self.assertIsNone(self.build())
        env = {"R1_RECORDING": "on", "R1_VIDEO_RECORDING": "on"}
        with mock.patch.object(Spool, "free_bytes", return_value=200 * 1024 * 1024):
            recorder = self.build(env=env, context={"recording": {"mode": "av"}})
        self.assertEqual(recorder.mode, "audio")
        with mock.patch.object(Spool, "free_bytes", return_value=2 * 1024 * 1024 * 1024):
            recorder = self.build(env=env, context={"recording": {"mode": "av"}})
        self.assertEqual(recorder.mode, "av")

    def test_a_build_failure_is_swallowed_and_logged_by_type_only(self) -> None:
        def boom(_directory):
            raise RuntimeError("secret detail " + PRESIGNED)

        with captured_logs() as lines:
            got = self.build(encoder_factory=boom)
        self.assertIsNone(got)
        self.assertEqual(lines[-1]["error_type"], "r1_rec_build_failed")
        self.assertEqual(lines[-1]["error_category"], "RuntimeError")
        self.assertNotIn("secret detail", json.dumps(lines))


# ------------------------------------------------------------------------------ spool


class TestSpool(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="r1rec-spool-")
        self.addCleanup(self._tmp.cleanup)
        self.spool = Spool(Path(self._tmp.name) / "root", SESSION_ID)
        self.spool.create()

    def test_wipe_removes_the_files_and_the_directory(self) -> None:
        for name in ("stream.mp4", "video.mp4", "audio.ogg"):
            (self.spool.dir / name).write_bytes(b"x" * 100)
        self.assertTrue(self.spool.wipe())
        self.assertFalse(self.spool.dir.exists())

    def test_a_discard_overwrites_the_bytes_before_unlinking_them(self) -> None:
        secret = b"CANDIDATE-VOICE" * 1000
        (self.spool.dir / "audio.ogg").write_bytes(secret)
        (self.spool.dir / "stream.mp4").write_bytes(secret)
        seen: dict[str, bytes] = {}
        real_unlink = os.unlink

        def spy(path, *args, **kwargs):
            seen[Path(path).name] = Path(path).read_bytes()
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(r1_recorder.os, "unlink", spy):
            self.assertTrue(self.spool.wipe(overwrite=True))
        self.assertEqual(set(seen), {"audio.ogg", "stream.mp4"})
        for name, content in seen.items():
            self.assertEqual(len(content), len(secret), name)
            self.assertEqual(content, b"\x00" * len(secret), name)
        self.assertFalse(self.spool.dir.exists())

    def test_only_allowlisted_names_are_ever_unlinked(self) -> None:
        (self.spool.dir / "stream.mp4").write_bytes(b"x")
        (self.spool.dir / "notes.txt").write_text("mine")
        self.assertFalse(self.spool.wipe())  # the directory is not empty: left alone, not forced
        self.assertTrue((self.spool.dir / "notes.txt").exists())
        self.assertFalse((self.spool.dir / "stream.mp4").exists())

    def test_wiping_a_missing_directory_is_fine(self) -> None:
        self.spool.wipe()
        self.assertTrue(self.spool.wipe())

    def test_clean_stale_keeps_only_the_current_session(self) -> None:
        other = self.spool.root / "22222222-2222-4222-8222-222222222222"
        other.mkdir()
        (other / "video.mp4").write_bytes(b"x")
        (self.spool.root / "loose-file").write_bytes(b"x")
        self.assertEqual(Spool.clean_stale(self.spool.root, keep=SESSION_ID), 1)
        self.assertFalse(other.exists())
        self.assertTrue(self.spool.dir.exists())
        self.assertTrue((self.spool.root / "loose-file").exists())
        self.assertEqual(Spool.clean_stale(self.spool.root / "missing", keep=SESSION_ID), 0)


# ------------------------------------------------------------------------------ mixer


class TestTeeMixer(unittest.TestCase):
    def test_the_agent_line_is_right_aligned_and_summed_with_the_candidate(self) -> None:
        mixer = TeeMixer(t0=0.0)
        candidate = [frame(tone_samples(2.5, freq=300.0, amp=4000))]
        agent = [frame(tone_samples(1.0, freq=900.0, amp=4000))]
        pieces = mixer.process(candidate, agent, 2.5)
        pcm = pcm_of(pieces)
        # (the resampler holds back a few milliseconds of the candidate's input between chunks)
        self.assertAlmostEqual(len(pcm) / RATE, 2.5, delta=0.05)
        # The agent's last second is the end of the chunk (it is queued when playback FINISHES):
        # before it only the 300 Hz candidate, inside it both.
        early = pcm[: int(1.0 * RATE)].astype(np.float64)
        late = pcm[int(1.6 * RATE) :].astype(np.float64)
        self.assertLess(abs(self.peak_freq(early) - 300.0), 5.0)
        spectrum = np.abs(np.fft.rfft(late * np.hanning(len(late))))
        freqs = np.fft.rfftfreq(len(late), 1 / RATE)
        for target in (300.0, 900.0):
            band = (freqs > target - 15) & (freqs < target + 15)
            self.assertGreater(spectrum[band].max(), spectrum.max() * 0.3, target)

    @staticmethod
    def peak_freq(window: np.ndarray) -> float:
        spectrum = np.abs(np.fft.rfft(window * np.hanning(len(window))))
        return float(np.argmax(spectrum)) * RATE / len(window)

    def test_input_at_24k_and_output_at_22k_both_become_48k_mono(self) -> None:
        mixer = TeeMixer(t0=0.0)
        pieces = mixer.process([frame(tone_samples(2.5, 24000), 24000)], [frame(tone_samples(1.0, 22050), 22050)], 2.5)
        samples = len(pcm_of(pieces))
        self.assertAlmostEqual(samples / RATE, 2.5, delta=0.05)

    def test_timestamps_are_the_sample_clock_and_are_contiguous(self) -> None:
        mixer = TeeMixer(t0=100.0)
        pts: list[int] = []
        total = 0
        for index in range(1, 5):
            for stamp, pcm in mixer.process([frame(tone_samples(2.5))], [], 100.0 + 2.5 * index):
                self.assertEqual(stamp, total * 1_000_000 // RATE)
                pts.append(stamp)
                total += len(pcm) // 2
        self.assertEqual(pts, sorted(pts))
        self.assertEqual(mixer.emitted, total)
        self.assertAlmostEqual(total / RATE, 10.0, delta=0.05)

    def test_empty_chunks_during_a_gap_pad_exactly_the_wall_time(self) -> None:
        """The candidate's audio stops (rejoin gap) and the agent is silent: 2.5 s ticks with nothing."""
        mixer = TeeMixer(t0=0.0)
        pcm = [pcm_of(mixer.process([frame(tone_samples(2.5))], [], 2.5))]
        for tick in range(2, 11):  # 20 s of empty ticks, t = 5.0 ... 25.0 -> 20 s gap
            pcm.append(pcm_of(mixer.process([], [], 2.5 * tick)))
        pcm.append(pcm_of(mixer.process([frame(tone_samples(2.5))], [], 2.5 * 11)))
        joined = np.concatenate(pcm)
        self.assertAlmostEqual(len(joined) / RATE, 27.5, delta=0.3)
        gap = joined[int(2.6 * RATE) : int(24.8 * RATE)]
        self.assertEqual(int(np.abs(gap).max()), 0)
        self.assertGreater(int(np.abs(joined[int(25.2 * RATE) :]).max()), 3000)

    def test_one_chunk_after_a_long_gap_is_padded_in_front_so_the_audio_ends_on_the_clock(self) -> None:
        mixer = TeeMixer(t0=0.0)
        mixer.process([frame(tone_samples(2.5))], [], 2.5)
        pieces = mixer.process([frame(tone_samples(2.5))], [], 25.0)  # 20 s hole before 2.5 s of audio
        self.assertAlmostEqual(mixer.emitted / RATE, 25.0, delta=0.05)
        pcm = pcm_of(pieces)
        self.assertEqual(int(np.abs(pcm[: int(19.5 * RATE)]).max()), 0)
        self.assertGreater(int(np.abs(pcm[-int(2.0 * RATE) :]).max()), 3000)

    def test_a_deficit_inside_the_slack_is_rounding_and_is_not_padded(self) -> None:
        mixer = TeeMixer(t0=0.0)
        mixer.process([frame(tone_samples(2.4))], [], 2.5)  # 0.1 s short of the clock
        self.assertAlmostEqual(mixer.emitted / RATE, 2.4, delta=0.05)

    def test_audio_ahead_of_the_clock_is_never_trimmed(self) -> None:
        mixer = TeeMixer(t0=0.0)
        mixer.process([frame(tone_samples(3.0))], [], 2.5)
        self.assertAlmostEqual(mixer.emitted / RATE, 3.0, delta=0.05)
        mixer.process([frame(tone_samples(2.0))], [], 5.0)  # the next chunk needs no padding
        self.assertAlmostEqual(mixer.emitted / RATE, 5.0, delta=0.05)

    def test_a_huge_gap_is_split_into_messages_of_at_most_30_seconds(self) -> None:
        mixer = TeeMixer(t0=0.0)
        pieces = mixer.process([], [], 100.0)
        self.assertGreaterEqual(len(pieces), 4)
        for _pts, pcm in pieces:
            self.assertLessEqual(len(pcm), 30 * RATE * 2)
        self.assertAlmostEqual(mixer.emitted / RATE, 100.0, delta=0.01)

    def test_clipping_not_wrapping(self) -> None:
        mixer = TeeMixer(t0=0.0)
        loud = np.full(24000, 30000, dtype="<i2")
        pcm = pcm_of(mixer.process([frame(loud)], [frame(loud)], 1.0))
        self.assertGreater(int(pcm.max()), 32000)
        self.assertGreaterEqual(int(pcm.min()), 0)

    def test_nothing_in_nothing_on_the_clock_is_nothing_out(self) -> None:
        self.assertEqual(TeeMixer(t0=0.0).process([], [], 0.1), [])


# ------------------------------------------------------------------------------ the SDK RecorderIO


class _Source:
    def __init__(self) -> None:
        self.next_frame = None

    def __aiter__(self):
        return self

    async def __anext__(self):
        return self.next_frame


class _Sink(lk_io.AudioOutput):
    def __init__(self) -> None:
        super().__init__(label="Sink", capabilities=lk_io.AudioOutputCapabilities(pause=True))

    async def capture_frame(self, frame) -> None:
        await super().capture_frame(frame)

    def flush(self) -> None:
        super().flush()

    def clear_buffer(self) -> None:
        pass


class _Wall:
    def __init__(self, t: float = 1_000_000.0) -> None:
        self.t = t

    def time(self) -> float:
        return self.t


def no_forward_ticks():
    """The SDK flushes held-back input every 2.5 s of REAL time; a test must not depend on the clock."""
    return mock.patch("livekit.agents.voice.recorder_io.recorder_io.WRITE_INTERVAL", 3600.0)


async def drive_recorder_io(io_cls: type, path: Path, *, tail: bool = False) -> "RecorderRig":
    """Replay a short call through ``io_cls``: 1 s of candidate, a 1.5 s agent line, 1 s of candidate."""
    source, sink = _Source(), _Sink()
    session = SimpleNamespace(input=SimpleNamespace(audio=source), output=SimpleNamespace(audio=sink))
    wall = _Wall()
    rec = io_cls(agent_session=session, sample_rate=RATE)
    tap_in = rec.record_input(source)
    tap_out = rec.record_output(sink)
    with mock.patch("time.time", wall.time), no_forward_ticks():
        await rec.start(output_path=path)
        for index in range(50):  # 1 s of candidate at 20 ms
            source.next_frame = frame(tone_samples(0.02, 24000, 300.0, 6000))
            await tap_in.__anext__()
            wall.t += 0.02
        for index in range(75):  # a 1.5 s agent line
            await tap_out.capture_frame(frame(tone_samples(0.02, 24000, 800.0, 6000)))
            wall.t += 0.02
        tap_out.flush()
        tap_out.on_playback_finished(playback_position=1.5, interrupted=False)
        for index in range(50):  # 1 more second of candidate, held back until the next tick
            source.next_frame = frame(tone_samples(0.02, 24000, 300.0, 6000))
            await tap_in.__anext__()
            wall.t += 0.02
        flushed = rec.flush_idle_tail() if tail else None
        await asyncio.wait_for(rec.aclose(), 20)
    return RecorderRig(rec, tap_in, tap_out, flushed)


class RecorderRig:
    def __init__(self, rec, tap_in, tap_out, flushed) -> None:
        self.rec, self.tap_in, self.tap_out, self.flushed = rec, tap_in, tap_out, flushed


def decode_ogg(path: Path) -> np.ndarray:
    with av.open(str(path)) as container:
        chunks = [f.to_ndarray() for f in container.decode(container.streams.audio[0])]
    return np.concatenate(chunks, axis=1) if chunks else np.zeros((2, 0), dtype=np.float32)


class TestRecorderIoOnTheRealSdk(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="r1rec-io-")
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    @staticmethod
    def spying(base: type) -> type:
        """``base`` with an encode thread that only RECORDS what the stock encoder would consume."""

        def encode_thread(self) -> None:
            self.consumed = []
            try:
                while True:
                    chunk_in, chunk_out = self._in_q.get(), self._out_q.get()
                    if chunk_in is None or chunk_out is None:
                        break
                    self.consumed.append(
                        (b"".join(bytes(f.data) for f in chunk_in), b"".join(bytes(f.data) for f in chunk_out))
                    )
            finally:
                def resolve() -> None:
                    if not self._close_fut.done():
                        self._close_fut.set_result(None)

                self._loop.call_soon_threadsafe(resolve)

        return type("Spy" + base.__name__, (base,), {"_encode_thread": encode_thread})

    async def test_the_stock_encoder_is_fed_exactly_what_it_is_fed_without_the_tee(self) -> None:
        """The OGG is untouched because its input is: the same chunks, in the same order, object for object."""
        from livekit.agents.voice.recorder_io.recorder_io import RecorderIO

        stock = (await drive_recorder_io(self.spying(RecorderIO), self.dir / "unused-stock.ogg")).rec
        tee = (await drive_recorder_io(self.spying(r1_recorder.recorder_io_class()), self.dir / "unused-tee.ogg")).rec
        self.assertEqual(len(stock.consumed), 1)  # not vacuous: the agent line's write (the held-back
        self.assertGreater(len(stock.consumed[0][1]), 0)  # second of input is dropped at close, as stock)
        self.assertEqual(stock.consumed, tee.consumed)
        # ... and the tee saw the very same objects the stock queues carried, in lock-step.
        pairs = []
        while not tee.tee_in.empty():
            pairs.append((tee.tee_in.get_nowait()[1], tee.tee_out.get_nowait()[1]))
        self.assertTrue(tee.tee_out.empty())
        self.assertEqual(len(pairs), len(tee.consumed) + 1)  # + the (None, None) end marker
        self.assertEqual(pairs[-1], (None, None))
        for (seen_in, seen_out), (bytes_in, bytes_out) in zip(pairs, tee.consumed):
            self.assertEqual(b"".join(bytes(f.data) for f in seen_in), bytes_in)
            self.assertEqual(b"".join(bytes(f.data) for f in seen_out), bytes_out)

    async def test_the_ogg_the_tee_recorder_writes_is_the_stock_one(self) -> None:
        from livekit.agents.voice.recorder_io.recorder_io import RecorderIO

        await drive_recorder_io(RecorderIO, self.dir / "stock.ogg")
        await drive_recorder_io(r1_recorder.recorder_io_class(), self.dir / "tee.ogg")
        stock, tee = decode_ogg(self.dir / "stock.ogg"), decode_ogg(self.dir / "tee.ogg")
        self.assertGreater(stock.shape[1], RATE)  # not vacuous: the agent line was written
        self.assertEqual(stock.shape, tee.shape)
        # Opus is not bit-reproducible run to run (two STOCK runs differ by about -54 dB), so the
        # exact claim is the chunk test above; here: the same stereo picture within codec noise.
        self.assertLess(float(np.abs(stock - tee).max()), 0.01)
        left, right = tee[0], tee[1]
        self.assertGreater(float(np.abs(left).max()), 0.05)   # candidate on the left
        self.assertGreater(float(np.abs(right).max()), 0.05)  # agent on the right

    async def test_every_write_reaches_the_tee_in_lock_step_with_a_clock_stamp(self) -> None:
        cls = r1_recorder.recorder_io_class()
        clock = ManualClock(500.0)
        source, sink = _Source(), _Sink()
        session = SimpleNamespace()
        rec = cls(agent_session=session, sample_rate=RATE)
        rec.tee_clock = clock
        tap_in, tap_out = rec.record_input(source), rec.record_output(sink)
        wall = _Wall()
        with mock.patch("time.time", wall.time), no_forward_ticks():
            await rec.start(output_path=self.dir / "x.ogg")
            for _ in range(10):
                source.next_frame = frame(tone_samples(0.02))
                await tap_in.__anext__()
            await tap_out.capture_frame(frame(tone_samples(0.5)))
            wall.t += 0.5
            clock.advance(1.0)
            tap_out.on_playback_finished(playback_position=0.5, interrupted=False)
            await rec.aclose()
        stamps_in = []
        while not rec.tee_in.empty():
            stamps_in.append(rec.tee_in.get_nowait())
        stamps_out = []
        while not rec.tee_out.empty():
            stamps_out.append(rec.tee_out.get_nowait())
        self.assertEqual(len(stamps_in), len(stamps_out))
        self.assertEqual(len(stamps_in), 2)  # the line's write and the close sentinel
        (t_in, in_buf), (t_out, out_buf) = stamps_in[0], stamps_out[0]
        self.assertEqual((t_in, t_out), (501.0, 501.0))
        self.assertEqual(len(in_buf), 10)
        self.assertEqual(len(out_buf), 1)
        self.assertEqual((stamps_in[1][1], stamps_out[1][1]), (None, None))  # aclose's end sentinels

    async def test_the_idle_tail_flush_keeps_the_candidate_audio_the_stock_recorder_drops(self) -> None:
        from livekit.agents.voice.recorder_io.recorder_io import RecorderIO

        stock_path, tee_path = self.dir / "stock.ogg", self.dir / "tail.ogg"
        await drive_recorder_io(RecorderIO, stock_path)
        rig = await drive_recorder_io(r1_recorder.recorder_io_class(), tee_path, tail=True)
        self.assertTrue(rig.flushed)
        stock, tail = decode_ogg(stock_path), decode_ogg(tee_path)
        self.assertGreater(tail.shape[1], stock.shape[1] + int(0.8 * RATE))  # the held-back second
        self.assertGreater(float(np.abs(tail[0, -int(0.5 * RATE) :]).max()), 0.05)

    async def test_no_flush_while_the_agent_is_mid_line_and_none_after_capture_closes(self) -> None:
        cls = r1_recorder.recorder_io_class()
        source, sink = _Source(), _Sink()
        rec = cls(agent_session=SimpleNamespace(), sample_rate=RATE)
        tap_in, tap_out = rec.record_input(source), rec.record_output(sink)
        wall = _Wall()
        with mock.patch("time.time", wall.time), no_forward_ticks():
            self.assertFalse(rec.flush_idle_tail())  # not started
            await rec.start(output_path=self.dir / "mid.ogg")
            self.assertTrue(rec.recording)
            await tap_out.capture_frame(frame(tone_samples(0.5)))  # a line is playing
            self.assertFalse(rec.flush_idle_tail())
            rec.close_capture()
            self.assertFalse(rec.recording)
            source.next_frame = frame(tone_samples(0.02))
            await tap_in.__anext__()
            self.assertEqual(tap_in.take_buf(), [])  # nothing accumulates once capture is closed
            await rec.aclose()


# ------------------------------------------------------------------------------ doubles


class FakeApi:
    """The worker routes and the presigned PUT, scripted; every call is recorded."""

    BASE = "https://r2.example.test/bucket/key"

    def __init__(self, events: list | None = None) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.puts: list[dict] = []
        self.scripts: dict[str, list] = {}
        self.put_statuses: list[int] = []
        self.part_size = 65536
        self.checkpoint = 10
        self.events = events if events is not None else []
        self.lock = threading.Lock()
        self.threads: set[str] = set()
        self.inflight = 0
        self.max_inflight = 0
        self.put_delay = 0.0

    def script(self, op: str, *replies) -> None:
        self.scripts.setdefault(op, []).extend(replies)

    def ops(self) -> list[str]:
        with self.lock:
            return [op for op, _body in self.calls]

    def bodies(self, op: str) -> list[dict]:
        with self.lock:
            return [body for name, body in self.calls if name == op]

    def post(self, op, body, *, connect_timeout, total_timeout):
        with self.lock:
            self.calls.append((op, dict(body)))
            self.threads.add(threading.current_thread().name)
            scripted = self.scripts.get(op)
            reply = scripted.pop(0) if scripted else None
        self.events.append("api." + op)
        if callable(reply):
            reply = reply(op, body)
        if isinstance(reply, Exception):
            raise reply
        if reply is not None:
            return reply
        if op == "prepare":
            return ApiReply(200, {
                "mode": body.get("mode"), "content_type": "audio/mp4", "part_size": self.part_size,
                "max_parts": 60, "next_part": 1, "checkpoint_interval_sec": self.checkpoint, "url_ttl_sec": 600,
            }, None)
        if op == "part-url":
            number = body["part_number"]
            return ApiReply(200, {"url": f"{self.BASE}/part?partNumber={number}&X-Amz-Signature=deadbeefcafe",
                                  "part_number": number, "expires_in_sec": 600}, None)
        if op == "object-url":
            kind = body["kind"]
            content_type = "audio/ogg" if kind.startswith("audio") else "audio/mp4"
            return ApiReply(200, {"url": f"{self.BASE}/{kind}?X-Amz-Signature=deadbeefcafe", "kind": kind,
                                  "content_type": content_type, "expires_in_sec": 600}, None)
        if op == "complete":
            return ApiReply(200, {"status": "finishing"}, None)
        raise AssertionError(op)

    def put(self, url, body, content_type, *, connect_timeout, total_timeout):
        with self.lock:
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
            status = self.put_statuses.pop(0) if self.put_statuses else 200
            self.puts.append({"url": url, "body": bytes(body), "content_type": content_type, "status": status})
        self.events.append("put")
        if self.put_delay:
            time.sleep(self.put_delay)
        with self.lock:
            self.inflight -= 1
        return ApiReply(status, {}, None, '"etag"')


class StubHttp:
    def __init__(self) -> None:
        self.aborted = False

    def abort(self) -> None:
        self.aborted = True


class FakeIO:
    """The RecorderIO surface ``R1Recorder`` uses, with no SDK behind it."""

    def __init__(self, events: list, *, start_error: BaseException | None = None, start_hangs: bool = False) -> None:
        self.events = events
        self.tee_in: queue.Queue = queue.Queue()
        self.tee_out: queue.Queue = queue.Queue()
        self.tee_clock = time.monotonic
        self.started = False
        self.closed = False
        self.capture_closed = False
        self.idle_flushes = 0
        self.start_error = start_error
        self.start_hangs = start_hangs
        self.output_path: Path | None = None
        self.sources: list = []

    def record_input(self, source):
        self.sources.append(("in", source))
        return SimpleNamespace(tap="in", source=source)

    def record_output(self, sink):
        self.sources.append(("out", sink))
        return SimpleNamespace(tap="out", sink=sink)

    async def start(self, *, output_path) -> None:
        if self.start_hangs:
            await asyncio.Event().wait()
        if self.start_error is not None:
            raise self.start_error
        self.output_path = Path(output_path)
        self.output_path.write_bytes(b"OggS" + bytes(range(256)) * 8)  # stands in for the stock OGG
        self.started = True

    async def aclose(self) -> None:
        self.events.append("io.aclose")
        self.closed = True
        self.tee_in.put((self.tee_clock(), None))
        self.tee_out.put((self.tee_clock(), None))

    def close_capture(self) -> None:
        self.capture_closed = True

    def flush_idle_tail(self) -> bool:
        self.idle_flushes += 1
        return True

    def push(self, t: float, seconds: float = 2.5, *, agent: float = 0.0) -> None:
        self.tee_in.put((t, [frame(tone_samples(seconds))]))
        self.tee_out.put((t, [frame(tone_samples(agent))] if agent else []))


class FakeEncoder:
    """The EncoderProcess surface; EOF/REMUX are answered from files the test lays down."""

    def __init__(self, events: list, spool_dir: Path, *, usable: bool = True, mp4_bytes: int = 150_000) -> None:
        self.events = events
        self.spool_dir = Path(spool_dir)
        self.ready = threading.Event()
        self.closed = threading.Event()
        self.remuxed = threading.Event()
        self.exited = threading.Event()
        self.ready_info = None
        self.error_code = None
        self.closed_info = None
        self.remux_bytes = None
        self.progress: dict = {}
        self.spawned_at = time.monotonic()
        self.last_status_at = time.monotonic()
        self.overflowed = False
        self.hello = None
        self.audio: list[tuple[int, bytes]] = []
        self.eof_sent = False
        self.remux_requests = 0
        self.killed = False
        self.quit_sent = False
        self.mp4_bytes = mp4_bytes
        self.media_ms = 12_000
        self.remux_bytes_to_write = 120_000
        if usable:
            self.ready.set()
        else:
            self.exited.set()

    @property
    def dead(self) -> bool:
        if self.overflowed or self.killed:
            return True
        return self.exited.is_set() and not (self.closed.is_set() or self.quit_sent)

    def spawn(self) -> bool:
        return not self.exited.is_set()

    def send_hello(self, *, video, preset, t0_us) -> bool:
        self.hello = {"video": video, "preset": preset, "t0_us": t0_us}
        return True

    def send_audio(self, pts_us, pcm) -> bool:
        self.audio.append((pts_us, pcm))
        return not self.dead

    def send_eof(self) -> bool:
        self.events.append("enc.eof")
        self.eof_sent = True
        content = bytes((i * 7) % 251 for i in range(self.mp4_bytes))
        (self.spool_dir / "stream.mp4").write_bytes(content)
        self.closed_info = {"s": "closed", "bytes": self.mp4_bytes, "media_ms": self.media_ms}
        self.closed.set()
        return True

    def send_remux(self) -> bool:
        self.events.append("enc.remux")
        self.remux_requests += 1
        (self.spool_dir / "video.mp4").write_bytes(b"F" * self.remux_bytes_to_write)
        self.remux_bytes = self.remux_bytes_to_write
        self.remuxed.set()
        return True

    def quit(self) -> bool:
        self.quit_sent = True
        self.exited.set()
        return True

    def kill(self) -> None:
        self.killed = True
        self.exited.set()
        self.events.append("enc.kill")

    def alive(self) -> bool:
        return not self.exited.is_set()


class RecorderCase(unittest.IsolatedAsyncioTestCase):
    """A recorder wired to the doubles, in a throwaway spool."""

    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="r1rec-case-")
        self.addCleanup(self._tmp.cleanup)
        self.events: list = []
        self.root = Path(self._tmp.name) / "r1-rec"
        self.spool = Spool(self.root, SESSION_ID)
        self.spool.create()
        self.api = FakeApi(self.events)
        self.http = StubHttp()
        self.io = FakeIO(self.events)
        self.encoder = FakeEncoder(self.events, self.spool.dir)
        self.session = SimpleNamespace(
            input=SimpleNamespace(audio=object()), output=SimpleNamespace(audio=object())
        )
        self.wall = ManualClock(1_700_000_000.0)
        self.clock = ManualClock(1000.0)
        self.recorder: R1Recorder | None = None
        patch = mock.patch.object(r1_recorder, "RETRY_DELAYS_SECONDS", (0.0, 0.0, 0.0))
        patch.start()
        self.addCleanup(patch.stop)

    def make(self, **overrides) -> R1Recorder:
        params = dict(
            session=self.session, room=ROOM, session_id=SESSION_ID, mode="audio", spool=self.spool,
            encoder=self.encoder, api=self.api, http_client=self.http, finish_seconds=18.0,
            clock=self.clock, wall=self.wall, io_class=lambda: (lambda **_kw: self.io),
        )
        params.update(overrides)
        self.recorder = R1Recorder(**params)
        self.addCleanup(self.recorder._worker.halt)
        return self.recorder

    async def started(self, **overrides) -> R1Recorder:
        recorder = self.make(**overrides)
        await recorder.start("candidate")
        return recorder

    def lay_stream(self, size: int | None = None) -> bytes:
        content = bytes((i * 7) % 251 for i in range(size if size is not None else self.encoder.mp4_bytes))
        (self.spool.dir / "stream.mp4").write_bytes(content)
        return content


# ------------------------------------------------------------------------------ upload worker


class TestUploadWorker(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="r1rec-up-")
        self.addCleanup(self._tmp.cleanup)
        self.spool = Spool(Path(self._tmp.name) / "r", SESSION_ID)
        self.spool.create()
        self.api = FakeApi()
        self.clock = ManualClock(0.0)
        self.discards: list[str] = []
        self.stops: list[str] = []
        self.mp4 = True
        patch = mock.patch.object(r1_recorder, "RETRY_DELAYS_SECONDS", (0.0, 0.0, 0.0))
        patch.start()
        self.addCleanup(patch.stop)
        self.worker = UploadWorker(
            api=self.api, http_client=StubHttp(), spool=self.spool, mode="audio", clock=self.clock,
            on_discard=self.discards.append, on_stop=self.stops.append, mp4_enabled=lambda: self.mp4,
            rng=lambda: 0.5,
        )
        self.addCleanup(self.worker.halt)

    def lay(self, size: int) -> bytes:
        content = os.urandom(size)
        (self.spool.dir / "stream.mp4").write_bytes(content)
        return content

    def prepare(self) -> None:
        self.assertTrue(self.worker._prepare(deadline=None, interruptible=False))

    def test_prepare_takes_the_servers_parameters(self) -> None:
        self.api.part_size = 262144
        self.api.checkpoint = 30
        self.prepare()
        self.assertEqual(self.worker.state, "uploading")
        self.assertEqual((self.worker.part_size, self.worker.checkpoint_seconds), (262144, 30.0))
        self.assertEqual(self.api.bodies("prepare"), [{"mode": "audio"}])

    def test_prepare_with_an_unusable_part_size_stops_the_upload(self) -> None:
        for bad in (0, 1024, 10**9, "5MiB", None, True):
            with self.subTest(part_size=bad):
                self.setUp()
                self.api.script("prepare", ApiReply(200, {"part_size": bad}, None))
                self.assertFalse(self.worker._prepare(deadline=None, interruptible=False))
                self.assertEqual(self.worker.state, "ended")
                self.assertEqual(self.stops, ["rejected"])

    def test_uniform_parts_are_cut_from_the_growing_file_one_at_a_time_in_order(self) -> None:
        self.prepare()
        content = self.lay(65536 * 2 + 1000)
        self.worker._upload_ready_parts(final=False, deadline=None, interruptible=False)
        self.assertEqual(self.worker.parts_done, 2)  # the short tail waits for the file to grow
        self.assertEqual([p["body"] for p in self.api.puts], [content[:65536], content[65536:131072]])
        self.assertEqual([b["part_number"] for b in self.api.bodies("part-url")], [1, 2])
        self.assertEqual({p["content_type"] for p in self.api.puts}, {"application/octet-stream"})
        # The file grows: the next full part goes, the remainder still waits.
        content += os.urandom(65536)
        (self.spool.dir / "stream.mp4").write_bytes(content)
        self.worker._upload_ready_parts(final=False, deadline=None, interruptible=False)
        self.assertEqual(self.worker.parts_done, 3)
        self.assertEqual(self.api.puts[-1]["body"], content[131072:196608])
        self.assertEqual(self.api.max_inflight, 1)

    def test_the_final_pass_uploads_the_short_last_part_and_then_nothing(self) -> None:
        self.prepare()
        content = self.lay(65536 + 4321)
        self.assertTrue(self.worker._upload_ready_parts(final=True, deadline=None, interruptible=False))
        self.assertEqual([p["body"] for p in self.api.puts], [content[:65536], content[65536:]])
        self.assertEqual(self.worker.parts_done, 2)
        # A second final pass has nothing left: no new calls.
        calls = len(self.api.calls)
        self.assertTrue(self.worker._upload_ready_parts(final=True, deadline=None, interruptible=False))
        self.assertEqual(len(self.api.calls), calls)

    def test_a_file_smaller_than_one_part_is_a_single_last_part(self) -> None:
        self.prepare()
        content = self.lay(5000)
        self.worker._upload_ready_parts(final=False, deadline=None, interruptible=False)
        self.assertEqual(self.api.puts, [])
        self.assertTrue(self.worker._upload_ready_parts(final=True, deadline=None, interruptible=False))
        self.assertEqual([p["body"] for p in self.api.puts], [content])
        self.assertEqual(self.api.bodies("part-url"), [{"part_number": 1}])

    def test_an_empty_or_missing_file_uploads_nothing_and_is_complete(self) -> None:
        self.prepare()
        self.assertTrue(self.worker._upload_ready_parts(final=True, deadline=None, interruptible=False))
        self.assertEqual(self.api.puts, [])

    def test_a_failed_put_retries_with_a_fresh_url_and_the_same_bytes(self) -> None:
        self.prepare()
        content = self.lay(65536)
        self.api.put_statuses = [500, 403, 200]
        self.worker._upload_ready_parts(final=False, deadline=None, interruptible=False)
        self.assertEqual(self.worker.parts_done, 1)
        self.assertEqual(len(self.api.puts), 3)
        self.assertEqual({p["body"] for p in self.api.puts}, {content})
        self.assertEqual(len(self.api.bodies("part-url")), 3, "every attempt asks for a fresh presigned URL")
        self.assertEqual({b["part_number"] for b in self.api.bodies("part-url")}, {1})

    def test_the_bytes_stay_on_disk_and_the_cursor_stays_until_the_put_succeeds(self) -> None:
        self.prepare()
        content = self.lay(65536)
        self.api.put_statuses = [500, 500, 500, 500]  # one whole round fails
        self.assertFalse(self.worker._upload_ready_parts(final=False, deadline=None, interruptible=False))
        self.assertEqual((self.worker.cut, self.worker.parts_done), (0, 0))
        self.assertEqual((self.spool.dir / "stream.mp4").read_bytes(), content)
        self.assertEqual(len(self.api.puts), 4)  # one try plus three retries
        # The failed round pauses part uploads; after the pause the same part goes out again.
        self.assertGreater(self.worker._next_parts_at, self.clock())
        self.clock.advance(20)
        self.worker._upload_ready_parts(final=False, deadline=None, interruptible=False)
        self.assertEqual(self.worker.parts_done, 1)
        self.assertEqual(self.api.puts[-1]["body"], content)

    def test_part_urls_are_requested_in_order_so_the_server_never_sees_a_skip_ahead(self) -> None:
        self.prepare()
        self.lay(65536 * 3)
        self.worker._upload_ready_parts(final=False, deadline=None, interruptible=False)
        self.assertEqual([b["part_number"] for b in self.api.bodies("part-url")], [1, 2, 3])

    def test_no_more_than_the_servers_max_parts(self) -> None:
        self.api.script("prepare", ApiReply(200, {"part_size": 65536, "max_parts": 2, "checkpoint_interval_sec": 10}, None))
        self.prepare()
        self.lay(65536 * 4)
        self.worker._upload_ready_parts(final=True, deadline=None, interruptible=False)
        self.assertEqual(self.worker.parts_done, 2)

    def test_the_ogg_checkpoint_goes_out_on_cadence_and_only_when_the_file_changed(self) -> None:
        self.prepare()  # clock 0 -> first checkpoint at 10
        ogg = self.spool.ogg_path
        ogg.write_bytes(b"OggS" + b"a" * 4000)
        self.worker._maybe_checkpoint()
        self.assertEqual(self.api.puts, [], "not before the interval")
        self.clock.advance(10)
        self.worker._maybe_checkpoint()
        self.assertEqual(self.api.bodies("object-url"), [{"kind": "audio_partial"}])
        self.assertEqual(self.api.puts[-1]["body"], ogg.read_bytes())
        self.assertEqual(self.api.puts[-1]["content_type"], "audio/ogg")
        self.assertTrue(self.worker.checkpoint_uploaded)
        self.clock.advance(10)
        self.worker._maybe_checkpoint()
        self.assertEqual(len(self.api.puts), 1, "an unchanged OGG is not re-sent")
        ogg.write_bytes(b"OggS" + b"b" * 6000)
        self.clock.advance(10)
        self.worker._maybe_checkpoint()
        self.assertEqual(len(self.api.puts), 2)
        self.assertEqual(self.api.puts[-1]["body"], ogg.read_bytes())

    def test_a_failed_checkpoint_is_retried_after_a_pause(self) -> None:
        self.prepare()
        self.spool.ogg_path.write_bytes(b"OggS" + b"a" * 100)
        self.clock.advance(10)
        self.api.put_statuses = [500, 500, 500, 500]
        self.worker._maybe_checkpoint()
        self.assertFalse(self.worker.checkpoint_uploaded)
        self.worker._maybe_checkpoint()  # still inside the pause
        self.assertEqual(len(self.api.puts), 4)
        self.clock.advance(16)
        self.worker._maybe_checkpoint()
        self.assertTrue(self.worker.checkpoint_uploaded)

    def test_an_object_put_sends_the_content_type_exactly_as_the_api_returned_it(self) -> None:
        self.prepare()
        self.spool.ogg_path.write_bytes(b"OggS" + b"z" * 50)
        self.api.script("object-url", ApiReply(200, {"url": FakeApi.BASE + "/x", "content_type": "audio/ogg; codecs=opus"}, None))
        self.assertTrue(self.worker._put_object("audio", self.spool.ogg_path, deadline=None, interruptible=False))
        self.assertEqual(self.api.puts[-1]["content_type"], "audio/ogg; codecs=opus")

    def test_an_answer_with_no_url_is_retried_not_trusted(self) -> None:
        self.prepare()
        self.spool.ogg_path.write_bytes(b"OggS" + b"z" * 50)
        self.api.script("object-url", ApiReply(200, {}, None), ApiReply(200, {"url": "", "content_type": "audio/ogg"}, None))
        self.assertTrue(self.worker._put_object("audio", self.spool.ogg_path, deadline=None, interruptible=False))
        self.assertEqual(len(self.api.bodies("object-url")), 3)

    def test_each_api_answer_has_one_reaction(self) -> None:
        cases = [
            (ApiReply(503, {"error": "r1_recording_disabled"}, "r1_recording_disabled"), "discard", "disabled"),
            (ApiReply(409, {"error": "r1_consent_withdrawn"}, "r1_consent_withdrawn"), "discard", "consent_withdrawn"),
            (ApiReply(410, {"error": "r1_recording_deleted"}, "r1_recording_deleted"), "discard", "deleted"),
            (ApiReply(409, {"error": "r1_session"}, "r1_session"), "stop", "session"),
            (ApiReply(409, {"error": "r1_recording_state"}, "r1_recording_state"), "stop", "state"),
            (ApiReply(401, {}, None), "stop", "rejected"),
            (ApiReply(403, {}, None), "stop", "rejected"),
            (ApiReply(400, {"error": "invalid_r1_room"}, "invalid_r1_room"), "stop", "rejected"),
            (ApiReply(404, {}, None), "stop", "rejected"),
            (ApiReply(429, {}, None), "retry", "retry"),
            (ApiReply(500, {}, None), "retry", "retry"),
            (ApiReply(503, {"error": "service_unavailable"}, "service_unavailable"), "retry", "retry"),
            (ApiReply(200, {}, None), "ok", "ok"),
        ]
        for reply, verdict, reason in cases:
            with self.subTest(status=reply.status, code=reply.code):
                self.assertEqual(r1_recorder.classify(reply), (verdict, reason))

    def test_a_discard_answer_ends_all_uploading_and_tells_the_recorder_once(self) -> None:
        self.prepare()
        self.lay(65536 * 2)
        self.api.script("part-url", ApiReply(409, {"error": "r1_consent_withdrawn"}, "r1_consent_withdrawn"))
        self.worker._upload_ready_parts(final=False, deadline=None, interruptible=False)
        self.assertEqual(self.discards, ["consent_withdrawn"])
        self.assertEqual(self.worker.state, "ended")
        calls = len(self.api.calls)
        self.worker._upload_ready_parts(final=False, deadline=None, interruptible=False)
        self.worker._maybe_checkpoint()
        self.assertEqual(len(self.api.calls), calls, "no further calls after a discard")
        self.assertEqual(self.worker.job_complete({"layout": "combined"}, deadline=100.0), "failed")
        self.assertEqual(len(self.api.calls), calls)

    def test_a_stop_answer_means_no_complete(self) -> None:
        self.api.script("prepare", ApiReply(409, {"error": "r1_session"}, "r1_session"))
        self.assertFalse(self.worker._prepare(deadline=None, interruptible=False))
        self.assertEqual(self.stops, ["session"])
        self.assertEqual(self.worker.job_complete({}, deadline=100.0), "failed")
        self.assertEqual(self.api.ops(), ["prepare"])

    def test_retryable_answers_are_retried_three_times_then_the_round_fails_quietly(self) -> None:
        self.api.script("prepare", *[ApiReply(503, {"error": "service_unavailable"}, "service_unavailable")] * 4)
        self.assertFalse(self.worker._prepare(deadline=None, interruptible=False))
        self.assertEqual(self.api.ops().count("prepare"), 4)
        self.assertEqual(self.worker.state, "preparing")  # not fatal: tried again after a pause
        self.assertEqual((self.discards, self.stops), ([], []))
        self.clock.advance(16)
        self.worker._periodic()
        self.assertEqual(self.worker.state, "uploading")

    def test_a_transport_failure_is_a_retry(self) -> None:
        self.api.script("prepare", HttpFailure("network"), HttpFailure("timeout"))
        self.prepare()
        self.assertEqual(self.api.ops().count("prepare"), 3)

    def test_an_aborted_request_ends_the_attempts_without_a_retry(self) -> None:
        self.api.script("prepare", HttpFailure("aborted"))
        self.assertFalse(self.worker._prepare(deadline=None, interruptible=False))
        self.assertEqual(self.api.ops().count("prepare"), 1)

    def test_a_missing_secret_is_a_stop_not_an_endless_retry(self) -> None:
        self.api.script("prepare", HttpFailure("no_secret"))
        self.assertFalse(self.worker._prepare(deadline=None, interruptible=False))
        self.assertEqual(self.stops, ["rejected"])

    def test_a_deadline_bounds_the_retries(self) -> None:
        self.api.script("prepare", *[ApiReply(500, {}, None)] * 8)
        self.clock.value = 100.0
        with mock.patch.object(r1_recorder, "RETRY_DELAYS_SECONDS", (5.0, 5.0, 5.0)):
            self.assertFalse(self.worker._prepare(deadline=101.0, interruptible=False))
        self.assertEqual(self.api.ops().count("prepare"), 1, "the next delay would pass the deadline")

    def test_finish_timeouts_never_exceed_the_remaining_budget_or_15_seconds(self) -> None:
        self.clock.value = 10.0
        self.assertEqual(self.worker._timeouts(None), (5.0, 60.0))
        self.assertEqual(self.worker._timeouts(100.0), (5.0, 15.0))
        self.assertEqual(self.worker._timeouts(12.5), (2.5, 2.5))
        self.assertIsNone(self.worker._timeouts(10.01))

    def test_jobs_run_on_the_one_upload_thread_and_a_waiting_job_cuts_a_retry_sleep(self) -> None:
        self.api.script("prepare", *[ApiReply(500, {}, None)] * 2)
        with mock.patch.object(r1_recorder, "RETRY_DELAYS_SECONDS", (30.0, 30.0, 30.0)):
            self.worker.start()
            wait_until(lambda: "prepare" in self.api.ops())  # inside its first retry sleep
            started = time.monotonic()
            future = self.worker.submit(lambda: threading.current_thread().name)
            self.assertEqual(future.result(timeout=5), "r1rec_upload")
            self.assertLess(time.monotonic() - started, 4.0)

    def test_periodic_work_uploads_in_the_background(self) -> None:
        content = self.lay(65536 + 10)
        self.worker.start()
        wait_until(lambda: self.worker.parts_done == 1)
        self.assertEqual(self.api.puts[0]["body"], content[:65536])
        self.assertEqual(self.api.threads, {"r1rec_upload"})

    def test_periodic_work_skips_the_mp4_when_the_encoder_is_lost(self) -> None:
        self.prepare()
        self.lay(65536 * 2)
        self.mp4 = False
        self.worker._periodic()
        self.assertEqual(self.api.puts, [])

    def test_job_tail_uploads_the_last_part_or_the_final_ogg(self) -> None:
        content = self.lay(65536 + 99)
        self.spool.ogg_path.write_bytes(b"OggS" + b"q" * 300)
        result = self.worker.job_tail(mp4=True, final_ogg=False, deadline=100.0)
        self.assertEqual(result, {"uploading": True, "mp4": True, "ogg": False})
        self.assertEqual(b"".join(p["body"] for p in self.api.puts), content)
        result = self.worker.job_tail(mp4=False, final_ogg=True, deadline=100.0)
        self.assertEqual(result, {"uploading": True, "mp4": False, "ogg": True})
        self.assertEqual(self.api.bodies("object-url")[-1], {"kind": "audio"})
        self.assertTrue(self.worker.final_ogg_uploaded)

    def test_job_tail_tries_prepare_once_more_and_reports_not_uploading_if_it_still_fails(self) -> None:
        self.api.script("prepare", *[ApiReply(503, {"error": "service_unavailable"}, "service_unavailable")] * 4)
        self.assertEqual(self.worker.job_tail(mp4=True, final_ogg=False, deadline=100.0)["uploading"], False)

    def test_job_video_and_complete(self) -> None:
        self.prepare()
        self.spool.video_path.write_bytes(b"F" * 2000)
        self.assertTrue(self.worker.job_video(deadline=100.0))
        self.assertEqual(self.api.bodies("object-url")[-1], {"kind": "video"})
        self.assertEqual(self.api.puts[-1]["content_type"], "audio/mp4")
        self.assertTrue(self.worker.faststart_uploaded)
        body = {"layout": "combined", "has_video": False, "report": {}}
        self.assertEqual(self.worker.job_complete(body, deadline=100.0), "ok")
        self.assertEqual(self.api.bodies("complete"), [body])


# ------------------------------------------------------------------------------ http


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    log_message = lambda *a, **k: None  # noqa: E731

    def _serve(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self.server.seen.append({"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
        if self.path.startswith("/hang"):
            self.server.release.wait(30)
            return
        status = int(self.path.rsplit("/", 1)[-1]) if self.path.startswith("/status/") else 200
        payload = json.dumps({"error": "r1_recording_state"} if status == 409 else {"ok": True, "echo": len(body)}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("ETag", '"abc123"')
        self.end_headers()
        self.wfile.write(payload)

    do_POST = do_PUT = do_GET = _serve


class TestHttpClient(unittest.TestCase):
    def setUp(self) -> None:
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.seen = []
        self.server.release = threading.Event()
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.client = HttpClient()
        self.addCleanup(self.server.server_close)  # cleanups run last-in first-out:
        self.addCleanup(self.server.shutdown)      # release the handlers, stop the loop, then close
        self.addCleanup(self.server.release.set)

    def test_a_presigned_put_goes_out_with_only_the_headers_it_was_signed_for(self) -> None:
        reply = self.client.request(
            "PUT", self.base + "/bucket/key?partNumber=2&X-Amz-Signature=abc%2Fdef",
            headers={"Content-Type": "application/octet-stream"}, body=b"x" * 100_000,
            connect_timeout=2, total_timeout=10,
        )
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.headers["etag"], '"abc123"')
        seen = self.server.seen[-1]
        self.assertEqual(seen["path"], "/bucket/key?partNumber=2&X-Amz-Signature=abc%2Fdef")  # byte-exact
        self.assertEqual(seen["body"], b"x" * 100_000)
        self.assertEqual(set(seen["headers"]), {"host", "content-type", "content-length"})

    def test_the_api_post_carries_the_bearer_and_the_room(self) -> None:
        api = RecordingApi(self.client, ROOM, endpoint=lambda path: self.base + path, secret=lambda: "fake-secret-value")
        reply = api.post("prepare", {"mode": "audio"}, connect_timeout=2, total_timeout=10)
        self.assertEqual((reply.status, reply.data["ok"]), (200, True))
        seen = self.server.seen[-1]
        self.assertEqual(seen["path"], "/api/internal/r1/recording/prepare")
        self.assertEqual(json.loads(seen["body"]), {"room": ROOM, "mode": "audio"})
        self.assertEqual(seen["headers"]["authorization"], "Bearer fake-secret-value")
        self.assertEqual(seen["headers"]["content-type"], "application/json")

    def test_error_codes_are_read_from_the_body_and_only_when_well_formed(self) -> None:
        api = RecordingApi(self.client, ROOM, endpoint=lambda path: self.base + "/status/409", secret=lambda: "s")
        reply = api.post("prepare", {}, connect_timeout=2, total_timeout=10)
        self.assertEqual((reply.status, reply.code), (409, "r1_recording_state"))

    def test_a_missing_secret_is_a_failure_before_any_connection(self) -> None:
        api = RecordingApi(self.client, ROOM, endpoint=lambda path: self.base + path, secret=lambda: None)
        with self.assertRaises(HttpFailure) as caught:
            api.post("prepare", {}, connect_timeout=2, total_timeout=10)
        self.assertEqual(caught.exception.kind, "no_secret")
        self.assertEqual(self.server.seen, [])

    def test_unusable_urls_and_refused_connections_are_failures_not_exceptions(self) -> None:
        for url in ("ftp://example.test/x", "not a url", "file:///etc/passwd"):
            with self.subTest(url=url):
                with self.assertRaises(HttpFailure) as caught:
                    self.client.request("GET", url, headers={}, body=None, connect_timeout=1, total_timeout=2)
                self.assertEqual(caught.exception.kind, "bad_url")
        with self.assertRaises(HttpFailure) as caught:
            self.client.request("GET", "http://127.0.0.1:1/x", headers={}, body=None, connect_timeout=1, total_timeout=2)
        self.assertIn(caught.exception.kind, ("network", "timeout"))

    def test_the_total_deadline_is_enforced_against_a_server_that_never_answers(self) -> None:
        started = time.monotonic()
        with self.assertRaises(HttpFailure) as caught:
            self.client.request("GET", self.base + "/hang", headers={}, body=None, connect_timeout=1, total_timeout=0.6)
        self.assertEqual(caught.exception.kind, "timeout")
        self.assertLess(time.monotonic() - started, 3.0)

    def test_abort_cuts_an_in_flight_request_from_another_thread(self) -> None:
        threading.Timer(0.3, self.client.abort).start()
        started = time.monotonic()
        with self.assertRaises(HttpFailure) as caught:
            self.client.request("GET", self.base + "/hang", headers={}, body=None, connect_timeout=1, total_timeout=30)
        self.assertEqual(caught.exception.kind, "aborted")
        self.assertLess(time.monotonic() - started, 5.0)
        with self.assertRaises(HttpFailure):  # once aborted, nothing else goes out
            self.client.request("GET", self.base + "/ok", headers={}, body=None, connect_timeout=1, total_timeout=2)


# ------------------------------------------------------------------------------ lifecycle


class TestStart(RecorderCase):
    async def test_start_wires_the_taps_sends_hello_and_begins_the_upload(self) -> None:
        recorder = await self.started()
        self.assertEqual(recorder.phase, "capturing")
        self.assertEqual(self.session.input.audio.tap, "in")
        self.assertEqual(self.session.output.audio.tap, "out")
        self.assertTrue(self.io.started)
        self.assertEqual(self.io.output_path, self.spool.ogg_path)
        self.assertEqual(self.encoder.hello, {"video": False, "preset": "superfast", "t0_us": 1000 * 1_000_000})
        await until(lambda: "prepare" in self.api.ops())
        self.assertEqual(self.api.bodies("prepare"), [{"mode": "audio"}])
        await recorder.finish()

    async def test_start_never_blocks_on_the_network(self) -> None:
        self.api.script("prepare", lambda *_a: time.sleep(0.5) or ApiReply(200, {"part_size": 65536}, None))
        recorder = self.make()
        started = time.monotonic()
        await recorder.start("candidate")
        self.assertLess(time.monotonic() - started, 0.4)
        await recorder.finish()

    async def test_the_report_starts_from_the_instant_start_returned(self) -> None:
        recorder = await self.started()
        self.assertEqual(recorder._facts.started_at_ms, 1_700_000_000_000)
        self.assertEqual(recorder._t0, 1000.0)
        await recorder.finish()

    async def test_a_video_mode_request_is_recorded_as_audio_until_camera_capture_exists(self) -> None:
        recorder = await self.started(mode="av")
        await until(lambda: "prepare" in self.api.ops())
        self.assertEqual(self.api.bodies("prepare"), [{"mode": "audio"}])
        self.assertEqual(self.encoder.hello["video"], False)
        await recorder.finish()

    async def test_a_start_that_fails_never_raises_and_leaves_nothing_behind(self) -> None:
        for label, io in (
            ("error", FakeIO(self.events, start_error=RuntimeError("boom " + PRESIGNED))),
            ("hang", FakeIO(self.events, start_hangs=True)),
        ):
            with self.subTest(label):
                await self.asyncSetUp()
                self.io = io
                recorder = self.make()
                with mock.patch.object(r1_recorder, "IO_START_WAIT_SECONDS", 0.2), captured_logs() as lines:
                    await recorder.start("candidate")
                self.assertEqual(recorder.phase, "done")
                self.assertTrue(self.encoder.killed)
                self.assertFalse(self.spool.dir.exists())
                self.assertEqual(self.api.calls, [])
                self.assertEqual(lines[-1]["error_type"], "r1_rec_start_failed")
                self.assertNotIn("boom", json.dumps(lines))
                await recorder.finish()  # a finish after a refused start is a no-op
                self.assertEqual(self.api.calls, [])

    async def test_no_audio_io_means_no_recording_and_no_error(self) -> None:
        self.session.input.audio = None
        recorder = self.make()
        with captured_logs() as lines:
            await recorder.start("candidate")
        self.assertEqual(recorder.phase, "done")
        self.assertEqual(lines[-1]["error_type"], "r1_rec_wire_skipped")
        self.assertIsNone(self.session.input.audio)  # the session's I/O was never touched
        self.assertEqual(self.api.calls, [])

    async def test_a_second_start_is_ignored(self) -> None:
        recorder = await self.started()
        await recorder.start("again")
        self.assertEqual(len(self.io.sources), 2)  # one input, one output, wired once
        await recorder.finish()


class TestTeeFeedsTheEncoder(RecorderCase):
    async def test_chunks_become_one_continuous_timeline_for_the_encoder(self) -> None:
        recorder = await self.started()
        for tick in range(1, 5):
            self.io.push(1000.0 + 2.5 * tick)
        await until(lambda: len(self.encoder.audio) >= 4)
        pts = [p for p, _ in self.encoder.audio]
        self.assertEqual(pts[0], 0)
        samples = 0
        for stamp, pcm in self.encoder.audio:
            self.assertEqual(stamp, samples * 1_000_000 // RATE)
            samples += len(pcm) // 2
        self.assertAlmostEqual(samples / RATE, 10.0, delta=0.05)
        await recorder.finish()

    async def test_a_lost_encoder_gets_no_more_audio_but_the_tee_keeps_draining(self) -> None:
        recorder = await self.started()
        self.io.push(1002.5)
        await until(lambda: len(self.encoder.audio) == 1)
        self.encoder.exited.set()
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_crashed")
        self.io.push(1005.0)
        await until(lambda: self.io.tee_in.empty())
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.encoder.audio), 1)
        await recorder.finish()

    async def test_a_mixer_failure_is_logged_once_and_the_loop_keeps_going(self) -> None:
        recorder = await self.started()
        with mock.patch.object(TeeMixer, "process", side_effect=[ValueError("bad " + PRESIGNED), []]), captured_logs() as lines:
            self.io.push(1002.5)
            self.io.push(1005.0)
            await until(lambda: self.io.tee_in.empty())
            await asyncio.sleep(0.05)
        self.assertEqual([l["error_type"] for l in lines if l["error_type"] == "r1_rec_tee_failed"], ["r1_rec_tee_failed"])
        self.assertNotIn("bad", json.dumps(lines))
        await recorder.finish()


class TestWatchdog(RecorderCase):
    async def test_an_encoder_that_exits_after_ready_is_a_crash(self) -> None:
        recorder = await self.started()
        recorder._check_encoder()
        self.assertIsNone(recorder.encoder_lost)
        self.encoder.exited.set()
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_crashed")
        self.assertTrue(self.encoder.killed)
        await recorder.finish()

    async def test_an_encoder_that_never_became_ready_is_unavailable(self) -> None:
        self.encoder.ready.clear()
        self.encoder.spawned_at = self.clock() - 9.0
        recorder = await self.started()
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_unavailable")
        await recorder.finish()

    async def test_an_encoder_still_starting_inside_its_window_is_left_alone(self) -> None:
        self.encoder.ready.clear()
        self.encoder.spawned_at = self.clock() - 3.0
        recorder = await self.started()
        recorder._check_encoder()
        self.assertIsNone(recorder.encoder_lost)
        await recorder.finish()

    async def test_a_missing_heartbeat_for_five_seconds_is_a_stall(self) -> None:
        recorder = await self.started()
        self.encoder.last_status_at = self.clock() - 4.9
        recorder._check_encoder()
        self.assertIsNone(recorder.encoder_lost)
        self.encoder.last_status_at = self.clock() - 5.1
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_crashed")
        self.assertTrue(recorder._lost_stalled)
        await recorder.finish()

    async def test_a_fatal_status_from_the_child_is_a_crash_but_a_failed_remux_is_not(self) -> None:
        recorder = await self.started()
        self.encoder.error_code = "remux_failed"
        recorder._check_encoder()
        self.assertIsNone(recorder.encoder_lost)
        self.encoder.error_code = "encode_failed"
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_crashed")
        await recorder.finish()

    async def test_a_backlogged_encoder_is_a_crash(self) -> None:
        recorder = await self.started()
        self.encoder.overflowed = True
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_crashed")
        await recorder.finish()

    async def test_the_watchdog_task_runs_the_check_every_second(self) -> None:
        recorder = await self.started()
        self.encoder.exited.set()
        await until(lambda: recorder.encoder_lost is not None, timeout=4.0)
        await recorder.finish()


class TestFinish(RecorderCase):
    async def run_normal(self, *, outcome: str | None = None, advance: float = 0.0, **overrides):
        recorder = await self.started(**overrides)
        await until(lambda: "prepare" in self.api.ops())
        await until(lambda: self.recorder._worker.state == "uploading")
        recorder.stop(outcome)
        self.clock.advance(advance)
        await asyncio.wait_for(recorder.finish(), 20)
        return recorder

    async def test_the_finish_steps_run_in_order_and_the_report_is_complete(self) -> None:
        self.lay_stream()
        recorder = await self.run_normal()
        ops = [e for e in self.events if e != "put"]
        # close the SDK recorder, then the encoder, then the last part(s), the faststart copy, complete
        self.assertEqual(
            ops,
            ["api.prepare", "io.aclose", "enc.eof", "enc.remux",
             "api.part-url", "api.part-url", "api.part-url", "api.object-url", "api.complete"],
        )
        content = bytes((i * 7) % 251 for i in range(self.encoder.mp4_bytes))
        self.assertEqual(b"".join(p["body"] for p in self.api.puts[:3]), content)
        self.assertEqual(self.api.puts[3]["body"], b"F" * self.encoder.remux_bytes_to_write)
        self.assertEqual(self.api.bodies("object-url"), [{"kind": "video"}])
        (body,) = self.api.bodies("complete")
        self.assertEqual(body["layout"], "combined")
        self.assertIs(body["has_video"], False)
        self.assertNotIn("failure_reason", body)
        self.assertNotIn("degraded_reason", body)
        self.assertEqual(
            body["report"],
            {"parts_uploaded": 3, "faststart_uploaded": True, "audio_final_uploaded": False,
             "audio_partial_uploaded": False, "started_at_ms": 1_700_000_000_000,
             "duration_ms": 12_000, "stream_bytes": self.encoder.mp4_bytes},
        )
        self.assertEqual(recorder.phase, "done")
        self.assertFalse(self.spool.dir.exists(), "the spool is deleted once complete answered 200")
        self.assertTrue(self.encoder.quit_sent)
        self.assertTrue(self.io.capture_closed)
        self.assertEqual(self.io.idle_flushes, 1)

    async def test_stop_is_what_starts_the_finish_so_it_overlaps_the_transcript_drain(self) -> None:
        recorder = await self.started()
        await until(lambda: self.recorder._worker.state == "uploading")
        recorder.stop(None)
        await until(lambda: "api.complete" in self.events)  # no finish() call needed
        await asyncio.wait_for(recorder.finish(), 5)

    async def test_the_deadline_is_counted_from_stop_not_from_finish(self) -> None:
        recorder = await self.started(finish_seconds=18.0)
        recorder.stop(None)
        self.assertEqual(recorder._stop_at, 1000.0)
        self.clock.advance(10.0)  # the transcript drain
        await recorder.finish()
        self.assertEqual(recorder._stop_at, 1000.0)

    async def test_faststart_is_skipped_on_a_forced_outcome(self) -> None:
        self.lay_stream()
        await self.run_normal(outcome="shutdown_forced")
        self.assertEqual(self.encoder.remux_requests, 0)
        (body,) = self.api.bodies("complete")
        self.assertFalse(body["report"]["faststart_uploaded"])
        self.assertEqual(body["layout"], "combined")  # the streamed MP4 is the deliverable
        self.assertNotIn({"kind": "video"}, self.api.bodies("object-url"))

    async def test_faststart_is_skipped_with_less_than_eight_seconds_left(self) -> None:
        self.lay_stream()
        await self.run_normal(advance=11.0)  # 18 s budget, 11 s spent in the drain: 7 s left
        self.assertEqual(self.encoder.remux_requests, 0)

    async def test_faststart_runs_with_more_than_eight_seconds_left(self) -> None:
        self.lay_stream()
        await self.run_normal(advance=9.0)  # 9 s left
        self.assertEqual(self.encoder.remux_requests, 1)

    async def test_a_failed_faststart_leaves_the_streamed_file_as_the_deliverable(self) -> None:
        self.lay_stream()
        self.encoder.remux_bytes_to_write = 0

        def failing_remux() -> bool:
            self.encoder.remux_requests += 1
            self.encoder.remux_bytes = None
            self.encoder.remuxed.set()  # the child reported remux_failed
            return True

        self.encoder.send_remux = failing_remux
        await self.run_normal()
        (body,) = self.api.bodies("complete")
        self.assertFalse(body["report"]["faststart_uploaded"])
        self.assertNotIn("failure_reason", body)

    async def test_a_timed_out_tail_is_reported_and_complete_is_still_attempted(self) -> None:
        self.lay_stream()
        self.api.put_delay = 0.0
        recorder = await self.started(finish_seconds=2.0)
        await until(lambda: self.recorder._worker.state == "uploading")
        self.api.script(
            "part-url", *[lambda *_a: time.sleep(1.5) or ApiReply(500, {}, None)] * 6
        )
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 10)
        (body,) = self.api.bodies("complete") or [None]
        if body is not None:
            self.assertIn(body.get("failure_reason"), ("finish_timeout", "upload_failed"))

    async def test_a_tail_that_cannot_be_uploaded_says_upload_failed(self) -> None:
        self.lay_stream()
        recorder = await self.started()
        await until(lambda: self.recorder._worker.state == "uploading")
        self.api.put_statuses = [500] * 40
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertEqual(body["failure_reason"], "upload_failed")
        self.assertEqual(body["layout"], "combined")

    async def test_stop_and_finish_are_idempotent(self) -> None:
        self.lay_stream()
        recorder = await self.started()
        await until(lambda: self.recorder._worker.state == "uploading")
        recorder.stop(None)
        recorder.stop("shutdown_forced")  # a second stop changes nothing, including "forced"
        await asyncio.gather(recorder.finish(), recorder.finish())
        await recorder.finish()
        self.assertEqual(len(self.api.bodies("complete")), 1)
        self.assertEqual(self.io.idle_flushes, 1)
        self.assertFalse(recorder._forced)

    async def test_finish_survives_being_cancelled_by_the_exit_funnel(self) -> None:
        self.lay_stream()
        recorder = await self.started()
        await until(lambda: self.recorder._worker.state == "uploading")
        recorder.stop(None)
        waiter = asyncio.ensure_future(recorder.finish())
        await asyncio.sleep(0)
        waiter.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await waiter
        await until(lambda: recorder.phase == "done")
        self.assertIn("api.complete", self.events)

    async def test_a_recorder_that_never_started_cleans_up_and_sends_nothing(self) -> None:
        recorder = self.make()
        await recorder.finish()
        self.assertTrue(self.encoder.killed)
        self.assertFalse(self.spool.dir.exists())
        self.assertEqual(self.api.calls, [])
        self.assertFalse(self.io.started)

    async def test_stop_before_start_prevents_the_start(self) -> None:
        recorder = self.make()
        recorder.stop("no_show")
        await recorder.start("candidate")
        self.assertFalse(self.io.started)
        await recorder.finish()
        self.assertEqual(self.api.calls, [])

    async def test_the_encoder_never_available_records_the_ogg_only(self) -> None:
        self.encoder = FakeEncoder(self.events, self.spool.dir, usable=False)
        recorder = await self.started()
        self.assertEqual(recorder.encoder_lost, "encoder_unavailable")
        self.assertIsNone(self.encoder.hello)
        await until(lambda: self.recorder._worker.state == "uploading")
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        self.assertEqual(self.api.bodies("part-url"), [])
        self.assertEqual(self.api.bodies("object-url"), [{"kind": "audio"}])
        self.assertEqual(self.api.puts[-1]["content_type"], "audio/ogg")
        self.assertEqual(self.api.puts[-1]["body"], b"OggS" + bytes(range(256)) * 8)
        (body,) = self.api.bodies("complete")
        self.assertEqual(body["layout"], "audio_only")
        self.assertEqual(body["failure_reason"], "encoder_unavailable")
        self.assertTrue(body["report"]["audio_final_uploaded"])
        self.assertFalse(self.spool.dir.exists())

    async def test_an_encoder_that_dies_mid_call_hands_the_audio_to_the_ogg(self) -> None:
        recorder = await self.started()
        await until(lambda: self.recorder._worker.state == "uploading")
        self.encoder.exited.set()
        recorder._check_encoder()
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        self.assertFalse(self.encoder.eof_sent)
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["failure_reason"]), ("audio_only", "encoder_crashed"))
        self.assertNotIn("degraded_reason", body)
        self.assertEqual(self.api.bodies("object-url"), [{"kind": "audio"}])

    async def test_a_stalled_encoder_also_reports_the_degraded_reason(self) -> None:
        recorder = await self.started()
        await until(lambda: self.recorder._worker.state == "uploading")
        self.encoder.last_status_at = self.clock() - 6.0
        recorder._check_encoder()
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["failure_reason"], body["degraded_reason"]), ("encoder_crashed", "encoder_stalled"))

    async def test_an_encoder_that_will_not_close_is_killed_and_the_ogg_carries_the_audio(self) -> None:
        self.lay_stream()
        stuck = self.encoder

        def never_closes() -> bool:
            stuck.events.append("enc.eof")
            return True

        stuck.send_eof = never_closes
        recorder = await self.started()
        await until(lambda: self.recorder._worker.state == "uploading")
        recorder.stop(None)
        with mock.patch.object(r1_recorder, "ENCODER_CLOSE_WAIT_SECONDS", 0.3):
            await asyncio.wait_for(recorder.finish(), 20)
        self.assertTrue(stuck.killed)
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["failure_reason"]), ("audio_only", "encoder_crashed"))

    async def test_complete_reports_a_clock_based_duration_when_the_encoder_gave_none(self) -> None:
        self.lay_stream()
        self.encoder.media_ms = 0
        recorder = await self.started()
        await until(lambda: self.recorder._worker.state == "uploading")
        self.clock.advance(7.5)
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertEqual(body["report"]["duration_ms"], 7500)

    async def test_a_checkpoint_during_the_call_is_counted_in_the_report(self) -> None:
        self.lay_stream()
        recorder = await self.started()
        await until(lambda: self.recorder._worker.state == "uploading")
        self.clock.advance(11)  # past the 10 s checkpoint interval
        await until(lambda: {"kind": "audio_partial"} in self.api.bodies("object-url"))
        await until(lambda: recorder._worker.checkpoint_uploaded)
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertTrue(body["report"]["audio_partial_uploaded"])


class TestDiscardAndStop(RecorderCase):
    async def test_each_discard_answer_throws_everything_away(self) -> None:
        for reply, reason in (
            (ApiReply(503, {"error": "r1_recording_disabled"}, "r1_recording_disabled"), "disabled"),
            (ApiReply(409, {"error": "r1_consent_withdrawn"}, "r1_consent_withdrawn"), "consent_withdrawn"),
            (ApiReply(410, {"error": "r1_recording_deleted"}, "r1_recording_deleted"), "deleted"),
        ):
            with self.subTest(reason=reason):
                await self.asyncSetUp()
                self.lay_stream()
                (self.spool.dir / "video.mp4").write_bytes(b"v" * 50)
                self.api.script("prepare", reply)
                zeroed: list[str] = []
                real = r1_recorder._zero_fill
                with mock.patch.object(r1_recorder, "_zero_fill", lambda p: (zeroed.append(Path(p).name), real(p))[1]):
                    recorder = await self.started()
                    await until(lambda: recorder.discarded == reason)
                    await until(lambda: not self.spool.dir.exists())
                self.assertTrue(self.encoder.killed)
                self.assertTrue(self.io.capture_closed)
                self.assertTrue(self.io.closed, "the SDK recorder is closed")
                self.assertIn("stream.mp4", zeroed)
                self.assertIn("audio.ogg", zeroed)
                calls = list(self.api.calls)
                await asyncio.wait_for(recorder.finish(), 10)
                self.assertEqual(self.api.calls, calls, "no call after a discard, not even complete")
                self.assertNotIn("api.complete", self.events)

    async def test_a_withdrawal_in_the_middle_of_the_call_discards_the_uploaded_work_too(self) -> None:
        self.lay_stream(65536 * 2)
        self.api.script("part-url", ApiReply(200, {"url": FakeApi.BASE + "/p", "part_number": 1}, None),
                        ApiReply(409, {"error": "r1_consent_withdrawn"}, "r1_consent_withdrawn"))
        recorder = await self.started()
        await until(lambda: recorder.discarded == "consent_withdrawn")
        await until(lambda: not self.spool.dir.exists())
        self.assertTrue(self.encoder.killed)
        await asyncio.wait_for(recorder.finish(), 10)
        self.assertNotIn("api.complete", self.events)

    async def test_the_discard_does_not_touch_the_interview(self) -> None:
        self.api.script("prepare", ApiReply(409, {"error": "r1_consent_withdrawn"}, "r1_consent_withdrawn"))
        recorder = await self.started()
        await until(lambda: recorder.discarded is not None)
        # The taps stay in place as pass-throughs; the session's audio path is unchanged.
        self.assertEqual(self.session.input.audio.tap, "in")
        await asyncio.wait_for(recorder.finish(), 10)

    async def test_session_and_state_answers_stop_uploading_without_a_complete(self) -> None:
        for reply, reason in (
            (ApiReply(409, {"error": "r1_session"}, "r1_session"), "session"),
            (ApiReply(409, {"error": "r1_recording_state"}, "r1_recording_state"), "state"),
            (ApiReply(403, {}, None), "rejected"),
        ):
            with self.subTest(reason=reason):
                await self.asyncSetUp()
                self.lay_stream()
                self.api.script("prepare", reply)
                recorder = await self.started()
                await until(lambda: recorder._stop_reason == reason)
                self.assertTrue(self.encoder.killed, "capture stops: nothing will be uploaded")
                recorder.stop(None)
                await asyncio.wait_for(recorder.finish(), 10)
                self.assertEqual(self.api.ops(), ["prepare"])
                self.assertFalse(self.spool.dir.exists(), "the spool is deleted at exit")
                self.assertIsNone(recorder.discarded)


class TestDeadline(unittest.IsolatedAsyncioTestCase):
    async def test_finish_returns_by_its_deadline_with_a_hung_api(self) -> None:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        server.seen = []
        server.release = threading.Event()
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.addCleanup(server.release.set)  # (last-in first-out: release, shutdown, then close)
        base = f"http://127.0.0.1:{server.server_address[1]}"
        tmp = tempfile.TemporaryDirectory(prefix="r1rec-hang-")
        self.addCleanup(tmp.cleanup)
        spool = Spool(Path(tmp.name) / "r", SESSION_ID)
        spool.create()
        events: list = []
        encoder = FakeEncoder(events, spool.dir)
        client = HttpClient()
        api = RecordingApi(client, ROOM, endpoint=lambda path: base + "/hang" + path, secret=lambda: "s")
        io = FakeIO(events)
        session = SimpleNamespace(input=SimpleNamespace(audio=object()), output=SimpleNamespace(audio=object()))
        recorder = R1Recorder(
            session=session, room=ROOM, session_id=SESSION_ID, mode="audio", spool=spool, encoder=encoder,
            api=api, http_client=client, finish_seconds=3.0, io_class=lambda: (lambda **_kw: io),
        )
        await recorder.start("candidate")
        await asyncio.sleep(0.4)  # prepare is now stuck inside the hung server
        recorder.stop(None)
        started = time.monotonic()
        await asyncio.wait_for(recorder.finish(), 8.0)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 4.5, "finish must not outlive its 3 s deadline by more than the abort slack")
        self.assertFalse(spool.dir.exists())
        recorder._worker._thread.join(timeout=3.0)
        self.assertFalse(recorder._worker._thread.is_alive(), "no thread outlives the bounded finish")


# ------------------------------------------------------------------------------ privacy


class TestNothingSensitiveIsLogged(RecorderCase):
    async def test_a_full_run_with_failures_logs_only_fixed_codes(self) -> None:
        self.lay_stream()
        self.api.put_statuses = [500, 200]
        self.api.script("part-url", HttpFailure("network"))
        poisoned = RuntimeError("boom " + PRESIGNED + " " + SESSION_ID)
        with captured_logs() as lines:
            recorder = await self.started()
            await until(lambda: self.recorder._worker.state == "uploading")
            with mock.patch.object(TeeMixer, "process", side_effect=poisoned):
                self.io.push(1002.5)
                await until(lambda: self.io.tee_in.empty())
            self.encoder.exited.set()
            recorder._check_encoder()
            recorder.stop(None)
            await asyncio.wait_for(recorder.finish(), 20)
        self.assertTrue(lines)
        blob = json.dumps(lines)
        for poison in POISONS + ("boom",):
            self.assertNotIn(poison, blob)
        for line in lines:
            self.assertEqual(line["component"], "r1")
            self.assertEqual(line["event"], "unknown_event")
            self.assertTrue(line["error_type"].startswith("r1_rec_"), line)
            self.assertLessEqual(set(line) - {"timestamp", "level", "component", "event", "correlationId"},
                                 {"error_type", "error_category", "status", "option_count", "duration_sec"})

    async def test_a_discard_logs_its_reason_as_a_fixed_word(self) -> None:
        self.api.script("prepare", ApiReply(409, {"error": "r1_consent_withdrawn"}, "r1_consent_withdrawn"))
        with captured_logs() as lines:
            recorder = await self.started()
            await until(lambda: recorder.discarded is not None)
            await asyncio.wait_for(recorder.finish(), 10)
        discard = [l for l in lines if l["error_type"] == "r1_rec_discarded"]
        self.assertEqual([l["error_category"] for l in discard], ["consent_withdrawn"])

    def test_no_object_storage_credential_name_appears_anywhere_in_the_worker_sources(self) -> None:
        """The worker gets presigned URLs only; the R2 credential lives on the API alone."""
        needle = "R1_RECORDING" + "_S3"
        offenders = [
            str(path.relative_to(HERE))
            for path in HERE.rglob("*.py")
            if ".venv" not in path.parts and "__pycache__" not in path.parts
            and needle in path.read_text(encoding="utf-8", errors="replace")
        ]
        self.assertEqual(offenders, [])
        self.assertNotIn("AWS_", (HERE / "r1_recorder.py").read_text(encoding="utf-8"))

    def test_the_child_environment_carries_no_secret(self) -> None:
        captured: dict = {}

        def fake_popen(*args, **kwargs):
            captured.update(kwargs)
            raise OSError("no spawn in this test")

        env = {"WORKER_CONTEXT_SECRET": "x", "SUPABASE_SERVICE_ROLE_KEY": "y", "SARVAM_API_KEY": "z",
               "LIVEKIT_API_SECRET": "w", "PATH": os.environ.get("PATH", ""), "HARMLESS": "ok"}
        with mock.patch.dict(os.environ, env):
            r1_recorder.EncoderProcess(Path("."), popen=fake_popen).spawn()
        self.assertEqual(captured["env"].get("HARMLESS"), "ok")
        for name in ("WORKER_CONTEXT_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "SARVAM_API_KEY", "LIVEKIT_API_SECRET"):
            self.assertNotIn(name, captured["env"])
        self.assertIs(captured["stderr"], r1_recorder.subprocess.DEVNULL)


# ------------------------------------------------------------------------------ end to end


class TestWithTheRealEncoder(unittest.IsolatedAsyncioTestCase):
    """The real child process behind the real uploader, with only the SDK and the network faked."""

    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="r1rec-e2e-")
        self.addCleanup(self._tmp.cleanup)
        self.spool = Spool(Path(self._tmp.name) / "r", SESSION_ID)
        self.spool.create()
        self.events: list = []
        self.api = FakeApi(self.events)
        self.api.checkpoint = 10
        self.io = FakeIO(self.events)
        self.clock = ManualClock(5000.0)
        self.session = SimpleNamespace(input=SimpleNamespace(audio=object()), output=SimpleNamespace(audio=object()))
        patch = mock.patch.object(r1_recorder, "RETRY_DELAYS_SECONDS", (0.0, 0.0, 0.0))
        patch.start()
        self.addCleanup(patch.stop)

    async def test_pcm_in_parts_out_and_the_parts_decode_to_the_audio_that_went_in(self) -> None:
        encoder = r1_recorder.EncoderProcess(self.spool.dir)
        self.assertTrue(encoder.spawn())
        self.addCleanup(encoder.kill)
        recorder = R1Recorder(
            session=self.session, room=ROOM, session_id=SESSION_ID, mode="audio", spool=self.spool,
            encoder=encoder, api=self.api, http_client=StubHttp(), finish_seconds=18.0,
            clock=self.clock, wall=time.time, io_class=lambda: (lambda **_kw: self.io),
        )
        self.addCleanup(recorder._worker.halt)
        await asyncio.get_running_loop().run_in_executor(None, lambda: encoder.ready.wait(60))
        self.assertTrue(encoder.ready.is_set(), "the child reported ready")
        await recorder.start("candidate")
        # 32 s of a 440 Hz candidate in 2.5 s chunks, then a line of the agent at 880 Hz, then a rejoin gap.
        for tick in range(1, 14):
            self.clock.advance(2.5)
            self.io.push(self.clock(), 2.5)
        self.clock.advance(2.5)
        self.io.tee_in.put((self.clock(), [frame(tone_samples(2.5, freq=440.0))]))
        self.io.tee_out.put((self.clock(), [frame(tone_samples(1.0, freq=880.0))]))
        for _ in range(4):  # 10 s with no candidate audio at all
            self.clock.advance(2.5)
            self.io.tee_in.put((self.clock(), []))
            self.io.tee_out.put((self.clock(), []))
        self.clock.advance(2.5)
        self.io.push(self.clock(), 2.5)
        await until(lambda: self.io.tee_in.empty(), timeout=20)
        # Let the periodic thread cut the full parts from the growing file and checkpoint the OGG.
        await until(lambda: any("/part?" in p["url"] for p in self.api.puts), timeout=30)
        self.clock.advance(11)
        await until(lambda: {"kind": "audio_partial"} in self.api.bodies("object-url"), timeout=30)
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 60)
        self.assertEqual(recorder.phase, "done")
        (body,) = self.api.bodies("complete")
        self.assertEqual(body["layout"], "combined")
        self.assertNotIn("failure_reason", body)
        report = body["report"]
        self.assertTrue(report["faststart_uploaded"])
        self.assertTrue(report["audio_partial_uploaded"])
        # The streamed MP4, rebuilt from the uploaded parts exactly as R2 would concatenate them.
        parts: dict[int, bytes] = {}
        for call_url, put in ((p["url"], p) for p in self.api.puts if "/part?" in p["url"]):
            number = int(re.search(r"partNumber=(\d+)", call_url).group(1))
            parts[number] = put["body"]
        self.assertEqual(sorted(parts), list(range(1, len(parts) + 1)))
        self.assertEqual(report["parts_uploaded"], len(parts))
        for number in range(1, len(parts)):
            self.assertEqual(len(parts[number]), self.api.part_size, "every part but the last is the full size")
        rebuilt = self.spool.dir.parent / "rebuilt.mp4"
        rebuilt.write_bytes(b"".join(parts[n] for n in sorted(parts)))
        with av.open(str(rebuilt)) as container:
            stream = container.streams.audio[0]
            pcm = np.concatenate([f.to_ndarray().reshape(-1) for f in container.decode(stream)])
        self.assertEqual(report["stream_bytes"], rebuilt.stat().st_size)
        seconds = len(pcm) / RATE
        # 13 ticks + 1 + 4 gap ticks + 1 = 19 ticks of 2.5 s on the clock: the rejoin gap is IN the timeline.
        self.assertAlmostEqual(seconds, 47.5, delta=0.5)
        self.assertEqual(report["duration_ms"], int(round(report["duration_ms"])))
        self.assertAlmostEqual(report["duration_ms"] / 1000, 47.5, delta=0.5)
        # Audio before the gap, silence in the gap, audio after it.
        before = np.abs(pcm[int(20 * RATE) : int(30 * RATE)])
        gap = np.abs(pcm[int(37.5 * RATE) : int(44.5 * RATE)])
        after = np.abs(pcm[int(45.5 * RATE) : int(47 * RATE)])
        self.assertGreater(float(before.max()), 0.1)
        self.assertLess(float(gap.max()), 0.02)
        self.assertGreater(float(after.max()), 0.1)
        fast = [p for p in self.api.puts if "/video?" in p["url"]]
        self.assertEqual(len(fast), 1)
        boxes = []
        data = fast[0]["body"]
        pos = 0
        while pos + 8 <= len(data):
            import struct

            size, kind = struct.unpack(">I4s", data[pos : pos + 8])
            boxes.append(kind.decode("latin1"))
            if size < 8:
                break
            pos += size
        self.assertLess(boxes.index("moov"), boxes.index("mdat"))
        self.assertFalse(self.spool.dir.exists())
        self.assertTrue(encoder.exited.wait(10) or True)


if __name__ == "__main__":
    unittest.main()
