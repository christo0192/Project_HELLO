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
  * a failing or hanging ``set_attributes`` is fail-open (no raise) and logs a
    fixed category, never the name;
  * ``_run_phone_session`` publishes immediately after ``ctx.connect``;
  * the attribute key is the API's ``PHONE_AGENT_NAME_ATTRIBUTE``, exactly.
"""

from __future__ import annotations

import asyncio
import inspect
import pathlib
import re
import unittest
from unittest.mock import AsyncMock, patch

from tests import test_phone_gate as fixtures
from tests.test_phone_agent_name import _BASE, _MACHINE, _PER_MACHINE_ON, _Env

agent = fixtures.agent_mod

_REPO_APP = pathlib.Path(__file__).resolve().parent.parent.parent  # app/


class _Participant:
    def __init__(self, behaviour: str = "ok"):
        self.behaviour = behaviour
        self.calls: list[dict[str, str]] = []

    async def set_attributes(self, attributes: dict[str, str]) -> None:
        self.calls.append(dict(attributes))
        if self.behaviour == "raise":
            raise RuntimeError("livekit said no")
        if self.behaviour == "hang":
            await asyncio.sleep(3600)


class _Room:
    def __init__(self, behaviour: str = "ok"):
        self.local_participant = _Participant(behaviour)


def _publish(env: dict[str, str], behaviour: str = "ok", timeout: float | None = None):
    room = _Room(behaviour)
    with _Env(env):
        with patch.object(agent, "_log") as log:
            if timeout is not None:
                with patch.object(agent, "_PHONE_AGENT_NAME_PUBLISH_TIMEOUT_SEC", timeout):
                    outcome = asyncio.run(agent._publish_phone_agent_name(room))
            else:
                outcome = asyncio.run(agent._publish_phone_agent_name(room))
    return outcome, room.local_participant.calls, log


class TestPublishPhoneAgentName(unittest.TestCase):
    def test_per_machine_name_is_published_once(self):
        outcome, calls, log = _publish(_PER_MACHINE_ON)
        self.assertEqual(outcome, "ok")
        self.assertEqual(calls, [{"lk.agent.name": f"{_BASE}-{_MACHINE}"}])
        log.info.assert_called_once_with(
            "unknown_event", error_type="phone_agent_name_published", error_category="ok",
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

    def test_a_failing_publish_is_fail_open_and_logs_no_value(self):
        outcome, calls, log = _publish(_PER_MACHINE_ON, behaviour="raise")
        self.assertEqual(outcome, "failed")
        self.assertEqual(len(calls), 1)
        log.warn.assert_called_once_with(
            "unknown_event", error_type="phone_agent_name_published", error_category="failed",
        )
        for call in log.mock_calls:
            self.assertNotIn(_MACHINE, repr(call))

    def test_a_hanging_publish_times_out_instead_of_holding_the_call(self):
        outcome, _calls, log = _publish(_PER_MACHINE_ON, behaviour="hang", timeout=0.05)
        self.assertEqual(outcome, "timeout")
        log.warn.assert_called_once_with(
            "unknown_event", error_type="phone_agent_name_published", error_category="timeout",
        )

    def test_run_phone_session_publishes_right_after_connect(self):
        src = inspect.getsource(agent._run_phone_session)
        body = src[src.index('"""', src.index('"""') + 3) + 3:]
        awaits = re.findall(r"^\s*await ([A-Za-z_][\w.]*)\(", body, re.M)
        self.assertGreaterEqual(len(awaits), 2)
        self.assertEqual(awaits[0], "ctx.connect")
        self.assertEqual(awaits[1], "_publish_phone_agent_name")
        self.assertIn("await _publish_phone_agent_name(ctx.room)", body)

    def test_run_phone_session_awaits_the_publish_before_any_other_work(self):
        # Behavioural: drive the real coroutine far enough to see the order.
        order: list[str] = []

        class _Ctx:
            def __init__(self):
                self.room = _Room()

            async def connect(self):
                order.append("connect")

        async def fake_publish(room):
            order.append("publish")
            raise _Stop()

        class _Stop(Exception):
            pass

        with patch.object(agent, "_publish_phone_agent_name", new=fake_publish):
            with self.assertRaises(_Stop):
                asyncio.run(agent._run_phone_session(_Ctx(), "phone-room", "attempt", 0))
        self.assertEqual(order, ["connect", "publish"])

    def test_the_key_is_the_apis_attribute_exactly(self):
        dial = (_REPO_APP / "api" / "src" / "integrations" / "livekit-phone-dial" / "dial.ts").read_text(
            encoding="utf-8",
        )
        m = re.search(r"export const PHONE_AGENT_NAME_ATTRIBUTE = '([^']+)';", dial)
        self.assertIsNotNone(m)
        self.assertEqual(agent._PHONE_AGENT_NAME_ATTRIBUTE, m.group(1))


if __name__ == "__main__":
    unittest.main()
