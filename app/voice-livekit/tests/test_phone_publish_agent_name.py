"""M010: the phone worker publishes its own ``lk.agent.name`` after connect.

Production 2026-10-04: every targeted (per-machine) dial deferred. The API's
agent-join barrier waits for a NEW agent participant whose ``lk.agent.name``
equals the per-machine name, and the barrier's diagnostic line read
``n.a`` on every dial — the agent joined within ~3 s and carried attributes,
but never ``lk.agent.name`` (the SDK's accept-time attribute does not reach
the participant on our LiveKit Cloud project). So the worker sets it itself.

What this file pins (bare python3, SDK stubbed via the shared fixtures):

  * per-machine name ⇒ exactly one ``set_attributes({"lk.agent.name": name})``;
  * base name (untargeted worker) ⇒ nothing is published — byte-identical;
  * a job dispatched under a different name publishes nothing (``mismatch``);
  * a publish that does not read back locally is ``unconfirmed``, not ``ok``;
  * a failing or hanging ``set_attributes`` is fail-open (no raise) and logs a
    fixed category, and the name is never logged on ANY outcome;
  * ``_run_phone_session`` publishes immediately after ``ctx.connect``, on
    ``ctx.room``, passing the job's dispatched name;
  * the attribute key is the API's ``PHONE_AGENT_NAME_ATTRIBUTE``, exactly.
"""

from __future__ import annotations

import asyncio
import pathlib
import re
import unittest
from unittest.mock import patch

from tests import test_phone_gate as fixtures
from tests.test_phone_agent_name import _BASE, _MACHINE, _PER_MACHINE_ON, _Env

agent = fixtures.agent_mod

_REPO_APP = pathlib.Path(__file__).resolve().parent.parent.parent  # app/
_NAME = f"{_BASE}-{_MACHINE}"


class _Participant:
    def __init__(self, behaviour: str = "ok"):
        self.behaviour = behaviour
        self.calls: list[dict[str, str]] = []
        self.attributes: dict[str, str] = {"lk.agent.state": "initializing"}

    async def set_attributes(self, attributes: dict[str, str]) -> None:
        self.calls.append(dict(attributes))
        if self.behaviour == "raise":
            raise RuntimeError("livekit said no")
        if self.behaviour == "raise_permission":
            raise PermissionError("no")
        if self.behaviour == "hang":
            await asyncio.sleep(3600)
        if self.behaviour != "silent":  # "silent": accepted locally, never reflected
            self.attributes.update(attributes)


class _Room:
    def __init__(self, behaviour: str = "ok"):
        self.local_participant = _Participant(behaviour)


def _publish(env: dict[str, str], behaviour: str = "ok", timeout: float | None = None,
             dispatched: object = None):
    room = _Room(behaviour)
    with _Env(env):
        with patch.object(agent, "_log") as log:
            with patch.object(
                agent, "_PHONE_AGENT_NAME_PUBLISH_TIMEOUT_SEC",
                timeout if timeout is not None else agent._PHONE_AGENT_NAME_PUBLISH_TIMEOUT_SEC,
            ):
                outcome = asyncio.run(agent._publish_phone_agent_name(room, dispatched))
    # The name (and the machine id inside it) is never logged, on ANY outcome.
    for call in log.mock_calls:
        assert _MACHINE not in repr(call), call
    return outcome, room.local_participant.calls, log


