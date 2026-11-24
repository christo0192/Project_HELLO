"""Owner decisions 2026-11-24: R1_CALLBACK_AFTER_PRESSURE and R1_IK_OFFERS.

A: after the WEAK line to an advisor who pressured her (an invented offer or a coercive deadline)
the learner still never enrols, but agrees to a reasonable callback time instead of refusing every
one.  The level on record stays WEAK, the grade stays WEAK and the evidence stays pressured.

B: referrals to hiring or partner companies and a paid interview-prep add-on are real IK offers
for the shadow judge, and an add-on's cost is never a discount (it neither whitens an off-deck
discount nor raises a website price check).  Off-deck prices, guarantees, promised roles and free
add-ons stay violations.

Every advisor line here is a synthetic paraphrase, never a session transcript.
"""
import os
import unittest
from unittest import mock

import r1_prompts as P
from r1_commitment import (
    AskKind,
    CALLBACK_FALLBACK_SLOT,
    CALLBACK_LINE,
    CALLBACK_MOVED_LINE,
    CALLBACK_OWN_SLOTS,
    DEFAULT_SLOT,
    Level,
    callback_line,
    classify_learner_commitment,
    commitment_line,
    grade,
    is_commitment_line,
)
from r1_guard import COMMITMENT, has_concession
from r1_negotiation import declines_call, refused_slot, stated_totals
from r1_personas import resolve_persona
from r1_roleplay import TurnMode
from r1_text import is_closer, is_sign_off, split_sentences
from r1_tracker import (
    JUDGE_IK_OFFERS_RULE,
    CoverageTracker,
    build_judge_messages,
    invented_offer_in,
    parse_discounts,
    parse_judge_output,
    sells_paid_addon,
)
from tests.test_r1_roleplay import (
    GOOD_JUDGE, P1, Session, cooperative_script, engine, run_cooperative,
)

FLAGS = ("R1_CALLBACK_AFTER_PRESSURE", "R1_IK_OFFERS")
NO_SLOT_ASK = "Can we set up a follow-up call to talk this through?"
TONIGHT_ASK = "Can I call you tonight?"
BACK_ASK = "When should I call you back?"
DAYTIME_ASK = "Can I give you a call tomorrow at 11 AM?"
ENROL_NOW = "Shall I send you the enrolment link now?"
CHAT = "Okay, that makes sense to me."
STRONG_REPLY = "Okay, send me the enrolment link and I'll pay today."


def flags(**values: str):
    """The environment with both owner flags unset (their default), then ``values``."""
    env = {key: value for key, value in os.environ.items() if key not in FLAGS}
    env.update(values)
    return mock.patch.dict(os.environ, env, clear=True)


def pressured(seed="cb-1", eng=None):
    """A thorough advisor whose judge verdicts are in, then an invented offer on record."""
    session, r = run_cooperative(72.5, eng=eng or engine(seed=seed))
    session.eng.apply_judge(GOOD_JUDGE, session.eng.turn)
    session.eng.tracker.invented_offer = True
    return session, r


def to_weak(session, r, ask=NO_SLOT_ASK):
    """Call asks inside the window until the WEAK line is planned (a stall round may come first)."""
    for _ in range(4):
        r += 40
        plan = session.say(ask, r)
        if session.eng.negotiation.weak_line_said:
            return plan, r
    raise AssertionError("the WEAK line was never planned")


def commitment_hits(session) -> int:
    return session.eng.ledger.counts.get(COMMITMENT, 0)


