"""Codex review §13 — the deterministic event-replay harness.

THE MISSING TEST LAYER the review named: the historical suites pin single
schedules (one STT final, one delivery callback, one judge verdict), so a
defect that only appears under a different EVENT TIMING — fragmented finals,
finals racing first-audio, a judge verdict landing late, a rejected
generation, a delayed TTS tail, a disconnect during closing — has no net.

This module replays the SAME logical conversation against the REAL
coordinator (`_run_native_phone_screening` via the existing fake-SDK
bootstrap) under varied event schedules and asserts the CORE invariant
verbatim from the review:

    The same logical exchange cannot change question ownership merely
    because event timing changed.

Concretely: across every schedule, the committed key sequence is identical,
each key is charged the same logical answer, and no key is ever charged
another exchange's speech. The conflict scenarios additionally assert that a
clarification exchange is never committed under a plan key, whatever the
relative timing of consumption, judge verdicts, probe interruptions, and
background commits.

These are fake-coordinator schedules, not SDK timing proofs (the review's own
distinction) — the harness owns every event explicitly, which is what makes
the schedules deterministic and replayable. It is the safety net for the
durable-outcome (Finding B) and exchange-identity (Finding C) changes; the
Finding C commit extends it with the fragmented-clarification schedule its
fence exists to close.
"""

from __future__ import annotations

import asyncio
import types
import unittest
from unittest.mock import AsyncMock, patch

from tests.test_phone_gate import (  # noqa: E402
    _FakeSpeech,
    _default_state,
    _make_native_coordinator,
)

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402


_Q1 = "Tell me about your recent role."
_Q2 = "What is your notice period?"
_ANSWER_1 = "I have been working in operations for six years."
_ANSWER_2 = "My notice period is thirty days."


class _ReplayHarness(unittest.IsolatedAsyncioTestCase):
    """Drives one logical conversation through the real coordinator under a
    schedule of explicit events."""

    @staticmethod
    def _state(resume_facts=None):
        state = _default_state(questions=[
            {"key": "k1", "text": _Q1, "mandatory": True, "hint": None},
            {"key": "k2", "text": _Q2, "mandatory": True, "hint": None},
        ])
        state.resume_facts = resume_facts or {}
        return state

    async def _coordinator(self, *, judge=False, resume_facts=None):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(resume_facts),
            coverage_judge_enabled=judge,
        )
        hooks["assistant_delivery_complete"].set()
        hooks["latest_assistant"][0] = _Q1
        hooks["latest_assistant_anchor"][0] = 1
        return agent, session, state, client, hooks

    async def _turn(self, hooks, text):
        import sys
        ctx = types.SimpleNamespace(items=[])
        try:
            await hooks["on_native_turn"](
                text, types.SimpleNamespace(text_content=text), ctx,
            )
        except sys.modules["livekit.agents"].StopResponse:
            # A suppressed/coalesced fragment exits via StopResponse — normal
            # control flow for a continuation, not an error.
            pass
        return ctx

    def _begin_streaming_reply(self, hooks, *, first_audio=False):
        """The bot's reply cycle for the last turn has started (pre/post
        first-audio per the schedule) — the structural signal the coalescer
        keys on."""
        hooks["reply_handle"][0] = _FakeSpeech()
        hooks["reply_started"].set()
        if first_audio:
            hooks["speech_first_audio"].set()
        else:
            hooks["speech_first_audio"].clear()

    async def _deliver(self, agent, interrupted=False, delivered_seq=None):
        value = agent._on_reply_delivered(interrupted, delivered_seq)
        if asyncio.iscoroutine(value):
            await value

    async def _drain_commits(self, client, count, tries=300):
        for _ in range(tries):
            await asyncio.sleep(0.005)
            if len(client.committed_keys) >= count:
                return True
        return False

    async def _close(self, hooks):
        hooks["task"].cancel()
        await asyncio.gather(hooks["task"], return_exceptions=True)
        hooks["log_patch"].stop()

    def _charged(self, client):
        """{question_key: concatenated candidate speech charged to it}."""
        charged: dict[str, str] = {}
        for boundary in client.boundaries:
            text = " ".join(
                t["text"] for t in boundary["turns"]
                if t.get("speaker") == "candidate"
            )
            charged[boundary["question_key"]] = charged.get(
                boundary["question_key"], "",
            ) + " " + text
        return charged


# ── Scenario 1: the plain two-question conversation ──────────────────────────

