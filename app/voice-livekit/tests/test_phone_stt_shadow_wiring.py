"""M015 PR-1: agent.py / phone.py wiring, a full-session parity run, packaging.

The shadow must be invisible to the call: the same fake consented screening is
run with the switch off and with it ON (a real shadow over a fake socket, patched
in at the single build seam) and every observable output must be identical. The
source pins keep the four small agent.py edits where the plan put them.
Synthetic data only.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import pathlib
import re
import unittest
from unittest.mock import patch

from tests import test_phone_gate as fixtures
from tests.test_phone_endpointing_phase import _SessionHarness
from tests.test_phone_stt_shadow import FakeWs, Frame, make_shadow

import phone_stt_shadow as pss

agent_mod = fixtures.agent_mod
phone = fixtures.phone

_CTX = pathlib.Path(__file__).resolve().parent.parent
_REPO = _CTX.parent.parent

# The ONE-line COPY at bd5ace12 (every module that must survive this change).
_EXISTING_MODULES = (
    "agent.py", "closing.py", "noise_suppression.py", "endpointing_phase.py",
    "gate_judge.py", "observability.py", "persistence.py", "phone.py", "phone_canary.py",
    "prompting.py", "provenance.py", "provider_resilience.py", "recording.py",
    "recording_api.py", "worker_ready_api.py", "r1_context.py", "r1_lines.py", "r1_llm.py",
    "r1_persistence.py", "r1_phases.py", "r1_routing.py", "r1_session.py",
    "r1_commitment.py", "r1_content.py", "r1_guard.py", "r1_personas.py", "r1_prompts.py",
    "r1_replies.py", "r1_roleplay.py", "r1_scheduler.py", "r1_script.py", "r1_text.py",
    "r1_tracker.py", "r1_world.py", "r1_latency.py", "r1_linecache.py", "r1_tts.py",
)


class TestSourcePins(unittest.TestCase):
    def setUp(self):
        self.src = (_CTX / "agent.py").read_text(encoding="utf-8").replace("\r\n", "\n")
        self.run_src = inspect.getsource(agent_mod._run_phone_session)

    def test_built_once_after_the_persist_flag(self):
        self.assertEqual(self.run_src.count("build_call_shadow("), 1)
        self.assertLess(
            self.run_src.index("assessment_persist_active: list[bool] = [False]"),
            self.run_src.index("build_call_shadow("))

    def test_build_is_inside_try(self):
        self.assertRegex(
            self.run_src,
            r"try:\n\s+stt_shadow = phone_stt_shadow\.build_call_shadow\(\n"
            r"\s+armed=lambda: bool\(assessment_persist_active\[0\]\)\)\n"
            r"\s+except Exception:.*\n\s+stt_shadow = None")

    def test_agent_class_receives_the_shadow(self):
        self.assertIn("phone.phone_agent_class(Agent, stt_shadow=stt_shadow)(", self.run_src)

    def test_vad_hooks_are_guarded_and_in_the_right_branches(self):
        m = re.search(
            r'if event_type == "start_of_speech":\n(?P<body>(?:.*\n)*?)\s+return\n', self.run_src)
        self.assertIsNotNone(m)
        self.assertRegex(m.group("body"),
                         r'try:\n\s+stt_shadow\.on_local_vad\("start"\)\n\s+except Exception')
        # r2: the end hook runs LAST - after the existing bookkeeping, `set()` and
        # timestamps - so it cannot shift the turn-taking event or a timestamp.
        start = self.run_src.index('candidate_speaking["ended_mono"] = _monotonic()')
        stop = self.run_src.index("session = _build_phone_provider_session(", start)
        body = self.run_src[start:stop]
        self.assertRegex(
            body, r'try:\n\s+stt_shadow\.on_local_vad\("end"\)\n\s+except Exception')
        hook = body.index('stt_shadow.on_local_vad("end")')
        self.assertLess(body.index("candidate_speech_ended.set()"), hook)
        self.assertLess(body.index('latency_state["local_vad_end_wall"]'), hook)
        self.assertLess(body.index("histogram_metric"), hook)
        self.assertEqual(body.count("stt_shadow.on_local_vad"), 1)

    def test_teardown_backstop_is_guarded(self):
        teardown = self.run_src[self.run_src.index("async def _teardown_impl"):]
        head = teardown[:2500]
        self.assertRegex(head, r'try:\n\s+stt_shadow\.close_nowait\(\)\n\s+except Exception')
        self.assertLess(head.index("recording_settle_started = True"),
                        head.index("stt_shadow.close_nowait()"))

    def test_watchdog_is_armed_before_the_bounded_shadow_wait(self):
        shutdown = self.run_src[self.run_src.index("async def _phone_job_shutdown"):]
        shutdown = shutdown[:1500]
        self.assertLess(shutdown.index("_arm_phone_job_watchdog()"),
                        shutdown.index("stt_shadow.wait_closed(1.0)"))

    def test_withdrawal_stops_the_shadow(self):
        # r2 (lens 2): a withdrawing candidate's audio must not keep flowing to
        # the second vendor socket. The three latch points call the notifier.
        self.assertIn(
            "on_withdrawal=(stt_shadow.close_nowait if stt_shadow is not None else None),",
            self.run_src)
        native = inspect.getsource(agent_mod._run_native_phone_screening)
        self.assertIn("on_withdrawal: Callable[[], None] | None = None,", native)
        self.assertEqual(native.count("_notify_withdrawal()"), 4)   # def + 3 call sites
        for marker in ('withdrawal["stage"] = "latched"', 'withdrawal["stage"] = "judged"'):
            at = native.index(marker)
            self.assertIn("_notify_withdrawal()", native[at - 200:at])
        at = native.index("def _end_midcall_opted_out")
        self.assertIn("_notify_withdrawal()", native[at:at + 400])

    def test_no_session_handler_references_the_shadow(self):
        for m in re.finditer(r"session\.on\(", self.run_src):
            self.assertNotIn("stt_shadow", self.run_src[m.start():m.start() + 200])

    def test_the_shadow_never_touches_gate_recording_or_browser_modules(self):
        shadow_src = (_CTX / "phone_stt_shadow.py").read_text(encoding="utf-8")
        imports = re.findall(r"(?m)^(?:from|import) (\w+)", shadow_src)
        for banned in ("agent", "phone", "gate_judge", "recording", "persistence",
                       "endpointing_phase", "noise_suppression", "prompting"):
            self.assertNotIn(banned, imports)

    def test_build_seam_is_off_by_default_without_any_env(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PHONE_STT_SHADOW", None)
            self.assertIsNone(pss.build_call_shadow(armed=lambda: True))


async def _no_warmup(*_a, **_k):
    """The harness would otherwise run the real Google warm-up, whose FIRST call
    imports google.genai synchronously (about 5 s blocking the event loop). That
    one-off stall made the first (cold) run differ from later ones - the source of
    the flaky parity result. Both runs of every comparison skip it."""
    return None


class TestSessionParity(unittest.IsolatedAsyncioTestCase):
    """One consented screening, switch off vs on: identical observable output."""

    _warmed = False

    async def _warm(self):
        """The very first harness run of the process pays one-off lazy imports and
        compiles that stall the event loop and change the scripted timing; a cold
        run compared against a warm one was the flaky parity result. Burn it."""
        if not TestSessionParity._warmed:
            TestSessionParity._warmed = True
            await self._run_once(False)

    async def _run(self, shadow_on: bool):
        await self._warm()
        return await self._run_once(shadow_on)

    async def _run_once(self, shadow_on: bool):
        built: list = []
        classes: list = []
        real_class = phone.phone_agent_class

        def spy_class(base, **kw):
            cls = real_class(base, **kw)
            classes.append(cls)
            return cls

        feeders: list = []

        final_event = type("E", (), {
            "type": "final_transcript",
            "alternatives": [type("A", (), {"text": "one two three"})()]})()

        async def feed(shadow):
            # Stands in for the SDK pump: synthetic frames every few ms run through
            # the INSTALLED stt_node tee (stub main STT underneath, scripted finals)
            # with the local-VAD hook fired around them, until the call's teardown
            # closes the shadow. This is what ARMS it (at consent).
            while not classes and not shadow._closed:
                await asyncio.sleep(0.005)
            if not classes:
                return

            async def frames():
                i = 0
                while not shadow._closed:
                    if i % 20 == 0:
                        shadow.on_local_vad("start")
                    elif i % 20 == 10:
                        shadow.on_local_vad("end")
                    i += 1
                    yield Frame()
                    await asyncio.sleep(0.005)

            node = classes[-1].stt_node(object(), frames(), None)
            async for _ in node:
                pass

        def build(**kwargs):
            shadow, *_ = make_shadow(FakeWs())
            shadow._armed = kwargs["armed"]
            built.append(shadow)
            feeders.append(asyncio.get_running_loop().create_task(feed(shadow)))
            return shadow

        env = {"PHONE_STT_SHADOW": "on" if shadow_on else "off", "SARVAM_API_KEY": "synthetic-key"}
        patcher = patch.object(pss, "build_call_shadow", side_effect=build) if shadow_on \
            else patch.object(pss, "build_call_shadow", wraps=pss.build_call_shadow)
        async def stub_stt_node(self, audio, model_settings):
            # the main STT stand-in: consumes every frame, emits a scripted final
            n = 0
            async for _ in audio:
                n += 1
                if n % 40 == 0:
                    yield final_event

        with patch.dict(os.environ, env), patcher, \
                patch.object(agent_mod.Agent, "stt_node", new=stub_stt_node, create=True), \
                patch.object(phone, "phone_agent_class", side_effect=spy_class), \
                patch.object(phone, "phone_warm_google_connection", new=_no_warmup):
            session, client = await _SessionHarness(self).run(
                replies=["Yes.", "I worked on a billing system.", "Another answer."])
        for task in feeders:
            await asyncio.wait_for(task, 5)
            if built and built[0]._task is not None:
                await asyncio.wait_for(asyncio.wait({built[0]._task}), 5)
        return session, client, built, classes

    @staticmethod
    def _observable(session, client):
        return {
            "spoken": list(session.spoken),
            "emitted": list(session.emitted_bot_turns),
            "calls": [(c[0], sorted((c[2] or {}).keys())) for c in client.calls],
            # per-item persists are concurrent tasks: order within a call is not
            # deterministic even with the switch off, so compare as a multiset
            "items": sorted((str(t.get("speaker") or t.get("role")), str(t.get("text")))
                            for t in client.item_turns),
            "boundaries": len(client.boundaries),
            "timeline": list(client.timeline),
        }

    async def test_off_is_repeatable(self):
        a = await self._run(False)
        b = await self._run(False)
        self.assertEqual(self._observable(a[0], a[1]), self._observable(b[0], b[1]))

    async def test_off_and_on_are_identical(self):
        off_session, off_client, _, off_classes = await self._run(False)
        on_session, on_client, built, on_classes = await self._run(True)
        self.assertEqual(len(built), 1)
        self.assertNotIn("stt_node", vars(off_classes[0]))
        self.assertIn("stt_node", vars(on_classes[0]))
        self.assertEqual(self._observable(off_session, off_client),
                         self._observable(on_session, on_client))
        self.assertTrue(off_session.spoken)
        self.assertTrue(built[0]._closed)   # teardown closed the shadow
        # the ARMED path ran end to end beside the call: it latched at consent,
        # opened its socket, took frames and emitted its summary - and the call's
        # observable output above is still identical.
        self.assertTrue(built[0]._latched)
        self.assertGreater(built[0].counters["frames_offered"], 0)
        # the tee really ran: frames reached the shadow through the installed
        # stt_node, the main STT's finals were observed, the VAD hook drove segments
        self.assertGreater(built[0].counters["chunks_sent"], 0)
        self.assertGreater(built[0].counters["main_finals"], 0)
        self.assertGreater(built[0].counters["segments"], 0)
        self.assertEqual(built[0].counters["frames_dropped"], 0)

    async def test_a_build_exception_leaves_the_call_unchanged(self):
        await self._warm()
        off_session, off_client, _, _ = await self._run(False)
        with patch.dict(os.environ, {"PHONE_STT_SHADOW": "on"}), \
                patch.object(pss, "build_call_shadow", side_effect=RuntimeError("boom")), \
                patch.object(phone, "phone_warm_google_connection", new=_no_warmup):
            session, client = await _SessionHarness(self).run(
                replies=["Yes.", "I worked on a billing system.", "Another answer."])
        self.assertEqual(self._observable(off_session, off_client),
                         self._observable(session, client))


class TestPackaging(unittest.TestCase):
    def test_dockerfile_one_copy_line_ships_the_module_and_keeps_every_other(self):
        dockerfile = (_CTX / "Dockerfile").read_text(encoding="utf-8")
        copies = re.findall(r"(?m)^COPY agent\.py .*\./\r?$", dockerfile)
        self.assertEqual(len(copies), 1)
        self.assertRegex(copies[0], r"\bphone_stt_shadow\.py\b")
        for module in _EXISTING_MODULES:
            self.assertRegex(copies[0], rf"\b{re.escape(module)}\b")

    def test_quality_workflow_compiles_it_and_runs_the_sdk_contract(self):
        workflow = (_REPO / ".github" / "workflows" / "quality.yml").read_text(encoding="utf-8")
        compile_line = next(l for l in workflow.splitlines() if "py_compile" in l)
        self.assertIn("app/voice-livekit/phone_stt_shadow.py", compile_line)
        self.assertIn("STT_SHADOW_SDK_CONTRACT_REQUIRED=1", workflow)
        self.assertIn("tests.test_stt_shadow_sdk_contract", workflow)

    def test_env_contract(self):
        names = ("PHONE_STT_SHADOW", "PHONE_STT_SHADOW_SAMPLE", "PHONE_STT_SHADOW_MODEL",
                 "PHONE_STT_SHADOW_SAMPLE_RATE", "PHONE_STT_SHADOW_STREAM_TYPE",
                 "PHONE_STT_SHADOW_VAD_THRESHOLD", "PHONE_STT_SHADOW_SILENCE_MS")
        schema = json.loads((_REPO / "config" / "environment.schema.json").read_text(encoding="utf-8"))
        variables = schema["components"]["voice-livekit"]["variables"]
        example = (_CTX / ".env.example").read_text(encoding="utf-8")
        toml = (_CTX / "fly.phone.toml").read_text(encoding="utf-8")
        for name in names:
            self.assertIn(name, variables)
            self.assertFalse(variables[name]["secret"])
            self.assertFalse(variables[name]["requiredInProduction"])
            self.assertRegex(example, rf"(?m)^{name}=")
            self.assertRegex(toml, rf'(?m)^  {name} = "')
        self.assertRegex(example, r"(?m)^PHONE_STT_SHADOW=off\s*$")
        self.assertRegex(toml, r'(?m)^  PHONE_STT_SHADOW = "off"\s*$')
        # no new secret: nothing STT-shadow-shaped is marked secret
        for name, meta in variables.items():
            if "STT_SHADOW" in name:
                self.assertFalse(meta["secret"])
        self.assertNotIn("SHADOW_KEY", json.dumps(variables))

    def test_the_module_reads_the_existing_sarvam_key_only(self):
        source = (_CTX / "phone_stt_shadow.py").read_text(encoding="utf-8")
        self.assertIn('os.getenv("SARVAM_API_KEY")', source)
        self.assertEqual(sorted(set(re.findall(r'os\.getenv\("([A-Z_]+)"\)', source))), sorted([
            "PHONE_STT_SHADOW", "PHONE_STT_SHADOW_SAMPLE", "PHONE_STT_SHADOW_MODEL",
            "PHONE_STT_SHADOW_SAMPLE_RATE", "PHONE_STT_SHADOW_STREAM_TYPE",
            "PHONE_STT_SHADOW_VAD_THRESHOLD", "PHONE_STT_SHADOW_SILENCE_MS",
            "SARVAM_API_KEY", "SARVAM_LANGUAGE"]))


if __name__ == "__main__":
    unittest.main()
