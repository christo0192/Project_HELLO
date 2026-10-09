"""M015 PR-1: Sarvam Realtime STT SHADOW for the phone lane (metrics only).

What it is
----------
Behind ``PHONE_STT_SHADOW`` (default OFF), AFTER consent only, the candidate's
inbound audio frames - the very frames the main (legacy) STT receives, after
RNNoise - are copied to a Sarvam Realtime streaming STT socket. The shadow logs
NUMBERS ONLY: how soon the first partial word arrives after the local VAD heard
speech, when a 3rd partial word exists compared with the main STT's final, word
counts, partials with no speech / no main final, and socket health.

What it never does
------------------
* It never logs or stores transcript text. Text is reduced to a word count the
  moment it is parsed and dropped. No stdlib ``logging`` call, no ``exc_info``,
  no exception message, no Sarvam ``message`` / close reason / ``request_id``.
* Nothing it produces is ever fed to the agent, the LLM, turn detection,
  interruption, the transcripts DB, scoring or the recording. It exposes no
  event surface the SDK could consume.
* It never blocks the call: the audio path is synchronous and O(1)
  (``offer``), every error is swallowed and logged once, the frame queue is
  bounded and drops when full, and the socket is closed at call end.

Protocol references only (no upstream code is copied, so no Apache header /
NOTICE is needed):
* https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/realtime/ws
* https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming
* livekit/agents PR #6562, ``livekit-plugins-sarvam/.../stt_streaming.py`` @
  c45cb2b7 (Apache-2.0) - read to cross-check the protocol, not vendored.

Import-time dependencies are stdlib only; ``aiohttp`` and ``livekit.rtc`` are
imported lazily, so a switched-off worker never loads them for this feature.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import math
import os
import random
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import urlencode

from observability import StructuredLogger

# ── constants (module level, not env) ────────────────────────────────────────

REALTIME_BASE_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws"
# Wire format is a constant, not an env var (S01-PLAN D5): Sarvam documents
# JSON base64 ``audio_input``; upstream LiveKit sends raw binary frames.
_AUDIO_WIRE = "json_b64"
_USER_AGENT = "hello-phone-stt-shadow/1"

TAIL = 1.0            # a partial up to 1.0 s after E_k still belongs to segment k
MERGE_GAP = 0.7      # a local-VAD restart within 0.7 s of E_k (no final yet) continues segment k
SETTLE = 3.0          # a segment stays open for late finals until E_k + 3.0 s
MAX_SEGMENTS = 2000   # beyond this only the summary counts
WORD_CAP = 999        # cap on any logged word count
COUNT_CAP = 100_000   # cap on any logged counter (observability option_count)

QUEUE_MAX = 256
CONNECT_TIMEOUT_SEC = 5.0
SEND_STALL_SEC = 2.0
END_WAIT_SEC = 2.0
SOCKET_CLOSE_SEC = 2.0
CLOSE_GRACE_SEC = 3.0
PING_SEC = 15.0
TICK_SEC = 0.5
CHUNK_MS = 100
MAX_SESSION_SEC = 3600.0
NONFATAL_LOG_LIMIT = 5

DEFAULT_MODEL = "saaras:v3-realtime"
_ALLOWED_MODELS = frozenset({"saaras:v3-realtime", "saaras:v4"})
_ALLOWED_RATES = (8000, 16000)
_ALLOWED_STREAM_TYPES = frozenset({"fast", "balanced"})  # "simulated" sends no partials
_LANG_RE = re.compile(r"^[A-Za-z0-9\-]{2,16}$")
_ERR_CODE_RE = re.compile(r"^[a-z0-9_]{1,40}$")
_IDENT_RE = re.compile(r"^[A-Za-z0-9_]{1,48}$")

# call_summary counters, in emission order.
COUNTER_NAMES = (
    "segments", "silence_partials", "silence_partial_words", "rt_empty_partials",
    "orphan_legacy_finals", "orphan_rt_finals", "main_finals", "main_finals_empty",
    "rt_partials", "rt_finals", "rt_vad_starts", "rt_unparsed", "frames_offered",
    "frames_dropped", "chunks_sent", "errors_nonfatal", "unrecovered_death", "segments_merged",
    "queue_lag_max_ms",
)

MSG_TEXT = "text"
MSG_BINARY = "binary"
MSG_CLOSE = "close"
MSG_ERROR = "error"
_SENTINEL = object()


# ── env readers (literal os.getenv so scripts/check-env-contract.mjs sees them) ─

def phone_stt_shadow_enabled() -> bool:
    """``on`` enables; anything else (unset, ``off``, garbage) disables."""
    return (os.getenv("PHONE_STT_SHADOW") or "").strip().lower() == "on"


def _sample_parse() -> tuple[float, bool]:
    """(sample, valid). Unset -> (1.0, True). Non-numeric -> (0.0, False)."""
    raw = (os.getenv("PHONE_STT_SHADOW_SAMPLE") or "").strip()
    if not raw:
        return 1.0, True
    try:
        value = float(raw)
    except ValueError:
        return 0.0, False
    if not math.isfinite(value):
        return 0.0, False
    return min(1.0, max(0.0, value)), True


def phone_stt_shadow_sample() -> float:
    """Fraction of calls to shadow, 0-1. An invalid value FAILS CLOSED to 0."""
    return _sample_parse()[0]


def phone_stt_shadow_model() -> str:
    raw = (os.getenv("PHONE_STT_SHADOW_MODEL") or "").strip()
    return raw if raw in _ALLOWED_MODELS else DEFAULT_MODEL


def phone_stt_shadow_sample_rate() -> int:
    raw = (os.getenv("PHONE_STT_SHADOW_SAMPLE_RATE") or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return 16000
    return value if value in _ALLOWED_RATES else 16000


def phone_stt_shadow_stream_type() -> str:
    raw = (os.getenv("PHONE_STT_SHADOW_STREAM_TYPE") or "").strip().lower()
    return raw if raw in _ALLOWED_STREAM_TYPES else "fast"


def phone_stt_shadow_vad_threshold() -> float:
    raw = (os.getenv("PHONE_STT_SHADOW_VAD_THRESHOLD") or "").strip()
    try:
        value = float(raw)
    except ValueError:
        return 0.5
    if not math.isfinite(value):
        return 0.5
    return min(0.9, max(0.1, value))


def phone_stt_shadow_silence_ms() -> int:
    raw = (os.getenv("PHONE_STT_SHADOW_SILENCE_MS") or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return 700
    return min(1500, max(300, value))


# ── config and URL ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ShadowConfig:
    model: str = DEFAULT_MODEL
    stream_type: str = "fast"
    sample_rate: int = 16000
    vad_threshold: float = 0.5
    silence_ms: int = 700
    language: str = "en-IN"


def _config_from_env() -> ShadowConfig:
    lang = (os.getenv("SARVAM_LANGUAGE") or "").strip()
    return ShadowConfig(
        model=phone_stt_shadow_model(),
        stream_type=phone_stt_shadow_stream_type(),
        sample_rate=phone_stt_shadow_sample_rate(),
        vad_threshold=phone_stt_shadow_vad_threshold(),
        silence_ms=phone_stt_shadow_silence_ms(),
        language=lang if _LANG_RE.match(lang) else "en-IN",
    )


def build_realtime_url(cfg: ShadowConfig) -> str:
    """The Realtime WebSocket URL. It NEVER carries the API key."""
    query = {
        "language_code": cfg.language,
        "model": cfg.model,
        "stream_type": cfg.stream_type,
        "mode": "transcribe",
        "endpointing": "vad",
        "encoding": "linear16",
        "sample_rate": str(cfg.sample_rate),
        "threshold": f"{cfg.vad_threshold:g}",
        "silence_duration_ms": str(cfg.silence_ms),
        "return_timestamps": "false",
    }
    return f"{REALTIME_BASE_URL}?{urlencode(query)}"


# ── logging helpers ──────────────────────────────────────────────────────────

def _r3(value: float) -> float:
    try:
        return round(max(0.0, float(value)), 3)
    except Exception:  # noqa: BLE001
        return 0.0


def _num(value: Any) -> Optional[float]:
    """A finite non-negative number from a number or a numeric string (Sarvam
    sends ``audio_duration_s`` as a string, e.g. "42.1"), else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) and out >= 0 else None


