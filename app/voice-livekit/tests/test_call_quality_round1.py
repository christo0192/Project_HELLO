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

import os
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


class TestTurnStyleRider(unittest.TestCase):
    """Benchmark-selected R1 per-turn style rider (2026-09-06): rides the
    toolless planned instruction (question + wind-down invite), NEVER the
    close — closes were 6/6 clean without it and must stay untouched."""

    def test_rider_constant_is_the_exact_benchmarked_text(self):
        self.assertIn("commas wherever a speaker would breathe",
                      phone.PHONE_TURN_STYLE_RIDER)
        self.assertIn("Always use contractions", phone.PHONE_TURN_STYLE_RIDER)
        self.assertIn("Two to three short sentences", phone.PHONE_TURN_STYLE_RIDER)
        self.assertTrue(phone.PHONE_TURN_STYLE_RIDER.startswith(" "))

    def test_rider_rides_both_planned_instruction_branches_not_the_close(self):
        # agent.py is read as text (this suite has no livekit/dotenv stubs).
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(here, "agent.py"), encoding="utf-8") as fh:
            src = fh.read()
        # both toolless planned-instruction branches carry the rider
        self.assertEqual(src.count("phone.PHONE_TURN_STYLE_RIDER"), 2)
        # the qna_done close instruction must NOT carry it (ship note 2)
        close_region = src[src.find("qna_done"):src.find("qna_done") + 4000]
        self.assertNotIn("PHONE_TURN_STYLE_RIDER", close_region)


