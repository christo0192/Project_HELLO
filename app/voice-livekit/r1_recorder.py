"""R1 interview recorder: the job-process side of in-worker recording.

What it records, and where it goes (binding contract C1-C11, ``IMPLEMENTER-RULES.md``):

* The stock SDK ``RecorderIO`` keeps writing a stereo OGG (left candidate, right agent) to a
  spool file.  A subclass tees each lock-step chunk to a tee thread that resamples to 48 kHz,
  mixes to mono, pads wall-clock gaps with silence and hands the PCM to a niced child
  process (``r1_video_encoder``), which writes a fragmented MP4 (AAC) that grows as the
  interview goes on.  In ``av`` mode the recorder also subscribes to the candidate's camera
  itself (the session connects audio-only), decimates it to 15 fps and hands the pictures to the
  same child, which puts them on a constant-rate clock next to the audio.  A watchdog gives the
  picture up (never the audio) when the machine is struggling.
* One uploader thread talks to the API (``/api/internal/r1/recording/{prepare,part-url,
  object-url,complete}``) and PUTs to the presigned URLs it returns: 5 MiB parts cut from the
  growing MP4, and the whole OGG every ``checkpoint_interval_sec``.  The worker holds no R2
  credential, ever.
* ``stop()`` (sync, from ``_begin_exit``) closes capture and starts the finish, which has its
  own deadline carved out of the interview's shared exit budget, so it overlaps the
  transcript drain.  ``finish()`` (async, from ``_exit``) only waits for it.

Failure never reaches the interview: ``start``, ``stop`` and ``finish`` do not raise, nothing
blocks the event loop (all network, process and spool-wipe I/O is on threads), and a recorder that cannot
work switches itself off.  The API can also tell the worker to throw the recording away
(recording disabled, consent withdrawn, row deleted); then capture stops, the encoder is
killed and the spool is overwritten and unlinked.

Privacy: the spool is ``/tmp/r1-rec/<session_id>/`` (mode 0700) and is deleted when the finish
ends.  Presigned URLs, object keys, upload ids, ETags and ids never reach a log line: every
call below is ``_log.<level>("unknown_event", error_type="r1_rec_<code>", ...)`` with
allowlisted, fixed values only.
"""
from __future__ import annotations

import asyncio
import collections
import concurrent.futures
import contextlib
import http.client
import json
import os
import queue
import random
import re
import select
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import urlsplit

from observability import StructuredLogger
from r1_context import _endpoint

# Plan section 9 fence 10: StructuredLogger only; fixed codes, never a value that could carry
# a URL, an id or an exception message.
_log = StructuredLogger("r1")

# ---------------------------------------------------------------------------- constants

MODE_OFF = "off"
MODE_AUDIO = "audio"
MODE_AV = "av"
_MODE_RANK = {MODE_OFF: 0, MODE_AUDIO: 1, MODE_AV: 2}
# Camera capture: with this off an ``av`` request is recorded as audio (a kill switch for tests).
VIDEO_CAPTURE_READY = True
PRESETS = ("ultrafast", "superfast", "veryfast")
DEFAULT_PRESET = "superfast"

SPOOL_ROOT = Path("/tmp/r1-rec")
STREAM_NAME = "stream.mp4"
VIDEO_NAME = "video.mp4"
OGG_NAME = "audio.ogg"
_SPOOL_FILES = (STREAM_NAME, VIDEO_NAME, OGG_NAME)
MIN_FREE_BYTES_AV = 400 * 1024 * 1024
MIN_FREE_BYTES_AUDIO = 64 * 1024 * 1024

SAMPLE_RATE = 48000
DEFAULT_PART_SIZE = 5 * 1024 * 1024
MIN_PART_SIZE = 64 * 1024
MAX_PART_SIZE = 64 * 1024 * 1024
MAX_PARTS = 60
DEFAULT_CHECKPOINT_SECONDS = 120.0
RECORDING_FINISH_NOMINAL_SECONDS = 18.0

CONNECT_TIMEOUT_SECONDS = 5.0
CALL_TIMEOUT_SECONDS = 60.0
FINISH_CALL_TIMEOUT_CAP_SECONDS = 15.0
RETRY_DELAYS_SECONDS = (1.0, 3.0, 7.0)
FAILED_ROUND_COOLDOWN_SECONDS = 15.0

SELF_TEST_WAIT_SECONDS = 8.0
ENCODER_STALL_SECONDS = 5.0
ENCODER_CLOSE_WAIT_SECONDS = 4.0
IO_CLOSE_WAIT_SECONDS = 3.0
IO_START_WAIT_SECONDS = 3.0
TEE_DRAIN_WAIT_SECONDS = 2.0
COMPLETE_RESERVE_SECONDS = 3.0
FASTSTART_MIN_REMAINING_SECONDS = 8.0
# A tee gap smaller than this is rounding, not a rejoin gap (see ``TeeMixer``).
GAP_SLACK_SECONDS = 0.25
# Peak amplitude (16-bit LSBs) of what counts as silence at the front of a chunk that is ahead of the
# clock: the SDK's silence frame, once resampled, carries +-1 LSB of dither (measured), never more.
SILENCE_LEVEL = 2
MAX_AUDIO_PIECE_SECONDS = 30
# 30 s of 48 kHz mono s16 may queue for a slow encoder; more means it is stuck.
ENCODER_AUDIO_BACKLOG_BYTES = 30 * SAMPLE_RATE * 2

# Camera capture (roadmap section 8).  Numeric SDK values, pinned by ``test_r1_sdk_contract``:
# ``rtc.TrackKind.KIND_VIDEO``, ``rtc.TrackSource.SOURCE_CAMERA``, ``rtc.ParticipantKind.STANDARD``,
# ``rtc.VideoBufferType.I420`` and the ``VideoRotation`` enum (0, 1, 2, 3 = 0, 90, 180, 270 degrees).
KIND_VIDEO = 2
SOURCE_CAMERA = 1
PARTICIPANT_STANDARD = 0
BUFFER_I420 = 5
ROTATION_DEGREES = {0: 0, 1: 90, 2: 180, 3: 270}
VIDEO_FPS = 15
# A picture is taken when it arrives at least this long after the last one taken: a 30 fps camera
# is halved, a 15 fps one passes untouched.
VIDEO_MIN_GAP_SECONDS = 0.060
# The SDK's own ring (drops the oldest) and our queue in front of the child's pipe (likewise).
VIDEO_STREAM_CAPACITY = 3
VIDEO_QUEUE_MAX = 3
VIDEO_MIN_SIDE = 16
VIDEO_MAX_SIDE = 4096

# Watchdog thresholds (roadmap section 8, "Isolation and degrade").  Level 1 gives up the picture;
# nothing here ever touches the audio.
LAG_TICK_SECONDS = 0.05
LAG_LIMIT_SECONDS = 0.25
LAG_WINDOW_SECONDS = 5.0
VAD_LOAD_FRACTION = 0.40  # mean inference time as a share of one VAD window
VAD_SINGLE_LIMIT_SECONDS = 0.2
VAD_WINDOW_SECONDS = 0.032
VAD_CONSECUTIVE_BATCHES = 2
DROP_RATIO_LIMIT = 0.30
DROP_WINDOW_SECONDS = 10.0
DROP_MIN_PICTURES = 30
BACKLOG_PARTS_LIMIT = 6
SPOOL_BYTES_LIMIT = 300 * 1024 * 1024
LOW_FREE_BYTES = 128 * 1024 * 1024
MAX_DEGRADED_AT_MS = 86_400_000

FORCED_OUTCOMES = frozenset({"shutdown_forced"})
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_ROOM_RE = re.compile(r"^screening-[0-9a-f-]{36}$")
_CODE_RE = re.compile(r"^[a-z0-9_]{1,64}$")
_SENSITIVE_ENV_RE = re.compile(r"SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL", re.IGNORECASE)

# API answers and what the worker does about them (contract C4).
OK = "ok"
RETRY = "retry"
DISCARD = "discard"
STOP = "stop"
FAILED = "failed"
ABORTED = "aborted"


def _error_type_of(exc: BaseException) -> str:
    """Name an exception by its type only: a message could carry a URL or an id."""
    return type(exc).__name__


# ---------------------------------------------------------------------------- modes


def _flags(env: Mapping[str, str] | None) -> tuple[str | None, str | None]:
    """Read the two worker flags.  Literal ``os.environ.get`` calls keep the env contract honest."""
    if env is None:
        return os.environ.get("R1_RECORDING"), os.environ.get("R1_VIDEO_RECORDING")
    return env.get("R1_RECORDING"), env.get("R1_VIDEO_RECORDING")


def worker_capability(env: Mapping[str, str] | None = None) -> str:
    """``off`` unless ``R1_RECORDING`` is exactly ``on``; then ``av`` iff ``R1_VIDEO_RECORDING`` is."""
    recording, video = _flags(env)
    if recording != "on":
        return MODE_OFF
    return MODE_AV if video == "on" else MODE_AUDIO


def server_mode(context: Mapping[str, Any] | None) -> str:
    """The API's projection (``context["recording"]["mode"]``); missing or malformed is ``off``."""
    if not isinstance(context, Mapping):
        return MODE_OFF
    recording = context.get("recording")
    if not isinstance(recording, Mapping):
        return MODE_OFF
    mode = recording.get("mode")
    return mode if isinstance(mode, str) and mode in _MODE_RANK else MODE_OFF


def effective_mode(context: Mapping[str, Any] | None, env: Mapping[str, str] | None = None) -> str:
    """``min(capability, server)`` with ``off < audio < av``."""
    capability, server = worker_capability(env), server_mode(context)
    return capability if _MODE_RANK[capability] <= _MODE_RANK[server] else server


def x264_preset(env: Mapping[str, str] | None = None) -> str:
    """``R1_VIDEO_X264_PRESET``: ``ultrafast``, ``superfast`` or ``veryfast``; anything else is the default."""
    raw = os.environ.get("R1_VIDEO_X264_PRESET") if env is None else env.get("R1_VIDEO_X264_PRESET")
    return raw if raw in PRESETS else DEFAULT_PRESET


# ---------------------------------------------------------------------------- spool


