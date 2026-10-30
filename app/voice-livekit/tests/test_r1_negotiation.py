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
from r1_commitment import (
    DEFAULT_SLOT,
    AskKind,
    Level,
    around,
    classify_learner_commitment,
    commitment_line,
    describes_programme,
    detect_ask,
    enrol_ask_in,
    production_call_ask_in,
)
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


def production_reads(text):
    """Origin/main's reading of an advisor turn: one of its enrolment or call patterns matches a sentence."""
    return any(
        enrol_ask_in(sentence) is not None or production_call_ask_in(sentence) is not None
        for sentence in split_sentences(text)
    )


# Pitch sentences about what the programme sends, schedules or does (R1-Q round 1, review 2).  None
# is an e-mail offer or a callback; none is an ask unless production's own patterns read it as one
# (ship restore round 1: ``production_reads``).
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
# Round 2 (review 3): booking, calling and sending wording in the SINGULAR and in every other form
# a pitch takes.  None is an e-mail offer, a callback or an ask of any kind.
CALL_PITCHES = (
    "You can book a one-on-one session with a mentor anytime.",
    "Mentors are available, you can book a slot with them every week.",
    "You can schedule a mock interview session whenever you want.",
    "We arrange a career coaching session in the third month.",
    "The coach will call you on the first day of the program.",
    "You can book a call with a mentor anytime.",
    "You can book a slot with a mentor.",
    "You can schedule a career counselling call whenever you want.",
    "Students get a one-on-one call with a mentor every month.",
    "The mentor will schedule a call with you in the third week.",
    "We can arrange a session with a mentor whenever you need help.",
    "You can ask for a doubt clearing session anytime.",
    "We organise a resume review session in the second month.",
    "Our mentors will set up a call with you after you enroll.",
    "You will get a slot with the mentor each week.",
    "Your mentor will call you on the first day of the program.",
    "Book a one-on-one session with a mentor whenever you need help.",
    "Alumni book a slot with an instructor during the program.",
    "You can schedule a time with the instructors every Saturday.",
    "The program lets you book a session with a coach at the end of each module.",
    # first-person wording about class timings and the onboarding flow, not a call with this learner
    "We can schedule a session on weekends for working professionals.",
    "I can arrange a session on the weekend if you miss a class.",
    "We'll schedule your onboarding call after you enroll.",
    "We can book you a slot in the next batch.",
    # questions that are still pitches
    "Did you know you can book a one-on-one session with a mentor anytime?",
    "Do you know that students can schedule a call with the coach every week?",
    "What students love is that they can schedule a call with a coach whenever they want.",
    "You can book a slot with a mentor, right?",
    "Want to know the best part? We schedule a career coaching session in the third month.",
    # ship de-risk: the programme's own schedule that ends in a fit check proposes no call
    "Our mentors run a live call every Saturday, would that work with your schedule?",
    "Live sessions are Tuesday and Thursday at 8 PM, would that work for you?",
    "Mentor sessions are every Wednesday at 9 PM, does that time work for you?",
    "We do a live coding call on Saturdays, is that good for you?",
    "Office hours run Friday evenings, would that work with your kids' routine?",
    "The weekly check-in is on Monday evenings, is that okay with your job?",
    "The capstone review call is on Thursdays, is that fine for you?",
)
EMAIL_PITCHES = (
    "We'll send you the schedule once you enroll.",
    "We'll send you the recordings once you join.",
    "We will email you the class link before every session.",
    "We'll email you the details of the live session every week.",
    "We can send you the notes for each class after you enroll.",
    "We will send you the schedule of the live classes on the first day of the program.",
    "I'll email you a link to join the live session.",
    "We'll send you the zoom link before the class.",
    "We will email you the reminders for the weekly session.",
)


def generated_call_pitches():
    """Every combination of who, what, with whom and when, one in seven (a deterministic sample)."""
    subjects = (
        "You can", "You may", "You will be able to", "Students can", "Learners get to",
        "Our mentors will", "Mentors can", "The coach will", "Your mentor will", "Alumni can",
        "We can", "We will", "We'll", "I can",
    )
    verbs = ("book", "schedule", "set up", "arrange", "organise", "plan")
    things = (
        "a one-on-one session with a mentor", "a slot with a mentor",
        "a mock interview session", "a career coaching session", "a doubt clearing session",
        "a resume review call", "office hours with an instructor",
    )
    whens = (
        "anytime", "whenever you want", "every week", "each month", "once you enroll",
        "after you join", "in the third month", "during the program",
        "on the first day of the program", "at the end of each module",
    )
    index = 0
    for subject in subjects:
        for verb in verbs:
            for thing in things:
                for when in whens:
                    index += 1
                    if index % 7 == 0:
                        yield f"{subject} {verb} {thing} {when}."
