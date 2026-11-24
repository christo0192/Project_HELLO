"""Unit tests for ``r1_script``: the plan 5.2 scripted lines and their rendering."""
from __future__ import annotations

import hashlib
import itertools
import json
import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_script
from r1_personas import PERSONAS, resolve_persona
from r1_script import (
    CANDIDATE_FREE_LINES,
    EXIT_CUE,
    LINES,
    NAME_FREE_LINES,
    filler_line,
    is_candidate_free,
    known_first_name,
    line,
    line_sha256,
    placeholders,
    safe_first_name,
    spoken_first_name,
)

PLAN_IDS = (
    "L-OPEN",
    "L-TRANSITION",
    "L-PICKUP",
    "L-TIME-CUE",
    "L-EXIT",
    "L-WRAP",
    "L-NO-FEEDBACK",
    "L-FAQ-DEFER",
    "L-CLOSE",
    "L-ASIDE-COACH",
    "L-MUTE",
    "L-SIL-IB",
    "L-SIL-RP1",
    "L-SIL-RP2",
    "L-SIL-END",
    "L-REJOIN",
    "L-SYSTEM-STOP",
    "L-FILLER",
)
PLAN_DOC = HERE.parents[1] / "docs" / "design" / "r1" / "R1-PLAN-final.md"


class TableTests(unittest.TestCase):
    def test_every_plan_line_id_exists(self):
        for line_id in PLAN_IDS:
            self.assertIn(line_id, LINES)
        for extra in ("L-TRANSITION-NUDGE", "L-REJOIN-RP", "L-FILLER-LEARNER",
                      "L-FILLER-INTERVIEWER"):
            self.assertIn(extra, LINES)

    def test_texts_match_the_plan_section_5_2_table_exactly(self):
        if not PLAN_DOC.exists():
            self.skipTest("plan document is not in this checkout")
        compared = 0
        for row in PLAN_DOC.read_text(encoding="utf-8").splitlines():
            match = re.match(r'^\| (L-[A-Z0-9-]+)[^|]*\| "([^"]*)" \|$', row)
            if not match or match.group(1) not in LINES:
                continue
            with self.subTest(line=match.group(1)):
                self.assertEqual(LINES[match.group(1)], match.group(2))
                compared += 1
        self.assertGreaterEqual(compared, 14)

    def test_the_learner_filler_is_a_three_variant_rotation_led_by_the_classic_line(self):
        variants = r1_script.LEARNER_FILLER_VARIANTS
        self.assertEqual(len(variants), 3)
        self.assertEqual(len(set(variants)), 3)
        self.assertEqual(variants[0], LINES["L-FILLER-LEARNER"])
        self.assertEqual(variants[0], filler_line("learner"))
        for text in variants:
            self.assertLessEqual(len(text.split()), 7, text)
            self.assertTrue(text.endswith("..."), text)
            self.assertNotEqual(text, LINES["L-FILLER-INTERVIEWER"])
            self.assertFalse(text.isupper())

    def test_the_opening_and_transition_say_what_the_plan_says(self):
        self.assertIn("an AI interviewer from Interview Kickstart", LINES["L-OPEN"])
        self.assertIn("about thirty minutes", LINES["L-OPEN"])
        # M3 (owner decision 2026-11-03): the role-play may end before twenty minutes, so both
        # lines say "up to twenty minutes", never a fixed twenty.
        self.assertIn("a sales role-play of up to twenty minutes", LINES["L-OPEN"])
        self.assertNotIn("twenty-minute", LINES["L-OPEN"])
        # The owner's ask: the role-play's length and the goal (convince the learner) are said
        # plainly at its start (M032 S6 / SWEEP-30 option A keeps "convince her").
        self.assertIn("You'll have up to twenty minutes", LINES["L-TRANSITION"])
        self.assertIn("your goal is to convince her as you would on a real call", LINES["L-TRANSITION"])
        self.assertNotIn("runs for twenty minutes", LINES["L-TRANSITION"])
        self.assertNotIn("fourteen", LINES["L-TRANSITION"])
        self.assertIn("'Let's pause the role-play here.'", LINES["L-TRANSITION"])
        self.assertIn("just say 'ready'", LINES["L-TRANSITION"])
        # M1: the brief ends by asking whether to start or take questions first (no auto-start).
        self.assertTrue(LINES["L-TRANSITION"].endswith(
            "Shall we start the role-play now, or do you have any questions first?"
        ))

    def test_the_consent_lines_never_start_the_role_play_themselves(self):
        # M1: every line of the wait asks; none announces that the role-play is starting.
        for line_id in (
            "L-TRANSITION-ASK", "L-TRANSITION-REASK", "L-TRANSITION-REASK-2", "L-TRANSITION-STEER",
            "L-TRANSITION-ASK-PAUSE",  # M032 christy-ready
        ):
            with self.subTest(line=line_id):
                text = LINES[line_id]
                self.assertTrue(is_candidate_free(line_id))
                self.assertNotIn("{", text)
                self.assertNotIn("let's begin", text.lower())
                self.assertIn("ready" if line_id == "L-TRANSITION-REASK-2" else "?", text)
        self.assertNotIn("hiring team", LINES["L-TRANSITION-STEER"])

    def test_the_exit_cue_is_the_exit_lines_first_sentence(self):
        self.assertTrue(LINES["L-EXIT"].startswith(EXIT_CUE))
        self.assertEqual(EXIT_CUE, "Let's pause the role-play here.")

    def test_no_line_makes_a_commitment_or_states_a_fact_beyond_the_plan(self):
        for text in LINES.values():
            self.assertNotIn("$", text)
            self.assertNotRegex(text, r"\b\d{2,}\b")

    def test_the_interviewer_is_christy(self):
        self.assertEqual(r1_script.INTERVIEWER_NAME, "Christy")
        for line_id in ("L-OPEN", "L-MUTE", "L-SIL-RP2", "L-ASIDE-COACH", "L-ASIDE-END", "L-EXIT"):
            self.assertIn("Christy", LINES[line_id])

    def test_the_end_request_lines(self):
        # Owner test 7f2a25e6: the one question after "can you disconnect the call?".  It carries
        # no candidate name, so it is cached across sessions, and its text is owner-approved.
        # Owner decision 2026-10-29 (owner test 1eb18cd4): a confirmed stop ends the role-play and
        # L-EXIT and the wrap-up follow, so the close that ended the whole session is gone.
        self.assertEqual(
            LINES["L-ASIDE-END"],
            "This is Christy, your interviewer. If you want to end the interview now, please say: "
            "end the interview. Otherwise, just carry on with {lead_name}.",
        )
        self.assertEqual(placeholders("L-ASIDE-END"), {"lead_name"})
        self.assertIn("L-ASIDE-END", CANDIDATE_FREE_LINES)
        self.assertNotIn("L-END-CLOSE", LINES)
        self.assertNotIn("L-END-CLOSE", NAME_FREE_LINES)
        for persona in PERSONAS:
            for variant in persona.variants:
                values = resolve_persona(persona.id, variant=variant.id).line_values
                self.assertTrue(
                    line("L-ASIDE-END", **values).endswith(f"carry on with {variant.full_name}.")
                )


class PlaceholderTests(unittest.TestCase):
    def test_placeholders_per_line(self):
        self.assertEqual(placeholders("L-OPEN"), {"first_name"})
        self.assertEqual(placeholders("L-TRANSITION"), {"first_name", "lead_name", "lead_city"})
        self.assertEqual(placeholders("L-PICKUP"), {"lead_first_name"})
        self.assertEqual(placeholders("L-ASIDE-COACH"), {"lead_name"})
        self.assertEqual(placeholders("L-WRAP"), frozenset())

    def test_first_name_is_the_only_candidate_pii(self):
        for line_id in LINES:
            self.assertTrue(
                placeholders(line_id) <= {"first_name", "lead_name", "lead_city",
                                          "lead_first_name"}
            )
        free = set(CANDIDATE_FREE_LINES)
        self.assertNotIn("L-OPEN", free)
        self.assertNotIn("L-CLOSE", free)
        self.assertNotIn("L-REJOIN", free)
        self.assertIn("L-PICKUP", free)
        self.assertIn("L-ASIDE-COACH", free)
        self.assertTrue(is_candidate_free("L-WRAP"))

    def test_name_free_lines_can_be_cached_once_per_machine(self):
        self.assertIn("L-WRAP", NAME_FREE_LINES)
        self.assertIn("L-TIME-CUE", NAME_FREE_LINES)
        self.assertIn("L-NO-FEEDBACK", NAME_FREE_LINES)
        self.assertNotIn("L-OPEN", NAME_FREE_LINES)
        self.assertNotIn("L-PICKUP", NAME_FREE_LINES)


class RenderTests(unittest.TestCase):
    def test_first_name_is_sanitised(self):
        self.assertEqual(safe_first_name("Arjun"), "Arjun")
        self.assertEqual(safe_first_name("Mary-Ann O'Neil"), "Mary-Ann O'Neil")
        for bad in ("", None, "A" * 25, "Arjun2", "Arjun<script>", "Ar\njun", "\u0905\u0930"):
            self.assertEqual(safe_first_name(bad), "there", repr(bad))

    def test_lines_render_with_the_sanitised_name(self):
        self.assertTrue(line("L-OPEN", first_name="Arjun").startswith("Hi Arjun, I'm Dex"))
        # A name the sanitiser rejects is unknown, not "there": the slot is dropped.
        self.assertTrue(line("L-OPEN", first_name="Arjun<b>").startswith("Hi, I'm Dex"))
        self.assertEqual(line("L-SIL-IB", first_name="Arjun"), "Are you still with me, Arjun?")
        self.assertEqual(line("L-WRAP"), LINES["L-WRAP"])

    def test_persona_values_are_required_and_never_come_from_the_candidate(self):
        with self.assertRaises(KeyError):
            line("L-TRANSITION", first_name="Arjun")
        with self.assertRaises(KeyError):
            line("L-NOPE")
        rendered = resolve_persona("p1_career_switcher", variant="v1")
        text = line("L-TRANSITION", first_name="Arjun", **rendered.line_values)
        self.assertIn("Thank you, Arjun.", text)
        self.assertIn("I'll play Meera Iyer from Edison, New Jersey, who filled in", text)
        self.assertNotIn("{", text)

    def test_every_persona_variant_renders_every_persona_line(self):
        for persona in PERSONAS:
            for variant in persona.variants:
                rendered = resolve_persona(persona.id, variant=variant.id)
                values = rendered.line_values
                # M032 S6 item 8: no answer to a question nobody asked.
                self.assertEqual(line("L-PICKUP", **values), f"Hello, {variant.first_name} speaking.")
                self.assertEqual(
                    line("L-PICKUP-V20", **values),
                    f"Hello? Yes, this is {variant.first_name} speaking.",
                )
                self.assertEqual(rendered.pickup_line, line("L-PICKUP", **values))
                # SWEEP-30: Christy says she is PLAYING the learner, never "I'm the learner ... She".
                aside = line("L-ASIDE-COACH", **values)
                self.assertIn(f"I'm playing the learner, {variant.full_name}, who enquired", aside)
                self.assertNotIn("I'm the learner", aside)
                self.assertIn(
                    f"I'm the learner, {variant.full_name}.", line("L-ASIDE-COACH-V20", **values)
                )
                self.assertNotIn(", NJ", line("L-TRANSITION", first_name="A", **values))
                for state in (", TX", ", NC", ", GA", ", MA"):
                    self.assertNotIn(state, line("L-TRANSITION", first_name="A", **values))

    def test_spoken_city_spells_out_the_state(self):
        values = {
            "p1_career_switcher": "Edison, New Jersey",
            "p2_recent_grad": "Austin, Texas",
            "p3_data_analyst": "Charlotte, North Carolina",
            "p4_research_scholar": "Boston, Massachusetts",
        }
        for persona_id, expected in values.items():
            self.assertEqual(resolve_persona(persona_id, variant="v1").spoken_city, expected)
        self.assertEqual(resolve_persona("p3_data_analyst", variant="v3").spoken_city,
                         "Atlanta, Georgia")

    def test_fillers_follow_the_voice(self):
        self.assertEqual(filler_line("learner"), "One second...")
        self.assertEqual(filler_line("interviewer"), "Let me think about that for a second.")

    def test_line_sha_is_the_digest_of_the_exact_text(self):
        digest = line_sha256(LINES["L-WRAP"])
        self.assertRegex(digest, r"^[a-f0-9]{64}$")
        self.assertEqual(digest, line_sha256(LINES["L-WRAP"]))
        self.assertNotEqual(digest, line_sha256(LINES["L-WRAP"] + " "))


