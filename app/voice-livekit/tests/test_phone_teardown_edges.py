"""Load-bearing phone teardown edge coverage.

This module deliberately drives ``_run_phone_session`` and the real
``run_phone_gate``.  The doubles are limited to the existing test fixtures and
to the worker's durable-I/O seams; assertions are made from those seams, not
from synthetic success markers.
"""

from __future__ import annotations

import asyncio
import multiprocessing
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from tests import test_phone_gate as fixtures


agent = fixtures.agent_mod
phone = fixtures.phone


class _Recorder:
    def __init__(self, _session):
        self.active = False
        self.begin_count = 0
        self.finish_count = 0
        self.discard_count = 0

    def wire(self):
        return True

    async def begin(self, *_args, **_kwargs):
        self.begin_count += 1
        self.active = True
        return True

    async def finish(self, _url):
        self.finish_count += 1
        self.active = False
        return SimpleNamespace(sha256="sha", size_bytes=3, duration_ms=7)

    async def discard(self):
        self.discard_count += 1
        self.active = False

    async def audio_health_heartbeat(self):
        await asyncio.Event().wait()


class _ExplodingTerminalClient(fixtures.FakeEventClient):
    def __init__(self, event_type):
        super().__init__()
        self.event_type = event_type

    async def post_event(self, attempt_id, event_type, **kwargs):
        if event_type == self.event_type:
            self.timeline.append(f"event:{event_type}:raised")
            raise RuntimeError("terminal transport failed")
        return await super().post_event(attempt_id, event_type, **kwargs)


