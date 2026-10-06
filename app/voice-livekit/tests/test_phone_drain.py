"""M009 PR-C, C9 worker side: evidence survives a stop, and a closed room is
not a teardown failure.

C9-1  The named phone worker bounds the SDK drain (`drain_timeout`, default
      1800 s in livekit-agents 1.6.4) with PHONE_DRAIN_TIMEOUT_SEC (default 90,
      clamp 30..120) so a live call at SIGINT reaches its own teardown inside
      Fly's kill_timeout (300 s). Browser / unnamed options stay byte-identical.
      A detached `recorder.finish` upload is AWAITED (never cancelled) before
      the exit watchdog is armed, bounded by
      min(PHONE_RECORDING_FINISH_SECONDS - elapsed,
          PHONE_SHUTDOWN_PROCESS_TIMEOUT - 15 - PHONE_TEARDOWN_MAX_SECONDS - 10).
C9-3  `_delete_livekit_room` classifies NOT_FOUND as info `room_already_closed`
      and a server disconnect as warn `room_delete_disconnected`, INSIDE the
      coroutine handed to `_bounded_await`; anything else still reads as
      `room_delete_failed`.

Runs on bare python3 (SDK stubbed via the shared `test_phone_gate` fixtures).
"""

from __future__ import annotations

import asyncio
import os
import pathlib
import time
import tomllib
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from tests import test_phone_gate as fixtures

agent = fixtures.agent_mod
phone = fixtures.phone

_CTX = pathlib.Path(__file__).resolve().parent.parent  # app/voice-livekit

_JUDGE_ENV = {
    "PHONE_JUDGE_SDK": "openai",
    "PHONE_JUDGE_API_KEY": "judge-test-key",
    "PHONE_JUDGE_URL": phone.PHONE_JUDGE_GOOGLE_URL,
    "PHONE_JUDGE_MODEL": phone.PHONE_JUDGE_GEMINI_MODEL,
    "PHONE_COVERAGE_TIMEOUT_SEC": "2",
    "PHONE_JUDGE_RETRIES": "0",
}
_ENV_KEYS = (
    "PHONE_AGENT_NAME", "BROWSER_AGENT_NAME", "WORKER_ORCHESTRATION",
    "PHONE_PER_MACHINE_AGENT_NAME", "FLY_MACHINE_ID",
    "PHONE_DRAIN_TIMEOUT_SEC", "PHONE_SHUTDOWN_PROCESS_TIMEOUT",
    "R1_LANE_MODE", "R1_DRAIN_TIMEOUT_SEC", "R1_SHUTDOWN_PROCESS_TIMEOUT_SEC",
    *_JUDGE_ENV.keys(),
)


class _Env:
    """Exactly ``env`` for the relevant keys, restored afterwards."""

    def __init__(self, env: dict[str, str]):
        self._env = env

    def __enter__(self):
        self._prior = {k: os.environ.get(k) for k in _ENV_KEYS}
        for k in _ENV_KEYS:
            os.environ.pop(k, None)
        os.environ.update(self._env)
        return self

    def __exit__(self, *exc):
        for k, v in self._prior.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return False


def _build(env: dict[str, str], *, accepts=lambda _f: True) -> dict:
    with _Env(env), \
         patch.object(agent, "WorkerOptions", fixtures._OptionsRecorder), \
         patch.object(agent, "_worker_options_accepts", accepts):
        agent.build_worker_options()
    return dict(fixtures._OptionsRecorder.last)


_PHONE = {"PHONE_AGENT_NAME": "phone-screener", **_JUDGE_ENV}


# ── C9-1: drain_timeout on the named phone worker only ─────────────────────

