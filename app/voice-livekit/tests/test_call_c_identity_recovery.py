"""Call C identity-recovery ownership — the RED/GREEN acceptance suite.

Codex Call-C identity-recovery handover §8–§9. Call C 428b384e looped for ~90s
because ONE logical name-confirmation action lost ownership across a rejected
generation and its watchdog recovery fallback: the original (rejected) reply's
interrupt callback CLEARED the identity arm and set an owed re-author, so when
the watchdog then spoke the canned confirmation its delivery callback found no
armed action and NEVER established awaiting-confirmation. The candidate's valid
"It's Christo" was consequently never credited and a second phantom confirm was
authored.

The repair (agent.py) makes ONE confirmation action own EVERY delivery attempt:
  * suppress-then-adopt — an interrupt never resolves an unconfirmed action; the
    watchdog fallback ADOPTS the same action by re-pointing its OBSERVED
    sequence at say-time; the fallback's non-interrupted delivery establishes
    awaiting-confirmation EXACTLY once (monotone lifecycle armed→awaiting→
    consumed, keyed on a per-action `action_id`);
  * candidate confirmation resolves the action AND clears any stale owed
    re-author, so the loop cannot recur;
  * `phone_name_confirm_instruction` is confirmation-only (no in-turn topic
    resume), removing the `compensation_drift` rejections that drove the
    watchdog fallback in the first place.

This module drives the ACTUAL watchdog path (`_on_reply_expected` +
`_on_generation_empty` → interrupt + `session.say`) plus the delivery callbacks
under both orderings and the split/interrupt/unrelated schedules, exactly as the
event-replay harness owns every event explicitly.

RED/GREEN CONTROL (docstring, per Codex §9): with the ownership fix reverted to
#260 behaviour — the interrupt callback clearing the arm and setting owed, and
no watchdog say-time rebind — `test_rejected_original_then_recovery_fallback_
credits_confirmation` FAILS: the fallback delivery finds no armed action,
awaiting-confirmation is never set, "It's Christo" is never credited
(disposition stays "armed"/"unresolved"), and a second confirm re-arms. A single
revert of the agent.py ownership hunk restores that failure, proving the test is
non-vacuous.
"""

from __future__ import annotations

import asyncio
import types
import unittest
from unittest.mock import AsyncMock, patch

from tests.test_phone_gate import (  # noqa: E402  (installs the dotenv stub)
    _default_state,
    _make_native_coordinator,
    _FakeSpeech,
)

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402


_MISMATCH_INTRO = "Hi, my name is Deepak and I lead data engineering."
_RECORD_NAME = "Christo"
_CONFIRM_REPLY = "It's Christo"
_CANNED = phone.PHONE_NAME_CONFIRM_CLARIFICATION_TEXT


class _IdentityRecoveryHarness(unittest.IsolatedAsyncioTestCase):
    """Drives the real coordinator; owns the watchdog + delivery events."""

    @staticmethod
    def _state():
        state = _default_state(questions=[
            {"key": "k1", "text": "Tell me about your recent role.",
             "mandatory": True, "hint": None},
            {"key": "k2", "text": "What are your compensation figures?",
             "mandatory": True, "hint": None},
        ])
        state.resume_facts = {"name": _RECORD_NAME}
        return state

    async def _coordinator(self, call_metrics):
        # Non-zero start so the original reply's seq and the fallback's rebound
        # seq are DISTINCT (the live case; #260's bug hid behind seq collision).
        self._seq = [5]
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(),
            coverage_judge_enabled=True, call_metrics=call_metrics,
            speech_sequence=self._seq,
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

    async def _deliver(self, agent, interrupted, seq):
        value = agent._on_reply_delivered(interrupted, seq)
        if asyncio.iscoroutine(value):
            await value

    async def _arm_and_reject_name_confirm(self, agent, session, hooks):
        """Arm the confirm, then run the ACTUAL watchdog: reject the generation
        so it interrupts the original and speaks the canned recovery fallback.
        Returns (armed_seq, fallback_seq) — DISTINCT, as on a live call."""
        ctx = await self._turn(hooks, _MISMATCH_INTRO)
        self.assertIn("name on record", str(ctx.items), "confirm must arm")
        armed_seq = agent._name_confirm_delivery["sequence"]
        # The original confirm reply is created (speech_created → bump seq).
        self._seq[0] = armed_seq
        hooks["reply_handle"][0] = _FakeSpeech()
        with patch.object(agent_mod, "PHONE_SPEECH_FIRST_AUDIO_TIMEOUT_SEC", 0.03):
            await agent._on_reply_expected()
            agent._on_generation_empty("compensation_drift")
            for _ in range(60):
                await asyncio.sleep(0.01)
        # The watchdog spoke the canned fallback and rebound the arm at say-time.
        self.assertIn(_CANNED, session.spoken[-1])
        fallback_seq = agent._name_confirm_delivery["sequence"]
        self.assertNotEqual(armed_seq, fallback_seq,
                            "fallback must adopt a DISTINCT observed sequence")
        # The fallback's speech_created bumps the shared sequence to that value.
        self._seq[0] = fallback_seq
        return armed_seq, fallback_seq

    async def _close(self, hooks):
        hooks["task"].cancel()
        await asyncio.gather(hooks["task"], return_exceptions=True)
        hooks["log_patch"].stop()

    def _disposition(self, call_metrics):
        signals = list(call_metrics["identity_signals"].values())
        return signals[-1]["disposition"] if signals else None

    def _judge_patch(self):
        return patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=phone.PhoneCoverageVerdict(True, None, "model"),
        )


