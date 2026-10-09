"""M015 PR-1: the livekit-agents 1.6.4 facts the STT shadow relies on.

Run against the REAL SDK, in CI's "STT shadow real-SDK contract" step (a venv with
requirements.txt, ``STT_SHADOW_SDK_CONTRACT_REQUIRED=1``, a skip is a failure).
The bare-python worker step stubs the SDK, so there these tests skip.

What `phone_stt_shadow` and `phone.phone_agent_class(..., stt_shadow=...)` assume:

1. the SDK reuses its STT pipeline across an agent handoff ONLY while
   ``type(agent).stt_node is Agent.stt_node`` - which is why the class must carry
   NO ``stt_node`` override when the shadow is off (source pin);
2. ``Agent.stt_node`` returns ``Agent.default.stt_node(...)``, an async generator,
   and ``AudioRecognition._stt_pump`` accepts a coroutine or an async iterable
   (so the plain-def override returning an async generator is valid);
3. the main STT's final is ``SpeechEventType.FINAL_TRANSCRIPT`` with
   ``alternatives[0].text`` (all `observe_main` reads, reduced to a word count);
4. ``rtc.AudioResampler`` converts the room input rates (48 k with RNNoise, 24 k
   without) to the 16 k / 8 k the socket takes, mono int16, and the SDK's
   ``silence_frame_like`` substitute frames pass through unchanged;
5. a real ``aiohttp`` WebSocket round trip against a LOCAL fake Sarvam server (no
   network): the ``API-SUBSCRIPTION-KEY`` header, the query, JSON base64
   ``audio_input``, begin/partial/final/end, and a 4000 rejection.

No candidate data: synthetic text and silent audio only.
"""

from __future__ import annotations

import asyncio
import base64
import collections.abc
import inspect
import json
import os
import pathlib
import unittest

_REQUIRED = os.environ.get("STT_SHADOW_SDK_CONTRACT_REQUIRED") == "1"
_CTX = pathlib.Path(__file__).resolve().parent.parent


def _real_sdk():
    try:
        import aiohttp  # noqa: PLC0415
        import livekit.agents as agents  # noqa: PLC0415
        from livekit import rtc  # noqa: PLC0415
        from livekit.agents import stt, utils  # noqa: PLC0415
        from livekit.agents.voice import agent as agent_mod  # noqa: PLC0415
        from livekit.agents.voice import agent_activity, audio_recognition  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(getattr(agents, "__version__", None), str):
        return None  # the test stub
    return {
        "aiohttp": aiohttp, "rtc": rtc, "stt": stt, "utils": utils,
        "agent": agent_mod, "agent_activity": agent_activity,
        "audio_recognition": audio_recognition,
    }


_SDK = _real_sdk()


def setUpModule():
    if _SDK is None and _REQUIRED:
        raise AssertionError("STT_SHADOW_SDK_CONTRACT_REQUIRED=1 but the real SDK is missing")


