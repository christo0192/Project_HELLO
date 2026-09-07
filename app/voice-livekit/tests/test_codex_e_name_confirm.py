"""Codex review Finding E (2026-09-07) — name-confirm vs echo guard + lifecycle.

Part 1 (the contradiction): `phone_name_confirm_instruction` used to embed a
LITERAL second-person example ("just so I have it right, should I call you
…?"). An instruction-literal model that copied the offered wording shared six
contiguous normalized words with the private control text, so the echo guard
rejected exactly what the instruction offered (twice on Call B, 17:39:20 and
17:39:30 UTC) — and the deterministic fallback then spoke nearly the same
words anyway. The instruction now describes the confirmation in third-person
prose with NO verbatim speakable phrase. The echo guard itself is untouched:
copying actual instruction prose is still rejected.

Part 2 (the lifecycle): `asked_name_mismatches` was updated at AUTHOR time, so
a rejected/interrupted confirmation read as already handled and Call A's
persisted identity signal froze at "armed". Authoring, delivery, and
confirmation are now tracked separately: an undelivered confirmation stays
PENDING under a bounded author cap (2, consistent with the existing re-ask
caps); playout proof grades "delivered"; the candidate's next turn is graded
once for "confirmed" by a conservative deterministic predicate.
"""

from __future__ import annotations

import asyncio
import types
import unittest
from unittest.mock import AsyncMock, patch

from tests.test_phone_gate import (  # noqa: E402
    _default_state,
    _make_native_coordinator,
)

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402


_MISMATCH = {"record": "Christo", "spoken": "Deepak"}
_NATURAL_CONFIRMATION = "Just so I have it right, should I call you Deepak?"


# ── Part 1: the instruction no longer offers what the guard forbids ──────────

class TestNameConfirmEchoRepair(unittest.TestCase):

    def test_review_reproduction_no_longer_trips_the_echo_guard(self):
        # The review's exact function reproduction (§7) — previously True.
        self.assertFalse(
            phone.phone_instruction_echo_detected(
                _NATURAL_CONFIRMATION,
                phone.phone_name_confirm_instruction(
                    {"record": "Christo", "spoken": "Deepak"},
                ),
            ),
        )

    def test_natural_confirmations_pass_full_reply_authorization(self):
        instruction = phone.phone_name_confirm_instruction(_MISMATCH)
        for reply in (
            _NATURAL_CONFIRMATION,
            "Just to make sure I have it right — do you prefer Deepak?",
            "Which name do you prefer to be called, Deepak or Christo?",
        ):
            with self.subTest(reply=reply):
                self.assertIsNone(
                    phone.phone_generated_reply_rejection_reason(
                        reply,
                        phone.PHONE_NAME_CONFIRM_CLARIFICATION_TEXT,
                        allow_closing=False,
                        control_text=instruction,
                        max_question_acts=(
                            phone.phone_objective_guard_max_questions_for_phase(
                                "name_confirm",
                            )
                        ),
                    ),
                )

    def test_instruction_contains_no_literal_speakable_example(self):
        instruction = phone.phone_name_confirm_instruction(_MISMATCH)
        low = instruction.lower()
        self.assertNotIn("should i call you", low)
        self.assertNotIn("just so i have it right", low)
        # The behavioural contract the old tests pinned is preserved.
        self.assertIn("do not assert either name", low)
        self.assertIn("do not brush it off", low)
        self.assertIn("never accuse", low)

    def test_echo_protection_is_not_weakened(self):
        # Copying ACTUAL instruction prose (six contiguous words of private
        # control text) is still rejected — the guard is untouched.
        instruction = phone.phone_name_confirm_instruction(_MISMATCH)
        leaked = (
            "The name the candidate just introduced themselves with does not "
            "match the name on record."
        )
        self.assertTrue(
            phone.phone_instruction_echo_detected(leaked, instruction),
        )
        # And the guard's general threshold behaviour is unchanged.
        self.assertFalse(
            phone.phone_instruction_echo_detected("the team will be in touch",
                                                  instruction),
        )

    def test_public_fallback_line_remains_exempt_as_the_objective(self):
        # PHONE_NAME_CONFIRM_CLARIFICATION_TEXT is the authorized objective on
        # name-confirm turns; `_private_phone_control_text` strips the
        # objective before echo scanning, so the model may speak the public
        # line verbatim even when the control text quotes it.
        control = (
            phone.phone_name_confirm_instruction(_MISMATCH)
            + " " + phone.PHONE_NAME_CONFIRM_CLARIFICATION_TEXT
        )
        self.assertIsNone(
            phone.phone_generated_reply_rejection_reason(
                phone.PHONE_NAME_CONFIRM_CLARIFICATION_TEXT,
                phone.PHONE_NAME_CONFIRM_CLARIFICATION_TEXT,
                allow_closing=False,
                control_text=control,
                max_question_acts=2,
            ),
        )


