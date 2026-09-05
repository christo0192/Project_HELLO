"""Focused tests for Christy's introduction, identity, and production voice."""

from __future__ import annotations

from pathlib import Path
import tomllib
import unittest

from prompting import format_resume_facts, opening_line, system_prompt


class TestOpeningAndIdentityDisclosure(unittest.TestCase):
    def test_opening_is_natural_and_does_not_proactively_disclose_ai(self):
        opener = opening_line("Asha", "Software Engineer")

        self.assertEqual(
            opener,
            "Hi, I'm Christy from Interview Kickstart. Thanks for joining today. How are you doing?",
        )
        self.assertNotIn("AI", opener)
        self.assertNotIn("automated", opener.lower())
        self.assertNotIn("bot", opener.lower())

    def test_system_prompt_discloses_ai_only_after_explicit_question(self):
        prompt = system_prompt(candidate_name="Asha")

        self.assertIn('You are "Christy"', prompt)
        self.assertIn("introduced yourself as Christy", prompt)
        self.assertNotIn("Diana", prompt)
        self.assertNotIn("Gopu", prompt)
        self.assertIn("Do not proactively mention being an AI", prompt)
        self.assertIn("Only if the candidate explicitly asks", prompt)
        self.assertIn("answer truthfully", prompt)
        self.assertIn("Never claim to be human", prompt)

    def test_system_prompt_confirms_name_instead_of_asserting_record_name(self):
        prompt = system_prompt(candidate_name="Rijo")

        # The record name is no longer asserted as established fact.
        self.assertNotIn("The candidate is Rijo", prompt)
        # It is framed as an unverified record and confirmed in-call.
        self.assertIn("UNVERIFIED record name", prompt)
        self.assertIn("just to confirm, am I speaking with Rijo?", prompt)
        # If a different name is given, do not argue; use theirs.
        self.assertIn("do NOT argue", prompt)
        self.assertIn("use the name THEY give", prompt)

    def test_closing_does_not_unconditionally_assert_record_name(self):
        prompt = system_prompt(candidate_name="Rijo")

        # The closing no longer hard-asserts "thank Rijo by name".
        self.assertNotIn("thank Rijo by name", prompt)
        # Closing is gated on a CONFIRMED name and drops the name otherwise.
        self.assertIn("If you have CONFIRMED their name", prompt)
        self.assertIn('WITHOUT asserting the record name "Rijo"', prompt)

    def test_resume_facts_include_bounded_recent_role_evidence(self):
        facts = format_resume_facts({
            "name": "Asha",
            "current_role": "Advisor",
            "recent_role": {
                "title": "Program Advisor",
                "employer": "Example Co",
                "period": "2024-present",
                "highlights": ["Exceeded target", "x" * 400],
            },
            "prior_roles": [{"title": "Sales Associate", "employer": "Prior Co"}],
            "career_highlights": ["Top performer"],
            "education": ["MBA"],
            "certifications": ["Salesforce Administrator"],
        })

        self.assertIn("untrusted resume claims", facts)
        self.assertIn("Program Advisor | Example Co | 2024-present", facts)
        self.assertIn("Sales Associate | Prior Co", facts)
        self.assertIn("Top performer", facts)
        self.assertNotIn("x" * 241, facts)

    def test_production_uses_bulbul_v3_simran(self):
        fly_config = tomllib.loads(
            (Path(__file__).parents[1] / "fly.toml").read_text(encoding="utf-8")
        )

        self.assertEqual(fly_config["env"]["SARVAM_TTS_MODEL"], "bulbul:v3")
        self.assertEqual(fly_config["env"]["SARVAM_TTS_VOICE"], "simran")


if __name__ == "__main__":
    unittest.main()
