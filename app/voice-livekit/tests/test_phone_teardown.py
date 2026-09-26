"""Focused production-seam tests for phone evidence teardown.

These use the same session and API doubles as ``test_phone_gate`` but drive
``_run_phone_session`` itself. They intentionally do not call a cleanup helper
in isolation for the ordering assertions.
"""

from __future__ import annotations

import asyncio
import multiprocessing
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from tests import test_phone_gate as fixtures


agent = fixtures.agent_mod
phone = fixtures.phone


class TestPhoneEvidenceTeardown(unittest.IsolatedAsyncioTestCase):
    async def _run_session(self, **kwargs):
        helper = fixtures.TestPhoneSessionFlow(
            "test_the_LEASE_is_heartbeaten_for_the_whole_conversation"
        )
        helper.setUp()
        try:
            return await helper._run_session(**kwargs)
        finally:
            helper.doCleanups()

    async def test_generic_gate_failure_settles_before_terminal_and_room_close(self):
        client = fixtures.FakeEventClient()

        class Recorder:
            def __init__(self, _session):
                self.active = False

            def wire(self):
                return True

            async def begin(self, *_args, **_kwargs):
                self.active = True
                client.timeline.append("recording.begun")
                return True

            async def finish(self, _url):
                self.active = False
                client.timeline.append("recording.uploaded")
                return type("Manifest", (), {
                    "sha256": "sha", "size_bytes": 3, "duration_ms": 7,
                })()

            async def audio_health_heartbeat(self):
                await asyncio.Event().wait()

        async def prepare(*_args):
            return {"object_key": "phone/test.ogg", "upload_url": "https://put"}

        async def complete(*_args, **_kwargs):
            client.timeline.append("recording.completed")

        async def broken_gate(**kwargs):
            await kwargs["wait_for_participant"]()
            await kwargs["begin_recording_at_answer"]()
            raise RuntimeError("gate provider failed")

        with patch.object(phone, "run_phone_gate", broken_gate), \
             patch.object(agent.recording, "recording_provider", lambda: "worker"), \
             patch.object(agent.recording, "InWorkerRecorder", Recorder), \
             patch.object(agent.recording_api, "prepare_recording", prepare), \
             patch.object(agent.recording_api, "complete_recording", complete):
            with self.assertRaisesRegex(RuntimeError, "gate provider failed"):
                await self._run_session(client=client, close_after=False)

        self.assertIn("event:consent.failed", client.timeline)
        self.assertLess(
            client.timeline.index("recording.completed"),
            client.timeline.index("event:consent.failed"),
        )
        self.assertLess(
            client.timeline.index("event:consent.failed"),
            client.timeline.index("room.delete"),
        )

    async def test_gate_cancellation_runs_settlement_without_stale_terminal(self):
        client = fixtures.FakeEventClient()
        recorder = MagicMock(active=False)
        recorder.wire.return_value = True

        async def begin(*_args, **_kwargs):
            recorder.active = True
            return True

        recorder.begin = AsyncMock(side_effect=begin)
        recorder.finish = AsyncMock(return_value=type("Manifest", (), {
            "sha256": "sha", "size_bytes": 3, "duration_ms": 7,
        })())
        recorder.audio_health_heartbeat = AsyncMock()
        complete = AsyncMock()

        async def cancelled_gate(**kwargs):
            await kwargs["wait_for_participant"]()
            await kwargs["begin_recording_at_answer"]()
            raise asyncio.CancelledError

        with patch.object(phone, "run_phone_gate", cancelled_gate), \
             patch.object(agent.recording, "recording_provider", lambda: "worker"), \
             patch.object(agent.recording, "InWorkerRecorder", lambda _s: recorder), \
             patch.object(agent.recording_api, "prepare_recording", AsyncMock(
                 return_value={"object_key": "phone/test.ogg", "upload_url": "https://put"},
             )), \
             patch.object(agent.recording_api, "complete_recording", complete):
            with self.assertRaises(asyncio.CancelledError):
                await self._run_session(client=client, close_after=False)

        recorder.begin.assert_awaited_once()
        recorder.finish.assert_awaited_once_with("https://put")
        complete.assert_awaited_once()
        self.assertIn("room.delete", client.timeline)
        self.assertFalse(
            any(item.startswith("event:") for item in client.timeline),
            client.timeline,
        )

    async def test_post_consent_exception_posts_aborted_before_room_close(self):
        client = fixtures.FakeEventClient(start=RuntimeError("screen failed"))
        with self.assertRaisesRegex(RuntimeError, "screen failed"):
            await self._run_session(
                client=client, answers=("Yes, that's fine.",), close_after=False,
            )
        self.assertIn("assessment.aborted", client.event_types)
        self.assertNotIn("assessment.completed", client.event_types)

    async def test_gate_wrong_number_latches_privacy_before_terminal_api_failure(self):
        """The real gate callback must mark the stranger before post_event."""
        lifecycle: dict[str, bool] = {}

        class Client:
            async def post_event(self, _attempt, event_type, **_kwargs):
                if event_type == "candidate.wrong_number":
                    raise RuntimeError("terminal transport failed")
                return phone.PhoneApiOutcome(
                    ok=True, status=phone.EVENT_STATUS_APPLIED,
                )

        async def classify():
            return phone.CLASSIFY_WRONG_NUMBER

        with patch.dict(agent.os.environ, {"PHONE_DETERMINISTIC_OPENER": "true"}):
            with self.assertRaisesRegex(RuntimeError, "terminal transport failed"):
                await phone.run_phone_gate(
                    attempt_id="attempt",
                    client=Client(),
                    wait_for_participant=lambda: asyncio.sleep(0, result=object()),
                    classify=classify,
                    say=lambda _text: asyncio.sleep(0),
                    gate_phase_out=lifecycle,
                )
        self.assertTrue(lifecycle.get("not_the_candidate"))

    async def test_bounded_await_detaches_cancellation_suppressing_close(self):
        cancelled = asyncio.Event()

        async def wedged_close():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                return None

        started = time.monotonic()
        await agent._bounded_await(wedged_close(), 0.01, category="test_close")
        await asyncio.sleep(0)
        elapsed = time.monotonic() - started
        self.assertTrue(cancelled.is_set())
        self.assertLess(elapsed, 0.5)

    async def test_answer_begin_race_cannot_start_after_wrong_number_settlement(self):
        """Drive the answer-begin callback and wrong-number teardown together."""
        ctx = fixtures.FakeCtx(
            fixtures._PHONE_ROOM, participants=[fixtures._participant()]
        )
        client = fixtures.FakeEventClient()
        prepare_started = asyncio.Event()
        release_prepare = asyncio.Event()

        class Recorder:
            def __init__(self, _session):
                self.active = False
                self.begun = False
                self.discarded = False

            def wire(self):
                return True

            async def begin(self, *_args, **_kwargs):
                self.begun = True
                self.active = True
                return True

            async def discard(self):
                self.discarded = True
                self.active = False

            async def finish(self, _url):
                self.active = False
                return None

            async def audio_health_heartbeat(self):
                await asyncio.Event().wait()

        recorder = None

        def make_recorder(session):
            nonlocal recorder
            recorder = Recorder(session)
            return recorder

        async def prepare(_attempt, _session):
            prepare_started.set()
            try:
                await release_prepare.wait()
            except asyncio.CancelledError:
                # A provider/API layer that suppresses cancellation can still
                # return a URL after teardown began; the post-prepare guard is
                # what prevents begin() from leaking stranger audio.
                await release_prepare.wait()
            return {"object_key": "phone/test.ogg", "upload_url": "https://put"}

        async def wrong_number_gate(**kwargs):
            await kwargs["wait_for_participant"]()
            asyncio.create_task(kwargs["begin_recording_at_answer"]())
            await prepare_started.wait()
            result = phone.PhoneGateResult(phone.CLASSIFY_WRONG_NUMBER)
            result.not_the_candidate = True
            return result

        with patch.object(agent, "AgentSession", fixtures._FakePhoneSession), \
             patch.object(agent, "persistence", MagicMock()), \
             patch.object(agent, "_delete_livekit_room", new_callable=AsyncMock), \
             patch.object(agent.recording, "recording_provider", lambda: "worker"), \
             patch.object(agent.recording, "InWorkerRecorder", make_recorder), \
             patch.object(agent.recording_api, "prepare_recording", prepare), \
             patch.object(phone, "run_phone_gate", wrong_number_gate), \
             patch.object(agent, "PHONE_TEARDOWN_STEP_SECONDS", 0.01), \
             patch.object(agent, "PHONE_TEARDOWN_MAX_SECONDS", 0.1), \
             patch.object(agent, "SESSION_MAX_RESIDENCY_SEC", fixtures._HARNESS_RESIDENCY_SEC):
            task = asyncio.create_task(
                agent._run_phone_session(
                    ctx, fixtures._PHONE_ROOM, fixtures._ATTEMPT_ID,
                    fixtures._EPOCH, client=client,
                )
            )
            await asyncio.wait_for(task, timeout=1.0)
            release_prepare.set()
            await asyncio.sleep(0.02)

        self.assertIsNotNone(recorder)
        self.assertFalse(recorder.begun)


