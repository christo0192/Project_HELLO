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
        self.assertTrue(
            guard_text("Let me think about it. Just email me the details.", context).clean
        )

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
        from r1_commitment import COMMITMENT_LINES

        for level in (Level.STRONG, Level.MEDIUM):
            line = COMMITMENT_LINES[level].format(decision_maker="husband")
            self.assertIn("commitment", categories(line, ctx()))


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
            "I'm not sure, I haven't thought about that.",
            PERSONA.surface("H1"),
        ):
            with self.subTest(answer=answer):
                self.assertTrue(guard_text(answer, context).clean, answer)
        self.assertFalse(guard_text("Around $900 a month.", context).clean)
        self.assertFalse(guard_text("My schedule is packed on weekends.", context).clean)

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
        self.assertEqual(result.text, FALLBACK_REPLY)

    def test_without_control_texts_nothing_is_an_echo(self):
        self.assertTrue(guard_text("Do not volunteer anything.", ctx()).clean)

    def test_interviewer_phases_are_covered_too(self):
        from r1_prompts import control_prose, interviewer_prefix

        context = ctx("wrapup", control_texts=(control_prose(interviewer_prefix()),))
        leaked = "Never ask about age, marital status, children, religion, caste or health."
        self.assertIn("control", categories(leaked, context))

    def test_the_words_the_model_is_meant_to_say_are_not_an_echo(self):
        from r1_commitment import stall_line
        from r1_prompts import control_prose, learner_prefix, turn_reminder

        reminder = turn_reminder(PERSONA, r_sec=10, first_probe_topics=["H1"],
                                 unlocked_topics=["H3"])
        context = ctx(
            released_topics=frozenset({"H3"}),
            control_texts=(control_prose(learner_prefix(PERSONA)), control_prose(reminder)),
        )
        for allowed in (
            stall_line("husband"),
            PERSONA.surface("H1"),
            PERSONA.deep("H3"),
            "I'm not sure, I haven't thought about that.",
            "You can use the email on my form.",
            "Around $500-700 a month.",
        ):
            with self.subTest(allowed=allowed):
                self.assertTrue(guard_text(allowed, context).clean, allowed)

    def test_the_prefix_prose_excludes_the_card_and_quoted_answers(self):
        from r1_prompts import control_prose, learner_prefix

        prose = control_prose(learner_prefix(PERSONA))
        self.assertNotIn("YOUR CARD", prose)
        self.assertNotIn(PERSONA.surface("H1"), prose)
        self.assertNotIn("I'm not sure, I haven't thought about that.", prose)
        self.assertIn("Never state product facts", prose)


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

    def test_only_ack_format_is_outside_the_leak_categories(self):
        self.assertEqual(
            set(r1_guard.CATEGORIES) - set(r1_guard.LEAK_CATEGORIES), {r1_guard.ACK_FORMAT}
        )


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
