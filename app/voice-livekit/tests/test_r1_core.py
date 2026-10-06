"""Bare-Python coverage for the isolated R1 worker core."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_context
import r1_llm
from r1_lines import line, safe_first_name
from r1_phases import MAX_AGENT_RESIDENCY_SEC, NORMAL_PATH_MAX_SEC, R1Phase, R1PhaseMachine
from r1_session import R1Interview


class Clock:
    def __init__(self): self.value = 0.0
    def __call__(self): return self.value
    def advance(self, seconds): self.value += seconds


class TestPhases(unittest.TestCase):
    def test_pinned_timing_arithmetic(self):
        self.assertEqual(NORMAL_PATH_MAX_SEC, 22 * 60 + 27)
        self.assertEqual(MAX_AGENT_RESIDENCY_SEC, 27 * 60 + 45)
        self.assertLess(MAX_AGENT_RESIDENCY_SEC, 1800)

    def test_forward_only_and_roleplay_pause(self):
        clock = Clock(); machine = R1PhaseMachine(clock)
        with self.assertRaisesRegex(RuntimeError, "r1_invalid_transition"):
            machine.transition(R1Phase.ROLEPLAY)
        machine.transition(R1Phase.OPENING); machine.transition(R1Phase.ICEBREAKER)
        machine.transition(R1Phase.TRANSITION); machine.transition(R1Phase.ROLEPLAY)
        clock.advance(60); machine.transition(R1Phase.ASIDE); clock.advance(30)
        machine.transition(R1Phase.ROLEPLAY); clock.advance(20)
        self.assertEqual(machine.roleplay_elapsed, 80)

    def test_rejoin_within_grace_resumes_prior_phase(self):
        machine = R1PhaseMachine(Clock())
        machine.transition(R1Phase.OPENING); machine.transition(R1Phase.ICEBREAKER)
        machine.begin_disconnect()
        self.assertEqual(machine.phase, R1Phase.PAUSED_DISCONNECTED)
        self.assertEqual(machine.rejoin(), R1Phase.ICEBREAKER)


class TestLinesAndGuards(unittest.TestCase):
    def test_scripted_line_and_name_sanitisation(self):
        self.assertEqual(safe_first_name("not/a/name"), "there")
        self.assertIn("Christy", line("L-OPEN", first_name="Asha"))
        self.assertIn("Asha", line("L-CLOSE", first_name="Asha"))

    def test_context_fails_closed(self):
        def broken(*_args): raise OSError("offline")
        with self.assertRaises(r1_context.R1ContextError):
            asyncio.run(r1_context.fetch_context("screening-x", requester=broken))

    def test_llm_host_and_thinking_guards(self):
        with self.assertRaises(r1_llm.R1LLMConfigurationError):
            r1_llm.r1_llm_config({"DEEPSEEK_API_KEY": "x", "R1_LLM_BASE_URL": "https://elsewhere.example/v1"})
        config = r1_llm.r1_llm_config({"DEEPSEEK_API_KEY": "x"})
        self.assertEqual(config["reasoning_effort"], "none")
        self.assertEqual(config["extra_body"]["thinking"]["type"], "disabled")
        with self.assertRaisesRegex(RuntimeError, "reasoning"):
            r1_llm.assert_thinking_disabled(type("R", (), {"usage": type("U", (), {"reasoning_tokens": 1})()})())
        self.assertEqual(r1_llm.r1_provenance({})["provider"], "deepseek")


class FakeSession:
    def __init__(self, clock): self.clock, self.spoken, self.llm_turns = clock, [], []
    def say(self, text, **_kwargs):
        self.spoken.append(text)
        return type("H", (), {"wait_for_playout": staticmethod(lambda: None)})()
    async def wait_for_candidate(self, _seconds): return True
    async def start(self, **kwargs): self.started = kwargs
    async def next_candidate_turn(self):
        self.clock.advance(300)
        return "candidate response"
    async def respond_to_turn(self, text, phase):
        self.llm_turns.append((text, phase))
        return "brief learner reply"

class FakeWriter:
    def __init__(self, order): self.order = order
    async def usage_disconnect(self, _seconds): self.order.append("ledger")
    async def terminal(self, _outcome, _duration): self.order.append("terminal")

class TestR1Integration(unittest.IsolatedAsyncioTestCase):
    async def test_full_phase_machine_uses_injected_fake_session(self):
        clock = Clock(); order = []; session = FakeSession(clock)
        interview = R1Interview(object(), {"first_name": "Asha"}, session, FakeWriter(order), clock=clock,
                                recorder_finish=lambda: _append(order, "recording"), close_room=lambda: _append(order, "room"))
        self.assertEqual(await interview.run(), "complete")
        self.assertFalse(session.started["record"])
        self.assertEqual(session.started["room_options"], {"text_input": False})
        self.assertTrue(session.llm_turns)  # fake STT -> fake LLM -> fake TTS
        self.assertEqual(order, ["recording", "ledger", "terminal", "room"])

    async def test_exit_order_is_invariant_for_every_outcome(self):
        for outcome in ("complete", "candidate_left", "no_show", "shutdown_forced", "provider_error"):
            with self.subTest(outcome=outcome):
                order = []; clock = Clock()
                interview = R1Interview(object(), {"first_name": "Asha"}, FakeSession(clock), FakeWriter(order), clock=clock,
                                        recorder_finish=lambda: _append(order, "recording"), close_room=lambda: _append(order, "room"))
                await interview._exit(outcome)
                self.assertEqual(order, ["recording", "ledger", "terminal", "room"])

    async def test_mute_and_rejoin_ladders_are_phase_scoped(self):
        clock = Clock(); order = []; session = FakeSession(clock)
        session.wait_for_rejoin = lambda _grace: True
        interview = R1Interview(object(), {"first_name": "Asha"}, session, FakeWriter(order), clock=clock,
                                recorder_finish=lambda: _append(order, "recording"), close_room=lambda: _append(order, "room"))
        interview.machine.transition(R1Phase.OPENING); interview.machine.transition(R1Phase.ICEBREAKER)
        interview.machine.transition(R1Phase.TRANSITION); interview.machine.transition(R1Phase.ROLEPLAY)
        await interview.handle_mute()
        self.assertEqual(interview.machine.phase, R1Phase.ROLEPLAY)
        self.assertTrue(await interview.handle_disconnect())
        self.assertEqual(interview.machine.phase, R1Phase.ROLEPLAY)
        self.assertTrue(any("muted" in text for text in session.spoken))


async def _append(items, value):
    items.append(value)


class TestPhoneIsolation(unittest.TestCase):
    def test_phone_early_return_precedes_r1_lazy_import(self):
        source = (HERE / "agent.py").read_text(encoding="utf-8")
        phone = source.index("if _phone_agent_name():", source.index("async def entrypoint"))
        returned = source.index("return", phone)
        r1 = source.index("import r1_session", phone)
        self.assertLess(returned, r1)
        self.assertNotIn("import r1_", source[:source.index("async def entrypoint")])
