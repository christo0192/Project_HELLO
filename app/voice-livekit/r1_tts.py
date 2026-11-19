"""R1 text-to-speech seams (plan 5.15): the early-flush node and the Sarvam voice settings.

The mechanism this exists for (livekit-agents 1.6.4, verified against the installed source):

* ``sarvam.TTS`` reports ``capabilities.streaming=True``, so the SDK's default ``tts_node``
  pushes the text stream straight into a ``sarvam.SynthesizeStream``.
* That stream runs its own sentence tokenizer, which emits a sentence to the Sarvam socket only
  once the NEXT sentence has begun or the input has ended (it cannot tell that the last
  sentence in its buffer is finished).  The R1 output guard already releases a sentence only
  after the next one has begun (``StreamGuard.feed``), so without help the first sentence of a
  reply waits for the end of the whole generation before any audio is requested.  That gap is
  the roughly 2.9 s the phone lane measured (``phone.py``, ``phone_tts_flush_min_chars``).
* ``end_input`` flushes the tokenizer.  So the first speakable fragment is synthesised ALONE
  (its own downstream call, ended at once) and the rest of the reply goes to ONE further call:
  at most two downstream syntheses per reply, never one per sentence.

This is the phone lane's first-fragment idea, copied and not imported (R1 never imports
``phone``), with the three differences R1's text needs:

* a boundary only counts when whitespace (or the end of the text) follows it, so the comma in
  "$9,000", the point in "3.5 years" and the dots of "e.g." never split a number or a word;
* a fragment is never cut inside a word: the length cap backs off to the last space, and
  where no cut leaves a natural fragment the text simply goes on to the next boundary;
* text is never dropped or reordered: the concatenation of everything handed downstream equals
  the input.

A fragment must contain a letter (Sarvam rejects a letter-free text with a 400), and a short
leading filler ("Mm,") merges forward into the first real clause, because Sarvam re-primes its
prosody per call and a two-letter first fragment sounds choppy.

R1's two voices (owner decision 2026-10-30) are resolved here too, in pure code:

* ``R1_TTS_PROFILE`` picks a WHOLE voice set, atomically.  ``v4`` (the default) is Bulbul v4
  Flash with Christy as ``simran_en_customer`` and the learner as ``zarina_en_conversation``;
  ``v3`` is exactly today's voice (``r1_tts_kwargs``, the browser screener's Simran) for both.
  A model and a speaker are never set apart, because each half-applied flip fails badly on
  plugin 1.6.4 (measured live 2026-10-29): bulbul:v3 with a v4 id raises ``ValueError`` when
  the TTS is built, and bulbul:v4-flash with ``simran`` fails EVERY utterance in-band with a
  400 that the plugin surfaces as a retryable status 500 (dead air, retried three times).
* The plugin does not validate speakers for a model it does not know (``bulbul:v4-flash`` is
  not in its compatibility table), so R1 allowlists its v4 ids itself (``V4_SPEAKERS``).
* Who is speaking is bound per speech, in a ``ContextVar`` of the speech's own TTS task
  (``bind_voice``): ``r1_sarvam.R1SarvamTTS.stream`` reads it, so concurrent speeches never
  cross voices and the session's TTS instance is never mutated.

This module logs nothing and imports no R1 module: ``r1_session`` supplies the callbacks, and
turns the voice set's ``notes`` into log lines.
"""
from __future__ import annotations

import contextlib
import contextvars
import inspect
import os
from dataclasses import dataclass
from typing import Any, AsyncIterable, AsyncIterator, Callable, Mapping

FLUSH_MIN_CHARS_DEFAULT = 60
FIRST_FRAGMENT_MIN_ALPHA = 14
SENTENCE_END = frozenset(".!?…")
CLAUSE_PAUSE = frozenset(",;:")


