"""R1's Sarvam providers: the voiced TTS, the TTS build with its fallback, and the STT model.

Owner decision 2026-10-30: R1 (and only R1) speaks with Bulbul v4 Flash, Christy as
``simran_en_customer`` and the role-play learner as ``zarina_en_conversation``, behind the
``R1_TTS_PROFILE`` flip back to today's voice (``v3``).  R1's STT is Saaras v4 by default, with
``R1_STT_MODEL=saaras:v3`` the rollback (verified live 2026-10-30 on the production account).

The transport is the pinned plugin (livekit-plugins-sarvam 1.6.4), unchanged.  The live smoke
test of 2026-10-29 proved ``sarvam.TTS(model="bulbul:v4-flash", speaker=...)`` works on both
routes R1 uses: ``stream()`` over WS ``/text-to-speech/ws?model=bulbul:v4-flash`` for live
speech, ``synthesize()`` over REST for the line cache; 22050 Hz mono in 50 ms frames.  Only one
thing is added, a speaker per STREAM on ONE TTS instance (``R1SarvamTTS``), and it is race-free
by the plugin's own construction (checked in the installed source, pinned by
``test_r1_sdk_contract``):

* ``SynthesizeStream.__init__`` copies the options (``self._opts = replace(tts._opts)``);
* ``_run_ws`` sends ``"speaker": self._opts.speaker`` in the config at the start of EVERY
  segment, a pooled (reused) socket included;
* the stream's main task is created in its ``__init__`` but cannot run before the synchronous
  assignment that follows ``super().stream()``;
* the instance's shared ``_opts`` is never changed (no ``update_options``), so there is no
  per-utterance "Unknown model" WARNING and no window in which another speech picks up the
  wrong speaker.  For a non-v3 model the plugin sends no temperature, as the docs expect.

Why ONE instance and not one per voice: the SDK subscribes to ``error`` and
``metrics_collected`` on the session's own TTS only, so a second, learner-only instance would
hide its failures from R1's provider-error handling (the 3-failure abort, the 401/402 abort,
the 429 counter) and from the SDK metrics.  One instance keeps the pool (``?model=`` is the same
for both voices), ``capabilities.streaming``, the sample rate and the error events as they are.

Which voice a stream speaks is ``r1_tts.current_voice()``: the voice ``r1_session`` binds at the
top of its ``tts_node``, inside the speech's own TTS task.  Unbound is the interviewer.

When livekit-agents moves to >= 1.8 with plugin 1.8.6 (native v4 on ``/text-to-speech/ws/v2``),
delete the subclass and revisit the two private seams it reads (``SynthesizeStream._opts`` and
the SDK's ``_SpeechHandleContextVar``).

Stdlib and ``r1_tts`` only at import time; the SDK is imported inside functions, so bare CI can
import this module.  This module logs nothing: ``on_fallback`` is its reporting seam.
"""
from __future__ import annotations

import contextlib
import functools
import os
from typing import Any, Callable

from r1_tts import (
    INTERVIEWER,
    PROFILE_V4,
    R1VoiceSet,
    current_voice,
    r1_tts_kwargs,
)

R1_STT_MODELS = frozenset({"saaras:v3", "saaras:v4"})
R1_STT_DEFAULT = "saaras:v4"
NOTE_STT_MODEL_REJECTED = "stt_model_rejected"


@functools.lru_cache(maxsize=1)
def _voiced_tts_class() -> type:
    """``R1SarvamTTS``, built once on first use (the plugin is imported only here).

    It subclasses the plugin module's own ``TTS`` (``livekit.plugins.sarvam.tts.TTS``), so a
    test that patches the package attribute ``sarvam.TTS`` never becomes its base class.
    """
    from livekit.agents import DEFAULT_API_CONNECT_OPTIONS
    from livekit.plugins.sarvam.tts import TTS as PluginTTS

    class R1SarvamTTS(PluginTTS):  # type: ignore[misc, valid-type]
        """One Sarvam TTS that speaks each stream in the voice bound to its speech."""

        def __init__(self, voice_set: R1VoiceSet) -> None:
            # model, interviewer speaker and pace; the plugin's en-IN and 22050 Hz defaults.
            super().__init__(**voice_set.kwargs(INTERVIEWER))
            self.r1_voice_set = voice_set

        def stream(self, *, conn_options: Any = DEFAULT_API_CONNECT_OPTIONS) -> Any:
            stream = super().stream(conn_options=conn_options)
            # The stream's own copy of the options: the instance's are never touched.
            stream._opts.speaker = self.r1_voice_set.speaker(current_voice() or INTERVIEWER)
            return stream

    R1SarvamTTS.__qualname__ = "R1SarvamTTS"
    return R1SarvamTTS


