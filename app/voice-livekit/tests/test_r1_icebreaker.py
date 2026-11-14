"""Unit tests for ``r1_icebreaker``: the getting-to-know-you plan code owns (M032 S5 item 3).

The owner's call fda9e9f6 is the source of every case, by turn number; the candidate text here is
synthetic or paraphrased, never the session's own words:

* #4: a fragment of a dozen words got a new topic (a selling scenario, #5) instead of one probe;
* #6: a request to skip ahead got "I understand, but we're still in the getting-to-know-you part"
  (the note's own label, read out);
* #14: a short decline was accepted well: a decline moves on and never loops;
* #8/#9 and #17/#18: one answer committed as two turns.

The module is pure: no clock, no I/O, no SDK, and the plan keeps no candidate text.
"""
from __future__ import annotations

import os
import re
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_icebreaker as ib
import r1_script
from r1_guard import GuardContext, check_sentence, guard_text
from r1_personas import ALL_PERSONA_NAMES

SUBSTANTIVE = "I spent six years selling insurance policies to young families across the city."
THIN = "I mostly pitch and then I just follow up."
FRAGMENT = "Okay so I would call them and then I would. Explain it, yeah."


def words(text: str) -> int:
    """A stand-in for the session's ``content_word_count`` (backchannel words excluded)."""
    backchannel = {"yeah", "yes", "okay", "ok", "sorry", "so", "um", "uh", "hmm", "well", "right"}
    return sum(
        1 for word in re.findall(r"[a-z0-9']+", text.lower()) if word not in backchannel
    )


def job(
    plan: ib.IcebreakerPlan, text: str, *, content_words: int | None = None
) -> ib.IcebreakerJob:
    counted = words(text) if content_words is None else content_words
    return plan.next_job(text, content_words=counted)


class TestObjectives(unittest.TestCase):
    def test_the_plan_is_background_then_the_three_objectives_of_the_spec(self):
        self.assertEqual([o.id for o in ib.OBJECTIVES], ["I1", "I2", "I3", "I4"])
        goals = [o.goal.lower() for o in ib.OBJECTIVES]
        self.assertIn("background", goals[0])  # L-OPEN asks it
        self.assertIn("typical day", goals[1])
        self.assertIn("customer", goals[1])
        self.assertIn("this role", goals[2])
        self.assertIn("proud", goals[3])
        for objective in ib.OBJECTIVES:
            with self.subTest(objective=objective.id):
                self.assertTrue(objective.restate.endswith("?"))
                self.assertLessEqual(len(objective.restate.split()), 20)

    def test_no_text_names_a_persona_the_role_play_or_a_grade(self):
        texts = [o.goal for o in ib.OBJECTIVES] + [o.restate for o in ib.OBJECTIVES]
        texts += [ib.FREE_RESTATE, ib.TAKE_YOUR_TIME, *ib.JOB_NOTES.values(), ib.ASKED_NOTE]
        texts += [*ib.FREE_JOB_NOTES.values()]
        for text in texts:
            lowered = text.lower()
            for name in ALL_PERSONA_NAMES:
                self.assertNotIn(name.lower(), lowered)
            for word in ("role-play", "role play", "score", "rubric", "grade", "$"):
                self.assertNotIn(word, lowered, text)

    def test_the_spoken_lines_pass_the_icebreaker_guard_clean(self):
        context = GuardContext(phase="icebreaker", praise_check=True)
        for text in [o.restate for o in ib.OBJECTIVES] + [ib.FREE_RESTATE, ib.TAKE_YOUR_TIME]:
            with self.subTest(text=text):
                self.assertEqual(check_sentence(text, context), [])
                self.assertEqual(guard_text(text, context).text, text)