# Real proposals of a call: every one of these must still be seen after the pitch filter.
CALL_PROPOSALS = (
    "Can we schedule a call tomorrow at 7 pm?",
    "Let's book a follow-up call.",
    "I'll call you back tomorrow.",
    "Shall we set up a time to talk?",
    "I can set up a call with your husband.",
    "Would you like to schedule a quick call?",
    "How about we schedule a call on Saturday?",
    "Let me schedule a call for tomorrow.",
    "Why don't we book a time?",
    "Schedule a call with me and we will go from there.",
    "Our team will call you tomorrow at 7 pm to finalize the details.",
    "Let's schedule a call so I can walk you through how the mentors work.",
    "We can arrange a call with you and your husband whenever it suits you.",
    "Can I book a slot with you for a quick chat on Friday?",
    "I will call you on Monday at 6 pm.",
)
# Real simulated-advisor turns of the rehearsal sweeps that the first version of the filter missed
# ("if we ...", "what if ...").  The callback detector reads them (and so makes the learner's
# "wants" a call); the ask detector never did.
CALLBACK_PROPOSALS = (
    "Would it help if we got him on a quick call with me?",
    "Would it help if I set up a short call with both of you so you can ask questions together?",
    "What if we do a quick call with your husband on Saturday?",
    "What time tomorrow actually works for a quick call, lunch or evening?",
    "Would a quick call after you've read it help?",
    "Since mornings don't work, when's better for a quick call?",
    "Can I pencil you in for tomorrow at nine?",
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
        for text in (T62_66, T68):
            with self.subTest(text=text[:40]):
                self.assertIsNotNone(neg.detect_callback(text))

    def test_the_owner_s_turn_78_offers_a_talk_with_the_husband_and_is_no_callback(self):
        # Ship restore round 1: "I can also talk to your husband" was read as a call by the head-only
        # "talk to your husband" call object, which also read "Talk to your husband tonight and let me
        # know"; production reads neither, and neither does the engine now.
        self.assertIsNone(neg.detect_callback(T78))
        self.assertIsNone(detect_ask(T78))

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


class PitchOrProposalTests(unittest.TestCase):
    """R1-Q round 2 (review 3, R2-3): booking, calling and sending wording that describes the
    programme is neither a callback, an ask of any kind nor an e-mail offer; the close window then
    never answers a pitch with the scripted MEDIUM line.  Round 1 only fixed the cited sentences
    (its own test used "book mentor slots", plural, which slipped past the singular pattern)."""

    def assert_not_detected(self, text):
        self.assertIsNone(neg.detect_callback(text), text)
        self.assertFalse(neg.detect_email_offer(text), text)
        # Ship restore round 1 (owner decision 2026-10-09): the engine's ask is the structural reader OR
        # production's own pattern list, so a pitch gets an ask exactly where production's patterns read
        # one (those false positives are back, equal to production); the structural reader adds none.
        self.assertEqual(detect_ask(text) is not None, production_reads(text), text)

    def test_the_reviewers_call_pitches_are_nothing(self):
        for text in CALL_PITCHES:
            with self.subTest(text=text):
                self.assert_not_detected(text)

    def test_the_reviewers_email_pitches_are_nothing(self):
        for text in EMAIL_PITCHES:
            with self.subTest(text=text):
                self.assert_not_detected(text)

    def test_the_round_one_pitches_are_still_nothing(self):
        for text in PITCHES:
            with self.subTest(text=text):
                self.assert_not_detected(text)

    def test_every_generated_pitch_is_nothing(self):
        count = 0
        for text in generated_call_pitches():
            count += 1
            with self.subTest(text=text):
                self.assert_not_detected(text)
        self.assertGreater(count, 400)

    def test_a_pitch_production_reads_as_a_call_is_read_as_one_as_on_production(self):
        reads = [text for text in CALL_PITCHES if production_reads(text)]
        self.assertGreaterEqual(len(reads), 15)
        for text in reads:
            with self.subTest(text=text):
                ask = detect_ask(text)
                self.assertIsNotNone(ask, text)
                self.assertIsNone(neg.detect_callback(text), text)

    def test_real_proposals_of_a_call_are_still_seen(self):
        for text in CALL_PROPOSALS:
            with self.subTest(text=text):
                self.assertIsNotNone(neg.detect_callback(text), text)
                ask = detect_ask(text)
                self.assertIsNotNone(ask, text)
                self.assertEqual(ask.kind, AskKind.CALL, text)

    def test_proposals_the_sweeps_phrased_as_a_question_to_the_learner_are_still_seen(self):
        for text in CALLBACK_PROPOSALS:
            with self.subTest(text=text):
                self.assertIsNotNone(neg.detect_callback(text), text)

    def test_a_greeting_that_says_quick_call_is_no_callback(self):
        """"Hi Meera, quick call!" opened every scripted call and counted as a callback proposal."""
        text = "Hi Meera, quick call! The course is $9,000 but today only I can do $2,000 off."
        self.assertIsNone(neg.detect_callback(text))

    def test_the_owner_test_turns_are_still_seen(self):
        for text in (T62_66, T68):
            with self.subTest(text=text[:40]):
                self.assertIsNotNone(neg.detect_callback(text))

    def test_a_pitch_inside_a_long_turn_does_not_hide_or_make_a_proposal(self):
        pitch = "You can book a slot with a mentor every week."
        proposal = "Can we schedule a call tomorrow at 7 pm?"
        self.assertIsNone(neg.detect_callback(f"{pitch} The fees are nine thousand."))
        self.assertIsNotNone(neg.detect_callback(f"{pitch} {proposal}"))
        self.assertIsNotNone(neg.detect_callback(f"{proposal} {pitch}"))
        self.assertEqual(neg.detect_callback(f"{pitch} {proposal}").slot.day, "tomorrow")

    def test_a_faraway_cadence_does_not_cancel_a_proposal(self):
        text = "Let's schedule a call so I can walk you through how classes run every week."
        self.assertIsNotNone(neg.detect_callback(text))
        self.assertEqual(detect_ask(text).kind, AskKind.CALL)

    def test_a_bare_link_is_an_enrolment_ask_as_on_production(self):
        # Ship restore (owner decision 2026-10-09): "send you the link to the live class" is read as an
        # enrolment ask, exactly as on production (its three rows moved out of this test: the
        # structural grammar that exempted them did not converge and is gone).
        for text in ("I'll send you the link.", "Shall I send you the payment link?"):
            with self.subTest(text=text):
                self.assertIsNotNone(detect_ask(text), text)

    def test_the_help_words_agree_with_the_filter(self):
        near = around("you can book a slot with them every week.", 8, 19)
        self.assertTrue(describes_programme(near))
        self.assertFalse(describes_programme(around("can we schedule a call tomorrow?", 7, 22)))


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

    def test_a_percent_discount_below_the_floor_is_no_offer(self):
        """Owner test 7f2a25e6 turn 58: "more than 90% discount" became a $900 offer and the learner
        said "Nine hundred is easier to hear", a number nobody said.  A percent discount keeps the
        floor a dollar figure has (``MIN_NET_USD``)."""
        turn_58 = (
            "First, I am trying to give you the program for $100 and you are asking too many "
            "questions like I reduced, I gave you more than 90% discount."
        )
        self.assertEqual(self.offers(turn_58), {})
        self.assertEqual(self.offers("I gave you more than 90% discount"), {})
        self.assertEqual(self.offers("I can give you 60% off."), {})
        self.assertEqual(self.offers("Fine, 99 percent off, take it."), {})
        # A real percent discount is still the price it leaves, up to the floor itself.
        self.assertEqual(self.offers("I can do 20% off for you."), {7200: False})
        self.assertEqual(self.offers("I can give you 50% off."), {neg.MIN_NET_USD: False})
        state = neg.Negotiation("husband")
        state.observe(21, "I can do $8,000 for you.", anchor_turn=None)
        seen = state.observe(58, turn_58, anchor_turn=22)
        self.assertFalse(seen.offer_added)
        self.assertEqual([o.net_usd for o in state.offers], [8000])

    def test_owner_test_8f5bfefc_a_framed_net_price_below_the_floor_is_an_offer(self):
        """Owner test 8f5bfefc turns 56 and 64: "I will give it to you for $3000" (before the
        anchor) and "give the program for 3000" were dropped by the cue gate and the $4,500 floor,
        and the learner then asked for $7,000 as if nothing was on the table."""
        turn_56 = "So the program is for $9000. I will give it to you for $3000."
        turn_64 = (
            "I am telling you that I can give it, give the program for 3000. I will do better "
            "than 7000. I am giving it to you for 3000."
        )
        for text in (turn_56, turn_64):
            for require_cue in (True, False):
                with self.subTest(text=text, require_cue=require_cue):
                    self.assertEqual(
                        neg.parse_price_offers(text, require_cue=require_cue), [(3000, False)]
                    )
        for text in (
            "The price for you is $3000.",
            "You'll only pay $3000.",
            "I'm bringing it down to $3000.",
            "Would you take it for $3000?",
            "I can give you the course at $3,000.",
            "Your final price will be 3000.",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.offers(text), {3000: False})
        self.assertEqual(self.offers("I can do it for 3000 only if you pay today."), {3000: True})
        # Before the anchor a framed price needs no other pricing word either.
        self.assertEqual(
            neg.parse_price_offers("I will give it to you for $8000.", require_cue=True),
            [(8000, False)],
        )

    def test_a_low_figure_that_is_no_net_price_stays_out(self):
        for text in (
            "I can't give it to you for $3000.",
            "Other bootcamps sell it for $3000.",
            "People got it for $3000 last year.",
            "Our alumni pay $3000 more in salary.",
            "I can give it to you for $500.",  # below MIN_FRAMED_NET_USD
            "We give it to you for 6 months of access.",
            "I will do better than $7000.",  # a bound, not the figure
            "Good luck finding better cost and better program.",
            # Someone else's price: "get" / "have" / "take" need "you" (review of the fix).
            "Most of my students get it for 6000.",
            "Other people get it for 6000.",
            "Other people get it for 3000.",
            "In 2025 the price was the same, and the 2026 batch starts soon.",
        ):
            for require_cue in (True, False):
                with self.subTest(text=text, require_cue=require_cue):
                    self.assertEqual(neg.parse_price_offers(text, require_cue=require_cue), [])
        # A small figure next to "off" / "save" / "discount" is still the discount it was.
        for text in ("$3000 off", "You'd save $3000", "A $3000 discount is the deepest."):
            with self.subTest(text=text):
                self.assertEqual(self.offers(text), {6000: False})

    # A part of the price, never the price (review of the 8f5bfefc fix: each one became the best
    # offer, the price "met" and the money stall dropped; main read none of them).
    PART_PAYMENTS = (
        "You'll only pay 2000 upfront and the rest in instalments.",
        "You'll pay $2,000 today and the rest over six months.",
        "You'll pay $2,000 now, and you can pay the rest later.",
        "The booking fee is just $1,000, and the rest you can pay later.",
        "The booking fee is just $1,000 to reserve your seat.",
        "You will pay 1500 now and 4500 later.",
        "The total comes to 1500 per instalment.",
        "The cost is 2000 per module.",
        "With the payment plan, you'll pay 1500 per instalment.",
        "Yes, we have a payment plan. You will pay 3000 now and the rest in two parts.",
        "You just pay $1,000 now and the rest later.",
        "You'll pay $1,000 as the registration fee to block your seat.",
        "The fee is $1,500 per installment.",
        "Sure, the fee is 3000 per term.",
        "The price is 1000 per module.",
        "The cost for you is $2,000 more if you add mentorship.",
        "You'll pay 1,500 dollars as a deposit.",
        "The fee is 1500 for the first instalment.",
        "I can bring it down by 2000.",
        # Review round 2: the rest paid later in other words, a duration or count of payments,
        # and a per-month figure in rupees.
        "You can join for 2000 and pay the rest later.",
        "You can join for 2000 and pay the rest in EMIs.",
        "You can start for 2000, rest in instalments.",
        "You can join for $2,000 and pay the balance in instalments.",
        "You'll pay 1500 for 6 months.",
        "You'll pay 1500, 6 times.",
        "You'll pay 1500 twice.",
        "The fee is 1500 rupees a month.",
        "The total is 3000 rupees per month.",
    )

    def test_a_part_of_the_price_is_no_net_price(self):
        for text in self.PART_PAYMENTS:
            for require_cue in (True, False):
                with self.subTest(text=text, require_cue=require_cue):
                    self.assertEqual(neg.parse_price_offers(text, require_cue=require_cue), [])
        for text in self.PART_PAYMENTS:
            with self.subTest(text=text, through="observe"):
                state = neg.Negotiation("husband")
                state.observe(4, "So the program is $9,000.")
                state.observe(6, text, anchor_turn=5)
                self.assertIsNone(state.best_offer_usd)
                self.assertNotEqual(state.price_situation(), neg.SITUATION_MET)
                self.assertFalse(state.money_is_settled())
                self.assertIsNone(state.unread_low_usd())  # the default anchor plays, as on main

    def test_a_bare_discount_is_the_discount_it_is(self):
        """Review of the 8f5bfefc fix: the framed floor read "for 1000 off" as a $1,000 price;
        with a "$" sign it always was the $8,000 the advisor meant."""
        for text, net in (
            ("I can give it to you for 1000 off.", 8000),
            ("I can give it to you for 1,000 off.", 8000),
            ("We can do it for 1000 off, that's the best.", 8000),
            ("I can give it to you for 1500 off.", 7500),
            ("I can give it to you for 1500 less.", 7500),
            ("You'll pay 1000 less.", 8000),
            ("I can do that for 2000 off.", 7000),
            ("I will give you the course for 1500 discount, so it's 7500.", 7500),
        ):
            for require_cue in (True, False):
                with self.subTest(text=text, require_cue=require_cue):
                    self.assertEqual(
                        {v for v, _ in neg.parse_price_offers(text, require_cue=require_cue)},
                        {net},
                    )

    def test_owner_test_8f5bfefc_every_way_of_naming_the_low_price_is_an_offer(self):
        """Review of the 8f5bfefc fix: only the owner's exact verb frames were read, so "I can
        offer you $3,000" still got "$9,000 ... can you match $7,000?"."""
        for text in (
            "I can offer you $3,000.",
            "I can offer 3000.",
            "It's yours for $3,000.",
            "Special price for you, $3,000.",
            "Only $3,000 for you today.",
            "How about $3,000?",
            "Let's make it 3000.",
            "I'll make it 3000.",
            "For you it's just 3000.",
            "You can join for $3,000.",
            "I'll give you a deal at $3,000.",
            "Okay, 3000 dollars, final.",
            "I will give it to you for 3 thousand.",
            "So the program is $9,000. I can offer you $3,000.",
        ):
            for require_cue in (True, False):
                with self.subTest(text=text, require_cue=require_cue):
                    self.assertEqual(
                        {v for v, _ in neg.parse_price_offers(text, require_cue=require_cue)},
                        {3000},
                    )

    def test_a_low_figure_not_read_as_an_offer_is_kept_for_the_anchor(self):
        state = neg.Negotiation("husband")
        state.observe(4, "So the program is $9,000. I can give you 1500.")
        self.assertIsNone(state.best_offer_usd)
        self.assertEqual(state.unread_low_usd(), 1500)
        state.observe(6, "I can give it to you for $3,000.")
        self.assertEqual(state.best_offer_usd, 3000)
        self.assertEqual(state.unread_low_usd(), 1500)  # still under the best offer
        for text in (
            "I can give it to you for 1000 off.",  # a discount: read as $8,000
            "Our alumni see a $3,000 jump in salary.",
            "I can't give it to you for 3000.",
            "Who told you $3,000?",
            *self.PART_PAYMENTS,
        ):
            with self.subTest(text=text):
                self.assertEqual(neg.unread_low_figures(text), [])
        anchor = neg.anchor_after_unclear_low(1500)
        self.assertEqual(anchor.id, neg.ANCHOR_UNCLEAR)
        self.assertEqual(anchor.must_say, ("$1,500", "$7,000"))
        for variant in anchor.variants:
            with self.subTest(variant=variant):
                self.assertIn("$1,500", variant)
                self.assertIn("$7,000", variant)
                for asked in ("$9,000", "Can you do that", "match that", "Is that possible"):
                    self.assertNotIn(asked, variant)

    # Review round 2 of the 8f5bfefc fix: pitch figures that were read as the learner's price.
    PITCH_COUNTS = (
        "We have 5 thousand alumni at top companies.",
        "Over 6 thousand learners placed.",
        "We have placed 3 thousand students so far.",
        "We have 3 thousand happy alumni.",
        "Over five thousand learners have been placed through this program.",
        "Our instructors have taken over two thousand interviews at FAANG.",
        "We have three thousand five hundred reviews on Google.",
        "The batch has 1,500 seats and the fee is nine thousand dollars.",
        "More than 2,500 dollars is the average monthly salary hike for our alumni.",
    )
    COMPETITOR_PRICES = (
        "Scaler sells it for 3000.",
        "Coursera offers it for 3000.",
        "Udemy sells the course for 3000.",
        "Scaler sells it for 6000.",
        "Coursera's price is $3,000.",
        "At Scaler the price is $3,000.",
        "At Scaler the price is $6,000.",
        "Acme Academy sells it for 3000.",
        "Scaler sells it for 3000, but they have no mentors.",
    )
    ADD_ONS = (
        "We have a $2,000 early bird discount right now.",
        "You get $2,000 in credits.",
        "You'll get $3,000 worth of bonuses.",
        "EMIs start at $1,500.",
        "There's a $2,000 referral bonus.",
        "You get a free 3000 dollar course as a bonus.",
    )

    def test_review_round_2_a_count_a_competitor_or_an_add_on_is_no_price(self):
        for text in (*self.PITCH_COUNTS, *self.COMPETITOR_PRICES, *self.ADD_ONS):
            for require_cue in (True, False):
                with self.subTest(text=text, require_cue=require_cue):
                    self.assertEqual(neg.parse_price_offers(text, require_cue=require_cue), [])
            with self.subTest(text=text, read="unread"):
                self.assertEqual(neg.unread_low_figures(text), [])
            with self.subTest(text=text, through="observe"):
                state = neg.Negotiation("husband")
                state.observe(4, "So the program is $9,000.")
                state.observe(6, text, anchor_turn=5)
                self.assertIsNone(state.best_offer_usd)
                self.assertNotEqual(state.price_situation(), neg.SITUATION_MET)
                self.assertFalse(state.money_is_settled())
                self.assertIsNone(state.unread_low_usd())

    def test_review_round_2_the_advisors_own_low_price_still_counts(self):
        for text in (
            "Scaler sells it for 6000, but I'll give it to you for 3000.",
            "I can give it for $3000 with the discount.",
            "I'll give it to you for 3000 and send you the link later.",
            "We are happy to give you the course for 3000.",
            "Let me give it to you for 3000.",
            "A special price of 3 thousand for students like you.",
            "I will give it to you for 3 thousand dollars.",
        ):
            for require_cue in (True, False):
                with self.subTest(text=text, require_cue=require_cue):
                    self.assertEqual(
                        {v for v, _ in neg.parse_price_offers(text, require_cue=require_cue)},
                        {3000},
                    )
        for text in ("Basically it costs $6,000.", "Unlike YouTube, the price for you is $6,000."):
            with self.subTest(text=text):
                self.assertEqual(self.offers(text), {6000: False})

    def test_a_capitalised_price_word_is_not_a_competitors_name(self):
        """Fuzz pass 2026-10-30: speech-to-text capitalises the first word, and "Best price" or
        "Mera last price" must read as the advisor's price, as on main, not as "Acme prices it"."""
        for text, value in (
            ("Mera best price 7,600 dollars hai.", 7600),
            ("Last price, 6,500 dollars.", 6500),
            ("Mera last price 6,000 dollars hai.", 6000),
            ("Hamara best price 6,800 dollars hai.", 6800),
            ("Discounted price 6,000 dollars, for you.", 6000),
            ("Revised price is 5,000 dollars.", 5000),
            ("Special price is 6,500 dollars.", 6500),
            ("Course price is 6,500 dollars.", 6500),
        ):
            with self.subTest(text=text):
                self.assertEqual({v for v, _ in neg.parse_price_offers(text)}, {value})
        # A real name in a seller's role still hands the figure to someone else.
        for text in ("Acme sells it for 3000.", "Acme charges 3000 for it."):
            with self.subTest(text=text):
                self.assertEqual(neg.parse_price_offers(text), [])

    def test_review_round_2_a_low_figure_named_before_the_full_price_is_stale(self):
        """"$2,000 in credits" (or any low figure) at turn 56, then "The program costs $9,000":
        the anchor asked "is $2,000 what I'd pay in total?" instead of asking for $7,000."""
        state = neg.Negotiation("husband")
        state.observe(56, "I can give you 1500.")
        self.assertEqual(state.unread_low_usd(), 1500)
        state.observe(58, "The program costs $9,000.")
        self.assertIsNone(state.unread_low_usd())
        state.observe(60, "Okay, I can give you 2500.")
        self.assertEqual(state.unread_low_usd(), 2500)  # named after the price: current again
        state.observe(62, "I can do $8,000 for you.")
        self.assertEqual(state.best_offer_usd, 8000)
        self.assertIsNone(state.unread_low_usd())  # an offer above the anchor clears it too
        # A low figure in the same turn as the price is still the one the anchor reacts to.
        same = neg.Negotiation("husband")
        same.observe(4, "So the program is $9,000. I can give you 1500.")
        self.assertEqual(same.unread_low_usd(), 1500)
        for text in ("Scaler costs $9,000.", "I can't do $9,000.", "What's the price, $9,000?"):
            with self.subTest(text=text):
                self.assertFalse(neg.states_full_price(text))
        for text in ("The program costs $9,000.", "The fee is 9000.", "Our price is $8,500."):
            with self.subTest(text=text):
                self.assertTrue(neg.states_full_price(text))

    def test_owner_test_8f5bfefc_the_three_thousand_is_on_the_table(self):
        state = neg.Negotiation("husband")
        state.observe(56, "So the program is for $9000. I will give it to you for $3000.")
        self.assertEqual(state.best_offer_usd, 3000)
        state.observe(
            64,
            "I am telling you that I can give it, give the program for 3000. I will do better "
            "than 7000. I am giving it to you for 3000.",
            anchor_turn=63,
        )
        self.assertEqual([o.net_usd for o in state.offers], [3000])
        self.assertEqual(state.price_situation(), neg.SITUATION_MET)
        self.assertTrue(state.money_is_settled())
        anchor = neg.anchor_after_offer(state.best_offer_usd)
        self.assertEqual(anchor.must_say, ("$3,000", "$7,000"))

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
        # Asking what the learner thinks of a new figure proposes it (round 2).
        self.assertEqual(self.offers("What do you think about $8,500 as a price?"), {8500: False})
        # A tag question after an offer is still the offer; a wh-question about a figure is not.
        self.assertEqual(self.offers("I can do $8,000, okay?"), {8000: False})
        self.assertEqual(self.offers("Let's make it $8,500, okay?"), {8500: False})
        self.assertEqual(self.offers("Would $7,000 work for you?"), {7000: False})
        self.assertEqual(self.offers("Who told you we could do $7,000? That was an old promo."), {})
        self.assertEqual(self.offers("Where did you hear $7,000 would work?"), {})
        self.assertEqual(self.offers("Can I ask where you heard $7,000?"), {})
        self.assertEqual(set(self.offers("What if I do $8,000 for you?")), {8000})

    def test_an_offer_phrased_as_a_question_is_an_offer(self):
        """R1-Q round 2 (review 3): round 1 accepted only a fixed list of question frames, so these
        real offers vanished and the learner asked "so what would the final price be?" straight
        after the advisor named a price."""
        for text, expected in (
            ("How does $8,500 sound?", {8500: False}),
            ("What do you say to $8,000?", {8000: False}),
            ("$8,000, how does that sound?", {8000: False}),
            ("If I give you a $1,000 discount, will you join today?", {8000: True}),
            ("If I gave you $1,000 off, would you enroll today?", {8000: True}),
            ("What would you say if I give you $1,000 off?", {8000: True}),
            ("Can we close at $8,000 today?", {8000: True}),
            ("Is $8,000 something you can manage?", {8000: False}),
            ("So $8,500 with the early bird, deal?", {8500: True}),
            ("What if I bring it down to $8,000?", {8000: True}),
            ("Would you join at $8,200?", {8200: False}),
            ("Does $8,300 work for you?", {8300: False}),
        ):
            with self.subTest(text=text):
                self.assertEqual(self.offers(text), expected, text)

    def test_the_anchor_phrased_as_an_offer_question_is_an_offer(self):
        for text in (
            "How does $7,000 sound?",
            "What do you say to $7,000?",
            "Can we close at $7,000 today?",
            "Is $7,000 something you can manage?",
            "$7,000, how does that sound?",
            "Would you join at $7,000?",
        ):
            with self.subTest(text=text):
                self.assertEqual(set(self.offers(text)), {7000}, text)

    def test_a_question_about_where_a_figure_came_from_offers_no_figure(self):
        """The round 1 blocker stays fixed, for the anchor and for any other figure."""
        for text in (
            "Who told you $7,000?",
            "Where did you hear $8,000?",
            "Where did you read that $7,000 would work?",
            "How did you get $7,000?",
            "Are you sure about $8,500?",
            "Did someone tell you $7,500?",
            "What is your budget, $6,000?",
            "Is your budget around $6,000?",
            "Why do you think $7,000 is a fair price?",
            "What makes you say $7,000?",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.offers(text), {}, text)

    def test_a_question_about_the_budget_is_not_an_offer_but_fitting_it_is(self):
        self.assertEqual(self.offers("Would $8,500 fit your budget?"), {8500: False})
        self.assertEqual(self.offers("Does $8,000 work with your budget?"), {8000: False})
        self.assertEqual(self.offers("How much can you spend, maybe $6,000?"), {})
        self.assertEqual(self.offers("Were you thinking $6,500?"), {})

    def test_the_price_students_pay_now_is_the_price_but_what_they_paid_is_history(self):
        self.assertEqual(self.offers("Students pay $8,500 and get everything."), {8500: False})
        self.assertEqual(self.offers("Students paid $8,000 last year."), {})

    def test_a_plain_acceptance_of_the_anchor_is_an_offer(self):
        """R1-Q round 2: "Yes, you can have it for $7,000" and the like were invisible after round 1
        because only "I can do ..." counted as a promise."""
        for text, expected in (
            ("Yes, you can have it for $7,000.", {7000: False}),
            ("Sure, it's yours for $7,000.", {7000: False}),
            ("Okay, I'll match that, $7,000.", {7000: False}),
            ("Fine, you get it at $7,000 if you enroll today.", {7000: True}),
            ("For you, $7,000.", {7000: False}),
            ("Alright, you got it, $7,000.", {7000: False}),
            ("Okay, $7,000.", {7000: False}),
            ("Alright, $7,000 works for us.", {7000: False}),
            ("Deal, $7,000.", {7000: False}),
            ("We can take it at $7,000.", {7000: False}),
        ):
            with self.subTest(text=text):
                self.assertEqual(self.offers(text), expected, text)

    def test_a_refused_anchor_is_still_not_an_acceptance(self):
        for text in (
            "Okay, $7,000 is not possible.",
            "Yes, you heard $7,000, but that was the old batch.",
            "Okay, I understand you want $7,000.",
            "Fine, but $7,000 is too low for us.",
            "I can do $8,500, but $7,000 is not something we do.",
            "Sure, $7,000 was last year's price.",
            "Okay, you said $7,000, and I can't do that.",
        ):
            with self.subTest(text=text):
                self.assertNotIn(7000, self.offers(text), text)
        self.assertEqual(self.offers("I can do $8,500, but $7,000 is not something we do."),
                         {8500: False})

    def test_an_income_a_competitor_or_what_someone_paid_is_not_an_offer(self):
        """R1-Q round 2: prices were tracked from the first mention, so these pitch figures became
        "an offer on the table"."""
        for text in (
            "After the program our alumni typically see a salary hike of about $8,000 a year.",
            "You could earn $5,000 more per month as a data scientist.",
            "Compared with a $6,000 bootcamp, we give you much more.",
            "Last year one student paid $7,500 with the scholarship.",
            "Graduates start at $8,000 monthly.",
            "A data scientist makes about $8,000 a month in the US.",
            "Other bootcamps charge $8,500 and give you less.",
            "People paid $8,000 for the old batch.",
            "Your income could go up by $5,000 a year.",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.offers(text), {}, text)
                self.assertEqual(dict(neg.parse_price_offers(text, require_cue=True)), {}, text)
        # ... and the same sentence next to a real offer leaves the offer alone.
        self.assertEqual(
            self.offers("Alumni earn $8,000 more a year, and I can do $8,500 for you today."),
            {8500: True},
        )

    def test_before_the_anchor_an_amount_needs_a_pricing_word(self):
        def pre(text):
            return dict(neg.parse_price_offers(text, require_cue=True))

        self.assertEqual(pre("A mentor session alone is worth $500."), {})
        self.assertEqual(pre("Our placement team has helped students reach $8,000 roles."), {})
        self.assertEqual(pre("The capstone is $8,500 of real work."), {})
        self.assertEqual(pre("I can do $2,000 off for you today."), {7000: True})
        self.assertEqual(pre("The program is $9,000 with an early bird discount of $1,500."),
                         {7500: True})  # "early" bird: conditional
        self.assertEqual(pre("Let's make it $8,500."), {8500: False})
        # After the anchor the learner has asked for a price, so a bare answer is an answer.
        self.assertEqual(dict(neg.parse_price_offers("Okay, $8,500.")), {8500: False})

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

    def test_pitch_figures_before_the_anchor_are_never_an_offer_on_the_table(self):
        """R1-Q round 2 (review 3): a salary figure in the pitch became "an offer", the learner's
        anchor then claimed "the advisor has already come down to $8,000", and $5,000 made it
        "pleased"."""
        state = self.state()
        for turn, text in enumerate((
            "After the program our alumni typically see a salary hike of about $8,000 a year.",
            "You could earn $5,000 more per month as a data scientist.",
            "Compared with a $6,000 bootcamp, we give you much more.",
            "Last year one student paid $7,500 with the scholarship.",
            "Our placement team has helped students reach $8,000 roles.",
        ), start=1):
            seen = state.observe(turn, text, anchor_turn=None)
            self.assertEqual(seen.offers, (), text)
        self.assertEqual(state.offers, [])
        self.assertIsNone(state.best_offer_usd)
        # A real offer next to the pitch still lands, before and after the anchor.
        real = state.observe(6, "I can do $500 off, so $8,500 for you.", anchor_turn=None)
        self.assertEqual([o.net_usd for o in real.offers], [8500])

    def test_a_bare_amount_after_the_anchor_still_answers_it(self):
        state = self.state()
        seen = state.observe(3, "Okay, $8,500.", anchor_turn=2)
        self.assertTrue(seen.price_answer)
        self.assertEqual(state.best_offer_usd, 8500)
        state2 = self.state()
        again = state2.observe(3, "Okay, $8,500.", anchor_turn=None)
        self.assertFalse(again.offer_added)  # before any anchor a bare number is not a price

    def test_an_offer_phrased_as_a_question_answers_the_anchor(self):
        for text, net in (
            ("How does $8,500 sound?", 8500),
            ("What do you say to $8,000?", 8000),
            ("Can we close at $8,000 today?", 8000),
            ("If I give you a $1,000 discount, will you join today?", 8000),
            ("Yes, you can have it for $7,000.", 7000),
            ("Okay, I'll match that, $7,000.", 7000),
        ):
            with self.subTest(text=text):
                state = self.state()
                seen = state.observe(3, text, anchor_turn=2)
                self.assertTrue(seen.price_answer, text)
                self.assertEqual(state.best_offer_usd, net)
                self.assertNotEqual(state.price_situation(), neg.SITUATION_UNCLEAR)

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
            for text in neg.N_QUESTION_ENROL_VARIANTS:
                yield rendered, neg.question_spec(AskKind.ENROL), text
            for item in neg.COUNTERS:
                for text in item.variants:
                    yield rendered, item, text

    def test_every_variant_passes_the_learner_guard_for_every_persona(self):
        seen = 0
        for rendered, spec, text in self.texts():
            # The counter variants ("that is closer to what I hoped") are spoken on the turn the
            # advisor lowered the price, so the price is fresh (R1-Q iteration 3).
            context = GuardContext(
                phase="roleplay", persona=rendered, mode="reply", fresh_price=True
            )
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
        self.assertNotIn('"', neg.N_QUESTION_ENROL_BRIEF)
        self.assertNotRegex(neg.N_QUESTION_ENROL_BRIEF, r"\d")

    def test_specs_are_found_by_id_and_by_reason(self):
        self.assertEqual(neg.SPEC_BY_ID[neg.N_EMAIL].kind, neg.KIND_EMAIL)
        self.assertEqual(neg.SPEC_BY_REASON[neg.REASON_MONEY].id, neg.N_MONEY)
        self.assertEqual(set(neg.SPEC_BY_REASON), set(neg.REASONS))

    def test_the_question_names_the_call_only_after_a_call_ask(self):
        """Owner test 7f2a25e6 turn 31-32: "Let's lock in the deal" (an enrolment ask) got "What
        exactly would that call involve?" though nobody had proposed a call."""
        call = neg.question_spec(AskKind.CALL)
        self.assertIs(call, neg.SPEC_BY_ID[neg.N_QUESTION])
        self.assertIn("call", call.brief)
        for ask in (AskKind.ENROL, None):
            spec = neg.question_spec(ask)
            with self.subTest(ask=ask):
                self.assertEqual(spec.id, neg.N_QUESTION)
                self.assertEqual(spec.kind, neg.KIND_QUESTION)
                self.assertEqual(spec.markers, call.markers)  # note_spoken proves either wording
                for text in (spec.brief, *spec.variants):
                    self.assertNotRegex(text.lower(), r"\bcall\b|\bnext step")
                self.assertIn("signing up", spec.brief)
                self.assertIn("included", spec.brief)
                for text in spec.variants:
                    self.assertTrue(markers_match(spec.markers, text), text)
                    self.assertLessEqual(len(text.split()), 30)
        # The learner's own words on the owner's call prove the enrolment wording, so no scripted
        # question is appended to it; a reply without a question word still does not.
        state = neg.Negotiation("husband")
        self.assertTrue(state.note_spoken(
            neg.N_QUESTION, "What exactly would I be getting for it?", 32))
        self.assertTrue(state.question_used)
        for text in (
            "What does the program include?",
            "What would I actually be signing up for?",
        ):
            self.assertTrue(markers_match(call.markers, text), text)
        for text in (
            "I'm not locking anything in today.",
            "I'd get back to you.",
            # Reviewed fix: a bare "get" next to any wh-word proved the question without one.
            "I get what you're saying, but I need to think about it.",
            "What a deal. I'll get back to you.",
            "That's what I wanted to hear, I'll get my laptop.",
        ):
            self.assertFalse(markers_match(call.markers, text), text)
        for text in ("What do I get for that?", "So what am I getting for the money?"):
            self.assertTrue(markers_match(call.markers, text), text)


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

    def test_every_figure_the_learner_must_write_is_in_every_variant_of_every_situation(self):
        """R1-Q round 2: the reached anchor named an amount below $7,000 in ``must_say`` but none
        of its three scripted variants contained it."""
        for offer in self.OFFERS:
            situation = neg.anchor_after_offer(offer)
            self.assertEqual(len(situation.variants), 3)
            for text in situation.variants:
                for figure in situation.must_say:
                    with self.subTest(offer=offer, figure=figure, text=text):
                        self.assertIn(figure, text)
        self.assertEqual(neg.anchor_after_offer(7000).must_say, ("$7,000",))
        self.assertEqual(neg.anchor_after_offer(6500).must_say, ("$6,500", "$7,000"))

    def test_the_unclear_low_anchor_raises_the_move_and_passes_the_guard(self):
        """Owner test 8f5bfefc: a figure under $7,000 that was not read as a price gets a
        reaction to it ("what would the total be?"), still with the anchor's $7,000 marker."""
        markers = MOVE_BY_ID["F1-ANCHOR"].markers
        for amount in (1000, 1500, 3000, 6500):
            situation = neg.anchor_after_unclear_low(amount)
            self.assertEqual(situation.id, neg.ANCHOR_UNCLEAR)
            self.assertEqual(len(situation.variants), 3)
            for text in situation.variants:
                with self.subTest(amount=amount, text=text):
                    self.assertTrue(markers_match(markers, text))
                    for figure in situation.must_say:
                        self.assertIn(figure, text)
                    self.assertLessEqual(classify_learner_commitment(text), Level.WEAK)
                    self.assertFalse(has_concession(text))
        for rendered in variants():
            context = GuardContext(
                phase="roleplay", persona=rendered, mode="reply", advisor_amounts=frozenset({3000})
            )  # the engine adds the figure the advisor named (``_observe_negotiation``)
            for text in neg.anchor_after_unclear_low(3000).variants:
                for sentence in split_sentences(text):
                    hits = check_sentence(sentence, context)
                    self.assertEqual(hits, [], f"{rendered.id}: {sentence!r} -> {hits}")

    def test_a_reached_anchor_never_asks_the_final_price_question(self):
        """R1-Q round 2: the anchor ("is that really the final price?") and the "met" counter
        that follows it ("is this the final price?") were the same question, voiced back to back
        with no new advisor price in between.  The counter owns that question."""
        asks_final = re.compile(
            r"(?i)final (?:price|number)|best (?:price|you can)|last price|lowest"
        )
        for offer in (7000, 6800, 6500, 5000):
            situation = neg.anchor_after_offer(offer)
            self.assertIn("you do not ask whether it is the final price", situation.brief)
            for text in situation.variants:
                with self.subTest(offer=offer, text=text):
                    self.assertNotRegex(text, asks_final)
        for item in neg.COUNTERS:
            if item.id == neg.SITUATION_MET:
                self.assertTrue(all(asks_final.search(text) for text in item.variants))

    def test_no_variant_accepts_commits_concedes_or_carries_a_locked_need(self):
        for rendered in variants():
            for offer in self.OFFERS:
                situation = neg.anchor_after_offer(offer)
                context = GuardContext(
                    phase="roleplay", persona=rendered, mode="reply",
                    advisor_amounts=frozenset({offer}), offer_usd=offer,
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


class AdvisorTurnReadingsIterationOneTests(unittest.TestCase):
    """R1-Q iteration 1: three more things the learner reads in an advisor turn -- a hedge that
    grants nothing, a question about who else decides, and a mention of the $7,000 anchor."""

    TENTATIVE = (
        "I can check with my manager about a discount for you.",
        "Let me see what I can do on the price.",
        "I'll try to get you a better price, but I can't promise anything.",
        "No promises, but I might be able to bring the fee down.",
        "Let me talk to my supervisor and see if there is a lower price.",
        "I'll do my best on the price.",
    )
    NOT_TENTATIVE = (
        "Let me check the start date for you.",
        "I can check which cohort is next.",
        "Let me see, the next cohort starts in March.",
        "The price is $9,000 and we have a payment plan.",
        "I can do $8,000 for you today.",
        "That sounds like a good plan.",
    )
    DECIDER = (
        "Is anyone else involved in the decision?",
        "Who else would be part of this decision?",
        "Would you want to talk it over with your husband?",
        "Do you need to check with anyone before you decide?",
        "Are you the only decision maker here?",
        "Does your father get a say in this?",
        "Will your partner be involved in the decision?",
        "Would you decide this together with your wife?",
        "Do you discuss things like this with anyone else?",
    )
    NOT_DECIDER = (
        "We can enrol you tomorrow.",
        "Our decision is to keep the batch small.",
        "That is a big decision, and I respect that.",
        "Who else from your team has joined the program?",
        "Is anyone else in your family in data science?",
        "How do you feel about the schedule?",
        "I decided to become an advisor years ago.",
    )
    ANCHOR = (
        "Who told you seven thousand dollars?",
        "So you are looking at $7,000.",
        "$7,000 is not something I can promise.",
        "You said 7000. Let me see what is possible.",
        "I can't do 7k, sorry.",
    )
    NOT_ANCHOR = (
        "The price is $9,000.",
        "We have about 7,000 students across 18 domains.",
        "It is 7,000 people who attended the webinar.",
        "I can do $8,500 for you.",
        "The program is six months.",
    )

    def test_a_hedge_about_the_price_is_tentative(self):
        for text in self.TENTATIVE:
            with self.subTest(text=text):
                self.assertTrue(neg.detect_tentative(text))
        for text in self.NOT_TENTATIVE:
            with self.subTest(text=text):
                self.assertFalse(neg.detect_tentative(text))

    def test_asking_who_else_decides(self):
        for text in self.DECIDER:
            with self.subTest(text=text):
                self.assertTrue(neg.asks_decider(text))
        for text in self.NOT_DECIDER:
            with self.subTest(text=text):
                self.assertFalse(neg.asks_decider(text))

    def test_a_statement_about_a_decision_maker_is_not_a_question_to_the_learner(self):
        self.assertFalse(neg.asks_decider("The decision maker for discounts is my manager."))
        self.assertFalse(neg.asks_decider("You will talk it over with your husband and then we decide."))

    def test_naming_the_anchor(self):
        for text in self.ANCHOR:
            with self.subTest(text=text):
                self.assertTrue(neg.mentions_anchor(text))
        for text in self.NOT_ANCHOR:
            with self.subTest(text=text):
                self.assertFalse(neg.mentions_anchor(text))

    def test_the_turn_carries_the_three_readings(self):
        state = neg.Negotiation("husband")
        seen = state.observe(5, "Who told you $7,000? Is anyone else involved in the decision?", anchor_turn=4)
        self.assertTrue(seen.anchor_mentioned)
        self.assertTrue(seen.decider_asked)
        self.assertFalse(seen.tentative)
        seen = state.observe(6, "I can check with my manager about a discount for you.", anchor_turn=4)
        self.assertTrue(seen.tentative)
        self.assertFalse(seen.anchor_mentioned)

    def test_the_anchor_is_only_named_after_the_learner_said_it(self):
        state = neg.Negotiation("husband")
        seen = state.observe(2, "Some people get $7,000 off the price.", anchor_turn=None)
        self.assertFalse(seen.anchor_mentioned)

    def test_a_turn_with_a_figure_or_a_refusal_is_no_hedge(self):
        state = neg.Negotiation("husband")
        seen = state.observe(5, "Let me check with my manager, but I can do $8,000 today.", anchor_turn=4)
        self.assertFalse(seen.tentative)
        self.assertTrue(seen.offers)
        refused = neg.Negotiation("husband").observe(
            6, "We can't go lower than that, I'm afraid.", anchor_turn=4
        )
        self.assertFalse(refused.tentative)

    def test_the_new_detectors_are_fast_on_hostile_text(self):
        hostile = (
            "let me check with my " * 3000,
            "i can try to see " * 3000,
            "who else " * 4000,
            ("is anyone else involved in " + "the " * 40) * 400,
            "7,000 " * 5000,
            "$" + "7" * 20000,
        )
        for text in hostile:
            with self.subTest(prefix=text[:20]):
                started = time.perf_counter()
                neg.detect_tentative(text)
                neg.asks_decider(text)
                neg.mentions_anchor(text)
                self.assertLess(time.perf_counter() - started, 3.0)

    def test_the_spoken_variants_carry_no_tic_words(self):
        from r1_text import TIC_PATTERNS

        texts = [variant for spec in neg.SPECS for variant in spec.variants]
        for counter in neg.COUNTERS:
            texts.extend(counter.variants)
        for offer in (6000, 7000, 8500):
            texts.extend(neg.anchor_after_offer(offer).variants)
        for text in texts:
            for tic, pattern in TIC_PATTERNS.items():
                with self.subTest(text=text, tic=tic):
                    self.assertIsNone(pattern.search(text))


class IterationTwoNegotiationTests(unittest.TestCase):
    """R1-Q iteration 2: declined calls, the slot of the MEDIUM line, the form question and the
    wording of the price reactions (D5, D6, D7, D8, D11, D15)."""

    def test_a_declined_call_is_recognised_in_the_learners_own_words(self):
        for text in (
            "I'd rather keep it to email for now.",
            "I haven't agreed to any date yet.",
            "I'd prefer email, if that's okay.",
            "I'll reply to you there.",
            "No calls for now, please.",
            "I'm not comfortable with a call yet.",
            "Let's keep this over text.",
        ):
            with self.subTest(text=text):
                self.assertTrue(neg.declines_call(text), text)
        for text in (
            "Sure, you can email me the details.",
            "What would the call cover?",
            "Let me check with my husband first, and then let's book a call, so we can decide.",
            "Let me think about it. Call me back after I've talked to my father, and I'll let you know.",
            "",
        ):
            with self.subTest(text=text):
                self.assertFalse(neg.declines_call(text), text)

    def test_a_slot_without_a_clock_time_or_a_part_of_the_day_is_vague(self):
        for text, vague in (
            ("I can try you sometime next week.", True),
            ("Let me know when's good.", True),
            ("Does Thursday work?", False),
            ("Would tomorrow evening work?", False),
            ("How about 10 AM?", False),
            ("Can we do this weekend?", False),
        ):
            slot = neg.parse_slot(text)
            with self.subTest(text=text):
                self.assertEqual(slot is None or slot.vague, vague, slot)

    def test_a_vague_slot_is_booked_without_a_time_only_after_the_decision_maker_was_mentioned(self):
        n = neg.Negotiation("partner")
        n.observe(
            3,
            "No problem at all, take your time with your partner and we'll find a time that "
            "works. Just let me know when's good, or I can try you sometime next week.",
        )
        self.assertTrue(n.last_slot.vague)
        self.assertFalse(n.slot_choice(4).deferred)  # nothing said about the partner yet
        n.note_learner_text("Before I commit to any timing, I'd need to talk it over with my partner.", 3)
        self.assertEqual(n.decider_said_turn, 3)
        choice = n.slot_choice(4)
        self.assertTrue(choice.deferred)
        self.assertEqual(n.log()["slot_deferred"], True)
        # The memory fades: three turns on, the learner picks a time again.
        self.assertFalse(n.slot_choice(3 + neg.DEFER_RECENT_TURNS + 1).deferred)

    def test_a_named_time_is_never_deferred(self):
        n = neg.Negotiation("husband")
        n.note_reason_voiced(neg.REASON_DECISION_MAKER, 5)
        n.observe(6, "Would tomorrow evening work for a quick call?")
        choice = n.slot_choice(7)
        self.assertFalse(choice.deferred)
        self.assertEqual(choice.phrase, "tomorrow in the evening")

    def test_the_form_question_is_no_email_offer_but_a_statement_still_is(self):
        form = (
            "The next step is just a two-minute enrollment form, then you're in. I'll do $600 a "
            "month, $6000 total, but only if you submit tonight. Can I send it right now?"
        )
        self.assertFalse(neg.detect_email_offer(form))
        self.assertTrue(neg.detect_email_offer("I'll send it over right after this call."))
        self.assertTrue(neg.detect_email_offer("I'll email you the form. Can I send it now?"))
        self.assertTrue(neg.detect_email_offer("Curriculum, deposit details and the deadline. I'll send it right now."))

    def test_the_counter_never_calls_the_same_price_better_or_a_stretch(self):
        short = neg.COUNTER_BY_SITUATION[neg.SITUATION_SHORT]
        for text in (short.brief, *short.variants):
            self.assertNotIn("stretch", text.lower())
        self.assertIn("do not call it better unless it just dropped", short.brief)
        self.assertNotIn("better", " ".join(short.variants).replace("a little better", "").replace("better than that", ""))

    def test_the_reached_anchor_is_calm_and_two_variants_are_statements(self):
        for offer in (7000, 6500):
            situation = neg.anchor_after_offer(offer)
            self.assertIn("no surprise and no thanks", situation.brief)
            self.assertNotIn("pleased", situation.brief)
            for variant in situation.variants:
                self.assertIn("$7,000", variant)
                self.assertNotRegex(variant, r"\b(?:oh|great|wonderful|relief|surprise\w*)\b")
            statements = [v for v in situation.variants if "?" not in v]
            self.assertEqual(len(statements), 2)

    def test_the_anchor_brief_tells_the_advisor_it_does_not_say_you(self):
        from r1_scheduler import SPEC_BY_ID

        brief = SPEC_BY_ID["F1-ANCHOR"].brief
        self.assertTrue(brief.startswith("tell the advisor that $9,000"))
        self.assertNotIn("you say", brief)
        self.assertNotIn("you say", neg.anchor_after_offer(8500).brief)

    def test_the_new_log_key_is_json(self):
        n = neg.Negotiation("husband")
        json.dumps(n.log())
        self.assertIsNone(n.log()["slot_deferred"])


class IterationThreeNegotiationTests(unittest.TestCase):
    """R1-Q iteration 3 (the third live sweep): slots, declined calls, cost priorities, e-mail."""

    # --- D1: only the advisor's proposed call time is a slot
    def test_a_time_the_advisor_sends_something_is_not_a_call_time(self):
        for text in (
            "Will do, I'll send those over today. So what do you think, should we pencil in a "
            "quick call in a few days once you've reviewed everything and talked it over at home?",
            "Perfect. I'll send it today. Since you two will be reviewing together, would it help "
            "to pencil in a short call later this week, maybe with your husband on it?",
            "I'll send you the summary today, you talk it over, and we pencil in a call with your "
            "partner for early next week.",
        ):
            with self.subTest(text=text):
                callback = neg.detect_callback(text)
                self.assertIsNotNone(callback)
                self.assertNotEqual(callback.slot.day, "today")
                self.assertTrue(callback.slot.vague, callback.slot)

    def test_loose_days_are_normalised(self):
        for text, day in (
            ("a quick call in a few days", "a few days"),
            ("a call later this week", "this week"),
            ("a call early next week", "next week"),
            ("a call in a couple of days", "a few days"),
        ):
            with self.subTest(text=text):
                self.assertEqual(neg.parse_slot(text).day, day)

    def test_the_day_after_tomorrow_is_not_tomorrow(self):
        slot = neg.parse_slot("I'll call you the day after tomorrow at this same time.")
        self.assertEqual(slot.day, neg.DAY_AFTER_TOMORROW)
        choice = neg.choose_slot(slot)
        self.assertEqual(choice.phrase, "the day after tomorrow at 7 PM")
        self.assertEqual(neg.parse_slot("I'll call you tomorrow.").day, "tomorrow")

    def test_a_call_time_before_a_delivery_word_still_counts(self):
        slot = neg.parse_slot("I'll call you tomorrow evening and send the details after.")
        self.assertEqual((slot.day, slot.part), ("tomorrow", "evening"))
        self.assertIsNone(neg.parse_slot("I'll email you the curriculum tonight."))
        self.assertEqual(
            neg.parse_slot("I'll send you the details today, and call you on Friday at 6 pm.").day,
            "friday",
        )

    def test_loose_days_make_loose_medium_slots(self):
        self.assertEqual(neg.choose_slot(neg.parse_slot("later this week")).phrase,
                         "later this week at 7 PM")
        self.assertEqual(neg.choose_slot(neg.parse_slot("in a few days")).phrase,
                         "in a few days at 7 PM")

    # --- D1: a declined call, a refused slot, a stale slot
    def test_firm_declines_of_a_call_hold_and_pauses_do_not(self):
        for text in (
            "Tomorrow evening's tricky for me, I'd rather reach out when I've made up my mind.",
            "I'd rather reach out myself once we've had a chance to go through it.",
            "I can't really pin down a time. I'll reach out once I've talked, rather than you calling me.",
            "I'd rather you didn't. If I decide anything, I'll reach out myself.",
            "I'd rather not have a check-in hanging over me.",
            "No need to call, I'll get back to you.",
        ):
            with self.subTest(text=text):
                self.assertTrue(neg.declines_call(text), text)
        for text in (
            "I'm not going to lock in a day right now, though.",
            "I'd rather not lock in a time yet.",
            "I'll reach out if I decide to move forward.",
            "I'll let you know either way.",
            "Let me talk to my father first and get back to you.",
            "Evenings usually work, but I'd rather think it over.",
        ):
            with self.subTest(text=text):
                self.assertFalse(neg.declines_call(text), text)

    def test_the_state_remembers_a_firm_decline_for_the_rest_of_the_call(self):
        n = neg.Negotiation("husband")
        self.assertFalse(n.call_declined())
        n.note_learner_text("I'd rather not lock in a time yet.", 5)
        self.assertFalse(n.call_declined())
        n.note_learner_text("I'd rather reach out myself.", 6)
        self.assertTrue(n.call_declined())
        self.assertEqual(n.log()["call_declined_turn"], 6)
        n.note_learner_text("Sounds good.", 30)
        self.assertTrue(n.call_declined())

    def test_a_day_the_learner_called_difficult_is_never_booked(self):
        n = neg.Negotiation("husband")
        n.observe(3, "How about I call you tomorrow evening, say around seven?")
        self.assertEqual(n.slot_choice(4).phrase, "tomorrow in the evening")
        n.note_learner_text("Tomorrow evening's tricky for me.", 4)
        choice = n.slot_choice(5)
        self.assertTrue(choice.deferred)
        self.assertEqual(n.log()["refused_slots"], 1)
        n.observe(6, "No problem. Would Friday at 6 pm work?")
        later = n.slot_choice(7)
        self.assertFalse(later.deferred)
        self.assertEqual(later.phrase, "on Friday at 6 PM")

    def test_evenings_called_unpredictable_are_not_offered_either(self):
        n = neg.Negotiation("partner")
        n.note_learner_text("My evenings are unpredictable with lab work.", 3)
        self.assertTrue(n.slot_choice(4).deferred)  # not even the legacy 7 PM default

    def test_a_proposal_older_than_the_recent_turns_is_no_proposal(self):
        n = neg.Negotiation("husband")
        n.observe(3, "Would Thursday at 6 pm work for a call?")
        self.assertEqual(n.slot_choice(4).phrase, "on Thursday at 6 PM")
        stale = n.slot_choice(3 + neg.SLOT_RECENT_TURNS + 1)
        self.assertEqual(stale.phrase, DEFAULT_SLOT)

    def test_an_enrolment_ask_without_a_slot_is_booked_without_one(self):
        n = neg.Negotiation("husband")
        self.assertEqual(n.slot_choice(5).phrase, DEFAULT_SLOT)  # a call ask: the learner picks
        choice = n.slot_choice(5, picks_own=False)
        self.assertTrue(choice.deferred)
        line = commitment_line(Level.MEDIUM, "husband", choice.phrase, deferred=choice.deferred)
        self.assertNotRegex(line, r"Thursday|\d")

    # --- D2: the stall reason follows the learner's priority
    def test_cost_called_the_lesser_worry_is_remembered(self):
        for text in (
            "My worry is more about time than money.",
            "That's really what worries me more than the cost.",
            "It's not really the money.",
            "That part sits easier with me now.",
            "The cost isn't the main issue for me.",
        ):
            with self.subTest(text=text):
                self.assertTrue(neg.says_cost_is_secondary(text), text)
        for text in (
            "The cost is still my main worry.",
            "It's a lot of money to commit.",
            "I worry about the time, and the cost too.",
        ):
            with self.subTest(text=text):
                self.assertFalse(neg.says_cost_is_secondary(text), text)

    def test_money_is_settled_when_the_ask_was_met_or_cost_was_called_secondary(self):
        n = neg.Negotiation("husband")
        self.assertFalse(n.money_is_settled())
        n.note_learner_text("My worry is more about time than money.", 4)
        self.assertTrue(n.money_is_settled())
        met = neg.Negotiation("husband")
        met.observe(2, "I can do $6,500 for you.", anchor_turn=1)
        self.assertTrue(met.money_is_settled())

    # --- D5: only a lower price is news
    def test_a_price_that_is_not_lower_is_no_news(self):
        n = neg.Negotiation("husband")
        first = n.observe(2, "I can do $7,500 with the upfront discount.", anchor_turn=1)
        self.assertEqual(first.lower_offer_usd, 7500)
        again = n.observe(3, "Like I said, $7,500 is the lowest I can offer.", anchor_turn=1)
        self.assertIsNone(again.lower_offer_usd)
        worse = n.observe(4, "On instalments the discount is $1000, so $8,000 a month.", anchor_turn=1)
        self.assertIsNone(worse.lower_offer_usd)
        self.assertEqual(n.best_offer_usd, 7500)
        better = n.observe(5, "Okay, I can go to $7,200.", anchor_turn=1)
        self.assertEqual(better.lower_offer_usd, 7200)

    # --- D4: the anchor below the ask is not "in line with what you heard"
    def test_the_anchor_below_seven_thousand_says_below_not_in_line(self):
        below = neg.anchor_after_offer(4500)
        self.assertIn("below the $7,000", below.brief)
        self.assertNotIn("in line with what you heard", below.brief)
        for variant in below.variants:
            self.assertNotIn("in line", variant)
        at = neg.anchor_after_offer(7000)
        self.assertIn("in line with what you heard", at.brief)

    # --- D6: the e-mail yes asks nothing when the contents were listed
    def test_an_email_offer_that_lists_its_contents_is_answered_with_a_yes_only(self):
        listed = (
            "Sure, I'll send the full curriculum breakdown, pricing, discount options and "
            "details on the mentorship. Everything you'd need to review together."
        )
        bare = "Would it help if I sent you some info you could share with him?"
        self.assertTrue(neg.lists_email_contents(listed))
        self.assertFalse(neg.lists_email_contents(bare))
        n = neg.Negotiation("husband")
        seen = n.observe(4, "I'll email you the curriculum, the pricing and the payment plan options.")
        self.assertTrue(seen.email_offer and seen.email_listed)
        self.assertFalse(n.observe(5, bare).email_listed)
        yes = neg.SPEC_BY_ID[neg.N_EMAIL_YES]
        for text in yes.variants:
            self.assertNotIn("?", text)

    def test_the_email_yes_is_proven_by_the_yes_alone(self):
        spec = neg.SPEC_BY_ID[neg.N_EMAIL]
        markers = neg.filled_markers(spec.markers, "husband")
        from r1_scheduler import markers_match as matches

        self.assertTrue(matches(markers, "Sure, go ahead and send the email, that works for me."))
        self.assertTrue(matches(markers, "Sure, you can email me. What will the email include?"))
        self.assertFalse(matches(markers, "I'd rather think it over."))


class FinalReviewRoundOneNegotiationTests(unittest.TestCase):
    """R1-Q final review round 1: the price ledger, the anchor and the STRONG gate."""

    def offers(self, text, own=(), require_cue=False):
        from r1_negotiation import parse_price_offers

        return dict(parse_price_offers(text, own, require_cue=require_cue))

    # --- a described discount is not an offer; a bound is not a price
    def test_a_discount_described_with_up_to_is_not_an_offer(self):
        for text in (
            "We have discounts up to $1,500.",
            "Some people qualify for up to $1,500 off.",
            "There are discounts of up to $1500 depending on the plan.",
            "Our discounts go as high as fifteen hundred dollars.",
            "Learners may qualify for up to 20% off.",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.offers(text), {}, text)

    def test_a_discount_the_advisor_offers_in_the_first_person_still_counts(self):
        self.assertEqual(self.offers("I can offer up to $1,500 off for you today."), {7500: True})
        self.assertEqual(self.offers("I can take $1,500 off."), {7500: False})

    def test_under_six_thousand_is_a_bound_not_the_price(self):
        for text in (
            "It's under six thousand with the extra five hundred.",
            "We can get it below $7,000 for you, I think.",
            "The total will be no more than $7,500.",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.offers(text), {}, text)

    # --- the anchor in the learner's shorthand, and counts that look like it
    def test_where_did_you_hear_seven_challenges_the_anchor(self):
        from r1_negotiation import refuses_price

        for text in (
            "Where did you hear seven?",
            "Who told you seven?",
            "That was an old promotion, it's not running anymore.",
            "That price was an early-bird, it ended last year.",
        ):
            with self.subTest(text=text):
                self.assertTrue(refuses_price(text), text)

    def test_seven_thousand_applications_is_not_the_anchor(self):
        from r1_negotiation import mentions_anchor, refuses_price

        for text in (
            "We had seven thousand applications last year.",
            "More than 7,000 learners have taken it.",
            "I can send you a sample project from last cohort.",
        ):
            with self.subTest(text=text):
                self.assertFalse(refuses_price(text), text)
                self.assertFalse(mentions_anchor(text), text)

    # --- money is settled by the best offer, whatever the advisor refused afterwards
    def test_money_is_settled_once_a_price_at_or_below_the_ask_was_offered(self):
        from r1_negotiation import SITUATION_REFUSED, Negotiation

        state = Negotiation("husband")
        # the advisor offered before the learner anchored and refused after it (the live sweep's p1)
        state.observe(2, "I can take thirty-five percent off, that is $5,850 for you.", anchor_turn=None)
        self.assertEqual(state.best_offer_usd, 5850)
        state.observe(4, "I'm sorry, I can't go lower than that.", anchor_turn=3)
        self.assertEqual(state.price_situation(), SITUATION_REFUSED)  # the refusal is the last word...
        self.assertTrue(state.money_is_settled())  # ...but the price is below the $7,000 ask
        other = Negotiation("husband")
        other.observe(2, "I can do $8,000 for you.", anchor_turn=1)
        self.assertFalse(other.money_is_settled())

    # --- STRONG needs a learner with nothing left to consult and nothing to wait for
    def test_a_wait_is_heard_in_the_learners_own_words(self):
        from r1_negotiation import says_will_wait

        for text in (
            "Waiting feels more realistic for me right now.",
            "I'll wait for the next cohort.",
            "I'm not ready to commit yet.",
            "I think I'd rather wait until after the holidays.",
        ):
            with self.subTest(text=text):
                self.assertTrue(says_will_wait(text), text)
        for text in ("I can't wait to see the curriculum.", "How long is the wait for a mentor?"):
            with self.subTest(text=text):
                self.assertFalse(says_will_wait(text), text)

    def test_the_decider_stall_is_resolved_only_by_an_answer_that_comes_after_it(self):
        from r1_negotiation import Negotiation

        state = Negotiation("husband")
        self.assertFalse(state.decider_unresolved())  # the learner never said it
        state.note_learner_text("I'd want to talk it over with my husband first.", 5)
        self.assertTrue(state.decider_unresolved())
        state.observe(5, "Your husband is welcome to join us on a call.", anchor_turn=None)
        self.assertTrue(state.decider_unresolved())  # said before the learner spoke: no answer
        state.observe(6, "Your husband is welcome to join us on a call.", anchor_turn=None)
        self.assertFalse(state.decider_unresolved())
        state.note_learner_text("I'd still talk it over with my husband first.", 7)
        self.assertTrue(state.decider_unresolved())  # it came back: not resolved again

    def test_strong_is_blocked_by_a_declined_call_a_recent_wait_or_an_open_decider(self):
        from r1_negotiation import Negotiation

        state = Negotiation("husband")
        self.assertIsNone(state.strong_blocked(10))
        state.note_learner_text("Waiting feels more realistic for me right now.", 8)
        self.assertEqual(state.strong_blocked(10), "learner_waiting")
        self.assertIsNone(state.strong_blocked(12))  # three turns later it no longer holds
        state.note_learner_text("I'd rather reach out myself, thanks.", 9)
        self.assertEqual(state.strong_blocked(12), "call_declined")
        fresh = Negotiation("husband")
        fresh.note_learner_text("I'd want to talk it over with my husband first.", 3)
        self.assertEqual(fresh.strong_blocked(9), "decider_unresolved")

    def test_the_owed_timing_stall_is_not_a_decision_to_wait(self):
        from r1_negotiation import Negotiation

        state = Negotiation("husband")
        state.note_learner_text("Maybe I'll join the next cohort.", 4, stall=True)
        self.assertIsNone(state.wait_said_turn)
        state.note_learner_text("Maybe I'll join the next cohort.", 5)
        self.assertEqual(state.wait_said_turn, 5)


if __name__ == "__main__":
    unittest.main()
