"""E2 (M009): the phone worker's per-machine LiveKit registration name.

Every phone pool machine used to register under the ONE shared name, so
LiveKit handed a leased session's job to whichever machine was idle, while the
reaper and terminal-release stop a machine by the session it was LEASED for —
a live interview on the "wrong" machine was stopped mid-call. The fix has the
worker register as ``<base>-<FLY_MACHINE_ID>`` and report that name in its
machine-level ready post, so the API can dispatch to the leased machine.

What this file pins (runs on bare python3, SDK stubbed via the shared
``test_phone_gate`` fixtures — CI has no livekit packages):

  * the name is per-machine ONLY when orchestrated AND the worker flag
    PHONE_PER_MACHINE_AGENT_NAME is "true" AND FLY_MACHINE_ID is well-formed;
  * every other case registers the BASE name, and the ready post then carries
    NO ``agent_name`` key (the flag-off body is byte-identical to pre-E2);
  * ``_phone_agent_name()`` stays the base — phone-mode detection and room
    ownership must not depend on which machine a worker runs on;
  * the browser worker's options and ready post are untouched;
  * PR-A shipped the flag ABSENT from fly.phone.toml; PR-B (M009 B6) flips it
    to exactly "true" now that the API stores names, and the SHIPPED [env]
    resolves to the per-machine name on a well-formed machine id. kill_timeout
    is set so a stop drains.
"""

from __future__ import annotations

import os
import pathlib
import re
import tomllib
import unittest
from unittest.mock import AsyncMock, patch

from tests import test_phone_gate as fixtures

agent = fixtures.agent_mod
phone = fixtures.phone

_CTX = pathlib.Path(__file__).resolve().parent.parent  # app/voice-livekit
_BASE = "phone-screener"
_MACHINE = "d895472c499e38"

_ENV_KEYS = (
    "PHONE_AGENT_NAME", "BROWSER_AGENT_NAME", "WORKER_ORCHESTRATION",
    "PHONE_PER_MACHINE_AGENT_NAME", "FLY_MACHINE_ID",
    "PHONE_JUDGE_SDK", "PHONE_JUDGE_API_KEY", "PHONE_JUDGE_URL",
    "PHONE_JUDGE_MODEL", "PHONE_COVERAGE_TIMEOUT_SEC", "PHONE_JUDGE_RETRIES",
)

_JUDGE_ENV = {
    "PHONE_JUDGE_SDK": "openai",
    "PHONE_JUDGE_API_KEY": "judge-test-key",
    "PHONE_JUDGE_URL": phone.PHONE_JUDGE_GOOGLE_URL,
    "PHONE_JUDGE_MODEL": phone.PHONE_JUDGE_GEMINI_MODEL,
    "PHONE_COVERAGE_TIMEOUT_SEC": "2",
    "PHONE_JUDGE_RETRIES": "0",
}

_PER_MACHINE_ON = {
    "PHONE_AGENT_NAME": _BASE,
    "WORKER_ORCHESTRATION": "worker",
    "PHONE_PER_MACHINE_AGENT_NAME": "true",
    "FLY_MACHINE_ID": _MACHINE,
}


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
        # Each case observes the once-per-process fallback log afresh.
        self._logged = agent._PHONE_AGENT_NAME_FALLBACK_LOGGED
        agent._PHONE_AGENT_NAME_FALLBACK_LOGGED = False
        return self

    def __exit__(self, *exc):
        for k, v in self._prior.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        agent._PHONE_AGENT_NAME_FALLBACK_LOGGED = self._logged
        return False


def _options(env: dict[str, str]) -> dict:
    with _Env(env):
        with patch.object(agent, "WorkerOptions", fixtures._OptionsRecorder):
            agent.build_worker_options()
    return dict(fixtures._OptionsRecorder.last)


def _prewarm_post_kwargs(env: dict[str, str]):
    """Drive the real prewarm and return the kwargs it posted with (or None)."""
    with _Env(env):
        with patch.object(
            agent.worker_ready_api, "post_worker_ready_machine",
            new=AsyncMock(return_value=True),
        ) as post:
            agent._prewarm_post_machine_ready(None)
    if not post.called:
        return None
    return dict(post.call_args.kwargs)


