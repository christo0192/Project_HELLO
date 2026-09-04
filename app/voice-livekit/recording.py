"""In-worker call recording (PR A) — the agent AS the recorder.

Replaces LiveKit Cloud room-composite egress (Build-plan concurrent-egress cap
= 2) with recording performed INSIDE this agent worker, using the built-in
``RecorderIO`` shipped in livekit-agents 1.6.4. RecorderIO taps the SAME
candidate audio the STT already consumes and the bot's OWN TTS output (captured
at the moment it is actually played), mixes both onto one synchronized stereo
timeline (candidate = left, agent = right), resamples, and stream-encodes to
OGG/Opus with constant memory. No second AudioStream, no hand-rolled mixer.

── CONSENT POSTURE: RECORD FROM ANSWER, KEEP ONLY IF CONSENT ────────────────
This matches the egress posture since migration 0067 (PR160): recording begins
at ``call.answered`` so the greeting + consent exchange itself is captured, and
the recording is KEPT only if consent is delivered. If consent is refused (a
machine pickup, an explicit refusal, or a pre-disclosure deferral), the audio
must be destroyed — the caller invokes :meth:`discard` instead of :meth:`finish`
so the local file is deleted and NOTHING is uploaded (there is therefore no
object for the server-side purge to race against). The upload in :meth:`finish`
is thus gated by the CALLER on the consent outcome, never performed blindly.

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
for the API to persist and finalize.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import sys
import tempfile
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
    re-download."""

    sha256: str
    size_bytes: int
    duration_ms: Optional[int]
    content_type: str = "audio/mpeg"


# Injected seams (real defaults below) so the lifecycle is unit-testable with no
# livekit/PyAV/ffmpeg/network present.
RecorderFactory = Callable[[Any, int], Any]
TranscodeFn = Callable[[Path, Path], Awaitable[None]]
# (upload_url, body, content_type) — content_type is "audio/mpeg" for the normal
# MP3 and "audio/ogg" for the v114 raw-OGG fallback, so the PUT declares the
# real Content-Type of whichever body survived.
UploadFn = Callable[[str, bytes, str], Awaitable[None]]


def _default_recorder_factory(session: Any, sample_rate: int) -> Any:
    """Construct the real RecorderIO. Imported lazily so this module (and its
    unit tests) load without livekit-agents installed."""
    from livekit.agents.voice.recorder_io import RecorderIO  # noqa: PLC0415

    return RecorderIO(agent_session=session, sample_rate=sample_rate)


