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
    line,
    line_sha256,
    placeholders,
    safe_first_name,
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

    def test_the_opening_and_transition_say_what_the_plan_says(self):
        self.assertIn("an AI interviewer from Interview Kickstart", LINES["L-OPEN"])
        self.assertIn("about twenty minutes", LINES["L-OPEN"])
        self.assertIn("twelve to fourteen minutes", LINES["L-TRANSITION"])
        self.assertIn("'Let's pause the role-play here.'", LINES["L-TRANSITION"])
        self.assertIn("just say 'ready'", LINES["L-TRANSITION"])

    def test_the_exit_cue_is_the_exit_lines_first_sentence(self):
        self.assertTrue(LINES["L-EXIT"].startswith(EXIT_CUE))
        self.assertEqual(EXIT_CUE, "Let's pause the role-play here.")

    def test_no_line_makes_a_commitment_or_states_a_fact_beyond_the_plan(self):
        for text in LINES.values():
            self.assertNotIn("$", text)
            self.assertNotRegex(text, r"\b\d{2,}\b")

    def test_the_interviewer_is_christy(self):
        self.assertEqual(r1_script.INTERVIEWER_NAME, "Christy")
        for line_id in ("L-OPEN", "L-MUTE", "L-SIL-RP2", "L-ASIDE-COACH", "L-EXIT"):
            self.assertIn("Christy", LINES[line_id])


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
        self.assertTrue(line("L-OPEN", first_name="Arjun<b>").startswith("Hi there, I'm Christy"))
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
        self.assertIn("The learner is Meera Iyer from Edison, New Jersey, who filled in", text)
        self.assertNotIn("{", text)

    def test_every_persona_variant_renders_every_persona_line(self):
        for persona in PERSONAS:
            for variant in persona.variants:
                rendered = resolve_persona(persona.id, variant=variant.id)
                values = rendered.line_values
                self.assertEqual(
                    line("L-PICKUP", **values),
                    f"Hello? Yes, this is {variant.first_name} speaking.",
                )
                self.assertEqual(rendered.pickup_line, line("L-PICKUP", **values))
                aside = line("L-ASIDE-COACH", **values)
                self.assertIn(f"I'm the learner, {variant.full_name}.", aside)
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
        self.assertEqual(filler_line("learner"), "Hmm, one second...")
        self.assertEqual(filler_line("interviewer"), "Let me think about that for a second.")

    def test_line_sha_is_the_digest_of_the_exact_text(self):
        digest = line_sha256(LINES["L-WRAP"])
        self.assertRegex(digest, r"^[a-f0-9]{64}$")
        self.assertEqual(digest, line_sha256(LINES["L-WRAP"]))
        self.assertNotEqual(digest, line_sha256(LINES["L-WRAP"] + " "))


if __name__ == "__main__":
    unittest.main()