class UnknownNameTests(unittest.TestCase):
    """R1-Q item 6: "Thank you, there." The API's placeholder is an unknown name, not a name."""

    UNKNOWN = ("", None, "there", "There", "THERE", " there ", "A", "-", "Arjun<b>", "x" * 25, "12")
    NAMED = ("Arjun", "Mary-Ann", "O'Neil", "Meera", "Bo")

    def persona_values(self):
        return resolve_persona("p1_career_switcher", variant="v1").line_values

    def test_known_first_name_is_the_name_or_empty(self):
        for value in self.NAMED:
            with self.subTest(value=value):
                self.assertEqual(known_first_name(value), value)
        self.assertEqual(known_first_name("  Arjun "), "Arjun")
        for value in self.UNKNOWN:
            with self.subTest(value=value):
                self.assertEqual(known_first_name(value), "")

    def test_safe_first_name_still_falls_back_to_there(self):
        # The old helper keeps its contract (the provisional r1_lines copy is pinned to it).
        for value in self.UNKNOWN[:3] + ("Arjun<b>",):
            self.assertEqual(safe_first_name(value), "there")

    def test_each_name_line_reads_naturally_without_a_name(self):
        values = self.persona_values()
        expected = {
            "L-OPEN": "Hi, I'm Dex, an AI interviewer from Interview Kickstart, and I'll",
            "L-OPEN-HELLO": "Hi, I'm Dex, an AI interviewer from Interview Kickstart. Can you",
            "L-OPEN-HI": "Hi, I'm Dex, an AI interviewer from Interview Kickstart.",
            "L-TRANSITION": "Thank you. Next, let's do a sales role-play. I'll play",
            "L-TRANSITION-V20": (
                "Thank you. We'll now move to the role-play. I'll play a prospective"
            ),
            # M032 diagnosis 3 (D3-ICE1): the thanked briefs.
            "L-TRANSITION-THANKS-A": "Thanks. Next, let's do a sales role-play.",
            "L-TRANSITION-THANKS-B": "Thanks for walking me through that. Next, let's do a sales",
            "L-TRANSITION-THANKS-C": "Got it, thank you. Next, let's do a sales role-play.",
            # M032 diagnosis 4 (D4-BRIEF2): the reworded briefs.
            "L-TRANSITION-W2": "Thank you. Next, let's do a sales role-play. I'll play",
            "L-TRANSITION-THANKS-A-W2": "Thanks. Next, let's do a sales role-play.",
            "L-TRANSITION-THANKS-B-W2": (
                "Thanks for walking me through that. Next, let's do a sales"
            ),
            "L-TRANSITION-THANKS-C-W2": "Got it, thank you. Next, let's do a sales role-play.",
            # Owner 2026-11-24 (R1_SPOKEN_LINES): the spoken briefs.
            "L-TRANSITION-SP": "Thank you. Next, let's do a sales role-play. I'll play",
            "L-TRANSITION-THANKS-A-SP": "Thanks. Next, let's do a sales role-play.",
            "L-TRANSITION-THANKS-B-SP": (
                "Thanks for walking me through that. Next, let's do a sales"
            ),
            "L-TRANSITION-THANKS-C-SP": "Got it, thank you. Next, let's do a sales role-play.",
            "L-CLOSE": (
                "Thank you for your time today. The hiring team will review your interview and "
                "get back to you. You can close this window now. Goodbye."
            ),
            # Simulation diagnosis 3 (D3-WRAP1): the close after the scripted what's-next answer.
            "L-CLOSE-SHORT": (
                "Thank you for your time today. You can close this window now. Goodbye."
            ),
            "L-SIL-IB": "Are you still with me?",
            "L-REJOIN": "Welcome back. Let's pick up where we left off.",
            "L-SYSTEM-STOP": (
                "I'm sorry, we need to stop here because of a technical problem on our side. "
                "This won't count against you, and the hiring team will send you a new link. "
                "Goodbye."
            ),
            # M034 S08 (R1_MEET_VOICE_ENABLED): the Google Meet variants that carry the name.
            "L-OPEN-MEET": (
                "Hi, I'm Dex, an AI interviewer from Interview Kickstart, and I'll be running your "
                "first-round interview for the Sales Program Advisor role. Just so you know, this "
                "call is recorded. It takes about thirty minutes."
            ),
            "L-OPEN-HELLO-MEET": (
                "Hi, I'm Dex, an AI interviewer from Interview Kickstart. Just so you know, this "
                "call is recorded. Can you hear me okay?"
            ),
            "L-OPEN-HI-MEET": (
                "Hi, I'm Dex, an AI interviewer from Interview Kickstart. Just so you know, this "
                "call is recorded."
            ),
            "L-SYSTEM-STOP-MEET": (
                "I'm sorry, we need to stop here because of a technical problem on our side. "
                "This won't count against you, and the hiring team will be in touch to arrange a "
                "new time. Goodbye."
            ),
            "L-CLOSE-MEET": (
                "Thank you for your time today. The hiring team will review your interview and "
                "get back to you. You can leave the call now. Goodbye."
            ),
            "L-CLOSE-SHORT-MEET": (
                "Thank you for your time today. You can leave the call now. Goodbye."
            ),
        }
        # Every line that carries the name slot is covered, so a new one cannot slip through.
        self.assertEqual(
            {line_id for line_id in LINES if "first_name" in placeholders(line_id)},
            set(expected),
        )
        for unknown in self.UNKNOWN:
            for line_id, start in expected.items():
                with self.subTest(unknown=unknown, line=line_id):
                    text = line(line_id, first_name=unknown, **values)
                    self.assertTrue(text.startswith(start), text)
                    self.assertEqual(text, line(line_id, first_name="", **values))
                    self.assertNotIn("{", text)
                    self.assertNotIn("  ", text)
                    self.assertNotRegex(text, r"\s[,.?]|,,|,\.|Hi there|, there\b")

    def test_a_known_name_renders_exactly_as_before(self):
        values = self.persona_values()
        self.assertEqual(
            line("L-CLOSE", first_name="Arjun", **values),
            "Thank you for your time today, Arjun. The hiring team will review your interview "
            "and get back to you. You can close this window now. Goodbye.",
        )
        self.assertEqual(
            line("L-SYSTEM-STOP", first_name="Arjun", **values),
            "I'm sorry, Arjun, we need to stop here because of a technical problem on our side. "
            "This won't count against you, and the hiring team will send you a new link. "
            "Goodbye.",
        )
        self.assertEqual(
            line("L-REJOIN", first_name="Arjun"),
            "Welcome back, Arjun. Let's pick up where we left off.",
        )

    def test_name_free_lines_are_untouched_by_an_unknown_name(self):
        for line_id in NAME_FREE_LINES:
            self.assertEqual(line(line_id, first_name=""), r1_script.persona_text(line_id))

    def test_an_unknown_name_does_not_change_which_lines_may_be_cached(self):
        # Cacheability is a property of the template (its slots), not of the name we have.
        self.assertFalse(is_candidate_free("L-CLOSE"))
        self.assertTrue(is_candidate_free("L-WRAP"))
        self.assertEqual(placeholders("L-CLOSE"), {"first_name"})


class SpokenNameTests(unittest.TestCase):
    """The first name a candidate introduces themselves with (capital letter, letters only)."""

    def test_introductions_are_recognised(self):
        for text, expected in (
            ("Yeah, so my name is Cristo.", "Cristo"),
            ("My name is Cristo and I have eleven years in sales", "Cristo"),
            ("Hi, my name's Priya, nice to meet you", "Priya"),
            ("Hi, my name’s Dev.", "Dev"),
            ("Myself Rahul, working as a sales executive", "Rahul"),
            ("Hello. Myself Anand Kumar.", "Anand"),
            ("Okay, myself Neha.", "Neha"),
            ("Thank you for the opportunity. Myself Vikram.", "Vikram"),
            ("Hi Christy, this is Meera", "Meera"),
            ("This is Sandeep speaking", "Sandeep"),
            ("Good morning, this is Ananya.", "Ananya"),
            ("my name is CRISTO", "Cristo"),
            ("I was told to say it first. My name is Ishaan Rao", "Ishaan"),
        ):
            with self.subTest(text=text):
                self.assertEqual(spoken_first_name(text), expected)

    def test_everything_else_is_not_a_name(self):
        for text in (
            "",
            None,
            "I taught myself Python and then Salesforce",
            "I worked there and this is Salesforce",
            "Well, I think this is Salesforce",
            "Yes, this is Salesforce related",
            "My name is not on the list",
            "this is great",
            "This is a good question",
            "This is Great",
            "my name is",
            "my name is O",
            "my name is " + "A" * 25,
            "my name is Krishna1",
            "my name is Mary-Ann",
            "my name is Christy",
            "I'm Cristo",
            "I am Cristo",
            "Cristo here",
            "my name is " + chr(0x0930) + chr(0x0935) + chr(0x093F),
            "My name is the one on my resume",
            "my name is also on the offer",
        ):
            with self.subTest(text=text):
                self.assertEqual(spoken_first_name(text), "")

    def test_the_first_introduction_wins_and_the_result_is_always_a_known_name(self):
        self.assertEqual(spoken_first_name("My name is Asha. Myself Bina."), "Asha")
        for text in ("My name is Asha", "Myself Rohit.", "Hi, this is Zoe"):
            self.assertEqual(known_first_name(spoken_first_name(text)), spoken_first_name(text))
            self.assertTrue(2 <= len(spoken_first_name(text)) <= 24)
            self.assertTrue(spoken_first_name(text).isalpha())