class TestDisposition(unittest.TestCase):
    def reading(self, text: str) -> ib.Reading:
        return ib.disposition(text, content_words=words(text))

    def test_a_substantive_answer_is_answered(self):
        self.assertEqual(self.reading(SUBSTANTIVE).kind, ib.ANSWERED)
        self.assertFalse(self.reading(SUBSTANTIVE).asked)

    def test_a_fragment_is_thin_even_with_a_dozen_words(self):
        # #4: a fragment of more than six words; a plain word count would call it an answer.
        self.assertGreater(len(FRAGMENT.split()), 10)
        self.assertEqual(self.reading(FRAGMENT).kind, ib.THIN)
        self.assertEqual(self.reading(THIN).kind, ib.THIN)
        brief = "I like meeting new folks. I stay calm."
        self.assertEqual(self.reading(brief).kind, ib.THIN)

    def test_a_decline_is_declined_only_when_it_is_short(self):
        for text in (
            "I do not wish to share that.",
            "I'd rather not say.",
            "Nothing really comes to mind.",
            "I can't think of one right now.",
            "Can we skip this one?",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.reading(text).kind, ib.DECLINED)
        long = (
            "I'd rather not name the company, but I sold about two hundred courses a month there "
            "to working parents and college students."
        )
        self.assertEqual(self.reading(long).kind, ib.ANSWERED)

    def test_a_request_to_skip_ahead_is_a_skip_and_not_an_answer(self):
        # #6, paraphrased.
        for text in (
            "Can we go straight to the role play?",
            "Could we just move on to the roleplay part?",
            "I'd like to start with the role play now.",
            "Can we skip the introductions?",
            "Let's just do the mock call.",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.reading(text).kind, ib.SKIP)
        # Talk about the candidate's own role-plays is no request.
        own = "I ran role plays for our new joiners every week at my last company."
        self.assertEqual(self.reading(own).kind, ib.ANSWERED)
        # An answer that also asks to skip is an answer, and the reply says the warm clause.
        both = SUBSTANTIVE + " Can we go straight to the role play after this?"
        reading = self.reading(both)
        self.assertEqual(reading.kind, ib.ANSWERED)
        self.assertTrue(reading.skip)

    def test_let_me_think_is_thinking_and_nothing_else_is(self):
        for text in (
            "Let me think.",
            "Hmm, let me think about that.",
            "Give me a second.",
            "One moment please.",
            "Okay, I'm just thinking.",
            "Let me think about how to put it.",
            # Review of S5: the commonest spoken forms ("for a second") were missed.
            "Let me think for a second.",
            "Let me think for a moment.",
            "Let me just think for a second.",
            "Let me think about that for a second.",
            "Let me gather my thoughts for a moment.",
            "Hmm, let me think about it for a minute.",
            "Give me a minute to think about it.",
            "Hmm, let me think for a bit.",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.reading(text).kind, ib.THINKING)
                self.assertTrue(ib.is_thinking(text))
        for text in (
            "Let me think, my best moment was closing a deal with a nervous parent last year.",
            "Let me check with my manager.",  # a move in the role-play, never a thinking turn
            "Let me think?",
            "I think I enjoy the calls most.",
        ):
            with self.subTest(text=text):
                self.assertNotEqual(self.reading(text).kind, ib.THINKING)
                self.assertFalse(ib.is_thinking(text))

    def test_a_question_to_christy_is_a_nonanswer_that_asked(self):
        for text in (
            "Sorry, what do you mean by a typical day?",
            "Do you want an example from my last job?",
            "Is this being recorded?",
            "Can you explain the question?",
        ):
            with self.subTest(text=text):
                reading = self.reading(text)
                self.assertEqual(reading.kind, ib.NONANSWER)
                self.assertTrue(reading.asked)

    def test_answer_openings_that_look_like_questions_are_not_questions(self):
        # The phone lesson: "What I do currently is ..." is an answer, not a question to the bot.
        for text in (
            "What I do currently is call the leads that came in overnight and book demos.",
            "How I usually start is by asking parents what their child struggles with.",
            "So what happens is, you know, I call each lead twice and then send the brochure.",
            "Six years in insurance sales?",  # a rising answer that the speech-to-text marked
            "What matters most to me is that you help every family pick the right plan.",
            "What you learn there is how to listen before you pitch anything.",
            "When you have a target, it pushes me to plan every call.",
        ):
            with self.subTest(text=text):
                self.assertFalse(ib.asks_christy(text))
        self.assertTrue(ib.asks_christy("What does the role involve day to day?"))
        self.assertTrue(ib.asks_christy("Could you repeat that for me"))

    def test_a_rhetorical_question_the_candidate_answers_is_no_question_to_christy(self):
        # Review of S5: a real answer that opens with its own question (speech-to-text adds the
        # "?") was read as a question to Christy, held the objective and got it asked again.
        for text in (
            "So what drew me here? Honestly the chance to work with learners who want to grow.",
            "What do I do? I call leads every morning and qualify them for the counsellors.",
            "Why sales? Because I love talking to people and I have done it for years.",
            "How do I handle a tough customer? I listen first and then answer each worry.",
            "Why did I pick this field? My cousin did it and loved the work.",
        ):
            with self.subTest(text=text):
                reading = self.reading(text)
                self.assertFalse(reading.asked)
                self.assertNotEqual(reading.kind, ib.NONANSWER)
                self.assertFalse(ib.asks_christy(text))
        # Questions to Christy stay questions, wherever they sit and whoever they name.
        for text in (
            "I sold courses to parents for years. What happens in the next part?",
            "Do I need to prepare anything? I have my notes here.",
            "What do I need to do next?",
            "How long is this part? I have another call later.",
        ):
            with self.subTest(text=text):
                self.assertTrue(ib.asks_christy(text))

    def test_saying_they_have_none_of_something_answers_and_is_no_decline(self):
        # Review of S5: "I don't have any sales experience" is a fact about them, not a refusal;
        # Christy must not reassure them about a refusal they never made.
        for text in (
            "I don't have any sales experience honestly.",
            "I don't have any experience in sales, I was a teacher.",
            "I don't have any experience in edtech yet, mostly retail.",
            "No, I don't have any direct sales background, I did customer support.",
            "I don't have one fixed routine, I call leads and follow up.",
            "I can't think of any other job I'd enjoy as much as this one.",
        ):
            with self.subTest(text=text):
                self.assertNotEqual(self.reading(text).kind, ib.DECLINED)
        for text in (
            "I don't have one.",
            "I don't really have one, sorry.",
            "I don't have an example right now.",
            "I don't remember a specific moment.",
            "Honestly I can't think of anything specific.",
            "I can't recall one off the top of my head.",
        ):
            with self.subTest(text=text):
                self.assertEqual(self.reading(text).kind, ib.DECLINED)

    def test_a_bare_yes_or_no_answers_a_closed_question_thinly(self):
        # The model may ask a yes/no question; "Yes." answers it (one probe follows), it is no
        # request to hear the question again.
        for text in ("Yes.", "No, not really.", "Yeah, I have.", "Yes, definitely."):
            with self.subTest(text=text):
                self.assertEqual(ib.disposition(text, content_words=0).kind, ib.THIN)

    def test_nothing_said_is_a_nonanswer(self):
        # "Yeah." or "Okay." alone is a lead-in or a backchannel (the owner's #16 went on at #17).
        for text in ("", "Yeah.", "Okay.", "Sorry, can you repeat that?", "Are you there?"):
            with self.subTest(text=text):
                self.assertEqual(ib.disposition(text, content_words=0).kind, ib.NONANSWER)

    def test_the_advisor_corpus_never_trips_the_narrow_readers(self):
        # The global rule: test every new detector on the advisor corpus (2,136+ real and
        # simulated candidate turns) for false positives.  None of them is a thinking statement,
        # a skip-ahead request or a decline; a directed question without "?" is one suggestion.
        import json

        rows = []
        for name in ("r1_advisor_corpus.jsonl", "r1_advisor_heldout.jsonl"):
            path = HERE / "tests" / "fixtures" / name
            rows += [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
                     if line.strip()]
        self.assertGreater(len(rows), 2100)
        texts = [row["text"] for row in rows]
        self.assertEqual([t for t in texts if ib.is_thinking(t)], [])
        skips = [t for t in texts if ib.disposition(t, content_words=99).kind == ib.SKIP]
        self.assertEqual(skips, [])
        self.assertEqual(
            [t for t in texts if ib.disposition(t, content_words=5).kind == ib.DECLINED], []
        )
        unmarked = [
            sentence
            for text in texts
            for sentence in ib.split_sentences(text)
            if "?" not in sentence and ib.asks_christy(sentence)
        ]
        self.assertLessEqual(len(unmarked), 1, unmarked)

    def test_the_readers_are_linear_on_long_input(self):
        long = "let me think " * 3000 + "can we go to the " * 3000 + "?"
        start = time.perf_counter()
        ib.disposition(long, content_words=9000)
        ib.is_thinking(long)
        ib.asks_christy(long)
        ib.substantive_words(long)
        # The decline's end check and the self-question reader (review of S5).
        ib.disposition("i don't have any " * 3000 + "really sorry " * 3000, content_words=5)
        ib.disposition("i don't really have one " + "honestly " * 6000, content_words=5)
        ib.asks_christy("What do I do? I call. " * 2000)
        self.assertLess(time.perf_counter() - start, 2.0)


