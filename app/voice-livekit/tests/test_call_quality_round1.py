"""Call-quality round 1 (live call 2026-09-03, session 1a22e510) unit tests.

Every case in here is anchored to a defect OBSERVED on that call:

  * the substance gate's 14-word cap discarded a matching 26-word deflection,
    so a non-answer was committed as an answer and the cursor advanced;
  * "Like you're talking about the notice period?" matched NO pattern, so the
    owed joining-availability question was skipped forever;
  * the conflict-probe deflection was never re-pursued (no code path existed);
  * `PHONE_TTS_FLUSH_MIN_CHARS` was hardcoded dead so the deployed secret was
    inert and every turn's latency floor grazed the 4.0 s first-audio watchdog;
  * the queued-scoring handoff dropped the lease and the reclaim sweep marked a
    finished screening `abandoned`.
"""

import unittest
from unittest.mock import patch

import phone


# The candidate's EXACT words from the live transcript.
LIVE_CONFLICT_DEFLECTION = (
    "Yeah, sure, but before that I am not, I don't understand like which "
    "clarification you need. I don't understand what conflicts my answer "
    "and the recipe."
)
LIVE_NOTICE_PERIOD_CHECK = "Like you're talking about the notice period?"
LIVE_CTC_CHECK = "Uh, by CTC what do you mean? You mean LPA, like the total salary that I get?"
LIVE_ETHICAL_SELLING_CHECK = "By the way, what do you mean by ethical consultative selling?"