def flush_min_chars() -> int:
    """The early-flush length cap in non-space characters; 0 disables the node (the rollback).

    Read at the call site with the literal name so the env-contract scanner sees it.
    """
    raw = os.getenv("R1_TTS_FLUSH_MIN_CHARS")
    try:
        value = int(raw) if raw is not None and raw.strip() != "" else FLUSH_MIN_CHARS_DEFAULT
    except ValueError:
        return FLUSH_MIN_CHARS_DEFAULT
    return min(400, max(0, value))


def r1_tts_kwargs() -> dict[str, Any]:
    """R1's ROLLBACK voice (``R1_TTS_PROFILE=v3``): today's Sarvam settings, for both voices.

    The browser lane's variables and defaults, ``pace`` 1.0 and ``temperature`` 0.8.  Under v3
    the session's TTS is ``sarvam.TTS(**r1_tts_kwargs())`` byte for byte, and the line cache
    keys and synthesises with the same dict, so a cached line has exactly a live line's voice.
    """
    return {
        "model": os.getenv("SARVAM_TTS_MODEL", "bulbul:v3"),
        "speaker": os.getenv("SARVAM_TTS_VOICE", "simran"),
        "pace": 1.0,
        "temperature": 0.8,
    }


# ------------------------------------------------------------------------------- voices

INTERVIEWER = "interviewer"
LEARNER = "learner"
VOICES = (INTERVIEWER, LEARNER)

PROFILE_V4 = "v4"
PROFILE_V3 = "v3"
PROFILE_DEFAULT = PROFILE_V4

# The API model id.  There is no plain "bulbul:v4"; v4 Flash is the only v4 the API serves.
V4_MODEL = "bulbul:v4-flash"
V4_PACE = 1.0  # v4 accepts 0.5-2.0; R1 speaks at the v3 voice's pace
V4_DEFAULT_SPEAKERS: Mapping[str, str] = {
    INTERVIEWER: "simran_en_customer",  # "Simran - A confident and low female voice"
    LEARNER: "zarina_en_conversation",  # "Zarina - A deep, full and flowing female voice"
}
# Every English id the live server listed for bulbul:v4-flash on 2026-10-29 (the list came back
# inside a 400 and was cut short after ``simran_en_sales``), plus the server-listed ids the
# smoke test named beyond that cut.  ``simran`` (the v3 short name) is NOT here: v4 rejects it.
# A new id is a code change on purpose: the plugin does not validate v4 ids, and a wrong one is
# dead air on every line (an in-band 400, retried three times).
V4_SPEAKERS = frozenset(
    {
        "aditi_en_stories",
        "amelia_en_conversational",
        "aparna_en_companion",
        "aparna_en_edtech",
        "ashwin_en_sports",
        "ashwin_en_sports_energetic",
        "chandrika_en_stories",
        "dev_en_conversational",
        "dev_en_recovery",
        "deven_en_conversation",
        "ishita_en_customer",
        "ishita_en_medical",
        "ishita_en_numbers",
        "ishita_en_social",
        "ishita_en_stories",
        "kalpit_en_edtech",
        "nachiket_en_ads",
        "neha_en_customer",
        "neha_en_latenight",
        "nupur_en_kids",
        "ojas_en_social",
        "ritu_en_edtech",
        "ritu_en_latenight",
        "ritu_en_medical",
        "ritu_en_reels",
        "rohan_en_recovery",
        "roopa_en_conversational",
        "rustom_en_suspense",
        "sanchita_en_companion",
        "sanchita_en_insurance",
        "sanchita_en_market",
        "sanchita_en_recovery",
        "sanchita_en_social",
        "shabana_en_edtech",
        "shalini_en_companion",
        "shalini_en_customer",
        "shubh_en_ads",
        "shubh_en_audiobook",
        "shubh_en_narration",
        "shubh_en_narration_gentle",
        "shubh_en_numbers",
        "shubh_en_recovery",
        "shubh_en_sports",
        "simran_en_ads",
        "simran_en_automobile",
        "simran_en_conversation",
        "simran_en_customer",
        "simran_en_edtech",
        "simran_en_edtech_bot",
        "simran_en_narration",
        "simran_en_recovery",
        "simran_en_sales",
        "simran_enhi_customer",
        "sophia_en_conversational",
        "zarina_en_conversation",
    }
)