def _words(n: int) -> int:
    return max(0, min(WORD_CAP, int(n)))


def _count(n: int) -> int:
    return max(0, min(COUNT_CAP, int(n)))


def _exc_name(exc: BaseException) -> str:
    name = type(exc).__name__
    return name if _IDENT_RE.match(name) else "exception"


class _Emitter:
    """Writes one allowlisted structured line. Never raises, never logs text."""

    def __init__(self, logger: Optional[StructuredLogger] = None) -> None:
        self._log = logger or StructuredLogger("phone_stt_shadow")

    def __call__(self, category: str, *, level: str = "info", **meta: Any) -> None:
        try:
            fn = self._log.warn if level == "warn" else self._log.info
            fn("unknown_event", error_type="phone_stt_shadow",
               error_category=category, **meta)
        except Exception:  # noqa: BLE001 - logging never breaks the call
            pass


# ── segment tracker (pure) ───────────────────────────────────────────────────

class _Segment:
    __slots__ = (
        "k", "start", "end", "p1", "p3", "pmax", "f", "lw", "lf", "rf", "rw",
        "rfn",
    )

    def __init__(self, k: int, start: float) -> None:
        self.k = k
        self.start = start
        self.end: Optional[float] = None
        self.p1: Optional[float] = None
        self.p3: Optional[float] = None
        self.pmax = 0
        self.f: Optional[float] = None   # first legacy final
        self.lw = 0                      # legacy words (sum)
        self.lf = 0                      # legacy final count
        self.rf: Optional[float] = None  # first realtime final
        self.rw = 0
        self.rfn = 0

    def klass(self) -> str:
        if self.lw >= 1 and self.pmax >= 1:
            return "both"
        if self.pmax >= 1 and (self.f is None or self.lw == 0):
            return "noise_partial"
        if self.lw >= 1 and self.pmax == 0:
            return "rt_missed"
        return "silent"


