"""Unit tests for ``r1_negotiation``: the learner's memory of offers, callbacks and reasons."""
from __future__ import annotations

import json
import re
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_negotiation as neg
from r1_commitment import DEFAULT_SLOT, Level, classify_learner_commitment, commitment_line
from r1_guard import GuardContext, check_sentence, has_concession
from r1_personas import PERSONAS, deep_need_topics_in, resolve_persona
from r1_scheduler import F1_COUNTER, SPEC_BY_ID as MOVE_BY_ID, markers_match
from r1_text import split_sentences

# The real advisor turns of owner session b58c7d9c (the candidate rows, merged per learner turn).
T56 = (
    "Um, yeah, I mean we can So, so 9000 like, okay, so you want the deal to be in 7000 and it "
    "also include live classes. I'm just want to make sure because when the value gets low, we "
    "will provide recorded classes."
)
T58 = (
    "So you're saying you need $7000. Okay, let's make it to 8.5, I mean $8500 and that will, "
    "I will talk to my manager. I'll make sure you get all the courses and all the premium."
)
T62_66 = (
    "Yeah, sure. So before you go, Can we do a schedule to call back tomorrow? maybe like 10:00 "
    "a.m. so that I can I will I will give you all the details in your email today. I mean "
    "right after we finish the call. Part 10 whichever you prefer and then we will talk about "
    "it and if you if you have any other questions we can discuss and we can get you enrolled."
)
T68 = "Uh, when will you get back to me? Like, when can I expect your call back?"
T78 = (
    "Oh, fine. Um, so, uh, when you call me back, in that case, I can also talk to your "
    "husband, you know, in case if you have any doubts and, uh, I can also help him understand "
    "like why the program is $8,500 and what are the packages that we will getting. I maybe I "
    "will give him the entire curriculum details so that he will also understand and, uh, you "
    "know, support you in this entire process. What do you think?"
)
T80 = (
    "Oh, is that so? Okay, okay. So you wanted me to mail that? Yeah, done. I will mail that "
    "once we finish this call. Anything else you wanted to know about the course or program?"
)
NEUTRAL = "That makes sense. What else is on your mind?"
# Pitch sentences about what the programme sends, schedules or does (R1-Q round 1, review 2).  None
# is an e-mail offer, a callback or an ask.
PITCHES = (
    "We send you the recordings after every class, so you never miss anything.",
    "We will send you a certificate at the end of the program.",
    "Every week we mail you a progress report with your scores.",
    "The platform will send you an email reminder before every class.",
    "Our team will reach you on the next session to help with the capstone.",
    "We schedule live sessions every weekend with the mentors.",
    "You can book mentor slots whenever you need help with your project.",
    "Mentors are available for one on one sessions every week.",
    "We will reach out to you on the group chat if there is a new batch.",
    "Our mentors call you every Saturday to review progress.",
    "In the live sessions we discuss real projects, and we send the notes right after class.",
)


def variants():
    for persona in PERSONAS:
        for variant in persona.variants:
            yield resolve_persona(persona.id, variant=variant.id)