@unittest.skipIf(_SDK is None, "real livekit-agents SDK not installed (bare python)")
class TestSdkContract(unittest.TestCase):
    def test_sdk_is_the_pinned_version(self):
        import livekit.agents as agents
        self.assertEqual(agents.__version__, "1.6.4")

    def test_stt_pipeline_is_reused_only_with_the_default_stt_node(self):
        src = inspect.getsource(_SDK["agent_activity"])
        self.assertIn("type(self.agent).stt_node is Agent.stt_node", src)
        self.assertIn("type(new_activity.agent).stt_node is Agent.stt_node", src)

    def test_agent_stt_node_is_the_default_async_generator(self):
        Agent = _SDK["agent"].Agent
        self.assertIn("Agent.default.stt_node(self, audio, model_settings)",
                      inspect.getsource(Agent.stt_node))
        self.assertTrue(inspect.isasyncgenfunction(Agent.default.stt_node))

    def test_stt_pump_accepts_a_coroutine_or_an_async_iterable(self):
        src = inspect.getsource(_SDK["audio_recognition"]._STTPipeline)
        self.assertIn("node = self._stt_node(self._audio_ch, ModelSettings())", src)
        self.assertIn("asyncio.iscoroutine(node)", src)
        self.assertIn("isinstance(node, AsyncIterable)", src)

    def test_the_installed_override_is_a_plain_def_returning_an_async_iterable(self):
        import phone
        import phone_stt_shadow as pss

        class Spy:
            def offer(self, f):
                pass

            def observe_main(self, e):
                pass

            def close_nowait(self):
                pass

        Agent = _SDK["agent"].Agent
        off = phone.phone_agent_class(Agent)
        self.assertNotIn("stt_node", vars(off))
        self.assertIs(off.stt_node, Agent.stt_node)
        on = phone.phone_agent_class(Agent, stt_shadow=Spy())
        self.assertIn("stt_node", vars(on))
        self.assertFalse(inspect.iscoroutinefunction(vars(on)["stt_node"]))

        async def empty():
            if False:
                yield None

        self.assertTrue(inspect.isfunction(pss.wrap_stt_node(lambda s, a, m: empty(), Spy())))

        async def run():
            wrapped = pss.wrap_stt_node(lambda s, a, m: empty(), Spy())
            result = wrapped(None, empty(), None)
            self.assertIsInstance(result, collections.abc.AsyncIterable)
            self.assertFalse(asyncio.iscoroutine(result))
            return [x async for x in result]

        self.assertEqual(asyncio.run(run()), [])

    def test_main_stt_final_event_shape(self):
        import phone_stt_shadow as pss
        stt = _SDK["stt"]
        self.assertEqual(stt.SpeechEventType.FINAL_TRANSCRIPT.value, "final_transcript")
        ev = stt.SpeechEvent(
            type=stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives=[stt.SpeechData(language="en-IN", text="alpha beta gamma delta")])
        self.assertEqual(ev.alternatives[0].text.split()[0], "alpha")
        rec = []

        def emit(cat, **meta):
            rec.append((cat, meta))

        shadow = pss.PhoneSttShadow(
            pss.ShadowConfig(), api_key="synthetic", armed=lambda: False, emitter=emit)
        shadow._latched = True
        shadow._tracker.arm()
        shadow._tracker.vad_start(1.0)
        shadow.observe_main(ev)
        self.assertEqual(shadow.counters["main_finals"], 1)
        shadow._tracker.vad_end(2.0)
        shadow._tracker.close(2.5)
        legacy = [m for c, m in rec if c == "seg_legacy_final"]
        self.assertEqual(legacy[0]["option_count"], 4)

    def test_resampler_rates_and_silence_substitution(self):
        import phone_stt_shadow as pss
        rtc, utils = _SDK["rtc"], _SDK["utils"]

        def frames(rate, n=50):
            spc = rate // 100
            return [rtc.AudioFrame(data=bytes(spc * 2), sample_rate=rate,
                                   num_channels=1, samples_per_channel=spc) for _ in range(n)]

        for in_rate, out_rate in ((48000, 16000), (24000, 16000), (48000, 8000)):
            rs = pss._default_resampler_factory(in_rate, out_rate, 1)
            total = sum(len(b) for f in frames(in_rate) for b in rs.push(f))
            total += sum(len(b) for b in rs.flush())
            expected = out_rate * 2 // 2                    # 0.5 s of int16
            self.assertLessEqual(abs(total - expected), out_rate * 2 // 50, (in_rate, out_rate))
        silent = utils.audio.silence_frame_like(frames(48000, 1)[0])
        rs = pss._default_resampler_factory(48000, 16000, 1)
        rs.push(silent)                                      # accepted, no error
        self.assertEqual(silent.sample_rate, 48000)
        self.assertEqual(silent.num_channels, 1)


@unittest.skipIf(_SDK is None, "real livekit-agents SDK not installed (bare python)")
class TestLocalFakeSarvam(unittest.IsolatedAsyncioTestCase):
    """The default ws_factory against a real aiohttp server on 127.0.0.1."""

    SENTINEL_TEXT = "zebra quantum marmalade"

    async def _serve(self, handler):
        web = _SDK["aiohttp"].web
        app = web.Application()
        app.router.add_get("/speech-to-text-realtime/ws", handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        return runner, port

    def _shadow(self, port, lines):
        import phone_stt_shadow as pss
        from observability import StructuredLogger
        emit = pss._Emitter(StructuredLogger("phone_stt_shadow", writer=lines.append))
        shadow = pss.PhoneSttShadow(
            pss.ShadowConfig(), api_key="synthetic-shadow-key", armed=lambda: True, emitter=emit)
        query = shadow._url.split("?", 1)[1]
        shadow._url = f"ws://127.0.0.1:{port}/speech-to-text-realtime/ws?{query}"
        shadow._tick_sec = 0.05
        return shadow

    async def test_end_to_end_metrics_and_no_text(self):
        import phone_stt_shadow as pss
        rtc = _SDK["rtc"]
        web = _SDK["aiohttp"].web
        seen: dict = {"audio": [], "events": []}

        async def handler(request):
            seen["key"] = request.headers.get("API-SUBSCRIPTION-KEY")
            seen["query"] = dict(request.query)
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.send_json({"event": "session.begin", "request_id": self.SENTINEL_TEXT})
            async for msg in ws:
                d = json.loads(msg.data)
                seen["events"].append(d["event"])
                if d["event"] == "audio_input":
                    seen["audio"].append(len(base64.b64decode(d["audio"])))
                    if len(seen["audio"]) == 2:
                        await ws.send_json({"event": "vad.speech_start"})
                        await ws.send_json({"event": "transcript.partial", "text": "zebra"})
                        await ws.send_json({"event": "transcript.partial",
                                            "text": self.SENTINEL_TEXT})
                        await ws.send_json({"event": "transcript.final",
                                            "text": self.SENTINEL_TEXT, "language": "en-IN"})
                elif d["event"] == "end":
                    await ws.send_json({"event": "session.end", "audio_duration_s": 1.0})
                    await ws.close(code=1000)
            return ws

        runner, port = await self._serve(handler)
        lines: list[str] = []
        try:
            shadow = self._shadow(port, lines)
            shadow.on_local_vad("start")                    # before arming: ignored
            frame = rtc.AudioFrame(data=bytes(960), sample_rate=48000, num_channels=1,
                                   samples_per_channel=480)
            shadow.offer(frame)
            shadow.on_local_vad("start")
            for _ in range(59):
                shadow.offer(rtc.AudioFrame(data=bytes(960), sample_rate=48000, num_channels=1,
                                            samples_per_channel=480))
                await asyncio.sleep(0.005)
            await asyncio.sleep(0.4)
            shadow.on_local_vad("end")
            shadow.close_nowait()
            await asyncio.wait_for(shadow._task, 5)
        finally:
            await runner.cleanup()

        rows = [json.loads(x) for x in lines]
        cats = [r["error_category"] for r in rows]
        self.assertEqual(seen["key"], "synthetic-shadow-key")
        self.assertEqual(seen["query"]["model"], "saaras:v3-realtime")
        self.assertEqual(seen["query"]["sample_rate"], "16000")
        self.assertTrue(all(n == 3200 for n in seen["audio"][:2]))
        self.assertEqual(seen["events"][-1], "end")
        for expected in ("armed", "socket_open", "session_begin", "seg_partial_lead",
                         "seg_three_word", "seg_summary", "call_summary", "session_end",
                         "socket_closed"):
            self.assertIn(expected, cats)
        summary = {r["schema"]: r["option_count"] for r in rows if r["error_category"] == "call_summary"}
        self.assertEqual((summary["rt_partials"], summary["rt_finals"], summary["unrecovered_death"]),
                         (2, 1, 0))
        closed = [r for r in rows if r["error_category"] == "socket_closed"][0]
        self.assertEqual((closed["schema"], closed["phase"]), ("close_1000", "expected"))
        blob = "\n".join(lines)
        for word in (self.SENTINEL_TEXT, "zebra", "synthetic-shadow-key", "127.0.0.1"):
            self.assertNotIn(word, blob)

    async def test_rejection_4000(self):
        web = _SDK["aiohttp"].web

        async def handler(request):
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.close(code=4000)
            return ws

        runner, port = await self._serve(handler)
        lines: list[str] = []
        try:
            shadow = self._shadow(port, lines)
            rtc = _SDK["rtc"]
            shadow.offer(rtc.AudioFrame(data=bytes(960), sample_rate=48000, num_channels=1,
                                        samples_per_channel=480))
            await asyncio.sleep(0.5)
            shadow.close_nowait()
            await asyncio.wait({shadow._task}, timeout=5)
        finally:
            await runner.cleanup()
        rows = [json.loads(x) for x in lines]
        closed = [r for r in rows if r["error_category"] == "socket_closed"][0]
        self.assertEqual((closed["schema"], closed["phase"]), ("close_4000", "unexpected"))
        summary = {r["schema"]: r["option_count"] for r in rows if r["error_category"] == "call_summary"}
        self.assertEqual(summary["unrecovered_death"], 1)

    async def test_unreachable_server_is_a_logged_connect_failure(self):
        import socket
        lines: list[str] = []
        with socket.socket() as probe:         # a port nothing listens on
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        shadow = self._shadow(port, lines)
        rtc = _SDK["rtc"]
        shadow.offer(rtc.AudioFrame(data=bytes(960), sample_rate=48000, num_channels=1,
                                    samples_per_channel=480))
        await asyncio.wait({shadow._task}, timeout=8)
        self.assertTrue(shadow._task.done())
        shadow.close_nowait()
        rows = [json.loads(x) for x in lines]
        failed = [r for r in rows if r["error_category"] == "connect_failed"]
        self.assertEqual(len(failed), 1)
        self.assertIn(failed[0]["schema"], ("connector", "other"))


@unittest.skipIf(_SDK is None, "real livekit-agents SDK not installed (bare python)")
class TestPipelineRestart(unittest.IsolatedAsyncioTestCase):
    """Review r1 (major): the gate's pre-consent ``clear_user_turn()`` makes the
    SDK cancel its ``_STTPipeline`` pump and build a new one (which calls
    ``stt_node`` again). The shadow belongs to the call, so it must survive that,
    arm after consent, and count frames of the REBUILT pipeline."""

    def test_clear_user_turn_is_a_pipeline_rebuild(self):
        src = inspect.getsource(_SDK["audio_recognition"].AudioRecognition.clear_user_turn)
        self.assertIn("self.update_stt(None)", src)
        self.assertIn("self.update_stt(stt)", src)

    async def test_shadow_survives_pipeline_restarts_before_and_after_arming(self):
        import phone_stt_shadow as pss
        rtc = _SDK["rtc"]
        AudioRecognition = _SDK["audio_recognition"]

        class _Ws:
            close_code = None

            def __init__(self):
                self.sent = 0

            async def send_str(self, data):
                self.sent += 1

            async def receive(self):
                await asyncio.Event().wait()

            async def close(self):
                pass

        ws = _Ws()
        rows: list = []

        async def factory(url, headers):
            return ws

        flag = [False]
        shadow = pss.PhoneSttShadow(
            pss.ShadowConfig(), api_key="synthetic", armed=lambda: flag[0],
            ws_factory=factory, emitter=lambda cat, **m: rows.append(cat))

        async def base(audio, model_settings):
            async for _ in audio:
                pass
            if False:
                yield None

        node = pss.wrap_stt_node(lambda self, a, m: base(a, m), shadow)

        def stt_node(audio, model_settings):
            return node(None, audio, model_settings)

        def frame():
            return rtc.AudioFrame(data=bytes(960), sample_rate=48000, num_channels=1,
                                  samples_per_channel=480)

        async def run_pipeline(n):
            pipe = AudioRecognition._STTPipeline(stt_node)
            for _ in range(n):
                pipe.audio_ch.send_nowait(frame())
            await asyncio.sleep(0.05)
            await pipe.aclose()                 # what update_stt(None) does

        await run_pipeline(10)                  # pre-consent pipeline, then torn down
        self.assertFalse(shadow._closed)
        self.assertEqual(shadow.counters["frames_offered"], 0)
        flag[0] = True                          # consent
        await run_pipeline(10)                  # the rebuilt pipeline
        self.assertTrue(shadow._latched)
        self.assertEqual(shadow.counters["frames_offered"], 10)
        await run_pipeline(10)                  # and another restart after arming
        self.assertEqual(shadow.counters["frames_offered"], 20)
        self.assertFalse(shadow._closed)
        shadow.close_nowait()                   # the teardown owner closes it, once
        await asyncio.wait({shadow._task}, timeout=5)
        self.assertEqual(rows.count("armed"), 1)
        self.assertNotIn("closed_unarmed", rows)


if __name__ == "__main__":
    unittest.main()