class ConsensualEndLineTests(unittest.TestCase):
    """M2 (2026-11-03): the offer to wrap up, the hand-back and the learner's closing at time."""

    def test_the_offer_asks_one_question_a_yes_can_answer(self):
        text = LINES["L-ASIDE-WRAP"]
        self.assertIn("Christy", text)
        self.assertIn("would you like to wrap it up here?", text)
        self.assertNotIn(" or keep going", text)  # not an either/or question (as L-ASIDE-END)
        self.assertEqual(placeholders("L-ASIDE-WRAP"), {"lead_first_name"})
        self.assertEqual(placeholders("L-ASIDE-WRAP-RESUME"), {"lead_first_name"})
        self.assertEqual(placeholders("L-TIME-UP"), frozenset())
        for line_id in ("L-ASIDE-WRAP", "L-ASIDE-WRAP-RESUME", "L-TIME-UP"):
            with self.subTest(line=line_id):
                self.assertIn(line_id, CANDIDATE_FREE_LINES)

    def test_the_closing_at_time_promises_nothing_and_names_nobody(self):
        text = LINES["L-TIME-UP"].lower()
        for word in ("hiring team", "enrol", "call you", "book", "email", "pay", "christy"):
            with self.subTest(word=word):
                self.assertNotIn(word, text)
        self.assertNotIn("pause the role-play", LINES["L-ASIDE-WRAP-RESUME"].lower())


class TransitionBridgeLineTests(unittest.TestCase):
    """M032 S5 item 4: the brief after Christy's own reaction does not thank the candidate again.

    L-TRANSITION-BRIDGED is L-TRANSITION without "Thank you, {first_name}." (the reaction sentence
    took its place), so it carries no candidate name and can be kept on disk once per machine.
    """

    OPENER = "Thank you, {first_name}. "

    def test_it_is_the_brief_without_its_thanks(self):
        self.assertTrue(LINES["L-TRANSITION"].startswith(self.OPENER))
        self.assertEqual(
            LINES["L-TRANSITION-BRIDGED"], LINES["L-TRANSITION"][len(self.OPENER) :]
        )
        self.assertEqual(placeholders("L-TRANSITION-BRIDGED"), {"lead_name", "lead_city"})
        self.assertIn("L-TRANSITION-BRIDGED", CANDIDATE_FREE_LINES)
        self.assertNotIn("thank", LINES["L-TRANSITION-BRIDGED"].lower())
        self.assertTrue(LINES["L-TRANSITION-BRIDGED"].endswith(
            "Shall we start the role-play now, or do you have any questions first?"
        ))


class TransitionRepairLineTests(unittest.TestCase):
    """M032 S6 (items 4, 5, 6, 8; SWEEP-29, -30, -32): the brief from one body, its replay and
    recap, the presence and pickup lines, the rotated start questions, and the rollback ids."""

    V20 = (
        "Thank you, {first_name}. We'll now move to the role-play. I'll play a prospective "
        "learner so we can evaluate how you handle a real sales call. The learner is "
        "{lead_name} from {lead_city}, who filled in a form on our website about the Data "
        "Science course a few days ago. You're the Program Advisor calling her back. The "
        "role-play runs for up to twenty minutes, and in that time your goal is to convince "
        "her: understand her needs and help her decide to enrol, as you would on a real call, "
        "using the course details from your preparation guide. I'll stay in character until I "
        "say, 'Let's pause the role-play here.' When you'd like to begin, just say 'ready' and "
        "she'll pick up. Shall we start the role-play now, or do you have any questions first?"
    )
    EITHER_OR = "Shall we start the role-play now, or do you have any questions first?"
    BRIEFS = ("L-TRANSITION", "L-TRANSITION-BRIDGED", "L-TRANSITION-AGAIN")

    @staticmethod
    def words(text: str) -> int:
        """Words, with each placeholder counted as one."""
        return len(re.sub(r"\{[a-z_]+\}", "X", text).split())

    def test_the_three_briefs_share_one_body(self):
        thanks, body = "Thank you, {first_name}. ", LINES["L-TRANSITION-BRIDGED"]
        self.assertEqual(LINES["L-TRANSITION"], thanks + body)
        self.assertEqual(body, r1_script.BRIEF_BODY)
        tail = body[body.index("I'll play {lead_name}"):]
        self.assertEqual(LINES["L-TRANSITION-AGAIN"], "Of course, here it is again. " + tail)
        self.assertIn(r1_script.BRIEF_GOAL, body)

    def test_the_brief_says_less_once_and_keeps_what_the_candidate_needs(self):
        text = LINES["L-TRANSITION"]
        self.assertLessEqual(self.words(text), 105)
        longest = 0
        for persona in PERSONAS:
            for variant in persona.variants:
                values = resolve_persona(persona.id, variant=variant.id).line_values
                longest = max(longest, len(line("L-TRANSITION", first_name="Mary-Ann", **values).split()))
        self.assertLessEqual(longest, 112)
        for line_id in self.BRIEFS:
            with self.subTest(line=line_id):
                brief = LINES[line_id]
                self.assertEqual(brief.count("twenty minutes"), 1)
                self.assertNotIn("evaluate", brief)
                self.assertNotIn("We'll now move", brief)
                self.assertNotIn("she'll pick up", brief)
                self.assertEqual(brief.count("just say 'ready'"), 1)
                self.assertTrue(brief.endswith("To begin, just say 'ready'. " + self.EITHER_OR))
                for kept in ("{lead_name}", "{lead_city}", "Data Science course", "calling her back",
                             "help her decide to enrol",
                             "using the course details from your preparation guide",
                             f"'{EXIT_CUE}'", "convince her"):
                    self.assertIn(kept, brief)
        self.assertNotIn("first_name", placeholders("L-TRANSITION-AGAIN"))
        self.assertIn("L-TRANSITION-AGAIN", CANDIDATE_FREE_LINES)

    def test_the_rollback_ids_hold_revision_21s_text(self):
        self.assertEqual(LINES["L-TRANSITION-V20"], self.V20)
        self.assertEqual(
            LINES["L-TRANSITION-BRIDGED-V20"], self.V20[len("Thank you, {first_name}. "):]
        )
        self.assertEqual(
            r1_script.ROLLBACK_LINES,
            {
                "L-TRANSITION": "L-TRANSITION-V20",
                "L-TRANSITION-BRIDGED": "L-TRANSITION-BRIDGED-V20",
                "L-PICKUP": "L-PICKUP-V20",
                "L-ASIDE-COACH": "L-ASIDE-COACH-V20",
            },
        )

    def test_the_flag_picks_the_spoken_id(self):
        import os
        from unittest import mock

        with mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": "0"}):
            self.assertFalse(r1_script.transition_repair_enabled())
            for line_id, old in r1_script.ROLLBACK_LINES.items():
                self.assertEqual(r1_script.active_line_id(line_id), old)
            self.assertEqual(r1_script.active_line_id("L-WRAP"), "L-WRAP")
        for value in ("1", "on", "", "yes"):
            # R1_SPOKEN_LINES=0: the S6 ids themselves (the spoken -SP ids are SpokenLinesTests').
            with mock.patch.dict(
                os.environ,
                {"R1_TRANSITION_REPAIR": value, "R1_BRIEF_WORDING_V2": "0", "R1_SPOKEN_LINES": "0"},
            ):
                self.assertTrue(r1_script.transition_repair_enabled())
                for line_id in r1_script.ROLLBACK_LINES:
                    self.assertEqual(r1_script.active_line_id(line_id), line_id)

    def test_the_recap_is_short_public_and_ends_with_the_either_or_question(self):
        recap = LINES["L-TRANSITION-RECAP"]
        self.assertEqual(placeholders("L-TRANSITION-RECAP"), {"lead_name"})
        self.assertIn("L-TRANSITION-RECAP", CANDIDATE_FREE_LINES)
        self.assertTrue(recap.startswith("Of course, in short: I'll play {lead_name}"))
        goal = r1_script.BRIEF_GOAL
        self.assertIn(goal[:1].upper() + goal[1:], recap)
        # Diagnosis 1 (CR-1): its own either/or question, not the brief's word for word.
        self.assertTrue(recap.endswith(r1_script.RECAP_START_PROMPT))
        self.assertNotIn(self.EITHER_OR, recap)
        self.assertIn(", or ", r1_script.RECAP_START_PROMPT)
        self.assertLessEqual(self.words(recap), 46)  # about 15 s
        for private in ("$", "7,000", "budget", "husband", "worried", "price"):
            self.assertNotIn(private, recap)

    def test_the_short_lines(self):
        self.assertEqual(LINES["L-PRESENT"], "Yes, I'm here.")
        self.assertEqual(LINES["L-PICKUP-BRIDGE"], "Great, here she is.")
        self.assertEqual(
            LINES["L-IB-HOLD"], "Of course, take a moment. I'm here when you're ready."
        )
        for line_id in ("L-PRESENT", "L-PICKUP-BRIDGE", "L-IB-HOLD"):
            self.assertIn(line_id, NAME_FREE_LINES)

    def test_the_rotated_start_questions_stay_either_or(self):
        # SWEEP-32: shorter forms after the brief's question was heard; a bare "yes" to an
        # either/or question still gets the nudge, so every form offers both.
        self.assertEqual(LINES["L-TRANSITION-ASK-2"], "Anything else, or shall we start?")
        self.assertEqual(
            LINES["L-TRANSITION-ASK-3"], "Any other questions, or shall we begin the role-play?"
        )
        for line_id in ("L-TRANSITION-ASK", "L-TRANSITION-ASK-2", "L-TRANSITION-ASK-3"):
            text = LINES[line_id]
            self.assertIn(", or ", text)
            self.assertTrue(text.endswith("?"))
            self.assertIn(line_id, NAME_FREE_LINES)

    def test_the_pause_prompt_word_for_word(self):
        # M032 christy-ready (R1_START_ASK_ONCE): the one start prompt a quiet pause gets once the
        # answers before the role-play end without one.  A yes/no question (a bare "yes" starts),
        # worded unlike every other start question, and naming the spoken "ready".
        self.assertEqual(
            LINES["L-TRANSITION-ASK-PAUSE"],
            "If that covers everything, shall we begin the role-play? Just say 'ready' whenever "
            "you like.",
        )
        self.assertNotIn(", or ", LINES["L-TRANSITION-ASK-PAUSE"])
        self.assertIn("L-TRANSITION-ASK-PAUSE", NAME_FREE_LINES)


