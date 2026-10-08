"""R1 scripted-line audio: a Sarvam request budget, a 429 counter by lane and a line cache.

Plan 5.2 and 5.15, and risk 18 ("Sarvam account limits shared with phone"): Sarvam's
rate limits are per ACCOUNT and the phone lane speaks on the same account, so R1's own
background synthesis must be paced, must back off when Sarvam says 429, and must be visible
per lane.  Three small pieces, all free of the SDK except where a real synthesis happens:

* ``SynthesisBucket``: a token bucket.  R1 starts at most ``R1_SYNTH_PER_MIN`` (default 5)
  syntheses a minute, one at a time spaced evenly, and a 429 closes the bucket for a backoff.
* ``RateLimitCounter``: 429s counted by lane and component, so a phone-side 429 burst can be
  compared with what R1 asked for.  R1 only ever records the lane ``"r1"``; the phone lane is
  deliberately not instrumented here (it must stay byte-identical), but the key is a lane so
  the same counter can serve it later.
* ``LineCache``: the audio of scripted lines.  A line that carries no candidate PII is
  synthesised once per machine and kept on local disk by the digest of its text and the voice;
  a line that carries the candidate's first name is synthesised per session and kept in memory
  only, never written to disk.  A played line is then ``session.say(text, audio=frames)``:
  no TTS round trip at all, so it starts as soon as the audio output does.

Nothing here runs in worker prewarm (plan section 9).  The cache is warmed in the background
from the interview, and every failure degrades to the live TTS, which is exactly today's
behaviour: a missing, corrupt or mismatched clip is a miss, never an error.

The synthesis uses a SEPARATE ``sarvam.TTS`` instance.  The session's own TTS reports every
error to the session, where three unrecoverable ones end the interview; a failed background
synthesis must never be able to do that.

This module logs nothing: ``on_event`` is the single reporting seam and ``r1_session`` turns
each event into one ``r1`` log line.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import random
import tempfile
import time
import wave
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Mapping, Sequence

from r1_script import line_sha256
from r1_tts import r1_tts_kwargs

LANE_R1 = "r1"
DEFAULT_SYNTHS_PER_MINUTE = 5
CACHE_VERSION = 1
FRAME_MS = 20
SYNTH_TIMEOUT_SEC = 20.0
MAX_ATTEMPTS = 3
MAX_CONSECUTIVE_FAILURES = 3
BACKOFF_BASE_SEC = 5.0
BACKOFF_CAP_SEC = 60.0
MAX_CLIP_SECONDS = 90.0
MAX_CACHE_FILES = 128
_OFF_VALUES = frozenset({"off", "0", "false", "no"})

# on_event(kind, line_id, **detail): kind is one of the labels documented on ``LineCache``.
OnEvent = Callable[..., None]
Synthesizer = Callable[[str], Awaitable["PcmClip"]]
FrameFactory = Callable[[bytes, int, int, int], Any]


def synths_per_minute() -> int:
    """How many background syntheses R1 may start in a minute (plan 5.2: 5; bounded 1-30)."""
    raw = os.getenv("R1_SYNTH_PER_MIN")
    try:
        value = int(raw) if raw is not None and raw.strip() != "" else DEFAULT_SYNTHS_PER_MINUTE
    except ValueError:
        return DEFAULT_SYNTHS_PER_MINUTE
    return min(30, max(1, value))


def line_cache_enabled() -> bool:
    """The line cache is on unless ``R1_LINE_CACHE`` says off (the rollback)."""
    return (os.getenv("R1_LINE_CACHE") or "on").strip().lower() not in _OFF_VALUES


def default_directory() -> Path:
    """Where this machine keeps its candidate-free lines (ephemeral on Fly, by design)."""
    return Path(tempfile.gettempdir()) / "r1-line-cache"


# ---------------------------------------------------------------------- request budget


class SynthesisBucket:
    """Start at most ``per_minute`` syntheses a minute, evenly spaced, with a 429 back-off.

    A bucket of ``burst`` tokens refilled at ``per_minute / 60`` a second.  ``burst`` defaults
    to 1, so syntheses are paced one interval apart and a minute never holds more than
    ``per_minute`` starts (plus the one the first token allows).  ``penalize`` empties the
    bucket and holds it shut for a while, which is how a 429 slows everything that follows.
    """

    def __init__(
        self,
        per_minute: int = DEFAULT_SYNTHS_PER_MINUTE,
        *,
        burst: int = 1,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    ) -> None:
        self._interval = 60.0 / max(1, per_minute)
        self._burst = max(1, burst)
        self._clock = clock
        self._sleep = sleep
        self._tokens = float(self._burst)
        self._stamp = clock()
        self._blocked_until = float("-inf")
        self._lock = asyncio.Lock()

    @property
    def interval(self) -> float:
        return self._interval

    def _refill(self, now: float) -> None:
        elapsed = max(0.0, now - self._stamp)
        self._tokens = min(float(self._burst), self._tokens + elapsed / self._interval)
        self._stamp = now

    async def acquire(self) -> None:
        """Wait for a token (and for any 429 back-off to end), then take it."""
        async with self._lock:
            while True:
                now = self._clock()
                self._refill(now)
                blocked = self._blocked_until - now
                if blocked <= 0.0 and self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                wait = blocked if blocked > 0.0 else (1.0 - self._tokens) * self._interval
                await self._sleep(wait)

    def penalize(self, seconds: float) -> None:
        """Close the bucket for ``seconds`` and drop its tokens (a 429 was just seen)."""
        now = self._clock()
        self._blocked_until = max(self._blocked_until, now + max(0.0, seconds))
        self._tokens = 0.0
        self._stamp = now


class RateLimitCounter:
    """Provider 429s counted by lane and component (``tts``, ``stt`` or ``llm``)."""

    def __init__(self) -> None:
        self._counts: dict[tuple[str, str], int] = {}

    def record(self, lane: str, component: str) -> int:
        """Count one 429 and return the new total for this lane and component."""
        key = (lane, component)
        self._counts[key] = self._counts.get(key, 0) + 1
        return self._counts[key]

    def count(self, lane: str, component: str | None = None) -> int:
        return sum(
            total
            for (seen_lane, seen_component), total in self._counts.items()
            if seen_lane == lane and (component is None or seen_component == component)
        )

    def snapshot(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = {}
        for (lane, component), total in sorted(self._counts.items()):
            out.setdefault(lane, {})[component] = total
        return out


# One per process, which is one per machine for the single-job R1 worker.
RATE_LIMITS = RateLimitCounter()


def status_of(exc: BaseException | None) -> int | None:
    """The HTTP status carried by a provider error, looking through ``__cause__``."""
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        status = getattr(exc, "status_code", None)
        if isinstance(status, int) and not isinstance(status, bool):
            return status
        exc = exc.__cause__
    return None


# ------------------------------------------------------------------------- audio clips


def audio_frame(data: bytes, sample_rate: int, channels: int, samples: int) -> Any:
    """Build the SDK's ``rtc.AudioFrame`` (imported lazily: this module is SDK-free)."""
    from livekit import rtc

    return rtc.AudioFrame(
        data=data, sample_rate=sample_rate, num_channels=channels, samples_per_channel=samples
    )


