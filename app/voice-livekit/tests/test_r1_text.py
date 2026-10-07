"""Unit tests for the shared R1 text helpers (``r1_text``)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from r1_text import (
    canonical_amounts,
    dollar_amounts,
    fold,
    fuzzy_contains,
    fuzzy_ratio,
    has_contact_detail,
    is_question_like,
    mask_contact,
    negated_before,
    normalize,
    split_sentences,
    truncate_words,
    word_count,
)


class NormalisationTests(unittest.TestCase):
    def test_fold_normalises_typographic_characters(self):
        self.assertEqual(fold("It\u2019s \u201cfine\u201d \u2014 ok\u2026"), 'It\'s "fine" - ok...')

    def test_normalize_drops_apostrophes_and_punctuation(self):
        self.assertEqual(normalize("It's $9,000 -- OK?"), "its 9 000 ok")

    def test_word_count_counts_tokens_not_punctuation(self):
        self.assertEqual(word_count("Okay, that's helpful."), 3)
        self.assertEqual(word_count("  ...  "), 0)
        self.assertEqual(word_count(""), 0)
        self.assertEqual(word_count(None), 0)


class SentenceTests(unittest.TestCase):
    def test_split_keeps_decimals_times_and_amounts_together(self):
        parts = split_sentences("It costs $7,000. About 4.5 hours at 3:30 AM? Yes!")
        self.assertEqual(parts, ["It costs $7,000.", "About 4.5 hours at 3:30 AM?", "Yes!"])

    def test_split_on_newlines_and_empty_input(self):
        self.assertEqual(split_sentences("one\ntwo"), ["one", "two"])
        self.assertEqual(split_sentences(""), [])

    def test_question_mark_is_enough(self):
        self.assertTrue(is_question_like("Sure?"))

    def test_unpunctuated_interrogatives_and_elicitations(self):
        for text in (
            "what made you look into this now",
            "tell me about your background",
            "walk me through that",
            "so what is driving the timeline",
            "okay and how many hours a week",
            "I was wondering if you could share more",
            "is it live",
            "thanks for sharing so what made you start",
        ):
            with self.subTest(text=text):
                self.assertTrue(is_question_like(text))

    def test_statements_are_not_questions(self):
        for text in (
            "Interview Kickstart was founded in 2014.",
            "Thanks for your time.",
            "That's a good question.",
            "Our career-transition support is strong",
            "",
        ):
            with self.subTest(text=text):
                self.assertFalse(is_question_like(text))


class FuzzyTests(unittest.TestCase):
    LINE = "Is it live classes or recorded?"

    def test_exact_and_embedded_line_match(self):
        self.assertTrue(fuzzy_contains(self.LINE, self.LINE))
        self.assertTrue(fuzzy_contains("Before that, is it live classes or recorded?", self.LINE))

    def test_unrelated_or_truncated_text_does_not_match(self):
        self.assertFalse(fuzzy_contains("Could you explain the schedule?", self.LINE))
        self.assertFalse(fuzzy_contains("Is it live", self.LINE))
        self.assertEqual(fuzzy_ratio("anything", ""), 0.0)

    def test_order_matters(self):
        self.assertFalse(fuzzy_contains("recorded classes live or it is", self.LINE))


class ContactTests(unittest.TestCase):
    def test_written_spoken_phone_and_url_forms_are_detected(self):
        for text in (
            "mail me at meera.iyer@gmail.com",
            "it is meera dot iyer at gmail dot com",
            "meera dot iyer at the rate gmail dot com",
            "call 555-123-4567",
            "my number is +1 (555) 123 4567",
            "nine eight seven six five four three two one zero",
            "see interviewkickstart.com/apply",
            "message me on whatsapp",
            "https://example.org/x",
        ):
            with self.subTest(text=text):
                self.assertTrue(has_contact_detail(text))

    def test_numbers_and_ordinary_words_are_not_contact_details(self):
        for text in (
            "It is about 4.5 hours a week",
            "I applied to 150+ roles since 2024",
            "The course is $9,000 over 6 months",
            "I will send you the details",
            "Interview Kickstart has 750 instructors",
            "one two three",
        ):
            with self.subTest(text=text):
                self.assertFalse(has_contact_detail(text))

    def test_mask_replaces_and_caps_length(self):
        masked = mask_contact("write to a.b@gmail.com now please", 20)
        self.assertNotIn("@", masked)
        self.assertLessEqual(len(masked), 20)
        self.assertIn("[contact]", mask_contact("a.b@gmail.com"))


class TruncationTests(unittest.TestCase):
    def test_whole_sentences_are_kept_while_they_fit(self):
        text = "Okay, that makes sense. I see where you are going. And another thing is here."
        self.assertEqual(truncate_words(text, 8), "Okay, that makes sense.")
        self.assertEqual(truncate_words(text, 0), "")

    def test_a_single_long_sentence_is_cut_at_a_word_and_closed(self):
        out = truncate_words("one two three four five six seven", 3)
        self.assertEqual(out, "one two three.")


class DollarTests(unittest.TestCase):
    def test_amount_forms(self):
        self.assertEqual(
            dollar_amounts("It's $9,000. Or $1.5k off, 500 dollars, USD 700, about $7,000."),
            [9000, 1500, 500, 700, 7000],
        )
        self.assertEqual(dollar_amounts("no money here, 2024"), [])

    def test_absurd_digit_runs_are_rejected_not_raised(self):
        from r1_text import MAX_AMOUNT, parse_amount

        self.assertEqual(dollar_amounts("$" + "9" * 400 + " off"), [])
        self.assertEqual(dollar_amounts("$" + "9" * 12), [])
        self.assertIsNone(parse_amount("9" * 400))
        self.assertIsNone(parse_amount(None))
        self.assertIsNone(parse_amount("abc"))
        self.assertIsNone(parse_amount(str(MAX_AMOUNT + 1)))
        self.assertEqual(parse_amount("1.5", True), 1500)
        self.assertEqual(parse_amount("9,000."), 9000)


class NegationTests(unittest.TestCase):
    """Polarity: a negator earlier in the clause negates the phrase (review P1 x2)."""

    def negated(self, text, needle):
        folded = fold(text)
        return negated_before(folded, folded.lower().index(needle.lower()))

    def test_a_negator_earlier_in_the_clause_negates_the_phrase(self):
        for text, needle in (
            ("We can't guarantee a job.", "guarantee"),
            ("Nobody can guarantee placement.", "guarantee"),
            ("We don't offer a money-back guarantee.", "guarantee"),
            ("There is no bonus on this.", "bonus"),
            ("Job outcomes aren't guaranteed.", "guaranteed"),
            ("Nothing guarantees a job.", "guarantees"),
            ("We cant guarantee anything.", "guarantee"),
            ("I'm not able to offer it at $7,000.", "$7,000"),
            ("It is not a guarantee.", "guarantee"),
            ("We can't promise much but we cannot guarantee it.", "guarantee"),
            ("It’s not guaranteed.", "guaranteed"),
        ):
            with self.subTest(text=text):
                self.assertTrue(self.negated(text, needle))

    def test_affirmative_text_and_other_clauses_are_not_negated(self):
        for text, needle in (
            ("It's a guaranteed job.", "guaranteed"),
            ("There's a full refund guarantee.", "guarantee"),
            ("We can't promise much, but it's a guaranteed job.", "guaranteed"),
            ("I don't know. We guarantee a callback.", "guarantee"),
            ("Not now - we guarantee a callback.", "guarantee"),
        ):
            with self.subTest(text=text):
                self.assertFalse(self.negated(text, needle))

    def test_courtesies_are_not_negations(self):
        for text, needle in (
            ("No problem I can do $500 off.", "$500"),
            ("No worries we can offer a bonus.", "bonus"),
            ("It's not a problem we can offer a bonus.", "bonus"),
            ("Without a doubt we can offer a bonus.", "bonus"),
        ):
            with self.subTest(text=text):
                self.assertFalse(self.negated(text, needle))

    def test_a_negator_more_than_six_words_back_does_not_reach(self):
        far = "We can't say much about it so I will just add that we guarantee a callback."
        self.assertFalse(self.negated(far, "guarantee"))
        near = "We can't say that we guarantee a callback."
        self.assertTrue(self.negated(near, "guarantee"))

    def test_clause_helpers_split_on_punctuation_and_contrast(self):
        from r1_text import clause_after, clause_before

        text = "i can't do it, but i can do $500 off. then more"
        self.assertEqual(clause_before(text, text.index("$500")).strip(), "i can do")
        self.assertEqual(clause_after(text, text.index(" off")).strip(), "off")
        self.assertEqual(clause_after("no stop here", 2), " stop here")


class CanonicalAmountTests(unittest.TestCase):
    """One amount grammar for every reader (review P2: Sarvam may write numbers any way)."""

    def test_every_written_form_becomes_a_dollar_amount(self):
        for text, expected in (
            ("a discount of 1500 dollars", "a discount of $1500"),
            ("a discount of $1,500", "a discount of $1500"),
            ("take $1.5k off", "take $1500 off"),
            ("take 1.5k dollars off", "take $1500 off"),
            ("USD 1500 off", "$1500 off"),
            ("1500 bucks off", "$1500 off"),
            ("fifteen hundred dollars off", "$1500 off"),
            ("three thousand dollars off", "$3000 off"),
            ("a thousand off", "$1000 off"),
            ("one thousand five hundred", "$1500"),
            ("two thousand five hundred dollars", "$2500"),
            ("seven hundred and fifty", "$750"),
            ("ten percent off", "10% off"),
            ("twenty five percent off", "25% off"),
            ("10 percent off", "10 percent off"),
        ):
            with self.subTest(text=text):
                self.assertEqual(canonical_amounts(text), expected)

    def test_plain_small_numbers_and_words_are_left_alone(self):
        for text in ("six months", "I have two kids", "about 10 hours a week", "ten or so"):
            with self.subTest(text=text):
                self.assertEqual(canonical_amounts(text), text)

    def test_surrounding_spacing_is_preserved(self):
        self.assertEqual(canonical_amounts("USD 700 and 500 bucks."), "$700 and $500.")
        self.assertEqual(canonical_amounts("take $2000 off"), "take $2000 off")

    def test_absurd_runs_are_left_as_they_were(self):
        text = "$" + "9" * 400 + " off"
        self.assertEqual(canonical_amounts(text), text)

    def test_the_grammar_agrees_with_dollar_amounts(self):
        for text in ("1500 dollars", "$1,500", "$1.5k", "USD 1500", "1500 bucks"):
            with self.subTest(text=text):
                self.assertEqual(dollar_amounts(canonical_amounts(text)), dollar_amounts(text))
                self.assertEqual(dollar_amounts(text), [1500])


if __name__ == "__main__":
    unittest.main()