class SlotTests(unittest.TestCase):
    def test_the_owner_test_callback_proposal_is_parsed_into_a_daytime_slot(self):
        callback = neg.detect_callback(T62_66)
        self.assertIsNotNone(callback)
        self.assertEqual(
            callback.slot, neg.Slot(day="tomorrow", hour=10, minute=0, part=None)
        )
        self.assertFalse(callback.slot.evening)

    def test_clock_forms_are_normalised(self):
        cases = {
            "tomorrow at 10:30 am": (10, 30),
            "Saturday at 7pm": (19, 0),
            "monday 5 p.m.": (17, 0),
            "friday at 12 pm": (12, 0),
            "friday at 12 am": (0, 0),
            "tuesday at six pm": (18, 0),
            "tuesday at ten a.m.": (10, 0),
        }
        for text, (hour, minute) in cases.items():
            with self.subTest(text=text):
                slot = neg.parse_slot(text)
                self.assertEqual((slot.hour, slot.minute), (hour, minute))

    def test_nothing_usable_is_none(self):
        for text in ("", None, "Let me tell you about the course.", "10 o'clock whichever", "x" * 50):
            with self.subTest(text=text):
                self.assertIsNone(neg.parse_slot(text))

    def test_an_evening_or_weekend_proposal_is_accepted_as_it_is(self):
        accepted = {
            "tomorrow at 7 pm": "tomorrow at 7 PM",
            "tonight": "tonight",
            "monday at 6:30 pm": "on Monday at 6:30 PM",
            "saturday at 11 am": "on Saturday at 11 AM",
            "this weekend": "this weekend",
            "saturday": "on Saturday",
            "tomorrow evening": "tomorrow in the evening",
        }
        for text, phrase in accepted.items():
            with self.subTest(text=text):
                choice = neg.choose_slot(neg.parse_slot(text))
                self.assertEqual((choice.phrase, choice.moved), (phrase, False))

    def test_a_daytime_weekday_proposal_moves_to_seven_pm(self):
        for text in ("tomorrow at 10 am", "tomorrow morning", "wednesday at 2 pm", "monday afternoon"):
            with self.subTest(text=text):
                choice = neg.choose_slot(neg.parse_slot(text))
                self.assertTrue(choice.moved)
                self.assertTrue(choice.phrase.endswith("at 7 PM"), choice.phrase)
        self.assertEqual(
            neg.choose_slot(neg.parse_slot("on wednesday at 2 pm")).phrase, "on Wednesday at 7 PM"
        )

    def test_a_day_alone_gets_the_preferred_evening_and_nothing_usable_the_legacy_slot(self):
        self.assertEqual(neg.choose_slot(neg.parse_slot("tomorrow")).phrase, "tomorrow at 7 PM")
        self.assertEqual(neg.choose_slot(neg.parse_slot("on friday")).phrase, "on Friday at 7 PM")
        self.assertFalse(neg.choose_slot(neg.parse_slot("friday")).moved)
        self.assertEqual(neg.choose_slot(None), neg.SlotChoice(DEFAULT_SLOT, False))
        self.assertEqual(DEFAULT_SLOT, "on Thursday at 7 PM")

    def test_every_medium_sentence_stays_one_sentence_ending_so_we_can_decide(self):
        """The scorer-side mask (transcript.ts) matches /book a call[^.!?]*so we can decide/."""
        mask = re.compile(r"book a call\b[^.!?]*\bso we can decide", re.IGNORECASE)
        for text in (
            None, "tomorrow at 10 am", "saturday at 11:15 am", "tonight", "next week",
            "monday evening", "wednesday at 2 pm", "today",
        ):
            choice = neg.choose_slot(neg.parse_slot(text))
            for dm in ("husband", "father", "partner"):
                line = commitment_line(Level.MEDIUM, dm, choice.phrase, moved=choice.moved)
                with self.subTest(text=text, dm=dm):
                    self.assertEqual(len(split_sentences(line)), 1, line)
                    self.assertTrue(mask.search(line), line)
                    self.assertTrue(line.endswith("so we can decide."), line)
                    self.assertEqual(classify_learner_commitment(line), Level.MEDIUM, line)
                    line.encode("ascii")

    def test_the_moved_line_explains_the_move_in_the_same_sentence(self):
        choice = neg.choose_slot(neg.parse_slot("tomorrow at 10:00 a.m."))
        line = commitment_line(Level.MEDIUM, "husband", choice.phrase, moved=choice.moved)
        self.assertEqual(
            line,
            "Daytime is tough for me, so let's book a call tomorrow at 7 PM with my husband so "
            "we can decide.",
        )
        plain = commitment_line(Level.MEDIUM, "husband", "tomorrow at 7 PM")
        self.assertEqual(
            plain, "Let's book a call tomorrow at 7 PM with my husband so we can decide."
        )
        self.assertEqual(
            commitment_line(Level.MEDIUM, "husband"),
            "Let's book a call on Thursday at 7 PM with my husband so we can decide.",
        )

    def test_the_slot_words_are_no_deep_need_marker_for_any_persona(self):
        lines = [
            commitment_line(Level.MEDIUM, rendered.decision_maker, phrase, moved=moved)
            for rendered in variants()
            for phrase, moved in (
                (DEFAULT_SLOT, False), ("tomorrow at 7 PM", True), ("on Saturday", False),
                ("tonight", False), ("tomorrow in the evening", False), ("this weekend", False),
            )
        ]
        for rendered in variants():
            for line in lines:
                self.assertEqual(deep_need_topics_in(rendered, line), frozenset(), line)


class CallbackTests(unittest.TestCase):
    def test_the_real_callback_turns_are_found(self):
        for text in (T62_66, T68, T78):
            with self.subTest(text=text[:40]):
                self.assertIsNotNone(neg.detect_callback(text))

    def test_the_slot_comes_from_the_sentences_around_the_proposal(self):
        callback = neg.detect_callback(
            "I will mail the details today. Can we schedule a call tomorrow? Maybe at 7 pm."
        )
        self.assertEqual(callback.slot.day, "tomorrow")
        self.assertEqual(callback.slot.hour, 19)
        far = neg.detect_callback(
            "I will mail the details today. " + "We cover a lot. " * 6
            + "Shall we schedule a call? Great."
        )
        self.assertIsNone(far.slot)

    def test_ordinary_talk_is_not_a_callback(self):
        for text in (
            "", None, "Our curriculum covers python, sql and machine learning.",
            "On this call I would like to understand your goals.",
            "The program is $9,000 and takes six months.",
            "What made you look into data science right now?",
        ):
            with self.subTest(text=text):
                self.assertIsNone(neg.detect_callback(text))

    def test_the_slotless_proposals_carry_no_slot(self):
        self.assertIsNone(neg.detect_callback(T68).slot)
        self.assertIsNone(neg.detect_callback(T78).slot)

    def test_a_pitch_about_the_programme_is_not_a_callback(self):
        """R1-Q round 1: "reach you on the next session" turned a pitch into a call ask."""
        for text in PITCHES:
            with self.subTest(text=text):
                self.assertIsNone(neg.detect_callback(text), text)

    def test_a_call_you_on_needs_a_day_a_clock_time_or_a_part_of_the_day(self):
        for text, slot in (
            ("I'll call you on Monday.", neg.Slot("monday", None, 0, None)),
            ("I'll call you at 7 pm tonight.", neg.Slot("tonight", 19, 0, None)),
            ("We can call you back tomorrow at 7 pm.", neg.Slot("tomorrow", 19, 0, None)),
            ("I will call you in the evening.", neg.Slot(None, None, 0, "evening")),
            ("I will call you next week.", neg.Slot("next week", None, 0, None)),
        ):
            with self.subTest(text=text):
                callback = neg.detect_callback(text)
                self.assertIsNotNone(callback, text)
                self.assertEqual(callback.slot, slot)
        for text in (
            "We will call you on the group chat.",
            "Our mentors call you every Saturday to review progress.",
            "Our team will reach you on the next session to help with the capstone.",
            "We will reach out to you on the group chat if there is a new batch.",
        ):
            with self.subTest(text=text):
                self.assertIsNone(neg.detect_callback(text), text)


