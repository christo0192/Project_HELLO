"""Unit tests for the worker→API recording client (PR A). Fake poster, no net."""

import asyncio
import os
import unittest

import recording_api as api
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


class TestPrepareRecording(unittest.TestCase):
    def setUp(self):
        self._prior = os.environ.get("WORKER_CONTEXT_SECRET")
        os.environ["WORKER_CONTEXT_SECRET"] = "s3cr3t"

    def tearDown(self):
        if self._prior is None:
            os.environ.pop("WORKER_CONTEXT_SECRET", None)
        else:
            os.environ["WORKER_CONTEXT_SECRET"] = self._prior

    def test_prepare_ok_returns_keys_and_shapes_request(self):
        cap = {}
        post = _poster({"ok": True, "status": "prepared",
                        "object_key": "phone/attempts/a.mp3",
                        "upload_url": "https://up/put?sig=x"}, captured=cap)
        out = _run(api.prepare_recording("att1", "sess1", "eng1", post=post))
        self.assertEqual(out, {"object_key": "phone/attempts/a.mp3",
                               "upload_url": "https://up/put?sig=x"})
        self.assertTrue(cap["url"].endswith("/api/internal/phone/recording/prepare"))
        self.assertEqual(cap["headers"]["Authorization"], "Bearer s3cr3t")
        self.assertEqual(cap["body"], {"attempt_id": "att1", "session_id": "sess1",
                                       "engagement_id": "eng1"})

    def test_prepare_refused_returns_none(self):
        post = _poster({"ok": False, "status": "refused", "reason": "role_undecidable"})
        self.assertIsNone(_run(api.prepare_recording("a", "s", "e", post=post)))

    def test_prepare_missing_fields_returns_none(self):
        post = _poster({"ok": True, "object_key": "k"})  # no upload_url
        self.assertIsNone(_run(api.prepare_recording("a", "s", "e", post=post)))

    def test_prepare_no_secret_returns_none(self):
        os.environ.pop("WORKER_CONTEXT_SECRET", None)
        post = _poster({"ok": True, "object_key": "k", "upload_url": "u"})
        self.assertIsNone(_run(api.prepare_recording("a", "s", "e", post=post)))

    def test_prepare_fail_open_on_errors(self):
        for exc in (ProviderError("x"), BusinessError(), RuntimeError("z")):
            post = _poster(raise_exc=exc)
            self.assertIsNone(_run(api.prepare_recording("a", "s", "e", post=post)))


class TestCompleteRecording(unittest.TestCase):
    def setUp(self):
        os.environ["WORKER_CONTEXT_SECRET"] = "s3cr3t"

    def tearDown(self):
        os.environ.pop("WORKER_CONTEXT_SECRET", None)

    def test_complete_ok_true_and_shapes_body(self):
        cap = {}
        post = _poster({"ok": True, "status": "ready"}, captured=cap)
        ok = _run(api.complete_recording("att1", "sess1", "a" * 64, 1234, 5678, post=post))
        self.assertTrue(ok)
        self.assertTrue(cap["url"].endswith("/recording/complete"))
        self.assertEqual(cap["body"]["sha256"], "a" * 64)
        self.assertEqual(cap["body"]["size_bytes"], 1234)
        self.assertEqual(cap["body"]["duration_ms"], 5678)

    def test_complete_omits_null_duration(self):
        cap = {}
        post = _poster({"ok": True}, captured=cap)
        _run(api.complete_recording("a", "s", "b" * 64, 10, None, post=post))
        self.assertNotIn("duration_ms", cap["body"])

    def test_complete_not_ready_false(self):
        post = _poster({"ok": False, "status": "pending"})
        self.assertFalse(_run(api.complete_recording("a", "s", "c" * 64, 1, 2, post=post)))

    def test_complete_fail_open_on_error(self):
        post = _poster(raise_exc=ProviderError("x"))
        self.assertFalse(_run(api.complete_recording("a", "s", "d" * 64, 1, 2, post=post)))


class TestFailRecording(unittest.TestCase):
    """/recording/failed — the worker's permanent-loss report (live 2026-09-03:
    without it the finalizer retried a never-uploaded key to exhaustion and the
    dashboard said "Recording is still processing" forever)."""

    def setUp(self):
        os.environ["WORKER_CONTEXT_SECRET"] = "s3cr3t"

    def tearDown(self):
        os.environ.pop("WORKER_CONTEXT_SECRET", None)

    def test_failed_ok_true_and_shapes_body(self):
        cap = {}
        post = _poster({"ok": True, "status": "failed_latched"}, captured=cap)
        ok = _run(api.fail_recording("att1", "sess1", "upload_failed", post=post))
        self.assertTrue(ok)
        self.assertTrue(cap["url"].endswith("/recording/failed"))
        self.assertEqual(cap["body"], {
            "attempt_id": "att1", "session_id": "sess1", "reason": "upload_failed",
        })

    def test_failed_bounds_the_reason(self):
        cap = {}
        post = _poster({"ok": True, "status": "failed_latched"}, captured=cap)
        _run(api.fail_recording("a", "s", "x" * 200, post=post))
        self.assertEqual(len(cap["body"]["reason"]), 64)

    def test_failed_not_latched_false(self):
        post = _poster({"ok": False, "status": "already_linked"})
        self.assertFalse(_run(api.fail_recording("a", "s", "upload_failed", post=post)))

    def test_failed_fail_open_on_error_and_no_secret(self):
        for exc in (ProviderError("x"), BusinessError(), RuntimeError("z")):
            post = _poster(raise_exc=exc)
            self.assertFalse(_run(api.fail_recording("a", "s", "r", post=post)))
        os.environ.pop("WORKER_CONTEXT_SECRET", None)
        post = _poster({"ok": True})
        self.assertFalse(_run(api.fail_recording("a", "s", "r", post=post)))


if __name__ == "__main__":
    unittest.main()