class TestRealGateTeardownEdges(unittest.IsolatedAsyncioTestCase):
    async def _run_nonconsent(self, *, conversational=False, classifier=None,
                              terminal_event=None):
        fixtures._FakePhoneSession.instances = []
        client = _ExplodingTerminalClient(terminal_event)
        recorder_box = []

        def make_recorder(session):
            recorder = _Recorder(session)
            recorder_box.append(recorder)
            return recorder

        async def prepare(*_args):
            return {"object_key": "phone/test.ogg", "upload_url": "https://put"}

        real_gate = phone.run_phone_gate
        identity_replies = iter(["No, this is her father.", "No, she is not here."])

        async def next_identity_reply():
            # Model asynchronous STT arrival, without relying on this SDK
            # double's unrelated native-screening response generator.
            await asyncio.sleep(0)
            return next(identity_replies)

        async def gate_with_stt(**kwargs):
            if conversational:
                kwargs["next_candidate_turn"] = next_identity_reply
                kwargs["speak_gate_line"] = None
            return await real_gate(**kwargs)

        env = {
            "PHONE_GATE_FLOW": "conversational" if conversational else "deterministic",
            "PHONE_DETERMINISTIC_OPENER": "true",
            "PHONE_IDENTITY_MISMATCH_SUPPRESSES": "false",
        }
        with patch.dict(phone.os.environ, env, clear=False), \
             patch.object(agent, "AgentSession", fixtures._FakePhoneSession), \
             patch.object(agent, "persistence", MagicMock()), \
             patch.object(agent, "_delete_livekit_room", new_callable=AsyncMock), \
             patch.object(agent.recording, "recording_provider", lambda: "worker"), \
             patch.object(agent.recording, "InWorkerRecorder", make_recorder), \
             patch.object(agent.recording_api, "prepare_recording", prepare), \
             patch.object(agent.recording_api, "fail_recording", AsyncMock(return_value=True)) as failed, \
             patch.object(agent, "SESSION_MAX_RESIDENCY_SEC", 1.0), \
             patch.object(phone, "run_phone_gate", gate_with_stt), \
             patch.object(phone, "phone_classify_identity", AsyncMock(return_value=phone.PHONE_IDENTITY_OTHER)) as identity:
            if conversational:
                fixtures._FakePhoneSession.default_gate_user_turns = [
                    "No, this is her father.",
                    "No, she is not here.",
                    "No, this is her father.",
                    "No, she is not here.",
                ]
            try:
                ctx = fixtures.FakeCtx(
                    fixtures._PHONE_ROOM,
                    participants=[fixtures._participant()],
                )
                task = asyncio.create_task(agent._run_phone_session(
                    ctx, fixtures._PHONE_ROOM, fixtures._ATTEMPT_ID,
                    fixtures._EPOCH, client=client, classifier=classifier,
                ))
                try:
                    result = await asyncio.wait_for(task, timeout=3.0)
                except RuntimeError as exc:
                    # The real gate propagates a terminal transport failure
                    # after teardown has settled the durable evidence.
                    self.assertEqual(str(exc), "terminal transport failed")
                    result = phone.PhoneGateResult(phone.GATE_FAILED)
            finally:
                fixtures._FakePhoneSession.default_gate_user_turns = []

        if conversational:
            self.assertEqual(identity.await_count, 2)
        failed.assert_awaited_once_with(
            fixtures._ATTEMPT_ID, fixtures._SESSION_ID, "discarded_not_the_candidate",
        )
        self.assertIsNotNone(result)
        self.assertTrue(recorder_box)
        return result, client, recorder_box[0]

    async def test_real_wrong_number_terminal_failure_discards_once_and_writes_no_gate(self):
        async def classify(_turns, _say):
            return phone.CLASSIFY_WRONG_NUMBER

        result, client, recorder = await self._run_nonconsent(
            classifier=classify, terminal_event="candidate.wrong_number",
        )
        # The terminal transport exception is intentionally propagated by the
        # real session after its finally/coordinator path has settled privacy.
        self.assertEqual(result.outcome, phone.GATE_FAILED)
        self.assertEqual(recorder.discard_count, 1)
        self.assertEqual(recorder.finish_count, 0)
        self.assertEqual(client.item_turns, [])
        self.assertFalse(any("recording" in item for item in client.timeline))

    async def test_real_confirmed_identity_mismatch_terminal_failure_discards_once(self):
        result, client, recorder = await self._run_nonconsent(
            conversational=True,
            terminal_event="candidate.deferred_pre_disclosure",
        )
        self.assertEqual(result.outcome, phone.GATE_FAILED)
        self.assertIn("event:candidate.deferred_pre_disclosure:raised", client.timeline)
        self.assertEqual(recorder.discard_count, 1)
        self.assertEqual(recorder.finish_count, 0)
        self.assertEqual(client.item_turns, [])

    async def test_sdk_close_while_gate_awaits_speech_settles_preconsent_once(self):
        fixtures._FakePhoneSession.instances = []
        close_started = asyncio.Event()
        client = fixtures.FakeEventClient()

        class Session(fixtures._FakePhoneSession):
            async def _aclose_impl(self, *_args, **_kwargs):
                close_started.set()
                await asyncio.Event().wait()

        async def gate(**kwargs):
            await kwargs["wait_for_participant"]()
            await kwargs["say"]("gate speech")
            await asyncio.Event().wait()

        async def run():
            ctx = fixtures.FakeCtx(fixtures._PHONE_ROOM,
                                   participants=[fixtures._participant()])
            with patch.object(agent, "AgentSession", Session), \
                 patch.object(agent, "persistence", MagicMock()), \
                 patch.object(agent, "_delete_livekit_room", new_callable=AsyncMock), \
                 patch.object(phone, "run_phone_gate", gate), \
                 patch.object(agent, "PHONE_SHUTDOWN_WATCHDOG_SECONDS", 0.02), \
                 patch.object(agent, "PHONE_TEARDOWN_STEP_SECONDS", 0.01), \
                 patch.object(agent, "PHONE_TEARDOWN_MAX_SECONDS", 0.2), \
                 patch.object(agent, "SESSION_MAX_RESIDENCY_SEC", 0.2):
                task = asyncio.create_task(agent._run_phone_session(
                    ctx, fixtures._PHONE_ROOM, fixtures._ATTEMPT_ID,
                    fixtures._EPOCH, client=client,
                ))
                await asyncio.sleep(0.02)
                session = fixtures._FakePhoneSession.instances[-1]
                await asyncio.wait_for(session._aclose_impl(), timeout=0.5)
                await asyncio.wait_for(task, timeout=0.5)
                return client, close_started.is_set()

        client, started = await run()
        self.assertTrue(started)
        self.assertIn("candidate.deferred_pre_disclosure", client.event_types)
        self.assertEqual(client.event_types.count("candidate.deferred_pre_disclosure"), 1)