class TestPublishPhoneAgentName(unittest.TestCase):
    def test_per_machine_name_is_published_once(self):
        outcome, calls, log = _publish(_PER_MACHINE_ON)
        self.assertEqual(outcome, "ok")
        self.assertEqual(calls, [{"lk.agent.name": _NAME}])
        log.info.assert_called_once_with(
            "unknown_event", error_type="phone_agent_name_published", error_category="ok",
        )

    def test_publish_when_the_dispatched_name_matches_or_is_unknown(self):
        for dispatched in (_NAME, None, ""):
            with self.subTest(dispatched=dispatched):
                outcome, calls, _log = _publish(_PER_MACHINE_ON, dispatched=dispatched)
                self.assertEqual(outcome, "ok")
                self.assertEqual(len(calls), 1)

    def test_a_job_dispatched_under_another_name_publishes_nothing(self):
        outcome, calls, log = _publish(_PER_MACHINE_ON, dispatched=f"{_BASE}-7812736a540d58")
        self.assertEqual(outcome, "mismatch")
        self.assertEqual(calls, [])
        log.warn.assert_called_once_with(
            "unknown_event", error_type="phone_agent_name_published", error_category="mismatch",
        )

    def test_base_name_publishes_nothing(self):
        for env in (
            {"PHONE_AGENT_NAME": _BASE},  # not orchestrated, flag absent
            {**_PER_MACHINE_ON, "PHONE_PER_MACHINE_AGENT_NAME": "false"},
            {**_PER_MACHINE_ON, "FLY_MACHINE_ID": "NOT_A_MACHINE"},  # falls back to base
            {},  # default unnamed worker
        ):
            with self.subTest(env=env):
                outcome, calls, _log = _publish(env)
                self.assertEqual(outcome, "skipped")
                self.assertEqual(calls, [])

    def test_a_publish_that_does_not_read_back_is_unconfirmed(self):
        outcome, calls, log = _publish(_PER_MACHINE_ON, behaviour="silent")
        self.assertEqual(outcome, "unconfirmed")
        self.assertEqual(len(calls), 1)
        log.warn.assert_called_once_with(
            "unknown_event", error_type="phone_agent_name_published", error_category="unconfirmed",
        )

    def test_a_failing_publish_is_fail_open_and_logs_a_fixed_bucket(self):
        outcome, calls, log = _publish(_PER_MACHINE_ON, behaviour="raise")
        self.assertEqual(outcome, "failed")
        self.assertEqual(len(calls), 1)
        log.warn.assert_called_once_with(
            "unknown_event", error_type="phone_agent_name_published",
            error_category="failed", schema="runtime",
        )

    def test_failure_classes_are_bucketed_from_a_fixed_vocabulary(self):
        outcome, _calls, log = _publish(_PER_MACHINE_ON, behaviour="raise_permission")
        self.assertEqual(outcome, "failed")
        self.assertEqual(log.warn.call_args.kwargs["schema"], "permission")

    def test_a_hanging_publish_times_out_instead_of_holding_the_call(self):
        outcome, _calls, log = _publish(_PER_MACHINE_ON, behaviour="hang", timeout=0.05)
        self.assertEqual(outcome, "timeout")
        log.warn.assert_called_once_with(
            "unknown_event", error_type="phone_agent_name_published", error_category="timeout",
        )

    def test_run_phone_session_publishes_on_ctx_room_right_after_connect(self):
        # Behavioural: drive the real coroutine far enough to see the order.
        order: list[str] = []
        seen: dict[str, object] = {}

        class _Stop(Exception):
            pass

        class _Job:
            agent_name = _NAME

        class _Ctx:
            def __init__(self):
                self.room = _Room()
                self.job = _Job()

            async def connect(self):
                order.append("connect")

        ctx = _Ctx()

        async def fake_publish(room, dispatched_agent_name=None):
            order.append("publish")
            seen["room"] = room
            seen["dispatched"] = dispatched_agent_name
            raise _Stop()

        with patch.object(agent, "_publish_phone_agent_name", new=fake_publish):
            with self.assertRaises(_Stop):
                asyncio.run(agent._run_phone_session(ctx, "phone-room", "attempt", 0))
        self.assertEqual(order, ["connect", "publish"])
        self.assertIs(seen["room"], ctx.room)
        self.assertEqual(seen["dispatched"], _NAME)

    def test_the_key_is_the_apis_attribute_exactly(self):
        dial = (_REPO_APP / "api" / "src" / "integrations" / "livekit-phone-dial" / "dial.ts").read_text(
            encoding="utf-8",
        )
        m = re.search(r"export const PHONE_AGENT_NAME_ATTRIBUTE = ['\"]([^'\"]+)['\"];", dial)
        self.assertIsNotNone(m, "PHONE_AGENT_NAME_ATTRIBUTE not found in dial.ts")
        self.assertEqual(agent._PHONE_AGENT_NAME_ATTRIBUTE, m.group(1))


if __name__ == "__main__":
    unittest.main()