class SegmentTracker:
    """Attributes realtime partials/finals and legacy finals to local-VAD segments.

    Pure: no I/O. ``emit(category, **meta)`` receives the allowlisted lines.
    Times are read from ``clock`` and logged as non-negative offsets from the
    segment's local VAD start; signed differences are computed offline.
    """

    def __init__(self, clock: Callable[[], float], emit: Callable[..., None],
                 counters: Optional[dict[str, int]] = None) -> None:
        self._clock = clock
        self._emit = emit
        self.counters: dict[str, int] = counters if counters is not None else {}
        for name in COUNTER_NAMES:
            self.counters.setdefault(name, 0)
        self._active: list[_Segment] = []
        self._utt: dict[int, _Segment] = {}   # Sarvam utterance_idx -> its segment
        self._next_k = 0
        self.armed = False
        self.merge_gap = MERGE_GAP

    # -- helpers
    def _open_segment(self) -> Optional[_Segment]:
        if self._active and self._active[-1].end is None:
            return self._active[-1]
        return None

    def arm(self) -> None:
        self.armed = True

    # -- local VAD
    def vad_start(self, now: Optional[float] = None) -> None:
        if not self.armed:
            return
        now = self._clock() if now is None else now
        self._settle(now)
        if self._open_segment() is not None:
            return  # duplicate start: keep the open segment
        # The deployed local VAD cuts at 0.25 s of silence; Sarvam and the main
        # STT keep one utterance across a ~0.7 s pause (cumulative partials, ONE
        # final). So a restart within MERGE_GAP of the last end, before any final
        # landed on that segment, is the same utterance: re-open it (S_k, the
        # barge-in anchor, is unchanged) instead of opening segment k+1.
        if self._active:
            last = self._active[-1]
            if (last.end is not None and now - last.end <= self.merge_gap
                    and last.f is None and last.rf is None):
                last.end = None
                self.counters["segments_merged"] += 1
                return
        self._active.append(_Segment(self._next_k, now))
        self._next_k += 1
        self.counters["segments"] += 1

    def vad_end(self, now: Optional[float] = None) -> None:
        if not self.armed:
            return
        now = self._clock() if now is None else now
        seg = self._open_segment()
        if seg is not None:
            seg.end = now
        self._settle(now)

    # -- realtime partial
    def rt_partial(self, words: int, now: Optional[float] = None,
                   utt: Optional[int] = None) -> None:
        if not self.armed:
            return
        now = self._clock() if now is None else now
        self._settle(now)
        if words < 1:
            self.counters["rt_empty_partials"] += 1
            return
        # Sarvam's ``utterance_idx`` (when present): every later partial of an
        # utterance belongs to the segment its FIRST non-empty partial landed in,
        # however late it arrives - the model's own latency must not push its
        # partials into the next segment (that would flatter G1 and G2).
        seg = self._utt.get(utt) if utt is not None else None
        if seg is None:
            seg = self._open_segment()
            if seg is None and self._active:
                last = self._active[-1]  # only the LATEST ended segment is eligible
                if last.end is not None and now <= last.end + TAIL:
                    seg = last
            if seg is not None and utt is not None:
                self._utt[utt] = seg
        if seg is None:
            self.counters["silence_partials"] += 1
            self.counters["silence_partial_words"] = _count(
                self.counters["silence_partial_words"] + words)
            return
        if seg.p1 is None:
            seg.p1 = now
        if words >= 3 and seg.p3 is None:
            seg.p3 = now
        if words > seg.pmax:
            seg.pmax = words

    # -- finals
    def _pick_final_segment(self, now: float, realtime: bool) -> Optional[_Segment]:
        """Which local segment does a final belong to?

        The pinned Sarvam plugin never sends an empty final, so a noise-only
        local segment (fan, cough, TV) gets NO final at all and must not steal
        the next real answer's. Hence evidence-first, oldest-first:
        1. the oldest ended segment still waiting for this kind of final that
           shows speech (a realtime partial, or the other kind of final);
        2. else the open segment, if it shows speech (a mid-utterance final);
        3. else the latest ended segment still waiting (nothing shows speech:
           the final was probably for the most recent sound);
        4. else the open segment.
        """
        waiting: list[_Segment] = []
        for seg in self._active:
            if seg.end is None:
                continue
            has = seg.rf is not None if realtime else seg.f is not None
            if not has and now <= seg.end + SETTLE:
                waiting.append(seg)

        def speech(seg: _Segment) -> bool:
            return seg.p1 is not None or seg.f is not None or seg.rf is not None

        for seg in waiting:
            if speech(seg):
                return seg
        opened = self._open_segment()
        if opened is not None and speech(opened):
            return opened
        if waiting:
            return waiting[-1]
        return opened

    def legacy_final(self, words: int, now: Optional[float] = None) -> None:
        if not self.armed:
            return
        now = self._clock() if now is None else now
        self._settle(now)
        self.counters["main_finals"] += 1
        if words < 1:
            self.counters["main_finals_empty"] += 1
        seg = self._pick_final_segment(now, realtime=False)
        if seg is None:
            self.counters["orphan_legacy_finals"] += 1
            return
        if seg.f is None:
            seg.f = now
        seg.lw += max(0, words)
        seg.lf += 1

    def rt_final(self, words: int, now: Optional[float] = None,
                 utt: Optional[int] = None) -> None:
        if not self.armed:
            return
        now = self._clock() if now is None else now
        self._settle(now)
        seg = self._utt.get(utt) if utt is not None else None
        if seg is None:
            seg = self._pick_final_segment(now, realtime=True)
        if seg is None:
            self.counters["orphan_rt_finals"] += 1
            return
        if seg.rf is None:
            seg.rf = now
        seg.rw += max(0, words)
        seg.rfn += 1

    # -- settling
    def tick(self, now: Optional[float] = None) -> None:
        if not self.armed:
            return
        self._settle(self._clock() if now is None else now)

    def _settle(self, now: float) -> None:
        keep: list[_Segment] = []
        dropped = False
        for seg in self._active:
            if seg.end is not None and now >= seg.end + SETTLE:
                self._log_segment(seg, "settled")
                dropped = True
            else:
                keep.append(seg)
        self._active = keep
        if dropped and self._utt:
            self._utt = {u: sg for u, sg in self._utt.items() if sg in keep}

    def close(self, now: Optional[float] = None) -> None:
        """Settle what is due, then finalize the rest as ``truncated``."""
        if self.armed:
            self._settle(self._clock() if now is None else now)
        for seg in self._active:
            self._log_segment(seg, "truncated")
        self._active = []
        self._utt = {}

    def _log_segment(self, seg: _Segment, phase: str) -> None:
        if seg.k >= MAX_SEGMENTS:
            return
        k = seg.k
        emit = self._emit
        try:
            if seg.p1 is not None:
                emit("seg_partial_lead", turn_index=k, duration_sec=_r3(seg.p1 - seg.start))
            if seg.p3 is not None:
                emit("seg_three_word", turn_index=k, duration_sec=_r3(seg.p3 - seg.start))
            if seg.f is not None:
                emit("seg_legacy_final", turn_index=k,
                     duration_sec=_r3(seg.f - seg.start), option_count=_words(seg.lw))
            if seg.rf is not None:
                emit("seg_rt_final", turn_index=k,
                     duration_sec=_r3(seg.rf - seg.start), option_count=_words(seg.rw))
            meta: dict[str, Any] = dict(
                turn_index=k, schema=seg.klass(), option_count=_words(seg.pmax),
                phase=phase,
            )
            if seg.end is not None:
                meta["duration_sec"] = _r3(seg.end - seg.start)
            emit("seg_summary", **meta)
        except Exception:  # noqa: BLE001
            pass


