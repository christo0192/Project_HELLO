"""Codex review Finding D (2026-09-07) — mixed answer + question turns keep
their information.

THE REPRODUCTION (§6, confirmed against these predicates before the fix):

    "If my current CTC is 20 LPA and expected is 50 LPA, can your team offer
    that?"
    phone_compensation_slots  → {'current': '20 LPA', 'expected': '50 LPA'}
    phone_answer_disposition  → nonanswer

The system extracted the answer, then classified the turn as a non-answer —
the live answer gate re-asked and the values were discarded. And:

    Q: "How do you review code quality?"
    A: "I enjoy cooking Italian food every weekend with my friends."
    disposition → answered   (off-topic substantive read as topical coverage)

THE FIX: `phone_turn_dimensions` represents answer evidence/slots, candidate
question, clarification, decline, and topic relation as INDEPENDENT
dimensions. Consumers compose them: values with objective-covering evidence
survive a counter-question in the same utterance (the boundary commits; the
reply answers the candidate's question without promises and asks only what is
missing); an evidence-free deflection still re-asks (bounded); off-topic
substantive speech is never marked as topical coverage for the disposition
consumers that feed commits (it rides the boundary as
``topic_relation="unrelated"``).
"""

from __future__ import annotations

import asyncio
import types
import unittest

from tests.test_phone_gate import (  # noqa: E402
    _FakeSpeech,
    _default_state,
    _make_native_coordinator,
)

import agent as agent_mod  # noqa: E402
import phone  # noqa: E402


_MIXED_COMP = (
    "If my current CTC is 20 LPA and expected is 50 LPA, can your team offer that?"
)
_PURE_DODGE = "If I tell you my CTC, will you give me the band?"
_OFF_TOPIC = "I enjoy cooking Italian food every weekend with my friends."
_COMP_Q = "What is your current CTC and expected CTC?"
_CODE_Q = "How do you review code quality?"


class TestTurnDimensions(unittest.TestCase):

    def test_reproduction_values_and_question_are_independent_dimensions(self):
        dims = phone.phone_turn_dimensions(_COMP_Q, "compensation", _MIXED_COMP)
        self.assertEqual(
            dims["slots"], {"current": "20 LPA", "expected": "50 LPA"},
        )
        self.assertTrue(dims["answer_evidence"])
        self.assertTrue(dims["candidate_question"])
        # The broad disposition still reads nonanswer — the point is that
        # consumers no longer collapse the turn onto it alone.
        self.assertEqual(dims["disposition"], phone.PHONE_ANSWER_NONANSWER)
        self.assertEqual(dims["topic_relation"], "covers")

    def test_actual_deflection_without_values_remains_a_nonanswer(self):
        dims = phone.phone_turn_dimensions(_COMP_Q, "compensation", _PURE_DODGE)
        self.assertEqual(dims["slots"], {})
        self.assertFalse(dims["answer_evidence"])
        self.assertTrue(dims["candidate_question"])
        self.assertEqual(dims["disposition"], phone.PHONE_ANSWER_NONANSWER)

    def test_off_topic_substantive_speech_is_not_topical_coverage(self):
        dims = phone.phone_turn_dimensions(_CODE_Q, None, _OFF_TOPIC)
        # The broad predicate still says "answered" — and that is exactly why
        # it must not be used as evidence of topical coverage (§6).
        self.assertEqual(dims["disposition"], phone.PHONE_ANSWER_ANSWERED)
        self.assertFalse(dims["answer_evidence"])
        self.assertEqual(dims["topic_relation"], "unrelated")

    def test_on_topic_paraphrase_is_never_downgraded_to_unrelated(self):
        # Conservative by construction: a legitimate answer phrased without
        # the question's literal words stays "related" (work-domain anchors).
        dims = phone.phone_turn_dimensions(
            "Tell me about your current role.", None,
            "I lead a team of five building payment systems.",
        )
        self.assertEqual(dims["topic_relation"], "related")
        # Structured evidence also protects: a duration answer is never
        # unrelated even with zero token overlap.
        dims = phone.phone_turn_dimensions(
            "What is your notice period?", None, "Roughly sixty days.",
        )
        self.assertNotEqual(dims["topic_relation"], "unrelated")

    def test_decline_and_clarification_dimensions(self):
        dims = phone.phone_turn_dimensions(
            _COMP_Q, "compensation", "I'd rather not share my compensation.",
        )
        self.assertTrue(dims["decline"])
        self.assertEqual(dims["disposition"], phone.PHONE_ANSWER_DECLINED)
        dims = phone.phone_turn_dimensions(
            _CODE_Q, None, "Sorry, what do you mean by that?",
        )
        self.assertTrue(dims["clarification"])
        self.assertTrue(dims["candidate_question"])