class EmailAndCheckinTests(unittest.TestCase):
    def test_email_offers(self):
        for text in (
            "I will mail that once we finish this call.",
            "I'll email you the details today.",
            "Let me send you the curriculum after this.",
            "We can send you an email with everything.",
            "I will send it over right now.",
            "I'll shoot you an email.",
        ):
            with self.subTest(text=text):
                self.assertTrue(neg.detect_email_offer(text))
        for text in ("", None, "Can you send me your resume?", "The email is on the website.",
                     "What is your email?"):
            with self.subTest(text=text):
                self.assertFalse(neg.detect_email_offer(text))

    def test_a_pitch_about_what_the_programme_sends_is_not_an_email_offer(self):
        """R1-Q round 1: format pitches got the learner's e-mail "yes" (an off-topic reply)."""
        for text in PITCHES:
            with self.subTest(text=text):
                self.assertFalse(neg.detect_email_offer(text), text)
        for text in (
            "I can send you a sample project to look at.",
            "I will send you the recordings of the missed classes.",
            "We will mail you the certificate at the end.",
        ):
            with self.subTest(text=text):
                self.assertFalse(neg.detect_email_offer(text), text)

    def test_an_offer_needs_a_first_person_promise_and_information_to_send(self):
        for text in (
            "I will email you the details once we finish this call.",
            "Sure, I will email you the details.",
            "I'll send you the brochure after the call.",
            "Let me mail you the curriculum.",
            "We can email you a link to the schedule.",
            "I will send everything over today.",
        ):
            with self.subTest(text=text):
                self.assertTrue(neg.detect_email_offer(text), text)
        for text in (
            "We send you the details every week.",
            "You get the details by email.",
            "The brochure is on our website.",
        ):
            with self.subTest(text=text):
                self.assertFalse(neg.detect_email_offer(text), text)

    def test_checkins(self):
        for text in (
            "So what do you think?",
            "What do you think about that?",
            "Is it fine with you?",
            "How does that sound?",
            "Does that make sense?",
            "Anything else you wanted to know about the course or program?",
            "Do you have any questions?",
            "Any other questions?",
            "What are your thoughts on that?",
            "Are you okay with that?",
        ):
            with self.subTest(text=text):
                self.assertTrue(neg.detect_checkin(text))

    def test_statements_that_mention_questions_or_thinking_are_not_checkins(self):
        for text in (
            "", None, "You can ask them any questions you want.",
            "If you have any other questions we can discuss it later.",
            "What do you think is the blocker in your career?",
            "I think the course is a good fit.",
            "What made you look into data science?",
            NEUTRAL,
        ):
            with self.subTest(text=text):
                self.assertFalse(neg.detect_checkin(text))

    def test_the_real_checkin_turns(self):
        self.assertTrue(neg.detect_checkin(T78))
        self.assertTrue(neg.detect_checkin(T80))
        self.assertFalse(neg.detect_checkin(T62_66))  # "if you have any other questions": no


class ReasonsHandledTests(unittest.TestCase):
    def test_each_reason_is_recognised(self):
        self.assertIn(neg.REASON_DECISION_MAKER, neg.reasons_handled_in(T78, "husband"))
        cases = {
            neg.REASON_TIMING: (
                "The next cohort starts in three weeks.",
                "There is no rush, take your time.",
                "You get recordings if you miss a class, so it is flexible.",
            ),
            neg.REASON_MONEY: (
                "We have a payment plan with monthly instalments.",
                "I can split the payment into parts.",
                "There is an EMI option.",
            ),
            neg.REASON_DECISION_MAKER: (
                "I can talk to your father if that helps.",
                "Happy to include your partner on the call.",
                "Bring your wife along and we will walk her through it.",
            ),
        }
        dms = {neg.REASON_DECISION_MAKER: "father"}
        for reason, texts in cases.items():
            for text in texts:
                with self.subTest(reason=reason, text=text):
                    self.assertIn(reason, neg.reasons_handled_in(text, dms.get(reason, "husband")))

    def test_a_negated_or_unrelated_mention_is_not_handling(self):
        self.assertNotIn(neg.REASON_MONEY, neg.reasons_handled_in("We have no discount at all."))
        self.assertNotIn(neg.REASON_MONEY, neg.reasons_handled_in("There is no payment plan."))
        self.assertEqual(neg.reasons_handled_in("Our instructors are from Google."), frozenset())
        self.assertEqual(neg.reasons_handled_in(""), frozenset())
        self.assertEqual(neg.reasons_handled_in(None), frozenset())


