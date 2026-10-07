"""Browser R1 readiness (opt-in) and one-job liveness fences.

Overriding principle under test: with ``R1_READINESS_HOST`` ABSENT the named
browser worker (the LIVE Cloud lane) is byte-identical to origin/main: the
prewarm posts the legacy body and ``cli.run_app(WorkerOptions)`` starts it.
Every new behaviour (post-registration readiness, ``livekit_host``) exists only
behind the exact opt-in ``R1_READINESS_HOST=on``.
"""

from __future__ import annotations

import ast
import asyncio
import os
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from tests import test_phone_gate as fixtures

agent = fixtures.agent_mod


class _Env:
    KEYS = (
        "PHONE_AGENT_NAME", "BROWSER_AGENT_NAME", "WORKER_ORCHESTRATION",
        "BROWSER_WORKER_ONE_JOB", "R1_READINESS_HOST", "LIVEKIT_URL",
        "PHONE_PER_MACHINE_AGENT_NAME", "FLY_MACHINE_ID",
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
_R1 = {**_NAMED, "R1_READINESS_HOST": "on"}


class _Server:
    """Minimal AgentServer double: records ``on`` registrations."""

    def __init__(self):
        self.handlers = {}

    def on(self, event, callback):
        self.handlers[event] = callback


def _run_worker_app(values: dict[str, str], server: _Server | None = None):
    """Run ``run_worker_app`` under ``values`` with the SDK edges mocked.

    Returns (run_app mock, options sentinel, AgentServer factory mock)."""
    options = object()
    fake_agent_server = MagicMock()
    fake_agent_server.from_server_options.return_value = server or _Server()
    import livekit.agents as livekit_agents

    previous = getattr(livekit_agents, "AgentServer", None)
    livekit_agents.AgentServer = fake_agent_server
    try:
        with _Env(values):
            with patch.object(agent, "build_worker_options", return_value=options), \
                 patch.object(agent.cli, "run_app") as run_app:
                agent.run_worker_app()
    finally:
        if previous is None:
            delattr(livekit_agents, "AgentServer")
        else:
            livekit_agents.AgentServer = previous
    return run_app, options, fake_agent_server


class TestR1ReadinessOptIn(unittest.TestCase):
    """The single switch: exact ``R1_READINESS_HOST=on`` on the named browser worker."""

    def test_predicate_is_exact_on_and_named_browser_only(self):
        cases = (
            (_NAMED, False),                                     # Cloud lane today
            ({**_NAMED, "R1_READINESS_HOST": "off"}, False),
            ({**_NAMED, "R1_READINESS_HOST": "ON"}, False),
            ({**_NAMED, "R1_READINESS_HOST": "true"}, False),
            (_R1, True),
            # unnamed browser worker: opt-in alone does nothing
            ({"R1_READINESS_HOST": "on", "LIVEKIT_URL": "wss://r1.example.test"}, False),
            # orchestration off: not a named worker
            ({"BROWSER_AGENT_NAME": "browser-screener", "R1_READINESS_HOST": "on"}, False),
            # the phone worker never opts in, whatever the env says
            ({**_R1, "PHONE_AGENT_NAME": "phone-screener"}, False),
        )
        for values, expected in cases:
            with self.subTest(values=values):
                with _Env(values):
                    self.assertIs(agent._browser_r1_readiness(), expected)

    def test_default_named_browser_prewarm_posts_the_legacy_body(self):
        # Byte-identical to main: exactly post_worker_ready_machine(), no kwargs.
        for values in (_NAMED, {**_NAMED, "R1_READINESS_HOST": "off"}):
            with self.subTest(values=values):
                with _Env(values):
                    with patch.object(
                        agent.worker_ready_api, "post_worker_ready_machine",
                        new=AsyncMock(return_value=True),
                    ) as post:
                        agent._prewarm_post_machine_ready(None)
                post.assert_awaited_once_with()

    def test_default_named_browser_starts_through_workeroptions(self):
        for values in (_NAMED, {**_NAMED, "R1_READINESS_HOST": "off"}):
            with self.subTest(values=values):
                run_app, options, fake_agent_server = _run_worker_app(values)
                self.assertIs(run_app.call_args.args[0], options)
                fake_agent_server.from_server_options.assert_not_called()

    def test_phone_and_unnamed_browser_keep_workeroptions_invocation(self):
        for values in (
            {},
            {"PHONE_AGENT_NAME": "phone-screener"},
            {"PHONE_AGENT_NAME": "phone-screener", "R1_READINESS_HOST": "on"},
            {"R1_READINESS_HOST": "on"},
        ):
            with self.subTest(values=values):
                run_app, options, fake_agent_server = _run_worker_app(values)
                self.assertIs(run_app.call_args.args[0], options)
                fake_agent_server.from_server_options.assert_not_called()

    def test_opt_in_prewarm_posts_nothing(self):
        with _Env(_R1):
            with patch.object(
                agent.worker_ready_api, "post_worker_ready_machine", new=AsyncMock(),
            ) as post:
                agent._prewarm_post_machine_ready(None)
        post.assert_not_called()

    def test_opt_in_leaves_phone_prewarm_untouched(self):
        # The phone worker still posts its machine-level readiness, exactly as
        # before, even if the R1 variable leaks into its environment.
        values = {
            "PHONE_AGENT_NAME": "phone-screener",
            "WORKER_ORCHESTRATION": "worker",
            "R1_READINESS_HOST": "on",
            "LIVEKIT_URL": "wss://r1.example.test",
        }
        with _Env(values):
            with patch.object(
                agent.worker_ready_api, "post_worker_ready_machine",
                new=AsyncMock(return_value=True),
            ) as post:
                agent._prewarm_post_machine_ready(None)
        post.assert_awaited_once_with()

    def test_prewarm_is_still_wired_and_fail_open_with_the_opt_in(self):
        # naming and readiness stay inseparable: options still carry the prewarm,
        # which is simply inert in R1 mode (and must never raise).
        with _Env(_R1):
            with patch.object(agent, "WorkerOptions", fixtures._OptionsRecorder):
                agent.build_worker_options()
            opts = dict(fixtures._OptionsRecorder.last)
            self.assertIs(opts["prewarm_fnc"], agent._prewarm_post_machine_ready)
            self.assertEqual(opts["agent_name"], "browser-screener")
            agent._prewarm_post_machine_ready(None)  # must not raise


class TestR1RegistrationReadiness(unittest.TestCase):
    def test_opt_in_uses_the_cli_server_and_listens_for_registration(self):
        server = _Server()
        run_app, options, fake_agent_server = _run_worker_app(_R1, server)
        fake_agent_server.from_server_options.assert_called_once_with(options)
        self.assertIs(run_app.call_args.args[0], server)
        self.assertEqual(list(server.handlers), ["worker_registered"])
        self.assertIs(server.handlers["worker_registered"], agent._on_browser_worker_registered)

    def test_registered_event_posts_sanitized_host_and_reposts_after_reconnect(self):
        async def exercise():
            with _Env(_R1):
                with patch.object(
                    agent.worker_ready_api, "post_worker_ready_machine", new=AsyncMock(),
                ) as post:
                    agent._on_browser_worker_registered("worker-1", object())
                    await asyncio.sleep(0)
                    agent._on_browser_worker_registered("worker-1", object())
                    await asyncio.sleep(0)
            self.assertEqual(post.await_count, 2)
            post.assert_awaited_with(livekit_host="r1.example.test")
            # strong references are released once the posts finish (done
            # callbacks run one loop iteration after the task completes)
            await asyncio.sleep(0)
            self.assertEqual(agent._registration_post_tasks, set())

        asyncio.run(exercise())

    def test_non_dns_host_still_posts_host_less_instead_of_killing_readiness(self):
        async def exercise(url):
            with _Env({**_R1, "LIVEKIT_URL": url}):
                with patch.object(
                    agent.worker_ready_api, "post_worker_ready_machine", new=AsyncMock(),
                ) as post:
                    agent._on_browser_worker_registered()
                    await asyncio.sleep(0)
            post.assert_awaited_once_with()

        for url in (
            "ws://[fdaa::3]:7880",
            "wss://r1.example.test.:7880",
            "",
            "not a url",
            "wss://[bad",
        ):
            with self.subTest(url=url):
                asyncio.run(exercise(url))

    def test_registration_post_failure_is_fail_open(self):
        async def exercise():
            with _Env(_R1):
                with patch.object(agent.asyncio, "sleep", new=AsyncMock()), patch.object(
                    agent.worker_ready_api, "post_worker_ready_machine",
                    new=AsyncMock(side_effect=RuntimeError("boom")),
                ):
                    await agent._post_browser_machine_ready_after_registration()

        asyncio.run(exercise())  # must not raise

    def test_registered_handler_without_a_running_loop_never_raises(self):
        with _Env(_R1):
            with patch.object(
                agent.worker_ready_api, "post_worker_ready_machine", new=AsyncMock(),
            ) as post:
                agent._on_browser_worker_registered("worker-1", object())
        post.assert_not_called()


class TestRegistrationPostRetry(unittest.TestCase):
    """ONE bounded retry with backoff: in R1 mode the registration post is the
    only readiness source and the API fails a host-write error closed (500), so a
    lost post would otherwise stall the claim until its ready budget expires."""

    def _run(self, post: AsyncMock, values: dict[str, str] | None = None):
        """Run the post under ``values``; return the patched ``asyncio.sleep``."""
        async def exercise():
            sleep = AsyncMock()
            with _Env(values or _R1):
                with patch.object(agent.asyncio, "sleep", new=sleep), patch.object(
                    agent.worker_ready_api, "post_worker_ready_machine", new=post,
                ):
                    await agent._post_browser_machine_ready_after_registration()
            return sleep

        return asyncio.run(exercise())

    def test_a_successful_first_post_is_never_retried(self):
        post = AsyncMock(return_value=True)
        sleep = self._run(post)
        post.assert_awaited_once_with(livekit_host="r1.example.test")
        sleep.assert_not_awaited()

    def test_an_http_failure_is_retried_once_after_the_backoff(self):
        # post_worker_ready_machine reports a transport/HTTP failure as False.
        post = AsyncMock(side_effect=[False, True])
        sleep = self._run(post)
        self.assertEqual(post.await_count, 2)
        sleep.assert_awaited_once_with(agent._REGISTRATION_POST_RETRY_DELAY_SEC)

    def test_a_raised_failure_is_retried_once_too(self):
        post = AsyncMock(side_effect=[RuntimeError("boom"), True])
        sleep = self._run(post)
        self.assertEqual(post.await_count, 2)
        sleep.assert_awaited_once_with(agent._REGISTRATION_POST_RETRY_DELAY_SEC)

    def test_it_is_bounded_to_one_retry_and_never_raises(self):
        for failure in (False, RuntimeError("down")):
            with self.subTest(failure=failure):
                effect = failure if isinstance(failure, Exception) else None
                post = AsyncMock(return_value=failure, side_effect=effect)
                sleep = self._run(post)
                self.assertEqual(post.await_count, 2)
                self.assertEqual(sleep.await_count, 1)

    def test_the_retry_sends_the_same_body_as_the_first_attempt(self):
        post = AsyncMock(side_effect=[False, True])
        self._run(post)
        self.assertEqual(
            [call.kwargs for call in post.await_args_list],
            [{"livekit_host": "r1.example.test"}] * 2,
        )
        # A host-less registration retries host-less (never invents a host).
        post = AsyncMock(side_effect=[False, True])
        self._run(post, {**_R1, "LIVEKIT_URL": "ws://[fdaa::3]:7880"})
        self.assertEqual([call.kwargs for call in post.await_args_list], [{}] * 2)

    def test_backoff_and_attempts_are_small_and_bounded(self):
        self.assertEqual(agent._REGISTRATION_POST_ATTEMPTS, 2)
        self.assertGreater(agent._REGISTRATION_POST_RETRY_DELAY_SEC, 0)
        self.assertLessEqual(agent._REGISTRATION_POST_RETRY_DELAY_SEC, 5)

    def test_the_handler_schedules_the_retry_without_blocking_the_caller(self):
        async def exercise():
            sleep = AsyncMock()
            with _Env(_R1):
                with patch.object(
                    agent.worker_ready_api, "post_worker_ready_machine",
                    new=AsyncMock(side_effect=[False, True]),
                ) as post:
                    real_sleep = asyncio.sleep
                    with patch.object(agent.asyncio, "sleep", new=sleep):
                        agent._on_browser_worker_registered()
                        # The handler only SCHEDULES the post: nothing has run
                        # when it returns, so the SDK's connection task is never
                        # held up by the post or its retry backoff.
                        self.assertEqual(post.await_count, 0)
                        await real_sleep(0)
                        await real_sleep(0)
            self.assertEqual(post.await_count, 2)
            sleep.assert_awaited_once_with(agent._REGISTRATION_POST_RETRY_DELAY_SEC)

        asyncio.run(exercise())


class TestBrowserLiveKitHost(unittest.TestCase):
    def _host(self, url: str | None):
        values = {} if url is None else {"LIVEKIT_URL": url}
        with _Env(values):
            return agent._browser_livekit_host()

    def test_dns_hostnames_are_lowercased_without_port_path_or_credentials(self):
        cases = {
            "wss://R1.Example.Test:7880/path": "r1.example.test",
            "ws://user:secret@r1.example.test:7880": "r1.example.test",
            "wss://sfu.internal": "sfu.internal",
            "ws://10.0.0.5:7880": "10.0.0.5",          # IPv4: valid DNS labels, API accepts it
            "wss://a-b.c1.example.test": "a-b.c1.example.test",
        }
        for url, expected in cases.items():
            with self.subTest(url=url):
                self.assertEqual(self._host(url), expected)

    def test_non_dns_values_degrade_to_no_host(self):
        for url in (
            None,
            "",
            "r1.example.test",                  # no scheme: no hostname
            "ws://[fdaa::3]:7880",              # IPv6 literal: API/SQL regex rejects it
            "wss://r1.example.test.:7880",      # trailing-dot FQDN
            "wss://under_score.example.test",   # underscore is not a DNS label char
            "wss://-bad.example.test",
            "wss://bad-.example.test",
            "wss://[bad",                       # urlparse raises ValueError
            "wss://" + "a" * 64 + ".example.test",   # label over 63
            "wss://" + ".".join(["a" * 60] * 5),     # name over 253
        ):
            with self.subTest(url=url):
                self.assertIsNone(self._host(url))

    def test_derived_host_always_satisfies_the_api_and_lease_pattern(self):
        for url in ("wss://R1.Example.Test:7880", "ws://10.0.0.5"):
            host = self._host(url)
            self.assertRegex(host, agent._BROWSER_DNS_HOST_RE.pattern)
            self.assertEqual(host, host.lower())


class TestNoNewTopLevelImports(unittest.TestCase):
    """Plan section 9, phone-shared ``agent.py``: no new top-level imports. The
    URL parser is imported inside the one helper that needs it."""

    @classmethod
    def setUpClass(cls):
        source = Path(agent.__file__).read_text(encoding="utf-8")
        cls.tree = ast.parse(source)

    def test_urlparse_is_not_a_module_level_import(self):
        for node in self.tree.body:
            if isinstance(node, ast.ImportFrom):
                self.assertNotEqual(node.module, "urllib.parse")
            if isinstance(node, ast.Import):
                self.assertNotIn("urllib.parse", [alias.name for alias in node.names])
        self.assertNotIn("urlparse", vars(agent))

    def test_urlparse_is_imported_inside_the_host_helper(self):
        helper = next(
            node for node in self.tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "_browser_livekit_host"
        )
        imports = [
            node for node in ast.walk(helper)
            if isinstance(node, ast.ImportFrom) and node.module == "urllib.parse"
        ]
        self.assertEqual(len(imports), 1)
        self.assertEqual([alias.name for alias in imports[0].names], ["urlparse"])


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

    def test_r1_readiness_opt_in_alone_does_not_change_the_options(self):
        # The two opt-ins are independent: readiness never turns on the load gate.
        self.assertEqual(self._options(_NAMED), self._options(_R1))

    def test_exact_on_uses_parent_active_job_gate_and_finite_threshold(self):
        options = self._options({**_NAMED, "BROWSER_WORKER_ONE_JOB": "on"})
        self.assertIs(options["load_fnc"], agent._browser_one_job_per_machine_load)
        self.assertEqual(options["load_threshold"], 0.75)
        idle = type("S", (), {"active_jobs": []})()
        busy = type("S", (), {"active_jobs": [object()]})()
        self.assertEqual(agent._browser_one_job_per_machine_load(idle), 0.0)
        self.assertEqual(agent._browser_one_job_per_machine_load(busy), 1.0)

    def test_non_exact_value_is_off(self):
        options = self._options({**_NAMED, "BROWSER_WORKER_ONE_JOB": "ON"})
        self.assertNotIn("load_fnc", options)


class TestPhoneAndUnnamedOptionsIgnoreR1Switches(unittest.TestCase):
    """Phone-impact fence (plan section 9: "the phone keys in build_worker_options").

    Both R1 switches live only in the NAMED BROWSER branch of
    ``build_worker_options``. Leaking them into a phone worker's (or an unnamed
    worker's) environment must not change one WorkerOptions key, so the shared
    entrypoint stays byte-identical in behaviour for the phone lane."""

    LEAK = {
        "BROWSER_WORKER_ONE_JOB": "on",
        "R1_READINESS_HOST": "on",
        "LIVEKIT_URL": "wss://r1.example.test",
    }

    def _options(self, values: dict[str, str]) -> dict:
        with _Env(values):
            # The phone coverage judge needs provider credentials that have
            # nothing to do with this fence; skip only that validation.
            with patch.object(agent, "WorkerOptions", fixtures._OptionsRecorder), \
                 patch.object(agent, "_worker_options_accepts", return_value=True), \
                 patch.object(agent.phone, "phone_coverage_judge_enabled", return_value=False):
                agent.build_worker_options()
        return dict(fixtures._OptionsRecorder.last)

    def test_phone_options_are_identical_with_the_r1_switches_present(self):
        for base in (
            {"PHONE_AGENT_NAME": "phone-screener"},
            {"PHONE_AGENT_NAME": "phone-screener", "WORKER_ORCHESTRATION": "worker"},
        ):
            with self.subTest(base=base):
                self.assertEqual(self._options(base), self._options({**base, **self.LEAK}))

    def test_phone_never_receives_the_browser_one_job_gate(self):
        options = self._options({"PHONE_AGENT_NAME": "phone-screener", **self.LEAK})
        self.assertIsNot(options.get("load_fnc"), agent._browser_one_job_per_machine_load)

    def test_unnamed_browser_options_are_identical_with_the_r1_switches_present(self):
        self.assertEqual(self._options({}), self._options(self.LEAK))
        self.assertNotIn("load_fnc", self._options(self.LEAK))


class TestR1CodeIsReachedOnlyFromTheDocumentedSeams(unittest.TestCase):
    """Phone-impact fence, STATIC (plan section 9, phone-shared ``agent.py``).

    The tests above prove, by running them, that the phone and unnamed-browser
    paths do not change when the R1 switches leak into their environment. This
    class pins the other half of the PR's phone-impact record: the exact set of
    top-level definitions in ``agent.py`` that may even NAME the R1 / browser
    readiness code. Everything else in the module (the job entrypoint, every
    phone helper, ``_run_session``, ``_run_native_phone_screening``) never
    references it, so a later edit that wires a phone path to one of these
    helpers turns this red and has to justify itself in its own phone-impact
    section.

    Owners are top-level definition names; ``<main>`` is the
    ``if __name__ == "__main__"`` block."""

    # symbol -> the ONLY top-level definitions allowed to reference it.
    ALLOWED_REFERENCES = {
        # The two pre-existing definitions that gained R1 behaviour, plus the
        # new launcher: these are the documented seams.
        "_browser_r1_readiness": {"_prewarm_post_machine_ready", "run_worker_app"},
        "_browser_worker_one_job": {"build_worker_options"},
        "_browser_one_job_per_machine_load": {"build_worker_options"},
        "run_worker_app": {"<main>"},
        # New helpers: reachable only through the seams above.
        "_on_browser_worker_registered": {"run_worker_app"},
        "_post_browser_machine_ready_after_registration": {"_on_browser_worker_registered"},
        "_browser_livekit_host": {"_post_browser_machine_ready_after_registration"},
        "_registration_post_tasks": {"_on_browser_worker_registered"},
        "_REGISTRATION_POST_ATTEMPTS": {"_post_browser_machine_ready_after_registration"},
        "_REGISTRATION_POST_RETRY_DELAY_SEC": {"_post_browser_machine_ready_after_registration"},
        "_BROWSER_DNS_HOST_RE": {"_browser_livekit_host"},
    }

    @classmethod
    def setUpClass(cls):
        cls.tree = ast.parse(Path(agent.__file__).read_text(encoding="utf-8"))
        cls.owners = {symbol: set() for symbol in cls.ALLOWED_REFERENCES}
        cls.definitions = set()
        for node in cls.tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                owner = node.name
                cls.definitions.add(owner)
            elif isinstance(node, ast.If):
                owner = "<main>"
            else:
                owner = "<module>"
            for child in ast.walk(node):
                is_use = isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load)
                if is_use and child.id in cls.owners:
                    cls.owners[child.id].add(owner)

    def test_every_r1_symbol_is_still_defined_at_module_level(self):
        # A rename must update this table, or the references below prove nothing.
        for symbol in self.ALLOWED_REFERENCES:
            with self.subTest(symbol=symbol):
                self.assertTrue(hasattr(agent, symbol), symbol)

    def test_r1_symbols_are_referenced_only_from_their_documented_owners(self):
        for symbol, allowed in self.ALLOWED_REFERENCES.items():
            with self.subTest(symbol=symbol):
                self.assertEqual(self.owners[symbol] - {symbol}, allowed)

    def test_no_phone_helper_or_the_job_entrypoint_names_an_r1_symbol(self):
        phone_surface = {name for name in self.definitions if "phone" in name}
        phone_surface |= {"entrypoint", "_run_session", "Christy"}
        # Guard the guard: the surface really contains the phone call path.
        self.assertIn("_run_native_phone_screening", phone_surface)
        self.assertGreater(len(phone_surface), 30)
        for symbol, owners in self.owners.items():
            with self.subTest(symbol=symbol):
                self.assertEqual(owners & phone_surface, set())

    def test_the_prewarm_carve_out_is_the_only_r1_branch_in_a_shared_prewarm(self):
        prewarm = next(
            node for node in self.tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "_prewarm_post_machine_ready"
        )
        gated = [
            node for node in ast.walk(prewarm)
            if isinstance(node, ast.If)
            and any(
                isinstance(call, ast.Call)
                and isinstance(call.func, ast.Name)
                and call.func.id == "_browser_r1_readiness"
                for call in ast.walk(node.test)
            )
        ]
        self.assertEqual(len(gated), 1)
        # The branch is a bare early return: no R1 work happens inside prewarm.
        self.assertEqual([type(stmt).__name__ for stmt in gated[0].body], ["Return"])
        self.assertEqual(gated[0].orelse, [])


if __name__ == "__main__":
    unittest.main()
