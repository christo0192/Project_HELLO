"""Phone-path noise suppression (RNNoise) for the candidate's inbound audio.

WHY: PSTN callers bring their background (traffic, TV, other voices) straight
into STT and VAD — nothing upstream suppresses it, and in livekit-agents 1.6.4
VAD does not gate STT, so noise becomes phantom turns and garbage transcript.
An offline A/B on a real call chose RNNoise (VAD segments 53 -> 36, caller
"speech" during bot speech 27.0 s -> 12.9 s, candidate words preserved).

Contract agent.py codes against:

  phone_room_options() -> livekit.agents.voice.room_io.RoomOptions | None
      None  -> do NOT pass room_options to session.start (pre-change behavior).
               Returned when PHONE_NOISE_SUPPRESSION=off, and FAIL-OPEN when the
               library cannot be loaded: a call must never die for want of a
               denoiser.
      else  -> RoomOptions(audio_input=AudioInputOptions(sample_rate=48000,
               noise_cancellation=<per-track RNNoise selector>)).

Import-safety: this module imports only the stdlib at import time. livekit and
numpy are imported lazily, so CI (bare python3, no livekit/numpy/pyrnnoise) and
agent.py's stubbed-SDK tests can import it.

The library: pyrnnoise==0.4.5 (Apache-2.0) is installed `--no-deps` purely for
its bundled librnnoise.so. We NEVER `import pyrnnoise` — its __init__ pulls
audiolab/matplotlib/click/tqdm — we locate the .so via find_spec (which does not
execute __init__) and bind it with ctypes exactly as pyrnnoise/rnnoise.py does.
"""
from __future__ import annotations

import ctypes
import importlib.util
import logging
import os
import sys
import threading
import time
from typing import Any, Callable, Optional

logger = logging.getLogger("voice-livekit.noise_suppression")

# Same LOG VISIBILITY trap as recording.py (live 2026-09-03): a bare logger
# propagating to a root handler the worker never configures never reaches
# `fly logs`, and these lines (unavailable / failed / summary) are the only
# evidence of whether a call was actually denoised. Dedicated stdout handler;
# propagation off so a configured root cannot double-print.
if not logger.handlers:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

PHONE_INPUT_SAMPLE_RATE = 48000
# RNNoise only speaks 10 ms @ 48 kHz. A library reporting anything else is a
# build we have not validated, so it is refused rather than guessed at.
RNNOISE_FRAME_SIZE = 480

_OFF_VALUES = frozenset({"off", "false", "0", "no", "none", "disable", "disabled"})
_unknown_mode_warned = False


def phone_noise_suppression_mode() -> str:
    """'rnnoise' (default) or 'off'. An unrecognised value keeps the default
    (warned once per process) — a typo must not silently remove suppression."""
    global _unknown_mode_warned
    # Literal env name: scripts/check-env-contract.mjs only sees literals.
    val = os.environ.get("PHONE_NOISE_SUPPRESSION", "").strip().lower()
    if val in ("", "rnnoise"):
        return "rnnoise"
    if val in _OFF_VALUES:
        return "off"
    if not _unknown_mode_warned:
        _unknown_mode_warned = True
        logger.warning(
            "phone_noise_suppression_unknown_mode value=%r using=rnnoise", val[:32]
        )
    return "rnnoise"


# ── librnnoise binding ────────────────────────────────────────────────────────