class OpeningSoundCheckLineTests(unittest.TestCase):
    """M032 S7C (SWEEP-35, ``R1_OPENING_SOUND_CHECK``): a short hello with a sound check, then a
    shorter agenda.  Every text is word for word the spec's (owner and HR review, D-M032-4)."""

    AGENDAS = ("L-OPEN-AGENDA", "L-OPEN-AGENDA-PLAIN", "L-OPEN-AGENDA-CONTINUE")

    def test_hello_without_hearing_check(self):
        self.assertEqual(placeholders("L-OPEN-HI"), {"first_name"})
        self.assertFalse(is_candidate_free("L-OPEN-HI"))
        self.assertEqual(line("L-OPEN-HI", first_name="Arjun"),
                         "Hi Arjun, I'm Dex, an AI interviewer from Interview Kickstart.")
        self.assertEqual(line("L-OPEN-HI", first_name=""),
                         "Hi, I'm Dex, an AI interviewer from Interview Kickstart.")
        self.assertNotIn("?", LINES["L-OPEN-HI"])
        self.assertNotIn("hear", LINES["L-OPEN-HI"].lower())
        self.assertIn("AI interviewer", LINES["L-OPEN-HI"])

    def test_the_texts_word_for_word(self):
        self.assertEqual(
            LINES["L-OPEN-HELLO"],
            "Hi {first_name}, I'm Christy, an AI interviewer from Interview Kickstart. Can you "
            "hear me okay?",
        )
        self.assertEqual(
            LINES["L-OPEN-HELLO-AGAIN"],
            "Sorry about that. Please check your speaker or headphone volume. Can you hear me now?",
        )
        agenda = (
            "This first-round interview takes about thirty minutes: we'll get to know each "
            "other, then do a sales role-play of up to twenty minutes, and you can ask me "
            "questions at the end."
        )
        first = "So, to begin, tell me a bit about yourself and your sales or customer-facing work."
        self.assertEqual(LINES["L-OPEN-AGENDA"], f"Good, I can hear you. {agenda} {first}")
        self.assertEqual(LINES["L-OPEN-AGENDA-PLAIN"], f"Let's get started. {agenda} {first}")
        self.assertEqual(
            LINES["L-OPEN-AGENDA-CONTINUE"],
            f"Good, I can hear you. {agenda} Please, carry on with what you were telling me.",
        )

    def test_the_hello_carries_the_disclosure_and_the_name_and_reads_without_one(self):
        self.assertEqual(placeholders("L-OPEN-HELLO"), {"first_name"})
        self.assertIn("AI interviewer", LINES["L-OPEN-HELLO"])
        self.assertFalse(is_candidate_free("L-OPEN-HELLO"))
        self.assertTrue(
            line("L-OPEN-HELLO", first_name="Arjun").startswith("Hi Arjun, I'm Dex, an AI")
        )
        self.assertEqual(
            line("L-OPEN-HELLO", first_name=""),
            "Hi, I'm Dex, an AI interviewer from Interview Kickstart. Can you hear me okay?",
        )

    def test_every_agenda_keeps_the_owner_durations_once_and_is_short(self):
        for line_id in self.AGENDAS:
            text = LINES[line_id]
            with self.subTest(line=line_id):
                self.assertEqual(text.count("thirty minutes"), 1)
                self.assertEqual(text.count("up to twenty minutes"), 1)
                self.assertLessEqual(len(text.split()), 55)
                for banned in ("short", "Let's start:", "{", "couple of minutes", "few minutes"):
                    self.assertNotIn(banned, text)
                self.assertIn(line_id, NAME_FREE_LINES)
        self.assertIn("L-OPEN-HELLO-AGAIN", NAME_FREE_LINES)
        # The plain agenda is the one said when nothing was heard in reply: no "I can hear you".
        self.assertNotIn("hear you", LINES["L-OPEN-AGENDA-PLAIN"])
        # The agenda asks the icebreaker plan's first objective (background and sales work), as
        # L-OPEN did; the continue variant asks nothing new.
        self.assertIn("sales or customer-facing work", LINES["L-OPEN-AGENDA"])
        self.assertNotIn("?", LINES["L-OPEN-AGENDA-CONTINUE"])

    def test_the_flag_off_opening_is_unchanged(self):
        self.assertEqual(
            LINES["L-OPEN"],
            "Hi {first_name}, I'm Christy, an AI interviewer from Interview Kickstart, and I'll "
            "be running your first-round interview for the Sales Program Advisor role. It takes "
            "about thirty minutes. We'll spend a few minutes getting to know you, then I'll switch "
            "into a sales role-play of up to twenty minutes where I play a prospective learner, "
            "and we'll finish with a couple of minutes for your questions. Let's start: could you "
            "walk me through your background, especially any sales or customer-facing work "
            "you've done?",
        )


class NoAudioAndMuteLineTests(unittest.TestCase):
    """M032 S7C: the never-heard ladder (SWEEP-34) and the mute aside by phase (SWEEP-36)."""

    def test_the_no_audio_texts_word_for_word(self):
        self.assertEqual(
            LINES["L-SIL-NOAUDIO"],
            "I can't hear anything from you yet. If you're speaking, please check that "
            "your microphone is switched on and selected.",
        )
        self.assertEqual(
            LINES["L-SIL-END-NOAUDIO"],
            "I still can't hear you, so I'll have to stop here for now. The hiring team will "
            "be in touch. Goodbye.",
        )
        for line_id in ("L-SIL-NOAUDIO", "L-SIL-END-NOAUDIO"):
            text = LINES[line_id]
            self.assertIn(line_id, NAME_FREE_LINES)
            # Hedged: no lost connection, no claim about whether the attempt counts.
            for banned in ("lost", "connection", "count", "still with me"):
                self.assertNotIn(banned, text)

    def test_the_mute_texts_word_for_word_and_neither_says_ready(self):
        self.assertEqual(
            LINES["L-MUTE-RP"],
            "This is Christy, your interviewer. Your microphone seems to be muted. Please "
            "unmute it so we can carry on.",
        )
        self.assertEqual(
            LINES["L-MUTE-IV"],
            "Your microphone seems to be muted. Please unmute it so I can hear you.",
        )
        for line_id in ("L-MUTE-RP", "L-MUTE-IV"):
            self.assertNotIn("ready", LINES[line_id].lower())
            self.assertIn(line_id, NAME_FREE_LINES)
        self.assertNotIn("Christy", LINES["L-MUTE-IV"])  # her own phase: no self-introduction
        self.assertEqual(
            LINES["L-MUTE"],
            "This is Christy. It looks like your microphone may be muted. Please unmute when "
            "you're ready.",
        )


if __name__ == "__main__":
    unittest.main()


class TestDiagnosis4Wording(unittest.TestCase):
    """M032 live simulation, diagnosis 4 (D4-BRIEF2, R1_BRIEF_WORDING_V2; D4-TRANS-PRESENT1): the agenda
    and the brief in a person's words, same facts, same consent; one presence line; the pickup
    bridge that hears the press."""

    VALUES = {"lead_name": "Priya Shah", "lead_city": "Pune", "lead_first_name": "Priya"}

    def test_the_brief_keeps_every_fact(self) -> None:
        for line_id in r1_script.WORDING_LINES.values():
            if not line_id.startswith("L-TRANSITION"):
                continue
            with self.subTest(line_id=line_id):
                text = r1_script.line(line_id, first_name="Asha", **self.VALUES)
                for fact in (
                    "Priya Shah",
                    "Pune",
                    "Data Science",
                    "twenty minutes",
                    "preparation guide",
                    "'Let's pause the role-play here.'",
                    "just say 'ready'",
                ):
                    self.assertIn(fact, text)
                self.assertNotIn(":", text.split("Treat it like a real call:")[0])
                self.assertTrue(text.endswith(r1_script.BRIEF_START_PROMPT_2))
                self.assertNotIn("Shall we start the role-play now", text)

    def test_the_agenda_keeps_the_owner_s_durations(self) -> None:
        for line_id in ("L-OPEN-AGENDA-W2", "L-OPEN-AGENDA-PLAIN-W2", "L-OPEN-AGENDA-CONTINUE-W2"):
            with self.subTest(line_id=line_id):
                text = r1_script.LINES[line_id]
                self.assertIn("about thirty minutes", text)
                self.assertIn("up to twenty minutes", text)
                self.assertNotIn("minutes:", text)
        self.assertTrue(r1_script.LINES["L-OPEN-AGENDA-W2"].startswith("Great, I can hear you too."))

    def test_the_flag_picks_the_text(self) -> None:
        # D5-AGENDA1: the agendas' W2 text is what R1_AGENDA_W3=0 speaks.
        for line_id, reworded in r1_script.WORDING_LINES.items():
            with self.subTest(line_id=line_id):
                # R1_SPOKEN_LINES=0: the W2 ids themselves (SpokenLinesTests has the -SP ids).
                with mock.patch.dict(os.environ, {"R1_AGENDA_W3": "0", "R1_SPOKEN_LINES": "0"}):
                    self.assertEqual(r1_script.active_line_id(line_id), reworded)
                with mock.patch.dict(os.environ, {"R1_BRIEF_WORDING_V2": "0"}):
                    self.assertEqual(r1_script.active_line_id(line_id), line_id)
        with mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": "0", "R1_AGENDA_W3": "0"}):
            self.assertEqual(r1_script.active_line_id("L-TRANSITION"), "L-TRANSITION-V20")
            self.assertEqual(r1_script.active_line_id("L-OPEN-AGENDA"), "L-OPEN-AGENDA-W2")

    def test_the_presence_line_and_the_pickup_bridge(self) -> None:
        self.assertEqual(
            r1_script.LINES["L-PRESENT-TAKE-TIME"],
            "Yes, I'm here. Take your time, and just say 'ready' whenever you like.",
        )
        self.assertEqual(r1_script.active_line_id("L-PICKUP-BRIDGE"), "L-PICKUP-BRIDGE-2")
        self.assertEqual(
            r1_script.line("L-PICKUP-BRIDGE-2", **self.VALUES), "Got it, you're ready. Here's Priya."
        )
        with mock.patch.dict(os.environ, {"R1_BRIEF_VARIETY": "0"}):
            self.assertEqual(r1_script.active_line_id("L-PICKUP-BRIDGE"), "L-PICKUP-BRIDGE")

    def test_the_field_answers_are_short_and_candidate_free(self) -> None:
        for line_id in r1_script.LINES:
            if not line_id.startswith("L-RP-"):
                continue
            with self.subTest(line_id=line_id):
                self.assertTrue(r1_script.is_candidate_free(line_id))
                text = r1_script.line(line_id, **self.VALUES)
                self.assertLessEqual(len(text.split()), 20)
                self.assertNotIn("?", text)


class TestDiagnosis5Agenda(unittest.TestCase):
    """M032 live simulation, diagnosis 5 (D5-AGENDA1, R1_AGENDA_W3): the W2 agenda's "takes about
    thirty minutes." then "a sales role-play of up to twenty minutes" was read as a contradiction;
    one sentence now shows the parts make up the whole."""

    IDS = ("L-OPEN-AGENDA", "L-OPEN-AGENDA-PLAIN", "L-OPEN-AGENDA-CONTINUE")

    def test_the_whole_and_its_parts_are_one_sentence(self) -> None:
        for line_id in r1_script.AGENDA_W3_LINES.values():
            with self.subTest(line_id=line_id):
                text = r1_script.LINES[line_id]
                sentence = next(
                    part for part in re.split(r"(?<=[.?!])\s+", text) if "whole interview" in part
                )
                self.assertIn("thirty", sentence)
                self.assertIn("up to twenty", sentence)
                self.assertNotIn("Great, I can hear you too", text)
                # Review of diagnosis 5 (D5-AGENDA1-R1): never the "I can hear you" echo that
                # D4-BRIEF2 removed.
                self.assertNotIn("I can hear you", text)

    def test_the_heard_line_and_the_first_question(self) -> None:
        self.assertEqual(
            r1_script.LINES["L-OPEN-AGENDA-W3"],
            "Lovely, thanks. The whole interview takes about thirty minutes: a few minutes "
            "to get to know you, a sales role-play of up to twenty minutes, then time for your "
            "questions. To start, tell me a bit about yourself and the sales or customer-facing "
            "work you've done.",
        )
        self.assertTrue(r1_script.LINES["L-OPEN-AGENDA-PLAIN-W3"].startswith("Let's get started. "))
        self.assertTrue(
            r1_script.LINES["L-OPEN-AGENDA-CONTINUE-W3"].endswith(r1_script.OPEN_CARRY_ON)
        )

    def test_the_flag_picks_the_text(self) -> None:
        for line_id in self.IDS:
            with self.subTest(line_id=line_id):
                with mock.patch.dict(os.environ, {"R1_AGENDA_W4": "0"}):
                    self.assertEqual(r1_script.active_line_id(line_id), line_id + "-W3")
                with mock.patch.dict(os.environ, {"R1_AGENDA_W3": "0"}):
                    self.assertEqual(r1_script.active_line_id(line_id), line_id + "-W2")
                with mock.patch.dict(os.environ, {"R1_BRIEF_WORDING_V2": "0"}):
                    self.assertEqual(r1_script.active_line_id(line_id), line_id)
                    self.assertFalse(r1_script.agenda_w3_enabled())