class TestPhoneRegisteredAgentName(unittest.TestCase):
    def test_orchestrated_flag_on_valid_machine_registers_per_machine(self):
        with _Env(_PER_MACHINE_ON):
            self.assertEqual(agent.phone_registered_agent_name(), f"{_BASE}-{_MACHINE}")
            # The BASE name is unchanged — phone-mode detection and room
            # ownership still key off it.
            self.assertEqual(agent._phone_agent_name(), _BASE)

    def test_second_fixture_machine_id(self):
        with _Env({**_PER_MACHINE_ON, "FLY_MACHINE_ID": "7812736a540d58"}):
            self.assertEqual(agent.phone_registered_agent_name(), f"{_BASE}-7812736a540d58")

    def test_flag_absent_is_base(self):
        env = dict(_PER_MACHINE_ON)
        env.pop("PHONE_PER_MACHINE_AGENT_NAME")
        with _Env(env):
            self.assertEqual(agent.phone_registered_agent_name(), _BASE)

    def test_flag_is_case_insensitive_exact_true_after_strip(self):
        for value, expected in (
            ("TRUE", f"{_BASE}-{_MACHINE}"),
            ("  True ", f"{_BASE}-{_MACHINE}"),
            ("1", _BASE),
            ("yes", _BASE),
            ("on", _BASE),
            ("false", _BASE),
            ("", _BASE),
            ("truee", _BASE),
        ):
            with self.subTest(value=value):
                with _Env({**_PER_MACHINE_ON, "PHONE_PER_MACHINE_AGENT_NAME": value}):
                    self.assertEqual(agent.phone_registered_agent_name(), expected)

    def test_orchestration_off_is_base(self):
        for orch in (None, "off", "true", "Worker"):
            with self.subTest(orch=orch):
                env = dict(_PER_MACHINE_ON)
                if orch is None:
                    env.pop("WORKER_ORCHESTRATION")
                else:
                    env["WORKER_ORCHESTRATION"] = orch
                with _Env(env):
                    self.assertEqual(agent.phone_registered_agent_name(), _BASE)

    def test_browser_worker_is_never_per_machine(self):
        # No PHONE_AGENT_NAME ⇒ not the phone worker ⇒ the base, i.e. "".
        env = dict(_PER_MACHINE_ON)
        env.pop("PHONE_AGENT_NAME")
        env["BROWSER_AGENT_NAME"] = "screening-agent"
        with _Env(env):
            self.assertEqual(agent.phone_registered_agent_name(), "")

    def test_invalid_or_missing_machine_id_falls_back_to_base_and_logs_once(self):
        for machine in (None, "", "ABC", "D895472C499E38", "abcdefg", "a" * 33,
                        "a.bcdefgh", "ab-cdefgh", "d895472c499e38\n", " d895472c499e38"):
            with self.subTest(machine=machine):
                env = dict(_PER_MACHINE_ON)
                if machine is None:
                    env.pop("FLY_MACHINE_ID")
                else:
                    env["FLY_MACHINE_ID"] = machine
                with _Env(env):
                    with patch.object(agent._log, "warn") as warn:
                        self.assertEqual(agent.phone_registered_agent_name(), _BASE)
                        self.assertEqual(agent.phone_registered_agent_name(), _BASE)
                    # Logged ONCE per process, with a fixed category and never
                    # the raw value.
                    self.assertEqual(warn.call_count, 1)
                    kwargs = warn.call_args.kwargs
                    self.assertEqual(kwargs["error_type"], "phone_agent_name_fallback")
                    self.assertEqual(kwargs["error_category"],
                                     "machine_id_missing" if not machine else "machine_id_invalid")
                    if machine:
                        self.assertNotIn(machine.strip(), repr(warn.call_args))

    def test_base_the_api_would_reject_falls_back_to_base(self):
        # A composed name outside the API's AGENT_NAME_RE would 400 every ready
        # post; the worker keeps the shared name instead.
        for base in ("p" * 65, "phone.screener", "phone screener"):
            with self.subTest(base=base):
                with _Env({**_PER_MACHINE_ON, "PHONE_AGENT_NAME": base}):
                    with patch.object(agent._log, "warn") as warn:
                        self.assertEqual(agent.phone_registered_agent_name(), base)
                    self.assertEqual(warn.call_args.kwargs["error_category"],
                                     "base_name_invalid")

    def test_regex_boundaries(self):
        ok = ("abcdefgh", "a" * 32, "0123456789", _MACHINE, "7812736a540d58")
        bad = ("abcdefg", "a" * 33, "", "ABCDEFGH", "abc_defgh", "abcdefgh\n")
        for value in ok:
            self.assertIsNotNone(agent._PER_MACHINE_ID_RE.fullmatch(value), value)
        for value in bad:
            self.assertIsNone(agent._PER_MACHINE_ID_RE.fullmatch(value), repr(value))