async def _default_transcode(ogg_path: Path, mp3_path: Path) -> None:
    """One-shot OGG→MP3 transcode, off the hot path, IN-PROCESS via PyAV.

    Deliberately NOT an ``ffmpeg`` subprocess: the worker image is
    ``python:3.12-slim`` with no ffmpeg BINARY, so shelling out silently failed
    and dropped the recording. PyAV (``av``) is already a guaranteed worker
    dependency — RecorderIO itself encodes the OGG with it — and its wheel
    bundles ``libmp3lame``, so the MP3 encode needs no extra binary or image
    change. Runs in a thread so the encode never blocks the event loop.

    ── WHY IT IS HARDENED (live v114, 2026-09-04) ──────────────────────────
    A real call lost its recording to ``transcode_failed`` preceded by the
    PyAV/librosa warning "Input is shorter by 46394 samples; silence has been
    prepended to align". The two mixed channels (candidate=left, bot=right)
    finished with mismatched sample counts, so a decoded frame arrived with an
    unexpected shape/layout/rate and a SINGLE bad frame threw out of the whole
    encode. Three hardening measures make the encode robust rather than
    all-or-nothing:

      1. An explicit ``av.AudioResampler`` coerces every decoded frame to the
         OUTPUT stream's exact rate + layout + a valid packed sample format
         (``s16p`` is what libmp3lame wants), so a short/mono/desynced frame is
         normalized instead of tripping the encoder.
      2. The per-frame decode→resample→encode step is wrapped so ONE malformed
         frame is skipped (counted + logged), never aborting the encode — BUT a
         COMPLETENESS FLOOR (see ``_TRANSCODE_MAX_SKIPPED_FRACTION``) fails the
         whole transcode if too large a fraction was skipped, so a badly
         truncated MP3 is never passed off as a success (it drops to the OGG
         fallback instead, preserving the complete raw audio).
      3. The layout is set explicitly (mono vs stereo), the encoder tail is
         always flushed, and the caller verifies a non-empty MP3 — so the
         function only "succeeds" when it actually produced (near-)complete audio.
    """
    def _run() -> None:
        import av  # noqa: PLC0415
        from av.audio.resampler import AudioResampler  # noqa: PLC0415

        in_container = av.open(str(ogg_path))
        out_container = av.open(str(mp3_path), mode="w")
        decoded_frames = 0
        encoded_frames = 0
        skipped_frames = 0
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
            # exact rate/layout/format. This is what turns "Input is shorter by N
            # samples" (a fatal encode error at v114) into a silently-aligned
            # frame the encoder accepts.
            resampler = AudioResampler(format="s16p", layout=out_layout, rate=out_rate)

            for frame in in_container.decode(in_stream):
                decoded_frames += 1
                try:
                    frame.pts = None
                    # resample() returns a LIST of frames (it may split/merge).
                    for r_frame in resampler.resample(frame):
                        for packet in out_stream.encode(r_frame):
                            out_container.mux(packet)
                    # Count the INPUT frame as encoded once its resampled output
                    # was muxed without error — so encoded_frames vs
                    # decoded_frames is an apples-to-apples completeness ratio,
                    # not inflated by the resampler splitting one frame into many.
                    encoded_frames += 1
                except Exception:  # noqa: BLE001 — skip ONE bad frame, not the file
                    skipped_frames += 1
                    continue
            # Drain any samples the resampler is still buffering, then flush the
            # encoder tail. Both are wrapped so a tail hiccup cannot lose the
            # frames already muxed.
            try:
                for r_frame in resampler.resample(None):
                    for packet in out_stream.encode(r_frame):
                        out_container.mux(packet)
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

    await asyncio.to_thread(_run)