class Spool:
    """``<root>/<session_id>/``: the only place candidate media touches the worker's disk.

    Files are removed by name from an allowlist and the directory with ``os.rmdir``, never
    recursively, so a wrong path can at worst fail to delete.
    """

    def __init__(self, root: Path, session_id: str) -> None:
        self.root = Path(root)
        self.session_id = session_id
        self.dir = self.root / session_id

    @property
    def stream_path(self) -> Path:
        return self.dir / STREAM_NAME

    @property
    def video_path(self) -> Path:
        return self.dir / VIDEO_NAME

    @property
    def ogg_path(self) -> Path:
        return self.dir / OGG_NAME

    def create(self) -> None:
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.dir.mkdir(mode=0o700, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(self.dir, 0o700)

    def free_bytes(self) -> int:
        probe = self.root
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        return shutil.disk_usage(probe).free

    def used_bytes(self) -> int:
        """Bytes the spool files hold right now (a missing file counts as nothing)."""
        total = 0
        for name in _SPOOL_FILES:
            try:
                total += (self.dir / name).stat().st_size
            except OSError:
                continue
        return total

    def wipe(self, *, overwrite: bool = False) -> bool:
        """Delete the spool files (zero-filling them first when ``overwrite``) and the directory."""
        return _wipe_directory(self.dir, overwrite=overwrite)

    @staticmethod
    def clean_stale(root: Path, keep: str) -> int:
        """Delete every spool directory under ``root`` except ``keep``; returns how many went."""
        removed = 0
        try:
            entries = list(os.scandir(root))
        except OSError:
            return 0
        for entry in entries:
            if entry.name == keep:
                continue
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            if _wipe_directory(Path(entry.path), overwrite=False):
                removed += 1
        return removed


def _wipe_directory(path: Path, *, overwrite: bool) -> bool:
    try:
        names = os.listdir(path)
    except OSError:
        return not path.exists()
    for name in names:
        if name not in _SPOOL_FILES:
            continue  # not ours: leave it, and the directory with it
        target = path / name
        try:
            if overwrite and target.is_file() and not target.is_symlink():
                _zero_fill(target)
            os.unlink(target)
        except OSError:
            continue
    try:
        os.rmdir(path)
    except OSError:
        return False
    return True


def _zero_fill(path: Path) -> None:
    size = path.stat().st_size
    block = b"\x00" * (1024 * 1024)
    with open(path, "r+b", buffering=0) as handle:
        remaining = size
        while remaining > 0:
            chunk = block[: min(remaining, len(block))]
            handle.write(chunk)
            remaining -= len(chunk)
        with contextlib.suppress(OSError):
            os.fsync(handle.fileno())


# ---------------------------------------------------------------------------- HTTP


class HttpFailure(Exception):
    """A transport failure (``network``, ``timeout``, ``aborted``, ``bad_url``, ``no_secret``)."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


@dataclass(frozen=True)
class HttpReply:
    status: int
    headers: dict[str, str]
    body: bytes


class HttpClient:
    """Minimal HTTP/1.1 client with a connect timeout, a total deadline and two ways to cut a request.

    ``http.client`` rather than ``urllib``: a presigned PUT must go out exactly as signed (no
    ``Accept-Encoding``, no extra headers), the total time must be bounded, and the request in
    flight must be cuttable from another thread.

    * ``abort()`` is the last resort at the finish deadline: this client sends nothing more, ever.
    * ``cancel_inflight()`` is for one request only.  A request is started with a ``cancel`` event;
      when the event is set and ``cancel_inflight()`` is called (in that order), that request ends
      with ``HttpFailure("cancelled")`` and the client stays usable.  The finish uses it so that a
      slow mid-call part PUT (60 s allowed) cannot hold the finish's jobs up.
    """

    _CHUNK = 64 * 1024
    _REPLY_LIMIT = 64 * 1024

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active: http.client.HTTPConnection | None = None
        self._active_cancel: threading.Event | None = None
        self._aborted = threading.Event()

    @staticmethod
    def _cut(conn: Any) -> None:
        sock = getattr(conn, "sock", None)
        if sock is not None:
            with contextlib.suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)
            with contextlib.suppress(OSError):
                sock.close()

    def abort(self) -> None:
        self._aborted.set()
        with self._lock:
            conn = self._active
        self._cut(conn)

    def cancel_inflight(self) -> None:
        """Cut the request in flight if it was started cancellable and its event is now set.

        The caller sets the event FIRST.  A request that registers after this call sees the event
        set (``request`` checks it again once it is registered); one that registered before is cut
        here.  Nothing happens to a request started without an event (a finish job).
        """
        with self._lock:
            conn, cancel = self._active, self._active_cancel
        if conn is not None and cancel is not None and cancel.is_set():
            self._cut(conn)

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        connect_timeout: float,
        total_timeout: float,
        cancel: threading.Event | None = None,
    ) -> HttpReply:
        if self._aborted.is_set():
            raise HttpFailure("aborted")
        if cancel is not None and cancel.is_set():
            raise HttpFailure("cancelled")
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise HttpFailure("bad_url")
        deadline = time.monotonic() + total_timeout
        target = parts.path or "/"
        if parts.query:
            target = target + "?" + parts.query
        try:
            if parts.scheme == "https":
                conn: http.client.HTTPConnection = http.client.HTTPSConnection(
                    parts.hostname, parts.port, timeout=connect_timeout,
                    context=ssl.create_default_context(),
                )
            else:
                conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=connect_timeout)
        except (ValueError, OSError) as exc:
            raise HttpFailure("bad_url") from exc
        with self._lock:
            self._active = conn
            self._active_cancel = cancel
        try:
            self._check(deadline, cancel)  # (a cancel that landed before the registration above)
            conn.putrequest(method, target, skip_accept_encoding=True)
            for name, value in headers.items():
                conn.putheader(name, value)
            if body is not None:
                conn.putheader("Content-Length", str(len(body)))
            conn.endheaders()  # connects here, under the connect timeout
            sock = conn.sock
            self._check(deadline, cancel)  # (a cancel that landed while connecting)
            if body is not None:
                view = memoryview(body)
                sent = 0
                while sent < len(view):
                    self._check(deadline, cancel)
                    if sock is not None:
                        sock.settimeout(max(0.2, min(30.0, deadline - time.monotonic())))
                    chunk = view[sent : sent + self._CHUNK]
                    conn.send(chunk)
                    sent += len(chunk)
            self._await_reply(sock, deadline, cancel)
            if sock is not None:
                sock.settimeout(max(0.2, deadline - time.monotonic()))
            response = conn.getresponse()
            data = response.read(self._REPLY_LIMIT)
            return HttpReply(
                response.status,
                {name.lower(): value for name, value in response.getheaders()},
                data,
            )
        except HttpFailure:
            raise
        except socket.timeout as exc:
            raise HttpFailure(self._interrupted(cancel) or "timeout") from exc
        except (OSError, http.client.HTTPException, ssl.SSLError, ValueError) as exc:
            raise HttpFailure(self._interrupted(cancel) or "network") from exc
        finally:
            with self._lock:
                self._active = None
                self._active_cancel = None
            with contextlib.suppress(Exception):
                conn.close()

    def _interrupted(self, cancel: threading.Event | None) -> str | None:
        """Why a socket error is really somebody cutting the request: ``aborted``, ``cancelled`` or neither."""
        if self._aborted.is_set():
            return "aborted"
        if cancel is not None and cancel.is_set():
            return "cancelled"
        return None

    def _check(self, deadline: float, cancel: threading.Event | None = None) -> None:
        if self._aborted.is_set():
            raise HttpFailure("aborted")
        if cancel is not None and cancel.is_set():
            raise HttpFailure("cancelled")
        if time.monotonic() >= deadline:
            raise HttpFailure("timeout")

    def _await_reply(self, sock: Any, deadline: float, cancel: threading.Event | None = None) -> None:
        """Wait for the first byte of the answer in short slices, so an abort, a cancel or the
        deadline is noticed within a quarter of a second on every platform (a blocking read in
        another thread is not reliably woken by closing its socket)."""
        if sock is None:
            self._check(deadline, cancel)
            return
        while True:
            self._check(deadline, cancel)
            ready, _, _ = select.select([sock], [], [], min(0.25, max(0.0, deadline - time.monotonic())))
            if ready:
                return


@dataclass(frozen=True)
class ApiReply:
    status: int
    data: dict[str, Any]
    code: str | None
    etag: str | None = None


class RecordingApi:
    """The four worker routes plus the presigned PUT, over an injectable ``HttpClient``."""

    def __init__(
        self,
        http_client: HttpClient,
        room: str,
        *,
        endpoint: Callable[[str], str] = _endpoint,
        secret: Callable[[], str | None] | None = None,
    ) -> None:
        self._http = http_client
        self._room = room
        self._endpoint = endpoint
        self._secret = secret or (lambda: os.getenv("WORKER_CONTEXT_SECRET"))

    def post(
        self,
        op: str,
        body: Mapping[str, Any],
        *,
        connect_timeout: float,
        total_timeout: float,
        cancel: threading.Event | None = None,
    ) -> ApiReply:
        secret = self._secret()
        if not secret:
            raise HttpFailure("no_secret")
        payload = json.dumps({"room": self._room, **body}).encode("utf-8")
        reply = self._http.request(
            "POST",
            self._endpoint("/api/internal/r1/recording/" + op),
            headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"},
            body=payload,
            connect_timeout=connect_timeout,
            total_timeout=total_timeout,
            cancel=cancel,
        )
        data: dict[str, Any] = {}
        try:
            decoded = json.loads(reply.body.decode("utf-8")) if reply.body else {}
            if isinstance(decoded, dict):
                data = decoded
        except (UnicodeDecodeError, ValueError):
            data = {}
        code = data.get("error")
        return ApiReply(reply.status, data, code if isinstance(code, str) and _CODE_RE.match(code) else None)

    def put(
        self,
        url: str,
        body: bytes,
        content_type: str,
        *,
        connect_timeout: float,
        total_timeout: float,
        cancel: threading.Event | None = None,
    ) -> ApiReply:
        reply = self._http.request(
            "PUT",
            url,
            headers={"Content-Type": content_type},
            body=body,
            connect_timeout=connect_timeout,
            total_timeout=total_timeout,
            cancel=cancel,
        )
        return ApiReply(reply.status, {}, None, reply.headers.get("etag"))


def classify(reply: ApiReply) -> tuple[str, str]:
    """Map an API answer to ``(OK|RETRY|DISCARD|STOP, reason)`` (contract C4, worker reaction)."""
    if reply.status == 200:
        return OK, "ok"
    if reply.status == 410:
        return DISCARD, "deleted"
    if reply.status == 409 and reply.code == "r1_consent_withdrawn":
        return DISCARD, "consent_withdrawn"
    if reply.status == 503 and reply.code == "r1_recording_disabled":
        return DISCARD, "disabled"
    if reply.status == 409:
        return STOP, "state" if reply.code == "r1_recording_state" else "session"
    if reply.status in (400, 401, 403, 404):
        return STOP, "rejected"
    return RETRY, "retry"


# ---------------------------------------------------------------------------- encoder process


def _wire() -> Any:
    """The encoder module, for its wire-protocol helpers (a real import the Docker closure sees)."""
    import r1_video_encoder

    return r1_video_encoder


class EncoderProcess:
    """The niced child that writes the MP4 spool, spoken to over pipes (protocol C9).

    All pipe I/O is on two daemon threads, so a stuck child can block only them; the
    recorder's watchdog notices the missing heartbeat and kills it.

    Two queues feed the one writer thread.  The ordered queue carries HELLO, audio and the
    control messages and is never reordered; the picture queue holds at most
    ``VIDEO_QUEUE_MAX`` pictures and drops the OLDEST when full (counted), so a slow child can
    never make the event loop wait or the process grow.  Audio goes first; a barrier message
    (EOF, REMUX, QUIT) waits until the pictures queued before it have been written.
    """

    def __init__(
        self,
        spool_dir: Path,
        *,
        python: str | None = None,
        module_dir: Path | None = None,
        popen: Callable[..., Any] = subprocess.Popen,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._spool_dir = Path(spool_dir)
        self._python = python or sys.executable
        self._module_dir = Path(module_dir) if module_dir else Path(__file__).resolve().parent
        self._popen = popen
        self._clock = clock
        self._proc: Any = None
        self._ordered: collections.deque[tuple[bytes, bool]] = collections.deque()
        self._pictures: collections.deque[tuple[int, int, int, int, bytes]] = collections.deque()
        self._wake = threading.Condition()
        self._writer_stop = False
        self._queued = 0
        self._lock = threading.Lock()
        self.video_dropped = 0  # pictures pushed out of the queue by newer ones
        self.video_sent = 0  # pictures written to the pipe
        self.ready = threading.Event()
        self.closed = threading.Event()
        self.remuxed = threading.Event()
        self.exited = threading.Event()
        self.ready_info: dict[str, Any] | None = None
        self.error_code: str | None = None
        self.closed_info: dict[str, Any] | None = None
        self.remux_bytes: int | None = None
        self.progress: dict[str, Any] = {}
        self.spawned_at: float | None = None
        self.last_status_at: float | None = None
        self.overflowed = False
        self._quit_sent = False
        self._killed = False

    def spawn(self) -> bool:
        """Start the child; ``False`` (and a dead encoder) when it cannot be started."""
        # The child needs none of the worker's credentials: it inherits the environment minus
        # anything that looks like a secret.
        env = {k: v for k, v in os.environ.items() if not _SENSITIVE_ENV_RE.search(k)}
        try:
            self._proc = self._popen(
                [self._python, "-m", "r1_video_encoder", str(self._spool_dir)],
                cwd=str(self._module_dir),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=env,
                close_fds=True,
            )
        except (OSError, ValueError):
            self.exited.set()
            return False
        self.spawned_at = self._clock()
        threading.Thread(target=self._write_loop, daemon=True, name="r1rec_enc_w").start()
        threading.Thread(target=self._read_loop, daemon=True, name="r1rec_enc_r").start()
        return True

    # -- state

    @property
    def dead(self) -> bool:
        """The child exited (or never started) without having closed its output on request."""
        if self.overflowed or self._killed:
            return True
        return self.exited.is_set() and not (self.closed.is_set() or self._quit_sent)

    def seconds_since_spawn(self) -> float | None:
        """How long ago the child was started, on THIS process's clock (None before a spawn).

        The watchdog asks the encoder for its own ages rather than subtracting the encoder's stamps
        from its own clock: the two clocks are injected separately, so mixing them could report a
        healthy child as stalled (or a stalled one as healthy).
        """
        spawned = self.spawned_at
        return None if spawned is None else self._clock() - spawned

    def seconds_since_status(self) -> float | None:
        """How long ago the child last reported anything, on THIS process's clock (None before)."""
        last = self.last_status_at
        return None if last is None else self._clock() - last

    def alive(self) -> bool:
        proc = self._proc
        return proc is not None and proc.poll() is None

    def can_encode_video(self) -> bool:
        """The child can take pictures: alive, and (once it has reported) libx264 is there."""
        if self.dead or self.exited.is_set():
            return False
        info = self.ready_info
        return info is None or bool(info.get("x264"))

    # -- sending

    def _send(self, frame: bytes, *, barrier: bool = False) -> bool:
        if self._proc is None or self.exited.is_set() or self._killed:
            return False
        with self._lock:
            self._queued += len(frame)
        with self._wake:
            self._ordered.append((frame, barrier))
            self._wake.notify()
        return True

    def send_video(self, pts_us: int, width: int, height: int, rotation: int, picture: bytes) -> bool:
        """Queue one I420 picture (never blocks).  The oldest queued picture goes when it is full."""
        if self._proc is None or self.exited.is_set() or self._killed:
            return False
        with self._wake:
            if len(self._pictures) >= VIDEO_QUEUE_MAX:
                self._pictures.popleft()
                self.video_dropped += 1
            self._pictures.append((pts_us, width, height, rotation, picture))
            self._wake.notify()
        return True

    def send_hello(self, *, video: bool, preset: str, t0_us: int) -> bool:
        return self._send(_wire().pack_hello(video=video, preset=preset, t0_us=t0_us))

    def send_audio(self, pts_us: int, pcm: bytes) -> bool:
        with self._lock:
            backlog = self._queued
        if backlog > ENCODER_AUDIO_BACKLOG_BYTES:
            self.overflowed = True  # a stuck child: the watchdog turns this into a crash
            return False
        return self._send(_wire().pack_audio(pts_us, pcm))

    def send_eof(self) -> bool:
        return self._send(_wire().pack_eof(), barrier=True)

    def send_remux(self) -> bool:
        return self._send(_wire().pack_remux(), barrier=True)

    def quit(self) -> bool:
        self._quit_sent = True
        return self._send(_wire().pack_quit(), barrier=True)

    def kill(self) -> None:
        """SIGKILL equivalent; the spool stays valid up to its last fragment."""
        self._killed = True
        proc = self._proc
        if proc is not None:
            with contextlib.suppress(Exception):
                proc.kill()
        with self._wake:
            self._writer_stop = True
            self._ordered.clear()
            self._pictures.clear()
            self._wake.notify_all()

    # -- threads

    def _next_to_write(self) -> tuple[bytes, bool] | None:
        """The next message for the pipe: ordered ones first (a barrier waits for the pictures
        queued ahead of it), else a picture.  ``None`` when the writer must stop."""
        with self._wake:
            while True:
                if self._writer_stop:
                    return None
                if self._ordered:
                    frame, barrier = self._ordered[0]
                    if not barrier or not self._pictures:
                        self._ordered.popleft()
                        return frame, True
                if self._pictures:
                    pts_us, width, height, rotation, picture = self._pictures.popleft()
                    return _wire().pack_video(pts_us, width, height, rotation, picture), False
                self._wake.wait()

    def _write_loop(self) -> None:
        proc = self._proc
        stdin = proc.stdin
        try:
            while True:
                item = self._next_to_write()
                if item is None:
                    break
                frame, ordered = item
                try:
                    stdin.write(frame)
                    stdin.flush()
                except (OSError, ValueError):
                    self.exited.set()
                    break
                finally:
                    if ordered:
                        with self._lock:
                            self._queued -= len(frame)
                if not ordered:
                    self.video_sent += 1
        finally:
            with contextlib.suppress(Exception):
                stdin.close()

    def _read_loop(self) -> None:
        parse_status = _wire().parse_status
        proc = self._proc
        try:
            for raw in iter(lambda: proc.stdout.readline(1024), b""):
                status = parse_status(raw)
                if status is not None:
                    self._apply(status)
        except (OSError, ValueError):
            pass
        finally:
            self.exited.set()
            with self._wake:  # the child is gone: nothing more can be written to it
                self._writer_stop = True
                self._wake.notify_all()
            with contextlib.suppress(Exception):
                proc.wait(timeout=5)  # reap the child so it never lingers as a zombie

    def _apply(self, status: dict[str, Any]) -> None:
        self.last_status_at = self._clock()
        kind = status["s"]
        if kind == "ready":
            self.ready_info = status
            self.ready.set()
        elif kind == "error":
            self.error_code = status.get("code")
            if self.error_code == "remux_failed":
                self.remuxed.set()  # wake the waiter; ``remux_bytes`` stays None
        elif kind == "progress":
            self.progress = status
        elif kind == "closed":
            self.closed_info = status
            self.closed.set()
        elif kind == "remuxed":
            self.remux_bytes = status.get("bytes", 0)
            self.remuxed.set()


# ---------------------------------------------------------------------------- audio tee


class _ChannelResampler:
    """One channel's frames -> 48 kHz mono int16, with the resampler state kept across chunks."""

    def __init__(self) -> None:
        self._resampler: Any = None
        self._key: tuple[int, int] | None = None

    def convert(self, frames: list[Any], *, flush: bool) -> Any:
        import numpy as np

        pieces: list[Any] = []
        for frame in frames:
            for converted in self._push(frame):
                pieces.append(_mono_int16(converted))
        if flush and self._resampler is not None:
            for converted in self._resampler.flush():
                pieces.append(_mono_int16(converted))
        if not pieces:
            return np.zeros(0, dtype=np.int16)
        return pieces[0] if len(pieces) == 1 else np.concatenate(pieces)

    def _push(self, frame: Any) -> list[Any]:
        from livekit import rtc

        if frame.sample_rate == SAMPLE_RATE:
            return [frame]
        key = (frame.sample_rate, frame.num_channels)
        if self._resampler is None or key != self._key:
            self._resampler = rtc.AudioResampler(
                input_rate=frame.sample_rate, output_rate=SAMPLE_RATE, num_channels=frame.num_channels
            )
            self._key = key
        return list(self._resampler.push(frame))


def _mono_int16(frame: Any) -> Any:
    import numpy as np

    channels = frame.num_channels
    samples = np.frombuffer(frame.data, dtype=np.int16, count=frame.samples_per_channel * channels)
    if channels == 1:
        return samples.copy()
    return (samples.reshape(-1, channels).sum(axis=1, dtype=np.int32) // channels).astype(np.int16)


class TeeMixer:
    """Turn the SDK's lock-step ``(candidate, agent)`` chunks into one continuous mono timeline.

    Each chunk is stamped with the monotonic time it was queued.  The timeline is the 48 kHz
    sample clock counted from ``t0``; when a chunk leaves it short of the wall clock by more
    than ``GAP_SLACK_SECONDS`` (the candidate's audio stopped arriving, e.g. across a rejoin
    gap while the agent was silent) the missing time is filled with silence at the front of
    the chunk.  Without that, the SDK's gapless assumption would shift the audio behind the
    wall clock for the rest of the call.  Position inside one chunk (2.5 s) is approximate;
    the total is exact.

    The opposite error is handled too, but only ever by dropping digital silence.  The SDK
    pads the candidate's FIRST input chunk once, in front, with the time between the end of the
    last agent line and the first microphone frame (``RecorderAudioInput.take_buf``).  When the
    microphone starts after an agent line, the wall-clock padding above has already filled that
    stretch, so the chunk arrives ahead of the clock by the same amount, and without a trim every
    later sound would sit that much late for the rest of the call.  A chunk that is ahead of the
    clock by more than the slack gives up the leading samples that are silent on BOTH channels
    (``SILENCE_LEVEL``: the resampler turns the SDK's digital silence into +-1 LSB of dither),
    up to the overshoot.  Speech is never cut: a chunk whose first sample is audible is left whole
    (audio ahead of the clock by a few hundred milliseconds is rounding, not a defect).
    """

    def __init__(self, t0: float) -> None:
        self._t0 = t0
        self._channels = (_ChannelResampler(), _ChannelResampler())
        self.emitted = 0  # samples handed out so far (the sample clock)

    def process(self, input_frames: list[Any], output_frames: list[Any], t_mono: float) -> list[tuple[int, bytes]]:
        """Return ``[(pts_us, pcm_s16le), ...]`` for one chunk (empty when it adds nothing)."""
        import numpy as np

        candidate = self._channels[0].convert(input_frames, flush=False)
        agent = self._channels[1].convert(output_frames, flush=bool(output_frames))
        count = max(len(candidate), len(agent))
        # The shorter channel is right-aligned (silence in front), as the SDK does: an agent
        # line is queued when its playback FINISHES, so its end is the end of the chunk.
        if len(candidate) < count:
            candidate = np.concatenate((np.zeros(count - len(candidate), dtype=np.int16), candidate))
        if len(agent) < count:
            agent = np.concatenate((np.zeros(count - len(agent), dtype=np.int16), agent))
        mixed = np.clip(candidate.astype(np.int32) + agent.astype(np.int32), -32768, 32767).astype(np.int16)
        target = int(round((t_mono - self._t0) * SAMPLE_RATE))
        deficit = target - (self.emitted + count)
        slack = int(GAP_SLACK_SECONDS * SAMPLE_RATE)
        if deficit > slack:
            mixed = np.concatenate((np.zeros(deficit, dtype=np.int16), mixed))
        elif -deficit > slack:
            # "Silent" is what the resampler makes of digital silence: +-1 LSB of dither.
            audible = (np.abs(candidate.astype(np.int32)) > SILENCE_LEVEL) | (np.abs(agent.astype(np.int32)) > SILENCE_LEVEL)
            silent = int(audible.argmax()) if audible.any() else count
            drop = min(-deficit, silent)
            if drop > 0:
                mixed = mixed[drop:]
        pieces: list[tuple[int, bytes]] = []
        step = MAX_AUDIO_PIECE_SECONDS * SAMPLE_RATE
        for offset in range(0, len(mixed), step):
            piece = mixed[offset : offset + step]
            pieces.append((self.emitted * 1_000_000 // SAMPLE_RATE, piece.astype("<i2").tobytes()))
            self.emitted += len(piece)
        return pieces


_IO_CLASS: type | None = None


def recorder_io_class() -> type:
    """The ``RecorderIO`` subclass, built on first use (importing it needs the real SDK)."""
    global _IO_CLASS
    if _IO_CLASS is None:
        _IO_CLASS = _build_recorder_io_class()
    return _IO_CLASS


def _build_recorder_io_class() -> type:
    from livekit.agents.voice.recorder_io.recorder_io import RecorderIO

    class _TeeQueue(queue.Queue):
        """A ``queue.Queue`` that also hands every item to the tee, stamped with the clock.

        The SDK puts exactly one item on each queue per write, in lock-step; the tee
        preserves that, and the stock encode thread (the OGG) is left untouched.
        """

        def __init__(self, owner: Any, sink: "queue.Queue[Any]") -> None:
            super().__init__()
            self._owner = owner
            self._sink = sink

        def put(self, item: Any, block: bool = True, timeout: float | None = None) -> None:
            super().put(item, block, timeout)
            self._sink.put((self._owner.tee_clock(), item))

    class R1RecorderIO(RecorderIO):
        """RecorderIO that tees its chunks and stops capturing on request."""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self.tee_clock: Callable[[], float] = time.monotonic
            self.tee_in: queue.Queue[Any] = queue.Queue()
            self.tee_out: queue.Queue[Any] = queue.Queue()
            self._in_q = _TeeQueue(self, self.tee_in)
            self._out_q = _TeeQueue(self, self.tee_out)
            self._capture_closed = False

        @property
        def recording(self) -> bool:  # type: ignore[override]
            return bool(self._started) and not self._capture_closed

        def close_capture(self) -> None:
            """Neither tap accumulates audio from now on (the interview is over)."""
            self._capture_closed = True

        def flush_idle_tail(self) -> bool:
            """Write the candidate audio held back since the last 2.5 s tick.

            Only when the agent is not mid-line: a partly played line at a forced close is
            lost, as in the stock recorder (documented, accepted).  Mirrors the SDK's own
            input-only write (``_forward_task``): one input chunk with an empty output chunk.
            """
            out, inp = self._out_record, self._in_record
            if not self._started or out is None or inp is None or out.has_pending_data:
                return False
            input_buf = inp.take_buf(pad_since=out._last_speech_end_time)
            self._in_q.put_nowait(input_buf)
            self._out_q.put_nowait([])
            return True

    return R1RecorderIO


# ---------------------------------------------------------------------------- camera


def _is_camera(publication: Any) -> bool:
    return getattr(publication, "kind", None) == KIND_VIDEO and getattr(publication, "source", None) == SOURCE_CAMERA


def _default_stream(track: Any) -> Any:
    """The SDK's decoded-frame stream for ``track``: I420 pictures, the oldest dropped when behind."""
    from livekit import rtc

    return rtc.VideoStream(track, capacity=VIDEO_STREAM_CAPACITY, format=rtc.VideoBufferType.I420)


class CameraCapture:
    """The candidate's camera, from subscription to a picture handed to the encoder.

    The session connects audio-only, so nothing forwards the camera to the worker until this
    asks for it (``set_subscribed``).  It follows the candidate across a refresh or a rejoin
    (every new publication, every ``track_subscribed``), re-creates the frame stream whenever
    one ends, and treats a camera that never appears as normal: the encoder shows black for it.

    Each picture is taken only when at least ``VIDEO_MIN_GAP_SECONDS`` have passed since the last
    one taken (receipt time), copied once into ``bytes`` and stamped with ``clock() - t0`` (the same
    media clock as the audio).  ``unsubscribe()`` is the Level 1 degrade: it gives the camera up
    for good.  Everything runs on the event loop.
    """

    _EVENTS = ("participant_connected", "participant_disconnected", "track_published", "track_subscribed", "track_unsubscribed")

    def __init__(
        self,
        *,
        room: Any,
        identity: str | None,
        loop: asyncio.AbstractEventLoop,
        clock: Callable[[], float],
        t0: float,
        on_picture: Callable[[int, int, int, int, bytes], None],
        on_reject: Callable[[], None],
        make_stream: Callable[[Any], Any] = _default_stream,
    ) -> None:
        self._room = room
        self._identity = identity
        self._loop = loop
        self._clock = clock
        self._t0 = t0
        self._on_picture = on_picture
        self._on_reject = on_reject
        self._make_stream = make_stream
        self._handlers: dict[str, Callable[..., None]] = {}
        self._stream: Any = None
        self._track_sid: str | None = None
        self._pump: asyncio.Task[Any] | None = None
        self._last_taken = float("-inf")
        self._off = False
        self._pump_error_logged = False
        self.received = 0  # frames the SDK handed over
        self.taken = 0  # frames passed on to the encoder
        self.rejected = 0  # frames we could not use (odd size, bad length, no conversion)
        self.streams_opened = 0

    # -- lifecycle

    def start(self) -> None:
        """Register for the room's events and look at who is already there."""
        for event in self._EVENTS:
            handler = getattr(self, "_on_" + event)
            self._handlers[event] = handler
            with contextlib.suppress(Exception):
                self._room.on(event, handler)
        self.scan()

    def _unregister(self) -> None:
        handlers, self._handlers = self._handlers, {}
        for event, handler in handlers.items():
            with contextlib.suppress(Exception):
                self._room.off(event, handler)

    def stop(self) -> None:
        """Capture is over (idempotent): no new pictures, the stream is closed."""
        self._off = True
        self._unregister()
        self._close_stream()

    def unsubscribe(self) -> None:
        """Give the camera up for good: ask the SFU to stop sending it, then ``stop``."""
        if self._off:
            return
        for participant in self._candidates():
            for publication in self._publications(participant):
                if _is_camera(publication):
                    with contextlib.suppress(Exception):
                        publication.set_subscribed(False)
        self.stop()

    # -- who and what

    def _is_candidate(self, participant: Any) -> bool:
        if self._identity:
            return getattr(participant, "identity", None) == self._identity
        return getattr(participant, "kind", None) == PARTICIPANT_STANDARD

    def _candidates(self) -> list[Any]:
        participants = getattr(self._room, "remote_participants", None) or {}
        values = participants.values() if hasattr(participants, "values") else participants
        return [p for p in list(values) if self._is_candidate(p)]

    @staticmethod
    def _publications(participant: Any) -> list[Any]:
        publications = getattr(participant, "track_publications", None) or {}
        values = publications.values() if hasattr(publications, "values") else publications
        return list(values)

    def scan(self) -> None:
        """Subscribe to every candidate camera and open the stream for a subscribed one.

        Run at start and once a second by the watchdog, so a missed event costs a second, not the
        picture.
        """
        if self._off:
            return
        for participant in self._candidates():
            for publication in self._publications(participant):
                self._consider(publication)

    def _consider(self, publication: Any) -> None:
        if self._off or not _is_camera(publication):
            return
        try:
            if not getattr(publication, "subscribed", False):
                publication.set_subscribed(True)
            track = getattr(publication, "track", None)
            if track is not None:
                self._open(track)
        except Exception:  # noqa: BLE001 - the camera is optional; the next scan tries again
            return

    # -- room events

    def _on_participant_connected(self, participant: Any) -> None:
        if self._is_candidate(participant):
            self.scan()

    def _on_participant_disconnected(self, participant: Any) -> None:
        if self._is_candidate(participant):
            self._close_stream()

    def _on_track_published(self, publication: Any, participant: Any) -> None:
        if self._is_candidate(participant):
            self._consider(publication)

    def _on_track_subscribed(self, track: Any, publication: Any, participant: Any) -> None:
        if self._is_candidate(participant) and _is_camera(publication) and not self._off:
            self._open(track)

    def _on_track_unsubscribed(self, track: Any, publication: Any, participant: Any) -> None:
        if self._is_candidate(participant) and _is_camera(publication) and getattr(track, "sid", None) == self._track_sid:
            self._close_stream()

    # -- the stream

    def _open(self, track: Any) -> None:
        sid = getattr(track, "sid", None)
        if self._off or (self._stream is not None and self._track_sid == sid):
            return
        self._close_stream()
        stream = self._make_stream(track)
        self._stream, self._track_sid = stream, sid
        self.streams_opened += 1
        self._pump = self._loop.create_task(self._run(stream))

    def _close_stream(self) -> None:
        stream, pump = self._stream, self._pump
        self._stream, self._track_sid, self._pump = None, None, None
        if pump is not None:
            pump.cancel()
        if stream is not None:
            self._loop.create_task(_close_quietly(stream))

    async def _run(self, stream: Any) -> None:
        try:
            async for event in stream:
                self._on_frame(event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - a broken stream ends the picture, not the call
            if not self._pump_error_logged:
                self._pump_error_logged = True
                _log.warn("unknown_event", error_type="r1_rec_camera_stream_failed", error_category=_error_type_of(exc))
        finally:
            if self._stream is stream:  # it ended by itself (EOS): wait for the next track
                self._stream, self._track_sid, self._pump = None, None, None
                self._loop.create_task(_close_quietly(stream))

    def _on_frame(self, event: Any) -> None:
        if self._off:
            return
        now = self._clock()
        self.received += 1
        if now - self._last_taken < VIDEO_MIN_GAP_SECONDS:
            return
        picture = self._picture(event)
        if picture is None:
            self.rejected += 1
            self._on_reject()
            return
        width, height, rotation, data = picture
        self._last_taken = now
        self.taken += 1
        self._on_picture(max(0, int((now - self._t0) * 1_000_000)), width, height, rotation, data)

    @staticmethod
    def _picture(event: Any) -> tuple[int, int, int, bytes] | None:
        try:
            frame = event.frame
            rotation = ROTATION_DEGREES.get(int(event.rotation))
            if rotation is None:
                return None
            if frame.type != BUFFER_I420:
                frame = frame.convert(BUFFER_I420)
            width, height = int(frame.width), int(frame.height)
            if width % 2 or height % 2 or not (VIDEO_MIN_SIDE <= width <= VIDEO_MAX_SIDE) or not (VIDEO_MIN_SIDE <= height <= VIDEO_MAX_SIDE):
                return None
            data = bytes(frame.data)
            if len(data) != width * height * 3 // 2:
                return None
            return width, height, rotation, data
        except Exception:  # noqa: BLE001 - an odd frame is a rejected frame
            return None


async def _close_quietly(stream: Any) -> None:
    with contextlib.suppress(BaseException):
        await asyncio.wait_for(stream.aclose(), 2.0)


# ---------------------------------------------------------------------------- watchdog


class LagMonitor:
    """Event-loop lag judged over a sliding window: tripped when the worst lag exceeds the limit."""

    def __init__(self, window: float = LAG_WINDOW_SECONDS, limit: float = LAG_LIMIT_SECONDS) -> None:
        self._window = window
        self._limit = limit
        self._samples: collections.deque[tuple[float, float]] = collections.deque()

    def record(self, now: float, lag: float) -> None:
        self._samples.append((now, lag))
        self._prune(now)

    def _prune(self, now: float) -> None:
        while self._samples and now - self._samples[0][0] > self._window:
            self._samples.popleft()

    def worst(self, now: float) -> float:
        self._prune(now)
        return max((lag for _t, lag in self._samples), default=0.0)

    def tripped(self, now: float) -> bool:
        return self.worst(now) > self._limit


class DropMonitor:
    """The share of pictures lost over a sliding window.

    ``seen`` counts every picture that reached us (taken or rejected), ``dropped`` the ones lost
    on the way (rejected, or pushed out of the encoder's queue).  Tripped when more than ``limit``
    of the pictures seen in the window were lost, and only once there are ``min_pictures`` to judge
    by (a handful of drops at the start proves nothing).
    """

    def __init__(
        self,
        window: float = DROP_WINDOW_SECONDS,
        limit: float = DROP_RATIO_LIMIT,
        min_pictures: int = DROP_MIN_PICTURES,
    ) -> None:
        self._window = window
        self._limit = limit
        self._min = min_pictures
        self._buckets: collections.deque[list[float | int]] = collections.deque()  # [second, seen, dropped]

    def record(self, now: float, *, seen: int = 0, dropped: int = 0) -> None:
        if not seen and not dropped:
            return
        second = int(now)
        if self._buckets and self._buckets[-1][0] == second:
            self._buckets[-1][1] += seen
            self._buckets[-1][2] += dropped
        else:
            self._buckets.append([second, seen, dropped])
        self._prune(now)

    def _prune(self, now: float) -> None:
        while self._buckets and now - self._buckets[0][0] >= self._window:
            self._buckets.popleft()

    def ratio(self, now: float) -> tuple[float, int]:
        """``(share lost, pictures seen)`` over the window."""
        self._prune(now)
        seen = sum(int(b[1]) for b in self._buckets)
        dropped = sum(int(b[2]) for b in self._buckets)
        return (dropped / seen if seen else 0.0), seen

    def tripped(self, now: float) -> bool:
        share, seen = self.ratio(now)
        return seen >= self._min and share > self._limit


class VadMonitor:
    """Voice-activity inference running too slow for real time.

    The SDK emits ``metrics_collected`` about once a second with the total time and count of
    its inferences.  A batch is too slow when the mean inference exceeds ``fraction`` of one VAD
    window (or a fixed ``single_limit``, which one inference over 200 ms would also push the
    mean past); ``consecutive`` such batches in a row trip it.
    """

    def __init__(
        self,
        fraction: float = VAD_LOAD_FRACTION,
        single_limit: float = VAD_SINGLE_LIMIT_SECONDS,
        consecutive: int = VAD_CONSECUTIVE_BATCHES,
    ) -> None:
        self._fraction = fraction
        self._single = single_limit
        self._need = consecutive
        self._run = 0

    def observe(self, total_seconds: float, count: int, window_seconds: float) -> bool:
        """Feed one batch; ``True`` once enough consecutive batches have been too slow."""
        if count <= 0 or total_seconds < 0 or window_seconds <= 0:
            return False
        mean = total_seconds / count
        slow = mean > self._fraction * window_seconds or mean > self._single
        self._run = self._run + 1 if slow else 0
        return self._run >= self._need


# ---------------------------------------------------------------------------- uploader


def _bounded_int(value: Any, low: int, high: int, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    number = int(value)
    return number if low <= number <= high else default


class _Limits(NamedTuple):
    """What one attempt may use: the two timeouts (a plain ``(connect, total)`` pair to anything
    that indexes it) and the event that cuts it short, for periodic work only (see ``HttpClient``)."""

    connect: float
    total: float
    cancel: threading.Event | None = None


class UploadWorker:
    """The one thread that talks to the API and to the presigned URLs.

    Periodic work (prepare, 5 MiB parts cut from the growing MP4, the OGG checkpoint) runs on
    its loop; the finish queues jobs onto the same thread, so there is exactly one request in
    flight and one owner of the counters.  A part's bytes stay on disk until its 200.

    The finish must not wait behind periodic work: ``submit`` ends the request periodic work has
    in flight (``HttpClient.cancel_inflight``; a mid-call PUT may be allowed 60 s) and the loop
    then picks the job up.  What was cut is not lost: a part advances the cursor only after its
    200, so the finish's tail job uploads the same part again (a part number can be PUT twice;
    the second replaces the first).
    """

    def __init__(
        self,
        *,
        api: RecordingApi,
        http_client: HttpClient,
        spool: Spool,
        mode: str,
        clock: Callable[[], float],
        on_discard: Callable[[str], None],
        on_stop: Callable[[str], None],
        mp4_enabled: Callable[[], bool],
        rng: Callable[[], float] = random.random,
    ) -> None:
        self._api = api
        self._http = http_client
        self._spool = spool
        self._mode = mode
        self._clock = clock
        self._on_discard = on_discard
        self._on_stop = on_stop
        self._mp4_enabled = mp4_enabled
        self._rng = rng
        self._thread = threading.Thread(target=self._run, daemon=True, name="r1rec_upload")
        self._jobs: queue.Queue[tuple[Callable[[], Any], concurrent.futures.Future[Any]]] = queue.Queue()
        self._interrupt = threading.Event()
        self._halt = threading.Event()
        self.state = "preparing"  # preparing | uploading | ended
        self.part_size = DEFAULT_PART_SIZE
        self.max_parts = MAX_PARTS
        self.checkpoint_seconds = DEFAULT_CHECKPOINT_SECONDS
        self.cut = 0
        self.parts_done = 0
        self.checkpoint_uploaded = False
        self.final_ogg_uploaded = False
        self.faststart_uploaded = False
        self._next_prepare_at = 0.0
        self._next_parts_at = 0.0
        self._loop_error_logged = False
        self._next_checkpoint_at = float("inf")
        self._last_checkpoint_size = -1
        self._delivered_at_least_one_byte = False

    # -- lifecycle

    def set_mode(self, mode: str) -> None:
        """The mode ``prepare`` asks for.  Set before ``start``: the recorder decides it once."""
        self._mode = mode

    def start(self) -> None:
        self._thread.start()

    def backlog_parts(self) -> float:
        """How many parts of the growing MP4 are waiting to be uploaded."""
        if self.part_size <= 0:
            return 0.0
        return max(0, self._stream_size() - self.cut) / self.part_size

    def halt(self) -> None:
        self._halt.set()
        self._interrupt.set()

    def abort(self) -> None:
        """Last resort at the finish deadline: cut the in-flight request and end the thread."""
        self.halt()
        self._http.abort()

    def submit(self, job: Callable[[], Any]) -> "concurrent.futures.Future[Any]":
        future: concurrent.futures.Future[Any] = concurrent.futures.Future()
        self._jobs.put((job, future))
        self._interrupt.set()  # cut a retry sleep short: the finish is waiting ...
        self._http.cancel_inflight()  # ... and a request in flight (only periodic work is cancellable)
        return future

    def _run(self) -> None:
        while not self._halt.is_set():
            try:
                job, future = self._jobs.get(timeout=0.5)
            except queue.Empty:
                try:
                    self._periodic()
                except Exception as exc:  # noqa: BLE001 - one bad round must not end the thread
                    if not self._loop_error_logged:
                        self._loop_error_logged = True
                        _log.warn(
                            "unknown_event",
                            error_type="r1_rec_upload_loop_error",
                            error_category=_error_type_of(exc),
                        )
                continue
            self._interrupt.clear()
            if not future.set_running_or_notify_cancel():
                continue
            try:
                future.set_result(job())
            except BaseException as exc:  # noqa: BLE001 - the thread must outlive a bad job
                future.set_exception(exc)

    def _periodic(self) -> None:
        if self.state == "preparing":
            if self._clock() >= self._next_prepare_at:
                self._prepare(deadline=None, interruptible=True)
        elif self.state == "uploading":
            if self._mp4_enabled() and self._clock() >= self._next_parts_at:
                self._upload_ready_parts(final=False, deadline=None, interruptible=True)
            self._maybe_checkpoint()

    # -- retry machinery

    def _wait(self, delay: float, interruptible: bool) -> bool:
        """Sleep ``delay`` seconds; ``True`` when the loop must stop early."""
        if interruptible:
            self._interrupt.wait(delay)
            return self._halt.is_set() or self._interrupt.is_set()
        self._halt.wait(delay)
        return self._halt.is_set()

    def _timeouts(self, deadline: float | None) -> tuple[float, float] | None:
        if deadline is None:
            return CONNECT_TIMEOUT_SECONDS, CALL_TIMEOUT_SECONDS
        remaining = deadline - self._clock()
        if remaining <= 0.05:
            return None
        return min(CONNECT_TIMEOUT_SECONDS, remaining), min(FINISH_CALL_TIMEOUT_CAP_SECONDS, remaining)

    def _attempts(
        self,
        step: Callable[[_Limits], tuple[str, Any]],
        *,
        deadline: float | None,
        interruptible: bool,
    ) -> tuple[str, Any]:
        """Run ``step`` up to four times (1 s, 3 s, 7 s apart, jittered), within ``deadline``.

        ``interruptible`` (periodic work) also lets the finish cut the request in flight: the step
        gets the interrupt event to hand to the HTTP client, and a cut request is ``ABORTED``,
        never retried (the job that cut it needs the thread).
        """
        attempts = len(RETRY_DELAYS_SECONDS) + 1
        for attempt in range(attempts):
            if self._halt.is_set() or (interruptible and self._interrupt.is_set()):
                return ABORTED, None
            timeouts = self._timeouts(deadline)
            if timeouts is None:
                return FAILED, None
            try:
                outcome, value = step(_Limits(timeouts[0], timeouts[1], self._interrupt if interruptible else None))
            except HttpFailure as failure:
                if failure.kind in ("aborted", "cancelled"):
                    return ABORTED, None
                if failure.kind in ("no_secret", "bad_url"):
                    outcome, value = STOP, "rejected"  # a request that can never succeed
                else:
                    outcome, value = RETRY, failure.kind
            if outcome in (OK, DISCARD, STOP):
                if outcome == DISCARD:
                    self._on_discard(value)
                    self.state = "ended"
                elif outcome == STOP:
                    self._on_stop(value)
                    self.state = "ended"
                return outcome, value
            if attempt == attempts - 1:
                break
            delay = RETRY_DELAYS_SECONDS[attempt] * (0.7 + 0.6 * self._rng())
            if deadline is not None and self._clock() + delay >= deadline:
                break
            _log.warn("unknown_event", error_type="r1_rec_upload_retry", option_count=attempt + 1)
            if self._wait(delay, interruptible):
                return ABORTED, None
        return FAILED, None

    # -- prepare

    def _prepare(self, *, deadline: float | None, interruptible: bool) -> bool:
        def step(limits: _Limits) -> tuple[str, Any]:
            reply = self._api.post(
                "prepare", {"mode": self._mode},
                connect_timeout=limits.connect, total_timeout=limits.total, cancel=limits.cancel,
            )
            verdict, reason = classify(reply)
            if verdict != OK:
                return verdict, reason
            return OK, reply.data

        outcome, value = self._attempts(step, deadline=deadline, interruptible=interruptible)
        if outcome != OK:
            if outcome == FAILED:
                self._next_prepare_at = self._clock() + FAILED_ROUND_COOLDOWN_SECONDS
                _log.warn("unknown_event", error_type="r1_rec_prepare_failed")
            return False
        data = value
        part_size = _bounded_int(data.get("part_size"), MIN_PART_SIZE, MAX_PART_SIZE, 0)
        if part_size == 0:
            self._on_stop("rejected")
            self.state = "ended"
            return False
        self.part_size = part_size
        self.max_parts = _bounded_int(data.get("max_parts"), 1, MAX_PARTS, MAX_PARTS)
        self.checkpoint_seconds = float(
            _bounded_int(data.get("checkpoint_interval_sec"), 10, 600, int(DEFAULT_CHECKPOINT_SECONDS))
        )
        self._next_checkpoint_at = self._clock() + self.checkpoint_seconds
        self.state = "uploading"
        return True

    # -- parts

    def _stream_size(self) -> int:
        try:
            return self._spool.stream_path.stat().st_size
        except OSError:
            return 0

    def _read_range(self, path: Path, offset: int, length: int) -> bytes:
        try:
            with open(path, "rb") as handle:
                handle.seek(offset)
                return handle.read(length)
        except OSError:
            return b""

    def _upload_ready_parts(self, *, final: bool, deadline: float | None, interruptible: bool) -> bool:
        """Upload every complete part (and, when ``final``, the short last one).

        Returns True when nothing is left to upload (always False while the file grows).
        """
        size = self._stream_size()
        while True:
            if self.state != "uploading" or self.parts_done >= self.max_parts:
                return False
            available = size - self.cut
            if available >= self.part_size:
                length = self.part_size
            elif final and available > 0:
                length = available
            else:
                return available <= 0 and final
            data = self._read_range(self._spool.stream_path, self.cut, length)
            if len(data) != length:
                return False
            number = self.parts_done + 1
            outcome, _ = self._attempts(
                self._part_step(number, data), deadline=deadline, interruptible=interruptible
            )
            if outcome != OK:
                if outcome == FAILED and not final:
                    # The bytes stay on disk; try again after a pause (the backlog grows meanwhile).
                    self._next_parts_at = self._clock() + FAILED_ROUND_COOLDOWN_SECONDS
                return False
            self.cut += length
            self.parts_done += 1
            self._delivered_at_least_one_byte = True
            if not final:
                size = self._stream_size()

    def _part_step(self, number: int, data: bytes) -> Callable[[_Limits], tuple[str, Any]]:
        def step(limits: _Limits) -> tuple[str, Any]:
            reply = self._api.post(
                "part-url", {"part_number": number},
                connect_timeout=limits.connect, total_timeout=limits.total, cancel=limits.cancel,
            )
            verdict, reason = classify(reply)
            if verdict != OK:
                return verdict, reason
            url = reply.data.get("url")
            if not isinstance(url, str) or not url:
                return RETRY, "bad_reply"
            put = self._api.put(
                url, data, "application/octet-stream",
                connect_timeout=limits.connect, total_timeout=limits.total, cancel=limits.cancel,
            )
            return (OK, None) if put.status == 200 else (RETRY, "put")

        return step

    # -- whole objects (OGG checkpoint / final OGG / faststart MP4)

    def _put_object(self, kind: str, path: Path, *, deadline: float | None, interruptible: bool) -> bool:
        try:
            data = path.read_bytes()
        except OSError:
            return False
        if not data:
            return False

        def step(limits: _Limits) -> tuple[str, Any]:
            reply = self._api.post(
                "object-url", {"kind": kind},
                connect_timeout=limits.connect, total_timeout=limits.total, cancel=limits.cancel,
            )
            verdict, reason = classify(reply)
            if verdict != OK:
                return verdict, reason
            url = reply.data.get("url")
            content_type = reply.data.get("content_type")
            if not isinstance(url, str) or not url or not isinstance(content_type, str) or not content_type:
                return RETRY, "bad_reply"
            put = self._api.put(
                url, data, content_type,
                connect_timeout=limits.connect, total_timeout=limits.total, cancel=limits.cancel,
            )
            return (OK, None) if put.status == 200 else (RETRY, "put")

        outcome, _ = self._attempts(step, deadline=deadline, interruptible=interruptible)
        return outcome == OK

    def _maybe_checkpoint(self) -> None:
        now = self._clock()
        if now < self._next_checkpoint_at:
            return
        try:
            size = self._spool.ogg_path.stat().st_size
        except OSError:
            size = 0
        if size <= 0 or size == self._last_checkpoint_size:
            self._next_checkpoint_at = now + self.checkpoint_seconds
            return
        ok = self._put_object("audio_partial", self._spool.ogg_path, deadline=None, interruptible=True)
        if ok:
            self.checkpoint_uploaded = True
            self._last_checkpoint_size = size
            self._next_checkpoint_at = self._clock() + self.checkpoint_seconds
        else:
            self._next_checkpoint_at = self._clock() + FAILED_ROUND_COOLDOWN_SECONDS

    # -- finish jobs (run on this thread, queued by the recorder's finish)

    def job_tail(self, *, mp4: bool, final_ogg: bool, deadline: float) -> dict[str, Any]:
        """Last MP4 part and/or the final OGG.  ``{"uploading": bool, "mp4": bool, "ogg": bool}``."""
        if self.state == "preparing":
            self._prepare(deadline=deadline, interruptible=False)
        result = {"uploading": self.state == "uploading", "mp4": False, "ogg": False}
        if self.state != "uploading":
            return result
        if mp4:
            result["mp4"] = self._upload_ready_parts(final=True, deadline=deadline, interruptible=False)
        if final_ogg and self.state == "uploading":
            ok = self._put_object("audio", self._spool.ogg_path, deadline=deadline, interruptible=False)
            self.final_ogg_uploaded = ok
            result["ogg"] = ok
        return result

    def job_video(self, *, deadline: float) -> bool:
        if self.state != "uploading":
            return False
        ok = self._put_object("video", self._spool.video_path, deadline=deadline, interruptible=False)
        self.faststart_uploaded = ok
        return ok

    def job_complete(self, body: Mapping[str, Any], *, deadline: float) -> str:
        """Send ``complete``; nothing is sent when the upload never began or was stopped."""
        if self.state != "uploading":
            return FAILED

        def step(limits: _Limits) -> tuple[str, Any]:
            reply = self._api.post(
                "complete", body, connect_timeout=limits.connect, total_timeout=limits.total, cancel=limits.cancel
            )
            verdict, reason = classify(reply)
            return verdict, reason

        outcome, _ = self._attempts(step, deadline=deadline, interruptible=False)
        return outcome


# ---------------------------------------------------------------------------- recorder

IDLE = "idle"
CAPTURING = "capturing"
STOPPED = "stopped"
DONE = "done"


@dataclass
class _Facts:
    """What the finish reports about the recording (display-only numbers; the server validates)."""

    started_at_ms: int | None = None
    stream_bytes: int | None = None
    media_ms: int | None = None


class R1Recorder:
    """One interview's recorder: ``start`` -> ``stop`` -> ``finish``, none of which raises."""

    def __init__(
        self,
        *,
        session: Any,
        room: str,
        session_id: str,
        mode: str,
        spool: Spool,
        encoder: EncoderProcess | None,
        api: RecordingApi,
        http_client: HttpClient,
        finish_seconds: float = RECORDING_FINISH_NOMINAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
        io_class: Callable[[], type] = recorder_io_class,
        ctx: Any = None,
        rng: Callable[[], float] = random.random,
        preset: str = DEFAULT_PRESET,
        make_stream: Callable[[Any], Any] = _default_stream,
        mono: Callable[[], float] = time.monotonic,
    ) -> None:
        self._session = session
        self._ctx = ctx
        self._preset = preset if preset in PRESETS else DEFAULT_PRESET
        self._make_stream = make_stream
        self._mono = mono  # the real clock, for event-loop lag (``clock`` may be a test double)
        self._room = room
        self._mode = mode
        self._spool = spool
        self._encoder = encoder
        self._http = http_client
        self._finish_seconds = max(1.0, float(finish_seconds))
        self._clock = clock
        self._wall = wall
        self._io_class = io_class
        self._lock = threading.Lock()
        self.phase = IDLE
        self._loop: asyncio.AbstractEventLoop | None = None
        self._io: Any = None
        self._tee_thread: threading.Thread | None = None
        self._watchdog: asyncio.Task[Any] | None = None
        self._discard_task: asyncio.Task[Any] | None = None
        self._finish_task: asyncio.Task[Any] | None = None
        self._t0: float | None = None
        self._stop_at: float | None = None
        self._stop_called = False
        self._forced = False
        self._facts = _Facts()
        self._encoder_lost: str | None = None
        self._lost_stalled = False
        self._discard_reason: str | None = None
        self._stop_reason: str | None = None
        self._candidate_identity: str | None = None
        self._tee_failed = False
        # Picture capture (``av``).  ``_video`` is decided once, at start; Level 1 / Level 2 only
        # ever take it away.
        self._video = False
        self._camera: CameraCapture | None = None
        self._lag_task: asyncio.Task[Any] | None = None
        self._lag = LagMonitor()
        self._drops = DropMonitor()
        self._vad_monitor = VadMonitor()
        self._vad: Any = None
        self._degraded_reason: str | None = None
        self._degraded_at_ms: int | None = None
        self._overflow_seen = 0
        self._worker = UploadWorker(
            api=api,
            http_client=http_client,
            spool=spool,
            mode=MODE_AUDIO,
            clock=clock,
            on_discard=self._on_discard,
            on_stop=self._on_stop,
            mp4_enabled=self._mp4_upload_allowed,
            rng=rng,
        )
        if encoder is None or encoder.exited.is_set():
            self._encoder_lost = "encoder_unavailable"

    # -- public API

    @property
    def mode(self) -> str:
        return self._mode

    @property
    def discarded(self) -> str | None:
        return self._discard_reason

    @property
    def encoder_lost(self) -> str | None:
        return self._encoder_lost

    @property
    def video(self) -> bool:
        """The picture is being recorded (``av`` and the encoder can do it); never comes back once off."""
        return self._video

    @property
    def degraded(self) -> str | None:
        """Why the picture was given up (Level 1), if it was."""
        return self._degraded_reason

    async def start(self, candidate_identity: str | None = None) -> None:
        """Wire the audio tap and begin capturing.  Never raises, never waits on the network."""
        if self.phase != IDLE or self._stop_called:
            return
        self._candidate_identity = candidate_identity
        try:
            await self._start_impl()
        except asyncio.CancelledError:
            self._abort_start()
            raise
        except Exception as exc:  # noqa: BLE001 - recording must never break the interview
            _log.warn("unknown_event", error_type="r1_rec_start_failed", error_category=_error_type_of(exc))
            self._abort_start()

    def stop(self, outcome: str | None = None) -> None:
        """Close capture now (sync, idempotent) and begin the finish in the background."""
        if self._stop_called:
            return
        self._stop_called = True
        self._stop_at = self._clock()
        self._forced = outcome in FORCED_OUTCOMES
        if self.phase == CAPTURING:
            try:
                if self._io is not None:
                    self._io.close_capture()
                    self._io.flush_idle_tail()
            except Exception as exc:  # noqa: BLE001
                _log.warn("unknown_event", error_type="r1_rec_stop_failed", error_category=_error_type_of(exc))
            self._stop_camera()
        self.phase = STOPPED if self.phase == CAPTURING else self.phase
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._finish_task is None:
            self._finish_task = loop.create_task(self._finish_impl())

    async def finish(self) -> None:
        """Wait for the finish (started by ``stop``).  Safe to cancel: the finish keeps running."""
        if not self._stop_called:
            self.stop(None)
        if self._finish_task is None:
            self._finish_task = asyncio.ensure_future(self._finish_impl())
        await asyncio.shield(self._finish_task)

    # -- start

    async def _start_impl(self) -> None:
        session = self._session
        source = getattr(getattr(session, "input", None), "audio", None)
        sink = getattr(getattr(session, "output", None), "audio", None)
        if source is None or sink is None:
            _log.warn("unknown_event", error_type="r1_rec_wire_skipped")
            self._abort_start()
            return
        loop = asyncio.get_running_loop()
        self._loop = loop
        io = self._io_class()(agent_session=session, sample_rate=SAMPLE_RATE)
        io.tee_clock = self._clock
        tap_in = io.record_input(source)
        tap_out = io.record_output(sink)
        session.input.audio = tap_in
        session.output.audio = tap_out
        self._io = io
        await asyncio.wait_for(io.start(output_path=self._spool.ogg_path), IO_START_WAIT_SECONDS)
        # t0 is the media clock origin of both spools (C8): sampled the instant start returns.
        self._t0 = self._clock()
        self._facts.started_at_ms = int(round(self._wall() * 1000))
        self._video = self._decide_video()
        self._worker.set_mode(MODE_AV if self._video else MODE_AUDIO)
        if self._encoder is not None and not self._encoder.dead:
            self._encoder.send_hello(video=self._video, preset=self._preset, t0_us=int(self._t0 * 1_000_000))
        self._tee_thread = threading.Thread(target=self._tee_loop, daemon=True, name="r1rec_tee")
        self._tee_thread.start()
        self._worker.start()
        self.phase = CAPTURING
        if self._video:
            self._start_video(loop)
        self._watchdog = loop.create_task(self._watch())
        _log.info(
            "unknown_event",
            error_type="r1_rec_started",
            error_category=MODE_AV if self._video else MODE_AUDIO,
        )

    def _decide_video(self) -> bool:
        """Record the picture only when asked (``av``), able (libx264) and connected (a room)."""
        if self._mode != MODE_AV or not VIDEO_CAPTURE_READY:
            return False
        encoder = self._encoder
        if encoder is None or self._encoder_lost is not None or not encoder.can_encode_video():
            _log.warn("unknown_event", error_type="r1_rec_video_unavailable")
            return False
        if getattr(self._ctx, "room", None) is None:
            _log.warn("unknown_event", error_type="r1_rec_video_unavailable")
            return False
        return True

    def _start_video(self, loop: asyncio.AbstractEventLoop) -> None:
        """Subscribe to the candidate camera, watch the machine, start the lag probe."""
        try:
            self._camera = CameraCapture(
                room=self._ctx.room,
                identity=self._candidate_identity,
                loop=loop,
                clock=self._clock,
                t0=self._t0 or self._clock(),
                on_picture=self._forward_picture,
                on_reject=self._reject_picture,
                make_stream=self._make_stream,
            )
            self._camera.start()
            self._attach_vad()
            self._lag_task = loop.create_task(self._lag_probe())
        except Exception as exc:  # noqa: BLE001 - a camera that cannot be started is a recording without one
            _log.warn("unknown_event", error_type="r1_rec_camera_start_failed", error_category=_error_type_of(exc))

    def _forward_picture(self, pts_us: int, width: int, height: int, rotation: int, data: bytes) -> None:
        self._drops.record(self._clock(), seen=1)
        encoder = self._encoder
        if encoder is None or self._encoder_lost is not None or not encoder.send_video(pts_us, width, height, rotation, data):
            self._drops.record(self._clock(), dropped=1)

    def _reject_picture(self) -> None:
        self._drops.record(self._clock(), seen=1, dropped=1)

    def _abort_start(self) -> None:
        """A start that failed or was refused: nothing was promised, so drop everything quietly."""
        self.phase = DONE
        self._stop_called = True
        self._kill_encoder()
        self._stop_camera()
        io = self._io
        if io is not None:
            with contextlib.suppress(Exception):
                io.close_capture()
        self._worker.halt()
        self._wipe(overwrite=False)

    # -- tee

    def _tee_loop(self) -> None:
        io = self._io
        mixer = TeeMixer(self._t0 or self._clock())
        while True:
            try:
                stamp_in, input_buf = io.tee_in.get()
                stamp_out, output_buf = io.tee_out.get()
            except Exception:  # noqa: BLE001
                return
            if input_buf is None or output_buf is None:
                return
            try:
                pieces = mixer.process(input_buf, output_buf, max(stamp_in, stamp_out))
            except Exception as exc:  # noqa: BLE001 - keep draining so the queues cannot grow
                if not self._tee_failed:
                    self._tee_failed = True
                    _log.warn("unknown_event", error_type="r1_rec_tee_failed", error_category=_error_type_of(exc))
                continue
            encoder = self._encoder
            if encoder is None or self._encoder_lost is not None:
                continue
            for pts_us, pcm in pieces:
                if not encoder.send_audio(pts_us, pcm):
                    break

    # -- watchdog

    async def _watch(self) -> None:
        try:
            while True:
                await asyncio.sleep(1.0)
                self._check_encoder()
                self._check_video()
        except asyncio.CancelledError:
            raise

    # -- picture watchdog (Level 1: give up the picture, never the audio)

    def _check_video(self) -> None:
        """Once a second: re-scan for the camera, then judge drops, upload backlog and disk."""
        camera = self._camera
        if not self._video or camera is None or self._degraded_reason is not None or self._stop_called:
            return
        camera.scan()
        encoder = self._encoder
        if encoder is not None:
            overflowed = encoder.video_dropped
            if overflowed > self._overflow_seen:
                self._drops.record(self._clock(), dropped=overflowed - self._overflow_seen)
                self._overflow_seen = overflowed
        now = self._clock()
        if self._drops.tripped(now):
            self._degrade("frame_drops")
        elif self._worker.backlog_parts() > BACKLOG_PARTS_LIMIT or self._spool.used_bytes() > SPOOL_BYTES_LIMIT:
            self._degrade("upload_backlog")
        elif self._low_disk():
            self._degrade("upload_backlog")

    def _low_disk(self) -> bool:
        try:
            return self._spool.free_bytes() < LOW_FREE_BYTES
        except OSError:
            return False

    async def _lag_probe(self) -> None:
        """A 50 ms ticker: how late it wakes is how far behind the event loop is."""
        mono = self._mono
        try:
            while self._degraded_reason is None:
                before = mono()
                await asyncio.sleep(LAG_TICK_SECONDS)
                now = mono()
                self.observe_lag(now, now - before - LAG_TICK_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - a broken probe must not end as an unretrieved task error
            _log.warn("unknown_event", error_type="r1_rec_lag_probe_failed", error_category=_error_type_of(exc))

    def observe_lag(self, now: float, lag: float) -> None:
        """One lag sample; the picture goes when the worst lag in the window exceeds the limit."""
        self._lag.record(now, max(0.0, lag))
        if self._lag.tripped(now):
            self._degrade("cpu_loop_lag")

    def _attach_vad(self) -> None:
        vad = getattr(self._session, "vad", None)
        on = getattr(vad, "on", None)
        if vad is None or not callable(on):
            return
        on("metrics_collected", self._on_vad_metrics)
        self._vad = vad

    def _detach_vad(self) -> None:
        vad, self._vad = self._vad, None
        off = getattr(vad, "off", None)
        if callable(off):
            with contextlib.suppress(Exception):
                off("metrics_collected", self._on_vad_metrics)

    def _on_vad_metrics(self, metrics: Any) -> None:
        total = getattr(metrics, "inference_duration_total", None)
        count = getattr(metrics, "inference_count", None)
        if not isinstance(total, (int, float)) or isinstance(count, bool) or not isinstance(count, int):
            return
        window = getattr(getattr(self._vad, "capabilities", None), "update_interval", None)
        if not isinstance(window, (int, float)) or window <= 0:
            window = VAD_WINDOW_SECONDS
        try:
            slow = self._vad_monitor.observe(float(total), count, float(window))
        except (TypeError, ValueError, OverflowError):
            return
        if slow:
            self._degrade("cpu_vad_slow")

    def _degrade(self, reason: str) -> None:
        """Level 1: stop the picture for good (the audio is untouched); the encoder shows black."""
        if not self._video or self._degraded_reason is not None or self._stop_called or self._encoder_lost is not None:
            return
        self._degraded_reason = reason
        if self._t0 is not None:
            self._degraded_at_ms = min(MAX_DEGRADED_AT_MS, max(0, int((self._clock() - self._t0) * 1000)))
        _log.warn("unknown_event", error_type="r1_rec_degraded", error_category=reason)
        camera = self._camera
        if camera is not None:
            with contextlib.suppress(Exception):
                camera.unsubscribe()
        self._detach_vad()
        task, self._lag_task = self._lag_task, None  # the probe has nothing left to protect
        try:
            running = asyncio.current_task()
        except RuntimeError:
            running = None
        if task is not None and task is not running:
            task.cancel()

    def _stop_camera(self, *, unsubscribe: bool = False) -> None:
        """Close the camera stream and the lag probe; safe from any thread.

        ``unsubscribe`` also asks the SFU to stop sending the camera: for a recording that is lost,
        discarded or abandoned (a normal end needs no such request, the room is closing).
        """
        loop = self._loop
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if loop is not None and running is not loop and not loop.is_closed():
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(self._stop_camera_now, unsubscribe)
                return
        self._stop_camera_now(unsubscribe)

    def _stop_camera_now(self, unsubscribe: bool = False) -> None:
        camera = self._camera
        if camera is not None:
            with contextlib.suppress(Exception):
                if unsubscribe:
                    camera.unsubscribe()
                else:
                    camera.stop()
        task, self._lag_task = self._lag_task, None
        if task is not None:
            task.cancel()
        self._detach_vad()

    def _mp4_upload_allowed(self) -> bool:
        """Parts of the MP4 keep going while the encoder is healthy, and after it dies when the
        prefix holds the picture (``split``: the MP4 is still the video half)."""
        return self._encoder_lost is None or self._prefix_has_picture()

    def _prefix_has_picture(self) -> bool:
        camera = self._camera
        return self._video and camera is not None and camera.taken > 0

    def _check_encoder(self) -> None:
        enc = self._encoder
        if enc is None or self._encoder_lost is not None or enc.closed.is_set():
            return
        # Ages come from the encoder's own clock (see EncoderProcess.seconds_since_status).
        if enc.dead or enc.exited.is_set():
            self._lose_encoder("encoder_crashed" if enc.ready.is_set() else "encoder_unavailable", stalled=False)
        elif not enc.ready.is_set():
            since_spawn = enc.seconds_since_spawn()
            if since_spawn is not None and since_spawn > SELF_TEST_WAIT_SECONDS:
                self._lose_encoder("encoder_unavailable", stalled=False)
        elif enc.error_code not in (None, "remux_failed"):
            self._lose_encoder("encoder_crashed", stalled=False)
        else:
            since_status = enc.seconds_since_status()
            if since_status is not None and since_status > ENCODER_STALL_SECONDS:
                self._lose_encoder("encoder_crashed", stalled=True)

    def _lose_encoder(self, reason: str, *, stalled: bool) -> None:
        """The MP4 can no longer carry the audio: kill the child; the OGG carries it from here."""
        if self._encoder_lost is not None:
            return
        self._encoder_lost = reason
        self._lost_stalled = stalled
        self._kill_encoder()
        self._stop_camera(unsubscribe=True)
        if reason == "encoder_unavailable":
            _log.error("unknown_event", error_type="r1_rec_encoder_unavailable")
        elif stalled:
            _log.error("unknown_event", error_type="r1_rec_encoder_stalled")
        else:
            _log.error("unknown_event", error_type="r1_rec_encoder_crashed")

    def _kill_encoder(self) -> None:
        if self._encoder is not None:
            self._encoder.kill()

    # -- worker callbacks (called from the upload thread)

    def _on_discard(self, reason: str) -> None:
        with self._lock:
            if self._discard_reason is not None:
                return
            self._discard_reason = reason
        _log.warn("unknown_event", error_type="r1_rec_discarded", error_category=reason)
        self._kill_encoder()
        self._stop_camera(unsubscribe=True)
        io = self._io
        if io is not None:
            with contextlib.suppress(Exception):
                io.close_capture()
        loop = self._loop
        if loop is not None and not loop.is_closed():
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(self._begin_discard_cleanup)
                return
        self._wipe(overwrite=True)

    def _on_stop(self, reason: str) -> None:
        with self._lock:
            if self._stop_reason is not None:
                return
            self._stop_reason = reason
        _log.warn("unknown_event", error_type="r1_rec_abandoned", error_category=reason)
        self._kill_encoder()
        self._stop_camera(unsubscribe=True)
        io = self._io
        if io is not None:
            with contextlib.suppress(Exception):
                io.close_capture()

    def _begin_discard_cleanup(self) -> None:
        if self._discard_task is None:
            self._discard_task = asyncio.ensure_future(self._discard_cleanup())

    async def _discard_cleanup(self) -> None:
        """Stop the SDK recorder, then overwrite and unlink everything the spool holds.

        A mid-call discard happens while the interview goes on, and the overwrite writes and
        fsyncs every spool byte (about 150 MB after a 30-minute call with video): that runs on a
        thread, never on the loop the live VAD / STT / TTS pipeline shares.
        """
        try:
            await self._close_io()
        finally:
            self._worker.halt()
            await self._wipe_off_loop(overwrite=True)

    # -- finish

    async def _finish_impl(self) -> None:
        try:
            await self._finish_steps()
        except asyncio.CancelledError:
            self._emergency_cleanup()
            raise
        except Exception as exc:  # noqa: BLE001
            _log.error("unknown_event", error_type="r1_rec_finish_failed", error_category=_error_type_of(exc))
            self._emergency_cleanup()
        finally:
            self.phase = DONE
            if self._watchdog is not None:
                self._watchdog.cancel()
            self._stop_camera()

    def _emergency_cleanup(self) -> None:
        self._kill_encoder()
        self._worker.halt()
        self._wipe(overwrite=self._discard_reason is not None)

    def _wipe(self, *, overwrite: bool) -> None:
        with contextlib.suppress(Exception):
            self._spool.wipe(overwrite=overwrite)

    async def _wipe_off_loop(self, *, overwrite: bool) -> None:
        """``_wipe`` on a worker thread.  Cancelling the wait does not stop the wipe, and when no
        thread can be had (the interpreter is shutting down) it is done inline: it must happen."""
        try:
            await asyncio.to_thread(self._wipe, overwrite=overwrite)
        except RuntimeError:
            self._wipe(overwrite=overwrite)

    async def _finish_steps(self) -> None:
        if self._t0 is None or self._io is None:
            # Never started (no show, configuration failure) or a refused start: nothing was
            # recorded, nothing is sent.
            self._kill_encoder()
            self._worker.halt()
            self._wipe(overwrite=False)
            return
        stop_at = self._stop_at if self._stop_at is not None else self._clock()
        deadline = stop_at + self._finish_seconds
        scale = min(1.0, self._finish_seconds / RECORDING_FINISH_NOMINAL_SECONDS)
        reserve = COMPLETE_RESERVE_SECONDS * scale
        await self._close_io()
        await self._poll(lambda: not (self._tee_thread and self._tee_thread.is_alive()), TEE_DRAIN_WAIT_SECONDS * scale)
        if self._discard_reason is not None:
            await self._discard_cleanup()
            return
        closed = await self._close_encoder(deadline, scale)
        if self._discard_reason is not None:
            await self._discard_cleanup()
            return
        if self._stop_reason is not None:
            self._worker.halt()
            await self._wipe_off_loop(overwrite=False)
            return
        upload_deadline = deadline - reserve
        mp4_ok = closed and self._encoder_lost is None
        # The encoder died but its prefix holds the picture: ship that MP4 as the video half and the
        # whole OGG as the audio (layout ``split``).  Without a picture the OGG alone carries the call.
        split = (not mp4_ok) and self._prefix_has_picture() and self._stream_bytes() > 0
        enc = self._encoder
        want_fast = (
            mp4_ok
            and not self._forced
            and enc is not None
            and deadline - self._clock() >= FASTSTART_MIN_REMAINING_SECONDS * scale
        )
        if want_fast:
            enc.send_remux()
        tail = await self._run_job(
            lambda: self._worker.job_tail(mp4=mp4_ok or split, final_ogg=not mp4_ok, deadline=upload_deadline),
            upload_deadline,
        )
        timed_out = tail is None
        uploaded = bool(tail) and tail.get("uploading", False)
        tail_ok = bool(tail) and (tail.get("mp4") if mp4_ok else tail.get("ogg"))
        if self._discard_reason is not None:
            await self._discard_cleanup()
            return
        if self._stop_reason is not None:
            self._worker.halt()
            await self._wipe_off_loop(overwrite=False)
            return
        if want_fast and tail_ok and enc is not None:
            remaining = upload_deadline - self._clock()
            if remaining > 0.5 and await self._poll(enc.remuxed.is_set, remaining - 0.5) and enc.remux_bytes:
                await self._run_job(lambda: self._worker.job_video(deadline=upload_deadline), upload_deadline)
        failure = self._failure_reason(uploaded=uploaded, tail_ok=tail_ok, timed_out=timed_out)
        layout = "combined" if mp4_ok else ("split" if split else "audio_only")
        body = self._complete_body(layout=layout, failure=failure)
        outcome = await self._run_job(
            lambda: self._worker.job_complete(body, deadline=deadline), deadline + 0.5, abort_on_timeout=True
        )
        if outcome == DISCARD or self._discard_reason is not None:
            await self._discard_cleanup()
            return
        if outcome != OK:
            _log.warn("unknown_event", error_type="r1_rec_complete_failed")
        else:
            _log.info(
                "unknown_event",
                error_type="r1_rec_finished",
                error_category=layout,
                duration_sec=int((self._facts.media_ms or 0) // 1000),
            )
        await self._teardown_child()
        self._worker.halt()
        await self._wipe_off_loop(overwrite=False)

    def _failure_reason(self, *, uploaded: bool, tail_ok: bool, timed_out: bool) -> str | None:
        """The worker's reason code for a recording that is not fully delivered (vocabulary C11)."""
        if self._encoder_lost == "encoder_unavailable":
            return "encoder_unavailable"
        if self._encoder_lost is not None:
            if self._encoder is not None and self._encoder.error_code == "disk_full":
                return "spool_disk_full"
            return "encoder_crashed"
        if timed_out:
            return "finish_timeout"
        if not uploaded or not tail_ok:
            return "upload_failed"
        return None

    def _stream_bytes(self) -> int:
        try:
            return self._spool.stream_path.stat().st_size
        except OSError:
            return 0

    def _has_video(self, layout: str) -> bool:
        """The deliverable really holds the candidate's picture (not only black)."""
        camera = self._camera
        if not self._video or layout == "audio_only" or camera is None or camera.taken <= 0:
            return False
        info = self._encoder.closed_info if self._encoder is not None else None
        return not (info is not None and int(info.get("width", 0) or 0) <= 0)  # the child fell back to audio

    def _complete_body(self, *, layout: str, failure: str | None) -> dict[str, Any]:
        facts = self._facts
        enc = self._encoder
        stream_bytes = facts.stream_bytes
        media_ms = facts.media_ms
        if enc is not None and enc.closed_info:
            stream_bytes = enc.closed_info.get("bytes", stream_bytes)
            media_ms = enc.closed_info.get("media_ms", media_ms)
        if not media_ms and self._t0 is not None and self._stop_at is not None:
            media_ms = int(max(0.0, self._stop_at - self._t0) * 1000)
        report: dict[str, Any] = {
            "parts_uploaded": self._worker.parts_done,
            "faststart_uploaded": self._worker.faststart_uploaded,
            "audio_final_uploaded": self._worker.final_ogg_uploaded,
            "audio_partial_uploaded": self._worker.checkpoint_uploaded,
        }
        if facts.started_at_ms:
            report["started_at_ms"] = facts.started_at_ms
        if media_ms and media_ms > 0:
            report["duration_ms"] = int(media_ms)
        if stream_bytes is not None:
            report["stream_bytes"] = int(stream_bytes)
        has_video = self._has_video(layout)
        if self._video:
            self._add_picture_facts(report)
        if self._degraded_at_ms is not None:
            report["degraded_at_ms"] = self._degraded_at_ms
        body: dict[str, Any] = {"layout": layout, "has_video": has_video, "report": report}
        if failure:
            body["failure_reason"] = failure
        degraded = self._degraded_reason
        if degraded is None and self._lost_stalled:
            degraded = "encoder_stalled"
        if degraded is None and self._video and not has_video and self._encoder_lost is None:
            degraded = "video_unavailable"  # the camera never delivered a picture (or the child could not encode one)
        if degraded:
            body["degraded_reason"] = degraded
        return body

    def _add_picture_facts(self, report: dict[str, Any]) -> None:
        """Size, rate and the counters from the child's last word (closed, else its last heartbeat)."""
        enc = self._encoder
        camera = self._camera
        source: Mapping[str, Any] = {}
        if enc is not None:
            source = enc.closed_info or enc.progress or {}
        frames = source.get("frames")
        if isinstance(frames, int) and frames > 0:
            report["frames_encoded"] = frames
            width, height = int(source.get("width", 0) or 0), int(source.get("height", 0) or 0)
            if width > 0 and height > 0:
                report.update(width=width, height=height, fps=int(source.get("fps", 0) or VIDEO_FPS))
        lost = int(source.get("dropped", 0) or 0)
        if enc is not None:
            lost += enc.video_dropped
        if camera is not None:
            lost += camera.rejected
        if isinstance(frames, int) and frames > 0:
            report["frames_dropped"] = lost
            report["camera_off_ms"] = int(source.get("black", 0) or 0) * 1000 // VIDEO_FPS

    # -- finish helpers

    async def _close_io(self) -> None:
        io = self._io
        if io is None:
            return
        try:
            await asyncio.wait_for(io.aclose(), IO_CLOSE_WAIT_SECONDS)
        except asyncio.TimeoutError:
            _log.warn("unknown_event", error_type="r1_rec_io_close_timeout")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _log.warn("unknown_event", error_type="r1_rec_io_close_failed", error_category=_error_type_of(exc))

    async def _close_encoder(self, deadline: float, scale: float) -> bool:
        """EOF the child and wait for it to close the MP4; ``False`` when it did not (it is killed)."""
        enc = self._encoder
        if enc is None or self._encoder_lost is not None:
            return False
        if enc.dead:
            self._lose_encoder("encoder_crashed" if enc.ready.is_set() else "encoder_unavailable", stalled=False)
            return False
        if not enc.send_eof():
            self._lose_encoder("encoder_crashed", stalled=False)
            return False
        wait = min(ENCODER_CLOSE_WAIT_SECONDS * scale, max(0.1, deadline - self._clock() - 1.0))
        if await self._poll(lambda: enc.closed.is_set() or enc.exited.is_set(), wait) and enc.closed.is_set():
            info = enc.closed_info or {}
            self._facts.stream_bytes = info.get("bytes")
            self._facts.media_ms = info.get("media_ms")
            return True
        self._lose_encoder("encoder_crashed", stalled=not enc.exited.is_set())
        return False

    async def _teardown_child(self) -> None:
        enc = self._encoder
        if enc is None:
            return
        if not enc.exited.is_set() and not enc.dead:
            enc.quit()
            await self._poll(enc.exited.is_set, 1.0)
        if not enc.exited.is_set():
            enc.kill()

    async def _poll(self, predicate: Callable[[], bool], timeout: float) -> bool:
        end = time.monotonic() + max(0.0, timeout)
        while True:
            if predicate():
                return True
            if time.monotonic() >= end:
                return False
            await asyncio.sleep(0.02)

    async def _run_job(
        self, job: Callable[[], Any], deadline: float, *, abort_on_timeout: bool = False
    ) -> Any:
        """Run ``job`` on the upload thread; ``None`` when it did not answer by ``deadline``."""
        future = self._worker.submit(job)
        remaining = max(0.05, deadline - self._clock()) + 0.25
        try:
            return await asyncio.wait_for(asyncio.wrap_future(future), remaining)
        except asyncio.TimeoutError:
            _log.warn("unknown_event", error_type="r1_rec_finish_timeout")
            if abort_on_timeout:
                self._worker.abort()
            return None
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _log.warn("unknown_event", error_type="r1_rec_job_failed", error_category=_error_type_of(exc))
            return None


# ---------------------------------------------------------------------------- builder


def build_r1_recorder(
    ctx: Any,
    context: Mapping[str, Any] | None,
    session: Any,
    room: str,
    session_id: str | None,
    *,
    finish_seconds: float = RECORDING_FINISH_NOMINAL_SECONDS,
    env: Mapping[str, str] | None = None,
    clock: Callable[[], float] = time.monotonic,
    wall: Callable[[], float] = time.time,
    spool_root: Path | None = None,
    encoder_factory: Callable[[Path], EncoderProcess] | None = None,
    http_client: HttpClient | None = None,
    io_class: Callable[[], type] = recorder_io_class,
) -> R1Recorder | None:
    """Build the recorder, or return ``None`` when recording is off or cannot work.

    With the locks off (``R1_RECORDING`` not ``on``, or the API's projection ``off``) this
    returns before touching anything: no spool, no process, no thread, no network.
    """
    try:
        mode = effective_mode(context, env)
        if mode == MODE_OFF:
            return None
        if not session_id or not _UUID_RE.match(session_id) or not _ROOM_RE.match(room or ""):
            _log.warn("unknown_event", error_type="r1_rec_bad_identity")
            return None
        spool = Spool(spool_root if spool_root is not None else SPOOL_ROOT, session_id)
        free = spool.free_bytes()
        if free < MIN_FREE_BYTES_AV and mode == MODE_AV:
            mode = MODE_AUDIO
        if free < MIN_FREE_BYTES_AUDIO:
            _log.warn("unknown_event", error_type="r1_rec_disk_low")
            return None
        Spool.clean_stale(spool.root, keep=session_id)
        spool.create()
        factory = encoder_factory or (lambda directory: EncoderProcess(directory))
        encoder = factory(spool.dir)
        if not encoder.spawn():
            _log.error("unknown_event", error_type="r1_rec_encoder_unavailable")
        client = http_client or HttpClient()
        return R1Recorder(
            session=session,
            room=room,
            session_id=session_id,
            mode=mode,
            spool=spool,
            encoder=encoder,
            api=RecordingApi(client, room),
            http_client=client,
            finish_seconds=finish_seconds,
            clock=clock,
            wall=wall,
            io_class=io_class,
            ctx=ctx,
            preset=x264_preset(env),
        )
    except Exception as exc:  # noqa: BLE001 - recording must never stop an interview from starting
        _log.warn("unknown_event", error_type="r1_rec_build_failed", error_category=_error_type_of(exc))
        return None
