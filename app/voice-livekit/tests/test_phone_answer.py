"""M009 E6: the phone gate waits for a REAL answer, not participant presence.

LiveKit adds the SIP participant when it starts DIALING, so presence is not an
answer. These tests pin the three layers of the fix:

* the pure helpers in ``phone.py`` — ``sip_call_status`` (one key, never the
  attribute map), ``unanswered_verdict`` (raw enum ints, never ``Name(None)``),
  ``phone_answer_signal`` (the kill switch);
* ``agent._wait_for_sip_answer`` against a fake room — both answer signals,
  every departure mapping, the deadline, the hangup grace, single-assignment
  and listener cleanup;
* ``phone.run_phone_gate`` with the ``wait_for_answer`` seam, and the real
  ``_run_phone_session`` teardown precedence merged with PR-A's E3 listener.

No candidate data appears anywhere: identities are the attempt-keyed SIP
identity the dialer mints, reasons are LiveKit enum values, and the one
number-shaped attribute is a synthetic placeholder used only to prove it never
reaches a log line.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import time
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from tests import test_phone_gate as fixtures
from tests import test_phone_sip_left as e3


agent = fixtures.agent_mod
phone = fixtures.phone

_SIP_IDENTITY = e3._SIP_IDENTITY
_KIND_SIP = e3._KIND_SIP
_KIND_STANDARD = e3._KIND_STANDARD
_BY_NAME = e3._BY_NAME
_REASONS = e3._REASONS
_FAKE_RTC = e3._FAKE_RTC
#: Synthetic, number-SHAPED placeholder for the privacy assertions only.
_NUMBER_LIKE = "+910000000000"

_ENV_SAVED: dict[str, str | None] = {}


def setUpModule() -> None:
    # Same pin as test_phone_gate: the scripted gate keeps the real
    # `run_phone_gate` cases deterministic.
    for key, value in (
        ("PHONE_GATE_FLOW", "deterministic"),
        ("PHONE_DETERMINISTIC_OPENER", "true"),
    ):
        _ENV_SAVED[key] = os.environ.get(key)
        os.environ[key] = value
    for key in ("PHONE_ANSWER_SIGNAL", "PHONE_BOUNCE_MODE"):
        _ENV_SAVED[key] = os.environ.get(key)
        os.environ.pop(key, None)


def tearDownModule() -> None:
    for key, value in _ENV_SAVED.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    _ENV_SAVED.clear()


def _sip(status=None, *, identity=_SIP_IDENTITY, kind=_KIND_SIP, reason=None,
         extra=None):
    attributes = {}
    if status is not None:
        attributes["sip.callStatus"] = status
    attributes.update(extra or {})
    return types.SimpleNamespace(
        identity=identity, kind=kind, disconnect_reason=reason,
        attributes=attributes,
    )


class _Room(e3._Room):
    """E3's room, plus attribute changes in the rtc emit shape."""

    def set_status(self, participant, status):
        participant.attributes["sip.callStatus"] = status
        self.emit(
            "participant_attributes_changed",
            {"sip.callStatus": status}, participant,
        )

    def depart(self, participant, reason):
        participant.disconnect_reason = reason
        self.remote_participants.pop(participant.identity, None)
        self.emit("participant_disconnected", participant)


def _ctx(room):
    return types.SimpleNamespace(room=room)


def _logged(log: MagicMock) -> str:
    return json.dumps(
        [list(c.args) + [c.kwargs] for c in log.info.call_args_list
         + log.warn.call_args_list],
        default=str,
    )


# ── Pure helpers ────────────────────────────────────────────────────────

class TestSipCallStatus(unittest.TestCase):
    def test_reads_only_the_status_key(self):
        accessed: list = []

        class _Attrs(dict):
            def get(self, key, default=None):
                accessed.append(key)
                return super().get(key, default)

            def __iter__(self):  # pragma: no cover - must never be called
                raise AssertionError("the attribute map must never be enumerated")

            def items(self):  # pragma: no cover - must never be called
                raise AssertionError("the attribute map must never be enumerated")

        p = types.SimpleNamespace(attributes=_Attrs({
            "sip.phoneNumber": _NUMBER_LIKE, "sip.callStatus": "ringing",
        }))
        self.assertEqual(phone.sip_call_status(p), "ringing")
        self.assertEqual(accessed, ["sip.callStatus"])

    def test_absent_unknown_and_malformed_are_none(self):
        for attrs in (None, {}, {"sip.callStatus": "weird"},
                      {"sip.callStatus": 3}, "not-a-map"):
            with self.subTest(attrs=attrs):
                self.assertIsNone(
                    phone.sip_call_status(types.SimpleNamespace(attributes=attrs)))
        self.assertIsNone(phone.sip_call_status(object()))

    def test_case_and_space_are_normalised(self):
        p = types.SimpleNamespace(attributes={"sip.callStatus": " Active "})
        self.assertEqual(phone.sip_call_status(p), phone.SIP_CALL_STATUS_ACTIVE)

    def test_a_raising_map_never_leaks_its_contents(self):
        class _Boom:
            def get(self, _key):
                raise RuntimeError(_NUMBER_LIKE)

        self.assertIsNone(phone.sip_call_status(types.SimpleNamespace(attributes=_Boom())))


class TestUnansweredVerdict(unittest.TestCase):
    EXPECTED = {
        "UNKNOWN_REASON": "no_answer",
        "CLIENT_INITIATED": "no_answer",
        "USER_UNAVAILABLE": "no_answer",
        "USER_REJECTED": "busy",
        "SIP_TRUNK_FAILURE": "provider_error",
        "DUPLICATE_IDENTITY": "aborted",
        "SERVER_SHUTDOWN": "aborted",
        "PARTICIPANT_REMOVED": "aborted",
        "ROOM_DELETED": "aborted",
        "STATE_MISMATCH": "aborted",
        "JOIN_FAILURE": "aborted",
        "MIGRATION": "aborted",
        "SIGNAL_CLOSE": "aborted",
        "ROOM_CLOSED": "aborted",
        "CONNECTION_TIMEOUT": "aborted",
        "MEDIA_FAILURE": "aborted",
        "AGENT_ERROR": "aborted",
    }
    # Pinned rtc 1.1.12 values for the reasons E3's table does not list.
    EXTRA_INTS = {"CONNECTION_TIMEOUT": 14, "MEDIA_FAILURE": 15, "AGENT_ERROR": 16}

    def test_every_disconnect_reason_int_is_mapped(self):
        by_name = dict(_BY_NAME)
        by_name.update(self.EXTRA_INTS)
        self.assertEqual(set(by_name) | {"UNKNOWN_REASON"}, set(self.EXPECTED))
        for name, value in by_name.items():
            with self.subTest(reason=name):
                self.assertEqual(phone.unanswered_verdict(value), self.EXPECTED[name])

    def test_none_deadline_and_unmapped_never_raise(self):
        self.assertEqual(phone.unanswered_verdict(None), "no_answer")
        self.assertEqual(phone.unanswered_verdict(phone.ANSWER_DEADLINE), "no_answer")
        for value in (999, -1, "USER_REJECTED", 1.5, True, object()):
            with self.subTest(value=value):
                self.assertEqual(phone.unanswered_verdict(value), "aborted")

    def test_event_mapping(self):
        self.assertEqual(phone.unanswered_event("no_answer"), "call.no_answer")
        self.assertEqual(phone.unanswered_event("busy"), "call.busy")
        self.assertEqual(phone.unanswered_event("provider_error"), "call.failed")
        self.assertIsNone(phone.unanswered_event("aborted"))
        self.assertIsNone(phone.unanswered_event("answered"))
        for event in ("call.no_answer", "call.busy", "call.failed"):
            self.assertIn(event, phone.PHONE_WORKER_EVENTS)
        # The provider-only edges stay off the worker allowlist.
        for event in ("sip.originate_timeout", "sip.originate_rejected_busy"):
            self.assertNotIn(event, phone.PHONE_WORKER_EVENTS)


