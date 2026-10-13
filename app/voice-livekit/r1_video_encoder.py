"""R1 interview recording: the encoder process (``python -m r1_video_encoder <spool_dir>``).

The job process (``r1_recorder``) never encodes.  It tees the interview audio to this
child over a pipe, and the child (niced, ``PR_SET_PDEATHSIG`` on Linux) turns it into a
fragmented MP4 spool file that the recorder uploads while the interview is still running.
The file is append-only while it is written and every fragment is flushed, so a ``kill -9``
leaves a prefix that still opens, decodes and copy-remuxes.

Wire protocol (binding contract C9, one place for both ends):

* parent -> child, stdin: ``struct.pack("!BqI", type, pts_us, length)`` + payload.  Types:
  ``HELLO`` (JSON ``{"v":1,"video":bool,"preset":str,"t0_us":int}``), ``VIDEO``
  (``!HHH`` width, height, rotation + packed I420), ``AUDIO`` (48 kHz mono s16le), ``EOF``
  (close the stream output), ``REMUX`` (faststart copy ``stream.mp4`` -> ``video.mp4``),
  ``QUIT``.  ``pts_us`` is monotonic microseconds minus the ``HELLO`` ``t0_us``.
* child -> parent, stdout: one JSON object per line, at most 512 bytes, written with
  ``os.write``: ``ready``, ``error``, ``progress`` (at least once a second while the loop
  is alive), ``closed``, ``remuxed``.  A status never carries a path, an id or a message.

This module never logs: no ``logging``, no ``print``, nothing on stderr (the parent sends
it to ``/dev/null``).  It imports ``av`` and ``numpy`` only inside functions, so the
recorder can import the protocol helpers without the media stack.

Two spool writers share the file name ``stream.mp4``:

* ``AudioSpool``: AAC mono only (``HELLO`` with ``video`` false, or a wheel without libx264).
* ``AVSpool``: H.264 640x360 at a constant 15 fps plus the same AAC, in one fragmented MP4.
  The picture clock lives HERE: every 1/15 s tick takes the newest frame received up to half a
  frame after that time, repeats it when none arrived, and shows black once the camera has been
  silent for 1.2 s (counted, it is the "camera off" time).  Every size and rotation is normalised onto
  the fixed canvas, so a 4:3 webcam, a portrait phone and a 320x180 stream all land alike.
  Both streams count from the same ``t0`` (the ``HELLO`` ``t0_us``), which is what keeps the
  picture and the voices in step.
"""
from __future__ import annotations

import errno
import json
import os
import queue
import struct
import sys
import threading
import time
from collections.abc import Callable
from fractions import Fraction
from pathlib import Path
from typing import Any, BinaryIO

# ---------------------------------------------------------------------------- protocol

MSG_HELLO = 1
MSG_VIDEO = 2
MSG_AUDIO = 3
MSG_EOF = 4
MSG_REMUX = 5
MSG_QUIT = 6
MESSAGE_TYPES = frozenset({MSG_HELLO, MSG_VIDEO, MSG_AUDIO, MSG_EOF, MSG_REMUX, MSG_QUIT})

HEADER = struct.Struct("!BqI")
HEADER_SIZE = HEADER.size
VIDEO_HEADER = struct.Struct("!HHH")
# One frame never needs more than a 4096x4096 I420 picture; anything larger is a broken peer.
MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
PROTOCOL_VERSION = 1
STATUS_MAX_BYTES = 512

SAMPLE_RATE = 48000
AAC_FRAME_SAMPLES = 1024
AAC_BIT_RATE = 64000
# A gap the child fills with silence itself (the parent's tee has already padded real
# gaps, so this only fires when a message was lost).
GAP_FILL_MIN_SAMPLES = SAMPLE_RATE // 4
GAP_FILL_MAX_SAMPLES = SAMPLE_RATE * 60
# Fragment length of the audio-only spool, in microseconds.
FRAG_DURATION_US = 2_000_000
HEARTBEAT_SECONDS = 1.0

STREAM_NAME = "stream.mp4"
VIDEO_NAME = "video.mp4"