# ── socket layer ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class SocketMessage:
    """What the receiver needs from a socket message: a kind and (text) data."""
    type: str
    data: Optional[str] = None


class _Stall(Exception):
    """One send took longer than SEND_STALL_SEC."""


class _AiohttpSocket:
    """Thin adapter over an aiohttp ClientWebSocketResponse + its session."""

    def __init__(self, session: Any, ws: Any, aiohttp_mod: Any) -> None:
        self._session = session
        self._ws = ws
        self._aiohttp = aiohttp_mod

    @property
    def close_code(self) -> Optional[int]:
        return self._ws.close_code

    async def send_str(self, data: str) -> None:
        await self._ws.send_str(data)

    async def receive(self) -> SocketMessage:
        msg = await self._ws.receive()
        t = msg.type
        kinds = self._aiohttp.WSMsgType
        if t == kinds.TEXT:
            return SocketMessage(MSG_TEXT, msg.data)
        if t == kinds.BINARY:
            return SocketMessage(MSG_BINARY, None)  # content never retained
        if t in (kinds.CLOSE, kinds.CLOSING, kinds.CLOSED):
            return SocketMessage(MSG_CLOSE, None)
        return SocketMessage(MSG_ERROR, None)

    async def close(self) -> None:
        try:
            await self._ws.close()
        finally:
            await self._session.close()


async def _default_ws_factory(url: str, headers: dict[str, str]) -> _AiohttpSocket:
    import aiohttp  # noqa: PLC0415 - lazy: a switched-off worker never loads it here

    session = aiohttp.ClientSession()
    try:
        ws = await session.ws_connect(url, headers=headers, heartbeat=None)
    except BaseException:
        try:
            await session.close()
        except Exception:  # noqa: BLE001
            pass
        raise
    return _AiohttpSocket(session, ws, aiohttp)


class _RtcResampler:
    """mono int16 resampler over ``rtc.AudioResampler``; returns raw bytes."""

    def __init__(self, in_rate: int, out_rate: int, channels: int) -> None:
        from livekit import rtc  # noqa: PLC0415

        self._rs = rtc.AudioResampler(in_rate, out_rate, num_channels=channels)

    def push(self, frame: Any) -> list[bytes]:
        return [bytes(f.data) for f in self._rs.push(frame)]

    def flush(self) -> list[bytes]:
        return [bytes(f.data) for f in self._rs.flush()]


def _default_resampler_factory(in_rate: int, out_rate: int, channels: int) -> _RtcResampler:
    return _RtcResampler(in_rate, out_rate, channels)


# ── the shadow ───────────────────────────────────────────────────────────────

