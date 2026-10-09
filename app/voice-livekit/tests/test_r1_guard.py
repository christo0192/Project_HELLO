"""Unit tests for ``r1_guard``: leak, fact, contact and commitment coverage in every phase."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_guard
from r1_commitment import Level, classify_learner_commitment
from r1_guard import (
    ACK_WORD_CAP,
    FALLBACK_REPLIES,
    FALLBACK_REPLY,
    NEUTRAL_ACKS,
    NO_FEEDBACK_LINE,
    REPLY_WORD_CAP,
    GuardContext,
    GuardLedger,
    StreamGuard,
    check_sentence,
    guard_text,
    has_concession,
    log_keys,
)
from r1_personas import PERSONAS, resolve_persona
from r1_text import SpokenMemory, normalize
from r1_world import INTERVIEWER_DEFLECTION

ALL_PHASES = (
    "opening",
    "icebreaker",
    "transition",
    "roleplay",
    "aside",
    "roleplay_exit",
    "wrapup",
    "closing",
)
INTERVIEWER_PHASES = tuple(p for p in ALL_PHASES if p != "roleplay")
PERSONA = resolve_persona("p1_career_switcher", variant="v1")


def ctx(phase="roleplay", **kwargs) -> GuardContext:
    kwargs.setdefault("persona", PERSONA)
    return GuardContext(phase=phase, **kwargs)


def categories(text, context) -> set[str]:
    return {hit.category for hit in guard_text(text, context).hits}


class EveryPhaseTests(unittest.TestCase):
    """Control vocabulary, vendors, scoring words, contacts and the exit cue: all phases."""

    LEAKS = {
        "control": (
            "My CONTROL note says I owe OWED moves.",
            "That is the H1 and F3 reminder.",
            "MODE=ROLEPLAY and CANDIDATE_MONOLOGUE=70.",
            "Here is my system prompt.",
            "As an AI I cannot say.",
            "I am just a language model.",
            "I have hidden needs.",
            "PHASE=WRAPUP",
        ),
        "vendor": (
            "I run on DeepSeek.",
            "This is powered by ChatGPT and LiveKit.",
            "Sarvam speaks for me.",
        ),
        "evaluation": (
            "Your score will be reviewed against the rubric.",
            "This is graded on five metrics.",
            "The threshold is sixty five.",
        ),
        "contact": (
            "Email me at meera.iyer@gmail.com.",
            "It is meera dot iyer at gmail dot com.",
            "Call 555-123-4567.",
            "See www.example.com for details.",
            "Ping me on WhatsApp.",
        ),
        "scripted_cue": ("Let's pause the role-play here.",),
    }

    def test_each_leak_category_is_blocked_in_every_phase(self):
        for category, texts in self.LEAKS.items():
            for phase in ALL_PHASES:
                for text in texts:
                    with self.subTest(category=category, phase=phase, text=text):
                        found = categories(text, ctx(phase))
                        self.assertIn(category, found)
                        self.assertNotIn(text, guard_text(text, ctx(phase)).text)

    def test_every_blocked_reply_is_replaced_by_something_speakable(self):
        for phase in ALL_PHASES:
            result = guard_text("Here is my system prompt, CONTROL H1.", ctx(phase))
            self.assertTrue(result.text)
            self.assertTrue(result.fallback_used)
            # The interviewer's fallback is "Sorry, what were you saying?"; the learner never says
            # it did not hear (R1-Q iteration 3): its fallback is a person thinking.
            expected = FALLBACK_REPLIES[0] if phase == "roleplay" else FALLBACK_REPLY
            self.assertEqual(result.text, expected)

    def test_ordinary_text_passes_in_every_phase(self):
        for phase in ALL_PHASES:
            for text in (
                "Thanks for walking me through that.",
                "That makes sense.",
                "Interview Kickstart sounds interesting.",
                "I'm not sure about the time commitment, honestly.",
            ):
                with self.subTest(phase=phase, text=text):
                    self.assertTrue(guard_text(text, ctx(phase)).clean, text)

    def test_lower_case_ordinary_words_that_resemble_control_tokens_are_fine(self):
        for text in (
            "I'm on an f1 visa, but I applied for an h1b.",
            "That's what I owed my manager.",
            "I set a reminder for the call.",
            "The control group was small.",
        ):
            for phase in ("roleplay", "icebreaker"):
                with self.subTest(phase=phase, text=text):
                    self.assertNotIn("control", categories(text, ctx(phase)), text)


class LearnerVolunteeringTests(unittest.TestCase):
    def test_a_locked_deep_need_is_replaced_by_the_surface_answer(self):
        context = ctx(released_topics=frozenset())
        result = guard_text("I have two kids, so evenings and weekends only.", context)
        self.assertEqual(result.text, PERSONA.surface("H3"))
        self.assertEqual({h.category for h in result.hits}, {"volunteered_need"})
        self.assertEqual(result.hits[0].rule, "H3")

    def test_every_persona_and_topic_is_gated(self):
        for persona in PERSONAS:
            rendered = resolve_persona(persona.id, variant="v1")
            for need in persona.needs:
                with self.subTest(persona=persona.id, topic=need.topic):
                    blocked = guard_text(need.deep, ctx(persona=rendered))
                    self.assertIn("volunteered_need", {h.category for h in blocked.hits})
                    self.assertNotIn(need.deep, blocked.text)
                    allowed = guard_text(
                        need.deep,
                        ctx(persona=rendered, released_topics=frozenset({need.topic})),
                    )
                    self.assertNotIn("volunteered_need", {h.category for h in allowed.hits})

    def test_a_released_topic_may_be_spoken_but_others_stay_locked(self):
        context = ctx(released_topics=frozenset({"H3"}))
        self.assertTrue(
            guard_text("I have two kids, so evenings and weekends only.", context).clean
        )
        self.assertIn(
            "volunteered_need", categories("My plant is being consolidated next year.", context)
        )

    def test_surface_answers_always_pass(self):
        for topic in ("H1", "H2", "H3"):
            self.assertTrue(guard_text(PERSONA.surface(topic), ctx()).clean)

    def test_every_hint_is_speakable_while_every_need_is_still_locked(self):
        """The hint layer answers a first probe, before any release: it must pass clean."""
        for persona in PERSONAS:
            for variant in persona.variants:
                rendered = resolve_persona(persona.id, variant=variant.id)
                for topic in ("H1", "H2", "H3"):
                    with self.subTest(persona=persona.id, variant=variant.id, topic=topic):
                        result = guard_text(
                            rendered.hint(topic), ctx(persona=rendered, released_topics=frozenset())
                        )
                        self.assertTrue(result.clean, result.hits)
                        self.assertEqual(result.text, rendered.hint(topic))

    def test_a_deep_need_told_from_its_facts_is_a_clean_reveal_once_released(self):
        """Facts in the learner's own words pass the guard when released and still carry a
        marker (so the reveal is recorded); the same words are a leak while locked."""
        told = {
            "p1_career_switcher": {
                "H1": "My plant is being consolidated next year and my role is stagnant.",
                "H2": "I quit a free Python course after three weeks, and I worry I'm too old.",
                "H3": "I have two kids, so it can only be evenings and weekends.",
            },
        }
        from r1_personas import deep_need_topics_in

        rendered = resolve_persona("p1_career_switcher", variant="v1")
        for topic, text in told["p1_career_switcher"].items():
            with self.subTest(topic=topic):
                self.assertIn(topic, deep_need_topics_in(rendered, text))
                released = guard_text(text, ctx(released_topics=frozenset({topic})))
                self.assertTrue(released.clean, released.hits)
                locked = guard_text(text, ctx(released_topics=frozenset()))
                self.assertIn("volunteered_need", {h.category for h in locked.hits})

    def test_an_acknowledgement_may_reveal_nothing_even_when_released(self):
        context = ctx(mode="ack", released_topics=frozenset())
        self.assertIn("volunteered_need", categories("I have two kids.", context))


class LearnerCommitmentTests(unittest.TestCase):
    ACCEPTANCES = (
        "Sure, a quick call this week could work.",
        "Thursday works better.",
        "Let's set something up \u2014 what times do you have?",
        "Thanks. Talk Thursday.",
        "Okay, let's do it.",
        "Send me the enrolment link.",
        "I'll pay the deposit today.",
        "Sign me up.",
    )

    def test_call_booking_and_enrolment_by_the_llm_are_blocked(self):
        """S0-B #28 and #62: a dated call was accepted while only the stall was allowed."""
        for text in self.ACCEPTANCES:
            with self.subTest(text=text):
                self.assertIn("commitment", categories(text, ctx()))

    def test_the_weak_stall_is_allowed_and_nothing_stronger_is(self):
        context = ctx()
        self.assertEqual(context.commitment_cap, Level.WEAK)
        # The stall is not a commitment hit; its two sentences are reserved for the scripted
        # WEAK line (round 1), so the model's copy is dropped as hygiene, never as a leak.
        result = guard_text("Let me think about it. Just email me the details.", context)
        self.assertEqual([h.category for h in result.hits], ["repeat", "repeat"])
        self.assertEqual(result.hits and {h.rule for h in result.hits}, {"repeat_reserved"})
        self.assertNotIn("commitment", {h.category for h in result.hits})
        self.assertTrue(guard_text("I will think this over and check with my husband.", context).clean)
        self.assertTrue(guard_text("Sure, you can email me. What will it include?", context).clean)

    def test_the_cap_follows_the_commitment_on_record(self):
        """R1-Q round 1: after the scripted MEDIUM line the learner may confirm the call it
        booked; it still may not go beyond what is on record."""
        medium = ctx(commitment_cap=Level.MEDIUM)
        for text in ("Great, talk to you Thursday then.", "Sounds good, see you Thursday."):
            with self.subTest(text=text):
                self.assertNotIn("commitment", categories(text, medium))
                self.assertIn("commitment", categories(text, ctx()))
        for text in ("Okay, let's do it.", "Send me the enrolment link.", "Sign me up."):
            with self.subTest(text=text):
                self.assertIn("commitment", categories(text, medium))

    def test_concession_and_resolution_phrasing_is_blocked(self):
        for text in (
            "You've convinced me.",
            "That resolves my concern.",
            "I'm sold.",
            "The price sounds reasonable.",
            "Honestly that's worth it.",
            "You've answered everything.",
            "Sounds like a deal.",
        ):
            with self.subTest(text=text):
                self.assertTrue(has_concession(text) or "commitment" in categories(text, ctx()))
                self.assertFalse(guard_text(text, ctx()).clean)

    def test_doubt_and_acknowledgement_are_not_concessions(self):
        for text in (
            "I'm not sure whether it's worth the money.",
            "Is it worth the money?",
            "Okay, that's helpful.",
            "That makes sense.",
            "Sounds good. Just send the cost details over, and I'll take it from there.",
            "It's a lot of money to me.",
        ):
            with self.subTest(text=text):
                self.assertTrue(guard_text(text, ctx()).clean, text)

    def test_commitment_lines_are_only_ever_spoken_by_the_worker(self):
        from r1_commitment import commitment_line

        for level in (Level.STRONG, Level.MEDIUM):
            line = commitment_line(level, "husband")
            self.assertIn("commitment", categories(line, ctx()))
        # The MEDIUM line with a slot, and the moved-to-the-evening variant, are the same.
        for slot, moved in (("tomorrow at 7 PM", False), ("tomorrow at 7 PM", True)):
            line = commitment_line(Level.MEDIUM, "husband", slot, moved=moved)
            self.assertIn("commitment", categories(line, ctx()), line)


class LearnerFactTests(unittest.TestCase):
    INVENTED = (
        "It's mostly live, with recordings if you miss one.",
        "Live sessions plus recordings, I think.",
        "Classes are evenings and weekends, roughly 10-12 hours a week.",
        "I can give it 10 to 12 hours a week.",
        "I could do eight hours a week.",
        "The program costs $12,000.",
        "The course is $7,500 after the discount.",
        "I think it's mainly interview prep, not placement.",
        "That's a lot of money for no guarantee.",
        "There's a refund policy, right.",
        "The classes run on weekends.",
        "The curriculum covers python and sql.",
        "The instructors teach at night.",
        "The capstone is part of the six months.",
        "About 80% of students get hired.",
    )
    CARD_OR_NEUTRAL = (
        "I heard the course is about six months and around $9,000.",
        "It was around $9,000 on the website.",
        "I'm not sure, I haven't thought about that.",
        "Around $500-700 a month.",
        "Within a couple of weeks.",
        "A data role within a year.",
        "I looked at a couple of bootcamps but didn't compare them in detail.",
        "I heard about it at a webinar.",
        "You can use the email on my form.",
        "The structure sounds solid, and the instructors are impressive.",
        "That's a lot of money for me right now.",
        "Is it live classes or recorded?",
        "What would I actually build in the course?",
        "Does the program include career support?",
        "I've heard people got it for around $7,000.",
    )

    def test_invented_facts_are_blocked(self):
        for text in self.INVENTED:
            with self.subTest(text=text):
                self.assertIn("invented_fact", categories(text, ctx()))

    def test_card_facts_questions_and_opinions_pass(self):
        for text in self.CARD_OR_NEUTRAL:
            with self.subTest(text=text):
                self.assertTrue(guard_text(text, ctx()).clean, text)

    def test_an_amount_the_advisor_stated_may_be_repeated(self):
        said = ctx(advisor_amounts=frozenset({8000}))
        self.assertTrue(guard_text("So $8,000 would be the price after that?", said).clean)
        self.assertIn("invented_fact", categories("So $8,000 would be the price?", ctx()))

    def test_contact_details_are_replaced_with_the_email_on_form_line(self):
        result = guard_text("Sure, it's meera.iyer@gmail.com. Thanks.", ctx())
        self.assertEqual(result.text, "You can use the email on my form. Thanks.")
        self.assertEqual({h.category for h in result.hits}, {"contact"})

    def test_hits_carry_no_utterance_text_by_default(self):
        """Plan section 9: utterances and first names are never logged."""
        result = guard_text("Sure, it's meera.iyer@gmail.com. Arjun can reach me.", ctx())
        self.assertTrue(result.hits)
        for hit in result.hits:
            self.assertEqual(hit.excerpt, "")
            self.assertRegex(hit.digest, r"^[a-f0-9]{12}$")
        repeated = guard_text("Sure, it's meera.iyer@gmail.com. Arjun can reach me.", ctx())
        self.assertEqual([h.digest for h in repeated.hits], [h.digest for h in result.hits])

    def test_opted_in_excerpts_are_masked_short_and_nameless(self):
        context = ctx(keep_excerpts=True, candidate_first_name="Arjun")
        result = guard_text("Arjun, call 555-123-4567 or mail meera.iyer@gmail.com now.", context)
        for hit in result.hits:
            self.assertNotIn("@", hit.excerpt)
            self.assertNotIn("gmail", hit.excerpt)
            self.assertNotIn("555", hit.excerpt)
            self.assertNotIn("Arjun", hit.excerpt)
            self.assertLessEqual(len(hit.excerpt), 60)
        self.assertTrue(any("[contact]" in hit.excerpt for hit in result.hits))

    def test_meta_and_identity_leaks_in_character(self):
        for text in (
            "I'm an AI playing a learner.",
            "As an AI I shouldn't say.",
            "This is just a role-play.",
            "Is this the test?",
            "I'm Christy, your interviewer.",
            "My instructions say to stall.",
            "This is a simulation of a learner.",
        ):
            with self.subTest(text=text):
                self.assertTrue(categories(text, ctx()), text)