class TestRejectedOriginalRecoveryOwnership(_IdentityRecoveryHarness):

    async def test_rejected_original_then_recovery_fallback_credits_confirmation(self):
        # THE RED/GREEN scenario (Codex §9): rejected original → watchdog
        # recovery fallback → candidate "It's Christo" MUST be credited. On #260
        # awaiting is never set and this fails.
        cm = agent_mod._new_phone_call_metrics()
        with self._judge_patch():
            agent, session, _, _, hooks = await self._coordinator(cm)
            armed_seq, fallback_seq = await self._arm_and_reject_name_confirm(
                agent, session, hooks,
            )
            # Original interrupt callback (its OWN seq) + fallback delivery.
            await self._deliver(agent, True, armed_seq)
            await self._deliver(agent, False, fallback_seq)
            # ADOPTED: awaiting established exactly once for the action.
            self.assertIsNotNone(agent._name_confirm_awaiting_reply["key"])
            self.assertEqual(self._disposition(cm), "delivered")
            # Candidate confirms → credited, owed cleared.
            await self._turn(hooks, _CONFIRM_REPLY)
            self.assertEqual(self._disposition(cm), "confirmed")
            self.assertFalse(agent._owed_name_confirm["value"])
            # No second phantom confirm on a later turn.
            ctx = await self._turn(hooks, "Anyway, do you like cricket?")
            self.assertNotIn("name on record", str(ctx.items))
            await self._close(hooks)

    async def test_late_original_callback_after_replacement_binds_cannot_regress(self):
        # Codex §9: a LATE original interruption/completion after the replacement
        # binds must not clear/complete the replacement incorrectly.
        cm = agent_mod._new_phone_call_metrics()
        with self._judge_patch():
            agent, session, _, _, hooks = await self._coordinator(cm)
            armed_seq, fallback_seq = await self._arm_and_reject_name_confirm(
                agent, session, hooks,
            )
            # Fallback delivers FIRST (awaiting established)…
            await self._deliver(agent, False, fallback_seq)
            self.assertEqual(self._disposition(cm), "delivered")
            self.assertIsNotNone(agent._name_confirm_awaiting_reply["key"])
            # …then the LATE original interrupt callback (its old seq) arrives.
            # Monotonicity: it must NOT regress the adopted awaiting state.
            await self._deliver(agent, True, armed_seq)
            self.assertIsNotNone(agent._name_confirm_awaiting_reply["key"])
            self.assertFalse(agent._owed_name_confirm["value"])
            self.assertEqual(self._disposition(cm), "delivered")
            # Confirmation still credited.
            await self._turn(hooks, _CONFIRM_REPLY)
            self.assertEqual(self._disposition(cm), "confirmed")
            await self._close(hooks)

    async def test_unrelated_successful_callback_cannot_prove_identity_delivery(self):
        # Codex §9: an unrelated successful speech callback (a different seq)
        # must NOT establish awaiting-confirmation.
        cm = agent_mod._new_phone_call_metrics()
        with self._judge_patch():
            agent, session, _, _, hooks = await self._coordinator(cm)
            armed_seq, fallback_seq = await self._arm_and_reject_name_confirm(
                agent, session, hooks,
            )
            # An UNRELATED reply completes on a wholly different sequence.
            await self._deliver(agent, False, fallback_seq + 99)
            self.assertIsNone(
                agent._name_confirm_awaiting_reply["key"],
                "unrelated speech must not prove identity delivery",
            )
            self.assertNotEqual(self._disposition(cm), "delivered")
            # The genuine fallback delivery still adopts.
            await self._deliver(agent, False, fallback_seq)
            self.assertIsNotNone(agent._name_confirm_awaiting_reply["key"])
            await self._close(hooks)

    async def test_candidate_interrupts_fallback_no_false_delivered_bounded(self):
        # Codex §9: candidate barges into the fallback → no false "delivered"
        # proof; the action stays pending (owed) for a bounded recovery.
        cm = agent_mod._new_phone_call_metrics()
        with self._judge_patch():
            agent, session, _, _, hooks = await self._coordinator(cm)
            armed_seq, fallback_seq = await self._arm_and_reject_name_confirm(
                agent, session, hooks,
            )
            # BOTH attempts interrupted (original + fallback barged into).
            await self._deliver(agent, True, armed_seq)
            await self._deliver(agent, True, fallback_seq)
            self.assertIsNone(agent._name_confirm_awaiting_reply["key"])
            self.assertNotEqual(self._disposition(cm), "delivered")
            # Still owed → a bounded re-author remains available, not silently
            # consumed (the Call A "froze at armed" failure class).
            self.assertTrue(agent._owed_name_confirm["value"])
            await self._close(hooks)

    async def test_split_confirmation_finals_are_one_logical_confirmation(self):
        # Codex §9: split confirmation finals = one logical confirmation; no
        # lost answer, no duplicate re-arm. The candidate's confirmation arrives
        # as two STT finals ("It's" then "Christo").
        cm = agent_mod._new_phone_call_metrics()
        with self._judge_patch():
            agent, session, _, _, hooks = await self._coordinator(cm)
            armed_seq, fallback_seq = await self._arm_and_reject_name_confirm(
                agent, session, hooks,
            )
            await self._deliver(agent, True, armed_seq)
            await self._deliver(agent, False, fallback_seq)
            # First final does not confirm on its own → consulted once, still not
            # a duplicate re-arm; second final carries the name.
            await self._turn(hooks, "It's")
            await self._turn(hooks, "Christo")
            # Confirmed at least once; never a second phantom confirm authored.
            self.assertFalse(agent._owed_name_confirm["value"])
            ctx = await self._turn(hooks, "So yeah.")
            self.assertNotIn("name on record", str(ctx.items))
            await self._close(hooks)


