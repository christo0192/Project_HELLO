"""Owner decision 2026-11-20 (R1_DISCOUNT_TOTAL_RECONCILE, R1_INDIA_PLAYBOOK), end to end.

A paraphrased, synthetic replay of the owner's session shape: a misheard EMI discount next to a
deck total, then a one-day deck offer, then an in-window enrol ask that grades STRONG with both
flags on and WEAK (invented, pressured) with both off.  The integrity scenarios (pushy, over-
discounter, manipulative) must still end pressured with both flags on.
"""
import os
import unittest
from unittest import mock

import r1_prompts as P2
from r1_commitment import AskKind, Level, STRONG_PLAN_LINE_V2, UPGRADE_LINE
from r1_negotiation import N_TIMING
from rehearsal.adapt import adapt_scenarios
from rehearsal.scripted_advisor import PUSHY_LINES
from tests.test_r1_roleplay import (
    GOOD_JUDGE, HANDLE_DECIDER, PRICE_ONLY, Session, cooperative_script, engine,
)

EMI = (
    "We have an EMI option at zero percent interest through our partner banks, and with it "
    "we give a hundred dollar discount, so the total comes to eight thousand five hundred dollars."
)
OFFER = (
    "This is a one-day offer: if you enrol today we give you the course at a fifteen hundred "
    "dollar discount, and from tomorrow it is not available."
)
ASK = "Would you like to go ahead and enrol today? I can send you the enrolment link."


def replay(wait=False):
    script = cooperative_script()
    script[8:11] = [PRICE_ONLY]
    session = Session(engine())
    for i, text in enumerate(script + [HANDLE_DECIDER] * 11):
        session.say(text, 20 + i * 25, turn_index=i * 2 + 1, candidate_seconds=20)
    session.eng.apply_judge(GOOD_JUDGE, session.eng.turn)
    session.say(EMI, 710)
    if wait:
        session.reply = ("I won't decide today just because the offer ends tomorrow; "
                         "I'd rather wait a little.")
    offer_plan = session.say(OFFER, 740)
    session.reply = "Just exploring options."
    plan = session.say(ASK, 800)
    return session, offer_plan, plan


class OwnerShapedReplayTests(unittest.TestCase):
    def test_replay_flags_on_and_off(self):
        for value in ("1", "0"):
            with self.subTest(value=value), mock.patch.dict(os.environ, {
                "R1_DISCOUNT_TOTAL_RECONCILE": value, "R1_INDIA_PLAYBOOK": value,
            }):
                session, offer, plan = replay()
                tracker = session.eng.tracker
                evidence = tracker.commitment_evidence(AskKind.ENROL)
                if value == "1":
                    self.assertEqual([x["usd"] for x in tracker.discount_log], [500, 1500])
                    self.assertEqual(tracker.discount_log[0]["heard_usd"], 100)
                    self.assertFalse(tracker.invented_offer)
                    self.assertFalse(tracker.coercive_urgency)
                    self.assertFalse(evidence.pressured)
                    self.assertTrue(evidence.money_path)
                    self.assertFalse(any("advisor_pressured" in p.reasons for p in session.plans))
                    self.assertTrue(P2.TIME_OFFER_OPEN_NOTE in offer.reminder or
                                    P2.TIME_OFFER_READY_NOTE in offer.reminder)
                    after_offer = session.plans[session.plans.index(offer):]
                    self.assertEqual(len(after_offer), 2)
                    self.assertFalse(any(p.negotiation_id == N_TIMING for p in after_offer))
                    self.assertIn("ask_in_window:grade_strong", plan.reasons)
                    self.assertIn("strong_gaps:none", plan.reasons)
                    self.assertIn(plan.scripted_text, (STRONG_PLAN_LINE_V2, UPGRADE_LINE))
                else:
                    self.assertTrue(tracker.invented_offer)
                    self.assertTrue(evidence.pressured)
                    self.assertIn("ask_in_window:grade_weak", plan.reasons)

    def test_wait_after_offer_blocks_strong(self):
        with mock.patch.dict(os.environ, {
            "R1_DISCOUNT_TOTAL_RECONCILE": "1", "R1_INDIA_PLAYBOOK": "1",
        }):
            session, offer, plan = replay(wait=True)
            self.assertEqual(session.eng.negotiation.wait_said_turn, offer.turn)
            self.assertIn("strong_blocked:learner_waiting", plan.reasons)
            self.assertNotEqual(plan.commitment_level, Level.STRONG)


class IntegrityStillFailsTests(unittest.TestCase):
    def test_pressure_scenarios(self):
        scenarios = {s.name: s for s in adapt_scenarios()}
        lines = {"pushy": [s.format(name="Maya", dm="husband") for s in PUSHY_LINES]}
        for name in ("over-discounter", "manipulative-advisor"):
            lines[name] = [beat.text for beat in scenarios[name].roleplay]
        with mock.patch.dict(os.environ, {
            "R1_DISCOUNT_TOTAL_RECONCILE": "1", "R1_INDIA_PLAYBOOK": "1",
        }):
            for name, beats in lines.items():
                with self.subTest(name=name):
                    session = Session(engine())
                    for i, beat in enumerate(beats):
                        session.say(beat, 20 + i * 50)
                    tracker = session.eng.tracker
                    self.assertTrue(tracker.commitment_evidence(AskKind.ENROL).pressured)
                    self.assertTrue(tracker.invented_offer or tracker.coercive_urgency)
                    if name == "pushy":
                        self.assertTrue(tracker.invented_offer)
                    if name == "manipulative-advisor":
                        self.assertTrue(tracker.coercive_urgency)
