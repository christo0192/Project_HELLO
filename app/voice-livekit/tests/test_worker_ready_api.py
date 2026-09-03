"""Unit tests for the worker→API readiness client (PR B). Fake poster, no net.

Proves: (1) the request is shaped correctly and returns True on ok; (2) it is a
NO-OP returning False when WORKER_ORCHESTRATION is off (default); (3) it is
fail-open on every transport/HTTP failure; (4) it fails closed when the Fly
identity or worker secret is unavailable.
"""

import asyncio
import os
import unittest

import worker_ready_api as api
from provider_resilience import BusinessError, ProviderError


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class _Resp:
    def __init__(self, payload):
        self._p = payload

    def json(self):
        return self._p


def _poster(payload=None, *, raise_exc=None, captured=None):
    async def post(method, url, headers, json_body):
        if captured is not None:
            captured.update(method=method, url=url, headers=headers, body=json_body)
        if raise_exc is not None:
            raise raise_exc
        return _Resp(payload)
    return post


class _EnvGuard:
    """Save/restore a fixed set of env vars around a test."""

    KEYS = (
        "WORKER_ORCHESTRATION", "WORKER_CONTEXT_SECRET",
        "FLY_MACHINE_ID", "FLY_APP_NAME", "PHONE_VOICE_APP",
    )

    def __enter__(self):
        self._prior = {k: os.environ.get(k) for k in self.KEYS}
        return self

    def __exit__(self, *exc):
        for k, v in self._prior.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return False


def _arm():
    os.environ["WORKER_ORCHESTRATION"] = "worker"
    os.environ["WORKER_CONTEXT_SECRET"] = "s3cr3t"
    os.environ["FLY_MACHINE_ID"] = "d891ee23"
    os.environ["FLY_APP_NAME"] = "project-hello-phone-voice"
    os.environ.pop("PHONE_VOICE_APP", None)


class TestWorkerOrchestrationEnabled(unittest.TestCase):
    def test_exact_string_only(self):
        with _EnvGuard():
            os.environ["WORKER_ORCHESTRATION"] = "worker"
            self.assertTrue(api.worker_orchestration_enabled())
            for val in ("off", "true", "1", "Worker", "WORKER", ""):
                os.environ["WORKER_ORCHESTRATION"] = val
                self.assertFalse(api.worker_orchestration_enabled())
            os.environ.pop("WORKER_ORCHESTRATION", None)
            self.assertFalse(api.worker_orchestration_enabled())