class CallbackAfterPressureTests(unittest.TestCase):
    def setUp(self):
        patcher = flags()
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_pressured_advisor_gets_a_callback_time_and_the_weak_level_stays(self):
        session, r = pressured()
        dm = session.eng.persona.decision_maker
        weak, r = to_weak(session, r)
        self.assertEqual(weak.scripted_text, commitment_line(Level.WEAK, dm, call=True))
        self.assertIn("advisor_pressured", weak.reasons)
        plan = session.say(TONIGHT_ASK, r + 40)
        self.assertIs(plan.mode, TurnMode.SAY_ONLY)
        self.assertEqual(plan.scripted_text, callback_line(dm, "tonight"))
        self.assertEqual(plan.scripted_text,
                         CALLBACK_LINE.format(slot="tonight", decision_maker=dm))
        self.assertIn("callback_after_pressure", plan.reasons)
        self.assertIn("callback_slot:advisor", plan.reasons)
        self.assertIsNone(plan.commitment_level)
        self.assertFalse(plan.resolves_commitment)
        commitment = session.eng.admin_log()["commitment"]
        self.assertEqual(commitment["level"], "WEAK")
        self.assertEqual(commitment["turn"], weak.turn)
        self.assertEqual(commitment["callback_turn"], plan.turn)
        evidence = session.eng.tracker.commitment_evidence(AskKind.CALL)
        self.assertTrue(evidence.pressured)
        self.assertIs(grade(evidence, strong_v2=True), Level.WEAK)
        self.assertIs(session.eng.negotiation.level, Level.WEAK)
        self.assertTrue(session.eng.fidelity()["checks"]["no_commitment_violation"])
        self.assertEqual(commitment_hits(session), 0)
        self.assertIsNone(session.eng.admin_log()["negotiation"]["slot"])

    def test_no_slot_named_she_offers_her_own(self):
        session, r = pressured(seed="cb-2")
        dm = session.eng.persona.decision_maker
        _, r = to_weak(session, r)
        plan = session.say(BACK_ASK, r + 40)
        self.assertEqual(plan.scripted_text, callback_line(dm, CALLBACK_OWN_SLOTS[0]))
        self.assertIn("callback_slot:own", plan.reasons)

    def test_a_daytime_proposal_moves_to_seven_pm(self):
        session, r = pressured(seed="cb-3")
        dm = session.eng.persona.decision_maker
        _, r = to_weak(session, r)
        plan = session.say(DAYTIME_ASK, r + 40)
        self.assertEqual(plan.scripted_text, callback_line(dm, "tomorrow at 7 PM", moved=True))
        self.assertEqual(plan.scripted_text,
                         CALLBACK_MOVED_LINE.format(slot="tomorrow at 7 PM", decision_maker=dm))
        self.assertIn("callback_slot:moved", plan.reasons)

    def test_evenings_she_called_difficult_are_never_booked(self):
        session, r = pressured(seed="cb-4")
        dm = session.eng.persona.decision_maker
        _, r = to_weak(session, r)
        session.reply = "Evenings are tricky for me."
        free = session.say(CHAT, r + 30)
        self.assertIs(free.mode, TurnMode.LLM_REPLY)
        self.assertTrue(session.eng.negotiation.refused_slots)
        plan = session.say(BACK_ASK, r + 60)
        self.assertEqual(plan.scripted_text, callback_line(dm, "this weekend"))
        self.assertIn("callback_slot:own", plan.reasons)

    def test_every_own_slot_refused_falls_back(self):
        session, r = pressured(seed="cb-4b")
        dm = session.eng.persona.decision_maker
        _, r = to_weak(session, r)
        session.reply = "Evenings are tricky for me."
        session.say(CHAT, r + 30)
        session.reply = "This weekend is packed for me too."
        session.say("I understand, it's a busy time.", r + 50)
        self.assertEqual(len(session.eng.negotiation.refused_slots), 2)
        plan = session.say(BACK_ASK, r + 70)
        self.assertEqual(plan.scripted_text, callback_line(dm, CALLBACK_FALLBACK_SLOT))

    def test_after_the_booking_a_call_ask_is_a_confirmation(self):
        session, r = pressured(seed="cb-5")
        dm = session.eng.persona.decision_maker
        _, r = to_weak(session, r)
        session.say(TONIGHT_ASK, r + 40)
        session.reply = "Tomorrow morning works too."
        plan = session.say("Or would tomorrow morning suit you better for that call?", r + 80)
        self.assertIs(plan.mode, TurnMode.LLM_REPLY)
        self.assertIn("callback_on_record", plan.reasons)
        self.assertNotIn("commitment_on_record", plan.reasons)
        self.assertIn(P.CALLBACK_DONE_NOTE.format(slot="tonight", decision_maker=dm),
                      plan.reminder)
        self.assertNotIn(P.RESOLVED_NOTE, plan.reminder)
        self.assertEqual(session.spoken[-1], "Tomorrow morning works too.")
        self.assertEqual(commitment_hits(session), 0)
        self.assertTrue(session.eng.fidelity()["checks"]["no_commitment_violation"])
        self.assertEqual(session.eng.admin_log()["commitment"]["level"], "WEAK")

    def test_she_never_enrols(self):
        session, r = pressured(seed="cb-6")
        _, r = to_weak(session, r)
        session.say(TONIGHT_ASK, r + 40)
        session.reply = STRONG_REPLY
        plan = session.say(ENROL_NOW, r + 80)
        self.assertIn("commitment_on_record", plan.reasons)
        self.assertNotIn("commitment_upgraded", plan.reasons)
        self.assertIn(P.RESOLVED_NOTE, plan.reminder)
        self.assertNotIn("enrolment link", session.spoken[-1].lower())
        self.assertEqual(commitment_hits(session), 1)
        self.assertEqual(session.eng.admin_log()["commitment"]["level"], "WEAK")
        self.assertIs(session.eng._commitment_cap(), Level.MEDIUM)

    def test_a_weak_that_is_not_pressure_keeps_the_previous_behaviour(self):
        session, r = run_cooperative(72.5, eng=engine(seed="cb-7"))
        self.assertFalse(session.eng.tracker.commitment_evidence(AskKind.CALL).pressured)
        _, r = to_weak(session, r)
        self.assertEqual(session.eng.admin_log()["commitment"]["level"], "WEAK")
        plan = session.say(TONIGHT_ASK, r + 40)
        self.assertIn("commitment_on_record", plan.reasons)
        self.assertNotIn("callback_after_pressure", plan.reasons)
        self.assertIn(P.RESOLVED_NOTE, plan.reminder)
        self.assertIs(session.eng._commitment_cap(), Level.WEAK)

    def test_her_own_decline_of_a_call_still_holds(self):
        session, r = pressured(seed="cb-8")
        _, r = to_weak(session, r)
        session.reply = "I'd rather reach out myself when I'm ready."
        session.say(CHAT, r + 30)
        self.assertTrue(session.eng.negotiation.call_declined())
        plan = session.say(TONIGHT_ASK, r + 60)
        self.assertIn("commitment_on_record", plan.reasons)
        self.assertNotIn("callback_after_pressure", plan.reasons)
        self.assertNotIn("callback_turn", session.eng.admin_log()["commitment"])

    def test_a_coercive_deadline_counts_as_pressure(self):
        session, r = run_cooperative(72.5, eng=engine(seed="cb-8b"))
        session.eng.apply_judge(GOOD_JUDGE, session.eng.turn)
        session.eng.tracker.coercive_urgency = True
        _, r = to_weak(session, r)
        plan = session.say(TONIGHT_ASK, r + 40)
        self.assertIn("callback_after_pressure", plan.reasons)

    def test_a_line_nobody_heard_is_agreed_again(self):
        session, r = pressured(seed="cb-12")
        dm = session.eng.persona.decision_maker
        _, r = to_weak(session, r)
        eng = session.eng
        cut = eng.plan_turn(TONIGHT_ASK, r + 40)
        self.assertIn("callback_after_pressure", cut.reasons)
        eng.record_spoken(cut, "", r_sec=r + 40, interrupted=True)
        self.assertNotIn("callback_turn", eng.admin_log()["commitment"])
        again = session.say(TONIGHT_ASK, r + 80)
        self.assertIn("callback_after_pressure", again.reasons)
        self.assertEqual(again.scripted_text, callback_line(dm, "tonight"))
        self.assertEqual(eng.admin_log()["commitment"]["callback_turn"], again.turn)

    def test_the_reminder_lets_her_give_a_time_only_while_the_callback_is_open(self):
        session, r = pressured(seed="cb-11")
        dm = session.eng.persona.decision_maker
        before = [plan.reminder for plan in session.plans if plan.reminder]
        self.assertTrue(before)
        for reminder in before:  # the cooperative script, before any WEAK line
            self.assertIn(P.NEXT_STEP_NOTE, reminder)
            self.assertNotIn("call you back", reminder)
        _, r = to_weak(session, r)
        plan = session.say("Just tell me a time that suits you.", r + 40)
        self.assertIs(plan.mode, TurnMode.LLM_REPLY)
        self.assertIn(P.CALLBACK_NEXT_STEP_NOTE.format(decision_maker=dm), plan.reminder)
        self.assertNotIn(P.NEXT_STEP_NOTE, plan.reminder)

    def test_a_reschedule_after_the_booking_keeps_the_callback_open(self):
        # Review 2026-11-24: "please don't call before ..." after the booking reads as a call
        # decline, which must not close the callback she already agreed to.
        session, r = pressured(seed="cb-14")
        dm = session.eng.persona.decision_maker
        _, r = to_weak(session, r)
        booked = session.say("Can I call you tomorrow evening?", r + 40)
        self.assertIn("callback_after_pressure", booked.reasons)
        session.reply = (f"Please don't call before I've talked to my {dm}, but tomorrow evening "
                         "should be fine.")
        session.say("Great, does that work for you?", r + 70)
        self.assertTrue(session.eng.negotiation.call_declined())
        self.assertIs(session.eng._commitment_cap(), Level.MEDIUM)
        session.reply = "Yes, tomorrow evening works for the call."
        plan = session.say("So I'll call you tomorrow evening, okay?", r + 100)
        self.assertIn("callback_on_record", plan.reasons)
        self.assertNotIn("commitment_on_record", plan.reasons)
        self.assertEqual(session.spoken[-1], "Yes, tomorrow evening works for the call.")
        self.assertEqual(commitment_hits(session), 0)
        self.assertTrue(session.eng.fidelity()["checks"]["no_commitment_violation"])
        self.assertEqual(session.eng.admin_log()["commitment"]["level"], "WEAK")

    def test_a_moved_evening_she_called_difficult_is_never_booked(self):
        # Review 2026-11-24: a daytime proposal moves to 7 PM, which she may have ruled out.
        for seed, refusal in (("cb-15", "Evenings are tricky for me."),
                              ("cb-16", "I can't do evenings, honestly.")):
            with self.subTest(refusal=refusal):
                session, r = pressured(seed=seed)
                dm = session.eng.persona.decision_maker
                _, r = to_weak(session, r)
                session.reply = refusal
                session.say(CHAT, r + 30)
                self.assertTrue(session.eng.negotiation.refused_slots)
                plan = session.say(DAYTIME_ASK, r + 60)
                self.assertEqual(plan.scripted_text, callback_line(dm, "this weekend"))
                self.assertIn("callback_slot:own", plan.reasons)
                self.assertNotIn("Evenings are easier", plan.scripted_text)

    def test_the_turns_the_callback_raised_the_cap_are_logged(self):
        # Review 2026-11-24: the cap is MEDIUM from the first turn after the WEAK line to a
        # pressured advisor, before any callback is booked; the rehearsal metric reads these turns.
        session, r = pressured(seed="cb-17")
        weak, r = to_weak(session, r)
        session.reply = "Okay, I'll pay today. Sure, tomorrow evening works for a call."
        free = session.say("Just tell me a time that suits you.", r + 40)
        self.assertEqual(session.spoken[-1], "Sure, tomorrow evening works for a call.")
        commitment = session.eng.admin_log()["commitment"]
        self.assertNotIn("callback_turn", commitment)
        self.assertEqual(commitment["callback_open_turns"], [free.turn])
        self.assertNotIn(weak.turn, commitment["callback_open_turns"])
        unpressured, r2 = run_cooperative(72.5, eng=engine(seed="cb-18"))
        to_weak(unpressured, r2)
        self.assertNotIn("callback_open_turns", unpressured.eng.admin_log()["commitment"])

    def test_owner_shaped_paraphrase(self):
        persona = resolve_persona("p2_recent_grad", variant="v2")
        session = Session(engine(persona, name="Advisor", seed="cb-13"))
        r = 20.0
        for index, text in enumerate(cooperative_script()):
            session.say(text, r, turn_index=index * 2 + 1, candidate_seconds=20)
            r += 60
        eng = session.eng
        eng.apply_judge(GOOD_JUDGE, eng.turn)
        r += 30
        session.say("Fine, since you heard someone paid seven thousand, I will match that "
                    "for you.", r)
        self.assertTrue(eng.apply_judge(
            {"invented_offer": True, "discount_offered_usd": 2000}, eng.turn))
        self.assertTrue(eng.tracker.invented_offer)
        for _ in range(4):
            r += 40
            session.say("So can I call you back after you talk to your father?", r)
            if eng.negotiation.weak_line_said:
                break
        self.assertTrue(eng.negotiation.weak_line_said)
        plan = session.say("Can I call you tonight then?", r + 40)
        self.assertEqual(
            plan.scripted_text, "Okay, let's book a call tonight, once I've talked to my father."
        )
        self.assertIn("callback_after_pressure", plan.reasons)
        self.assertEqual(eng.admin_log()["commitment"]["level"], "WEAK")
        self.assertEqual(commitment_hits(session), 0)