class TestAnswerSignalSwitch(unittest.TestCase):
    def test_default_and_kill_switch(self):
        cases = {None: "sip_status", "": "sip_status", "sip_status": "sip_status",
                 "presence": "presence", " PRESENCE ": "presence",
                 "bogus": "sip_status"}
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                env = {} if raw is None else {"PHONE_ANSWER_SIGNAL": raw}
                with patch.dict(os.environ, env, clear=False):
                    if raw is None:
                        os.environ.pop("PHONE_ANSWER_SIGNAL", None)
                    self.assertEqual(phone.phone_answer_signal(), expected)

    def test_gate_not_answered_is_not_an_assessment(self):
        result = phone.PhoneGateResult(phone.GATE_NOT_ANSWERED)
        self.assertFalse(result.assessment_allowed)
        self.assertFalse(result.recording_allowed)
        self.assertEqual(agent._teardown_label(phone.GATE_NOT_ANSWERED), "not_answered")


class TestLeaseBudget(unittest.TestCase):
    """The API admission lease must cover boot + agent join + the ring."""

    ADMISSION_LEASE_SEC = 240
    BOOT_SEC = 32
    AGENT_JOIN_SEC = 20

    def _fly_env(self, key):
        toml = (pathlib.Path(__file__).resolve().parents[1] / "fly.phone.toml").read_text(
            encoding="utf-8")
        match = re.search(rf'^\s*{key}\s*=\s*"([^"]*)"', toml, re.MULTILINE)
        return match.group(1) if match else None

    def test_fly_config_rings_60s_and_uses_sip_status(self):
        self.assertEqual(self._fly_env("PHONE_PARTICIPANT_WAIT_SEC"), "60")
        self.assertEqual(self._fly_env("PHONE_ANSWER_SIGNAL"), "sip_status")

    def test_lease_covers_boot_join_and_ring_with_margin(self):
        with patch.dict(os.environ, {"PHONE_PARTICIPANT_WAIT_SEC": "60"}):
            ring = phone.phone_participant_wait_sec()
            self.assertEqual(ring, 60.0)
            needed = self.BOOT_SEC + self.AGENT_JOIN_SEC + ring
            self.assertLessEqual(needed * 2, self.ADMISSION_LEASE_SEC)
            # The answer wait SHARES the ring budget; the gate wall clock does
            # not grow by a second wait.
            with patch.object(phone, "phone_bounce_mode", lambda: False):
                self.assertEqual(
                    agent._phone_gate_wall_clock_seconds(),
                    ring + agent.PHONE_GATE_MAX_SECONDS,
                )

    def test_an_unrenewed_gate_budget_stays_inside_the_admission_lease(self):
        """M013 S01 T03. With no gate heartbeat (no session id / epoch), the
        gate budget is capped to what this arithmetic says is left of the
        admission lease, for the worst-case ring, so the gate ends itself
        before the server could reap it."""
        self.assertEqual(phone.PHONE_ADMISSION_LEASE_SEC, self.ADMISSION_LEASE_SEC)
        self.assertEqual(phone.PHONE_PRE_RING_LEASE_SPEND_SEC,
                         self.BOOT_SEC + self.AGENT_JOIN_SEC)
        with patch.dict(os.environ, {"PHONE_PARTICIPANT_WAIT_SEC": "60"}):
            ring = phone.phone_participant_wait_sec()
        left = self.ADMISSION_LEASE_SEC - self.BOOT_SEC - self.AGENT_JOIN_SEC - ring
        self.assertEqual(phone.phone_unrenewed_lease_after_answer_sec(ring), left)
        budget = phone.GateBudget(agent.PHONE_GATE_MAX_SECONDS, clock=lambda: 0.0)
        budget.start()
        budget.cap_total(phone.phone_unrenewed_lease_after_answer_sec(ring),
                         reason="unrenewed_lease")
        self.assertLessEqual(budget.remaining() + phone.GATE_BUDGET_MARGIN_SEC, left)
        # And it still leaves room for the identity turn plus a consent round.
        self.assertGreater(
            budget.remaining(),
            budget.round_cost_sec() + budget.round_cost_sec(
                phone.GATE_DISCLOSURE_LINE_ESTIMATE_SEC))


# ── _wait_for_sip_answer ────────────────────────────────────────────────

