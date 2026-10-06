"""Browser-only registration readiness and one-job liveness fences."""

from __future__ import annotations

import asyncio
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from tests import test_phone_gate as fixtures

agent = fixtures.agent_mod


class _Env:
    KEYS = (
        "PHONE_AGENT_NAME", "BROWSER_AGENT_NAME", "WORKER_ORCHESTRATION",
        "BROWSER_WORKER_ONE_JOB", "LIVEKIT_URL", agent._BROWSER_READY_MARKER_ENV,
    )

    def __init__(self, values: dict[str, str]):
        self.values = values

    def __enter__(self):
        self.saved = {key: os.environ.get(key) for key in self.KEYS}
        for key in self.KEYS:
            os.environ.pop(key, None)
        os.environ.update(self.values)

    def __exit__(self, *_exc):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


_NAMED = {
    "BROWSER_AGENT_NAME": "browser-screener",
    "WORKER_ORCHESTRATION": "worker",
    "LIVEKIT_URL": "wss://R1.Example.Test:7880/path",
}


class TestBrowserRegistrationReadiness(unittest.TestCase):
    def test_prewarm_cannot_post_before_parent_registration(self):
        with _Env(_NAMED):
            with patch.object(agent.worker_ready_api, "post_worker_ready_machine", new=AsyncMock()) as post:
                with patch.object(agent, "_browser_has_registered", return_value=False):
                    agent._prewarm_post_machine_ready(None)
        post.assert_not_called()

    def test_prewarm_after_registration_carries_sanitized_host(self):
        with _Env(_NAMED):
            with patch.object(agent.worker_ready_api, "post_worker_ready_machine", new=AsyncMock()) as post:
                with patch.object(agent, "_browser_has_registered", return_value=True):
                    agent._prewarm_post_machine_ready(None)
        post.assert_awaited_once_with(livekit_host="r1.example.test")

    def test_registered_event_posts_host_and_reposts_after_reconnect(self):
        class Server:
            def __init__(self):
                self.handlers = {}

            def on(self, event, callback):
                self.handlers[event] = callback

        server = Server()
        fake_agent_server = MagicMock()
        fake_agent_server.from_server_options.return_value = server

        async def exercise():
            with _Env(_NAMED):
                with patch.object(agent.worker_ready_api, "post_worker_ready_machine", new=AsyncMock()) as post, \
                     patch.object(agent, "_prepare_browser_registration_marker"), \
                     patch.object(agent, "_mark_browser_registered") as marked, \
                     patch.object(agent, "WorkerOptions", fixtures._OptionsRecorder), \
                     patch.object(agent.cli, "run_app") as run_app:
                    import livekit.agents as livekit_agents
                    previous = getattr(livekit_agents, "AgentServer", None)
                    livekit_agents.AgentServer = fake_agent_server
                    try:
                        agent.run_worker_app()
                        self.assertIs(run_app.call_args.args[0], server)
                        server.handlers["worker_registered"]("first", object())
                        await asyncio.sleep(0)
                        server.handlers["worker_registered"]("second", object())
                        await asyncio.sleep(0)
                    finally:
                        if previous is None:
                            delattr(livekit_agents, "AgentServer")
                        else:
                            livekit_agents.AgentServer = previous
            self.assertEqual(marked.call_count, 2)
            self.assertEqual(post.await_count, 2)
            post.assert_awaited_with(livekit_host="r1.example.test")

        asyncio.run(exercise())

    def test_phone_and_unnamed_browser_keep_workeroptions_invocation(self):
        for values in ({}, {"PHONE_AGENT_NAME": "phone-screener"}):
            with self.subTest(values=values):
                with _Env(values):
                    options = object()
                    with patch.object(agent, "build_worker_options", return_value=options), \
                         patch.object(agent.cli, "run_app") as run_app:
                        agent.run_worker_app()
                self.assertIs(run_app.call_args.args[0], options)


class TestBrowserOneJobGate(unittest.TestCase):
    def _options(self, values: dict[str, str]) -> dict:
        with _Env(values):
            with patch.object(agent, "WorkerOptions", fixtures._OptionsRecorder), \
                 patch.object(agent, "_worker_options_accepts", return_value=True):
                agent.build_worker_options()
        return dict(fixtures._OptionsRecorder.last)

    def test_off_is_the_existing_named_browser_options(self):
        baseline = self._options(_NAMED)
        explicit_off = self._options({**_NAMED, "BROWSER_WORKER_ONE_JOB": "off"})
        self.assertEqual(baseline, explicit_off)
        self.assertNotIn("load_fnc", baseline)
        self.assertNotIn("load_threshold", baseline)

    def test_exact_on_uses_parent_active_job_gate_and_finite_threshold(self):
        options = self._options({**_NAMED, "BROWSER_WORKER_ONE_JOB": "on"})
        self.assertIs(options["load_fnc"], agent._browser_one_job_per_machine_load)
        self.assertEqual(options["load_threshold"], 0.75)
        self.assertEqual(agent._browser_one_job_per_machine_load(type("S", (), {"active_jobs": []})()), 0.0)
        self.assertEqual(agent._browser_one_job_per_machine_load(type("S", (), {"active_jobs": [object()]})()), 1.0)

    def test_non_exact_value_is_off(self):
        options = self._options({**_NAMED, "BROWSER_WORKER_ONE_JOB": "ON"})
        self.assertNotIn("load_fnc", options)


if __name__ == "__main__":
    unittest.main()