class PhoneSttShadow:
    """One per call. ``offer`` / ``observe_main`` / ``on_local_vad`` are
    synchronous, O(1) and never raise; ``close_nowait`` is synchronous and
    idempotent. Everything slow happens in the supervisor task it spawns."""

    def __init__(
        self,
        cfg: ShadowConfig,
        *,
        api_key: str,
        armed: Callable[[], bool],
        ws_factory: Optional[Callable[[str, dict], Awaitable[Any]]] = None,
        resampler_factory: Optional[Callable[[int, int, int], Any]] = None,
        clock: Callable[[], float] = time.monotonic,
        emitter: Optional[Callable[..., None]] = None,
    ) -> None:
        self._cfg = cfg
        self._url = build_realtime_url(cfg)
        self._headers = {"API-SUBSCRIPTION-KEY": api_key, "User-Agent": _USER_AGENT}
        self._armed = armed
        self._factory = ws_factory or _default_ws_factory
        self._resampler_factory = resampler_factory
        self._clock = clock
        self._emit = emitter or _Emitter()
        self.counters: dict[str, int] = {n: 0 for n in COUNTER_NAMES}
        self._tracker = SegmentTracker(clock, self._emit, self.counters)
        # The merge window follows Sarvam's own silence threshold (default 0.7 s).
        self._tracker.merge_gap = cfg.silence_ms / 1000.0

        # tunables (module constants; tests shrink them)
        self._connect_timeout = CONNECT_TIMEOUT_SEC
        self._send_stall = SEND_STALL_SEC
        self._end_wait = END_WAIT_SEC
        self._socket_close = SOCKET_CLOSE_SEC
        self._close_grace = CLOSE_GRACE_SEC
        self._ping_sec = PING_SEC
        self._tick_sec = TICK_SEC
        self._max_session = MAX_SESSION_SEC

        self._latched = False        # armed at least once
        self._dead = False           # socket/shadow ended; no more audio accepted
        self._closed = False         # close_nowait ran
        self._closing = False        # WE are ending the session
        self._queue: Optional[asyncio.Queue] = None
        self._task: Optional[asyncio.Task] = None
        self._ws: Any = None
        self._lock: Optional[asyncio.Lock] = None
        self._hard_timer: Any = None
        self._opened_at: Optional[float] = None
        self._close_logged = False
        self._drop_logged = False
        self._failed_phases: set[str] = set()
        self._nonfatal_logged = 0
        self._begin_logged = False

        self._in_rate: Optional[int] = None
        self._resampler: Any = None
        self._buf = bytearray()
        self._out_rate = cfg.sample_rate
        self._chunk_bytes = cfg.sample_rate * 2 * CHUNK_MS // 1000

    # ---- audio path (synchronous) -------------------------------------------

    def offer(self, frame: Any) -> None:
        try:
            if self._closed or self._dead:
                return
            if not self._latched:
                try:
                    ok = bool(self._armed())
                except Exception:  # noqa: BLE001
                    ok = False
                if not ok:
                    return
                self._start()
            self.counters["frames_offered"] += 1
            try:
                self._queue.put_nowait((self._clock(), frame))  # type: ignore[union-attr]
            except asyncio.QueueFull:
                self.counters["frames_dropped"] += 1
                if not self._drop_logged:
                    self._drop_logged = True
                    self._emit("frames_dropped", level="warn",
                               option_count=_count(self.counters["frames_dropped"]))
        except Exception as exc:  # noqa: BLE001
            self._fail("offer", exc, cancel=True)

    def observe_main(self, ev: Any) -> None:
        try:
            if self._closed or self._dead or not self._latched:
                return
            raw = getattr(ev, "type", None)
            if getattr(raw, "value", raw) != "final_transcript":
                return
            alts = getattr(ev, "alternatives", None)
            n = 0
            if alts:
                text = getattr(alts[0], "text", "")
                n = len(text.split()) if isinstance(text, str) else 0
                text = None  # noqa: F841 - drop the text immediately
            self._tracker.legacy_final(n)
        except Exception as exc:  # noqa: BLE001
            self._fail("observe", exc, cancel=True)

    def on_local_vad(self, kind: str) -> None:
        try:
            if self._closed or self._dead or not self._latched:
                return
            if kind == "start":
                self._tracker.vad_start()
            elif kind == "end":
                self._tracker.vad_end()
        except Exception as exc:  # noqa: BLE001
            self._fail("vad", exc, cancel=True)

    # ---- lifecycle ---------------------------------------------------------

    def _start(self) -> None:
        loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self._lock = asyncio.Lock()
        self._latched = True
        self._tracker.arm()
        self._emit("armed")
        self._task = loop.create_task(self._run())
        self._task.add_done_callback(self._on_done)

    @staticmethod
    def _on_done(task: "asyncio.Task") -> None:
        try:
            if not task.cancelled():
                task.exception()  # retrieve; never re-raised
        except Exception:  # noqa: BLE001
            pass

    def _mark_death(self) -> None:
        self.counters["unrecovered_death"] = 1
        self._dead = True

    def _cancel_task(self) -> None:
        try:
            task = self._task
            if task is not None and not task.done():
                task.cancel()
        except Exception:  # noqa: BLE001
            pass

    def _fail(self, phase: str, exc: Optional[BaseException] = None, *,
              schema: Optional[str] = None, cancel: bool = False) -> None:
        try:
            if phase not in self._failed_phases:
                self._failed_phases.add(phase)
                name = schema or (_exc_name(exc) if exc is not None else "exception")
                self._emit("shadow_failed", level="warn", schema=name, phase=phase)
            self._mark_death()
            if cancel:
                self._cancel_task()
        except Exception:  # noqa: BLE001
            pass

    def _emit_summary(self) -> None:
        for name in COUNTER_NAMES:
            self._emit("call_summary", schema=name,
                       option_count=_count(self.counters.get(name, 0)))

    def _begin_graceful(self) -> None:
        """Ask the sender to flush, send ``end`` and stop; arm the hard bound."""
        self._closing = True
        q = self._queue
        if q is not None:
            try:
                while True:
                    q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                q.put_nowait(_SENTINEL)
            except asyncio.QueueFull:  # pragma: no cover - just drained
                pass
        task = self._task
        if self._hard_timer is None and task is not None and not task.done():
            self._hard_timer = task.get_loop().call_later(self._close_grace, self._cancel_task)

    def close_nowait(self) -> None:
        """Synchronous + idempotent. The summary is emitted BEFORE anything can
        be awaited, because the job may be force-exited right after teardown."""
        if self._closed:
            return
        self._closed = True
        self._closing = True
        if self._latched:
            try:
                self._tracker.close(self._clock())
                self._emit_summary()
            except Exception:  # noqa: BLE001
                pass
        else:
            # The call ended without the shadow ever arming (no consent, or no
            # frame after it): say so, so "config but nothing else" is not silent.
            self._emit("closed_unarmed")
        try:
            task = self._task
            if task is not None and not task.done():
                if self._ws is None:
                    task.cancel()          # still connecting
                else:
                    self._begin_graceful()
        except Exception:  # noqa: BLE001
            pass

    async def wait_closed(self, timeout: float = 1.0) -> None:
        """Teardown-only courtesy: give the supervisor a short, bounded moment to
        finish its graceful close so the job does not exit with a pending task
        and an unclosed client session. Never raises, never cancels it."""
        try:
            task = self._task
            if task is not None and not task.done():
                await asyncio.wait({task}, timeout=timeout)
        except Exception:  # noqa: BLE001
            pass

    # ---- supervisor --------------------------------------------------------

    def _connect_failed(self, exc: BaseException) -> None:
        name = type(exc).__name__
        status = getattr(exc, "status", None)
        if isinstance(exc, asyncio.TimeoutError):
            schema = "timeout"
        elif name in ("WSServerHandshakeError", "ClientResponseError", "InvalidStatus",
                      "InvalidStatusCode"):
            schema = "handshake"
        elif "Connector" in name or name.endswith("ClientError") or isinstance(exc, OSError):
            schema = "connector"
        else:
            schema = "other"
        meta: dict[str, Any] = {"schema": schema}
        if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599:
            meta["http_status"] = status
        self._emit("connect_failed", level="warn", **meta)
        self._mark_death()

    def _log_closed(self, code: Any) -> None:
        if self._close_logged:
            return
        self._close_logged = True
        valid = isinstance(code, int) and not isinstance(code, bool) and 1000 <= code <= 4999
        expected = self._closing and (code is None or code in (1000, 1001))
        session = 0.0
        if self._opened_at is not None:
            session = self._clock() - self._opened_at
        self._emit("socket_closed", level="info" if expected else "warn",
                   schema=f"close_{code}" if valid else "close_unknown",
                   phase="expected" if expected else "unexpected",
                   duration_sec=_r3(session))
        if not expected:
            self._mark_death()

    def _log_closed_after_death(self, code: Any) -> None:
        """The close code after the shadow already died (a fatal error event is
        followed by the server's close, e.g. 4000 = account not enabled). Info
        only, never a second death."""
        if self._close_logged:
            return
        self._close_logged = True
        valid = isinstance(code, int) and not isinstance(code, bool) and 1000 <= code <= 4999
        self._emit("socket_closed", schema=f"close_{code}" if valid else "close_unknown",
                   phase="after_death")

    async def _run(self) -> None:
        ws: Any = None
        subtasks: list[asyncio.Task] = []
        try:
            t0 = self._clock()
            try:
                ws = await asyncio.wait_for(
                    self._factory(self._url, self._headers), self._connect_timeout)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self._connect_failed(exc)
                return
            self._ws = ws
            self._opened_at = self._clock()
            self._emit("socket_open", duration_sec=_r3(self._opened_at - t0))
            loop = asyncio.get_running_loop()
            sender = loop.create_task(self._sender())
            receiver = loop.create_task(self._receiver())
            ticker = loop.create_task(self._ticker())
            subtasks = [sender, receiver, ticker]
            pending: set = set(subtasks)
            while pending:
                done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                if self._dead or receiver in done:
                    break
                if sender in done:
                    if self._closing:      # 'end' sent: wait briefly for session.end
                        await asyncio.wait({receiver}, timeout=self._end_wait)
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            self._fail("close", exc)
        finally:
            # Whatever ended the supervisor, the shadow is finished: offer /
            # observe_main / on_local_vad stop at once (no queue filling, no
            # spurious frames_dropped). unrecovered_death stays for unexpected
            # endings only (_mark_death), so set the flag directly.
            was_dead = self._dead
            self._dead = True
            if self._hard_timer is not None:
                try:
                    self._hard_timer.cancel()
                except Exception:  # noqa: BLE001
                    pass
            for t in subtasks:
                t.cancel()
            if subtasks:
                try:
                    await asyncio.wait(subtasks, timeout=1.0)
                except Exception:  # noqa: BLE001
                    pass
                for t in subtasks:
                    if t.done() and not t.cancelled():
                        try:
                            t.exception()
                        except Exception:  # noqa: BLE001
                            pass
            if ws is not None:
                try:
                    await asyncio.wait_for(ws.close(), self._socket_close)
                except Exception:  # noqa: BLE001
                    pass
                code = getattr(ws, "close_code", None)
                if not was_dead:
                    self._log_closed(code)
                else:
                    self._log_closed_after_death(code)
            self._drain()

    def _drain(self) -> None:
        q = self._queue
        if q is None:
            return
        try:
            while True:
                q.get_nowait()
        except asyncio.QueueEmpty:
            pass

    # ---- sender ------------------------------------------------------------

    async def _send(self, payload: dict) -> None:
        msg = json.dumps(payload)

        async def _go() -> None:
            async with self._lock:  # type: ignore[union-attr]
                await self._ws.send_str(msg)

        try:
            await asyncio.wait_for(_go(), self._send_stall)
        except asyncio.TimeoutError:
            raise _Stall() from None

    def _on_stall(self) -> None:
        self._emit("send_stalled", level="warn", duration_sec=_r3(self._send_stall))
        self._mark_death()

    def _resample(self, frame: Any) -> list[bytes]:
        channels = int(getattr(frame, "num_channels", 1) or 1)
        if channels != 1:
            raise ValueError("channels")
        rate = int(frame.sample_rate)
        out: list[bytes] = []
        if self._in_rate is not None and rate != self._in_rate:
            out.extend(self._flush_resampler())
            self._resampler = None
        self._in_rate = rate
        if rate == self._out_rate and self._resampler_factory is None:
            return out + [bytes(frame.data)]
        if self._resampler is None:
            factory = self._resampler_factory or _default_resampler_factory
            self._resampler = factory(rate, self._out_rate, 1)
        return out + list(self._resampler.push(frame))

    def _flush_resampler(self) -> list[bytes]:
        rs = self._resampler
        flush = getattr(rs, "flush", None) if rs is not None else None
        return list(flush()) if flush is not None else []

    async def _send_pcm(self, final: bool = False) -> None:
        n = self._chunk_bytes
        while len(self._buf) >= n:
            chunk = bytes(self._buf[:n])
            del self._buf[:n]
            await self._send({"event": "audio_input",
                              "audio": base64.b64encode(chunk).decode("ascii")})
            self.counters["chunks_sent"] += 1
            # A backlog (slow connect) is drained without holding the event loop
            # in one stretch: give the call's own tasks a turn between chunks.
            await asyncio.sleep(0)
        if final and self._buf:
            chunk = bytes(self._buf)
            self._buf.clear()
            await self._send({"event": "audio_input",
                              "audio": base64.b64encode(chunk).decode("ascii")})
            self.counters["chunks_sent"] += 1

    async def _sender(self) -> None:
        q = self._queue
        try:
            while True:
                got = await q.get()  # type: ignore[union-attr]
                if got is _SENTINEL:
                    break
                queued_at, item = got
                got = None
                lag_ms = int(max(0.0, self._clock() - queued_at) * 1000)
                if lag_ms > self.counters["queue_lag_max_ms"]:
                    self.counters["queue_lag_max_ms"] = _count(lag_ms)
                for pcm in self._resample(item):
                    self._buf += pcm
                item = None
                await self._send_pcm()
            for pcm in self._flush_resampler():
                self._buf += pcm
            await self._send_pcm(final=True)
            await self._send({"event": "end"})
        except asyncio.CancelledError:
            raise
        except _Stall:
            self._on_stall()
        except ValueError as exc:
            if str(exc) == "channels":
                self._fail("sender", schema="channels")
            else:
                self._fail("sender", exc)
        except Exception as exc:  # noqa: BLE001
            self._fail("sender", exc)

    async def _ticker(self) -> None:
        next_ping = self._clock() + self._ping_sec
        try:
            while True:
                await asyncio.sleep(self._tick_sec)
                now = self._clock()
                self._tracker.tick(now)
                if self._opened_at is not None and now - self._opened_at >= self._max_session:
                    self._begin_graceful()
                    return
                if now >= next_ping:
                    next_ping = now + self._ping_sec
                    await self._send({"event": "ping"})
        except asyncio.CancelledError:
            raise
        except _Stall:
            self._on_stall()
        except Exception as exc:  # noqa: BLE001
            self._fail("sender", exc)

    # ---- receiver ----------------------------------------------------------

    async def _receiver(self) -> None:
        try:
            while True:
                msg = await self._ws.receive()
                kind = msg.type
                if kind == MSG_TEXT:
                    if self._on_text(msg.data):
                        return
                elif kind == MSG_BINARY:
                    self.counters["rt_unparsed"] += 1
                elif kind == MSG_CLOSE:
                    self._log_closed(getattr(self._ws, "close_code", None))
                    return
                elif kind == MSG_ERROR:
                    self._emit("socket_error", level="warn", schema="transport", phase="fatal")
                    self._mark_death()
                    return
                else:
                    self.counters["rt_unparsed"] += 1
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            self._fail("receiver", exc)

    def _on_text(self, data: Any) -> bool:
        """Handle one text message; True means stop receiving."""
        try:
            d = json.loads(data)
        except Exception:  # noqa: BLE001
            self.counters["rt_unparsed"] += 1
            return False
        if not isinstance(d, dict):
            self.counters["rt_unparsed"] += 1
            return False
        ev = d.get("event")
        now = self._clock()
        if ev == "session.begin":
            if not self._begin_logged and self._opened_at is not None:
                self._begin_logged = True
                self._emit("session_begin", duration_sec=_r3(now - self._opened_at))
        elif ev == "vad.speech_start":
            self.counters["rt_vad_starts"] += 1
        elif ev in ("transcript.partial", "transcript.final"):
            text = d.get("text")
            n = len(text.split()) if isinstance(text, str) else 0
            raw_utt = d.get("utterance_idx")
            utt = (raw_utt if isinstance(raw_utt, int) and not isinstance(raw_utt, bool)
                   and 0 <= raw_utt <= 1_000_000 else None)
            text = None  # noqa: F841 - text is dropped right here
            d = None  # type: ignore[assignment]
            if ev == "transcript.partial":
                self.counters["rt_partials"] += 1
                self._tracker.rt_partial(n, now, utt)
            else:
                self.counters["rt_finals"] += 1
                self._tracker.rt_final(n, now, utt)
        elif ev == "session.end":
            billed = _num(d.get("audio_duration_s"))
            if billed is not None:
                self._emit("session_end", duration_sec=_r3(billed))
            else:
                self._emit("session_end")
            if self._closing:
                return True
        elif ev == "error":
            code = d.get("code")
            code_s = str(code) if isinstance(code, (str, int)) and not isinstance(code, bool) else ""
            schema = code_s if _ERR_CODE_RE.match(code_s) else "unknown"
            fatal = d.get("is_fatal") is True
            meta: dict[str, Any] = {"schema": schema, "phase": "fatal" if fatal else "nonfatal"}
            status = d.get("status_code")
            if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599:
                meta["http_status"] = status
            if fatal:
                self._emit("socket_error", level="warn", **meta)
                self._mark_death()
                return True
            self.counters["errors_nonfatal"] += 1
            if self._nonfatal_logged < NONFATAL_LOG_LIMIT:
                self._nonfatal_logged += 1
                self._emit("socket_error", level="warn", **meta)
        elif ev in ("pong", "config.updated", "vad.speech_end"):
            pass
        else:
            self.counters["rt_unparsed"] += 1
        return False