class _MixedIntentHarness(unittest.IsolatedAsyncioTestCase):

    @staticmethod
    def _state():
        return _default_state(questions=[
            {"key": "comp", "text": _COMP_Q, "mandatory": True, "hint": None},
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

    def _log_categories(self, hooks, error_type):
        return [
            c.kwargs.get("error_category")
            for c in hooks["log"].info.call_args_list
            if c.kwargs.get("error_type") == error_type
        ]


class TestMixedIntentCommit(_MixedIntentHarness):

    async def test_supplied_values_survive_a_counter_question(self):
        # §6 acceptance, verbatim: supplied values survive a counter-question
        # in the same utterance — the boundary COMMITS instead of re-asking.
        agent, _, _, client, hooks = await self._coordinator()
        ctx = await self._turn(hooks, _MIXED_COMP)
        self.assertTrue(await self._drain(
            lambda: client.committed_keys == ["comp"],
        ))
        # The exchange committed carries the candidate's own words.
        self.assertIn(_MIXED_COMP, str(client.boundaries[0]["turns"]))
        # No re-ask was charged.
        self.assertNotIn(
            "nonanswer_reask", self._log_categories(hooks, "phone_answer_gate"),
        )
        self.assertIn(
            "mixed_intent_evidence_commit",
            self._log_categories(hooks, "phone_answer_gate"),
        )
        # The reply answers the candidate's question FIRST — without promises.
        injected = str(ctx.items)
        self.assertIn("also carried a question", injected)
        self.assertIn("never make promises", injected)
        await self._close(hooks)

    async def test_deflection_without_values_still_reasks(self):
        # §6 acceptance: an actual deflection with no values remains a
        # non-answer — the cursor holds and the SAME question is re-asked.
        agent, _, state, client, hooks = await self._coordinator()
        ctx = await self._turn(hooks, _PURE_DODGE)
        for _ in range(30):
            await asyncio.sleep(0.005)
        self.assertEqual(client.committed_keys, [])
        self.assertEqual(agent._answer_reask_counts.get("comp"), 1)
        injected = str(ctx.items)
        # §6 acceptance: the candidate's question RECEIVES A RESPONSE before
        # the re-ask — honestly and without promises.
        self.assertIn("First give a brief, honest answer", injected)
        self.assertIn("re-ask", injected)
        self.assertIn("never making promises", injected)
        await self._close(hooks)

    async def test_partial_slots_reask_names_only_the_missing_slot(self):
        agent, _, _, client, hooks = await self._coordinator()
        ctx = await self._turn(
            hooks, "My current CTC is 20 LPA — can you match a good hike?",
        )
        for _ in range(30):
            await asyncio.sleep(0.005)
        # Half an answer does not advance a mandatory compensation objective…
        self.assertEqual(client.committed_keys, [])
        injected = str(ctx.items)
        # …but what was given SURVIVES: only the missing slot is re-asked.
        self.assertIn("already supplied", injected)
        self.assertIn("missing slot(s): expected", injected)
        self.assertIn("Do not ask for a known slot again", injected)
        await self._close(hooks)

    async def test_off_topic_substantive_commits_but_is_recorded_unrelated(self):
        # Behaviour is preserved (a substantive turn still advances — bounded
        # policy, no new re-ask loop), but the boundary now carries the honest
        # topic relation so the durable disposition consumers never record it
        # as topical coverage.
        state = _default_state(questions=[
            {"key": "code", "text": _CODE_Q, "mandatory": True, "hint": None},
            {"key": "k2", "text": "What is your notice period?", "mandatory": True, "hint": None},
        ])
        agent, session, state, client, hooks = await _make_native_coordinator(
            turn_mode="toolless", state=state,
        )
        hooks["assistant_delivery_complete"].set()
        hooks["latest_assistant"][0] = state.questions[0].spoken_text
        hooks["latest_assistant_anchor"][0] = 1
        await self._turn(hooks, _OFF_TOPIC)
        self.assertTrue(await self._drain(
            lambda: client.committed_keys == ["code"],
        ))
        self.assertEqual(agent._pending.get("topic_relation"), "unrelated")
        self.assertEqual(
            agent._pending.get("answer_disposition"), phone.PHONE_ANSWER_ANSWERED,
        )
        self.assertFalse(agent._pending.get("answer_evidence"))
        await self._close(hooks)

    async def test_coalesced_mixed_intent_also_keeps_its_values(self):
        # The counter-question arrives as a continuation fragment of the same
        # utterance (pre-first-audio STT split): the merged text carries both
        # slots, so the coalesced gate must NOT hold — mirror of the
        # single-final bypass.
        agent, _, state, client, hooks = await self._coordinator()
        await self._turn(hooks, "My current CTC is 20 LPA and expected is 50 LPA")
        stale = _FakeSpeech()
        hooks["reply_handle"][0] = stale
        hooks["reply_started"].set()
        hooks["speech_first_audio"].clear()
        await self._turn(hooks, "so can your team offer that much?")
        self.assertNotIn(
            "coalesced_nonanswer_reask",
            self._log_categories(hooks, "phone_answer_gate"),
        )
        # The merged exchange commits under the comp key with both values.
        self.assertTrue(await self._drain(
            lambda: client.committed_keys == ["comp"],
        ))
        merged = str(client.boundaries[0]["turns"])
        self.assertIn("20 LPA", merged)
        self.assertIn("50 LPA", merged)
        await self._close(hooks)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