async def _default_upload(
    upload_url: str, body: bytes, content_type: str = "audio/mpeg",
) -> None:
    """PUT the recording bytes to the presigned URL the API minted. Lazy httpx
    import. ``content_type`` is ``audio/mpeg`` for the normal MP3 and
    ``audio/ogg`` for the v114 raw-OGG fallback, so the declared Content-Type
    matches the bytes actually sent (the finalizer still sniffs the object's
    container bytes and does not trust this header)."""
    import httpx  # noqa: PLC0415

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        resp = await client.put(
            upload_url, content=body, headers={"Content-Type": content_type},
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"upload_failed_status_{resp.status_code}")


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
            self._session.input.audio = self._recorder.record_input(in_src)
            self._session.output.audio = self._recorder.record_output(out_src)
            self._wired = True
            return True
        except Exception:  # noqa: BLE001 — fail-open by contract
            logger.warning("in_worker_recording_wire_failed", exc_info=True)
            self._failed = True
            self._recorder = None
            return False

    async def begin(self, object_key: str) -> bool:
        """Start recording at the recording-permitted moment, using the object
        key the API bound in /recording/prepare. Everything from here on is
        captured; nothing before it is (RecorderAudioInput only accumulates while
        RecorderIO.recording is True). Idempotent and fail-open."""
        if self._failed or not self._wired or self._recorder is None:
            return False
        if self._begun:
            return True
        try:
            self._object_key = object_key
            base = self._work_dir or Path(tempfile.gettempdir()) / "inworker-recordings"
            base.mkdir(parents=True, exist_ok=True)
            self._ogg_path = base / (Path(object_key).name + ".ogg")
            await self._recorder.start(output_path=self._ogg_path)
            self._begun = True
            logger.info("in_worker_recording_started", extra={"object_key": self._object_key})
            return True
        except Exception:  # noqa: BLE001
            logger.warning(
                "in_worker_recording_begin_failed", extra={"object_key": self._object_key},
                exc_info=True,
            )
            self._failed = True
            return False

    async def finish(self, upload_url: str) -> Optional[RecordingManifest]:
        """Close the recorder, transcode OGG→MP3, upload to the presigned URL
        the API minted, and return the manifest. Returns None (fail-open) if
        recording never began or any step fails — the call is already over, so
        nothing here can harm the screening."""
        if not self._begun or self._failed or self._recorder is None or self._ogg_path is None:
            return None
        try:
            await self._recorder.aclose()
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

        mp3_path = self._ogg_path.with_suffix(".mp3")
        body: Optional[bytes] = None
        content_type = "audio/mpeg"
        try:
            # ── PRIMARY: OGG→MP3 transcode, then upload the MP3. ────────────
            transcoded_ok = False
            try:
                await self._transcode_fn(self._ogg_path, mp3_path)
                mp3_body = mp3_path.read_bytes()
                if not mp3_body:
                    raise RuntimeError("empty_mp3")
                body = mp3_body
                content_type = "audio/mpeg"
                transcoded_ok = True
            except Exception:  # noqa: BLE001 — DO NOT re-raise: try the fallback
                # ── FALLBACK (live v114, 2026-09-04): NEVER lose the audio. ──
                # The v114 call died here with `transcode_failed` on a
                # sample/channel desync, and finish()'s `finally: _cleanup()`
                # then DELETED the raw OGG — total loss of a recoverable call.
                # So a failed MP3 transcode no longer discards everything: if a
                # non-empty raw OGG exists, upload IT instead so a reviewable
                # artifact survives. The server sniffs the object's container
                # bytes and records `audio/ogg`, a status a human/QA can tell
                # apart from a clean MP3 finalize.
                logger.warning(
                    "in_worker_recording_transcode_failed_trying_ogg_fallback",
                    extra={"object_key": self._object_key},
                    exc_info=True,
                )
                try:
                    ogg_body = self._ogg_path.read_bytes()
                except Exception:  # noqa: BLE001 — the OGG itself is unreadable
                    ogg_body = b""
                if not ogg_body:
                    # No MP3, no OGG — genuinely nothing to keep.
                    self._finish_failure = "transcode_failed"
                    raise
                body = ogg_body
                content_type = "audio/ogg"

            # ── UPLOAD (MP3 or the OGG fallback) to the presigned PUT. ──────
            assert body is not None
            try:
                await self._upload_fn(upload_url, body, content_type)
            except Exception:
                # An upload failure is a real loss regardless of which body we
                # sent. Name the leg so the caller latches truthfully — a
                # fallback whose upload also failed is still a total loss, not a
                # silent success.
                self._finish_failure = (
                    "upload_failed" if transcoded_ok else "transcode_failed"
                )
                raise
        except Exception:  # noqa: BLE001 — fail-open, the call is already over
            logger.warning(
                "in_worker_recording_finish_failed %s",
                self._finish_failure,
                extra={"object_key": self._object_key},
                exc_info=True,
            )
            return None
        finally:
            self._cleanup()

        sha256 = hashlib.sha256(body).hexdigest()
        duration_ms = self._probe_duration_ms()
        logger.info(
            "in_worker_recording_uploaded",
            extra={
                "object_key": self._object_key,
                "size_bytes": len(body),
                "content_type": content_type,
            },
        )
        return RecordingManifest(
            sha256=sha256,
            size_bytes=len(body),
            duration_ms=duration_ms,
            content_type=content_type,
        )

    async def discard(self) -> None:
        """No-consent path: stop recording and delete the local file WITHOUT
        uploading. Called instead of :meth:`finish` when consent was refused /
        a machine answered / a pre-disclosure deferral occurred, so no audio of
        a non-consenting call is ever retained or uploaded. Fail-open and
        idempotent."""
        if self._recorder is not None and self._begun and not self._failed:
            try:
                await self._recorder.aclose()
            except Exception:  # noqa: BLE001
                pass
        self._failed = True  # a subsequent finish() becomes a no-op
        self._cleanup()
        logger.info("in_worker_recording_discarded", extra={"object_key": self._object_key})

    def _probe_duration_ms(self) -> Optional[int]:
        """Best-effort duration from the recorder's started-at anchor. Never
        raises — a missing duration is acceptable to the finalizer."""
        try:
            started = getattr(self._recorder, "recording_started_at", None)
            if started is None:
                return None
            import time  # noqa: PLC0415

            return max(0, int((time.time() - started) * 1000))
        except Exception:  # noqa: BLE001
            return None

    def _cleanup(self) -> None:
        for p in (self._ogg_path, self._ogg_path.with_suffix(".mp3") if self._ogg_path else None):
            try:
                if p and p.exists():
                    p.unlink()
            except Exception:  # noqa: BLE001
                pass
