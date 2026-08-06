"""Focused tests for Christy's introduction, identity, and production voice."""

from __future__ import annotations

from pathlib import Path
import tomllib
import unittest

from prompting import opening_line, system_prompt


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

    def test_production_uses_bulbul_v3_simran(self):
        fly_config = tomllib.loads(
            (Path(__file__).parents[1] / "fly.toml").read_text(encoding="utf-8")
        )

        self.assertEqual(fly_config["env"]["SARVAM_TTS_MODEL"], "bulbul:v3")
        self.assertEqual(fly_config["env"]["SARVAM_TTS_VOICE"], "simran")


if __name__ == "__main__":
    unittest.main()