class TestObjectiveGuardQuestionActCeiling(unittest.TestCase):
    """FIX B (2026-09-06, live DeepSeek call f4761967): the objective guard
    rejected NATURAL two-part confirm/probe utterances into the flat canned line.
    A phase-aware question-act ceiling (≤2 on name_confirm / resume_conflict, 1
    everywhere else) lets valid phrasing pass while every OTHER protection —
    instruction-echo, premature-closing, compensation-drift — stays intact."""

    # A natural single-act confirm (ONE '?') already passed before FIX B.
    ONE_ACT_CONFIRM = (
        "I have Christo on file but you said Deepak — which should I use?"
    )
    # A natural confirm-PLUS-probe: TWO question acts, the shape DeepSeek writes
    # on a name/résumé clarification turn. Rejected by the old one-act rule.
    TWO_ACT_CONFIRM = (
        "I have Christo on file — is that right? Or should I use Deepak?"
    )
    TWO_ACT_RESUME_PROBE = (
        "The resume lists a trading role — did I read that right? "
        "How does that square with the EdTech sales you described?"
    )

    def test_the_natural_two_act_confirm_trips_the_base_one_act_rule(self):
        # Baseline: with the default ceiling (1) the two-act confirm is rejected.
        self.assertEqual(phone.phone_generated_question_act_count(self.TWO_ACT_CONFIRM), 2)
        self.assertEqual(phone.phone_generated_reply_rejection_reason(
            self.TWO_ACT_CONFIRM,
            phone.PHONE_NAME_CONFIRM_CLARIFICATION_TEXT, allow_closing=False,
        ), "question_mark_count")

    def test_two_act_confirm_passes_on_the_relaxed_phases(self):
        # With the phase-aware ceiling (2) the same utterances now PASS.
        for text in (self.TWO_ACT_CONFIRM, self.TWO_ACT_RESUME_PROBE):
            with self.subTest(text[:32]):
                self.assertIsNone(phone.phone_generated_reply_rejection_reason(
                    text, phone.PHONE_NAME_CONFIRM_CLARIFICATION_TEXT,
                    allow_closing=False,
                    max_question_acts=phone.phone_objective_guard_max_questions_for_phase(
                        "name_confirm"),
                ))
        self.assertIsNone(phone.phone_generated_reply_rejection_reason(
            self.TWO_ACT_RESUME_PROBE,
            phone.PHONE_RESUME_CONFLICT_CLARIFICATION_TEXT, allow_closing=False,
            max_question_acts=phone.phone_objective_guard_max_questions_for_phase(
                "resume_conflict"),
        ))

    def test_one_act_confirm_passes_on_every_phase(self):
        # An ack + one question (ONE '?') was always fine — verify the guard
        # counts question ACTS, not sentences, so a normal advance ack+question
        # is never rejected.
        for phase in ("screening", "name_confirm", "resume_conflict", "candidate_qna"):
            with self.subTest(phase):
                self.assertIsNone(phone.phone_generated_reply_rejection_reason(
                    self.ONE_ACT_CONFIRM,
                    phone.PHONE_NAME_CONFIRM_CLARIFICATION_TEXT, allow_closing=False,
                    max_question_acts=phone.phone_objective_guard_max_questions_for_phase(phase),
                ))

    def test_ordinary_advance_turn_still_rejects_a_genuine_double_question(self):
        # A NON-confirm phase keeps the one-act rule: a genuine double question on
        # an ordinary QnA advance turn is still rejected.
        double = "What is your notice period? And what CTC do you expect?"
        self.assertEqual(phone.phone_generated_question_act_count(double), 2)
        self.assertEqual(phone.phone_generated_reply_rejection_reason(
            double, "Ask about availability.", allow_closing=False,
            max_question_acts=phone.phone_objective_guard_max_questions_for_phase("screening"),
        ), "question_mark_count")

    def test_other_protections_survive_the_relaxation(self):
        # The relaxed ceiling must NOT weaken any OTHER rejection reason. A
        # two-act utterance that ALSO leaks a private instruction / drifts to
        # compensation / closes prematurely is still rejected on a relaxed phase.
        comp = ("What is your notice period? And what salary do you expect?")
        self.assertEqual(phone.phone_generated_reply_rejection_reason(
            comp, phone.PHONE_RESUME_CONFLICT_CLARIFICATION_TEXT,
            allow_closing=False, max_question_acts=2,
        ), "compensation_drift")
        closing = "Is that right? Thanks so much, goodbye and take care."
        self.assertEqual(phone.phone_generated_reply_rejection_reason(
            closing, phone.PHONE_RESUME_CONFLICT_CLARIFICATION_TEXT,
            allow_closing=False, max_question_acts=2,
        ), "premature_closing")

    def test_phase_helper_is_relaxed_only_for_confirm_phases(self):
        self.assertEqual(phone.phone_objective_guard_max_questions_for_phase("name_confirm"), 2)
        self.assertEqual(phone.phone_objective_guard_max_questions_for_phase("resume_conflict"), 2)
        for phase in ("screening", "candidate_qna", "wind_down", "closing", None, 123):
            with self.subTest(phase):
                self.assertEqual(
                    phone.phone_objective_guard_max_questions_for_phase(phase), 1)

    def test_kill_switch_flips_behavior(self):
        # PHONE_OBJECTIVE_GUARD_MAX_QUESTIONS=1 restores the strict one-act rule
        # on every phase (per-phase kill switch); default (unset) is 2.
        with patch.dict(phone.os.environ, {"PHONE_OBJECTIVE_GUARD_MAX_QUESTIONS": "1"}):
            self.assertEqual(
                phone.phone_objective_guard_max_questions_for_phase("name_confirm"), 1)
            self.assertEqual(phone.phone_generated_reply_rejection_reason(
                self.TWO_ACT_CONFIRM,
                phone.PHONE_NAME_CONFIRM_CLARIFICATION_TEXT, allow_closing=False,
                max_question_acts=phone.phone_objective_guard_max_questions_for_phase("name_confirm"),
            ), "question_mark_count")
        # Unset defaults to 2; out-of-range clamps to [1, 2].
        with patch.dict(phone.os.environ, {}, clear=False):
            phone.os.environ.pop("PHONE_OBJECTIVE_GUARD_MAX_QUESTIONS", None)
            self.assertEqual(phone.phone_objective_guard_max_questions(), 2)
        for raw, expected in (("1", 1), ("2", 2), ("5", 2), ("0", 1), ("junk", 2)):
            with self.subTest(raw):
                with patch.dict(phone.os.environ, {"PHONE_OBJECTIVE_GUARD_MAX_QUESTIONS": raw}):
                    self.assertEqual(phone.phone_objective_guard_max_questions(), expected)

    def test_guard_cannot_be_disabled_below_one_act(self):
        # Even if a caller passes a bogus ceiling, the guard never accepts zero
        # questions on a non-closing turn (it clamps to >= 1).
        self.assertEqual(phone.phone_generated_reply_rejection_reason(
            "Thanks, that is helpful context.",  # zero question acts
            phone.PHONE_RESUME_CONFLICT_CLARIFICATION_TEXT, allow_closing=False,
            max_question_acts=0,
        ), "question_mark_count")


    def test_guard_flag_env_contract_declared_both_sides(self):
        # Review finding #3: pin the two-sided env contract for
        # PHONE_OBJECTIVE_GUARD_MAX_QUESTIONS (schema + .env.example) so a
        # future edit cannot drop one side silently.
        import json as _json
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        repo_root = os.path.dirname(os.path.dirname(here))
        with open(os.path.join(repo_root, "config", "environment.schema.json"),
                  encoding="utf-8") as fh:
            schema = _json.load(fh)
        self.assertIn(
            "PHONE_OBJECTIVE_GUARD_MAX_QUESTIONS",
            schema["components"]["voice-livekit"]["variables"],
        )
        with open(os.path.join(here, ".env.example"), encoding="utf-8") as fh:
            self.assertIn("PHONE_OBJECTIVE_GUARD_MAX_QUESTIONS=", fh.read())


