"""Codex review Findings F + H (2026-09-07) — funnel truth + exit observability.

Finding F (§8): the conflict-probe funnel separates SCHEDULED from DELIVERED.
`_arm_conflict_delivery` is the single choke point that counts
``conflict_probe_scheduled`` for EVERY origin (deterministic sync, async owed
promotion, LLM-authored, re-pursuit); ``conflict_probe_delivered`` is bumped
ONLY by the `on_reply_delivered` playout proof, also for every origin. The
async owed-probe branch used to bump `delivered` at ARMING time, so the same
metric mixed scheduled and played probes and an RCA could not tell a probe
that played from one that never reached audio.

Finding H (§10): the per-call observability snapshot persists on ALL exit
paths, not just the ``reason == "completed"`` completion body. A candidate
hangup / disconnect / recovery exit posts the same compact snapshot through
the standalone ``/observability`` endpoint — best-effort, idempotent, and
never an empty snapshot (the empty guard lives in BOTH the worker client and
the API route, so good data cannot be overwritten by nothing).
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


class _ObservabilityFakeClient(FakeEventClient):
    """FakeEventClient + the Finding H standalone observability endpoint."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.observability_posts: list[tuple[str, dict]] = []

    async def post_observability(self, session_id, metrics):
        self.observability_posts.append((session_id, metrics))
        return phone.PhoneApiOutcome(True, "ok")


class _Harness(unittest.IsolatedAsyncioTestCase):
    RESUME_FACTS = {"current_role": {"title": "Data Engineer"}}
    CONFLICT_TEXT = "I spent two years in sales and advisory roles."

    @staticmethod
    def _state():
        state = _default_state(questions=[
            {"key": "k1", "text": "Tell me about your recent role.", "mandatory": True, "hint": None},
            {"key": "k2", "text": "What is your notice period?", "mandatory": True, "hint": None},
        ])
        state.resume_facts = {"current_role": {"title": "Data Engineer"}}
        return state

    async def _coordinator(
        self, call_metrics=None, *, client=None, coverage_judge_enabled=True,
    ):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(), client=client,
            coverage_judge_enabled=coverage_judge_enabled,
            call_metrics=call_metrics,
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

    async def _close(self, hooks):
        hooks["task"].cancel()
        await asyncio.gather(hooks["task"], return_exceptions=True)
        hooks["log_patch"].stop()

    async def _deliver(self, agent, interrupted=False, delivered_seq=None):
        value = agent._on_reply_delivered(interrupted, delivered_seq)
        if asyncio.iscoroutine(value):
            await value


# ── Finding F — the scheduled/delivered split ────────────────────────────────

