"""R1 recording: the encoder process (``r1_video_encoder``), against the real PyAV.

Covers the wire protocol (framing, malformed input, status lines), the start-up self-test, the
audio spool (a fragmented MP4 that only ever grows, survives ``kill -9`` and copy-remuxes to a
faststart file) and the real child process end to end (HELLO, AUDIO, EOF, REMUX, QUIT, stdin EOF,
heartbeat, refusals).

The bare-python CI step has neither ``av`` nor ``numpy``; this module then skips itself.  The R1
SDK step (``quality.yml``) installs both and fails on any skip, so a skip there is a failure.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

try:
    import av
    import numpy as np
except ImportError as exc:  # bare python: nothing to test without the media stack
    raise unittest.SkipTest("PyAV/numpy are not installed (bare python CI step)") from exc

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_video_encoder as enc

RATE = 48000


def tone(seconds: float, freq: float = 440.0, amplitude: int = 8000, offset_s: float = 0.0) -> np.ndarray:
    count = int(round(seconds * RATE))
    t = (np.arange(count) + int(round(offset_s * RATE))) / RATE
    return (np.sin(2 * np.pi * freq * t) * amplitude).astype("<i2")


def top_level_boxes(data: bytes) -> list[str]:
    boxes: list[str] = []
    pos = 0
    while pos + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[pos : pos + 8])
        boxes.append(kind.decode("latin1"))
        if size == 0:
            break
        if size == 1:
            size = struct.unpack(">Q", data[pos + 8 : pos + 16])[0]
        if size < 8:
            break
        pos += size
    return boxes


def decode(path: Path) -> tuple[np.ndarray, float, "av.AudioStream"]:
    container = av.open(str(path))
    try:
        stream = container.streams.audio[0]
        chunks = []
        for frame in container.decode(stream):
            chunks.append(frame.to_ndarray().reshape(-1))
        pcm = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
        duration = float(container.duration) / 1_000_000 if container.duration else 0.0
        return pcm, duration, stream
    finally:
        container.close()


def dominant_frequency(pcm: np.ndarray, start_s: float, length_s: float = 1.0) -> float:
    window = pcm[int(start_s * RATE) : int((start_s + length_s) * RATE)].astype(np.float64)
    spectrum = np.abs(np.fft.rfft(window * np.hanning(len(window))))
    return float(np.argmax(spectrum)) * RATE / len(window)


class ChildHarness:
    """The real ``python -m r1_video_encoder`` process with its status lines collected."""

    def __init__(self, spool: Path) -> None:
        self.spool = spool
        self.lines: list[tuple[float, bytes]] = []
        self.statuses: list[dict] = []
        self._cond = threading.Condition()
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "r1_video_encoder", str(spool)],
            cwd=str(HERE),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        for raw in iter(self.proc.stdout.readline, b""):
            with self._cond:
                self.lines.append((time.monotonic(), raw))
                parsed = enc.parse_status(raw)
                if parsed is not None:
                    self.statuses.append(parsed)
                self._cond.notify_all()

    def send(self, frame: bytes) -> None:
        self.proc.stdin.write(frame)
        self.proc.stdin.flush()

    def wait_for(self, kind: str, timeout: float = 60.0, start: int = 0) -> dict:
        end = time.monotonic() + timeout
        with self._cond:
            while True:
                for status in self.statuses[start:]:
                    if status["s"] == kind:
                        return status
                remaining = end - time.monotonic()
                if remaining <= 0:
                    raise AssertionError(f"no {kind!r} status; got {self.statuses}")
                self._cond.wait(remaining)

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(timeout=10)
        for stream in (self.proc.stdin, self.proc.stdout):
            try:
                stream.close()
            except OSError:
                pass


class SpoolCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="r1enc-test-")
        self.addCleanup(self._tmp.cleanup)
        self.spool = Path(self._tmp.name)


class TestWireProtocol(unittest.TestCase):
    def test_every_message_type_round_trips_through_the_framing(self) -> None:
        cases = [
            (enc.MSG_HELLO, 0, enc.pack_hello(video=False, preset="superfast", t0_us=123456)),
            (enc.MSG_AUDIO, 2_500_000, enc.pack_audio(2_500_000, b"\x01\x00" * 480)),
            (enc.MSG_VIDEO, 66_667, enc.pack_video(66_667, 640, 360, 90, b"\x80" * 10)),
            (enc.MSG_EOF, 0, enc.pack_eof()),
            (enc.MSG_REMUX, 0, enc.pack_remux()),
            (enc.MSG_QUIT, 0, enc.pack_quit()),
        ]
        stream = io.BytesIO(b"".join(frame for _t, _p, frame in cases))
        for msg_type, pts_us, _frame in cases:
            got = enc.read_frame(stream)
            self.assertIsNotNone(got)
            self.assertEqual((got[0], got[1]), (msg_type, pts_us))
        self.assertIsNone(enc.read_frame(stream))  # a clean EOF is None, not an error

    def test_header_layout_is_the_binding_contract(self) -> None:
        self.assertEqual(enc.HEADER.format, "!BqI")
        self.assertEqual(enc.HEADER_SIZE, 13)
        frame = enc.pack_audio(7, b"\x00\x00")
        self.assertEqual(frame[:13], struct.pack("!BqI", enc.MSG_AUDIO, 7, 2))
        self.assertEqual((enc.MSG_HELLO, enc.MSG_VIDEO, enc.MSG_AUDIO), (1, 2, 3))
        self.assertEqual((enc.MSG_EOF, enc.MSG_REMUX, enc.MSG_QUIT), (4, 5, 6))

    def test_malformed_frames_are_rejected(self) -> None:
        for bad in (
            struct.pack("!BqI", 0, 0, 0),  # unknown type
            struct.pack("!BqI", 7, 0, 0),
            struct.pack("!BqI", enc.MSG_AUDIO, -1, 0),  # negative pts
            struct.pack("!BqI", enc.MSG_AUDIO, 0, enc.MAX_PAYLOAD_BYTES + 1),  # oversized
        ):
            with self.subTest(header=bad.hex()):
                with self.assertRaises(enc.FrameError):
                    enc.read_frame(io.BytesIO(bad))
        with self.assertRaises(enc.FrameError):  # cut inside the header
            enc.read_frame(io.BytesIO(b"\x03\x00\x00"))
        with self.assertRaises(enc.FrameError):  # cut inside the payload
            enc.read_frame(io.BytesIO(struct.pack("!BqI", enc.MSG_AUDIO, 0, 10) + b"\x00" * 4))
        with self.assertRaises(enc.FrameError):
            enc.pack_audio(0, b"\x00")  # odd byte count is not s16 PCM
        with self.assertRaises(enc.FrameError):
            enc.pack_frame(99)

    def test_hello_is_validated_and_an_unknown_preset_falls_back(self) -> None:
        good = enc.parse_hello(enc.pack_hello(video=True, preset="veryfast", t0_us=5)[enc.HEADER_SIZE :])
        self.assertEqual(good, {"video": True, "preset": "veryfast", "t0_us": 5})
        odd = json.dumps({"v": 1, "video": False, "preset": "placebo", "t0_us": 0}).encode()
        self.assertEqual(enc.parse_hello(odd)["preset"], enc.DEFAULT_PRESET)
        for bad in (b"not json", b"[]", b'{"v":2,"video":false,"t0_us":0}', b'{"v":1,"video":"yes","t0_us":0}',
                    b'{"v":1,"video":false,"t0_us":true}'):
            with self.subTest(payload=bad):
                with self.assertRaises(enc.FrameError):
                    enc.parse_hello(bad)

    def test_video_payload_splits_into_dimensions_and_picture(self) -> None:
        payload = enc.pack_video(0, 854, 480, 270, b"abc")[enc.HEADER_SIZE :]
        self.assertEqual(enc.parse_video(payload), (854, 480, 270, b"abc"))
        with self.assertRaises(enc.FrameError):
            enc.parse_video(b"\x00\x01")

    def test_status_lines_fit_in_512_bytes_and_never_carry_text(self) -> None:
        line = enc.status_line(s="progress", frames=1, dropped=0, black=0, bytes=10, media_ms=20)
        self.assertTrue(line.endswith(b"\n"))
        self.assertLessEqual(len(line), enc.STATUS_MAX_BYTES)
        self.assertEqual(json.loads(line)["s"], "progress")
        too_long = enc.status_line(s="error", code="x" * 600)
        self.assertEqual(json.loads(too_long), {"s": "error", "code": "status_too_long"})
        self.assertLessEqual(len(too_long), enc.STATUS_MAX_BYTES)

    def test_a_status_is_accepted_only_in_its_closed_vocabulary(self) -> None:
        parsed = enc.parse_status(b'{"s":"ready","av":"19.0.1","x264":true,"aac":true}\n')
        self.assertEqual(parsed, {"s": "ready", "av": "19.0.1", "x264": True, "aac": True})
        # An unknown error code never reaches the parent as text; extra keys are dropped.
        parsed = enc.parse_status(b'{"s":"error","code":"C:\\\\secret\\\\path","path":"/tmp/x"}\n')
        self.assertEqual(parsed, {"s": "error", "code": "protocol"})
        closed = enc.parse_status(b'{"s":"closed","bytes":12,"media_ms":340,"width":0,"height":0,"fps":0,"x":"y"}')
        self.assertEqual(closed["bytes"], 12)
        self.assertNotIn("x", closed)
        for bad in (b"", b"garbage", b"[1]", b'{"s":"nope"}', b'{"s":"ready"' + b" " * 600 + b"}"):
            with self.subTest(line=bad[:20]):
                self.assertIsNone(enc.parse_status(bad))
        # Negative, boolean and enormous counters are dropped, not trusted.
        odd = enc.parse_status(b'{"s":"progress","bytes":-1,"frames":true,"media_ms":99999999999999}')
        self.assertEqual(odd, {"s": "progress"})


class TestSelfTest(unittest.TestCase):
    def test_the_real_media_stack_reports_both_encoders(self) -> None:
        result = enc.self_test()
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["aac"])
        self.assertTrue(result["x264"], "the wheel must bundle libx264 (CI asserts it)")
        self.assertEqual(result["av"], av.__version__[:16])

    def test_a_wheel_without_libx264_still_serves_audio(self) -> None:
        with mock.patch.object(enc, "_probe_x264", side_effect=ValueError("no libx264")):
            result = enc.self_test()
        self.assertTrue(result["ok"])
        self.assertFalse(result["x264"])

    def test_a_wheel_without_aac_is_an_error(self) -> None:
        with mock.patch.object(enc, "_probe_aac", side_effect=ValueError("no aac")):
            result = enc.self_test()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "no_aac")

    def test_no_media_stack_at_all_is_a_no_av_error(self) -> None:
        with mock.patch.dict(sys.modules, {"av": None}):
            result = enc.self_test()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "no_av")


class TestAudioSpool(SpoolCase):
    def write_tone(self, spool: "enc.AudioSpool", seconds: float, chunk: float = 2.5) -> None:
        samples = tone(seconds)
        step = int(chunk * RATE)
        for offset in range(0, len(samples), step):
            spool.write(offset * 1_000_000 // RATE, samples[offset : offset + step].tobytes())

    def test_ten_seconds_become_one_aac_mono_48k_stream_that_starts_at_zero(self) -> None:
        path = self.spool / enc.STREAM_NAME
        spool = enc.AudioSpool(path)
        self.write_tone(spool, 10.0)
        size = spool.close()
        self.assertEqual(size, path.stat().st_size)
        pcm, duration, stream = decode(path)
        self.assertEqual((stream.codec_context.name, stream.rate, stream.layout.name), ("aac", RATE, "mono"))
        with av.open(str(path)) as container:
            self.assertEqual(len(container.streams.audio), 1)
            self.assertEqual(len(container.streams), 1)
            first = next(p for p in container.demux() if p.pts is not None)
        self.assertEqual(first.pts, 0)  # the first audio sample is media time zero
        self.assertAlmostEqual(duration, 10.0, delta=0.1)
        self.assertAlmostEqual(len(pcm) / RATE, 10.0, delta=0.1)
        self.assertEqual(spool.media_ms, 10000)
        self.assertLess(abs(dominant_frequency(pcm, 3.0) - 440.0), 5.0)

    def test_the_file_is_append_only_while_encoding_and_grows_a_fragment_at_a_time(self) -> None:
        path = self.spool / enc.STREAM_NAME
        spool = enc.AudioSpool(path)
        samples = tone(10.0)
        snapshots: list[bytes] = []
        for offset in range(0, len(samples), RATE // 2):
            spool.write(offset * 1_000_000 // RATE, samples[offset : offset + RATE // 2].tobytes())
            if path.exists():
                snapshots.append(path.read_bytes())
        spool.close()
        final = path.read_bytes()
        sizes = [len(s) for s in snapshots]
        self.assertEqual(sizes, sorted(sizes))
        self.assertGreaterEqual(len(set(sizes)), 4, "a fragment is flushed about every 2 s")
        for earlier, later in zip(snapshots, snapshots[1:] + [final]):
            self.assertEqual(later[: len(earlier)], earlier, "an uploaded byte must never change")
        stable = {hashlib.sha256(s[:700]).hexdigest() for s in snapshots}
        self.assertEqual(len(stable), 1, "ftyp+moov never change once written")
        boxes = top_level_boxes(snapshots[0])
        self.assertEqual(boxes[:2], ["ftyp", "moov"])  # a valid prefix exists from the first flush

    def test_a_real_gap_is_filled_with_silence_and_a_rounding_gap_is_not(self) -> None:
        path = self.spool / enc.STREAM_NAME
        spool = enc.AudioSpool(path)
        spool.write(0, tone(2.0).tobytes())
        spool.write(2_100_000, tone(1.0).tobytes())  # 0.1 s late: rounding, left alone
        self.assertEqual(spool.received_samples, 3 * RATE)
        spool.write(6_000_000, tone(1.0).tobytes())  # 2.9 s hole: filled
        self.assertAlmostEqual(spool.received_samples / RATE, 7.0, delta=0.01)
        spool.close()
        pcm, duration, _stream = decode(path)
        self.assertAlmostEqual(duration, 7.0, delta=0.1)
        gap = np.abs(pcm[int(3.2 * RATE) : int(5.8 * RATE)])
        self.assertLess(float(gap.max()), 0.02)  # silence (AAC pre-echo aside)
        self.assertGreater(float(np.abs(pcm[int(6.2 * RATE) : int(6.8 * RATE)]).max()), 0.1)

    def test_writing_after_close_is_ignored(self) -> None:
        spool = enc.AudioSpool(self.spool / enc.STREAM_NAME)
        spool.write(0, tone(1.0).tobytes())
        size = spool.close()
        spool.write(1_000_000, tone(1.0).tobytes())
        self.assertEqual(spool.close(), size)

    def test_faststart_remux_puts_moov_first_and_keeps_the_audio_unchanged(self) -> None:
        source = self.spool / enc.STREAM_NAME
        spool = enc.AudioSpool(source)
        self.write_tone(spool, 10.0)
        spool.close()
        target = self.spool / enc.VIDEO_NAME
        size = enc.remux_faststart(source, target)
        self.assertEqual(size, target.stat().st_size)
        boxes = top_level_boxes(target.read_bytes())
        self.assertLess(boxes.index("moov"), boxes.index("mdat"))
        self.assertNotIn("moof", boxes)  # a plain MP4, not a fragmented one
        a, dur_a, _ = decode(source)
        b, dur_b, stream_b = decode(target)
        self.assertAlmostEqual(dur_a, dur_b, delta=0.05)
        self.assertLessEqual(abs(len(a) - len(b)), 1024)  # the edit list trims AAC priming
        with av.open(str(target)) as container:
            self.assertEqual(len(container.streams), 1)
        self.assertEqual(stream_b.codec_context.name, "aac")

        def packets(path: Path) -> list[bytes]:
            with av.open(str(path)) as container:
                return [bytes(p) for p in container.demux() if p.dts is not None and p.size]

        self.assertEqual(packets(source), packets(target))  # a copy: the very same AAC packets


class TestChildProcess(SpoolCase):
    def start(self) -> ChildHarness:
        child = ChildHarness(self.spool)
        self.addCleanup(child.close)
        return child

    def feed(self, child: ChildHarness, seconds: float, chunk: float = 2.0) -> None:
        samples = tone(seconds)
        step = int(chunk * RATE)
        for offset in range(0, len(samples), step):
            child.send(enc.pack_audio(offset * 1_000_000 // RATE, samples[offset : offset + step].tobytes()))

    def test_ready_then_audio_then_eof_closes_the_mp4_and_reports_its_size(self) -> None:
        child = self.start()
        ready = child.wait_for("ready")
        self.assertTrue(ready["aac"] and ready["x264"])
        child.send(enc.pack_hello(video=False, preset="superfast", t0_us=1))
        self.feed(child, 10.0)
        child.send(enc.pack_eof())
        closed = child.wait_for("closed")
        stream = self.spool / enc.STREAM_NAME
        self.assertEqual(closed["bytes"], stream.stat().st_size)
        self.assertEqual(closed["media_ms"], 10000)
        self.assertEqual((closed["width"], closed["height"], closed["fps"]), (0, 0, 0))
        pcm, duration, _ = decode(stream)
        self.assertAlmostEqual(duration, 10.0, delta=0.1)

    def test_remux_and_quit(self) -> None:
        child = self.start()
        child.wait_for("ready")
        child.send(enc.pack_hello(video=False, preset="superfast", t0_us=1))
        self.feed(child, 4.0)
        child.send(enc.pack_eof())
        child.wait_for("closed")
        child.send(enc.pack_remux())
        remuxed = child.wait_for("remuxed")
        fast = self.spool / enc.VIDEO_NAME
        self.assertEqual(remuxed["bytes"], fast.stat().st_size)
        boxes = top_level_boxes(fast.read_bytes())
        self.assertLess(boxes.index("moov"), boxes.index("mdat"))
        child.send(enc.pack_quit())
        self.assertEqual(child.proc.wait(timeout=20), 0)

    def test_remux_before_the_stream_is_closed_is_an_error_not_a_crash(self) -> None:
        child = self.start()
        child.wait_for("ready")
        child.send(enc.pack_hello(video=False, preset="superfast", t0_us=1))
        child.send(enc.pack_remux())
        self.assertEqual(child.wait_for("error")["code"], "remux_failed")
        self.assertIsNone(child.proc.poll())

    def test_stdin_eof_closes_the_output_cleanly_and_exits_zero(self) -> None:
        child = self.start()
        child.wait_for("ready")
        child.send(enc.pack_hello(video=False, preset="superfast", t0_us=1))
        self.feed(child, 3.0)
        child.proc.stdin.close()  # the parent died
        closed = child.wait_for("closed")
        self.assertGreater(closed["bytes"], 0)
        self.assertEqual(child.proc.wait(timeout=20), 0)
        pcm, duration, _ = decode(self.spool / enc.STREAM_NAME)
        self.assertAlmostEqual(duration, 3.0, delta=0.1)

    def test_a_progress_line_arrives_at_least_once_a_second_even_when_idle(self) -> None:
        child = self.start()
        child.wait_for("ready")
        child.send(enc.pack_hello(video=False, preset="superfast", t0_us=1))
        before = len([s for s in child.statuses if s["s"] == "progress"])
        time.sleep(3.3)
        after = [s for s in child.statuses if s["s"] == "progress"]
        self.assertGreaterEqual(len(after) - before, 3)

    def test_kill_nine_mid_write_leaves_a_prefix_that_opens_decodes_and_copy_remuxes(self) -> None:
        child = self.start()
        child.wait_for("ready")
        child.send(enc.pack_hello(video=False, preset="superfast", t0_us=1))
        self.feed(child, 8.0)
        stream = self.spool / enc.STREAM_NAME
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and (not stream.exists() or stream.stat().st_size < 20_000):
            time.sleep(0.05)
        child.proc.kill()
        child.proc.wait(timeout=10)
        pcm, duration, _ = decode(stream)  # opens and decodes without the trailer
        self.assertGreater(duration, 1.5)
        self.assertGreater(len(pcm) / RATE, 1.5)
        prefix = self.spool / "prefix-fast.mp4"
        enc.remux_faststart(stream, prefix)
        copy_pcm, copy_duration, _ = decode(prefix)
        self.assertAlmostEqual(copy_duration, duration, delta=0.1)
        self.assertGreater(len(copy_pcm), 0)

    def test_every_status_line_is_small_json_without_a_path(self) -> None:
        child = self.start()
        child.wait_for("ready")
        child.send(enc.pack_hello(video=False, preset="superfast", t0_us=1))
        self.feed(child, 4.0)
        child.send(enc.pack_eof())
        child.wait_for("closed")
        child.send(enc.pack_quit())
        child.proc.wait(timeout=20)
        time.sleep(0.2)
        self.assertGreaterEqual(len(child.lines), 3)
        for _at, raw in child.lines:
            self.assertLessEqual(len(raw), enc.STATUS_MAX_BYTES + 1)
            body = json.loads(raw)
            self.assertIn(body["s"], enc.STATUS_KINDS)
            self.assertNotIn(str(self.spool), raw.decode())
            self.assertNotIn(self.spool.name, raw.decode())

    def test_video_messages_are_parsed_and_ignored(self) -> None:
        child = self.start()
        child.wait_for("ready")
        child.send(enc.pack_hello(video=False, preset="superfast", t0_us=1))
        child.send(enc.pack_video(0, 640, 360, 0, b"\x10" * (640 * 360 * 3 // 2)))
        self.feed(child, 2.0)
        child.send(enc.pack_eof())
        closed = child.wait_for("closed")
        self.assertEqual(closed["media_ms"], 2000)
        self.assertEqual(closed.get("frames", 0), 0)

    def test_a_hello_that_asks_for_video_is_refused_until_camera_capture_exists(self) -> None:
        child = self.start()
        child.wait_for("ready")
        child.send(enc.pack_hello(video=True, preset="superfast", t0_us=1))
        self.assertEqual(child.wait_for("error")["code"], "video_unsupported")
        self.assertEqual(child.proc.wait(timeout=20), 1)

    def test_garbage_and_a_missing_hello_are_protocol_errors(self) -> None:
        for payload in (b"\xff" * 13, enc.pack_audio(0, b"\x00\x00")):
            with self.subTest(first=payload[:4].hex()):
                with tempfile.TemporaryDirectory(prefix="r1enc-proto-") as tmp:
                    child = ChildHarness(Path(tmp))
                    try:
                        child.wait_for("ready")
                        child.send(payload)
                        self.assertEqual(child.wait_for("error")["code"], "protocol")
                        self.assertEqual(child.proc.wait(timeout=20), 2)
                    finally:
                        child.close()

    def test_a_missing_spool_directory_is_reported_not_crashed(self) -> None:
        missing = self.spool / "nope"
        child = ChildHarness(missing)
        self.addCleanup(child.close)
        self.assertEqual(child.wait_for("error")["code"], "spool_unusable")
        self.assertEqual(child.proc.wait(timeout=20), 1)


class TestInProcessLoop(SpoolCase):
    """``serve`` without a subprocess: the same loop, driven through a BytesIO."""

    def run_loop(self, frames: list[bytes]) -> tuple[int, list[dict]]:
        statuses: list[dict] = []
        code = enc.serve(self.spool, io.BytesIO(b"".join(frames)), statuses.append)
        return code, statuses

    def test_a_scripted_session_emits_ready_progress_closed(self) -> None:
        code, statuses = self.run_loop(
            [
                enc.pack_hello(video=False, preset="superfast", t0_us=0),
                enc.pack_audio(0, tone(2.0).tobytes()),
                enc.pack_eof(),
                enc.pack_quit(),
            ]
        )
        self.assertEqual(code, 0)
        kinds = [s["s"] for s in statuses]
        self.assertEqual(kinds[0], "ready")
        self.assertEqual(kinds[-1], "closed")
        self.assertEqual(statuses[-1]["media_ms"], 2000)

    def test_a_sigterm_style_stop_closes_the_output(self) -> None:
        import threading as _threading

        stop = _threading.Event()
        stop.set()
        statuses: list[dict] = []

        class Blocked(io.RawIOBase):
            def readinto(self, _buffer):  # never delivers anything
                time.sleep(5)
                return 0

        started = time.monotonic()
        code = enc.serve(self.spool, Blocked(), statuses.append, stop=stop)
        self.assertEqual(code, 0)
        self.assertLess(time.monotonic() - started, 3.0)

    def test_an_unexpected_failure_is_reported_as_a_fixed_code(self) -> None:
        with mock.patch.object(enc, "AudioSpool", side_effect=OSError(28, "no space")):
            code, statuses = self.run_loop([enc.pack_hello(video=False, preset="superfast", t0_us=0)])
        self.assertEqual(code, 1)
        self.assertEqual(statuses[-1], {"s": "error", "code": "disk_full"})
        with mock.patch.object(enc, "AudioSpool", side_effect=RuntimeError("boom with /secret/path")):
            code, statuses = self.run_loop([enc.pack_hello(video=False, preset="superfast", t0_us=0)])
        self.assertEqual(statuses[-1], {"s": "error", "code": "encode_failed"})


class TestProcessSetup(unittest.TestCase):
    def test_the_child_lowers_its_priority_and_is_told_to_die_with_its_parent(self) -> None:
        with mock.patch.object(os, "nice", create=True) as nice:
            enc._lower_priority()
        nice.assert_called_once_with(10)

    def test_a_platform_without_nice_is_not_an_error(self) -> None:
        with mock.patch.object(os, "nice", create=True, side_effect=OSError("denied")):
            enc._lower_priority()

    def test_main_needs_exactly_the_spool_directory(self) -> None:
        with mock.patch.object(enc, "_write_status") as write:
            self.assertEqual(enc.main([]), 2)
        self.assertEqual(write.call_args.args[0]["code"], "spool_unusable")

    def test_the_module_never_logs_or_prints(self) -> None:
        import ast

        tree = ast.parse(Path(enc.__file__).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertNotEqual(node.func.id, "print")
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module]
                self.assertFalse({"logging", "traceback", "warnings"} & set(names))


if __name__ == "__main__":
    unittest.main()
