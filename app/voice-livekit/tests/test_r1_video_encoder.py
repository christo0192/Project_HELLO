"""R1 recording: the encoder process (``r1_video_encoder``), against the real PyAV.

Covers the wire protocol (framing, malformed input, status lines), the start-up self-test, the
audio spool (a fragmented MP4 that only ever grows, survives ``kill -9`` and copy-remuxes to a
faststart file), the combined A/V spool (640x360 at a constant 15 fps plus AAC: the picture clock,
black fill and camera-off time, every size and rotation on one canvas, A/V sync across a rejoin
gap) and the real child process end to end (HELLO, AUDIO, VIDEO, EOF, REMUX, QUIT, stdin EOF,
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


def flat_picture(width: int, height: int, luma: int = 128) -> bytes:
    """A tightly packed I420 picture with one luma value and neutral chroma."""
    picture = np.full(width * height * 3 // 2, 128, dtype=np.uint8)
    picture[: width * height] = luma
    return picture.tobytes()


def halves_picture(width: int, height: int, *, light: str) -> bytes:
    """Bright on one half (``left`` / ``right`` / ``top`` / ``bottom``), dark on the other."""
    luma = np.full((height, width), 30, dtype=np.uint8)
    if light == "left":
        luma[:, : width // 2] = 220
    elif light == "right":
        luma[:, width // 2 :] = 220
    elif light == "top":
        luma[: height // 2, :] = 220
    elif light == "bottom":
        luma[height // 2 :, :] = 220
    chroma = np.full(width * height // 2, 128, dtype=np.uint8)
    return luma.tobytes() + chroma.tobytes()


def video_payload(width: int, height: int, rotation: int, picture: bytes) -> bytes:
    return enc.VIDEO_HEADER.pack(width, height, rotation) + picture


def decode_video(path: Path) -> list[tuple[float, np.ndarray]]:
    """Every decoded picture as ``(seconds, luma plane)``."""
    out: list[tuple[float, np.ndarray]] = []
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        for frame in container.decode(stream):
            plane = frame.to_ndarray()[: frame.height]
            out.append((float(frame.pts * frame.time_base), plane))
    return out


def decode_chroma(path: Path) -> list[tuple[float, float]]:
    """``(seconds, mean of the two chroma planes)`` of every decoded picture (128 is neutral)."""
    out: list[tuple[float, float]] = []
    with av.open(str(path)) as container:
        for frame in container.decode(container.streams.video[0]):
            out.append((float(frame.pts * frame.time_base), float(frame.to_ndarray()[frame.height :].mean())))
    return out


def video_packets(path: Path) -> list[tuple[int, bool]]:
    with av.open(str(path)) as container:
        return [(p.pts, bool(p.is_keyframe)) for p in container.demux(container.streams.video[0]) if p.pts is not None]


def beep(seconds: float, at_s: float, total_s: float, freq: float = 1000.0, amplitude: int = 16000) -> np.ndarray:
    """``total_s`` of silence with a ``seconds``-long tone starting at ``at_s``."""
    pcm = np.zeros(int(round(total_s * RATE)), dtype="<i2")
    start = int(round(at_s * RATE))
    pcm[start : start + int(round(seconds * RATE))] = tone(seconds, freq=freq, amplitude=amplitude)
    return pcm


def beep_onset(path: Path, *, threshold: float = 0.15) -> float:
    """Seconds at which the first loud audio starts."""
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            samples = np.abs(frame.to_ndarray().reshape(-1))
            loud = np.nonzero(samples > threshold)[0]
            if loud.size:
                return float(frame.pts * frame.time_base) + float(loud[0]) / RATE
    raise AssertionError("no loud audio in the file")


def flash_times(path: Path, *, level: float = 150.0) -> list[float]:
    """Seconds of every picture whose mean luma is above ``level`` (a white flash)."""
    return [t for t, plane in decode_video(path) if float(plane.mean()) > level]


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


def loud_onsets(path: Path, *, threshold: float = 0.15, quiet_s: float = 2.0) -> list[float]:
    """Start of every burst of loud audio, bursts being separated by ``quiet_s`` of quiet."""
    onsets: list[float] = []
    last_loud = -1e9
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            samples = np.abs(frame.to_ndarray().reshape(-1))
            base = float(frame.pts * frame.time_base)
            loud = np.nonzero(samples > threshold)[0]
            if not loud.size:
                continue
            first = base + float(loud[0]) / RATE
            if first - last_loud > quiet_s:
                onsets.append(first)
            last_loud = base + float(loud[-1]) / RATE
    return onsets


def flash_onsets(path: Path, *, level: float = 150.0, quiet_s: float = 1.0) -> list[float]:
    onsets: list[float] = []
    last = -1e9
    for t, plane in decode_video(path):
        if float(plane.mean()) > level:
            if t - last > quiet_s:
                onsets.append(t)
            last = t
    return onsets


class AVCase(SpoolCase):
    """An ``AVSpool`` driven by hand: audio and pictures carry explicit times, and the spool's
    clock is advanced explicitly, so a whole call is encoded in a second or two."""

    STEP_US = 1_000_000 // enc.VIDEO_FPS

    def make(self, preset: str = "superfast") -> "enc.AVSpool":
        self.path = self.spool / enc.STREAM_NAME
        return enc.AVSpool(self.path, preset=preset)

    def play(
        self,
        spool: "enc.AVSpool",
        *,
        start_us: int = 0,
        end_us: int,
        picture=None,
        audio: list[tuple[int, np.ndarray]] | None = None,
        chunk_s: float = 0.5,
    ) -> None:
        """Feed 15 fps pictures from ``start_us`` and the audio segments (``(start_us, samples)``,
        cut into chunks and delivered when the clock reaches them), advancing the clock."""
        step = int(chunk_s * RATE)
        chunks: list[tuple[int, bytes]] = []
        for segment_start, samples in audio or []:
            for offset in range(0, len(samples), step):
                chunks.append((segment_start + offset * 1_000_000 // RATE, samples[offset : offset + step].tobytes()))
        chunks.sort()
        t = start_us
        while t < end_us:
            while chunks and chunks[0][0] <= t:
                spool.write(*chunks.pop(0))
            if picture is not None:
                data = picture(t)
                if data is not None:
                    spool.feed_video(t, video_payload(640, 360, 0, data))
            spool.advance(t + enc.VIDEO_LATENCY_US)
            t += self.STEP_US
        for chunk in chunks:
            spool.write(*chunk)


class TestAVSpool(AVCase):
    def test_ten_seconds_become_h264_640x360_at_a_constant_15_fps_plus_aac_both_from_zero(self) -> None:
        spool = self.make()
        self.play(
            spool, end_us=10_000_000, audio=[(0, tone(10.0))],
            picture=lambda t: flat_picture(640, 360, 40 + int(t / 1_000_000 * 20)),
        )
        spool.close()
        with av.open(str(self.path)) as container:
            video, audio = container.streams.video[0], container.streams.audio[0]
            self.assertEqual((video.codec_context.name, video.width, video.height), ("h264", 640, 360))
            self.assertEqual((audio.codec_context.name, audio.rate, audio.layout.name), ("aac", RATE, "mono"))
            self.assertEqual(len(container.streams), 2)
            self.assertAlmostEqual(float(container.duration) / 1e6, 10.0, delta=0.1)
        packets = video_packets(self.path)
        deltas = [b[0] - a[0] for a, b in zip(packets, packets[1:])]
        # Constant frame rate: every picture lasts 1024 ticks of the 1/15360 timescale.  (The muxer
        # lengthens the very first one by the AAC priming delay, about 21 ms, to keep both tracks
        # non-negative in a fragmented file; that is not a rate change.)
        self.assertEqual(set(deltas[1:]), {1024})
        self.assertLess(deltas[0], 2 * 1024)
        self.assertEqual(packets[0][0], 0)  # picture time zero
        with av.open(str(self.path)) as container:
            first_audio = next(p for p in container.demux(container.streams.audio[0]) if p.pts is not None)
        self.assertEqual(first_audio.pts, 0)  # voice time zero
        self.assertIn(len(packets), (150, 151))
        keys = [i for i, (_pts, key) in enumerate(packets) if key]
        self.assertEqual(keys, list(range(0, len(packets), 30)))  # a keyframe, so a fragment, every 2 s (30 frames)
        self.assertEqual((spool.frames, spool.dropped, spool.black), (len(packets), 0, 0))
        pictures = decode_video(self.path)
        self.assertEqual(len(pictures), len(packets))
        for t, plane in pictures[::15]:  # the luma follows the clock
            self.assertAlmostEqual(float(plane.mean()), 40 + int(t) * 20, delta=18)

    def test_the_file_only_grows_and_every_snapshot_is_a_valid_prefix(self) -> None:
        spool = self.make()
        snapshots: list[bytes] = []
        for second in range(8):
            self.play(
                spool, start_us=second * 1_000_000, end_us=(second + 1) * 1_000_000,
                audio=[(second * 1_000_000, tone(1.0, offset_s=second))],
                picture=lambda t: flat_picture(640, 360, 90),
            )
            snapshots.append(self.path.read_bytes())
        spool.close()
        final = self.path.read_bytes()
        sizes = [len(x) for x in snapshots]
        self.assertEqual(sizes, sorted(sizes))
        self.assertGreaterEqual(len(set(sizes)), 3, "a fragment is flushed about every 2 s")
        for earlier, later in zip(snapshots, snapshots[1:] + [final]):
            self.assertEqual(later[: len(earlier)], earlier, "an uploaded byte must never change")
        self.assertEqual(top_level_boxes(snapshots[0])[:2], ["ftyp", "moov"])

    def test_a_faststart_copy_keeps_both_streams_and_every_packet(self) -> None:
        spool = self.make()
        self.play(spool, end_us=6_000_000, audio=[(0, tone(6.0))], picture=lambda t: flat_picture(640, 360, 120))
        spool.close()
        target = self.spool / enc.VIDEO_NAME
        enc.remux_faststart(self.path, target)
        boxes = top_level_boxes(target.read_bytes())
        self.assertLess(boxes.index("moov"), boxes.index("mdat"))
        self.assertNotIn("moof", boxes)

        def streams(path: Path) -> dict[str, list[tuple[int | None, bytes]]]:
            out: dict[str, list] = {"video": [], "audio": []}
            with av.open(str(path)) as container:
                for packet in container.demux():
                    if packet.dts is not None and packet.size:
                        out[packet.stream.type].append((packet.pts, bytes(packet)))
            return out

        a, b = streams(self.path), streams(target)
        for kind in ("video", "audio"):
            self.assertEqual([x[1] for x in a[kind]], [x[1] for x in b[kind]], kind + " packets are copied")
        v_a, v_b = [x[0] for x in a["video"]], [x[0] for x in b["video"]]
        self.assertEqual(np.diff(v_a).tolist(), np.diff(v_b).tolist())  # same spacing
        with av.open(str(self.path)) as ca, av.open(str(target)) as cb:
            self.assertEqual(len(cb.streams.video), 1)
            self.assertEqual(len(cb.streams.audio), 1)
            self.assertAlmostEqual(float(ca.duration), float(cb.duration), delta=50_000)

    def test_every_size_and_rotation_lands_on_the_same_canvas_upright(self) -> None:
        cases = [
            # (width, height, rotation, bright side as sent, bright side expected after the turn)
            (854, 480, 0, "left", "left"),
            (320, 180, 0, "right", "right"),
            (426, 240, 0, "left", "left"),
            (1280, 720, 0, "right", "right"),
            (640, 360, 0, "left", "left"),
            (360, 640, 90, "top", "right"),  # a portrait phone, turned a quarter clockwise
            (360, 640, 270, "top", "left"),
            (640, 360, 180, "left", "right"),
        ]
        for width, height, rotation, sent, expected in cases:
            with self.subTest(size=(width, height), rotation=rotation):
                with tempfile.TemporaryDirectory(prefix="r1enc-size-") as tmp:
                    self.path = Path(tmp) / enc.STREAM_NAME
                    spool = enc.AVSpool(self.path)
                    spool.feed_video(0, video_payload(width, height, rotation, halves_picture(width, height, light=sent)))
                    spool.advance(400_000)
                    spool.write(0, tone(0.5).tobytes())
                    spool.close()
                    first = decode_video(self.path)[0][1]
                    self.assertEqual(first.shape, (360, 640))
                    left, right = float(first[:, :280].mean()), float(first[:, 360:].mean())
                    if expected == "left":
                        self.assertGreater(left, 150)
                        self.assertLess(right, 100)
                    else:
                        self.assertGreater(right, 150)
                        self.assertLess(left, 100)
                    self.assertEqual(spool.dropped, 0)

    def test_a_4_by_3_picture_keeps_its_shape_with_black_bars(self) -> None:
        spool = self.make()
        spool.feed_video(0, video_payload(480, 360, 0, flat_picture(480, 360, 200)))
        spool.advance(400_000)
        spool.write(0, tone(0.5).tobytes())
        spool.close()
        picture = decode_video(self.path)[0][1]
        self.assertLess(float(picture[:, :70].mean()), 30)  # the left bar
        self.assertLess(float(picture[:, -70:].mean()), 30)  # the right bar
        self.assertGreater(float(picture[:, 100:540].mean()), 170)  # the picture itself, undistorted width

    def test_a_silent_camera_is_held_for_1_2_seconds_then_black_and_counted(self) -> None:
        spool = self.make()
        self.play(
            spool, end_us=6_000_000, audio=[(0, tone(6.0))],
            picture=lambda t: flat_picture(640, 360, 200) if (t < 2_000_000 or t >= 5_000_000) else None,
        )
        black_before_close = spool.black
        spool.close()
        # Silent from 1.93 s to 5.0 s: held until 1.93 + 1.2 s, black from there to the next picture.
        camera_off_ms = black_before_close * 1000 // enc.VIDEO_FPS
        self.assertAlmostEqual(camera_off_ms, 1800, delta=150)
        pictures = decode_video(self.path)
        at = lambda second: float(next(p for t, p in pictures if t >= second).mean())  # noqa: E731
        self.assertGreater(at(1.0), 150)  # live
        self.assertGreater(at(2.5), 150)  # held (still inside the hold)
        self.assertLess(at(4.0), 40)  # black
        self.assertGreater(at(5.6), 150)  # live again
        chroma = next(c for t, c in decode_chroma(self.path) if t >= 4.0)
        self.assertAlmostEqual(chroma, 128.0, delta=4)  # black, not the green an all-zero picture would be

    def test_before_the_first_picture_the_clock_shows_black_and_counts_it(self) -> None:
        spool = self.make()
        self.play(
            spool, end_us=3_000_000, audio=[(0, tone(3.0))],
            picture=lambda t: flat_picture(640, 360, 200) if t >= 1_000_000 else None,
        )
        self.assertAlmostEqual(spool.black, 15, delta=2)
        spool.close()
        pictures = decode_video(self.path)
        self.assertLess(float(pictures[3][1].mean()), 40)
        self.assertGreater(float(next(p for t, p in pictures if t >= 1.5).mean()), 150)

    def test_a_missing_picture_repeats_the_last_one_and_is_not_black(self) -> None:
        spool = self.make()
        spool.feed_video(0, video_payload(640, 360, 0, flat_picture(640, 360, 180)))
        spool.advance(1_000_000 + enc.VIDEO_LATENCY_US)
        self.assertGreaterEqual(spool.frames, 15)
        self.assertEqual(spool.black, 0)
        spool.close()

    def test_a_late_picture_still_lands_on_the_tick_it_belongs_to(self) -> None:
        spool = self.make()
        spool.advance(200_000 + enc.VIDEO_LATENCY_US - 1)  # tick 3 (0.2 s) is not produced yet
        produced = spool.frames
        spool.feed_video(190_000, video_payload(640, 360, 0, flat_picture(640, 360, 220)))
        spool.advance(400_000 + enc.VIDEO_LATENCY_US)
        self.assertGreater(spool.frames, produced)
        spool.write(0, tone(0.5).tobytes())
        spool.close()
        pictures = decode_video(self.path)
        self.assertLess(float(pictures[2][1].mean()), 40)  # 0.133 s: nothing had arrived
        self.assertGreater(float(pictures[3][1].mean()), 150)  # 0.2 s: the late picture

    def test_a_picture_goes_to_the_nearest_tick_not_always_the_next_one(self) -> None:
        spool = self.make()
        tick3 = spool.tick_us(3)
        # Received 30 ms AFTER tick 3: closer to tick 3 than to tick 4, so it is on show at tick 3.
        spool.feed_video(tick3 + 30_000, video_payload(640, 360, 0, flat_picture(640, 360, 220)))
        # Received 40 ms after tick 6: closer to tick 7, so it first shows there.
        spool.feed_video(spool.tick_us(6) + 40_000, video_payload(640, 360, 0, flat_picture(640, 360, 120)))
        spool.advance(10 * spool.tick_us(1) + enc.VIDEO_LATENCY_US)
        spool.write(0, tone(0.7).tobytes())
        spool.close()
        lumas = [float(plane.mean()) for _t, plane in decode_video(self.path)]
        self.assertLess(lumas[2], 40)  # black before it
        self.assertGreater(lumas[3], 200)  # the first picture, on the tick it is nearest to
        self.assertGreater(lumas[6], 200)  # the second one has not arrived for tick 6 ...
        self.assertAlmostEqual(lumas[7], 120, delta=8)  # ... and is on show from tick 7

    def test_malformed_pictures_are_counted_and_never_break_the_recording(self) -> None:
        spool = self.make()
        good = flat_picture(640, 360, 100)
        for payload in (
            b"\x00\x01",  # shorter than its own header
            video_payload(640, 360, 0, good[:-1]),  # one byte short
            video_payload(641, 360, 0, bytes(641 * 360 * 3 // 2)),  # odd width, right length
            video_payload(640, 361, 0, bytes(640 * 361 * 3 // 2)),  # odd height, right length
            video_payload(8, 8, 0, bytes(8 * 8 * 3 // 2)),  # absurdly small
            video_payload(8192, 8192, 0, b""),  # absurdly large
            video_payload(640, 360, 45, good),  # not a quarter turn
        ):
            spool.feed_video(0, payload)
        self.assertEqual(spool.dropped, 7)
        spool.feed_video(0, video_payload(640, 360, 0, good))
        spool.advance(200_000)
        self.assertEqual(spool.dropped, 7)
        spool.write(0, tone(0.3).tobytes())
        spool.close()
        self.assertGreater(float(decode_video(self.path)[0][1].mean()), 80)

    def test_a_backlog_of_pictures_drops_the_oldest_and_counts_them(self) -> None:
        spool = self.make()
        for index in range(enc.VIDEO_PENDING_MAX + 5):
            spool.feed_video(index * 1000, video_payload(640, 360, 0, flat_picture(640, 360, 100)))
        self.assertEqual(spool.dropped, 5)
        spool.close()

    def test_a_picture_that_cannot_be_normalised_is_dropped_and_the_next_one_works(self) -> None:
        spool = self.make()
        spool.feed_video(0, video_payload(854, 480, 0, flat_picture(854, 480, 100)))
        with mock.patch.object(enc._Normalizer, "apply", side_effect=ValueError("boom")):
            spool.advance(100_000 + enc.VIDEO_LATENCY_US)
        self.assertEqual(spool.dropped, 1)
        spool.feed_video(200_000, video_payload(854, 480, 0, flat_picture(854, 480, 220)))
        spool.advance(400_000 + enc.VIDEO_LATENCY_US)
        spool.write(0, tone(0.5).tobytes())
        spool.close()
        self.assertGreater(float(decode_video(self.path)[4][1].mean()), 150)

    def test_writing_after_close_is_ignored(self) -> None:
        spool = self.make()
        spool.write(0, tone(0.5).tobytes())
        size = spool.close()
        spool.feed_video(0, video_payload(640, 360, 0, flat_picture(640, 360, 100)))
        spool.advance(5_000_000)
        self.assertEqual(spool.close(), size)

    def test_the_picture_clock_comes_from_the_hello_time_when_the_clocks_agree(self) -> None:
        now = 5_000_000_000_000
        self.assertEqual(enc.pick_origin_us(now, now - 50_000), now - 50_000)
        self.assertEqual(enc.pick_origin_us(now, now + 1_000_000), now + 1_000_000)
        # another clock domain (or no time at all): count from when HELLO arrived
        self.assertEqual(enc.pick_origin_us(now, 1_000_000), now)
        self.assertEqual(enc.pick_origin_us(now, 0), now)
        self.assertEqual(enc.pick_origin_us(now, now - 10 * enc.ORIGIN_TOLERANCE_US), now)


class TestAVSync(AVCase):
    """A flash and a beep at one instant must decode together, also after a long hole."""

    def encode_with_hole(self, *, hole_s: float) -> tuple[list[float], list[float], float]:
        """Beep + flash at 2 s; then ``hole_s`` seconds in which NO audio arrives (the candidate
        left and rejoined while the agent was silent) but pictures keep coming; beep + flash again."""
        spool = self.make()
        first_at = 2.0
        resume_at = 6.0 + hole_s  # the second audio segment starts here
        second_at = resume_at + 2.0
        end_s = resume_at + 6.0

        def flashing(t: int) -> bytes:
            seconds = t / 1_000_000
            on = any(a <= seconds < a + 0.2 for a in (first_at, second_at))
            return flat_picture(640, 360, 235 if on else 50)

        self.play(
            spool, end_us=int(end_s * 1e6), picture=flashing,
            audio=[(0, beep(0.2, first_at, 6.0)), (int(resume_at * 1e6), beep(0.2, 2.0, 6.0))],
        )
        spool.close()
        return loud_onsets(self.path), flash_onsets(self.path), float(resume_at)

    def test_a_beep_and_a_flash_at_the_same_instant_decode_together(self) -> None:
        beeps, flashes, _ = self.encode_with_hole(hole_s=0.0)
        self.assertEqual((len(beeps), len(flashes)), (2, 2), (beeps, flashes))
        for beep_at, flash_at in zip(beeps, flashes):
            self.assertLess(abs(beep_at - flash_at), 0.15)
        self.assertAlmostEqual(beeps[0], 2.0, delta=0.15)

    def test_after_a_20_second_hole_in_the_audio_the_second_pair_is_still_together(self) -> None:
        beeps, flashes, resume = self.encode_with_hole(hole_s=20.0)
        self.assertEqual((len(beeps), len(flashes)), (2, 2), (beeps, flashes))
        for beep_at, flash_at in zip(beeps, flashes):
            self.assertLess(abs(beep_at - flash_at), 0.15, (beeps, flashes))
        self.assertAlmostEqual(beeps[1], resume + 2.0, delta=0.15)  # on the wall clock, not shifted


def box(kind: bytes, payload: bytes = b"", *, large: bool = False) -> bytes:
    """One top-level box; ``large`` writes the 64-bit form (size 1, then the real size)."""
    if large:
        return struct.pack(">I4sQ", 1, kind, 16 + len(payload)) + payload
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def box_offsets(data: bytes) -> list[tuple[str, int, int]]:
    """``(type, start, end)`` of every whole top-level box (32- and 64-bit sizes)."""
    out: list[tuple[str, int, int]] = []
    pos = 0
    while pos + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[pos : pos + 8])
        if size == 1:
            size = struct.unpack(">Q", data[pos + 8 : pos + 16])[0]
        if size < 8 or pos + size > len(data):
            break
        out.append((kind.decode("latin1"), pos, pos + size))
        pos += size
    return out


class TestFragmentEnd(SpoolCase):
    """``mp4_fragment_end``: where the frozen spool of a dead child is cut before it goes up on its own."""

    HEAD = box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2avc1mp41") + box(b"moov", b"\x00" * 300)
    PAIR = box(b"moof", b"\x11" * 100) + box(b"mdat", b"\x22" * 1000)

    def end_of(self, data: bytes) -> int:
        path = self.spool / "probe.mp4"
        path.write_bytes(data)
        return enc.mp4_fragment_end(path)

    def test_whole_fragments_end_where_the_last_mdat_ends(self) -> None:
        data = self.HEAD + self.PAIR * 3
        self.assertEqual(self.end_of(data), len(data))
        self.assertEqual(self.end_of(data + box(b"mfra", b"\x00" * 40)), len(data), "a trailer is not a fragment")

    def test_a_fragment_cut_off_mid_write_is_left_out(self) -> None:
        whole = self.HEAD + self.PAIR * 2
        for cut in (1, 7, 8, 108, 109, 600, len(self.PAIR) - 1):
            with self.subTest(cut=cut):
                self.assertEqual(self.end_of(whole + self.PAIR[:cut]), len(whole))

    def test_a_64_bit_size_is_followed(self) -> None:
        big = box(b"moof", b"\x11" * 100) + box(b"mdat", b"\x33" * 5000, large=True)
        data = self.HEAD + self.PAIR + big + self.PAIR
        self.assertEqual(self.end_of(data), len(data))
        self.assertEqual(self.end_of(self.HEAD + self.PAIR + big[:-1]), len(self.HEAD + self.PAIR))
        # A 64-bit header cut short (12 of its 16 bytes) stops the walk.
        short = box(b"moof", b"\x11" * 100) + struct.pack(">I4sI", 1, b"mdat", 0)
        self.assertEqual(self.end_of(self.HEAD + self.PAIR + short), len(self.HEAD + self.PAIR))

    def test_a_box_of_size_zero_runs_to_the_end_of_the_file_and_proves_nothing(self) -> None:
        zero = box(b"moof", b"\x11" * 100) + struct.pack(">I4s", 0, b"mdat") + b"\x44" * 900
        self.assertEqual(self.end_of(self.HEAD + self.PAIR + zero), len(self.HEAD + self.PAIR))

    def test_a_truncated_header_or_a_size_smaller_than_its_header_stops_the_walk(self) -> None:
        whole = self.HEAD + self.PAIR
        self.assertEqual(self.end_of(whole + b"\x00\x00\x01"), len(whole))  # 3 bytes of the next header
        self.assertEqual(self.end_of(whole + struct.pack(">I4s", 4, b"moof") + self.PAIR), len(whole))

    def test_no_whole_fragment_is_zero(self) -> None:
        for label, data in (
            ("ftyp and moov only", self.HEAD),
            ("a moof with no mdat", self.HEAD + box(b"moof", b"\x11" * 100)),
            ("a moof whose mdat is cut", self.HEAD + self.PAIR[:500]),
            ("an mdat with no moof (not fragmented)", self.HEAD + box(b"mdat", b"\x22" * 100)),
            ("a fragment before the moov", box(b"ftyp", b"isom") + self.PAIR + box(b"moov", b"\x00" * 10)),
            ("no ftyp first", box(b"moov", b"\x00" * 10) + self.PAIR),
            ("not an MP4 at all", bytes((i * 7) % 251 for i in range(50_000))),
            ("empty", b""),
        ):
            with self.subTest(label):
                self.assertEqual(self.end_of(data), 0)
        self.assertEqual(enc.mp4_fragment_end(self.spool / "missing.mp4"), 0)


class TestFragmentEndOnARealSpool(AVCase):
    def test_a_real_spool_cut_mid_fragment_is_trimmed_to_a_prefix_that_decodes_to_its_end(self) -> None:
        spool = self.make()
        self.play(
            spool, end_us=7_000_000, audio=[(0, tone(7.0))],
            picture=lambda t: flat_picture(640, 360, 60 + int(t / 1_000_000) * 20),
        )
        live = self.path.read_bytes()  # the spool as the uploader sees it mid-call (no trailer)
        spool.close()
        boxes = box_offsets(live)
        self.assertEqual([kind for kind, _s, _e in boxes[:2]], ["ftyp", "moov"])
        moofs = [start for kind, start, _e in boxes if kind == "moof"]
        self.assertGreaterEqual(len(moofs), 3, "a fragment every 2 s")
        closed_mdats = [end for kind, _start, end in box_offsets(self.path.read_bytes()) if kind == "mdat"]
        self.assertEqual(enc.mp4_fragment_end(self.path), closed_mdats[-1], "the closed file: up to its trailer")
        # kill -9 in the middle of writing the last fragment of ``live``:
        cut_at = moofs[-1] + (len(live) - moofs[-1]) // 2
        cut = self.spool / "cut.mp4"
        cut.write_bytes(live[:cut_at])
        end = enc.mp4_fragment_end(cut)
        self.assertEqual(end, moofs[-1], "the cut fragment is left out, the ones before it are whole")
        trimmed = self.spool / "trimmed.mp4"
        trimmed.write_bytes(live[:end])
        self.assertEqual(top_level_boxes(live[:end])[-1], "mdat")
        pictures = decode_video(trimmed)
        with av.open(str(trimmed)) as container:
            packets = sum(1 for p in container.demux(container.streams.video[0]) if p.size)
        self.assertEqual(len(pictures), packets, "every picture in it decodes")
        self.assertEqual(len(pictures) % enc.VIDEO_KEYINT, 0, "whole fragments only (one per keyframe)")
        self.assertGreaterEqual(len(pictures), 2 * enc.VIDEO_KEYINT)
        pcm, _duration, _stream = decode(trimmed)
        self.assertGreater(len(pcm) / RATE, 3.0)
        # The picture follows the clock up to the last whole fragment.
        last_at, last_plane = pictures[-1]
        self.assertAlmostEqual(float(last_plane.mean()), 60 + int(last_at) * 20, delta=18)


class TestChildPicture(SpoolCase):
    """The real child process with a picture, fed in real time like the recorder does."""

    def start(self) -> ChildHarness:
        child = ChildHarness(self.spool)
        self.addCleanup(child.close)
        return child

    def stream_for(self, child: ChildHarness, seconds: float, *, luma_at=lambda s: 150, with_audio: bool = True) -> int:
        """Send ``seconds`` of 15 fps pictures (stamped on the shared monotonic clock) and audio."""
        t0 = time.monotonic()
        child.send(enc.pack_hello(video=True, preset="ultrafast", t0_us=int(t0 * 1_000_000)))
        sent = 0
        audio_sent = 0
        while True:
            elapsed = time.monotonic() - t0
            if elapsed >= seconds:
                break
            child.send(enc.pack_frame(enc.MSG_VIDEO, int(elapsed * 1_000_000), video_payload(640, 360, 0, flat_picture(640, 360, luma_at(elapsed)))))
            sent += 1
            while with_audio and audio_sent < int(elapsed * 2):  # a half-second chunk each time one is due
                chunk = tone(0.5, offset_s=audio_sent * 0.5)
                child.send(enc.pack_audio(audio_sent * 500_000, chunk.tobytes()))
                audio_sent += 1
            time.sleep(max(0.0, (sent / enc.VIDEO_FPS) - (time.monotonic() - t0)))
        while with_audio and audio_sent < int(seconds * 2):
            child.send(enc.pack_audio(audio_sent * 500_000, tone(0.5, offset_s=audio_sent * 0.5).tobytes()))
            audio_sent += 1
        return sent

    def test_a_picture_request_yields_a_combined_file_and_honest_counters(self) -> None:
        child = self.start()
        ready = child.wait_for("ready")
        self.assertTrue(ready["x264"])
        sent = self.stream_for(child, 3.0)
        child.send(enc.pack_eof())
        closed = child.wait_for("closed")
        stream = self.spool / enc.STREAM_NAME
        self.assertEqual((closed["width"], closed["height"], closed["fps"]), (640, 360, 15))
        self.assertEqual(closed["bytes"], stream.stat().st_size)
        self.assertGreaterEqual(closed["frames"], 40)
        self.assertLessEqual(closed["black"], 3)  # a tick or two before the first picture is fine
        self.assertEqual(closed["dropped"], 0)
        self.assertGreaterEqual(sent, 40)
        with av.open(str(stream)) as container:
            self.assertEqual((len(container.streams.video), len(container.streams.audio)), (1, 1))
            self.assertAlmostEqual(float(container.duration) / 1e6, 3.0, delta=0.4)
        pictures = decode_video(stream)
        self.assertGreater(float(pictures[len(pictures) // 2][1].mean()), 100)
        child.send(enc.pack_quit())
        self.assertEqual(child.proc.wait(timeout=20), 0)

    def test_progress_lines_report_the_picture_counters_and_stay_small(self) -> None:
        child = self.start()
        child.wait_for("ready")
        self.stream_for(child, 2.5)
        child.wait_for("progress", start=3)
        child.send(enc.pack_eof())
        child.wait_for("closed")
        beats = [s for s in child.statuses if s["s"] == "progress" and s.get("frames", 0) > 0]
        self.assertTrue(beats)
        self.assertTrue(all({"frames", "dropped", "black", "bytes", "media_ms"} <= set(b) for b in beats))
        for _at, raw in child.lines:
            self.assertLessEqual(len(raw), enc.STATUS_MAX_BYTES + 1)

    def test_kill_nine_mid_call_leaves_a_prefix_with_both_streams_that_copies_to_faststart(self) -> None:
        child = self.start()
        child.wait_for("ready")
        self.stream_for(child, 6.5)
        stream = self.spool / enc.STREAM_NAME
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and (not stream.exists() or stream.stat().st_size < 30_000):
            time.sleep(0.05)
        child.proc.kill()
        child.proc.wait(timeout=10)
        pictures = decode_video(stream)  # opens and decodes without the trailer
        pcm, duration, _ = decode(stream)
        self.assertGreater(len(pictures), 15)
        self.assertGreater(len(pcm) / RATE, 1.5)
        prefix = self.spool / "prefix-fast.mp4"
        enc.remux_faststart(stream, prefix)
        self.assertAlmostEqual(len(decode_video(prefix)), len(pictures), delta=2)
        self.assertGreater(len(decode(prefix)[0]), 0)

    def test_faststart_of_a_combined_file_over_the_pipe(self) -> None:
        child = self.start()
        child.wait_for("ready")
        self.stream_for(child, 2.0)
        child.send(enc.pack_eof())
        child.wait_for("closed")
        child.send(enc.pack_remux())
        remuxed = child.wait_for("remuxed")
        fast = self.spool / enc.VIDEO_NAME
        self.assertEqual(remuxed["bytes"], fast.stat().st_size)
        with av.open(str(fast)) as container:
            self.assertEqual((len(container.streams.video), len(container.streams.audio)), (1, 1))
        boxes = top_level_boxes(fast.read_bytes())
        self.assertLess(boxes.index("moov"), boxes.index("mdat"))

    def test_a_camera_that_goes_dark_mid_call_is_counted(self) -> None:
        child = self.start()
        child.wait_for("ready")
        t0 = time.monotonic()
        child.send(enc.pack_hello(video=True, preset="ultrafast", t0_us=int(t0 * 1_000_000)))
        sent = 0
        while time.monotonic() - t0 < 1.0:  # one second of picture ...
            child.send(enc.pack_frame(enc.MSG_VIDEO, int((time.monotonic() - t0) * 1e6), video_payload(640, 360, 0, flat_picture(640, 360, 200))))
            sent += 1
            time.sleep(max(0.0, sent / 15 - (time.monotonic() - t0)))
        time.sleep(3.2 - (time.monotonic() - t0))  # ... then 2.2 s of nothing
        child.send(enc.pack_audio(0, tone(3.2).tobytes()))
        child.send(enc.pack_eof())
        closed = child.wait_for("closed")
        off_ms = closed["black"] * 1000 // 15
        # silent for ~2.2 s, of which the first 1.2 s are held: about 1 s of black (generous bounds: real time)
        self.assertGreaterEqual(off_ms, 600)
        self.assertLessEqual(off_ms, 1500)

    def test_a_picture_request_on_a_wheel_without_libx264_is_recorded_as_audio_only(self) -> None:
        statuses: list[dict] = []
        frames = [
            enc.pack_hello(video=True, preset="superfast", t0_us=0),
            enc.pack_frame(enc.MSG_VIDEO, 0, video_payload(640, 360, 0, flat_picture(640, 360, 100))),
            enc.pack_audio(0, tone(2.0).tobytes()),
            enc.pack_eof(),
            enc.pack_quit(),
        ]
        real = enc.self_test

        def no_x264() -> dict:
            result = real()
            result["x264"] = False
            return result

        with mock.patch.object(enc, "self_test", no_x264):
            code = enc.serve(self.spool, io.BytesIO(b"".join(frames)), statuses.append)
        self.assertEqual(code, 0)
        self.assertFalse(statuses[0]["x264"])
        closed = statuses[-1]
        self.assertEqual((closed["s"], closed["width"], closed["height"], closed["fps"]), ("closed", 0, 0, 0))
        self.assertEqual(closed["media_ms"], 2000)
        with av.open(str(self.spool / enc.STREAM_NAME)) as container:
            self.assertEqual(len(container.streams.video), 0)

    def test_a_picture_request_whose_encoder_will_not_open_falls_back_to_audio_only(self) -> None:
        statuses: list[dict] = []
        frames = [
            enc.pack_hello(video=True, preset="superfast", t0_us=0),
            enc.pack_audio(0, tone(1.0).tobytes()),
            enc.pack_eof(),
        ]
        with mock.patch.object(enc, "AVSpool", side_effect=ValueError("libx264 refused")):
            code = enc.serve(self.spool, io.BytesIO(b"".join(frames)), statuses.append)
        self.assertEqual(code, 0)
        self.assertEqual(statuses[-1]["s"], "closed")
        self.assertEqual(statuses[-1]["width"], 0)

    def test_a_full_disk_while_opening_the_picture_spool_is_reported_not_swallowed(self) -> None:
        statuses: list[dict] = []
        frames = [enc.pack_hello(video=True, preset="superfast", t0_us=0)]
        with mock.patch.object(enc, "AVSpool", side_effect=OSError(28, "no space")):
            code = enc.serve(self.spool, io.BytesIO(b"".join(frames)), statuses.append)
        self.assertEqual(code, 1)
        self.assertEqual(statuses[-1], {"s": "error", "code": "disk_full"})

    def test_a_scripted_picture_session_closes_with_the_picture_to_the_end_of_the_audio(self) -> None:
        statuses: list[dict] = []
        frames = [enc.pack_hello(video=True, preset="superfast", t0_us=0)]
        for index in range(10):  # the first 0.6 s of pictures, stamped on the media clock
            frames.append(
                enc.pack_frame(enc.MSG_VIDEO, index * 66_667, video_payload(640, 360, 0, flat_picture(640, 360, 120)))
            )
        frames += [enc.pack_audio(0, tone(2.0).tobytes()), enc.pack_eof(), enc.pack_quit()]
        code = enc.serve(self.spool, io.BytesIO(b"".join(frames)), statuses.append)
        self.assertEqual(code, 0)
        closed = statuses[-1]
        self.assertEqual((closed["width"], closed["height"], closed["fps"]), (640, 360, 15))
        self.assertEqual(closed["media_ms"], 2000)
        # EOF carries the picture on to the end of the audio: 2.0 s at 15 fps is 31 ticks (0 .. 30).
        self.assertIn(closed["frames"], (30, 31))
        self.assertEqual(closed["dropped"], 0)
        self.assertGreater(float(decode_video(self.spool / enc.STREAM_NAME)[5][1].mean()), 80)


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