class TestQnaDismissalDetector(unittest.TestCase):
    """FIX D (2026-09-06, live tail): an EXPLICIT dismissal during the
    questions-for-me phase must proceed to the closing goodbye instead of the bot
    re-opening ("Do you have any questions…?"). The anchored `phone_qna_done`
    misses a compound dismissal; `phone_qna_dismissal` catches it and fails
    closed on any turn that also carries a question."""

    # The EXACT live transcript utterance that re-opened the wind-down loop.
    LIVE_DISMISSAL = (
        "No follow up from me. You can just disconnect the call. Thank you."
    )

    def test_the_live_compound_dismissal_is_caught(self):
        self.assertTrue(phone.phone_qna_dismissal(self.LIVE_DISMISSAL))
        # It is NOT caught by the anchored done-detector (the middle clause).
        self.assertFalse(phone.phone_qna_done(self.LIVE_DISMISSAL))

    def test_explicit_dismissal_phrasings(self):
        for text in (
            "You can hang up the call, thanks.",
            "Please disconnect the call.",
            "No follow-ups from me.",
            "We're good, you can end the call.",
            "That's all from me, nothing from my side.",
            "I'm all set, go ahead and drop the call.",
        ):
            with self.subTest(text):
                self.assertTrue(phone.phone_qna_dismissal(text), text)

    def test_a_real_question_is_never_swallowed(self):
        # Fail-closed: any turn that also asks something must NOT be a dismissal.
        for text in (
            "Before we end the call, what are the work timings?",
            "Can you disconnect after you tell me the salary range?",
            "We're good — but what's the notice period expectation?",
            "What happens next in the process?",
        ):
            with self.subTest(text):
                self.assertFalse(phone.phone_qna_dismissal(text), text)

    def test_non_dismissal_content_stays_in_qna(self):
        for text in (
            "I actually have another question about the team.",
            "Tell me more about the role.",
            "Hmm, let me think.",
        ):
            with self.subTest(text):
                self.assertFalse(phone.phone_qna_dismissal(text), text)

    def test_fails_closed_on_non_str_and_empty(self):
        self.assertFalse(phone.phone_qna_dismissal(None))
        self.assertFalse(phone.phone_qna_dismissal(""))
        self.assertFalse(phone.phone_qna_dismissal("   "))


    def test_review_repair_midutterance_question_fails_closed(self):
        # Review finding #1: a question embedded mid-utterance without a '?'
        # must fail closed (not close the call).
        for text in (
            "we're good on that topic, but one question about salary",
            "I'm done, but how does the next round work",
            "no follow up from me although what is the salary range",
            "you can end the call after one more question",
        ):
            with self.subTest(text=text):
                self.assertFalse(phone.phone_qna_dismissal(text))

    def test_review_repair_im_good_prose_is_not_a_dismissal(self):
        # Review finding #2: "good/done/set" mid-sentence is an ANSWER.
        for text in (
            "I'm good at closing deals",
            "we are good on the CRM side and I also track follow-ups",
            "I'm set on targets every quarter",
        ):
            with self.subTest(text=text):
                self.assertFalse(phone.phone_qna_dismissal(text))

    def test_review_repair_standalone_dismissals_still_fire(self):
        for text in (
            "No no we are good thank you",
            "I'm good, thanks.",
            "No follow up from me. You can just connect the call. Thank you.",
            "we're all done!",
        ):
            with self.subTest(text=text):
                self.assertTrue(phone.phone_qna_dismissal(text))


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


