"""Synthetic gate conversations: draft validation, calendar routing and closing."""
import asyncio
import types
import unittest
import sys
from unittest.mock import AsyncMock, patch

import phone
from test_phone_gate import agent_mod
import test_phone_gate as harness


class ConversationGateTests(unittest.IsolatedAsyncioTestCase):
    async def gate(self, replies, *, draft=None, identity=False, confirm=True,
                   say_error=False):
        queue = asyncio.Queue()
        for reply in replies:
            queue.put_nowait(reply)
        spoken, consumed, events, phases = [], [], [], {}

        async def say(text):
            spoken.append(text)
            if say_error:
                raise RuntimeError("synthetic playout failure")

        async def post(_attempt, event, **kwargs):
            events.append(event)
            return phone.PhoneApiOutcome(True, "applied")

        proposal = phone.CallbackProposal({
            "starts_at": "2026-10-07T09:30:00Z", "ends_at": "2026-10-07T09:45:00Z",
            "weekday": "Wednesday", "ist_date": "2026-10-07", "ist_time": "15:00",
            "time_zone": "Asia/Kolkata",
        })
        client = types.SimpleNamespace(
            post_event=post,
            propose_callback=AsyncMock(return_value=(phone.PhoneApiOutcome(True, "proposal_valid"), proposal)),
            confirm_callback=AsyncMock(return_value=phone.PhoneApiOutcome(confirm, "ok" if confirm else None)),
            consent_and_start_assessment=AsyncMock(side_effect=AssertionError("must not screen")),
        )

        async def classify():
            return await agent_mod._classify_phone_answer(
                queue, say, consumed=consumed, answer_timeout_sec=.01,
            )

        async def next_turn():
            return queue.get_nowait() if not queue.empty() else ""

        with patch.dict(phone.os.environ, {"PHONE_GATE_FLOW": "conversational" if identity else "deterministic"}):
            result = await phone.run_phone_gate(
                attempt_id="synthetic-attempt", client=client,
                wait_for_participant=AsyncMock(return_value=object()),
                classify=classify, say=say, post_call_answered=True,
                compose_opening=AsyncMock(return_value=draft),
                next_candidate_turn=next_turn, consent_reply_out=consumed,
                classify_gate_reply=agent_mod.classify_answer_text,
                gate_phase_out=phases, candidate_name="Taylor Example",
                session_id="synthetic-session", epoch=1,
            )
        client.consent_and_start_assessment.assert_not_awaited()
        self.assertFalse(result.assessment_allowed)
        self.assertNotIn("disclosure.delivered", events)
        self.assertNotIn("classify.human", events)
        return result, client, spoken, events, phases

    async def test_busy_and_driving_before_consent_book_existing_calendar(self):
        for first in ("I am busy", "I'm driving", "No, I am in a meeting", "Yes, but call me tomorrow at 3 pm"):
            with self.subTest(first=first):
                result, client, spoken, events, phases = await self.gate([first, "tomorrow at 3 pm"])
                self.assertEqual(result.outcome, phone.HALT_CALLBACK_SCHEDULED)
                client.confirm_callback.assert_awaited_once()
                self.assertTrue(phases["terminal_posted"])
                self.assertEqual(events, ["call.answered"])
                for reask in (phone.PHONE_CONSENT_REASK_UNCLEAR_TEXT,
                              phone.PHONE_CONSENT_REASK_SILENCE_TEXT,
                              phone.PHONE_CONSENT_REASK_QUESTION_TEXT):
                    self.assertNotIn(reask, spoken)

    async def test_busy_at_identity_also_books_without_reading_consent(self):
        result, client, spoken, _, _ = await self.gate(["I'm driving", "tomorrow at 3 pm"], identity=True)
        self.assertEqual(result.outcome, phone.HALT_CALLBACK_SCHEDULED)
        self.assertFalse(any(phone.PHONE_DISCLOSURE_RECORDING_SENTENCE in s for s in spoken))

    async def test_no_time_is_bounded_deferral_not_voicemail(self):
        result, client, _, events, _ = await self.gate(["I'm busy", "not sure"])
        self.assertEqual(result.outcome, phone.CLASSIFY_DEFERRED_PRE_DISCLOSURE)
        self.assertEqual(events[-1], "candidate.deferred_pre_disclosure")
        client.confirm_callback.assert_not_awaited()

    async def test_opt_out_during_scheduling_wins_over_time(self):
        result, client, _, events, _ = await self.gate(["I'm busy", "Don't call me again, tomorrow at 3 pm"])
        self.assertEqual(result.outcome, phone.CLASSIFY_OPT_OUT)
        self.assertEqual(events[-1], "candidate.opt_out")
        client.confirm_callback.assert_not_awaited()

    async def test_confirmation_failure_never_claims_booked(self):
        result, _, spoken, events, _ = await self.gate(["call me tomorrow at 3 pm"], confirm=False)
        self.assertEqual(result.outcome, phone.HALT_CALLBACK_RECOVERY)
        self.assertIn("consent.failed", events)
        self.assertFalse(any("booked" in s.lower() for s in spoken))

    async def test_end_request_wins_over_a_callback_time_at_each_gate_stage(self):
        for identity, replies in (
            (True, ["Hang up, call me tomorrow at 3 pm"]),
            (False, ["Hang up, call me tomorrow at 3 pm"]),
            (False, ["I'm busy", "Hang up, call me tomorrow at 3 pm"]),
        ):
            _, client, spoken, events, _ = await self.gate(replies, identity=identity)
            client.propose_callback.assert_not_awaited()
            self.assertEqual(events[-1], "candidate.deferred_pre_disclosure")
            self.assertEqual(spoken[-1], phone.PHONE_CANDIDATE_END_TEXT)

    async def test_time_correction_is_not_recording_refusal(self):
        result, client, _, events, _ = await self.gate(["I'm busy", "No, tomorrow at 3 pm"])
        self.assertEqual(result.outcome, phone.HALT_CALLBACK_SCHEDULED)
        client.confirm_callback.assert_awaited_once()
        self.assertNotIn("disclosure.refused", events)

    async def test_negated_end_request_keeps_calendar_selection_alive(self):
        result, client, _, _, _ = await self.gate(
            ["I'm busy", "Please do not hang up, tomorrow at 3 pm"],
        )
        self.assertEqual(result.outcome, phone.HALT_CALLBACK_SCHEDULED)
        client.confirm_callback.assert_awaited_once()

    async def test_opt_out_plus_end_remains_opt_out_at_every_stage(self):
        stop = "Don't call me again, hang up the call"
        for identity, replies in ((True, [stop]), (False, [stop]),
                                  (False, ["I'm busy", stop])):
            result, client, _, events, _ = await self.gate(replies, identity=identity)
            self.assertEqual(result.outcome, phone.CLASSIFY_OPT_OUT)
            self.assertEqual(events[-1], "candidate.opt_out")
            client.propose_callback.assert_not_awaited()

    async def test_invalid_draft_is_never_spoken(self):
        draft = "Hi, is this Taylor? This call is recorded. Okay to continue?"
        _, _, spoken, _, _ = await self.gate(["No thanks"], draft=draft)
        self.assertNotIn(draft, spoken)
        self.assertEqual(spoken.count(phone.PHONE_DISCLOSURE_TEXT), 1)

    async def test_valid_draft_is_spoken_once(self):
        draft = (f"Hello, I'm Christy, an AI voice assistant from {phone._COMPANY} "
                 "about your application. " + phone.PHONE_DISCLOSURE_RECORDING_SENTENCE +
                 " Are you okay to continue?")
        _, _, spoken, _, _ = await self.gate(["No thanks"], draft=draft)
        self.assertEqual(spoken.count(draft), 1)
        self.assertNotIn(phone.PHONE_DISCLOSURE_TEXT, spoken)

    async def test_playout_failure_does_not_replay_an_opener(self):
        with self.assertRaisesRegex(RuntimeError, "playout"):
            await self.gate(["No thanks"], say_error=True)