# The picture: one fixed canvas at a constant frame rate (roadmap section 8).
VIDEO_WIDTH = 640
VIDEO_HEIGHT = 360
VIDEO_FPS = 15
# A held picture older than this becomes black: the camera is off (or the track is gone).
VIDEO_HOLD_US = 1_200_000
# A tick is produced this long after its time, so a frame that is a little late over the pipe
# still lands on the tick it belongs to.
VIDEO_LATENCY_US = 120_000
# A picture goes to the NEAREST tick: it is eligible for tick ``t`` when it was received up to half a
# frame after ``t``.  (Taking only pictures at or before ``t`` would show every picture up to one
# whole frame late, 33 ms on average, which comes straight out of the audio/video sync budget.)
VIDEO_HALF_TICK_US = 1_000_000 // VIDEO_FPS // 2
# One keyframe every 2 s: the muxer cuts a fragment on each, so the spool grows every 2 s.
VIDEO_KEYINT = 30
VIDEO_MIN_DIM = 16
VIDEO_MAX_DIM = 4096
# Frames received but not yet placed on a tick; more than this means the loop fell far behind.
VIDEO_PENDING_MAX = 12
ROTATIONS = (0, 90, 180, 270)
# With a picture the loop wakes at least this often to produce the due ticks.
VIDEO_POLL_SECONDS = 0.04
# The parent's ``t0`` is trusted when it is within this of the child's own clock; otherwise (a
# different clock domain) the child counts from the moment ``HELLO`` arrived.
ORIGIN_TOLERANCE_US = 120_000_000

PRESETS = frozenset({"ultrafast", "superfast", "veryfast"})
DEFAULT_PRESET = "superfast"

# Status vocabulary (closed: the parent maps these, never shows them).
STATUS_READY = "ready"
STATUS_ERROR = "error"
STATUS_PROGRESS = "progress"
STATUS_CLOSED = "closed"
STATUS_REMUXED = "remuxed"
STATUS_KINDS = frozenset(
    {STATUS_READY, STATUS_ERROR, STATUS_PROGRESS, STATUS_CLOSED, STATUS_REMUXED}
)
ERROR_CODES = frozenset(
    {
        "no_av",
        "no_aac",
        "protocol",
        "encode_failed",
        "disk_full",
        "remux_failed",
        "spool_unusable",
        "status_too_long",
    }
)
_STATUS_INT_KEYS = ("frames", "dropped", "black", "bytes", "media_ms", "width", "height", "fps")


class FrameError(ValueError):
    """A frame on the wire is malformed (unknown type, bad length, truncated, bad payload)."""


def pack_frame(msg_type: int, pts_us: int = 0, payload: bytes = b"") -> bytes:
    """Encode one message; the same rules apply to what ``parse_header`` accepts."""
    if msg_type not in MESSAGE_TYPES:
        raise FrameError("type")
    if pts_us < 0 or pts_us >= 1 << 62:
        raise FrameError("pts")
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise FrameError("length")
    return HEADER.pack(msg_type, pts_us, len(payload)) + bytes(payload)


def parse_header(data: bytes) -> tuple[int, int, int]:
    """Decode and validate a 13-byte header: ``(type, pts_us, payload_length)``."""
    if len(data) != HEADER_SIZE:
        raise FrameError("header")
    msg_type, pts_us, length = HEADER.unpack(data)
    if msg_type not in MESSAGE_TYPES:
        raise FrameError("type")
    if pts_us < 0:
        raise FrameError("pts")
    if length > MAX_PAYLOAD_BYTES:
        raise FrameError("length")
    return msg_type, pts_us, length


def _read_exactly(stream: BinaryIO, count: int) -> bytes | None:
    """Read ``count`` bytes; ``None`` on a clean EOF before the first byte, error if cut short."""
    chunks: list[bytes] = []
    remaining = count
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            if remaining == count:
                return None
            raise FrameError("truncated")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream: BinaryIO) -> tuple[int, int, bytes] | None:
    """Read one message: ``(type, pts_us, payload)``, or ``None`` at a clean end of stream."""
    header = _read_exactly(stream, HEADER_SIZE)
    if header is None:
        return None
    msg_type, pts_us, length = parse_header(header)
    payload = b""
    if length:
        body = _read_exactly(stream, length)
        if body is None:
            raise FrameError("truncated")
        payload = body
    return msg_type, pts_us, payload


def pack_hello(*, video: bool, preset: str, t0_us: int) -> bytes:
    body = {"v": PROTOCOL_VERSION, "video": bool(video), "preset": preset, "t0_us": int(t0_us)}
    return pack_frame(MSG_HELLO, 0, json.dumps(body, separators=(",", ":")).encode("ascii"))


