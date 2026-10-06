"""In-worker call recording (PR A) — the agent AS the recorder.

Replaces LiveKit Cloud room-composite egress (Build-plan concurrent-egress cap
= 2) with recording performed INSIDE this agent worker, using the built-in
``RecorderIO`` shipped in livekit-agents 1.6.4. RecorderIO taps the SAME
candidate audio the STT already consumes and the bot's OWN TTS output (captured
at the moment it is actually played), mixes both onto one synchronized stereo
timeline (candidate = left, agent = right), resamples, and stream-encodes to
OGG/Opus with constant memory. No second AudioStream, no hand-rolled mixer.

── CONSENT POSTURE: RECORD FROM ANSWER, KEEP EVERY CANDIDATE LEG ──────────
Recording begins at ``call.answered`` so the greeting + consent exchange itself
is captured. Since migration 0105 the recording is KEPT whatever the consent
outcome (declined, revoked, deferred and pre-consent legs are retained and
flagged server-side). The ONLY discard is the wrong-number / wrong-person
privacy path — a third party's voice — where the caller invokes
:meth:`discard` instead of :meth:`finish`, so the local file is deleted and
NOTHING is uploaded (there is therefore no object for a server-side purge to
race against).

── TAIL FLUSH (M013 S02) ────────────────────────────────────────────────────
RecorderIO 1.6.4 writes a bot utterance only when its playback finishes, and
holds back the candidate audio while bot audio is pending. A leg that ends
mid-utterance therefore lost that utterance and everything after it (live
session 9f60523d: leg 1 lost its last ~7 s, including Q1). The default factory
now returns :class:`_FlushingRecorderIO`, which writes the PLAYED part of the
pending utterance plus the held-back candidate audio before the recorder's end
sentinels. The cut-off is the leg end (the SIP participant leaving), not the
session close, so bot audio the candidate never heard is not written. Kill
switch: ``PHONE_RECORDING_TAIL_FLUSH=off`` restores the plain RecorderIO.

The taps are wired immediately AFTER ``session.start()`` (which is when RoomIO
attaches the live ``session.input.audio`` / ``session.output.audio`` the taps must
wrap — before start they are ``None``), and :meth:`begin` starts recording at
answer; ``RecorderAudioInput`` only accumulates while ``RecorderIO.recording`` is
True (verified against the 1.6.4 wheel), so begin/discard cleanly bound the
captured window. Reassigning the streams once, right after start, is a supported
operation (the ``AgentInput``/``AgentOutput`` ``.audio`` setters fire
on_attached/on_detached + ``_audio_changed``, re-wiring the running session).

── FAIL-OPEN ───────────────────────────────────────────────────────────────
Recording is strictly secondary to the screening happening. Every step here is
guarded: a RecorderIO/transcode/upload failure is logged and swallowed, never
raised into the call path. The API consent gate already guarantees no audio is
retained without a binding, so degrading to "no recording" is the safe
direction.

── OUTPUT CONTRACT ─────────────────────────────────────────────────────────
The downstream finalizer/download/integrity pipeline expects an **MP3** at the
attempt-scoped object key. RecorderIO emits OGG/Opus, so :meth:`finish`
transcodes OGG→MP3 once at call end (off the hot path) and PUTs the MP3 to the
presigned URL the API minted. It returns a manifest (sha256, size, duration_ms)
for the API to persist and finalize. Since M013 S02 the manifest also carries
the leg timing (recording anchor, leg end, whether the tail was flushed), and
``duration_ms`` is the true audio length rather than a wall-clock span.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger("voice-livekit.recording")

# ── LOG VISIBILITY (live 2026-09-03): this logger relied on propagating to a
# root handler the worker never explicitly configures, and NO recording
# lifecycle line (started / uploaded / finish_failed) ever reached `fly logs` —
# a silently-lost upload was indistinguishable from a silent success, and the
# finalizer retried a key that was never PUT until exhaustion. A dedicated
# stdout handler guarantees emission regardless of the framework's root logging
# config; propagation is disabled so a configured root cannot double-print.
if not logger.handlers:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

# 48 kHz stereo matches RecorderIO's default mixing rate.
_SAMPLE_RATE = 48_000
_MP3_BITRATE_BPS = 64_000

# ── FIX 4 (2026-09-06): AUDIO-PATH HEALTH HEARTBEAT ───────────────────────────
# Live call ac7c8c77 lost OUTBOUND audio to the SIP leg at ~12:57:25 — the worker
# kept generating and speaking into the recorder while the candidate heard 51s of
# silence — and NOTHING surfaced it until the candidate hung up. The taps already
# count every input/output frame (the zero-capture instrumentation); this
# heartbeat turns those counters into a periodic, content-free health signal so a
# starved audio path is visible in `fly logs` DURING the call, not only in the
# post-mortem. Interval and the stall threshold are env-tunable but default sane.
def _float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw in (None, ""):
        return default
    try:
        return float(raw)
    except ValueError:
        return default


PHONE_AUDIO_HEALTH_INTERVAL_SEC = _float_env("PHONE_AUDIO_HEALTH_INTERVAL_SEC", 15.0)
# WARN `no_input_audio` once the INPUT tap has gone this long with zero new
# frames while recording is active — the candidate leg has stopped delivering
# audio (drop / mute), the inbound half of what the live incident showed.
PHONE_AUDIO_NO_INPUT_WARN_SEC = _float_env("PHONE_AUDIO_NO_INPUT_WARN_SEC", 20.0)

# The transcode COMPLETENESS FLOOR (adversarial-review MED, v114 2026-09-04).
# Per-frame skip tolerance makes the encode robust to a handful of malformed
# boundary frames at a channel desync — but if a desync corrupts MOST frames,
# tolerating them yields a non-empty yet severely TRUNCATED MP3 that would pass
# the `if not mp3_body` check, upload as a clean `audio/mpeg`, and let
# _cleanup() delete the intact OGG — silently substituting partial audio for the
# full raw recording the OGG fallback would have preserved. Partial-as-success
# is worse than the fallback it skips. So the transcode FAILS (raises → OGG
# fallback) when more than this fraction of decoded frames was skipped. A couple
# of boundary frames out of hundreds is fine; losing a large slice is not.
_TRANSCODE_MAX_SKIPPED_FRACTION = 0.02  # allow up to 2% skipped, fail beyond

# RecorderIO.aclose() waits for its encoder thread and may be the thing that
# wedges a worker during shutdown.  This is deliberately a small local bound:
# the caller owns the larger evidence-teardown budget and must still have time
# to PUT an already-flushed OGG and report its manifest.
RECORDER_CLOSE_TIMEOUT_SEC = 3.0


def _consume_cancelled_task(task: asyncio.Task[Any]) -> None:
    """Retrieve a detached close exception without awaiting its acknowledgement."""
    try:
        task.result()
    except BaseException:
        pass


def recording_provider() -> str:
    """'worker' only when explicitly selected; anything else is 'egress'."""
    return "worker" if os.getenv("RECORDING_PROVIDER") == "worker" else "egress"


@dataclass(frozen=True)
class RecordingManifest:
    """What the worker reports back to the API after a successful upload.

    ``content_type`` distinguishes a clean MP3 upload (``audio/mpeg``) from the
    v114 raw-OGG FALLBACK (``audio/ogg``) that survives a transcode failure. It
    is advisory to the worker's own logging — the server sniffs the object's
    real container bytes at finalize time — but carrying it here keeps the
    worker's report honest and lets a caller tell the two apart without a
    re-download.

    M013 S02 (T02) — truthful timing, reported as data only:
      * ``duration_ms`` is the TRUE audio length (samples encoded / rate, or the
        OGG container's own length on the fallback), never a wall-clock span.
        ``None`` when unknown or not positive: the API schema is
        ``.int().positive()``, so a 0 would 400 the completion.
      * ``recording_started_at_ms`` — epoch ms of the file's t = 0, never
        earlier than the moment :meth:`InWorkerRecorder.begin` ran.
      * ``leg_ended_at_ms`` — epoch ms of the earliest leg-end mark.
      * ``tail_flushed`` — True only when the tail flush actually ran and the
        recorder closed cleanly (the flush is fail-open, so the API must not
        infer it)."""

    sha256: str
    size_bytes: int
    duration_ms: Optional[int]
    content_type: str = "audio/mpeg"
    recording_started_at_ms: Optional[int] = None
    leg_ended_at_ms: Optional[int] = None
    tail_flushed: Optional[bool] = None

    def timing_kwargs(self) -> dict[str, Any]:
        """The keyword arguments :func:`recording_api.complete_recording`
        takes for the leg timing (``None`` values are omitted from the body
        there, so an unknown value is simply not sent)."""
        return {
            "recording_started_at_ms": self.recording_started_at_ms,
            "leg_ended_at_ms": self.leg_ended_at_ms,
            "tail_flushed": self.tail_flushed,
        }


def manifest_timing_kwargs(manifest: Any) -> dict[str, Any]:
    """``manifest.timing_kwargs()`` when the manifest has it, else ``{}``.

    The agent's completion call sites use this so a manifest that is not a
    :class:`RecordingManifest` (a test double, or an older shape) still posts
    the legacy body instead of raising inside the teardown. Never raises."""
    try:
        fn = getattr(manifest, "timing_kwargs", None)
        if callable(fn):
            out = fn()
            if isinstance(out, dict):
                return out
    except Exception:  # noqa: BLE001 — the completion itself matters more
        pass
    return {}


def _positive_ms(value: Any) -> Optional[int]:
    """An int > 0, else ``None`` (bools and non-numbers are ``None``)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        ms = int(round(value))
    except (OverflowError, ValueError):
        return None
    return ms if ms > 0 else None


# Injected seams (real defaults below) so the lifecycle is unit-testable with no
# livekit/PyAV/ffmpeg/network present.
RecorderFactory = Callable[[Any, int], Any]
# (ogg_path, mp3_path) -> the ENCODED audio length in ms (samples fed to the
# MP3 encoder / its rate), or None when the transcoder cannot tell. A value
# that is not a positive int is treated as unknown (M013 S02 T02).
TranscodeFn = Callable[[Path, Path], Awaitable[Optional[int]]]
# (upload_url, body, content_type) — content_type is "audio/mpeg" for the normal
# MP3 and "audio/ogg" for the v114 raw-OGG fallback, so the PUT declares the
# real Content-Type of whichever body survived.
UploadFn = Callable[[str, bytes, str], Awaitable[None]]


def _default_recorder_factory(session: Any, sample_rate: int) -> Any:
    """Construct the real RecorderIO. Imported lazily so this module (and its
    unit tests) load without livekit-agents installed.

    M013 S02: returns the tail-flushing subclass unless the kill switch
    ``PHONE_RECORDING_TAIL_FLUSH=off`` is set. Building the subclass is itself
    fail-open: any failure falls back to the plain RecorderIO."""
    from livekit.agents.voice.recorder_io import RecorderIO  # noqa: PLC0415

    if not tail_flush_enabled():
        logger.info("in_worker_recording_tail_flush_disabled")
        return RecorderIO(agent_session=session, sample_rate=sample_rate)
    try:
        cls = _real_flushing_recorder_cls()
    except Exception as exc:  # noqa: BLE001 — fail-open to the plain recorder
        logger.warning(
            "in_worker_recording_tail_flush_skipped category=%s",
            f"build_{type(exc).__name__}",
        )
        return RecorderIO(agent_session=session, sample_rate=sample_rate)
    return cls(agent_session=session, sample_rate=sample_rate)


# ── TAIL FLUSH (M013 S02-1) ──────────────────────────────────────────────────
# The SDK version the flush was verified against (recorder_io.py internals:
# `_in_record`, `_out_record`, `_in_q`/`_out_q`, `_write_cb`, the name-mangled
# `__acc_frames` lists and `_split_frame`). Another version still TRIES the
# flush — it is fail-open — but logs a warning so a silent drift is visible.
_TAIL_FLUSH_SDK_VERSION = "1.6.4"


def tail_flush_enabled() -> bool:
    """Kill switch. Default ON; ``PHONE_RECORDING_TAIL_FLUSH=off`` (or
    false/0/no/disabled) returns the plain RecorderIO, byte-identical to the
    pre-S02 behaviour."""
    raw = (os.getenv("PHONE_RECORDING_TAIL_FLUSH") or "").strip().lower()
    return raw not in ("off", "false", "0", "no", "disabled")


_FLUSHING_CLS_CACHE: dict[Any, type] = {}


def _real_flushing_recorder_cls() -> type:
    from livekit.agents.voice.recorder_io import recorder_io as _rio  # noqa: PLC0415

    try:
        from livekit.agents import __version__ as sdk_version  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        sdk_version = "unknown"
    if sdk_version != _TAIL_FLUSH_SDK_VERSION:
        logger.warning(
            "in_worker_recording_tail_flush_sdk_unverified version=%s verified=%s",
            sdk_version, _TAIL_FLUSH_SDK_VERSION,
        )
    return build_flushing_recorder_cls(_rio.RecorderIO, _rio._split_frame)


def build_flushing_recorder_cls(base: type, split_frame: Callable[[Any, float], Any]) -> type:
    """Return ``_FlushingRecorderIO``, a subclass of ``base`` (the SDK's
    RecorderIO in production; a structural fake in the bare-python tests).

    ``split_frame(frame, position) -> (head, tail)`` is the SDK's
    ``_split_frame``. Cached per base class."""
    key = (base, split_frame)
    cached = _FLUSHING_CLS_CACHE.get(key)
    if cached is not None:
        return cached

    class _FlushingRecorderIO(base):  # type: ignore[misc, valid-type]
        """RecorderIO that writes the recording TAIL on close.

        WHY: RecorderIO 1.6.4 writes a bot utterance only from
        ``on_playback_finished`` and, while bot audio is pending, also holds
        back the candidate audio its ``_forward_task`` would otherwise flush
        every 2.5 s. Closed mid-utterance, the stock recorder drops that
        utterance AND the held-back candidate audio.

        ``flush_tail(until)`` (synchronous, loop thread) writes, before the
        end sentinels ``aclose`` enqueues:
          * pending bot audio: only the PLAYED part, i.e.
            ``min(sum(frame.duration), until - _last_speech_start_time)``
            (clamped at 0), split with the SDK ``_split_frame`` and passed to
            ``_write_cb``, which also takes the held-back input buffer — so
            both channels land in ONE FIFO pair and stay aligned. A position
            that clamps to 0 (the utterance began after the leg end) writes
            ``_write_cb([])`` so the input is still flushed. The output
            accumulator is then cleared, so a later ``on_playback_finished``
            writes nothing twice. The AudioOutput base ``on_playback_finished``
            (segment counting) is NEVER called here.
          * no pending bot audio: the input-only write ``_forward_task``
            would have made.
        Pause intervals (``__pause_wall_times``) are IGNORED by the flush;
        acceptable for a tail of at most one utterance.

        ``mark_leg_end(ts)`` (earliest wins) records the cut-off and CLOSES
        capture: ``recording`` reads False from then on, so neither tap
        accumulates audio after the leg ended and an ``on_playback_finished``
        fired by the session's own close (its ``interrupt``) cannot write bot
        audio the candidate never heard. ``reopen_capture()`` undoes a mark
        when the SIP participant is seen again (a spurious departure).

        Fail-open: any exception skips the flush (logged
        ``in_worker_recording_tail_flush_skipped``) and the normal close
        proceeds, so the recording is still written and uploaded."""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self._s02_leg_end: Optional[float] = None
            self._s02_capture_closed = False
            self._s02_skip_flush = False
            self.tail_flushed = False
            self.tail_flush_result: Optional[dict] = None

        @property
        def recording(self) -> bool:  # type: ignore[override]
            return bool(self._started) and not self._s02_capture_closed

        @property
        def leg_end(self) -> Optional[float]:
            return self._s02_leg_end

        def mark_leg_end(self, ts: float) -> None:
            if self._s02_leg_end is None or ts < self._s02_leg_end:
                self._s02_leg_end = ts
            self._s02_capture_closed = True

        def reopen_capture(self) -> None:
            self._s02_leg_end = None
            self._s02_capture_closed = False

        def skip_tail_flush(self) -> None:
            """The wrong-number discard path: the audio is about to be
            deleted, so spend no encode time on it."""
            self._s02_skip_flush = True

        def flush_tail(self, until: Optional[float] = None) -> dict:
            """Write the played part of any pending bot utterance plus the
            held-back candidate audio. Returns ``{out_ms, in_ms}`` (counts
            only). A no-op when begin never ran or the flush is skipped."""
            if not self._started or self._s02_skip_flush:
                return {"out_ms": 0, "in_ms": 0}
            out = self._out_record
            inp = self._in_record
            if out is None or inp is None:
                return {"out_ms": 0, "in_ms": 0}
            cut = until if until is not None else time.time()
            pending = list(out._RecorderAudioOutput__acc_frames)
            held_in = getattr(inp, "_RecorderAudioInput__acc_frames", None) or []
            in_ms = int(round(sum(f.duration for f in held_in) * 1000))
            if not pending:
                # Mirror `_forward_task`: input only, paired with an empty
                # output chunk so the two FIFOs stay in lock-step.
                input_buf = inp.take_buf(pad_since=out._last_speech_end_time)
                self._in_q.put_nowait(input_buf)
                self._out_q.put_nowait([])
                return {"out_ms": 0, "in_ms": in_ms}

            total = sum(f.duration for f in pending)
            started = out._last_speech_start_time
            played = total if started is None else min(total, cut - started)
            played = max(0.0, played)
            buf: list[Any] = []
            acc = 0.0
            if played > 0.0:
                for frame in pending:
                    if acc + frame.duration > played:
                        head, _tail = split_frame(frame, played - acc)
                        if head.duration > 0.0:
                            buf.append(head)
                            acc += head.duration
                        break
                    buf.append(frame)
                    acc += frame.duration
            # `_write_cb` takes the held-back INPUT buffer too (padded from the
            # last speech end, exactly as the SDK's own playback write does).
            self._write_cb(buf)
            out._RecorderAudioOutput__acc_frames = []
            out._last_speech_end_time = cut
            out._last_speech_start_time = None
            return {"out_ms": int(round(acc * 1000)), "in_ms": in_ms}

        async def aclose(self) -> None:
            if self._started and not self._s02_skip_flush:
                try:
                    result = self.flush_tail(self._s02_leg_end)
                    self.tail_flushed = True
                    self.tail_flush_result = result
                    logger.info(
                        "in_worker_recording_tail_flush out_ms=%d in_ms=%d",
                        result["out_ms"], result["in_ms"],
                    )
                except Exception as exc:  # noqa: BLE001 — fail-open by contract
                    logger.warning(
                        "in_worker_recording_tail_flush_skipped category=%s",
                        type(exc).__name__,
                    )
            await super().aclose()

    _FLUSHING_CLS_CACHE[key] = _FlushingRecorderIO
    return _FlushingRecorderIO


async def _default_transcode(ogg_path: Path, mp3_path: Path) -> Optional[int]:
    """One-shot OGG→MP3 transcode, off the hot path, IN-PROCESS via PyAV.

    Returns the ENCODED audio length in ms: every sample handed to the MP3
    encoder (the FIFO chunks plus the final short frame) divided by the output
    rate. That is the true length of the recording (M013 S02 T02 — the old
    wall-clock "duration" counted from the recorder's start to the upload).
    ``None`` when nothing was counted.

    Deliberately NOT an ``ffmpeg`` subprocess: the worker image is
    ``python:3.12-slim`` with no ffmpeg BINARY, so shelling out silently failed
    and dropped the recording. PyAV (``av``) is already a guaranteed worker
    dependency — RecorderIO itself encodes the OGG with it — and its wheel
    bundles ``libmp3lame``, so the MP3 encode needs no extra binary or image
    change. Runs in a thread so the encode never blocks the event loop.

    ── WHY IT IS HARDENED (live v114/v115, 2026-09-04) ─────────────────────
    A real call lost its recording to ``transcode_failed`` preceded by the
    swresample warning "Input is shorter by 46394 samples; silence has been
    prepended to align". The two mixed channels (candidate=left, bot=right)
    finished with mismatched sample counts, so the OGG's decoded frames arrive
    with VARYING sample counts (and a short/one-sided tail).

    The v114 fix added an ``av.AudioResampler`` — that coerces every frame to
    the encoder's rate/layout/format, but it does NOT chunk frames to the MP3
    encoder's fixed input size. ``libmp3lame`` requires exactly ``frame_size``
    (1152) samples per input frame: fed a shorter/longer frame it errors, so the
    per-frame ``except`` SKIPPED it — and on a desynced call that is MOST frames,
    tripping the completeness floor (``transcode_truncated_below_floor``) and
    dropping to the OGG fallback on a call whose audio was entirely recoverable.
    That is why v115 STILL failed the transcode with the resampler in place.

    The robust idiom (PyAV canonical, confirmed against the docs) is
    ``AudioResampler`` → ``AudioFifo`` → fixed-size ``read(frame_size)`` →
    encode:

      1. The resampler coerces rate/layout/packed format so a short/mono/desynced
         frame is normalized rather than tripping the encoder.
      2. An ``AudioFifo`` accumulates the resampled samples and hands the encoder
         ONLY full ``frame_size`` chunks (plus one final short frame at flush),
         so NO frame is ever the wrong size and NO audio is dropped for being an
         odd length. The desync is absorbed into the sample timeline, not skipped.
      3. The encoder tail is always flushed and the caller verifies a non-empty
         MP3. The completeness floor still fails a transcode that genuinely could
         not decode its input (so a truly-corrupt OGG still drops to the fallback
         that preserves the raw bytes), but a normal desynced call now yields a
         complete MP3 with zero skipped frames.
    """
    def _run() -> Optional[int]:
        import av  # noqa: PLC0415
        from av.audio.fifo import AudioFifo  # noqa: PLC0415
        from av.audio.resampler import AudioResampler  # noqa: PLC0415

        in_container = av.open(str(ogg_path))
        out_container = av.open(str(mp3_path), mode="w")
        decoded_frames = 0
        encoded_frames = 0
        skipped_frames = 0
        # M013 S02 T02: samples actually handed to the MP3 encoder — the
        # recording's TRUE length once divided by the output rate.
        encoded_samples = 0
        out_rate = _SAMPLE_RATE
        try:
            in_stream = in_container.streams.audio[0]
            out_rate = in_stream.rate or _SAMPLE_RATE
            out_stream = out_container.add_stream("libmp3lame", rate=out_rate)
            out_stream.bit_rate = _MP3_BITRATE_BPS
            # Handle the mono-vs-stereo mismatch EXPLICITLY. The candidate|bot mix
            # is stereo, but a degenerate/one-sided capture can be mono; pick the
            # decoder's channel count and pin the encoder layout to match, so the
            # resampler below has a definite target rather than an inferred one.
            try:
                in_channels = len(in_stream.layout.channels)
            except Exception:  # noqa: BLE001 — layout may be absent on odd inputs
                in_channels = 2
            out_layout = "stereo" if in_channels >= 2 else "mono"
            try:
                out_stream.layout = out_layout
            except Exception:  # noqa: BLE001 — some builds infer layout from frames
                pass

            # The desync-tolerant normalizer: coerce EVERY frame to the encoder's
            # exact rate/layout/format (packed s16 the FIFO + libmp3lame accept).
            #
            # ── WHY IT IS REBUILT ON MISMATCH (the TRUE v114/v115 root cause) ──
            # ``av.AudioResampler`` LOCKS to the layout/format/rate of the FIRST
            # frame it sees and raises ``ValueError: Frame does not match
            # AudioResampler setup`` on any LATER frame whose input layout differs.
            # A channel-desynced mix ends with a short/one-sided (mono) tail
            # frame, so mid-stream the resampler hit exactly that and threw — the
            # per-frame ``except`` then skipped a whole run of tail frames and the
            # completeness floor tripped (``transcode_truncated_below_floor`` →
            # OGG fallback) on a call whose audio was fully recoverable. The
            # OUTPUT target is fixed; only the INPUT shape varies. So on a
            # mismatch we REBUILD the resampler (fresh input lock) and retry the
            # SAME frame once, rather than dropping it. This is the piece the v114
            # resampler-only fix and the FIFO alone both lacked.
            resampler = AudioResampler(format="s16", layout=out_layout, rate=out_rate)
            # The chunker: accumulate resampled samples and pull encoder-sized
            # frames — libmp3lame needs frame_size-sized input frames, so the FIFO
            # absorbs the varying decoded-frame lengths without dropping audio.
            fifo = AudioFifo()
            # MP3 fixed frame size; fall back to the MPEG-1 Layer III constant if
            # the encoder has not exposed it yet (it may be 0 before first use).
            frame_size = getattr(out_stream, "frame_size", 0) or 1152

            def _new_resampler() -> Any:
                return AudioResampler(format="s16", layout=out_layout, rate=out_rate)

            def _drain_fifo(*, final: bool) -> None:
                # Pull full frame_size chunks out of the FIFO and encode each.
                # When NOT finalizing, stop once fewer than frame_size samples
                # remain (they wait for more input). When finalizing, first drain
                # every full frame_size chunk (BUG 4: after the resampler's tail
                # is flushed in the FIFO occupancy can exceed frame_size, and a
                # single oversized read is rejected by libmp3lame and silently
                # dropped), THEN encode the final short remainder as the one
                # legitimately-undersized last frame. `fifo.read` returns None
                # when fewer than the requested samples remain.
                nonlocal encoded_samples
                while fifo.samples >= frame_size:
                    chunk = fifo.read(frame_size)
                    if chunk is None:
                        break
                    chunk.pts = None
                    for packet in out_stream.encode(chunk):
                        out_container.mux(packet)
                    encoded_samples += chunk.samples
                if final:
                    # The true last frame: everything still buffered (< frame_size).
                    tail = fifo.read()
                    if tail is not None:
                        tail.pts = None
                        for packet in out_stream.encode(tail):
                            out_container.mux(packet)
                        encoded_samples += tail.samples

            for frame in in_container.decode(in_stream):
                decoded_frames += 1
                try:
                    frame.pts = None
                    try:
                        resampled = resampler.resample(frame)
                    except ValueError:
                        # The input layout/format changed under the resampler (the
                        # desync tail). Before discarding the OLD resampler, FLUSH
                        # its buffered conversion state into the FIFO (BUG 3:
                        # dereferencing it without a `resample(None)` silently
                        # loses whatever samples it had buffered — audio the floor
                        # would never see, because the frame is neither encoded
                        # short nor skip-counted). Then rebuild for the NEW input
                        # shape and retry the SAME frame — never drop it. If the
                        # retry still fails, the outer except counts it as one
                        # skipped frame.
                        try:
                            for old_frame in resampler.resample(None):
                                old_frame.pts = None
                                fifo.write(old_frame)
                        except Exception:  # noqa: BLE001 — a flush hiccup is not fatal
                            pass
                        resampler = _new_resampler()
                        resampled = resampler.resample(frame)
                    # resample() returns a LIST of frames (it may split/merge).
                    # Feed each into the FIFO; the FIFO owns the chunking so the
                    # encoder only ever sees frame_size-sized input.
                    for r_frame in resampled:
                        r_frame.pts = None
                        fifo.write(r_frame)
                    _drain_fifo(final=False)
                    encoded_frames += 1
                except Exception:  # noqa: BLE001 — skip ONE bad frame, not the file
                    skipped_frames += 1
                    continue
            # Drain the resampler's own tail into the FIFO, then flush the FIFO
            # (including the final short frame) and the encoder. Each stage is
            # wrapped so a tail hiccup cannot lose the frames already muxed.
            try:
                for r_frame in resampler.resample(None):
                    r_frame.pts = None
                    fifo.write(r_frame)
            except Exception:  # noqa: BLE001
                pass
            try:
                _drain_fifo(final=True)
            except Exception:  # noqa: BLE001
                pass
            try:
                for packet in out_stream.encode(None):  # flush the encoder tail
                    out_container.mux(packet)
            except Exception:  # noqa: BLE001
                pass
        finally:
            in_container.close()
            out_container.close()

        if skipped_frames:
            logger.warning(
                "in_worker_recording_transcode_skipped_frames "
                "skipped=%d encoded=%d decoded=%d",
                skipped_frames, encoded_frames, decoded_frames,
            )
        # A transcode that encoded NO audio is a real failure — drop to the OGG
        # fallback (finish() will retain the raw OGG).
        if encoded_frames == 0:
            raise RuntimeError("transcode_produced_no_audio")
        # THE COMPLETENESS FLOOR (adversarial-review MED, v114 2026-09-04).
        # A few skipped boundary frames are fine, but if a desync corrupted a
        # large FRACTION of the stream the resulting MP3 is truncated audio, and
        # keeping it would silently substitute a partial recording for the full
        # one — and delete the intact OGG that still holds all of it. So fail the
        # transcode when the skipped fraction exceeds the floor, forcing the OGG
        # fallback that preserves the COMPLETE raw audio.
        #
        # After the FIFO fix a normal desynced call skips ZERO frames (the
        # desync is absorbed into the sample timeline, not dropped), so this
        # floor now only trips on a genuinely-undecodable input — exactly the
        # case where the raw-OGG fallback is the right answer.
        if decoded_frames > 0:
            skipped_fraction = skipped_frames / decoded_frames
            if skipped_fraction > _TRANSCODE_MAX_SKIPPED_FRACTION:
                logger.warning(
                    "in_worker_recording_transcode_truncated "
                    "skipped=%d decoded=%d fraction=%.3f floor=%.3f",
                    skipped_frames, decoded_frames, skipped_fraction,
                    _TRANSCODE_MAX_SKIPPED_FRACTION,
                )
                raise RuntimeError("transcode_truncated_below_floor")
        if encoded_samples <= 0 or not out_rate:
            return None
        return _positive_ms(encoded_samples * 1000.0 / out_rate)

    return await asyncio.to_thread(_run)


def _ogg_duration_ms(ogg_path: Optional[Path]) -> Optional[int]:
    """The OGG container's own audio length in ms, read with PyAV by demuxing
    packets (no decode, so it is cheap even for a long call). Used for the
    raw-OGG manifests, where no MP3 encode counted the samples.

    Sums the packet durations (the Opus demuxer gives each packet its real
    duration, and the end trim lives in the last packet's duration); falls
    back to the container's own duration when the packets carry none.
    ``None`` when PyAV is absent, the file is unreadable or the length is not
    positive. Never raises."""
    if ogg_path is None:
        return None
    try:
        import av  # noqa: PLC0415

        container = av.open(str(ogg_path))
        try:
            stream = container.streams.audio[0]
            time_base = stream.time_base
            total = 0
            for packet in container.demux(stream):
                if packet.duration:
                    total += int(packet.duration)
            if total > 0 and time_base is not None:
                return _positive_ms(float(total * time_base) * 1000.0)
            if container.duration:
                # Container duration is in AV_TIME_BASE (microseconds).
                return _positive_ms(container.duration / 1000.0)
            return None
        finally:
            container.close()
    except Exception:  # noqa: BLE001 — a missing duration is acceptable
        return None


async def _default_upload(
    upload_url: str, body: bytes, content_type: str = "audio/mpeg",
) -> None:
    """PUT the recording bytes to the presigned URL the API minted. Lazy httpx
    import. ``content_type`` is ``audio/mpeg`` for the normal MP3 and
    ``audio/ogg`` for the v114 raw-OGG fallback, so the declared Content-Type
    matches the bytes actually sent (the finalizer still sniffs the object's
    container bytes and does not trust this header).

    ── v115 (2026-09-04): ``x-upsert: true`` ────────────────────────────────
    The API now mints the signed upload URL with ``upsert:true`` so a retry or
    the OGG fallback can OVERWRITE the key instead of colliding 409 with an
    earlier insert. Supabase's own ``uploadToSignedUrl`` sends this header on the
    PUT; the raw PUT here mirrors it so the write mode the token was minted for
    is actually exercised. The object PATH is signed into the token — this header
    only selects insert-vs-upsert, it cannot retarget the write."""
    import httpx  # noqa: PLC0415

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        resp = await client.put(
            upload_url,
            content=body,
            headers={"Content-Type": content_type, "x-upsert": "true"},
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"upload_failed_status_{resp.status_code}")


# ── ZERO-CAPTURE INSTRUMENTATION (RCA 2026-09-04, v114/v115/v116) ────────────
# EVERY live phone call lost its recording to `transcode_failed`, whose REAL
# exception was `FileNotFoundError: …-egress.mp3.ogg` — i.e. the OGG was NEVER
# written. Confirmed against PyAV 18.1.0 (the worker's pinned wheel):
# `av.open(path, "w", format="ogg")` DEFERS on-disk creation to the first muxed
# packet, so a RecorderIO encode thread that muxes ZERO packets leaves no file.
# The encode thread muxes only what the input/output taps accumulate, and the
# taps accumulate only while `RecorderIO.recording` is True — so a missing OGG
# means ZERO frames reached the encoder. The v116 log proved wire OK +
# `in_worker_recording_started` fired + clean `aclose` yet still no OGG, so the
# capture never engaged even though the flag flipped. The SDK 1.6.4 source shows
# reassigning `session.input.audio`/`output.audio` AFTER `session.start()` IS a
# supported reroute (the input `audio.setter` fires `_on_audio_input_changed`,
# which cancels + restarts `_forward_audio_task` on the new tap; the output
# reference is read fresh per speech turn) — so the wiring is mechanically
# correct and the live failure cannot be diagnosed further from the INFO logs
# alone. These two proxies wrap the RecorderIO taps to COUNT the frames each
# side actually sees, so the next test call's log states — deterministically —
# whether capture engaged (input_frames/output_frames > 0) and, if not, which
# side is starved. They are pure pass-through: they never alter, drop, reorder,
# or delay a frame, and hold no audio (a running COUNT only, PII-free).
#
# CONSENT NOTE: counting is NOT capture. A proxy increments an integer and
# immediately forwards the frame; it retains nothing. RETENTION still happens
# only inside the underlying tap, and only while `RecorderIO.recording` is True
# (flipped True by begin() at the consent seam) — so the input count is
# legitimately non-zero DURING the pre-consent exchange (the recognition loop is
# pulling candidate audio to run the consent classifier), yet NO audio of that
# window is ever kept. The count is a diagnostic number, not a recording.
class _CountingAudioInput:
    """Transparent async-iterator proxy over the RecorderIO input tap that counts
    every frame the recognition loop pulls THROUGH the tap. Pass-through only —
    it forwards `__anext__` verbatim and mirrors every other attribute onto the
    wrapped tap, so the SDK sees the exact object it expects."""

    def __init__(self, inner: Any, counter: "_FrameCounter") -> None:
        self.__inner = inner
        self.__counter = counter

    def __aiter__(self) -> Any:
        # RecorderAudioInput.__aiter__ returns self; keep our proxy as the iterator
        # so __anext__ (and the count) stays on the pulled path.
        self.__inner.__aiter__()
        return self

    async def __anext__(self) -> Any:
        frame = await self.__inner.__anext__()
        self.__counter.input += 1
        # M013 S02: wall clock of the latest input frame — logged next to the
        # leg end as a cross-check only (a time, never audio).
        self.__counter.last_input_at = time.time()
        return frame

    def __getattr__(self, name: str) -> Any:
        # Everything else (on_attached/on_detached/source/label/…) delegates to
        # the real tap so re-wiring behaves identically to the un-proxied tap.
        return getattr(self.__inner, name)


class _CountingAudioOutput:
    """Transparent proxy over the RecorderIO output tap that counts every TTS
    frame the session PUSHES into the tap via `capture_frame`. Pass-through only:
    `capture_frame` forwards verbatim (so playback + the tap's own accumulation
    are untouched) and every other attribute/method mirrors onto the real tap."""

    def __init__(self, inner: Any, counter: "_FrameCounter") -> None:
        self.__inner = inner
        self.__counter = counter

    async def capture_frame(self, frame: Any) -> None:
        await self.__inner.capture_frame(frame)
        self.__counter.output += 1

    def __getattr__(self, name: str) -> Any:
        return getattr(self.__inner, name)


class _FrameCounter:
    """A tiny mutable counter shared by the two proxies. Booleans/ints only —
    never touches audio bytes."""

    __slots__ = ("input", "output", "last_input_at")

    def __init__(self) -> None:
        self.input = 0
        self.output = 0
        self.last_input_at: Optional[float] = None


class InWorkerRecorder:
    """Owns the RecorderIO lifecycle for exactly one phone call."""

    def __init__(
        self,
        session: Any,
        *,
        sample_rate: int = _SAMPLE_RATE,
        work_dir: Optional[Path] = None,
        recorder_factory: RecorderFactory = _default_recorder_factory,
        transcode_fn: TranscodeFn = _default_transcode,
        upload_fn: UploadFn = _default_upload,
        room: Any = None,
        sip_identity: Optional[str] = None,
    ) -> None:
        self._session = session
        # object_key + upload_url arrive from the API /recording/prepare call at
        # the consent-permitted moment — NOT at construction — because prepare
        # runs the consent gate and only then mints them.
        self._object_key: Optional[str] = None
        self._sample_rate = sample_rate
        self._work_dir = work_dir
        self._recorder_factory = recorder_factory
        self._transcode_fn = transcode_fn
        self._upload_fn = upload_fn

        # A STRONG reference is retained for the whole call — an early community
        # failure mode was the encode task being garbage-collected mid-call.
        self._recorder: Any = None
        self._ogg_path: Optional[Path] = None
        self._wired = False
        self._begun = False
        self._failed = False
        self._finish_failure: Optional[str] = None

        # ZERO-CAPTURE INSTRUMENTATION (RCA 2026-09-04). Frame counts the taps
        # actually saw + a lifecycle-order/timing trail, so the next test call's
        # log proves whether capture engaged and, if not, which side starved.
        # Counts/booleans/millis only — never audio.
        self._counter = _FrameCounter()
        self._wired_at_ms: Optional[int] = None
        self._begun_at_ms: Optional[int] = None
        # M013 S02 T02: epoch seconds stamped just BEFORE the recorder's
        # start() — the floor for the reported recording anchor.
        self._begin_called_at: Optional[float] = None
        # FIX 4: the call.answered wall-clock (epoch ms), passed to begin() so the
        # recording START offset vs answer (the observed ~28s head-gap) is logged
        # once at recorder start. None → the offset line is skipped.
        self._answered_epoch_ms: Optional[int] = None

        # M013 S02: the LEG END — the cut-off for the tail flush. Earliest
        # mark wins. Sources, in priority order: this recorder's OWN
        # `participant_disconnected` listener for exactly this attempt's SIP
        # identity (the hang-up), the session `close` event (an upper bound —
        # the SDK emits it at the END of `_aclose_impl`, seconds late), and
        # finally `finish()` stamping its own time before the close.
        self._room: Any = room
        self._sip_identity: Optional[str] = sip_identity
        self._leg_end_ts: Optional[float] = None
        self._leg_end_source: Optional[str] = None
        self._room_listeners: list[tuple[str, Callable[..., None]]] = []
        self._session_listeners: list[tuple[str, Callable[..., None]]] = []

    @property
    def active(self) -> bool:
        """True once recording has actually begun and has not failed."""
        return self._begun and not self._failed

    @property
    def finish_failure(self) -> Optional[str]:
        """Bounded reason code when :meth:`finish` failed AFTER a recording had
        begun (close/transcode/upload/empty output), else ``None``.

        Live 2026-09-03: `finish()` fail-opened to a bare ``None``, the caller
        could not distinguish "failed" from "nothing to do", so the API was
        never told and its finalizer retried a never-uploaded object key to
        exhaustion (`object_unreadable` x6, egress stuck `active`). The caller
        reports this reason via `/recording/failed` so the server can latch the
        session truthfully instead of retrying forever."""
        return self._finish_failure

    @property
    def input_frames(self) -> int:
        """Total INPUT (candidate → worker) frames the tap has seen. FIX 4."""
        return self._counter.input

    @property
    def output_frames(self) -> int:
        """Total OUTPUT (worker TTS → candidate) frames the tap has seen. FIX 4."""
        return self._counter.output

    # ── M013 S02: leg end + tail flush ───────────────────────────────────────
    @property
    def leg_ended_at(self) -> Optional[float]:
        """Epoch seconds of the earliest leg-end mark, else ``None``."""
        return self._leg_end_ts

    @property
    def leg_end_source(self) -> Optional[str]:
        """``sip_left`` | ``session_close`` | ``finish`` (the earliest mark)."""
        return self._leg_end_source

    @property
    def leg_ended_at_ms(self) -> Optional[int]:
        """:attr:`leg_ended_at` as epoch ms, else ``None``."""
        ts = self._leg_end_ts
        if ts is None:
            return None
        try:
            return _positive_ms(ts * 1000.0)
        except Exception:  # noqa: BLE001
            return None

    @property
    def recording_started_at_ms(self) -> Optional[int]:
        """Epoch ms of the recording file's t = 0, or ``None`` before begin.

        The SDK's ``RecorderIO.recording_started_at`` is the earliest of the
        two taps' ``started_wall_time``, but the OUTPUT tap stamps its start on
        the first ``capture_frame`` EVEN WHEN NOT RECORDING (1.6.4
        ``recorder_io.py:547-548``) — so a bot frame spoken before
        :meth:`begin` would pull the anchor before the file's t = 0. Only tap
        starts at or after the moment begin() started the recorder count; the
        earliest of those is the anchor, and begin's own stamp is the floor
        (equivalently ``max(recording_started_at, begun_at)`` when the SDK
        exposes only the combined value, as the test doubles do). Never
        raises."""
        floor = self._begin_called_at
        if floor is None:
            return None
        try:
            rec = self._recorder
            starts: list[float] = []
            for tap_name in ("_in_record", "_out_record"):
                tap = getattr(rec, tap_name, None)
                t = getattr(tap, "started_wall_time", None) if tap is not None else None
                if isinstance(t, (int, float)) and not isinstance(t, bool):
                    starts.append(float(t))
            if starts:
                valid = [t for t in starts if t >= floor]
                anchor = min(valid) if valid else floor
            else:
                sdk = getattr(rec, "recording_started_at", None)
                if isinstance(sdk, (int, float)) and not isinstance(sdk, bool):
                    anchor = max(float(sdk), floor)
                else:
                    anchor = floor
            return _positive_ms(anchor * 1000.0)
        except Exception:  # noqa: BLE001
            return _positive_ms(floor * 1000.0)

    @property
    def tail_flushed(self) -> bool:
        """True only when the recorder's tail flush actually ran successfully
        (the flush is fail-open, so this is reported, never inferred)."""
        return getattr(self._recorder, "tail_flushed", False) is True

    def watch_leg_end(self, room: Any, sip_identity: Optional[str]) -> None:
        """Attach the room and this attempt's SIP identity after construction
        (the agent call site; equivalent to the constructor kwargs). The
        listener is registered once wired. Never raises."""
        try:
            if room is not None:
                self._room = room
            if sip_identity:
                self._sip_identity = sip_identity
            if self._wired:
                self._register_leg_listeners()
        except Exception:  # noqa: BLE001 — recording is strictly secondary
            pass

    def mark_leg_end(self, ts: float, *, source: str) -> None:
        """Record the leg end (earliest wins) and forward it to the recorder,
        which closes capture and uses it as the tail-flush cut-off. Never
        raises."""
        try:
            if self._leg_end_ts is None or ts < self._leg_end_ts:
                self._leg_end_ts = ts
                self._leg_end_source = source
            mark = getattr(self._recorder, "mark_leg_end", None)
            if callable(mark):
                mark(self._leg_end_ts)
        except Exception:  # noqa: BLE001
            pass

    def _on_room_participant_disconnected(self, participant: Any = None, *_: Any) -> None:
        # Our OWN listener (S01's `_on_phone_participant_disconnected` is
        # untouched). Exactly this attempt's SIP identity; anyone else leaving
        # the room is ignored. Never raises into the room's emitter.
        try:
            if self._sip_identity and getattr(participant, "identity", None) == self._sip_identity:
                self.mark_leg_end(time.time(), source="sip_left")
        except Exception:  # noqa: BLE001
            pass

    def _on_room_participant_connected(self, participant: Any = None, *_: Any) -> None:
        # A departure followed by the SAME identity re-appearing was not a
        # leg end (e.g. a room-level resync): reopen capture. A later real
        # departure, the session close or finish() marks the end again.
        try:
            if (
                self._sip_identity
                and getattr(participant, "identity", None) == self._sip_identity
                and self._leg_end_source == "sip_left"
            ):
                self._leg_end_ts = None
                self._leg_end_source = None
                reopen = getattr(self._recorder, "reopen_capture", None)
                if callable(reopen):
                    reopen()
                logger.info("in_worker_recording_leg_end_reopened")
        except Exception:  # noqa: BLE001
            pass

    def _on_session_close(self, *_: Any) -> None:
        # Upper bound only: `close` is emitted at the END of the SDK's
        # `_aclose_impl`, after interrupt/drain/transcript commit.
        try:
            self.mark_leg_end(time.time(), source="session_close")
        except Exception:  # noqa: BLE001
            pass

    def _register_leg_listeners(self) -> None:
        """Idempotent; fail-open. Room listeners only when a SIP identity is
        known, so a listener can never match an unrelated participant."""
        if not self._room_listeners and self._room is not None and self._sip_identity:
            on = getattr(self._room, "on", None)
            if callable(on):
                for event, handler in (
                    ("participant_disconnected", self._on_room_participant_disconnected),
                    ("participant_connected", self._on_room_participant_connected),
                ):
                    try:
                        on(event, handler)
                        self._room_listeners.append((event, handler))
                    except Exception:  # noqa: BLE001
                        pass
        if not self._session_listeners:
            on = getattr(self._session, "on", None)
            if callable(on):
                try:
                    on("close", self._on_session_close)
                    self._session_listeners.append(("close", self._on_session_close))
                except Exception:  # noqa: BLE001
                    pass

    def _unregister_leg_listeners(self) -> None:
        for target, listeners in (
            (self._room, self._room_listeners),
            (self._session, self._session_listeners),
        ):
            off = getattr(target, "off", None)
            for event, handler in listeners:
                try:
                    if callable(off):
                        off(event, handler)
                except Exception:  # noqa: BLE001
                    pass
            listeners.clear()

    def wire(self) -> bool:
        """Install the input/output taps around the session's LIVE audio I/O.

        MUST be called AFTER ``session.start()``: RoomIO only attaches the room
        audio to ``session.input.audio`` / ``session.output.audio`` during start,
        so before that both are ``None``. Wrapping ``None`` yields a tap whose
        ``__anext__`` raises ``NoneType`` at runtime and an output tap that feeds a
        null sink — a silent call in both directions. This method therefore
        REFUSES to wire (and self-disables) when either stream is absent, so the
        call always proceeds with no recording rather than a broken audio path.

        Recording does NOT begin here — no frame is captured until :meth:`begin`.
        Fail-open: returns False if wiring fails or is refused."""
        if self._wired:
            return True
        try:
            # Both live streams must exist BEFORE we wrap them. If either is None
            # (wire() called too early, or a room with no audio I/O), refuse and
            # self-disable — never build a tap around None.
            in_src = self._session.input.audio
            out_src = self._session.output.audio
            if in_src is None or out_src is None:
                logger.warning(
                    "in_worker_recording_wire_skipped_no_audio_io "
                    "has_input=%s has_output=%s",
                    in_src is not None, out_src is not None,
                )
                self._failed = True
                return False
            self._recorder = self._recorder_factory(self._session, self._sample_rate)
            # record_input/record_output must both be called before the recorder's
            # own start() (invoked from begin() at the consent seam).
            #
            # ZERO-CAPTURE INSTRUMENTATION (RCA 2026-09-04): wrap each RecorderIO
            # tap in a transparent counting proxy BEFORE reassigning it onto the
            # session, so the frame count each side sees is observable at aclose.
            # The proxy forwards __anext__/capture_frame verbatim and mirrors all
            # other attributes onto the real tap, so re-wiring and accumulation
            # behave exactly as the un-proxied tap (this is the piece that lets
            # the next test call PROVE capture engaged rather than infer it).
            in_tap = _CountingAudioInput(self._recorder.record_input(in_src), self._counter)
            out_tap = _CountingAudioOutput(self._recorder.record_output(out_src), self._counter)
            self._session.input.audio = in_tap
            self._session.output.audio = out_tap
            self._wired = True
            self._wired_at_ms = int(time.time() * 1000)
            # ORDER + STATE trail (STEP 3): recording MUST still be False here —
            # wiring installs the taps but begin() (consent) starts capture.
            logger.info(
                "in_worker_recording_wired recording=%s wired_at_ms=%d",
                bool(getattr(self._recorder, "recording", False)),
                self._wired_at_ms,
            )
            self._register_leg_listeners()
            return True
        except Exception:  # noqa: BLE001 — fail-open by contract
            logger.warning("in_worker_recording_wire_failed", exc_info=True)
            self._failed = True
            self._recorder = None
            return False

    async def begin(
        self, object_key: str, *, answered_epoch_ms: Optional[int] = None,
    ) -> bool:
        """Start recording at the recording-permitted moment, using the object
        key the API bound in /recording/prepare. Everything from here on is
        captured; nothing before it is (RecorderAudioInput only accumulates while
        RecorderIO.recording is True). Idempotent and fail-open.

        FIX 4 (2026-09-06): ``answered_epoch_ms`` (the call.answered wall clock)
        lets `begin` log the recording START offset from answer — the observed
        ~28s head-gap between a call being answered and capture engaging. It is
        a diagnostic only; a missing value simply omits the offset field."""
        if self._failed or not self._wired or self._recorder is None:
            return False
        if answered_epoch_ms is not None:
            self._answered_epoch_ms = answered_epoch_ms
        if self._begun:
            return True
        try:
            # M013 S02: the room may have been attached after wire().
            self._register_leg_listeners()
        except Exception:  # noqa: BLE001
            pass
        try:
            self._object_key = object_key
            base = self._work_dir or Path(tempfile.gettempdir()) / "inworker-recordings"
            base.mkdir(parents=True, exist_ok=True)
            self._ogg_path = base / (Path(object_key).name + ".ogg")
            self._begin_called_at = time.time()
            await self._recorder.start(output_path=self._ogg_path)
            self._begun = True
            self._begun_at_ms = int(time.time() * 1000)
            # ORDER + STATE trail (STEP 3): recording MUST be True immediately
            # after start() (RecorderIO.recording == _started). If this logs
            # recording=false the flag never flipped and the taps will accumulate
            # nothing — the SECONDARY hypothesis. `wire_to_begin_ms` is the gap
            # between installing the taps and starting capture (the pre-consent
            # window during which NOTHING is retained).
            # FIX 4: the recording START offset from call.answered — the ~28s
            # head-gap the live call showed between answer and capture engaging.
            # -1 when no answered timestamp was threaded (nothing to compute).
            answered_to_begin_ms = (
                (self._begun_at_ms - self._answered_epoch_ms)
                if self._answered_epoch_ms else -1
            )
            logger.info(
                "in_worker_recording_started recording=%s begun_at_ms=%d "
                "wire_to_begin_ms=%s answered_to_begin_ms=%s",
                bool(getattr(self._recorder, "recording", False)),
                self._begun_at_ms,
                (self._begun_at_ms - self._wired_at_ms) if self._wired_at_ms else -1,
                answered_to_begin_ms,
                extra={"object_key": self._object_key},
            )
            return True
        except Exception:  # noqa: BLE001
            logger.warning(
                "in_worker_recording_begin_failed", extra={"object_key": self._object_key},
                exc_info=True,
            )
            self._failed = True
            return False

    async def audio_health_heartbeat(
        self,
        *,
        interval_sec: float = PHONE_AUDIO_HEALTH_INTERVAL_SEC,
        no_input_warn_sec: float = PHONE_AUDIO_NO_INPUT_WARN_SEC,
    ) -> None:
        """Periodic, content-free audio-path health signal (FIX 4, 2026-09-06).

        Emits `phone_audio_health` every ``interval_sec`` while recording is
        active, carrying the INPUT/OUTPUT frame DELTAS since the last tick (and
        the running totals). When the input tap goes ``no_input_warn_sec`` with
        zero new frames while active, it also emits a WARN `no_input_audio` —
        the inbound-starvation signal (candidate leg dropped / muted).

        Pure observability: it reads two integers and logs counts/booleans only,
        never audio. It stops when recording is no longer active. Fail-open: any
        error ends the heartbeat quietly rather than perturbing the call — it is
        cancelled by the caller in the same `finally` that finishes recording.
        """
        # Floor is small so tests can drive a fast cadence; production uses the
        # 15s default. A zero/negative interval would busy-loop, hence the floor.
        interval = max(0.001, float(interval_sec))
        warn_after = max(interval, float(no_input_warn_sec))
        last_input = self._counter.input
        last_output = self._counter.output
        last_input_change = time.monotonic()
        input_warned = False
        try:
            while self.active:
                await asyncio.sleep(interval)
                if not self.active:
                    break
                cur_in = self._counter.input
                cur_out = self._counter.output
                in_delta = cur_in - last_input
                out_delta = cur_out - last_output
                now = time.monotonic()
                if in_delta > 0:
                    last_input_change = now
                    input_warned = False
                # Content-free: deltas + totals only, no audio, no ids beyond the
                # object key the other recording lines already carry.
                logger.info(
                    "phone_audio_health in_delta=%d out_delta=%d "
                    "in_total=%d out_total=%d",
                    in_delta, out_delta, cur_in, cur_out,
                    extra={"object_key": self._object_key},
                )
                if (
                    not input_warned
                    and (now - last_input_change) >= warn_after
                ):
                    input_warned = True
                    logger.warning(
                        "no_input_audio stalled_sec=%d in_total=%d out_total=%d",
                        int(now - last_input_change), cur_in, cur_out,
                        extra={"object_key": self._object_key},
                    )
                last_input = cur_in
                last_output = cur_out
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — observability must never break a call
            logger.warning(
                "phone_audio_health_failed", extra={"object_key": self._object_key},
                exc_info=True,
            )

    async def finish(self, upload_url: str) -> Optional[RecordingManifest]:
        """Close the recorder, transcode OGG→MP3, upload to the presigned URL
        the API minted, and return the manifest. Returns None (fail-open) if
        recording never began or any step fails — the call is already over, so
        nothing here can harm the screening."""
        self._unregister_leg_listeners()
        if not self._begun or self._failed or self._recorder is None or self._ogg_path is None:
            return None
        # The STARTED flag: after a leg-end mark the tail-flushing recorder's
        # `recording` reads False by design (capture closed), which is not the
        # zero-capture signal this diagnostic exists for.
        recording_at_close = bool(
            getattr(self._recorder, "_started", None)
            if isinstance(getattr(self._recorder, "_started", None), bool)
            else getattr(self._recorder, "recording", False)
        )
        # M013 S02: last-resort leg end (earliest mark wins, so a SIP-leave or
        # session-close mark already recorded is kept), then a content-free
        # line pairing it with the last input frame's wall clock.
        self.mark_leg_end(time.time(), source="finish")
        try:
            last_in = self._counter.last_input_at
            logger.info(
                "in_worker_recording_leg_end source=%s leg_end_ms=%d "
                "last_input_frame_ms=%s begun_at_ms=%s",
                self._leg_end_source,
                int((self._leg_end_ts or 0) * 1000),
                int(last_in * 1000) if last_in is not None else -1,
                self._begun_at_ms if self._begun_at_ms is not None else -1,
                extra={"object_key": self._object_key},
            )
        except Exception:  # noqa: BLE001
            pass
        close_completed = True
        try:
            close_task = asyncio.create_task(self._recorder.aclose())
            done, pending = await asyncio.wait(
                {close_task}, timeout=RECORDER_CLOSE_TIMEOUT_SEC,
            )
            if pending:
                # Do not wait for a cancellation-suppressing SDK/provider close.
                # The OGG may already contain complete muxed packets; upload it
                # as raw OGG, omit duration, and make the partial-close state
                # visible.  We never claim a clean MP3/full-duration recording.
                close_completed = False
                self._finish_failure = "recorder_close_timeout"
                close_task.cancel()
                close_task.add_done_callback(_consume_cancelled_task)
                logger.warning(
                    "in_worker_recording_close_timed_out_ogg_only",
                    extra={"object_key": self._object_key},
                )
            else:
                close_task.result()
        except Exception:  # noqa: BLE001
            logger.warning(
                "in_worker_recording_close_failed", extra={"object_key": self._object_key},
                exc_info=True,
            )
            self._finish_failure = "recorder_close_failed"
            # The failure is about to be REPORTED as a permanent loss — the
            # documented invariant is that a reported failure retains no audio,
            # so the local OGG must not survive this branch either.
            self._cleanup()
            return None

        # ── THE DECISIVE CAPTURE LOG (RCA 2026-09-04, STEP 3) ────────────────
        # This single line answers the RCA question the INFO logs could not: did
        # capture engage? `recording_at_close` is the RecorderIO.recording flag
        # at teardown (paired with the recording=... field on the earlier
        # `in_worker_recording_started` line: the SECONDARY-hypothesis signal —
        # if the flag never flipped True the taps accumulate nothing).
        # `input_frames`/`output_frames` are the counts the taps actually saw
        # (the PRIMARY-hypothesis signal — if both are 0 the reassignment did not
        # reroute the live audio into the taps). `ogg_exists`/`ogg_bytes` are the
        # ground truth: PyAV writes NO ogg file until the first muxed packet, so
        # ogg_exists=false with input/output_frames=0 is the exact zero-capture
        # signature (missing OGG, not a transcode desync). Counts/booleans only.
        ogg_exists = self._ogg_path.exists()
        try:
            ogg_bytes = self._ogg_path.stat().st_size if ogg_exists else 0
        except Exception:  # noqa: BLE001
            ogg_bytes = -1
        logger.info(
            "in_worker_recording_capture "
            "recording_at_close=%s input_frames=%d output_frames=%d "
            "ogg_exists=%s ogg_bytes=%d",
            recording_at_close,
            self._counter.input,
            self._counter.output,
            ogg_exists,
            ogg_bytes,
            extra={"object_key": self._object_key},
        )

        mp3_path = self._ogg_path.with_suffix(".mp3")
        body: Optional[bytes] = None
        content_type = "audio/ogg"
        # M013 S02 T02: the true audio length in ms (None until known).
        encoded_ms: Optional[int] = None
        try:
            # ── NO-AUDIO GUARD (RCA 2026-09-04, STEP 4): the OGG is MISSING or
            # EMPTY. This is the ACTUAL live failure on every phone call — zero
            # frames reached the encoder, so PyAV never materialized the file —
            # NOT a transcode desync. Previously the transcode ran anyway,
            # `av.open` raised `FileNotFoundError`, and finish() mislabeled it
            # `transcode_failed`, which sent the entire B2 line (#223/#227/#228)
            # chasing a desync that never existed. Report `no_audio_captured` so
            # the failure names its real cause. There is genuinely nothing to
            # upload, so this is a truthful terminal loss (the caller latches it
            # via /recording/failed exactly like any other named failure).
            if not ogg_exists or ogg_bytes <= 0:
                self._finish_failure = "no_audio_captured"
                raise RuntimeError("no_audio_captured")

            # ── OGG-FIRST DURABLE UPLOAD (RCA 2026-09-05, prod v117) ────────
            # THE v117 GAP: finish() runs INLINE in the post-teardown shutdown
            # path (after `_close_phone_room`), and its steps used to be, in
            # order: transcode (seconds of PyAV CPU on a loaded shared-cpu box)
            # → then the presigned PUT. LiveKit's entrypoint-exit grace cancels
            # the coroutine DURING the transcode / before the PUT completes, so
            # the ALREADY-CAPTURED 3.9MB OGG (`ogg_exists=True ogg_bytes=…`) was
            # NEVER uploaded: the storage object was never PUT, the API finalizer
            # deferred `object_unreadable`, and the session stayed
            # `recording_egress_status=active` forever.
            #
            # FIX: make the bytes we ALREADY HAVE durable FIRST — PUT the raw OGG
            # immediately, before the slow transcode can be cancelled. This is
            # the durability guarantee. The MP3 transcode is then a BEST-EFFORT
            # UPGRADE that re-PUTs the same key (upsert) — if it is cancelled or
            # fails, the durable OGG already landed and the manifest reflects it.
            ogg_body = self._ogg_path.read_bytes()
            if not ogg_body:
                # Existed at stat() but read empty — same class as no-audio.
                self._finish_failure = "no_audio_captured"
                raise RuntimeError("no_audio_captured")
            try:
                await self._upload_fn(upload_url, ogg_body, "audio/ogg")
            except Exception:
                # The durability PUT itself failed — nothing landed. This is a
                # real total loss; name the leg so the caller latches truthfully
                # (do NOT attempt the transcode/upgrade on an unreachable store).
                self._finish_failure = "upload_failed"
                raise
            body = ogg_body
            content_type = "audio/ogg"
            logger.info(
                "in_worker_recording_uploaded_ogg_close_timeout"
                if not close_completed else "in_worker_recording_uploaded_ogg",
                extra={
                    "object_key": self._object_key,
                    "size_bytes": len(ogg_body),
                    "content_type": "audio/ogg",
                },
            )

            if not close_completed:
                # The file was flushed before the recorder close acknowledged;
                # retain the raw evidence, but do not run transcode or invent a
                # duration for bytes that may still be missing tail packets.
                self._cleanup()
                # No duration, and the tail is NOT reported flushed: the
                # encoder never acknowledged the close, so tail packets may be
                # missing from the file whatever the flush did.
                return self._build_manifest(
                    body, content_type, None, close_completed=False,
                )

            # ── BEST-EFFORT MP3 UPGRADE ─────────────────────────────────────
            # The OGG is now durable. Attempt OGG→MP3 and re-PUT the same key
            # (upsert:true, so the overwrite is permitted — see _default_upload).
            # ANY failure here — transcode desync, empty MP3, upgrade PUT error,
            # or asyncio.CancelledError from the shutdown grace — leaves the
            # durable OGG in place and the OGG manifest already assigned above.
            # CancelledError is RE-RAISED after we confirm the OGG PUT happened,
            # so the shutdown path is not swallowed (the durability guarantee is
            # met before we honour the cancellation).
            # NOTE: _default_transcode runs the PyAV work via asyncio.to_thread,
            # which is NOT interruptible — a CancelledError abandons the await but
            # the OS thread runs to completion detached. So a shutdown cancel
            # realistically lands on the OGG PUT await above (the first slow
            # network await), not here; either way the OGG is already durable.
            try:
                encoded_ms = _positive_ms(
                    await self._transcode_fn(self._ogg_path, mp3_path),
                )
                mp3_body = mp3_path.read_bytes()
                if not mp3_body:
                    raise RuntimeError("empty_mp3")
                await self._upload_fn(upload_url, mp3_body, "audio/mpeg")
                body = mp3_body
                content_type = "audio/mpeg"
                logger.info(
                    "in_worker_recording_uploaded",
                    extra={
                        "object_key": self._object_key,
                        "size_bytes": len(mp3_body),
                        "content_type": "audio/mpeg",
                    },
                )
            except asyncio.CancelledError:
                # The shutdown grace cancelled the upgrade. The OGG is already
                # durable; honour the cancellation but keep the OGG manifest.
                logger.warning(
                    "in_worker_recording_mp3_upgrade_cancelled_ogg_durable",
                    extra={"object_key": self._object_key},
                )
                raise
            except Exception:  # noqa: BLE001 — upgrade is best-effort only
                # A failed MP3 upgrade is NOT a loss: the raw OGG already landed
                # and remains the reviewable artifact (the server sniffs the
                # object's container bytes and records `audio/ogg`, a status a
                # human/QA can tell apart from a clean MP3 finalize).
                logger.warning(
                    "in_worker_recording_mp3_upgrade_failed_keeping_ogg",
                    extra={"object_key": self._object_key},
                    exc_info=True,
                )
            # M013 S02 T02: the TRUE audio length. The MP3 encode counted its
            # samples; otherwise (raw-OGG manifest, or a transcoder that could
            # not tell) read the OGG container's own length. Off the loop: a
            # long call's OGG has tens of thousands of packets.
            if encoded_ms is None:
                encoded_ms = await asyncio.to_thread(_ogg_duration_ms, self._ogg_path)
        except asyncio.CancelledError:
            # Cancellation propagated from the upgrade block AFTER the durable
            # OGG PUT succeeded (body/content_type are the OGG). Build the OGG
            # manifest and return it rather than reporting a loss — the audio is
            # safely stored. (A cancellation BEFORE the OGG PUT leaves body=None
            # and falls through to the fail-open None return below via the outer
            # structure — but that PUT is the first slow await, so in practice
            # the OGG is durable well before any transcode-window cancel.)
            if body is None:
                self._cleanup()
                raise
            # Read the OGG's length BEFORE the cleanup deletes it (a rare
            # shutdown path, so the short synchronous demux is acceptable).
            if encoded_ms is None:
                encoded_ms = _ogg_duration_ms(self._ogg_path)
            self._cleanup()
            return self._build_manifest(body, content_type, encoded_ms)
        except Exception:  # noqa: BLE001 — fail-open, the call is already over
            logger.warning(
                "in_worker_recording_finish_failed %s",
                self._finish_failure,
                extra={"object_key": self._object_key},
                exc_info=True,
            )
            self._cleanup()
            return None
        except BaseException:
            # A non-Exception, non-CancelledError BaseException (GeneratorExit,
            # SystemExit, KeyboardInterrupt) can be raised during the awaits above
            # — most plausibly the OGG PUT (line ~711), the first slow network
            # await where a shutdown lands. The pre-reorder code used
            # `finally: _cleanup()` and was immune to this; moving cleanup into
            # explicit per-branch paths reintroduced a temp-file leak on this
            # branch. Restore the guarantee so a long-lived worker never
            # accumulates orphaned temp OGG/MP3 files across calls. _cleanup() is
            # idempotent, so this is safe alongside the other cleanup callsites.
            self._cleanup()
            raise

        self._cleanup()
        assert body is not None
        return self._build_manifest(body, content_type, encoded_ms)

    async def discard(self) -> None:
        """Wrong-number/identity-mismatch privacy path: stop recording and
        delete the local file without uploading. Other gate exits retain audio
        under the recorded-from-answer policy. Fail-open and idempotent."""
        self._unregister_leg_listeners()
        if self._recorder is not None and self._begun and not self._failed:
            # M013 S02: the audio is about to be deleted — skip the tail flush
            # so a discarded call spends no encode time on it.
            try:
                skip = getattr(self._recorder, "skip_tail_flush", None)
                if callable(skip):
                    skip()
            except Exception:  # noqa: BLE001
                pass
            try:
                close_task = asyncio.create_task(self._recorder.aclose())
                done, pending = await asyncio.wait(
                    {close_task}, timeout=RECORDER_CLOSE_TIMEOUT_SEC,
                )
                if pending:
                    close_task.cancel()
                    close_task.add_done_callback(_consume_cancelled_task)
                    logger.warning(
                        "in_worker_recording_discard_close_timed_out",
                        extra={"object_key": self._object_key},
                    )
                else:
                    close_task.result()
            except Exception:  # noqa: BLE001
                pass
        self._failed = True  # a subsequent finish() becomes a no-op
        self._cleanup()
        logger.info("in_worker_recording_discarded", extra={"object_key": self._object_key})

    def _build_manifest(
        self,
        body: bytes,
        content_type: str,
        duration_ms: Optional[int],
        *,
        close_completed: bool = True,
    ) -> RecordingManifest:
        """The manifest for whichever body landed, with the M013 S02 timing
        (data only: the API stamps it on the attempt, it never drives a state
        transition). ``duration_ms`` is the TRUE audio length or ``None`` —
        never 0 and never a wall-clock span (the old ``_probe_duration_ms``
        measured recorder start → upload)."""
        return RecordingManifest(
            sha256=hashlib.sha256(body).hexdigest(),
            size_bytes=len(body),
            duration_ms=_positive_ms(duration_ms),
            content_type=content_type,
            recording_started_at_ms=self.recording_started_at_ms,
            leg_ended_at_ms=self.leg_ended_at_ms,
            tail_flushed=bool(close_completed and self.tail_flushed),
        )

    def _cleanup(self) -> None:
        for p in (self._ogg_path, self._ogg_path.with_suffix(".mp3") if self._ogg_path else None):
            try:
                if p and p.exists():
                    p.unlink()
            except Exception:  # noqa: BLE001
                pass
