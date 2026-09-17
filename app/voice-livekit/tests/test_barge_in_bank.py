"""The barge-in word floor: what it refuses, and what it deliberately does not.

`min_interruption_words` does not DISCARD an utterance that is too short to
interrupt the bot. `AudioRecognition._audio_transcript` is cleared on the
COMMITTED branch or by `clear_user_turn()`, and on NEITHER path when the word
gate refuses — so a refused fragment is BANKED and the next fragment is
appended to it. Both interruption paths then read that bank.

At the old floor of two words, that made the guard mean "one word of
backchannel cannot cut the bot off, two can" — and on an Indian phone screen
two words of backchannel is the norm. On 2026-09-17 Deepti backchannelled
"Sure" 965 ms into Q1, one more token arrived, and the committed turn reads
"Sure Ee"; Q1 is recorded `[interrupted question]`, truncated mid-sentence.
Three more truncated bot turns followed and she hung up 54 s in. Neelu's call
shows six truncated bot turns, each after a one- or two-word utterance.

THE FIX IS THE FLOOR, AND ONLY THE FLOOR. Three is enough for every
truncation observed in production, and four is too many (it silences "can you
repeat" and banks a short direct answer instead of delivering it).

The BANK itself is not repaired — see the long comment above
`phone_min_interruption_words` for why three attempts were reverted. The
short version: a false interruption truncates a question and the bot re-asks;
a wrongly dropped bank deletes an ANSWER from the transcript the scorer reads,
silently. These tests pin the floor and the cost on BOTH sides of it.
"""

from __future__ import annotations

import os
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import phone  # noqa: E402





class WordFloorTests(unittest.TestCase):
    """The floor is the first repair: a backchannel must not reach it."""

    def test_default_is_three(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PHONE_MIN_INTERRUPTION_WORDS", None)
            self.assertEqual(phone.phone_min_interruption_words(), 3)

    def test_every_utterance_that_truncated_a_live_bot_turn_is_below_the_floor(self):
        """The four candidate utterances that preceded an `[interrupted question]`.

        Verbatim from `screening_v2.transcript_turns`: Deepti session
        f84e2e51 turn 5, and Neelu session 7562d48f turns 10, 14, 20 and 31,
        all on 2026-09-17. Each is what the bank held when the bot was cut off.

        The bound is the LITERAL 3, not `phone_min_interruption_words()`.
        Deriving the expectation from the reader under test is the vacuous
        pattern this repo has been bitten by before — it would pass for any
        floor, including the floor of 2 that caused these truncations.
        """
        self.assertEqual(
            phone.phone_min_interruption_words(), 3,
            "the evidence below is calibrated against a floor of exactly 3")
        for text in ("Sure Ee", "Yes Okay", "Yeah", "Yeah.", "Got Sure"):
            with self.subTest(text=text):
                self.assertLess(
                    len(text.split()), 3,
                    f"{text!r} still reaches the floor")

    def test_a_genuine_interruption_from_the_same_calls_still_qualifies(self):
        """The counterweight: raising the floor must not deafen the bot.

        Neelu, session 7562d48f turn 25 — a real mid-question interruption,
        and the SHORTEST genuine one in either transcript. It must stay above
        the floor, or the fix has traded one failure for its opposite.

        Literal 3 again, for the same anti-vacuity reason. The second group is
        what an adversarial review showed a floor of FOUR would have silenced:
        the short clarification requests a candidate needs most on a bad line.
        """
        for text in (
            "I want to understand about the leads everything because",
            "sorry, repeat that",
            "can you repeat",
            "wait wait wait",
            "repeat that please",
        ):
            with self.subTest(text=text):
                self.assertGreaterEqual(
                    len(text.split()), 3,
                    f"{text!r} can no longer interrupt the bot")

    def test_zero_is_honoured_as_the_rollback_lever(self):
        with patch.dict(
            os.environ, {"PHONE_MIN_INTERRUPTION_WORDS": "0"}, clear=False,
        ):
            self.assertEqual(phone.phone_min_interruption_words(), 0)

    def test_a_decimal_truncates_rather_than_rounding(self):
        """`int(float(raw))`. "2.9" is 2, not 3 — i.e. LOWER than asked for."""
        with patch.dict(
            os.environ, {"PHONE_MIN_INTERRUPTION_WORDS": "2.9"}, clear=False,
        ):
            self.assertEqual(phone.phone_min_interruption_words(), 2)

    def test_unparseable_values_fall_back_to_the_default(self):
        for raw in ("", "banana", "4 words"):
            with self.subTest(raw=raw):
                with patch.dict(
                    os.environ, {"PHONE_MIN_INTERRUPTION_WORDS": raw}, clear=False,
                ):
                    self.assertEqual(phone.phone_min_interruption_words(), 3)

    def test_out_of_range_values_CLAMP_they_do_not_fall_back(self):
        """`_bounded_int_env` clamps. Pinned because it is a sharp edge.

        An operator who types 99 gets 8, which is safe. An operator who types
        a NEGATIVE gets 0 — and 0 is not "a bit less strict", it is the SDK
        default, i.e. barge-in on raw VAD energy with no word gate at all
        (the 2026-09-10 Praveetha failure: 8/8 bot turns truncated with the
        candidate silent). Anyone changing the bounds must know that the floor
        of the range IS the kill switch.
        """
        for raw, expected in (("99", 8), ("9", 8), ("-1", 0), ("-99", 0)):
            with self.subTest(raw=raw):
                with patch.dict(
                    os.environ, {"PHONE_MIN_INTERRUPTION_WORDS": raw}, clear=False,
                ):
                    self.assertEqual(phone.phone_min_interruption_words(), expected)

    def test_the_new_upper_bound_is_reachable(self):
        """8, not 5. An operator must be able to tune past the old ceiling."""
        with patch.dict(
            os.environ, {"PHONE_MIN_INTERRUPTION_WORDS": "8"}, clear=False,
        ):
            self.assertEqual(phone.phone_min_interruption_words(), 8)



if __name__ == "__main__":  # pragma: no cover
    unittest.main()
