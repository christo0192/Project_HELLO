"""Unit tests for the worker→API recording client (PR A). Fake poster, no net."""

import asyncio
import os
import unittest
import unittest.mock

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


def _business_400(status):
    exc = BusinessError(status_code=400)
    exc.body = {"ok": False, "status": status}
    return exc


class _SeqPoster:
    """Replies in order; each reply is a payload dict or an exception."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.bodies = []

    async def __call__(self, method, url, headers, json_body):
        self.bodies.append(dict(json_body))
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return _Resp(reply)


_TIMING = {
    "recording_started_at_ms": 1_790_000_000_000,
    "leg_ended_at_ms": 1_790_000_060_430,
    "leg_end_source": "sip_left",
    "tail_flushed": True,
}


class TestCompleteRecordingTiming(unittest.TestCase):
    """M013 S02 T02: the leg timing rides on /recording/complete as data, and
    an older API (a rollback) never loses the completion."""

    def setUp(self):
        os.environ["WORKER_CONTEXT_SECRET"] = "s3cr3t"

    def tearDown(self):
        os.environ.pop("WORKER_CONTEXT_SECRET", None)

    def test_body_carries_the_new_fields(self):
        post = _SeqPoster({"ok": True, "status": "ready"})
        ok = _run(api.complete_recording("att1", "sess1", "a" * 64, 10, 60_400,
                                         post=post, **_TIMING))
        self.assertTrue(ok)
        self.assertEqual(post.bodies, [{
            "attempt_id": "att1", "session_id": "sess1", "sha256": "a" * 64,
            "size_bytes": 10, "duration_ms": 60_400, **_TIMING,
        }])

    def test_none_fields_are_omitted(self):
        post = _SeqPoster({"ok": True})
        _run(api.complete_recording("a", "s", "b" * 64, 10, None, post=post,
                                    recording_started_at_ms=None,
                                    leg_ended_at_ms=5, tail_flushed=None))
        self.assertEqual(post.bodies[0], {
            "attempt_id": "a", "session_id": "s", "sha256": "b" * 64,
            "size_bytes": 10, "leg_ended_at_ms": 5,
        })

    def test_tail_flushed_false_is_sent_not_dropped(self):
        post = _SeqPoster({"ok": True})
        _run(api.complete_recording("a", "s", "b" * 64, 10, 7, post=post,
                                    tail_flushed=False))
        self.assertIs(post.bodies[0]["tail_flushed"], False)

    def test_400_invalid_request_retries_the_legacy_body_exactly_once(self):
        post = _SeqPoster(_business_400("invalid_request"), {"ok": True, "status": "ready"})
        ok = _run(api.complete_recording("a", "s", "c" * 64, 10, 7, post=post, **_TIMING))
        self.assertTrue(ok)
        self.assertEqual(len(post.bodies), 2)
        self.assertEqual(post.bodies[0]["tail_flushed"], True)
        self.assertEqual(post.bodies[1], {
            "attempt_id": "a", "session_id": "s", "sha256": "c" * 64,
            "size_bytes": 10, "duration_ms": 7,
        })

    def test_legacy_retry_is_not_repeated_when_it_also_fails(self):
        post = _SeqPoster(_business_400("invalid_request"), _business_400("invalid_request"))
        ok = _run(api.complete_recording("a", "s", "c" * 64, 10, 7, post=post, **_TIMING))
        self.assertFalse(ok)
        self.assertEqual(len(post.bodies), 2)

    def test_400_with_another_status_does_not_retry(self):
        for exc in (_business_400("invalid_body"), _business_400(None),
                    BusinessError(status_code=400)):
            post = _SeqPoster(exc, {"ok": True})
            self.assertFalse(_run(api.complete_recording(
                "a", "s", "c" * 64, 10, 7, post=post, **_TIMING)))
            self.assertEqual(len(post.bodies), 1)

    def test_other_4xx_with_the_token_does_not_retry(self):
        exc = BusinessError(status_code=409)
        exc.body = {"ok": False, "status": "invalid_request"}
        post = _SeqPoster(exc, {"ok": True})
        self.assertFalse(_run(api.complete_recording(
            "a", "s", "c" * 64, 10, 7, post=post, **_TIMING)))
        self.assertEqual(len(post.bodies), 1)

    def test_5xx_and_transport_errors_do_not_retry(self):
        for exc in (ProviderError("protocol"), ProviderError("timeout"), RuntimeError("x")):
            post = _SeqPoster(exc, {"ok": True})
            self.assertFalse(_run(api.complete_recording(
                "a", "s", "c" * 64, 10, 7, post=post, **_TIMING)))
            self.assertEqual(len(post.bodies), 1)

    def test_legacy_shaped_call_never_retries(self):
        # No new fields were sent, so the legacy body is identical: no retry.
        post = _SeqPoster(_business_400("invalid_request"), {"ok": True})
        self.assertFalse(_run(api.complete_recording("a", "s", "c" * 64, 10, 7, post=post)))
        self.assertEqual(len(post.bodies), 1)

    def test_logs_carry_categories_only(self):
        seen = []
        post = _SeqPoster(_business_400("invalid_request"), ProviderError("protocol"))
        with unittest.mock.patch.object(api._log, "info",
                                        lambda *a, **k: seen.append((a, k))):
            _run(api.complete_recording("att-secret", "sess-secret", "c" * 64, 10, 7,
                                        post=post, **_TIMING))
        self.assertEqual([k["error_category"] for _a, k in seen],
                         ["legacy_body_retry", "api_error"])
        flat = repr(seen)
        for value in ("att-secret", "sess-secret", "c" * 64):
            self.assertNotIn(value, flat)


class _HttpResp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class _ScriptedTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.bodies = []

    async def request(self, method, url, *, json=None, timeout=None, headers=None):
        self.bodies.append(json)
        return self.responses.pop(0)

    async def close(self):
        pass


class TestDefaultPostCompatRetry(unittest.TestCase):
    """The REAL `_default_post` (breaker + status classification) must expose
    the 400 body so the compat retry can see the route's token."""

    def setUp(self):
        os.environ["WORKER_CONTEXT_SECRET"] = "s3cr3t"
        api._RECORDING_BREAKER.reset()

    def tearDown(self):
        os.environ.pop("WORKER_CONTEXT_SECRET", None)
        api._RECORDING_BREAKER.reset()

    def test_400_body_is_attached_to_the_business_error(self):
        t = _ScriptedTransport(_HttpResp(400, {"ok": False, "status": "invalid_request"}))
        with unittest.mock.patch.object(api, "_get_transport", lambda: t):
            with self.assertRaises(BusinessError) as ctx:
                _run(api._default_post("POST", "http://x/complete", {}, {"a": 1}))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.body, {"ok": False, "status": "invalid_request"})

    def test_non_json_400_body_is_unknown(self):
        t = _ScriptedTransport(_HttpResp(400, ValueError("not json")))
        with unittest.mock.patch.object(api, "_get_transport", lambda: t):
            with self.assertRaises(BusinessError) as ctx:
                _run(api._default_post("POST", "http://x/complete", {}, {"a": 1}))
        self.assertIsNone(ctx.exception.body)

    def test_end_to_end_old_api_gets_the_legacy_body(self):
        t1 = _ScriptedTransport(_HttpResp(400, {"ok": False, "status": "invalid_request"}))
        t2 = _ScriptedTransport(_HttpResp(200, {"ok": True, "status": "ready"}))
        transports = [t1, t2]
        with unittest.mock.patch.object(api, "_get_transport", lambda: transports.pop(0)):
            ok = _run(api.complete_recording("a", "s", "e" * 64, 10, 7, **_TIMING))
        self.assertTrue(ok)
        self.assertIn("leg_ended_at_ms", t1.bodies[0])
        self.assertNotIn("leg_ended_at_ms", t2.bodies[0])
        self.assertNotIn("leg_end_source", t2.bodies[0])
        self.assertNotIn("recording_started_at_ms", t2.bodies[0])
        self.assertNotIn("tail_flushed", t2.bodies[0])

    def test_end_to_end_500_is_not_retried(self):
        t1 = _ScriptedTransport(_HttpResp(500, {"ok": False}))
        transports = [t1]
        with unittest.mock.patch.object(api, "_get_transport", lambda: transports.pop(0)):
            ok = _run(api.complete_recording("a", "s", "e" * 64, 10, 7, **_TIMING))
        self.assertFalse(ok)
        self.assertEqual(transports, [])
        self.assertEqual(len(t1.bodies), 1)


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