NOTE_PROFILE_UNKNOWN = "profile_unknown"


def voice_role(voice: Any) -> str:
    """``voice`` as one of ``VOICES``; anything else is the interviewer (never raises)."""
    return voice if voice in VOICES else INTERVIEWER


@dataclass(frozen=True)
class R1VoiceSet:
    """Who R1's two voices are: one Sarvam kwargs dict per role, both on ONE model.

    ``profile`` is ``v4`` or ``v3``; ``notes`` are labels for settings that were refused
    (``profile_unknown``, ``interviewer_voice_rejected``, ``learner_voice_rejected``).  Two
    models can never be mixed: the plugin's socket pool is keyed on the model, and a set that
    tried would be a half-applied flip, so ``__post_init__`` refuses it.
    """

    profile: str
    interviewer: Mapping[str, Any]
    learner: Mapping[str, Any]
    notes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "interviewer", dict(self.interviewer))
        object.__setattr__(self, "learner", dict(self.learner))
        object.__setattr__(self, "notes", tuple(self.notes))
        if self.interviewer.get("model") != self.learner.get("model"):
            raise ValueError("both R1 voices must use one TTS model")

    def kwargs(self, voice: Any = INTERVIEWER) -> dict[str, Any]:
        """A copy of the Sarvam kwargs of ``voice`` (an unknown role is the interviewer)."""
        return dict(self.learner if voice_role(voice) == LEARNER else self.interviewer)

    def speaker(self, voice: Any = INTERVIEWER) -> str:
        return str(self.kwargs(voice).get("speaker"))

    @property
    def model(self) -> str:
        return str(self.interviewer.get("model"))

    @property
    def distinct(self) -> bool:
        """True when the two roles really are two voices (v4), False when they share one (v3)."""
        return self.interviewer != self.learner


def legacy_voice_set(notes: tuple[str, ...] = ()) -> R1VoiceSet:
    """The v3 set: BOTH roles are exactly ``r1_tts_kwargs()`` (today's voice, the rollback)."""
    kwargs = r1_tts_kwargs()
    return R1VoiceSet(PROFILE_V3, kwargs, dict(kwargs), notes)


def _v4_speaker(role: str, raw: str | None, notes: list[str]) -> str:
    """An override of ``role``'s v4 id, if it is allowlisted; otherwise the owner's default.

    Unset or empty is the default with no note.  A value is stripped; one that is blank or not
    in ``V4_SPEAKERS`` (``simran``, a typo) keeps the default and notes ``<role>_voice_rejected``.
    """
    if raw is None or raw == "":
        return V4_DEFAULT_SPEAKERS[role]
    value = raw.strip()
    if value in V4_SPEAKERS:
        return value
    notes.append(f"{role}_voice_rejected")
    return V4_DEFAULT_SPEAKERS[role]


def r1_voice_set() -> R1VoiceSet:
    """R1's voices for this session, read from the environment (once per session).

    ``R1_TTS_PROFILE`` unset, empty or ``v4`` is the v4 set; ``v3`` is the legacy set; any other
    value is the legacy set too, noted ``profile_unknown`` (an unknown value is most likely a
    typo made during a rollback, so the known-good voice wins).  The overrides
    ``R1_TTS_INTERVIEWER_VOICE`` and ``R1_TTS_LEARNER_VOICE`` apply in v4 only, and v4 ignores
    ``SARVAM_TTS_*`` (those stay the browser screener's voice).  v4 sends no temperature (the
    plugin never sends one for a non-v3 model) and keeps the plugin's en-IN and 22050 Hz.
    """
    profile = (os.getenv("R1_TTS_PROFILE") or "").strip().lower()
    if profile == PROFILE_V3:
        return legacy_voice_set()
    if profile not in ("", PROFILE_V4):
        return legacy_voice_set((NOTE_PROFILE_UNKNOWN,))
    notes: list[str] = []
    interviewer = _v4_speaker(INTERVIEWER, os.getenv("R1_TTS_INTERVIEWER_VOICE"), notes)
    learner = _v4_speaker(LEARNER, os.getenv("R1_TTS_LEARNER_VOICE"), notes)
    return R1VoiceSet(
        PROFILE_V4,
        {"model": V4_MODEL, "speaker": interviewer, "pace": V4_PACE},
        {"model": V4_MODEL, "speaker": learner, "pace": V4_PACE},
        tuple(notes),
    )


