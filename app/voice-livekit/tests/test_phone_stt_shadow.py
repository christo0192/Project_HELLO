"""M015 PR-1: the metrics-only Sarvam Realtime STT shadow (phone_stt_shadow.py).

Bare python, no SDK, no network, no secret: a scriptable fake socket, a fake
clock and synthetic text only. The shadow logs NUMBERS: these tests pin the
formulas (S01-PLAN section 4), the wire format (section 3), failure isolation
(section 6) and that no text ever reaches a log or a retained attribute.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import pathlib
import re
import time
import unittest
from unittest.mock import patch

import phone_stt_shadow as pss
from observability import StructuredLogger

_CTX = pathlib.Path(__file__).resolve().parent.parent

SENTINELS = (
    "zebra quantum marmalade", "synthetic.person@example.test", "9876543210",
    "velvet thunder cactus",
)
_KEY = "synthetic-shadow-key"
_ENV_KEYS = (
    "PHONE_STT_SHADOW", "PHONE_STT_SHADOW_SAMPLE", "PHONE_STT_SHADOW_MODEL",
    "PHONE_STT_SHADOW_SAMPLE_RATE", "PHONE_STT_SHADOW_STREAM_TYPE",
    "PHONE_STT_SHADOW_VAD_THRESHOLD", "PHONE_STT_SHADOW_SILENCE_MS",
    "SARVAM_API_KEY", "SARVAM_LANGUAGE",
)
_ALLOWED_KEYS = {
    "timestamp", "level", "component", "event", "correlationId",
    "error_type", "error_category", "schema", "phase", "model", "duration_sec",
    "option_count", "turn_index", "http_status",
}


class _Env:
    def __init__(self, **env: str) -> None:
        self._env = env

    def __enter__(self) -> "_Env":
        self._saved = {k: os.environ.get(k) for k in _ENV_KEYS}
        for k in _ENV_KEYS:
            os.environ.pop(k, None)
        os.environ.update(self._env)
        return self

    def __exit__(self, *exc) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class Clock:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


class Frame:
    def __init__(self, nbytes: int = 320, rate: int = 16000, channels: int = 1) -> None:
        self.data = bytes(nbytes)
        self.sample_rate = rate
        self.num_channels = channels
        self.samples_per_channel = nbytes // 2 // max(1, channels)


class PassResampler:
    def __init__(self, i, o, c) -> None:
        self.args = (i, o, c)

    def push(self, frame):
        return [bytes(frame.data)]

    def flush(self):
        return []


class FakeWs:
    def __init__(self, script=(), *, hang_send=False, raise_on_receive=None,
                 close_code=None) -> None:
        self.sent: list = []
        self._rx: asyncio.Queue = asyncio.Queue()
        for item in script:
            self._rx.put_nowait(item)
        self.hang_send = hang_send
        self.raise_on_receive = raise_on_receive
        self.close_code = close_code
        self.closed = False
        self.closed_event = asyncio.Event()

    def feed(self, kind: str, data=None) -> None:
        self._rx.put_nowait(pss.SocketMessage(kind, data))

    def feed_json(self, obj) -> None:
        self.feed(pss.MSG_TEXT, json.dumps(obj))

    async def send_str(self, s: str) -> None:
        if self.hang_send:
            await asyncio.Event().wait()
        self.sent.append(json.loads(s))

    async def receive(self):
        if self.raise_on_receive is not None:
            raise self.raise_on_receive
        return await self._rx.get()

    async def close(self) -> None:
        self.closed = True
        if self.close_code is None:
            self.close_code = 1000
        self.closed_event.set()


class Recorder:
    """Records emitted (category, meta) pairs."""

    def __init__(self) -> None:
        self.events: list = []

    def __call__(self, category, *, level="info", **meta):
        self.events.append((category, dict(meta)))

    def cats(self):
        return [c for c, _ in self.events]

    def of(self, cat):
        return [m for c, m in self.events if c == cat]


def make_shadow(ws=None, *, armed=None, clock=None, rec=None, cfg=None,
                factory=None, **tune):
    clock = clock or Clock()
    rec = rec if rec is not None else Recorder()
    flag = armed if armed is not None else [True]

    async def default_factory(url, headers):
        default_factory.calls.append((url, dict(headers)))
        return ws

    default_factory.calls = []
    shadow = pss.PhoneSttShadow(
        cfg or pss.ShadowConfig(), api_key=_KEY, armed=lambda: bool(flag[0]),
        ws_factory=factory or default_factory, resampler_factory=PassResampler,
        clock=clock, emitter=rec)
    shadow._tick_sec = 0.01
    shadow._end_wait = 0.1
    shadow._socket_close = 0.2
    shadow._close_grace = 0.5
    shadow._connect_timeout = tune.pop("connect_timeout", 0.2)
    shadow._send_stall = tune.pop("send_stall", 0.1)
    for k, v in tune.items():
        setattr(shadow, k, v)
    return shadow, rec, clock, flag, default_factory


async def settle(t: float = 0.05) -> None:
    await asyncio.sleep(t)


# ── A1 readers ───────────────────────────────────────────────────────────────

class TestReaders(unittest.TestCase):
    def test_defaults(self):
        with _Env():
            self.assertFalse(pss.phone_stt_shadow_enabled())
            self.assertEqual(pss.phone_stt_shadow_sample(), 1.0)
            self.assertEqual(pss.phone_stt_shadow_model(), "saaras:v3-realtime")
            self.assertEqual(pss.phone_stt_shadow_sample_rate(), 16000)
            self.assertEqual(pss.phone_stt_shadow_stream_type(), "fast")
            self.assertEqual(pss.phone_stt_shadow_vad_threshold(), 0.5)
            self.assertEqual(pss.phone_stt_shadow_silence_ms(), 700)

    def test_switch_only_on_enables(self):
        for raw, expect in (("on", True), (" ON ", True), ("off", False), ("", False),
                            ("true", False), ("1", False), ("realtime", False)):
            with _Env(PHONE_STT_SHADOW=raw):
                self.assertEqual(pss.phone_stt_shadow_enabled(), expect, raw)

    def test_sample_clamps_and_invalid_fails_closed(self):
        for raw, expect, valid in (("0.25", 0.25, True), ("5", 1.0, True), ("-1", 0.0, True),
                                   ("abc", 0.0, False), ("nan", 0.0, False),
                                   ("inf", 0.0, False)):
            with _Env(PHONE_STT_SHADOW_SAMPLE=raw):
                self.assertEqual(pss.phone_stt_shadow_sample(), expect, raw)
                self.assertEqual(pss._sample_parse()[1], valid, raw)

    def test_model_allowlist(self):
        with _Env(PHONE_STT_SHADOW_MODEL="saaras:v4"):
            self.assertEqual(pss.phone_stt_shadow_model(), "saaras:v4")
        with _Env(PHONE_STT_SHADOW_MODEL="gpt-evil"):
            self.assertEqual(pss.phone_stt_shadow_model(), "saaras:v3-realtime")

    def test_rate_stream_threshold_silence(self):
        with _Env(PHONE_STT_SHADOW_SAMPLE_RATE="8000"):
            self.assertEqual(pss.phone_stt_shadow_sample_rate(), 8000)
        with _Env(PHONE_STT_SHADOW_SAMPLE_RATE="44100"):
            self.assertEqual(pss.phone_stt_shadow_sample_rate(), 16000)
        with _Env(PHONE_STT_SHADOW_STREAM_TYPE="balanced"):
            self.assertEqual(pss.phone_stt_shadow_stream_type(), "balanced")
        with _Env(PHONE_STT_SHADOW_STREAM_TYPE="simulated"):
            self.assertEqual(pss.phone_stt_shadow_stream_type(), "fast")
        for raw, expect in (("0.01", 0.1), ("0.99", 0.9), ("0.6", 0.6), ("x", 0.5)):
            with _Env(PHONE_STT_SHADOW_VAD_THRESHOLD=raw):
                self.assertEqual(pss.phone_stt_shadow_vad_threshold(), expect, raw)
        for raw, expect in (("100", 300), ("9999", 1500), ("800", 800), ("x", 700)):
            with _Env(PHONE_STT_SHADOW_SILENCE_MS=raw):
                self.assertEqual(pss.phone_stt_shadow_silence_ms(), expect, raw)


# ── A2 build_call_shadow ─────────────────────────────────────────────────────

class TestBuild(unittest.TestCase):
    def _logger(self):
        lines: list[str] = []
        return StructuredLogger("phone_stt_shadow", writer=lines.append), lines

    def test_off_returns_none_and_logs_nothing(self):
        logger, lines = self._logger()
        with _Env():
            self.assertIsNone(pss.build_call_shadow(armed=lambda: True, logger=logger))
        with _Env(PHONE_STT_SHADOW="off", SARVAM_API_KEY=_KEY):
            self.assertIsNone(pss.build_call_shadow(armed=lambda: True, logger=logger))
        self.assertEqual(lines, [])

    def test_sampled_out(self):
        logger, lines = self._logger()
        with _Env(PHONE_STT_SHADOW="on", PHONE_STT_SHADOW_SAMPLE="0.5", SARVAM_API_KEY=_KEY):
            self.assertIsNone(pss.build_call_shadow(
                armed=lambda: True, rng=lambda: 0.99, logger=logger))
            self.assertIsNotNone(pss.build_call_shadow(
                armed=lambda: True, rng=lambda: 0.1, logger=logger))
        cats = [json.loads(x)["error_category"] for x in lines]
        self.assertEqual(cats, ["sampled_out", "config"])
        self.assertEqual(json.loads(lines[0])["duration_sec"], 0.5)

    def test_invalid_sample_fails_closed_with_a_line(self):
        logger, lines = self._logger()
        with _Env(PHONE_STT_SHADOW="on", PHONE_STT_SHADOW_SAMPLE="lots", SARVAM_API_KEY=_KEY):
            self.assertIsNone(pss.build_call_shadow(
                armed=lambda: True, rng=lambda: 0.0, logger=logger))
        row = json.loads(lines[0])
        self.assertEqual((row["error_category"], row["schema"]), ("disabled", "sample_invalid"))

    def test_missing_key(self):
        logger, lines = self._logger()
        with _Env(PHONE_STT_SHADOW="on"):
            self.assertIsNone(pss.build_call_shadow(armed=lambda: True, logger=logger))
        row = json.loads(lines[0])
        self.assertEqual((row["error_category"], row["schema"]), ("disabled", "no_key"))

    def test_key_never_in_a_line_or_the_url_only_in_the_header(self):
        logger, lines = self._logger()
        with _Env(PHONE_STT_SHADOW="on", SARVAM_API_KEY=_KEY, SARVAM_LANGUAGE="hi-IN"):
            shadow = pss.build_call_shadow(armed=lambda: True, logger=logger)
        self.assertIsNotNone(shadow)
        self.assertNotIn(_KEY, "".join(lines))
        self.assertNotIn(_KEY, shadow._url)
        self.assertEqual(shadow._headers["API-SUBSCRIPTION-KEY"], _KEY)
        self.assertIn("language_code=hi-IN", shadow._url)
        row = json.loads(lines[0])
        self.assertEqual(row["error_category"], "config")
        self.assertEqual(row["model"], "saaras:v3-realtime")
        self.assertEqual(row["option_count"], 16000)
        self.assertEqual(row["turn_index"], 700)

    def test_construction_failure_is_swallowed(self):
        logger, lines = self._logger()
        with _Env(PHONE_STT_SHADOW="on", SARVAM_API_KEY=_KEY), \
                patch.object(pss, "PhoneSttShadow", side_effect=RuntimeError(SENTINELS[0])):
            self.assertIsNone(pss.build_call_shadow(armed=lambda: True, logger=logger))
        self.assertEqual(json.loads(lines[0])["schema"], "build_failed")
        self.assertNotIn(SENTINELS[0], "".join(lines))


# ── A3 URL ───────────────────────────────────────────────────────────────────

class TestUrl(unittest.TestCase):
    def test_exact_query(self):
        from urllib.parse import parse_qs, urlsplit
        url = pss.build_realtime_url(pss.ShadowConfig())
        parts = urlsplit(url)
        self.assertEqual((parts.scheme, parts.netloc, parts.path),
                         ("wss", "api.sarvam.ai", "/speech-to-text-realtime/ws"))
        query = {k: v[0] for k, v in parse_qs(parts.query).items()}
        self.assertEqual(query, {
            "language_code": "en-IN", "model": "saaras:v3-realtime", "stream_type": "fast",
            "mode": "transcribe", "endpointing": "vad", "encoding": "linear16",
            "sample_rate": "16000", "threshold": "0.5", "silence_duration_ms": "700",
            "return_timestamps": "false",
        })
        self.assertNotIn("key", url.lower())


# ── A4 arming ────────────────────────────────────────────────────────────────

class TestArming(unittest.IsolatedAsyncioTestCase):
    async def test_unarmed_frames_cost_nothing(self):
        ws = FakeWs()
        shadow, rec, _, flag, factory = make_shadow(ws, armed=[False])
        for _ in range(1000):
            shadow.offer(Frame())
        await settle()
        self.assertEqual(factory.calls, [])
        self.assertIsNone(shadow._task)
        self.assertIsNone(shadow._queue)
        self.assertEqual(shadow.counters["frames_offered"], 0)
        self.assertEqual(rec.events, [])

    async def test_first_armed_frame_connects_once_and_never_reconnects(self):
        ws = FakeWs(close_code=None)
        shadow, rec, _, flag, factory = make_shadow(ws, armed=[False])
        shadow.offer(Frame())
        flag[0] = True
        shadow.offer(Frame())
        await settle()
        self.assertEqual(len(factory.calls), 1)
        self.assertEqual(rec.cats().count("armed"), 1)
        self.assertEqual(factory.calls[0][1]["API-SUBSCRIPTION-KEY"], _KEY)
        ws.feed(pss.MSG_CLOSE)
        ws.close_code = 1011
        await settle()
        for _ in range(50):
            shadow.offer(Frame())
        await settle()
        self.assertEqual(len(factory.calls), 1)
        shadow.close_nowait()

    async def test_armed_raising_means_not_armed(self):
        shadow, rec, *_ = make_shadow(FakeWs())

        def boom():
            raise RuntimeError("x")

        shadow._armed = boom
        shadow.offer(Frame())
        self.assertIsNone(shadow._task)


# ── A5 wire ──────────────────────────────────────────────────────────────────

class TestWire(unittest.IsolatedAsyncioTestCase):
    async def test_chunks_ping_and_end(self):
        ws = FakeWs()
        shadow, rec, clock, _, _ = make_shadow(ws)
        for _ in range(25):                 # 25 x 320 B = 8000 B
            shadow.offer(Frame())
        await settle()
        audio = [m for m in ws.sent if m["event"] == "audio_input"]
        self.assertEqual(len(audio), 2)
        self.assertTrue(all(len(base64.b64decode(m["audio"])) == 3200 for m in audio))
        clock.t += 16.0
        await settle()
        self.assertIn({"event": "ping"}, ws.sent)
        shadow.close_nowait()
        await asyncio.wait_for(shadow._task, 2)
        self.assertEqual(ws.sent[-1], {"event": "end"})
        tail = [m for m in ws.sent if m["event"] == "audio_input"][2:]
        self.assertEqual([len(base64.b64decode(m["audio"])) for m in tail], [1600])
        self.assertEqual(shadow.counters["chunks_sent"], 3)

    async def test_8k_chunk_is_1600_bytes(self):
        ws = FakeWs()
        shadow, *_ = make_shadow(ws, cfg=pss.ShadowConfig(sample_rate=8000))
        for _ in range(10):
            shadow.offer(Frame(rate=8000))
        await settle()
        audio = [m for m in ws.sent if m["event"] == "audio_input"]
        self.assertEqual([len(base64.b64decode(m["audio"])) for m in audio], [1600] * 2)
        shadow.close_nowait()

    async def test_multichannel_kills_the_shadow(self):
        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        shadow.offer(Frame(channels=2))
        await settle()
        self.assertEqual(rec.of("shadow_failed")[0]["schema"], "channels")
        self.assertEqual(rec.of("shadow_failed")[0]["phase"], "sender")
        self.assertEqual(shadow.counters["unrecovered_death"], 1)


# ── A6 parsing ───────────────────────────────────────────────────────────────

class TestParsing(unittest.IsolatedAsyncioTestCase):
    async def test_every_event_kind(self):
        ws = FakeWs()
        shadow, rec, clock, _, _ = make_shadow(ws)
        shadow.offer(Frame())
        await settle()
        shadow.on_local_vad("start")
        ws.feed_json({"event": "session.begin", "request_id": SENTINELS[3]})
        ws.feed_json({"event": "vad.speech_start", "utterance_idx": 0})
        ws.feed_json({"event": "transcript.partial", "text": "one two three"})
        ws.feed_json({"event": "transcript.final", "text": "one two three four"})
        ws.feed_json({"event": "vad.speech_end"})
        ws.feed_json({"event": "pong"})
        ws.feed_json({"event": "config.updated"})
        ws.feed_json({"event": "error", "code": "invalid_config", "is_fatal": False,
                      "message": SENTINELS[0]})
        ws.feed_json({"event": "who.knows"})
        ws.feed(pss.MSG_TEXT, "not json at all " + SENTINELS[0])
        ws.feed(pss.MSG_BINARY)
        ws.feed_json([1, 2, 3])
        ws.feed_json({"event": "session.end", "audio_duration_s": 12.5})
        await settle()
        c = shadow.counters
        self.assertEqual((c["rt_partials"], c["rt_finals"], c["rt_vad_starts"]), (1, 1, 1))
        self.assertEqual(c["rt_unparsed"], 4)
        self.assertEqual(c["errors_nonfatal"], 1)
        self.assertEqual(rec.of("session_end")[0]["duration_sec"], 12.5)
        self.assertEqual(pss._num("42.1"), 42.1)          # Sarvam sends a string
        self.assertIsNone(pss._num("x"))
        self.assertIsNone(pss._num(True))
        self.assertIsNone(pss._num("-1"))
        self.assertIsNone(pss._num("nan"))
        self.assertEqual(len(rec.of("session_begin")), 1)
        self.assertEqual(rec.of("socket_error")[0], {"schema": "invalid_config", "phase": "nonfatal"})
        self.assertEqual(c["unrecovered_death"], 0)
        shadow.close_nowait()

    async def test_session_end_duration_as_documented_string(self):
        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        shadow.offer(Frame())
        await settle()
        ws.feed_json({"event": "session.end", "audio_duration_s": "42.1",
                      "total_duration_s": "43.0"})
        await settle()
        self.assertEqual(rec.of("session_end")[0]["duration_sec"], 42.1)
        shadow.close_nowait()

    async def test_fatal_error_event_ends_the_shadow(self):
        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        shadow.offer(Frame())
        await settle()
        ws.feed_json({"event": "error", "code": "Quota Hit!!", "is_fatal": True,
                      "status_code": 503, "message": SENTINELS[0]})
        await settle()
        row = rec.of("socket_error")[0]
        self.assertEqual(row, {"schema": "unknown", "phase": "fatal", "http_status": 503})
        self.assertEqual(shadow.counters["unrecovered_death"], 1)
        self.assertTrue(shadow._dead)

    async def test_nonfatal_errors_logged_five_times_then_counted(self):
        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        shadow.offer(Frame())
        await settle()
        for _ in range(9):
            ws.feed_json({"event": "error", "code": "invalid_config", "is_fatal": False})
        await settle()
        self.assertEqual(len(rec.of("socket_error")), 5)
        self.assertEqual(shadow.counters["errors_nonfatal"], 9)
        shadow.close_nowait()


# ── A7 metric formulas (pure tracker) ────────────────────────────────────────

class TestTracker(unittest.TestCase):
    def setUp(self):
        self.rec = Recorder()
        self.clock = Clock(0.0)
        self.tr = pss.SegmentTracker(self.clock, self.rec)
        self.tr.arm()

    def at(self, t):
        self.clock.t = t
        return t

    def seg_summary(self, k):
        return [m for c, m in self.rec.events if c == "seg_summary" and m["turn_index"] == k][0]

    def values(self, cat, k):
        return [m for c, m in self.rec.events if c == cat and m["turn_index"] == k]

    def test_events_before_arming_are_ignored(self):
        tr = pss.SegmentTracker(self.clock, self.rec)
        tr.vad_start(1.0)
        tr.rt_partial(2, 1.1)
        tr.legacy_final(2, 1.2)
        self.assertEqual(tr.counters["segments"], 0)
        self.assertEqual(tr.counters["silence_partials"], 0)

    def test_both(self):
        tr = self.tr
        tr.vad_start(10.0)
        tr.rt_partial(1, 10.4)
        tr.rt_partial(2, 10.9)
        tr.rt_partial(3, 11.3)
        tr.vad_end(12.0)
        tr.rt_final(5, 12.5)
        tr.legacy_final(5, 13.0)
        tr.tick(15.1)
        self.assertEqual(self.values("seg_partial_lead", 0)[0]["duration_sec"], 0.4)
        self.assertEqual(self.values("seg_three_word", 0)[0]["duration_sec"], 1.3)
        self.assertEqual(self.values("seg_legacy_final", 0)[0],
                         {"turn_index": 0, "duration_sec": 3.0, "option_count": 5})
        self.assertEqual(self.values("seg_rt_final", 0)[0],
                         {"turn_index": 0, "duration_sec": 2.5, "option_count": 5})
        s = self.seg_summary(0)
        self.assertEqual((s["schema"], s["option_count"], s["phase"], s["duration_sec"]),
                         ("both", 3, "settled", 2.0))

    def test_noise_partial_with_no_final_and_with_empty_final(self):
        tr = self.tr
        tr.vad_start(10.0)
        tr.rt_partial(2, 10.5)
        tr.vad_end(11.0)
        tr.vad_start(20.0)
        tr.rt_partial(1, 20.3)
        tr.vad_end(21.0)
        tr.legacy_final(0, 22.0)
        tr.tick(30.0)
        self.assertEqual(self.seg_summary(0)["schema"], "noise_partial")
        self.assertEqual(self.seg_summary(1)["schema"], "noise_partial")
        self.assertEqual(tr.counters["main_finals_empty"], 1)

    def test_rt_missed_and_silent(self):
        tr = self.tr
        tr.vad_start(10.0)
        tr.vad_end(11.0)
        tr.legacy_final(4, 11.9)
        tr.vad_start(20.0)
        tr.vad_end(21.0)
        tr.tick(30.0)
        self.assertEqual(self.seg_summary(0)["schema"], "rt_missed")
        self.assertEqual(self.seg_summary(1)["schema"], "silent")

    def test_several_legacy_finals_on_one_open_segment(self):
        tr = self.tr
        tr.vad_start(10.0)
        tr.legacy_final(3, 10.8)
        tr.legacy_final(4, 11.6)
        tr.vad_end(12.0)
        tr.tick(20.0)
        row = self.values("seg_legacy_final", 0)[0]
        self.assertEqual((row["duration_sec"], row["option_count"]), (0.8, 7))

    def test_clause_pause_inside_one_utterance_is_one_segment(self):
        # Review r1 (lens 2): the 0.25 s local VAD cuts an 8-word answer with a
        # 0.4 s pause into two segments; Sarvam / the main STT keep ONE utterance
        # (cumulative partials, one final each). Must be one `both` segment.
        tr = self.tr
        tr.vad_start(0.0)
        tr.rt_partial(1, 0.6)
        tr.vad_end(1.5)
        tr.rt_partial(3, 1.7)
        tr.vad_start(1.9)            # 0.4 s pause: continues segment 0
        tr.rt_partial(4, 2.4)
        tr.vad_end(3.3)
        tr.rt_partial(6, 3.5)
        tr.rt_partial(8, 3.8)
        tr.rt_final(8, 4.0)
        tr.legacy_final(8, 4.3)
        tr.tick(30.0)
        self.assertEqual(tr.counters["segments"], 1)
        self.assertEqual(tr.counters["segments_merged"], 1)
        self.assertEqual(self.seg_summary(0)["schema"], "both")
        self.assertEqual(self.seg_summary(0)["option_count"], 8)
        self.assertEqual(self.values("seg_three_word", 0)[0]["duration_sec"], 1.7)
        self.assertEqual(len([c for c, _ in self.rec.events if c == "seg_summary"]), 1)
        self.assertEqual(tr.counters["silence_partials"], 0)

    def test_restart_after_a_final_or_a_long_gap_is_a_new_segment(self):
        tr = self.tr
        tr.vad_start(0.0)
        tr.vad_end(1.0)
        tr.legacy_final(3, 1.5)      # a final landed: the next speech is new
        tr.vad_start(1.6)
        tr.vad_end(2.0)
        tr.vad_start(2.8)            # gap 0.8 s > MERGE_GAP: new segment
        tr.vad_end(3.0)
        tr.tick(30.0)
        self.assertEqual(tr.counters["segments"], 3)
        self.assertEqual(tr.counters["segments_merged"], 0)

    def test_legacy_final_after_the_next_vad_start_goes_to_the_older_segment(self):
        tr = self.tr
        tr.vad_start(10.0)
        tr.vad_end(11.0)
        tr.vad_start(11.9)          # next utterance already started (gap > MERGE_GAP)
        tr.legacy_final(6, 12.0)    # belongs to the older, ended segment
        tr.vad_end(13.0)
        tr.legacy_final(2, 14.0)
        tr.tick(30.0)
        self.assertEqual(self.values("seg_legacy_final", 0)[0]["option_count"], 6)
        self.assertEqual(self.values("seg_legacy_final", 1)[0]["option_count"], 2)

    def test_partial_inside_tail_after_end_belongs_to_the_segment(self):
        tr = self.tr
        tr.vad_start(10.0)
        tr.vad_end(11.0)
        tr.rt_partial(2, 11.9)      # within TAIL
        tr.rt_partial(2, 12.2)      # beyond TAIL: silence partial
        self.assertEqual(tr.counters["silence_partials"], 1)
        self.assertEqual(tr.counters["silence_partial_words"], 2)
        tr.tick(30.0)
        self.assertEqual(self.seg_summary(0)["option_count"], 2)

    def test_silence_partial_and_empty_partial(self):
        tr = self.tr
        tr.rt_partial(3, 5.0)
        tr.rt_partial(0, 5.1)
        self.assertEqual(tr.counters["silence_partials"], 1)
        self.assertEqual(tr.counters["rt_empty_partials"], 1)

    def test_orphans(self):
        tr = self.tr
        tr.legacy_final(2, 5.0)
        tr.rt_final(2, 5.0)
        self.assertEqual(tr.counters["orphan_legacy_finals"], 1)
        self.assertEqual(tr.counters["orphan_rt_finals"], 1)

    def test_truncated_at_close(self):
        tr = self.tr
        tr.vad_start(10.0)
        tr.rt_partial(1, 10.2)
        tr.close(10.5)
        s = self.seg_summary(0)
        self.assertEqual(s["phase"], "truncated")
        self.assertNotIn("duration_sec", s)

    def test_three_word_reached_by_a_later_cumulative_partial(self):
        tr = self.tr
        tr.vad_start(10.0)
        tr.rt_partial(1, 10.2)
        tr.rt_partial(2, 10.6)
        tr.rt_partial(4, 11.1)
        tr.vad_end(11.5)
        tr.tick(30.0)
        self.assertEqual(self.values("seg_three_word", 0)[0]["duration_sec"], 1.1)
        self.assertEqual(self.seg_summary(0)["option_count"], 4)

    def test_segment_settles_only_after_the_settle_window(self):
        tr = self.tr
        tr.vad_start(10.0)
        tr.vad_end(11.0)
        tr.tick(13.9)
        self.assertEqual(self.rec.of("seg_summary"), [])
        tr.tick(14.0)
        self.assertEqual(len(self.rec.of("seg_summary")), 1)

    def test_max_segments_caps_the_lines_not_the_counter(self):
        tr = self.tr
        t = 0.0
        for _ in range(pss.MAX_SEGMENTS + 5):
            tr.vad_start(t)
            tr.vad_end(t + 0.1)
            t += 10.0
        tr.tick(t + 10)
        self.assertEqual(tr.counters["segments"], pss.MAX_SEGMENTS + 5)
        self.assertEqual(len(self.rec.of("seg_summary")), pss.MAX_SEGMENTS)

    def test_word_cap(self):
        tr = self.tr
        tr.vad_start(1.0)
        tr.legacy_final(5000, 1.5)
        tr.rt_partial(5000, 1.2)
        tr.vad_end(2.0)
        tr.tick(20.0)
        self.assertEqual(self.values("seg_legacy_final", 0)[0]["option_count"], pss.WORD_CAP)
        self.assertEqual(self.seg_summary(0)["option_count"], pss.WORD_CAP)


# ── A8 close codes ───────────────────────────────────────────────────────────

class TestCloseCodes(unittest.IsolatedAsyncioTestCase):
    async def _server_close(self, code):
        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        shadow.offer(Frame())
        await settle()
        ws.close_code = code
        ws.feed(pss.MSG_CLOSE)
        await settle()
        return shadow, rec

    async def test_unexpected_codes_are_deaths(self):
        for code, schema in ((1000, "close_1000"), (1003, "close_1003"), (1008, "close_1008"),
                             (1011, "close_1011"), (4000, "close_4000"),
                             (99999, "close_unknown"), (None, "close_unknown")):
            shadow, rec = await self._server_close(code)
            row = rec.of("socket_closed")[0]
            self.assertEqual((row["schema"], row["phase"]), (schema, "unexpected"), code)
            self.assertEqual(shadow.counters["unrecovered_death"], 1, code)
            shadow.close_nowait()

    async def test_our_own_end_is_expected(self):
        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        shadow.offer(Frame())
        await settle()
        shadow.close_nowait()
        await asyncio.wait_for(shadow._task, 2)
        row = rec.of("socket_closed")[0]
        self.assertEqual((row["schema"], row["phase"]), ("close_1000", "expected"))
        self.assertEqual(shadow.counters["unrecovered_death"], 0)

    async def test_session_end_after_our_end_finishes_early(self):
        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        shadow._end_wait = 5.0
        shadow.offer(Frame())
        await settle()
        shadow.close_nowait()
        await settle(0.02)
        ws.feed_json({"event": "session.end", "audio_duration_s": 1.0})
        t0 = time.monotonic()
        await asyncio.wait_for(shadow._task, 2)
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertEqual(rec.of("session_end")[0]["duration_sec"], 1.0)


# ── A9 isolation ─────────────────────────────────────────────────────────────

class TestIsolation(unittest.IsolatedAsyncioTestCase):
    async def _drive(self, shadow, n=600):
        """A simulated audio loop: every call must return fast and not raise."""
        worst = 0.0
        for i in range(n):
            t0 = time.perf_counter()
            shadow.offer(Frame())
            shadow.observe_main(type("E", (), {"type": "interim_transcript"})())
            shadow.on_local_vad("start" if i % 50 == 0 else "end")
            worst = max(worst, time.perf_counter() - t0)
            if i % 20 == 0:
                await asyncio.sleep(0)
        self.assertLess(worst, 0.05)

    async def test_connect_raises(self):
        async def factory(url, headers):
            raise ConnectionError(SENTINELS[0])

        shadow, rec, *_ = make_shadow(factory=factory)
        await self._drive(shadow)
        await settle()
        self.assertEqual(rec.of("connect_failed")[0]["schema"], "connector")
        self.assertEqual(shadow.counters["unrecovered_death"], 1)
        shadow.close_nowait()

    async def test_connect_never_returns(self):
        async def factory(url, headers):
            await asyncio.Event().wait()

        shadow, rec, *_ = make_shadow(factory=factory, connect_timeout=0.05)
        await self._drive(shadow, 200)
        await settle(0.15)
        self.assertEqual(rec.of("connect_failed")[0]["schema"], "timeout")
        self.assertEqual(shadow.counters["unrecovered_death"], 1)
        shadow.close_nowait()

    async def test_send_blocks_forever(self):
        ws = FakeWs(hang_send=True)
        shadow, rec, *_ = make_shadow(ws, send_stall=0.05)
        await self._drive(shadow, 800)
        await settle(0.2)
        self.assertEqual(len(rec.of("send_stalled")), 1)
        self.assertEqual(shadow.counters["unrecovered_death"], 1)
        self.assertTrue(ws.closed)
        shadow.close_nowait()

    async def test_full_queue_drops_and_logs_once(self):
        ws = FakeWs(hang_send=True)
        shadow, rec, *_ = make_shadow(ws, send_stall=5.0)
        for _ in range(pss.QUEUE_MAX + 300):
            shadow.offer(Frame())     # no await: the sender cannot drain
        self.assertGreaterEqual(shadow.counters["frames_dropped"], 299)
        self.assertEqual(len(rec.of("frames_dropped")), 1)
        shadow.close_nowait()
        await settle(0.1)

    async def test_receive_raises(self):
        ws = FakeWs(raise_on_receive=RuntimeError(SENTINELS[0]))
        shadow, rec, *_ = make_shadow(ws)
        await self._drive(shadow, 200)
        await settle()
        row = rec.of("shadow_failed")[0]
        self.assertEqual((row["schema"], row["phase"]), ("RuntimeError", "receiver"))
        self.assertNotIn(SENTINELS[0], json.dumps(rec.events))
        shadow.close_nowait()

    async def test_immediate_4000(self):
        ws = FakeWs([pss.SocketMessage(pss.MSG_CLOSE, None)], close_code=4000)
        shadow, rec, *_ = make_shadow(ws)
        await self._drive(shadow, 200)
        await settle()
        self.assertEqual(rec.of("socket_closed")[0]["schema"], "close_4000")
        self.assertEqual(shadow.counters["unrecovered_death"], 1)
        shadow.close_nowait()

    async def test_resampler_raises(self):
        class Boom:
            def __init__(self, *a):
                pass

            def push(self, frame):
                raise ValueError(SENTINELS[0])

        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        shadow._resampler_factory = Boom
        await self._drive(shadow, 200)       # 16k in == out, but a factory forces use
        await settle()
        self.assertEqual(rec.of("shadow_failed")[0]["phase"], "sender")
        self.assertEqual(shadow.counters["unrecovered_death"], 1)
        shadow.close_nowait()

    async def test_tracker_fault_does_not_escape(self):
        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        shadow.offer(Frame())
        await settle()

        def boom(*a, **k):
            raise RuntimeError(SENTINELS[0])

        shadow._tracker.vad_start = boom
        shadow.on_local_vad("start")
        shadow.on_local_vad("start")
        self.assertEqual(rec.of("shadow_failed")[0]["phase"], "vad")
        self.assertEqual(len(rec.of("shadow_failed")), 1)
        shadow.close_nowait()


# ── A10 close ────────────────────────────────────────────────────────────────

class TestClose(unittest.IsolatedAsyncioTestCase):
    async def test_idempotent_and_summary_is_synchronous(self):
        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        shadow.offer(Frame())
        await settle()
        shadow.close_nowait()
        names = [m["schema"] for m in rec.of("call_summary")]
        self.assertEqual(names, list(pss.COUNTER_NAMES))     # before any await
        shadow.close_nowait()
        self.assertEqual(len(rec.of("call_summary")), len(pss.COUNTER_NAMES))
        await asyncio.wait_for(shadow._task, 2)

    def test_close_without_a_loop_or_before_arming(self):
        shadow, rec, *_ = make_shadow(FakeWs())
        shadow.close_nowait()          # never armed: no summary, one closed_unarmed line
        self.assertEqual([c for c, _ in rec.events], ["closed_unarmed"])
        shadow.offer(Frame())          # closed: ignored, no loop needed
        self.assertIsNone(shadow._task)

    def test_close_with_no_running_loop_after_arming(self):
        async def arm():
            shadow, rec, *_ = make_shadow(FakeWs())
            shadow.offer(Frame())
            return shadow, rec

        loop = asyncio.new_event_loop()
        shadow, rec = loop.run_until_complete(arm())
        shadow.close_nowait()          # the loop is not running now
        self.assertEqual(len(rec.of("call_summary")), len(pss.COUNTER_NAMES))
        loop.run_until_complete(asyncio.wait({shadow._task}, timeout=2))
        loop.close()

    async def test_close_while_connecting_cancels(self):
        started = asyncio.Event()

        async def factory(url, headers):
            started.set()
            await asyncio.Event().wait()

        shadow, rec, *_ = make_shadow(factory=factory, connect_timeout=30)
        shadow.offer(Frame())
        await started.wait()
        shadow.close_nowait()
        await settle(0.05)
        self.assertTrue(shadow._task.done())

    async def test_aclose_is_bounded_when_the_socket_never_answers(self):
        ws = FakeWs(hang_send=True)
        shadow, rec, *_ = make_shadow(ws, send_stall=10.0)
        shadow._close_grace = 0.2
        shadow.offer(Frame())
        await settle()
        shadow.close_nowait()
        t0 = time.monotonic()
        await asyncio.wait({shadow._task}, timeout=3)     # the hard bound cancels it
        self.assertTrue(shadow._task.done())
        self.assertLess(time.monotonic() - t0, 3.0)
        self.assertTrue(ws.closed)


# ── A11 no text, ever ────────────────────────────────────────────────────────

def _walk(obj, seen, out, skip=frozenset()):
    if id(obj) in seen:
        return
    seen.add(id(obj))
    if isinstance(obj, (str, bytes)):
        out.append(obj if isinstance(obj, str) else obj.decode("utf-8", "ignore"))
    elif isinstance(obj, dict):
        for k, v in obj.items():
            _walk(k, seen, out)
            _walk(v, seen, out)
    elif isinstance(obj, (list, tuple, set, frozenset)):
        for v in obj:
            _walk(v, seen, out)
    elif hasattr(obj, "__slots__") or hasattr(obj, "__dict__"):
        names = list(getattr(obj, "__slots__", ()) or ())
        names += list(getattr(obj, "__dict__", {}).keys())
        for n in names:
            if n in skip:
                continue
            _walk(getattr(obj, n, None), seen, out)


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records = []

    def emit(self, record):
        self.records.append(record.getMessage())


class TestNoTextEver(unittest.IsolatedAsyncioTestCase):
    async def test_sentinels_fed_through_every_field_never_surface(self):
        lines: list[str] = []
        logger = StructuredLogger("phone_stt_shadow", writer=lines.append)
        capture = _Capture()
        root = logging.getLogger()
        old_level = root.level
        root.addHandler(capture)
        root.setLevel(logging.DEBUG)
        try:
            ws = FakeWs()
            rec = pss._Emitter(logger)
            shadow, _, clock, _, _ = make_shadow(ws, rec=rec)
            shadow.offer(Frame())
            await settle()
            shadow.on_local_vad("start")
            s0, s1, s2, s3 = SENTINELS
            ws.feed_json({"event": "session.begin", "request_id": s3, "config": {"x": s0}})
            ws.feed_json({"event": "transcript.partial", "text": s0, "language": s1})
            ws.feed_json({"event": "transcript.partial", "text": f"{s0} {s2}"})
            ws.feed_json({"event": "error", "code": s0, "is_fatal": False, "message": s1})
            ws.feed_json({"event": "transcript.final", "text": f"{s0} {s1} {s2}"})
            ws.feed(pss.MSG_TEXT, f"garbage {s0} {{")
            ws.feed_json({"event": s2, "text": s0})
            await settle()
            clock.t += 0.8
            shadow.observe_main(type("E", (), {
                "type": type("T", (), {"value": "final_transcript"})(),
                "alternatives": [type("A", (), {"text": f"{s0} {s1}"})()]})())
            shadow.on_local_vad("end")
            ws.close_code = 1011
            ws.feed(pss.MSG_CLOSE)
            await settle()
            shadow.close_nowait()
            await asyncio.wait_for(shadow._task, 2)

            # a second call whose socket raises with sentinel text
            ws2 = FakeWs(raise_on_receive=RuntimeError(f"{s0} {s1}"))
            shadow2, *_ = make_shadow(ws2, rec=rec)
            shadow2.offer(Frame())
            await settle()
            shadow2.close_nowait()
            await settle(0.2)

            blob = "\n".join(lines)
            self.assertTrue(lines)
            for s in SENTINELS:
                self.assertNotIn(s, blob)
                self.assertFalse(any(s in r for r in capture.records), s)
            for sh in (shadow, shadow2):
                texts: list[str] = []
                skip = frozenset({"_ws", "_factory", "_task", "_queue", "_lock", "_emit",
                                  "_armed", "_clock", "_resampler_factory", "_hard_timer",
                                  "_resampler"})
                _walk(sh, set(), texts, skip)
                walked = "\n".join(texts)
                for s in SENTINELS:
                    self.assertNotIn(s, walked)
        finally:
            root.removeHandler(capture)
            root.setLevel(old_level)

    def test_module_source_has_no_stdlib_logging_or_exc_info(self):
        import ast
        tree = ast.parse((_CTX / "phone_stt_shadow.py").read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
            elif isinstance(node, ast.keyword):
                self.assertNotEqual(node.arg, "exc_info")
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertNotIn(node.func.id, ("print", "repr"))
        self.assertNotIn("logging", imported)
        self.assertNotIn("traceback", imported)


# ── A12 allowlist ────────────────────────────────────────────────────────────

class TestAllowlist(unittest.IsolatedAsyncioTestCase):
    async def test_every_line_keeps_every_intended_field(self):
        lines: list[str] = []
        logger = StructuredLogger("phone_stt_shadow", writer=lines.append)
        with _Env(PHONE_STT_SHADOW="on", SARVAM_API_KEY=_KEY, PHONE_STT_SHADOW_MODEL="saaras:v4"):
            built = pss.build_call_shadow(armed=lambda: True, logger=logger)
        self.assertIsNotNone(built)
        sent: list[tuple] = []

        class Spy(pss._Emitter):
            def __call__(self, category, *, level="info", **meta):
                sent.append((category, dict(meta)))
                super().__call__(category, level=level, **meta)

        ws = FakeWs()
        shadow, _, clock, _, _ = make_shadow(ws, rec=Spy(logger))
        shadow.offer(Frame())
        await settle()
        shadow.on_local_vad("start")
        ws.feed_json({"event": "session.begin"})
        ws.feed_json({"event": "transcript.partial", "text": "a b c"})
        ws.feed_json({"event": "error", "code": "invalid_config", "is_fatal": False,
                      "status_code": 400})
        ws.feed_json({"event": "session.end", "audio_duration_s": 3.2})
        await settle()
        clock.t += 1
        shadow.on_local_vad("end")
        shadow.observe_main(type("E", (), {
            "type": "final_transcript",
            "alternatives": [type("A", (), {"text": "x y"})()]})())
        shadow.close_nowait()
        await asyncio.wait_for(shadow._task, 2)
        rows = [json.loads(x) for x in lines]
        self.assertTrue(rows)
        for row in rows:
            self.assertLessEqual(set(row), _ALLOWED_KEYS, row)
            self.assertEqual(row["error_type"], "phone_stt_shadow")
        # no intended field was silently dropped by a validator
        by_cat: dict[str, list] = {}
        for row in rows:
            by_cat.setdefault(row["error_category"], []).append(row)
        for cat, meta in sent:
            self.assertTrue(any(all(row.get(k) == v for k, v in meta.items())
                                for row in by_cat[cat]), (cat, meta))
        self.assertEqual(by_cat["config"][0]["model"], "saaras:v4")

    def test_default_model_name_is_ident_safe(self):
        lines: list[str] = []
        pss._Emitter(StructuredLogger("phone_stt_shadow", writer=lines.append))(
            "config", model=pss.DEFAULT_MODEL, schema="fast", option_count=16000,
            duration_sec=0.5, turn_index=700)
        row = json.loads(lines[0])
        self.assertEqual(row["model"], "saaras:v3-realtime")
        self.assertEqual(row["turn_index"], 700)


# ── A13 caps ─────────────────────────────────────────────────────────────────

class TestCaps(unittest.IsolatedAsyncioTestCase):
    async def test_session_cap_ends_the_socket_as_expected(self):
        ws = FakeWs()
        shadow, rec, clock, *_ = make_shadow(ws)
        shadow.offer(Frame())
        await settle()
        clock.t += pss.MAX_SESSION_SEC + 1
        await asyncio.wait_for(shadow._task, 3)
        row = rec.of("socket_closed")[0]
        self.assertEqual((row["schema"], row["phase"]), ("close_1000", "expected"))
        self.assertEqual(shadow.counters["unrecovered_death"], 0)
        self.assertEqual(ws.sent[-1], {"event": "end"})

    async def test_after_a_graceful_end_the_audio_path_stops_counting(self):
        # Review r1: once the supervisor is done (1 h cap), offer() must not keep
        # filling the queue and counting every frame as dropped.
        ws = FakeWs()
        shadow, rec, clock, *_ = make_shadow(ws)
        shadow.offer(Frame())
        await settle()
        clock.t += pss.MAX_SESSION_SEC + 1
        await asyncio.wait_for(shadow._task, 3)
        self.assertTrue(shadow._dead)
        offered = shadow.counters["frames_offered"]
        for _ in range(pss.QUEUE_MAX + 50):
            shadow.offer(Frame())
        self.assertEqual(shadow.counters["frames_offered"], offered)
        self.assertEqual(shadow.counters["frames_dropped"], 0)
        self.assertEqual(shadow.counters["unrecovered_death"], 0)
        shadow.close_nowait()
        self.assertEqual(len(rec.of("call_summary")), len(pss.COUNTER_NAMES))

    async def test_wait_closed_is_bounded_and_never_raises(self):
        ws = FakeWs()
        shadow, rec, *_ = make_shadow(ws)
        await shadow.wait_closed(0.05)           # no task yet
        shadow.offer(Frame())
        await settle()
        shadow.close_nowait()
        await shadow.wait_closed(2.0)
        self.assertTrue(shadow._task.done())

    def test_constants_match_the_plan(self):
        self.assertEqual(
            (pss.QUEUE_MAX, pss.MAX_SESSION_SEC, pss.MAX_SEGMENTS, pss.WORD_CAP,
             pss.TAIL, pss.SETTLE, pss.NONFATAL_LOG_LIMIT, pss.PING_SEC,
             pss.CONNECT_TIMEOUT_SEC),
            (256, 3600.0, 2000, 999, 1.0, 3.0, 5, 15.0, 5.0))


if __name__ == "__main__":
    unittest.main()