def _child_real_phone_job(conn):
    """Forked production seam: real session teardown, fake durable I/O only."""
    import types
    from unittest.mock import AsyncMock, MagicMock, patch
    import agent as child_agent
    import recording as child_recording

    class ChildCtx(fixtures.FakeCtx):
        def __init__(self):
            super().__init__(
                fixtures._PHONE_ROOM, participants=[fixtures._participant()]
            )
            self.shutdown_callbacks = []

        def add_shutdown_callback(self, callback):
            self.shutdown_callbacks.append(callback)
            conn.send("shutdown_callback_registered")

    class ChildClient(fixtures.FakeEventClient):
        async def post_event(self, *args, **kwargs):
            outcome = await super().post_event(*args, **kwargs)
            conn.send(f"event:{args[1]}")
            return outcome

    class ChildRecorder:
        def __init__(self, _session):
            self.active = False

        def wire(self):
            return True

        async def begin(self, *_args, **_kwargs):
            self.active = True
            conn.send("recording_begun")
            return True

        async def finish(self, _url):
            self.active = False
            conn.send("recording_uploaded")
            return types.SimpleNamespace(
                sha256="sha", size_bytes=3, duration_ms=7,
            )

        async def discard(self):
            self.active = False
            conn.send("recording_discarded")

        async def audio_health_heartbeat(self):
            await asyncio.Event().wait()

    class ChildSession(fixtures._FakePhoneSession):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)

        async def _aclose_impl(self, *_args, **_kwargs):
            # A genuinely stubborn close: every cancellation is suppressed and
            # the task keeps waiting forever until the process watchdog wins.
            while True:
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    continue

    async def prepare(*_args):
        conn.send("recording_prepared")
        return {"object_key": "phone/test.ogg", "upload_url": "https://put"}

    async def complete(*_args, **_kwargs):
        conn.send("recording_completed")
        return None

    async def broken_gate(**kwargs):
        await kwargs["wait_for_participant"]()
        await kwargs["begin_recording_at_answer"]()
        # Start the real SDK close while the production gate task is still
        # awaiting. The guard must cancel/coordinate this gate before taking
        # ownership of teardown; closing only after _run_phone_session returns
        # would miss the single-flight race.
        session = ChildSession.instances[-1]
        asyncio.create_task(session._aclose_impl())
        await asyncio.Event().wait()

    async def run():
        ctx = ChildCtx()
        client = ChildClient()
        with patch.object(child_agent, "AgentSession", ChildSession), \
             patch.object(child_agent, "persistence", MagicMock()), \
             patch.object(child_agent.recording, "recording_provider", lambda: "worker"), \
             patch.object(child_agent.recording, "InWorkerRecorder", ChildRecorder), \
             patch.object(child_agent.recording_api, "prepare_recording", prepare), \
             patch.object(child_agent.recording_api, "complete_recording", complete), \
             patch.object(child_agent, "_delete_livekit_room", AsyncMock(
                 side_effect=lambda _room: conn.send("room_deleted")
             )), \
             patch.object(child_agent.phone, "run_phone_gate", broken_gate), \
             patch.object(child_agent, "PHONE_SHUTDOWN_WATCHDOG_SECONDS", 0.02), \
             patch.object(child_agent, "SESSION_MAX_RESIDENCY_SEC", 0.2):
            await child_agent._run_phone_session(
                ctx, fixtures._PHONE_ROOM, fixtures._ATTEMPT_ID,
                fixtures._EPOCH, client=client,
            )
            session = fixtures._FakePhoneSession.instances[-1]
            if not getattr(session, "_phone_teardown_guarded", False):
                raise AssertionError("production SDK close guard was not installed")
            conn.send("sdk_guard_installed")
            # The close was initiated by broken_gate while the real gate was
            # active; this second invocation is intentionally absent.
            conn.send("sdk_aclose_returned")
            for callback in ctx.shutdown_callbacks:
                await callback("JOB_SHUTDOWN")
            await asyncio.sleep(0.1)

    asyncio.run(run())
    conn.close()