class TestDeflectionGateOpened(unittest.TestCase):
    """F6 — the gate must classify real deflections at ANY length."""

    def test_the_live_26_word_conflict_deflection_is_a_clarification(self):
        # The regex matched on the live call too — the 14-word cap ALONE
        # discarded it. The cap no longer applies to strong deflections.
        self.assertEqual(
            phone.phone_turn_substance(LIVE_CONFLICT_DEFLECTION),
            phone.PHONE_SUBSTANCE_CLARIFICATION,
        )

    def test_confirm_question_shapes_are_clarifications(self):
        for text in (LIVE_NOTICE_PERIOD_CHECK, LIVE_CTC_CHECK, LIVE_ETHICAL_SELLING_CHECK):
            with self.subTest(text):
                self.assertEqual(
                    phone.phone_turn_substance(text),
                    phone.PHONE_SUBSTANCE_CLARIFICATION,
                )

    def test_confirm_questions_also_route_so_the_cursor_holds(self):
        # `candidate_turn_route` is what the live turn hook consults FIRST; a
        # clarification-shaped confirm question must route (and therefore
        # re-ask) instead of falling through as candidate evidence.
        self.assertEqual(
            phone.candidate_turn_route(LIVE_NOTICE_PERIOD_CHECK), "candidate_question",
        )

    def test_a_long_narrative_containing_you_mean_stays_substantive(self):
        # The weak confirm-question shapes keep a length bound so reported
        # speech inside a genuine story is not misread as a deflection.
        narrative = (
            "So when a prospect is hesitant I first ask what their goals are, "
            "and if you mean the AI programs I sell those every day, so I walk "
            "them through the syllabus, the mentors, the outcomes, and the "
            "placement support until the value is completely concrete for them."
        )
        self.assertGreater(len(narrative.split()), 30)
        self.assertEqual(
            phone.phone_turn_substance(narrative), phone.PHONE_SUBSTANCE_SUBSTANTIVE,
        )

    def test_a_long_answer_with_a_strong_deflection_is_still_a_clarification(self):
        # Owner directive (2026-09-03): the regex must not be blocked by length.
        long_deflection = (
            "Okay so I hear you, and honestly I was trying to follow along with "
            "everything you were saying just now about my background, but I "
            "have to be honest with you here, I don't understand what conflicts "
            "my answer and the resume."
        )
        self.assertGreater(len(long_deflection.split()), 30)
        self.assertEqual(
            phone.phone_turn_substance(long_deflection),
            phone.PHONE_SUBSTANCE_CLARIFICATION,
        )

    # ── Review repairs (2026-09-03): the gate must not EAT real answers ──
    def test_sorry_with_question_mark_is_a_clarification(self):
        # The first draft's `sorry\s*\?` sat inside a \b-closed group; \b after
        # a literal '?' never matches at end-of-utterance, so the canonical
        # didn't-hear-you deflection scored substantive (review find).
        for text in ("Sorry?", "sorry ?", "Sorry? I missed that."):
            with self.subTest(text):
                self.assertEqual(
                    phone.phone_turn_substance(text),
                    phone.PHONE_SUBSTANCE_CLARIFICATION,
                )

    def test_exemplifier_and_reported_speech_answers_stay_substantive(self):
        # Every one of these is a COMPLETE answer that the first draft's
        # loosening misclassified (verified live by the review agents):
        # 'as in' exemplifiers, third-person 'didn't mention', reported
        # speech, and long narratives around weak phrases.
        for text in (
            "Around 55,000 as in hand salary per month.",
            "I joined as in-house sales counsel in 2021 and grew the desk.",
            "My manager didn't mention the deadline had moved, so I set up a "
            "weekly sync with the ops team to keep everyone aligned.",
            "We had two microservices and the team debated which one to "
            "migrate first, so I built a scoring matrix comparing blast "
            "radius, traffic, and rollback cost before we committed to either "
            "of them in production.",
            "In retail we always thank the customer and say come again, and I "
            "carried that same warmth into my counseling calls every single "
            "day because people remember exactly how you make them feel.",
            "If you mean the AI programs I built two of them last year and "
            "both are still in production today.",
        ):
            with self.subTest(text[:40]):
                self.assertEqual(
                    phone.phone_turn_substance(text),
                    phone.PHONE_SUBSTANCE_SUBSTANTIVE,
                )

    def test_route_and_substance_gate_share_one_classifier(self):
        # The live turn hook consults candidate_turn_route FIRST; the commit
        # gate consults phone_turn_substance. The first draft gave them
        # different vocabularies and different length bounds, so one utterance
        # could be spoken to as an answer while its commit was skipped —
        # desynchronizing the cursor (review find). Pin the alignment on both
        # the clarification and the substantive side.
        clarifying = "Like you're talking about the notice period?"
        self.assertEqual(phone.candidate_turn_route(clarifying), "candidate_question")
        self.assertEqual(
            phone.phone_turn_substance(clarifying), phone.PHONE_SUBSTANCE_CLARIFICATION,
        )
        narrative = (
            "I've closed admissions for two years — as in, direct B2C "
            "counseling and closing roles — and exceeded quota every quarter "
            "while mentoring the two newest advisors on my team."
        )
        self.assertIsNone(phone.candidate_turn_route(narrative))
        self.assertEqual(
            phone.phone_turn_substance(narrative), phone.PHONE_SUBSTANCE_SUBSTANTIVE,
        )