class CallbackFlagOffTests(unittest.TestCase):
    def test_flag_off_restores_the_refusal_path(self):
        with flags(R1_CALLBACK_AFTER_PRESSURE="0"):
            session, r = pressured(seed="cb-9")
            _, r = to_weak(session, r)
            session.reply = "Tonight works."
            plan = session.say(TONIGHT_ASK, r + 40)
            self.assertIs(plan.mode, TurnMode.LLM_REPLY)
            self.assertIn("commitment_on_record", plan.reasons)
            self.assertNotIn("callback_after_pressure", plan.reasons)
            self.assertIn(P.RESOLVED_NOTE, plan.reminder)
            self.assertIn(P.NEXT_STEP_NOTE, plan.reminder)
            self.assertIs(session.eng._commitment_cap(), Level.WEAK)
            self.assertNotEqual(session.spoken[-1], "Tonight works.")
            self.assertEqual(commitment_hits(session), 1)
            self.assertNotIn("callback_turn", session.eng.admin_log()["commitment"])


class CallbackHarnessTests(unittest.TestCase):
    """rehearsal/metrics.py: after the callback a MEDIUM confirmation is no spoken leak."""

    @staticmethod
    def leaks(spoken, commitment):
        from rehearsal import metrics
        admin = {
            "guard": {"by_category": {"commitment": 1}, "flagged": False},
            "commitment": commitment,
            "turn_map": [{"roleplay_turn": 22, "transcript_turn": 44}],
        }
        exchanges = [{"n": 22, "r_sec": 1300.0, "advisor": {"text": "Tomorrow then?"},
                      "learner": {"spoken": spoken, "raw": spoken, "plan": None}}]
        trips = [{"category": "commitment", "turn_index": 44, "rule": "level_medium"}]
        return metrics.commitment_spoken_leaks(admin, trips, exchanges)

    def test_the_cap_is_medium_after_the_callback_turn(self):
        medium = "Sure, let's book a call tomorrow then."
        self.assertEqual(len(self.leaks(medium, {"level": "WEAK", "turn": 18})), 1)
        self.assertEqual(
            self.leaks(medium, {"level": "WEAK", "turn": 18, "callback_turn": 20}), [])
        self.assertEqual(
            len(self.leaks(STRONG_REPLY, {"level": "WEAK", "turn": 18, "callback_turn": 20})), 1)
        self.assertEqual(
            len(self.leaks(medium, {"level": "WEAK", "turn": 18, "callback_turn": 22})), 1)

    def test_the_cap_is_medium_on_the_turns_the_callback_was_open(self):
        # Review 2026-11-24: the engine's cap is MEDIUM while the callback is open, before any
        # booking.
        medium = "Sure, tomorrow evening works for a call."
        self.assertEqual(
            self.leaks(medium, {"level": "WEAK", "turn": 18, "callback_open_turns": [20, 22]}), [])
        self.assertEqual(len(self.leaks(
            STRONG_REPLY, {"level": "WEAK", "turn": 18, "callback_open_turns": [22]})), 1)
        self.assertEqual(len(self.leaks(
            medium, {"level": "WEAK", "turn": 18, "callback_open_turns": [20, 21]})), 1)