class TestWorkerOptionsAgentName(unittest.TestCase):
    def test_per_machine_name_is_registered(self):
        opts = _options({**_PER_MACHINE_ON, **_JUDGE_ENV})
        self.assertEqual(opts["agent_name"], f"{_BASE}-{_MACHINE}")
        # Nothing else about the phone posture drifts with the name.
        self.assertIs(opts["prewarm_fnc"], agent._prewarm_post_machine_ready)
        self.assertEqual(opts["num_idle_processes"], 1)
        self.assertIs(opts["load_fnc"], agent._phone_one_call_per_machine_load)

    def test_flag_absent_registers_base(self):
        env = {**_PER_MACHINE_ON, **_JUDGE_ENV}
        env.pop("PHONE_PER_MACHINE_AGENT_NAME")
        self.assertEqual(_options(env)["agent_name"], _BASE)

    def test_orchestration_off_registers_base(self):
        env = {**_PER_MACHINE_ON, **_JUDGE_ENV}
        env.pop("WORKER_ORCHESTRATION")
        opts = _options(env)
        self.assertEqual(opts["agent_name"], _BASE)
        self.assertNotIn("prewarm_fnc", opts)

    def test_invalid_machine_registers_base(self):
        opts = _options({**_PER_MACHINE_ON, **_JUDGE_ENV, "FLY_MACHINE_ID": "not-a-machine"})
        self.assertEqual(opts["agent_name"], _BASE)

    def test_browser_named_options_unchanged_by_the_flag(self):
        env = {
            "BROWSER_AGENT_NAME": "screening-agent",
            "WORKER_ORCHESTRATION": "worker",
            "PHONE_PER_MACHINE_AGENT_NAME": "true",
            "FLY_MACHINE_ID": _MACHINE,
        }
        opts = _options(env)
        self.assertEqual(opts["agent_name"], "screening-agent")
        self.assertIs(opts["prewarm_fnc"], agent._prewarm_post_machine_ready)

    def test_unnamed_browser_worker_has_no_agent_name(self):
        opts = _options({"PHONE_PER_MACHINE_AGENT_NAME": "true", "FLY_MACHINE_ID": _MACHINE})
        self.assertNotIn("agent_name", opts)
        self.assertNotIn("prewarm_fnc", opts)

    def test_base_name_still_drives_room_ownership(self):
        # A per-machine registration must not change which rooms this worker
        # owns: ownership keys off the BASE name being non-empty.
        with _Env(_PER_MACHINE_ON):
            self.assertTrue(agent._worker_handles_room(fixtures._PHONE_ROOM, None))
            self.assertFalse(agent._worker_handles_room("screening-browser-room", None))


class TestPrewarmReadyPostAgentName(unittest.TestCase):
    def test_per_machine_name_is_reported(self):
        kwargs = _prewarm_post_kwargs(_PER_MACHINE_ON)
        self.assertEqual(kwargs, {"agent_name": f"{_BASE}-{_MACHINE}"})

    def test_flag_absent_posts_no_agent_name(self):
        env = dict(_PER_MACHINE_ON)
        env.pop("PHONE_PER_MACHINE_AGENT_NAME")
        self.assertEqual(_prewarm_post_kwargs(env), {})

    def test_invalid_or_missing_machine_posts_no_agent_name(self):
        for machine in (None, "BAD", "a" * 33):
            with self.subTest(machine=machine):
                env = dict(_PER_MACHINE_ON)
                if machine is None:
                    env.pop("FLY_MACHINE_ID")
                else:
                    env["FLY_MACHINE_ID"] = machine
                self.assertEqual(_prewarm_post_kwargs(env), {})

    def test_browser_named_worker_posts_no_agent_name(self):
        env = {
            "BROWSER_AGENT_NAME": "screening-agent",
            "WORKER_ORCHESTRATION": "worker",
            "PHONE_PER_MACHINE_AGENT_NAME": "true",
            "FLY_MACHINE_ID": _MACHINE,
        }
        self.assertEqual(_prewarm_post_kwargs(env), {})

    def test_orchestration_off_posts_nothing(self):
        env = dict(_PER_MACHINE_ON)
        env.pop("WORKER_ORCHESTRATION")
        self.assertIsNone(_prewarm_post_kwargs(env))

    def test_post_failure_never_raises_out_of_prewarm(self):
        with _Env(_PER_MACHINE_ON):
            with patch.object(
                agent.worker_ready_api, "post_worker_ready_machine",
                new=AsyncMock(side_effect=RuntimeError("boom")),
            ):
                agent._prewarm_post_machine_ready(None)  # must not raise

    def test_end_to_end_body_through_the_real_client(self):
        # The real worker_ready_api client, a fake transport: the wire body is
        # exactly {app, machine_id, agent_name} on, {app, machine_id} off.
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

        common = {"FLY_APP_NAME": "project-hello-phone-voice", "WORKER_CONTEXT_SECRET": "s3cr3t"}
        prior = {k: os.environ.get(k) for k in common}
        os.environ.update(common)
        try:
            for env, expected in (
                (_PER_MACHINE_ON, {"app": "project-hello-phone-voice", "machine_id": _MACHINE,
                                   "agent_name": f"{_BASE}-{_MACHINE}"}),
                ({k: v for k, v in _PER_MACHINE_ON.items()
                  if k != "PHONE_PER_MACHINE_AGENT_NAME"},
                 {"app": "project-hello-phone-voice", "machine_id": _MACHINE}),
            ):
                captured.clear()
                with _Env(env):
                    with patch.object(agent.worker_ready_api, "post_worker_ready_machine",
                                      new=via_fake):
                        agent._prewarm_post_machine_ready(None)
                self.assertEqual(captured, [expected])
        finally:
            for k, v in prior.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