class TestAnswerDispositionFromTheLiveCall(unittest.TestCase):
    """ANSWER-GATE (owner directive, 2026-09-05). The same live-call shapes that
    the substance gate scored SUBSTANTIVE (so they advanced the cursor) must now
    be caught as non-answers by the per-question disposition — while a genuine
    answer or an explicit decline still advances.
    """

    CTC_Q = "What is your current CTC and what are your expectations?"

    def test_the_live_ctc_conditional_counter_is_a_nonanswer(self):
        # The CTC-skip shape: a conditional counter-question that supplied no
        # number. It was substantive under the old gate and advanced past the
        # owed compensation question.
        self.assertEqual(
            phone.phone_answer_disposition(
                self.CTC_Q, "compensation",
                "If I share my CTC, will you tell me the range for this role?",
            ),
            phone.PHONE_ANSWER_NONANSWER,
        )

    def test_the_live_conflict_deflection_is_a_nonanswer(self):
        self.assertEqual(
            phone.phone_answer_disposition(
                "Tell me about your recent experience.", "open",
                LIVE_CONFLICT_DEFLECTION,
            ),
            phone.PHONE_ANSWER_NONANSWER,
        )

    def test_a_ctc_decline_advances_not_loops(self):
        self.assertEqual(
            phone.phone_answer_disposition(
                self.CTC_Q, "compensation", "I'd rather not share my CTC.",
            ),
            phone.PHONE_ANSWER_DECLINED,
        )

    def test_a_real_ctc_answer_advances(self):
        # Both slots supplied in the labelled forms the existing extractor
        # recognises (current … is N; expect around N) → answered.
        self.assertEqual(
            phone.phone_answer_disposition(
                self.CTC_Q, "compensation",
                "My current CTC is 14 LPA and I expect around 20 LPA.",
            ),
            phone.PHONE_ANSWER_ANSWERED,
        )

    def test_a_genuine_open_narrative_advances(self):
        # The long substantive answers the round-1 table protects must count as
        # answered for an OPEN objective — the gate must not demand completeness.
        self.assertEqual(
            phone.phone_answer_disposition(
                "Tell me about your sales experience.", "open",
                "I've closed admissions for two years — direct B2C counseling "
                "and closing roles — and exceeded quota every quarter.",
            ),
            phone.PHONE_ANSWER_ANSWERED,
        )


class _FakeMsg:
    """A ChatMessage-shaped item with a pydantic-style `model_copy`."""

    def __init__(self, role, content, msg_id=None):
        self.role = role
        self.content = content
        self.id = msg_id

    def model_copy(self, *, update=None):
        clone = _FakeMsg(self.role, self.content, self.id)
        for key, value in (update or {}).items():
            setattr(clone, key, value)
        return clone

    def __repr__(self):
        return f"_FakeMsg({self.role!r}, {self.content!r})"


class _FakeCtx:
    """A ChatContext-shaped holder with a copy() that clones the item list."""

    def __init__(self, items):
        self.items = list(items)

    def copy(self):
        return _FakeCtx(self.items)