class TestPlan(unittest.TestCase):
    def test_an_answer_moves_the_cursor_and_asks_the_next_objective(self):
        plan = ib.IcebreakerPlan()
        self.assertEqual(plan.current.id, "I1")  # L-OPEN asked it
        first = job(plan, SUBSTANTIVE)
        self.assertEqual(first.kind, ib.JOB_ASK)
        self.assertEqual(first.objective.id, "I2")
        self.assertIn(ib.OBJECTIVES[1].goal, first.note)
        self.assertEqual(first.fallback, ib.OBJECTIVES[1].restate)
        self.assertEqual(first.scripted, "")

    def test_a_thin_answer_gets_one_same_topic_probe_then_the_plan_moves_on(self):
        # #4 -> #5: the fragment got a new topic; now it gets ONE probe on the same objective.
        plan = ib.IcebreakerPlan()
        probe = job(plan, FRAGMENT)
        self.assertEqual(probe.kind, ib.JOB_FOLLOW_UP)
        self.assertEqual(probe.objective.id, "I1")
        self.assertIn(ib.OBJECTIVES[0].goal, probe.note)
        again = job(plan, THIN)
        self.assertEqual(again.kind, ib.JOB_ASK)
        self.assertEqual(again.objective.id, "I2")

    def test_a_decline_is_accepted_and_moves_on_and_never_loops(self):
        # #14 -> #15 went well; it stays that way.
        plan = ib.IcebreakerPlan()
        job(plan, SUBSTANTIVE)  # I1 answered, I2 asked
        declined = job(plan, "I'd prefer not to discuss that.")
        self.assertEqual(declined.kind, ib.JOB_DECLINED)
        self.assertEqual(declined.objective.id, "I3")
        self.assertIn("accept it", declined.note)
        self.assertIn("without pressing", declined.note)

    def test_a_skip_request_gets_one_warm_clause_then_the_same_question(self):
        # #6 -> #7: never "I understand, but", never the note's label, never a forward-looking
        # role-play sentence (the guard strips those in the icebreaker).
        # D4-ICE-SKIP1: the same question again is revision 30's (R1_IB_SKIP_V2=0); with the flag
        # on the next one is asked (``TestDiagnosis4Icebreaker``).
        with mock.patch.dict(os.environ, {"R1_IB_SKIP_V2": "0"}):
            plan = ib.IcebreakerPlan()
            job(plan, SUBSTANTIVE)
            skip = job(plan, "Can we go straight to the role play?")
            self.assertEqual(skip.kind, ib.JOB_SKIP)
            self.assertEqual(skip.objective.id, "I2")
            self.assertIn("get there soon", skip.note)
            self.assertIn('never start with "i understand, but"', skip.note.lower())
            self.assertIn("without naming any part of the interview", skip.note)
            self.assertNotIn("getting-to-know-you", skip.note)
        plan = ib.IcebreakerPlan()
        job(plan, SUBSTANTIVE)
        skip = job(plan, "Can we go straight to the role play?")
        self.assertEqual(skip.kind, ib.JOB_SKIP)
        self.assertEqual(skip.objective.id, "I3")
        self.assertIn('never start with "i understand, but"', skip.note.lower())
        self.assertNotIn("getting-to-know-you", skip.note)

    def test_a_nonanswer_reasks_the_same_objective_a_bounded_number_of_times(self):
        # D3-IB-REASK1 (R1_IB_REASK_V2, the default): once; with it off, MAX_HOLDS times.
        for flag, holds in (("1", ib.REASK_V2_MAX_HOLDS), ("0", ib.MAX_HOLDS)):
            with self.subTest(flag=flag), mock.patch.dict(os.environ, {"R1_IB_REASK_V2": flag}):
                self.assertEqual(ib.max_holds(), holds)
                plan = ib.IcebreakerPlan()
                job(plan, SUBSTANTIVE)
                asked = []
                for _ in range(holds):
                    reask = job(plan, "Sorry, can you repeat that?", content_words=0)
                    asked.append((reask.kind, reask.objective.id))
                self.assertEqual(asked, [(ib.JOB_REASK, "I2")] * holds)
                moved = job(plan, "Sorry, can you repeat that?", content_words=0)
                self.assertEqual((moved.kind, moved.objective.id), (ib.JOB_ASK, "I3"))  # no loop
        self.assertEqual(ib.REASK_V2_MAX_HOLDS, 1)  # a question is never put a third time

    def test_an_explicit_repeat_request_does_not_use_up_the_one_hold(self):
        # Review of diagnosis 3 (D3-IB-REASK1-SECOND-REPEAT): a candidate on a bad line who asks
        # twice to hear the question gets it twice; the one hold is still there for a turn that
        # answers nothing, and the repeats are bounded too (no loop).
        repeat = "Sorry, can you say that again?"
        with mock.patch.dict(os.environ, {"R1_IB_REASK_V2": "1"}):
            plan = ib.IcebreakerPlan()
            job(plan, SUBSTANTIVE)
            kinds = [
                plan.next_job(repeat, content_words=0, repeat_asked=True).kind
                for _ in range(ib.REASK_V2_MAX_REPEATS)
            ]
            self.assertEqual(kinds, [ib.JOB_REASK] * ib.REASK_V2_MAX_REPEATS)
            held = job(plan, "What do you mean?", content_words=0)
            self.assertEqual((held.kind, held.objective.id), (ib.JOB_REASK, "I2"))  # the hold
            moved = plan.next_job(repeat, content_words=0, repeat_asked=True)
            self.assertEqual((moved.kind, moved.objective.id), (ib.JOB_ASK, "I3"))
            # Taken back with the rest of the plan's state when a reply is never heard.
            plan = ib.IcebreakerPlan()
            job(plan, SUBSTANTIVE)
            lost = plan.next_job(repeat, content_words=0, repeat_asked=True)
            self.assertTrue(plan.reply_lost(lost))
            self.assertEqual(plan.repeats, {})
        self.assertEqual(ib.REASK_V2_MAX_REPEATS, 2)

    def test_with_the_flag_off_a_repeat_request_is_an_ordinary_hold(self):
        with mock.patch.dict(os.environ, {"R1_IB_REASK_V2": "0"}):
            plan = ib.IcebreakerPlan()
            job(plan, SUBSTANTIVE)
            kinds = [
                plan.next_job("Sorry, again?", content_words=0, repeat_asked=True).kind
                for _ in range(ib.MAX_HOLDS + 1)
            ]
        self.assertEqual(kinds, [ib.JOB_REASK] * ib.MAX_HOLDS + [ib.JOB_ASK])

    def test_repeats_after_every_objective_are_bounded_as_well(self):
        with mock.patch.dict(os.environ, {"R1_IB_REASK_V2": "1"}):
            plan = ib.IcebreakerPlan()
            while plan.current is not None:
                job(plan, SUBSTANTIVE)
            kinds = [
                plan.next_job("Sorry, again?", content_words=0, repeat_asked=True).kind
                for _ in range(ib.REASK_V2_MAX_REPEATS + ib.REASK_V2_MAX_HOLDS + 1)
            ]
        self.assertEqual(
            kinds,
            [ib.JOB_REASK] * (ib.REASK_V2_MAX_REPEATS + ib.REASK_V2_MAX_HOLDS) + [ib.JOB_FREE],
        )

    def test_a_question_to_christy_is_answered_first_then_the_objective_again(self):
        plan = ib.IcebreakerPlan()
        job(plan, SUBSTANTIVE)
        reask = job(plan, "Do you mean my current job or the one before?")
        self.assertEqual(reask.kind, ib.JOB_REASK)
        self.assertIn("answer it first", reask.note)
        self.assertEqual(reask.objective.id, "I2")

    def test_let_me_think_is_take_your_time_and_nothing_else(self):
        plan = ib.IcebreakerPlan()
        job(plan, SUBSTANTIVE)
        before = plan.summary()
        thinking = job(plan, "Hmm, let me think about that.")
        self.assertEqual(thinking.kind, ib.JOB_TAKE_TIME)
        self.assertEqual(thinking.scripted, "Take your time.")
        self.assertEqual(thinking.note, "")
        after = plan.summary()
        self.assertEqual(after["cursor"], before["cursor"])  # no advance
        self.assertEqual(after["holds"], before["holds"])
        self.assertEqual(after["follow_ups"], before["follow_ups"])
        self.assertEqual(job(plan, SUBSTANTIVE).objective.id, "I3")

    def test_an_answer_that_already_reached_the_next_objective_skips_it(self):
        plan = ib.IcebreakerPlan()
        job(plan, SUBSTANTIVE)
        both = (
            "A typical day starts with forty calls to new leads, and honestly that's why I'm "
            "applying for this role, I love those first conversations."
        )
        nxt = job(plan, both)
        self.assertEqual(nxt.objective.id, "I4")
        self.assertEqual(plan.summary()["credited"], ["I3"])

    def test_after_the_last_objective_it_follows_up_on_what_they_said(self):
        plan = ib.IcebreakerPlan()
        for _ in range(3):
            job(plan, SUBSTANTIVE)
        free = job(plan, SUBSTANTIVE)
        self.assertEqual(free.kind, ib.JOB_FREE)
        self.assertIsNone(free.objective)
        self.assertEqual(free.fallback, ib.FREE_RESTATE)
        self.assertEqual(job(plan, SUBSTANTIVE).kind, ib.JOB_FREE)

    def test_talk_about_a_past_job_does_not_answer_why_this_role(self):
        # Review of S5: "I left the job because ..." credited "what draws you to this role" and
        # the plan never asked it.
        for text in (
            "A typical day was calls and store visits. I left the job because the branch closed.",
            "I call about fifty parents a day, and I stayed in the job because the team was kind.",
            "I left the role since the targets kept rising every quarter at that firm.",
            "I liked the job because no two calls were ever the same for me there.",
        ):
            with self.subTest(text=text):
                plan = ib.IcebreakerPlan()
                job(plan, SUBSTANTIVE)  # I1 answered, I2 asked
                nxt = job(plan, text)
                self.assertNotIn("I3", plan.summary()["credited"])
                self.assertNotEqual(nxt.objective and nxt.objective.id, "I4")
        plan = ib.IcebreakerPlan()
        job(plan, SUBSTANTIVE)
        job(plan, "A typical day is forty calls, and I want this role because I love those talks.")
        self.assertEqual(plan.summary()["credited"], ["I3"])

    def through(self) -> ib.IcebreakerPlan:
        plan = ib.IcebreakerPlan()
        for _ in range(4):
            job(plan, SUBSTANTIVE)
        self.assertIsNone(plan.current)
        return plan

    def test_a_decline_after_the_plan_is_through_is_still_accepted(self):
        # Review of S5: once the cursor ran out (and for a decline of the last objective) the
        # decline lost its "accept it, without pressing" and got a plain follow-up.
        plan = ib.IcebreakerPlan()
        for _ in range(3):
            job(plan, SUBSTANTIVE)
        self.assertEqual(plan.current.id, "I4")
        for current in (plan, self.through()):
            declined = job(current, "I'd rather not say.")
            self.assertEqual(declined.kind, ib.JOB_DECLINED)
            self.assertIsNone(declined.objective)
            self.assertIn("accept it", declined.note)
            self.assertIn("without pressing", declined.note)
            self.assertIn("something else they already told you", declined.note)
            self.assertEqual(declined.fallback, ib.FREE_RESTATE)

    def test_a_repeat_request_after_the_plan_is_through_asks_the_last_question_again(self):
        # Review of S5: "Can you repeat the question?" got a NEW follow-up question.
        for flag in ("1", "0"):  # D3-IB-REASK1: R1_IB_REASK_V2 on (one re-ask) and off
            with self.subTest(flag=flag), mock.patch.dict(os.environ, {"R1_IB_REASK_V2": flag}):
                plan = self.through()
                kinds = []
                for _ in range(ib.max_holds()):
                    again = job(plan, "Sorry, can you repeat the question?", content_words=0)
                    kinds.append(again.kind)
                    self.assertIn("ask your last question again", again.note)
                    self.assertNotIn(
                        "follow-up question about something they already told you", again.note
                    )
                self.assertEqual(kinds, [ib.JOB_REASK] * ib.max_holds())
                bounded = job(plan, "Sorry, what?", content_words=0)
                self.assertEqual(bounded.kind, ib.JOB_FREE)
        with mock.patch.dict(os.environ, {"R1_IB_SKIP_V2": "0"}):
            skip = job(self.through(), "Can we go straight to the role play?")
            self.assertEqual(skip.kind, ib.JOB_SKIP)
            self.assertIn("get there soon", skip.note)
            self.assertIn("ask your last question again", skip.note)
        skip = job(self.through(), "Can we go straight to the role play?")  # D4-ICE-SKIP1
        self.assertEqual(skip.kind, ib.JOB_SKIP)
        self.assertIn("something else they already told you", skip.note)
        self.assertNotIn("ask your last question again", skip.note)

    def test_the_skip_note_and_the_tail_never_contradict_each_other(self):
        # Review of S5 (naturalness R8): "say you will get there soon" and "never hint at the
        # role-play" in one note.  The notes that say the clause carry the exception in the tail.
        plan = ib.IcebreakerPlan()
        job(plan, SUBSTANTIVE)
        notes = {
            "skip": job(plan, "Can we go straight to the role play?").note,
            "answer_and_skip": job(
                plan, SUBSTANTIVE + " Can we go straight to the role play after this?"
            ).note,
        }
        for name, note in notes.items():
            with self.subTest(name=name):
                self.assertTrue(note.endswith(ib.PLAN_NOTE_TAIL_SKIP))
                self.assertIn("apart from that one warm clause", note.lower())
        plain = job(plan, SUBSTANTIVE).note
        self.assertTrue(plain.endswith(ib.PLAN_NOTE_TAIL))
        self.assertNotIn("apart from", plain.lower())

    def test_a_reply_that_was_never_heard_is_undone(self):
        # #8/#9: the first half committed alone, its reply was cancelled before any audio, and the
        # second half must be read against the question that was really asked.
        plan = ib.IcebreakerPlan()
        first = job(plan, SUBSTANTIVE)
        self.assertEqual(plan.current.id, "I2")
        self.assertTrue(plan.reply_lost(first))
        self.assertEqual(plan.current.id, "I1")
        self.assertFalse(plan.reply_lost(first))  # once only
        # A later decision is not undone by an older lost reply.
        older = job(plan, SUBSTANTIVE)
        job(plan, SUBSTANTIVE)
        self.assertFalse(plan.reply_lost(older))
        self.assertEqual(plan.current.id, "I3")

    def test_every_note_keeps_the_guard_rails_and_quotes_its_objective(self):
        # TestIcebreakerNote's tokens: never start, announce; role-play; goodbye.
        plan = ib.IcebreakerPlan()
        notes = [
            job(plan, FRAGMENT).note,
            job(plan, SUBSTANTIVE).note,
            job(plan, "Can we go straight to the role play?").note,
            job(plan, "Is this being recorded?").note,
            job(plan, "I'd rather not say.").note,
            job(plan, SUBSTANTIVE + " Can we go straight to the role play after this?").note,
        ]
        for _ in range(4):
            notes.append(job(plan, SUBSTANTIVE).note)
        notes.append(job(plan, "I'd rather not say.").note)  # the plan is through by now
        notes.append(job(plan, "Sorry, can you repeat that?", content_words=0).note)
        notes.append(job(plan, "Can we go straight to the role play?").note)
        for note in notes:
            with self.subTest(note=note[:60]):
                lowered = note.lower()
                self.assertTrue(note.startswith(ib.PLAN_NOTE_HEAD))
                self.assertIn("never start, announce", lowered)
                self.assertIn("role-play", lowered)
                self.assertIn("goodbye", lowered)
                self.assertIn("selling scenarios", lowered)
                self.assertNotIn("getting-to-know-you", lowered)  # #7 read the label out
        for objective in ib.OBJECTIVES[1:]:
            self.assertTrue(any(f'"{objective.goal}"' in note for note in notes), objective.id)

    def test_the_summary_is_labels_and_counts_only(self):
        plan = ib.IcebreakerPlan()
        job(plan, SUBSTANTIVE)
        job(plan, FRAGMENT)
        summary = plan.summary()
        self.assertEqual(
            set(summary), {"cursor", "reached", "credited", "follow_ups", "holds", "jobs"}
        )
        blob = repr(summary).lower()
        for word in ("insurance", "pitch", "families"):
            self.assertNotIn(word, blob)
        # The log line's labels are fixed words and counts (built here, not in the log call, so
        # the session's static log fence sees plain names).
        self.assertEqual(
            plan.log_labels(), ("reached_1", "follow_ups_1_holds_0_credited_0")
        )