class TestWaitForSipAnswer(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.log = MagicMock()
        self._patches = [
            patch.object(agent, "_livekit_rtc", lambda: _FAKE_RTC),
            patch.object(agent, "_log", self.log),
        ]
        for p in self._patches:
            p.start()

    async def asyncTearDown(self):
        for p in reversed(self._patches):
            p.stop()

    def _setup(self, status="dialing", **kw):
        participant = _sip(status, **kw)
        room = _Room([participant])
        holder: dict = {}
        timings: list = []
        return participant, room, holder, timings

    def _start(self, room, participant, holder, timings, *, budget=2.0, sub=None):
        return asyncio.create_task(agent._wait_for_sip_answer(
            _ctx(room), participant, agent._monotonic() + budget, sub, holder, timings,
        ))

    async def _registered(self, room):
        for _ in range(50):
            if room.handlers.get("participant_disconnected"):
                return
            await asyncio.sleep(0)
        raise AssertionError("listeners never registered")

    def _assert_clean(self, room):
        for event in ("participant_attributes_changed", "participant_disconnected",
                      "track_published"):
            self.assertEqual(room.handlers.get(event, []), [], event)

    async def test_status_transitions_answer_at_active(self):
        p, room, holder, timings = self._setup("dialing")
        task = self._start(room, p, holder, timings)
        await self._registered(room)
        room.set_status(p, "ringing")
        await asyncio.sleep(0.01)
        self.assertFalse(task.done())
        room.set_status(p, "active")
        self.assertEqual(await task, "answered")
        labels = [label for label, _ms in timings]
        self.assertEqual(labels, ["status_ringing", "status_active"])
        self._assert_clean(room)
        self.assertEqual(holder, {})

    async def test_departure_reasons_map_and_reason_is_written_synchronously(self):
        cases = {
            "USER_UNAVAILABLE": "no_answer",
            "USER_REJECTED": "busy",
            "SIP_TRUNK_FAILURE": "provider_error",
            "ROOM_DELETED": "aborted",
            "CLIENT_INITIATED": "no_answer",
        }
        for name, verdict in cases.items():
            with self.subTest(reason=name):
                p, room, holder, timings = self._setup("ringing")
                task = self._start(room, p, holder, timings)
                await self._registered(room)
                room.depart(p, _BY_NAME[name])
                # Written INSIDE the emit — before any await yields.
                self.assertEqual(holder.get("reason"), _BY_NAME[name])
                self.assertEqual(await task, verdict)
                self._assert_clean(room)

    async def test_none_reason_is_no_answer_without_calling_name(self):
        p, room, holder, timings = self._setup("ringing")
        task = self._start(room, p, holder, timings)
        await self._registered(room)
        room.depart(p, None)
        self.assertIn("reason", holder)
        self.assertIsNone(holder["reason"])
        self.assertEqual(await task, "no_answer")
        wait_logs = [c.kwargs for c in self.log.info.call_args_list
                     if c.kwargs.get("error_type") == "phone_answer_wait"]
        self.assertEqual(wait_logs[0]["schema"], "UNKNOWN")

    async def test_deadline_is_no_answer(self):
        p, room, holder, timings = self._setup("ringing")
        verdict = await self._start(room, p, holder, timings, budget=0.05)
        self.assertEqual(verdict, "no_answer")
        self.assertIn("deadline", [label for label, _ in timings])
        self._assert_clean(room)

    async def test_spent_budget_at_entry_is_no_answer(self):
        p, room, holder, timings = self._setup("ringing")
        self.assertEqual(
            await self._start(room, p, holder, timings, budget=-1.0), "no_answer")

    async def test_subscription_answers_when_status_absent_without_warning(self):
        p, room, holder, timings = self._setup(None)
        sub = asyncio.get_running_loop().create_future()
        task = self._start(room, p, holder, timings, sub=sub)
        await self._registered(room)
        sub.set_result(None)
        self.assertEqual(await task, "answered")
        self.assertFalse(any(
            c.kwargs.get("error_category") == "answer_signal_disagree"
            for c in self.log.warn.call_args_list))

    async def test_subscription_while_ringing_answers_and_warns_disagree(self):
        p, room, holder, timings = self._setup("ringing")
        sub = asyncio.get_running_loop().create_future()
        task = self._start(room, p, holder, timings, sub=sub)
        await self._registered(room)
        sub.set_result(None)
        self.assertEqual(await task, "answered")
        disagree = [c.kwargs for c in self.log.warn.call_args_list
                    if c.kwargs.get("error_category") == "answer_signal_disagree"]
        self.assertEqual(len(disagree), 1)
        self.assertEqual(disagree[0]["phase"], "status_ringing")
        self.assertIsInstance(disagree[0]["duration_sec"], float)

    async def test_already_subscribed_at_entry_answers(self):
        p, room, holder, timings = self._setup("ringing")
        sub = asyncio.get_running_loop().create_future()
        sub.set_result(None)
        self.assertEqual(
            await self._start(room, p, holder, timings, sub=sub), "answered")

    async def test_failed_subscription_is_not_an_answer(self):
        p, room, holder, timings = self._setup("ringing")
        sub = asyncio.get_running_loop().create_future()
        sub.cancel()
        self.assertEqual(
            await self._start(room, p, holder, timings, sub=sub, budget=0.05),
            "no_answer")

    async def test_non_sip_kind_or_no_rtc_answers_immediately(self):
        p, room, holder, timings = self._setup("ringing", kind=_KIND_STANDARD)
        self.assertEqual(
            await self._start(room, p, holder, timings, budget=0.0), "answered")
        self.assertEqual(room.handlers, {})
        p2, room2, holder2, timings2 = self._setup("ringing")
        with patch.object(agent, "_livekit_rtc", lambda: None):
            self.assertEqual(
                await self._start(room2, p2, holder2, timings2, budget=0.0), "answered")

    async def test_already_active_at_entry_answers_without_listening(self):
        p, room, holder, timings = self._setup("active")
        self.assertEqual(await self._start(room, p, holder, timings), "answered")
        self.assertEqual(room.handlers, {})

    async def test_hangup_then_reason_within_grace_is_mapped(self):
        p, room, holder, timings = self._setup("ringing")
        task = self._start(room, p, holder, timings)
        await self._registered(room)
        room.set_status(p, "hangup")
        await asyncio.sleep(0.01)
        self.assertFalse(task.done())
        room.depart(p, _BY_NAME["USER_REJECTED"])
        self.assertEqual(await task, "busy")

    async def test_hangup_without_reason_is_no_answer_after_grace(self):
        p, room, holder, timings = self._setup("ringing")
        with patch.object(agent, "_SIP_ANSWER_HANGUP_GRACE_SEC", 0.02):
            task = self._start(room, p, holder, timings, budget=5.0)
            await self._registered(room)
            room.set_status(p, "hangup")
            self.assertEqual(await asyncio.wait_for(task, 1.0), "no_answer")
        self.assertNotIn("reason", holder)
        # The observed non-answer is still recorded for the teardown terminal.
        self.assertEqual(holder.get("verdict"), "no_answer")

    async def test_late_duplicate_events_are_harmless(self):
        p, room, holder, timings = self._setup("ringing")
        task = self._start(room, p, holder, timings)
        await self._registered(room)
        handlers = {
            event: list(room.handlers[event])
            for event in ("participant_attributes_changed", "participant_disconnected")
        }
        room.set_status(p, "active")
        # Same tick, before the waiter resumes: a second verdict must be a
        # no-op, never InvalidStateError.
        room.depart(p, _BY_NAME["USER_REJECTED"])
        room.set_status(p, "active")
        self.assertEqual(await task, "answered")
        # And after resolution, a stale handler reference still never raises.
        for callback in handlers["participant_attributes_changed"]:
            callback({"sip.callStatus": "active"}, p)
        for callback in handlers["participant_disconnected"]:
            callback(p)

    async def test_other_identity_is_ignored(self):
        p, room, holder, timings = self._setup("ringing")
        other = _sip("ringing", identity="phone-00000000-0000-4000-8000-000000000000")
        room.remote_participants[other.identity] = other
        task = self._start(room, p, holder, timings, budget=0.1)
        await self._registered(room)
        room.depart(other, _BY_NAME["USER_REJECTED"])
        room.set_status(other, "active")
        self.assertEqual(await task, "no_answer")
        self.assertNotIn("reason", holder)

    async def test_departed_before_listening_is_mapped(self):
        p, room, holder, timings = self._setup("ringing", reason=_BY_NAME["USER_REJECTED"])
        room.remote_participants.clear()
        self.assertEqual(await self._start(room, p, holder, timings), "busy")
        self.assertEqual(holder["reason"], _BY_NAME["USER_REJECTED"])

    async def test_cancellation_removes_listeners(self):
        class _Sub:
            def __init__(self):
                self.callbacks: list = []

            def add_done_callback(self, cb):
                self.callbacks.append(cb)

            def remove_done_callback(self, cb):
                self.callbacks.remove(cb)
                return 1

        p, room, holder, timings = self._setup("ringing")
        sub = _Sub()
        task = self._start(room, p, holder, timings, sub=sub)
        await self._registered(room)
        self.assertEqual(len(sub.callbacks), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self._assert_clean(room)
        self.assertEqual(sub.callbacks, [])
        # Our own cancellation is not evidence of a non-answer.
        self.assertEqual(holder, {})

    async def test_privacy_no_number_in_any_log(self):
        p, room, holder, timings = self._setup(
            "ringing", extra={"sip.phoneNumber": _NUMBER_LIKE})
        sub = asyncio.get_running_loop().create_future()
        task = self._start(room, p, holder, timings, sub=sub)
        await self._registered(room)
        room.emit("track_published", types.SimpleNamespace(sid="TR_x"), p)
        sub.set_result(None)
        await task
        text = _logged(self.log)
        self.assertNotIn(_NUMBER_LIKE, text)
        self.assertNotIn(_SIP_IDENTITY, text)
        self.assertNotIn("phoneNumber", text)


# ── run_phone_gate with the seam ────────────────────────────────────────

class _SlowAnsweredClient(fixtures.FakeEventClient):
    def __init__(self, *a, answered_delay=0.0, phases=None, **kw):
        super().__init__(*a, **kw)
        self.answered_delay = answered_delay
        self.phases = phases
        self.phase_at_post: list = []

    async def post_event(self, attempt_id, event_type, **kwargs):
        if self.phases is not None:
            self.phase_at_post.append((event_type, dict(self.phases)))
        if event_type == "call.answered" and self.answered_delay:
            self.timeline.append("call.answered:sent")
            await asyncio.sleep(self.answered_delay)
        return await super().post_event(attempt_id, event_type, **kwargs)


class TestGateAnswerSeam(unittest.IsolatedAsyncioTestCase):
    async def _gate(self, verdict, *, client=None, durable=None, bounce=False,
                    verdict_delay=0.0, order=None):
        order = order if order is not None else []
        phases: dict = {}
        client = client or fixtures.FakeEventClient()
        recorder = fixtures.Recorder()
        begin_calls: list = []
        rebase_calls: list = []
        durable_calls: list = []
        durable_cancelled: list = []

        async def wait_for_participant():
            order.append("participant")
            return fixtures._participant()

        async def wait_for_answer():
            order.append("answer_wait")
            if verdict_delay:
                await asyncio.sleep(verdict_delay)
            order.append(f"verdict:{verdict}")
            return verdict

        async def classify():
            return phone.CLASSIFY_HUMAN

        async def say(text):
            order.append("say")
            await recorder.say(text)

        async def begin():
            begin_calls.append(True)
            order.append("begin_recording")

        async def fetch_durable():
            durable_calls.append(True)
            order.append("durable_fetch")
            try:
                await asyncio.sleep(0.02)
            except asyncio.CancelledError:
                durable_cancelled.append(True)
                raise
            return durable

        async def fake_rebase(*_a, **_k):
            rebase_calls.append(True)

        with patch.object(phone, "rebase_lease_on_answer", fake_rebase):
            result = await phone.run_phone_gate(
                attempt_id=fixtures._ATTEMPT_ID,
                client=client,
                wait_for_participant=wait_for_participant,
                classify=classify,
                say=say,
                start_recording=recorder.start_recording,
                begin_recording_at_answer=begin,
                epoch=fixtures._EPOCH,
                session_id=fixtures._SESSION_ID,
                post_call_answered=True,
                fetch_durable_consent=fetch_durable,
                bounce_mode=bounce,
                answer_wait_sleep=AsyncMock(),
                answer_wait_sec=0.0,
                wait_for_answer=wait_for_answer,
                gate_phase_out=phases,
                classify_timeout_sec=1.0,
            )
            # Let fired-and-forgotten tasks run.
            for _ in range(10):
                await asyncio.sleep(0)
        return types.SimpleNamespace(
            result=result, client=client, recorder=recorder, phases=phases,
            begin=begin_calls, rebase=rebase_calls, durable=durable_calls,
            durable_cancelled=durable_cancelled, order=order,
        )

    async def test_not_answered_posts_only_the_mapped_event(self):
        for verdict, event in (("no_answer", "call.no_answer"), ("busy", "call.busy"),
                               ("provider_error", "call.failed")):
            with self.subTest(verdict=verdict):
                g = await self._gate(verdict, verdict_delay=0.005)
                self.assertEqual(g.result.outcome, phone.GATE_NOT_ANSWERED)
                self.assertFalse(g.result.assessment_allowed)
                self.assertEqual(g.client.event_types, [event])
                self.assertEqual(g.result.events, [event])
                self.assertEqual(g.recorder.spoken, [])
                self.assertEqual(g.begin, [])
                self.assertEqual(g.rebase, [])
                self.assertEqual(g.recorder.recording_calls, 0)
                self.assertEqual(g.durable, [True])
                self.assertEqual(g.durable_cancelled, [True])
                self.assertTrue(g.phases.get("not_answered"))
                self.assertTrue(g.phases.get("terminal_posted"))
                self.assertNotIn("answer_observed", g.phases)
                # Epoch fencing travels with the verdict.
                self.assertEqual(g.client.calls[0][2]["epoch"], fixtures._EPOCH)

    async def test_aborted_posts_nothing(self):
        g = await self._gate("aborted")
        self.assertEqual(g.result.outcome, phone.GATE_NOT_ANSWERED)
        self.assertEqual(g.client.event_types, [])
        self.assertNotIn("terminal_posted", g.phases)
        self.assertTrue(g.phases.get("not_answered"))
        self.assertEqual(g.recorder.spoken, [])

    async def test_refused_verdict_is_not_marked_posted(self):
        client = fixtures.FakeEventClient({
            "call.no_answer": phone.PhoneApiOutcome(True, "ignored"),
        })
        g = await self._gate("no_answer", client=client)
        self.assertEqual(g.result.outcome, phone.GATE_NOT_ANSWERED)
        self.assertEqual(g.result.events, [])
        self.assertNotIn("terminal_posted", g.phases)

    async def test_answered_keeps_server_order_and_marks_answer_first(self):
        client = _SlowAnsweredClient()
        g = await self._gate("answered", client=client)
        self.assertEqual(g.result.outcome, phone.CLASSIFY_HUMAN)
        self.assertEqual(
            g.client.event_types,
            ["call.answered", "classify.human", "disclosure.delivered"],
        )
        self.assertTrue(g.phases.get("answer_observed"))
        self.assertTrue(g.phases.get("answered"))
        self.assertEqual(g.begin, [True])
        self.assertEqual(g.rebase, [True])

    async def test_answer_observed_is_set_before_any_post(self):
        phases: dict = {}
        client = _SlowAnsweredClient(phases=phases)
        await self._gate_with_phases(client, phases)
        first_event, phase_snapshot = client.phase_at_post[0]
        self.assertEqual(first_event, "call.answered")
        self.assertTrue(phase_snapshot.get("answer_observed"))

    async def _gate_with_phases(self, client, phases):
        async def wait_for_participant():
            return fixtures._participant()

        async def wait_for_answer():
            return "answered"

        async def classify():
            return phone.CLASSIFY_HUMAN

        with patch.object(phone, "rebase_lease_on_answer", AsyncMock()):
            return await phone.run_phone_gate(
                attempt_id=fixtures._ATTEMPT_ID, client=client,
                wait_for_participant=wait_for_participant, classify=classify,
                say=fixtures.Recorder().say, post_call_answered=True,
                wait_for_answer=wait_for_answer, gate_phase_out=phases,
                classify_timeout_sec=1.0,
            )

    async def test_first_say_happens_before_call_answered_completes(self):
        events_at_say: list = []
        client = _SlowAnsweredClient(answered_delay=0.2)

        async def wait_for_participant():
            return fixtures._participant()

        async def wait_for_answer():
            return "answered"

        async def say(_text):
            events_at_say.append(list(client.event_types))

        async def classify():
            return phone.CLASSIFY_HUMAN

        started = time.monotonic()
        with patch.object(phone, "rebase_lease_on_answer", AsyncMock()):
            await phone.run_phone_gate(
                attempt_id=fixtures._ATTEMPT_ID, client=client,
                wait_for_participant=wait_for_participant, classify=classify,
                say=say, post_call_answered=True, wait_for_answer=wait_for_answer,
                classify_timeout_sec=1.0,
            )
        # The disclosure was spoken while call.answered had NOT yet been
        # recorded by the (slow) server.
        self.assertEqual(events_at_say[0], [])
        self.assertGreaterEqual(time.monotonic() - started, 0.2)
        self.assertEqual(
            client.event_types,
            ["call.answered", "classify.human", "disclosure.delivered"],
        )

    async def test_recording_begins_only_when_call_answered_applied(self):
        client = fixtures.FakeEventClient({
            "call.answered": phone.PhoneApiOutcome(True, "ignored"),
        })
        g = await self._gate("answered", client=client)
        self.assertEqual(g.begin, [])
        self.assertNotIn("answered", g.phases)
        self.assertTrue(g.phases.get("answer_observed"))

    async def test_rebase_fires_even_when_call_answered_fails(self):
        class _Raising(fixtures.FakeEventClient):
            async def post_event(self, attempt_id, event_type, **kwargs):
                if event_type == "call.answered":
                    raise RuntimeError("transport")
                return await super().post_event(attempt_id, event_type, **kwargs)

        g = await self._gate("answered", client=_Raising())
        self.assertEqual(g.rebase, [True])
        self.assertEqual(g.begin, [])
        self.assertTrue(g.phases.get("answer_observed"))

    async def test_durable_fetch_starts_during_the_ring(self):
        order: list = []
        await self._gate("answered", verdict_delay=0.01, order=order)
        self.assertLess(order.index("durable_fetch"), order.index("verdict:answered"))
        self.assertEqual(order.count("durable_fetch"), 1)

    async def test_durable_consent_still_short_circuits(self):
        durable = fixtures._default_state()
        durable.gate_recorded = True
        g = await self._gate("answered", durable=durable)
        self.assertEqual(g.result.outcome, phone.CLASSIFY_HUMAN)
        self.assertTrue(g.result.assessment_allowed)
        self.assertEqual(g.recorder.spoken, [])
        self.assertEqual(g.durable, [True])

    async def _gate_awaiting_durable(self, fetch_durable):
        recorder = fixtures.Recorder()

        async def wait_for_participant():
            return fixtures._participant()

        async def wait_for_answer():
            return "answered"

        async def classify():
            return phone.CLASSIFY_HUMAN

        task = asyncio.ensure_future(phone.run_phone_gate(
            attempt_id=fixtures._ATTEMPT_ID, client=fixtures.FakeEventClient(),
            wait_for_participant=wait_for_participant, classify=classify,
            say=recorder.say, post_call_answered=True,
            fetch_durable_consent=fetch_durable, wait_for_answer=wait_for_answer,
            classify_timeout_sec=1.0,
        ))
        return task, recorder

    async def test_gate_cancel_while_awaiting_ring_started_durable_read_propagates(self):
        """Cancelling the gate while it awaits the ring-started read forwards
        the cancel INTO the read; the gate must still die, never fall through
        to speak the disclosure as a zombie."""
        reached = asyncio.Event()

        async def fetch_durable():
            reached.set()
            await asyncio.Event().wait()

        with patch.object(phone, "rebase_lease_on_answer", AsyncMock()):
            task, recorder = await self._gate_awaiting_durable(fetch_durable)
            await asyncio.wait_for(reached.wait(), 1.0)
            for _ in range(5):
                await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 1.0)
        self.assertEqual(recorder.spoken, [])

    async def test_durable_read_cancelled_on_its_own_still_fails_open_to_gating(self):
        async def fetch_durable():
            raise asyncio.CancelledError

        with patch.object(phone, "rebase_lease_on_answer", AsyncMock()):
            task, recorder = await self._gate_awaiting_durable(fetch_durable)
            result = await asyncio.wait_for(task, 2.0)
        self.assertNotEqual(result.outcome, phone.GATE_NOT_ANSWERED)
        self.assertTrue(recorder.spoken)

    async def test_a_raising_answer_wait_fails_open_to_answered(self):
        async def wait_for_participant():
            return fixtures._participant()

        async def wait_for_answer():
            raise RuntimeError("seam broke")

        async def classify():
            return phone.CLASSIFY_HUMAN

        client = fixtures.FakeEventClient()
        with patch.object(phone, "rebase_lease_on_answer", AsyncMock()):
            result = await phone.run_phone_gate(
                attempt_id=fixtures._ATTEMPT_ID, client=client,
                wait_for_participant=wait_for_participant, classify=classify,
                say=fixtures.Recorder().say, post_call_answered=True,
                wait_for_answer=wait_for_answer, classify_timeout_sec=1.0,
            )
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)
        self.assertNotIn("call.no_answer", client.event_types)

    async def test_bounce_mode_ignores_the_seam(self):
        called: list = []

        async def wait_for_participant():
            return fixtures._participant()

        async def wait_for_answer():  # pragma: no cover - must not run
            called.append(True)
            return "no_answer"

        async def classify():
            return phone.CLASSIFY_HUMAN

        client = fixtures.FakeEventClient()
        result = await phone.run_phone_gate(
            attempt_id=fixtures._ATTEMPT_ID, client=client,
            wait_for_participant=wait_for_participant, classify=classify,
            say=fixtures.Recorder().say, bounce_mode=True,
            answer_wait_sec=1.0, answer_wait_sleep=AsyncMock(),
            wait_for_answer=wait_for_answer, classify_timeout_sec=1.0,
        )
        self.assertEqual(called, [])
        self.assertEqual(result.outcome, phone.CLASSIFY_HUMAN)
        self.assertNotIn("call.no_answer", client.event_types)

    async def test_without_the_seam_call_answered_is_awaited_inline(self):
        """wait_for_answer=None: the pre-E6 path — no task is parked."""
        holder: dict = {}
        events_at_say: list = []
        client = _SlowAnsweredClient(answered_delay=0.05)

        async def wait_for_participant():
            return fixtures._participant()

        async def say(_text):
            events_at_say.append(list(client.event_types))

        async def classify():
            return phone.CLASSIFY_HUMAN

        with patch.object(phone, "rebase_lease_on_answer", AsyncMock()):
            await phone.run_phone_gate(
                attempt_id=fixtures._ATTEMPT_ID, client=client,
                wait_for_participant=wait_for_participant, classify=classify,
                say=say, post_call_answered=True, answer_post_out=holder,
                classify_timeout_sec=1.0,
            )
        self.assertEqual(events_at_say[0], ["call.answered"])
        self.assertEqual(holder, {})