class TestConflictRepursuit(unittest.TestCase):
    """F7 — one concrete, kind re-pursuit when the probe is brushed off."""

    CONFLICT = {
        "resume_fact": "Proprietary trader at Alpha Markets since 2024",
        "spoken_claim": "Two years in EdTech sales and advisory roles",
    }

    # v114 (live call): the candidate deflected the probe with a ~17-word
    # counter-question that asked the interviewer to explain the conflict
    # itself. It reads substantive and exceeds the old 12-word non-answer cap,
    # so it was classified ENGAGED, re-pursuit was suppressed, and the bot
    # capitulated + fabricated a reconciliation.
    V114_CONFLICT_COUNTER_QUESTION = (
        "yeah definitely I can do that, but can you explain what conflict is "
        "between resume and what I told?"
    )

    def test_unresolved_on_deflection_filler_and_dont_know(self):
        for text in (
            LIVE_CONFLICT_DEFLECTION,
            "Um, yeah, so",
            "I don't know honestly",
            "",
            None,
        ):
            with self.subTest(repr(text)):
                self.assertTrue(phone.phone_conflict_reply_unresolved(text))

    def test_v114_interrogative_deflection_is_unresolved_despite_length(self):
        # The EXACT live v114 counter-question — >12 words, question-shaped,
        # asks the interviewer to explain the conflict — must read as a
        # DEFLECTION so the ONE re-pursuit fires.
        self.assertTrue(
            phone.phone_conflict_reply_unresolved(self.V114_CONFLICT_COUNTER_QUESTION)
        )

    def test_other_conflict_counter_questions_are_unresolved(self):
        # Same interrogative-deflection shape, other phrasings — all unresolved
        # regardless of word count.
        for text in (
            "Wait, what conflict? I don't get which part doesn't line up.",
            "Sorry, which part of my answer doesn't match the resume?",
            "Can you clarify what you mean by the discrepancy with my resume?",
            "What do you mean there's a mismatch with the resume exactly?",
            # Adversarial-review MUST-DEFLECT cases:
            "What do you mean? Which part doesn't line up?",
        ):
            with self.subTest(text):
                self.assertTrue(phone.phone_conflict_reply_unresolved(text))

    def test_engaged_candidate_who_also_asks_a_question_is_not_a_deflection(self):
        # ADVERSARIAL-REVIEW REGRESSION (must NOT fire re-pursuit at an engaged
        # candidate): each reply gives a real substantive clause — an account,
        # a resolution, or a stated position — AND tacks on a clarifying
        # question. The deflection is not the primary payload, so these are
        # ENGAGED (False). Firing the one-shot re-pursuit here is the exact
        # regression the interrogative gate must avoid.
        for text in (
            "I worked there for three years. Which part of my resume seems wrong?",
            "Honestly I think my resume is accurate. What is the problem you are "
            "seeing?",
            "How I resolved it was by escalating to my manager; which part of the "
            "resume seems wrong to you?",
            "Could you tell me which role you mean, since my resume lists two and "
            "I want to answer the right one?",
        ):
            with self.subTest(text):
                self.assertFalse(phone.phone_conflict_reply_unresolved(text))

    def test_engaged_on_a_substantive_explanation(self):
        self.assertFalse(phone.phone_conflict_reply_unresolved(
            "Right, so the trading role was a family business I helped with "
            "part-time while my full-time employment stayed in EdTech sales — "
            "the resume lists both and the dates overlap."
        ))

    def test_engaged_on_a_genuine_reconciliation_mentioning_resume(self):
        # A real explanation that squares the two — even one that mentions the
        # word "resume" — is ENGAGED (False). It is not a question, so the
        # interrogative-deflection gate never fires on it.
        for text in (
            "Yes — I was a proprietary trader by title but my day-to-day was "
            "advisory sales to clients.",
            "My resume lists both roles because I did trading and EdTech "
            "advisory sales in the same period, so the timeline overlaps.",
        ):
            with self.subTest(text):
                self.assertFalse(phone.phone_conflict_reply_unresolved(text))

    def test_repursuit_instruction_names_the_gap_with_guards(self):
        instruction = phone.phone_conflict_repursuit_instruction(self.CONFLICT)
        self.assertIsNotNone(instruction)
        low = instruction.lower()
        self.assertIn("for your context only", low)
        self.assertIn("do not read these aloud", low)
        self.assertIn("never accuse", low)
        self.assertIn('never use the word "discrepancy"', low)
        self.assertIn("exactly one direct, friendly question", low)
        # The second ask may EXPLAIN, and then must let go.
        self.assertIn("explain in one plain, warm sentence", low)
        self.assertIn("accept it gracefully and move on", low)
        # It must reference BOTH facts so the re-assertion is concrete.
        self.assertIn(self.CONFLICT["resume_fact"], instruction)
        self.assertIn(self.CONFLICT["spoken_claim"], instruction)

    def test_repursuit_instruction_forbids_endorsing_or_reconciling(self):
        # v114 ANTI-CAPITULATION: the bot verbally validated the candidate's
        # false account and invented a "start date" reconciliation. The
        # instruction must explicitly forbid affirming/validating/reconciling
        # and inventing any detail to smooth it over.
        instruction = phone.phone_conflict_repursuit_instruction(self.CONFLICT)
        low = instruction.lower()
        self.assertIn("do not affirm", low)
        for word in ("validate", "reconcile"):
            self.assertIn(word, low)
        self.assertIn("do not invent", low)
        self.assertIn("makes total sense", low)

    def test_repursuit_refuses_malformed_findings(self):
        for bad in (None, {}, {"resume_fact": "x"}, {"spoken_claim": "y"},
                    {"resume_fact": " ", "spoken_claim": "y"}, "not a dict"):
            with self.subTest(repr(bad)):
                self.assertIsNone(phone.phone_conflict_repursuit_instruction(bad))