class TestPhoneChildBound(unittest.TestCase):
    def test_child_exits_after_evidence_before_wedged_sdk_close(self):
        ctx = multiprocessing.get_context("fork")
        parent, child = ctx.Pipe(duplex=False)
        process = ctx.Process(target=_child_real_phone_job, args=(child,))
        started = time.monotonic()
        process.start()
        process.join(1.0)
        elapsed = time.monotonic() - started
        try:
            self.assertFalse(process.is_alive())
            self.assertEqual(process.exitcode, 0)
            events = []
            while parent.poll():
                events.append(parent.recv())
            self.assertIn("recording_uploaded", events)
            self.assertIn("recording_completed", events)
            # SDK close interrupted the gate before consent was durable, so
            # participant-left is the truthful terminal for this race.
            self.assertIn("event:candidate.deferred_pre_disclosure", events)
            self.assertIn("room_deleted", events)
            self.assertIn("sdk_aclose_returned", events)
            self.assertIn("sdk_guard_installed", events)
            self.assertIn("shutdown_callback_registered", events)
            self.assertLess(
                events.index("recording_uploaded"),
                events.index("event:candidate.deferred_pre_disclosure"),
            )
            self.assertLess(
                events.index("event:candidate.deferred_pre_disclosure"),
                events.index("room_deleted"),
            )
            self.assertLess(elapsed, 1.0)
        finally:
            parent.close()
            child.close()
            if process.is_alive():
                process.terminate()
                process.join()


if __name__ == "__main__":
    unittest.main()