class TestConflictProbeFunnel(_Harness):

    async def test_sync_arm_counts_scheduled_then_delivery_counts_delivered(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=phone.PhoneCoverageVerdict(True, None, "model"),
        ):
            agent, _, _, _, hooks = await self._coordinator(call_metrics)
            await self._turn(hooks, self.CONFLICT_TEXT)
            judge = call_metrics["coverage_judge"]
            # Arming is scheduling — not yet a delivery.
            self.assertEqual(judge["conflict_probe_scheduled"], 1)
            self.assertEqual(judge["conflict_probe_delivered"], 0)
            await self._deliver(agent, False)
            self.assertEqual(judge["conflict_probe_scheduled"], 1)
            self.assertEqual(judge["conflict_probe_delivered"], 1)
            await self._close(hooks)

    async def test_interrupted_probe_is_scheduled_but_never_delivered(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        with patch.object(
            phone, "judge_phone_coverage", new_callable=AsyncMock,
            return_value=phone.PhoneCoverageVerdict(True, None, "model"),
        ):
            agent, _, _, _, hooks = await self._coordinator(call_metrics)
            await self._turn(hooks, self.CONFLICT_TEXT)
            judge = call_metrics["coverage_judge"]
            armed_seq = agent._conflict_delivery.get("sequence")
            self.assertIsNotNone(armed_seq)
            # Barged into on its OWN speech handle: the probe never played.
            await self._deliver(agent, True, delivered_seq=armed_seq)
            self.assertEqual(judge["conflict_probe_scheduled"], 1)
            self.assertEqual(judge["conflict_probe_delivered"], 0)
            await self._close(hooks)

    async def test_llm_authored_arm_counts_scheduled_via_the_choke_point(self):
        call_metrics = agent_mod._new_phone_call_metrics()
        agent, _, _, _, hooks = await self._coordinator(
            call_metrics, coverage_judge_enabled=False,
        )
        judge = call_metrics["coverage_judge"]
        armed = agent._maybe_arm_llm_authored_conflict(
            phone.PHONE_RESUME_CONFLICT_CLARIFICATION_TEXT,
        )
        self.assertTrue(armed)
        self.assertEqual(judge["conflict_probe_scheduled"], 1)
        self.assertEqual(judge["conflict_probe_delivered"], 0)
        # The playout proof counts the delivery for this origin too.
        await self._deliver(agent, False)
        self.assertEqual(judge["conflict_probe_delivered"], 1)
        await self._close(hooks)

    def test_summary_carries_both_funnel_buckets(self):
        metrics = agent_mod._new_phone_call_metrics()
        metrics["coverage_judge"]["conflict_probe_scheduled"] = 2
        metrics["coverage_judge"]["conflict_probe_delivered"] = 1
        snapshot = agent_mod._summarize_phone_call_metrics(metrics)
        self.assertEqual(snapshot["coverage_judge"]["conflict_probe_scheduled"], 2)
        self.assertEqual(snapshot["coverage_judge"]["conflict_probe_delivered"], 1)


# ── Finding H — observability on every exit ──────────────────────────────────

class TestObservabilityOnAllExits(_Harness):

    async def test_candidate_hangup_posts_a_nonempty_snapshot(self):
        client = _ObservabilityFakeClient()
        agent, _, _, client, hooks = await self._coordinator(
            client=client, coverage_judge_enabled=False,
        )
        await self._turn(hooks, "Please end the call now, I have to go.")
        hooks["reply_started"].set()
        await hooks["drive_terminal"]()
        self.assertEqual(len(client.observability_posts), 1)
        session_id, snapshot = client.observability_posts[0]
        self.assertIsInstance(snapshot, dict)
        self.assertTrue(snapshot)
        self.assertIn("watchdog_fired_count", snapshot)
        self.assertIn("coverage_judge", snapshot)
        # The hangup leg never reached completion, so the completion body
        # carried no metrics.
        self.assertIsNone(client.last_complete_metrics)

    async def test_disconnect_posts_snapshot_and_preserves_the_room(self):
        client = _ObservabilityFakeClient()
        agent, _, _, client, hooks = await self._coordinator(
            client=client, coverage_judge_enabled=False,
        )
        agent._native_terminal_reason["reason"] = "disconnect"
        agent._native_finished.set()
        with patch.object(
            agent_mod, "_delete_livekit_room", new_callable=AsyncMock,
        ) as delete:
            await asyncio.wait_for(hooks["task"], timeout=5)
            delete.assert_not_called()
        hooks["log_patch"].stop()
        self.assertEqual(len(client.observability_posts), 1)

    async def test_completed_rides_the_completion_body_without_double_post(self):
        client = _ObservabilityFakeClient()
        agent, _, state, client, hooks = await self._coordinator(
            client=client, coverage_judge_enabled=False,
        )
        # Complete the two-question plan through the real advance path.
        for key in ("k1", "k2"):
            question = state.question_at(state.cursor if False else 0)
            agent._pending.update({
                "question": next(q for q in state.questions if q.key == key),
                "prompt": "Question?",
                "candidate": "A substantive answer.",
                "message": None,
                "turn_ctx": types.SimpleNamespace(items=[]),
                "probe_used": False,
                "source_event_id": phone.plan_source_event_id(key),
            })
            await agent._on_advance()
        hooks["reply_started"].set()
        await hooks["drive_terminal"]()
        # The snapshot rode complete_assessment; the standalone path stayed quiet.
        self.assertIsNotNone(client.last_complete_metrics)
        self.assertEqual(client.observability_posts, [])

    async def test_completed_with_failed_completion_falls_back_to_standalone(self):
        client = _ObservabilityFakeClient(
            complete=phone.PhoneApiOutcome(False, "plan_incomplete"),
        )
        agent, _, state, client, hooks = await self._coordinator(
            client=client, coverage_judge_enabled=False,
        )
        for key in ("k1", "k2"):
            agent._pending.update({
                "question": next(q for q in state.questions if q.key == key),
                "prompt": "Question?",
                "candidate": "A substantive answer.",
                "message": None,
                "turn_ctx": types.SimpleNamespace(items=[]),
                "probe_used": False,
                "source_event_id": phone.plan_source_event_id(key),
            })
            await agent._on_advance()
        hooks["reply_started"].set()
        await hooks["drive_terminal"]()
        # The completion refused (plan_incomplete is non-retryable), so the
        # snapshot it carried was never written — the standalone post covers it.
        self.assertEqual(len(client.observability_posts), 1)

    async def test_clients_without_the_endpoint_stay_correct(self):
        # A legacy fake/in-memory client without `post_observability` must not
        # perturb the terminal path (defensive getattr, house pattern).
        agent, _, _, client, hooks = await self._coordinator(
            coverage_judge_enabled=False,
        )
        await self._turn(hooks, "Please end the call now, I have to go.")
        hooks["reply_started"].set()
        await hooks["drive_terminal"]()  # must not raise
        self.assertFalse(hasattr(client, "observability_posts"))

    async def test_client_guard_refuses_an_empty_snapshot_without_a_request(self):
        # phone.PhoneEventClient.post_observability never POSTs an empty dict —
        # the server-side guard is the backstop, this is the first line.
        calls = []

        class _Probe:
            async def _post(self, *args, **kwargs):  # pragma: no cover
                calls.append(args)
                return None

        outcome = await phone.PhoneEventClient.post_observability(
            _Probe(), "session", {},
        )
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.error_category, "empty_snapshot")
        self.assertEqual(calls, [])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