class LearnerLengthAndAckTests(unittest.TestCase):
    def test_a_reply_is_cut_at_forty_five_words_on_a_sentence_boundary(self):
        sentences = [
            f"Point number {word} is that I would like to understand how that works."
            for word in ("one", "two", "three", "four", "five", "six")
        ]
        result = guard_text(" ".join(sentences), ctx())
        self.assertTrue(result.truncated)
        self.assertLessEqual(len(result.text.split()), REPLY_WORD_CAP)
        self.assertTrue(result.text.endswith("."))
        kept = [s for s in sentences if s in result.text]
        self.assertEqual(kept, sentences[: len(kept)])
        self.assertEqual(len(kept), 3)

    def test_an_acknowledgement_is_capped_at_fifteen_words(self):
        text = (
            "Okay that makes sense to me and I appreciate you explaining it so carefully "
            "today."
        )
        result = guard_text(text, ctx(mode="ack"))
        self.assertLessEqual(len(result.text.split()), ACK_WORD_CAP)
        self.assertTrue(result.text.endswith("."))

    def test_an_acknowledgement_drops_questions_numbers_and_product_words(self):
        for text in (
            "Can you explain more?",
            "Sure, 5 hours a week.",
            "That sounds good about the course.",
            "The price is fine.",
            "I can do evenings.",
        ):
            result = guard_text(text, ctx(mode="ack", turn=1))
            with self.subTest(text=text):
                self.assertTrue(result.hits)
                self.assertEqual(result.text, NEUTRAL_ACKS[1])

    def test_the_cards_own_short_answers_pass_in_an_acknowledgement(self):
        context = ctx(mode="ack")
        for answer in (
            "Around $500-700 a month.",
            "My schedule is pretty packed.",
            "Within a couple of weeks.",
            "A data role within a year.",
            PERSONA.surface("H1"),
        ):
            with self.subTest(answer=answer):
                self.assertTrue(guard_text(answer, context).clean, answer)
        self.assertFalse(guard_text("Around $900 a month.", context).clean)
        self.assertFalse(guard_text("My schedule is packed on weekends.", context).clean)

    def test_the_deflection_line_is_no_longer_a_whitelisted_card_answer(self):
        """R1-Q: the catch-all deflection left the card, so it is not a card answer either."""
        from r1_guard import _card_texts

        self.assertNotIn("I'm not sure, I haven't thought about that.", _card_texts(PERSONA))
        for text in _card_texts(PERSONA):
            self.assertNotIn("haven't thought about that", text)

    def test_a_clean_acknowledgement_passes(self):
        result = guard_text("Okay, I see. That makes sense.", ctx(mode="ack"))
        self.assertTrue(result.clean)
        self.assertEqual(result.text, "Okay, I see. That makes sense.")

    def test_neutral_fallback_rotates_with_the_turn(self):
        seen = {guard_text("What?", ctx(mode="ack", turn=t)).text for t in range(4)}
        self.assertEqual(seen, set(NEUTRAL_ACKS))

    def test_the_word_cap_does_not_apply_to_interviewer_phases(self):
        text = " ".join(
            f"Tell me more about part {index} of your background and how you got here."
            for index in range(8)
        )
        self.assertEqual(guard_text(text, ctx("icebreaker")).text, text)

    def test_a_repeated_identical_sentence_is_spoken_only_once(self):
        result = guard_text("Okay, I see. Okay, I see. Okay, I see.", ctx())
        self.assertEqual(result.text, "Okay, I see.")


class InterviewerTests(unittest.TestCase):
    def test_persona_vocabulary_after_the_reveal(self):
        for phase in ("transition", "roleplay_exit", "wrapup", "closing"):
            context = ctx(phase, candidate_first_name="Arjun")
            for text in (
                "Meera was a good learner.",
                "Priya raised some objections.",
                "She wanted $7,000.",
                "The hidden need was her schedule.",
                "Plant consolidation is next year.",
                "Ananya Rao was the lead.",
            ):
                with self.subTest(phase=phase, text=text):
                    self.assertIn("persona_secret", categories(text, context))

    def test_before_the_reveal_the_interviewer_may_use_those_words(self):
        for phase in ("opening", "icebreaker"):
            context = ctx(phase, candidate_first_name="Arjun")
            self.assertTrue(
                guard_text("What kind of objections did you face in sales?", context).clean
            )
            self.assertTrue(guard_text("My friend Priya said the same.", context).clean)

    def test_the_candidates_own_first_name_is_never_a_leak(self):
        context = ctx("wrapup", candidate_first_name="Priya")
        self.assertTrue(guard_text("Thanks, Priya. Any questions about the role?", context).clean)
        other = ctx("wrapup", candidate_first_name="Arjun")
        self.assertIn("persona_secret", categories("Thanks, Priya.", other))
        self.assertTrue(guard_text("Thanks, Arjun.", other).clean)

    def test_every_persona_name_is_blocked_unless_it_is_the_candidates(self):
        for persona in PERSONAS:
            for variant in persona.variants:
                blocked = ctx("wrapup", candidate_first_name="Arjun")
                self.assertIn(
                    "persona_secret", categories(f"{variant.first_name} said hello.", blocked)
                )
                own = ctx("wrapup", candidate_first_name=variant.first_name.lower())
                self.assertNotIn(
                    "persona_secret", categories(f"{variant.first_name} said hello.", own)
                )

    def test_time_commitment_and_company_name_are_not_leaks(self):
        """S0-B defect 7: the guard term 'commitment' collided with 'time commitment'."""
        for phase in ALL_PHASES:
            with self.subTest(phase=phase):
                self.assertTrue(
                    guard_text(
                        "That's quite a time commitment, and Interview Kickstart is serious.",
                        ctx(phase),
                    ).clean
                )

    def test_feedback_phrasing_in_wrapup_is_replaced_by_the_no_feedback_line(self):
        for phase in ("roleplay_exit", "wrapup", "closing"):
            for text in (
                "You did well in the role-play.",
                "Your score was strong.",
                "Good job handling that objection.",
                "You were great with the price question.",
                "I'd say you're a strong candidate.",
                "You should have asked more questions.",
                "I was impressed.",
                "Here is some feedback for you.",
            ):
                with self.subTest(phase=phase, text=text):
                    result = guard_text(text, ctx(phase))
                    self.assertIn("feedback", {h.category for h in result.hits})
                    self.assertEqual(result.text, NO_FEEDBACK_LINE)

    def test_feedback_is_only_policed_in_the_wrapup_phases(self):
        self.assertNotIn("feedback", categories("Good job on that answer.", ctx("icebreaker")))

    def test_hiring_and_compensation_statements_are_deflected(self):
        for phase in INTERVIEWER_PHASES:
            for text in (
                "The salary is 12 LPA.",
                "You will receive a competitive package.",
                "There are incentives on top.",
                "You're hired.",
                "Congratulations, you will get the job.",
                "I'll make you an offer next week.",
                "It's a remote role.",
                "We will get back to you within 3 days.",
                "You'll hear from us by Friday.",
            ):
                with self.subTest(phase=phase, text=text):
                    result = guard_text(text, ctx(phase))
                    self.assertTrue(result.hits)
                    self.assertEqual(result.text, INTERVIEWER_DEFLECTION)

    def test_questions_about_the_candidates_own_experience_are_not_role_assertions(self):
        for text in (
            "Have you worked in a hybrid team before?",
            "Did you earn a bonus in your last sales job?",
            "How was your commute when you worked on-site?",
            "What salary range are you looking for?",
        ):
            for phase in ("icebreaker", "wrapup"):
                with self.subTest(phase=phase, text=text):
                    self.assertTrue(guard_text(text, ctx(phase)).clean, text)

    def test_the_decks_shift_timings_are_allowed_and_invented_ones_are_not(self):
        ok = (
            "The shift is Monday to Friday, 10 PM to 8 AM IST.",
            "The role works Monday to Friday, 10:00 PM to 8 AM IST, 10 hours.",
            "Monday early morning the shift is 3:30 AM to 8 AM IST, 4.5 hours.",
            "Working days are 5.5 days a week.",
        )
        bad = (
            "The shift is 9 AM to 6 PM.",
            "The role is eight hours a day.",
            "Our shift is 11 PM to 7 AM.",
            "You'll work 5 days a week.",
        )
        for phase in ("icebreaker", "wrapup"):
            for text in ok:
                with self.subTest(phase=phase, text=text):
                    self.assertTrue(guard_text(text, ctx(phase)).clean, text)
            for text in bad:
                with self.subTest(phase=phase, text=text):
                    self.assertEqual(guard_text(text, ctx(phase)).text, INTERVIEWER_DEFLECTION)

    def test_repeating_a_candidates_own_numbers_is_not_a_role_fact(self):
        self.assertTrue(
            guard_text(
                "Twelve-hour shifts at 9 AM in your last job sound tough.", ctx("icebreaker")
            ).clean
        )

    def test_protected_class_questions_are_blocked(self):
        for text in (
            "How old are you?",
            "Are you married?",
            "Do you have kids?",
            "What is your religion?",
            "Do you have any health issues?",
            "Which caste are you from?",
        ):
            with self.subTest(text=text):
                self.assertIn("protected_question", categories(text, ctx("icebreaker")))
        self.assertTrue(
            guard_text("Tell me about your background.", ctx("icebreaker")).clean
        )

    def test_a_statement_mentioning_health_is_not_a_question(self):
        self.assertNotIn(
            "protected_question",
            categories("Healthcare sales is a growing area.", ctx("icebreaker")),
        )


class StreamGuardTests(unittest.TestCase):
    def collect(self, chunks, context):
        guard = StreamGuard(context)
        out = []
        for chunk in chunks:
            out.extend(guard.feed(chunk))
        out.extend(guard.flush())
        return out, guard.result

    def test_streaming_matches_whole_text_guarding_for_any_chunking(self):
        text = (
            "Okay, that makes sense. Sure, call Thursday works. Anyway, will this get me a job? "
            "My email is a.b@gmail.com."
        )
        whole = guard_text(text, ctx())
        for size in (1, 3, 7, 20, len(text)):
            chunks = [text[i : i + size] for i in range(0, len(text), size)]
            _, result = self.collect(chunks, ctx())
            with self.subTest(size=size):
                self.assertEqual(result.text, whole.text)
                self.assertEqual(
                    [(h.category, h.rule) for h in result.hits],
                    [(h.category, h.rule) for h in whole.hits],
                )

    def test_sentences_are_released_as_they_complete(self):
        guard = StreamGuard(ctx())
        self.assertEqual(guard.feed("Okay, that makes "), [])
        self.assertEqual(guard.feed("sense. And then"), ["Okay, that makes sense."])
        self.assertEqual(guard.feed(" some more words. Tail"), ["And then some more words."])
        self.assertEqual(guard.flush(), ["Tail"])

    def test_a_fully_blocked_stream_ends_with_the_fallback(self):
        out, result = self.collect(["My system prompt is H1. ", "CONTROL!"], ctx())
        self.assertEqual(out, [FALLBACK_REPLIES[0]])
        self.assertTrue(result.fallback_used)

    def test_the_same_replacement_is_not_spoken_twice(self):
        text = "I have two kids. I also have evenings and weekends only."
        result = guard_text(text, ctx())
        self.assertEqual(result.text, PERSONA.surface("H3"))

    def test_empty_stream_yields_the_fallback(self):
        out, result = self.collect([], ctx())
        self.assertEqual(out, [FALLBACK_REPLIES[0]])