class TestDeveloperRoleRewrite(unittest.TestCase):
    """F-B (live f5dee550, first DeepSeek call): every conversational request
    400'd because DeepSeek's OpenAI-compat endpoint rejects the `developer`
    role. The rewrite maps `developer`->`system` on the OUTGOING request only,
    preserving order and leaving non-developer items untouched."""

    def test_developer_is_rewritten_to_system(self):
        ctx = _FakeCtx([
            _FakeMsg("system", "policy"),
            _FakeMsg("user", "hi"),
            _FakeMsg("developer", "ask Q1"),
            _FakeMsg("assistant", "sure"),
        ])
        out, count = phone.rewrite_developer_role_to_system(ctx)
        self.assertEqual(count, 1)
        roles = [m.role for m in out.items]
        # Order preserved; the developer item became system; nothing else moved.
        self.assertEqual(roles, ["system", "user", "system", "assistant"])
        # The rewritten item preserved its content payload.
        self.assertEqual(out.items[2].content, "ask Q1")

    def test_order_preserved_with_multiple_developer_items(self):
        ctx = _FakeCtx([
            _FakeMsg("developer", "d1"),
            _FakeMsg("user", "u1"),
            _FakeMsg("developer", "d2"),
            _FakeMsg("assistant", "a1"),
            _FakeMsg("developer", "d3"),
        ])
        out, count = phone.rewrite_developer_role_to_system(ctx)
        self.assertEqual(count, 3)
        self.assertEqual(
            [(m.role, m.content) for m in out.items],
            [("system", "d1"), ("user", "u1"), ("system", "d2"),
             ("assistant", "a1"), ("system", "d3")],
        )

    def test_no_developer_items_is_a_noop_same_object(self):
        ctx = _FakeCtx([
            _FakeMsg("system", "policy"),
            _FakeMsg("user", "hi"),
            _FakeMsg("assistant", "there"),
        ])
        out, count = phone.rewrite_developer_role_to_system(ctx)
        self.assertEqual(count, 0)
        # No rewrite → the SAME ctx object is returned (no needless copy).
        self.assertIs(out, ctx)

    def test_non_developer_roles_are_untouched(self):
        ctx = _FakeCtx([
            _FakeMsg("system", "s"), _FakeMsg("user", "u"),
            _FakeMsg("assistant", "a"), _FakeMsg("tool", "t"),
        ])
        out, count = phone.rewrite_developer_role_to_system(ctx)
        self.assertEqual(count, 0)
        self.assertEqual([m.role for m in out.items], ["system", "user", "assistant", "tool"])

    def test_source_does_not_mutate_the_input_items_in_place(self):
        # The rewrite must not corrupt the passed ctx's own list when it copies.
        original = _FakeMsg("developer", "d1")
        ctx = _FakeCtx([original, _FakeMsg("user", "u1")])
        out, count = phone.rewrite_developer_role_to_system(ctx)
        self.assertEqual(count, 1)
        self.assertIsNot(out, ctx)
        # The original developer item object is unchanged (a fresh copy was made).
        self.assertEqual(original.role, "developer")
        self.assertEqual(out.items[0].role, "system")

    def test_dict_shaped_items_are_rewritten_too(self):
        # A test-harness ctx may carry plain dict items with no model_copy.
        ctx = _FakeCtx([
            {"role": "developer", "content": "d"},
            {"role": "user", "content": "u"},
        ])
        out, count = phone.rewrite_developer_role_to_system(ctx)
        self.assertEqual(count, 1)
        self.assertEqual(out.items[0]["role"], "system")
        self.assertEqual(out.items[1]["role"], "user")

    def test_llm_node_applies_rewrite_only_on_openai_lane(self):
        # The wiring guard must be `not phone_use_google_llm()`: the OpenAI-compat
        # lane rewrites, the native google/Gemini lane does not. Verified via the
        # source of the llm_node override (the lane gate is the load-bearing part).
        import inspect
        src = inspect.getsource(phone.phone_agent_class)
        self.assertIn("if not phone_use_google_llm():", src)
        self.assertIn("rewrite_developer_role_to_system(generation_ctx)", src)