class TestPhoneDrainTimeoutOption(unittest.TestCase):
    def test_phone_options_are_identical_for_every_r1_mode(self):
        """R1 drain knobs are browser-only, including garbage and disabled mode values."""
        baseline = _build(_PHONE)
        for mode in ("", "off", "r1_only", "garbage"):
            with self.subTest(mode=mode):
                candidate = _build({
                    **_PHONE,
                    "R1_LANE_MODE": mode,
                    "R1_DRAIN_TIMEOUT_SEC": "30",
                    "R1_SHUTDOWN_PROCESS_TIMEOUT_SEC": "30",
                })
                self.assertEqual(candidate, baseline)

    def test_named_phone_worker_sets_drain_timeout_90_as_int(self):
        options = _build(_PHONE)
        self.assertEqual(options["drain_timeout"], 90)
        # The SDK field is `drain_timeout: int`.
        self.assertIsInstance(options["drain_timeout"], int)

    def test_env_override_and_clamp(self):
        for raw, expected in (("60", 60), ("120", 120), ("500", 120),
                              ("5", 30), ("nan", 90), ("junk", 90)):
            with self.subTest(raw=raw):
                options = _build({**_PHONE, "PHONE_DRAIN_TIMEOUT_SEC": raw})
                self.assertEqual(options["drain_timeout"], expected)

    def test_not_sent_when_the_pinned_sdk_lacks_the_field(self):
        # An unknown WorkerOptions kwarg raises at worker start, which would
        # take the whole phone fleet down, so it is probed, never guessed.
        options = _build(_PHONE, accepts=lambda f: f != "drain_timeout")
        self.assertNotIn("drain_timeout", options)
        self.assertIn("shutdown_process_timeout", options)

    def test_unnamed_browser_worker_options_are_byte_identical(self):
        # Even with the env var present and an SDK that accepts the field,
        # the unnamed browser worker gets neither phone shutdown key.
        with_drain = _build({"PHONE_DRAIN_TIMEOUT_SEC": "60"})
        without = _build({})
        self.assertNotIn("drain_timeout", with_drain)
        self.assertNotIn("shutdown_process_timeout", with_drain)
        self.assertEqual(with_drain.keys(), without.keys())
        self.assertEqual(
            {k: v for k, v in with_drain.items() if k != "entrypoint_fnc"},
            {k: v for k, v in without.items() if k != "entrypoint_fnc"},
        )

    def test_named_browser_worker_gets_no_drain_timeout(self):
        options = _build({
            "BROWSER_AGENT_NAME": "browser-screener",
            "WORKER_ORCHESTRATION": "worker",
            "PHONE_DRAIN_TIMEOUT_SEC": "60",
        })
        self.assertEqual(options.get("agent_name"), "browser-screener")
        self.assertNotIn("drain_timeout", options)

    def test_shutdown_process_timeout_reader_is_shared_and_unchanged(self):
        # The refactor to one reader must not move the PR-A value.
        self.assertEqual(_build(_PHONE)["shutdown_process_timeout"], 90.0)
        with _Env({"PHONE_SHUTDOWN_PROCESS_TIMEOUT": "500"}):
            self.assertEqual(agent._phone_shutdown_process_timeout(), 120.0)
        with _Env({"PHONE_SHUTDOWN_PROCESS_TIMEOUT": "1"}):
            self.assertEqual(agent._phone_shutdown_process_timeout(), 10.0)


class TestShippedDrainBudget(unittest.TestCase):
    """The SHIPPED fly.phone.toml satisfies the C9-1 budget the worker assumes."""

    def setUp(self):
        self.cfg = tomllib.loads(
            (_CTX / "fly.phone.toml").read_text(encoding="utf-8"),
        )

    def test_shipped_value_and_budget(self):
        env = self.cfg.get("env", {})
        self.assertEqual(env.get("PHONE_DRAIN_TIMEOUT_SEC"), "90")
        drain = int(env["PHONE_DRAIN_TIMEOUT_SEC"])
        shutdown = float(env.get("PHONE_SHUTDOWN_PROCESS_TIMEOUT", 90))
        kill_timeout = self.cfg["kill_timeout"]
        # PR-A's kill_timeout is untouched; the drain fits inside it.
        self.assertEqual(kill_timeout, 300)
        self.assertLessEqual(drain + 2 * shutdown + 30, kill_timeout)
        # And the worker reads the shipped value back unchanged.
        with _Env({**_PHONE, "PHONE_DRAIN_TIMEOUT_SEC": env["PHONE_DRAIN_TIMEOUT_SEC"]}):
            self.assertEqual(agent._phone_drain_timeout_sec(), drain)

    def test_browser_config_has_no_drain_key(self):
        browser = tomllib.loads((_CTX / "fly.toml").read_text(encoding="utf-8"))
        self.assertNotIn("PHONE_DRAIN_TIMEOUT_SEC", browser.get("env", {}))


# ── C9-1: the detached-finish wait cap ─────────────────────────────────────