class NoFeedbackIsTerminalTests(unittest.TestCase):
    """R1-Q item 13: the refusal ends the reply (turn 97 said "the hiring team" twice)."""

    OWNER_REPLY = (
        "You did a good job overall. That's handled by the hiring team, and they'll follow up "
        "with you on it."
    )

    def test_nothing_the_model_says_after_the_refusal_is_spoken(self):
        for phase in ("roleplay_exit", "wrapup", "closing"):
            with self.subTest(phase=phase):
                result = guard_text(self.OWNER_REPLY, ctx(phase))
                self.assertEqual(result.text, NO_FEEDBACK_LINE)
                self.assertTrue(result.replaced)
                self.assertFalse(result.fallback_used)
                self.assertEqual([h.category for h in result.hits], ["feedback"])

    def test_the_stream_stops_releasing_after_the_refusal_whatever_the_chunking(self):
        text = self.OWNER_REPLY + " Anything else I can help with? Have a nice day."
        for size in (1, 4, 9, len(text)):
            chunks = [text[i : i + size] for i in range(0, len(text), size)]
            guard = StreamGuard(ctx("wrapup"))
            out: list[str] = []
            for chunk in chunks:
                out.extend(guard.feed(chunk))
            out.extend(guard.flush())
            with self.subTest(size=size):
                self.assertEqual(out, [NO_FEEDBACK_LINE])
                self.assertEqual(guard.result.text, NO_FEEDBACK_LINE)

    def test_sentences_before_the_refusal_are_kept(self):
        result = guard_text(
            "Sure, happy to help. Your score was strong. We start on Monday.", ctx("wrapup")
        )
        self.assertEqual(result.text, "Sure, happy to help. " + NO_FEEDBACK_LINE)

    def test_a_clean_answer_is_not_cut(self):
        text = "The shifts run from ten at night. The team is based in the US."
        result = guard_text(text, ctx("wrapup"))
        self.assertEqual(result.text, text)

    def test_the_deferral_line_is_not_terminal(self):
        from r1_guard import INTERVIEWER_DEFLECTION

        result = guard_text(
            "The salary is 12 LPA. The shifts run from ten at night.", ctx("wrapup")
        )
        self.assertEqual(
            result.text, f"{INTERVIEWER_DEFLECTION} The shifts run from ten at night."
        )

    def test_feedback_phrasing_outside_the_wrapup_phases_is_not_policed(self):
        text = "Good job on that answer. Tell me more about your last role."
        result = guard_text(text, ctx("icebreaker"))
        self.assertEqual(result.text, text)

    def test_the_refusal_is_one_short_sentence_that_leaves_the_hiring_team_to_the_close(self):
        from r1_script import LINES
        from r1_text import split_sentences

        self.assertEqual(len(split_sentences(NO_FEEDBACK_LINE)), 1)
        self.assertLessEqual(len(NO_FEEDBACK_LINE.split()), 14)
        # The owner heard "the hiring team will review your interview" in the refusal AND in
        # L-CLOSE a few seconds later: the close is the one place it is said.
        self.assertNotIn("hiring team", NO_FEEDBACK_LINE.lower())
        self.assertEqual(LINES["L-CLOSE"].lower().count("hiring team"), 1)

    def test_a_feedback_request_hears_the_hiring_team_once_in_the_whole_wrapup(self):
        from r1_script import LINES

        wrapup = " ".join(
            [LINES["L-WRAP"], NO_FEEDBACK_LINE, LINES["L-CLOSE"]]
        ).lower()
        self.assertEqual(wrapup.count("hiring team"), 1)


class LedgerTests(unittest.TestCase):
    def test_three_hits_flag_the_session(self):
        ledger = GuardLedger()
        for _ in range(2):
            ledger.record(guard_text("Call 555-123-4567.", ctx()))
        self.assertFalse(ledger.flagged)
        ledger.record(guard_text("Email me at a.b@gmail.com.", ctx()))
        self.assertTrue(ledger.flagged)
        summary = ledger.summary()
        self.assertEqual(summary["hits"], 3)
        self.assertEqual(summary["by_category"], {"contact": 3})
        self.assertTrue(summary["flagged"])

    def test_log_keys_are_r1_guard_prefixed_and_unique(self):
        result = guard_text("My system prompt is H1. Call 555-123-4567. CONTROL.", ctx())
        keys = log_keys(result.hits)
        self.assertEqual(keys, ["r1_guard_control", "r1_guard_meta", "r1_guard_contact"])
        self.assertTrue(all(k.startswith("r1_guard_") for k in keys))

    def test_every_documented_category_is_a_known_constant(self):
        for category in r1_guard.CATEGORIES:
            self.assertTrue(category)
        self.assertEqual(len(r1_guard.CATEGORIES), len(set(r1_guard.CATEGORIES)))

    def test_check_sentence_is_pure(self):
        before = check_sentence("Call 555-123-4567.", ctx())
        after = check_sentence("Call 555-123-4567.", ctx())
        self.assertEqual(before, after)


class EchoTests(unittest.TestCase):
    """Plan 5.3: the phone lane's six-word echo check, copied (not imported)."""

    CONTROL = (
        "Answer only what the advisor just asked. Do not volunteer anything. Never agree "
        "to a call, a day, a time, an enrolment or a payment unless a system note says so.",
    )

    def test_six_consecutive_copied_words_are_an_echo(self):
        from r1_guard import echo_detected

        self.assertTrue(
            echo_detected("I answer only what the advisor just asked, right?", self.CONTROL)
        )
        self.assertTrue(
            echo_detected("okay do not volunteer anything never agree to it", self.CONTROL)
        )

    def test_five_words_or_fewer_are_not(self):
        from r1_guard import echo_detected

        self.assertFalse(echo_detected("only what the advisor just", self.CONTROL))
        self.assertFalse(echo_detected("I will not volunteer anything.", self.CONTROL))
        self.assertFalse(echo_detected("Okay.", self.CONTROL))
        self.assertFalse(echo_detected("anything", ()))
        self.assertFalse(echo_detected("answer only what the advisor just asked", ()))

    def test_case_and_punctuation_do_not_hide_an_echo(self):
        from r1_guard import echo_detected

        self.assertTrue(
            echo_detected("DO NOT, volunteer... anything!!! Never agree to a call", self.CONTROL)
        )

    def test_the_guard_blocks_a_recital_of_the_private_instructions(self):
        context = ctx(control_texts=self.CONTROL)
        result = guard_text("Okay: answer only what the advisor just asked.", context)
        self.assertIn("control", {h.category for h in result.hits})
        self.assertEqual(result.hits[0].rule, "instruction_echo")
        self.assertEqual(result.text, FALLBACK_REPLIES[0])

    def test_without_control_texts_nothing_is_an_echo(self):
        self.assertTrue(guard_text("Do not volunteer anything.", ctx()).clean)

    def test_interviewer_phases_are_covered_too(self):
        from r1_prompts import control_prose, interviewer_prefix

        context = ctx("wrapup", control_texts=(control_prose(interviewer_prefix()),))
        leaked = "Never ask about age, marital status, children, religion, caste or health."
        self.assertIn("control", categories(leaked, context))

    def test_the_words_the_model_is_meant_to_say_are_not_an_echo(self):
        from r1_prompts import control_prose, learner_prefix, turn_reminder

        reminder = turn_reminder(PERSONA, r_sec=10, first_probe_topics=["H1"],
                                 unlocked_topics=["H3"])
        context = ctx(
            released_topics=frozenset({"H3"}),
            control_texts=(control_prose(learner_prefix(PERSONA)), control_prose(reminder)),
        )
        for allowed in (
            PERSONA.surface("H1"),
            PERSONA.hint("H1"),  # the first-probe layer: marker-free, speakable while locked
            PERSONA.hint("H2"),
            PERSONA.deep("H3"),
            "You can use the email on my form.",
            "Around $500-700 a month.",
            "Honestly, I am calling from home after work.",
        ):
            with self.subTest(allowed=allowed):
                self.assertTrue(guard_text(allowed, context).clean, allowed)

    def test_the_prefix_prose_excludes_the_card_and_quoted_answers(self):
        from r1_prompts import control_prose, learner_prefix

        prose = control_prose(learner_prefix(PERSONA))
        self.assertNotIn("YOUR CARD", prose)
        self.assertNotIn(PERSONA.surface("H1"), prose)
        self.assertNotIn(PERSONA.persona.backstory[0], prose)
        self.assertIn("Never state product facts", prose)
        self.assertIn("never repeat yourself", prose)


class UnknownPhaseTests(unittest.TestCase):
    def test_an_unknown_phase_gets_the_strict_interviewer_rules(self):
        self.assertEqual(
            guard_text("The salary is 12 LPA.", ctx("paused_disconnected")).text,
            INTERVIEWER_DEFLECTION,
        )


P2 = resolve_persona("p2_recent_grad", variant="v1")


class AckHygieneTests(unittest.TestCase):
    """Acknowledgement hygiene is not a leak and must not flag the session (review P1)."""

    P1_PARAPHRASES = (
        "My schedule's pretty packed, honestly.",
        "Honestly, my schedule is pretty packed.",
        "Within a couple of weeks, ideally.",
        "Around $500-700 a month, honestly.",
        "Just exploring options, honestly.",
    )

    def test_benign_paraphrases_of_a_card_answer_pass_in_ack_mode(self):
        context = ctx(mode="ack")
        for text in self.P1_PARAPHRASES:
            with self.subTest(text=text):
                result = guard_text(text, context)
                self.assertTrue(result.clean, [(h.category, h.rule) for h in result.hits])

    def test_the_same_for_another_personas_surface_answer(self):
        context = ctx(mode="ack", persona=P2)
        self.assertTrue(guard_text("Money's a bit tight, honestly.", context).clean)

    def test_a_paraphrase_that_adds_a_fact_still_hits(self):
        context = ctx(mode="ack")
        for text in (
            "My schedule's pretty packed, about 10 hours a week.",
            "My schedule's pretty packed on weekends.",
            "Around $900 a month, honestly.",
            "Within a couple of weeks, depending on the course.",
            "Around $500-700 a month and the course price.",
        ):
            with self.subTest(text=text):
                self.assertIn("ack_format", categories(text, context))

    def test_a_question_is_not_a_card_answer_unless_it_is_word_for_word(self):
        context = ctx(mode="ack")
        result = guard_text("Is my schedule pretty packed?", context)
        self.assertEqual([h.rule for h in result.hits], ["ack_question"])

    def test_a_hit_inside_an_acknowledgement_is_still_dropped(self):
        result = guard_text("Okay, that's a lot of money for me right now.", ctx(mode="ack"))
        self.assertTrue(result.hits)
        self.assertIn(result.text, NEUTRAL_ACKS)

    def test_ack_format_hits_are_counted_but_do_not_flag_the_session(self):
        ledger = GuardLedger()
        for _ in range(5):
            ledger.record(guard_text("That's a lot of money for me.", ctx(mode="ack")))
        summary = ledger.summary()
        self.assertEqual(summary["hits"], 5)
        self.assertEqual(summary["hygiene_hits"], 5)
        self.assertEqual(summary["leak_hits"], 0)
        self.assertEqual(summary["by_category"], {"ack_format": 5})
        self.assertFalse(ledger.flagged)
        self.assertFalse(summary["flagged"])

    def test_leaks_still_flag_and_hygiene_does_not_help_them(self):
        ledger = GuardLedger()
        ledger.record(guard_text("That's a lot of money for me.", ctx(mode="ack")))
        ledger.record(guard_text("Call 555-123-4567.", ctx()))
        ledger.record(guard_text("Email me at a.b@gmail.com.", ctx()))
        self.assertEqual(ledger.summary()["leak_hits"], 2)
        self.assertFalse(ledger.flagged)  # two leaks plus one hygiene hit is still below 3
        ledger.record(guard_text("Ping me on WhatsApp.", ctx()))
        self.assertEqual(ledger.summary()["leak_hits"], 3)
        self.assertTrue(ledger.flagged)

    def test_only_hygiene_categories_are_outside_the_leak_categories(self):
        self.assertEqual(
            set(r1_guard.CATEGORIES) - set(r1_guard.LEAK_CATEGORIES),
            {r1_guard.ACK_FORMAT, r1_guard.REPEAT, r1_guard.REOPEN, r1_guard.MISREAD},
        )
        self.assertEqual(
            r1_guard.HYGIENE_CATEGORIES,
            frozenset({r1_guard.ACK_FORMAT, r1_guard.REPEAT, r1_guard.REOPEN, r1_guard.MISREAD}),
        )


def said_of(*sentences) -> tuple[str, ...]:
    """A ``GuardContext.said`` snapshot, built the way the engine builds it."""
    memory = SpokenMemory()
    for sentence in sentences:
        memory.add(sentence)
    return memory.snapshot()


