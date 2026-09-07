"""Codex review Finding B (2026-09-07) — durable per-key outcome distinctions.

`phone_session_progress` rows used to IMPLY "asked and answered" while the
commit machinery could advance a populated boundary whose ask was never
meaningfully established; PR #257's honesty landed only in the in-memory
boundary dictionary and a log line. The worker now derives ONE truthful
outcome at commit time — {asked_answered, volunteered_with_evidence,
asked_declined, asked_unanswered, not_delivered, skipped_bounded} — and it
rides the durable commit (0086 records it on the write-once progress row;
volunteered forward-skip rows record volunteered_with_evidence in the RPC).

§4 acceptance, asserted here at the worker seam (the DB half lives in
policy_tests.sql 0086-A/B):
  * an unasked objective cannot silently become asked/covered;
  * volunteered coverage retains real provenance without invented bot turns;
  * decline and capped skips advance only with explicit durable dispositions;
  * cursor advancement does not imply asked or covered.
"""

from __future__ import annotations

import asyncio
import types
import unittest
from unittest.mock import MagicMock, patch

from tests.test_phone_gate import (  # noqa: E402
    _default_state,
    _make_native_coordinator,
)

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402


class TestDispositionMapping(unittest.TestCase):
    """The pure commit-time mapping, all six outcomes + the honest None."""

    def _map(self, **boundary):
        return agent_mod._phone_boundary_disposition(boundary)

    def test_delivered_and_answered_on_topic(self):
        self.assertEqual(
            self._map(ask_delivered=True, answer_disposition="answered",
                      topic_relation="related", answer_evidence=False),
            "asked_answered",
        )

    def test_mixed_intent_evidence_outranks_the_broad_nonanswer(self):
        # Finding D composition: the values survived a counter-question — the
        # question WAS answered, whatever the broad predicate said.
        self.assertEqual(
            self._map(ask_delivered=True, answer_disposition="nonanswer",
                      topic_relation="covers", answer_evidence=True),
            "asked_answered",
        )

    def test_off_topic_substantive_is_not_recorded_as_covered(self):
        # §6 composition: `answered` + topic_relation=unrelated is NOT topical
        # coverage. Cursor advancement must not imply covered.
        self.assertEqual(
            self._map(ask_delivered=True, answer_disposition="answered",
                      topic_relation="unrelated", answer_evidence=False),
            "asked_unanswered",
        )

    def test_explicit_decline(self):
        self.assertEqual(
            self._map(ask_delivered=True, answer_disposition="declined",
                      topic_relation="related", answer_evidence=False),
            "asked_declined",
        )

    def test_capped_nonanswer_advance_is_asked_unanswered(self):
        self.assertEqual(
            self._map(ask_delivered=True, answer_disposition="nonanswer",
                      topic_relation="related", answer_evidence=False),
            "asked_unanswered",
        )

    def test_undelivered_ask_with_volunteered_evidence(self):
        self.assertEqual(
            self._map(ask_delivered=False, answer_disposition="answered",
                      topic_relation="covers", answer_evidence=True),
            "volunteered_with_evidence",
        )

    def test_undelivered_ask_without_evidence_is_not_delivered(self):
        # An unasked objective can never silently become asked/covered.
        self.assertEqual(
            self._map(ask_delivered=False, answer_disposition="answered",
                      topic_relation="related", answer_evidence=False),
            "not_delivered",
        )

    def test_delivery_gate_cap_exhaustion_is_an_explicit_bounded_skip(self):
        self.assertEqual(
            self._map(ask_delivered=False, answer_disposition="nonanswer",
                      topic_relation="related", answer_evidence=False,
                      bounded_skip=True),
            "skipped_bounded",
        )

    def test_legacy_boundary_without_signals_maps_to_none(self):
        # The tool-first lane / older shapes measure nothing: NULL in the row,
        # never a guessed enum member.
        self.assertIsNone(self._map(question="q", prompt="p", candidate="c"))

    def test_every_output_is_a_member_of_the_shared_vocabulary(self):
        outputs = {
            self._map(ask_delivered=True, answer_disposition="answered",
                      topic_relation="related"),
            self._map(ask_delivered=True, answer_disposition="declined"),
            self._map(ask_delivered=True, answer_disposition="nonanswer"),
            self._map(ask_delivered=False, answer_disposition="answered",
                      answer_evidence=True),
            self._map(ask_delivered=False, answer_disposition="nonanswer"),
            self._map(ask_delivered=False, answer_disposition="nonanswer",
                      bounded_skip=True),
        }
        self.assertTrue(outputs <= phone.PHONE_BOUNDARY_DISPOSITIONS)
        self.assertEqual(len(outputs), 6)