class TestDetachedFinishWaitCap(unittest.TestCase):
    def _cap(self, elapsed, *, finish=45.0, teardown=25.0, shutdown=None):
        env = {} if shutdown is None else {"PHONE_SHUTDOWN_PROCESS_TIMEOUT": str(shutdown)}
        with _Env(env), \
             patch.object(agent, "PHONE_RECORDING_FINISH_SECONDS", finish), \
             patch.object(agent, "PHONE_TEARDOWN_MAX_SECONDS", teardown):
            return agent._detached_finish_wait_cap(elapsed)

    def test_defaults_are_bounded_by_the_shutdown_grace(self):
        # 90 - 15 - 25 - 10 = 40 < 45 - 0
        self.assertAlmostEqual(self._cap(0.0), 40.0)

    def test_upload_budget_term_counts_from_upload_start(self):
        self.assertAlmostEqual(self._cap(30.0), 15.0)  # 45 - 30
        self.assertAlmostEqual(self._cap(44.0), 1.0)

    def test_clamped_at_zero(self):
        self.assertEqual(self._cap(50.0), 0.0)
        self.assertEqual(self._cap(0.0, shutdown=30), 0.0)  # 30-15-25-10 < 0

    def test_lower_shutdown_grace_shrinks_the_cap(self):
        self.assertAlmostEqual(self._cap(0.0, shutdown=60), 10.0)  # 60-15-25-10

    def test_negative_elapsed_never_extends_the_upload_budget(self):
        self.assertAlmostEqual(self._cap(-100.0, finish=20.0), 20.0)


# ── C9-1: shutdown awaits the detached upload BEFORE arming the watchdog ───