class PriceOfferTests(unittest.TestCase):
    def offers(self, text):
        return dict(neg.parse_price_offers(text))

    def test_the_owner_test_offer_in_every_spelling(self):
        self.assertEqual(self.offers(T58), {8500: False})
        self.assertEqual(self.offers("Okay, let's make it 8.5."), {8500: False})
        self.assertEqual(self.offers("Let's say 8500 for you."), {8500: False})
        self.assertEqual(self.offers("I can do it for 8,500 dollars."), {8500: False})
        self.assertEqual(self.offers("How about $8.5k?"), {8500: False})
        self.assertEqual(self.offers("Let's do eight thousand five hundred dollars."), {8500: False})
        self.assertEqual(self.offers("Let me bring it down to 8k, final price."), {8000: False})

    def test_discounts_become_the_price_they_leave(self):
        self.assertEqual(self.offers("I can give you $500 off."), {8500: False})
        self.assertEqual(self.offers("I'll knock $1,000 off the price."), {8000: False})
        self.assertEqual(self.offers("We can do 10% off if you enrol today."), {8100: True})
        self.assertEqual(self.offers("There is a discount of $1500."), {7500: False})

    def test_a_list_of_the_decks_discounts_is_not_an_offer(self):
        self.assertEqual(self.offers("We have discounts of $500, $1000 and $1500."), {})
        self.assertEqual(
            self.offers("The course is $9000, and we offer discounts of $500, $1000 and $1500."),
            {},
        )

    def test_the_learners_own_ask_echoed_back_is_not_an_offer(self):
        self.assertEqual(self.offers(T56), {})
        self.assertEqual(self.offers("So you're saying you need $7000."), {})
        self.assertEqual(self.offers("You are asking for $7,000, but I can't do that."), {})
        self.assertEqual(self.offers("I heard people got it for $7,500."), {})

    def test_a_refused_or_negated_figure_is_not_an_offer(self):
        self.assertEqual(self.offers("I can't do $7,000."), {})
        self.assertEqual(self.offers("$7,000 isn't something we can do."), {})
        self.assertEqual(self.offers("I can't do 7,000 but I can do $8,000."), {8000: False})

    def test_a_questioned_or_refused_anchor_is_never_an_offer(self):
        """R1-Q round 1 (blocker): the advisor's reply to the $7,000 anchor was read as a $7,000
        offer, and the learner then thanked them for a price nobody had offered."""
        for text in (
            "$7,000? Where did you hear that? That's not something we offer.",
            "Who told you $7,000? That was an old promo.",
            "$7,000 is too low for us, I'm afraid.",
            "Sorry, $7,000 is impossible.",
            "Um, actually how did you get to know that 7000 USD is the price?",
            "That is not realistic, $7,000 is not correct.",
            "We don't do $7,000, sorry.",
            "I don't think we can do $7,000 on this one.",
            "$7,000 needs approval from my manager first.",
            "Hmm, $7,000? That is no longer available.",
            "Is $7,000 what they told you?",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.offers(text), {}, text)

    def test_the_anchor_is_an_offer_only_when_the_advisor_promises_it(self):
        for text in (
            "Okay, I can do $7,000 for you.",
            "Let's make it 7000.",
            "We can meet you at $7,000.",
            "Okay, $7,000 then.",
            "How about $7,000?",
            "Sure, I can bring it down to 7000 dollars.",
            "We could do $7,000 if you enrol today.",
            "I'll give you $7,000.",
        ):
            with self.subTest(text=text):
                self.assertEqual(set(self.offers(text)), {7000}, text)

    def test_a_figure_the_learner_said_needs_the_same_promise(self):
        own = {8500}
        offers = lambda text: dict(neg.parse_price_offers(text, own))  # noqa: E731
        self.assertEqual(offers("You said $8,500, that is a lot."), {})
        self.assertEqual(offers("Who told you $8,500?"), {})
        self.assertEqual(offers("Okay, I can do $8,500 for you."), {8500: False})
        self.assertEqual(offers("I can do $8,000 for you."), {8000: False})

    def test_a_question_offers_only_when_phrased_as_an_offer(self):
        self.assertEqual(self.offers("How about $8,000?"), {8000: False})
        self.assertEqual(self.offers("Would $8,500 work for you?"), {8500: False})
        self.assertEqual(self.offers("Can I do $8,200 for you?"), {8200: False})
        self.assertEqual(self.offers("Is $8,500 okay for you?"), {8500: False})
        self.assertEqual(self.offers("Who told you $8,200? That was an old promo."), {})
        self.assertEqual(self.offers("Why is the program $8,500?"), {})
        self.assertEqual(self.offers("What do you think about $8,500 as a price?"), {})
        # A tag question after an offer is still the offer; a wh-question about a figure is not.
        self.assertEqual(self.offers("I can do $8,000, okay?"), {8000: False})
        self.assertEqual(self.offers("Let's make it $8,500, okay?"), {8500: False})
        self.assertEqual(self.offers("Would $7,000 work for you?"), {7000: False})
        self.assertEqual(self.offers("Who told you we could do $7,000? That was an old promo."), {})
        self.assertEqual(self.offers("Where did you hear $7,000 would work?"), {})
        self.assertEqual(self.offers("Can I ask where you heard $7,000?"), {})
        self.assertEqual(set(self.offers("What if I do $8,000 for you?")), {8000})

    def test_the_net_price_of_a_discount_is_not_the_anchor_echoed(self):
        self.assertEqual(self.offers("Today only I can do $2,000 off, so $7,000."), {7000: True})
        self.assertEqual(self.offers("I can give you $2,000 off."), {7000: False})
        self.assertEqual(self.offers("Who told you $2,000 off?"), {})
        self.assertEqual(self.offers("$2,000 off is too much for us."), {})

    def test_the_conditional_flag(self):
        self.assertEqual(self.offers("I can do $8,000 if you enrol today."), {8000: True})
        self.assertEqual(self.offers("I can do $8,000 with the upfront plan."), {8000: True})
        self.assertEqual(self.offers("I can do $8,000 for you."), {8000: False})

    def test_numbers_that_are_not_prices_are_ignored(self):
        for text in (
            "The price is $9,000 for 6.5 months.",
            "We have over 6000 students and the price is fixed.",
            "Call me at 7.30 pm about the price.",
            "The program is 8.5 hours a week, a great price.",
            "The price is $9,000.",
            "It costs $3,000 to run the lab.",
            "I have 5 years in this deal.",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.offers(text), {}, text)

    def test_a_bare_number_needs_a_price_cue(self):
        self.assertEqual(self.offers("We have 8500 learners."), {})
        self.assertEqual(self.offers("There were 8.5 of them."), {})

    def test_refusals(self):
        for text in (
            "I'm sorry, I can't go lower on the price.",
            "The price is fixed, we don't discount.",
            "That is the best I can do on price.",
            "A discount is not possible.",
            "We can't offer anything less than that.",
        ):
            with self.subTest(text=text):
                self.assertTrue(neg.refuses_price(text), text)
        for text in ("", None, "I can't promise a job.", "We can do $8,000.", NEUTRAL):
            with self.subTest(text=text):
                self.assertFalse(neg.refuses_price(text), text)


