"""Focused tests for Christy's introduction, identity, and production voice."""

from __future__ import annotations

import hashlib
from pathlib import Path
import re
import tomllib
import unittest

from prompting import format_questions, format_resume_facts, opening_line, system_prompt


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
        # PHONE lane (name_unverified=True): confirm-don't-assert.
        prompt = system_prompt(candidate_name="Rijo", name_unverified=True)

        # The record name is no longer asserted as established fact.
        self.assertNotIn("The candidate is Rijo", prompt)
        # It is framed as an unverified record and confirmed in-call.
        self.assertIn("UNVERIFIED record name", prompt)
        self.assertIn("just to confirm, am I speaking with Rijo?", prompt)
        # If a different name is given, do not argue; use theirs.
        self.assertIn("do NOT argue", prompt)
        self.assertIn("use the name THEY give", prompt)

    def test_browser_lane_keeps_original_name_assertion_byte_identical(self):
        # BROWSER lane (default flag): the frozen surface must keep the ORIGINAL
        # assertion — the phone-only confirm text must NOT leak here (guards the
        # sha-pinned browser prompt surface).
        prompt = system_prompt(candidate_name="Rijo")
        self.assertIn("The candidate is Rijo, applying for", prompt)
        self.assertNotIn("UNVERIFIED record name", prompt)
        self.assertIn("thank Rijo by name", prompt)

    def test_closing_does_not_unconditionally_assert_record_name(self):
        # PHONE lane: closing gated on a CONFIRMED name.
        prompt = system_prompt(candidate_name="Rijo", name_unverified=True)

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


class TestPhoneNoNameBranch(unittest.TestCase):
    """M017 (ADR-0018): a phone call whose record carries no usable name.

    The phone branch must never speak the "there" fallback as if it were a
    name; the phone branch WITH a name and the browser branch render the same
    bytes as before (sha256 of the origin/main renders, same inputs).
    """

    _INPUTS = {
        "role_title": "Pin Role",
        "role_focus": "pin focus",
        "resume_facts": "pin facts",
        "questions": format_questions(None),
        "interviewer_instructions": "pin guidance",
    }
    _PHONE_NAMED_SHA256 = "e76075c150192e11c6304f6145e67f2b76717ba8cf63fbdd54a509c2fe1f07d5"
    _BROWSER_NAMELESS_SHA256 = "cc5fcaf7ac34632e1ca1196944faaa1dc6982bd05cfef1a2a3dff3cdf81c8c4c"

    @staticmethod
    def _sha256(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def test_phone_branch_without_a_name_never_says_there(self):
        for name in (None, "", "   "):
            with self.subTest(name=name):
                prompt = system_prompt(
                    candidate_name=name, name_unverified=True, **self._INPUTS,
                )
                self.assertIsNone(re.search(r"\bthere\b", prompt))
                self.assertIn("who is applying for the Pin Role.", prompt)
                self.assertIn("Never guess or invent a name", prompt)
                self.assertNotIn("UNVERIFIED record name", prompt)
                # The wind-down asks "the candidate", and the closing uses no
                # name unless they gave one.
                self.assertIn(
                    "ALWAYS ask the candidate if they have any questions", prompt,
                )
                self.assertIn("thank them warmly WITHOUT using any name", prompt)

    def test_phone_branch_with_a_name_is_unchanged(self):
        prompt = system_prompt(
            candidate_name="Rijo", name_unverified=True, **self._INPUTS,
        )
        self.assertEqual(self._sha256(prompt), self._PHONE_NAMED_SHA256)
        self.assertIn("ALWAYS ask Rijo if they have any questions", prompt)
        self.assertNotIn("Never guess or invent a name", prompt)

    def test_browser_branch_without_a_name_is_unchanged(self):
        prompt = system_prompt(candidate_name=None, **self._INPUTS)
        self.assertEqual(self._sha256(prompt), self._BROWSER_NAMELESS_SHA256)
        self.assertIn("The candidate is there, applying for", prompt)
        self.assertNotIn("Never guess or invent a name", prompt)


if __name__ == "__main__":
    unittest.main()