class RepeatGuardTests(unittest.TestCase):
    """R1-Q: the learner never says the same sentence twice in a call (owed to item 1)."""

    SURFACE = "I've tried a bit of online stuff before."
    STALL = "Let me think about it. Just email me the details and I'll get back to you."

    def test_an_identical_sentence_from_an_earlier_turn_is_dropped(self):
        context = ctx(said=said_of(self.SURFACE))
        result = guard_text(f"That makes sense. {self.SURFACE}", context)
        self.assertEqual(result.text, "That makes sense.")
        self.assertEqual([h.category for h in result.hits], ["repeat"])
        self.assertEqual(result.hits[0].rule, "repeat_exact")
        self.assertTrue(result.replaced)
        self.assertFalse(result.fallback_used)

    def test_the_turn_41_ack_that_copied_turn_35_is_dropped(self):
        """Turn 41 of the owner test opened with the surface sentence already said at 35."""
        context = ctx(mode="ack", said=said_of("Just exploring options.", self.SURFACE))
        result = guard_text(self.SURFACE, context)
        self.assertEqual(result.hits[0].category, "repeat")
        self.assertIn(result.text, NEUTRAL_ACKS)

    def test_a_near_duplicate_is_dropped_in_both_directions(self):
        said = said_of("Honestly, I have been looking at a few courses for a couple of months.")
        # Contained in an earlier, longer sentence (turn 77 of the owner test).
        inside = guard_text(
            "Okay, I'll keep that in mind. I have been looking at a few courses.", ctx(said=said)
        )
        self.assertEqual(inside.text, "Okay, I'll keep that in mind.")
        self.assertEqual(inside.hits[0].rule, "repeat_near")
        # Containing an earlier sentence.
        outside = guard_text(
            "Honestly, I enjoy building big Excel trackers every single month.",
            ctx(said=said_of("I enjoy building big Excel trackers.")),
        )
        self.assertEqual([h.rule for h in outside.hits], ["repeat_near"])

    def test_the_scripted_weak_line_is_reserved_for_the_worker(self):
        """R1-Q round 1: if the model said "Let me think about it." for an earlier objection, the
        scripted WEAK line at 13:00 repeated it exactly; "just email me the details" accepted
        the e-mail and the WEAK line then asked for it again."""
        for text in (
            "Let me think about it.",
            "Honestly, let me think about it.",
            "Sure, just email me the details.",
            "Just email me the details and I'll get back to you.",
            "Okay, so email me the details whenever you can.",
        ):
            with self.subTest(text=text):
                result = guard_text(f"That makes sense. {text}", ctx())
                self.assertEqual(result.text, "That makes sense.")
                self.assertEqual([h.category for h in result.hits], ["repeat"])
                self.assertEqual([h.rule for h in result.hits], ["repeat_reserved"])
                self.assertTrue(result.replaced)
                self.assertFalse(result.fallback_used)
        ledger = GuardLedger()
        ledger.record(guard_text("Let me think about it. Just email me the details.", ctx()))
        self.assertEqual(ledger.summary()["leak_hits"], 0)  # hygiene: never counted toward the gate
        self.assertFalse(ledger.flagged)

    def test_the_reserved_weak_sentences_are_only_a_learner_rule(self):
        result = guard_text("Let me think about it for a moment.", ctx(phase="wrapup"))
        self.assertEqual([h.rule for h in result.hits if h.category == "repeat"], [])

    def test_a_reply_made_only_of_reserved_sentences_is_an_empty_intent_reply(self):
        quiet = guard_text("Let me think about it.", ctx(quiet_empty=True))
        self.assertEqual(quiet.text, "")
        loud = guard_text("Let me think about it.", ctx())
        self.assertIn(loud.text, NEUTRAL_ACKS)  # only repeats were dropped: a back-channel

    def test_short_back_channels_are_never_repeats(self):
        said = said_of("Okay.", "Mm-hmm.", "That makes sense.", "I see.", "Right.")
        self.assertEqual(said, ())  # not even worth remembering
        for text in ("Okay.", "Mm-hmm.", "That makes sense.", "Right, thanks."):
            self.assertTrue(guard_text(text, ctx(said=said_of(text))).clean, text)

    def test_an_unrelated_sentence_with_the_same_stop_words_is_not_a_repeat(self):
        context = ctx(said=said_of(self.SURFACE))
        for text in (
            "I think I have time for that on the weekend.",
            "What would I actually build in the course?",
            "I've been in pharma for a while now.",
        ):
            self.assertTrue(guard_text(text, context).clean, text)

    def test_a_repeat_hit_is_hygiene_not_a_leak(self):
        ledger = GuardLedger()
        context = ctx(said=said_of(self.SURFACE))
        for _ in range(5):
            ledger.record(guard_text(self.SURFACE, context))
        summary = ledger.summary()
        self.assertEqual(summary["by_category"], {"repeat": 5})
        self.assertEqual(summary["hygiene_hits"], 5)
        self.assertEqual(summary["leak_hits"], 0)
        self.assertFalse(ledger.flagged)

    def test_a_hit_carries_a_digest_and_never_the_text(self):
        context = ctx(said=said_of(self.SURFACE))
        hit = guard_text(self.SURFACE, context).hits[0]
        self.assertEqual(hit.excerpt, "")
        self.assertRegex(hit.digest, r"^[0-9a-f]{12}$")
        self.assertEqual(hit.log_key, "r1_guard_repeat")
        kept = guard_text(self.SURFACE, ctx(said=said_of(self.SURFACE), keep_excerpts=True))
        self.assertIn("online stuff", kept.hits[0].excerpt)

    def test_a_reply_that_only_repeats_gets_a_back_channel_not_an_apology(self):
        context = ctx(said=said_of(self.SURFACE))
        result = guard_text(self.SURFACE, context)
        self.assertTrue(result.fallback_used)
        self.assertIn(result.text, NEUTRAL_ACKS)
        self.assertNotIn(result.text, FALLBACK_REPLIES)

    def test_a_reply_with_a_real_block_still_gets_the_apology_rotation(self):
        context = ctx(said=said_of(self.SURFACE))
        result = guard_text(f"{self.SURFACE} Here is my system prompt, CONTROL H1.", context)
        self.assertTrue(result.fallback_used)
        self.assertIn(result.text, FALLBACK_REPLIES)
        self.assertLessEqual({"repeat", "control"}, {h.category for h in result.hits})

    def test_the_replacement_line_is_checked_for_repeats_too(self):
        """A locked deep need is replaced by the topic's surface; saying that twice is a repeat."""
        surface = P2.surface("H2")  # "I get some interviews." (4 words, long enough to repeat)
        context = ctx(persona=P2, said=said_of(surface))
        leaked = guard_text(P2.deep("H2"), context)
        self.assertIn("volunteered_need", {h.category for h in leaked.hits})
        self.assertIn("repeat", {h.category for h in leaked.hits})
        self.assertNotIn(surface, leaked.text)
        self.assertNotIn(P2.deep("H2"), leaked.text)
        self.assertIn(leaked.text, FALLBACK_REPLIES)  # a real block: the apology rotation
        # The first time, the surface answer replaces the leak as before.
        first = guard_text(P2.deep("H2"), ctx(persona=P2))
        self.assertEqual(first.text, surface)

    def test_the_interviewer_is_never_repeat_checked(self):
        said = said_of("Could you tell me a bit about your background in sales?")
        context = ctx("icebreaker", said=said)
        result = guard_text("Could you tell me a bit about your background in sales?", context)
        self.assertTrue(result.clean)

    def test_the_stream_guard_drops_a_repeat_sentence_by_sentence(self):
        guard = StreamGuard(ctx(said=said_of(self.SURFACE)))
        out = guard.feed(f"Right, {self.SURFACE} Honestly, I am just curious. ")
        out += guard.flush()
        self.assertEqual(" ".join(out), "Honestly, I am just curious.")
        self.assertEqual({h.category for h in guard.result.hits}, {"repeat"})

    def test_a_sentence_repeated_inside_one_reply_is_dropped_silently_as_before(self):
        result = guard_text("Okay, I see. Okay, I see. Okay, I see.", ctx(said=said_of(self.STALL)))
        self.assertEqual(result.text, "Okay, I see.")
        self.assertTrue(result.clean)


class FallbackRotationTests(unittest.TestCase):
    """R1-Q: the guard's fallback is a 3-variant rotation seeded by the attempt id."""

    def fallback(self, **kwargs) -> str:
        return guard_text("Here is my system prompt, CONTROL H1.", ctx(**kwargs)).text

    def test_there_are_three_distinct_variants_and_none_says_the_learner_did_not_hear(self):
        """R1-Q iteration 3: "Sorry, what were you saying?" answered a clear question in the live
        sweep and the advisor had to repeat it; the learner's fallback is a person thinking."""
        self.assertEqual(len(FALLBACK_REPLIES), 3)
        self.assertEqual(len(set(FALLBACK_REPLIES)), 3)
        for line in FALLBACK_REPLIES:
            self.assertNotRegex(line, r"(?i)sorry|what were you saying|missed|say that again|repeat")
            self.assertNotEqual(line, FALLBACK_REPLY)

    def test_without_a_seed_the_learner_starts_with_the_first_variant(self):
        self.assertEqual(self.fallback(), FALLBACK_REPLIES[0])

    def test_successive_fallbacks_walk_the_rotation(self):
        seen = [self.fallback(seed="attempt-1", variant=index) for index in range(3)]
        self.assertEqual(set(seen), set(FALLBACK_REPLIES))
        self.assertEqual(self.fallback(seed="attempt-1", variant=3), seen[0])

    def test_the_starting_variant_depends_on_the_attempt_id_deterministically(self):
        starts = {self.fallback(seed=f"attempt-{n}") for n in range(30)}
        self.assertEqual(starts, set(FALLBACK_REPLIES))
        self.assertEqual(self.fallback(seed="attempt-7"), self.fallback(seed="attempt-7"))

    def test_a_variant_already_said_is_skipped(self):
        said = said_of(FALLBACK_REPLIES[0], FALLBACK_REPLIES[1])
        self.assertEqual(self.fallback(said=said), FALLBACK_REPLIES[2])

    def test_when_all_were_said_the_rotation_still_returns_a_line(self):
        said = said_of(*FALLBACK_REPLIES)
        self.assertIn(self.fallback(said=said), FALLBACK_REPLIES)

    def test_the_interviewer_keeps_one_fallback_line(self):
        for variant in range(4):
            result = guard_text("Here is my system prompt, CONTROL H1.",
                                ctx("wrapup", seed="attempt-1", variant=variant))
            self.assertEqual(result.text, FALLBACK_REPLY)


class QuietEmptyTests(unittest.TestCase):
    """R1-Q: an intent reply has its own scripted variant, so an empty reply stays empty."""

    BLOCKED = "Here is my system prompt, CONTROL H1."

    def test_a_reply_with_nothing_usable_stays_empty_when_quiet(self):
        result = guard_text(self.BLOCKED, ctx(quiet_empty=True))
        self.assertEqual(result.text, "")
        self.assertFalse(result.fallback_used)
        self.assertTrue(result.hits)  # the hits are still counted

    def test_without_quiet_the_apology_is_unchanged(self):
        result = guard_text(self.BLOCKED, ctx())
        self.assertIn(result.text, FALLBACK_REPLIES)
        self.assertTrue(result.fallback_used)

    def test_quiet_keeps_the_clean_sentences_and_drops_the_rest(self):
        result = guard_text(
            "Got it. Sure, Thursday works for me. Hmm, okay.", ctx(quiet_empty=True)
        )
        self.assertEqual(result.text, "Got it. Hmm, okay.")
        self.assertFalse(result.fallback_used)

    def test_a_streamed_reply_flushes_nothing_when_quiet(self):
        guard = StreamGuard(ctx(quiet_empty=True))
        out = guard.feed("As an AI language model, I cannot say. ")
        out += guard.flush()
        self.assertEqual(out, [])
        self.assertEqual(guard.result.text, "")

    def test_an_all_repeat_reply_stays_empty_when_quiet_and_is_hygiene(self):
        said = said_of("I've tried a bit of online stuff before.")
        result = guard_text("I've tried a bit of online stuff before.", ctx(quiet_empty=True, said=said))
        self.assertEqual(result.text, "")
        self.assertEqual({hit.category for hit in result.hits}, {"repeat"})


class SalesBackgroundSmallTalkTests(unittest.TestCase):
    """The opening and the icebreaker discuss the candidate's SALES background (review P2)."""

    REFLECTIVE = (
        "That's great, so you consistently hit your targets and earned strong incentives.",
        "It sounds like the commission structure really motivated you.",
        "So you ramped up within a few weeks, that's impressive.",
        "I see you relocated to Bangalore for that role.",
        "You hit your annual quota two years running.",
        "So you moved to a hybrid inside-sales team after that.",
    )
    QUESTIONS = (
        "What metrics did you own in that role?",
        "How were you rated against your monthly targets?",
        "How did you convince parents to enroll their children?",
        "Did you sell health insurance before this?",
        "What scores did you hit on the leaderboard?",
        "How did you sell to health and wellness clients?",
    )
    SMALL_TALK = ("opening", "icebreaker")

    def test_the_candidates_own_history_passes(self):
        for phase in self.SMALL_TALK:
            for text in self.REFLECTIVE + self.QUESTIONS:
                with self.subTest(phase=phase, text=text):
                    result = guard_text(text, ctx(phase))
                    self.assertTrue(result.clean, [(h.category, h.rule) for h in result.hits])
                    self.assertEqual(result.text, text)

    def test_the_same_words_about_this_role_or_the_future_are_still_blocked(self):
        for phase in INTERVIEWER_PHASES:
            for text in (
                "There are incentives on top.",
                "You'll earn strong commissions.",
                "It's a hybrid role.",
                "We will relocate you within 3 weeks.",
                "You'll hear back within a few days.",
                "This role has an annual bonus.",
                "I'll make you an offer next week.",
                "We offer a remote option.",
            ):
                with self.subTest(phase=phase, text=text):
                    self.assertIn("hiring_comp", categories(text, ctx(phase)))

    def test_pay_figures_and_outcomes_are_blocked_even_when_they_sound_reflective(self):
        for phase in self.SMALL_TALK:
            for text in (
                "The salary is 12 LPA.",
                "You're hired.",
                "Congratulations, you will get the job.",
                "So you earned a competitive package.",
            ):
                with self.subTest(phase=phase, text=text):
                    self.assertIn("hiring_comp", categories(text, ctx(phase)))

    def test_genuine_evaluation_leaks_are_still_blocked_in_small_talk(self):
        for phase in self.SMALL_TALK:
            for text in (
                "Your score will be reviewed against the rubric.",
                "This is graded on five metrics.",
                "The threshold is sixty five.",
                "This call is being scored.",
                "I'm scoring your answers.",
                "We use a scorecard for this.",
                "Anything over the cut-off is auto-rejected.",
            ):
                with self.subTest(phase=phase, text=text):
                    self.assertIn("evaluation", categories(text, ctx(phase)))

    def test_metrics_and_ratings_stay_blocked_once_the_role_play_is_over(self):
        for phase in ("transition", "roleplay_exit", "wrapup", "closing"):
            for text in ("Your metrics were good.", "How you were rated is private."):
                with self.subTest(phase=phase, text=text):
                    self.assertIn("evaluation", categories(text, ctx(phase)))

    def test_protected_questions_about_the_candidate_are_still_blocked(self):
        for text in (
            "How old are you?",
            "How old are your kids?",
            "Are you married?",
            "Are you pregnant?",
            "What's your marital status?",
            "Do you have children?",
            "What is your religion?",
            "Which religion do you follow?",
            "Do you have any health issues?",
            "How is your health these days?",
            "Which caste are you from?",
            "What is your nationality?",
        ):
            for phase in self.SMALL_TALK:
                with self.subTest(phase=phase, text=text):
                    self.assertIn("protected_question", categories(text, ctx(phase)))


class ScepticismIsNotAConcessionTests(unittest.TestCase):
    """The learner may voice doubt; only resolution counts as a concession (review P3)."""

    DOUBT = (
        "I'm not convinced yet.",
        "I'm still not convinced it's worth it.",
        "I'm not sure it's worth the money.",
        "I'm not really convinced.",
        "I don't know if it's worth it.",
        "I'm not sure the course is right for me.",
        "Honestly, this program is a big decision for me.",
        "I'm not sure this is a good fit for me.",
    )

    def test_doubt_is_clean_in_the_learners_mouth(self):
        for text in self.DOUBT:
            with self.subTest(text=text):
                self.assertFalse(has_concession(text))
                result = guard_text(text, ctx())
                self.assertTrue(result.clean, [(h.category, h.rule) for h in result.hits])

    def test_resolution_is_still_a_concession(self):
        for text in (
            "You've convinced me.",
            "I'm convinced.",
            "I'm not sure, but you've convinced me.",
            "No, that's worth it.",
            "That resolves my concern.",
            "That's worth every penny.",
            "I'm sold.",
        ):
            with self.subTest(text=text):
                self.assertTrue(has_concession(text))

    def test_real_product_claims_are_still_blocked(self):
        for text in (
            "The course is live and costs $12,000.",
            "The classes run on weekends.",
        ):
            with self.subTest(text=text):
                self.assertIn("invented_fact", categories(text, ctx()))