class TestTransitionBridge(unittest.TestCase):
    """M032 S5 item 4: one guarded reaction sentence to the boundary answer, or nothing.

    #22 -> #23: a reflective last answer got only "Thank you, {name}." and a 44 s brief.  The
    sentence is composed out of band and spoken only when it is clean.
    """

    CTX = GuardContext(phase="icebreaker", praise_check=True)

    def test_a_clean_short_reaction_passes_as_it_is(self):
        for text in (
            "So for you it's really about the person you're talking to in that moment.",
            "  Staying with the conversation instead of the outcome, that makes sense.  ",
        ):
            with self.subTest(text=text):
                self.assertEqual(ib.clean_bridge(text, self.CTX), text.strip())

    def test_anything_but_one_plain_reaction_sentence_is_dropped(self):
        for text in (
            "",
            "   ",
            None,
            "What made you think that way?",  # a question
            "That makes sense. Let's move on.",  # two sentences
            "Thank you for sharing that with me.",  # L-TRANSITION's own opener
            "That's impressive.",  # praise
            "Eight years is solid experience.",
            "Great, now we move to the role-play.",  # what comes next
            "That brings us to the next part of the interview.",
            "Goodbye for now.",
            "So for you it's about the person you're talking to in that very moment and not "
            "about whatever the final number turns out to be.",  # too long
            "Right.",  # too short to be a reaction to anything
            "You're hired.",  # a guard hit
        ):
            with self.subTest(text=text):
                self.assertIsNone(ib.clean_bridge(text, self.CTX))

    def test_quotes_around_the_sentence_are_not_spoken(self):
        self.assertEqual(
            ib.clean_bridge('"That sounds like a long week on the phones."', self.CTX),
            "That sounds like a long week on the phones.",
        )

    def test_praise_the_learner_and_an_echo_of_the_note_are_dropped(self):
        echo_ctx = GuardContext(
            phase="icebreaker", praise_check=True, control_texts=(ib.BRIDGE_NOTE,)
        )
        for text in (
            "You clearly know your customers well.",
            "Your patience with that parent shows real dedication.",
            "That will help you a lot with the learner.",
            "I'll react warmly to one specific thing they just said.",
        ):
            with self.subTest(text=text):
                self.assertIsNone(ib.clean_bridge(text, echo_ctx))

    def test_only_a_substantive_boundary_answer_gets_one(self):
        self.assertTrue(ib.bridge_wanted(SUBSTANTIVE, content_words=words(SUBSTANTIVE)))
        for text in (
            FRAGMENT,
            "Yes.",
            "Let me think.",
            "Can we go straight to the role play?",
            "Sorry, what do you mean by a typical day?",
            "I'd rather not say.",
        ):
            with self.subTest(text=text):
                self.assertFalse(ib.bridge_wanted(text, content_words=words(text)))

    def test_the_note_asks_for_one_short_sentence_with_no_question(self):
        lowered = ib.BRIDGE_NOTE.lower()
        for phrase in ("one short sentence", "no question", "no thanks", "no praise",
                       "nothing about what comes next", "goodbye"):
            self.assertIn(phrase, lowered)
        self.assertNotIn("role-play", lowered)  # nothing to copy
        self.assertLessEqual(ib.BRIDGE_TIMEOUT_SEC, 1.5)

    def test_the_bridge_flag_ships_off_and_turns_on(self):
        # Off by default: the measured boundary cost is above the ~1.5 s the plan allows
        # (r1_icebreaker's module notes).
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("R1_TRANSITION_BRIDGE", None)
            self.assertFalse(ib.transition_bridge_enabled())
        for on in ("1", "on", "true", "yes", " ON "):
            with mock.patch.dict(os.environ, {"R1_TRANSITION_BRIDGE": on}):
                self.assertTrue(ib.transition_bridge_enabled())
        with mock.patch.dict(os.environ, {"R1_TRANSITION_BRIDGE": "0"}):
            self.assertFalse(ib.transition_bridge_enabled())