class IntentTests(unittest.TestCase):
    def test_availability_is_not_consent_and_negations_do_not_schedule(self):
        for text in ("I'm busy", "I am driving", "No, I'm busy right now"):
            self.assertEqual(agent_mod.classify_answer_text(text), phone.CLASSIFY_CALLBACK_REQUESTED)
        for text in ("I'm not busy", "I was driving yesterday", "I am busy in the mornings but free now"):
            self.assertNotEqual(agent_mod.classify_answer_text(text), phone.CLASSIFY_CALLBACK_REQUESTED)
        for text in ("Don't record, call me tomorrow at 3 pm", "Don't call me again"):
            self.assertNotEqual(agent_mod.classify_answer_text(text), phone.CLASSIFY_CALLBACK_REQUESTED)

    def test_acknowledgements_never_swallow_a_question_or_unfinished_thought(self):
        for text in ("Okay, thanks", "Got it.", "Thank you!"):
            self.assertTrue(phone.phone_qna_acknowledgement(text))
        for text in ("Okay, but what is the salary?", "Thanks, and how about shifts", "Yeah, so", "Okay?"):
            self.assertFalse(phone.phone_qna_acknowledgement(text))


class CandidateQnaTests(unittest.IsolatedAsyncioTestCase):
    async def enter(self):
        values = await harness.TestBoundedCandidateQna()._enter_qna()
        hooks = values[-1]

        async def cleanup():
            hooks["task"].cancel()
            await asyncio.gather(hooks["task"], return_exceptions=True)
            hooks["log_patch"].stop()

        self.addAsyncCleanup(cleanup)
        return values

    async def turn(self, hooks, text):
        ctx = types.SimpleNamespace(items=[])
        await hooks["on_native_turn"](text, types.SimpleNamespace(text_content=text), ctx)
        return str(ctx.items).lower()

    async def test_four_questions_are_answered_without_four_invitations(self):
        agent, _, _, client, hooks = await self.enter()
        for text in ("How large is the team?", "What are the work hours?",
                     "Who would I report to?", "When is the next round?"):
            instruction = await self.turn(hooks, text)
            self.assertIn("answer", instruction)
            self.assertIn("do not ask a question or invite more questions", instruction)
            self.assertNotIn("anything else", instruction)
            self.assertEqual(agent._closing_state_machine.state.value, "candidate_qna")
        self.assertNotIn("assessment.completed", client.event_types)

    async def test_ack_after_delivered_answer_closes_once(self):
        for ack in ("Okay", "Thanks", "Got it"):
            agent, _, _, client, hooks = await self.enter()
            await self.turn(hooks, "How large is the team?")
            await agent._on_reply_delivered(False, hooks["speech_sequence"][0] + 1)
            instruction = await self.turn(hooks, ack)
            self.assertIn("say goodbye", instruction)
            self.assertNotIn("anything else", instruction)
            self.assertEqual(agent._closing_state_machine.state.value, "closing_pending")
            # Completion must wait for the farewell delivery path.
            self.assertNotIn("assessment.completed", client.event_types)

    async def test_ack_before_answer_is_delivered_does_not_close(self):
        agent, _, _, _, hooks = await self.enter()
        await self.turn(hooks, "How large is the team?")
        with self.assertRaises(sys.modules["livekit.agents"].StopResponse):
            await self.turn(hooks, "Okay")
        self.assertEqual(agent._closing_state_machine.state.value, "candidate_qna")

    async def test_ack_after_watchdog_recovery_uses_replacement_delivery(self):
        agent, session, _, _, hooks = await self.enter()
        await self.turn(hooks, "How large is the team?")
        # An intervening handle changes the actual fallback's sequence.
        hooks["speech_sequence"][0] = 7
        with patch.object(agent_mod, "PHONE_SPEECH_FIRST_AUDIO_TIMEOUT_SEC", .05):
            await agent._on_reply_expected()
            for _ in range(100):
                if "The hiring team can help with that detail." in session.spoken:
                    break
                await asyncio.sleep(.01)
        self.assertIn("The hiring team can help with that detail.", session.spoken)
        await agent._on_reply_delivered(False, 8)
        instruction = await self.turn(hooks, "Okay")
        self.assertIn("say goodbye", instruction)

    async def test_ack_with_question_is_answered_even_after_delivery(self):
        agent, _, _, _, hooks = await self.enter()
        await self.turn(hooks, "How large is the team?")
        await agent._on_reply_delivered(False, hooks["speech_sequence"][0] + 1)
        instruction = await self.turn(hooks, "Thanks, but what are the work hours?")
        self.assertIn("do not say goodbye yet", instruction)
        self.assertEqual(agent._closing_state_machine.state.value, "candidate_qna")

    async def test_incomplete_interruption_gets_space_without_reinvitation(self):
        agent, _, _, _, hooks = await self.enter()
        await self.turn(hooks, "How large is the team?")
        hooks["reply_handle"][0] = harness._FakeSpeech(interrupted=True)
        instruction = await self.turn(hooks, "Uh, yeah, so")
        self.assertIn("take your time", instruction)
        self.assertNotIn("anything else", instruction)
        self.assertEqual(agent._closing_state_machine.state.value, "candidate_qna")
