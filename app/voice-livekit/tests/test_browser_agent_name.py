"""M019: the R1 browser worker's per-machine LiveKit registration name.

Every browser pool machine registers the ONE shared ``BROWSER_AGENT_NAME``, so
with more than one machine LiveKit can hand a leased session's job to whichever
machine is idle, while ending that session stops the machine it was LEASED on
(the 2026-10-03 phone incident, on the browser pool). The fix mirrors the phone
lane's E2: the worker registers as ``<base>-<FLY_MACHINE_ID>`` and reports that
name in its readiness post, so the API can dispatch to the leased machine.

What this file pins (runs on bare python3, SDK stubbed via the shared
``test_phone_gate`` fixtures, like ``test_phone_agent_name``):

  * the name is per-machine ONLY on the named browser worker opted into the R1
    readiness contract (``R1_READINESS_HOST=on``) AND with
    ``BROWSER_PER_MACHINE_AGENT_NAME`` EXACTLY "true" AND a well-formed
    FLY_MACHINE_ID whose composed name the API accepts;
  * every other case registers the BASE name and reports none, so the flag-off
    and Cloud-lane bodies are byte-identical to before (the Cloud fallback
    stays at today's behaviour even with the key present);
  * the per-machine opt-in turns on the one-job availability gate by itself,
    and the gate reports a busy machine as full;
  * the phone worker's options, name and readiness body are untouched.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import pathlib
import tomllib
import types
import unittest
from unittest.mock import AsyncMock, patch

from tests import test_phone_gate as fixtures

agent = fixtures.agent_mod

_CTX = pathlib.Path(__file__).resolve().parent.parent  # app/voice-livekit
_BASE = "browser-screener"
_MACHINE = "d895472c499e38"
_HOST = "r1.example.test"

_ENV_KEYS = (
    "PHONE_AGENT_NAME", "BROWSER_AGENT_NAME", "WORKER_ORCHESTRATION",
    "R1_READINESS_HOST", "BROWSER_PER_MACHINE_AGENT_NAME", "BROWSER_WORKER_ONE_JOB",
    "PHONE_PER_MACHINE_AGENT_NAME", "FLY_MACHINE_ID", "LIVEKIT_URL", "R1_LANE_MODE",
    "FLY_APP_NAME", "PHONE_VOICE_APP", "WORKER_CONTEXT_SECRET",
)

# The live Cloud browser lane: named and orchestrated, R1 readiness absent.
_CLOUD = {
    "BROWSER_AGENT_NAME": _BASE,
    "WORKER_ORCHESTRATION": "worker",
    "LIVEKIT_URL": "wss://cloud.example.test",
}
# The R1 lane as the cutover leaves it (R1_READINESS_HOST is a Fly secret).
_R1 = {**_CLOUD, "LIVEKIT_URL": "wss://R1.Example.Test:7880", "R1_READINESS_HOST": "on"}
# The R1 lane opted into per-machine registration on a well-formed machine.
_ON = {**_R1, "BROWSER_PER_MACHINE_AGENT_NAME": "true", "FLY_MACHINE_ID": _MACHINE}

_PHONE = {"PHONE_AGENT_NAME": "phone-screener", "WORKER_ORCHESTRATION": "worker"}


class _Env:
    """Run with EXACTLY ``env`` set for the relevant keys (others removed),
    restoring the prior process environment afterwards."""

    def __init__(self, env: dict[str, str]):
        self._env = env

    def __enter__(self):
        self._prior = {k: os.environ.get(k) for k in _ENV_KEYS}
        for k in _ENV_KEYS:
            os.environ.pop(k, None)
        os.environ.update(self._env)
        # Each case observes the once-per-process fallback logs afresh.
        self._logged = (
            agent._BROWSER_AGENT_NAME_FALLBACK_LOGGED,
            agent._PHONE_AGENT_NAME_FALLBACK_LOGGED,
        )
        agent._BROWSER_AGENT_NAME_FALLBACK_LOGGED = False
        agent._PHONE_AGENT_NAME_FALLBACK_LOGGED = False
        return self

    def __exit__(self, *exc):
        for k, v in self._prior.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        (
            agent._BROWSER_AGENT_NAME_FALLBACK_LOGGED,
            agent._PHONE_AGENT_NAME_FALLBACK_LOGGED,
        ) = self._logged
        return False


def _options(env: dict[str, str]) -> dict:
    with _Env(env):
        # The phone coverage judge needs provider credentials that have nothing
        # to do with naming; skip only that validation.
        with patch.object(agent, "WorkerOptions", fixtures._OptionsRecorder), \
             patch.object(agent, "_worker_options_accepts", return_value=True), \
             patch.object(agent.phone, "phone_coverage_judge_enabled", return_value=False):
            agent.build_worker_options()
    return dict(fixtures._OptionsRecorder.last)


def _prewarm_post_kwargs(env: dict[str, str]):
    """Drive the real prewarm; return the kwargs it posted with (or None)."""
    with _Env(env):
        with patch.object(
            agent.worker_ready_api, "post_worker_ready_machine",
            new=AsyncMock(return_value=True),
        ) as post:
            agent._prewarm_post_machine_ready(None)
    if not post.called:
        return None
    return dict(post.call_args.kwargs)


def _registration_posts(env: dict[str, str], post: AsyncMock | None = None) -> list[dict]:
    """Drive the real post-registration readiness post (main process, R1 mode);
    return the kwargs of every attempt."""
    post = post or AsyncMock(return_value=True)

    async def exercise():
        with _Env(env):
            with patch.object(agent.asyncio, "sleep", new=AsyncMock()), patch.object(
                agent.worker_ready_api, "post_worker_ready_machine", new=post,
            ):
                await agent._post_browser_machine_ready_after_registration()

    asyncio.run(exercise())
    return [dict(call.kwargs) for call in post.await_args_list]


class TestBrowserRegisteredAgentName(unittest.TestCase):
    def test_r1_opted_in_valid_machine_registers_per_machine(self):
        with _Env(_ON):
            self.assertEqual(agent.browser_registered_agent_name(), f"{_BASE}-{_MACHINE}")
            # The BASE name is unchanged: naming and room ownership key off it.
            self.assertEqual(agent._browser_agent_name(), _BASE)
            self.assertTrue(agent._browser_worker_named())

    def test_second_fixture_machine_id(self):
        with _Env({**_ON, "FLY_MACHINE_ID": "7812736a540d58"}):
            self.assertEqual(agent.browser_registered_agent_name(), f"{_BASE}-7812736a540d58")

    def test_flag_absent_is_base_and_logs_nothing(self):
        env = dict(_ON)
        env.pop("BROWSER_PER_MACHINE_AGENT_NAME")
        with _Env(env):
            with patch.object(agent._log, "warn") as warn:
                self.assertEqual(agent.browser_registered_agent_name(), _BASE)
            warn.assert_not_called()

    def test_flag_is_exactly_true(self):
        # Exact, like the browser lane's other opt-ins. Every near miss is OFF
        # (inert), never a per-machine name.
        for value, expected in (
            ("true", f"{_BASE}-{_MACHINE}"),
            ("TRUE", _BASE),
            ("True", _BASE),
            (" true", _BASE),
            ("true ", _BASE),
            ("1", _BASE),
            ("yes", _BASE),
            ("on", _BASE),
            ("false", _BASE),
            ("", _BASE),
        ):
            with self.subTest(value=value):
                with _Env({**_ON, "BROWSER_PER_MACHINE_AGENT_NAME": value}):
                    with patch.object(agent._log, "warn") as warn:
                        self.assertEqual(agent.browser_registered_agent_name(), expected)
                    warn.assert_not_called()

    def test_cloud_lane_ignores_the_flag(self):
        # Without the R1 readiness opt-in (the live Cloud lane, and what the
        # Cloud-fallback runbook step leaves) the flag is inert.
        for readiness in (None, "off", "ON", "true"):
            with self.subTest(readiness=readiness):
                env = dict(_ON)
                if readiness is None:
                    env.pop("R1_READINESS_HOST")
                else:
                    env["R1_READINESS_HOST"] = readiness
                with _Env(env):
                    self.assertFalse(agent._browser_per_machine_agent_name_enabled())
                    self.assertEqual(agent.browser_registered_agent_name(), _BASE)

    def test_orchestration_off_is_base(self):
        for orch in (None, "off", "true", "Worker"):
            with self.subTest(orch=orch):
                env = dict(_ON)
                if orch is None:
                    env.pop("WORKER_ORCHESTRATION")
                else:
                    env["WORKER_ORCHESTRATION"] = orch
                with _Env(env):
                    self.assertEqual(agent.browser_registered_agent_name(), _BASE)

    def test_unnamed_browser_worker_stays_unnamed(self):
        env = dict(_ON)
        env.pop("BROWSER_AGENT_NAME")
        with _Env(env):
            self.assertEqual(agent.browser_registered_agent_name(), "")
            self.assertFalse(agent._browser_per_machine_agent_name_enabled())

    def test_phone_worker_never_takes_the_browser_name(self):
        # PHONE_AGENT_NAME wins: not the named browser worker, so the browser
        # helper is inert and the phone helper ignores the browser flag.
        with _Env({**_ON, **_PHONE}):
            self.assertFalse(agent._browser_per_machine_agent_name_enabled())
            self.assertEqual(agent.browser_registered_agent_name(), _BASE)
            self.assertEqual(agent.phone_registered_agent_name(), "phone-screener")

    def test_invalid_or_missing_machine_id_falls_back_to_base_and_logs_once(self):
        for machine in (None, "", "ABC", "D895472C499E38", "abcdefg", "a" * 33,
                        "a.bcdefgh", "ab-cdefgh", "d895472c499e38\n", " d895472c499e38"):
            with self.subTest(machine=machine):
                env = dict(_ON)
                if machine is None:
                    env.pop("FLY_MACHINE_ID")
                else:
                    env["FLY_MACHINE_ID"] = machine
                with _Env(env):
                    with patch.object(agent._log, "warn") as warn:
                        self.assertEqual(agent.browser_registered_agent_name(), _BASE)
                        self.assertEqual(agent.browser_registered_agent_name(), _BASE)
                    # Logged ONCE per process, with a fixed category and never
                    # the raw value.
                    self.assertEqual(warn.call_count, 1)
                    kwargs = warn.call_args.kwargs
                    self.assertEqual(kwargs["error_type"], "browser_agent_name_fallback")
                    self.assertEqual(kwargs["error_category"],
                                     "machine_id_missing" if not machine else "machine_id_invalid")
                    if machine:
                        self.assertNotIn(machine.strip(), repr(warn.call_args))

    def test_base_the_api_would_reject_falls_back_to_base(self):
        # A composed name outside the API's AGENT_NAME_RE would 400 every ready
        # post; the worker keeps the shared name instead.
        for base in ("b" * 65, "browser.screener", "browser screener"):
            with self.subTest(base=base):
                with _Env({**_ON, "BROWSER_AGENT_NAME": base}):
                    with patch.object(agent._log, "warn") as warn:
                        self.assertEqual(agent.browser_registered_agent_name(), base)
                    self.assertEqual(warn.call_args.kwargs["error_category"],
                                     "base_name_invalid")
        # The boundary: a 64-character base still composes.
        with _Env({**_ON, "BROWSER_AGENT_NAME": "b" * 64}):
            self.assertEqual(agent.browser_registered_agent_name(), f"{'b' * 64}-{_MACHINE}")

    def test_uses_the_phone_patterns_and_fullmatch(self):
        # One lease table, one 0112 CHECK, one API contract: the browser helper
        # must use the SAME pinned literals as the phone one, with fullmatch.
        source = inspect.getsource(agent.browser_registered_agent_name)
        self.assertIn('f"{base}-{machine_id}"', source)
        self.assertIn("_PER_MACHINE_ID_RE.fullmatch(machine_id)", source)
        self.assertIn("_PER_MACHINE_AGENT_NAME_RE.fullmatch(registered)", source)
        self.assertNotIn("_RE.match(", source)


class TestWorkerOptions(unittest.TestCase):
    def test_per_machine_name_is_registered_with_the_one_job_gate(self):
        opts = _options(_ON)
        self.assertEqual(opts["agent_name"], f"{_BASE}-{_MACHINE}")
        self.assertIs(opts["prewarm_fnc"], agent._prewarm_post_machine_ready)
        self.assertEqual(opts["num_idle_processes"], 1)
        # BROWSER_WORKER_ONE_JOB is NOT set: the per-machine opt-in alone turns
        # the one-job gate on.
        self.assertNotIn("BROWSER_WORKER_ONE_JOB", _ON)
        self.assertIs(opts["load_fnc"], agent._browser_one_job_per_machine_load)
        self.assertEqual(opts["load_threshold"], 0.75)

    def test_flag_absent_options_are_unchanged(self):
        baseline = _options(_R1)
        self.assertEqual(baseline["agent_name"], _BASE)
        self.assertNotIn("load_fnc", baseline)
        self.assertNotIn("load_threshold", baseline)
        for extra in (
            {"FLY_MACHINE_ID": _MACHINE},
            {"FLY_MACHINE_ID": _MACHINE, "BROWSER_PER_MACHINE_AGENT_NAME": "false"},
            {"FLY_MACHINE_ID": _MACHINE, "BROWSER_PER_MACHINE_AGENT_NAME": "TRUE"},
            # The PHONE flag never names the browser worker.
            {"FLY_MACHINE_ID": _MACHINE, "PHONE_PER_MACHINE_AGENT_NAME": "true"},
        ):
            with self.subTest(extra=extra):
                self.assertEqual(_options({**_R1, **extra}), baseline)

    def test_cloud_lane_options_are_identical_with_the_flag(self):
        # The Cloud fallback stays at today's behaviour: shared name, no load
        # gate unless its own secret is set.
        flagged = {"BROWSER_PER_MACHINE_AGENT_NAME": "true", "FLY_MACHINE_ID": _MACHINE}
        self.assertEqual(_options(_CLOUD), _options({**_CLOUD, **flagged}))
        self.assertEqual(_options(_CLOUD)["agent_name"], _BASE)
        self.assertNotIn("load_fnc", _options({**_CLOUD, **flagged}))
        one_job = {**_CLOUD, "BROWSER_WORKER_ONE_JOB": "on"}
        self.assertEqual(_options(one_job), _options({**one_job, **flagged}))

    def test_invalid_machine_keeps_base_but_still_one_job(self):
        # The gate follows the operator's opt-in, not whether the name resolved:
        # one job per machine is the safe posture either way.
        opts = _options({**_ON, "FLY_MACHINE_ID": "not-a-machine"})
        self.assertEqual(opts["agent_name"], _BASE)
        self.assertIs(opts["load_fnc"], agent._browser_one_job_per_machine_load)
        self.assertEqual(opts["load_threshold"], 0.75)

    def test_one_job_secret_alone_is_unchanged(self):
        opts = _options({**_R1, "BROWSER_WORKER_ONE_JOB": "on"})
        self.assertEqual(opts["agent_name"], _BASE)
        self.assertIs(opts["load_fnc"], agent._browser_one_job_per_machine_load)
        # Both opt-ins together are the same single gate, not two.
        both = _options({**_ON, "BROWSER_WORKER_ONE_JOB": "on"})
        self.assertEqual({k: v for k, v in both.items() if k != "agent_name"},
                         {k: v for k, v in _options(_ON).items() if k != "agent_name"})

    def test_reserved_slot_arithmetic_refuses_a_second_dispatch(self):
        # livekit-agents 1.6.4 prices an ACCEPTED-but-not-launched job at
        # load_threshold / num_idle_processes while active_jobs is still empty
        # (_get_effective_load), and is available only while effective load is
        # BELOW the threshold. With one idle process a single reservation
        # scores exactly the threshold, so a second dispatch arriving in the
        # launch window is refused. Two idle processes would halve it.
        opts = _options(_ON)
        threshold, idle = opts["load_threshold"], opts["num_idle_processes"]
        self.assertGreater(threshold, 0.0)
        self.assertLess(threshold, 1.0)
        self.assertEqual(idle, 1)
        self.assertFalse(0.0 + 1 * (threshold / max(idle, 1)) < threshold)


class TestOneJobLoad(unittest.TestCase):
    """The signal the SDK gates on, refreshed in the PARENT before every
    availability answer: a machine running a job reports full."""

    def test_idle_is_available_and_busy_is_full(self):
        threshold = _options(_ON)["load_threshold"]
        load = agent._browser_one_job_per_machine_load
        idle = types.SimpleNamespace(active_jobs=[])
        busy = types.SimpleNamespace(active_jobs=[object()])
        two = types.SimpleNamespace(active_jobs=[object(), object()])
        self.assertEqual(load(idle), 0.0)
        self.assertLess(load(idle), threshold)
        self.assertEqual(load(busy), 1.0)
        self.assertGreaterEqual(load(busy), threshold)
        self.assertGreaterEqual(load(two), threshold)

    def test_a_machine_that_cannot_be_asked_reports_itself_full(self):
        class _Broken:
            @property
            def active_jobs(self):
                raise RuntimeError("ipc gone")

        self.assertEqual(agent._browser_one_job_per_machine_load(_Broken()), 1.0)


class TestRegistrationReadinessBody(unittest.TestCase):
    """The R1 readiness report (main process, after LiveKit accepted the
    registration): the only readiness source on the R1 lane."""

    def test_per_machine_name_is_reported_with_the_host(self):
        self.assertEqual(
            _registration_posts(_ON),
            [{"livekit_host": _HOST, "agent_name": f"{_BASE}-{_MACHINE}"}],
        )

    def test_flag_absent_body_is_unchanged(self):
        for extra in ({}, {"FLY_MACHINE_ID": _MACHINE},
                      {"FLY_MACHINE_ID": _MACHINE, "BROWSER_PER_MACHINE_AGENT_NAME": "on"}):
            with self.subTest(extra=extra):
                self.assertEqual(_registration_posts({**_R1, **extra}), [{"livekit_host": _HOST}])

    def test_fallback_reports_no_name(self):
        for machine in (None, "BAD", "a" * 33):
            with self.subTest(machine=machine):
                env = dict(_ON)
                if machine is None:
                    env.pop("FLY_MACHINE_ID")
                else:
                    env["FLY_MACHINE_ID"] = machine
                self.assertEqual(_registration_posts(env), [{"livekit_host": _HOST}])

    def test_host_less_registration_still_reports_the_name(self):
        self.assertEqual(
            _registration_posts({**_ON, "LIVEKIT_URL": "ws://[fdaa::3]:7880"}),
            [{"agent_name": f"{_BASE}-{_MACHINE}"}],
        )

    def test_the_retry_sends_the_same_body(self):
        posts = _registration_posts(_ON, AsyncMock(side_effect=[False, True]))
        self.assertEqual(
            posts, [{"livekit_host": _HOST, "agent_name": f"{_BASE}-{_MACHINE}"}] * 2,
        )

    def test_end_to_end_body_through_the_real_client(self):
        # The real worker_ready_api client, a fake transport: the wire body is
        # {app, machine_id, livekit_host, agent_name} on, no agent_name off.
        captured: list[dict] = []

        class _Resp:
            def json(self):
                return {"ok": True}

        async def fake_post(method, url, headers, json_body):
            captured.append(dict(json_body))
            return _Resp()

        real = agent.worker_ready_api.post_worker_ready_machine

        async def via_fake(**kwargs):
            return await real(post=fake_post, **kwargs)

        common = {"FLY_APP_NAME": "project-hello-voice", "WORKER_CONTEXT_SECRET": "s3cr3t"}
        on_body = {"app": "project-hello-voice", "machine_id": _MACHINE,
                   "agent_name": f"{_BASE}-{_MACHINE}", "livekit_host": _HOST}
        off_body = {"app": "project-hello-voice", "machine_id": _MACHINE, "livekit_host": _HOST}
        off_env = {k: v for k, v in _ON.items() if k != "BROWSER_PER_MACHINE_AGENT_NAME"}
        for env, expected in ((_ON, on_body), (off_env, off_body)):
            with self.subTest(expected=expected):
                captured.clear()
                _registration_posts({**env, **common}, AsyncMock(side_effect=via_fake))
                self.assertEqual(captured, [expected])


class TestPrewarmReadinessBody(unittest.TestCase):
    """The startup (idle-process prewarm) report, used by the Cloud lane."""

    def test_cloud_lane_prewarm_body_is_the_legacy_body_even_with_the_flag(self):
        for env in (
            _CLOUD,
            {**_CLOUD, "BROWSER_PER_MACHINE_AGENT_NAME": "true", "FLY_MACHINE_ID": _MACHINE},
        ):
            with self.subTest(env=env):
                self.assertEqual(_prewarm_post_kwargs(env), {})

    def test_r1_lane_prewarm_posts_nothing_with_the_flag(self):
        # R1 readiness comes only from the main process after registration.
        self.assertIsNone(_prewarm_post_kwargs(_ON))

    def test_post_failure_never_raises_out_of_prewarm(self):
        with _Env({**_CLOUD, "BROWSER_PER_MACHINE_AGENT_NAME": "true", "FLY_MACHINE_ID": _MACHINE}):
            with patch.object(
                agent.worker_ready_api, "post_worker_ready_machine",
                new=AsyncMock(side_effect=RuntimeError("boom")),
            ):
                agent._prewarm_post_machine_ready(None)  # must not raise


class TestRegisteredAndReportedNamesAgree(unittest.TestCase):
    """Whatever name the worker REGISTERS, the readiness path that is active for
    that posture REPORTS it (or reports none for the base). A worker that
    registered a per-machine name but reported none would be dispatched to the
    base name, which nothing would be listening on."""

    def _reported(self, env: dict[str, str]) -> str | None:
        with _Env(env):
            r1 = agent._browser_r1_readiness()
        kwargs = _registration_posts(env)[0] if r1 else _prewarm_post_kwargs(env)
        return (kwargs or {}).get("agent_name")

    def test_matrix(self):
        cases = (
            _CLOUD,
            {**_CLOUD, "BROWSER_PER_MACHINE_AGENT_NAME": "true", "FLY_MACHINE_ID": _MACHINE},
            _R1,
            _ON,
            {**_ON, "FLY_MACHINE_ID": "BAD"},
            {**_ON, "BROWSER_AGENT_NAME": "b" * 65},
            {**_ON, "BROWSER_PER_MACHINE_AGENT_NAME": "True"},
            {**_ON, "BROWSER_WORKER_ONE_JOB": "on"},
        )
        for env in cases:
            with self.subTest(env=env):
                registered = _options(env)["agent_name"]
                base = env["BROWSER_AGENT_NAME"]
                expected = None if registered == base else registered
                self.assertEqual(self._reported(env), expected)


class TestPhoneUnaffected(unittest.TestCase):
    LEAK = {
        "BROWSER_PER_MACHINE_AGENT_NAME": "true",
        "R1_READINESS_HOST": "on",
        "LIVEKIT_URL": "wss://r1.example.test",
        "FLY_MACHINE_ID": _MACHINE,
    }

    def test_phone_options_are_identical_with_the_browser_flag(self):
        for base in (
            {"PHONE_AGENT_NAME": "phone-screener"},
            _PHONE,
            {**_PHONE, "PHONE_PER_MACHINE_AGENT_NAME": "true", "FLY_MACHINE_ID": _MACHINE},
        ):
            with self.subTest(base=base):
                self.assertEqual(_options(base), _options({**base, **self.LEAK}))
        opts = _options({**_PHONE, **self.LEAK})
        self.assertEqual(opts["agent_name"], "phone-screener")
        self.assertIs(opts["load_fnc"], agent._phone_one_call_per_machine_load)

    def test_phone_per_machine_name_ignores_the_browser_flag(self):
        env = {**_PHONE, "PHONE_PER_MACHINE_AGENT_NAME": "true", "FLY_MACHINE_ID": _MACHINE}
        self.assertEqual(_options({**env, **self.LEAK})["agent_name"], f"phone-screener-{_MACHINE}")

    def test_phone_prewarm_body_is_identical_with_the_browser_flag(self):
        for base in (
            _PHONE,
            {**_PHONE, "PHONE_PER_MACHINE_AGENT_NAME": "true", "FLY_MACHINE_ID": _MACHINE},
        ):
            with self.subTest(base=base):
                self.assertEqual(_prewarm_post_kwargs(base),
                                 _prewarm_post_kwargs({**base, **self.LEAK}))

    def test_unnamed_browser_options_are_identical_with_the_flag(self):
        self.assertEqual(_options({}), _options(self.LEAK))
        self.assertNotIn("agent_name", _options(self.LEAK))


class TestFlyConfig(unittest.TestCase):
    """Deploy posture: the key may live only in fly.toml, absent or "true"."""

    def setUp(self):
        self.browser = tomllib.loads((_CTX / "fly.toml").read_text(encoding="utf-8"))
        self.phone = tomllib.loads((_CTX / "fly.phone.toml").read_text(encoding="utf-8"))

    def test_browser_value_is_absent_or_exactly_true(self):
        self.assertIn(self.browser.get("env", {}).get("BROWSER_PER_MACHINE_AGENT_NAME"),
                      (None, "true"))

    def test_phone_config_never_carries_the_browser_flag(self):
        self.assertNotIn("BROWSER_PER_MACHINE_AGENT_NAME", self.phone.get("env", {}))

    def test_shipped_env_registers_the_base_unless_the_flag_ships(self):
        # The SHIPPED [env] plus the R1 cutover secret and a real machine id:
        # absent ⇒ today's shared name; "true" ⇒ the per-machine name.
        env = self.browser.get("env", {})
        shipped = {k: env[k] for k in ("BROWSER_AGENT_NAME", "WORKER_ORCHESTRATION")}
        if "BROWSER_PER_MACHINE_AGENT_NAME" in env:
            shipped["BROWSER_PER_MACHINE_AGENT_NAME"] = env["BROWSER_PER_MACHINE_AGENT_NAME"]
        with _Env({**shipped, "R1_READINESS_HOST": "on", "FLY_MACHINE_ID": _MACHINE}):
            base = agent._browser_agent_name()
            expected = (f"{base}-{_MACHINE}"
                        if env.get("BROWSER_PER_MACHINE_AGENT_NAME") == "true" else base)
            self.assertEqual(agent.browser_registered_agent_name(), expected)


if __name__ == "__main__":
    unittest.main()