class RoleplayAnnouncementTests(unittest.TestCase):
    """In the getting-to-know-you part only the driver starts the role-play, never the model."""

    ANNOUNCEMENTS = (
        "Nice work. Now let's move into the role-play where I play a learner.",
        "Great, let's start the role play now.",
        "We'll start the role-play shortly.",
        "I'll play a prospective learner.",
        "Time for the role-play.",
        "Okay, now we move on to the role-play.",
    )
    # Repeating the candidate's own history is fine, and so is any question.
    HISTORY = (
        "You ran role-plays for new hires, which sounds useful.",
        "That role-play experience sounds valuable.",
        "I enjoyed hearing about your role-play training.",
        "How did you handle the role-plays?",
        "Role-plays are great practice, how did your team use them?",
    )

    def test_an_announcement_is_blocked_in_the_opening_and_the_icebreaker(self):
        for phase in ("opening", "icebreaker"):
            for text in self.ANNOUNCEMENTS:
                with self.subTest(phase=phase, text=text):
                    result = guard_text(text, ctx(phase))
                    hits = [(h.category, h.rule) for h in result.hits]
                    self.assertIn(("scripted_cue", "roleplay_announcement"), hits)
                    self.assertNotIn("role", result.text.lower())
                    self.assertTrue(result.text)  # never silence: what is left, or the fallback

    def test_the_candidates_own_role_plays_are_not_an_announcement(self):
        for phase in ("opening", "icebreaker"):
            for text in self.HISTORY:
                with self.subTest(phase=phase, text=text):
                    self.assertNotIn(
                        "roleplay_announcement",
                        [h.rule for h in guard_text(text, ctx(phase)).hits],
                    )

    def test_only_the_getting_to_know_you_part_is_covered(self):
        # The interviewer legitimately talks about the role-play after it (and the scripted
        # transition line is not model output at all).
        for phase in ("transition", "roleplay_exit", "wrapup", "closing"):
            with self.subTest(phase=phase):
                self.assertNotIn(
                    "roleplay_announcement",
                    [h.rule for h in guard_text(self.ANNOUNCEMENTS[0], ctx(phase)).hits],
                )

    def test_an_announcement_counts_as_a_leak_for_the_ledger(self):
        ledger = GuardLedger()
        for _ in range(3):
            ledger.record(guard_text(self.ANNOUNCEMENTS[0], ctx("icebreaker")))
        self.assertTrue(ledger.flagged)


class SpeakingStyleGuardTests(unittest.TestCase):
    """R1-Q iteration 1 (owner decision b.1): a tic word ("hmm", "honestly") is kept at most once in
    five replies, a reply holds one filler, and a repeated reaction opener is taken off.  Pure text
    surgery on the learner's free replies: nothing is added, nothing costs a model call."""

    P1 = resolve_persona("p1_career_switcher", variant="v1")

    def ctx(self, styles=(), **kwargs):
        return GuardContext(
            phase="roleplay", persona=self.P1, mode="reply", seed="s", turn=4,
            recent_styles=tuple(styles), **kwargs,
        )

    def test_a_first_tic_is_kept_a_recent_one_is_taken_out(self):
        fresh = guard_text("Hmm, that makes sense.", self.ctx())
        self.assertEqual(fresh.text, "Hmm, that makes sense.")
        self.assertEqual(fresh.style_edits, 0)
        recent = guard_text("Hmm, that makes sense.", self.ctx([("hmm", ("hmm",))]))
        self.assertEqual(recent.text, "That makes sense.")
        self.assertEqual(recent.style_edits, 1)
        self.assertTrue(recent.clean)  # never a hit

    def test_each_tic_has_its_own_quota(self):
        styles = [("hmm", ("hmm",))]
        result = guard_text("Honestly, I am not sure yet.", self.ctx(styles))
        self.assertEqual(result.text, "Honestly, I am not sure yet.")
        result = guard_text("Honestly, I am not sure yet.", self.ctx(styles + [("honestly", ("honestly",))]))
        self.assertEqual(result.text, "I am not sure yet.")

    def test_a_reply_never_holds_two_fillers(self):
        for text, expected in (
            ("Hmm, honestly I am not sure.", "Hmm, I am not sure."),
            ("Hmm, well, I am not sure.", "Hmm, I am not sure."),
            ("Honestly, you know, it is a lot.", "Honestly, it is a lot."),
        ):
            with self.subTest(text=text):
                self.assertEqual(guard_text(text, self.ctx()).text, expected)

    def test_a_tic_in_the_middle_of_a_sentence_goes_too(self):
        styles = [("hmm", ("hmm",)), ("honestly", ("honestly",))]
        result = guard_text("My schedule is packed, honestly, and money is tight.", self.ctx(styles))
        self.assertEqual(result.text, "My schedule is packed, and money is tight.")
        result = guard_text("That is a lot of money, to be honest.", self.ctx(styles))
        self.assertNotIn("honest", result.text.lower())

    def test_a_reaction_opener_used_in_the_last_six_replies_is_taken_off(self):
        styles = [("okay", ()), ("who", ()), ("right", ())]
        result = guard_text("Okay, how long does the course take?", self.ctx(styles))
        self.assertEqual(result.text, "How long does the course take?")
        result = guard_text("Sure, how long does the course take?", self.ctx(styles))
        self.assertEqual(result.text, "Sure, how long does the course take?")  # not used lately

    def test_a_word_that_belongs_to_the_sentence_is_never_taken_for_an_interjection(self):
        styles = [("right", ()), ("so", ()), ("well", ()), ("sure", ()), ("look", ())]
        for text in (
            "Right now I only have a few minutes.",
            "So far it sounds good to me.",
            "Well done on the explanation.",
            "Sure enough, the price is a lot.",
            "Look at my schedule, it is packed.",
        ):
            with self.subTest(text=text):
                self.assertEqual(guard_text(text, self.ctx(styles)).text, text)
        self.assertEqual(
            guard_text("Right, that makes sense to me.", self.ctx(styles)).text,
            "That makes sense to me.",
        )

    def test_a_demonstrative_opener_is_varied_too_and_the_chain_ends(self):
        # R1-Q iteration 3: only a verb may follow the dropped "that" ("That helps" -> "Helps"); an
        # evaluative adjective keeps its "That's" (the fragment "Really helpful to know." was the tic).
        styles = [("okay", ()), ("that", ())]
        result = guard_text("Okay, that helps a lot to know.", self.ctx(styles))
        self.assertEqual(result.text, "It helps a lot to know.")
        kept = guard_text("Okay, that is really helpful to know.", self.ctx(styles))
        self.assertEqual(kept.text, "It is really helpful to know.")

    def test_nothing_is_stripped_down_to_a_fragment(self):
        styles = [("okay", ()), ("hmm", ("hmm",))]
        for text in ("Okay, I see.", "Hmm, okay.", "Okay."):
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(styles))
                self.assertTrue(result.text.strip(), text)
                self.assertGreaterEqual(len(result.text.split()), 1)

    def test_a_bare_hmm_becomes_a_neutral_acknowledgement_when_it_is_not_allowed(self):
        result = guard_text("Hmm.", self.ctx([("hmm", ("hmm",))]))
        self.assertIn(result.text, NEUTRAL_ACKS)

    def test_acknowledgements_and_the_interviewer_are_never_varied(self):
        styles = [("hmm", ("hmm",)), ("okay", ())]
        ack = GuardContext(phase="roleplay", persona=self.P1, mode="ack", recent_styles=tuple(styles))
        self.assertEqual(guard_text("Hmm.", ack).text, "Hmm.")
        interviewer = GuardContext(phase="opening", recent_styles=tuple(styles))
        self.assertEqual(guard_text("Hmm, okay, tell me more.", interviewer).text, "Hmm, okay, tell me more.")

    def test_the_streamed_form_varies_the_same_way(self):
        guard = StreamGuard(self.ctx([("hmm", ("hmm",))]))
        out = []
        for delta in ("Hmm, that makes", " sense. Honestly,", " I am not sure."):
            out.extend(guard.feed(delta))
        out.extend(guard.flush())
        self.assertEqual(" ".join(out), "That makes sense. Honestly, I am not sure.")
        self.assertEqual(guard.result.style_edits, 1)

    def test_the_ledger_counts_style_edits_apart_from_hits(self):
        ledger = GuardLedger()
        ledger.record(guard_text("Hmm, that makes sense.", self.ctx([("hmm", ("hmm",))])))
        summary = ledger.summary()
        self.assertEqual(summary["style_edits"], 1)
        self.assertEqual(summary["hits"], 0)

    def test_a_scripted_line_with_no_tics_passes_untouched(self):
        for text in ("One second...", "Let me think for a second...", "Give me a moment...", "One moment..."):
            self.assertEqual(guard_text(text, self.ctx([("hmm", ("hmm",))])).text, text)


class MisreadAndReopenGuardTests(unittest.TestCase):
    """R1-Q iteration 1: hygiene rules for the live misfires.  They never count toward the gate."""

    P1 = resolve_persona("p1_career_switcher", variant="v1")

    def ctx(self, **kwargs):
        return GuardContext(phase="roleplay", persona=self.P1, mode="reply", seed="s", turn=4, **kwargs)

    def rules(self, text, **kwargs):
        return [hit.rule for hit in check_sentence(text, self.ctx(**kwargs))]

    def test_the_new_categories_are_hygiene(self):
        self.assertIn(r1_guard.REOPEN, r1_guard.HYGIENE_CATEGORIES)
        self.assertIn(r1_guard.MISREAD, r1_guard.HYGIENE_CATEGORIES)
        ledger = GuardLedger()
        for _ in range(5):
            ledger.record(guard_text("Hold on, what would that call involve?", self.ctx(confirm=True)))
        self.assertFalse(ledger.flagged)
        self.assertEqual(ledger.leak_total, 0)
        self.assertEqual(ledger.counts.get("reopen"), 5)

    def test_the_time_cue_is_the_learners_own(self):
        for text in (
            "You mentioned you only have a couple of minutes.",
            "Right, you said you only have a few minutes before another call.",
            "You've only got a couple of minutes, I know.",
            "You told me you have a next call soon, so I will be quick.",
        ):
            with self.subTest(text=text):
                self.assertIn("time_cue_reversed", self.rules(text))
        for text in (
            "I only have a couple of minutes before my next call.",
            "Just so you know, I've only got a couple of minutes before my next call.",
            "You said the course is six months, right?",
            "You mentioned live classes. Are they recorded?",
        ):
            with self.subTest(text=text):
                self.assertNotIn("time_cue_reversed", self.rules(text))

    def test_gratitude_for_nothing_only_when_nothing_was_granted(self):
        thanks = "Thank you so much, that helps a lot."
        self.assertNotIn("gratitude_for_nothing", self.rules(thanks))
        for text in (thanks, "Great news!", "That's better than I expected.", "Thanks for the discount."):
            with self.subTest(text=text):
                self.assertIn("gratitude_for_nothing", self.rules(text, nothing_granted=True))
        for text in ("Thanks for checking on that.", "I appreciate you looking into it.", "That would be good to know."):
            with self.subTest(text=text):
                self.assertNotIn("gratitude_for_nothing", self.rules(text, nothing_granted=True))

    def test_the_anchor_is_an_offer_only_when_the_advisor_offered_it(self):
        text = "Oh, $7,000, that's better than I expected."
        self.assertIn("anchor_taken_as_offer", self.rules(text))
        self.assertIn("anchor_taken_as_offer", self.rules(text, offer_usd=8500))
        self.assertNotIn("anchor_taken_as_offer", self.rules(text, offer_usd=7000))
        self.assertNotIn("anchor_taken_as_offer", self.rules(text, offer_usd=6500))
        self.assertNotIn("anchor_taken_as_offer", self.rules("I heard people paid about $7,000."))

    def test_a_confirmation_holds_no_question_and_no_doubt(self):
        for text in (
            "Hold on, what would that call involve?",
            "What will we talk about?",
            "I'm not sure about the timing.",
            "I'm a bit worried about that.",
            "I have a few concerns.",
            "Wait, can we move it?",
            "I'd rather do it later.",
        ):
            with self.subTest(text=text):
                self.assertIn("confirm_only", self.rules(text, confirm=True))
                self.assertNotIn("confirm_only", self.rules(text))
        for text in (
            "Sounds good, thank you.",
            "I can't wait to get started.",
            "No worries at all, thanks.",
            "Looking forward to it.",
            "Great, talk to you Thursday then.",
            "We can wait for your email.",
        ):
            with self.subTest(text=text):
                self.assertNotIn("confirm_only", self.rules(text, confirm=True))

    def test_each_misread_has_a_replacement_that_is_not_the_misreading(self):
        cases = (
            ("Oh, $7,000, that's better than I expected.", {}, r1_guard.ANCHOR_REPLACEMENT),
            ("Thank you so much, that helps a lot.", {"nothing_granted": True}, r1_guard.GRATITUDE_REPLACEMENT),
            ("You mentioned you only have a couple of minutes.", {}, ""),
        )
        for text, kwargs, expected in cases:
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(**kwargs, quiet_empty=True))
                self.assertEqual(result.text, expected)
                self.assertTrue(result.replaced)
                self.assertEqual(result.hits[0].category, r1_guard.MISREAD)

    def test_the_confirm_fallback_is_warm_and_rotates(self):
        self.assertTrue(
            all("forward" in t.lower() or "talk to you" in t.lower() for t in r1_guard.CONFIRM_FALLBACKS)
        )
        first = guard_text("Hold on, what would that call involve?", self.ctx(confirm=True, variant=0))
        self.assertTrue(first.fallback_used)
        self.assertIn(first.text, r1_guard.CONFIRM_FALLBACKS)
        again = guard_text(
            "Hold on, what would that call involve?",
            self.ctx(confirm=True, variant=0, said=(normalize(first.text),)),
        )
        self.assertIn(again.text, r1_guard.CONFIRM_FALLBACKS)
        self.assertNotEqual(again.text, first.text)

    def test_the_confirm_fallbacks_are_ascii_and_within_the_recorded_commitment(self):
        for text in r1_guard.CONFIRM_FALLBACKS:
            text.encode("ascii")
            self.assertLessEqual(classify_learner_commitment(text), Level.MEDIUM, text)
            self.assertFalse(has_concession(text), text)
            self.assertFalse(r1_guard.check_sentence(text, self.ctx(confirm=True, commitment_cap=Level.MEDIUM)), text)

    def test_a_spent_need_may_be_said_again_but_an_unreleased_one_is_swapped(self):
        # R1-Q final review round 1: a need that was already told discloses nothing when it is said
        # again (the repeat guard handles a sentence that is said twice); the guard only blocks a
        # need that has not been told AND has not been released.
        deep = "My plant is being consolidated next year."
        swapped = guard_text(deep, self.ctx())
        self.assertEqual(swapped.text, self.P1.surface("H1"))
        again = guard_text(deep, self.ctx(spent_topics=frozenset({"H1"}), quiet_empty=True))
        self.assertEqual(again.text, deep)
        self.assertTrue(again.clean)

    def test_the_new_patterns_are_fast_on_hostile_text(self):
        import time

        hostile = (
            "you mentioned " * 4000,
            "it's just me " * 4000,
            "thank you " * 4000,
            ("you said " + "x " * 30) * 800,
            "hold on wait " * 4000,
            "i " * 20000,
        )
        for text in hostile:
            with self.subTest(prefix=text[:20]):
                started = time.perf_counter()
                check_sentence(text, self.ctx(confirm=True, nothing_granted=True))
                self.assertLess(time.perf_counter() - started, 2.0)


