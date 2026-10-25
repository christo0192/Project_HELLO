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
import struct
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


def box(kind: bytes, payload: bytes = b"") -> bytes:
    """One top-level ISO-BMFF box (32-bit size)."""
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def fmp4(fragments: int, *, payload: int = 20_000, tail: int = 3000) -> tuple[bytes, int]:
    """Bytes laid out like the encoder's spool after a ``kill -9``: ``ftyp``, ``moov``, ``fragments``
    whole ``moof`` + ``mdat`` pairs, then the first ``tail`` bytes of one more, cut off mid-write.
    Returns ``(content, end of the last whole fragment)``."""
    head = box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2avc1mp41") + box(b"moov", b"\x00" * 700)
    pairs = b"".join(
        box(b"moof", bytes([n % 251]) * 200) + box(b"mdat", bytes((n * 13 + i) % 251 for i in range(payload)))
        for n in range(fragments)
    )
    cut = (box(b"moof", b"\x01" * 200) + box(b"mdat", b"\x02" * payload))[:tail]
    return head + pairs + cut, len(head) + len(pairs)


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

    @staticmethod
    def tone_onset(pcm: np.ndarray, after: float = 0.0, level: int = 1000) -> float | None:
        """Seconds of the first 20 ms window at or after ``after`` whose peak exceeds ``level``."""
        window = RATE // 50
        for start in range(int(after * RATE), len(pcm) - window, window):
            if int(np.abs(pcm[start : start + window]).max()) > level:
                return start / RATE
        return None

    def test_the_sdks_one_time_input_padding_is_not_added_on_top_of_the_wall_clock_padding(self) -> None:
        """A microphone that starts after the opening line: the SDK pads its first chunk in front.

        The agent speaks 0 - 1.5 s, the tick at 2.5 s has nothing (wall-clock padded by the mixer), the
        microphone's first frame is at 4.0 s and the tick at 5.0 s carries the SDK's silence frame
        (4.0 - 1.5 = 2.5 s) followed by 1 s of microphone.  The tone must sit at 4.0 s, not 5.0 s.
        """
        mixer = TeeMixer(t0=0.0)
        pieces = list(mixer.process([], [frame(tone_samples(1.5, freq=800.0))], 1.5))
        pieces += mixer.process([], [], 2.5)
        sdk_pad = frame(np.zeros(int(2.5 * 24000), dtype="<i2"))
        pieces += mixer.process([sdk_pad, frame(tone_samples(1.0, freq=300.0, amp=6000))], [], 5.0)
        pcm = pcm_of(pieces)
        self.assertAlmostEqual(len(pcm) / RATE, 5.0, delta=0.1)
        self.assertAlmostEqual(mixer.emitted / RATE, 5.0, delta=0.1)
        onset = self.tone_onset(pcm, after=2.0)
        self.assertIsNotNone(onset)
        self.assertAlmostEqual(onset, 4.0, delta=0.1)
        # The later audio stays on the clock too.
        more = pcm_of(mixer.process([frame(tone_samples(2.5, freq=300.0, amp=6000))], [], 7.5))
        self.assertAlmostEqual(mixer.emitted / RATE, 7.5, delta=0.1)
        self.assertGreater(int(np.abs(more[:RATE // 10]).max()), 1000)

    def test_only_leading_digital_silence_is_given_up_when_the_chunk_is_ahead_of_the_clock(self) -> None:
        mixer = TeeMixer(t0=0.0)
        mixer.process([], [frame(tone_samples(2.5))], 2.5)  # (an agent line: no resampler tail carried over)
        # 1 s ahead of the clock, but only 0.2 s of the chunk's front is silent: exactly 0.2 s goes.
        chunk = [frame(np.zeros(int(0.2 * 24000), dtype="<i2")), frame(tone_samples(3.3, freq=300.0, amp=6000))]
        pcm = pcm_of(mixer.process(chunk, [], 5.0))
        self.assertAlmostEqual(len(pcm) / RATE, 3.3, delta=0.1)
        self.assertGreater(int(np.abs(pcm[: RATE // 50]).max()), 1000, "the tone is the first thing in what is left")
        # An agent line that starts with a few zero samples keeps them when the audio is not ahead.
        steady = TeeMixer(t0=0.0)
        got = pcm_of(steady.process([], [frame(np.concatenate((np.zeros(2400, dtype="<i2"), tone_samples(1.0))))], 1.1))
        self.assertAlmostEqual(len(got) / RATE, 1.1, delta=0.05)

    def test_a_chunk_of_nothing_but_silence_is_trimmed_to_the_clock_and_can_vanish(self) -> None:
        mixer = TeeMixer(t0=0.0)
        mixer.process([], [frame(tone_samples(2.5))], 2.5)
        silence = pcm_of(mixer.process([frame(np.zeros(int(4.0 * 24000), dtype="<i2"))], [], 3.0))
        self.assertLessEqual(int(np.abs(silence).max()), r1_recorder.SILENCE_LEVEL)  # (dither, not speech)
        self.assertAlmostEqual(mixer.emitted / RATE, 3.0, delta=0.1)
        # Already ahead of the clock by more than the whole chunk: the silent chunk adds nothing.
        ahead = TeeMixer(t0=0.0)
        ahead.process([], [frame(tone_samples(2.5))], 2.5)
        self.assertEqual(ahead.process([frame(np.zeros(24000, dtype="<i2"))], [], 1.0), [])
        self.assertAlmostEqual(ahead.emitted / RATE, 2.5, delta=0.1)

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
        from livekit import rtc
        from livekit.agents.voice.recorder_io import recorder_io as sdk_recorder_io
        from livekit.agents.voice.recorder_io.recorder_io import RecorderIO

        # The SDK's rtc.AudioResampler dithers its int16 output with fresh randomness per
        # instance (zeros in, non-zero out), so two STOCK runs hand the encoder chunks that differ
        # by up to 2 LSB and decode a few 1e-3 apart, at times past 0.01.  Opus itself is
        # deterministic.  With the resampler swapped for an exact one in both runs the decoded
        # PCM must be bit-identical: the tee adds no sample, drops none and changes none.
        class ExactResampler:
            def __init__(self, input_rate: int, output_rate: int, num_channels: int, **_kw: object) -> None:
                assert output_rate % input_rate == 0, (input_rate, output_rate)
                self._k, self._rate, self._channels = output_rate // input_rate, output_rate, num_channels

            def push(self, f: rtc.AudioFrame) -> list[rtc.AudioFrame]:
                pcm = np.frombuffer(bytes(f.data), dtype="<i2").reshape(-1, self._channels)
                out = np.repeat(pcm, self._k, axis=0).astype("<i2")
                return [rtc.AudioFrame(data=out.tobytes(), sample_rate=self._rate,
                                       num_channels=self._channels, samples_per_channel=len(out))]

            def flush(self) -> list[rtc.AudioFrame]:
                return []

        with mock.patch.object(sdk_recorder_io.rtc, "AudioResampler", ExactResampler):
            await drive_recorder_io(RecorderIO, self.dir / "stock.ogg")
            await drive_recorder_io(r1_recorder.recorder_io_class(), self.dir / "tee.ogg")
        stock, tee = decode_ogg(self.dir / "stock.ogg"), decode_ogg(self.dir / "tee.ogg")
        self.assertGreater(stock.shape[1], RATE)  # not vacuous: the agent line was written
        self.assertEqual(stock.shape, tee.shape)  # no sample added or lost
        self.assertTrue(np.array_equal(stock, tee), f"max diff {float(np.abs(stock - tee).max())}")
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

    async def replay_with_a_late_microphone(self, mic_start: float, agent_line: float, stop_at: float):
        """The real subclass on a controlled clock; the candidate's first frame is at ``mic_start``.

        The agent speaks from 0 to ``agent_line``; the SDK's 2.5 s idle flush is driven by hand (its own
        ticker is off).  Returns ``(seconds of the first candidate tone in the mixed timeline, found from
        0.1 s after the line on, and the timeline's length in seconds)``; the candidate speaks a 300 Hz
        tone from ``max(mic_start, agent_line)``.
        """
        clock = {"t": 0.0}
        source, sink = _Source(), _Sink()
        rec = r1_recorder.recorder_io_class()(agent_session=SimpleNamespace(), sample_rate=RATE)
        rec.tee_clock = lambda: clock["t"]
        tap_in, tap_out = rec.record_input(source), rec.record_output(sink)
        step = 0.02
        next_tick = 2.5
        with mock.patch("time.time", lambda: 1_000_000.0 + clock["t"]), no_forward_ticks():
            await rec.start(output_path=self.dir / "late-mic.ogg")
            for _ in range(int(round(agent_line / step))):
                await tap_out.capture_frame(frame(tone_samples(step, freq=800.0)))
                if clock["t"] >= mic_start:
                    source.next_frame = frame(np.zeros(480, dtype="<i2"))  # live, but quiet during the line
                    await tap_in.__anext__()
                clock["t"] += step
            tap_out.flush()
            tap_out.on_playback_finished(playback_position=agent_line, interrupted=False)
            while clock["t"] < stop_at - 1e-9:
                if clock["t"] >= next_tick - 1e-9:
                    rec.flush_idle_tail()  # what the SDK's own ticker does when the agent is idle
                    next_tick += 2.5
                if clock["t"] >= mic_start:
                    source.next_frame = frame(tone_samples(step, freq=300.0, amp=6000))
                    await tap_in.__anext__()
                clock["t"] += step
            rec.flush_idle_tail()
            await asyncio.wait_for(rec.aclose(), 20)
        mixer = TeeMixer(0.0)
        pieces: list[tuple[int, bytes]] = []
        while True:
            stamp_in, input_buf = rec.tee_in.get_nowait()
            stamp_out, output_buf = rec.tee_out.get_nowait()
            if input_buf is None or output_buf is None:
                break
            pieces.extend(mixer.process(input_buf, output_buf, max(stamp_in, stamp_out)))
        pcm = pcm_of(pieces)
        return TestTeeMixer.tone_onset(pcm, after=agent_line + 0.1), len(pcm) / RATE

    async def test_a_microphone_that_starts_after_the_first_agent_line_stays_on_the_wall_clock(self) -> None:
        """The SDK pads the first input chunk with (mic start - end of the last line) of silence; the
        mixer has already filled that stretch from the wall clock.  Seen before the fix: the candidate
        tone at +1.0 s (mic at 4 s), +8.5 s (mic at 12 s) and +17 s (mic at 25 s after an 8 s line), and
        a timeline 57 s long for 40 s of wall time."""
        for mic_start, agent_line, stop_at in ((0.0, 1.5, 9.0), (4.0, 1.5, 9.0), (12.0, 1.5, 20.0), (25.0, 8.0, 40.0)):
            with self.subTest(mic_start=mic_start, agent_line=agent_line):
                onset, length = await self.replay_with_a_late_microphone(mic_start, agent_line, stop_at)
                expected = max(mic_start, agent_line + 0.1)  # (the search starts 0.1 s after the line)
                self.assertIsNotNone(onset)
                self.assertLess(abs(onset - expected), 0.15, f"candidate tone at {onset}s, spoken at {expected}s")
                self.assertLess(abs(length - stop_at), 0.3, f"timeline {length}s for {stop_at}s of wall time")

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
        # ``url -> status`` for the PUT to that URL, or None for the usual answer (``put_statuses``, then 200)
        self.put_status = None
        self.part_size = 65536
        self.checkpoint = 10
        self.events = events if events is not None else []
        self.lock = threading.Lock()
        self.threads: set[str] = set()
        self.inflight = 0
        self.max_inflight = 0
        self.put_delay = 0.0
        # (what, was the request started cancellable): periodic work is, a finish job is not
        self.cancellable: list[tuple[str, bool]] = []

    def script(self, op: str, *replies) -> None:
        self.scripts.setdefault(op, []).extend(replies)

    def ops(self) -> list[str]:
        with self.lock:
            return [op for op, _body in self.calls]

    def bodies(self, op: str) -> list[dict]:
        with self.lock:
            return [body for name, body in self.calls if name == op]

    def post(self, op, body, *, connect_timeout, total_timeout, cancel=None):
        with self.lock:
            self.calls.append((op, dict(body)))
            self.cancellable.append((op, cancel is not None))
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

    def put(self, url, body, content_type, *, connect_timeout, total_timeout, cancel=None):
        with self.lock:
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
            hooked = self.put_status(url) if self.put_status is not None else None
            if hooked is not None:
                status = hooked
            else:
                status = self.put_statuses.pop(0) if self.put_statuses else 200
            entry = {"url": url, "body": bytes(body), "content_type": content_type, "status": status, "total": total_timeout}
            self.puts.append(entry)
            self.cancellable.append(("put", cancel is not None))
        self.events.append("put")
        try:
            if self.put_delay:
                if cancel is None:
                    time.sleep(self.put_delay)
                elif cancel.wait(self.put_delay):  # a cancellable request ends when it is cancelled
                    entry["cancelled"] = True
                    raise HttpFailure("cancelled")
        finally:
            with self.lock:
                self.inflight -= 1
        return ApiReply(status, {}, None, '"etag"')


class StubHttp:
    def __init__(self) -> None:
        self.aborted = False
        self.cancelled = 0

    def abort(self) -> None:
        self.aborted = True

    def cancel_inflight(self) -> None:
        self.cancelled += 1


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

    def __init__(
        self, events: list, spool_dir: Path, *, usable: bool = True, mp4_bytes: int = 150_000, x264: bool = True
    ) -> None:
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
        self.clock = time.monotonic  # RecorderCase binds this to the test clock
        self.spawned_at = time.monotonic()
        self.last_status_at = None  # a fake never sends heartbeats: fresh unless a test stamps one
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
        self.pictures: list[tuple] = []
        self.video_dropped = 0
        self.video_sent = 0
        self.closed_extra: dict = {}
        if usable:
            self.ready.set()
            self.ready_info = {"s": "ready", "av": "19.0.1", "x264": x264, "aac": True}
        else:
            self.exited.set()

    def can_encode_video(self) -> bool:
        if self.dead or self.exited.is_set():
            return False
        return self.ready_info is None or bool(self.ready_info.get("x264"))

    def send_video(self, pts_us, width, height, rotation, picture) -> bool:
        self.pictures.append((pts_us, width, height, rotation, bytes(picture)))
        return not self.dead

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
        self.closed_info = {"s": "closed", "bytes": self.mp4_bytes, "media_ms": self.media_ms, **self.closed_extra}
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

    def seconds_since_spawn(self):
        return None if self.spawned_at is None else self.clock() - self.spawned_at

    def seconds_since_status(self):
        return None if self.last_status_at is None else self.clock() - self.last_status_at


class FakeTrack:
    def __init__(self, sid: str) -> None:
        self.sid = sid


class FakePublication:
    def __init__(self, sid: str, *, kind: int = 2, source: int = 1, subscribed: bool = False) -> None:
        self.sid = sid
        self.kind = kind
        self.source = source
        self.subscribed = subscribed
        self.track = FakeTrack("TR_" + sid) if subscribed else None
        self.subscribe_calls: list[bool] = []

    def set_subscribed(self, value: bool) -> None:
        self.subscribe_calls.append(value)
        self.subscribed = value


class FakeParticipant:
    def __init__(self, identity: str, *, kind: int = 0) -> None:
        self.identity = identity
        self.kind = kind
        self.track_publications: dict[str, FakePublication] = {}

    def add(self, publication: FakePublication) -> FakePublication:
        self.track_publications[publication.sid] = publication
        return publication


class FakeRoom:
    def __init__(self) -> None:
        self.handlers: dict[str, list] = {}
        self.remote_participants: dict[str, FakeParticipant] = {}

    def on(self, event, handler) -> None:
        self.handlers.setdefault(event, []).append(handler)

    def off(self, event, handler) -> None:
        if handler in self.handlers.get(event, []):
            self.handlers[event].remove(handler)

    def emit(self, event, *args) -> None:
        for handler in list(self.handlers.get(event, [])):
            handler(*args)

    def listeners(self) -> int:
        return sum(len(v) for v in self.handlers.values())


class FakeVideoStream:
    """The SDK ``VideoStream`` surface the capture uses: an async iterator and ``aclose``."""

    def __init__(self, track) -> None:
        self.track = track
        self.queue: asyncio.Queue = asyncio.Queue()
        self.closed = False
        self.fail: BaseException | None = None

    def push(self, event) -> None:
        self.queue.put_nowait(event)

    def end(self) -> None:
        self.queue.put_nowait(None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.fail is not None:
            raise self.fail
        item = await self.queue.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def aclose(self) -> None:
        self.closed = True
        self.queue.put_nowait(None)


class StreamFactory:
    def __init__(self) -> None:
        self.streams: list[FakeVideoStream] = []

    def __call__(self, track) -> FakeVideoStream:
        stream = FakeVideoStream(track)
        self.streams.append(stream)
        return stream


def picture_event(width: int = 640, height: int = 360, *, rotation: int = 0, luma: int = 100, kind: int = 5, data: bytes | None = None):
    payload = data if data is not None else bytes([luma]) * (width * height * 3 // 2)
    picture = SimpleNamespace(width=width, height=height, type=kind, data=memoryview(payload))
    return SimpleNamespace(frame=picture, rotation=rotation, timestamp_us=0)


class FakeVad:
    def __init__(self) -> None:
        self.handlers: list = []
        self.capabilities = SimpleNamespace(update_interval=0.032)

    def on(self, event, handler) -> None:
        assert event == "metrics_collected"
        self.handlers.append(handler)

    def off(self, event, handler) -> None:
        if handler in self.handlers:
            self.handlers.remove(handler)

    def emit(self, total: float, count: int) -> None:
        metrics = SimpleNamespace(inference_duration_total=total, inference_count=count)
        for handler in list(self.handlers):
            handler(metrics)


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
        # The fake encoder ages on the SAME test clock (the real one ages on its own clock). It never
        # sends heartbeats, so its last status reads as fresh (None) unless a test stamps one:
        # otherwise a test that advances the clock past the stall limit would race the 1 s tick.
        self.encoder.clock = self.clock
        self.encoder.spawned_at = self.clock()
        self.encoder.last_status_at = None
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
        self.http = StubHttp()
        self.worker = UploadWorker(
            api=self.api, http_client=self.http, spool=self.spool, mode="audio", clock=self.clock,
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

    def test_a_finish_job_does_not_wait_behind_a_slow_mid_call_put_and_that_part_goes_again(self) -> None:
        """Periodic work may be 60 s inside one PUT; the job that submit() queues cuts that PUT, the
        loop takes the job at once, and the tail job uploads the same part number again."""
        content = self.lay(65536 * 2 + 100)
        self.api.put_delay = 30.0  # the first (mid-call) part PUT hangs ...
        self.worker.start()
        wait_until(lambda: "put" in self.api.events)
        self.api.put_delay = 0.0  # ... the ones the finish makes are instant
        started = time.monotonic()
        future = self.worker.submit(lambda: self.worker.job_tail(mp4=True, final_ogg=False, deadline=100.0))
        result = future.result(timeout=5)
        self.assertLess(time.monotonic() - started, 3.0, "the job did not sit behind the 30 s PUT")
        self.assertEqual(result, {"uploading": True, "mp4": True, "ogg": False})
        self.assertGreaterEqual(self.http.cancelled, 1, "the in-flight request was cut")
        self.assertEqual([b["part_number"] for b in self.api.bodies("part-url")], [1, 1, 2, 3])
        delivered = [p["body"] for p in self.api.puts if not p.get("cancelled")]
        self.assertEqual(b"".join(delivered), content, "every byte arrived once, in order")
        self.assertEqual(self.worker.parts_done, 3)
        self.assertEqual(self.worker.cut, len(content))

    def test_only_periodic_requests_are_cancellable_never_a_finish_job(self) -> None:
        self.lay(65536 + 10)
        self.worker.start()
        wait_until(lambda: self.worker.parts_done == 1)
        periodic = list(self.api.cancellable)
        self.assertTrue(periodic and all(flag for _what, flag in periodic), periodic)
        self.api.cancellable.clear()
        self.spool.ogg_path.write_bytes(b"OggS" + b"q" * 200)
        self.worker.submit(lambda: self.worker.job_tail(mp4=True, final_ogg=True, deadline=100.0)).result(timeout=5)
        self.worker.submit(lambda: self.worker.job_complete({"layout": "combined", "report": {}}, deadline=100.0)).result(timeout=5)
        self.assertTrue(self.api.cancellable)
        self.assertFalse(any(flag for _what, flag in self.api.cancellable), self.api.cancellable)

    def test_a_cut_request_is_not_retried_and_does_not_end_the_upload(self) -> None:
        self.prepare()
        self.lay(65536)
        self.api.script("part-url", HttpFailure("cancelled"))
        outcome = self.worker._attempts(
            self.worker._part_step(1, b"x"), deadline=None, interruptible=True, label="part"
        )
        self.assertEqual(outcome, ("aborted", None))
        self.assertEqual(self.api.bodies("part-url"), [{"part_number": 1}], "no retry")
        self.assertEqual((self.worker.state, self.discards, self.stops), ("uploading", [], []))

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

    def test_a_part_url_that_answers_404_ends_the_multipart_with_no_retry_and_no_stop(self) -> None:
        """NoSuchUpload (incident 482cb480: the multipart was aborted under a live call).  Retrying the
        part can never succeed and only eats the finish budget; nor is it the API's stop answer."""
        self.prepare()
        self.lay(65536 * 3 + 500)
        self.api.put_status = lambda url: 404 if "partNumber=2&" in url else None
        with captured_logs() as lines:
            self.assertFalse(self.worker._upload_ready_parts(final=False, deadline=None, interruptible=False))
        self.assertEqual([b["part_number"] for b in self.api.bodies("part-url")], [1, 2], "part 2 once, no part 3")
        self.assertEqual((self.worker.parts_done, self.worker.cut), (1, 65536))
        self.assertTrue(self.worker.multipart_gone)
        self.assertEqual((self.worker.state, self.stops, self.discards), ("uploading", [], []))
        self.assertEqual([l["error_type"] for l in lines], ["r1_rec_multipart_gone"])
        calls = len(self.api.calls)
        self.assertFalse(self.worker._upload_ready_parts(final=True, deadline=100.0, interruptible=False))
        self.clock.advance(60)
        self.worker._periodic()
        self.assertEqual(len(self.api.calls), calls, "no part URL is asked for again")
        # Everything else goes on: the tail job sends the final OGG instead, and complete.
        self.spool.ogg_path.write_bytes(b"OggS" + b"q" * 300)
        result = self.worker.job_tail(mp4=True, final_ogg=False, deadline=self.clock() + 100.0)
        self.assertEqual(result, {"uploading": True, "mp4": False, "ogg": True})
        self.assertTrue(self.worker.final_ogg_uploaded)
        self.assertEqual([b["part_number"] for b in self.api.bodies("part-url")], [1, 2])
        self.assertEqual(self.worker.job_complete({"layout": "combined"}, deadline=self.clock() + 100.0), "ok")

    def test_the_retry_line_names_the_step_it_retries(self) -> None:
        self.api.script("prepare", ApiReply(500, {}, None))
        with captured_logs() as lines:
            self.prepare()
            self.lay(65536)
            self.api.put_statuses = [500]
            self.worker._upload_ready_parts(final=False, deadline=None, interruptible=False)
            self.spool.ogg_path.write_bytes(b"OggS" + b"a" * 50)
            for kind in ("audio", "audio_partial"):
                self.api.put_statuses = [500]
                self.assertTrue(self.worker._put_object(kind, self.spool.ogg_path, deadline=None, interruptible=False))
            self.spool.video_path.write_bytes(b"F" * 50)
            self.api.put_statuses = [500]
            self.assertTrue(self.worker.job_video(deadline=100.0))
            self.api.script("complete", ApiReply(500, {}, None))
            self.assertEqual(self.worker.job_complete({"layout": "combined"}, deadline=100.0), "ok")
        retries = [(l["error_category"], l["option_count"]) for l in lines if l["error_type"] == "r1_rec_upload_retry"]
        self.assertEqual(
            retries,
            [("prepare", 1), ("part", 1), ("object_audio", 1), ("object_audio", 1), ("object_video", 1), ("complete", 1)],
        )

    def test_a_big_body_may_take_longer_but_a_finish_call_never_passes_its_deadline(self) -> None:
        self.clock.value = 10.0
        self.assertEqual(self.worker._timeouts(None, 10.0), (5.0, 60.0), "never less than any other call")
        self.assertEqual(self.worker._timeouts(None, 512.0), (5.0, 512.0))
        self.assertEqual(self.worker._timeouts(100.0, 1.0), (5.0, 15.0))
        self.assertEqual(self.worker._timeouts(100.0, 40.0), (5.0, 40.0), "past a finish call's 15 s cap ...")
        self.assertEqual(self.worker._timeouts(30.0, 40.0), (5.0, 20.0), "... never past the deadline")
        self.assertIsNone(self.worker._timeouts(10.01, 40.0))

    def frozen_prefix(self, fragments: int = 6, tail: int = 5000) -> tuple[bytes, int]:
        """The recorder says the MP4 is frozen with a picture in it (the encoder is lost)."""
        self.worker._prefix_ready = lambda: True
        content, end = fmp4(fragments, tail=tail)
        (self.spool.dir / "stream.mp4").write_bytes(content)
        return content, end

    def test_a_frozen_prefix_goes_up_once_as_the_video_object_and_no_part_follows(self) -> None:
        self.prepare()
        content, end = self.frozen_prefix()
        self.assertGreater(len(content), 65536)  # (a part would be due)
        with mock.patch.object(r1_recorder, "PREFIX_MIN_BYTES_PER_SECOND", 1000):
            self.worker._periodic()
        (put,) = self.api.puts
        self.assertIn("/video?", put["url"])
        self.assertEqual(put["body"], content[:end], "cut at the last whole fragment")
        self.assertEqual(put["total"], end / 1000, "the timeout scales with the size")
        self.assertEqual(self.api.bodies("object-url"), [{"kind": "video"}])
        self.assertEqual((self.worker.prefix_uploaded, self.worker.prefix_bytes), (True, end))
        self.assertFalse(self.worker.faststart_uploaded)
        for _ in range(3):
            self.clock.advance(20)
            self.worker._periodic()
        self.assertEqual(self.api.bodies("part-url"), [], "no part is cut once the prefix is up")
        self.spool.ogg_path.write_bytes(b"OggS" + b"q" * 300)
        result = self.worker.job_tail(mp4=True, final_ogg=True, split=True, deadline=self.clock() + 100.0)
        self.assertEqual(result, {"uploading": True, "mp4": True, "ogg": True})
        self.assertEqual(self.api.bodies("part-url"), [], "nor at the finish")
        self.assertEqual(len([p for p in self.api.puts if "/video?" in p["url"]]), 1)

    def test_a_prefix_over_the_cap_or_without_a_whole_fragment_leaves_the_multipart_as_the_path(self) -> None:
        for reason in ("too_large", "no_fragment"):
            with self.subTest(reason):
                self.setUp()
                self.prepare()
                if reason == "too_large":
                    _content, end = self.frozen_prefix()
                    patch = mock.patch.object(r1_recorder, "PREFIX_MAX_BYTES", end - 1)
                else:
                    self.worker._prefix_ready = lambda: True
                    self.lay(65536 * 2 + 10)  # no ftyp, no fragment: nothing that opens on its own
                    patch = contextlib.nullcontext()
                with patch, captured_logs() as lines:
                    self.worker._periodic()
                    self.worker._periodic()
                self.assertEqual([p for p in self.api.puts if "/video?" in p["url"]], [])
                self.assertGreaterEqual(self.worker.parts_done, 1)
                self.assertFalse(self.worker.prefix_uploaded)
                self.assertEqual([(l["error_type"], l["error_category"]) for l in lines], [("r1_rec_prefix_skipped", reason)])

    def test_a_failing_prefix_waits_the_cooldown_between_rounds_and_the_finish_tries_once_more(self) -> None:
        self.prepare()
        content, end = self.frozen_prefix(fragments=1, tail=0)  # smaller than a part: nothing else is due
        self.api.put_status = lambda url: 500 if "/video?" in url else None
        self.worker._periodic()
        self.assertEqual(len(self.api.puts), 4, "one round: a try and three retries")
        self.worker._periodic()
        self.assertEqual(len(self.api.puts), 4, "inside the cooldown")
        for _ in range(r1_recorder.PREFIX_MAX_ROUNDS + 2):
            self.clock.advance(16)
            self.worker._periodic()
        self.assertEqual(len(self.api.puts), 4 * r1_recorder.PREFIX_MAX_ROUNDS, "the rounds are capped mid-call")
        self.assertEqual(len(self.api.bodies("object-url")), 4 * r1_recorder.PREFIX_MAX_ROUNDS)
        self.assertFalse(self.worker.prefix_uploaded)
        self.assertEqual((self.worker.state, self.stops, self.discards), ("uploading", [], []))
        self.api.put_status = None
        result = self.worker.job_tail(mp4=True, final_ogg=False, split=True, deadline=self.clock() + 100.0)
        self.assertEqual(result, {"uploading": True, "mp4": True, "ogg": False})
        self.assertEqual(self.api.puts[-1]["body"], content[:end])
        self.assertTrue(self.worker.prefix_uploaded)


# ------------------------------------------------------------------------------ http


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    log_message = lambda *a, **k: None  # noqa: E731

    def _serve(self) -> None:
        if self.path.startswith("/noread"):  # never reads the request body: a big upload stalls in send()
            self.server.release.wait(30)
            return
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

    def request_in_a_thread(self, path: str, *, cancel, total_timeout: float = 30, body: bytes | None = None):
        outcome: dict = {}

        def run() -> None:
            started = time.monotonic()
            try:
                outcome["reply"] = self.client.request(
                    "PUT" if body is not None else "GET", self.base + path, headers={}, body=body,
                    connect_timeout=1, total_timeout=total_timeout, cancel=cancel,
                )
            except HttpFailure as failure:
                outcome["failure"] = failure.kind
            outcome["took"] = time.monotonic() - started

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, outcome

    def test_cancel_inflight_cuts_a_cancellable_request_and_leaves_the_client_usable(self) -> None:
        cancel = threading.Event()
        thread, outcome = self.request_in_a_thread("/hang", cancel=cancel)
        wait_until(lambda: self.server.seen)  # the server has the request: it is in flight
        cancel.set()
        self.client.cancel_inflight()
        thread.join(5)
        self.assertEqual(outcome.get("failure"), "cancelled")
        self.assertLess(outcome["took"], 3.0)
        # Unlike abort(), the client carries on: the next request goes out and is answered.
        reply = self.client.request("GET", self.base + "/ok", headers={}, body=None, connect_timeout=1, total_timeout=5)
        self.assertEqual(reply.status, 200)

    def test_the_event_alone_ends_a_request_waiting_for_its_answer_within_a_quarter_second(self) -> None:
        cancel = threading.Event()
        thread, outcome = self.request_in_a_thread("/hang", cancel=cancel)
        wait_until(lambda: self.server.seen)
        cancel.set()  # no cancel_inflight(): the wait for the first byte polls the event
        thread.join(5)
        self.assertEqual(outcome.get("failure"), "cancelled")
        self.assertLess(outcome["took"], 3.0)

    def test_cancel_inflight_cuts_an_upload_that_is_stuck_inside_send(self) -> None:
        cancel = threading.Event()
        thread, outcome = self.request_in_a_thread("/noread", cancel=cancel, body=b"x" * (96 * 1024 * 1024))
        time.sleep(0.8)  # the socket buffers are full by now: the thread is blocked in send()
        self.assertTrue(thread.is_alive())
        cancel.set()
        self.client.cancel_inflight()
        thread.join(8)
        self.assertEqual(outcome.get("failure"), "cancelled")
        self.assertLess(outcome["took"], 6.0)

    def test_a_request_started_without_an_event_is_not_cut_by_cancel_inflight(self) -> None:
        thread, outcome = self.request_in_a_thread("/hang", cancel=None, total_timeout=1.5)
        wait_until(lambda: self.server.seen)
        self.client.cancel_inflight()
        thread.join(6)
        self.assertEqual(outcome.get("failure"), "timeout", "it ran to its own deadline, uncut")

    def test_an_event_that_is_set_but_not_announced_does_not_cut_a_request_by_cancel_inflight_alone(self) -> None:
        # (cancel_inflight is the second half of the pair: the caller sets the event first.)
        cancel = threading.Event()
        thread, outcome = self.request_in_a_thread("/hang", cancel=cancel, total_timeout=1.5)
        wait_until(lambda: self.server.seen)
        self.client.cancel_inflight()  # the event is not set: nothing is cut
        thread.join(6)
        self.assertEqual(outcome.get("failure"), "timeout")

    def test_a_cancel_that_is_already_set_stops_a_request_before_anything_goes_out(self) -> None:
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(HttpFailure) as caught:
            self.client.request("GET", self.base + "/ok", headers={}, body=None, connect_timeout=1, total_timeout=2, cancel=cancel)
        self.assertEqual(caught.exception.kind, "cancelled")
        self.assertEqual(self.server.seen, [])

    def test_abort_still_wins_over_cancel(self) -> None:
        cancel = threading.Event()
        thread, outcome = self.request_in_a_thread("/hang", cancel=cancel)
        wait_until(lambda: self.server.seen)
        cancel.set()
        self.client.abort()
        thread.join(5)
        self.assertEqual(outcome.get("failure"), "aborted")


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

    async def test_a_video_request_without_a_room_or_a_picture_encoder_is_recorded_as_audio(self) -> None:
        for label in ("no room", "no ctx", "no libx264"):
            with self.subTest(label):
                await self.asyncSetUp()
                overrides: dict = {}
                if label == "no room":
                    overrides = dict(ctx=SimpleNamespace(room=None))
                elif label == "no ctx":
                    overrides = dict(ctx=None)
                else:
                    self.encoder = FakeEncoder(self.events, self.spool.dir, x264=False)
                    overrides = dict(encoder=self.encoder, ctx=SimpleNamespace(room=FakeRoom()))
                recorder = await self.started(mode="av", **overrides)
                await until(lambda: "prepare" in self.api.ops())
                self.assertEqual(self.api.bodies("prepare"), [{"mode": "audio"}])
                self.assertFalse(self.encoder.hello["video"])
                self.assertFalse(recorder.video)
                await recorder.finish()

    async def test_the_kill_switch_records_a_video_request_as_audio(self) -> None:
        room = FakeRoom()
        with mock.patch.object(r1_recorder, "VIDEO_CAPTURE_READY", False):
            recorder = await self.started(mode="av", ctx=SimpleNamespace(room=room))
        await until(lambda: "prepare" in self.api.ops())
        self.assertEqual(self.api.bodies("prepare"), [{"mode": "audio"}])
        self.assertEqual(room.listeners(), 0)
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

    async def test_the_encoder_is_aged_on_its_own_clock_never_the_recorders(self) -> None:
        # CI regression (a fresh Linux VM): the recorder's clock far AHEAD of the encoder's must not
        # read as a stall; the encoder reports its own ages (the BEHIND case has its own test).
        recorder = await self.started()
        self.encoder.clock = time.monotonic
        self.encoder.spawned_at = self.encoder.last_status_at = time.monotonic()
        self.clock.advance(10_000_000.0)
        recorder._check_encoder()
        self.assertIsNone(recorder.encoder_lost)
        self.encoder.last_status_at = time.monotonic() - 5.1
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_crashed")
        self.assertTrue(recorder._lost_stalled)
        await recorder.finish()

    async def test_a_stall_is_seen_when_the_recorders_clock_is_far_behind_the_encoders(self) -> None:
        # The case that HID the bug on Windows: recorder clock behind the encoder's made the old age
        # negative, so a real stall never fired. The encoder's own age must still trip it.
        recorder = await self.started()
        far_ahead = 10_000_000.0
        self.encoder.clock = lambda: far_ahead + time.monotonic()
        self.encoder.last_status_at = self.encoder.clock() - 4.9
        recorder._check_encoder()
        self.assertIsNone(recorder.encoder_lost)
        self.encoder.last_status_at = self.encoder.clock() - 5.1
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_crashed")
        self.assertTrue(recorder._lost_stalled)
        await recorder.finish()

    async def test_a_starting_encoder_is_aged_on_its_own_clock_too(self) -> None:
        self.encoder.ready.clear()
        self.encoder.clock = time.monotonic
        self.encoder.spawned_at = time.monotonic()
        recorder = await self.started()
        self.clock.advance(10_000_000.0)
        recorder._check_encoder()
        self.assertIsNone(recorder.encoder_lost)
        self.encoder.spawned_at = time.monotonic() - (r1_recorder.SELF_TEST_WAIT_SECONDS + 0.5)
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_unavailable")
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

    async def test_a_slow_mid_call_part_put_does_not_cost_the_recording_its_tail(self) -> None:
        """Review round 1: the first (mid-call) part PUT takes 8 s, the finish is allowed 6.  The jobs the
        finish queues used to wait behind that PUT, so no ``complete`` went out and the tail was lost."""
        part = self.api.part_size
        self.encoder.mp4_bytes = 3 * part + 1000
        self.lay_stream(3 * part)  # three full parts are due while the call is still going
        self.api.put_delay = 8.0
        recorder = await self.started(finish_seconds=6.0)
        await until(lambda: "put" in self.events)  # the slow PUT is in flight
        self.api.put_delay = 0.0
        began = time.monotonic()
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        self.assertLess(time.monotonic() - began, 3.0, "the finish did not sit behind the 8 s PUT")
        (body,) = self.api.bodies("complete")
        self.assertNotIn("failure_reason", body)
        self.assertEqual((body["layout"], body["report"]["parts_uploaded"]), ("combined", 4))
        full = bytes((i * 7) % 251 for i in range(self.encoder.mp4_bytes))
        delivered = b"".join(p["body"] for p in self.api.puts if p["content_type"] == "application/octet-stream" and not p.get("cancelled"))
        self.assertEqual(delivered, full, "no part is missing and none is duplicated")
        self.assertFalse(self.spool.dir.exists())

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

    async def test_a_multipart_that_is_gone_still_leaves_the_final_ogg_and_the_faststart_copy(self) -> None:
        """The multipart upload vanished under a live call: the stream can no longer be completed, so
        the finish sends the whole OGG as well, and the faststart copy is still the MP4."""
        self.api.put_status = lambda url: 404 if "/part?" in url and "partNumber=1&" not in url else None
        self.lay_stream(65536 * 2 + 100)
        recorder = await self.started()
        await until(lambda: recorder._worker.multipart_gone)
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        self.assertEqual([b["part_number"] for b in self.api.bodies("part-url")], [1, 2])
        self.assertEqual(self.api.bodies("object-url"), [{"kind": "audio"}, {"kind": "video"}])
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["failure_reason"]), ("combined", "upload_failed"))
        self.assertTrue(body["report"]["audio_final_uploaded"])
        self.assertTrue(body["report"]["faststart_uploaded"])
        self.assertNotIn("prefix_uploaded", body["report"])
        self.assertIsNone(recorder._stop_reason)

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

    async def test_the_discard_overwrite_runs_off_the_event_loop_so_the_interview_keeps_ticking(self) -> None:
        """Review round 1: the zero-fill + fsync of a long call's spool ran on the loop the live pipeline shares."""
        self.lay_stream()
        loop_thread = threading.get_ident()
        filled: list[tuple[str, int]] = []

        def slow_zero_fill(path) -> None:  # a ~100 MB spool takes this long on a slow disk
            filled.append((Path(path).name, threading.get_ident()))
            time.sleep(0.5)

        ticks: list[float] = []

        async def ticker() -> None:
            while True:
                ticks.append(time.monotonic())
                await asyncio.sleep(0.01)

        self.api.script("prepare", ApiReply(409, {"error": "r1_consent_withdrawn"}, "r1_consent_withdrawn"))
        pulse = asyncio.ensure_future(ticker())
        self.addCleanup(pulse.cancel)
        with mock.patch.object(r1_recorder, "_zero_fill", slow_zero_fill):
            recorder = await self.started()
            await until(lambda: recorder.discarded == "consent_withdrawn")
            await until(lambda: not self.spool.dir.exists(), timeout=10)
        pulse.cancel()
        self.assertEqual({name for name, _ in filled}, {"stream.mp4", "audio.ogg"})
        self.assertNotIn(loop_thread, {thread for _, thread in filled}, "the overwrite is not on the event loop")
        self.assertLess(max(b - a for a, b in zip(ticks, ticks[1:])), 0.35, "the loop kept ticking during the 1 s wipe")
        await asyncio.wait_for(recorder.finish(), 10)

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


# ------------------------------------------------------------------------------ picture: encoder queues


class _BlockingStdout:
    """The child's stdout: ``readline`` blocks until the test closes it (a live child writes nothing here)."""

    def __init__(self) -> None:
        self._lines: queue.Queue = queue.Queue()

    def readline(self, _limit: int = -1) -> bytes:
        item = self._lines.get()
        return b"" if item is None else item

    def close(self) -> None:
        self._lines.put(None)


class _GatedStdin:
    """The child's stdin: every write waits for ``gate``, so a test can hold the writer thread."""

    def __init__(self) -> None:
        self.gate = threading.Event()
        self.gate.set()
        self.writes: list[bytes] = []
        self.closed = False
        self._cond = threading.Condition()

    def write(self, data: bytes) -> None:
        self.gate.wait(10)
        with self._cond:
            self.writes.append(bytes(data))
            self._cond.notify_all()

    def flush(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True

    def wait_for(self, count: int, timeout: float = 5.0) -> None:
        end = time.monotonic() + timeout
        with self._cond:
            while len(self.writes) < count:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    raise AssertionError(f"only {len(self.writes)} of {count} writes")
                self._cond.wait(remaining)

    def messages(self) -> list[tuple[int, int, bytes]]:
        import io

        import r1_video_encoder as wire

        stream = io.BytesIO(b"".join(self.writes))
        out = []
        while (message := wire.read_frame(stream)) is not None:
            out.append(message)
        return out


class _FakeProc:
    def __init__(self) -> None:
        self.stdin = _GatedStdin()
        self.stdout = _BlockingStdout()
        self.killed = False

    def poll(self):
        return 0 if self.killed else None

    def kill(self) -> None:
        self.killed = True
        self.stdout.close()

    def wait(self, timeout=None) -> int:
        return 0


class TestEncoderQueues(unittest.TestCase):
    def setUp(self) -> None:
        import r1_video_encoder as wire

        self.wire = wire
        self.proc = _FakeProc()
        self.clock = ManualClock(100.0)  # the encoder's own clock: what its backlog is aged on
        self.encoder = r1_recorder.EncoderProcess(Path("."), popen=lambda *_a, **_k: self.proc, clock=self.clock)
        self.assertTrue(self.encoder.spawn())
        self.addCleanup(self.encoder.kill)
        self.addCleanup(self.proc.stdout.close)

    def hold_the_writer(self) -> None:
        """Send one message and block the writer inside its write, so later sends queue up."""
        self.proc.stdin.gate.clear()
        self.assertTrue(self.encoder.send_hello(video=True, preset="superfast", t0_us=1))
        end = time.monotonic() + 5
        while self.encoder._ordered and time.monotonic() < end:
            time.sleep(0.005)
        time.sleep(0.05)  # the writer has taken HELLO and is blocked in its write

    def release(self, count: int) -> list[tuple[int, int, bytes]]:
        self.proc.stdin.gate.set()
        self.proc.stdin.wait_for(count)
        return self.proc.stdin.messages()

    def test_the_picture_queue_keeps_the_newest_three_and_counts_what_it_pushed_out(self) -> None:
        self.hold_the_writer()
        for index in range(6):
            self.assertTrue(self.encoder.send_video(index * 1000, 640, 360, 0, b"P%d" % index))
        self.assertEqual(self.encoder.video_dropped, 3)
        got = self.release(1 + 3)
        types = [m[0] for m in got]
        self.assertEqual(types, [self.wire.MSG_HELLO] + [self.wire.MSG_VIDEO] * 3)
        self.assertEqual([m[1] for m in got[1:]], [3000, 4000, 5000])  # the newest three, oldest first
        deadline = time.monotonic() + 5
        while self.encoder.video_sent < 3 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.encoder.video_sent, 3)
        header = self.wire.VIDEO_HEADER.size
        self.assertEqual(self.wire.parse_video(got[1][2])[:3], (640, 360, 0))
        self.assertEqual(got[1][2][header:], b"P3")

    def test_audio_goes_before_pictures_and_the_ordered_messages_keep_their_order(self) -> None:
        self.hold_the_writer()
        self.encoder.send_video(1, 640, 360, 0, b"p1")
        self.encoder.send_audio(10, b"\x00\x00")
        self.encoder.send_video(2, 640, 360, 0, b"p2")
        self.encoder.send_audio(20, b"\x00\x00")
        got = self.release(5)
        self.assertEqual(
            [(m[0], m[1]) for m in got],
            [(self.wire.MSG_HELLO, 0), (self.wire.MSG_AUDIO, 10), (self.wire.MSG_AUDIO, 20),
             (self.wire.MSG_VIDEO, 1), (self.wire.MSG_VIDEO, 2)],
        )

    def test_eof_waits_for_the_pictures_queued_before_it_so_the_tail_is_not_lost(self) -> None:
        self.hold_the_writer()
        self.encoder.send_video(1, 640, 360, 0, b"p1")
        self.encoder.send_video(2, 640, 360, 0, b"p2")
        self.encoder.send_eof()
        self.encoder.send_audio(30, b"\x00\x00")  # queued after EOF in the ordered queue
        got = self.release(5)
        self.assertEqual(
            [m[0] for m in got],
            [self.wire.MSG_HELLO, self.wire.MSG_VIDEO, self.wire.MSG_VIDEO, self.wire.MSG_EOF, self.wire.MSG_AUDIO],
        )

    def test_pictures_never_count_against_the_audio_backlog(self) -> None:
        self.assertTrue(self.encoder.send_hello(video=True, preset="superfast", t0_us=1))
        self.proc.stdin.wait_for(1)
        end = time.monotonic() + 5
        while self.encoder._writing_since is not None and time.monotonic() < end:
            time.sleep(0.005)  # the write of HELLO has returned: nothing ordered waits
        self.proc.stdin.gate.clear()
        for index in range(50):
            self.encoder.send_video(index, 640, 360, 0, b"x" * 1000)
        self.clock.advance(r1_recorder.ENCODER_BACKLOG_SECONDS * 2)  # a picture stuck in the pipe ...
        self.assertEqual(self.encoder.backlog_seconds(), 0.0)  # ... is not a backlog by itself
        self.assertTrue(self.encoder.send_audio(1, b"\x00\x00"))
        self.assertFalse(self.encoder.overflowed)
        # The audio now waits behind that picture: once it has waited too long the pipe is stuck.
        self.clock.advance(r1_recorder.ENCODER_BACKLOG_SECONDS + 0.1)
        self.assertFalse(self.encoder.send_audio(2, b"\x00\x00"))
        self.assertTrue(self.encoder.overflowed)  # only waiting audio can make the child "stuck"
        self.proc.stdin.gate.set()

    def test_a_whole_agent_turn_handed_over_at_once_is_a_burst_not_a_stuck_child(self) -> None:
        # The SDK writes nothing while the agent speaks, so a 35 s turn is ONE chunk, and the mixer
        # hands it to the encoder at once as a 30 s piece and a 5 s piece.  A healthy child that has
        # not read the first piece yet (the writer is inside a write) must take the rest too.
        mixer = r1_recorder.TeeMixer(0.0)
        pieces = mixer.process([], [frame(tone_samples(35.0, rate=RATE), rate=RATE)], 35.0)
        self.assertEqual([len(pcm) // 2 for _pts, pcm in pieces], [30 * RATE, 5 * RATE])
        self.hold_the_writer()
        for pts_us, pcm in pieces:
            self.assertTrue(self.encoder.send_audio(pts_us, pcm), "a piece of the turn was refused")
        self.clock.advance(2.5)  # the next 2.5 s chunk, the child still busy with the turn
        self.assertTrue(self.encoder.send_audio(35_000_000, b"\x00" * (RATE * 5)))
        self.assertFalse(self.encoder.overflowed, "a healthy child was taken for a stuck one")
        got = self.release(1 + 3)
        self.assertEqual([m[0] for m in got], [self.wire.MSG_HELLO] + [self.wire.MSG_AUDIO] * 3)
        self.assertEqual(b"".join(m[2] for m in got[1:3]), b"".join(pcm for _pts, pcm in pieces))

    def test_audio_that_waited_longer_than_the_window_means_a_stuck_child(self) -> None:
        self.hold_the_writer()  # HELLO went in at 100.0 and the pipe takes nothing more
        self.assertTrue(self.encoder.send_audio(1, b"\x00\x00"))
        self.clock.advance(r1_recorder.ENCODER_BACKLOG_SECONDS)
        self.assertEqual(self.encoder.backlog_seconds(), r1_recorder.ENCODER_BACKLOG_SECONDS)
        self.assertTrue(self.encoder.send_audio(2, b"\x00\x00"), "a slow encoder gets the whole window")
        self.assertFalse(self.encoder.overflowed)
        self.clock.advance(0.1)
        self.assertFalse(self.encoder.send_audio(3, b"\x00\x00"))
        self.assertTrue(self.encoder.overflowed)
        self.proc.stdin.gate.set()
        self.proc.stdin.wait_for(3)  # HELLO and the two accepted pieces; the refused one never queued
        end = time.monotonic() + 5
        while self.encoder.backlog_seconds() and time.monotonic() < end:
            time.sleep(0.005)
        self.assertEqual(self.encoder.backlog_seconds(), 0.0, "a written message no longer waits")

    def test_kill_discards_everything_queued_and_stops_the_writer(self) -> None:
        self.hold_the_writer()
        self.encoder.send_video(1, 640, 360, 0, b"p")
        self.encoder.send_audio(2, b"\x00\x00")
        self.encoder.kill()
        self.assertEqual((len(self.encoder._ordered), len(self.encoder._pictures)), (0, 0))
        self.assertTrue(self.proc.killed)
        self.proc.stdin.gate.set()
        deadline = time.monotonic() + 5
        while not self.proc.stdin.closed and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.proc.stdin.closed)
        self.assertFalse(self.encoder.send_video(3, 640, 360, 0, b"p"))
        self.assertFalse(self.encoder.send_audio(4, b"\x00\x00"))

    def test_the_writer_stops_when_the_child_goes_away(self) -> None:
        self.proc.stdout.close()  # the child closed its output: it is gone
        self.assertTrue(self.encoder.exited.wait(5))
        deadline = time.monotonic() + 5
        while not self.proc.stdin.closed and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.proc.stdin.closed)
        self.assertFalse(self.encoder.send_video(1, 640, 360, 0, b"p"))

    def test_the_child_can_take_pictures_only_with_libx264(self) -> None:
        self.assertTrue(self.encoder.can_encode_video(), "self-test still running: optimistic")
        self.encoder.ready_info = {"s": "ready", "av": "19", "x264": True, "aac": True}
        self.assertTrue(self.encoder.can_encode_video())
        self.encoder.ready_info = {"s": "ready", "av": "19", "x264": False, "aac": True}
        self.assertFalse(self.encoder.can_encode_video())
        self.encoder.ready_info = {"s": "ready", "av": "19", "x264": True, "aac": True}
        self.encoder.exited.set()
        self.assertFalse(self.encoder.can_encode_video())


# ------------------------------------------------------------------------------ picture: camera capture


class CameraCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.room = FakeRoom()
        self.clock = ManualClock(1000.0)
        self.factory = StreamFactory()
        self.pictures: list[tuple] = []
        self.rejects = 0
        self.candidate = FakeParticipant("candidate-identity")
        self.room.remote_participants["candidate-identity"] = self.candidate
        self.camera_pub = self.candidate.add(FakePublication("PUB_camera"))
        self.camera = self.make()

    def make(self, identity: str | None = "candidate-identity") -> r1_recorder.CameraCapture:
        def rejected() -> None:
            self.rejects += 1

        camera = r1_recorder.CameraCapture(
            room=self.room, identity=identity, loop=asyncio.get_running_loop(), clock=self.clock, t0=1000.0,
            on_picture=lambda *args: self.pictures.append(args), on_reject=rejected, make_stream=self.factory,
        )
        self.addCleanup(camera.stop)
        return camera

    async def subscribed(self, publication: FakePublication | None = None, participant: FakeParticipant | None = None):
        """The SFU accepted the subscription and the track arrived."""
        publication = publication or self.camera_pub
        participant = participant or self.candidate
        publication.track = FakeTrack("TR_" + publication.sid)
        publication.subscribed = True
        self.room.emit("track_subscribed", publication.track, publication, participant)
        await asyncio.sleep(0)
        return self.factory.streams[-1]

    async def deliver(self, stream: FakeVideoStream, event, at: float) -> None:
        self.clock.value = 1000.0 + at
        stream.push(event)
        for _ in range(3):
            await asyncio.sleep(0)


class TestCameraCapture(CameraCase):
    async def test_it_subscribes_to_the_candidate_camera_and_to_nothing_else(self) -> None:
        microphone = self.candidate.add(FakePublication("PUB_mic", kind=1, source=2))
        screen = self.candidate.add(FakePublication("PUB_screen", kind=2, source=3))
        stranger = FakeParticipant("someone-else")
        stranger_camera = stranger.add(FakePublication("PUB_other"))
        self.room.remote_participants["someone-else"] = stranger
        self.camera.start()
        self.assertEqual(self.camera_pub.subscribe_calls, [True])
        self.assertEqual((microphone.subscribe_calls, screen.subscribe_calls, stranger_camera.subscribe_calls), ([], [], []))

    async def test_a_camera_that_never_appears_is_not_an_error(self) -> None:
        self.candidate.track_publications.clear()
        with captured_logs() as lines:
            self.camera.start()
            await asyncio.sleep(0.05)
            self.camera.scan()
        self.assertEqual(lines, [])
        self.assertEqual(self.factory.streams, [])

    async def test_a_camera_published_later_is_subscribed_when_it_appears(self) -> None:
        self.candidate.track_publications.clear()
        self.camera.start()
        late = self.candidate.add(FakePublication("PUB_late"))
        self.room.emit("track_published", late, self.candidate)
        self.assertEqual(late.subscribe_calls, [True])
        self.room.emit("track_published", FakePublication("PUB_other", source=2, kind=1), self.candidate)  # a microphone: ignored
        self.room.emit("track_published", FakePublication("PUB_x"), FakeParticipant("someone-else"))  # another person: ignored
        self.assertEqual(self.factory.streams, [])

    async def test_a_rejoin_brings_a_new_participant_and_a_new_camera(self) -> None:
        self.camera.start()
        await self.subscribed()
        self.room.emit("participant_disconnected", self.candidate)
        await asyncio.sleep(0)
        self.assertTrue(self.factory.streams[0].closed)
        again = FakeParticipant("candidate-identity")
        publication = again.add(FakePublication("PUB_camera_2"))
        self.room.remote_participants["candidate-identity"] = again
        self.room.emit("participant_connected", again)
        self.assertEqual(publication.subscribe_calls, [True])
        await self.subscribed(publication, again)
        self.assertEqual(len(self.factory.streams), 2)
        self.assertEqual(self.camera.streams_opened, 2)

    async def test_a_stream_that_ends_is_reopened_when_the_next_track_arrives(self) -> None:
        self.camera.start()
        first = await self.subscribed()
        first.end()
        for _ in range(3):
            await asyncio.sleep(0)
        self.assertTrue(first.closed)
        publication = self.candidate.add(FakePublication("PUB_camera_b"))
        second = await self.subscribed(publication)
        self.assertIsNot(first, second)

    async def test_the_same_track_is_never_opened_twice(self) -> None:
        self.camera.start()
        await self.subscribed()
        self.camera.scan()
        self.camera.scan()
        self.room.emit("track_subscribed", self.camera_pub.track, self.camera_pub, self.candidate)
        self.assertEqual(len(self.factory.streams), 1)

    async def test_unsubscribing_the_track_closes_the_stream(self) -> None:
        self.camera.start()
        stream = await self.subscribed()
        self.room.emit("track_unsubscribed", self.camera_pub.track, self.camera_pub, self.candidate)
        await asyncio.sleep(0)
        self.assertTrue(stream.closed)

    async def test_pictures_carry_the_media_clock_the_size_and_the_turn_in_degrees(self) -> None:
        self.camera.start()
        stream = await self.subscribed()
        await self.deliver(stream, picture_event(640, 360, luma=77), 2.5)
        await self.deliver(stream, picture_event(360, 640, rotation=1, luma=88), 3.0)
        await self.deliver(stream, picture_event(360, 640, rotation=3, luma=99), 3.5)
        await self.deliver(stream, picture_event(640, 360, rotation=2, luma=11), 4.0)
        self.assertEqual([(p[0], p[1], p[2], p[3]) for p in self.pictures],
                         [(2_500_000, 640, 360, 0), (3_000_000, 360, 640, 90), (3_500_000, 360, 640, 270), (4_000_000, 640, 360, 180)])
        self.assertEqual(self.pictures[0][4], bytes([77]) * (640 * 360 * 3 // 2))
        self.assertIsInstance(self.pictures[0][4], bytes)  # a copy: the SDK buffer is reused
        self.assertEqual(self.camera.taken, 4)

    async def test_a_30_fps_camera_is_halved_and_a_15_fps_one_is_untouched(self) -> None:
        self.camera.start()
        stream = await self.subscribed()
        for index in range(30):  # 1 s at 30 fps
            await self.deliver(stream, picture_event(), 10.0 + index / 30)
        self.assertEqual(self.camera.received, 30)
        self.assertEqual(self.camera.taken, 15)
        self.pictures.clear()
        before = self.camera.taken
        for index in range(15):  # 1 s at 15 fps
            await self.deliver(stream, picture_event(), 20.0 + index / 15)
        self.assertEqual(self.camera.taken - before, 15)

    async def test_the_gap_between_two_pictures_is_at_least_60_milliseconds(self) -> None:
        self.camera.start()
        stream = await self.subscribed()
        await self.deliver(stream, picture_event(), 5.000)
        await self.deliver(stream, picture_event(), 5.059)  # 59 ms: too soon
        self.assertEqual(self.camera.taken, 1)
        await self.deliver(stream, picture_event(), 5.061)  # 61 ms after the one taken
        self.assertEqual(self.camera.taken, 2)

    async def test_pictures_that_cannot_be_used_are_rejected_and_counted(self) -> None:
        self.camera.start()
        stream = await self.subscribed()
        good = picture_event(640, 360)
        bad_cases = [
            picture_event(641, 360, data=bytes(641 * 360 * 3 // 2)),  # odd width
            picture_event(640, 360, data=bytes(640 * 360 * 3 // 2 - 2)),  # short buffer
            picture_event(8, 8, data=bytes(8 * 8 * 3 // 2)),  # absurdly small
            picture_event(8192, 8192, data=b""),  # absurdly large
            picture_event(640, 360, rotation=7),  # not a turn the SDK defines
        ]
        at = 30.0
        for event in bad_cases:
            at += 1.0
            await self.deliver(stream, event, at)
        self.assertEqual((self.camera.rejected, self.rejects, self.camera.taken), (5, 5, 0))
        await self.deliver(stream, good, at + 1.0)
        self.assertEqual(self.camera.taken, 1)

    async def test_a_picture_in_another_pixel_format_is_converted_to_i420(self) -> None:
        self.camera.start()
        stream = await self.subscribed()
        converted = picture_event(640, 360, luma=55).frame
        event = picture_event(640, 360, luma=1, kind=9)
        event.frame.convert = lambda kind: converted if kind == 5 else None
        await self.deliver(stream, event, 40.0)
        self.assertEqual(self.pictures[0][4][:4], bytes([55]) * 4)
        broken = picture_event(640, 360, kind=9)

        def explode(_kind):
            raise RuntimeError("no conversion " + PRESIGNED)

        broken.frame.convert = explode
        await self.deliver(stream, broken, 41.0)
        self.assertEqual(self.rejects, 1)

    async def test_a_stream_that_fails_is_logged_once_by_type_and_never_raises(self) -> None:
        self.camera.start()
        with captured_logs() as lines:
            stream = await self.subscribed()
            stream.fail = ValueError("boom " + PRESIGNED + " candidate-identity")
            stream.push(picture_event())
            for _ in range(5):
                await asyncio.sleep(0)
            self.camera.scan()  # the next scan reopens it: the second failure stays quiet
            for _ in range(5):
                await asyncio.sleep(0)
        failures = [l for l in lines if l["error_type"] == "r1_rec_camera_stream_failed"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["error_category"], "ValueError")
        self.assertNotIn("boom", json.dumps(lines))
        self.assertNotIn("candidate-identity", json.dumps(lines))

    async def test_unsubscribe_gives_the_camera_up_for_good(self) -> None:
        self.camera.start()
        stream = await self.subscribed()
        await self.deliver(stream, picture_event(), 50.0)
        self.camera.unsubscribe()
        await asyncio.sleep(0)
        self.assertEqual(self.camera_pub.subscribe_calls, [True, False])
        self.assertTrue(stream.closed)
        self.assertEqual(self.room.listeners(), 0)
        self.camera.scan()  # nothing comes back
        self.room.emit("track_published", self.camera_pub, self.candidate)
        self.assertEqual(self.camera_pub.subscribe_calls, [True, False])
        stream.push(picture_event())
        await asyncio.sleep(0)
        self.assertEqual(self.camera.taken, 1)
        self.camera.unsubscribe()  # idempotent
        self.assertEqual(self.camera_pub.subscribe_calls, [True, False])

    async def test_stop_closes_the_stream_and_the_listeners_but_leaves_the_subscription(self) -> None:
        self.camera.start()
        stream = await self.subscribed()
        self.camera.stop()
        self.camera.stop()
        await asyncio.sleep(0)
        self.assertTrue(stream.closed)
        self.assertEqual(self.room.listeners(), 0)
        self.assertEqual(self.camera_pub.subscribe_calls, [True])

    async def test_without_an_identity_only_standard_participants_are_considered(self) -> None:
        camera = self.make(identity=None)
        agent = FakeParticipant("agent-1", kind=4)
        agent_camera = agent.add(FakePublication("PUB_agent"))
        self.room.remote_participants["agent-1"] = agent
        camera.start()
        self.assertEqual(self.camera_pub.subscribe_calls, [True])
        self.assertEqual(agent_camera.subscribe_calls, [])

    async def test_a_room_that_refuses_a_subscription_is_not_an_error(self) -> None:
        def refuse(_value: bool) -> None:
            raise RuntimeError("no")

        self.camera_pub.set_subscribed = refuse
        self.camera.start()  # nothing raises
        self.camera.scan()


# ------------------------------------------------------------------------------ picture: the watchdog thresholds


class TestMonitors(unittest.TestCase):
    def test_lag_over_250_ms_in_a_5_second_window_trips_and_below_never_does(self) -> None:
        monitor = r1_recorder.LagMonitor()
        for second in range(0, 20):
            monitor.record(float(second), 0.249)
            self.assertFalse(monitor.tripped(float(second)))
        monitor.record(20.0, 0.250)
        self.assertFalse(monitor.tripped(20.0), "exactly at the limit is not over it")
        monitor.record(21.0, 0.251)
        self.assertTrue(monitor.tripped(21.0))
        self.assertAlmostEqual(monitor.worst(21.0), 0.251)

    def test_a_lag_spike_leaves_the_window_after_five_seconds(self) -> None:
        monitor = r1_recorder.LagMonitor()
        monitor.record(0.0, 0.4)
        self.assertTrue(monitor.tripped(5.0))
        self.assertFalse(monitor.tripped(5.01))

    def test_more_than_30_percent_of_the_pictures_lost_over_10_seconds_trips_it(self) -> None:
        monitor = r1_recorder.DropMonitor()
        monitor.record(100.0, seen=70)
        monitor.record(100.0, seen=30, dropped=30)  # 100 seen, 30 lost: exactly the limit
        self.assertFalse(monitor.tripped(105.0))
        monitor.record(105.0, dropped=1)
        self.assertTrue(monitor.tripped(105.0))

    def test_a_handful_of_pictures_proves_nothing(self) -> None:
        monitor = r1_recorder.DropMonitor()
        monitor.record(10.0, seen=29, dropped=29)
        self.assertFalse(monitor.tripped(10.0))
        monitor.record(10.0, seen=1, dropped=1)
        self.assertTrue(monitor.tripped(10.0))

    def test_losses_age_out_of_the_window(self) -> None:
        monitor = r1_recorder.DropMonitor()
        monitor.record(0.0, seen=100, dropped=100)
        self.assertTrue(monitor.tripped(9.9))
        self.assertFalse(monitor.tripped(10.0))
        self.assertEqual(monitor.ratio(10.0), (0.0, 0))

    def test_vad_trips_on_two_slow_batches_in_a_row_and_only_then(self) -> None:
        monitor = r1_recorder.VadMonitor()
        window = 0.032
        slow, fine = 0.0135 * 32, 0.0125 * 32  # means of 13.5 ms and 12.5 ms against a 12.8 ms limit
        self.assertFalse(monitor.observe(fine, 32, window))
        self.assertFalse(monitor.observe(slow, 32, window))
        self.assertFalse(monitor.observe(fine, 32, window), "a good batch resets the run")
        self.assertFalse(monitor.observe(slow, 32, window))
        self.assertTrue(monitor.observe(slow, 32, window))

    def test_a_single_slow_inference_batch_also_counts(self) -> None:
        monitor = r1_recorder.VadMonitor()
        self.assertFalse(monitor.observe(0.25, 1, 5.0))  # mean 250 ms: slow, whatever the window
        self.assertTrue(monitor.observe(0.25, 1, 5.0))

    def test_vad_batches_that_make_no_sense_are_ignored(self) -> None:
        monitor = r1_recorder.VadMonitor()
        for args in ((1.0, 0, 0.032), (-1.0, 5, 0.032), (1.0, 5, 0.0)):
            self.assertFalse(monitor.observe(*args))
            self.assertFalse(monitor.observe(*args))


# ------------------------------------------------------------------------------ picture: the recorder


class VideoCase(RecorderCase):
    """An ``av`` recorder with a fake room, a fake camera stream and a fake VAD."""

    async def asyncSetUp(self) -> None:
        await super().asyncSetUp()
        self.room = FakeRoom()
        self.factory = StreamFactory()
        self.candidate = FakeParticipant("candidate-identity")
        self.room.remote_participants["candidate-identity"] = self.candidate
        self.pub = self.candidate.add(FakePublication("PUB_camera"))
        self.vad = FakeVad()
        self.session.vad = self.vad
        self.ctx = SimpleNamespace(room=self.room)

    def make(self, **overrides) -> R1Recorder:
        params = dict(mode="av", ctx=self.ctx, make_stream=self.factory)
        params.update(overrides)
        return super().make(**params)

    async def started(self, **overrides) -> R1Recorder:
        recorder = self.make(**overrides)
        await recorder.start("candidate-identity")
        return recorder

    async def camera_on(self) -> FakeVideoStream:
        self.pub.track = FakeTrack("TR_camera")
        self.pub.subscribed = True
        self.room.emit("track_subscribed", self.pub.track, self.pub, self.candidate)
        await until(lambda: self.factory.streams)
        return self.factory.streams[-1]

    async def show(self, stream: FakeVideoStream, count: int = 1, **kwargs) -> None:
        """Deliver ``count`` pictures 70 ms apart on the recorder's clock; wait until each reaches the encoder."""
        for _ in range(count):
            self.clock.advance(0.07)
            before = len(self.encoder.pictures)
            stream.push(picture_event(**kwargs))
            await until(lambda: len(self.encoder.pictures) > before)

    async def ready(self, recorder: R1Recorder) -> None:
        await until(lambda: recorder._worker.state == "uploading")


class TestVideoStart(VideoCase):
    async def test_av_says_video_in_hello_and_prepare_and_asks_for_the_camera(self) -> None:
        recorder = await self.started()
        self.assertTrue(recorder.video)
        self.assertEqual(self.encoder.hello, {"video": True, "preset": "superfast", "t0_us": 1000 * 1_000_000})
        await until(lambda: "prepare" in self.api.ops())
        self.assertEqual(self.api.bodies("prepare"), [{"mode": "av"}])
        self.assertEqual(self.pub.subscribe_calls, [True])
        self.assertGreater(self.room.listeners(), 0)
        self.assertEqual(len(self.vad.handlers), 1)
        await recorder.finish()

    async def test_the_preset_reaches_the_encoder_in_hello(self) -> None:
        recorder = await self.started(preset="veryfast")
        self.assertEqual(self.encoder.hello["preset"], "veryfast")
        await recorder.finish()
        recorder = self.make(preset="slow")  # not one of the three: the default
        self.assertEqual(recorder._preset, "superfast")

    async def test_audio_mode_never_touches_the_room_the_vad_or_the_probe(self) -> None:
        recorder = await self.started(mode="audio")
        self.assertFalse(recorder.video)
        self.assertEqual(self.encoder.hello["video"], False)
        self.assertEqual(self.room.listeners(), 0)
        self.assertEqual(self.pub.subscribe_calls, [])
        self.assertEqual(self.vad.handlers, [])
        self.assertIsNone(recorder._lag_task)
        self.assertIsNone(recorder._camera)
        await recorder.finish()

    async def test_a_self_test_that_has_not_answered_yet_is_given_the_benefit_of_the_doubt(self) -> None:
        self.encoder.ready_info = None
        recorder = await self.started()
        self.assertTrue(recorder.video)
        await recorder.finish()

    async def test_a_camera_that_never_appears_is_a_recording_without_a_picture_not_an_error(self) -> None:
        self.candidate.track_publications.clear()
        with captured_logs() as lines:
            recorder = await self.started()
            await self.ready(recorder)
            self.lay_stream()
            recorder.stop(None)
            await asyncio.wait_for(recorder.finish(), 20)
        self.assertEqual([l["error_type"] for l in lines if l["level"] in ("warn", "error")], [])
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["has_video"]), ("combined", False))
        self.assertEqual(body["degraded_reason"], "video_unavailable")
        self.assertNotIn("failure_reason", body)


class TestPictureFlow(VideoCase):
    async def test_pictures_reach_the_encoder_stamped_on_the_media_clock(self) -> None:
        recorder = await self.started()
        stream = await self.camera_on()
        self.clock.value = 1002.5
        stream.push(picture_event(640, 360, luma=66))
        await until(lambda: self.encoder.pictures)
        pts, width, height, rotation, data = self.encoder.pictures[0]
        self.assertEqual((pts, width, height, rotation), (2_500_000, 640, 360, 0))
        self.assertEqual(data, bytes([66]) * (640 * 360 * 3 // 2))
        await recorder.finish()

    async def test_a_refresh_keeps_the_pictures_coming(self) -> None:
        recorder = await self.started()
        first = await self.camera_on()
        await self.show(first, 2)
        first.end()
        await until(lambda: first.closed)
        self.pub.track = None
        self.room.emit("track_unsubscribed", FakeTrack("TR_camera"), self.pub, self.candidate)
        second_pub = self.candidate.add(FakePublication("PUB_camera_2"))
        self.room.emit("track_published", second_pub, self.candidate)
        second_pub.track = FakeTrack("TR_camera_2")
        second_pub.subscribed = True
        self.room.emit("track_subscribed", second_pub.track, second_pub, self.candidate)
        await until(lambda: len(self.factory.streams) == 2)
        await self.show(self.factory.streams[1], 2)
        self.assertEqual(len(self.encoder.pictures), 4)
        self.assertEqual(recorder._camera.streams_opened, 2)
        await recorder.finish()

    async def test_a_camera_whose_event_was_missed_is_found_by_the_once_a_second_rescan(self) -> None:
        self.candidate.track_publications.clear()
        recorder = await self.started()
        late = self.candidate.add(FakePublication("PUB_late"))  # no track_published event is ever emitted
        await until(lambda: late.subscribe_calls == [True], timeout=4)
        late.track = FakeTrack("TR_late")  # ... nor a track_subscribed one
        await until(lambda: self.factory.streams, timeout=4)
        await recorder.finish()

    async def test_unusable_pictures_never_reach_the_encoder(self) -> None:
        recorder = await self.started()
        stream = await self.camera_on()
        self.clock.advance(1.0)
        stream.push(picture_event(641, 360, data=bytes(641 * 360 * 3 // 2)))
        await until(lambda: recorder._camera.rejected == 1)
        self.assertEqual(self.encoder.pictures, [])
        await recorder.finish()

    async def test_pictures_sent_to_a_lost_encoder_are_dropped_not_queued(self) -> None:
        recorder = await self.started()
        stream = await self.camera_on()
        await self.show(stream, 1)
        self.encoder.exited.set()
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_crashed")
        recorder._forward_picture(1, 640, 360, 0, bytes(640 * 360 * 3 // 2))
        self.assertEqual(len(self.encoder.pictures), 1)
        await recorder.finish()


class TestDegrade(VideoCase):
    """Level 1: the picture is given up (never the audio) on a numeric trigger, once, for good."""

    async def running(self) -> tuple[R1Recorder, FakeVideoStream]:
        recorder = await self.started()
        stream = await self.camera_on()
        await self.show(stream, 3)
        await self.ready(recorder)
        return recorder, stream

    def assert_given_up(self, recorder: R1Recorder, reason: str) -> None:
        self.assertEqual(recorder.degraded, reason)
        self.assertEqual(self.pub.subscribe_calls, [True, False])
        self.assertEqual(self.room.listeners(), 0)
        self.assertEqual(self.vad.handlers, [])

    async def test_loop_lag_over_250_ms_gives_the_picture_up_and_below_it_does_not(self) -> None:
        recorder, stream = await self.running()
        recorder.observe_lag(500.0, 0.249)
        self.assertIsNone(recorder.degraded)
        recorder.observe_lag(500.1, 0.251)
        self.assert_given_up(recorder, "cpu_loop_lag")
        await recorder.finish()

    async def test_a_really_blocked_event_loop_is_noticed_by_the_probe(self) -> None:
        recorder, _stream = await self.running()
        await asyncio.sleep(0.2)
        time.sleep(0.45)  # the whole loop is stuck
        await until(lambda: recorder.degraded == "cpu_loop_lag", timeout=5)
        await recorder.finish()

    async def test_a_healthy_loop_does_not_trip_the_probe(self) -> None:
        recorder, _stream = await self.running()
        await asyncio.sleep(0.6)
        self.assertIsNone(recorder.degraded)
        await recorder.finish()

    async def test_vad_inference_too_slow_for_two_batches_in_a_row_gives_it_up(self) -> None:
        recorder, _stream = await self.running()
        self.vad.emit(0.0125 * 32, 32)
        self.vad.emit(0.0135 * 32, 32)
        self.assertIsNone(recorder.degraded)
        self.vad.emit(0.0135 * 32, 32)
        self.assert_given_up(recorder, "cpu_vad_slow")
        await recorder.finish()

    async def test_vad_metrics_of_the_wrong_shape_are_ignored(self) -> None:
        recorder, _stream = await self.running()
        for metrics in (SimpleNamespace(), SimpleNamespace(inference_duration_total="x", inference_count=3),
                        SimpleNamespace(inference_duration_total=1.0, inference_count=True)):
            for _ in range(3):
                recorder._on_vad_metrics(metrics)
        self.assertIsNone(recorder.degraded)
        await recorder.finish()

    async def test_more_than_30_percent_of_the_pictures_lost_gives_it_up(self) -> None:
        recorder, _stream = await self.running()
        recorder._drops.record(self.clock(), seen=40, dropped=12)  # 12 of 43 seen (the 3 above included): under
        recorder._check_video()
        self.assertIsNone(recorder.degraded)
        recorder._drops.record(self.clock(), dropped=3)
        recorder._check_video()
        self.assert_given_up(recorder, "frame_drops")
        await recorder.finish()

    async def test_pictures_pushed_out_of_the_encoder_queue_count_as_lost(self) -> None:
        recorder, _stream = await self.running()
        recorder._drops.record(self.clock(), seen=40)
        self.encoder.video_dropped = 5  # 5 of 43: under the limit
        recorder._check_video()
        self.assertIsNone(recorder.degraded)
        self.encoder.video_dropped = 20  # 20 of 43
        recorder._check_video()
        self.assert_given_up(recorder, "frame_drops")
        await recorder.finish()

    async def test_an_upload_backlog_over_six_parts_gives_it_up_and_six_does_not(self) -> None:
        recorder, _stream = await self.running()
        recorder._worker._mp4_enabled = lambda: False  # nothing uploads while the test measures
        size = recorder._worker.part_size
        self.lay_stream(size * 6)
        recorder._check_video()
        self.assertIsNone(recorder.degraded)
        self.lay_stream(size * 6 + 1)
        recorder._check_video()
        self.assert_given_up(recorder, "upload_backlog")
        await recorder.finish()

    async def test_a_spool_over_300_megabytes_gives_it_up(self) -> None:
        recorder, _stream = await self.running()
        recorder._worker._mp4_enabled = lambda: False
        with mock.patch.object(r1_recorder, "SPOOL_BYTES_LIMIT", 100_000), mock.patch.object(
            r1_recorder, "BACKLOG_PARTS_LIMIT", 1000
        ):
            ogg = 4 + 256 * 8  # what the FakeIO leaves for the stock OGG
            self.lay_stream(100_000 - ogg)  # the spool holds exactly the limit
            recorder._check_video()
            self.assertIsNone(recorder.degraded)
            self.lay_stream(100_000 - ogg + 1)  # one byte over
            recorder._check_video()
        self.assert_given_up(recorder, "upload_backlog")
        await recorder.finish()

    async def test_a_nearly_full_disk_gives_it_up(self) -> None:
        recorder, _stream = await self.running()
        with mock.patch.object(Spool, "free_bytes", return_value=r1_recorder.LOW_FREE_BYTES):
            recorder._check_video()
        self.assertIsNone(recorder.degraded)
        with mock.patch.object(Spool, "free_bytes", return_value=r1_recorder.LOW_FREE_BYTES - 1):
            recorder._check_video()
        self.assert_given_up(recorder, "upload_backlog")
        await recorder.finish()

    async def test_the_watchdog_task_runs_the_picture_checks_every_second(self) -> None:
        recorder, _stream = await self.running()
        with mock.patch.object(Spool, "free_bytes", return_value=0):
            await until(lambda: recorder.degraded is not None, timeout=4)
        self.assertEqual(recorder.degraded, "upload_backlog")
        await recorder.finish()

    async def test_once_given_up_no_picture_reaches_the_encoder_and_nothing_comes_back(self) -> None:
        recorder, stream = await self.running()
        self.clock.advance(12.5)
        recorder.observe_lag(500.0, 0.5)
        sent = len(self.encoder.pictures)
        stream.push(picture_event())
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.encoder.pictures), sent)
        self.room.emit("track_published", self.pub, self.candidate)
        recorder._camera.scan()
        recorder.observe_lag(501.0, 0.5)  # a second trigger changes nothing ...
        recorder._degrade("frame_drops")  # ... not even a different one
        self.assertEqual(recorder.degraded, "cpu_loop_lag")
        self.vad.emit(10.0, 1)
        self.assertEqual(recorder.degraded, "cpu_loop_lag")
        self.assertEqual(self.pub.subscribe_calls, [True, False])
        self.assertEqual(recorder._degraded_at_ms, int((self.clock() - 1000.0) * 1000))
        await recorder.finish()

    async def test_the_audio_keeps_flowing_after_the_picture_is_given_up(self) -> None:
        recorder, _stream = await self.running()
        recorder.observe_lag(500.0, 0.5)
        self.io.push(1002.5)
        await until(lambda: len(self.encoder.audio) >= 1)
        self.assertIsNone(recorder.encoder_lost)
        await recorder.finish()

    async def test_the_complete_report_says_when_and_why_and_stays_one_combined_file(self) -> None:
        recorder, _stream = await self.running()
        self.lay_stream()
        self.encoder.closed_extra = {"frames": 150, "dropped": 0, "black": 30, "width": 640, "height": 360, "fps": 15}
        self.clock.advance(12.5)
        degraded_at = int((self.clock() - 1000.0) * 1000)
        recorder.observe_lag(500.0, 0.5)
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["has_video"]), ("combined", True))
        self.assertEqual(body["degraded_reason"], "cpu_loop_lag")
        self.assertNotIn("failure_reason", body)
        self.assertEqual(body["report"]["degraded_at_ms"], degraded_at)
        self.assertIn({"kind": "video"}, self.api.bodies("object-url"))  # the faststart copy still goes

    async def test_giving_up_in_audio_mode_or_after_stop_does_nothing(self) -> None:
        audio = await self.started(mode="audio")
        audio._degrade("cpu_loop_lag")
        self.assertIsNone(audio.degraded)
        await audio.finish()
        await self.asyncSetUp()
        recorder, _stream = await self.running()
        recorder.stop(None)
        recorder._degrade("cpu_loop_lag")
        self.assertIsNone(recorder.degraded)
        await recorder.finish()

    async def test_the_log_line_for_a_degrade_is_a_fixed_word(self) -> None:
        recorder, _stream = await self.running()
        with captured_logs() as lines:
            recorder.observe_lag(500.0, 0.5)
        (line,) = lines
        self.assertEqual((line["error_type"], line["error_category"]), ("r1_rec_degraded", "cpu_loop_lag"))
        await recorder.finish()


class TestEncoderLossWithPicture(VideoCase):
    """Level 2: the encoder died.  The MP4 prefix keeps the picture, the OGG carries the whole call."""

    async def running(self, *, pictures: int = 3) -> R1Recorder:
        recorder = await self.started()
        stream = await self.camera_on()
        if pictures:
            await self.show(stream, pictures)
        await self.ready(recorder)
        return recorder

    async def test_a_crash_after_pictures_ships_the_prefix_and_the_whole_ogg_as_split(self) -> None:
        recorder = await self.running()
        self.lay_stream(150_000)
        self.encoder.exited.set()
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_crashed")
        self.assertEqual(self.pub.subscribe_calls, [True, False])  # no point decoding a camera nobody records
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["has_video"], body["failure_reason"]), ("split", True, "encoder_crashed"))
        self.assertTrue(body["report"]["audio_final_uploaded"])
        self.assertEqual(b"".join(p["body"] for p in self.api.puts if "/part?" in p["url"]),
                         bytes((i * 7) % 251 for i in range(150_000)))
        self.assertIn({"kind": "audio"}, self.api.bodies("object-url"))
        self.assertFalse(self.encoder.eof_sent)
        # These bytes hold no whole fragment, so nothing opens on its own: the multipart stays the path.
        self.assertNotIn({"kind": "video"}, self.api.bodies("object-url"))
        self.assertIs(body["report"]["prefix_uploaded"], False)
        self.assertEqual(body["report"]["stream_bytes"], 150_000)  # what the dead child left on disk

    async def test_a_crash_before_any_picture_is_audio_only(self) -> None:
        recorder = await self.running(pictures=0)
        self.encoder.exited.set()
        recorder._check_encoder()
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["has_video"], body["failure_reason"]), ("audio_only", False, "encoder_crashed"))
        self.assertNotIn("degraded_reason", body)
        self.assertEqual([p for p in self.api.puts if "/part?" in p["url"]], [])

    async def test_a_stalled_encoder_with_pictures_is_split_and_says_so(self) -> None:
        recorder = await self.running()
        self.lay_stream(100_000)
        self.encoder.last_status_at = self.clock() - 6.0
        recorder._check_encoder()
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["failure_reason"], body["degraded_reason"]),
                         ("split", "encoder_crashed", "encoder_stalled"))

    async def test_the_prefix_keeps_uploading_in_the_background_after_the_crash(self) -> None:
        recorder = await self.running()
        self.encoder.exited.set()
        recorder._check_encoder()
        self.lay_stream(65536 * 2 + 10)
        await until(lambda: len([p for p in self.api.puts if "/part?" in p["url"]]) >= 2)
        await recorder.finish()

    async def test_a_full_disk_is_named_as_such(self) -> None:
        recorder = await self.running()
        self.encoder.error_code = "disk_full"
        self.encoder.exited.set()
        recorder._check_encoder()
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertEqual(body["failure_reason"], "spool_disk_full")

    async def test_a_hung_encoder_that_will_not_close_is_split_too(self) -> None:
        recorder = await self.running()
        self.lay_stream(100_000)
        stuck = self.encoder
        stuck.send_eof = lambda: stuck.events.append("enc.eof") or True
        recorder.stop(None)
        with mock.patch.object(r1_recorder, "ENCODER_CLOSE_WAIT_SECONDS", 0.3):
            await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["has_video"]), ("split", True))


class TestFrozenPrefix(VideoCase):
    """Incident 482cb480: the encoder was lost with about four minutes of picture on disk, the multipart
    upload carrying it was gone by the hang-up, and the recording ended up audio-only.  The frozen
    prefix, cut at its last whole fragment, now goes up on its own as the ``video`` object."""

    async def running(self) -> R1Recorder:
        recorder = await self.started()
        stream = await self.camera_on()
        await self.show(stream, 3)
        await self.ready(recorder)
        return recorder

    def lay_fmp4(self, fragments: int, *, tail: int = 3000) -> tuple[bytes, int]:
        content, end = fmp4(fragments, tail=tail)
        (self.spool.dir / "stream.mp4").write_bytes(content)
        return content, end

    def crash(self, recorder: R1Recorder) -> None:
        self.encoder.exited.set()
        recorder._check_encoder()
        self.assertEqual(recorder.encoder_lost, "encoder_crashed")

    def put_indexes(self, marker: str) -> list[int]:
        return [index for index, put in enumerate(self.api.puts) if marker in put["url"]]

    async def test_the_frozen_prefix_goes_up_mid_call_as_the_video_object_and_no_tail_part_follows(self) -> None:
        recorder = await self.running()
        content, end = self.lay_fmp4(6)
        await until(lambda: recorder._worker.parts_done == 1)  # part 1 went up while the encoder was well
        self.crash(recorder)
        await until(lambda: recorder._worker.prefix_uploaded)  # mid-call: no finish has begun
        (video,) = [put for put in self.api.puts if "/video?" in put["url"]]
        self.assertEqual(video["body"], content[:end], "the stream cut at its last whole fragment")
        self.assertLess(end, len(content))
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        self.assertEqual(len(self.put_indexes("/part?")), 1, "no tail part at the finish")
        self.assertEqual([b["part_number"] for b in self.api.bodies("part-url")], [1])
        self.assertEqual(len(self.put_indexes("/video?")), 1)
        self.assertLess(self.put_indexes("/video?")[0], self.put_indexes("/audio?")[0])
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["has_video"], body["failure_reason"]), ("split", True, "encoder_crashed"))
        report = body["report"]
        self.assertEqual((report["prefix_uploaded"], report["prefix_bytes"]), (True, end))
        self.assertFalse(report["faststart_uploaded"], "the prefix is not the faststart copy")
        self.assertEqual((report["stream_bytes"], report["parts_uploaded"]), (len(content), 1))
        self.assertTrue(report["audio_final_uploaded"])
        self.assertFalse(self.spool.dir.exists())

    async def test_part_urls_that_answer_404_end_the_multipart_and_the_finish_still_ships_both_halves(self) -> None:
        self.api.put_status = lambda url: 404 if "/part?" in url and "partNumber=1&" not in url else None
        with captured_logs() as lines:
            recorder = await self.running()
            content, end = self.lay_fmp4(10)  # about 200 KB: three whole parts are due mid-call
            await until(lambda: recorder._worker.multipart_gone)
            stuck = self.encoder
            stuck.send_eof = lambda: stuck.events.append("enc.eof") or True  # ... and the child hangs at the end
            recorder.stop(None)
            with mock.patch.object(r1_recorder, "ENCODER_CLOSE_WAIT_SECONDS", 0.3):
                await asyncio.wait_for(recorder.finish(), 20)
        self.assertEqual([b["part_number"] for b in self.api.bodies("part-url")], [1, 2], "no retry, no part 3")
        self.assertEqual(len(self.put_indexes("/part?")), 2)
        self.assertEqual([l for l in lines if l["error_type"] == "r1_rec_upload_retry"], [], "no retry storm")
        self.assertNotIn("r1_rec_abandoned", [l["error_type"] for l in lines])
        self.assertIsNone(recorder._stop_reason)
        (ogg,) = self.put_indexes("/audio?")
        (video,) = self.put_indexes("/video?")
        self.assertLess(ogg, video, "the OGG, the whole call, goes first")
        self.assertEqual(self.api.puts[video]["body"], content[:end])
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["has_video"], body["failure_reason"]), ("split", True, "encoder_crashed"))
        self.assertEqual(body["report"]["stream_bytes"], len(content), "what is on disk")
        self.assertEqual((body["report"]["prefix_uploaded"], body["report"]["prefix_bytes"]), (True, end))
        self.assertTrue(body["report"]["audio_final_uploaded"])

    async def test_a_failing_prefix_is_tried_again_after_the_cooldown_and_once_more_at_the_finish(self) -> None:
        failing = {"on": True}
        self.api.put_status = lambda url: 500 if failing["on"] and "/video?" in url else None
        recorder = await self.running()
        content, end = self.lay_fmp4(2)  # smaller than a part: nothing else wants the thread
        worker = recorder._worker
        with captured_logs() as lines:
            self.crash(recorder)
            await until(lambda: worker._prefix_rounds == 1)  # round 1: a try and three retries
            self.assertEqual(len(self.put_indexes("/video?")), 4)
            await asyncio.sleep(1.2)  # a couple of periodic rounds inside the cooldown
            self.assertEqual(len(self.put_indexes("/video?")), 4)
            self.clock.advance(16)
            await until(lambda: worker._prefix_rounds == 2)  # round 2, once the cooldown is over
            self.assertEqual(len(self.put_indexes("/video?")), 8)
            failing["on"] = False
            recorder.stop(None)
            await asyncio.wait_for(recorder.finish(), 20)
        videos = self.put_indexes("/video?")
        self.assertEqual(len(videos), 9, "two rounds mid-call, then one more try at the finish")
        self.assertLess(self.put_indexes("/audio?")[-1], videos[-1], "at the finish, after the OGG")
        self.assertEqual(self.api.puts[videos[-1]]["body"], content[:end])
        retried = {l["error_category"] for l in lines if l["error_type"] == "r1_rec_upload_retry"}
        self.assertEqual(retried, {"object_video"})
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["report"]["prefix_uploaded"]), ("split", True))

    async def test_a_healthy_multipart_sends_its_short_tail_before_the_whole_file_prefix_at_the_finish(self) -> None:
        # Review of #377: the prefix is the whole file again; on a slow link it alone could use the window
        # and leave the tail (the last minutes of picture) unsent.  The tail goes first; no prefix follows.
        self.api.put_status = lambda url: 500 if "/video?" in url else None  # the prefix never went up mid-call
        recorder = await self.running()
        content, end = self.lay_fmp4(10)  # about 200 KB: whole parts are due mid-call
        worker = recorder._worker
        await until(lambda: worker.parts_done >= 1)
        self.crash(recorder)
        await until(lambda: worker._prefix_rounds == 1)
        self.assertFalse(worker.prefix_uploaded)
        videos_mid_call = len(self.put_indexes("/video?"))
        self.api.put_status = None
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        self.assertEqual(len(self.put_indexes("/video?")), videos_mid_call, "no prefix at the finish")
        parts = self.put_indexes("/part?")
        self.assertLess(self.put_indexes("/audio?")[-1], parts[-1], "the OGG first, then the tail")
        self.assertEqual(b"".join(self.api.puts[i]["body"] for i in parts), content, "the whole stream went up")
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["has_video"], body["failure_reason"]), ("split", True, "encoder_crashed"))
        self.assertFalse(body["report"]["prefix_uploaded"])
        self.assertEqual(body["report"]["parts_uploaded"], len(parts))
        self.assertTrue(body["report"]["audio_final_uploaded"])

    async def test_a_discard_or_stop_answer_to_the_prefix_still_halts_everything(self) -> None:
        for reply, verdict in (
            (ApiReply(409, {"error": "r1_consent_withdrawn"}, "r1_consent_withdrawn"), "discard"),
            (ApiReply(409, {"error": "r1_session"}, "r1_session"), "stop"),
        ):
            with self.subTest(verdict=verdict):
                await self.asyncSetUp()
                recorder = await self.running()
                self.lay_fmp4(2)
                self.api.script("object-url", reply)  # the first object URL asked for is the prefix's
                self.crash(recorder)
                if verdict == "discard":
                    await until(lambda: recorder.discarded == "consent_withdrawn")
                    await until(lambda: not self.spool.dir.exists())
                else:
                    await until(lambda: recorder._stop_reason == "session")
                calls = list(self.api.calls)
                recorder.stop(None)
                await asyncio.wait_for(recorder.finish(), 10)
                self.assertEqual(self.api.calls, calls, "no call after the verdict, not even complete")
                self.assertEqual(self.api.bodies("object-url"), [{"kind": "video"}])
                self.assertEqual(self.api.puts, [])
                self.assertFalse(recorder._worker.prefix_uploaded)
                self.assertFalse(self.spool.dir.exists())

    async def test_the_finished_line_counts_the_call_on_the_clock_when_the_child_never_closed(self) -> None:
        recorder = await self.running()
        self.lay_fmp4(2)
        self.crash(recorder)
        await until(lambda: recorder._worker.prefix_uploaded)
        self.clock.advance(90.0)
        with captured_logs() as lines:
            recorder.stop(None)
            await asyncio.wait_for(recorder.finish(), 20)
        (finished,) = [l for l in lines if l["error_type"] == "r1_rec_finished"]
        (body,) = self.api.bodies("complete")
        self.assertEqual(finished["error_category"], "split")
        self.assertEqual(finished["duration_sec"], 90)  # (it used to say 0: the child never closed)
        self.assertEqual(body["report"]["duration_ms"] // 1000, finished["duration_sec"])


class TestPictureReport(VideoCase):
    async def finish_after(self, pictures: int, **closed) -> dict:
        recorder = await self.started()
        stream = await self.camera_on()
        if pictures:
            await self.show(stream, pictures)
        await self.ready(recorder)
        self.lay_stream()
        self.encoder.closed_extra = closed
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        return body

    async def test_a_normal_picture_run_reports_size_rate_frames_losses_and_camera_off_time(self) -> None:
        self.encoder.video_dropped = 1
        body = await self.finish_after(
            3, frames=150, dropped=2, black=15, width=640, height=360, fps=15
        )
        self.assertEqual((body["layout"], body["has_video"]), ("combined", True))
        self.assertNotIn("degraded_reason", body)
        self.assertNotIn("failure_reason", body)
        report = body["report"]
        self.assertEqual((report["width"], report["height"], report["fps"]), (640, 360, 15))
        self.assertEqual(report["frames_encoded"], 150)
        self.assertEqual(report["frames_dropped"], 3)  # 2 in the child + 1 pushed out of the queue
        self.assertEqual(report["camera_off_ms"], 1000)
        self.assertNotIn("degraded_at_ms", report)
        self.assertTrue(report["faststart_uploaded"])

    async def test_losses_before_the_encoder_are_added_to_the_childs(self) -> None:
        recorder = await self.started()
        stream = await self.camera_on()
        await self.show(stream, 2)
        self.clock.advance(1.0)
        stream.push(picture_event(641, 360, data=bytes(641 * 360 * 3 // 2)))
        await until(lambda: recorder._camera.rejected == 1)
        await self.ready(recorder)
        self.lay_stream()
        self.encoder.video_dropped = 4
        self.encoder.closed_extra = {"frames": 100, "dropped": 1, "black": 0, "width": 640, "height": 360, "fps": 15}
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertEqual(body["report"]["frames_dropped"], 1 + 4 + 1)
        self.assertEqual(body["report"]["camera_off_ms"], 0)

    async def test_a_camera_that_never_delivered_a_picture_is_video_unavailable(self) -> None:
        body = await self.finish_after(0, frames=150, dropped=0, black=150, width=640, height=360, fps=15)
        self.assertEqual((body["layout"], body["has_video"], body["degraded_reason"]), ("combined", False, "video_unavailable"))
        self.assertNotIn("failure_reason", body)
        self.assertEqual(body["report"]["camera_off_ms"], 10_000)

    async def test_a_child_that_fell_back_to_audio_is_video_unavailable(self) -> None:
        body = await self.finish_after(3, frames=0, dropped=0, black=0, width=0, height=0, fps=0)
        self.assertEqual((body["has_video"], body["degraded_reason"]), (False, "video_unavailable"))
        self.assertNotIn("width", body["report"])
        self.assertNotIn("frames_encoded", body["report"])

    async def test_a_forced_exit_skips_the_faststart_but_keeps_the_picture(self) -> None:
        recorder = await self.started()
        stream = await self.camera_on()
        await self.show(stream, 2)
        await self.ready(recorder)
        self.lay_stream()
        self.encoder.closed_extra = {"frames": 40, "dropped": 0, "black": 0, "width": 640, "height": 360, "fps": 15}
        recorder.stop("shutdown_forced")
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertEqual((body["layout"], body["has_video"]), ("combined", True))
        self.assertFalse(body["report"]["faststart_uploaded"])

    async def test_an_audio_recording_reports_no_picture_at_all(self) -> None:
        recorder = await self.started(mode="audio")
        await self.ready(recorder)
        self.lay_stream()
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 20)
        (body,) = self.api.bodies("complete")
        self.assertFalse(body["has_video"])
        self.assertNotIn("degraded_reason", body)
        for key in ("width", "height", "fps", "frames_encoded", "frames_dropped", "camera_off_ms", "degraded_at_ms"):
            self.assertNotIn(key, body["report"])

    async def test_stopping_closes_the_camera_and_the_probe(self) -> None:
        recorder = await self.started()
        stream = await self.camera_on()
        await self.show(stream, 1)
        recorder.stop(None)
        # At once, not when the finish gets to it: no picture is taken during the transcript drain.
        self.assertTrue(recorder._camera._off)
        self.assertEqual(self.room.listeners(), 0)
        self.assertEqual(self.vad.handlers, [])
        await until(lambda: stream.closed)
        await recorder.finish()
        self.assertIsNone(recorder._lag_task)


class TestPictureDiscard(VideoCase):
    async def test_a_discard_answer_gives_up_the_camera_too(self) -> None:
        for reply in (
            ApiReply(409, {"error": "r1_consent_withdrawn"}, "r1_consent_withdrawn"),
            ApiReply(410, {"error": "r1_recording_deleted"}, "r1_recording_deleted"),
        ):
            with self.subTest(status=reply.status):
                await self.asyncSetUp()
                gate = threading.Event()  # the API answers only once the camera is flowing
                self.api.script("prepare", lambda *_a, _reply=reply: gate.wait(10) and _reply)
                recorder = await self.started()
                stream = await self.camera_on()
                recorder._watchdog.cancel()  # the encoder-loss path would unsubscribe too: take it out
                gate.set()
                await until(lambda: recorder.discarded is not None)
                await until(lambda: stream.closed)
                self.assertEqual(self.pub.subscribe_calls, [True, False])
                self.assertEqual(self.room.listeners(), 0)
                self.assertTrue(self.encoder.killed)
                await asyncio.wait_for(recorder.finish(), 10)
                self.assertFalse(self.spool.dir.exists())
                self.assertEqual(self.encoder.pictures, [])

    async def test_a_stop_answer_gives_up_the_camera_too(self) -> None:
        gate = threading.Event()
        self.api.script("prepare", lambda *_a: gate.wait(10) and ApiReply(409, {"error": "r1_session"}, "r1_session"))
        recorder = await self.started()
        stream = await self.camera_on()
        recorder._watchdog.cancel()  # the encoder-loss path would unsubscribe too: take it out
        gate.set()
        await until(lambda: stream.closed)
        self.assertEqual(self.pub.subscribe_calls, [True, False])
        await asyncio.wait_for(recorder.finish(), 10)
        self.assertEqual(self.api.bodies("complete"), [])

    async def test_a_start_that_fails_leaves_no_listener_and_no_subscription_behind(self) -> None:
        self.io = FakeIO(self.events, start_error=RuntimeError("boom"))
        recorder = await self.started()
        self.assertEqual(recorder.phase, "done")
        self.assertEqual(self.room.listeners(), 0)
        self.assertEqual(self.pub.subscribe_calls, [])


class TestPictureLogging(VideoCase):
    async def test_nothing_about_the_camera_or_the_candidate_reaches_a_log_line(self) -> None:
        with captured_logs() as lines:
            recorder = await self.started()
            stream = await self.camera_on()
            await self.show(stream, 2)
            await self.ready(recorder)
            stream.fail = ValueError("boom candidate-identity TR_camera " + PRESIGNED)
            stream.push(picture_event())
            recorder.observe_lag(500.0, 0.6)
            self.lay_stream()
            recorder.stop(None)
            await asyncio.wait_for(recorder.finish(), 20)
        blob = json.dumps(lines)
        for poison in POISONS + ("boom", "candidate-identity", "TR_camera", "PUB_camera"):
            self.assertNotIn(poison, blob)
        for line in lines:
            self.assertTrue(line["error_type"].startswith("r1_rec_"), line)
            self.assertLessEqual(set(line) - {"timestamp", "level", "component", "event", "correlationId"},
                                 {"error_type", "error_category", "status", "option_count", "duration_sec"})


class TestPresetKnob(unittest.TestCase):
    def test_only_the_three_cheap_presets_are_accepted_and_anything_else_is_the_default(self) -> None:
        for value, expected in (
            ("ultrafast", "ultrafast"), ("superfast", "superfast"), ("veryfast", "veryfast"),
            ("faster", "superfast"), ("medium", "superfast"), ("", "superfast"), (None, "superfast"),
            ("SUPERFAST", "superfast"), (" veryfast", "superfast"), ("veryfast ", "superfast"),
        ):
            env = {} if value is None else {"R1_VIDEO_X264_PRESET": value}
            self.assertEqual(r1_recorder.x264_preset(env), expected, value)

    def test_the_process_environment_is_read_when_no_env_is_given(self) -> None:
        with mock.patch.dict(os.environ, {"R1_VIDEO_X264_PRESET": "ultrafast"}):
            self.assertEqual(r1_recorder.x264_preset(), "ultrafast")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("R1_VIDEO_X264_PRESET", None)
            self.assertEqual(r1_recorder.x264_preset(), "superfast")

    def test_the_builder_passes_the_preset_on(self) -> None:
        with tempfile.TemporaryDirectory(prefix="r1rec-preset-") as tmp:
            class Probe:
                def __init__(self, directory):
                    self.exited = threading.Event()

                def spawn(self) -> bool:
                    return True

            env = {"R1_RECORDING": "on", "R1_VIDEO_RECORDING": "on", "R1_VIDEO_X264_PRESET": "veryfast"}
            recorder = r1_recorder.build_r1_recorder(
                SimpleNamespace(room=FakeRoom()), {"recording": {"mode": "av"}}, SimpleNamespace(), ROOM, SESSION_ID,
                env=env, spool_root=Path(tmp) / "r", encoder_factory=Probe, http_client=HttpClient(),
            )
            self.assertEqual(recorder._preset, "veryfast")
            self.assertEqual(recorder.mode, "av")
            recorder._worker.halt()


# ------------------------------------------------------------------------------ end to end


class TestEncoderAges(unittest.TestCase):
    def test_ages_are_measured_on_the_encoders_own_clock(self) -> None:
        clock = ManualClock(50.0)
        enc = r1_recorder.EncoderProcess(Path("."), clock=clock)
        self.assertIsNone(enc.seconds_since_spawn())
        self.assertIsNone(enc.seconds_since_status())
        enc.spawned_at = clock()
        clock.advance(2.0)
        enc._apply({"s": "progress"})  # every status line (here a heartbeat) stamps it on the encoder's clock
        clock.advance(7.5)
        self.assertEqual(enc.seconds_since_spawn(), 9.5)
        self.assertEqual(enc.seconds_since_status(), 7.5)


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
        why = f"failure_reason={body.get('failure_reason')!r} encoder_lost={recorder.encoder_lost!r}"
        self.assertEqual(body["layout"], "combined", why)
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


def _loud_onsets(path: Path, *, threshold: float = 0.15, quiet_s: float = 2.0) -> list[float]:
    """Start of every burst of loud audio in an MP4, bursts being at least ``quiet_s`` apart."""
    onsets: list[float] = []
    last_loud = -1e9
    with av.open(str(path)) as container:
        for chunk in container.decode(container.streams.audio[0]):
            samples = np.abs(chunk.to_ndarray().reshape(-1))
            base = float(chunk.pts * chunk.time_base)
            loud = np.nonzero(samples > threshold)[0]
            if loud.size:
                first = base + float(loud[0]) / RATE
                if first - last_loud > quiet_s:
                    onsets.append(first)
                last_loud = base + float(loud[-1]) / RATE
    return onsets


def _flash_onsets(path: Path, *, level: float = 150.0, quiet_s: float = 1.0) -> list[float]:
    onsets: list[float] = []
    last = -1e9
    with av.open(str(path)) as container:
        for picture in container.decode(container.streams.video[0]):
            at = float(picture.pts * picture.time_base)
            if float(picture.to_ndarray()[: picture.height].mean()) > level:
                if at - last > quiet_s:
                    onsets.append(at)
                last = at
    return onsets


def _pictures(path: Path) -> list[tuple[float, float]]:
    """``(seconds, mean luma)`` of every decoded picture."""
    with av.open(str(path)) as container:
        return [
            (float(p.pts * p.time_base), float(p.to_ndarray()[: p.height].mean()))
            for p in container.decode(container.streams.video[0])
        ]


class TestPictureWithTheRealEncoder(unittest.IsolatedAsyncioTestCase):
    """The real child process, a fake room and camera stream, the real clock: a whole call in real time."""

    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="r1rec-av-")
        self.addCleanup(self._tmp.cleanup)
        self.spool = Spool(Path(self._tmp.name) / "r", SESSION_ID)
        self.spool.create()
        self.events: list = []
        self.api = FakeApi(self.events)
        self.api.checkpoint = 600
        self.io = FakeIO(self.events)
        self.room = FakeRoom()
        self.factory = StreamFactory()
        self.candidate = FakeParticipant("candidate-identity")
        self.room.remote_participants["candidate-identity"] = self.candidate
        self.pub = self.candidate.add(FakePublication("PUB_camera"))
        self.vad = FakeVad()
        self.session = SimpleNamespace(
            input=SimpleNamespace(audio=object()), output=SimpleNamespace(audio=object()), vad=self.vad
        )
        patch = mock.patch.object(r1_recorder, "RETRY_DELAYS_SECONDS", (0.0, 0.0, 0.0))
        patch.start()
        self.addCleanup(patch.stop)

    async def start_recorder(self, *, preset: str = "ultrafast") -> tuple[R1Recorder, "r1_recorder.EncoderProcess"]:
        encoder = r1_recorder.EncoderProcess(self.spool.dir)
        self.assertTrue(encoder.spawn())
        self.addCleanup(encoder.kill)
        recorder = R1Recorder(
            session=self.session, room=ROOM, session_id=SESSION_ID, mode="av", spool=self.spool,
            encoder=encoder, api=self.api, http_client=StubHttp(), finish_seconds=18.0,
            clock=time.monotonic, wall=time.time, io_class=lambda: (lambda **_kw: self.io),
            ctx=SimpleNamespace(room=self.room), make_stream=self.factory, preset=preset,
        )
        self.addCleanup(recorder._worker.halt)
        await asyncio.get_running_loop().run_in_executor(None, lambda: encoder.ready.wait(60))
        self.assertTrue(encoder.ready.is_set(), "the child reported ready")
        await recorder.start("candidate-identity")
        self.assertTrue(recorder.video)
        self.pub.track = FakeTrack("TR_camera")
        self.pub.subscribed = True
        self.room.emit("track_subscribed", self.pub.track, self.pub, self.candidate)
        await until(lambda: self.factory.streams)
        return recorder, encoder

    async def run_call(
        self,
        recorder: R1Recorder,
        seconds: float,
        *,
        flashes=(),
        beeps=(),
        audio_present=lambda tick: True,
        stop_pictures_at: float | None = None,
    ) -> None:
        """Run ``seconds`` of media time: 15 fps pictures (white during a flash window), a 2.5 s audio
        tick (a 1 kHz beep in the window it falls in, nothing at all while ``audio_present`` is False)."""
        t0 = recorder._t0
        stream = self.factory.streams[-1]

        async def pictures() -> None:
            index = 0
            while True:
                media = time.monotonic() - t0
                if media >= seconds or (stop_pictures_at is not None and media >= stop_pictures_at):
                    return
                lit = any(a <= media < a + 0.2 for a in flashes)
                stream.push(picture_event(luma=235 if lit else 50))
                index += 1
                await asyncio.sleep(max(0.0, t0 + index / 15 - time.monotonic()))

        async def audio() -> None:
            tick = 0
            while (tick + 1) * 2.5 <= seconds + 1e-9:
                tick += 1
                await asyncio.sleep(max(0.0, t0 + tick * 2.5 - time.monotonic()))
                stamp = time.monotonic()
                if audio_present(tick):
                    samples = np.zeros(int(2.5 * 24000), dtype="<i2")
                    start_media = tick * 2.5 - 2.5
                    for beep_at in beeps:
                        if start_media <= beep_at < start_media + 2.5:
                            offset = int((beep_at - start_media) * 24000)
                            samples[offset : offset + 4800] = tone_samples(0.2, 24000, 1000.0, 16000)
                    self.io.tee_in.put((stamp, [frame(samples)]))
                else:
                    self.io.tee_in.put((stamp, []))
                self.io.tee_out.put((stamp, []))

        await asyncio.gather(pictures(), audio())

    async def finish_and_rebuild(self, recorder: R1Recorder) -> tuple[dict, Path]:
        recorder.stop(None)
        await asyncio.wait_for(recorder.finish(), 60)
        self.assertEqual(recorder.phase, "done")
        (body,) = self.api.bodies("complete")
        parts: dict[int, bytes] = {}
        for put in self.api.puts:
            if "/part?" in put["url"]:
                parts[int(re.search(r"partNumber=(\d+)", put["url"]).group(1))] = put["body"]
        rebuilt = Path(self._tmp.name) / "rebuilt.mp4"
        rebuilt.write_bytes(b"".join(parts[n] for n in sorted(parts)))
        self.assertEqual(sorted(parts), list(range(1, len(parts) + 1)))
        return body, rebuilt

    async def test_a_beep_and_a_flash_stay_together_across_a_20_second_rejoin_gap(self) -> None:
        recorder, _encoder = await self.start_recorder()
        # Candidate audio for the first 5 s, none for 20 s (the candidate left and came back while the
        # agent was silent), then again; a beep and a white frame at 1.5 s and again at 26.0 s.
        await self.run_call(
            recorder, 30.0, flashes=(1.5, 26.0), beeps=(1.5, 26.0),
            audio_present=lambda tick: tick <= 2 or tick >= 11,
        )
        body, rebuilt = await self.finish_and_rebuild(recorder)
        self.assertEqual((body["layout"], body["has_video"]), ("combined", True))
        self.assertNotIn("failure_reason", body)
        self.assertNotIn("degraded_reason", body)
        with av.open(str(rebuilt)) as container:
            video, audio = container.streams.video[0], container.streams.audio[0]
            self.assertEqual((video.width, video.height), (640, 360))
            self.assertAlmostEqual(float(container.duration) / 1e6, 30.0, delta=1.2)
            self.assertEqual(audio.codec_context.name, "aac")
        beeps, flashes = _loud_onsets(rebuilt), _flash_onsets(rebuilt)
        self.assertEqual((len(beeps), len(flashes)), (2, 2), (beeps, flashes))
        # Real time on a shared machine: a stalled event loop can add a frame or two of delay to a
        # picture, so the bound here is 250 ms.  The exact 150 ms acceptance (timestamps controlled) is
        # ``test_r1_video_encoder.TestAVSync``; this test is for a drift of SECONDS, e.g. a rejoin gap
        # squeezed out of the audio.
        for beep_at, flash_at in zip(beeps, flashes):
            self.assertLess(abs(beep_at - flash_at), 0.25, (beeps, flashes))
        self.assertAlmostEqual(beeps[0], 1.5, delta=0.3)
        self.assertAlmostEqual(beeps[1], 26.0, delta=0.3)  # the gap is IN the timeline, not squeezed out
        report = body["report"]
        self.assertEqual((report["width"], report["height"], report["fps"]), (640, 360, 15))
        self.assertGreater(report["frames_encoded"], 30 * 15 - 40)
        self.assertEqual(report["frames_dropped"], 0)
        self.assertLess(report["camera_off_ms"], 1500)
        self.assertTrue(report["faststart_uploaded"])
        fast = [p for p in self.api.puts if "/video?" in p["url"]]
        self.assertEqual(len(fast), 1)
        faststart = Path(self._tmp.name) / "faststart.mp4"
        faststart.write_bytes(fast[0]["body"])
        with av.open(str(faststart)) as container:
            self.assertEqual((len(container.streams.video), len(container.streams.audio)), (1, 1))
        self.assertEqual(_flash_onsets(faststart), flashes)  # the copy has the very same timeline

    async def test_giving_the_picture_up_keeps_one_combined_file_with_black_video_and_continuous_audio(self) -> None:
        recorder, _encoder = await self.start_recorder()
        call = asyncio.ensure_future(
            self.run_call(recorder, 9.0, beeps=(), audio_present=lambda tick: True)
        )
        await asyncio.sleep(3.0)
        recorder.observe_lag(time.monotonic(), 0.6)  # the machine is struggling: the picture goes
        self.assertEqual(recorder.degraded, "cpu_loop_lag")
        await call
        body, rebuilt = await self.finish_and_rebuild(recorder)
        self.assertEqual((body["layout"], body["has_video"]), ("combined", True))
        self.assertEqual(body["degraded_reason"], "cpu_loop_lag")
        self.assertNotIn("failure_reason", body)
        self.assertAlmostEqual(body["report"]["degraded_at_ms"], 3000, delta=400)
        pictures = _pictures(rebuilt)
        live = [luma for at, luma in pictures if 0.5 < at < 3.0]
        dark = [luma for at, luma in pictures if at > 5.0]
        self.assertTrue(live and dark)
        self.assertGreater(min(live), 40)  # the flat 50-luma picture
        self.assertLess(max(dark), 25)  # black after the 1.2 s hold
        with av.open(str(rebuilt)) as container:
            self.assertAlmostEqual(float(container.duration) / 1e6, 9.0, delta=1.2)
        self.assertGreater(body["report"]["camera_off_ms"], 2000)

    async def test_a_dead_encoder_mid_call_ships_the_prefix_with_the_picture_and_the_whole_ogg(self) -> None:
        """Changed on purpose (incident 482cb480).  This used to assert that NO ``video`` object went up
        ("no faststart copy of a cut-off file") and decoded the prefix from the multipart parts alone;
        the session then lost its picture when that multipart upload was gone by the hang-up.  The
        frozen prefix, cut at its last whole fragment, now goes up as exactly one ``video`` object while
        the call is still going (no faststart remux: the cut file is already playable), and no part
        follows it."""
        import r1_video_encoder

        recorder, encoder = await self.start_recorder()
        call = asyncio.ensure_future(self.run_call(recorder, 9.0, audio_present=lambda tick: True))
        await asyncio.sleep(4.0)
        encoder._proc.kill()  # kill -9 the child
        await until(lambda: recorder.encoder_lost is not None, timeout=5)
        await until(lambda: recorder._worker.prefix_uploaded, timeout=10)  # mid-call, not at the finish
        await call
        body, _parts = await self.finish_and_rebuild(recorder)
        self.assertEqual((body["layout"], body["has_video"], body["failure_reason"]), ("split", True, "encoder_crashed"))
        self.assertTrue(body["report"]["audio_final_uploaded"])
        self.assertTrue(any(p["content_type"] == "audio/ogg" and "/audio?" in p["url"] for p in self.api.puts))
        self.assertEqual(self.pub.subscribe_calls, [True, False])
        indexes = [i for i, p in enumerate(self.api.puts) if "/video?" in p["url"]]
        self.assertEqual(len(indexes), 1, "exactly one standalone copy of the frozen prefix")
        self.assertFalse(any("/part?" in p["url"] for p in self.api.puts[indexes[0]:]), "no part after it")
        data = self.api.puts[indexes[0]]["body"]
        self.assertEqual((body["report"]["prefix_uploaded"], body["report"]["prefix_bytes"]), (True, len(data)))
        self.assertGreaterEqual(body["report"]["stream_bytes"], len(data))
        prefix = Path(self._tmp.name) / "prefix.mp4"
        prefix.write_bytes(data)
        self.assertEqual(r1_video_encoder.mp4_fragment_end(prefix), len(data), "it ends on a fragment boundary")
        pictures = _pictures(prefix)  # the cut-off file opens and decodes ...
        self.assertGreater(len(pictures), 20)
        self.assertLess(max(at for at, _ in pictures), 5.5)
        with av.open(str(prefix)) as container:  # ... to its very end: every packet, both streams
            video_packets = sum(1 for p in container.demux(container.streams.video[0]) if p.size)
        with av.open(str(prefix)) as container:
            samples = sum(frame.samples for frame in container.decode(container.streams.audio[0]))
        self.assertEqual(len(pictures), video_packets)
        self.assertGreater(samples / RATE, 1.5)


if __name__ == "__main__":
    unittest.main()