class TestAwaitAnsweredPost(unittest.IsolatedAsyncioTestCase):
    async def test_empty_holder_returns_without_suspending(self):
        coro = phone.await_answered_post({})
        with self.assertRaises(StopIteration):
            coro.send(None)

    async def test_timeout_never_cancels_the_post(self):
        gate = asyncio.Event()

        async def post():
            await gate.wait()
            return "done"

        task = asyncio.ensure_future(post())
        with patch.object(phone, "_answered_post_wait_sec", lambda: 0.01):
            await phone.await_answered_post({phone.ANSWERED_POST_TASK_KEY: task})
        self.assertFalse(task.done())
        gate.set()
        self.assertEqual(await task, "done")

    async def test_failed_post_is_swallowed(self):
        async def post():
            raise RuntimeError("transport")

        task = asyncio.ensure_future(post())
        await phone.await_answered_post({phone.ANSWERED_POST_TASK_KEY: task})
        self.assertTrue(task.done())


# ── Agent level: _run_phone_session teardown precedence, merged with E3 ──

class _Harness(e3._Harness):
    def __init__(self, status="ringing"):
        super().__init__()
        self.participant = _sip(status)
        self.room = _Room([self.participant])
        self.ctx.room = self.room
        self.begin_kwargs: list = []
        self.fail_calls: list = []
        harness = self
        base = self.recorder_cls

        class Recorder(base):
            async def begin(self, *args, **kwargs):
                harness.begin_kwargs.append(kwargs)
                harness.client.timeline.append("recording.begin")
                return await super().begin(*args, **kwargs)

        self.recorder_cls = Recorder

    def teardown_labels(self):
        return [
            c.kwargs.get("error_category") for c in self.log.info.call_args_list
            if c.kwargs.get("error_type") == "phone_room_teardown"
        ]

    async def run_real(self, *, drive, wall_clock=5.0, env=None, wedge=False):
        """Drive the REAL run_phone_gate; `drive` runs once the answer wait
        is listening."""
        e3._Session.instances = []
        e3._Session.sdk_closes = []
        e3._Session.wedge_say = wedge

        async def prepare(*_args):
            return {"object_key": "phone/test.ogg", "upload_url": "https://put"}

        async def complete(*_args, **_kwargs):
            self.client.timeline.append("recording.completed")

        async def fail(*args, **_kwargs):
            self.fail_calls.append(args)
            return True

        with patch.dict(os.environ, env or {}), \
             patch.object(agent, "AgentSession", e3._Session), \
             patch.object(agent, "persistence", MagicMock()), \
             patch.object(agent, "_log", self.log), \
             patch.object(agent, "_livekit_rtc", lambda: _FAKE_RTC), \
             patch.object(
                 agent, "_delete_livekit_room", new_callable=AsyncMock,
                 side_effect=lambda _room: self.client.timeline.append("room.delete"),
             ), \
             patch.object(agent, "_phone_gate_wall_clock_seconds", lambda: wall_clock), \
             patch.object(agent.recording, "recording_provider", lambda: "worker"), \
             patch.object(agent.recording, "InWorkerRecorder", self.recorder_cls), \
             patch.object(agent.recording_api, "prepare_recording", prepare), \
             patch.object(agent.recording_api, "complete_recording", complete), \
             patch.object(agent.recording_api, "fail_recording", fail), \
             patch.object(agent, "SESSION_MAX_RESIDENCY_SEC", 1.0), \
             patch.object(phone, "rebase_lease_on_answer", AsyncMock()):
            task = asyncio.create_task(agent._run_phone_session(
                self.ctx, fixtures._PHONE_ROOM, fixtures._ATTEMPT_ID,
                fixtures._EPOCH, client=self.client,
            ))
            for _ in range(400):
                if self.room.handlers.get("participant_attributes_changed"):
                    break
                await asyncio.sleep(0.005)
            else:
                task.cancel()
                raise AssertionError("the answer wait never started listening")
            drive()
            result = await asyncio.wait_for(task, timeout=5.0)
            for _ in range(20):
                await asyncio.sleep(0.005)
        return result