# Whose line the TTS of THIS task is speaking.  Set by ``r1_session`` at the top of its
# ``tts_node`` (which the SDK calls synchronously inside each speech's own TTS task), so it is
# local to that speech: a concurrent speech has its own task context and its own value.
_BOUND_VOICE: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "r1_tts_voice", default=None
)


def bind_voice(voice: Any) -> None:
    """Bind ``voice`` (a role, or None) to the current task's context from here on."""
    _BOUND_VOICE.set(voice if voice in VOICES else None)


def current_voice() -> str | None:
    """The voice bound in this task's context, or None when nothing bound one."""
    return _BOUND_VOICE.get()


def speakable(text: str) -> bool:
    """True when ``text`` carries a letter, the least Sarvam accepts as speech."""
    return any(ch.isalpha() for ch in text)


class FirstFragmentScanner:
    """Find the end of the first speakable fragment of a text that arrives in chunks.

    ``feed`` returns ``(fragment, rest)`` as soon as the fragment is settled, where ``rest``
    is the unread tail of the chunk just fed (the caller continues with the stream after it);
    ``finish`` returns everything buffered when the text ended first.
    """

    def __init__(self, min_chars: int) -> None:
        self._min_chars = min_chars
        self._buffer = ""
        self._dense = 0  # non-space characters buffered
        self._alpha = 0  # letters buffered
        # The last character is a boundary that still needs one character of lookahead.
        self._pending = False

    def finish(self) -> str:
        text, self._buffer = self._buffer, ""
        return text

    def feed(self, chunk: str) -> tuple[str, str] | None:
        for position, ch in enumerate(chunk):
            if self._pending:
                self._pending = False
                if ch.isspace():
                    return self.finish(), chunk[position:]
                # Not followed by whitespace: a digit separator, a decimal point, an
                # abbreviation.  Not a boundary; this character is processed normally.
            self._buffer += ch
            if not ch.isspace():
                self._dense += 1
            if ch.isalpha():
                self._alpha += 1
            if self._alpha == 0:
                continue  # digits and punctuation before the first letter merge forward
            if ch in SENTENCE_END or (ch in CLAUSE_PAUSE and self._alpha >= FIRST_FRAGMENT_MIN_ALPHA):
                self._pending = True
                continue
            if self._min_chars > 0 and self._dense >= self._min_chars:
                cut = self._word_cut()
                if cut is not None:
                    head, tail = self._buffer[:cut], self._buffer[cut:]
                    self._buffer = ""
                    return head, tail + chunk[position + 1 :]
        return None

    def _word_cut(self) -> int | None:
        """Where the length cap may cut: just after the last space, if that leaves a good head."""
        last_space = max((i for i, ch in enumerate(self._buffer) if ch.isspace()), default=-1)
        if last_space < 0:
            return None
        head = self._buffer[: last_space + 1]
        if sum(1 for ch in head if ch.isalpha()) < FIRST_FRAGMENT_MIN_ALPHA:
            return None
        return last_space + 1


async def aiter_text(text: Any) -> AsyncIterator[str]:
    """Normalise a TTS-node text source (async iterable, iterable or ``str``) to str chunks."""
    if isinstance(text, str):
        yield text
        return
    if hasattr(text, "__aiter__"):
        async for chunk in text:
            if chunk:
                yield chunk if isinstance(chunk, str) else str(chunk)
        return
    for chunk in text:
        if chunk:
            yield chunk if isinstance(chunk, str) else str(chunk)