class TestMeetLines(unittest.TestCase):
    """M034 S08 (``R1_MEET_VOICE_ENABLED``, default off): the Google Meet line variants.

    Nine browser lines get a ``-MEET`` variant that a Meet session speaks (``MEET_LINES``, applied
    after ``active_line_id``): the three openings add the recording disclosure (owner: "Dex still
    discloses he is an AI and that the call is recorded"), the sound check's hello-again repeats it
    with the AI disclosure (review S08-2: the candidate said they could not hear the hello), and
    the other five drop the button, link and window wording, because a Meet candidate never sees
    our page.  No browser text changes.
    """

    # sha256 of the canonical JSON of all 113 LINES on 5ec8b11a (content revision 50), before the
    # Meet variants.  Recomputed below over LINES without the Meet ids: every browser text is byte
    # for byte what it was.  A later revision that changes a browser line on purpose recomputes it
    # with the same recipe.
    PRE_MEET_LINES_DIGEST = "05b905726461fdf19b89143c66c991772b03e6dfd20f78fe4dfbeee84139acdb"
    # Wording that assumes the candidate can see or operate our page (S08 plan section 2).
    BANNED = re.compile(
        r"\b(?:button|click|press|tap|link|refresh|reload|window|browser|tab|screen|page|"
        r"selected)\b",
        re.IGNORECASE,
    )
    ROUTING_FLAGS = (
        "R1_TRANSITION_REPAIR", "R1_BRIEF_WORDING_V2", "R1_AGENDA_W3", "R1_TRANSITION_PRESENCE_V2",
        "R1_SPOKEN_LINES",
    )
    OPENINGS = ("L-OPEN", "L-OPEN-HELLO", "L-OPEN-HI")
    # The sound check's repeat after "I can't hear you": the disclosure again (review S08-2).
    REPEATS = ("L-OPEN-HELLO-AGAIN",)
    NOT_OPENINGS = (
        "L-TRANSITION-REASK-2", "L-SYSTEM-STOP", "L-CLOSE", "L-CLOSE-SHORT", "L-SIL-NOAUDIO",
    )
    # The hello-again's Meet text, word for word (persona-neutral and name-free, like its base).
    HELLO_AGAIN_MEET = (
        "Sorry about that. Please check your speaker or headphone volume. Just so you know, I'm an "
        "AI interviewer and this call is recorded. Can you hear me now?"
    )
    # What the default interviewer (Dex) says to a candidate called Asha: plan section 2, exactly.
    DEX_OPENINGS = {
        "L-OPEN-MEET": (
            "Hi Asha, I'm Dex, an AI interviewer from Interview Kickstart, and I'll be running "
            "your first-round interview for the Sales Program Advisor role. Just so you know, this "
            "call is recorded. It takes about thirty minutes. We'll spend a few minutes getting to "
            "know you, then I'll switch into a sales role-play of up to twenty minutes where I "
            "play a prospective learner, and we'll finish with a couple of minutes for your "
            "questions. Let's start: could you walk me through your background, especially any "
            "sales or customer-facing work you've done?"
        ),
        "L-OPEN-HELLO-MEET": (
            "Hi Asha, I'm Dex, an AI interviewer from Interview Kickstart. Just so you know, this "
            "call is recorded. Can you hear me okay?"
        ),
        "L-OPEN-HI-MEET": (
            "Hi Asha, I'm Dex, an AI interviewer from Interview Kickstart. Just so you know, this "
            "call is recorded."
        ),
    }
    # The other five, as written in LINES (persona-neutral or name-only).
    OTHER_TEXTS = {
        "L-TRANSITION-REASK-2-MEET": (
            "I'm still here whenever you're ready. Just say 'ready', and she'll pick up."
        ),
        "L-SYSTEM-STOP-MEET": (
            "I'm sorry, {first_name}, we need to stop here because of a technical problem on our "
            "side. This won't count against you, and the hiring team will be in touch to arrange "
            "a new time. Goodbye."
        ),
        "L-CLOSE-MEET": (
            "Thank you for your time today, {first_name}. The hiring team will review your "
            "interview and get back to you. You can leave the call now. Goodbye."
        ),
        "L-CLOSE-SHORT-MEET": (
            "Thank you for your time today, {first_name}. You can leave the call now. Goodbye."
        ),
        "L-SIL-NOAUDIO-MEET": (
            "I can't hear anything from you yet. If you're speaking, please check that you're not "
            "muted in Google Meet."
        ),
    }

    @staticmethod
    def values() -> dict[str, str]:
        rendered = resolve_persona("p1_career_switcher", variant="v1")
        return {**rendered.line_values, "first_name": "Asha"}

    @staticmethod
    def persona_env(dex: str | None) -> dict[str, str]:
        return {} if dex is None else {"R1_INTERVIEWER_DEX": dex}

    def test_no_browser_text_changed(self):
        meet_ids = set(r1_script.MEET_LINES.values())
        # Revision 52 ADDED the W4 agenda ids (R1_AGENDA_W4); leaving them out keeps the proof
        # that no line that existed on 5ec8b11a changed.
        added_ids = set(r1_script.AGENDA_W4_LINES.values())
        # Revision 54 ADDED the spoken -SP ids (R1_SPOKEN_LINES); no existing text changed.
        added_ids |= set(r1_script.SPOKEN_LINES.values())
        browser = {
            key: text for key, text in LINES.items() if key not in meet_ids | added_ids
        }
        canonical = json.dumps(browser, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
        self.assertEqual(
            hashlib.sha256(canonical.encode()).hexdigest(), self.PRE_MEET_LINES_DIGEST
        )

    def test_the_map_names_nine_existing_lines_and_their_meet_ids(self):
        meet = r1_script.MEET_LINES
        self.assertEqual(
            set(meet), set(self.OPENINGS) | set(self.REPEATS) | set(self.NOT_OPENINGS)
        )
        self.assertEqual(len(meet), 9)
        for key, value in meet.items():
            with self.subTest(line=key):
                self.assertIn(key, LINES)
                self.assertIn(value, LINES)
                self.assertEqual(value, key + "-MEET")
                self.assertNotIn(value, meet)  # no chaining: a Meet id is never a key
                self.assertNotEqual(LINES[value], LINES[key])
        self.assertEqual(len(set(meet.values())), len(meet))

    def test_the_map_is_disjoint_from_the_other_routing_maps(self):
        touched = set(r1_script.MEET_LINES) | set(r1_script.MEET_LINES.values())
        for name in (
            "ROLLBACK_LINES", "WORDING_LINES", "AGENDA_W3_LINES", "VARIETY_LINES", "SPOKEN_LINES",
        ):
            other = getattr(r1_script, name)
            with self.subTest(other=name):
                self.assertEqual(touched & (set(other) | set(other.values())), set())

    def test_active_line_id_never_remaps_a_meet_key_or_id_under_any_flag_state(self):
        touched = (*r1_script.MEET_LINES, *r1_script.MEET_LINES.values())
        for states in itertools.product("01", repeat=len(self.ROUTING_FLAGS)):
            with mock.patch.dict(os.environ, dict(zip(self.ROUTING_FLAGS, states)), clear=True):
                for line_id in touched:
                    with self.subTest(states=states, line=line_id):
                        self.assertEqual(r1_script.active_line_id(line_id), line_id)

    def test_meet_line_id_routes_only_the_nine_keys_and_never_chains(self):
        for line_id in LINES:
            with self.subTest(line=line_id):
                routed = r1_script.meet_line_id(line_id)
                expected = r1_script.MEET_LINES.get(line_id, line_id)
                self.assertEqual(routed, expected)
                self.assertEqual(r1_script.meet_line_id(routed), routed)
        self.assertEqual(r1_script.meet_line_id("L-NOPE"), "L-NOPE")

    def test_each_pair_has_the_same_placeholders_and_cacheability(self):
        # So the warm-up's persist or candidate-free choice for a base id stays right for the
        # text a Meet session speaks: a clip that carries the name is never kept on disk.
        for dex in (None, "1", "0"):
            with mock.patch.dict(os.environ, self.persona_env(dex), clear=True):
                for key, value in r1_script.MEET_LINES.items():
                    with self.subTest(dex=dex, line=key):
                        self.assertEqual(placeholders(value), placeholders(key))
                        self.assertEqual(is_candidate_free(value), is_candidate_free(key))
                        self.assertEqual(
                            value in CANDIDATE_FREE_LINES, key in CANDIDATE_FREE_LINES
                        )
                        self.assertEqual(value in NAME_FREE_LINES, key in NAME_FREE_LINES)

    def test_no_meet_line_tells_the_candidate_to_press_open_or_close_anything(self):
        values = self.values()
        for dex in (None, "1", "0"):
            with mock.patch.dict(os.environ, self.persona_env(dex), clear=True):
                for line_id in LINES:
                    with self.subTest(dex=dex, line=line_id):
                        text = line(r1_script.meet_line_id(line_id), **values)
                        self.assertIsNone(self.BANNED.search(text), text)
                # Not vacuous: the five browser lines the Meet variants replace match today, and
                # they are the only lines in the table that do.
                matching = {i for i in LINES if self.BANNED.search(line(i, **values))}
                self.assertEqual(matching, set(self.NOT_OPENINGS))

    def test_the_meet_openings_disclose_the_ai_and_the_recording(self):
        for dex, name in ((None, "Dex"), ("1", "Dex"), ("0", "Christy")):
            with mock.patch.dict(os.environ, self.persona_env(dex), clear=True):
                for key in self.OPENINGS:
                    meet_id = r1_script.meet_line_id(key)
                    with self.subTest(dex=dex, line=meet_id):
                        for first_name in ("Asha", ""):
                            text = line(meet_id, first_name=first_name)
                            self.assertIn("AI interviewer", text)
                            self.assertIn("this call is recorded", text)
                            self.assertNotIn(
                                "Christy" if name == "Dex" else "Dex", text
                            )
                        self.assertTrue(
                            line(meet_id, first_name="Asha").startswith(f"Hi Asha, I'm {name}")
                        )
                        # The browser opening is unchanged: no recording sentence.
                        self.assertNotIn("recorded", line(key, first_name="Asha"))
                        # The disclosure is the only difference from the browser opening.
                        self.assertEqual(
                            LINES[meet_id].replace(" Just so you know, this call is recorded.", ""),
                            LINES[key],
                        )
        with mock.patch.dict(os.environ, {}, clear=True):
            for meet_id, expected in self.DEX_OPENINGS.items():
                with self.subTest(line=meet_id):
                    self.assertEqual(line(meet_id, first_name="Asha"), expected)
                    self.assertIn(meet_id, r1_script.DEX_LINES)

    def test_the_meet_hello_again_repeats_the_ai_and_recording_disclosure(self):
        # Review S08-2: in Meet the spoken notice is the only one (no consent page), so the repeat
        # after "I can't hear you" carries both again.  The browser hello-again is unchanged.
        self.assertEqual(r1_script.meet_line_id("L-OPEN-HELLO-AGAIN"), "L-OPEN-HELLO-AGAIN-MEET")
        text = LINES["L-OPEN-HELLO-AGAIN-MEET"]
        self.assertEqual(text, self.HELLO_AGAIN_MEET)
        self.assertIn("AI interviewer", text)
        self.assertIn("this call is recorded", text)
        self.assertTrue(text.endswith("Can you hear me now?"))
        # The disclosure sentence is the only difference from the browser line.
        self.assertEqual(
            text.replace(" Just so you know, I'm an AI interviewer and this call is recorded.", ""),
            LINES["L-OPEN-HELLO-AGAIN"],
        )
        self.assertNotIn("recorded", LINES["L-OPEN-HELLO-AGAIN"])
        self.assertIn("L-OPEN-HELLO-AGAIN-MEET", NAME_FREE_LINES)
        self.assertNotIn("L-OPEN-HELLO-AGAIN-MEET", r1_script.DEX_LINES)  # persona-neutral
        for dex in (None, "1", "0"):
            with self.subTest(dex=dex), mock.patch.dict(
                os.environ, self.persona_env(dex), clear=True
            ):
                self.assertEqual(line("L-OPEN-HELLO-AGAIN-MEET"), self.HELLO_AGAIN_MEET)

    def test_the_other_meet_texts_word_for_word(self):
        for meet_id, expected in self.OTHER_TEXTS.items():
            with self.subTest(line=meet_id):
                self.assertEqual(LINES[meet_id], expected)
                self.assertNotIn(meet_id, r1_script.DEX_LINES)  # persona-neutral
        # The base lines' own rules carry over to their Meet variants.
        reask = LINES["L-TRANSITION-REASK-2-MEET"]
        self.assertIn("ready", reask)
        self.assertTrue(is_candidate_free("L-TRANSITION-REASK-2-MEET"))
        self.assertNotIn("let's begin", reask.lower())
        self.assertEqual(LINES["L-CLOSE-MEET"].lower().count("hiring team"), 1)
        self.assertNotIn("hiring team", LINES["L-CLOSE-SHORT-MEET"].lower())
        noaudio = LINES["L-SIL-NOAUDIO-MEET"]
        self.assertIn("L-SIL-NOAUDIO-MEET", NAME_FREE_LINES)
        for banned in ("lost", "connection", "count", "still with me"):
            self.assertNotIn(banned, noaudio)

class TestOwnerAgendaW4(unittest.TestCase):
    """Owner 2026-11-24 (R1_AGENDA_W4): the W3 agenda sounded read aloud in Dex's voice; the owner
    picked spoken sentences and a first question ending in "?" from four production-voice clips."""

    IDS = ("L-OPEN-AGENDA", "L-OPEN-AGENDA-PLAIN", "L-OPEN-AGENDA-CONTINUE")
    PICKED = (
        "Let's get started. The whole interview takes about thirty minutes. That's a few minutes "
        "to get to know you, a sales role-play of up to twenty minutes, and then time for your "
        "questions. To start, could you tell me a bit about yourself, and any sales or "
        "customer-facing work you've done?"
    )

    def test_the_plain_agenda_is_the_owners_pick_word_for_word(self) -> None:
        self.assertEqual(r1_script.LINES["L-OPEN-AGENDA-PLAIN-W4"], self.PICKED)
        self.assertEqual(r1_script.line("L-OPEN-AGENDA-PLAIN-W4"), self.PICKED)

    def test_the_other_agendas_share_the_heard_line_and_the_carry_on(self) -> None:
        body = self.PICKED.removeprefix("Let's get started. ")
        self.assertEqual(r1_script.LINES["L-OPEN-AGENDA-W4"], "Lovely, thanks. " + body)
        self.assertEqual(
            r1_script.LINES["L-OPEN-AGENDA-CONTINUE-W4"],
            "Lovely, thanks. " + r1_script.OPEN_AGENDA_4 + r1_script.OPEN_CARRY_ON,
        )

    def test_spoken_shape(self) -> None:
        for line_id in r1_script.AGENDA_W4_LINES.values():
            with self.subTest(line_id=line_id):
                text = r1_script.LINES[line_id]
                self.assertNotIn(":", text)
                self.assertIn("about thirty minutes", text)
                self.assertIn("up to twenty minutes", text)
                self.assertNotIn("I can hear you", text)
                self.assertTrue(r1_script.is_candidate_free(line_id))
                for sentence in re.split(r"(?<=[.?!])\s+", text):
                    self.assertLessEqual(len(sentence), 150, sentence)
        for line_id in ("L-OPEN-AGENDA-W4", "L-OPEN-AGENDA-PLAIN-W4"):
            self.assertTrue(r1_script.LINES[line_id].endswith("?"))

    def test_default_on_and_the_rollbacks(self) -> None:
        for line_id in self.IDS:
            with self.subTest(line_id=line_id):
                with mock.patch.dict(os.environ, {}, clear=True):
                    self.assertTrue(r1_script.agenda_w4_enabled())
                    self.assertEqual(r1_script.active_line_id(line_id), line_id + "-W4")
                for value in ("0", "off", "false", "no"):
                    with mock.patch.dict(os.environ, {"R1_AGENDA_W4": value}):
                        self.assertFalse(r1_script.agenda_w4_enabled())
                        self.assertEqual(r1_script.active_line_id(line_id), line_id + "-W3")
                # W4 rides on W3: the older rollbacks keep their documented texts.
                with mock.patch.dict(os.environ, {"R1_AGENDA_W3": "0", "R1_AGENDA_W4": "1"}):
                    self.assertFalse(r1_script.agenda_w4_enabled())
                    self.assertEqual(r1_script.active_line_id(line_id), line_id + "-W2")
                with mock.patch.dict(os.environ, {"R1_BRIEF_WORDING_V2": "0"}):
                    self.assertEqual(r1_script.active_line_id(line_id), line_id)


class SpokenLinesTests(unittest.TestCase):
    """Owner 2026-11-24 (``R1_SPOKEN_LINES``, content revision 54): every scripted line in the
    spoken style the owner picked by ear for the W4 agenda ("dont make it to open wording only.
    apply this fix for all scripted line as all of the scripted ones are sounding the same way").

    Spoken sentences (never over 25 words), no colon lists, semicolons, dashes or parentheses, and
    a question only as the last thing said.  Every fact, placeholder, cue phrase and consent
    meaning is kept.  The -SP ids are new and chosen after every older routing flag, so no existing
    text changes and ``R1_SPOKEN_LINES=0`` speaks revision 53's texts byte for byte.
    """

    # sha256 of the canonical JSON of {id: line(active_line_id(id), **values)} over the 125 ids on
    # 50b4e882 (content revision 53): default flags (Dex), persona p1_career_switcher v1, first name
    # Asha.  ``R1_SPOKEN_LINES=0`` gives it back exactly.
    ROLLBACK_DIGEST = "3ac26527c6528b9e9231cd4f66a8a210d4dc31553002f4e7191c014265602130"
    PRE_EXISTING = 125
    BODY = (
        "Next, let's do a sales role-play. I'll play {lead_name} from {lead_city}. She filled in a "
        "form on our website about the Data Science course a few days ago. You're the Program "
        "Advisor calling her back. You'll have up to twenty minutes. Treat it like a real call. "
        "Your goal is to understand her needs and help her decide to enrol. Use the course details "
        "from your preparation guide. I'll stay in character until I say, 'Let's pause the "
        "role-play here.' When you want to begin, just say 'ready', and she'll pick up. Any "
        "questions before we start?"
    )
    SCENARIO = BODY.removeprefix("Next, let's do a sales role-play. ")
    # The reviewed wording, word for word, as written in LINES (Christy; DEX_LINES swaps the name).
    SPOKEN = {
        "L-TRANSITION-SP": "Thank you, {first_name}. " + BODY,
        "L-TRANSITION-THANKS-A-SP": "Thanks, {first_name}. " + BODY,
        "L-TRANSITION-THANKS-B-SP": "Thanks for walking me through that, {first_name}. " + BODY,
        "L-TRANSITION-THANKS-C-SP": "Got it, thank you, {first_name}. " + BODY,
        "L-TRANSITION-BRIDGED-SP": BODY,
        "L-TRANSITION-AGAIN-SP": "Of course, here it is again. " + SCENARIO,
        "L-TRANSITION-AGAIN-PLAIN-SP": (
            "Sure. Think of it as a real sales call. I'll play {lead_name} from {lead_city}. She "
            "filled in a form about our Data Science course, and you're the Program Advisor "
            "calling her back. Find out what she needs, and help her decide to enrol. Use your "
            "preparation guide. You'll have up to twenty minutes. I'll stay in character until I "
            "say, 'Let's pause the role-play here.' Whenever you're ready, just say 'ready'."
        ),
        "L-TRANSITION-RECAP-SP": (
            "Of course. In short, I'll play {lead_name}. You're the Program Advisor, calling her "
            "back about the Data Science course. Understand her needs and help her decide to "
            "enrol, using your preparation guide. Would you like to begin now, or ask me something "
            "first?"
        ),
        "L-TRANSITION-RECAP-2-SP": (
            "No problem, here's the short version. You're calling {lead_first_name} back about the "
            "Data Science course she asked about. Understand what she needs and help her decide. "
            "Say 'ready' when you'd like to start."
        ),
        "L-RP-GOAL-SP": (
            "Treat it like a real call. Understand what she needs, and help her decide to enrol."
        ),
        "L-RP-STUCK-SP": (
            "Just carry on the way you would on a real call. I'll stay in character."
        ),
        "L-TRANSITION-ASK-PAUSE-SP": (
            "If that covers everything, just say 'ready' whenever you like. Shall we begin the "
            "role-play?"
        ),
        "L-TRANSITION-REASK-SP": (
            "Just say 'ready' when you are, or ask me a question first. Shall we start the "
            "role-play now?"
        ),
        "L-TRANSITION-STEER-SP": (
            "Let's keep any other questions for the end of the interview. There'll be time for "
            "them then. Shall we start the role-play now?"
        ),
        "L-EXIT-SP": (
            "Let's pause the role-play here. I'm stepping out of the learner's role now. This is "
            "Christy, your interviewer, again. Thank you, that's the end of the role-play."
        ),
        "L-ASIDE-COACH-SP": (
            "Quick note from Christy, your interviewer. In this role-play, you're the Program "
            "Advisor. I'm playing the learner, {lead_name}, who enquired about the Data Science "
            "course. You're calling her back. Please carry on as you would on a real call."
        ),
        "L-ASIDE-END-2-SP": (
            "This is Christy, your interviewer. If you want to keep going, just carry on with "
            "{lead_first_name}. Would you like to stop the role-play here and finish the interview?"
        ),
        "L-ASIDE-WRAP-SP": (
            "This is Christy, your interviewer, stepping in for a moment. We're well into the "
            "role-play now. If you'd rather keep going, just carry on with {lead_first_name}. "
            "Would you like to wrap it up here?"
        ),
        "L-ASIDE-WRAP-AGAIN-SP": (
            "Christy again, just checking in. If you'd like to keep going, just carry on with "
            "{lead_first_name}. Would you like to wrap up the role-play here?"
        ),
        # Either/or on purpose: the engine reads a bare "yes" to the early-close question as unclear
        # (review S3R-2) and asks once more, so a yes/no question here would ask "Would you like to
        # stop?" again after a "Yes."; L-ASIDE-EARLY-CLOSE-2 is either/or for the same reason.
        "L-ASIDE-EARLY-CLOSE-SP": (
            "This is Christy, stepping in for a moment. It sounds like you're wrapping up the call "
            "with {lead_first_name}. Would you like to keep going with her, or stop the role-play "
            "here?"
        ),
        "L-ASIDE-EARLY-CLOSE-TIME-SP": (
            "This is Christy, stepping in for a moment. It sounds like you're wrapping up the call "
            "with {lead_first_name}. We still have some time for the role-play. Would you like to "
            "keep going with her, or stop the role-play here?"
        ),
    }
    # Keyed by the id ``active_line_id`` selects today (the briefs' W2 ids, L-ASIDE-END-2).
    MAP = {
        "L-TRANSITION-W2": "L-TRANSITION-SP",
        "L-TRANSITION-THANKS-A-W2": "L-TRANSITION-THANKS-A-SP",
        "L-TRANSITION-THANKS-B-W2": "L-TRANSITION-THANKS-B-SP",
        "L-TRANSITION-THANKS-C-W2": "L-TRANSITION-THANKS-C-SP",
        "L-TRANSITION-BRIDGED-W2": "L-TRANSITION-BRIDGED-SP",
        "L-TRANSITION-AGAIN-W2": "L-TRANSITION-AGAIN-SP",
        "L-TRANSITION-AGAIN-PLAIN": "L-TRANSITION-AGAIN-PLAIN-SP",
        "L-TRANSITION-RECAP": "L-TRANSITION-RECAP-SP",
        "L-TRANSITION-RECAP-2": "L-TRANSITION-RECAP-2-SP",
        "L-RP-GOAL": "L-RP-GOAL-SP",
        "L-RP-STUCK": "L-RP-STUCK-SP",
        "L-TRANSITION-ASK-PAUSE": "L-TRANSITION-ASK-PAUSE-SP",
        "L-TRANSITION-REASK": "L-TRANSITION-REASK-SP",
        "L-TRANSITION-STEER": "L-TRANSITION-STEER-SP",
        "L-EXIT": "L-EXIT-SP",
        "L-ASIDE-COACH": "L-ASIDE-COACH-SP",
        "L-ASIDE-END-2": "L-ASIDE-END-2-SP",
        "L-ASIDE-WRAP": "L-ASIDE-WRAP-SP",
        "L-ASIDE-WRAP-AGAIN": "L-ASIDE-WRAP-AGAIN-SP",
        "L-ASIDE-EARLY-CLOSE": "L-ASIDE-EARLY-CLOSE-SP",
        "L-ASIDE-EARLY-CLOSE-TIME": "L-ASIDE-EARLY-CLOSE-TIME-SP",
    }
    BRIEFS = (
        "L-TRANSITION-W2", "L-TRANSITION-THANKS-A-W2", "L-TRANSITION-THANKS-B-W2",
        "L-TRANSITION-THANKS-C-W2", "L-TRANSITION-BRIDGED-W2", "L-TRANSITION-AGAIN-W2",
    )
    NAMED = (
        "L-EXIT-SP", "L-ASIDE-COACH-SP", "L-ASIDE-END-2-SP", "L-ASIDE-WRAP-SP",
        "L-ASIDE-WRAP-AGAIN-SP", "L-ASIDE-EARLY-CLOSE-SP", "L-ASIDE-EARLY-CLOSE-TIME-SP",
    )
    # Callers that are spoken only behind a non-default flag (their texts are left as they are).
    FLAG_OFF_ONLY = {
        "L-OPEN": "R1_OPENING_SOUND_CHECK=0",
        "L-ASIDE-END": "R1_END_ASIDE_V2=0",
        "L-ASIDE-LAST-POINT": "R1_LAST_POINT_V2=0",
    }
    # Spoken by default, outside this change: the role-play's "Hello? Are you still there?" call,
    # and L-FAQ-DEFER (r1_world.INTERVIEWER_DEFLECTION, in the world canonical; deferred).
    EXEMPT = ("L-SIL-RP1", "L-FAQ-DEFER")
    # Facts and cue phrases a pair must say exactly as often.
    KEPT = (
        "'ready'", EXIT_CUE, "Program Advisor", "up to twenty minutes", "preparation guide",
        "Data Science course", "hiring team", "AI interviewer", "Interview Kickstart", "recorded",
        "Christy",
    )
    OFF = ("0", "off", "false", "no", " OFF ")

    @staticmethod
    def values(persona_id: str = "p1_career_switcher", variant: str = "v1") -> dict[str, str]:
        return {**resolve_persona(persona_id, variant=variant).line_values, "first_name": "Asha"}

    @staticmethod
    def words(text: str) -> int:
        """Words, with each placeholder counted as one."""
        return len(re.sub(r"\{[a-z_]+\}", "X", text).split())

    @staticmethod
    def sentences(text: str) -> list[str]:
        """Sentences, a quoted cue's closing quote kept with its sentence."""
        return [part for part in re.split(r"(?<=[.?!])\s+|(?<=[.?!]')\s+", text) if part]

    def style_problems(self, text: str) -> list[str]:
        problems = [mark for mark in (":", ";", " - ", "–", "—", "(") if mark in text]
        problems += [
            f"{len(part.split())} words: {part}"
            for part in self.sentences(text)
            if len(part.split()) > 25
        ]
        if "?" in text and not text.endswith("?"):
            problems.append("a question that is not the last thing said")
        if text.count("?") > 1:
            problems.append("two questions")
        return problems

    @staticmethod
    def targets() -> set[str]:
        maps = (
            r1_script.ROLLBACK_LINES, r1_script.WORDING_LINES, r1_script.AGENDA_W3_LINES,
            r1_script.AGENDA_W4_LINES, r1_script.VARIETY_LINES, r1_script.MEET_LINES,
            r1_script.SPOKEN_LINES,
        )
        return set().union(*(set(item.values()) for item in maps))

    def callers(self) -> list[str]:
        """The ids a default session names (each routed target is reached through its caller)."""
        targets = self.targets()
        return [i for i in LINES if i not in targets and i not in self.FLAG_OFF_ONLY]

    @staticmethod
    def selected(line_id: str) -> str:
        """What ``active_line_id`` picks with the spoken lines off (the other flags as they are)."""
        with mock.patch.dict(os.environ, {"R1_SPOKEN_LINES": "0"}):
            return r1_script.active_line_id(line_id)

    def test_the_texts_word_for_word(self) -> None:
        self.assertEqual(r1_script.SPOKEN_LINES, self.MAP)
        self.assertEqual(set(self.SPOKEN), set(r1_script.SPOKEN_LINES.values()))
        for line_id, text in self.SPOKEN.items():
            with self.subTest(line=line_id):
                self.assertEqual(LINES[line_id], text)
        self.assertEqual(r1_script.BRIEF_BODY_SP, self.BODY)
        self.assertEqual(r1_script.BRIEF_SCENARIO_SP, self.SCENARIO)
        self.assertEqual(
            r1_script.BRIEF_START_PROMPT_SP,
            "When you want to begin, just say 'ready', and she'll pick up. Any questions before we "
            "start?",
        )

    def test_default_on_and_the_rollback(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertTrue(r1_script.spoken_lines_enabled())
            for line_id in LINES:
                with self.subTest(line=line_id):
                    chosen = self.selected(line_id)
                    self.assertEqual(
                        r1_script.active_line_id(line_id),
                        r1_script.SPOKEN_LINES.get(chosen, chosen),
                    )
            self.assertEqual(r1_script.active_line_id("L-TRANSITION"), "L-TRANSITION-SP")
            self.assertEqual(r1_script.active_line_id("L-ASIDE-COACH"), "L-ASIDE-COACH-SP")
        for value in self.OFF:
            with self.subTest(value=value), mock.patch.dict(
                os.environ, {"R1_SPOKEN_LINES": value}, clear=True
            ):
                self.assertFalse(r1_script.spoken_lines_enabled())
                self.assertEqual(r1_script.active_line_id("L-TRANSITION"), "L-TRANSITION-W2")
                for key in r1_script.SPOKEN_LINES:
                    self.assertEqual(r1_script.active_line_id(key), key)
        # Applied after the older routing: each older rollback still speaks its own text.
        with mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": "0"}, clear=True):
            self.assertEqual(r1_script.active_line_id("L-TRANSITION"), "L-TRANSITION-V20")
            self.assertEqual(r1_script.active_line_id("L-ASIDE-COACH"), "L-ASIDE-COACH-V20")
        with mock.patch.dict(os.environ, {"R1_BRIEF_WORDING_V2": "0"}, clear=True):
            self.assertEqual(r1_script.active_line_id("L-TRANSITION"), "L-TRANSITION")
            self.assertEqual(r1_script.active_line_id("L-TRANSITION-AGAIN"), "L-TRANSITION-AGAIN")
        # A raw id still renders its own text: only the choice of id changes.
        values = self.values()
        with mock.patch.dict(os.environ, {}, clear=True):
            for key, spoken in r1_script.SPOKEN_LINES.items():
                with self.subTest(key=key):
                    self.assertEqual(
                        line(key, **values), LINES[key].replace("Christy", "Dex").format(**values)
                    )
                    self.assertNotEqual(line(key, **values), line(spoken, **values))

    def test_the_rollback_is_byte_for_byte(self) -> None:
        values = self.values()
        old_ids = [i for i in LINES if i not in r1_script.SPOKEN_LINES.values()]
        self.assertEqual(len(old_ids), self.PRE_EXISTING)

        def rendered(env: dict[str, str]) -> dict[str, str]:
            with mock.patch.dict(os.environ, env, clear=True):
                return {i: line(r1_script.active_line_id(i), **values) for i in old_ids}

        def digest(table: dict[str, str]) -> str:
            canonical = json.dumps(table, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
            return hashlib.sha256(canonical.encode()).hexdigest()

        off, on = rendered({"R1_SPOKEN_LINES": "0"}), rendered({})
        self.assertEqual(digest(off), self.ROLLBACK_DIGEST)
        self.assertNotEqual(digest(on), self.ROLLBACK_DIGEST)
        changed = {i for i in old_ids if on[i] != off[i]}
        with mock.patch.dict(os.environ, {}, clear=True):
            expected = {i for i in old_ids if self.selected(i) in r1_script.SPOKEN_LINES}
        self.assertEqual(changed, expected)
        self.assertIn("L-TRANSITION-THANKS-A", changed)
        self.assertNotIn("L-FAQ-DEFER", changed)

    def test_every_default_line_is_spoken_style(self) -> None:
        for dex in (None, "0"):
            env = {} if dex is None else {"R1_INTERVIEWER_DEX": dex}
            with mock.patch.dict(os.environ, env, clear=True):
                for persona in PERSONAS:
                    for variant in persona.variants:
                        values = self.values(persona.id, variant.id)
                        for line_id in self.callers():
                            if line_id in self.EXEMPT:
                                continue
                            text = line(r1_script.active_line_id(line_id), **values)
                            with self.subTest(dex=dex, persona=persona.id, line=line_id):
                                self.assertEqual(self.style_problems(text), [], text)
        # Not vacuous: with the flag off, the lines that break the style are this change's own.
        values = self.values()
        with mock.patch.dict(os.environ, {"R1_SPOKEN_LINES": "0"}, clear=True):
            failing = {
                i for i in self.callers()
                if self.style_problems(line(r1_script.active_line_id(i), **values))
            }
            routed = {i for i in self.callers() if self.selected(i) in r1_script.SPOKEN_LINES}
        self.assertEqual(failing - routed, set(self.EXEMPT))
        # L-ASIDE-EARLY-CLOSE passed already; it is reworded with its -TIME twin.
        self.assertEqual(routed - failing, {"L-ASIDE-EARLY-CLOSE"})

    def test_each_pair_keeps_its_facts_placeholders_and_cacheability(self) -> None:
        for dex in (None, "1", "0"):
            env = {} if dex is None else {"R1_INTERVIEWER_DEX": dex}
            with mock.patch.dict(os.environ, env, clear=True):
                for base, spoken in r1_script.SPOKEN_LINES.items():
                    with self.subTest(dex=dex, line=base):
                        self.assertEqual(placeholders(spoken), placeholders(base))
                        self.assertEqual(is_candidate_free(spoken), is_candidate_free(base))
                        self.assertEqual(spoken in NAME_FREE_LINES, base in NAME_FREE_LINES)
                        self.assertEqual(
                            spoken in CANDIDATE_FREE_LINES, base in CANDIDATE_FREE_LINES
                        )
                        self.assertEqual(
                            spoken in r1_script.DEX_LINES, base in r1_script.DEX_LINES
                        )
                        for kept in self.KEPT:
                            self.assertEqual(
                                LINES[spoken].count(kept), LINES[base].count(kept), kept
                            )

    def test_the_briefs_keep_every_fact_and_end_on_the_any_questions_prompt(self) -> None:
        lead_in = "Next, let's do a sales role-play. "
        for base in self.BRIEFS:
            spoken = r1_script.SPOKEN_LINES[base]
            text = LINES[spoken]
            with self.subTest(line=spoken):
                # ``r1_session._ANY_QUESTIONS_BRIEFS``: a bare "yes" is invited, a "no" nudged.
                self.assertTrue(text.endswith("Any questions before we start?"))
                self.assertIn(r1_script.BRIEF_GOAL, text)
                self.assertEqual(text.count("just say 'ready'"), 1)
                self.assertNotIn("If not", text)
                for kept in (
                    "{lead_name}", "{lead_city}", "Data Science course", "calling her back",
                    "help her decide to enrol", "course details from your preparation guide",
                    f"'{EXIT_CUE}'", "she'll pick up", "You'll have up to twenty minutes",
                ):
                    self.assertIn(kept, text)
                # The thanks (or the replay's lead-in) is the base's, word for word.
                self.assertEqual(
                    text.split("I'll play")[0].replace(lead_in, ""),
                    LINES[base].split("I'll play")[0].replace(lead_in, ""),
                )
                self.assertLessEqual(self.words(text), 105)
        self.assertNotIn("thank", LINES["L-TRANSITION-BRIDGED-SP"].lower())
        longest = 0
        for persona in PERSONAS:
            for variant in persona.variants:
                values = resolve_persona(persona.id, variant=variant.id).line_values
                for base in self.BRIEFS:
                    text = line(r1_script.SPOKEN_LINES[base], first_name="Mary-Ann", **values)
                    longest = max(longest, len(text.split()))
        self.assertLessEqual(longest, 112)

    def test_the_replay_and_the_recaps(self) -> None:
        recap = LINES["L-TRANSITION-RECAP-SP"]
        goal = r1_script.BRIEF_GOAL
        self.assertTrue(recap.endswith(r1_script.RECAP_START_PROMPT))  # its own either/or
        self.assertIn(goal[:1].upper() + goal[1:], recap)
        self.assertLessEqual(self.words(recap), 46)
        for private in ("$", "7,000", "budget", "husband", "worried", "price"):
            self.assertNotIn(private, recap)
        again = LINES["L-TRANSITION-AGAIN-PLAIN-SP"]
        self.assertTrue(again.startswith("Sure. Think of it as a real sales call. I'll play "))
        self.assertTrue(again.endswith("just say 'ready'."))
        self.assertNotIn("?", again)
        recap_2 = LINES["L-TRANSITION-RECAP-2-SP"]
        self.assertIn("{lead_first_name}", recap_2)
        self.assertTrue(recap_2.endswith("Say 'ready' when you'd like to start."))
        self.assertNotIn("?", recap_2)
        for persona in PERSONAS:
            for variant in persona.variants:
                values = self.values(persona.id, variant.id)
                brief = line("L-TRANSITION-BRIDGED-SP", **values)
                with self.subTest(persona=persona.id, variant=variant.id):
                    # ``full_metrics``: a short brief is under 0.6 of the brief's words.
                    self.assertLess(
                        len(line("L-TRANSITION-RECAP-SP", **values).split()),
                        0.6 * len(brief.split()),
                    )
                    # D3-BRIEF1: the replay is re-explained, never a brief word for word.
                    replay = line("L-TRANSITION-AGAIN-PLAIN-SP", **values)
                    for base in self.BRIEFS:
                        self.assertNotIn(replay, line(r1_script.SPOKEN_LINES[base], **values))

    def test_the_start_prompts_end_on_their_question(self) -> None:
        for line_id in (
            "L-TRANSITION-ASK-PAUSE-SP", "L-TRANSITION-REASK-SP", "L-TRANSITION-STEER-SP",
        ):
            text = LINES[line_id]
            with self.subTest(line=line_id):
                # A bare "yes" starts (``_YES_NO``), so the yes/no question is said last.
                self.assertTrue(text.endswith("?"))
                self.assertEqual(text.count("?"), 1)
                self.assertNotIn("let's begin", text.lower())
                self.assertIn(line_id, NAME_FREE_LINES)
        self.assertIn("'ready'", LINES["L-TRANSITION-ASK-PAUSE-SP"])
        self.assertIn("'ready'", LINES["L-TRANSITION-REASK-SP"])
        self.assertNotIn(", or ", LINES["L-TRANSITION-ASK-PAUSE-SP"])
        self.assertNotIn("hiring team", LINES["L-TRANSITION-STEER-SP"])
        goal = LINES["L-RP-GOAL-SP"]
        self.assertLessEqual(len(goal.split()), 20)
        self.assertNotIn("?", goal)

    def test_the_asides_and_the_exit(self) -> None:
        exit_line = LINES["L-EXIT-SP"]
        self.assertTrue(exit_line.startswith(EXIT_CUE + " "))
        self.assertIn("Christy, your interviewer", exit_line)
        coach = LINES["L-ASIDE-COACH-SP"]
        self.assertIn("I'm playing the learner, {lead_name}, who enquired", coach)  # SWEEP-30
        self.assertNotIn("I'm the learner", coach)
        # A bare "yes" to these means stop or wrap up, so each ends on that one question.
        for line_id, question in (
            ("L-ASIDE-END-2-SP",
             "Would you like to stop the role-play here and finish the interview?"),
            ("L-ASIDE-WRAP-SP", "Would you like to wrap it up here?"),
            ("L-ASIDE-WRAP-AGAIN-SP", "Would you like to wrap up the role-play here?"),
        ):
            text = LINES[line_id]
            with self.subTest(line=line_id):
                self.assertTrue(text.endswith(question))
                self.assertNotIn(", or ", text)
                self.assertIn("carry on with {lead_first_name}", text)
        self.assertNotEqual(LINES["L-ASIDE-WRAP-SP"], LINES["L-ASIDE-WRAP-AGAIN-SP"])
        # The early-close question stays either/or (a bare yes is unclear there).
        for line_id in ("L-ASIDE-EARLY-CLOSE-SP", "L-ASIDE-EARLY-CLOSE-TIME-SP"):
            self.assertTrue(LINES[line_id].endswith(
                "Would you like to keep going with her, or stop the role-play here?"
            ))
        self.assertIn(
            "We still have some time for the role-play", LINES["L-ASIDE-EARLY-CLOSE-TIME-SP"]
        )

    def test_the_map_shape(self) -> None:
        spoken = r1_script.SPOKEN_LINES
        self.assertEqual(len(spoken), 21)
        self.assertEqual(len(set(spoken.values())), len(spoken))
        others = {
            name: getattr(r1_script, name)
            for name in (
                "ROLLBACK_LINES", "WORDING_LINES", "AGENDA_W3_LINES", "AGENDA_W4_LINES",
                "VARIETY_LINES", "MEET_LINES",
            )
        }
        with mock.patch.dict(os.environ, {"R1_SPOKEN_LINES": "0"}, clear=True):
            chosen = {r1_script.active_line_id(i) for i in LINES}
        for key, value in spoken.items():
            with self.subTest(line=key):
                self.assertIn(key, LINES)
                self.assertIn(value, LINES)
                self.assertEqual(value, re.sub(r"-W2$", "", key) + "-SP")
                self.assertNotIn(value, spoken)  # nothing chains
                self.assertIn(key, chosen)  # a key is what some caller speaks today
                for name, other in others.items():
                    # Only reached through this map, after every older one.
                    self.assertNotIn(value, set(other) | set(other.values()), name)
        meet = set(r1_script.MEET_LINES) | set(r1_script.MEET_LINES.values())
        self.assertEqual((set(spoken) | set(spoken.values())) & meet, set())
        self.assertEqual({i for i in spoken.values() if i in r1_script.DEX_LINES}, set(self.NAMED))
        with mock.patch.dict(os.environ, {}, clear=True):
            for line_id in self.NAMED:
                self.assertIn("Dex", line(line_id, **self.values()))
                self.assertNotIn("Christy", line(line_id, **self.values()))

    def test_no_spoken_line_names_a_page_a_price_or_a_number(self) -> None:
        values = self.values()
        for line_id in r1_script.SPOKEN_LINES.values():
            text = line(line_id, **values)
            with self.subTest(line=line_id):
                self.assertIsNone(TestMeetLines.BANNED.search(text), text)
                self.assertNotIn("$", text)
                self.assertNotRegex(text, r"\b\d{2,}\b")
                self.assertNotIn("{", text)
