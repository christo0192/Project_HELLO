"""Synthetic gate conversations: draft validation, calendar routing and closing."""
import asyncio
import types
import unittest
from unittest.mock import AsyncMock, patch

import phone
from test_phone_gate import agent_mod


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
                self.assertNotIn(phone.PHONE_REASK_TEXT, spoken)

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
