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

This module logs nothing and imports no R1 module: ``r1_session`` supplies the callbacks.
"""
from __future__ import annotations

import contextlib
import inspect
import os
from typing import Any, AsyncIterable, AsyncIterator, Callable

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
    """The Sarvam voice settings of R1: the session's TTS and the line cache share them.

    One source, so a cached line is synthesised with exactly the voice a live line has (the
    browser lane's variables and defaults, ``pace`` 1.0 and ``temperature`` 0.8).
    """
    return {
        "model": os.getenv("SARVAM_TTS_MODEL", "bulbul:v3"),
        "speaker": os.getenv("SARVAM_TTS_VOICE", "simran"),
        "pace": 1.0,
        "temperature": 0.8,
    }


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
