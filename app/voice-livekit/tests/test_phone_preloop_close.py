"""M009 C4 (W1): a resumed leg that hangs up before / during the pre-loop lines.

Fly d8d9564b50e908, room phone-e5f260c9: gate_resumed_consent, then a
CLIENT_INITIATED close, then `RuntimeError("AgentSession isn't running")` out of
the raw Q1 `session.say` (agent.py:7162) and "job crashed". The silence task and
watchdog were never cancelled and the non-terminal `disconnect` branch never ran.

Two layers are pinned here, against the shared doubles in ``test_phone_gate``:

* the GUARDED pre-loop speech in ``_run_native_phone_screening`` (role opening
  and Q1): a line that cannot be heard ends the pre-loop as a non-terminal
  ``disconnect`` (room preserved, nothing posted), and a non-marker error still
  propagates;
* the RUN-LEVEL backstop in ``_run_phone_session``: a participant-gone signal
  escaping the screening posts nothing, sets no gate error and requests no room
  close, while any other RuntimeError keeps the generic body; and the adoption /
  recovered closing ``say`` no longer costs the completion post.

No candidate data appears anywhere.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from tests import test_phone_gate as fixtures


agent_mod = fixtures.agent_mod
phone = fixtures.phone

_ROLE = "Sales Program Advisor"
_STOPPED = "AgentSession isn't running"


def _state(*, exhausted=False, role_title=_ROLE):
    """`exhausted` = the resumed cursor is already past the last question, the
    "empty plan" shape `question_at(cursor) is None` (a literally empty plan is
    refused as malformed by `PhoneAssessmentState.parse`)."""
    payload = (
        fixtures._plan_payload(cursor=2, completed=["k1", "k2"], role_title=role_title)
        if exhausted else fixtures._plan_payload(role_title=role_title)
    )
    state = phone.PhoneAssessmentState.parse(payload)
    assert state.ok, state.status
    return state


class _PreloopSession(fixtures._InertSession):
    """Inert session whose `say` (or its playout) drops on chosen lines.

    `drop_say` / `drop_playout` are predicates on the spoken text. `error`
    is the RuntimeError message raised (the SDK marker by default).
    `close_on_say` sets the coordinator's close_event while a line plays,
    the shape of a CLIENT_INITIATED close that lands mid-playout.
    """

    def __init__(self, *, drop_say=None, drop_playout=None, error=_STOPPED,
                 close_on_say=None):
        super().__init__()
        self.drop_say = drop_say or (lambda _t: False)
        self.drop_playout = drop_playout or (lambda _t: False)
        self.error = error
        self.close_on_say = close_on_say or (lambda _t: False)
        self.close_event: asyncio.Event | None = None

    def say(self, text, **kwargs):
        self.spoken.append(text)
        self.say_calls.append({"text": text, **kwargs})
        if self.drop_say(text):
            raise RuntimeError(self.error)
        if self.close_on_say(text) and self.close_event is not None:
            self.close_event.set()
        error = self.error
        drops = self.drop_playout(text)

        class _Handle:
            interrupted = False

            async def wait_for_playout(self_inner):
                if drops:
                    raise RuntimeError(error)
                return None

        return _Handle()


class _NativeHarness:
    """Run a REAL `_run_native_phone_screening` to completion."""

    def __init__(self, session, *, state, role_opening_spoken=False,
                 close_preset=False):
        self.session = session
        self.state = state
        self.client = fixtures.FakeEventClient()
        self.close_event = asyncio.Event()
        session.close_event = self.close_event
        if close_preset:
            self.close_event.set()
        self.latest_assistant: list = [None]
        self.assistant_delivery_complete = asyncio.Event()
        self.result = phone.PhoneGateResult(
            phone.CLASSIFY_HUMAN, assessment_allowed=True,
            role_opening_spoken=role_opening_spoken,
        )
        self.rephrase = AsyncMock(side_effect=lambda text, **_k: text)
        self.close_room = AsyncMock()
        self.agent = None

    async def run(self):
        class BaseAgent:
            def __init__(self, instructions=""):
                self.instructions = instructions

        self.agent = phone.phone_agent_class(BaseAgent)(
            "instructions", client=fixtures.FakeEventClient(),
            attempt_id=fixtures._ATTEMPT_ID, say=AsyncMock(), native_turns=True,
        )
        self.log = MagicMock(wraps=agent_mod._log)
        with patch.object(agent_mod, "_log", self.log), \
             patch.object(phone, "phone_rephrase_first_question", self.rephrase), \
             patch.object(agent_mod, "_delete_livekit_room", new_callable=AsyncMock), \
             patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC", 0.3):
            return await asyncio.wait_for(
                agent_mod._run_native_phone_screening(
                    session=self.session, agent=self.agent, events=self.client,
                    state=self.state, attempt_id=fixtures._ATTEMPT_ID,
                    session_id=fixtures._SESSION_ID, room_name=fixtures._PHONE_ROOM,
                    result=self.result,
                    latest_assistant=self.latest_assistant,
                    latest_assistant_anchor=[None],
                    latest_candidate_anchor=[None],
                    candidate_end_requested=asyncio.Event(),
                    reply_started=asyncio.Event(),
                    speech_first_audio=asyncio.Event(),
                    speech_sequence=[0], reply_handle=[None],
                    assistant_delivery_complete=self.assistant_delivery_complete,
                    candidate_activity=asyncio.Event(),
                    agent_listening=asyncio.Event(),
                    agent_activity_changed=asyncio.Event(),
                    close_event=self.close_event,
                    close_room=self.close_room,
                ),
                timeout=5,
            )

    @property
    def terminal_reason(self):
        return getattr(self.agent, "_native_terminal_reason", {}).get("reason")

    def logged(self, error_type, category=None):
        for call in self.log.info.call_args_list + self.log.warn.call_args_list:
            if call.kwargs.get("error_type") != error_type:
                continue
            if category is None or call.kwargs.get("error_category") == category:
                return True
        return False


class TestGuardedPreloopSpeech(unittest.IsolatedAsyncioTestCase):
    """C4 items 1-2: `_speak_preloop` and `_is_sdk_session_stopped`."""

    def _assert_nonterminal_disconnect(self, h, result):
        self.assertIs(result, h.result)
        self.assertEqual(h.terminal_reason, "disconnect")
        self.assertTrue(h.logged("phone_session_terminal", "disconnect_nonterminal"))
        self.assertTrue(h.logged("phone_room_preserved", "disconnect"))
        # Non-terminal: nothing posted, the room is the reconnect path's.
        self.assertEqual(h.client.event_types, [])
        h.close_room.assert_not_awaited()

    async def test_role_opening_say_drop_is_a_disconnect_and_skips_the_question(self):
        session = _PreloopSession(drop_say=lambda t: _ROLE in t)
        h = _NativeHarness(session, state=_state())
        result = await h.run()
        self._assert_nonterminal_disconnect(h, result)
        h.rephrase.assert_not_awaited()
        self.assertEqual(len(session.spoken), 1)  # the role opening only
        self.assertIsNone(h.latest_assistant[0])
        self.assertTrue(h.logged("phone_say_after_close", "preloop_role_opening"))

    async def test_role_opening_playout_drop_is_a_disconnect(self):
        session = _PreloopSession(drop_playout=lambda t: _ROLE in t)
        h = _NativeHarness(session, state=_state())
        result = await h.run()
        self._assert_nonterminal_disconnect(h, result)
        h.rephrase.assert_not_awaited()

    async def test_close_during_the_role_opening_skips_the_rephrase(self):
        # The SDK closed under the playout without raising: the line was not
        # heard, so the rephrase LLM call is never spent on nobody.
        session = _PreloopSession(close_on_say=lambda t: _ROLE in t)
        h = _NativeHarness(session, state=_state())
        result = await h.run()
        self._assert_nonterminal_disconnect(h, result)
        h.rephrase.assert_not_awaited()

    async def test_empty_plan_plus_role_opening_drop_is_NOT_completed(self):
        session = _PreloopSession(drop_say=lambda t: _ROLE in t)
        h = _NativeHarness(session, state=_state(exhausted=True))
        result = await h.run()
        self._assert_nonterminal_disconnect(h, result)

    async def test_empty_plan_without_a_drop_still_completes(self):
        session = _PreloopSession()
        h = _NativeHarness(session, state=_state(exhausted=True))
        await h.run()
        self.assertEqual(h.terminal_reason, "completed")

    async def test_close_before_the_opening_speaks_nothing(self):
        session = _PreloopSession()
        h = _NativeHarness(session, state=_state(), close_preset=True)
        result = await h.run()
        self._assert_nonterminal_disconnect(h, result)
        self.assertEqual(session.spoken, [])
        h.rephrase.assert_not_awaited()

    async def test_close_before_the_rephrase_with_no_role_line(self):
        session = _PreloopSession()
        h = _NativeHarness(
            session, state=_state(role_title=None), close_preset=True,
        )
        result = await h.run()
        self._assert_nonterminal_disconnect(h, result)
        h.rephrase.assert_not_awaited()
        self.assertEqual(session.spoken, [])

    async def test_q1_say_drop_is_a_disconnect_and_skips_F0a(self):
        session = _PreloopSession(drop_say=lambda t: t == "First question?")
        h = _NativeHarness(session, state=_state(), role_opening_spoken=True)
        result = await h.run()
        self._assert_nonterminal_disconnect(h, result)
        h.rephrase.assert_awaited_once()
        # F0a never primed the turn tracking with an ask nobody heard.
        self.assertIsNone(h.latest_assistant[0])
        self.assertFalse(h.assistant_delivery_complete.is_set())
        self.assertTrue(h.logged("phone_say_after_close", "preloop_q1"))

    async def test_q1_playout_drop_is_a_disconnect(self):
        session = _PreloopSession(drop_playout=lambda t: t == "First question?")
        h = _NativeHarness(session, state=_state())
        result = await h.run()
        self._assert_nonterminal_disconnect(h, result)
        self.assertIsNone(h.latest_assistant[0])

    async def test_a_non_marker_error_still_propagates(self):
        for where in ("say", "playout"):
            with self.subTest(where=where):
                pick = (lambda t: t == "First question?")
                session = _PreloopSession(
                    drop_say=pick if where == "say" else None,
                    drop_playout=pick if where == "playout" else None,
                    error="event loop is closed",
                )
                h = _NativeHarness(session, state=_state(), role_opening_spoken=True)
                with self.assertRaises(RuntimeError) as caught:
                    await h.run()
                self.assertIn("event loop is closed", str(caught.exception))
                self.assertNotEqual(h.terminal_reason, "disconnect")

    async def test_happy_path_q1_is_spoken_exactly_as_before(self):
        session = _PreloopSession()
        h = _NativeHarness(session, state=_state())
        await h.run()
        role_line = phone.phone_role_opening_text(_ROLE)
        self.assertEqual(session.say_calls[0], {"text": role_line, "allow_interruptions": True})
        self.assertEqual(
            session.say_calls[1], {"text": "First question?", "allow_interruptions": True},
        )
        # F0a primed with the delivered ask.
        self.assertEqual(h.latest_assistant[0], "First question?")
        self.assertTrue(h.assistant_delivery_complete.is_set())
        self.assertNotEqual(h.terminal_reason, "disconnect")

    def test_is_sdk_session_stopped_matches_only_the_sdk_marker(self):
        self.assertTrue(agent_mod._is_sdk_session_stopped(RuntimeError(_STOPPED)))
        self.assertTrue(
            agent_mod._is_sdk_session_stopped(RuntimeError("AgentSession is not running"))
        )
        self.assertFalse(agent_mod._is_sdk_session_stopped(RuntimeError("event loop is closed")))
        self.assertFalse(agent_mod._is_sdk_session_stopped(ValueError(_STOPPED)))
        self.assertFalse(agent_mod._is_sdk_session_stopped(phone.PhoneParticipantGone()))

    def test_participant_gone_from_shares_the_one_matcher(self):
        source = inspect.getsource(agent_mod._participant_gone_from)
        self.assertIn("_is_sdk_session_stopped(exc)", source)
        self.assertNotIn("_SDK_SESSION_STOPPED_MARKERS", source)
        self.assertIsInstance(
            agent_mod._participant_gone_from(RuntimeError(_STOPPED), category="x"),
            phone.PhoneParticipantGone,
        )
        with self.assertRaises(RuntimeError):
            agent_mod._participant_gone_from(RuntimeError("boom"), category="x")


class _ClosingDropsSession(fixtures._FakePhoneSession):
    """The candidate is gone by the time the closing courtesy line is said."""

    def say(self, text, **kwargs):
        if text == phone.PHONE_ASSESSMENT_CLOSING_TEXT:
            raise RuntimeError(_STOPPED)
        return super().say(text, **kwargs)


class TestRunLevelBackstop(unittest.IsolatedAsyncioTestCase):
    """C4 items 3-4, driven through the real `_run_phone_session`."""

    def setUp(self):
        fixtures._FakePhoneSession.instances = []
        fixtures._FakePhoneSession.default_answers = []
        patcher = patch.dict(os.environ, {
            "PHONE_GATE_FLOW": "deterministic",
            "PHONE_DETERMINISTIC_OPENER": "true",
        })
        patcher.start()
        self.addCleanup(patcher.stop)

    async def _run(self, client, *, screening=None, session_cls=None):
        ctx = fixtures.FakeCtx(
            fixtures._PHONE_ROOM, participants=[fixtures._participant()],
        )

        async def recording_seam():
            return None

        async def classifier(turns, say):
            return phone.CLASSIFY_HUMAN

        log = MagicMock(wraps=agent_mod._log)
        patches = [
            patch.object(agent_mod, "AgentSession", session_cls or fixtures._FakePhoneSession),
            patch.object(agent_mod, "persistence", MagicMock()),
            patch.object(agent_mod, "_phone_recording_permitted", new=recording_seam),
            patch.object(agent_mod, "SESSION_MAX_RESIDENCY_SEC", fixtures._HARNESS_RESIDENCY_SEC),
            patch.object(agent_mod, "_log", log),
        ]
        if screening is not None:
            patches.append(
                patch.object(agent_mod, "_run_native_phone_screening", screening)
            )
        delete = AsyncMock()
        patches.append(patch.object(agent_mod, "_delete_livekit_room", delete))
        for p in patches:
            p.start()
        try:
            task = asyncio.ensure_future(
                agent_mod._run_phone_session(
                    ctx, fixtures._PHONE_ROOM, fixtures._ATTEMPT_ID, fixtures._EPOCH,
                    client=client, classifier=classifier,
                )
            )
            outcome: object
            try:
                outcome = await asyncio.wait_for(task, timeout=10)
            except Exception as exc:  # noqa: BLE001 — returned for assertions
                outcome = exc
        finally:
            for p in reversed(patches):
                p.stop()
        return outcome, delete, log

    @staticmethod
    def _logged(log, error_type, category):
        return any(
            c.kwargs.get("error_type") == error_type
            and c.kwargs.get("error_category") == category
            for c in log.info.call_args_list + log.warn.call_args_list
        )

    def _assert_halted_quietly(self, outcome, client, delete, log):
        self.assertIsInstance(outcome, phone.PhoneGateResult)
        self.assertTrue(outcome.assessment_allowed)
        self.assertTrue(self._logged(log, "phone_assessment_halted_leg", "participant_gone"))
        self.assertFalse(self._logged(log, "phone_assessment_failed", "post_consent_exception"))
        # Posts nothing after consent, and requests no room close.
        self.assertNotIn("assessment.aborted", client.event_types)
        self.assertNotIn("assessment.completed", client.event_types)
        self.assertNotIn("sip.participant_left", client.event_types)
        delete.assert_not_awaited()

    async def test_participant_gone_escaping_the_screening_is_a_quiet_halt(self):
        async def screening(**_kw):
            raise phone.PhoneParticipantGone()

        client = fixtures.FakeEventClient()
        outcome, delete, log = await self._run(client, screening=screening)
        self._assert_halted_quietly(outcome, client, delete, log)

    async def test_marker_runtime_error_after_teardown_first_is_a_quiet_halt(self):
        # The guarded SDK close runs teardown FIRST (posting nothing), and only
        # then does the raw `say` raise — the d8d9564b50e908 order.
        async def screening(**_kw):
            session = fixtures._FakePhoneSession.instances[-1]
            session.emit_close()
            await asyncio.sleep(0)
            raise RuntimeError(_STOPPED)

        client = fixtures.FakeEventClient()
        outcome, delete, log = await self._run(client, screening=screening)
        self._assert_halted_quietly(outcome, client, delete, log)

    async def test_a_generic_error_after_consent_keeps_the_generic_body(self):
        for exc in (RuntimeError("event loop is closed"), ValueError("bad")):
            with self.subTest(exc=type(exc).__name__):
                async def screening(**_kw):
                    raise exc

                client = fixtures.FakeEventClient()
                outcome, delete, log = await self._run(client, screening=screening)
                self.assertIs(outcome, exc)
                self.assertTrue(
                    self._logged(log, "phone_assessment_failed", "post_consent_exception")
                )
                self.assertFalse(
                    self._logged(log, "phone_assessment_halted_leg", "participant_gone")
                )
                delete.assert_awaited()

    async def test_adoption_closing_say_drop_still_posts_the_completion(self):
        client = fixtures.FakeEventClient(
            start=phone.PhoneAssessmentState(False, phone.ASSESSMENT_ALREADY_SCORED_STATUS),
        )
        outcome, delete, _log = await self._run(client, session_cls=_ClosingDropsSession)
        self.assertIsInstance(outcome, phone.PhoneGateResult)
        self.assertIn("assessment.completed", client.event_types)
        self.assertNotIn("assessment.aborted", client.event_types)
        delete.assert_awaited()

    async def test_recovered_closing_say_drop_still_posts_the_completion(self):
        client = fixtures.FakeEventClient(
            start=phone.PhoneAssessmentState(False, "session_not_active"),
            complete=phone.PhoneApiOutcome(True, phone.ASSESSMENT_SCORED_STATUS),
        )
        outcome, delete, _log = await self._run(client, session_cls=_ClosingDropsSession)
        self.assertIsInstance(outcome, phone.PhoneGateResult)
        self.assertIn("assessment.completed", client.event_types)
        self.assertNotIn("assessment.aborted", client.event_types)
        delete.assert_awaited()

    def test_backstop_is_ordered_after_the_lease_halt_cancel(self):
        source = inspect.getsource(agent_mod._run_phone_session)
        cancel = source.index("except asyncio.CancelledError:\n                reason = lease_halt")
        backstop = source.index("except (phone.PhoneParticipantGone, RuntimeError) as exc:")
        generic = source.index("except Exception as exc:  # noqa: BLE001 — finalizer owns truth")
        self.assertLess(cancel, backstop)
        self.assertLess(backstop, generic)


if __name__ == "__main__":
    unittest.main()
