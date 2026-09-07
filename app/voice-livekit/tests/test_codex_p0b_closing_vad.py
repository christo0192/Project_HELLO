"""Codex review F-P0b (§9, 2026-09-07) — the closing-state VAD check.

The final room-delete path had a goodbye tail-grace but NO candidate-speech
check: a goodbye latch + 1.5s grace could still delete the room while the
candidate was mid-sentence (Call #2's disconnect class). The `completed`
pre-delete path now waits for end-of-speech while local VAD shows active — or
very recent (< PHONE_CLOSE_VAD_RECENT_SEC) — candidate speech, bounded by
PHONE_CLOSE_VAD_WAIT_MAX_SEC. Explicit candidate end requests and disconnects
keep their immediate handling, and unthreaded VAD state (tests, legacy paths)
reads "not speaking" so nothing else changes.
"""

from __future__ import annotations

import asyncio
import types
import unittest
from unittest.mock import AsyncMock, patch

from tests.test_phone_gate import (  # noqa: E402
    FakeEventClient,
    _default_state,
    _make_native_coordinator,
)

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402


class _ClosingVadHarness(unittest.IsolatedAsyncioTestCase):

    @staticmethod
    def _state():
        return _default_state(questions=[
            {"key": "k1", "text": "First question?", "mandatory": True, "hint": None},
        ])

    async def _completed_coordinator(self, speaking, ended, *, client=None):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(), client=client,
            candidate_speaking=speaking, candidate_speech_ended=ended,
        )
        # Complete the one-question plan through the real advance path.
        agent._pending.update({
            "question": state.question_at(0),
            "prompt": "First question?",
            "candidate": "A substantive answer.",
            "message": None,
            "turn_ctx": types.SimpleNamespace(items=[]),
            "probe_used": False,
            "source_event_id": phone.plan_source_event_id("k1"),
        })
        await agent._on_advance()
        hooks["reply_started"].set()
        return agent, client, hooks

    async def _drive_completed(self, agent, hooks):
        delivered = agent._on_reply_delivered(False)
        if asyncio.iscoroutine(delivered):
            await delivered

    async def test_active_speech_defers_the_delete_until_end_of_speech(self):
        speaking = {"value": True}
        ended = asyncio.Event()
        agent, _, hooks = await self._completed_coordinator(speaking, ended)
        with patch.object(
            agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
        ) as delete:
            await self._drive_completed(agent, hooks)
            task = asyncio.ensure_future(hooks["task"])
            # The candidate is mid-sentence: the room must stay up.
            await asyncio.sleep(0.3)
            delete.assert_not_called()
            # End of speech releases the close (and the recency window is
            # zeroed so the test does not wait a wall-clock second).
            speaking["value"] = False
            speaking["ended_mono"] = agent_mod._monotonic() - 5.0
            ended.set()
            await asyncio.wait_for(task, timeout=5)
            delete.assert_called_once()
        hooks["log_patch"].stop()
        categories = [
            c.kwargs.get("error_category")
            for c in hooks["log"].info.call_args_list
            if c.kwargs.get("error_type") == "phone_room_teardown"
        ]
        self.assertIn("close_deferred_candidate_speaking", categories)

    async def test_the_wait_is_bounded_a_monologue_cannot_hold_the_room(self):
        speaking = {"value": True}
        ended = asyncio.Event()
        agent, _, hooks = await self._completed_coordinator(speaking, ended)
        with patch.object(agent_mod, "PHONE_CLOSE_VAD_WAIT_MAX_SEC", 0.2):
            with patch.object(
                agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
            ) as delete:
                await self._drive_completed(agent, hooks)
                # Speech never ends — the bounded wait must still proceed.
                await asyncio.wait_for(hooks["task"], timeout=5)
                delete.assert_called_once()
        hooks["log_patch"].stop()
        categories = [
            c.kwargs.get("error_category")
            for c in hooks["log"].info.call_args_list
            if c.kwargs.get("error_type") == "phone_room_teardown"
        ]
        self.assertIn("close_vad_wait_timeout", categories)

    async def test_recent_speech_is_not_silence(self):
        # Speech ENDED milliseconds ago (an inter-clause pause): the close
        # waits out the recency window before deleting.
        speaking = {"value": False, "ended_mono": agent_mod._monotonic()}
        ended = asyncio.Event()
        agent, _, hooks = await self._completed_coordinator(speaking, ended)
        with patch.object(agent_mod, "PHONE_CLOSE_VAD_RECENT_SEC", 0.3):
            with patch.object(
                agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
            ) as delete:
                await self._drive_completed(agent, hooks)
                task = asyncio.ensure_future(hooks["task"])
                await asyncio.sleep(0.05)
                delete.assert_not_called()
                await asyncio.wait_for(task, timeout=5)
                delete.assert_called_once()
        hooks["log_patch"].stop()

    async def test_stale_ended_stamp_closes_immediately(self):
        # Speech ended long ago: no deferral at all — the fast path stays fast.
        speaking = {"value": False, "ended_mono": agent_mod._monotonic() - 30.0}
        ended = asyncio.Event()
        agent, _, hooks = await self._completed_coordinator(speaking, ended)
        with patch.object(
            agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
        ) as delete:
            await self._drive_completed(agent, hooks)
            await asyncio.wait_for(hooks["task"], timeout=5)
            delete.assert_called_once()
        hooks["log_patch"].stop()
        categories = [
            c.kwargs.get("error_category")
            for c in hooks["log"].info.call_args_list
            if c.kwargs.get("error_type") == "phone_room_teardown"
        ]
        self.assertNotIn("close_deferred_candidate_speaking", categories)

    async def test_queue_owned_completion_also_checks_the_vad(self):
        speaking = {"value": True}
        ended = asyncio.Event()
        client = FakeEventClient(
            complete=phone.PhoneApiOutcome(False, phone.ASSESSMENT_QUEUED_STATUS),
        )
        agent, client, hooks = await self._completed_coordinator(
            speaking, ended, client=client,
        )
        with patch.object(agent_mod, "PHONE_CLOSE_VAD_WAIT_MAX_SEC", 0.2):
            with patch.object(
                agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
            ) as delete:
                await self._drive_completed(agent, hooks)
                result = await asyncio.wait_for(hooks["task"], timeout=5)
                delete.assert_called_once()
                self.assertTrue(result.scoring_queue_owned)
        hooks["log_patch"].stop()

    async def test_explicit_candidate_end_keeps_immediate_handling(self):
        # HALT_CANDIDATE_ENDED never routes through the completed VAD wait —
        # an explicit "end the call" is honoured immediately even while the
        # VAD still reads speaking (their own request outranks the check).
        speaking = {"value": True}
        ended = asyncio.Event()
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(),
            candidate_speaking=speaking, candidate_speech_ended=ended,
        )
        hooks["assistant_delivery_complete"].set()
        hooks["latest_assistant"][0] = "First question?"
        ctx = types.SimpleNamespace(items=[])
        await hooks["on_native_turn"](
            "Please end the call now.",
            types.SimpleNamespace(text_content="Please end the call now."),
            ctx,
        )
        hooks["reply_started"].set()
        with patch.object(
            agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
        ) as delete:
            delivered = agent._on_reply_delivered(False)
            if asyncio.iscoroutine(delivered):
                await delivered
            await asyncio.wait_for(hooks["task"], timeout=5)
            delete.assert_called_once()
        hooks["log_patch"].stop()
        categories = [
            c.kwargs.get("error_category")
            for c in hooks["log"].info.call_args_list
            if c.kwargs.get("error_type") == "phone_room_teardown"
        ]
        self.assertNotIn("close_deferred_candidate_speaking", categories)
        self.assertIn("candidate_ended", categories)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
