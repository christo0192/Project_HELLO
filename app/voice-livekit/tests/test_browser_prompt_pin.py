"""The browser (WebRTC) prompt surface, pinned byte-for-byte.

The phone/WebRTC parity work (2026-08-28 RCA) carries one hard constraint:
the browser lane — the golden path — must not change AT ALL. `prompting.py`
and `agent.py` host both lanes, so a phone-side edit can silently shift the
browser surface through a shared helper. This pin turns that shift into a red
test instead of a changed production prompt.

If this test fails, one of two things is true:

1. You touched the shared browser surface by accident — revert.
2. You changed the browser lane ON PURPOSE — then updating the hash below is
   the explicit, reviewable act of doing so. Recompute it with the block in
   this file's docstring history (same inputs, sha256 over the RS-joined
   parts) and say so in the PR.

The pinned parts are the ones the browser lane actually renders: the full
`system_prompt` with the default question bank exactly as `format_questions`
supplies it, the raw `DEFAULT_QUESTIONS` topic prose, and the opening line.
"""

from __future__ import annotations

import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import prompting  # noqa: E402


_PINNED_SHA256 = "164e954cf4a9a41a3676c403bc5507f3ca0f609e842ef8de73647d039312bf80"


def _surface() -> str:
    text = prompting.system_prompt(
        candidate_name="Pin Candidate",
        role_title="Pin Role",
        role_focus="pin focus",
        resume_facts="pin facts",
        questions=prompting.format_questions(None),
        interviewer_instructions="pin guidance",
    )
    parts = [
        text,
        "\n".join(prompting.DEFAULT_QUESTIONS),
        prompting.opening_line("Pin Candidate", "Pin Role"),
    ]
    return "\x1e".join(parts)


class TestBrowserPromptPin(unittest.TestCase):
    def test_browser_prompt_surface_is_byte_identical(self):
        digest = hashlib.sha256(_surface().encode("utf-8")).hexdigest()
        self.assertEqual(
            digest, _PINNED_SHA256,
            "The browser-visible prompt surface changed. If this was not "
            "deliberate, revert; if it was, update the pin explicitly and "
            "call it out in the PR.",
        )

    def test_the_pin_is_not_vacuous(self):
        # A pin that ignores its inputs would stay green through any change.
        # The prompt renders FIRST names, so the candidate appears as "Pin".
        self.assertIn("The candidate is Pin,", _surface())
        self.assertIn(prompting.DEFAULT_QUESTIONS[0], _surface())


if __name__ == "__main__":
    unittest.main()