# ── per-call construction ────────────────────────────────────────────────────

def build_call_shadow(
    *,
    armed: Callable[[], bool],
    rng: Callable[[], float] = random.random,
    ws_factory: Optional[Callable[[str, dict], Awaitable[Any]]] = None,
    resampler_factory: Optional[Callable[[int, int, int], Any]] = None,
    clock: Callable[[], float] = time.monotonic,
    logger: Optional[StructuredLogger] = None,
) -> Optional[PhoneSttShadow]:
    """The per-call shadow, or None. None means "off": no class change, no
    socket, no task. ``off`` (the default) writes NO log line."""
    if not phone_stt_shadow_enabled():
        return None
    emit = _Emitter(logger)
    try:
        sample, valid = _sample_parse()
        if not valid:
            emit("disabled", level="warn", schema="sample_invalid")
            return None
        if not rng() < sample:
            emit("sampled_out", duration_sec=_r3(sample))
            return None
        key = (os.getenv("SARVAM_API_KEY") or "").strip()
        if not key:
            emit("disabled", level="warn", schema="no_key")
            return None
        cfg = _config_from_env()
        shadow = PhoneSttShadow(
            cfg, api_key=key, armed=armed, ws_factory=ws_factory,
            resampler_factory=resampler_factory, clock=clock, emitter=emit)
        emit("config", model=cfg.model, schema=cfg.stream_type,
             option_count=cfg.sample_rate, duration_sec=_r3(cfg.vad_threshold),
             turn_index=cfg.silence_ms)
        return shadow
    except Exception:  # noqa: BLE001
        emit("disabled", level="warn", schema="build_failed")
        return None