class CallbackLineShapeTests(unittest.TestCase):
    def lines(self):
        for dm in ("husband", "father", "wife"):
            for slot in ("tonight", "tomorrow evening", "this weekend", "later this week",
                         "on Thursday at 7 PM", "on Friday in the evening"):
                yield callback_line(dm, slot), dm
            yield callback_line(dm, "tomorrow at 7 PM", moved=True), dm

    def test_shape(self):
        for text, dm in self.lines():
            with self.subTest(text=text):
                self.assertIs(classify_learner_commitment(text), Level.MEDIUM)
                self.assertFalse(is_closer(text, wide=True))
                self.assertFalse(is_sign_off(text, wide=True))
                self.assertIsNone(refused_slot(text))
                self.assertFalse(declines_call(text))
                self.assertFalse(has_concession(text))
                self.assertIn("let's book a call", text)
                self.assertEqual(len(split_sentences(text)), 1)
                self.assertTrue(is_commitment_line(text, dm))

    def test_templates(self):
        self.assertEqual(callback_line("husband", DEFAULT_SLOT),
                         "Okay, let's book a call on Thursday at 7 PM, once I've talked to my "
                         "husband.")
        self.assertTrue(CALLBACK_MOVED_LINE.startswith("Evenings are easier for me, "))


class JudgeIkOffersTests(unittest.TestCase):
    def test_rule_only_with_v2_and_the_flag(self):
        def system(**kwargs):
            return build_judge_messages("x", "y", seed="s", turn=1, **kwargs)[0]["content"]
        self.assertIn(JUDGE_IK_OFFERS_RULE,
                      system(v2=True, reconcile=True, playbook=True, ik_offers=True))
        self.assertIn(JUDGE_IK_OFFERS_RULE, system(v2=True, ik_offers=True))
        self.assertNotIn(JUDGE_IK_OFFERS_RULE, system(v2=True, reconcile=True, playbook=True))
        self.assertNotIn(JUDGE_IK_OFFERS_RULE, system(v2=False, ik_offers=True))
        full = system(v2=True, reconcile=True, playbook=True, ik_offers=True)
        self.assertTrue(full.endswith(JUDGE_IK_OFFERS_RULE))
        self.assertIn("partner companies", JUDGE_IK_OFFERS_RULE)
        self.assertIn("still invented", JUDGE_IK_OFFERS_RULE)

    def test_rule_keeps_the_floor_and_reads_a_bundle_total_as_course_plus_addon(self):
        # Review 2026-11-24: a total with a priced add-on implies a LARGER course discount, never
        # none.
        rule = JUDGE_IK_OFFERS_RULE
        self.assertIn("the course price is that total minus the add-on's price", rule)
        self.assertIn("the discount is $9000 minus that course price", rule)
        self.assertIn("A course price below $7500 is still", rule)
        self.assertIn("add-on or not", rule)
        self.assertIn("included with no price of its own is still a free extra", rule)
        self.assertIn("a course price of $7000, a $2000 discount, which is invented", rule)
        self.assertIn("a course price of $7500, a $1500 discount, which is not", rule)
        self.assertNotIn("never read it, or a total that includes it, as a discount", rule)
        self.assertNotIn("does not apply to such a total", rule)

    def test_engine_follows_the_flag(self):
        for value, expected in (("1", True), ("0", False)):
            with self.subTest(value=value), flags(R1_IK_OFFERS=value):
                eng = engine(seed="ik-judge")
                system = eng.judge_messages("x", "y", turn=1)[0]["content"]
                self.assertIs(JUDGE_IK_OFFERS_RULE in system, expected)
                self.assertIs(eng.tracker.ik_offers, expected)
        with flags():
            self.assertTrue(engine(seed="ik-default").tracker.ik_offers)