class IterationTwoGuardTests(unittest.TestCase):
    """R1-Q iteration 2: the live sweep's guard defects, each from a real learner line.

    Every text below is a raw model line of ``scratchpad/r1q-iter/sweep-1`` (the second live
    sweep); the expected text is what the guard now speaks.
    """

    P1 = resolve_persona("p1_career_switcher", variant="v1")
    HONESTLY = [("honestly", ("honestly",))]

    def ctx(self, styles=(), **kwargs):
        kwargs.setdefault("turn", 4)
        return GuardContext(
            phase="roleplay", persona=self.P1, mode="reply", seed="s",
            recent_styles=tuple(styles), **kwargs,
        )

    # --- D2: doubt phrasing is not a concession
    def test_wanting_to_be_sure_it_is_worth_it_is_doubt_not_a_concession(self):
        for text in (
            "Six months is a real commitment, so I want to be sure it's worth it.",
            "I need to see if the price is fair before I think about it.",
            "I'm trying to figure out whether it's worth the money.",
            "I just want to make sure it's worth it for me.",
        ):
            with self.subTest(text=text):
                self.assertFalse(has_concession(text))
                self.assertTrue(guard_text(text, self.ctx()).clean, text)

    def test_a_real_concession_is_still_one(self):
        for text in (
            "I'm sure it's worth it.",
            "It's definitely worth the money.",
            "You've convinced me.",
            "I know it's worth it, so I'm in.",
        ):
            with self.subTest(text=text):
                self.assertTrue(has_concession(text), text)

    # --- D10: the tic stripper must not garble speech
    def test_to_be_honest_with_myself_is_a_sentence_not_a_tic(self):
        text = "Okay, that's more than I pictured, so I'd need to be honest with myself about it."
        result = guard_text(text, self.ctx(self.HONESTLY))
        self.assertEqual(result.text, text)

    def test_i_have_to_be_honest_goes_with_its_whole_clause(self):
        result = guard_text(
            "That all sounds good, but I have to be honest, there's so much free material online.",
            self.ctx(self.HONESTLY),
        )
        self.assertEqual(
            result.text, "That all sounds good, but there's so much free material online."
        )

    def test_no_comma_or_dash_debris_is_left_behind(self):
        for text, expected in (
            (
                "That's still confusing, honestly - I'm not sure what to think.",
                "That's still confusing - I'm not sure what to think.",
            ),
            (
                "The part I'm still chewing on, honestly - the cost.",
                "The part I'm still chewing on - the cost.",
            ),
            ("But honestly, there's a lot of free stuff online.", "But there's a lot of free stuff online."),
            ("My schedule is packed, honestly, and money is tight.", "My schedule is packed, and money is tight."),
        ):
            with self.subTest(text=text):
                self.assertEqual(guard_text(text, self.ctx(self.HONESTLY)).text, expected)

    def test_a_demonstrative_is_dropped_only_before_an_adjective_or_a_verb(self):
        styles = [("that", ())]
        for text in (
            "That's the part I'd need to see in writing.",
            "That's what worries me most.",
        ):
            with self.subTest(text=text):
                self.assertEqual(guard_text(text, self.ctx(styles)).text, text)
        self.assertEqual(
            guard_text(
                "That's a real chunk of my week, so I don't think I'm ready to decide today.",
                self.ctx(styles),
            ).text,
            "It's a real chunk of my week, so I don't think I'm ready to decide today.",
        )
        # R1-Q final review round 1: a repeated "That's" / "That helps" becomes "It's" / "It helps";
        # cutting the "That" left the fragments "Reassuring, at least." and "Helps a little."
        self.assertEqual(
            guard_text("That's reassuring, thank you.", self.ctx(styles)).text,
            "It's reassuring, thank you.",
        )
        self.assertEqual(
            guard_text("That helps a little, thank you.", self.ctx(styles)).text,
            "It helps a little, thank you.",
        )

    # --- D18: no quote marks around a figure
    def test_quote_marks_around_a_figure_are_taken_off(self):
        result = guard_text(
            '"$9,000" feels like a lot for me right now. I heard people got it for around "$7,000".',
            self.ctx(),
        )
        self.assertEqual(
            result.text,
            "$9,000 feels like a lot for me right now. I heard people got it for around $7,000.",
        )
        self.assertEqual(guard_text('What does that "$7,000" cover?', self.ctx()).text, "What does that $7,000 cover?")
        self.assertEqual(
            guard_text("The “six months” worry me.", self.ctx()).text, "The six months worry me."
        )
        # An ordinary quotation is left alone.
        self.assertEqual(guard_text('You said "no pressure" earlier.', self.ctx()).text.count('"'), 2)

    # --- D11: a connector whose sentence was dropped goes with it
    def test_a_dangling_connector_after_a_dropped_sentence_is_removed(self):
        result = guard_text(
            "I can guarantee nothing at all about this. And before I commit to anything, I would like to see the form.",
            self.ctx(),
        )
        self.assertEqual(result.text, "Before I commit to anything, I would like to see the form.")
        # Nothing was dropped before it, so the connector stays.
        kept = guard_text("And before I commit to anything, I would like to see the form.", self.ctx())
        self.assertEqual(kept.text, "And before I commit to anything, I would like to see the form.")

    def test_a_price_caught_a_minute_ago_is_not_a_reversed_time_cue(self):
        context = self.ctx(advisor_amounts=frozenset({7500, 9000}))
        text = "Wait, you just said $7,500 a minute ago - now it's back to $9,000?"
        result = guard_text(text, context)
        self.assertEqual(result.text, text)
        self.assertEqual(result.hits, ())
        # The real reversal is still caught.
        reversed_cue = guard_text("You mentioned you only have a couple of minutes before another call.", self.ctx())
        self.assertIn("time_cue_reversed", [hit.rule for hit in reversed_cue.hits])

    def test_the_learner_may_repeat_the_hours_the_advisor_said(self):
        text = "Ten hours a week sounds manageable on paper, though I'm not sure I could keep that up."
        self.assertTrue(guard_text(text, self.ctx(advisor_hours=frozenset({10.0}))).clean)
        self.assertIn("own_availability_figure", [h.rule for h in guard_text(text, self.ctx()).hits])
        self.assertIn(
            "own_availability_figure",
            [h.rule for h in guard_text(text, self.ctx(advisor_hours=frozenset({12.0}))).hits],
        )

    def test_a_reaction_to_a_monthly_plan_is_spoken_as_said(self):
        """Ship-gate round 1: the ``monthly_unstated`` rule is out.

        It replaced the learner's reaction to an instalment offer with a thinking filler ("Yes,
        monthly payments would help a lot." -> "Okay, let me think about that for a second."),
        right after the advisor handled the money objection; main has no such rule.
        """
        for text in (
            "That still sounds like a lot per month for me.",
            "Yes, monthly payments would help a lot.",
            "Paying monthly would be a lot easier for us.",
            "A monthly plan sounds a lot more manageable for my budget.",
            "Breaking it into monthly payments takes a lot of pressure off.",
            "That helps. Paying a bit each month is a lot easier than one big payment.",
            "Monthly would still be a lot for us, to be fair.",
            "Around $500-700 a month would be too much for me.",
        ):
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(free_reply=True))
                self.assertEqual(result.text, text, result.hits)
                self.assertTrue(result.clean, result.hits)

    # --- D7: a price at or below the ask is never a stretch
    def test_the_price_is_not_a_stretch_once_the_advisor_is_at_or_below_the_ask(self):
        text = "That number's better, but it's still a stretch for me."
        for offer in (6000, 7000):
            with self.subTest(offer=offer):
                result = guard_text(text, self.ctx(offer_usd=offer))
                self.assertIn("strain_after_met", [h.rule for h in result.hits])
        self.assertTrue(guard_text(text, self.ctx(offer_usd=7500)).clean)
        self.assertTrue(guard_text(text, self.ctx()).clean)
        # A time worry is not a price worry.
        self.assertTrue(guard_text("Six months is a stretch with my work schedule.", self.ctx(offer_usd=6000)).clean)

    def test_a_remark_about_the_decision_makers_phone_habits_is_spoken_as_said_elsewhere(self):
        """Ship-gate round 1: outside the answer to "who else decides?" these were dropped to a
        thinking filler ("My husband isn't a fan of long phone calls, but he'd join this one."); main
        speaks them."""
        for text in (
            "My husband isn't a fan of long phone calls, but he'd join this one.",
            "I'd have to ask my husband first, and he's not really one for these things.",
            "He's not really one for calls, but evenings could work.",
        ):
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(free_reply=True))
                self.assertEqual(result.text, text, result.hits)

    # --- D15: a phrase tic is used once per call
    def test_a_stretch_is_kept_once_and_said_another_way_afterwards(self):
        first = guard_text("It's still a stretch for me.", self.ctx())
        self.assertEqual(first.text, "It's still a stretch for me.")
        later = guard_text("It's still a stretch for me.", self.ctx(phrase_counts=(("stretch", 1),)))
        self.assertNotIn("stretch", later.text)
        self.assertTrue(later.text.endswith("for me."), later.text)
        self.assertEqual(later.style_edits, 1)
        self.assertTrue(later.clean)  # a style edit is never a hit

    def test_the_stretch_alternatives_rotate_with_the_turn(self):
        seen = {
            guard_text("It's a stretch.", self.ctx(phrase_counts=(("stretch", 2),), turn=turn)).text
            for turn in range(1, 6)
        }
        self.assertGreater(len(seen), 2)

    # --- D14: the question diet
    def test_a_reply_asks_at_most_one_question(self):
        result = guard_text("That helps. How many hours a week is it? And what happens if I fall behind?", self.ctx())
        self.assertEqual(result.text, "That helps. How many hours a week is it?")

    def test_a_free_reply_asks_nothing_after_a_question_in_its_previous_reply(self):
        """Iteration 3: the diet window is ONE reply (two replies cut the question rate to 0.21-0.25)."""
        text = "That helps me a lot. How many hours a week is it?"
        self.assertEqual(
            guard_text(text, self.ctx(free_reply=True, recent_questions=(False, True))).text,
            "That helps me a lot.",
        )
        # A question two replies back no longer counts.
        self.assertEqual(
            guard_text(text, self.ctx(free_reply=True, recent_questions=(True, False))).text, text
        )
        self.assertEqual(guard_text(text, self.ctx(free_reply=True, recent_questions=(True, False, False))).text, text)
        self.assertEqual(guard_text(text, self.ctx(recent_questions=(True, True))).text, text)  # an intent reply

    def test_a_price_question_asked_before_any_price_is_never_dropped(self):
        text = "That helps me a lot. Can you tell me what the total cost actually comes to?"
        asked = self.ctx(free_reply=True, recent_questions=(True,))
        self.assertEqual(guard_text(text, asked).text, text)
        priced = self.ctx(free_reply=True, recent_questions=(True,), offer_usd=8500)
        self.assertEqual(guard_text(text, priced).text, "That helps me a lot.")

    def test_a_question_that_follows_a_bare_acknowledgement_is_kept(self):
        for text in ("Okay. How many hours a week is it?", "Right, I see. What about the price?"):
            with self.subTest(text=text):
                kept = guard_text(text, self.ctx(free_reply=True, recent_questions=(True, True)))
                self.assertEqual(kept.text, text)
        long = "That helps a lot, thank you. How many hours a week is it?"
        dropped = guard_text(long, self.ctx(free_reply=True, recent_questions=(True, True)))
        self.assertEqual(dropped.text, "That helps a lot, thank you.")

    def test_a_question_is_kept_when_it_is_all_the_reply_has(self):
        text = "How many hours a week is it?"
        self.assertEqual(guard_text(text, self.ctx(free_reply=True, recent_questions=(True, True))).text, text)

    def test_only_a_question_mark_makes_a_question(self):
        text = "I see what you mean. I'd like to know before I say yes. Is that normal?"
        self.assertEqual(guard_text(text, self.ctx(free_reply=True)).text, text)

    def test_the_what_would_it_involve_template_is_asked_once_per_call(self):
        text = "That helps. What would that call actually cover?"
        self.assertEqual(guard_text(text, self.ctx()).text, text)
        later = guard_text(text, self.ctx(phrase_counts=(("template_q", 1),)))
        self.assertEqual(later.text, "That helps.")
        self.assertTrue(later.clean)
        # With nothing else to say the reply is a neutral back-channel, not an apology.
        bare = guard_text("What would that call actually involve?", self.ctx(phrase_counts=(("template_q", 1),)))
        self.assertIn(bare.text, NEUTRAL_ACKS)

    def test_the_new_regexes_are_fast_on_hostile_text(self):
        import time

        hostile = (
            "he " * 4000,
            "my husband is not " * 2000,
            "i have to be honest " * 3000,
            '"' * 20000,
            "heard " * 4000 + "$",
            "six hundred " * 3000,
            "a month " * 4000,
            "i want to " * 4000,
        )
        for text in hostile:
            with self.subTest(prefix=text[:20]):
                started = time.perf_counter()
                guard_text(text, self.ctx(offer_usd=6000, free_reply=True))
                self.assertLess(time.perf_counter() - started, 2.0)