def build_r1_tts(
    voice_set: R1VoiceSet | None,
    on_fallback: Callable[[BaseException], None] | None = None,
) -> Any:
    """The session's TTS for ``voice_set``.

    v3 (or no set) is literally ``sarvam.TTS(**r1_tts_kwargs())``: today's class and today's
    kwargs.  v4 is one ``R1SarvamTTS``; if building it raises, ``on_fallback(exc)`` is told and
    this session gets the plain v3 TTS instead, so the session (and the line cache, which reads
    the voice set off the TTS) is wholly in today's voice.
    """
    from livekit.plugins import sarvam

    if voice_set is None or voice_set.profile != PROFILE_V4:
        return sarvam.TTS(**r1_tts_kwargs())
    try:
        return _voiced_tts_class()(voice_set)
    except Exception as exc:  # noqa: BLE001 - any build failure is the known-good voice
        if on_fallback is not None:
            with contextlib.suppress(Exception):
                on_fallback(exc)
        return sarvam.TTS(**r1_tts_kwargs())


@functools.lru_cache(maxsize=1)
def _speech_handle_var() -> Any:
    """The SDK's speech-handle ``ContextVar``, or None without the SDK (imported once)."""
    try:
        from livekit.agents.voice.agent_activity import _SpeechHandleContextVar
    except Exception:  # noqa: BLE001 - no SDK (bare CI) or SDK drift: no speech is known
        return None
    return _SpeechHandleContextVar


def current_speech_id() -> str | None:
    """The id of the speech whose task is running now, or None.

    livekit-agents 1.6.4 sets ``_SpeechHandleContextVar`` in ``_create_speech_task`` for every
    speech task, and the SDK's own nodes read it the same way; R1 reads it in its ``tts_node``
    (and in the LLM guard), which run in child tasks of the speech's task.
    """
    var = _speech_handle_var()
    if var is None:
        return None
    try:
        handle = var.get(None)
    except Exception:  # noqa: BLE001
        return None
    speech_id = getattr(handle, "id", None)
    return None if speech_id is None else str(speech_id)


def r1_stt_model() -> tuple[str, str | None]:
    """R1's STT model and a refusal note: Saaras v4 by default, ``saaras:v3`` the rollback.

    Owner decision 2026-10-30: R1 runs ``saaras:v4`` (R1_STT_DEFAULT).  It was verified live on
    the production Sarvam account through plugin 1.6.4's legacy socket ``/speech-to-text/ws``
    (no mode is sent for it): exact transcripts, the same as ``saaras:v3`` on the same audio.
    ``R1_STT_MODEL`` unset or empty is that default; a value in ``R1_STT_MODELS`` (after
    stripping) is used, so ``fly secrets set R1_STT_MODEL=saaras:v3`` is the rollback; anything
    else falls back to today's browser-lane expression ``os.getenv("SARVAM_STT_MODEL",
    "saaras:v3")`` with the note ``stt_model_rejected``, so a typo lands on the known-good model.
    """
    raw = os.getenv("R1_STT_MODEL")
    fallback = os.getenv("SARVAM_STT_MODEL", "saaras:v3")
    if raw is None or raw == "":
        return R1_STT_DEFAULT, None
    value = raw.strip()
    if value in R1_STT_MODELS:
        return value, None
    return fallback, NOTE_STT_MODEL_REJECTED