class TestAgentUnanswered(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        e3._Session.wedge_say = True

    async def test_ring_out_posts_no_answer_records_nothing_and_closes_room(self):
        h = _Harness("ringing")
        result = await h.run_real(
            drive=lambda: h.room.depart(h.participant, _BY_NAME["USER_UNAVAILABLE"]))
        self.assertEqual(result.outcome, phone.GATE_NOT_ANSWERED)
        self.assertEqual(h.client.event_types, ["call.no_answer"])
        self.assertNotIn("recording.begin", h.client.timeline)
        self.assertNotIn("recording.uploaded", h.client.timeline)
        self.assertEqual(h.begin_kwargs, [])
        self.assertEqual(h.fail_calls, [])
        self.assertIn("room.delete", h.client.timeline)
        self.assertLess(h.client.timeline.index("event:call.no_answer"),
                        h.client.timeline.index("room.delete"))
        self.assertIn("not_answered", h.teardown_labels())
        # Nothing was spoken to a ringing line.
        self.assertTrue(all(not s.spoken for s in e3._Session.instances))
        # E3's listener stood down: no departure decision of its own.
        self.assertEqual(h.sip_left_logs(), [])
        self.assertEqual(e3._Session.sdk_closes, [])

    async def test_reject_posts_busy(self):
        h = _Harness("ringing")
        result = await h.run_real(
            drive=lambda: h.room.depart(h.participant, _BY_NAME["USER_REJECTED"]))
        self.assertEqual(result.outcome, phone.GATE_NOT_ANSWERED)
        self.assertEqual(h.client.event_types, ["call.busy"])
        self.assertNotIn("sip.participant_left", h.client.event_types)
        self.assertNotIn("candidate.deferred_pre_disclosure", h.client.event_types)

    async def test_answered_call_anchors_the_recorder_on_the_answer(self):
        h = _Harness("ringing")
        marks: dict = {}

        def drive():
            marks["answer_ms"] = int(round(time.time() * 1000))
            h.room.set_status(h.participant, "active")
            # The callee hangs up mid-disclosure (wedged playout): E3's
            # post-answer path owns it now.
            asyncio.get_running_loop().call_later(
                0.3, h.room.depart, h.participant, _BY_NAME["USER_UNAVAILABLE"])

        result = await h.run_real(drive=drive, wedge=True)
        self.assertEqual(result.outcome, phone.GATE_PARTICIPANT_LEFT)
        self.assertEqual(h.begin_kwargs[0]["answered_epoch_ms"] >= marks["answer_ms"], True)
        self.assertEqual(
            h.client.event_types, ["call.answered", "sip.participant_left"])
        self.assertNotIn("call.no_answer", h.client.event_types)
        self.assertEqual(e3._Session.sdk_closes, ["user_initiated"])


class TestAgentTeardownPrecedence(unittest.IsolatedAsyncioTestCase):
    """Fixture gates (as in E3's suite) drive the agent's own seams."""

    def setUp(self):
        e3._Session.wedge_say = True

    async def test_pre_answer_rejected_racing_to_participant_left_posts_busy(self):
        h = _Harness("ringing")

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            answer = asyncio.ensure_future(kwargs["wait_for_answer"]())
            h.gate_ready.set()
            await answer
            # RoomIO closed the session on USER_REJECTED before the gate could
            # return its own verdict: the next say finds no session.
            raise phone.PhoneParticipantGone("participant_gone")

        def drive():
            h.room.depart(h.participant, _BY_NAME["USER_REJECTED"])

        result = await h.run(gate, drive=drive)
        self.assertEqual(result.outcome, phone.GATE_PARTICIPANT_LEFT)
        self.assertEqual(h.client.event_types, ["call.busy"])
        self.assertEqual(h.sip_left_logs(), [])
        self.assertEqual(h.begin_kwargs, [])

    async def test_pre_answer_client_initiated_posts_no_answer(self):
        h = _Harness("ringing")

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            answer = asyncio.ensure_future(kwargs["wait_for_answer"]())
            h.gate_ready.set()
            await answer
            raise phone.PhoneParticipantGone("participant_gone")

        await h.run(gate, drive=lambda: h.room.depart(
            h.participant, _BY_NAME["CLIENT_INITIATED"]))
        self.assertEqual(h.client.event_types, ["call.no_answer"])

    async def test_pre_answer_transport_abort_posts_nothing(self):
        h = _Harness("ringing")

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            answer = asyncio.ensure_future(kwargs["wait_for_answer"]())
            h.gate_ready.set()
            await answer
            raise phone.PhoneParticipantGone("participant_gone")

        await h.run(gate, drive=lambda: h.room.depart(
            h.participant, _BY_NAME["ROOM_DELETED"]))
        self.assertEqual(h.client.event_types, [])

    async def test_answer_observed_with_failed_call_answered_defers_never_no_answer(self):
        h = _Harness("ringing")
        h.client._outcomes["call.answered"] = phone.PhoneApiOutcome(False, "transport")

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            answer = asyncio.ensure_future(kwargs["wait_for_answer"]())
            h.gate_ready.set()
            self.assertEqual(await answer, "answered")
            kwargs["gate_phase_out"]["answer_observed"] = True
            await kwargs["client"].post_event(fixtures._ATTEMPT_ID, "call.answered")
            raise phone.PhoneParticipantGone("participant_gone")

        await h.run(gate, drive=lambda: h.room.set_status(h.participant, "active"))
        self.assertNotIn("call.no_answer", h.client.event_types)
        self.assertEqual(
            h.client.event_types, ["call.answered", "candidate.deferred_pre_disclosure"])

    async def test_e3_post_answer_sip_left_still_posts_once_after_evidence(self):
        h = _Harness("ringing")

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            answer = asyncio.ensure_future(kwargs["wait_for_answer"]())
            h.room.set_status(h.participant, "active")
            self.assertEqual(await answer, "answered")
            kwargs["gate_phase_out"]["answer_observed"] = True
            await kwargs["begin_recording_at_answer"]()
            h.gate_ready.set()
            await kwargs["say"](phone.PHONE_DISCLOSURE_TEXT)  # wedged
            raise AssertionError("a wedged playout must never return")

        result = await h.run(gate, drive=lambda: h.room.depart(
            h.participant, _BY_NAME["USER_UNAVAILABLE"]))
        self.assertEqual(result.outcome, phone.GATE_PARTICIPANT_LEFT)
        self.assertEqual(h.client.event_types.count("sip.participant_left"), 1)
        timeline = h.client.timeline
        self.assertLess(timeline.index("recording.uploaded"),
                        timeline.index("event:sip.participant_left"))
        self.assertLess(timeline.index("event:sip.participant_left"),
                        timeline.index("room.delete"))
        self.assertEqual(e3._Session.sdk_closes, ["user_initiated"])

    async def test_e3_listener_does_nothing_pre_answer_while_seam_active(self):
        h = _Harness("ringing")

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            # The status was 'ringing' at presence, so the seam latched there.
            self.assertTrue(kwargs["gate_phase_out"].get("answer_seam"))
            h.gate_ready.set()
            await kwargs["say"](phone.PHONE_DISCLOSURE_TEXT)  # wedged
            raise AssertionError("unreachable")

        result = await h.run(
            gate, drive=lambda: h.room.depart(h.participant, _BY_NAME["USER_UNAVAILABLE"]),
            wall_clock=0.2,
        )
        self.assertEqual(result.outcome, phone.GATE_TIMED_OUT)
        self.assertEqual(h.sip_left_logs(), [])
        self.assertEqual(e3._Session.sdk_closes, [])
        self.assertNotIn("sip.participant_left", h.client.event_types)
        self.assertNotIn("candidate.deferred_pre_disclosure", h.client.event_types)

    async def test_gate_not_answered_posts_nothing_more(self):
        h = _Harness("ringing")

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            h.gate_ready.set()
            kwargs["gate_phase_out"]["answer_seam"] = True
            return phone.PhoneGateResult(phone.GATE_NOT_ANSWERED)

        result = await h.run(gate)
        self.assertEqual(result.outcome, phone.GATE_NOT_ANSWERED)
        self.assertEqual(h.client.event_types, [])
        self.assertIn("room.delete", h.client.timeline)
        self.assertIn("not_answered", h.teardown_labels())

    async def test_pre_answer_exception_without_departure_charges_nothing(self):
        h = _Harness("ringing")

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            h.gate_ready.set()
            raise RuntimeError("worker bug")

        result = await h.run(gate, expect=RuntimeError)
        self.assertIsNone(result)
        self.assertEqual(h.client.event_types, [])

    async def test_sdk_close_mid_ring_without_departure_charges_nothing(self):
        """Our own job shutdown / deploy closes the AgentSession while the leg
        still rings: the gate is cancelled with failure=None and NO departure.
        That is not evidence the callee did not answer — never call.no_answer."""
        h = _Harness("ringing")

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            answer = asyncio.ensure_future(kwargs["wait_for_answer"]())
            h.gate_ready.set()
            await answer
            raise AssertionError("the ring never resolves in this case")

        def drive():
            # The harness shadows `instances` on the subclass; the base list
            # is the one appended to, and its newest entry is this run's.
            session = fixtures._FakePhoneSession.instances[-1]
            asyncio.ensure_future(session._aclose_impl(reason="job_shutdown"))

        result = await h.run(gate, drive=drive)
        self.assertEqual(result.outcome, phone.GATE_PARTICIPANT_LEFT)
        self.assertEqual(h.client.event_types, [])
        self.assertEqual(e3._Session.sdk_closes, ["job_shutdown"])
        uncharged = [
            c.kwargs for c in h.log.warn.call_args_list
            if c.kwargs.get("error_category") == "pre_answer_failure_uncharged"
        ]
        self.assertEqual(len(uncharged), 1)
        self.assertEqual(uncharged[0]["phase"], "no_departure")
        self.assertIn("room.delete", h.client.timeline)

    async def test_sdk_close_after_hangup_grace_verdict_still_charges(self):
        """The ring resolved (hangup grace → no_answer) but the gate was cut
        short before it could post: an OBSERVED non-answer is still charged."""
        h = _Harness("ringing")

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            answer = asyncio.ensure_future(kwargs["wait_for_answer"]())
            h.gate_ready.set()
            await answer
            # Cut short before the gate's own post: the session is gone.
            raise phone.PhoneParticipantGone("participant_gone")

        with patch.object(agent, "_SIP_ANSWER_HANGUP_GRACE_SEC", 0.02):
            await h.run(gate, drive=lambda: h.room.set_status(h.participant, "hangup"))
        self.assertEqual(h.client.event_types, ["call.no_answer"])

    async def test_cancellation_still_posts_nothing(self):
        h = _Harness("ringing")
        departed = asyncio.Event()

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            h.gate_ready.set()
            await departed.wait()
            raise asyncio.CancelledError

        await h.run(gate, drive=departed.set, expect=asyncio.CancelledError)
        self.assertFalse(any(i.startswith("event:") for i in h.client.timeline))

    async def test_presence_mode_does_not_wire_the_seam(self):
        for env in ({"PHONE_ANSWER_SIGNAL": "presence"}, {"PHONE_BOUNCE_MODE": "true"}):
            with self.subTest(env=env):
                h = _Harness("ringing")
                seen: dict = {}

                async def gate(**kwargs):
                    seen["wait_for_answer"] = kwargs["wait_for_answer"]
                    await kwargs["wait_for_participant"]()
                    seen["seam"] = kwargs["gate_phase_out"].get("answer_seam")
                    h.gate_ready.set()
                    await kwargs["say"](phone.PHONE_DISCLOSURE_TEXT)  # wedged
                    raise AssertionError("unreachable")

                with patch.dict(os.environ, env):
                    await h.run(gate, drive=lambda: h.room.depart(
                        h.participant, _BY_NAME["USER_UNAVAILABLE"]))
                self.assertIsNone(seen["wait_for_answer"])
                self.assertIsNone(seen["seam"])
                # Today's E3 behaviour: the listener closes, sip.participant_left.
                self.assertEqual(h.client.event_types, ["sip.participant_left"])

    async def test_without_rtc_the_seam_is_not_wired(self):
        h = _Harness("ringing")
        seen: dict = {}

        async def gate(**kwargs):
            seen["wait_for_answer"] = kwargs["wait_for_answer"]
            await kwargs["wait_for_participant"]()
            seen["seam"] = kwargs["gate_phase_out"].get("answer_seam")
            h.gate_ready.set()
            return phone.PhoneGateResult(phone.GATE_NO_PARTICIPANT)

        # `run` installs `lambda: e3._FAKE_RTC`; None there is "no rtc".
        with patch.object(e3, "_FAKE_RTC", None):
            await h.run(gate)
        self.assertIsNone(seen["wait_for_answer"])
        self.assertIsNone(seen["seam"])


if __name__ == "__main__":
    unittest.main()