class TestDetachedFinishWaitBeforeWatchdog(unittest.IsolatedAsyncioTestCase):
    async def _run(self, client, recorder_cls, *, finish_seconds, release_after=None,
                   release=None, teardown_max=0.2):
        """Drive the real `_run_phone_session` through the shared harness, with
        a ctx that HAS add_shutdown_callback (so the arm path is live) and a
        `parent_process` probe that records each arm attempt without arming."""
        callbacks: list = []

        class CtxWithShutdown(fixtures.FakeCtx):
            def add_shutdown_callback(self, callback):
                callbacks.append(callback)

        def parent_process_probe():
            client.timeline.append("watchdog_arm")
            return None  # never actually arm os._exit in a test

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            await kwargs["begin_recording_at_answer"]()
            raise RuntimeError("gate provider failed")

        helper = fixtures.TestPhoneSessionFlow(
            "test_the_LEASE_is_heartbeaten_for_the_whole_conversation"
        )
        helper.setUp()
        log = MagicMock()
        try:
            with patch.object(fixtures, "FakeCtx", CtxWithShutdown), \
                 patch.object(phone, "run_phone_gate", gate), \
                 patch.object(agent, "_log", log), \
                 patch.object(agent.multiprocessing, "parent_process", parent_process_probe), \
                 patch.object(agent, "PHONE_TEARDOWN_MAX_SECONDS", teardown_max), \
                 patch.object(agent, "PHONE_RECORDING_FINISH_SECONDS", finish_seconds), \
                 patch.object(agent.recording, "recording_provider", lambda: "worker"), \
                 patch.object(agent.recording, "InWorkerRecorder", recorder_cls), \
                 patch.object(agent.recording_api, "prepare_recording", AsyncMock(
                     return_value={"object_key": "phone/test.ogg", "upload_url": "https://put"},
                 )), \
                 patch.object(agent.recording_api, "fail_recording", AsyncMock()), \
                 patch.object(agent.recording_api, "complete_recording", AsyncMock()):
                if release_after is not None:
                    asyncio.get_running_loop().call_later(release_after, release.set)
                started = time.monotonic()
                with self.assertRaisesRegex(RuntimeError, "gate provider failed"):
                    await helper._run_session(client=client, close_after=False)
                elapsed = time.monotonic() - started
                # The SDK shutdown callback, after the body already waited.
                cb_started = time.monotonic()
                for callback in callbacks:
                    await callback("JOB_SHUTDOWN")
                cb_elapsed = time.monotonic() - cb_started
        finally:
            helper.doCleanups()
        return elapsed, cb_elapsed, log, callbacks

    @staticmethod
    def _recorder(client, release, state):
        class Recorder:
            def __init__(self, _session):
                self.active = False

            def wire(self):
                return True

            async def begin(self, *_args, **_kwargs):
                self.active = True
                return True

            async def finish(self, _url):
                self.active = False
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    state["cancelled"] = True
                    raise
                client.timeline.append("recording.uploaded")
                return types.SimpleNamespace(sha256="sha", size_bytes=3, duration_ms=7)

            async def audio_health_heartbeat(self):
                await asyncio.Event().wait()

        return Recorder

    @staticmethod
    def _categories(log):
        return [
            call.kwargs.get("error_category")
            for method in (log.info, log.warn)
            for call in method.call_args_list
        ]

    async def test_detached_upload_completes_before_the_watchdog_is_armed(self):
        client = fixtures.FakeEventClient()
        release = asyncio.Event()
        state = {"cancelled": False}
        elapsed, _cb, log, callbacks = await self._run(
            client, self._recorder(client, release, state),
            finish_seconds=3.0, release_after=0.3, release=release,
        )
        self.assertTrue(callbacks, "the shutdown callback must be registered")
        self.assertFalse(state["cancelled"], "the detached upload was cancelled")
        cats = self._categories(log)
        # It really was detached (teardown budget expired first) ...
        self.assertIn("recording_finish_detached", cats)
        # ... and the body then WAITED for it, before any arm attempt.
        self.assertIn("recording.uploaded", client.timeline)
        self.assertIn("watchdog_arm", client.timeline)
        self.assertLess(
            client.timeline.index("recording.uploaded"),
            client.timeline.index("watchdog_arm"),
            client.timeline,
        )
        self.assertIn("recording_finish_awaited", cats)
        self.assertNotIn("recording_finish_wait_expired", cats)
        # Bounded wall clock: released at 0.3 s, far inside the 3 s cap.
        self.assertGreaterEqual(elapsed, 0.25)
        self.assertLess(elapsed, 2.5)

    async def test_cap_expiry_arms_anyway_and_never_cancels(self):
        client = fixtures.FakeEventClient()
        release = asyncio.Event()
        state = {"cancelled": False}
        try:
            elapsed, cb_elapsed, log, _callbacks = await self._run(
                client, self._recorder(client, release, state),
                finish_seconds=0.4,
            )
            cats = self._categories(log)
            self.assertIn("recording_finish_detached", cats)
            self.assertIn("recording_finish_wait_expired", cats)
            self.assertIn("watchdog_arm", client.timeline)
            self.assertNotIn("recording.uploaded", client.timeline)
            self.assertFalse(state["cancelled"], "the capped wait cancelled the upload")
            # Bounded by the 0.4 s upload budget, not by the hung upload.
            self.assertLess(elapsed, 2.0)
            # Single-flight: the SDK shutdown callback reuses the SAME deadline,
            # so the three arm sites cannot stack their waits past the budget.
            self.assertLess(cb_elapsed, 0.3)
        finally:
            # Let the still-detached upload land so no task outlives the test;
            # it was never cancelled, so it completes normally.
            release.set()
            await asyncio.sleep(0.05)
        self.assertFalse(state["cancelled"])
        self.assertIn("recording.uploaded", client.timeline)

    async def test_no_detached_upload_means_no_wait(self):
        client = fixtures.FakeEventClient()
        release = asyncio.Event()
        release.set()  # finish returns at once: nothing is detached
        state = {"cancelled": False}
        # A normal teardown budget: the instant upload finishes inside it.
        elapsed, _cb, log, _callbacks = await self._run(
            client, self._recorder(client, release, state),
            finish_seconds=3.0, teardown_max=12.0,
        )
        cats = self._categories(log)
        self.assertNotIn("recording_finish_detached", cats)
        self.assertNotIn("recording_finish_awaited", cats)
        self.assertNotIn("recording_finish_wait_expired", cats)
        self.assertIn("watchdog_arm", client.timeline)
        self.assertLess(elapsed, 2.0)


# ── C9-3: room-delete classification inside the bounded coroutine ──────────

class _TwirpError(Exception):
    def __init__(self, code, status=404):
        super().__init__(f"twirp {code}")
        self.code = code
        self.status = status


class ServerDisconnectedError(Exception):
    """Same class NAME as aiohttp's, which is how the worker recognises it."""


