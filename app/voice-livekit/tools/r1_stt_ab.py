#!/usr/bin/env python3
"""A/B the same audio through two Sarvam STT models (the Saaras v4 TRIAL, owner 2026-10-30).

R1's production STT stays ``saaras:v3``.  ``R1_STT_MODEL`` (``r1_sarvam.r1_stt_model``) can point
R1 alone at ``saaras:v4``, but only after this tool, then a local rehearsal, pass and the owner
decides; never set it on project-hello-voice before that.  This tool is NOT in the worker image
and the worker never imports it.  Its pure helpers import without the SDK; the transports import
the SDK (livekit-agents 1.6.4, livekit-plugins-sarvam 1.6.4, aiohttp) lazily.

Usage:
    python tools/r1_stt_ab.py CLIP.wav [CLIP.wav ...] [--models saaras:v3,saaras:v4]
        [--transport stream|rest|realtime] [--language en-IN] [--env-file PATH]
        [--max-audio-seconds 120] [--sequential] [--no-text] [--json OUT]

Input: 16-bit PCM WAVs at any rate (stereo is downmixed).  The expected text of ``CLIP.wav`` is
read from a sidecar ``CLIP.txt`` when there is one (no sidecar: no WER for that clip).  Use only
synthetic or consented staff audio: transcripts are printed (``--no-text`` prints numbers only).

The key: ``SARVAM_API_KEY`` from the environment, else the ``SARVAM_API_KEY=`` line of
``--env-file`` (no other line of that file is read).  It is never printed: every string this
tool writes, errors included, passes through ``redact``.

Budget: live calls cost credits.  Before any network call the tool prints the audio it will
send (each clip plus its lead and tail silence, times the number of models) and exits 2 when
that exceeds ``--max-audio-seconds``.

Transports:

* ``stream`` (default, R1's real path): ``sarvam.STT(model, language).stream()``, fed 10 ms
  frames at real-time pace (the SDK resamples to the plugin's 16 kHz), with 0.5 s of silence
  before and 2.5 s after, then ``end_input``.  Records the FINAL transcripts in order, START
  and END of speech, the words of each final (R1's stt_sanity gate counts rows of two words or
  fewer), the time from the end of the audio to the last final, errors (type and status code)
  and the plugin's WS URL (it carries no key).  "0 finals" is reported apart from an error.
  On plugin 1.6.4 ``saaras:v4`` goes to the LEGACY socket ``/speech-to-text/ws`` with no mode.
* ``rest``: the plugin's ``recognize()`` (POST ``/speech-to-text``): raw model accuracy, no
  streaming.
* ``realtime``: a small aiohttp client for ``wss://api.sarvam.ai/speech-to-text-realtime/ws``
  (Sarvam's documented v4 streaming endpoint; protocol cross-checked against
  ``phone_stt_shadow.py``'s constants, which is not imported), in 100 ms ``audio_input``
  chunks at real-time pace, then ``end``; collects ``transcript.final`` until ``session.end``.
  Its only purpose is to tell whether an R1 adapter for that endpoint is worth writing.

Output: per clip the expected text, each model's transcript, its WER against the expected text
(both normalised with the folding of ``r1_session.fold_speech``) and a word diff between the
first two models (``-`` only in the first, ``+`` only in the second); then per model the mean
WER, the failures and the median final latency.  ``--json`` writes everything.

Exit codes: 0 ok, 2 usage, budget or missing key, 3 when a model failed every clip.

Trial gates for v4 (runbook, "Voices: Bulbul v4 Flash"): finals are produced, WER no worse than
v3, final latency at most v3 + 0.3 s, no extra fragmentation (finals per clip).
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import difflib
import json
import logging
import os
import re
import statistics
import sys
import time
import unicodedata
import wave
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterator, Sequence, TextIO

DEFAULT_MODELS = ("saaras:v3", "saaras:v4")
TRANSPORTS = ("stream", "rest", "realtime")
LEAD_SECONDS = 0.5
TAIL_SECONDS = 2.5
FRAME_MS = 10
REALTIME_CHUNK_MS = 100
REALTIME_RATE = 16000
REALTIME_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws"
CALL_TIMEOUT_SEC = 90.0
EXIT_OK, EXIT_USAGE, EXIT_ALL_FAILED = 0, 2, 3
REDACTED = "[redacted]"

# The folding of ``r1_session.fold_speech`` (copied, never imported: the tool stays out of the
# worker's import graph).  ``tests/test_r1_stt_ab`` checks the two agree on a corpus.
_APOSTROPHES = frozenset("'’‘ʼ`´")
_EDGE_APOSTROPHES = re.compile(r"(?<!\w)'+|'+(?!\w)")
_KEY_PARAM = re.compile(r"(?i)(api[-_]subscription[-_]key[\"']?\s*[:=]\s*[\"']?)[^\s\"'&,}]+")

Transport = Callable[..., Awaitable[dict[str, Any]]]


class UsageError(Exception):
    """A problem with the command line or the input files (exit code 2)."""


# ------------------------------------------------------------------------------ secrets


def redact(text: Any, secrets: Sequence[str] = ()) -> str:
    """``text`` as a string with every secret (and any key-shaped header value) removed."""
    out = str(text)
    for secret in secrets:
        if secret:
            out = out.replace(secret, REDACTED)
    return _KEY_PARAM.sub(lambda m: m.group(1) + REDACTED, out)


def read_key(env_file: str | None) -> str | None:
    """``SARVAM_API_KEY`` from the environment, else from the ``SARVAM_API_KEY=`` line of
    ``env_file``.  No other line of the file is parsed, kept or returned."""
    key = (os.environ.get("SARVAM_API_KEY") or "").strip()
    if key:
        return key
    if not env_file:
        return None
    try:
        with open(env_file, encoding="utf-8-sig") as handle:
            for line in handle:
                stripped = line.strip()
                if stripped.startswith("export "):
                    stripped = stripped[len("export ") :].lstrip()
                if not stripped.startswith("SARVAM_API_KEY="):
                    continue
                value = stripped[len("SARVAM_API_KEY=") :].strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                return value or None
    except OSError:
        return None
    return None


class _RedactingFilter(logging.Filter):
    """Scrub the key from every log record the SDK or plugin writes while the tool runs."""

    def __init__(self, secrets: Sequence[str]) -> None:
        super().__init__()
        self._secrets = tuple(secrets)

    def filter(self, record: logging.LogRecord) -> bool:
        # A Formatter appends the traceback (exc_info / a cached exc_text) and stack_info
        # AFTER the filters ran, so scrubbing getMessage() alone left logger.exception() and
        # exc_info=True records (the plugin's stt.py logs that way) printing the raw text.
        # Fold both into the message here, in the order format() would add them, redact the
        # whole, and clear the fields so no formatter can render them again.
        parts = [record.getMessage()]
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            parts.append(record.exc_text)
        if record.stack_info:
            parts.append(record.stack_info)
        record.msg = redact("\n".join(parts), self._secrets)
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        return True


# --------------------------------------------------------------------------------- audio


def read_wav(path: Path) -> tuple[bytes, int]:
    """Mono signed 16-bit PCM and its rate; stereo is downmixed, anything else is refused."""
    try:
        with wave.open(str(path), "rb") as handle:
            width, channels = handle.getsampwidth(), handle.getnchannels()
            rate, frames = handle.getframerate(), handle.getnframes()
            compression = handle.getcomptype()
            data = handle.readframes(frames)
    except (wave.Error, EOFError, OSError) as exc:
        raise UsageError(f"{path.name}: not a readable WAV ({type(exc).__name__})") from None
    if width != 2 or compression != "NONE":
        raise UsageError(f"{path.name}: must be 16-bit PCM (got {width * 8}-bit {compression})")
    if channels not in (1, 2) or rate <= 0 or not data:
        raise UsageError(f"{path.name}: must be mono or stereo with audio in it")
    if channels == 2:
        data = downmix(data)
    return data, rate


def downmix(stereo: bytes) -> bytes:
    """Average the two channels of interleaved 16-bit stereo PCM."""
    import array

    samples = array.array("h")
    samples.frombytes(stereo[: len(stereo) // 4 * 4])
    if sys.byteorder == "big":
        samples.byteswap()
    mono = array.array("h", ((samples[i] + samples[i + 1]) // 2 for i in range(0, len(samples), 2)))
    if sys.byteorder == "big":
        mono.byteswap()
    return mono.tobytes()


def seconds_of(pcm: bytes, rate: int) -> float:
    return len(pcm) / (2.0 * rate)


def frames(
    pcm: bytes, rate: int, *, frame_ms: int = FRAME_MS, lead: float = LEAD_SECONDS,
    tail: float = TAIL_SECONDS,
) -> Iterator[bytes]:
    """``frame_ms`` chunks of mono PCM, with ``lead`` and ``tail`` seconds of silence around
    the audio; the last chunk of audio is zero-padded to a whole frame."""
    step = max(1, rate * frame_ms // 1000)
    size = step * 2
    silence = b"\x00\x00" * step
    for _ in range(round(lead * 1000 / frame_ms)):
        yield silence
    for start in range(0, len(pcm), size):
        chunk = pcm[start : start + size]
        yield chunk + b"\x00" * (size - len(chunk))
    for _ in range(round(tail * 1000 / frame_ms)):
        yield silence


def speech_frame_count(pcm: bytes, rate: int, frame_ms: int = FRAME_MS) -> int:
    """How many frames of ``frames()`` come before the audio ends (the lead plus the audio)."""
    step = max(1, rate * frame_ms // 1000)
    return round(LEAD_SECONDS * 1000 / frame_ms) + -(-len(pcm) // (step * 2))


# ------------------------------------------------------------------------------- scoring


def normalise(text: Any) -> str:
    """Lower case, punctuation and symbols to spaces, apostrophes folded (``fold_speech``)."""
    folded: list[str] = []
    for char in str(text or "").lower():
        if char in _APOSTROPHES:
            folded.append("'")
        elif unicodedata.category(char)[0] in ("P", "S"):
            folded.append(" ")
        else:
            folded.append(char)
    return " ".join(_EDGE_APOSTROPHES.sub(" ", "".join(folded)).split())


def wer(reference: str, hypothesis: str) -> float:
    """Word error rate of ``hypothesis`` against ``reference`` (both normalised first)."""
    ref, hyp = normalise(reference).split(), normalise(hypothesis).split()
    if not ref:
        return 0.0 if not hyp else 1.0
    previous = list(range(len(hyp) + 1))
    for i, word in enumerate(ref, start=1):
        current = [i] + [0] * len(hyp)
        for j, other in enumerate(hyp, start=1):
            current[j] = min(
                previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (word != other)
            )
        previous = current
    return previous[-1] / len(ref)


def word_diff(first: str, second: str) -> str:
    """The normalised words of both, ``-word`` only in ``first``, ``+word`` only in ``second``."""
    a, b = normalise(first).split(), normalise(second).split()
    out: list[str] = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if op == "equal":
            out.extend(a[i1:i2])
            continue
        out.extend(f"-{word}" for word in a[i1:i2])
        out.extend(f"+{word}" for word in b[j1:j2])
    return " ".join(out)


def status_of(result: dict[str, Any]) -> str:
    """``error`` (the call failed), ``no_finals`` (it ran but transcribed nothing) or ``ok``."""
    if result.get("error"):
        return "error"
    return "ok" if result.get("finals") else "no_finals"


def score(clip: dict[str, Any]) -> None:
    """Add status, transcript, words per final and WER to each model's result of ``clip``."""
    for result in clip["results"].values():
        finals = [str(text) for text in result.get("finals") or []]
        result["status"] = status_of(result)
        result["transcript"] = " ".join(text.strip() for text in finals if text.strip())
        result["final_words"] = [len(normalise(text).split()) for text in finals]
        expected = clip.get("expected")
        result["wer"] = (
            None
            if expected is None or result["status"] == "error"
            else round(wer(expected, result["transcript"]), 4)
        )
    models = list(clip["results"])
    if len(models) >= 2:
        first, second = clip["results"][models[0]], clip["results"][models[1]]
        clip["diff"] = word_diff(first["transcript"], second["transcript"])