ADDON_WHITENED = (
    "I can give you $2,000 off and add interview prep for $1,000, so it comes to $8,000."
)
ADDON_INCLUDED_8000 = "I can do it for $8,000 with the interview prep add-on included."
ADDON_INCLUDED_7000 = "I can do it for $7,000 with the interview prep add-on included."
ADDON_TOTAL = (
    "Interview prep is a separate program; we can add it on top of the course for an extra "
    "$1,000, so your total comes to $10,000."
)
BUNDLE_7000 = (
    "Interview prep is a separate program for an extra $1,000. I can do the whole thing for $8,000."
)
BUNDLE_7500 = "With interview prep at $1,000 more, I can do both for $8,500 in total."
# The course's own price said next to the words "interview prep" (review 2026-11-24), and the
# discount the deck reader logs for it with the flag on or off.
COURSE_PRICES = (
    ("I can do our interview prep program for $7,800.", 1200),
    ("I can give you the interview prep program for $7,800.", 1200),
    ("I can offer you the course at $7,600, and it covers interview prep too.", 1400),
    ("Interview prep is our core, and I can offer it to you at $7,900.", 1100),
    ("Forget the add-on, I can do the course for $8,200 today.", 800),
    ("Without the interview prep add-on, I can do the course for $7,800.", 1200),
    ("I can do it for $7,800 including the interview prep add-on.", 1200),
    ("I can bring it down to $7,700 and you get the whole interview prep curriculum.", 1300),
)