class TestPhoneFlyConfig(unittest.TestCase):
    """Deploy posture for the phone app (fly.phone.toml): PR-A's kill_timeout
    plus PR-B's (M009 B6) per-machine registration flip."""

    def setUp(self):
        self.text = (_CTX / "fly.phone.toml").read_text(encoding="utf-8")
        self.cfg = tomllib.loads(self.text)

    def test_per_machine_flag_is_exactly_true_in_pr_b(self):
        # Flipped in PR-B, only once PR-A's API that accepts and stores names
        # is live — the old strict /ready-machine schema would 400 the new key.
        # Exactly "true": the reader also accepts " TRUE " etc., but the deploy
        # validator pins the literal so the manifest says what it means.
        self.assertEqual(self.cfg.get("env", {}).get("PHONE_PER_MACHINE_AGENT_NAME"), "true")

    def test_shipped_env_registers_per_machine_name(self):
        # The SHIPPED [env] (orchestration posture, base name and flag exactly
        # as deployed) plus a well-formed Fly machine id resolves to
        # `<base>-<id>`, and the prewarm ready post reports that name — the two
        # ends the API pairs to dispatch a leased session to its own machine.
        env = self.cfg.get("env", {})
        shipped = {
            k: env[k]
            for k in ("WORKER_ORCHESTRATION", "PHONE_AGENT_NAME", "PHONE_PER_MACHINE_AGENT_NAME")
        }
        base = shipped["PHONE_AGENT_NAME"]
        with _Env({**shipped, "FLY_MACHINE_ID": _MACHINE}):
            self.assertEqual(agent.phone_registered_agent_name(), f"{base}-{_MACHINE}")
            # Phone-mode detection and room ownership still key off the base.
            self.assertEqual(agent._phone_agent_name(), base)
        kwargs = _prewarm_post_kwargs({**shipped, "FLY_MACHINE_ID": _MACHINE})
        self.assertIsNotNone(kwargs)
        self.assertEqual(kwargs.get("agent_name"), f"{base}-{_MACHINE}")

    def test_shipped_env_falls_back_to_base_without_a_machine_id(self):
        # Rollback-safe floor: with the flag on but no usable machine id the
        # worker registers the BASE name and posts no agent_name, so it and the
        # API still agree on the shared name.
        env = self.cfg.get("env", {})
        shipped = {
            k: env[k]
            for k in ("WORKER_ORCHESTRATION", "PHONE_AGENT_NAME", "PHONE_PER_MACHINE_AGENT_NAME")
        }
        with _Env(shipped):
            self.assertEqual(agent.phone_registered_agent_name(), shipped["PHONE_AGENT_NAME"])
        kwargs = _prewarm_post_kwargs(shipped)
        self.assertIsNotNone(kwargs)
        self.assertNotIn("agent_name", kwargs)

    def test_kill_timeout_lets_a_stop_drain(self):
        # Fly's default 5 s force-kill defeats the SDK drain; the configured
        # value must at least cover the parent's process-shutdown grace.
        kill_timeout = self.cfg.get("kill_timeout")
        self.assertIsInstance(kill_timeout, int)
        self.assertGreaterEqual(kill_timeout, 90)
        self.assertLessEqual(kill_timeout, 300)

    def test_browser_config_has_no_per_machine_flag(self):
        browser = tomllib.loads((_CTX / "fly.toml").read_text(encoding="utf-8"))
        self.assertNotIn("PHONE_PER_MACHINE_AGENT_NAME", browser.get("env", {}))

    def test_registration_proof_text_untouched(self):
        # The deploy proof greps the SDK's "registered worker" line; nothing in
        # the worker may log a look-alike that could satisfy it.
        source = (_CTX / "agent.py").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"[\"']registered worker", source))


if __name__ == "__main__":
    unittest.main()
