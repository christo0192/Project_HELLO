"""R1 interview recorder: the job-process side of in-worker recording.

What it records, and where it goes (binding contract C1-C11, ``IMPLEMENTER-RULES.md``):

* The stock SDK ``RecorderIO`` keeps writing a stereo OGG (left candidate, right agent) to a
  spool file.  A subclass tees each lock-step chunk to a tee thread that resamples to 48 kHz,
  mixes to mono, pads wall-clock gaps with silence and hands the PCM to a niced child
  process (``r1_video_encoder``), which writes a fragmented MP4 (AAC) that grows as the
  interview goes on.  This build records audio only; camera capture is a later task.
* One uploader thread talks to the API (``/api/internal/r1/recording/{prepare,part-url,
  object-url,complete}``) and PUTs to the presigned URLs it returns: 5 MiB parts cut from the
  growing MP4, and the whole OGG every ``checkpoint_interval_sec``.  The worker holds no R2
  credential, ever.
* ``stop()`` (sync, from ``_begin_exit``) closes capture and starts the finish, which has its
  own deadline carved out of the interview's shared exit budget, so it overlaps the
  transcript drain.  ``finish()`` (async, from ``_exit``) only waits for it.

Failure never reaches the interview: ``start``, ``stop`` and ``finish`` do not raise, nothing
blocks the event loop (all network and process I/O is on threads), and a recorder that cannot
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
from typing import Any
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
# Camera capture is not built yet: an ``av`` request is recorded as audio until it is.
VIDEO_CAPTURE_READY = False

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
MAX_AUDIO_PIECE_SECONDS = 30
# 30 s of 48 kHz mono s16 may queue for a slow encoder; more means it is stuck.
ENCODER_AUDIO_BACKLOG_BYTES = 30 * SAMPLE_RATE * 2

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
    """Minimal HTTP/1.1 client with a connect timeout, a total deadline and a hard abort.

    ``http.client`` rather than ``urllib``: a presigned PUT must go out exactly as signed (no
    ``Accept-Encoding``, no extra headers), the total time must be bounded, and ``abort()``
    must be able to cut an in-flight request from another thread when the finish deadline
    arrives.
    """

    _CHUNK = 64 * 1024
    _REPLY_LIMIT = 64 * 1024

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active: http.client.HTTPConnection | None = None
        self._aborted = threading.Event()

    def abort(self) -> None:
        self._aborted.set()
        with self._lock:
            conn = self._active
        sock = getattr(conn, "sock", None)
        if sock is not None:
            with contextlib.suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)
            with contextlib.suppress(OSError):
                sock.close()

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        connect_timeout: float,
        total_timeout: float,
    ) -> HttpReply:
        if self._aborted.is_set():
            raise HttpFailure("aborted")
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
        try:
            conn.putrequest(method, target, skip_accept_encoding=True)
            for name, value in headers.items():
                conn.putheader(name, value)
            if body is not None:
                conn.putheader("Content-Length", str(len(body)))
            conn.endheaders()  # connects here, under the connect timeout
            sock = conn.sock
            if body is not None:
                view = memoryview(body)
                sent = 0
                while sent < len(view):
                    self._check(deadline)
                    if sock is not None:
                        sock.settimeout(max(0.2, min(30.0, deadline - time.monotonic())))
                    chunk = view[sent : sent + self._CHUNK]
                    conn.send(chunk)
                    sent += len(chunk)
            self._await_reply(sock, deadline)
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
            raise HttpFailure("aborted" if self._aborted.is_set() else "timeout") from exc
        except (OSError, http.client.HTTPException, ssl.SSLError, ValueError) as exc:
            raise HttpFailure("aborted" if self._aborted.is_set() else "network") from exc
        finally:
            with self._lock:
                self._active = None
            with contextlib.suppress(Exception):
                conn.close()

    def _check(self, deadline: float) -> None:
        if self._aborted.is_set():
            raise HttpFailure("aborted")
        if time.monotonic() >= deadline:
            raise HttpFailure("timeout")

    def _await_reply(self, sock: Any, deadline: float) -> None:
        """Wait for the first byte of the answer in short slices, so an abort or the deadline is
        noticed within a quarter of a second on every platform (a blocking read in another
        thread is not reliably woken by closing its socket)."""
        if sock is None:
            self._check(deadline)
            return
        while True:
            self._check(deadline)
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

    def post(self, op: str, body: Mapping[str, Any], *, connect_timeout: float, total_timeout: float) -> ApiReply:
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
        self, url: str, body: bytes, content_type: str, *, connect_timeout: float, total_timeout: float
    ) -> ApiReply:
        reply = self._http.request(
            "PUT",
            url,
            headers={"Content-Type": content_type},
            body=body,
            connect_timeout=connect_timeout,
            total_timeout=total_timeout,
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
        self._out: queue.Queue[bytes | None] = queue.Queue()
        self._queued = 0
        self._lock = threading.Lock()
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

    def alive(self) -> bool:
        proc = self._proc
        return proc is not None and proc.poll() is None

    # -- sending

    def _send(self, frame: bytes) -> bool:
        if self._proc is None or self.exited.is_set() or self._killed:
            return False
        with self._lock:
            self._queued += len(frame)
        self._out.put(frame)
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
        return self._send(_wire().pack_eof())

    def send_remux(self) -> bool:
        return self._send(_wire().pack_remux())

    def quit(self) -> bool:
        self._quit_sent = True
        return self._send(_wire().pack_quit())

    def kill(self) -> None:
        """SIGKILL equivalent; the spool stays valid up to its last fragment."""
        self._killed = True
        proc = self._proc
        if proc is not None:
            with contextlib.suppress(Exception):
                proc.kill()
        self._out.put(None)

    # -- threads

    def _write_loop(self) -> None:
        proc = self._proc
        stdin = proc.stdin
        try:
            while True:
                frame = self._out.get()
                if frame is None:
                    break
                try:
                    stdin.write(frame)
                    stdin.flush()
                except (OSError, ValueError):
                    self.exited.set()
                    break
                finally:
                    with self._lock:
                        self._queued -= len(frame)
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
        if deficit > int(GAP_SLACK_SECONDS * SAMPLE_RATE):
            mixed = np.concatenate((np.zeros(deficit, dtype=np.int16), mixed))
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


# ---------------------------------------------------------------------------- uploader


def _bounded_int(value: Any, low: int, high: int, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    number = int(value)
    return number if low <= number <= high else default


class UploadWorker:
    """The one thread that talks to the API and to the presigned URLs.

    Periodic work (prepare, 5 MiB parts cut from the growing MP4, the OGG checkpoint) runs on
    its loop; the finish queues jobs onto the same thread, so there is exactly one request in
    flight and one owner of the counters.  A part's bytes stay on disk until its 200.
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

    def start(self) -> None:
        self._thread.start()

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
        self._interrupt.set()  # cut a retry sleep short: the finish is waiting
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
        step: Callable[[tuple[float, float]], tuple[str, Any]],
        *,
        deadline: float | None,
        interruptible: bool,
    ) -> tuple[str, Any]:
        """Run ``step`` up to four times (1 s, 3 s, 7 s apart, jittered), within ``deadline``."""
        attempts = len(RETRY_DELAYS_SECONDS) + 1
        for attempt in range(attempts):
            if self._halt.is_set() or (interruptible and self._interrupt.is_set()):
                return ABORTED, None
            timeouts = self._timeouts(deadline)
            if timeouts is None:
                return FAILED, None
            try:
                outcome, value = step(timeouts)
            except HttpFailure as failure:
                if failure.kind == "aborted":
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
        def step(timeouts: tuple[float, float]) -> tuple[str, Any]:
            reply = self._api.post(
                "prepare", {"mode": self._mode}, connect_timeout=timeouts[0], total_timeout=timeouts[1]
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

    def _part_step(self, number: int, data: bytes) -> Callable[[tuple[float, float]], tuple[str, Any]]:
        def step(timeouts: tuple[float, float]) -> tuple[str, Any]:
            reply = self._api.post(
                "part-url", {"part_number": number}, connect_timeout=timeouts[0], total_timeout=timeouts[1]
            )
            verdict, reason = classify(reply)
            if verdict != OK:
                return verdict, reason
            url = reply.data.get("url")
            if not isinstance(url, str) or not url:
                return RETRY, "bad_reply"
            put = self._api.put(
                url, data, "application/octet-stream", connect_timeout=timeouts[0], total_timeout=timeouts[1]
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

        def step(timeouts: tuple[float, float]) -> tuple[str, Any]:
            reply = self._api.post(
                "object-url", {"kind": kind}, connect_timeout=timeouts[0], total_timeout=timeouts[1]
            )
            verdict, reason = classify(reply)
            if verdict != OK:
                return verdict, reason
            url = reply.data.get("url")
            content_type = reply.data.get("content_type")
            if not isinstance(url, str) or not url or not isinstance(content_type, str) or not content_type:
                return RETRY, "bad_reply"
            put = self._api.put(
                url, data, content_type, connect_timeout=timeouts[0], total_timeout=timeouts[1]
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

        def step(timeouts: tuple[float, float]) -> tuple[str, Any]:
            reply = self._api.post("complete", body, connect_timeout=timeouts[0], total_timeout=timeouts[1])
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
    ) -> None:
        self._session = session
        self._ctx = ctx
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
        self._worker = UploadWorker(
            api=api,
            http_client=http_client,
            spool=spool,
            mode=MODE_AUDIO if not VIDEO_CAPTURE_READY else mode,
            clock=clock,
            on_discard=self._on_discard,
            on_stop=self._on_stop,
            mp4_enabled=lambda: self._encoder_lost is None,
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
        if self._encoder is not None and not self._encoder.dead:
            self._encoder.send_hello(video=False, preset="superfast", t0_us=int(self._t0 * 1_000_000))
        self._tee_thread = threading.Thread(target=self._tee_loop, daemon=True, name="r1rec_tee")
        self._tee_thread.start()
        self._worker.start()
        self.phase = CAPTURING
        self._watchdog = loop.create_task(self._watch())
        _log.info("unknown_event", error_type="r1_rec_started", error_category=self._mode)

    def _abort_start(self) -> None:
        """A start that failed or was refused: nothing was promised, so drop everything quietly."""
        self.phase = DONE
        self._stop_called = True
        self._kill_encoder()
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
        except asyncio.CancelledError:
            raise

    def _check_encoder(self) -> None:
        enc = self._encoder
        if enc is None or self._encoder_lost is not None or enc.closed.is_set():
            return
        now = self._clock()
        if enc.dead or enc.exited.is_set():
            self._lose_encoder("encoder_crashed" if enc.ready.is_set() else "encoder_unavailable", stalled=False)
        elif not enc.ready.is_set():
            if enc.spawned_at is not None and now - enc.spawned_at > SELF_TEST_WAIT_SECONDS:
                self._lose_encoder("encoder_unavailable", stalled=False)
        elif enc.error_code not in (None, "remux_failed"):
            self._lose_encoder("encoder_crashed", stalled=False)
        elif enc.last_status_at is not None and now - enc.last_status_at > ENCODER_STALL_SECONDS:
            self._lose_encoder("encoder_crashed", stalled=True)

    def _lose_encoder(self, reason: str, *, stalled: bool) -> None:
        """The MP4 can no longer carry the audio: kill the child; the OGG carries it from here."""
        if self._encoder_lost is not None:
            return
        self._encoder_lost = reason
        self._lost_stalled = stalled
        self._kill_encoder()
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
        io = self._io
        if io is not None:
            with contextlib.suppress(Exception):
                io.close_capture()

    def _begin_discard_cleanup(self) -> None:
        if self._discard_task is None:
            self._discard_task = asyncio.ensure_future(self._discard_cleanup())

    async def _discard_cleanup(self) -> None:
        """Stop the SDK recorder, then overwrite and unlink everything the spool holds."""
        try:
            await self._close_io()
        finally:
            self._worker.halt()
            self._wipe(overwrite=True)

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

    def _emergency_cleanup(self) -> None:
        self._kill_encoder()
        self._worker.halt()
        self._wipe(overwrite=self._discard_reason is not None)

    def _wipe(self, *, overwrite: bool) -> None:
        with contextlib.suppress(Exception):
            self._spool.wipe(overwrite=overwrite)

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
            self._wipe(overwrite=False)
            return
        upload_deadline = deadline - reserve
        mp4_ok = closed and self._encoder_lost is None
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
            lambda: self._worker.job_tail(mp4=mp4_ok, final_ogg=not mp4_ok, deadline=upload_deadline),
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
            self._wipe(overwrite=False)
            return
        if want_fast and tail_ok and enc is not None:
            remaining = upload_deadline - self._clock()
            if remaining > 0.5 and await self._poll(enc.remuxed.is_set, remaining - 0.5) and enc.remux_bytes:
                await self._run_job(lambda: self._worker.job_video(deadline=upload_deadline), upload_deadline)
        failure = self._failure_reason(uploaded=uploaded, tail_ok=tail_ok, timed_out=timed_out)
        layout = "combined" if mp4_ok else "audio_only"
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
        self._wipe(overwrite=False)

    def _failure_reason(self, *, uploaded: bool, tail_ok: bool, timed_out: bool) -> str | None:
        """The worker's reason code for a recording that is not fully delivered (vocabulary C11)."""
        if self._encoder_lost == "encoder_unavailable":
            return "encoder_unavailable"
        if self._encoder_lost is not None:
            return "encoder_crashed"
        if timed_out:
            return "finish_timeout"
        if not uploaded or not tail_ok:
            return "upload_failed"
        return None

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
        body: dict[str, Any] = {"layout": layout, "has_video": False, "report": report}
        if failure:
            body["failure_reason"] = failure
        if self._lost_stalled:
            body["degraded_reason"] = "encoder_stalled"
        return body

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
        )
    except Exception as exc:  # noqa: BLE001 - recording must never stop an interview from starting
        _log.warn("unknown_event", error_type="r1_rec_build_failed", error_category=_error_type_of(exc))
        return None