class TestQueuedScoringTeardownEdges(unittest.IsolatedAsyncioTestCase):
    async def test_pending_scoring_has_evidence_and_room_close_before_first_hold_post(self):
        helper = fixtures.TestPhoneSessionFlow(
            "test_queue_owned_scoring_holds_the_lease_and_posts_terminal"
        )
        helper.setUp()
        try:
            client = fixtures.FakeEventClient(
                complete=phone.PhoneApiOutcome(False, phone.ASSESSMENT_QUEUED_STATUS)
            )
            with patch.object(phone, "PHONE_QUEUED_SCORING_POLL_SEC", 0.01), \
                 patch.dict(phone.os.environ, {"PHONE_QUEUED_SCORING_HOLD_SEC": "0.2"}):
                _, client, _, delete, _, _ = await helper._run_session(
                    answers=("Yes, that's fine.",), client=client,
                )
            first_hold_post = client.timeline.index("event:assessment.completed")
            self.assertTrue(delete.await_count >= 1)
            self.assertLess(client.timeline.index("room.delete"), first_hold_post)
            self.assertGreaterEqual(len(client.heartbeats), 1)
        finally:
            helper.doCleanups()

    async def test_lease_loss_during_pending_hold_never_posts_stale_completion(self):
        class LeaseLostClient(fixtures.FakeEventClient):
            def __init__(self):
                super().__init__(complete=phone.PhoneApiOutcome(
                    False, phone.ASSESSMENT_QUEUED_STATUS,
                ))
                self.hold_started = asyncio.Event()
                hold_started = self.hold_started

                class Timeline(list):
                    def append(self, event):
                        super().append(event)
                        if event == "room.delete":
                            # Queued scoring closes PSTN before the first
                            # hold sleep. Deliver lease loss in that sleep,
                            # not AFTER completion has already been posted.
                            hold_started.set()

                self.timeline = Timeline()

            async def heartbeat_attempt(self, *args, **kwargs):
                await self.hold_started.wait()
                return phone.PhoneApiOutcome(False, phone.HEARTBEAT_LEASE_LOST_STATUS)

        helper = fixtures.TestPhoneSessionFlow(
            "test_queue_owned_scoring_holds_the_lease_and_posts_terminal"
        )
        helper.setUp()
        try:
            client = LeaseLostClient()
            with patch.object(phone, "PHONE_QUEUED_SCORING_POLL_SEC", 0.05), \
                 patch.dict(phone.os.environ, {"PHONE_QUEUED_SCORING_HOLD_SEC": "0.2"}):
                _, client, *_ = await helper._run_session(
                    answers=("Yes, that's fine.",), client=client,
                )
            self.assertTrue(client.hold_started.is_set())
            self.assertNotIn("assessment.completed", client.event_types)
        finally:
            helper.doCleanups()


def _stubborn_child(conn):
    """Exercise the real coordinator with a cancellation-suppressing SDK close."""
    import asyncio as aio
    from unittest.mock import AsyncMock as ChildAsyncMock, MagicMock as ChildMagicMock, patch as child_patch
    import agent as child_agent

    class Session(fixtures._FakePhoneSession):
        async def _aclose_impl(self, *_args, **_kwargs):
            conn.send("close_started")
            while True:
                try:
                    await aio.Event().wait()
                except aio.CancelledError:
                    continue

    async def gate(**kwargs):
        await kwargs["wait_for_participant"]()
        await kwargs["say"]("gate speech")
        await aio.Event().wait()

    async def run():
        ctx = fixtures.FakeCtx(fixtures._PHONE_ROOM,
                               participants=[fixtures._participant()])
        client = fixtures.FakeEventClient()
        ctx.add_shutdown_callback = lambda callback: None
        with child_patch.object(child_agent, "AgentSession", Session), \
             child_patch.object(child_agent, "persistence", ChildMagicMock()), \
             child_patch.object(child_agent, "_delete_livekit_room", ChildAsyncMock()), \
             child_patch.object(child_agent.phone, "run_phone_gate", gate), \
             child_patch.object(child_agent, "PHONE_SHUTDOWN_WATCHDOG_SECONDS", 0.02), \
             child_patch.object(child_agent, "PHONE_TEARDOWN_STEP_SECONDS", 0.01), \
             child_patch.object(child_agent, "PHONE_TEARDOWN_MAX_SECONDS", 0.1), \
             child_patch.object(child_agent, "SESSION_MAX_RESIDENCY_SEC", 0.1):
            task = aio.create_task(child_agent._run_phone_session(
                ctx, fixtures._PHONE_ROOM, fixtures._ATTEMPT_ID,
                fixtures._EPOCH, client=client,
            ))
            await aio.sleep(0.02)
            for _ in range(100):
                if (Session.instances and
                        getattr(Session.instances[-1], "_phone_teardown_guarded", False)):
                    break
                await aio.sleep(0.001)
            session = Session.instances[-1]
            if not getattr(session, "_phone_teardown_guarded", False):
                raise AssertionError("production SDK close guard was not installed")
            await session._aclose_impl()
            await task
            conn.send("session_returned")

    aio.run(run())
    conn.close()


class TestChildBoundedClose(unittest.TestCase):
    def test_cancellation_suppressing_close_cannot_leave_orphan_process(self):
        context = multiprocessing.get_context("fork")
        parent, child = context.Pipe(duplex=False)
        process = context.Process(target=_stubborn_child, args=(child,))
        process.start()
        process.join(1.0)
        try:
            self.assertFalse(process.is_alive())
            self.assertEqual(process.exitcode, 0)
            messages = []
            while parent.poll():
                messages.append(parent.recv())
            self.assertIn("session_returned", messages)
        finally:
            parent.close()
            child.close()
            if process.is_alive():
                process.terminate()
                process.join()


if __name__ == "__main__":
    unittest.main()