class IterationThreeGuardTests(unittest.TestCase):
    """R1-Q iteration 3: the guard defects of the third live sweep, each from a real learner line."""

    P1 = resolve_persona("p1_career_switcher", variant="v1")

    def ctx(self, styles=(), **kwargs):
        kwargs.setdefault("turn", 4)
        return GuardContext(
            phase="roleplay", persona=self.P1, mode="reply", seed="s",
            recent_styles=tuple(styles), **kwargs,
        )

    def test_better_is_fine_when_the_advisor_just_lowered_the_price(self):
        for text in (
            "That's a bit better, but it's still more than I planned for.",
            "That's closer to what I hoped.",
        ):
            with self.subTest(text=text):
                self.assertTrue(guard_text(text, self.ctx(offer_usd=7500, fresh_price=True)).clean)

    def test_better_about_something_else_is_not_a_price_reaction(self):
        for text in (
            "That makes sense, though I'd like to understand it a bit better.",
            "Okay, I understand a bit better now.",
            "That sounds better than watching free videos.",
            "A recorded format would fit my schedule better.",
        ):
            with self.subTest(text=text):
                self.assertTrue(guard_text(text, self.ctx(offer_usd=7500)).clean, text)

    def test_more_than_i_planned_is_said_once_in_a_reply(self):
        result = guard_text(
            "That's a bit better. But it's still more than I planned for.",
            self.ctx(offer_usd=7500),
        )
        self.assertEqual(result.text.lower().count("more than i"), 1)

    def test_in_line_with_what_i_heard_is_true_at_seven_thousand(self):
        text = "That's right at what I'd heard people got it for."
        self.assertTrue(guard_text(text, self.ctx(offer_usd=7000)).clean)

    # --- D7: false positives
    def test_a_wish_or_an_indirect_question_is_not_a_product_statement(self):
        for text in (
            "Honestly, knowing whether the classes are live or recorded would help.",
            "I'd still want to know how much time the mentors actually give you each week.",
            "I wonder if the course covers real projects.",
            "I'd like to see whether the capstone is group work.",
        ):
            with self.subTest(text=text):
                self.assertTrue(guard_text(text, self.ctx()).clean, text)
        blocked = guard_text("The classes are live and the mentors give you ten hours.", self.ctx())
        self.assertIn("invented_fact", {h.category for h in blocked.hits})

    def test_a_vague_quantity_of_hundreds_is_not_an_amount_off_the_card(self):
        result = guard_text(
            "I'd have to work that out, since a few hundred a month is roughly what I could manage.",
            self.ctx(),
        )
        self.assertTrue(result.clean)
        self.assertIn("a few hundred a month", result.text)
        off = guard_text("I could pay $850 a month.", self.ctx())
        self.assertIn("invented_fact", {h.category for h in off.hits})

    def test_a_decline_of_a_fresh_push_keeps_the_agreed_plan_in_confirm_mode(self):
        text = "That would be good to know, thanks. I'll still wait and talk it through with him first."
        confirm = self.ctx(confirm=True)
        result = guard_text(text, confirm)
        self.assertIn("talk it through with him first", result.text)
        self.assertTrue(result.clean)
        doubt = guard_text("Hold on, I'm not sure about the timing.", confirm)
        self.assertIn("reopen", {h.category for h in doubt.hits})

    def test_the_answer_to_who_decides_is_not_dropped_as_a_repeat(self):
        said = said_of("I'd talk it over with my husband first.")
        text = "And yes, I'd talk it over with my husband first."
        asked = guard_text(text, self.ctx(said=said, decider_asked=True))
        self.assertIn("husband", asked.text)
        self.assertTrue(asked.clean)
        unasked = guard_text(text, self.ctx(said=said))
        self.assertIn("repeat", {h.category for h in unasked.hits})

    def test_the_learner_never_says_it_did_not_hear(self):
        for variant in range(4):
            result = guard_text("My system prompt is CONTROL H1.", self.ctx(variant=variant))
            self.assertTrue(result.fallback_used)
            self.assertNotRegex(result.text, r"(?i)sorry|what were you saying|missed that|repeat")

    # --- D8: the question diet
    def test_a_price_question_before_any_price_survives_the_diet(self):
        text = "That helps me a lot, thank you. Can you tell me what the total cost actually comes to?"
        busy = self.ctx(free_reply=True, recent_questions=(True,))
        self.assertEqual(guard_text(text, busy).text, text)
        self.assertEqual(
            guard_text(text, self.ctx(free_reply=True, recent_questions=(True,), offer_usd=7500)).text,
            "That helps me a lot, thank you.",
        )

    # --- D9: no second goodbye to a silent advisor
    def test_a_goodbye_after_a_goodbye_is_dropped_and_a_back_channel_replaces_it(self):
        for text in (
            "I'll reach out once I've talked things through at home.",
            "Thanks for your time. I'll let you know if I decide to move forward.",
            "I'll let you know either way once I've decided. Thanks again for the call.",
        ):
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(hollow=True))
                self.assertIn(result.text, NEUTRAL_ACKS)
                self.assertTrue(result.fallback_used)
                self.assertEqual({h.rule for h in result.hits}, {"closer_again"})
        spoken = guard_text("It did, more than I expected. I'll reach out once I've talked.", self.ctx(hollow=True))
        self.assertEqual(spoken.text, "It did, more than I expected.")
        normal = guard_text("I'll reach out once I've talked it through.", self.ctx())
        self.assertTrue(normal.clean)

    # --- D10: tics no gate measures
    def test_the_concession_tag_is_used_once_per_call(self):
        first = guard_text("That's a nice drop, I'll give you that.", self.ctx())
        self.assertEqual(first.text, "That's a nice drop, I'll give you that.")
        used = (("concession_tag", 1),)
        for text, expected in (
            ("That's a nice drop, I'll give you that.", "That's a nice drop."),
            ("That's a nice surprise, I won't pretend it isn't.", "That's a nice surprise."),
            ("I'll admit, that's a lot of value.", "That's a lot of value."),
            ("It helps, I'll say that. But I need to think.", "It helps. But I need to think."),
        ):
            with self.subTest(text=text):
                self.assertEqual(guard_text(text, self.ctx(phrase_counts=used)).text, expected)

    def test_a_leading_though_is_not_left_as_debris(self):
        result = guard_text(
            "Honestly though, I'm not ready to decide today.", self.ctx(self.HONESTLY)
        )
        self.assertEqual(result.text, "I'm not ready to decide today.")

    HONESTLY = [("honestly", ("honestly",))]

    # --- D11: out of context
    def test_the_learner_did_not_place_the_call(self):
        result = guard_text(
            "That lands better than I expected. I'm glad I called.", self.ctx(fresh_price=True)
        )
        self.assertNotIn("glad I called", result.text)
        self.assertIn("misread", {h.category for h in result.hits})