class _SubclassedDisconnect(ServerDisconnectedError):
    pass


class TestRoomDeleteClassification(unittest.IsolatedAsyncioTestCase):
    async def _delete(self, error, *, with_twirp=True):
        client = MagicMock()
        client.room.delete_room = AsyncMock(side_effect=error)
        client.aclose = AsyncMock()
        api = types.SimpleNamespace(
            LiveKitAPI=lambda: client,
            DeleteRoomRequest=lambda room: {"room": room},
        )
        if with_twirp:
            api.TwirpError = _TwirpError
            api.TwirpErrorCode = types.SimpleNamespace(NOT_FOUND="not_found")
        log = MagicMock()
        with patch.object(agent, "livekit_api", api), patch.object(agent, "_log", log):
            await agent._delete_livekit_room("phone-room")
        client.room.delete_room.assert_awaited_once_with({"room": "phone-room"})
        client.aclose.assert_awaited_once()
        return log

    @staticmethod
    def _logged(log):
        return {
            ("info", c.kwargs.get("error_category")) for c in log.info.call_args_list
        } | {
            ("warn", c.kwargs.get("error_category")) for c in log.warn.call_args_list
        }

    async def test_success_logs_nothing(self):
        self.assertEqual(self._logged(await self._delete(None)), set())

    async def test_not_found_is_info_room_already_closed(self):
        logged = self._logged(await self._delete(_TwirpError("not_found")))
        self.assertEqual(logged, {("info", "room_already_closed")})

    async def test_not_found_without_sdk_names_falls_back_to_the_code(self):
        logged = self._logged(
            await self._delete(_TwirpError("not_found"), with_twirp=False),
        )
        self.assertEqual(logged, {("info", "room_already_closed")})

    async def test_server_disconnect_is_warn_room_delete_disconnected(self):
        for error in (ServerDisconnectedError("gone"), _SubclassedDisconnect("gone")):
            with self.subTest(error=type(error).__name__):
                logged = self._logged(await self._delete(error))
                self.assertEqual(logged, {("warn", "room_delete_disconnected")})

    async def test_any_other_error_is_still_room_delete_failed(self):
        for error in (_TwirpError("internal", status=500), RuntimeError("boom")):
            with self.subTest(error=repr(error)):
                logged = self._logged(await self._delete(error))
                self.assertEqual(logged, {("warn", "room_delete_failed")})

    async def test_a_non_twirp_error_with_a_not_found_code_is_not_swallowed(self):
        # When the SDK DOES export TwirpError, only a TwirpError may be
        # classified as already-closed; a look-alike stays a failure.
        class Other(Exception):
            code = "not_found"

        logged = self._logged(await self._delete(Other("x")))
        self.assertEqual(logged, {("warn", "room_delete_failed")})

    async def test_classification_happens_inside_the_bounded_coroutine(self):
        # The coroutine handed to `_bounded_await` must itself swallow the
        # NOT_FOUND: `_bounded_await` sees a clean return, never the error.
        seen = []
        real = agent._bounded_await

        async def spy(awaitable, timeout, *, category, deadline=None):
            async def wrapped():
                try:
                    return await awaitable
                except BaseException as exc:
                    seen.append((category, type(exc).__name__))
                    raise
            return await real(wrapped(), timeout, category=category, deadline=deadline)

        with patch.object(agent, "_bounded_await", spy):
            logged = self._logged(await self._delete(_TwirpError("not_found")))
        self.assertEqual(seen, [])
        self.assertEqual(logged, {("info", "room_already_closed")})

    async def test_a_hung_delete_is_still_bounded(self):
        client = MagicMock()

        async def hang(_req):
            await asyncio.Event().wait()

        client.room.delete_room = hang
        client.aclose = AsyncMock()
        api = types.SimpleNamespace(
            LiveKitAPI=lambda: client, DeleteRoomRequest=lambda room: room,
        )
        log = MagicMock()
        started = time.monotonic()
        with patch.object(agent, "livekit_api", api), \
             patch.object(agent, "_log", log), \
             patch.object(agent, "PHONE_TEARDOWN_STEP_SECONDS", 0.05):
            await agent._delete_livekit_room("phone-room")
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertIn(("warn", "room_delete_timeout"), self._logged(log))


if __name__ == "__main__":
    unittest.main()
