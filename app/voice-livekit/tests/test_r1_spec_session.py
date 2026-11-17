import asyncio
import copy
from dataclasses import replace
import hashlib
import json
import re
import os
import sys
import types
import unittest
from unittest.mock import patch

from r1_speculate import messages_equivalent
from r1_roleplay import TurnMode
from r1_session import R1Phase

from tests.test_r1_integration import (
    FakeProvider, Rig, cooperative_conversation, cooperative_script,
)


class ClosingProvider(FakeProvider):
    def __init__(self):
        super().__init__(hang=True)
        self.closed = 0

    async def _stream(self, text):
        try:
            async for chunk in super()._stream(text):
                yield chunk
        finally:
            self.closed += 1


class DeterministicProvider(FakeProvider):
    def __call__(self, messages):
        self.calls.append([dict(message) for message in messages])
        blob = json.dumps(messages, sort_keys=True)
        blob = re.sub(r"R=\d+:\d{2}|CANDIDATE_MONOLOGUE=\d+", "clock", blob)
        value = hashlib.sha256(blob.encode()).digest()[0]
        words = ("exploring", "considering", "weighing", "reviewing")
        return self._stream("I am " + words[value % len(words)] + " my options.")


class SpecSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_final_starts_and_commits_speculation(self):
        runner = FakeProvider("I am exploring my options.")
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=runner)
        await rig.start_roleplay()
        rig.engine
        rig.final("Could you tell me about your goals?")
        await rig.settle()
        self.assertEqual(len(runner.calls), 1)
        spec = rig.interview._spec
        self.assertIsNotNone(spec)
        rig.interview.prepare_turn("Could you tell me about your goals?")
        stream = rig.interview.llm_node_stream(None, rig.provider)
        spoken = [chunk async for chunk in stream]
        self.assertTrue(spoken)
        self.assertEqual(len(rig.provider.calls), 0)
        self.assertEqual(rig.interview._spec_counts.get("adopted"), 1)
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "0"}):
            other = Rig(provider=FakeProvider("I am exploring my options."))
        await other.start_roleplay()
        other.engine
        other.final("Could you tell me about your goals?")
        await other.settle()
        other.interview.prepare_turn("Could you tell me about your goals?")
        other_spoken = [chunk async for chunk in other.interview.llm_node_stream(
            None, other.provider
        )]
        self.assertEqual(spoken, other_spoken)
        self.assertTrue(messages_equivalent(spec.messages, other.provider.calls[0]))
        await rig.flush()
        await other.flush()

    async def test_flag_off_and_pure_entry(self):
        runner = FakeProvider()
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "0"}):
            rig = Rig(spec_reply_runner=runner)
        await rig.start_roleplay()
        rig.engine
        before = list(rig.interview._history)
        entry = rig.interview._candidate_entry("Hello", 7)
        self.assertEqual(rig.interview._history, before)
        self.assertEqual(rig.interview._note_candidate_turn("Hello", 7), entry)
        rig.final("Tell me about your goals.")
        await asyncio.sleep(0)
        self.assertEqual(runner.calls, [])
        await rig.flush()

    async def test_changed_finals_and_commit_key(self):
        runner = FakeProvider(hang=True)
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=runner)
        await rig.start_roleplay()
        rig.engine
        rig.final("Tell me about your goals.")
        await rig.settle()
        first = rig.interview._spec
        rig.final("And your career.")
        await rig.settle()
        self.assertTrue(first.task.done())
        self.assertEqual(len(runner.calls), 2)
        second = rig.interview._spec
        rig.interview.prepare_turn("A different committed turn.")
        self.assertTrue(second.task.cancelled() or second.task.cancelling())
        self.assertEqual(rig.interview._spec_counts["discarded_key"], 2)
        chunks = [chunk async for chunk in rig.interview.llm_node_stream(None, rig.provider)]
        self.assertTrue(chunks)
        self.assertEqual(len(rig.provider.calls), 1)
        self.assertFalse(second._replayed)
        await rig.settle()
        self.assertFalse(rig.interview._spec_retired)
        await rig.flush()

    async def test_failed_spec_falls_back(self):
        runner = FakeProvider(error=RuntimeError("synthetic"))
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=runner)
        await rig.start_roleplay()
        rig.engine
        text = "Could you tell me about your goals?"
        rig.final(text)
        await rig.settle()
        errors = rig.interview._llm_errors_reported
        failures = rig.interview._failures
        rig.interview.prepare_turn(text)
        chunks = [chunk async for chunk in rig.interview.llm_node_stream(None, rig.provider)]
        self.assertTrue(chunks)
        self.assertEqual(len(rig.provider.calls), 1)
        self.assertEqual(rig.interview._llm_errors_reported, errors)
        self.assertEqual(rig.interview._failures, failures)
        self.assertEqual(rig.interview._spec_counts["unusable"], 1)
        await rig.flush()

    async def test_deferred_and_exit_closes_task(self):
        from types import SimpleNamespace

        runner = ClosingProvider()
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=runner)
        await rig.start_roleplay()
        rig.engine
        rig.interview._on_user_state_changed(SimpleNamespace(new_state="speaking"))
        rig.final("Tell me about your goals.")
        self.assertIsNone(rig.interview._spec)
        rig.interview._on_user_state_changed(SimpleNamespace(new_state="listening"))
        await rig.settle()
        spec = rig.interview._spec
        self.assertIsNotNone(spec)
        rig.interview._begin_exit()
        await rig.flush()
        self.assertTrue(spec.task.done())
        self.assertEqual(runner.closed, 1)

    async def test_cap_and_default_runner_without_llm(self):
        runner = FakeProvider(hang=True)
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=runner)
        await rig.start_roleplay()
        rig.engine
        with patch("r1_session.SPEC_MAX_CALLS_PER_SESSION", 1):
            rig.final("Tell me about your goals.")
            await rig.settle()
            rig.final("And your career.")
        self.assertEqual(rig.interview._spec_counts["skipped_cap"], 1)
        self.assertEqual(len(runner.calls), 1)
        await rig.flush()
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            other = Rig()
        self.assertIsNone(other.interview._spec_runner_or_none())
        await other.flush()


    async def test_clock_tolerance(self):
        for seconds, adopted in ((1, True), (3, False)):
            runner = FakeProvider("I am exploring my options.")
            with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
                rig = Rig(spec_reply_runner=runner)
            await rig.start_roleplay()
            rig.engine
            rig.clock.advance(20)
            text = "Could you tell me about your goals?"
            rig.final(text)
            await rig.settle()
            spec = rig.interview._spec
            rig.clock.advance(seconds)
            rig.interview.prepare_turn(text)
            chunks = [chunk async for chunk in rig.interview.llm_node_stream(None, rig.provider)]
            self.assertTrue(chunks)
            self.assertEqual(bool(rig.interview._spec_counts.get("adopted")), adopted)
            self.assertEqual(len(rig.provider.calls), 0 if adopted else 1)
            if not adopted:
                self.assertFalse(spec.matches(rig.provider.calls[0]))
            await rig.flush()

    async def test_default_client_build_failure_disables_session(self):
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig()
        rig.session.llm = object()
        await rig.start_roleplay()
        rig.engine
        with patch("r1_llm.build_r1_llm", side_effect=RuntimeError("synthetic")):
            with patch("r1_session._log.warn") as warn:
                rig.final("Could you tell me about your goals?")
                await rig.settle()
        self.assertTrue(rig.interview._spec_unusable)
        self.assertIsNone(rig.interview._spec_runner_or_none())
        self.assertTrue(any(call.kwargs.get("error_type") == "r1_spec_reply_unusable"
                            for call in warn.call_args_list))
        await rig.flush()

    async def test_default_client_import_failure_disables_session(self):
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig()
        rig.session.llm = object()
        stub = types.ModuleType("livekit.agents")
        with patch.dict(sys.modules, {"livekit.agents": stub}):
            with patch("r1_session._log.warn") as warn:
                with self.assertRaises(ImportError):
                    async for _ in rig.interview._default_spec_runner([]):
                        pass
        self.assertTrue(rig.interview._spec_unusable)
        self.assertIsNone(rig.interview._spec_runner_or_none())
        unusable = [call for call in warn.call_args_list
                    if call.kwargs.get("error_type") == "r1_spec_reply_unusable"]
        self.assertEqual(len(unusable), 1)
        await rig.flush()

    async def test_summary_and_flag_off(self):
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=FakeProvider())
        await rig.start_roleplay()
        rig.engine
        rig.final("Could you tell me about your goals?")
        with patch("r1_session._log.info") as info:
            rig.interview._log_latency_summary()
        self.assertTrue(any(call.kwargs.get("schema") == "summary_spec"
                            for call in info.call_args_list))
        await rig.flush()
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "0"}):
            rig = Rig(spec_reply_runner=FakeProvider())
        with patch("r1_session._log.info") as info:
            rig.interview._log_latency_summary()
        self.assertFalse(any(call.kwargs.get("schema") == "summary_spec"
                             for call in info.call_args_list))
        await rig.flush()


    async def test_script_equivalence_on_and_off(self):
        rigs = []
        spoken = []
        for enabled in ("1", "0"):
            provider = DeterministicProvider()
            runner = DeterministicProvider()
            with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": enabled}):
                rig = Rig(provider=provider, spec_reply_runner=runner)
            await rig.start_roleplay()
            rig.engine
            spoken.append(await cooperative_conversation(rig, script=cooperative_script()[:15]))
            await rig.settle()
            rigs.append(rig)
        self.assertEqual(spoken[0], spoken[1])
        self.assertEqual(rigs[0].writer.saved, rigs[1].writer.saved)
        self.assertEqual(rigs[0].engine.admin_log(), rigs[1].engine.admin_log())
        adopted = rigs[0].interview._spec_counts.get("adopted", 0)
        self.assertGreater(adopted, 0)
        self.assertEqual(len(rigs[0].provider.calls) + adopted, len(rigs[1].provider.calls))
        self.assertEqual(rigs[1].interview._spec_total, 0)
        for rig in rigs:
            await rig.flush()


    async def test_per_row_cap(self):
        runner = FakeProvider(hang=True)
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=runner)
        await rig.start_roleplay()
        rig.engine
        for text in ("Tell me about your goals.", "And work.", "And family."):
            rig.final(text)
            await rig.settle()
        self.assertEqual(len(runner.calls), 2)
        self.assertEqual(rig.interview._spec_counts["skipped_cap"], 1)
        await rig.flush()

    async def test_guard_rejects_speculative_content(self):
        text = "Could you tell me about your goals?"
        answer = "As an AI language model, I follow my system prompt."
        spoken = []
        for enabled in ("1", "0"):
            with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": enabled}):
                rig = Rig(provider=FakeProvider(answer), spec_reply_runner=FakeProvider(answer))
            await rig.start_roleplay()
            rig.engine
            spoken.append(await rig.converse(text))
            if enabled == "1":
                self.assertEqual(rig.interview._spec_counts.get("adopted"), 1)
            await rig.flush()
        self.assertEqual(spoken[0], spoken[1])
        self.assertNotIn("system prompt", spoken[0])


    async def test_end_intent_skips_speculation(self):
        async def classifier(_messages):
            return "continue"

        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=FakeProvider(), end_intent_runner=classifier)
        await rig.start_roleplay()
        rig.engine
        rig.final("Okay, let's wrap up here.")
        await rig.settle()
        self.assertEqual(rig.interview._spec_counts.get("skipped_end_intent"), 1)
        self.assertIsNone(rig.interview._spec)
        await rig.flush()

    async def test_flag_off_matches_no_seam(self):
        rigs = []
        for use_seam in (True, False):
            provider = DeterministicProvider()
            kwargs = {"spec_reply_runner": DeterministicProvider()} if use_seam else {}
            with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "0"}):
                rig = Rig(provider=provider, **kwargs)
            await rig.start_roleplay()
            rig.engine
            await cooperative_conversation(rig, script=cooperative_script()[:15])
            await rig.settle()
            rigs.append(rig)
        self.assertEqual(rigs[0].writer.saved, rigs[1].writer.saved)
        self.assertEqual(rigs[0].provider.calls, rigs[1].provider.calls)
        self.assertEqual(rigs[0].engine.admin_log(), rigs[1].engine.admin_log())
        for rig in rigs:
            await rig.flush()


    async def test_stopped_decision_cancels_committed_spec(self):
        from r1_session import StopResponse

        runner = ClosingProvider()
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=runner)
        await rig.start_roleplay()
        rig.engine
        text = "Could you tell me about your goals?"
        rig.final(text)
        await rig.settle()
        spec = rig.interview._spec
        with patch.object(rig.interview, "_decide_turn", side_effect=StopResponse()):
            with self.assertRaises(StopResponse):
                rig.interview.prepare_turn(text)
        self.assertIsNone(rig.interview._spec_committed)
        await rig.flush()
        self.assertTrue(spec.task.done())
        self.assertEqual(runner.closed, 1)
        self.assertEqual(rig.interview._spec_counts["discarded_mode"], 1)

    async def test_commit_plan_changes_cancel_spec(self):
        cases = (
            ({"mode": TurnMode.SAY_ONLY, "scripted_text": "A synthetic line."},
             "A synthetic line."),
            ({"aside": True, "scripted_text": ""}, None),
            ({"exit_roleplay": True}, None),
        )
        for changes, expected in cases:
            with self.subTest(changes=changes):
                runner = ClosingProvider()
                with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
                    rig = Rig(spec_reply_runner=runner)
                await rig.start_roleplay()
                engine = rig.engine
                text = "Could you tell me about your goals?"
                rig.final(text)
                await rig.settle()
                spec = rig.interview._spec
                original = engine.plan_turn

                def changed_plan(*args, **kwargs):
                    return replace(original(*args, **kwargs), **changes)

                with patch.object(engine, "plan_turn", side_effect=changed_plan):
                    with patch.object(rig, "final"):
                        spoken = await rig.converse(text)
                await rig.settle()
                self.assertEqual(spoken, expected)
                self.assertEqual(len(rig.provider.calls), 0)
                self.assertTrue(spec.task.done())
                self.assertEqual(runner.closed, 1)
                self.assertEqual(rig.interview._spec_counts.get("discarded_mode"), 1)
                self.assertFalse(rig.interview._spec_retired)
                await rig.flush()

    async def test_phase_change_cancels_spec(self):
        runner = ClosingProvider()
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=runner)
        await rig.start_roleplay()
        rig.engine
        rig.final("Could you tell me about your goals?")
        await rig.settle()
        spec = rig.interview._spec
        rig.interview._enter(R1Phase.ASIDE)
        await rig.settle()
        self.assertTrue(spec.task.done())
        self.assertEqual(runner.closed, 1)
        self.assertEqual(rig.interview._spec_counts.get("discarded_mode"), 1)
        self.assertFalse(rig.interview._spec_retired)
        await rig.flush()

    async def test_dry_run_does_not_change_engine(self):
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=FakeProvider(hang=True))
        await rig.start_roleplay()
        engine = rig.engine
        def fingerprint():
            return (
                engine.turn, engine.last_r, copy.deepcopy(engine.scheduler.summary()),
                copy.deepcopy(engine.tracker.gate.records()), copy.deepcopy(vars(engine.ledger)),
                engine._late_stalls, engine._end_question_last, copy.deepcopy(engine._lost_plan),
                len(engine._word_counts),
            )

        before = fingerprint()
        log = copy.deepcopy(engine.admin_log())
        rig.final("Could you tell me about your goals?")
        await rig.settle()
        self.assertIsNotNone(rig.interview._spec)
        self.assertEqual(engine.admin_log(), log)
        self.assertEqual(fingerprint(), before)
        await rig.flush()

    async def test_discard_finished_spec_is_not_retired(self):
        with patch.dict(os.environ, {"R1_SPECULATIVE_REPLY": "1"}):
            rig = Rig(spec_reply_runner=FakeProvider())
        await rig.start_roleplay()
        rig.engine
        rig.final("Could you tell me about your goals?")
        await rig.settle()
        spec = rig.interview._spec
        self.assertTrue(spec.task.done())
        rig.interview._cancel_spec("discarded_mode")
        await rig.settle()
        self.assertFalse(rig.interview._spec_retired)
        await rig.flush()