class TestPostWorkerReady(unittest.TestCase):
    def test_ready_ok_shapes_request_and_returns_true(self):
        with _EnvGuard():
            _arm()
            cap = {}
            post = _poster({"ok": True, "status": "ready"}, captured=cap)
            ok = _run(api.post_worker_ready(
                "33333333-3333-4333-8333-333333333333", 7, post=post))
            self.assertTrue(ok)
            self.assertEqual(cap["method"], "POST")
            self.assertTrue(cap["url"].endswith("/api/internal/voice-worker/ready"))
            self.assertEqual(cap["headers"]["Authorization"], "Bearer s3cr3t")
            self.assertEqual(cap["body"], {
                "app": "project-hello-phone-voice",
                "machine_id": "d891ee23",
                "session_id": "33333333-3333-4333-8333-333333333333",
                "epoch": 7,
            })

    def test_phone_voice_app_overrides_fly_app_name(self):
        with _EnvGuard():
            _arm()
            os.environ["PHONE_VOICE_APP"] = "override-app"
            cap = {}
            post = _poster({"ok": True}, captured=cap)
            _run(api.post_worker_ready("s", 1, post=post))
            self.assertEqual(cap["body"]["app"], "override-app")

    def test_explicit_app_and_machine_override_env(self):
        with _EnvGuard():
            _arm()
            cap = {}
            post = _poster({"ok": True}, captured=cap)
            _run(api.post_worker_ready(
                "s", 2, app="a-app", machine_id="m-99", post=post))
            self.assertEqual(cap["body"]["app"], "a-app")
            self.assertEqual(cap["body"]["machine_id"], "m-99")

    def test_noop_when_flag_off(self):
        with _EnvGuard():
            _arm()
            os.environ["WORKER_ORCHESTRATION"] = "off"
            called = {"n": 0}

            async def post(*_a, **_k):
                called["n"] += 1
                return _Resp({"ok": True})

            ok = _run(api.post_worker_ready("s", 1, post=post))
            self.assertFalse(ok)
            self.assertEqual(called["n"], 0)  # the poster was NEVER reached

    def test_fails_closed_without_machine_id(self):
        with _EnvGuard():
            _arm()
            os.environ.pop("FLY_MACHINE_ID", None)
            post = _poster({"ok": True})
            self.assertFalse(_run(api.post_worker_ready("s", 1, post=post)))

    def test_fails_closed_without_app(self):
        with _EnvGuard():
            _arm()
            os.environ.pop("FLY_APP_NAME", None)
            post = _poster({"ok": True})
            self.assertFalse(_run(api.post_worker_ready("s", 1, post=post)))

    def test_fails_closed_without_secret(self):
        with _EnvGuard():
            _arm()
            os.environ.pop("WORKER_CONTEXT_SECRET", None)
            post = _poster({"ok": True})
            self.assertFalse(_run(api.post_worker_ready("s", 1, post=post)))

    def test_not_ok_verdict_returns_false(self):
        with _EnvGuard():
            _arm()
            post = _poster({"ok": False, "status": "stale"})
            self.assertFalse(_run(api.post_worker_ready("s", 1, post=post)))

    def test_fail_open_on_errors(self):
        with _EnvGuard():
            _arm()
            for exc in (ProviderError("x"), BusinessError(), RuntimeError("z")):
                post = _poster(raise_exc=exc)
                self.assertFalse(_run(api.post_worker_ready("s", 1, post=post)))


class TestPostWorkerReadyMachine(unittest.TestCase):
    """The BROWSER worker's session-less machine-level readiness ping."""

    def test_ready_machine_shapes_request_and_returns_true(self):
        with _EnvGuard():
            _arm()
            os.environ["FLY_APP_NAME"] = "project-hello-voice"
            cap = {}
            post = _poster({"ok": True, "status": "ready"}, captured=cap)
            ok = _run(api.post_worker_ready_machine(post=post))
            self.assertTrue(ok)
            self.assertEqual(cap["method"], "POST")
            self.assertTrue(cap["url"].endswith(
                "/api/internal/voice-worker/ready-machine"))
            self.assertEqual(cap["headers"]["Authorization"], "Bearer s3cr3t")
            # NO session_id / epoch — only app + machine_id.
            self.assertEqual(cap["body"], {
                "app": "project-hello-voice", "machine_id": "d891ee23",
            })
            self.assertNotIn("session_id", cap["body"])
            self.assertNotIn("epoch", cap["body"])

    def test_noop_when_flag_off(self):
        with _EnvGuard():
            _arm()
            os.environ["WORKER_ORCHESTRATION"] = "off"
            called = {"n": 0}

            async def post(*_a, **_k):
                called["n"] += 1
                return _Resp({"ok": True})

            self.assertFalse(_run(api.post_worker_ready_machine(post=post)))
            self.assertEqual(called["n"], 0)

    def test_fails_closed_without_identity(self):
        with _EnvGuard():
            _arm()
            os.environ.pop("FLY_MACHINE_ID", None)
            post = _poster({"ok": True})
            self.assertFalse(_run(api.post_worker_ready_machine(post=post)))

    def test_explicit_overrides(self):
        with _EnvGuard():
            _arm()
            cap = {}
            post = _poster({"ok": True}, captured=cap)
            _run(api.post_worker_ready_machine(app="b-app", machine_id="mX", post=post))
            self.assertEqual(cap["body"], {"app": "b-app", "machine_id": "mX"})

    def test_fail_open_on_errors(self):
        with _EnvGuard():
            _arm()
            for exc in (ProviderError("x"), BusinessError(), RuntimeError("z")):
                post = _poster(raise_exc=exc)
                self.assertFalse(_run(api.post_worker_ready_machine(post=post)))


if __name__ == "__main__":
    unittest.main()
