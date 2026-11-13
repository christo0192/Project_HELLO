"""Unit tests for ``r1_script``: the plan 5.2 scripted lines and their rendering."""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

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
        self.assertTrue(line("L-OPEN", first_name="Arjun").startswith("Hi Arjun, I'm Christy"))
        # A name the sanitiser rejects is unknown, not "there": the slot is dropped.
        self.assertTrue(line("L-OPEN", first_name="Arjun<b>").startswith("Hi, I'm Christy"))
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
            "L-OPEN": "Hi, I'm Christy, an AI interviewer from Interview Kickstart, and I'll",
            "L-OPEN-HELLO": "Hi, I'm Christy, an AI interviewer from Interview Kickstart. Can you",
            "L-TRANSITION": "Thank you. Next, let's do a sales role-play. I'll play",
            "L-TRANSITION-V20": (
                "Thank you. We'll now move to the role-play. I'll play a prospective"
            ),
            # M032 diagnosis 3 (D3-ICE1): the thanked briefs.
            "L-TRANSITION-THANKS-A": "Thanks. Next, let's do a sales role-play.",
            "L-TRANSITION-THANKS-B": "Thanks for walking me through that. Next, let's do a sales",
            "L-TRANSITION-THANKS-C": "Got it, thank you. Next, let's do a sales role-play.",
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
            self.assertEqual(line(line_id, first_name=""), LINES[line_id])

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
            with mock.patch.dict(os.environ, {"R1_TRANSITION_REPAIR": value}):
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
            line("L-OPEN-HELLO", first_name="Arjun").startswith("Hi Arjun, I'm Christy, an AI")
        )
        self.assertEqual(
            line("L-OPEN-HELLO", first_name=""),
            "Hi, I'm Christy, an AI interviewer from Interview Kickstart. Can you hear me okay?",
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
