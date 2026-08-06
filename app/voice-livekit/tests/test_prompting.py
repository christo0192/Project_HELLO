"""Focused tests for Gopu's deterministic introduction and identity disclosure."""

from __future__ import annotations

import unittest

from prompting import opening_line, system_prompt


class TestOpeningAndIdentityDisclosure(unittest.TestCase):
    def test_opening_is_natural_and_does_not_proactively_disclose_ai(self):
        opener = opening_line("Asha", "Software Engineer")

        self.assertEqual(
            opener,
            "Hi, I'm Gopu from Interview Kickstart. Thanks for joining today. How are you doing?",
        )
        self.assertNotIn("AI", opener)
        self.assertNotIn("automated", opener.lower())
        self.assertNotIn("bot", opener.lower())

    def test_system_prompt_discloses_ai_only_after_explicit_question(self):
        prompt = system_prompt(candidate_name="Asha")

        self.assertIn("Do not proactively mention being an AI", prompt)
        self.assertIn("Only if the candidate explicitly asks", prompt)
        self.assertIn("answer truthfully", prompt)
        self.assertIn("Never claim to be human", prompt)


if __name__ == "__main__":
    unittest.main()