class TestConflictGuardSatisfiable(unittest.TestCase):
    """F5 — the paraphrase the instruction demands must be authorizable."""

    def test_model_phrased_conflict_probe_passes_authorization(self):
        # THE UNSATISFIABLE PAIR (live 2026-09-03): instruction says "your own
        # words", the removed guard clause accepted only the canned sentence.
        paraphrase = (
            "Thanks for sharing that. I noticed the resume we received "
            "describes a somewhat different recent role — could you help me "
            "understand how the two fit together?"
        )
        self.assertTrue(phone.phone_generated_reply_authorized(
            paraphrase, phone.PHONE_RESUME_CONFLICT_CLARIFICATION_TEXT,
            allow_closing=False,
        ))

    def test_general_guards_still_bound_the_conflict_turn(self):
        self.assertEqual(phone.phone_generated_reply_rejection_reason(
            "Interesting. What is your salary expectation?",
            phone.PHONE_RESUME_CONFLICT_CLARIFICATION_TEXT, allow_closing=False,
        ), "compensation_drift")


class TestTtsFlushKnobLive(unittest.TestCase):
    """F4 — the env knob is honored again; 0 remains the instant rollback."""

    def test_env_value_is_honored_and_bounded(self):
        cases = (("60", 60), ("0", 0), ("400", 400), ("1000", 400), ("-3", 0), ("junk", 0))
        for raw, expected in cases:
            with self.subTest(raw):
                with patch.dict(phone.os.environ, {"PHONE_TTS_FLUSH_MIN_CHARS": raw}):
                    self.assertEqual(phone.phone_tts_flush_min_chars(), expected)

    def test_unset_defaults_to_disabled(self):
        with patch.dict(phone.os.environ, {}, clear=False):
            phone.os.environ.pop("PHONE_TTS_FLUSH_MIN_CHARS", None)
            self.assertEqual(phone.phone_tts_flush_min_chars(), 0)


class TestQueuedScoringHold(unittest.TestCase):
    """F2 — the lease hold that keeps a finished screening from `abandoned`."""

    def test_default_and_bounds(self):
        with patch.dict(phone.os.environ, {}, clear=False):
            phone.os.environ.pop("PHONE_QUEUED_SCORING_HOLD_SEC", None)
            self.assertEqual(phone.phone_queued_scoring_hold_sec(), 600.0)
        for raw, expected in (("0", 0.0), ("900", 900.0), ("2000", 900.0), ("-5", 0.0)):
            with self.subTest(raw):
                with patch.dict(
                    phone.os.environ, {"PHONE_QUEUED_SCORING_HOLD_SEC": raw},
                ):
                    self.assertEqual(phone.phone_queued_scoring_hold_sec(), expected)

    def test_poll_and_tail_grace_are_sane(self):
        self.assertGreater(phone.PHONE_QUEUED_SCORING_POLL_SEC, 0)
        self.assertLess(phone.PHONE_QUEUED_SCORING_POLL_SEC, 60)
        self.assertGreater(phone.PHONE_CLOSE_TAIL_GRACE_SEC, 0)
        self.assertLess(phone.PHONE_CLOSE_TAIL_GRACE_SEC, 5)


if __name__ == "__main__":
    unittest.main()