class TestRepeatedFallbackVariation(unittest.TestCase):
    """F-D #1 (live transcript): the watchdog fallback re-asked the SAME
    question byte-identically twice in a row and the candidate noticed. A
    consecutive identical fallback must be re-worded (same question, rotated
    prefix); a non-repeat is returned unchanged."""

    QUESTION = "Walk me through your most recent role."

    def test_first_fallback_is_unchanged(self):
        out = phone.phone_vary_repeated_fallback(self.QUESTION, None, 0)
        self.assertEqual(out, self.QUESTION)

    def test_a_different_fallback_is_unchanged(self):
        out = phone.phone_vary_repeated_fallback(
            "A totally different question?", self.QUESTION, 0,
        )
        self.assertEqual(out, "A totally different question?")

    def test_consecutive_identical_is_reworded_but_keeps_the_question(self):
        out = phone.phone_vary_repeated_fallback(self.QUESTION, self.QUESTION, 0)
        # Never byte-identical to the previous line …
        self.assertNotEqual(out, self.QUESTION)
        # … but the question body is preserved verbatim (case-insensitive, since
        # the leading capital is lowered so the prefix reads naturally).
        self.assertIn("walk me through your most recent role.", out.lower())
        # The prefix is one of the fixed rotation entries.
        self.assertTrue(
            any(out.startswith(p) for p in phone.PHONE_REASK_VARIATION_PREFIXES),
            out,
        )

    def test_rotation_advances_with_repeat_index(self):
        first = phone.phone_vary_repeated_fallback(self.QUESTION, self.QUESTION, 0)
        second = phone.phone_vary_repeated_fallback(self.QUESTION, self.QUESTION, 1)
        # Two consecutive repeats pick DIFFERENT prefixes (deterministic rotation).
        self.assertNotEqual(first, second)

    def test_empty_and_non_string_are_safe(self):
        self.assertEqual(phone.phone_vary_repeated_fallback("", "x", 0), "")
        self.assertEqual(phone.phone_vary_repeated_fallback(None, "x", 0), "")


class TestCompensationDriftCandidateIntroduced(unittest.TestCase):
    """FIX 3 (2026-09-06, live call ac7c8c77 12:57:30): the candidate volunteered
    "my notice period is around 1 month", the model acknowledged it, and the ack
    was rejected as `compensation_drift` on a screening turn — the drift guard
    fired on an acknowledgement of a topic the CANDIDATE introduced. The guard
    now gates on whether the candidate raised comp/notice, so an ack of
    volunteered content passes while a genuine bot-initiated comp probe is still
    caught."""

    # A non-comp screening objective (the drift check only fires off-comp).
    SCREENING_OBJECTIVE = (
        "Ask the candidate to walk through their total sales experience."
    )

    # Table-driven candidate turns that SHOULD suppress the drift check.
    CANDIDATE_INTRODUCED = (
        ("notice", "My notice period is around 1 month."),
        ("current_ctc", "My current CTC is about 12 LPA."),
        ("salary_word", "I'd want the salary to be competitive."),
        ("package", "The package matters to me a lot."),
        ("take_home", "My take-home is around 80k a month."),
    )

    def test_live_shape_ack_of_volunteered_notice_is_not_drift(self):
        # The exact live shape: candidate volunteered notice, model acknowledged
        # it (mentions 'notice period') then asked the screening objective.
        reply = (
            "Got it — a one-month notice period is helpful to know. "
            "Now, can you walk me through your total sales experience?"
        )
        # WITHOUT the candidate context this looks like drift (mentions 'package'
        # vocabulary via the objective regex)…
        self.assertEqual(
            phone.phone_generated_reply_rejection_reason(
                "Your notice and package aside — what is your current salary?",
                self.SCREENING_OBJECTIVE, allow_closing=False,
            ),
            "compensation_drift",
        )
        # …but an ack of what the candidate volunteered passes.
        self.assertIsNone(
            phone.phone_generated_reply_rejection_reason(
                reply, self.SCREENING_OBJECTIVE, allow_closing=False,
                candidate_text="My notice period is around 1 month.",
            ),
        )

    def test_candidate_introduced_topics_suppress_drift(self):
        # A reply that names the comp/notice vocabulary (would trip the drift
        # regex) is allowed when the candidate raised the topic in this turn.
        reply = "Thanks for sharing your package details. Moving on."
        for name, candidate in self.CANDIDATE_INTRODUCED:
            with self.subTest(name):
                self.assertIsNone(
                    phone.phone_generated_reply_rejection_reason(
                        reply + " Walk me through your experience.",
                        self.SCREENING_OBJECTIVE, allow_closing=False,
                        candidate_text=candidate,
                    ),
                )

    def test_bot_initiated_comp_drift_still_rejected(self):
        # The candidate said nothing about comp; a bot comp probe on a non-comp
        # objective is genuine drift and stays rejected.
        self.assertEqual(
            phone.phone_generated_reply_rejection_reason(
                "By the way, what is your expected salary package?",
                self.SCREENING_OBJECTIVE, allow_closing=False,
                candidate_text="I have about eight years in inside sales.",
            ),
            "compensation_drift",
        )

    def test_default_none_candidate_text_preserves_legacy_behaviour(self):
        # Absent candidate_text, behaviour is byte-identical to before FIX 3.
        self.assertEqual(
            phone.phone_generated_reply_rejection_reason(
                "What is your current CTC?", self.SCREENING_OBJECTIVE,
                allow_closing=False,
            ),
            "compensation_drift",
        )

    def test_detector_predicate_shapes(self):
        self.assertTrue(
            phone.phone_candidate_introduced_compensation("notice period is 30 days"))
        self.assertTrue(
            phone.phone_candidate_introduced_compensation("my ctc is 10 lpa"))
        self.assertFalse(
            phone.phone_candidate_introduced_compensation("I lead a team of five."))
        self.assertFalse(phone.phone_candidate_introduced_compensation(None))