class StateTests(unittest.TestCase):
    def state(self, dm="husband"):
        return neg.Negotiation(dm)

    def test_offers_are_tracked_from_the_first_price_mention_and_only_once(self):
        """R1-Q round 1: an offer made BEFORE the anchor is on the table, and a restatement of
        any offer, before or after the anchor, is never a new one."""
        state = self.state()
        before = state.observe(1, "I can do $8,500 for you.", anchor_turn=None)
        self.assertTrue(before.offer_added)
        self.assertFalse(before.price_answer)  # there is no anchor yet to answer
        self.assertEqual([(o.turn, o.net_usd) for o in state.offers], [(1, 8500)])
        restated = state.observe(2, "Okay, I can do $8,500 for you.", anchor_turn=None)
        self.assertFalse(restated.offer_added)
        answer = state.observe(3, "Okay, I can do $8,500 for you.", anchor_turn=2)
        self.assertFalse(answer.offer_added)  # not new ...
        self.assertTrue(answer.price_answer)  # ... but it IS the answer to the anchor
        again = state.observe(4, "So the $8,500 is a good deal.", anchor_turn=2)
        self.assertFalse(again.offer_added)
        better = state.observe(5, "Let me do $8,000 then.", anchor_turn=2)
        self.assertEqual(better.offers[0].net_usd, 8000)
        self.assertEqual(state.best_offer_usd, 8000)
        self.assertEqual([o.net_usd for o in state.offers], [8500, 8000])

    def test_the_turn_78_mention_of_a_price_already_offered_is_not_a_new_offer(self):
        """R1-Q round 1 (group 18): "why the program is $8,500" while offering to call the
        husband primed "a better price on the table: $8,500" with no new offer."""
        state = self.state("husband")
        first = state.observe(
            13, "So the price I can do is $8500. I can reduce $500. Is it fine with you?",
            anchor_turn=None,
        )
        self.assertEqual([o.net_usd for o in first.offers], [8500])
        state.observe(14, "Okay.", anchor_turn=None)
        seen = state.observe(18, T78, anchor_turn=14)
        self.assertFalse(seen.offer_added)
        self.assertEqual([o.net_usd for o in state.offers], [8500])

    def test_a_refusal_only_answers_an_anchor_that_was_delivered(self):
        state = self.state()
        early = state.observe(1, "I am sorry, we can't go lower on the price.", anchor_turn=None)
        self.assertFalse(early.refusal)
        self.assertEqual(state.refusals, 0)
        late = state.observe(3, "I am sorry, we can't go lower on the price.", anchor_turn=2)
        self.assertTrue(late.refusal and late.price_answer)

    def test_an_earlier_offer_does_not_hide_a_later_refusal_of_the_anchor(self):
        state = self.state()
        state.observe(1, "I can do $8,500 for you.", anchor_turn=None)
        state.observe(3, "I'm sorry, that is the best I can do on price.", anchor_turn=2)
        self.assertEqual(state.price_situation(), neg.SITUATION_REFUSED)
        quiet = self.state()
        quiet.observe(1, "I can do $8,500 for you.", anchor_turn=None)
        quiet.observe(3, "Yeah, we can see what we can do.", anchor_turn=2)
        self.assertEqual(quiet.price_situation(), neg.SITUATION_SHORT)  # the number stands
        met = self.state()
        met.observe(1, "Today only I can do $2,000 off, so $7,000.", anchor_turn=None)
        self.assertEqual(met.best_offer_usd, 7000)
        self.assertEqual(met.price_situation(), neg.SITUATION_MET)

    def test_a_figure_the_learner_said_needs_a_promise_to_be_an_offer(self):
        state = self.state()
        state.note_learner_text("Honestly $8,500 is still a lot for me.")
        self.assertEqual(state.own_amounts, {8500})
        questioned = state.observe(3, "Where did you hear $8,500? That was an old promo.", anchor_turn=2)
        self.assertFalse(questioned.offer_added)
        promised = state.observe(4, "Okay, I can do $8,500 for you.", anchor_turn=2)
        self.assertTrue(promised.offer_added)

    def test_reason_voicings_are_counted_per_reason(self):
        state = self.state()
        state.note_reason_voiced(neg.REASON_TIMING, 3)
        state.note_reason_voiced(neg.REASON_TIMING, 7)
        state.note_reason_voiced(neg.REASON_MONEY, 8)
        self.assertEqual(state.voiced[neg.REASON_TIMING], 3)
        self.assertEqual(state.log()["reason_voicings"], {"timing": 2, "money": 1})

    def test_the_reasons_an_owed_move_owns_can_be_skipped(self):
        state = self.state()
        skip = {neg.REASON_TIMING, neg.REASON_DECISION_MAKER}
        self.assertEqual(state.next_reason(skip), neg.REASON_MONEY)
        state.note_reason_voiced(neg.REASON_MONEY, 1)
        self.assertIsNone(state.next_reason(skip))
        self.assertFalse(state.can_stall(skip))
        self.assertTrue(state.can_stall())  # nothing is skipped by default

    def test_the_price_situation_follows_the_advisors_answer(self):
        def situation(text):
            state = self.state()
            state.observe(2, text, anchor_turn=1)
            return state.price_situation()

        self.assertEqual(situation("Okay, let's make it 8.5."), neg.SITUATION_SHORT)
        self.assertEqual(situation("Sure, I can do $7,000 for you."), neg.SITUATION_MET)
        self.assertEqual(situation("I'm sorry, that is the best I can do on price."),
                         neg.SITUATION_REFUSED)
        self.assertEqual(situation("Yeah, we can see what we can do."), neg.SITUATION_UNCLEAR)
        # An offer wins over a refusal of the learner's figure.
        self.assertEqual(situation("I can't do $7,000 but I can do $8,000."), neg.SITUATION_SHORT)

    def test_every_counter_variant_raises_the_f1_counter_move(self):
        markers = MOVE_BY_ID[F1_COUNTER].markers
        for item in neg.COUNTERS:
            self.assertEqual(len(item.variants), 3, item.id)
            for text in item.variants:
                with self.subTest(item=item.id, text=text):
                    self.assertTrue(markers_match(markers, text))
        self.assertEqual({item.id for item in neg.COUNTERS}, {
            neg.SITUATION_SHORT, neg.SITUATION_MET, neg.SITUATION_REFUSED, neg.SITUATION_UNCLEAR,
        })

    def test_a_reason_is_handled_only_after_the_learner_voiced_it(self):
        state = self.state()
        early = state.observe(2, "We have a payment plan with instalments.", anchor_turn=None)
        self.assertEqual(early.reasons_handled, frozenset())
        state.note_reason_voiced(neg.REASON_MONEY, 3)
        same_turn = state.observe(3, "We have a payment plan with instalments.")
        self.assertEqual(same_turn.reasons_handled, frozenset())
        later = state.observe(4, "We have a payment plan with instalments.")
        self.assertEqual(later.reasons_handled, {neg.REASON_MONEY})
        self.assertEqual(state.reasons_handled_count, 1)
        again = state.observe(5, "The payment plan is monthly instalments.")
        self.assertEqual(again.reasons_handled, frozenset())  # counted once
        self.assertEqual(state.reasons_handled_count, 1)

    def test_the_decision_maker_is_handled_by_an_invitation_to_include_them(self):
        state = self.state("husband")
        state.note_reason_voiced(neg.REASON_DECISION_MAKER, 1)
        seen = state.observe(2, T78)
        self.assertIn(neg.REASON_DECISION_MAKER, seen.reasons_handled)

    def test_reasons_are_used_once_in_order(self):
        state = self.state()
        self.assertEqual(state.next_reason(), neg.REASON_TIMING)
        for expected in (neg.REASON_TIMING, neg.REASON_MONEY, neg.REASON_DECISION_MAKER):
            self.assertEqual(state.next_reason(), expected)
            state.note_reason_voiced(expected, 1)
        self.assertIsNone(state.next_reason())
        state.note_reason_voiced(neg.REASON_TIMING, 9)
        self.assertEqual(state.voiced[neg.REASON_TIMING], 1)  # the first time stands

    def test_stall_rounds_are_capped(self):
        state = self.state()
        self.assertTrue(state.can_stall())
        state.stall_rounds = neg.MAX_STALL_ROUNDS
        self.assertFalse(state.can_stall())
        state.stall_rounds = 0
        for reason in neg.REASONS:
            state.note_reason_voiced(reason, 1)
        self.assertFalse(state.can_stall())

    def test_a_spec_counts_as_raised_only_when_the_played_text_proves_it(self):
        state = self.state("husband")
        self.assertFalse(state.note_spoken(neg.N_TIMING, "Okay, I see.", 3))
        self.assertEqual(state.voiced, {})
        self.assertTrue(state.note_spoken(neg.N_TIMING, "I'm not ready to decide today.", 3))
        self.assertEqual(state.voiced, {neg.REASON_TIMING: 3})
        self.assertTrue(state.note_spoken(
            neg.N_DECISION_MAKER, "I should check with my husband first.", 4))
        self.assertFalse(state.note_spoken(
            neg.N_DECISION_MAKER, "I should check with my father first.", 5))
        self.assertFalse(state.note_spoken("N-NOPE", "anything", 5))
        self.assertTrue(state.note_spoken(neg.N_EMAIL, "Sure, you can email me. What is in it?", 6))
        self.assertTrue(state.email_answered)
        self.assertTrue(state.note_spoken(neg.N_QUESTION, "What would that call involve?", 7))
        self.assertTrue(state.question_used)

    def test_the_weak_line_is_said_at_most_once_and_the_first_commitment_stands(self):
        state = self.state()
        self.assertFalse(state.weak_line_said)
        state.note_commitment(Level.WEAK, 5)
        state.note_commitment(Level.MEDIUM, 6)
        self.assertTrue(state.resolved)
        self.assertTrue(state.weak_line_said)
        self.assertEqual((state.level, state.commitment_turn), (Level.WEAK, 5))

    def test_the_log_is_json_ids_and_integers_only(self):
        state = self.state()
        state.observe(1, "x", anchor_turn=None)
        state.observe(2, T78, anchor_turn=1)
        state.observe(3, T62_66, anchor_turn=1)
        state.note_response(2, "N-TIMING")
        state.slot_choice()
        log = state.log()
        text = json.dumps(log)
        self.assertEqual(log["offers"][0]["net_usd"], 8500)
        self.assertEqual(log["slot"], "tomorrow at 7 PM")
        self.assertTrue(log["slot_moved"])
        for fragment in ("husband", "curriculum", "doubts", "Oh, fine"):
            self.assertNotIn(fragment, text)

    def test_observing_never_raises_and_is_bounded_on_hostile_text(self):
        state = self.state()
        started = time.perf_counter()
        for index, text in enumerate((
            "", None, "\x00\x01", "word " * 20000, "a." * 20000, "$" + "9" * 400 + " off",
            "(((( [[[[ {{{{ ^^^^", "?" * 5000, "9," * 5000, "call back " * 3000,
            "tomorrow at " + "1" * 300 + " pm", "‮reversed‬ text",
        )):
            seen = state.observe(index + 1, text, anchor_turn=0)
            self.assertIsInstance(seen, neg.NegotiationTurn)
        self.assertLess(time.perf_counter() - started, 5.0)


