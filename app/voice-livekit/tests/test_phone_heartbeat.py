"""P5 — the heartbeat that keeps a concurrency lease alive for a whole call.

THE DEFECT THIS FILE EXISTS TO PIN. 0042 sizes an attempt's lease to cover the
ORIGINATE and says out loud that the 10-slot fleet cap's correctness depends on
the worker renewing it. Nothing renewed it. A screening runs for minutes, so on
every answered call the lease lapsed mid-conversation: the slot was released the
instant it did (the cap counts `lease_expires_at > now`), the reclaim sweep
marked the attempt `abandoned` while the candidate was still speaking, the
engagement left `in_call`, and the assessment this leg then scored was ignored
because that edge is gated on `in_call`. A screening that was conducted and
scored was lost, silently.

Four properties, and every test here pins one:

1. **The SERVER dictates the cadence.** The worker clamps it into an envelope
   it can honour and otherwise does as it is told.
2. **`lease_lost` stops the conversation.** The slot may already belong to
   another call, so there is no safe version of carrying on.
3. **A blip is not a lost lease — but an unrenewed lease becomes one.** One
   failure retries; a run of them halts, because at that point the hazard is
   indistinguishable from `lease_lost`.
4. **No identifier is ever logged**, and the control for that assertion proves
   the log sink was actually receiving records.

`phone.py` imports no SDK at module scope, so this module needs no stub. Time
is injected everywhere; nothing here sleeps.
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import phone  # noqa: E402


_SESSION_ID = "11111111-2222-4333-8444-555555555555"
_ATTEMPT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
# Deliberately a long, unmistakable digit run: every "was this identifier
# logged?" assertion below is a substring search, and a small epoch like 1
# would make those searches pass by coincidence.
_EPOCH = 424242
_GOOD_SECRET = "x" * 32


def _run(coro):
    return asyncio.run(coro)


def _dispatch(**overrides) -> str:
    blob = {
        "session_id": _SESSION_ID,
        "attempt_id": _ATTEMPT_ID,
        "channel": "phone",
        "epoch": _EPOCH,
    }
    blob.update(overrides)
    return json.dumps({k: v for k, v in blob.items() if v is not _ABSENT})


_ABSENT = object()


def _ctx(dispatch):
    return types.SimpleNamespace(job=types.SimpleNamespace(metadata=dispatch))


# ── Fakes ─────────────────────────────────────────────────────────────

class _Stop(Exception):
    """Raised by the injected clock to end an otherwise endless loop."""


def _ok(seconds=None):
    outcome = phone.PhoneApiOutcome(True, phone.HEARTBEAT_OK_STATUS)
    outcome.next_heartbeat_seconds = (
        phone.HEARTBEAT_FALLBACK_SEC if seconds is None else seconds
    )
    return outcome


def _lease_lost():
    return phone.PhoneApiOutcome(False, phone.HEARTBEAT_LEASE_LOST_STATUS)


def _blip(category="transport"):
    return phone.PhoneApiOutcome(False, error_category=category)


class ScriptedHeartbeatClient:
    """Answers each beat from a script and records every call."""

    def __init__(self, answers=()):
        self.calls: list[tuple] = []
        self._answers = list(answers)

    async def heartbeat_attempt(self, attempt_id, session_id, *, epoch):
        self.calls.append((attempt_id, session_id, epoch))
        answer = self._answers.pop(0) if self._answers else _ok()
        if isinstance(answer, BaseException):
            raise answer
        return answer


class _Loop:
    """One run of the heartbeat with an injected clock and a halt recorder."""

    def __init__(self, answers, *, max_sleeps=8, **kwargs):
        self.client = ScriptedHeartbeatClient(answers)
        self.slept: list[float] = []
        self.halts: list[str] = []
        self._max_sleeps = max_sleeps
        self._kwargs = kwargs

    async def sleep(self, seconds):
        self.slept.append(seconds)
        if len(self.slept) >= self._max_sleeps:
            raise _Stop

    async def halt(self, reason):
        self.halts.append(reason)

    async def run(self):
        try:
            return await phone.run_phone_heartbeat(
                attempt_id=_ATTEMPT_ID,
                session_id=_SESSION_ID,
                epoch=_EPOCH,
                client=self.client,
                halt=self.halt,
                sleep=self.sleep,
                **self._kwargs,
            )
        except _Stop:
            return "_ran_out_of_clock"


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _RecordingTransport:
    def __init__(self, status_code=200, body=None):
        self.requests: list[dict] = []
        self._status = status_code
        self._body = body

    async def request(self, method, url, *, json=None, timeout=None, headers=None):
        self.requests.append(
            {"method": method, "url": url, "json": json, "headers": headers}
        )
        return types.SimpleNamespace(status_code=self._status, json=lambda: self._body)


# ── The epoch reader ──────────────────────────────────────────────────

class TestEpochFromDispatchMetadata(unittest.TestCase):
    """No epoch, no heartbeat; no heartbeat, no call.

    The epoch is the heartbeat's entire claim to the lease — the server tells a
    stale leg from the live one by comparing it. A leg that cannot renew its
    lease will have the slot reclaimed out from under a live conversation, so a
    missing epoch is refused in the same direction as a missing attempt id.
    """

    def test_the_epoch_is_read_off_the_dispatch_blob(self):
        self.assertEqual(phone.epoch_from_dispatch_metadata(_ctx(_dispatch())), _EPOCH)

    def test_bytes_metadata_parses_exactly_like_text(self):
        ctx = _ctx(_dispatch().encode("utf-8"))
        self.assertEqual(phone.epoch_from_dispatch_metadata(ctx), _EPOCH)

    def test_epoch_zero_is_a_real_epoch_and_not_a_missing_one(self):
        # The first dispatch of an attempt. `if not epoch` would have thrown
        # this away and refused a perfectly good call.
        self.assertEqual(phone.epoch_from_dispatch_metadata(_ctx(_dispatch(epoch=0))), 0)

    def test_a_missing_or_malformed_epoch_fails_CLOSED(self):
        cases = {
            "absent blob": None,
            "empty blob": "",
            "not json": "garbage",
            "json array": "[3]",
            "no epoch key": _dispatch(epoch=_ABSENT),
            "null epoch": _dispatch(epoch=None),
            "string epoch": _dispatch(epoch="3"),
            "float epoch": _dispatch(epoch=3.0),
            "bool epoch": _dispatch(epoch=True),
            "negative epoch": _dispatch(epoch=-1),
            "absurd epoch": _dispatch(epoch=phone.MAX_DISPATCH_EPOCH + 1),
            "wrong channel": _dispatch(channel="browser"),
            "missing channel": _dispatch(channel=_ABSENT),
        }
        for label, dispatch in cases.items():
            with self.subTest(label=label):
                self.assertIsNone(phone.epoch_from_dispatch_metadata(_ctx(dispatch)))

    def test_a_context_without_a_job_is_not_an_exception(self):
        self.assertIsNone(phone.epoch_from_dispatch_metadata(object()))


# ── The cadence envelope ──────────────────────────────────────────────

class TestHeartbeatInterval(unittest.TestCase):
    def test_the_envelope_is_derived_from_the_lease_not_invented(self):
        # MAX is lease/2 at the default 60 s lease: a cadence at or past half
        # the lease cannot guarantee a second chance before it lapses. The
        # consecutive-failure bound is derived from this ceiling.
        self.assertEqual(phone.HEARTBEAT_MAX_SEC, 30.0)
        self.assertEqual(phone.HEARTBEAT_FALLBACK_SEC, 20.0)
        self.assertLess(phone.HEARTBEAT_MIN_SEC, phone.HEARTBEAT_FALLBACK_SEC)
        self.assertLess(phone.HEARTBEAT_FALLBACK_SEC, phone.HEARTBEAT_MAX_SEC)

    def test_a_usable_server_value_is_honoured_verbatim(self):
        for value in (2.0, 5, 12.5, 30):
            with self.subTest(value=value):
                self.assertEqual(phone.heartbeat_interval_sec(value), float(value))

    def test_an_absurd_or_missing_value_is_clamped_or_falls_back(self):
        # A LIST, not a dict: `True == 1` and `False == 0` in Python, so a dict
        # would silently collapse the bool cases into the numeric ones and the
        # bool guard would go untested.
        cases = [
            (None, phone.HEARTBEAT_FALLBACK_SEC),
            ("", phone.HEARTBEAT_FALLBACK_SEC),
            ("nonsense", phone.HEARTBEAT_FALLBACK_SEC),
            (float("nan"), phone.HEARTBEAT_FALLBACK_SEC),
            (True, phone.HEARTBEAT_FALLBACK_SEC),   # bool is an int, not a cadence
            (False, phone.HEARTBEAT_FALLBACK_SEC),
            (0, phone.HEARTBEAT_MIN_SEC),           # would otherwise busy-wait
            (-5, phone.HEARTBEAT_MIN_SEC),
            (9999, phone.HEARTBEAT_MAX_SEC),        # would outlive the lease
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(phone.heartbeat_interval_sec(raw), expected)


# ── The client ────────────────────────────────────────────────────────

class TestHeartbeatClient(unittest.IsolatedAsyncioTestCase):
    def _client(self, transport):
        return phone.PhoneEventClient(
            transport_factory=lambda: transport, api_base="http://api.test"
        )

    async def _call(self, body, status=200):
        transport = _RecordingTransport(status, body)
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            outcome = await self._client(transport).heartbeat_attempt(
                _ATTEMPT_ID, _SESSION_ID, epoch=_EPOCH
            )
        return outcome, transport

    async def test_posts_the_exact_strict_body_to_the_worker_route(self):
        outcome, transport = await self._call(
            {"ok": True, "status": "ok", "next_heartbeat_seconds": 15}
        )
        self.assertTrue(outcome.ok)
        request = transport.requests[0]
        self.assertEqual(request["method"], "POST")
        # Under `/api/internal/phone` with every other worker call, because
        # that is the ONE mount. This assertion previously hardcoded
        # `/api/phone-worker/...` — the same wrong value the constant held —
        # so the suite agreed with the defect instead of catching it. It now
        # reads the constant AND pins the prefix, so a path that drifts off
        # the mount fails here as well as in the cross-language test on the
        # TypeScript side.
        self.assertEqual(
            request["url"], f"http://api.test{phone.HEARTBEAT_PATH}"
        )
        self.assertTrue(
            phone.HEARTBEAT_PATH.startswith("/api/internal/phone/"),
            f"heartbeat path {phone.HEARTBEAT_PATH} is off the worker mount",
        )
        # The server schema is `.strict()`: an extra key is a flat 400, so the
        # body carries exactly the three the contract names.
        self.assertEqual(
            request["json"],
            {"attempt_id": _ATTEMPT_ID, "epoch": _EPOCH, "session_id": _SESSION_ID},
        )
        self.assertEqual(request["headers"]["Authorization"], f"Bearer {_GOOD_SECRET}")

    async def test_the_cadence_comes_from_the_SERVER(self):
        outcome, _ = await self._call(
            {"ok": True, "status": "ok", "next_heartbeat_seconds": 7}
        )
        self.assertEqual(outcome.next_heartbeat_seconds, 7.0)

    async def test_an_absurd_server_cadence_is_clamped_at_the_boundary(self):
        for raw, expected in ((0, phone.HEARTBEAT_MIN_SEC),
                              (86400, phone.HEARTBEAT_MAX_SEC),
                              (None, phone.HEARTBEAT_FALLBACK_SEC)):
            with self.subTest(raw=raw):
                outcome, _ = await self._call(
                    {"ok": True, "status": "ok", "next_heartbeat_seconds": raw}
                )
                self.assertEqual(outcome.next_heartbeat_seconds, expected)

    async def test_lease_lost_arrives_inside_a_200_and_is_NOT_ok(self):
        """The whole shape of the mistake: the body says `ok: true`.

        Reading that flag alone would leave a candidate talking to a leg that
        owns no slot, while an eleventh call takes the one it used to hold.
        """
        outcome, _ = await self._call({"ok": True, "status": "lease_lost"})
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.status, phone.HEARTBEAT_LEASE_LOST_STATUS)
        # NOT a transport failure: the caller must be able to tell the two
        # apart, because it halts on one and retries the other.
        self.assertIsNone(outcome.error_category)

    async def test_a_blip_is_the_THIRD_outcome_not_either_of_the_other_two(self):
        cases = [
            (500, {"ok": True, "status": "ok"}),
            (403, {"ok": True, "status": "ok"}),
            (200, {"ok": False, "status": "ok"}),
            (200, {"ok": True, "status": "something_new"}),
            (200, "not a dict"),
            (200, None),
        ]
        for status, body in cases:
            with self.subTest(status=status, body=body):
                outcome, _ = await self._call(body, status)
                self.assertFalse(outcome.ok)
                self.assertNotEqual(
                    outcome.status, phone.HEARTBEAT_LEASE_LOST_STATUS
                )
                self.assertIsNotNone(outcome.error_category)

    async def test_a_short_secret_fails_closed_before_any_transport(self):
        transport = _RecordingTransport(200, {"ok": True, "status": "ok"})
        with patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": "too-short"}):
            outcome = await self._client(transport).heartbeat_attempt(
                _ATTEMPT_ID, _SESSION_ID, epoch=_EPOCH
            )
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.error_category, "configuration")
        self.assertEqual(transport.requests, [])

    async def test_there_is_no_lease_token_anywhere_and_never_will_be(self):
        """The response carries no lease token, so nothing here can hold one."""
        slots = set(phone.PhoneApiOutcome.__slots__)
        self.assertNotIn("lease_token", slots)
        self.assertFalse([s for s in slots if "token" in s])

        token = "tok_should_never_be_retained"
        outcome, _ = await self._call(
            {"ok": True, "status": "ok", "next_heartbeat_seconds": 9,
             "lease_token": token}
        )
        self.assertTrue(outcome.ok)
        for slot in phone.PhoneApiOutcome.__slots__:
            self.assertNotEqual(getattr(outcome, slot, None), token)


# ── The loop ──────────────────────────────────────────────────────────

class TestHeartbeatLoop(unittest.IsolatedAsyncioTestCase):
    async def test_it_beats_immediately_and_carries_the_epoch_every_time(self):
        loop = _Loop([_ok(9), _ok(9)], max_sleeps=2)
        await loop.run()
        self.assertEqual(len(loop.client.calls), 2)
        for attempt_id, session_id, epoch in loop.client.calls:
            self.assertEqual((attempt_id, session_id, epoch),
                             (_ATTEMPT_ID, _SESSION_ID, _EPOCH))

    async def test_the_CADENCE_comes_from_the_server_beat_by_beat(self):
        loop = _Loop([_ok(7), _ok(11), _ok(3)], max_sleeps=3)
        await loop.run()
        self.assertEqual(loop.slept, [7.0, 11.0, 3.0])
        self.assertEqual(loop.halts, [])

    async def test_an_absurd_server_cadence_cannot_stretch_past_the_lease(self):
        # Built past the client's clamp on purpose: the loop is what spends the
        # time, so it clamps too rather than trusting the field.
        loop = _Loop([_ok(86400), _ok(0)], max_sleeps=2)
        await loop.run()
        self.assertEqual(
            loop.slept, [phone.HEARTBEAT_MAX_SEC, phone.HEARTBEAT_MIN_SEC]
        )

    async def test_LEASE_LOST_halts_immediately_and_stops_beating(self):
        loop = _Loop([_ok(9), _lease_lost(), _ok(9)], max_sleeps=8)
        reason = await loop.run()
        self.assertEqual(reason, phone.HALT_LEASE_LOST)
        self.assertEqual(loop.halts, [phone.HALT_LEASE_LOST])
        # It stopped: the third scripted answer was never asked for, and the
        # loop did not sleep again after halting.
        self.assertEqual(len(loop.client.calls), 2)
        self.assertEqual(loop.slept, [9.0])

    async def test_a_lost_lease_is_a_RETRYABLE_halt_so_the_leg_posts_nothing(self):
        for reason in (phone.HALT_LEASE_LOST, phone.HALT_LEASE_UNCONFIRMED):
            with self.subTest(reason=reason):
                self.assertTrue(phone.halt_is_retryable(reason))
                self.assertIn(reason, phone.RETRYABLE_HALTS)

    async def test_a_single_BLIP_does_not_halt_and_the_beat_continues(self):
        """A flaky network is not a lost lease."""
        loop = _Loop([_ok(9), _blip(), _ok(9), _ok(9)], max_sleeps=4)
        await loop.run()
        self.assertEqual(loop.halts, [])
        self.assertEqual(len(loop.client.calls), 4)
        # The failed beat still waits a cadence — the last one the server gave.
        self.assertEqual(loop.slept, [9.0, 9.0, 9.0, 9.0])

    async def test_SUSTAINED_failure_halts_because_the_lease_may_have_lapsed(self):
        loop = _Loop([_blip(), _blip(), _ok(9)], max_sleeps=8)
        reason = await loop.run()
        self.assertEqual(reason, phone.HALT_LEASE_UNCONFIRMED)
        self.assertEqual(loop.halts, [phone.HALT_LEASE_UNCONFIRMED])
        self.assertEqual(len(loop.client.calls), 2)

    async def test_the_failure_count_is_CONSECUTIVE_and_a_success_resets_it(self):
        """Otherwise a call long enough to see two unrelated blips would halt."""
        loop = _Loop([_blip(), _ok(9), _blip(), _ok(9), _blip()], max_sleeps=5)
        await loop.run()
        self.assertEqual(loop.halts, [])
        self.assertEqual(len(loop.client.calls), 5)

    async def test_the_bound_is_derived_from_the_cadence_not_hardcoded_by_luck(self):
        # The clamp guarantees cadence <= lease/2, so the smallest lease
        # consistent with a cadence is 2x it: after 2 consecutive failures the
        # whole guaranteed margin since the last renewal is gone.
        self.assertEqual(phone.HEARTBEAT_MAX_CONSECUTIVE_FAILURES, 2)
        loop = _Loop([_blip()] * 5, max_sleeps=8,
                     max_consecutive_failures=phone.HEARTBEAT_MAX_CONSECUTIVE_FAILURES)
        await loop.run()
        self.assertEqual(
            len(loop.client.calls), phone.HEARTBEAT_MAX_CONSECUTIVE_FAILURES
        )

    async def test_a_RAISING_client_counts_as_a_failure_rather_than_killing_the_task(self):
        """A dead heartbeat task is the original defect wearing a hat.

        If an exception escaped, nothing would beat and nothing would halt —
        the lease would lapse under a live call exactly as before, only now
        with a silent traceback instead of no code at all.
        """
        loop = _Loop([RuntimeError("boom"), _ok(9), RuntimeError("boom")],
                     max_sleeps=3)
        await loop.run()
        self.assertEqual(loop.halts, [])
        self.assertEqual(len(loop.client.calls), 3)

    async def test_two_consecutive_RAISES_halt_like_any_other_unproved_lease(self):
        loop = _Loop([RuntimeError("boom"), RuntimeError("boom")], max_sleeps=8)
        self.assertEqual(await loop.run(), phone.HALT_LEASE_UNCONFIRMED)

    async def test_the_first_beat_needs_no_cadence_from_anybody(self):
        loop = _Loop([_ok(9)], max_sleeps=1)
        await loop.run()
        # Beat first, then sleep: the immediate beat is the only chance to
        # learn the server's cadence before spending one, and a call answered
        # on the last ring has very little originate lease left.
        self.assertEqual(len(loop.client.calls), 1)

    async def test_it_is_cancellable_and_halts_nothing_when_cancelled(self):
        halts: list[str] = []

        async def halt(reason):
            halts.append(reason)

        client = ScriptedHeartbeatClient([_ok(9)] * 50)
        started = asyncio.Event()

        async def sleep(seconds):
            started.set()
            await asyncio.sleep(3600)

        task = asyncio.create_task(phone.run_phone_heartbeat(
            attempt_id=_ATTEMPT_ID, session_id=_SESSION_ID, epoch=_EPOCH,
            client=client, halt=halt, sleep=sleep,
        ))
        await asyncio.wait_for(started.wait(), timeout=1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(halts, [])
        self.assertEqual(len(client.calls), 1)

    async def test_a_cancellation_is_never_swallowed_as_a_failed_beat(self):
        """Shutdown must not be laundered into `lease_unconfirmed`."""
        halts: list[str] = []

        async def halt(reason):
            halts.append(reason)

        class CancellingClient:
            calls = 0

            async def heartbeat_attempt(self, attempt_id, session_id, *, epoch):
                CancellingClient.calls += 1
                raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await phone.run_phone_heartbeat(
                attempt_id=_ATTEMPT_ID, session_id=_SESSION_ID, epoch=_EPOCH,
                client=CancellingClient(), halt=halt,
                sleep=lambda s: asyncio.sleep(0),
            )
        self.assertEqual(halts, [])


# ── Nothing identifying is ever logged ────────────────────────────────

class TestHeartbeatLogsNoIdentifier(unittest.IsolatedAsyncioTestCase):
    """The attempt id, the session id, the epoch and the response body all stay
    out of the logs — on the renewal path, the failure path and the halt path.

    The assertion is made at the CALL SITE, before the logger's own redaction:
    a grep of sanitised output would pass even if the call site leaked.
    """

    async def _capture(self, answers, **kwargs):
        records: list[tuple] = []

        def _emit(level, event, meta=None):
            records.append((level, event, dict(meta or {})))

        loop = _Loop(answers, **kwargs)
        with patch.object(phone._log, "_emit", _emit):
            await loop.run()
        return records, loop

    def _assert_clean(self, records):
        # ── THE CONTROL ───────────────────────────────────────────────
        # "No identifier was logged" is worthless if nothing was logged at all.
        # This asserts the sink actually received records first, so the check
        # below is a real check rather than a vacuous one.
        self.assertTrue(records, "log sink received nothing — the check is vacuous")
        self.assertTrue(
            [r for r in records if r[2].get("error_type")],
            "records carried no error_type — the sink is not the real one",
        )
        forbidden = (_ATTEMPT_ID, _SESSION_ID, str(_EPOCH))
        for level, event, meta in records:
            rendered = " ".join([str(level), str(event)]
                                + [f"{k}={v}" for k, v in meta.items()])
            for needle in forbidden:
                self.assertNotIn(needle, rendered)
            # And no digit run at all: a phone number would be one too.
            self.assertIsNone(phone._DIGIT_RUN_RE.search(rendered), rendered)

    async def test_the_RENEWAL_path_logs_no_identifier(self):
        records, _ = await self._capture([_ok(9), _ok(9)], max_sleeps=2)
        self._assert_clean(records)
        self.assertIn(
            "phone_lease_renewed",
            [r[2].get("error_type") for r in records],
        )

    async def test_the_LEASE_LOST_path_logs_no_identifier(self):
        records, _ = await self._capture([_lease_lost()], max_sleeps=8)
        self._assert_clean(records)
        self.assertIn(
            "phone_heartbeat_halted", [r[2].get("error_type") for r in records]
        )

    async def test_the_FAILURE_path_logs_no_identifier(self):
        records, _ = await self._capture([_blip(), _blip()], max_sleeps=8)
        self._assert_clean(records)
        types_seen = [r[2].get("error_type") for r in records]
        self.assertIn("phone_heartbeat_failed", types_seen)
        self.assertIn("phone_heartbeat_halted", types_seen)

    async def test_the_CLIENT_never_logs_the_body_or_the_triple(self):
        records: list[tuple] = []

        def _emit(level, event, meta=None):
            records.append((level, event, dict(meta or {})))

        transport = _RecordingTransport(
            200,
            {"ok": True, "status": "lease_lost", "secret_ish": _SESSION_ID},
        )
        client = phone.PhoneEventClient(
            transport_factory=lambda: transport, api_base="http://api.test"
        )
        with patch.object(phone._log, "_emit", _emit), \
             patch.dict(phone.os.environ, {"WORKER_CONTEXT_SECRET": _GOOD_SECRET}):
            outcome = await client.heartbeat_attempt(
                _ATTEMPT_ID, _SESSION_ID, epoch=_EPOCH
            )
        self.assertFalse(outcome.ok)
        self._assert_clean(records)


if __name__ == "__main__":
    unittest.main()