class TestNameConfirmReplyPredicate(unittest.TestCase):

    def test_affirmations_and_corrections_confirm(self):
        for reply in (
            "Yes, Deepak is right.",
            "Yeah that's fine.",
            "Please call me Deepak.",
            "Actually I go by Christo.",
            "No, call me Christo please.",
        ):
            with self.subTest(reply=reply):
                self.assertTrue(
                    phone.phone_name_confirm_reply_confirms(reply, _MISMATCH),
                )

    def test_unrelated_replies_do_not_confirm(self):
        for reply in (
            "My notice period is thirty days.",
            "What is the salary band for this role?",
            "",
            None,
        ):
            with self.subTest(reply=reply):
                self.assertFalse(
                    phone.phone_name_confirm_reply_confirms(reply, _MISMATCH),
                )


# ── Part 2: authored vs delivered vs confirmed ───────────────────────────────

class TestNameConfirmLifecycle(unittest.IsolatedAsyncioTestCase):

    INTRO = "Hi, my name is Deepak and I lead data engineering projects."
    FOLLOWUP = "I have been building data pipelines for four years."

    @staticmethod
    def _state():
        state = _default_state(questions=[
            {"key": "k1", "text": "Tell me about your recent role.", "mandatory": True, "hint": None},
            {"key": "k2", "text": "What is your notice period?", "mandatory": True, "hint": None},
        ])
        state.resume_facts = {"name": "Christo"}
        return state

    async def _coordinator(self, call_metrics=None):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(),
            coverage_judge_enabled=True, call_metrics=call_metrics,
        )
        hooks["assistant_delivery_complete"].set()
        hooks["latest_assistant"][0] = state.questions[0].spoken_text
        hooks["latest_assistant_anchor"][0] = 1
        return agent, session, state, client, hooks

    async def _turn(self, hooks, text):
        ctx = types.SimpleNamespace(items=[])
        await hooks["on_native_turn"](
            text, types.SimpleNamespace(text_content=text), ctx,
        )
        return ctx

    async def _deliver(self, agent, interrupted=False, delivered_seq=None):
        value = agent._on_reply_delivered(interrupted, delivered_seq)
        if asyncio.iscoroutine(value):
            await value

    async def _close(self, hooks):
        hooks["task"].cancel()
        await asyncio.gather(hooks["task"], return_exceptions=True)
        hooks["log_patch"].stop()

    def _signal(self, call_metrics):
        signals = call_metrics["identity_signals"]
        self.assertEqual(len(signals), 1)
        return next(iter(signals.values()))

    async def test_authored_then_delivered_then_confirmed(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=phone.PhoneCoverageVerdict(True, None, "model"),
        ):
            agent, _, _, _, hooks = await self._coordinator(call_metrics)
            ctx = await self._turn(hooks, self.INTRO)
            # Authored: the confirm turn claimed the reply, but nothing is
            # delivered yet — the signal reads "armed", not handled.
            self.assertIn("name on record", str(ctx.items))
            key = next(iter(agent._name_confirm_state))
            self.assertEqual(agent._name_confirm_state[key]["authored"], 1)
            self.assertFalse(agent._name_confirm_state[key]["delivered"])
            self.assertEqual(self._signal(call_metrics)["disposition"], "armed")
            # Delivery proof grades "delivered" — not "confirmed".
            await self._deliver(agent, False)
            self.assertTrue(agent._name_confirm_state[key]["delivered"])
            self.assertEqual(
                self._signal(call_metrics)["disposition"], "delivered")
            # The candidate's confirming reply grades "confirmed".
            await self._turn(hooks, "Yes, Deepak is right.")
            self.assertEqual(
                self._signal(call_metrics)["disposition"], "confirmed")
            await self._close(hooks)

    async def test_nonconfirming_reply_stays_delivered(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=phone.PhoneCoverageVerdict(True, None, "model"),
        ):
            agent, _, _, _, hooks = await self._coordinator(call_metrics)
            await self._turn(hooks, self.INTRO)
            await self._deliver(agent, False)
            await self._turn(hooks, self.FOLLOWUP)
            # Delivery is not confirmation: a topic answer that never touched
            # the name leaves the truthful "delivered".
            self.assertEqual(
                self._signal(call_metrics)["disposition"], "delivered")
            await self._close(hooks)

    async def test_interrupted_confirmation_stays_pending_and_reauthors(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=phone.PhoneCoverageVerdict(True, None, "model"),
        ):
            agent, _, _, _, hooks = await self._coordinator(call_metrics)
            await self._turn(hooks, self.INTRO)
            key = next(iter(agent._name_confirm_state))
            armed_seq = agent._name_confirm_delivery["sequence"]
            # Barged into on its own handle: NOT delivered — stays pending.
            await self._deliver(agent, True, delivered_seq=armed_seq)
            self.assertFalse(agent._name_confirm_state[key]["delivered"])
            self.assertTrue(agent._owed_name_confirm["value"])
            self.assertEqual(self._signal(call_metrics)["disposition"], "armed")
            # The next authored turn RE-AUTHORS the confirmation (bounded).
            ctx = await self._turn(hooks, self.FOLLOWUP)
            self.assertIn("name on record", str(ctx.items))
            self.assertEqual(agent._name_confirm_state[key]["authored"], 2)
            self.assertFalse(agent._owed_name_confirm["value"])
            # This one plays out: delivered.
            await self._deliver(agent, False)
            self.assertTrue(agent._name_confirm_state[key]["delivered"])
            self.assertEqual(
                self._signal(call_metrics)["disposition"], "delivered")
            await self._close(hooks)

    async def test_author_cap_records_unresolved_not_an_endless_reask(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=phone.PhoneCoverageVerdict(True, None, "model"),
        ):
            agent, _, _, _, hooks = await self._coordinator(call_metrics)
            await self._turn(hooks, self.INTRO)
            key = next(iter(agent._name_confirm_state))
            # First interruption → owed → re-authored on the next turn.
            await self._deliver(
                agent, True,
                delivered_seq=agent._name_confirm_delivery["sequence"])
            await self._turn(hooks, self.FOLLOWUP)
            self.assertEqual(agent._name_confirm_state[key]["authored"], 2)
            # Second interruption: the author cap (2) is exhausted — recorded
            # UNRESOLVED, no further re-author is owed (bounded policy).
            await self._deliver(
                agent, True,
                delivered_seq=agent._name_confirm_delivery["sequence"])
            self.assertFalse(agent._owed_name_confirm["value"])
            self.assertEqual(
                self._signal(call_metrics)["disposition"], "unresolved")
            ctx = await self._turn(hooks, "My notice period is thirty days.")
            self.assertNotIn("name on record", str(ctx.items))
            self.assertEqual(agent._name_confirm_state[key]["authored"], 2)
            await self._close(hooks)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