def mentions(text, ik):
    return [(m.usd, m.heard_usd) for m in parse_discounts(text, reconcile=True, ik_offers=ik)]


class AddonReaderTests(unittest.TestCase):
    def test_an_addon_never_whitens_an_off_deck_discount(self):
        self.assertEqual(mentions(ADDON_WHITENED, True), [(2000, None)])
        self.assertTrue(invented_offer_in(ADDON_WHITENED, v2=True, reconcile=True,
                                          ik_offers=True))
        self.assertEqual(mentions(ADDON_WHITENED, False), [(1000, 2000)])
        self.assertFalse(invented_offer_in(ADDON_WHITENED, v2=True, reconcile=True,
                                           ik_offers=False))

    def test_an_included_addon_is_a_free_perk_and_the_net_price_is_read(self):
        # Review 2026-11-24: an add-on "included" has no price of its own, so it is no paid add-on
        # and the figure is the course's net price, as with the flag off.
        for ik in (True, False):
            with self.subTest(ik=ik):
                self.assertEqual(mentions(ADDON_INCLUDED_8000, ik), [(1000, None)])
                self.assertEqual(mentions(ADDON_INCLUDED_7000, ik), [(2000, None)])
                self.assertTrue(invented_offer_in(ADDON_INCLUDED_7000, v2=True, ik_offers=ik))
        self.assertFalse(sells_paid_addon(ADDON_INCLUDED_8000))

    def test_a_total_with_a_priced_addon_is_read_as_course_plus_addon(self):
        # Review 2026-11-24: total minus the add-on's price is the course; the discount is read
        # on it.
        self.assertEqual(mentions(BUNDLE_7000, True), [(2000, None)])  # the course at $7,000
        self.assertTrue(invented_offer_in(BUNDLE_7000, v2=True, reconcile=True, ik_offers=True))
        self.assertEqual(mentions(BUNDLE_7000, False), [(1000, None)])
        self.assertEqual(mentions(BUNDLE_7500, True), [(1500, None)])
        self.assertFalse(invented_offer_in(BUNDLE_7500, v2=True, reconcile=True, ik_offers=True))
        self.assertEqual(mentions(BUNDLE_7500, False), [(500, None)])

    def test_only_the_figures_own_clause_makes_it_a_total_with_the_addon(self):
        # A total word elsewhere ("when it comes to", "together", "so your total comes to $8,500")
        # belongs to another figure; reading the course price as a bundle would invent $1,000 off.
        for text, logged in (
            ("Interview prep is $1,000 more. When it comes to the course, I can do it for $7,500.",
             1500),
            ("Let's work together: the add-on is $1,000 more, and I can do it for $7,500 today.",
             1500),
            ("With interview prep at $1,000 more, I can do the course for $7,500.", 1500),
            ("Interview prep is $1,000 extra. I can do the course for $7,500, so your total "
             "comes to $8,500.", 1500),
            ("Interview prep is $1,000 extra, so I can do both for $8,000.", 2000),
            ("We can add interview prep for an extra $1,000, and I can do the course plus the "
             "add-on for $8,500.", 1500),
            ("The add-on is $1,000 more, so in total I can do it for $8,500.", 1500),
            ("The add-on is $1,000 more, so I can do it for $8,000 for both.", 2000),
            ("The add-on is $1,000 extra. I can give both of you the course for $7,500.", 1500),
            ("The add-on is $1,000 extra. If you're all in I can do it for $7,500.", 1500),
            ("The add-on is $1,000 extra. I can give you everything you need for $7,500.", 1500),
            ("The add-on is $1,000 extra, so I can do it all for $8,000.", 2000),
        ):
            with self.subTest(text=text):
                self.assertEqual(mentions(text, True), [(logged, None)])
                self.assertIs(invented_offer_in(text, v2=True, reconcile=True, ik_offers=True),
                              logged > 1500)

    def test_a_course_price_beside_a_paid_addon_is_the_course_price(self):
        text = "I can do it for $7,500 today, and interview prep for $1,000 more."
        self.assertTrue(sells_paid_addon(text))
        for ik in (True, False):
            with self.subTest(ik=ik):
                self.assertEqual(mentions(text, ik), [(1500, None)])
                self.assertFalse(invented_offer_in(text, v2=True, reconcile=True, ik_offers=ik))
        before = "The add-on is $1,000 more. I can do the course for $7,800."
        self.assertEqual(mentions(before, True), [(1200, None)])
        self.assertTrue(invented_offer_in(before, v2=True, reconcile=True, ik_offers=True))

    def test_course_prices_next_to_interview_prep_are_still_read(self):
        # Review 2026-11-24: "interview prep" names IK's course; a left-out or included add-on, or
        # the course's own price, is no paid add-on, so the off-deck price stays invented.
        for text, usd in COURSE_PRICES:
            for ik in (True, False):
                with self.subTest(text=text, ik=ik):
                    self.assertEqual(mentions(text, ik), [(usd, None)])
                    self.assertTrue(invented_offer_in(text, v2=True, reconcile=True,
                                                      ik_offers=ik))
                    self.assertFalse(sells_paid_addon(text))

    def test_explicit_discounts_are_unchanged(self):
        stacked = "With the $1,500 discount and the interview prep add-on at $1,000 more, you pay $8,500."
        self.assertEqual(mentions(stacked, True), [(1500, None)])
        another = "I can take another $1,000 off if you add interview prep."
        self.assertEqual(mentions(another, True), [(1000, None)])
        self.assertEqual(mentions("I can give you $500 off today.", True), [(500, None)])

    def test_sells_paid_addon(self):
        positives = (
            ADDON_TOTAL,
            ADDON_WHITENED,
            "You can add our interview preparation program for $1,000 more.",
            "The interview prep add-on costs $1,000.",
            "We also have a separate program for interviews at an extra $800.",
        )
        negatives = (
            ADDON_INCLUDED_8000,
            "We'll add interview prep for free if you enrol today.",
            "Interview prep is included at no extra cost.",
            "Would you like to add interview prep for an extra $1,000?",
            "Last year the interview prep add-on cost $1,000.",
            "Some students paid $1,000 for the add-on before.",
            "I can take another $1,000 off if you add interview prep.",
            "We don't sell interview prep for $1,000.",
            "The course is $9,000 with mentorship.",
            "The course costs $9,000, and we also have an interview prep add-on.",
            "On top of that I can give you the interview prep course for $7,500.",
            "I can give you the interview prep program for $9,500.",
        )
        for text in positives:
            with self.subTest(text=text):
                self.assertTrue(sells_paid_addon(text))
        for text in negatives:
            with self.subTest(text=text):
                self.assertFalse(sells_paid_addon(text))

    def test_a_free_addon_is_still_invented(self):
        for ik in (True, False):
            with self.subTest(ik=ik):
                self.assertTrue(invented_offer_in(
                    "We'll add interview prep for free if you enrol today.", v2=True,
                    ik_offers=ik))

    def test_guarantees_and_promised_jobs_are_still_invented(self):
        for text in (
            "If you join, you will definitely get a job as a data analyst.",
            "We guarantee you a placement through our partner companies.",
            "You will get placed for sure with our hiring partners.",
        ):
            for ik in (True, False):
                with self.subTest(text=text, ik=ik):
                    self.assertTrue(invented_offer_in(text, v2=True, ik_offers=ik))

    def test_a_referral_alone_is_no_rule_violation(self):
        referral = "We are partnered with many hiring companies, so it is easier to refer you."
        for ik in (True, False):
            self.assertFalse(invented_offer_in(referral, v2=True, ik_offers=ik))

    def test_stated_totals_skip_the_addon_total(self):
        split = "We can add interview prep for an extra $1,000. So your total comes to $10,000."
        with flags(R1_IK_OFFERS="1"):
            self.assertEqual(stated_totals(ADDON_TOTAL), [])
            self.assertEqual(stated_totals(split), [])
            self.assertEqual(stated_totals("The total comes to $9,500 for this cohort."), [9500])
            # Review 2026-11-24: the course's own price next to "interview prep" is still a total.
            self.assertEqual(
                stated_totals("I can give you the interview prep program for $9,500."), [9500])
        with flags(R1_IK_OFFERS="0"):
            self.assertEqual(stated_totals(ADDON_TOTAL), [10000])
            self.assertEqual(stated_totals(split), [10000])