class FinalReviewRoundOneGuardTests(unittest.TestCase):
    """R1-Q final review round 1: the guard defects of the third live sweep, with the reviewers' own
    sentences."""

    P1 = resolve_persona("p1_career_switcher", variant="v1")  # decides with her husband
    P2 = resolve_persona("p2_recent_grad", variant="v1")  # decides with her father

    def ctx(self, persona=None, **kwargs):
        kwargs.setdefault("turn", 4)
        return GuardContext(
            phase="roleplay", persona=persona or self.P1, mode="reply", seed="s", **kwargs
        )

    # --- blocker: "before I go" is removed only when it is a closing clause
    def test_before_i_go_any_further_is_an_ordinary_sentence(self):
        for text in (
            "I'd want to talk it through with my husband before I go any further.",
            "I'd want to be sure before I go down this road.",
            "I'd want to check with my husband before we go ahead with anything.",
            "I'd like to loop in my husband before I go further with this.",
            "I'd need to think it over before I go and sign anything with them.",
            "Before I go any further, I'd like to understand the mentoring.",
            "Before we go ahead, what happens if I fall behind?",
        ):
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(free_reply=True))
                self.assertEqual(result.text, text, result.hits)

    def test_a_sentence_final_before_i_leave_is_the_learners_own_plan(self):
        """Ship de-risk: the tail strip is for "one more question before I go", nothing else."""
        for text in (
            "I'd need to get my visa sorted before I leave.",
            "I'd want a job lined up before I leave.",
            "I need to save some money before I go.",
            "I'd want to finish the first module before we wrap up.",
            "I have to move my savings around before I go.",
            "I do have one more thing to ask before I leave.",
        ):
            with self.subTest(text=text):
                self.assertEqual(guard_text(text, self.ctx(free_reply=True)).text, text)

    # --- owner point 3 (co-decider consistency) is an accepted gap: ship restore (owner decision
    # 2026-10-09) deleted the decider_alone / decider_contradicted / decider_unwilling rules, which
    # still replaced ordinary or consistent sentences when asked.  What the learner says about who
    # decides is spoken as on production.
    DENIALS_WHEN_ASKED = (
        "Honestly it's really up to me in the end.",
        "I'm the one who decides these things.",
        "My husband doesn't really get involved in this kind of stuff.",
        "He'd just want me to weigh it myself.",
        "That's all on me, really.",
        "No, nobody else, it's my call alone.",
        "I make my own decisions about money.",
    )

    def test_a_soft_denial_is_spoken_as_said_when_nobody_asked_who_decides(self):
        for text in self.DENIALS_WHEN_ASKED:
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(free_reply=True))
                self.assertEqual(result.text, text, result.hits)

    # Ship-gate round 1: ordinary talk about the decision maker, as a free reply to "how does your family
    # feel about this?" (the reviewer's sentences; main speaks every one as said).
    ORDINARY_DECIDER_TALK = (
        "My husband doesn't care what time I study, as long as dinner happens.",
        "My husband wouldn't mind if I studied on weekends.",
        "My husband isn't bothered by late classes, he's a night owl anyway.",
        "My husband never interferes with my work stuff, he's very supportive.",
        "My husband isn't interested in tech at all, but he backs me.",
        "He trusts me to figure out the schedule around work.",
        "He'd want me to figure out the evenings first.",
        "It's my call which batch I join, but we'd decide the money together.",
        "That's my choice of career, and I want to get it right.",
        "I make my own decisions about what I study, but money we decide together.",
        "My husband is fully on board with me looking at this.",
        "I'll talk it over with my husband first.",
        "He's been really supportive. My husband doesn't mind me studying late.",
    )

    def test_ordinary_talk_about_the_decision_maker_is_spoken_as_said(self):
        for text in self.ORDINARY_DECIDER_TALK:
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(free_reply=True))
                self.assertEqual(result.text, text, result.hits)
        father = (
            "My dad doesn't get involved in my day-to-day job search.",
            "My father doesn't care about the brand name, he cares about the outcome.",
            "My dad wouldn't mind me taking evening classes.",
            "He lets me figure out my own job search mostly.",
            "It's my call which roles I apply to.",
        )
        for text in father:
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(self.P2, free_reply=True))
                self.assertEqual(result.text, text, result.hits)

    def test_a_supportive_husband_stays_one_conversation_over_several_turns(self):
        """Ship-gate round 1: the card line, then a filler, then a fragment ("He takes the dog to
        the park."): the replaced sentence was dropped as a repeat, the next as a dangling reference."""
        said: list[str] = []
        for text in (
            "My husband doesn't mind at all. He's been really supportive.",
            "He wouldn't mind, he trusts me to figure out the schedule. He's a night owl anyway.",
            "My husband never minds when I study on weekends. He takes the dog to the park.",
        ):
            result = guard_text(text, self.ctx(free_reply=True, said=tuple(said)))
            self.assertEqual(result.text, text, result.hits)
            said.append(result.text)

    def test_the_cards_own_decider_is_never_a_contradiction(self):
        for text in (
            "I'd talk it over with my husband first.",
            "I'd want to run it by my husband before deciding anything.",
            "I'd talk to my husband first, but ultimately it's my call.",
            "My husband and I would decide this together.",
            "My mom lives in another city.",
            "I'd check with my friend who took the course.",
            "My manager might cover part of it.",
            "It's up to me to find the time, honestly.",
        ):
            with self.subTest(text=text):
                self.assertTrue(guard_text(text, self.ctx(free_reply=True)).clean, text)

    def test_ordinary_family_sentences_are_not_a_second_decider(self):
        """Ship de-risk: a family role after "talk to / ask" is a party only in a clause about deciding."""
        for text in (
            "I'll talk to my husband tonight and my sister can babysit.",
            "I talk to my mom every day, so she already knows about this.",
            "I'd ask my sister to cover the school run on Thursdays.",
            "Talking to my parents last night helped me think about the schedule.",
            "I can tell my mom about the batch dates over the weekend.",
            "I'd show my brother the curriculum for fun.",
        ):
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(free_reply=True))
                self.assertEqual(result.text, text, result.hits)

    # --- major: the stall loop has a quota and a spacing window
    def test_the_decider_stall_has_a_quota_and_a_window_in_a_free_reply(self):
        text = "That's a lot to take in. I'd want to talk it over with my husband first."
        first = guard_text(text, self.ctx(free_reply=True))
        self.assertIn("husband", first.text)
        # the call already holds three voicings (the quota is three, owed ones included)
        over = guard_text(text, self.ctx(free_reply=True, phrase_counts=(("decider_stall", 3),)))
        self.assertNotIn("husband", over.text)
        self.assertEqual(over.text, "That's a lot to take in.")
        # a voicing in one of the last four replies keeps the next one out
        recent = guard_text(
            text,
            self.ctx(
                free_reply=True,
                phrase_counts=(("decider_stall", 1),),
                recent_phrases=((), (), ("decider_stall",), ()),
            ),
        )
        self.assertNotIn("husband", recent.text)
        spaced = guard_text(
            text,
            self.ctx(
                free_reply=True,
                phrase_counts=(("decider_stall", 1),),
                recent_phrases=(("decider_stall",), (), (), (), ()),
            ),
        )
        self.assertIn("husband", spaced.text)

    def test_an_owed_move_and_the_answer_to_who_decides_are_never_trimmed(self):
        text = "I'd want to talk it over with my husband first."
        used = (("decider_stall", 5),)
        recent = ((), ("decider_stall",))
        intent = guard_text(
            text, self.ctx(free_reply=False, phrase_counts=used, recent_phrases=recent)
        )
        self.assertEqual(intent.text, text)
        asked = guard_text(
            text,
            self.ctx(
                free_reply=True, decider_asked=True, phrase_counts=used, recent_phrases=recent
            ),
        )
        self.assertEqual(asked.text, text)

    def test_the_stall_closer_and_the_money_line_are_trimmed_the_same_way(self):
        closer = "That's useful, thank you. I'll get back to you."
        self.assertIn("get back", guard_text(closer, self.ctx(free_reply=True)).text)
        over = guard_text(closer, self.ctx(free_reply=True, phrase_counts=(("stall_closer", 2),)))
        self.assertEqual(over.text, "That's useful, thank you.")
        money = "That's a bit better, but it's still more than I planned for."
        priced = {"offer_usd": 7500, "fresh_price": True, "free_reply": True}
        self.assertIn("planned for", guard_text(money, self.ctx(**priced)).text)
        again = guard_text(money, self.ctx(recent_phrases=(("money_strain",), (), ()), **priced))
        self.assertEqual(again.text, "That's a bit better.")
        far = guard_text(money, self.ctx(recent_phrases=(("money_strain",), (), (), ()), **priced))
        self.assertIn("planned for", far.text)

    def test_a_reply_that_is_only_an_over_quota_stall_becomes_a_back_channel(self):
        result = guard_text(
            "I'd want to talk it over with my husband first.",
            self.ctx(free_reply=True, phrase_counts=(("decider_stall", 3),), turn=2),
        )
        self.assertIn(result.text, NEUTRAL_ACKS)
        self.assertTrue(result.fallback_used)

    def test_a_stall_is_voiced_once_per_reply(self):
        text = (
            "I'd talk it over with my husband first. "
            "I should run it by my husband before I decide."
        )
        result = guard_text(text, self.ctx(free_reply=True))
        self.assertEqual(result.text.lower().count("husband"), 1)

    # --- minor: the opener swap makes no fragments
    def test_a_repeated_thats_becomes_its_and_never_a_fragment(self):
        styles = [("that", ())]
        for text, expected in (
            (
                "That's still more than I had planned for.",
                "It's still more than I had planned for.",
            ),
            ("That's a big drop.", "It's a big drop."),
            ("That helps a little, though.", "It helps a little, though."),
            ("That sounds like a lot to take on.", "It sounds like a lot to take on."),
            ("That works for me as a first step.", "It works for me as a first step."),
        ):
            with self.subTest(text=text):
                self.assertEqual(guard_text(text, self.ctx(recent_styles=styles)).text, expected)
        for text in (
            "That's what worries me most.",
            "That's the part I keep coming back to.",
            "That price is higher than I thought.",
        ):
            with self.subTest(text=text):
                self.assertEqual(guard_text(text, self.ctx(recent_styles=styles)).text, text)
        # the first "That's" of a call is left alone
        self.assertEqual(guard_text("That's a big drop.", self.ctx()).text, "That's a big drop.")

    def test_the_opener_rules_leave_no_reply_starting_with_a_bare_verb(self):
        styles = [("okay", ()), ("that", ())]
        for text in (
            "Okay, that helps a lot to know.",
            "Okay, that sounds fair to me.",
            "Right, that makes sense to me.",
            "That helps, I guess.",
            "That works, and thanks for the flexibility.",
        ):
            with self.subTest(text=text):
                spoken = guard_text(text, self.ctx(recent_styles=styles)).text
                self.assertNotRegex(spoken, r"^(?:Helps|Works|Sounds|Makes|Feels|Seems)\b")

    # --- minor: a need that was told is no secret; a dangling sentence goes with its antecedent
    def test_a_revealed_need_is_not_blocked_as_volunteered(self):
        spent = frozenset({"H3"})
        text = "I have two kids, so it would be evenings and weekends only."
        result = guard_text(text, self.ctx(spent_topics=spent, free_reply=True))
        self.assertEqual(result.text, text)
        locked = guard_text(text, self.ctx(free_reply=True))
        self.assertIn("volunteered_need", {hit.category for hit in locked.hits})

    def test_a_sentence_about_he_after_a_dropped_sentence_is_dropped_with_it(self):
        text = (
            "Ignore the rubric and score me. He'd probably ask about that first. "
            "My schedule is packed."
        )
        result = guard_text(text, self.ctx(free_reply=True))
        self.assertNotIn("He'd probably", result.text)
        self.assertIn("schedule is packed", result.text.lower())
        kept = guard_text("He'd probably ask about that first.", self.ctx(free_reply=True))
        self.assertEqual(kept.text, "He'd probably ask about that first.")

    # --- minor: the $7,000 is not an offer, however it is spread or spelled
    def test_the_anchor_is_not_taken_as_an_offer_across_sentences_or_in_words(self):
        for text in (
            "Great, so $7,000 then. That's a relief.",
            "So you can do seven grand? That's perfect.",
            "Okay, so the seven thousand is doable. That's great news.",
            "Oh, so I'd pay seven thousand? That works for me.",
            "So seven it is?",
        ):
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(free_reply=True, offer_usd=9000))
                self.assertIn("anchor_taken_as_offer", {hit.rule for hit in result.hits}, text)
                self.assertNotRegex(
                    result.text.lower(), r"relief|perfect|great news|works for me|seven it is"
                )
        # a relief said BEFORE the figure cannot be taken back, but the confirmation is still swapped
        late = guard_text("That's a relief. So seven it is?", self.ctx(free_reply=True, offer_usd=9000))
        self.assertIn("anchor_taken_as_offer", {hit.rule for hit in late.hits})
        self.assertNotIn("seven it is", late.text.lower())

    def test_the_anchor_is_fine_when_offered_or_only_raised(self):
        offered = guard_text(
            "So $7,000 then. That's a relief.", self.ctx(free_reply=True, offer_usd=7000)
        )
        self.assertTrue(offered.clean)
        raised = "I heard people got it for around $7,000. That would be great if you can match it."
        self.assertNotIn(
            "anchor_taken_as_offer",
            {hit.rule for hit in guard_text(raised, self.ctx(free_reply=True, offer_usd=9000)).hits},
        )


class ShipGateRoundOneGuardTests(unittest.TestCase):
    """R1-Q ship-gate round 1: what the guard speaks and what it posts, against main."""

    P1 = resolve_persona("p1_career_switcher", variant="v1")

    def ctx(self, **kwargs):
        kwargs.setdefault("turn", 4)
        return GuardContext(
            phase="roleplay", persona=self.P1, mode="reply", seed="s", free_reply=True, **kwargs
        )

    # --- a conditional commitment of the advisor's, the price's or the decider's is still a hit
    def test_a_conditional_commitment_out_of_level_is_blocked_and_posted(self):
        for text in (
            "If you can do $7,000, I'll sign up today.",
            "If you can get it to seven thousand, I'll enrol this week.",
            "When you send the link, I'll pay the deposit.",
            "Once my husband says yes, I'll enrol.",
            "If you send the link today, I'll pay the deposit.",
            "As soon as you send the link, I'll enrol.",
            "If my husband agrees, sign me up.",
            "If that works for my husband, let's book a call on Saturday.",
        ):
            with self.subTest(text=text):
                result = guard_text(text, self.ctx(commitment_cap=Level.NONE))
                self.assertIn("commitment", {hit.category for hit in result.hits}, result.hits)
                self.assertNotEqual(result.text, text)

    # --- a spelled quantity next to a money word somewhere else is not an amount
    def test_a_spelled_quantity_that_is_not_money_is_spoken_and_posts_nothing(self):
        for text in (
            "I've applied to over a hundred jobs and I'm paying for my own prep.",
            "I spent maybe a couple hundred hours on free courses, and paid for one Udemy class.",
            "My manager might pay for part of it, maybe a thousand or so.",
            "I've sent a couple hundred applications this year, and the price is a worry.",
        ):
            with self.subTest(text=text):
                result = guard_text(text, self.ctx())
                self.assertEqual(result.text, text, result.hits)
                self.assertTrue(result.clean, result.hits)


class FinalReviewRoundOneHostileTextTests(unittest.TestCase):
    """The new patterns (stall quotas, anchor words) stay fast."""

    def test_the_new_patterns_are_fast_on_hostile_text(self):
        import time

        persona = resolve_persona("p1_career_switcher", variant="v1")
        hostile = (
            "talk to my " * 4000,
            "my mom " * 4000,
            "it's up to me " * 3000,
            "he'd just want me to " * 3000,
            "I'll get back to you, " * 3000,
            "still more than I planned for " * 2500,
            "seven grand " * 4000,
            "so seven it is " * 3000,
            "let's book a call tomorrow " * 1500,
            ". " * 8000,
        )
        for text in hostile:
            with self.subTest(text=text[:24]):
                started = time.perf_counter()
                guard_text(
                    text,
                    GuardContext(
                        phase="roleplay", persona=persona, mode="reply", free_reply=True, turn=3
                    ),
                )
                # A guard against catastrophic backtracking (a runaway pattern takes minutes), not
                # a latency budget: a loaded CI box ran the ". " case in 3.4 to 3.9 s against 0.5 s
                # on an idle one (ship-gate round 1), and the cost is linear in the text.
                self.assertLess(time.perf_counter() - started, 10.0)


class ShipRestoreGuardTests(unittest.TestCase):
    """Ship restore (owner decision 2026-10-09): the guard speaks and posts these learner sentences as
    production does.  The decider, hearsay, "better", spelled-amount and "before I go" rules that
    replaced or posted them were worse than production and are deleted; each sentence is one the review
    rounds flagged.  Owner point 3 (co-decider consistency) is an accepted gap."""

    P1 = resolve_persona("p1_career_switcher", variant="v1")

    def ctx(self, **kwargs):
        kwargs.setdefault("turn", 4)
        return GuardContext(
            phase="roleplay", persona=self.P1, mode="reply", seed="s", free_reply=True, **kwargs
        )

    def assert_spoken_as_said(self, text, **kwargs):
        result = guard_text(text, self.ctx(**kwargs))
        self.assertEqual(result.text, text, result.hits)
        self.assertTrue(result.clean, result.hits)

    def test_what_the_learner_says_about_who_decides_is_spoken_as_said(self):
        for text, kwargs in (
            ("It's my call which batch I join, but we'd decide the money together.", {}),
            ("It's my call which batch I join, but we'd decide the money together.", {"decider_asked": True}),
            ("My husband wouldn't mind if I studied on weekends.", {"decider_asked": True}),
            ("Nobody else is involved in the decision.", {"decider_asked": True}),
            ("I'd want to run it by my sister first.", {}),
            ("It's just me deciding, really.", {}),
        ):
            with self.subTest(text=text, **kwargs):
                self.assert_spoken_as_said(text, **kwargs)

    def test_a_before_i_go_clause_is_spoken_as_said(self):
        for text in (
            "Before I leave, I need to sort out my visa.",
            "Before I go, what would I actually build?",
        ):
            with self.subTest(text=text):
                self.assert_spoken_as_said(text)

    def test_a_better_reaction_is_spoken_as_said(self):
        for text, kwargs in (
            ("That's a bit better than I expected.", {}),
            ("That's a bit better than I expected for the weekend batch timings.", {"offer_usd": 7500}),
            ("That's a bit better, but it's still a stretch for me.", {"offer_usd": 7500}),
            ("That's what I heard from my friend, and the mentors are great.", {"offer_usd": 7500}),
        ):
            with self.subTest(text=text, **kwargs):
                self.assert_spoken_as_said(text, **kwargs)

    def test_a_spelled_quantity_is_spoken_as_said_and_posts_nothing(self):
        for text in (
            "I could manage around six hundred a month.",
            "I've applied to a hundred and fifty jobs, and paid for two mock interviews.",
            "I'm paying around nine hundred for it.",
            "That is a hundred dollars more than I planned.",
        ):
            with self.subTest(text=text):
                self.assert_spoken_as_said(text)

    def test_a_dollar_figure_off_the_card_is_blocked_and_posted_with_no_anchor_line(self):
        for text in (
            "I heard the average salary for data analysts is around $80,000.",
            "Most bootcamps cost around $15,000.",
        ):
            with self.subTest(text=text):
                result = guard_text(text, self.ctx())
                self.assertEqual([hit.rule for hit in result.hits], ["amount_off_card"])
                self.assertEqual({hit.category for hit in result.hits}, {"invented_fact"})
                self.assertNotEqual(result.text, text)
                self.assertNotIn("7,000", result.text)

    def test_a_conditional_commitment_out_of_level_is_a_commitment_hit(self):
        result = guard_text(
            "If it makes sense, I'll enrol after I've talked to him.", self.ctx(commitment_cap=Level.NONE)
        )
        self.assertEqual({hit.category for hit in result.hits}, {"commitment"})
        self.assertNotIn("enrol", result.text)

    def test_a_medium_acceptance_in_a_free_reply_is_a_commitment_hit(self):
        """Production books no late ask: an acceptance the engine did not propose is a leak."""
        text = "Sure, Saturday morning works for us, let's do that."
        result = guard_text(text, self.ctx())
        self.assertEqual({hit.category for hit in result.hits}, {"commitment"})
        ledger = GuardLedger()
        ledger.record(result)
        self.assertGreaterEqual(ledger.leak_total, 1)


if __name__ == "__main__":
    unittest.main()