# ── the stt_node tee ─────────────────────────────────────────────────────────

def wrap_stt_node(base_stt_node: Callable[..., Any], shadow: PhoneSttShadow) -> Callable[..., Any]:
    """An ``Agent.stt_node`` replacement that tees audio frames to ``shadow`` and
    passes the main STT's frames in and events out UNCHANGED (same objects, same
    order, no extra awaits). Installed only when the shadow is on for the call."""

    async def _shadow_stt_node(self: Any, audio: Any, model_settings: Any):
        async def _tapped():
            async for frame in audio:
                try:
                    shadow.offer(frame)
                except Exception:  # noqa: BLE001
                    pass
                yield frame

        node = None
        try:
            node = base_stt_node(self, _tapped(), model_settings)
            if inspect.iscoroutine(node):
                node = await node
            if node is None:
                return
            async for ev in node:
                try:
                    shadow.observe_main(ev)
                except Exception:  # noqa: BLE001
                    pass
                yield ev
        finally:
            # The shadow belongs to the CALL, not to this invocation: the SDK
            # rebuilds its STT pipeline (and calls stt_node again) on every
            # clear_user_turn(), including the gate's pre-consent ones. Closing
            # here would kill the shadow before it ever arms. The call's end is
            # closed by agent.py's teardown (close_nowait) instead.
            aclose = getattr(node, "aclose", None)
            if aclose is not None:
                try:
                    await aclose()
                except Exception:  # noqa: BLE001
                    pass

    def stt_node(self: Any, audio: Any, model_settings: Any):
        return _shadow_stt_node(self, audio, model_settings)

    return stt_node