def summarise(clips: Sequence[dict[str, Any]], models: Sequence[str]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for model in models:
        results = [clip["results"][model] for clip in clips if model in clip["results"]]
        wers = [r["wer"] for r in results if r.get("wer") is not None]
        latencies = [r["final_latency_s"] for r in results if r.get("final_latency_s") is not None]
        summary[model] = {
            "clips": len(results),
            "failures": sum(1 for r in results if r["status"] == "error"),
            "no_finals": sum(1 for r in results if r["status"] == "no_finals"),
            "mean_wer": round(statistics.fmean(wers), 4) if wers else None,
            "median_final_latency_s": round(statistics.median(latencies), 3) if latencies else None,
            "mean_finals_per_clip": (
                round(statistics.fmean(len(r.get("finals") or []) for r in results), 2)
                if results
                else None
            ),
            "short_finals": sum(
                1 for r in results for words in r.get("final_words", []) if words <= 2
            ),
        }
    return summary


def render(
    clips: Sequence[dict[str, Any]], summary: dict[str, Any], *, no_text: bool
) -> list[str]:
    """The human report.  ``no_text``: numbers only, never a word of a transcript."""
    lines: list[str] = []
    for clip in clips:
        lines.append(f"== {clip['name']} ({clip['seconds']:.2f} s)")
        if not no_text and clip.get("expected") is not None:
            lines.append(f"   expected: {clip['expected']}")
        for model, result in clip["results"].items():
            numbers = (
                f"status={result['status']} finals={len(result.get('finals') or [])} "
                f"words={result.get('final_words')} wer={result.get('wer')} "
                f"latency_s={result.get('final_latency_s')}"
            )
            lines.append(f"   {model}: {numbers}")
            if result.get("error"):
                error = result["error"]
                lines.append(
                    f"      error: {error.get('type')} status={error.get('status_code')}"
                    + ("" if no_text else f" {error.get('message', '')}")
                )
            if not no_text:
                lines.append(f"      text: {result['transcript']}")
        if not no_text and clip.get("diff") is not None:
            lines.append(f"   diff: {clip['diff']}")
    lines.append("== summary")
    for model, row in summary.items():
        lines.append(
            f"   {model}: clips={row['clips']} failures={row['failures']} "
            f"no_finals={row['no_finals']} mean_wer={row['mean_wer']} "
            f"median_final_latency_s={row['median_final_latency_s']} "
            f"finals_per_clip={row['mean_finals_per_clip']} short_finals={row['short_finals']}"
        )
    return lines


# ---------------------------------------------------------------------------- transports


def _error_of(exc: BaseException, secrets: Sequence[str]) -> dict[str, Any]:
    status = getattr(exc, "status_code", None)
    return {
        "type": type(exc).__name__,
        "status_code": status if isinstance(status, int) and not isinstance(status, bool) else None,
        "message": redact(exc, secrets)[:500],
    }


async def stream_transport(
    model: str, pcm: bytes, rate: int, *, language: str, key: str
) -> dict[str, Any]:
    """R1's real path: the plugin's streaming STT, fed at real-time pace."""
    from livekit import rtc
    from livekit.agents import stt as agents_stt
    from livekit.plugins import sarvam

    result: dict[str, Any] = {"finals": [], "events": [], "final_latency_s": None, "url": None}
    stt = sarvam.STT(model=model, language=language, api_key=key)
    try:
        from livekit.plugins.sarvam.stt import _build_websocket_url

        result["url"] = _build_websocket_url(stt._opts.streaming_url, stt._opts)
    except Exception:  # noqa: BLE001 - the URL is informational only
        pass
    stream = stt.stream()
    audio_end: list[float] = []
    last_final: list[float] = []
    speech_frames = speech_frame_count(pcm, rate)

    async def feed() -> None:
        start = time.perf_counter()
        for index, chunk in enumerate(frames(pcm, rate), start=1):
            stream.push_frame(rtc.AudioFrame(chunk, rate, 1, len(chunk) // 2))
            if index == speech_frames:
                audio_end.append(time.perf_counter())
            delay = start + index * FRAME_MS / 1000 - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)
        stream.end_input()

    async def read() -> None:
        async for event in stream:
            kind = event.type
            if kind == agents_stt.SpeechEventType.FINAL_TRANSCRIPT:
                text = event.alternatives[0].text if event.alternatives else ""
                result["finals"].append(text)
                result["events"].append("FINAL")
                last_final.append(time.perf_counter())
            elif kind == agents_stt.SpeechEventType.START_OF_SPEECH:
                result["events"].append("START")
            elif kind == agents_stt.SpeechEventType.END_OF_SPEECH:
                result["events"].append("END")
            elif kind == agents_stt.SpeechEventType.INTERIM_TRANSCRIPT:
                result["events"].append("INTERIM")

    try:
        await asyncio.wait_for(asyncio.gather(feed(), read()), CALL_TIMEOUT_SEC)
    except Exception as exc:  # noqa: BLE001 - every failure is a result, never a crash
        result["error"] = _error_of(exc, (key,))
    finally:
        await stream.aclose()
        aclose = getattr(stt, "aclose", None)
        if callable(aclose):
            await aclose()
    if audio_end and last_final:
        result["final_latency_s"] = round(last_final[-1] - audio_end[0], 3)
    return result


async def rest_transport(
    model: str, pcm: bytes, rate: int, *, language: str, key: str
) -> dict[str, Any]:
    """The plugin's ``recognize()``: one REST request for the whole clip."""
    from livekit import rtc
    from livekit.plugins import sarvam

    result: dict[str, Any] = {"finals": [], "events": [], "final_latency_s": None, "url": None}
    stt = sarvam.STT(model=model, language=language, api_key=key)
    try:
        frame = rtc.AudioFrame(pcm, rate, 1, len(pcm) // 2)
        started = time.perf_counter()
        event = await asyncio.wait_for(stt.recognize(frame), CALL_TIMEOUT_SEC)
        result["final_latency_s"] = round(time.perf_counter() - started, 3)
        text = event.alternatives[0].text if getattr(event, "alternatives", None) else ""
        if text:
            result["finals"].append(text)
            result["events"].append("FINAL")
    except Exception as exc:  # noqa: BLE001
        result["error"] = _error_of(exc, (key,))
    finally:
        aclose = getattr(stt, "aclose", None)
        if callable(aclose):
            await aclose()
    return result


def realtime_url(model: str, language: str) -> str:
    """The realtime endpoint's URL (it never carries the key: that is a header)."""
    from urllib.parse import urlencode

    query = {
        "language_code": language,
        "model": model,
        "mode": "transcribe",
        "stream_type": "fast",
        "endpointing": "vad",
        "encoding": "linear16",
        "sample_rate": str(REALTIME_RATE),
    }
    return f"{REALTIME_URL}?{urlencode(query)}"


def _resample_16k(pcm: bytes, rate: int) -> bytes:
    if rate == REALTIME_RATE:
        return pcm
    from livekit import rtc

    resampler = rtc.AudioResampler(rate, REALTIME_RATE, num_channels=1)
    out = bytearray()
    for frame in resampler.push(rtc.AudioFrame(pcm, rate, 1, len(pcm) // 2)):
        out += bytes(frame.data)
    for frame in resampler.flush():
        out += bytes(frame.data)
    return bytes(out)


async def realtime_transport(
    model: str, pcm: bytes, rate: int, *, language: str, key: str
) -> dict[str, Any]:
    """Sarvam's ``/speech-to-text-realtime/ws``: JSON base64 ``audio_input`` in, events out."""
    import aiohttp

    url = realtime_url(model, language)
    result: dict[str, Any] = {"finals": [], "events": [], "final_latency_s": None, "url": url}
    audio = _resample_16k(pcm, rate)
    speech_chunks = speech_frame_count(audio, REALTIME_RATE, REALTIME_CHUNK_MS)
    audio_end: list[float] = []
    last_final: list[float] = []
    headers = {"API-SUBSCRIPTION-KEY": key, "User-Agent": "hello-r1-stt-ab/1"}

    async def run() -> None:
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(url, headers=headers, heartbeat=20) as ws:

                async def send() -> None:
                    start = time.perf_counter()
                    chunks = frames(audio, REALTIME_RATE, frame_ms=REALTIME_CHUNK_MS)
                    for index, chunk in enumerate(chunks, start=1):
                        payload = base64.b64encode(chunk).decode("ascii")
                        await ws.send_str(json.dumps({"event": "audio_input", "audio": payload}))
                        if index == speech_chunks:
                            audio_end.append(time.perf_counter())
                        delay = start + index * REALTIME_CHUNK_MS / 1000 - time.perf_counter()
                        if delay > 0:
                            await asyncio.sleep(delay)
                    await ws.send_str(json.dumps({"event": "end"}))

                async def receive() -> None:
                    async for message in ws:
                        if message.type != aiohttp.WSMsgType.TEXT:
                            if message.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                                break
                            continue
                        try:
                            data = json.loads(message.data)
                        except ValueError:
                            continue
                        event = str(data.get("event") or data.get("type") or "")
                        if event == "transcript.final":
                            result["finals"].append(str(data.get("text") or ""))
                            result["events"].append("FINAL")
                            last_final.append(time.perf_counter())
                        elif event == "vad.speech_start":
                            result["events"].append("START")
                        elif event == "vad.speech_end":
                            result["events"].append("END")
                        elif event == "transcript.partial":
                            result["events"].append("INTERIM")
                        elif "error" in event:
                            raise RuntimeError(f"realtime error event: {data}")
                        elif event == "session.end":
                            return
                    if ws.close_code not in (None, 1000):
                        raise RuntimeError(f"realtime socket closed {ws.close_code}")

                await asyncio.gather(send(), receive())

    try:
        await asyncio.wait_for(run(), CALL_TIMEOUT_SEC)
    except Exception as exc:  # noqa: BLE001
        result["error"] = _error_of(exc, (key,))
    if audio_end and last_final:
        result["final_latency_s"] = round(last_final[-1] - audio_end[0], 3)
    return result


TRANSPORT_FUNCTIONS: dict[str, Transport] = {
    "stream": stream_transport,
    "rest": rest_transport,
    "realtime": realtime_transport,
}


# ---------------------------------------------------------------------------------- main


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="r1_stt_ab.py", description="A/B the same audio through Sarvam STT models."
    )
    parser.add_argument("clips", nargs="+", type=Path, help="16-bit PCM WAV files")
    parser.add_argument("--models", default=",".join(DEFAULT_MODELS))
    parser.add_argument("--transport", choices=TRANSPORTS, default="stream")
    parser.add_argument("--language", default="en-IN")
    parser.add_argument("--env-file", default=None)
    parser.add_argument("--max-audio-seconds", type=float, default=120.0)
    parser.add_argument("--sequential", action="store_true")
    parser.add_argument("--no-text", action="store_true")
    parser.add_argument("--json", dest="json_out", type=Path, default=None)
    return parser.parse_args(argv)


def load_clips(paths: Sequence[Path]) -> list[dict[str, Any]]:
    clips = []
    for path in paths:
        pcm, rate = read_wav(path)
        sidecar = path.with_suffix(".txt")
        expected = None
        if sidecar.is_file():
            expected = sidecar.read_text(encoding="utf-8-sig").strip() or None
        clips.append(
            {
                "name": path.name,
                "pcm": pcm,
                "rate": rate,
                "seconds": round(seconds_of(pcm, rate), 3),
                "expected": expected,
                "results": {},
            }
        )
    return clips


async def run_all(
    clips: list[dict[str, Any]],
    models: Sequence[str],
    transport: Transport,
    *,
    language: str,
    key: str,
    sequential: bool,
) -> None:
    for clip in clips:

        async def one(model: str, clip: dict[str, Any] = clip) -> dict[str, Any]:
            try:
                return await transport(
                    model, clip["pcm"], clip["rate"], language=language, key=key
                )
            except Exception as exc:  # noqa: BLE001 - a transport bug is a result too
                return {"finals": [], "events": [], "error": _error_of(exc, (key,))}

        if sequential:
            results = [await one(model) for model in models]
        else:
            results = await asyncio.gather(*(one(model) for model in models))
        for model, result in zip(models, results):
            if result.get("url"):
                result["url"] = redact(result["url"], (key,))
            clip["results"][model] = result
        score(clip)


def main(
    argv: Sequence[str] | None = None,
    *,
    transports: dict[str, Transport] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    try:
        args = parse_args(argv)
    except SystemExit as exc:  # argparse already printed the usage
        return EXIT_USAGE if exc.code else EXIT_OK
    models = [model.strip() for model in args.models.split(",") if model.strip()]
    if not models or len(set(models)) != len(models):
        print("error: --models needs one or more distinct model ids", file=err)
        return EXIT_USAGE
    try:
        clips = load_clips(args.clips)
    except UsageError as exc:
        print(f"error: {exc}", file=err)
        return EXIT_USAGE
    padding = LEAD_SECONDS + TAIL_SECONDS if args.transport != "rest" else 0.0
    per_model = sum(clip["seconds"] + padding for clip in clips)
    total = per_model * len(models)
    print(
        f"budget: {per_model:.1f} s of audio x {len(models)} model(s) = {total:.1f} s "
        f"(limit {args.max_audio_seconds:.1f} s, transport {args.transport})",
        file=out,
    )
    if total > args.max_audio_seconds:
        print("error: over the audio budget; raise --max-audio-seconds to go on", file=err)
        return EXIT_USAGE
    key = read_key(args.env_file)
    if not key:
        print("error: no SARVAM_API_KEY (environment or --env-file)", file=err)
        return EXIT_USAGE
    transport = (transports or TRANSPORT_FUNCTIONS)[args.transport]
    handler = logging.StreamHandler(err)
    handler.addFilter(_RedactingFilter((key,)))
    root = logging.getLogger()
    root.addHandler(handler)
    previous = root.level
    root.setLevel(logging.WARNING)
    try:
        asyncio.run(
            run_all(
                clips, models, transport,
                language=args.language, key=key, sequential=args.sequential,
            )
        )
    finally:
        root.removeHandler(handler)
        root.setLevel(previous)
    summary = summarise(clips, models)
    for line in render(clips, summary, no_text=args.no_text):
        print(redact(line, (key,)), file=out)
    if args.json_out is not None:
        document = {
            "transport": args.transport,
            "language": args.language,
            "models": models,
            "clips": [{k: v for k, v in clip.items() if k != "pcm"} for clip in clips],
            "summary": summary,
        }
        if args.no_text:
            for clip in document["clips"]:
                clip.pop("expected", None)
                clip.pop("diff", None)
                for result in clip["results"].values():
                    result.pop("finals", None)
                    result.pop("transcript", None)
                    if result.get("error"):
                        result["error"].pop("message", None)
        text = redact(json.dumps(document, indent=2, ensure_ascii=False), (key,))
        args.json_out.write_text(text + "\n", encoding="utf-8")
    if any(row["clips"] and row["failures"] == row["clips"] for row in summary.values()):
        return EXIT_ALL_FAILED
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