class AddonTrackerTests(unittest.TestCase):
    def judge_on(self, ik):
        tracker = CoverageTracker(P1, seed="ik-t", invented_v2=True, discipline_v2=True,
                                  total_reconcile=True, india_playbook=True, ik_offers=ik)
        tracker.observe_candidate_turn("The course costs $9000.", 1)
        tracker.observe_candidate_turn(ADDON_WHITENED, 2)
        tracker.apply_judge(
            parse_judge_output({"invented_offer": True, "discount_offered_usd": 2000}), 2)
        return tracker

    def test_the_addon_turn_is_not_reconciled_so_the_judge_counts(self):
        on = self.judge_on(True)
        self.assertNotIn(2, on._reconciled_turns)
        self.assertTrue(on.invented_offer)
        off = self.judge_on(False)
        self.assertIn(2, off._reconciled_turns)
        self.assertFalse(off.invented_offer)

    def test_course_prices_next_to_interview_prep_stay_in_the_discount_log(self):
        # Review 2026-11-24: the posted discount_detected rows come from this log.
        for line, logged, invented in (
            ("I can give you the interview prep program for $7,800.", [1200], True),
            ("I can do it for $7,500 today, and interview prep for $1,000 more.", [1500], False),
            (BUNDLE_7000, [2000], True),
        ):
            for ik in (True, False):
                if line is BUNDLE_7000 and not ik:
                    continue
                with self.subTest(line=line, ik=ik):
                    tracker = CoverageTracker(
                        P1, seed="ik-c", invented_v2=True, discipline_v2=True,
                        total_reconcile=True, india_playbook=True, ik_offers=ik,
                    )
                    tracker.observe_candidate_turn("The course costs $9000.", 1)
                    tracker.observe_candidate_turn(line, 2)
                    self.assertEqual([item["usd"] for item in tracker.discount_log], logged)
                    self.assertIs(tracker.invented_offer, invented)
                    if invented:
                        self.assertFalse(tracker.discount_ok)