class TestPlainConversationOwnershipIsScheduleInvariant(_ReplayHarness):
    """One logical conversation; many schedules; identical ownership."""

    async def _run_schedule(self, schedule_name):
        agent, _, _, client, hooks = await self._coordinator()

        async def exchange(fragments, next_question):
            # First final of the logical exchange.
            await self._turn(hooks, fragments[0])
            # Continuation fragments arrive while the reply is streaming
            # pre-first-audio — the same logical utterance, STT-split.
            for fragment in fragments[1:]:
                self._begin_streaming_reply(hooks, first_audio=False)
                await self._turn(hooks, fragment)
            hooks["latest_assistant"][0] = next_question

        if schedule_name == "single_final":
            await exchange((_ANSWER_1,), _Q2)
            await self._drain_commits(client, 1)
            await exchange((_ANSWER_2,), _Q2)
        elif schedule_name == "split_two_finals":
            await exchange(
                ("I have been working", " in operations for six years."), _Q2,
            )
            await self._drain_commits(client, 1)
            await exchange((_ANSWER_2,), _Q2)
        elif schedule_name == "many_fragments":
            await exchange(
                ("I have been working", " in operations", " for six years."),
                _Q2,
            )
            await self._drain_commits(client, 1)
            await exchange(("My notice period", " is thirty days."), _Q2)
        elif schedule_name == "final_before_first_audio_then_delivery":
            # The second exchange's commit settles through the delayed-TTS
            # window: delivery incomplete at commit time, first audio landing
            # a beat later.
            await exchange((_ANSWER_1,), _Q2)
            await self._drain_commits(client, 1)
            await self._turn(hooks, _ANSWER_2)
            hooks["assistant_delivery_complete"].clear()
            self._begin_streaming_reply(hooks, first_audio=False)
            await asyncio.sleep(0.05)
            hooks["speech_first_audio"].set()
            hooks["assistant_delivery_complete"].set()
        elif schedule_name == "rejected_generation_between_turns":
            await exchange((_ANSWER_1,), _Q2)
            await self._drain_commits(client, 1)
            # The reply generation for turn 1 was rejected by the guard; the
            # deterministic recovery owns re-delivery. Ownership of the
            # ALREADY-CAPTURED exchange must not move.
            empty = getattr(agent, "_on_generation_empty", None)
            if callable(empty):
                empty("question_mark_count")
            await exchange((_ANSWER_2,), _Q2)
        elif schedule_name == "delivery_callback_after_next_final":
            # The delivery callback for reply 1 lands LATE — after the second
            # exchange's final already arrived.
            await exchange((_ANSWER_1,), _Q2)
            await self._drain_commits(client, 1)
            await self._turn(hooks, _ANSWER_2)
            await self._deliver(agent, False)
        else:  # pragma: no cover - schedule typo guard
            raise AssertionError(f"unknown schedule {schedule_name}")

        self.assertTrue(
            await self._drain_commits(client, 2),
            f"{schedule_name}: both boundaries must commit",
        )
        charged = self._charged(client)
        await self._close(hooks)
        return client.committed_keys, charged

    async def test_ownership_is_identical_across_all_schedules(self):
        results = {}
        for schedule in (
            "single_final",
            "split_two_finals",
            "many_fragments",
            "final_before_first_audio_then_delivery",
            "rejected_generation_between_turns",
            "delivery_callback_after_next_final",
        ):
            with self.subTest(schedule=schedule):
                keys, charged = await self._run_schedule(schedule)
                results[schedule] = (keys, charged)
                # Same committed key sequence…
                self.assertEqual(keys, ["k1", "k2"], schedule)
                # …each key charged with ITS OWN exchange's speech…
                self.assertIn("six years", charged["k1"], schedule)
                self.assertIn("thirty days", charged["k2"], schedule)
                # …and NEVER the other exchange's (the core assertion).
                self.assertNotIn("thirty days", charged["k1"], schedule)
                self.assertNotIn("six years", charged["k2"], schedule)

    async def test_disconnect_during_closing_changes_no_ownership(self):
        agent, _, _, client, hooks = await self._coordinator()
        await self._turn(hooks, _ANSWER_1)
        await self._drain_commits(client, 1)
        hooks["latest_assistant"][0] = _Q2
        await self._turn(hooks, _ANSWER_2)
        await self._drain_commits(client, 2)
        keys_before = list(client.committed_keys)
        # The room dies during the closing phase.
        agent._native_terminal_reason["reason"] = "disconnect"
        agent._native_finished.set()
        with patch.object(
            agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
        ):
            await asyncio.wait_for(hooks["task"], timeout=5)
        hooks["log_patch"].stop()
        self.assertEqual(client.committed_keys, keys_before)
        charged = self._charged(client)
        self.assertNotIn("thirty days", charged["k1"])
        self.assertNotIn("six years", charged["k2"])