class RNNoiseUnavailable(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


_FLOAT_P = ctypes.POINTER(ctypes.c_float)


class _RNNoiseLib:
    """The backend seam: create() -> state, process(state, chunk) -> speech
    prob (denoises a 480-sample float32 numpy chunk IN PLACE), destroy(state).
    Tests inject a fake with the same three methods."""

    def __init__(self, cdll: ctypes.CDLL) -> None:
        cdll.rnnoise_create.argtypes = [ctypes.c_void_p]
        cdll.rnnoise_create.restype = ctypes.c_void_p
        cdll.rnnoise_destroy.argtypes = [ctypes.c_void_p]
        cdll.rnnoise_destroy.restype = None
        cdll.rnnoise_process_frame.argtypes = [ctypes.c_void_p, _FLOAT_P, _FLOAT_P]
        cdll.rnnoise_process_frame.restype = ctypes.c_float
        cdll.rnnoise_get_frame_size.argtypes = []
        cdll.rnnoise_get_frame_size.restype = ctypes.c_int
        self._lib = cdll
        self.frame_size = int(cdll.rnnoise_get_frame_size())

    def create(self) -> Any:
        state = self._lib.rnnoise_create(None)  # None -> built-in model
        if not state:
            raise RuntimeError("rnnoise_create returned NULL")
        return state

    def destroy(self, state: Any) -> None:
        self._lib.rnnoise_destroy(state)

    def process(self, state: Any, chunk: Any) -> float:
        # RNNoise permits in == out; samples are int16-SCALE floats, not ±1.
        ptr = chunk.ctypes.data_as(_FLOAT_P)
        return float(self._lib.rnnoise_process_frame(state, ptr, ptr))


def _try_load(
    find_spec: Callable[[str], Any] = importlib.util.find_spec,
    platform: str = sys.platform,
) -> tuple[Optional[_RNNoiseLib], Optional[str]]:
    """(backend, None) or (None, stable_reason). Never raises."""
    if not platform.startswith("linux"):
        return None, "unsupported_platform"  # the bundled lib is the Linux .so
    try:
        spec = find_spec("pyrnnoise")
    except Exception:
        spec = None
    locations = list(getattr(spec, "submodule_search_locations", None) or [])
    if not locations:
        return None, "not_installed"
    path = os.path.join(locations[0], "librnnoise.so")
    if not os.path.isfile(path):
        return None, "library_missing"
    try:
        lib = _RNNoiseLib(ctypes.CDLL(path))
    except Exception:
        return None, "load_failed"
    if lib.frame_size != RNNOISE_FRAME_SIZE:
        return None, f"frame_size_{lib.frame_size}"
    # Prove create/process/destroy once, so a broken build fails HERE (one
    # error per session start) instead of inside every call's audio path.
    try:
        state = lib.create()
        try:
            probe = (ctypes.c_float * RNNOISE_FRAME_SIZE)()
            lib._lib.rnnoise_process_frame(state, probe, probe)
        finally:
            lib.destroy(state)
    except Exception:
        return None, "probe_failed"
    try:
        import numpy  # noqa: F401  — the frame processor needs it
    except Exception:
        return None, "numpy_missing"
    return lib, None


_backend_lock = threading.Lock()
_backend_cache: Optional[tuple[Optional[_RNNoiseLib], Optional[str]]] = None


def _load_backend() -> _RNNoiseLib:
    """Load once per process (lazily — never at import); raise RNNoiseUnavailable."""
    global _backend_cache
    with _backend_lock:
        if _backend_cache is None:
            _backend_cache = _try_load()
        lib, reason = _backend_cache
    if lib is None:
        raise RNNoiseUnavailable(reason or "unknown")
    return lib


# ── FrameProcessor ────────────────────────────────────────────────────────────

_processor_class: Optional[type] = None


def _get_processor_class() -> type:
    """Build RNNoiseFrameProcessor on first use: it must subclass
    rtc.FrameProcessor (RoomIO isinstance-checks it), and livekit is not
    importable everywhere this module is."""
    global _processor_class
    if _processor_class is not None:
        return _processor_class

    import numpy as np
    from livekit import rtc

    class RNNoiseFrameProcessor(rtc.FrameProcessor[rtc.AudioFrame]):
        """One RNNoise state per inbound track stream (RoomIO owns and closes it).

        rtc.AudioStream calls _process synchronously on the event loop for every
        frame, and RoomIO's AGC runs on what we return, so the output frame has
        EXACTLY the input's rate/channels/length. Frames of any length are
        re-chunked to 480 via an input FIFO; the output FIFO is primed with 480
        zeros, so the output is the denoised input delayed by a constant 10 ms
        of FIFO — plus RNNoise's own ~20 ms lookahead, ~30 ms end to end
        (measured by cross-correlation on a real call; a uniform shift, not
        jitter, so endpointing is unaffected beyond that constant).
        """

        def __init__(self, backend: Any = None) -> None:
            self._backend = backend if backend is not None else _load_backend()
            self._state = self._backend.create()
            self._enabled = True
            self._dead = False  # sticky: bad format, error, or closed
            self._closed = False
            self._pending = np.zeros(0, dtype=np.int16)  # < 480 samples awaiting a chunk
            self._out = np.zeros(RNNOISE_FRAME_SIZE, dtype=np.int16)
            self._frames = 0
            self._passthrough = 0
            self._total_s = 0.0
            self._max_s = 0.0
            self._chunks = 0
            self._prob_sum = 0.0

        @property
        def enabled(self) -> bool:
            return self._enabled and not self._dead

        @enabled.setter
        def enabled(self, value: bool) -> None:
            self._enabled = bool(value)

        def _process(self, frame: rtc.AudioFrame) -> rtc.AudioFrame:
            if not self.enabled:
                self._passthrough += 1
                return frame
            try:
                if (
                    frame.sample_rate != PHONE_INPUT_SAMPLE_RATE
                    or frame.num_channels != 1
                ):
                    # Re-chunking assumes 48 kHz mono; anything else passes
                    # through untouched for the rest of the stream.
                    self._dead = True
                    self._passthrough += 1
                    logger.warning(
                        "phone_noise_suppression_bad_format sample_rate=%s "
                        "num_channels=%s disabled=true",
                        frame.sample_rate, frame.num_channels,
                    )
                    return frame
                t0 = time.perf_counter()
                out = self._denoise(frame)
                dt = time.perf_counter() - t0
                self._frames += 1
                self._total_s += dt
                self._max_s = max(self._max_s, dt)
                return out
            except Exception:
                # Once: _dead stops AudioStream calling us (it checks enabled
                # per frame), so its per-frame warning never fires either.
                self._dead = True
                self._passthrough += 1
                logger.error(
                    "phone_noise_suppression_failed disabled=true", exc_info=True
                )
                return frame

        def _denoise(self, frame: rtc.AudioFrame) -> rtc.AudioFrame:
            n = frame.samples_per_channel
            x = np.frombuffer(frame.data, dtype=np.int16, count=n)
            buf = np.concatenate((self._pending, x)) if self._pending.size else x
            m = buf.size - buf.size % RNNOISE_FRAME_SIZE
            if m:
                f = buf[:m].astype(np.float32)  # int16 scale, as RNNoise expects
                for i in range(0, m, RNNOISE_FRAME_SIZE):
                    self._prob_sum += self._backend.process(
                        self._state, f[i:i + RNNOISE_FRAME_SIZE]
                    )
                self._chunks += m // RNNOISE_FRAME_SIZE
                np.rint(f, out=f)
                np.clip(f, -32768, 32767, out=f)
                self._out = np.concatenate((self._out, f.astype(np.int16)))
            self._pending = buf[m:].copy()
            # Invariant: len(_out) == 480 + n - len(_pending) > n before this cut.
            data = bytearray(2 * n)  # mutable: RoomIO's AGC processes it in place
            np.frombuffer(data, dtype=np.int16)[:] = self._out[:n]
            self._out = self._out[n:]
            return rtc.AudioFrame(
                data, frame.sample_rate, 1, n, userdata=frame.userdata
            )

        def _close(self) -> None:
            # RoomIO may close on track replace AND on aclose: exactly once.
            if self._closed:
                return
            self._closed = True
            self._dead = True
            state, self._state = self._state, None
            try:
                self._backend.destroy(state)
            except Exception:
                logger.warning("phone_noise_suppression_destroy_failed", exc_info=True)
            logger.info(
                "phone_noise_suppression_summary frames_processed=%d "
                "frames_passthrough=%d total_ms=%.1f max_frame_ms=%.3f "
                "mean_speech_prob=%.3f",
                self._frames, self._passthrough, self._total_s * 1000.0,
                self._max_s * 1000.0,
                self._prob_sum / self._chunks if self._chunks else 0.0,
            )

    _processor_class = RNNoiseFrameProcessor
    return _processor_class


def __getattr__(name: str) -> Any:  # PEP 562: lazy public class name
    if name == "RNNoiseFrameProcessor":
        return _get_processor_class()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# ── Public entry point ────────────────────────────────────────────────────────


def phone_room_options() -> Any | None:
    """RoomOptions enabling RNNoise on the phone input, or None (see module doc).
    Never raises."""
    try:
        if phone_noise_suppression_mode() == "off":
            logger.info("phone_noise_suppression_disabled reason=env_off")
            return None
        try:
            backend = _load_backend()
        except RNNoiseUnavailable as exc:
            logger.error("phone_noise_suppression_unavailable reason=%s", exc.reason)
            return None

        from livekit.agents.voice import room_io

        processor_cls = _get_processor_class()

        def _select(_params: Any) -> Any:
            # RoomIO calls this per track stream and takes OWNERSHIP of what
            # we return (closing it on replace), so each call gets its own.
            try:
                return processor_cls(backend=backend)
            except Exception:
                logger.error(
                    "phone_noise_suppression_unavailable reason=processor_create_failed",
                    exc_info=True,
                )
                return None  # this track streams unfiltered

        options = room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                sample_rate=PHONE_INPUT_SAMPLE_RATE,
                noise_cancellation=_select,
            )
        )
        logger.info(
            "phone_noise_suppression_enabled engine=rnnoise sample_rate=%d",
            PHONE_INPUT_SAMPLE_RATE,
        )
        return options
    except Exception:
        logger.error(
            "phone_noise_suppression_unavailable reason=unexpected_error", exc_info=True
        )
        return None