class AddonEngineTests(unittest.TestCase):
    def test_an_off_deck_price_next_to_interview_prep_keeps_the_advisor_pressured(self):
        # Review 2026-11-24: with the flag on this advisor was no longer pressured, so the callback
        # path never opened and the learner's grade was no longer capped at WEAK.
        for value in ("1", "0"):
            with self.subTest(flag=value), flags(R1_IK_OFFERS=value):
                session, r = run_cooperative(72.5, eng=engine(seed="ik-press"))
                session.eng.apply_judge(GOOD_JUDGE, session.eng.turn)
                session.say("I can offer you the course at $7,600, and it covers interview prep "
                            "too.", r + 30)
                self.assertTrue(session.eng.tracker.invented_offer)
                evidence = session.eng.tracker.commitment_evidence(AskKind.CALL)
                self.assertTrue(evidence.pressured)
                self.assertFalse(evidence.discount_ok)


class AddonConflictTests(unittest.TestCase):
    def run_addon(self, value):
        with flags(R1_IK_OFFERS=value):
            session, r = run_cooperative(60, eng=engine(seed="ik-conflict"))
            session.eng.apply_judge(GOOD_JUDGE, session.eng.turn)
            plan = session.say(ADDON_TOTAL, r + 30)
            return session, plan

    def test_an_addon_total_raises_no_website_check(self):
        session, plan = self.run_addon("1")
        self.assertIs(plan.mode, TurnMode.LLM_REPLY)
        self.assertEqual(session.eng.negotiation.conflicts, [])
        self.assertFalse(session.eng._conflict_note)
        self.assertFalse(session.eng.tracker.invented_offer)

    def test_flag_off_restores_the_website_check(self):
        session, _ = self.run_addon("0")
        self.assertEqual(session.eng.negotiation.conflicts, [("website", 10000)])


if __name__ == "__main__":
    unittest.main()
