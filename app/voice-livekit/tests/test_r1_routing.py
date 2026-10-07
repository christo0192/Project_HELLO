"""R1 lane routing at the shared worker entrypoint, and the R1 worker options.

A refused room must be deleted and its job ended with ``JobContext.delete_room`` and
``JobContext.shutdown`` (livekit-agents 1.6.4 has no ``close_room``); the contexts
below expose only those two, and no ``connect``, so any other call fails the test.

Runs on bare python3 (SDK stubbed via the shared ``test_phone_gate`` fixtures). Under a
real SDK venv the phone fixtures cannot import (no tzdata), and the suite is skipped.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

try:
    from tests import test_phone_drain as drain_fixtures
    from tests import test_phone_gate as fixtures
except Exception:  # noqa: BLE001 - e.g. ZoneInfoNotFoundError under the SDK venv
    drain_fixtures = fixtures = None

SESSION_ID = "5b2a34cb-a912-4c68-a2c2-79ccdc1dcdd1"
ROOM = f"screening-{SESSION_ID}"
MARKED = '{"session_id": "x", "lane": "r1"}'
UNMARKED = '{"session_id": "x"}'
_ENV_KEYS = ("PHONE_AGENT_NAME", "BROWSER_AGENT_NAME", "WORKER_ORCHESTRATION", "R1_LANE_MODE")


class RefuseContext:
    """A JobContext with ONLY the 1.6.4 surface the refuse path may use."""

    def __init__(self, metadata: str | None, *, delete_error: BaseException | None = None) -> None:
        self.room = SimpleNamespace(name=ROOM, metadata=metadata)
        self.job = SimpleNamespace(room=SimpleNamespace(name=ROOM, metadata=metadata))
        self.deleted: list = []
        self.shutdowns: list[str] = []
        self.delete_error = delete_error

    async def delete_room(self, room_name=None) -> None:
        self.deleted.append(room_name)
        if self.delete_error is not None:
            raise self.delete_error

    def shutdown(self, reason: str = "") -> None:
        self.shutdowns.append(reason)


@unittest.skipIf(fixtures is None, "phone fixtures need the bare-python SDK stubs")
class TestR1EntrypointRouting(unittest.IsolatedAsyncioTestCase):
    """The mode gate and the API-authored marker must agree, or the job is ended."""

    def setUp(self) -> None:
        self.agent = fixtures.agent_mod
        prior = {key: os.environ.get(key) for key in _ENV_KEYS}
        for key in _ENV_KEYS:
            os.environ.pop(key, None)

        def restore() -> None:
            for key, value in prior.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        self.addCleanup(restore)
        import r1_session

        self.run_r1 = mock.AsyncMock(return_value="complete")
        patch = mock.patch.object(r1_session, "run_r1_session", self.run_r1)
        patch.start()
        self.addCleanup(patch.stop)
        log_patch = mock.patch.object(self.agent, "_log")
        self.log = log_patch.start()
        self.addCleanup(log_patch.stop)

    def assert_refused(self, ctx: RefuseContext, category: str) -> None:
        self.assertEqual(ctx.deleted, [ROOM])
        self.assertEqual(ctx.shutdowns, ["r1_routing_refused"])
        self.run_r1.assert_not_awaited()
        first = self.log.warn.call_args_list[0]
        self.assertEqual(first.args, ("unknown_event",))
        self.assertEqual(first.kwargs["error_type"], "r1_room_routing_refused")
        self.assertEqual(first.kwargs["error_category"], category)

    async def test_every_refuse_case_ends_the_job_without_connecting_or_raising(self) -> None:
        cases = (
            ("off", MARKED, "marked_room_mode_off"),
            ("garbage", MARKED, "marked_room_mode_off"),
            (None, MARKED, "marked_room_mode_off"),
            ("r1_only", UNMARKED, "unmarked_room_r1_only"),
            (" r1_only ", UNMARKED, "unmarked_room_r1_only"),
            ("r1_only", None, "unmarked_room_r1_only"),
        )
        for mode, metadata, category in cases:
            with self.subTest(mode=mode, metadata=metadata):
                self.log.reset_mock()
                self.run_r1.reset_mock()
                if mode is None:
                    os.environ.pop("R1_LANE_MODE", None)
                else:
                    os.environ["R1_LANE_MODE"] = mode
                ctx = RefuseContext(metadata)
                await self.agent.entrypoint(ctx)  # no connect(): AttributeError if reached
                self.assert_refused(ctx, category)

    async def test_a_failed_room_delete_still_ends_the_job(self) -> None:
        os.environ["R1_LANE_MODE"] = "off"
        ctx = RefuseContext(MARKED, delete_error=RuntimeError("livekit api unreachable"))
        await self.agent.entrypoint(ctx)
        self.assertEqual(ctx.shutdowns, ["r1_routing_refused"])
        types = [call.kwargs.get("error_type") for call in self.log.warn.call_args_list]
        self.assertEqual(types, ["r1_room_routing_refused", "r1_room_refuse_delete_failed"])

    async def test_a_marked_room_with_the_gate_open_runs_r1(self) -> None:
        for mode in ("r1_only", " r1_only "):
            with self.subTest(mode=mode):
                self.run_r1.reset_mock()
                os.environ["R1_LANE_MODE"] = mode
                ctx = RefuseContext(MARKED)
                await self.agent.entrypoint(ctx)
                self.run_r1.assert_awaited_once()
                self.assertIs(self.run_r1.await_args.args[0], ctx)
                self.assertEqual(ctx.shutdowns, [])
                self.assertEqual(ctx.deleted, [])

    async def test_an_unmarked_room_with_the_gate_closed_stays_on_the_legacy_path(self) -> None:
        for mode in (None, "off", "garbage"):
            with self.subTest(mode=mode):
                self.run_r1.reset_mock()
                if mode is None:
                    os.environ.pop("R1_LANE_MODE", None)
                else:
                    os.environ["R1_LANE_MODE"] = mode
                ctx = RefuseContext(UNMARKED)
                # The legacy path starts with ctx.connect(), which this context lacks.
                with self.assertRaises(AttributeError):
                    await self.agent.entrypoint(ctx)
                self.assertEqual(ctx.deleted, [])
                self.assertEqual(ctx.shutdowns, [])
                self.run_r1.assert_not_awaited()


@unittest.skipIf(fixtures is None, "phone fixtures need the bare-python SDK stubs")
class TestR1WorkerOptions(unittest.TestCase):
    """The drain budget follows the SAME predicate as routing, and never reaches phone."""

    def test_a_padded_mode_value_gets_the_r1_drain_budget(self) -> None:
        for mode in ("r1_only", " r1_only ", "r1_only\n"):
            with self.subTest(mode=mode):
                options = drain_fixtures._build({"R1_LANE_MODE": mode})
                self.assertEqual(options["drain_timeout"], 60)
                self.assertEqual(options["shutdown_process_timeout"], 90)

    def test_other_modes_keep_the_legacy_browser_options(self) -> None:
        baseline = drain_fixtures._build({})
        self.assertNotIn("drain_timeout", baseline)
        for mode in ("", "off", "garbage", "R1_ONLY"):
            with self.subTest(mode=mode):
                self.assertEqual(drain_fixtures._build({"R1_LANE_MODE": mode}), baseline)

    def test_the_budget_is_bounded_even_for_a_bad_value(self) -> None:
        options = drain_fixtures._build(
            {
                "R1_LANE_MODE": "r1_only",
                "R1_DRAIN_TIMEOUT_SEC": "9999",
                "R1_SHUTDOWN_PROCESS_TIMEOUT_SEC": "1",
            }
        )
        self.assertEqual(options["drain_timeout"], 60)
        self.assertEqual(options["shutdown_process_timeout"], 30)

    def test_phone_options_are_identical_for_every_padded_mode_too(self) -> None:
        baseline = drain_fixtures._build(drain_fixtures._PHONE)
        for mode in ("", "off", "r1_only", " r1_only ", "garbage"):
            with self.subTest(mode=mode):
                candidate = drain_fixtures._build(
                    {
                        **drain_fixtures._PHONE,
                        "R1_LANE_MODE": mode,
                        "R1_DRAIN_TIMEOUT_SEC": "30",
                        "R1_SHUTDOWN_PROCESS_TIMEOUT_SEC": "30",
                    }
                )
                self.assertEqual(candidate, baseline)


if __name__ == "__main__":
    unittest.main()