class SpecContentTests(unittest.TestCase):
    """Every spoken variant is safe for every persona, and proves its own spec."""

    def texts(self):
        for rendered in variants():
            dm = rendered.decision_maker
            for spec in neg.SPECS:
                for text in spec.variants:
                    yield rendered, spec, neg.fill_decision_maker(text, dm)
            for item in neg.COUNTERS:
                for text in item.variants:
                    yield rendered, item, text

    def test_every_variant_passes_the_learner_guard_for_every_persona(self):
        seen = 0
        for rendered, spec, text in self.texts():
            context = GuardContext(phase="roleplay", persona=rendered, mode="reply")
            for sentence in split_sentences(text):
                hits = check_sentence(sentence, context)
                self.assertEqual(hits, [], f"{rendered.id}/{spec.id}: {sentence!r} -> {hits}")
            seen += 1
        self.assertGreater(seen, 200)

    def test_no_variant_or_brief_carries_a_locked_deep_need(self):
        for rendered, spec, text in self.texts():
            self.assertEqual(deep_need_topics_in(rendered, text), frozenset(), (spec.id, text))
        for rendered in variants():
            for spec in neg.SPECS:
                brief = neg.fill_decision_maker(spec.brief, rendered.decision_maker)
                self.assertEqual(deep_need_topics_in(rendered, brief), frozenset(), spec.id)
            for item in neg.COUNTERS:
                self.assertEqual(deep_need_topics_in(rendered, item.brief), frozenset(), item.id)
            self.assertEqual(
                deep_need_topics_in(rendered, neg.COMMIT_REACTION_BRIEF), frozenset()
            )

    def test_no_variant_is_a_commitment_or_a_concession(self):
        for _rendered, spec, text in self.texts():
            self.assertLessEqual(classify_learner_commitment(text), Level.WEAK, text)
            self.assertFalse(has_concession(text), text)

    def test_every_spec_variant_raises_its_own_spec_for_every_decision_maker(self):
        for rendered in variants():
            dm = rendered.decision_maker
            for spec in neg.SPECS:
                markers = neg.filled_markers(spec.markers, dm)
                self.assertEqual(len(spec.variants), 3, spec.id)
                for text in spec.variants:
                    filled = neg.fill_decision_maker(text, dm)
                    with self.subTest(spec=spec.id, dm=dm, text=filled):
                        self.assertTrue(markers_match(markers, filled))

    def test_the_markers_are_specific_to_their_own_reason(self):
        """A reply about timing does not prove the decision maker or the money reason."""
        specs = {spec.id: spec for spec in neg.SPECS}
        stalls = (neg.N_TIMING, neg.N_MONEY, neg.N_DECISION_MAKER)
        for own in stalls:
            for other in stalls:
                if own == other:
                    continue
                markers = neg.filled_markers(specs[own].markers, "husband")
                for text in specs[other].variants:
                    filled = neg.fill_decision_maker(text, "husband")
                    with self.subTest(own=own, other=other, text=filled):
                        self.assertFalse(markers_match(markers, filled))

    def test_ordinary_replies_do_not_prove_a_reason(self):
        for text in ("Okay, I see.", "That makes sense.", "Hmm, interesting.", "Thanks.", ""):
            for spec in neg.SPECS:
                markers = neg.filled_markers(spec.markers, "husband")
                self.assertFalse(markers_match(markers, text), (spec.id, text))

    def test_the_content_is_ascii_short_and_one_per_line(self):
        for spec in neg.SPECS:
            for text in (spec.brief, *spec.variants):
                text.encode("ascii")
            for group in spec.markers:
                for pattern in group:
                    re.compile(pattern)
        for item in neg.COUNTERS:
            for text in (item.brief, *item.variants):
                text.encode("ascii")
                self.assertLessEqual(len(text.split()), 30)
        neg.COMMIT_REACTION_BRIEF.encode("ascii")

    def test_no_brief_contains_a_quote_or_a_figure_it_cannot_say(self):
        for spec in neg.SPECS:
            self.assertNotIn('"', spec.brief)
        for item in neg.COUNTERS:
            self.assertNotIn('"', item.brief)
            self.assertNotRegex(item.brief, r"\d")
        self.assertNotIn('"', neg.COMMIT_REACTION_BRIEF)

    def test_specs_are_found_by_id_and_by_reason(self):
        self.assertEqual(neg.SPEC_BY_ID[neg.N_EMAIL].kind, neg.KIND_EMAIL)
        self.assertEqual(neg.SPEC_BY_REASON[neg.REASON_MONEY].id, neg.N_MONEY)
        self.assertEqual(set(neg.SPEC_BY_REASON), set(neg.REASONS))