class TestIcebreakerRepair(unittest.TestCase):
    """M032 S6 (SWEEP-28): the pure pieces of the icebreaker repair (synthetic texts only)."""

    HOLDS = (
        "Can you pause this for a minute?",
        "Could you give me a second?",
        "Can I take a minute?",
        "Hold on a sec, please.",
        "Give me a moment.",
        "Can we take a short break?",
        "Could we pause for a bit?",
        "Wait a minute, please.",
        "Sorry, hold on.",
        "Pause, please.",
        "Can I have a quick minute?",
        "Can I take a minute to think?",
        "Okay, just give me a minute, ma'am.",
        "Please wait a minute.",
        "Could you hold on for a second, please?",
        "Give me a second, I'll be right back.",
    )
    NOT_HOLDS = (
        "Could you give me an example of what you mean?",
        "Can you give me more context on the role?",
        "Will you wait for my answer?",
        "Would you hold that thought?",
        "I took a short break from sales in 2020",
        "There was a pause in my career after college.",
        "I hold on to my best customers by calling them every month.",
        "Give me a moment to explain: I sold software for six years to banks, insurers, retailers, "
        "two hospitals and a chain of schools across the city.",
        "Let me think about that.",
        "One moment.",
        "",
    )
    # Review of S6 (synthetic): a hold phrase used in an answer, and "hold on" / "wait a minute"
    # in front of a question, a repair or a denial of their own.
    NARRATIVE_NOT_HOLDS = (
        "So when a client hesitates I usually wait a minute and then I follow up with the pricing.",
        "I had to wait a bit for my promotion.",
        "When a customer gets angry I hold on for a second and let them vent.",
        "Honestly, my best moment was when a client said give me a minute and then signed.",
        "Hold on, sorry, my phone was ringing. So I worked at an edtech firm.",
        "I just wait a minute and then call them back.",
        "Let me pause there.",
    )
    ASKING_NOT_HOLDS = (
        "Hold on, what was the question?",
        "Hold on, can you repeat the question?",
        "Wait a minute, what do you mean?",
        "Wait a minute, which role are you asking about?",
        "Wait a minute, I didn't say that.",
        "Pause, what do you mean by typical day?",
        "Hold on, I didn't get you.",
        "Hold on a sec, are you there?",
        "Wait a second. Hello?",
        "Hold on. Could you rephrase that?",
    )

    def test_a_hold_request(self):
        for text in self.HOLDS:
            with self.subTest(text=text):
                self.assertTrue(ib.is_hold_request(text))
        for text in self.NOT_HOLDS + self.NARRATIVE_NOT_HOLDS + self.ASKING_NOT_HOLDS:
            with self.subTest(text=text):
                self.assertFalse(ib.is_hold_request(text))

    def test_a_hold_request_is_linear_on_long_input(self):
        for text in (
            "give me " + "a " * 5000 + "second",
            "can i " + "take " * 5000 + "a minute",
            "sorry " * 5000 + "hold on",
            "wait for " * 3000 + "a minute",
            "please wait " * 3000 + "for a minute " * 2000,
            "sorry " * 5000 + "wait a minute " + "this " * 3000,
        ):
            started = time.perf_counter()
            ib.is_hold_request(text)
            self.assertLess(time.perf_counter() - started, 1.0)

    def test_the_question_to_repeat(self):
        cases = (
            ("Thanks. So, what does a typical day look like for you?",
             "So, what does a typical day look like for you?"),
            ("Here's my next question: how do you keep track of your leads?",
             "How do you keep track of your leads?"),
            ("Got it - and how do you follow up with them?", "And how do you follow up with them?"),
            ("What do you sell - courses or software?", "What do you sell - courses or software?"),
            ("Is it inbound? Or do you also call cold leads?", "Or do you also call cold leads?"),
        )
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(ib.repeat_question(text), expected)
        for text in ("That sounds like a busy week.", "", "?", None):
            with self.subTest(text=text):
                self.assertIsNone(ib.repeat_question(text))

    def test_the_question_of_one_reply(self):
        # Review of S6: read from ONE reply.  A reply cut before its question, or one that only
        # reacted, gives None (the plan's question is used); an imperative prompt heard in full
        # is said again.
        self.assertEqual(
            ib.reply_question("Got it. How do you follow up?", complete=False),
            "How do you follow up?",
        )
        self.assertIsNone(ib.reply_question("That sounds like a busy week.", complete=False))
        self.assertIsNone(ib.reply_question("That sounds like a busy week.", complete=True))
        self.assertEqual(
            ib.reply_question("Got it. Tell me about a customer you're proud of.", complete=True),
            "Tell me about a customer you're proud of.",
        )
        self.assertIsNone(
            ib.reply_question("Got it. Tell me about a customer you're proud of.", complete=False)
        )
        self.assertEqual(
            ib.reply_question("Nice. So walk me through a typical day.", complete=True),
            "So walk me through a typical day.",
        )
        self.assertIsNone(ib.reply_question("", complete=True))

    def test_a_closed_question(self):
        for text in ("Do you enjoy cold calls?", "And is that inbound?", "Have you led a team?"):
            with self.subTest(text=text):
                self.assertTrue(ib.is_closed_question(text))
        for text in (
            "How do you keep track of all your leads?",
            "What did a typical day look like for you?",
            "Tell me about a customer you're proud of.",
        ):
            with self.subTest(text=text):
                self.assertFalse(ib.is_closed_question(text))

    def test_the_repeat_line_and_the_presence_notes(self):
        self.assertEqual(
            ib.repeat_line("How do you keep track of your leads?"),
            "Of course. How do you keep track of your leads?",
        )
        self.assertEqual(ib.IB_REPEAT_TEMPLATE, "Of course. {question}")
        self.assertEqual(
            ib.PRESENCE_OPENER_NOTE,
            'If they asked whether you are there, start with "Yes, I\'m here."',
        )
        self.assertEqual(
            ib.PRESENCE_OPENER_NOTE_LATE,
            'If they asked whether you are there, start with "Sorry about that, yes, I\'m here."',
        )
        self.assertEqual(ib.presence_opener_note(waited=5.9), ib.PRESENCE_OPENER_NOTE)
        self.assertEqual(ib.presence_opener_note(waited=6.0), ib.PRESENCE_OPENER_NOTE_LATE)
        self.assertEqual(ib.presence_opener_note(waited=None), ib.PRESENCE_OPENER_NOTE)
        self.assertEqual(ib.ICEBREAKER_HOLD_WAIT_SECONDS, 60.0)
        self.assertEqual(ib.HOLD_MIN_BUDGET_SECONDS, 15.0)

    def test_the_repair_flag_defaults_on_and_turns_off(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("R1_ICEBREAKER_REPAIR", None)
            self.assertTrue(ib.icebreaker_repair_enabled())
        for off in ("0", "off", "false", "no", " OFF "):
            with mock.patch.dict(os.environ, {"R1_ICEBREAKER_REPAIR": off}):
                self.assertFalse(ib.icebreaker_repair_enabled())


class TestFlags(unittest.TestCase):
    def test_the_plan_flag_defaults_on_and_turns_off(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("R1_ICEBREAKER_PLAN", None)
            self.assertTrue(ib.icebreaker_plan_enabled())
        for off in ("0", "off", "false", "no", " OFF "):
            with mock.patch.dict(os.environ, {"R1_ICEBREAKER_PLAN": off}):
                self.assertFalse(ib.icebreaker_plan_enabled())
        with mock.patch.dict(os.environ, {"R1_ICEBREAKER_PLAN": "1"}):
            self.assertTrue(ib.icebreaker_plan_enabled())


if __name__ == "__main__":
    unittest.main()


class TestDiagnosis4Icebreaker(unittest.TestCase):
    """M032 live simulation, diagnosis 4 (Christy lane): skip requests (D4-ICE-SKIP1), a request to
    wait with an object (D4-ICE-HOLD1), the quiet nudge's line (D4-IB-QUIET-NUDGE), the silence
    restates (D4-SIL-IB1) and the plan notes' react clause (D4-ICE-ECHO1).  Synthetic texts."""

    ANSWER = (
        "I sold insurance policies to young families for six years across three cities, mostly "
        "over the phone."
    )
    RUDE_SKIP = (
        "Guy landed a tech job after my pitch. Fine, that was satisfying. Now can we do the "
        "role-play?"
    )

    def next_job(self, plan: ib.IcebreakerPlan, text: str) -> ib.IcebreakerJob:
        return plan.next_job(text, content_words=words(text))

    def test_a_skip_with_an_answer_moves_on_and_never_asks_again(self) -> None:
        plan = ib.IcebreakerPlan()
        plan.cursor = 3  # the proud-moment question was just asked
        asked = plan.current.id
        result = self.next_job(plan, self.RUDE_SKIP)
        self.assertEqual(result.disposition, ib.ANSWERED)
        self.assertTrue(result.skip)
        self.assertNotEqual(result.kind, ib.JOB_SKIP)
        self.assertNotEqual(getattr(result.objective, "id", None), asked)
        self.assertIn("couple of minutes", result.note)
        with mock.patch.dict(os.environ, {"R1_IB_SKIP_V2": "0"}):
            plan = ib.IcebreakerPlan()
            plan.cursor = 3
            result = self.next_job(plan, self.RUDE_SKIP)
            self.assertEqual(result.kind, ib.JOB_SKIP)  # revision 30: the same question again
            self.assertEqual(result.objective.id, asked)

    def test_a_pure_skip_asks_the_next_objective(self) -> None:
        plan = ib.IcebreakerPlan()
        self.next_job(plan, self.ANSWER)  # I2 asked
        asked = plan.current.id
        result = self.next_job(plan, "Sorry, can we skip ahead to the role-play?")
        self.assertEqual(result.kind, ib.JOB_SKIP)
        self.assertNotEqual(result.objective.id, asked)
        self.assertIn("couple of minutes", result.note)
        self.assertIn(result.objective.goal, result.note)
        self.assertFalse(result.last)

    def test_the_sequences_never_ask_an_objective_twice_after_a_skip(self) -> None:
        for turns in (
            (self.ANSWER, "Sorry, can we skip ahead to the role-play?", self.ANSWER),
            (self.ANSWER, "Calls, follow-ups, closing. Same routine.", self.RUDE_SKIP),
        ):
            with self.subTest(turns=turns):
                plan = ib.IcebreakerPlan()
                asked: list[str] = [plan.current.id]
                for text in turns:
                    result = self.next_job(plan, text)
                    if result.skip and result.objective is not None:
                        self.assertNotIn(result.objective.id, asked)
                    if result.objective is not None:
                        asked.append(result.objective.id)

    def test_a_second_skip_leaves_one_more_question(self) -> None:
        plan = ib.IcebreakerPlan()
        first = self.next_job(plan, "Can we skip ahead to the role-play?")
        self.assertFalse(first.last)
        second = self.next_job(plan, "Can we just go to the role-play?")
        self.assertTrue(second.last)
        plan.reply_lost(second)  # never heard: the count is given back
        self.assertEqual(plan.skips, 1)
        with mock.patch.dict(os.environ, {"R1_IB_SKIP_V2": "0"}):
            plan = ib.IcebreakerPlan()
            self.next_job(plan, "Can we skip ahead to the role-play?")
            self.assertFalse(self.next_job(plan, "Can we skip ahead to the role-play?").last)

    def test_a_thin_answer_s_follow_up_never_asks_the_original_question(self) -> None:
        plan = ib.IcebreakerPlan()
        self.next_job(plan, self.ANSWER)
        result = self.next_job(plan, "Calls, follow-ups, closing. Same routine.")
        self.assertEqual(result.kind, ib.JOB_FOLLOW_UP)
        self.assertIn("do not ask the original question again", result.note)
        with mock.patch.dict(os.environ, {"R1_IB_SKIP_V2": "0"}):
            self.assertIn("for instance for one concrete example", result.note)

    def test_the_m09_wait_request_is_a_hold(self) -> None:
        self.assertTrue(
            ib.is_hold_request(
                "Never mentioned it to anyone, never. Hey, could you just hold this for a minute?"
            )
        )
        for text in (
            "Could you hold this for a minute?",
            "Can you pause it for a second?",
            "Can we hold on for a minute?",
        ):
            with self.subTest(text=text):
                self.assertTrue(ib.is_hold_request(text))
        for text in (
            "I hold on for a second and let them vent.",
            "I usually wait a minute and then follow up.",
            "I sold courses. Then I hold on for a second and let them vent.",
            "Hold on, what was the question?",
        ):
            with self.subTest(text=text):
                self.assertFalse(ib.is_hold_request(text))

    def test_the_plan_note_never_refuses_a_pause(self) -> None:
        plan = ib.IcebreakerPlan()
        self.assertIn(ib.HOLD_NOTE, self.next_job(plan, self.ANSWER).note)
        for flag in ("R1_ICEBREAKER_REPAIR", "R1_IB_HOLD_V2"):
            with self.subTest(flag=flag), mock.patch.dict(os.environ, {flag: "0"}):
                plan = ib.IcebreakerPlan()
                self.assertNotIn(ib.HOLD_NOTE, self.next_job(plan, self.ANSWER).note)

    def test_the_hold_v2_flag_restores_revision_30_s_reader(self) -> None:
        # Review of diagnosis 4 (NO-ISOLATED-ROLLBACK): R1_IB_HOLD_V2=0 rolls back D4-ICE-HOLD1
        # alone; the rest of the icebreaker repair stays on.
        with mock.patch.dict(os.environ, {"R1_IB_HOLD_V2": "0"}):
            self.assertTrue(ib.icebreaker_repair_enabled())
            self.assertFalse(ib.ib_hold_v2_enabled())
            for text in (
                "Never mentioned it to anyone, never. Hey, could you just hold this for a minute?",
                "Could you hold this for a minute?",
                "Can we hold on for a minute?",
                "Hey, wait a minute.",
            ):
                with self.subTest(text=text):
                    self.assertFalse(ib.is_hold_request(text))
            for text in ("Can you give me a minute?", "Wait a minute, please.", "Hold on."):
                with self.subTest(text=text):
                    self.assertTrue(ib.is_hold_request(text))
            self.assertEqual(ib.hold_request_answer("I sold loans. Could I have a moment?"), "")

    def test_a_hold_after_an_answer_keeps_the_answer(self) -> None:
        # Review of diagnosis 4 (HOLD-TAIL-DROPS-ANSWER).
        told = (
            "I sold home loans at a bank for three years, mostly walk-ins. Could I have a moment?"
        )
        self.assertTrue(ib.is_hold_request(told))
        self.assertEqual(
            ib.hold_request_answer(told),
            "I sold home loans at a bank for three years, mostly walk-ins.",
        )
        for text in (
            "Could you give me a minute?",
            "Wait. Could you give me a minute?",
            "Sorry, can you give me a moment to think?",
            "I sold home loans at a bank.",
            "Hold on, what was the question?",
        ):
            with self.subTest(text=text):
                self.assertEqual(ib.hold_request_answer(text), "")

    def test_the_quiet_nudge_line(self) -> None:
        for question, said in (
            (
                "What does a typical day look like in your sales work?",
                "So, what does a typical day look like in your sales work?",
            ),
            ("And what do you actually ask them?", "So, what do you actually ask them?"),
            ("Right, how do you keep track of leads?", "So, how do you keep track of leads?"),
            ("I'm curious, why sales?", "So, why sales?"),
            # Review of diagnosis 4 (NUDGE-LINE-CASING): only a question word is lowered, a lead
            # before the asking clause (a name, her reaction) is left out, and a question of lead
            # words alone gives no nudge.
            ("Priya, what draws you to this role?", "So, what draws you to this role?"),
            ("HDFC sounds busy, what did you sell?", "So, what did you sell?"),
            ("Tell me about a hard call.", "So, tell me about a hard call."),
            ("HDFC or ICICI, which bank was it?", "So, which bank was it?"),
            ("IT sales for five years?", "So, IT sales for five years?"),
            ("Okay?", ""),
            ("Right, so?", ""),
            ("", ""),
        ):
            with self.subTest(question=question):
                self.assertEqual(ib.quiet_nudge_line(question), said)

    def test_the_nudge_spends_the_question_s_one_re_ask(self) -> None:
        plan = ib.IcebreakerPlan()
        self.assertTrue(plan.can_hold())  # review of diagnosis 4: a peek spends nothing
        self.assertTrue(plan.can_hold())
        self.assertTrue(plan.use_hold())
        self.assertFalse(plan.can_hold())
        self.assertFalse(plan.use_hold())  # REASK_V2_MAX_HOLDS
        self.assertEqual(self.next_job(plan, "What do you mean?").kind, ib.JOB_ASK)  # moved on

    def test_the_silence_restate_lines(self) -> None:
        for objective in ib.OBJECTIVES:
            with self.subTest(objective=objective.id):
                line_id = ib.silence_line_id(objective)
                self.assertTrue(r1_script.LINES[line_id].startswith("No rush. I was asking "))
        self.assertEqual(ib.silence_line_id(None), "L-SIL-IB")

    def test_the_react_clause_of_the_notes(self) -> None:
        plan = ib.IcebreakerPlan()
        note = self.next_job(plan, self.ANSWER).note
        self.assertIn("never their words back", note)
        self.assertNotIn("React in a few words", note)
        with mock.patch.dict(os.environ, {"R1_REACTION_VARIETY_V2": "0"}):
            plan = ib.IcebreakerPlan()
            self.assertIn("React in a few words", self.next_job(plan, self.ANSWER).note)

    def test_the_flags_default_on(self) -> None:
        for flag, reader in (
            ("R1_IB_SKIP_V2", ib.ib_skip_v2_enabled),
            ("R1_IB_QUIET_NUDGE", ib.ib_quiet_nudge_enabled),
            ("R1_SIL_IB_RESTATE", ib.sil_ib_restate_enabled),
            ("R1_IB_HOLD_V2", ib.ib_hold_v2_enabled),
        ):
            with self.subTest(flag=flag):
                self.assertTrue(reader())
                with mock.patch.dict(os.environ, {flag: "0"}):
                    self.assertFalse(reader())
