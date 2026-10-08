"""Unit tests for ``r1_guard``: leak, fact, contact and commitment coverage in every phase."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_guard
from r1_commitment import Level
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
from r1_text import SpokenMemory
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
            self.assertEqual(result.text, FALLBACK_REPLY)

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
        self.assertEqual(out, [FALLBACK_REPLY])
        self.assertTrue(result.fallback_used)

    def test_the_same_replacement_is_not_spoken_twice(self):
        text = "I have two kids. I also have evenings and weekends only."
        result = guard_text(text, ctx())
        self.assertEqual(result.text, PERSONA.surface("H3"))

    def test_empty_stream_yields_the_fallback(self):
        out, result = self.collect([], ctx())
        self.assertEqual(out, [FALLBACK_REPLY])


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
        self.assertEqual(result.text, FALLBACK_REPLY)

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
            {r1_guard.ACK_FORMAT, r1_guard.REPEAT},
        )
        self.assertEqual(
            r1_guard.HYGIENE_CATEGORIES, frozenset({r1_guard.ACK_FORMAT, r1_guard.REPEAT})
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

    def test_there_are_three_distinct_variants_and_the_first_is_the_classic_line(self):
        self.assertEqual(len(FALLBACK_REPLIES), 3)
        self.assertEqual(len(set(FALLBACK_REPLIES)), 3)
        self.assertEqual(FALLBACK_REPLIES[0], FALLBACK_REPLY)

    def test_without_a_seed_the_learner_starts_with_the_classic_line(self):
        self.assertEqual(self.fallback(), FALLBACK_REPLY)

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


if __name__ == "__main__":
    unittest.main()