class TestDispositionRidesTheCommit(unittest.IsolatedAsyncioTestCase):
    """The live commit path sends the derived outcome to the durable write."""

    @staticmethod
    def _state():
        return _default_state(questions=[
            {"key": "k1", "text": "Tell me about your recent role.", "mandatory": True, "hint": None},
            {"key": "k2", "text": "What is your notice period?", "mandatory": True, "hint": None},
        ])

    async def _coordinator(self):
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=self._state(),
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

    async def _drain(self, predicate, tries=200):
        for _ in range(tries):
            await asyncio.sleep(0.005)
            if predicate():
                return True
        return False

    async def _close(self, hooks):
        hooks["task"].cancel()
        await asyncio.gather(hooks["task"], return_exceptions=True)
        hooks["log_patch"].stop()

    async def test_ordinary_answer_commits_asked_answered(self):
        agent, _, _, client, hooks = await self._coordinator()
        await self._turn(
            hooks, "I have been leading an operations team for six years.",
        )
        self.assertTrue(await self._drain(lambda: client.committed_keys == ["k1"]))
        self.assertEqual(client.boundaries[0]["disposition"], "asked_answered")
        await self._close(hooks)

    async def test_decline_commits_asked_declined(self):
        agent, _, state, client, hooks = await self._coordinator()
        state.resume_facts = {}
        await self._turn(hooks, "I'd rather not share the details of that role.")
        self.assertTrue(await self._drain(lambda: client.committed_keys == ["k1"]))
        self.assertEqual(client.boundaries[0]["disposition"], "asked_declined")
        await self._close(hooks)

    async def test_capped_nonanswer_commits_asked_unanswered(self):
        agent, _, _, client, hooks = await self._coordinator()
        # The re-ask budget for k1 is already exhausted: the next non-answer
        # advances DELIBERATELY — and the durable record says unanswered.
        agent._answer_reask_counts["k1"] = phone.phone_answer_gate_max_reasks()
        await self._turn(
            hooks, "If I answer that, will you tell me the salary band first?",
        )
        self.assertTrue(await self._drain(lambda: client.committed_keys == ["k1"]))
        self.assertEqual(client.boundaries[0]["disposition"], "asked_unanswered")
        await self._close(hooks)

    async def test_legacy_seeded_boundary_sends_no_disposition(self):
        # A boundary without the dimension signals (tool-first lane / legacy
        # test seams) commits exactly as before, and the fake records None —
        # the row would be NULL, an honest "not measured".
        agent, _, state, client, hooks = await self._coordinator()
        agent._pending.update({
            "question": state.question_at(0),
            "prompt": "Tell me about your recent role.",
            "candidate": "A substantive answer.",
            "message": None,
            "turn_ctx": types.SimpleNamespace(items=[]),
            "probe_used": False,
            "source_event_id": phone.plan_source_event_id("k1"),
        })
        await agent._on_advance()
        self.assertEqual(client.committed_keys, ["k1"])
        self.assertIsNone(client.boundaries[0]["disposition"])
        await self._close(hooks)

    async def test_clients_without_the_parameter_are_never_broken(self):
        # The commit probes the client's signature (the record_probe idiom): a
        # legacy client without `disposition` receives its old call shape.
        class _LegacyClient:
            def __init__(self):
                self.calls = []

            async def commit_boundary(
                self, session_id, question_key, expected_index,
                source_event_id, turns, covered_question_keys=None,
            ):
                self.calls.append(question_key)
                outcome = phone.PhoneApiOutcome(True, "applied")
                outcome.cursor = expected_index + 1
                return outcome

        legacy = _LegacyClient()
        agent, _, _, client, hooks = await self._coordinator()
        # Swap the events client's commit only (the seam under test).
        client.commit_boundary = legacy.commit_boundary
        await self._turn(
            hooks, "I have been leading an operations team for six years.",
        )
        self.assertTrue(await self._drain(lambda: legacy.calls == ["k1"]))
        await self._close(hooks)


