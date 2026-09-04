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
    def _run() -> None:
        import av  # noqa: PLC0415
        from av.audio.fifo import AudioFifo  # noqa: PLC0415
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
                while fifo.samples >= frame_size:
                    chunk = fifo.read(frame_size)
                    if chunk is None:
                        break
                    chunk.pts = None
                    for packet in out_stream.encode(chunk):
                        out_container.mux(packet)
                if final:
                    # The true last frame: everything still buffered (< frame_size).
                    tail = fifo.read()
                    if tail is not None:
                        tail.pts = None
                        for packet in out_stream.encode(tail):
                            out_container.mux(packet)

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

    await asyncio.to_thread(_run)


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