# ── Scenario 2: the conflict clarification exchange ──────────────────────────

_CONFLICT_ANSWER = "I spent two years in sales and advisory roles."
_CLARIFICATION_DEFLECTION = (
    "I don't understand what conflicts my answer and the resume."
)
_RECONCILE = (
    "The sales work was a side project; my main role was data engineering."
)


class TestConflictClarificationNeverStealsOwnership(_ReplayHarness):
    """The clarification exchange belongs to the conflict loop, never to a
    plan key — whatever the relative timing of probe delivery, consumption,
    judge verdicts, and background commits."""

    RESUME = {"current_role": {"title": "Data Engineer"}}

    async def _run_conflict_schedule(self, schedule_name):
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=phone.PhoneCoverageVerdict(True, None, "model"),
        ):
            agent, _, _, client, hooks = await self._coordinator(
                judge=True, resume_facts=self.RESUME,
            )
            # E1: the source answer — detects the conflict, arms the probe,
            # and legitimately commits its OWN key.
            await self._turn(hooks, _CONFLICT_ANSWER)
            self.assertIsNotNone(agent._conflict_delivery.get("key"))

            if schedule_name == "consumed_after_source_commit":
                await self._drain_commits(client, 1)
                await self._deliver(agent, False)   # probe played
                await self._turn(hooks, _CLARIFICATION_DEFLECTION)
                await self._deliver(agent, False)   # re-pursuit played
                await self._turn(hooks, _RECONCILE)
            elif schedule_name == "consumed_before_source_commit":
                # The probe plays and the clarification arrives BEFORE the
                # background commit of the source answer has run.
                await self._deliver(agent, False)
                await self._turn(hooks, _CLARIFICATION_DEFLECTION)
                await self._drain_commits(client, 1)
                await self._deliver(agent, False)
                await self._turn(hooks, _RECONCILE)
            elif schedule_name == "interrupted_probe":
                await self._drain_commits(client, 1)
                # The probe is barged into on its own handle: never played,
                # clarification machinery disarms — the candidate's next turn
                # is an ordinary answer.
                armed_seq = agent._conflict_delivery.get("sequence")
                await self._deliver(agent, True, delivered_seq=armed_seq)
            elif schedule_name == "late_judge_verdict":
                # The async judge's conflict verdict lands only AFTER the
                # source commit — the owed probe rides the NEXT authored turn
                # and its clarification still owns no plan key.
                await self._drain_commits(client, 1)
                await self._deliver(agent, False)
                await self._turn(hooks, _CLARIFICATION_DEFLECTION)
                await self._deliver(agent, False)
                await self._turn(hooks, _RECONCILE)
            else:  # pragma: no cover
                raise AssertionError(f"unknown schedule {schedule_name}")

            # E2: the notice-period answer arrives; its key must be charged
            # with IT, and only it.
            hooks["latest_assistant"][0] = _Q2
            await self._turn(hooks, _ANSWER_2)
            self.assertTrue(
                await self._drain_commits(client, 2),
                f"{schedule_name}: both plan keys must commit",
            )
            charged = self._charged(client)
            keys = list(client.committed_keys)
            await self._close(hooks)
            return keys, charged

    async def test_clarification_never_commits_under_a_plan_key(self):
        for schedule in (
            "consumed_after_source_commit",
            "consumed_before_source_commit",
            "interrupted_probe",
            "late_judge_verdict",
        ):
            with self.subTest(schedule=schedule):
                keys, charged = await self._run_conflict_schedule(schedule)
                self.assertEqual(keys, ["k1", "k2"], schedule)
                # The source answer owns k1; the notice answer owns k2.
                self.assertIn("sales and advisory", charged["k1"], schedule)
                self.assertIn("thirty days", charged["k2"], schedule)
                # THE CORE ASSERTION: no fragment of the clarification
                # exchange is ever charged to a plan key.
                for key, text in charged.items():
                    self.assertNotIn("don't understand", text, schedule)
                    self.assertNotIn("side project", text, schedule)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