class TestRhetoricalTagQuestionCount(unittest.TestCase):
    """FIX 3 (2026-09-06, live call ac7c8c77 12:55:37 phase=screening): an ack
    ending on a rhetorical tag ("…, right?") plus one real question counted TWO
    question acts and was rejected as `question_mark_count`. A rhetorical tag is
    not a candidate-directed question act; it no longer inflates the count, while
    a genuine second question still does."""

    def test_trailing_tag_does_not_inflate_the_count(self):
        # Ack + tag + ONE real question = one act (was two before the fix).
        for tag_reply in (
            "That makes sense, right? Now, walk me through your experience.",
            "Great, you know? Tell me about your recent role.",
            "Okay, does that make sense? What is your notice period?",
            "Sounds good, yeah? Describe your last project.",
        ):
            with self.subTest(tag_reply[:32]):
                self.assertEqual(
                    phone.phone_generated_question_act_count(tag_reply), 1)
                self.assertIsNone(
                    phone.phone_generated_reply_rejection_reason(
                        tag_reply,
                        "Ask about the candidate's experience.",
                        allow_closing=False,
                    ),
                )

    def test_genuine_two_questions_still_counted_and_rejected(self):
        # Two real candidate-directed questions is genuine stacking → rejected.
        stacked = "What is your CTC? What is your notice period?"
        self.assertEqual(phone.phone_generated_question_act_count(stacked), 2)
        self.assertEqual(
            phone.phone_generated_reply_rejection_reason(
                stacked, "Ask about the candidate's CTC.", allow_closing=False,
            ),
            "question_mark_count",
        )

    def test_a_short_real_question_is_not_mistaken_for_a_tag(self):
        # A short genuine question ("what's your CTC?") is NOT a tag phrase and
        # still counts as one act.
        self.assertEqual(
            phone.phone_generated_question_act_count("What's your CTC?"), 1)

    def test_tag_alone_with_no_real_question_is_zero_acts(self):
        # Only a rhetorical tag and no real question = zero acts (and on a
        # non-closing turn that is its own rejection, unchanged).
        self.assertEqual(
            phone.phone_generated_question_act_count("That makes sense, right?"), 0)


if __name__ == "__main__":
    unittest.main()