def parse_hello(payload: bytes) -> dict[str, Any]:
    """Validate a ``HELLO`` payload; a bad one is a protocol error, never a guess."""
    try:
        body = json.loads(payload.decode("ascii"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise FrameError("hello") from exc
    if not isinstance(body, dict) or body.get("v") != PROTOCOL_VERSION:
        raise FrameError("hello")
    video = body.get("video")
    preset = body.get("preset", DEFAULT_PRESET)
    t0_us = body.get("t0_us", 0)
    if not isinstance(video, bool) or not isinstance(t0_us, int) or isinstance(t0_us, bool):
        raise FrameError("hello")
    if not isinstance(preset, str) or preset not in PRESETS:
        preset = DEFAULT_PRESET  # an unknown preset falls back to the default, like the env knob
    return {"video": video, "preset": preset, "t0_us": t0_us}


def pack_audio(pts_us: int, pcm: bytes) -> bytes:
    if len(pcm) % 2:
        raise FrameError("audio")
    return pack_frame(MSG_AUDIO, pts_us, pcm)


def pack_video(pts_us: int, width: int, height: int, rotation: int, i420: bytes) -> bytes:
    return pack_frame(MSG_VIDEO, pts_us, VIDEO_HEADER.pack(width, height, rotation) + i420)


def parse_video(payload: bytes) -> tuple[int, int, int, bytes]:
    """Split a ``VIDEO`` payload into ``(width, height, rotation, i420)``."""
    if len(payload) < VIDEO_HEADER.size:
        raise FrameError("video")
    width, height, rotation = VIDEO_HEADER.unpack_from(payload)
    return width, height, rotation, payload[VIDEO_HEADER.size :]


def i420_size(width: int, height: int) -> int:
    """Bytes of a tightly packed I420 picture (even dimensions only)."""
    return width * height * 3 // 2


def picture_is_usable(width: int, height: int, rotation: int, data: bytes) -> bool:
    """A picture the normaliser can take: even sides in range, a known rotation, exact length."""
    if rotation not in ROTATIONS:
        return False
    for side in (width, height):
        if side < VIDEO_MIN_DIM or side > VIDEO_MAX_DIM or side % 2:
            return False
    return len(data) == i420_size(width, height)


def pack_eof() -> bytes:
    return pack_frame(MSG_EOF)


def pack_remux() -> bytes:
    return pack_frame(MSG_REMUX)


def pack_quit() -> bytes:
    return pack_frame(MSG_QUIT)


def status_line(**fields: Any) -> bytes:
    """Encode one status object as a single newline-terminated line of at most 512 bytes.

    Atomic on a pipe (``PIPE_BUF``) when written with one ``os.write``.  An object that
    would not fit is replaced by a fixed error rather than truncated into invalid JSON.
    """
    line = json.dumps(fields, separators=(",", ":")).encode("ascii") + b"\n"
    if len(line) > STATUS_MAX_BYTES:
        return b'{"s":"error","code":"status_too_long"}\n'
    return line


def parse_status(line: bytes | str) -> dict[str, Any] | None:
    """Validate one status line from the child; ``None`` when it is not a known, safe status."""
    if isinstance(line, str):
        line = line.encode("utf-8", "replace")
    if not line or len(line) > STATUS_MAX_BYTES + 1:
        return None
    try:
        body = json.loads(line.decode("ascii"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(body, dict):
        return None
    kind = body.get("s")
    if kind not in STATUS_KINDS:
        return None
    clean: dict[str, Any] = {"s": kind}
    if kind == STATUS_ERROR:
        code = body.get("code")
        clean["code"] = code if code in ERROR_CODES else "protocol"
    elif kind == STATUS_READY:
        version = body.get("av")
        clean["av"] = version[:16] if isinstance(version, str) else ""
        clean["x264"] = body.get("x264") is True
        clean["aac"] = body.get("aac") is True
    else:
        for key in _STATUS_INT_KEYS:
            value = body.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 1 << 40:
                clean[key] = value
    return clean


# ---------------------------------------------------------------------------- self-test


def self_test() -> dict[str, Any]:
    """Probe the media stack: both encoders exist and a 0.3 s in-memory mux works.

    Returns ``{"ok": bool, "code": str | None, "av": str, "x264": bool, "aac": bool}``.
    The AAC mux is what an audio spool needs, so it decides ``ok``; ``x264`` is reported
    for the parent (it lowers an A/V request to audio when the wheel lacks libx264).
    """
    result: dict[str, Any] = {"ok": False, "code": None, "av": "", "x264": False, "aac": False}
    try:
        import av
        import numpy  # noqa: F401 - the audio path needs it
    except Exception:  # noqa: BLE001 - any import failure means no media stack
        result["code"] = "no_av"
        return result
    result["av"] = str(getattr(av, "__version__", ""))[:16]
    try:
        result["aac"] = _probe_aac(av)
    except Exception:  # noqa: BLE001
        result["aac"] = False
    try:
        result["x264"] = _probe_x264(av)
    except Exception:  # noqa: BLE001
        result["x264"] = False
    if result["aac"]:
        result["ok"] = True
    else:
        result["code"] = "no_aac"
    return result


def _probe_aac(av: Any) -> bool:
    import io

    import numpy as np

    av.Codec("aac", "w")
    sink = io.BytesIO()
    container = av.open(
        sink,
        mode="w",
        format="mp4",
        options={"movflags": "frag_keyframe+empty_moov+default_base_moof"},
    )
    stream = container.add_stream("aac", rate=SAMPLE_RATE, layout="mono")
    stream.codec_context.bit_rate = AAC_BIT_RATE
    silence = np.zeros((1, AAC_FRAME_SAMPLES), dtype=np.float32)
    packets = 0
    pts = 0
    for _ in range(int(0.3 * SAMPLE_RATE) // AAC_FRAME_SAMPLES):
        frame = _audio_frame(av, silence)
        frame.pts = pts
        frame.time_base = Fraction(1, SAMPLE_RATE)
        pts += AAC_FRAME_SAMPLES
        for packet in stream.encode(frame):
            container.mux(packet)
            packets += 1
    for packet in stream.encode(None):
        container.mux(packet)
        packets += 1
    container.close()
    return packets > 0 and len(sink.getvalue()) > 0


def _probe_x264(av: Any) -> bool:
    import io

    av.Codec("libx264", "w")
    sink = io.BytesIO()
    container = av.open(
        sink,
        mode="w",
        format="mp4",
        options={"movflags": "frag_keyframe+empty_moov+default_base_moof"},
    )
    stream = container.add_stream("libx264", rate=15)
    stream.width, stream.height, stream.pix_fmt = 64, 64, "yuv420p"
    stream.codec_context.options = {"preset": "ultrafast", "tune": "zerolatency"}
    packets = 0
    for index in range(5):
        frame = av.VideoFrame(64, 64, "yuv420p")
        frame.pts = index
        frame.time_base = Fraction(1, 15)
        for packet in stream.encode(frame):
            container.mux(packet)
            packets += 1
    for packet in stream.encode(None):
        container.mux(packet)
        packets += 1
    container.close()
    return packets > 0 and len(sink.getvalue()) > 0


def _audio_frame(av: Any, planar: Any) -> Any:
    """One mono ``fltp`` frame from a ``(1, n)`` float32 array."""
    frame = av.AudioFrame.from_ndarray(planar, format="fltp", layout="mono")
    frame.sample_rate = SAMPLE_RATE
    return frame


# ---------------------------------------------------------------------------- spool writer


class AudioSpool:
    """The audio-only fragmented MP4 written to ``<spool_dir>/stream.mp4``.

    ``flush_packets=1`` makes the muxer flush each fragment as soon as it is written (the
    default holds data in the I/O buffer for a seekable file), so the file the uploader
    tails is always a valid prefix: ``ftyp`` + ``moov`` first, then one ``moof``/``mdat``
    pair every ``FRAG_DURATION_US``.
    """

    # What the status lines report about the picture (an audio-only spool has none).
    has_video = False
    frames = 0
    dropped = 0
    black = 0
    width = 0
    height = 0
    fps = 0

    def __init__(self, path: Path) -> None:
        import av

        self._av = av
        self.path = path
        self._container = av.open(str(path), mode="w", format="mp4", options=self._container_options())
        self._add_video_stream()  # before the audio stream, so the picture is stream 0
        self._stream = self._container.add_stream("aac", rate=SAMPLE_RATE, layout="mono")
        self._stream.codec_context.bit_rate = AAC_BIT_RATE
        self._fifo = av.AudioFifo()
        self._pts = 0  # next AAC frame's presentation time, in samples
        self.received_samples = 0  # samples handed to the fifo (silence included)
        self.closed = False

    def _container_options(self) -> dict[str, str]:
        return {
            "movflags": "empty_moov+default_base_moof",
            "frag_duration": str(FRAG_DURATION_US),
            "flush_packets": "1",
        }

    def _add_video_stream(self) -> None:
        """Hook: the audio-only spool has no picture."""

    def advance(self, now_us: int) -> None:
        """Hook: produce the pictures due by ``now_us`` (microseconds since ``t0``)."""

    def feed_video(self, pts_us: int, payload: bytes) -> None:
        """Hook: a ``VIDEO`` message for a spool that has no picture is ignored."""

    @property
    def media_ms(self) -> int:
        return self.received_samples * 1000 // SAMPLE_RATE

    def write(self, pts_us: int, pcm: bytes) -> None:
        """Append one chunk of 48 kHz mono s16le at ``pts_us``, filling a real gap with silence."""
        import numpy as np

        if self.closed:
            return
        samples = np.frombuffer(pcm, dtype="<i2")
        start = (pts_us * SAMPLE_RATE + 500_000) // 1_000_000
        gap = start - self.received_samples
        if gap > GAP_FILL_MIN_SAMPLES:
            remaining = min(gap, GAP_FILL_MAX_SAMPLES)
            while remaining > 0:
                piece = min(remaining, SAMPLE_RATE * 10)
                self._push(np.zeros(piece, dtype=np.int16))
                remaining -= piece
        if samples.size:
            self._push(samples)

    def _push(self, samples: Any) -> None:
        import numpy as np

        planar = (samples.astype(np.float32) / 32768.0).reshape(1, -1)
        frame = _audio_frame(self._av, planar)
        frame.pts = None  # the fifo only keeps a running count when it is not told one
        self._fifo.write(frame)
        self.received_samples += int(samples.size)
        self._drain(partial=False)

    def _drain(self, *, partial: bool) -> None:
        while True:
            frame = self._fifo.read(AAC_FRAME_SAMPLES, partial=partial)
            if frame is None:
                return
            frame.pts = self._pts
            frame.time_base = Fraction(1, SAMPLE_RATE)
            self._pts += frame.samples
            for packet in self._stream.encode(frame):
                self._container.mux(packet)
            if partial:
                return

    def close(self) -> int:
        """Flush the encoder, write the trailer and return the final size in bytes."""
        if self.closed:
            return self.size()
        self.closed = True
        try:
            self._drain(partial=True)
            for packet in self._stream.encode(None):
                self._container.mux(packet)
        finally:
            self._container.close()
        return self.size()

    def size(self) -> int:
        try:
            return self.path.stat().st_size
        except OSError:
            return 0


class _Normalizer:
    """Any I420 picture -> the fixed 640x360 canvas, as a ``(540, 640)`` uint8 array.

    One filter graph per (width, height, rotation): rotate by the frame's rotation (the SDK
    reports it but never applies it), scale to fit keeping the aspect ratio, pad with black.
    A picture that already is 640x360 upright skips the graph.  The graph is rebuilt by the
    caller when the size or rotation changes.
    """

    def __init__(self, av: Any, width: int, height: int, rotation: int) -> None:
        self._av = av
        self.key = (width, height, rotation)
        self._width, self._height = width, height
        self._pushed = 0
        self._graph: Any = None
        if self.key != (VIDEO_WIDTH, VIDEO_HEIGHT, 0):
            self._graph = self._build(rotation)

    def _build(self, rotation: int) -> Any:
        av = self._av
        graph = av.filter.Graph()
        last = graph.add_buffer(
            width=self._width, height=self._height, format="yuv420p", time_base=Fraction(1, VIDEO_FPS)
        )
        steps: list[tuple[str, str]] = []
        if rotation == 90:
            steps.append(("transpose", "1"))  # clockwise
        elif rotation == 270:
            steps.append(("transpose", "2"))  # counter-clockwise
        elif rotation == 180:
            steps.extend((("hflip", ""), ("vflip", "")))
        steps.append(("scale", f"{VIDEO_WIDTH}:{VIDEO_HEIGHT}:force_original_aspect_ratio=decrease"))
        steps.append(("pad", f"{VIDEO_WIDTH}:{VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2"))
        for name, args in steps:
            node = graph.add(name, args) if args else graph.add(name)
            last.link_to(node)
            last = node
        sink = graph.add("buffersink")
        last.link_to(sink)
        graph.configure()
        return graph

    def apply(self, i420: bytes) -> Any:
        import numpy as np

        picture = np.frombuffer(i420, dtype=np.uint8).reshape(self._height * 3 // 2, self._width)
        if self._graph is None:
            return picture
        # ``from_ndarray`` rather than ``planes[i].update``: the latter raises for widths that are
        # not aligned to the allocation stride (854x480, 426x240 both do).
        frame = self._av.VideoFrame.from_ndarray(picture, format="yuv420p")
        frame.pts = self._pushed
        frame.time_base = Fraction(1, VIDEO_FPS)
        self._pushed += 1
        self._graph.push(frame)
        return self._graph.pull().to_ndarray()


class AVSpool(AudioSpool):
    """The combined spool: H.264 (``libx264``) on a constant 15 fps clock plus the AAC audio.

    ``feed_video`` only queues the picture; ``advance(now_us)`` produces every tick that is due
    (``now_us`` counts from ``t0``).  That keeps the 15 fps clock steady whatever the camera
    does: a late frame is repeated over, a missing one is black after ``VIDEO_HOLD_US``.
    ``fragment on keyframe`` plus ``flush_packets`` make the file grow every 2 s with a valid
    prefix at every point (the uploader tails it).
    """

    has_video = True
    width = VIDEO_WIDTH
    height = VIDEO_HEIGHT
    fps = VIDEO_FPS

    def __init__(self, path: Path, *, preset: str = DEFAULT_PRESET) -> None:
        self._preset = preset if preset in PRESETS else DEFAULT_PRESET
        self._pending: list[tuple[int, int, int, int, bytes]] = []
        self._latest: Any = None  # the normalised newest picture (an array) ...
        self._latest_pts = 0  # ... and when it was received
        self._normalizer: _Normalizer | None = None
        self._black: Any = None
        self._next_tick = 0
        self.frames = 0  # ticks encoded (repeated and black ones included)
        self.dropped = 0  # pictures the child could not use (malformed, or the queue overflowed)
        self.black = 0  # ticks shown as black
        super().__init__(path)

    def _container_options(self) -> dict[str, str]:
        return {"movflags": "frag_keyframe+empty_moov+default_base_moof", "flush_packets": "1"}

    def _add_video_stream(self) -> None:
        import numpy as np

        stream = self._container.add_stream("libx264", rate=VIDEO_FPS)
        stream.width, stream.height, stream.pix_fmt = VIDEO_WIDTH, VIDEO_HEIGHT, "yuv420p"
        stream.codec_context.options = {
            "preset": self._preset,
            "tune": "zerolatency",
            "crf": "28",
            "maxrate": "500k",
            "bufsize": "1000k",
            "threads": "1",
            "profile": "main",
            "g": str(VIDEO_KEYINT),
            "keyint_min": str(VIDEO_KEYINT),
            "sc_threshold": "0",
        }
        self._vstream = stream
        black = np.empty((VIDEO_HEIGHT * 3 // 2, VIDEO_WIDTH), dtype=np.uint8)
        black[:VIDEO_HEIGHT] = 16  # limited-range black; chroma neutral
        black[VIDEO_HEIGHT:] = 128
        self._black = black

    # -- input

    def feed_video(self, pts_us: int, payload: bytes) -> None:
        if self.closed:
            return
        try:
            width, height, rotation, i420 = parse_video(payload)
        except FrameError:
            self.dropped += 1
            return
        if not picture_is_usable(width, height, rotation, i420):
            self.dropped += 1
            return
        self._pending.append((pts_us, width, height, rotation, i420))
        if len(self._pending) > VIDEO_PENDING_MAX:
            del self._pending[0]
            self.dropped += 1

    # -- the clock

    @staticmethod
    def tick_us(index: int) -> int:
        """Presentation time of tick ``index`` in microseconds (rounded, no drift)."""
        return (index * 1_000_000 + VIDEO_FPS // 2) // VIDEO_FPS

    def advance(self, now_us: int) -> None:
        """Produce every tick whose time is at least ``VIDEO_LATENCY_US`` before ``now_us``."""
        if self.closed:
            return
        limit = now_us - VIDEO_LATENCY_US
        while self.tick_us(self._next_tick) <= limit:
            self._emit(self._next_tick)
            self._next_tick += 1

    def _emit(self, index: int) -> None:
        at = self.tick_us(index)
        self._place(at)
        if self._latest is None or at - self._latest_pts > VIDEO_HOLD_US:
            picture = self._black
            self.black += 1
        else:
            picture = self._latest
        frame = self._av.VideoFrame.from_ndarray(picture, format="yuv420p")
        frame.pts = index
        frame.time_base = Fraction(1, VIDEO_FPS)
        for packet in self._vstream.encode(frame):
            self._container.mux(packet)
        self.frames += 1

    def _place(self, at_us: int) -> None:
        """Make the newest picture received up to half a frame after ``at_us`` the one on show."""
        horizon = at_us + VIDEO_HALF_TICK_US
        due = [item for item in self._pending if item[0] <= horizon]
        if not due:
            return
        self._pending = [item for item in self._pending if item[0] > horizon]
        pts_us, width, height, rotation, i420 = max(due, key=lambda item: item[0])
        try:
            normalizer = self._normalizer
            if normalizer is None or normalizer.key != (width, height, rotation):
                normalizer = self._normalizer = _Normalizer(self._av, width, height, rotation)
            self._latest = normalizer.apply(i420)
            self._latest_pts = pts_us
        except Exception:  # noqa: BLE001 - one bad picture must not end the recording
            self._normalizer = None
            self.dropped += 1

    # -- end

    def close(self) -> int:
        if self.closed:
            return self.size()
        try:
            # Carry the picture to the end of the audio, then flush the video encoder.
            end_us = self.media_ms * 1000
            while self.tick_us(self._next_tick) <= end_us:
                self._emit(self._next_tick)
                self._next_tick += 1
            for packet in self._vstream.encode(None):
                self._container.mux(packet)
        finally:
            size = super().close()
        return size


def remux_faststart(source: Path, target: Path) -> int:
    """Copy ``source`` into ``target`` with ``moov`` before ``mdat``; no re-encode.  Returns bytes."""
    import av

    incoming = av.open(str(source))
    outgoing = None
    try:
        outgoing = av.open(str(target), mode="w", format="mp4", options={"movflags": "faststart"})
        mapping: dict[int, Any] = {}
        template = getattr(outgoing, "add_stream_from_template", None)
        for stream in incoming.streams:
            if stream.type not in ("audio", "video"):
                continue
            mapping[stream.index] = (
                template(stream) if template is not None else outgoing.add_stream(template=stream)
            )
        for packet in incoming.demux():
            if packet.dts is None or packet.stream.index not in mapping:
                continue
            packet.stream = mapping[packet.stream.index]
            outgoing.mux(packet)
    finally:
        if outgoing is not None:
            outgoing.close()
        incoming.close()
    return target.stat().st_size


# ---------------------------------------------------------------------------- process loop

Emit = Callable[[dict[str, Any]], None]
_BAD = object()
_END = object()


def _reader(stream: BinaryIO, inbox: "queue.Queue[Any]") -> None:
    """Parse frames off stdin until EOF or garbage; the main loop owns everything else."""
    try:
        while True:
            message = read_frame(stream)
            if message is None:
                inbox.put(_END)
                return
            inbox.put(message)
    except FrameError:
        inbox.put(_BAD)
    except (OSError, ValueError):
        inbox.put(_END)


def serve(
    spool_dir: str | os.PathLike[str],
    stream: BinaryIO,
    emit: Emit,
    *,
    clock: Callable[[], float] = time.monotonic,
    stop: threading.Event | None = None,
) -> int:
    """Run the encoder loop; returns the process exit code (0 = clean).

    ``emit`` receives each status as a dict.  ``stop`` is set by a SIGTERM so the loop
    closes its output cleanly (the parent's death delivers SIGTERM and stdin EOF).
    """
    stop = stop or threading.Event()
    try:
        return _serve(Path(spool_dir), stream, emit, clock, stop)
    except Exception as exc:  # noqa: BLE001 - the child must always report, never traceback
        no_space = isinstance(exc, OSError) and exc.errno == errno.ENOSPC
        emit({"s": STATUS_ERROR, "code": "disk_full" if no_space else "encode_failed"})
        return 1


def _serve(
    spool: Path,
    stream: BinaryIO,
    emit: Emit,
    clock: Callable[[], float],
    stop: threading.Event,
) -> int:
    probe = self_test()
    if not probe["ok"]:
        emit({"s": STATUS_ERROR, "code": probe["code"] or "no_av"})
        return 1
    if not spool.is_dir():
        emit({"s": STATUS_ERROR, "code": "spool_unusable"})
        return 1
    emit({"s": STATUS_READY, "av": probe["av"], "x264": probe["x264"], "aac": probe["aac"]})

    inbox: queue.Queue[Any] = queue.Queue(maxsize=128)
    threading.Thread(target=_reader, args=(stream, inbox), daemon=True, name="r1enc_reader").start()

    writer: AudioSpool | None = None
    hello = False
    closed_info: dict[str, int] | None = None
    last_beat = clock()
    origin_us = 0  # the clock reading, in microseconds, that media time zero is counted from

    def media_now_us() -> int:
        return int(clock() * 1_000_000) - origin_us

    def counters() -> dict[str, int]:
        if writer is None:
            return {"frames": 0, "dropped": 0, "black": 0}
        return {"frames": writer.frames, "dropped": writer.dropped, "black": writer.black}

    def beat(force: bool = False) -> None:
        nonlocal last_beat
        now = clock()
        if not force and now - last_beat < HEARTBEAT_SECONDS:
            return
        last_beat = now
        size = writer.size() if writer is not None else 0
        media = writer.media_ms if writer is not None else 0
        emit({"s": STATUS_PROGRESS, **counters(), "bytes": size, "media_ms": media})

    def close_output() -> None:
        nonlocal closed_info
        if writer is None or closed_info is not None:
            return
        size = writer.close()
        closed_info = {"bytes": size, "media_ms": writer.media_ms}
        emit(
            {"s": STATUS_CLOSED, **counters(), "bytes": size, "media_ms": writer.media_ms,
             "width": writer.width, "height": writer.height, "fps": writer.fps}
        )

    while True:
        if stop.is_set():
            close_output()
            return 0
        pictured = writer is not None and writer.has_video and closed_info is None
        try:
            message = inbox.get(timeout=VIDEO_POLL_SECONDS if pictured else 0.25)
        except queue.Empty:
            if pictured:
                writer.advance(media_now_us())
            beat()
            continue
        if message is _END:
            close_output()
            return 0
        if message is _BAD:
            emit({"s": STATUS_ERROR, "code": "protocol"})
            close_output()
            return 2
        msg_type, pts_us, payload = message
        if not hello:
            if msg_type != MSG_HELLO:
                emit({"s": STATUS_ERROR, "code": "protocol"})
                return 2
            try:
                settings = parse_hello(payload)
            except FrameError:
                emit({"s": STATUS_ERROR, "code": "protocol"})
                return 2
            origin_us = pick_origin_us(int(clock() * 1_000_000), settings["t0_us"])
            writer = _open_writer(spool / STREAM_NAME, settings, probe)
            hello = True
            beat(force=True)
            continue
        if msg_type == MSG_AUDIO:
            if writer is not None and closed_info is None:
                writer.write(pts_us, payload)
        elif msg_type == MSG_VIDEO:
            if writer is not None and closed_info is None:
                writer.feed_video(pts_us, payload)  # a no-op for an audio-only spool
        elif msg_type == MSG_EOF:
            close_output()
        elif msg_type == MSG_REMUX:
            _handle_remux(spool, closed_info is not None, emit)
        elif msg_type == MSG_QUIT:
            close_output()
            return 0
        else:  # a second HELLO
            emit({"s": STATUS_ERROR, "code": "protocol"})
            close_output()
            return 2
        if writer is not None and writer.has_video and closed_info is None:
            writer.advance(media_now_us())
        beat()


def pick_origin_us(now_us: int, t0_us: int) -> int:
    """The clock reading media time zero is counted from.

    The parent's ``t0`` is on the same monotonic clock when both processes run on one machine
    (always, in production), so it is trusted when it is close to the child's own reading;
    anything else is another clock domain and time zero is when ``HELLO`` arrived.
    """
    if t0_us > 0 and abs(now_us - t0_us) <= ORIGIN_TOLERANCE_US:
        return t0_us
    return now_us


def _open_writer(path: Path, settings: dict[str, Any], probe: dict[str, Any]) -> AudioSpool:
    """The spool the ``HELLO`` asked for; a picture request the wheel cannot serve is audio only.

    The parent learns which one it got from ``closed`` (``width`` 0 means no picture) and from
    the ``x264`` flag of ``ready``.  A disk error is never swallowed here.
    """
    if settings["video"] and probe["x264"]:
        try:
            return AVSpool(path, preset=settings["preset"])
        except OSError:
            raise
        except Exception:  # noqa: BLE001 - libx264 refused to open: keep the voices, lose the picture
            pass
    return AudioSpool(path)


def _handle_remux(spool: Path, closed: bool, emit: Emit) -> None:
    source, target = spool / STREAM_NAME, spool / VIDEO_NAME
    if not closed or not source.is_file():
        emit({"s": STATUS_ERROR, "code": "remux_failed"})
        return
    try:
        size = remux_faststart(source, target)
    except Exception as exc:  # noqa: BLE001 - a failed copy leaves the streamed file as deliverable
        no_space = isinstance(exc, OSError) and exc.errno == errno.ENOSPC
        emit({"s": STATUS_ERROR, "code": "disk_full" if no_space else "remux_failed"})
        try:
            target.unlink()
        except OSError:
            pass
        return
    emit({"s": STATUS_REMUXED, "bytes": size})


# ---------------------------------------------------------------------------- entry point


def _lower_priority() -> None:
    """Nice +10 and die with the parent; both are best effort and Linux/POSIX only."""
    try:
        os.nice(10)
    except (AttributeError, OSError):
        pass
    if sys.platform.startswith("linux"):
        try:
            import ctypes
            import signal

            ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, int(signal.SIGTERM))  # PR_SET_PDEATHSIG
        except Exception:  # noqa: BLE001
            pass


def _write_status(fields: dict[str, Any]) -> None:
    try:
        os.write(1, status_line(**fields))
    except OSError:
        pass  # the parent is gone; the loop ends on stdin EOF


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        _write_status({"s": STATUS_ERROR, "code": "spool_unusable"})
        return 2
    _lower_priority()
    stop = threading.Event()
    try:
        import signal

        signal.signal(signal.SIGTERM, lambda _signo, _frame: stop.set())
    except (ImportError, ValueError, OSError, AttributeError):
        pass
    # Raw, unbuffered stdin: a daemon thread blocked in a BufferedReader read holds that
    # reader's lock, and interpreter shutdown then aborts ("could not acquire lock for
    # <stdin> at interpreter shutdown").  The entry point also skips finalization below.
    stdin = os.fdopen(sys.stdin.fileno(), "rb", buffering=0, closefd=False)
    return serve(args[0], stdin, _write_status, stop=stop)


if __name__ == "__main__":
    # Every output is already closed and the status lines are unbuffered ``os.write`` calls,
    # so there is nothing left for a normal shutdown to flush; skipping it is what keeps the
    # reader thread (blocked on the pipe) from crashing the exit.
    os._exit(main())