class AnchorAfterOfferTests(unittest.TestCase):
    """R1-Q round 1: the anchor reacts to a price the advisor already put on the table."""

    OFFERS = (8800, 8500, 8000, 7500, 7000, 6500)

    def test_the_situation_depends_on_where_the_offer_sits_against_the_ask(self):
        for offer in self.OFFERS:
            situation = neg.anchor_after_offer(offer)
            expected = neg.ANCHOR_ABOVE if offer > neg.ANCHOR_USD else neg.ANCHOR_REACHED
            self.assertEqual(situation.id, expected, offer)
            self.assertIn(f"${offer:,}", situation.brief)
            self.assertIn("$7,000", situation.must_say)
            self.assertEqual(len(situation.variants), 3)

    def test_every_variant_still_raises_the_anchor_move(self):
        markers = MOVE_BY_ID["F1-ANCHOR"].markers
        for offer in self.OFFERS:
            for text in neg.anchor_after_offer(offer).variants:
                with self.subTest(offer=offer, text=text):
                    self.assertTrue(markers_match(markers, text))

    def test_the_figures_the_learner_must_write_are_in_every_above_variant(self):
        for offer in (8800, 8500, 8000, 7500):
            situation = neg.anchor_after_offer(offer)
            self.assertEqual(situation.must_say, (f"${offer:,}", "$7,000"))
            for text in situation.variants:
                self.assertIn(f"${offer:,}", text)
                self.assertIn("$7,000", text)

    def test_no_variant_accepts_commits_concedes_or_carries_a_locked_need(self):
        for rendered in variants():
            for offer in self.OFFERS:
                situation = neg.anchor_after_offer(offer)
                context = GuardContext(
                    phase="roleplay", persona=rendered, mode="reply",
                    advisor_amounts=frozenset({offer}),
                )
                for text in (situation.brief, *situation.variants):
                    self.assertEqual(deep_need_topics_in(rendered, text), frozenset(), text)
                for text in situation.variants:
                    self.assertLessEqual(classify_learner_commitment(text), Level.WEAK, text)
                    self.assertFalse(has_concession(text), text)
                    text.encode("ascii")
                    self.assertLessEqual(len(text.split()), 30)
                    for sentence in split_sentences(text):
                        hits = check_sentence(sentence, context)
                        self.assertEqual(hits, [], f"{rendered.id}: {sentence!r} -> {hits}")
                self.assertNotIn('"', situation.brief)


if __name__ == "__main__":
    unittest.main()