class TestConfirmationAlsoClearsOwed(_IdentityRecoveryHarness):

    async def test_confirmation_clears_a_stale_owed_reauthor(self):
        # Codex §3 primary fix: crediting the confirmation must ALSO clear a
        # stale owed re-author so the loop cannot re-author a name the candidate
        # already confirmed. Seed owed directly (as an interrupted attempt would)
        # then confirm; owed must be cleared and no re-arm follows.
        cm = agent_mod._new_phone_call_metrics()
        with self._judge_patch():
            agent, session, _, _, hooks = await self._coordinator(cm)
            armed_seq, fallback_seq = await self._arm_and_reject_name_confirm(
                agent, session, hooks,
            )
            await self._deliver(agent, False, fallback_seq)
            # Simulate a stale owed latch surviving from a prior attempt.
            agent._owed_name_confirm["value"] = True
            agent._owed_name_confirm["mismatch"] = (
                agent._name_confirm_awaiting_reply["mismatch"]
            )
            await self._turn(hooks, _CONFIRM_REPLY)
            self.assertEqual(self._disposition(cm), "confirmed")
            self.assertFalse(agent._owed_name_confirm["value"],
                             "confirmation must clear the stale owed re-author")
            ctx = await self._turn(hooks, "Ready when you are.")
            self.assertNotIn("name on record", str(ctx.items))
            await self._close(hooks)


class TestNameConfirmInstructionPhaseIsolation(unittest.TestCase):

    def test_instruction_is_confirmation_only_no_topic_resume(self):
        # Codex §4: the instruction must not tell the model to resume the owed
        # plan objective in the same turn (the root of the compensation_drift
        # rejections). It must be confirmation-only.
        instr = phone.phone_name_confirm_instruction(
            {"record": "christo", "spoken": "deepak"},
        )
        low = instr.lower()
        self.assertNotIn("then continue", low)
        self.assertIn("do not move on to any other question", low)
        self.assertIn("ask only about the name", low)
        # Behavioural contract preserved.
        self.assertIn("do not assert either name", low)
        self.assertIn("never accuse", low)

    def test_compensation_reply_on_name_confirm_turn_no_longer_forced(self):
        # A natural confirmation-only reply on a name-confirm turn passes the
        # guard (no compensation clause is instructed, so no drift is provoked).
        instr = phone.phone_name_confirm_instruction(
            {"record": "christo", "spoken": "deepak"},
        )
        self.assertIsNone(
            phone.phone_generated_reply_rejection_reason(
                "Just to confirm — do you prefer Deepak or Christo?",
                phone.PHONE_NAME_CONFIRM_CLARIFICATION_TEXT,
                allow_closing=False, control_text=instr,
                max_question_acts=phone.phone_objective_guard_max_questions_for_phase(
                    "name_confirm",
                ),
            ),
        )

    def test_compensation_drift_guard_itself_is_not_weakened(self):
        # A comp probe on a NON-comp objective with a candidate turn that never
        # raised comp is STILL rejected — the guard is untouched.
        self.assertEqual(
            phone.phone_generated_reply_rejection_reason(
                "What is your current and expected compensation?",
                phone.PHONE_NAME_CONFIRM_CLARIFICATION_TEXT,
                allow_closing=False,
                candidate_text="This is his last match, so sad.",
                max_question_acts=2,
            ),
            "compensation_drift",
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