class TestDispositionVersionSkewDowngrade(unittest.IsolatedAsyncioTestCase):
    """R3 (PR #260 adversarial review): new worker + old API must not wedge.

    An old API's strict schema rejects the unknown `disposition` key with a
    flat 400 — pre-repair, every boundary commit failed for the whole
    parallel-deploy window and the fleet's cursors stalled. The client now
    retries EXACTLY ONCE with the field omitted (idempotent on
    source_event_id; the row records NULL = "not measured") and logs
    `disposition_field_downgraded` so a lingering old API stays visible.
    """

    class _Probe:
        """Fake PhoneEventClient transport: an OLD API rejects any body
        carrying `disposition` with a business-class 400."""

        def __init__(self, reject_disposition, *, always_reject=False):
            self.posts = []
            self.reject_disposition = reject_disposition
            self.always_reject = always_reject

        async def _post(self, path, body, hint):
            self.posts.append(dict(body))
            if self.always_reject:
                return phone._ERR_BUSINESS
            if self.reject_disposition and "disposition" in body:
                return phone._ERR_BUSINESS
            return types.SimpleNamespace(json=lambda: {
                "ok": True, "status": "applied", "duplicate": False,
                "cursor": 1, "plan_complete": False, "expected_key": None,
            })

    TURNS = [
        {"speaker": "bot", "text": "Q?"},
        {"speaker": "candidate", "text": "A."},
    ]

    async def _commit(self, probe, disposition):
        return await phone.PhoneEventClient.commit_boundary(
            probe, "session", "k1", 0, "ev-1", self.TURNS,
            disposition=disposition,
        )

    async def test_old_api_400_downgrades_once_and_the_commit_lands(self):
        probe = self._Probe(reject_disposition=True)
        spy = MagicMock(wraps=phone._log)
        with patch.object(phone, "_log", spy):
            outcome = await self._commit(probe, "asked_answered")
        self.assertTrue(outcome.ok)
        self.assertEqual(len(probe.posts), 2)
        self.assertIn("disposition", probe.posts[0])
        self.assertNotIn("disposition", probe.posts[1])
        categories = [
            c.kwargs.get("error_category") for c in spy.info.call_args_list
            if c.kwargs.get("error_type") == "phone_api_version_skew"
        ]
        self.assertEqual(categories, ["disposition_field_downgraded"])

    async def test_new_api_path_is_unchanged_one_post_field_kept(self):
        probe = self._Probe(reject_disposition=False)
        spy = MagicMock(wraps=phone._log)
        with patch.object(phone, "_log", spy):
            outcome = await self._commit(probe, "asked_answered")
        self.assertTrue(outcome.ok)
        self.assertEqual(len(probe.posts), 1)
        self.assertIn("disposition", probe.posts[0])
        self.assertFalse([
            c for c in spy.info.call_args_list
            if c.kwargs.get("error_type") == "phone_api_version_skew"
        ])

    async def test_no_disposition_means_no_retry_machinery_at_all(self):
        # A dispositionless commit that 400s fails exactly as before — the
        # downgrade path never engages when there is nothing to downgrade.
        probe = self._Probe(reject_disposition=False, always_reject=True)
        outcome = await phone.PhoneEventClient.commit_boundary(
            probe, "session", "k1", 0, "ev-1", self.TURNS,
        )
        self.assertFalse(outcome.ok)
        self.assertEqual(len(probe.posts), 1)

    async def test_a_genuine_refusal_is_bounded_to_exactly_one_retry(self):
        # The 400 had some OTHER cause: the single downgrade retry refuses
        # again and the ordinary failure handling takes over — never a loop.
        probe = self._Probe(reject_disposition=True, always_reject=True)
        outcome = await self._commit(probe, "asked_answered")
        self.assertFalse(outcome.ok)
        self.assertEqual(outcome.error_category, phone._ERR_BUSINESS)
        self.assertEqual(len(probe.posts), 2)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