@dataclass(frozen=True)
class PcmClip:
    """Mono or stereo signed 16-bit PCM and the format it was produced in."""

    pcm: bytes
    sample_rate: int
    channels: int = 1

    @property
    def seconds(self) -> float:
        return len(self.pcm) / (2.0 * self.channels * self.sample_rate)

    def valid(self) -> bool:
        return (
            self.sample_rate > 0
            and self.channels in (1, 2)
            and len(self.pcm) > 0
            and len(self.pcm) % (2 * self.channels) == 0
        )

    async def frames(
        self, make_frame: FrameFactory | None = None, frame_ms: int = FRAME_MS
    ) -> AsyncIterator[Any]:
        """The clip as ``frame_ms`` audio frames, ready for ``session.say(audio=...)``."""
        build = make_frame or audio_frame
        per_frame = max(1, self.sample_rate * frame_ms // 1000)
        step = per_frame * self.channels * 2
        for start in range(0, len(self.pcm), step):
            data = self.pcm[start : start + step]
            yield build(data, self.sample_rate, self.channels, len(data) // (2 * self.channels))


def write_wav(path: Path, clip: PcmClip) -> None:
    """Write ``clip`` atomically: a reader never sees a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{random.getrandbits(32):08x}.tmp")
    try:
        with wave.open(str(temporary), "wb") as handle:
            handle.setnchannels(clip.channels)
            handle.setsampwidth(2)
            handle.setframerate(clip.sample_rate)
            handle.writeframes(clip.pcm)
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(OSError):
            temporary.unlink()


def read_wav(path: Path, sample_rate: int, channels: int, max_seconds: float) -> PcmClip | None:
    """Read a cached clip, or None when it is not exactly the format and size expected."""
    try:
        with wave.open(str(path), "rb") as handle:
            if (
                handle.getsampwidth() != 2
                or handle.getnchannels() != channels
                or handle.getframerate() != sample_rate
                or handle.getcomptype() != "NONE"
            ):
                return None
            frames = handle.getnframes()
            if frames <= 0 or frames / sample_rate > max_seconds:
                return None
            pcm = handle.readframes(frames)
    except (wave.Error, EOFError):
        return None
    clip = PcmClip(pcm, sample_rate, channels)
    return clip if clip.valid() and len(pcm) == frames * channels * 2 else None


# --------------------------------------------------------------------------- synthesis


class SarvamSynthesizer:
    """Synthesise one line with its own ``sarvam.TTS`` (never the session's)."""

    def __init__(
        self,
        tts_kwargs: Mapping[str, Any],
        *,
        timeout: float = SYNTH_TIMEOUT_SEC,
        factory: Callable[[Mapping[str, Any]], Any] | None = None,
    ) -> None:
        self._kwargs = dict(tts_kwargs)
        self._timeout = timeout
        self._factory = factory
        self._tts: Any = None

    def _ensure(self) -> Any:
        if self._tts is None:
            if self._factory is not None:
                self._tts = self._factory(self._kwargs)
            else:
                from livekit.plugins import sarvam

                self._tts = sarvam.TTS(**self._kwargs)
        return self._tts

    async def __call__(self, text: str) -> PcmClip:
        tts = self._ensure()
        if self._factory is None:
            from livekit.agents import APIConnectOptions

            # No SDK retries: the bucket owns the pacing and the 429 back-off.
            stream = tts.synthesize(
                text, conn_options=APIConnectOptions(max_retry=0, timeout=self._timeout)
            )
        else:
            stream = tts.synthesize(text)
        try:
            frame = await stream.collect()
        finally:
            with contextlib.suppress(Exception):
                await stream.aclose()
        return PcmClip(bytes(frame.data), int(frame.sample_rate), int(frame.num_channels))

    async def aclose(self) -> None:
        tts, self._tts = self._tts, None
        aclose = getattr(tts, "aclose", None)
        if callable(aclose):
            with contextlib.suppress(Exception):
                await aclose()


@dataclass(frozen=True)
class LineSpec:
    """One line to warm: its reviewed id, its exact rendered text and whether it may be kept
    on disk (only a line with no candidate PII may)."""

    line_id: str
    text: str
    persist: bool


class LineCache:
    """The audio of scripted lines, in memory and (for candidate-free lines) on disk.

    ``on_event(kind, line_id, **detail)`` reports, with ``kind`` one of: ``disk_hit``,
    ``disk_corrupt``, ``disk_write_failed``, ``disk_full``, ``synth_ok`` (``seconds``),
    ``synth_failed`` (``error``), ``rate_limited`` (``count``, ``seconds``), ``gave_up``,
    ``clip_rejected``, ``warm_aborted`` and ``warm_done`` (``count``).
    """

    def __init__(
        self,
        synthesizer: Synthesizer,
        *,
        voice: Mapping[str, Any],
        sample_rate: int,
        channels: int = 1,
        directory: Path | None = None,
        bucket: SynthesisBucket | None = None,
        counter: RateLimitCounter | None = None,
        on_event: OnEvent | None = None,
        clock: Callable[[], float] = time.monotonic,
        jitter: Callable[[], float] = random.random,
        synth_timeout: float = SYNTH_TIMEOUT_SEC,
        max_clip_seconds: float = MAX_CLIP_SECONDS,
        max_files: int = MAX_CACHE_FILES,
    ) -> None:
        self._synthesizer = synthesizer
        self._voice = dict(voice)
        self._rate = sample_rate
        self._channels = channels
        self._directory = directory
        self._bucket = SynthesisBucket(synths_per_minute()) if bucket is None else bucket
        self._counter = RATE_LIMITS if counter is None else counter
        self._on_event = on_event
        self._clock = clock
        self._jitter = jitter
        self._synth_timeout = synth_timeout
        self._max_clip_seconds = max_clip_seconds
        self._max_files = max_files
        self._memory: dict[str, PcmClip] = {}

    # ------------------------------------------------------------------------ lookup

    @property
    def sample_rate(self) -> int:
        return self._rate

    @property
    def channels(self) -> int:
        return self._channels

    def key(self, text: str) -> str:
        """The cache key: the digest of the exact text and of the voice that speaks it."""
        document = {
            "v": CACHE_VERSION,
            "text": line_sha256(text),
            "voice": self._voice,
            "rate": self._rate,
            "channels": self._channels,
        }
        return sha256(json.dumps(document, sort_keys=True).encode("utf-8")).hexdigest()[:40]

    def lookup(self, text: str) -> PcmClip | None:
        """The warmed clip for ``text``, from memory only (cheap enough for the speech path)."""
        return self._memory.get(self.key(text))

    @property
    def size(self) -> int:
        """How many lines are warm (a count, not ``__len__``: an empty cache must stay truthy)."""
        return len(self._memory)

    def listen(self, on_event: OnEvent | None) -> None:
        """Report to ``on_event`` from now on (the interview that owns the cache hooks in)."""
        self._on_event = on_event

    # ------------------------------------------------------------------------ warming

    async def warm(self, specs: Sequence[LineSpec]) -> dict[str, int]:
        """Fill the cache for ``specs`` in order; returns how each line was obtained."""
        stats = {"memory": 0, "disk": 0, "synthesized": 0, "failed": 0}
        consecutive = 0
        for spec in specs:
            key = self.key(spec.text)
            if key in self._memory:
                stats["memory"] += 1
                continue
            if spec.persist:
                clip = await self._load(spec, key)
                if clip is not None:
                    self._memory[key] = clip
                    stats["disk"] += 1
                    self._event("disk_hit", spec.line_id, seconds=clip.seconds)
                    continue
            clip = await self._synthesize(spec)
            if clip is None:
                stats["failed"] += 1
                consecutive += 1
                if consecutive >= MAX_CONSECUTIVE_FAILURES:
                    self._event("warm_aborted", spec.line_id, count=stats["failed"])
                    break
                continue
            consecutive = 0
            self._memory[key] = clip
            stats["synthesized"] += 1
            if spec.persist:
                await self._store(spec, key, clip)
        self._event("warm_done", "", count=len(self._memory))
        return stats

    async def aclose(self) -> None:
        close = getattr(self._synthesizer, "aclose", None)
        if callable(close):
            with contextlib.suppress(Exception):
                await close()

    # ---------------------------------------------------------------------- internals

    def _event(self, kind: str, line_id: str, **detail: Any) -> None:
        if self._on_event is None:
            return
        try:
            self._on_event(kind, line_id, **detail)
        except Exception:  # noqa: BLE001 - reporting must never disturb the cache
            pass

    def _backoff(self, attempt: int) -> float:
        base = min(BACKOFF_CAP_SEC, BACKOFF_BASE_SEC * (2**attempt))
        return base * (0.5 + self._jitter())

    async def _synthesize(self, spec: LineSpec) -> PcmClip | None:
        for attempt in range(MAX_ATTEMPTS):
            await self._bucket.acquire()
            started = self._clock()  # the synthesis itself, not the wait for the bucket
            try:
                clip = await asyncio.wait_for(
                    self._synthesizer(spec.text), self._synth_timeout
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - every failure is just a cache miss
                if status_of(exc) == 429:
                    count = self._counter.record(LANE_R1, "tts")
                    delay = self._backoff(attempt)
                    self._bucket.penalize(delay)
                    self._event("rate_limited", spec.line_id, count=count, seconds=delay)
                    continue
                self._event("synth_failed", spec.line_id, error=type(exc).__name__)
                return None
            if (
                not clip.valid()
                or clip.sample_rate != self._rate
                or clip.channels != self._channels
                or clip.seconds > self._max_clip_seconds
            ):
                self._event("clip_rejected", spec.line_id)
                return None
            self._event("synth_ok", spec.line_id, seconds=self._clock() - started)
            return clip
        self._event("gave_up", spec.line_id)
        return None

    def _path(self, key: str) -> Path | None:
        return None if self._directory is None else self._directory / f"{key}.wav"

    async def _load(self, spec: LineSpec, key: str) -> PcmClip | None:
        path = self._path(key)
        if path is None:
            return None
        try:
            if not await asyncio.to_thread(path.is_file):
                return None
            clip = await asyncio.to_thread(
                read_wav, path, self._rate, self._channels, self._max_clip_seconds
            )
        except OSError:
            return None
        if clip is None:
            self._event("disk_corrupt", spec.line_id)
            with contextlib.suppress(OSError):
                await asyncio.to_thread(path.unlink)
        return clip

    async def _store(self, spec: LineSpec, key: str, clip: PcmClip) -> None:
        path = self._path(key)
        if path is None:
            return
        try:
            existing = await asyncio.to_thread(lambda: sum(1 for _ in path.parent.glob("*.wav")))
        except OSError:
            existing = 0
        if existing >= self._max_files:
            self._event("disk_full", spec.line_id)
            return
        try:
            await asyncio.to_thread(write_wav, path, clip)
        except OSError as exc:
            self._event("disk_write_failed", spec.line_id, error=type(exc).__name__)


def build_line_cache(
    session: Any,
    *,
    on_event: OnEvent | None = None,
    counter: RateLimitCounter | None = None,
    directory: Path | None = None,
    synthesizer_factory: Callable[[Mapping[str, Any]], Synthesizer] | None = None,
) -> LineCache | None:
    """The cache for ``session``, or None (disabled, no real TTS, or the TTS format is unknown).

    The cached audio must be in the format the session's audio output was opened with, so the
    cache is only built from the session TTS's own ``sample_rate`` and ``num_channels``.
    """
    if not line_cache_enabled():
        return None
    tts = getattr(session, "tts", None)
    rate = getattr(tts, "sample_rate", None)
    channels = getattr(tts, "num_channels", None)
    if (
        isinstance(rate, bool)
        or isinstance(channels, bool)
        or not isinstance(rate, int)
        or not isinstance(channels, int)
    ):
        return None
    kwargs = r1_tts_kwargs()
    synthesizer = (
        synthesizer_factory(kwargs) if synthesizer_factory is not None else SarvamSynthesizer(kwargs)
    )
    return LineCache(
        synthesizer,
        voice=kwargs,
        sample_rate=rate,
        channels=channels,
        directory=default_directory() if directory is None else directory,
        counter=counter,
        on_event=on_event,
    )