async def _once(text: str) -> AsyncIterator[str]:
    yield text


async def _chain(head: str, source: AsyncIterator[str]) -> AsyncIterator[str]:
    """``head`` first, then whatever ``source`` has not produced yet."""
    if head:
        yield head
    async for chunk in source:
        yield chunk


@contextlib.asynccontextmanager
async def _closing(obj: Any) -> AsyncIterator[Any]:
    """Close an async generator when its consumer stops early (a barge-in tears this down)."""
    try:
        yield obj
    finally:
        aclose = getattr(obj, "aclose", None)
        if callable(aclose):
            with contextlib.suppress(Exception):
                await aclose()


SynthFn = Callable[[AsyncIterable[str]], Any]


async def flush_tts(
    text: Any,
    synth: SynthFn,
    *,
    min_chars: int,
    on_first_text: Callable[[], None] | None = None,
    on_first_frame: Callable[[], None] | None = None,
) -> AsyncIterator[Any]:
    """Drive ``synth`` (the SDK's default ``tts_node``) with the first fragment flushed early.

    ``synth(stream)`` returns the downstream node's frames (an async iterable, or an awaitable
    of one).  ``min_chars <= 0`` hands the whole stream to ONE call unchanged, the rollback.
    ``on_first_text`` fires when the first text reaches this node and ``on_first_frame`` when
    the first audio frame leaves it; both fire at most once, and a failing callback never
    disturbs the audio.
    """
    seen = {"text": False, "frame": False}

    def note_text(chunk: str) -> None:
        if chunk and not seen["text"]:
            seen["text"] = True
            _call(on_first_text)

    def note_frame() -> None:
        if not seen["frame"]:
            seen["frame"] = True
            _call(on_first_frame)

    async def frames_of(stream: AsyncIterable[str]) -> AsyncIterator[Any]:
        result = synth(stream)
        if inspect.isawaitable(result):
            result = await result
        async with _closing(result) as frames:
            async for frame in frames:
                note_frame()
                yield frame

    source = aiter_text(text)
    try:
        if min_chars <= 0:

            async def noted() -> AsyncIterator[str]:
                async for chunk in source:
                    note_text(chunk)
                    yield chunk

            async with _closing(frames_of(noted())) as frames:
                async for frame in frames:
                    yield frame
            return

        scanner = FirstFragmentScanner(min_chars)
        found: tuple[str, str] | None = None
        async for chunk in source:
            note_text(chunk)
            found = scanner.feed(chunk)
            if found is not None:
                break
        if found is None:
            # The text ended before any boundary: ONE call, and only if it can be spoken.
            whole = scanner.finish()
            if speakable(whole):
                async with _closing(frames_of(_once(whole))) as frames:
                    async for frame in frames:
                        yield frame
            return

        first, rest = found
        async with _closing(frames_of(_once(first))) as frames:
            async for frame in frames:
                yield frame

        # The remainder: only after the first fragment's audio is out, so waiting for more
        # text here costs the first audio nothing.  A remainder with no letter in it (the
        # trailing space after a closed sentence, a lone "2019.") is joined with what follows
        # and is never sent on its own.
        if not speakable(rest):
            async for chunk in source:
                rest += chunk
                if speakable(rest):
                    break
        if speakable(rest):
            async with _closing(frames_of(_chain(rest, source))) as frames:
                async for frame in frames:
                    yield frame
    finally:
        aclose = getattr(source, "aclose", None)
        if callable(aclose):
            with contextlib.suppress(Exception):
                await aclose()


def _call(callback: Callable[[], None] | None) -> None:
    if callback is None:
        return
    try:
        callback()
    except Exception:  # noqa: BLE001 - instrumentation must never disturb the audio
        pass
