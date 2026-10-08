"""Unit tests for the shared R1 text helpers (``r1_text``)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from r1_text import (
    SpokenMemory,
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
    pick_variant,
    repeat_kind,
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

    def test_speech_to_text_openers_of_the_owner_test_are_questions(self):
        """Turn 34 of b58c7d9c: "Like I wanted to know like why ..." was read as a pitch."""
        for text in (
            "Like I wanted to know like why are you looking at our programs",
            "like what is the friction or blocker that you have in your career",
            "I wanted to know what you do in your career",
            "I wanted to ask how your week looks",
            "I am trying to understand how we can help you fix that gap",
            "I'm trying to understand what is stopping you",
            "Trying to understand what brought you here",
            "Um, I am trying to understand what you are looking for",
            "Uh, like, I wanted to know why you signed up",
            "So tell me what is going on at work",
            "Hmm, what brings you here",
        ):
            with self.subTest(text=text):
                self.assertTrue(is_question_like(text))

    def test_wondering_and_wanting_to_wonder_open_a_question(self):
        """Turn 25 of b58c7d9c: "So I wanted to wonder what makes you here ..." was no question."""
        for text in (
            "So I wanted to wonder what makes you here, bring what makes you come here",
            "and also I was wondering like what do you want",
            "I'm wondering what you do for work",
            "I am wondering how your week looks",
            "I wonder what made you sign up",
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
            "Like I said, we help you fix that gap.",
            "I am trying to get you enrolled today.",
            "Um, we offer live classes and recordings.",
            "I wanted the best price for you.",
        ):
            with self.subTest(text=text):
                self.assertFalse(is_question_like(text))

    def test_when_asks_only_in_inverted_order(self):
        """"When it comes to live classes, you can ask ..." is a subordinate clause (turns 37,
        45, 51 and 78 of b58c7d9c), while "when can I expect your call back" asks."""
        for text in (
            "when can I expect your call back",
            "so when exactly do you plan to decide",
            "and when will you hear back",
            "okay when are you hoping to start",
            "Uh, when will you get back to me",
            "when's the next cohort",
        ):
            with self.subTest(text=text):
                self.assertTrue(is_question_like(text), text)
        for text in (
            "Like When it comes to live classes, you can ask them any questions you want.",
            "You will land on something, but when it comes to our programs we really deliver.",
            "Yeah, we have our own portal, so when you miss the live classes, you can request "
            "a recording.",
            "When you call me back, I can also talk to your husband.",
            "Um, so, uh, when you call me back, in that case, I can also talk to your husband, "
            "you know, in case if you have any doubts.",
        ):
            with self.subTest(text=text):
                self.assertFalse(is_question_like(text), text)

    def test_a_wh_word_inside_an_offer_or_promise_is_not_a_question(self):
        """Turn 78 of b58c7d9c: the advisor's offer ended "... why the program is $8,500 and
        what are the packages that we will get" and read as a probe of H2 and H3."""
        for text in (
            "I can also help him understand like why the program is $8,500 and what are the "
            "packages that we will get",
            "We will explain why it costs this and what you get for it",
            "I'll walk you through how it works and what the options are",
            "so what we can do is send you the details",
            "and what I mean is the cohort is limited",
        ):
            with self.subTest(text=text):
                self.assertFalse(is_question_like(text), text)

    def test_a_run_on_question_after_a_conjunction_is_still_a_question(self):
        for text in (
            "okay and what are the packages",
            "I'm great, thank you, so what do you do for work",
            "Yeah I just got a call from you and uh so why are you looking at our programs",
            "that makes sense and how many hours a week can you give it",
        ):
            with self.subTest(text=text):
                self.assertTrue(is_question_like(text), text)

    def test_the_full_turn_78_offer_is_no_probe_at_all(self):
        from r1_personas import detect_probes

        turn_78 = (
            "Oh, fine. Um, so, uh, when you call me back, in that case, I can also talk to your "
            "husband, you know, in case if you have any doubts and, uh, I can also help him "
            "understand like why the program is $8,500 and what are the packages that we will "
            "getting. I maybe I will give him the entire curriculum details so that he will "
            "also understand and, uh, you know, support you in this entire process."
        )
        self.assertEqual(detect_probes(turn_78), frozenset())
        self.assertFalse(any(is_question_like(s) for s in split_sentences(turn_78)))


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


class SpokenMemoryTests(unittest.TestCase):
    STALL = "Let me think about it. Just email me the details and I'll get back to you."

    def test_it_remembers_sentences_long_enough_to_be_repeated(self):
        memory = SpokenMemory()
        self.assertEqual(memory.add(self.STALL), 2)
        self.assertEqual(len(memory), 2)
        self.assertEqual(memory.add("Okay. Mm-hmm. That makes sense."), 0)
        self.assertEqual(len(memory), 2)

    def test_it_keeps_a_normalised_form_and_ignores_duplicates(self):
        memory = SpokenMemory()
        memory.add("I've tried a bit of online stuff before.")
        memory.add("I’ve TRIED a bit of online stuff before!")
        self.assertEqual(memory.snapshot(), ("ive tried a bit of online stuff before",))

    def test_a_snapshot_is_immutable_and_does_not_follow_later_additions(self):
        memory = SpokenMemory()
        before = memory.snapshot()
        memory.add(self.STALL)
        self.assertEqual(before, ())
        self.assertIsInstance(memory.snapshot(), tuple)

    def test_empty_and_odd_input_is_harmless(self):
        memory = SpokenMemory()
        for text in ("", None, "   ", "...", 42):
            memory.add(text)
        self.assertEqual(len(memory), 0)


class RepeatKindTests(unittest.TestCase):
    SAID = SpokenMemory()
    SAID.add("Just exploring options. I've tried a bit of online stuff before.")
    SAID.add("Let me think about it. Just email me the details and I'll get back to you.")
    SNAP = SAID.snapshot()

    def test_an_exact_repeat_needs_four_words(self):
        self.assertEqual(repeat_kind("I've tried a bit of online stuff before!", self.SNAP), "exact")
        self.assertEqual(repeat_kind("Let me think about it.", self.SNAP), "exact")
        self.assertIsNone(repeat_kind("Just exploring options.", self.SNAP))  # 3 words

    def test_a_sentence_inside_an_earlier_one_is_a_near_repeat(self):
        self.assertEqual(repeat_kind("Just email me the details.", self.SNAP), "near")

    def test_a_sentence_containing_an_earlier_one_is_a_near_repeat(self):
        said = SpokenMemory()
        said.add("I quit a free Python course.")
        self.assertEqual(
            repeat_kind("Honestly I quit a free Python course last year.", said.snapshot()), "near"
        )

    def test_four_content_words_are_needed_for_a_near_repeat(self):
        said = SpokenMemory()
        said.add("Fine, that is a good point.")
        # Only three content words (that, good, point): too little to call it a repeat.
        self.assertIsNone(repeat_kind("That is a good point.", said.snapshot()))
        self.assertIsNone(repeat_kind("Good point.", said.snapshot()))
        self.assertEqual(repeat_kind("Fine, that is a good point.", said.snapshot()), "exact")

    def test_order_matters_and_one_missing_word_in_four_is_not_a_repeat(self):
        said = SpokenMemory()
        said.add("I quit a free Python course.")
        self.assertIsNone(repeat_kind("Course free Python quit.", said.snapshot()))
        self.assertIsNone(repeat_kind("I quit a paid Python course.", said.snapshot()))

    def test_nothing_said_means_no_repeat(self):
        self.assertIsNone(repeat_kind("I've tried a bit of online stuff before.", ()))
        self.assertIsNone(repeat_kind("", self.SNAP))


class PickVariantTests(unittest.TestCase):
    VARIANTS = ("a", "b", "c")

    def test_no_seed_starts_at_the_first_variant_and_walks_the_rotation(self):
        self.assertEqual([pick_variant(self.VARIANTS, "", n) for n in range(4)], list("abca"))

    def test_the_start_is_deterministic_per_seed_and_varies_across_seeds(self):
        self.assertEqual(
            pick_variant(self.VARIANTS, "attempt-1", 0), pick_variant(self.VARIANTS, "attempt-1", 0)
        )
        starts = {pick_variant(self.VARIANTS, f"attempt-{n}", 0) for n in range(40)}
        self.assertEqual(starts, set(self.VARIANTS))

    def test_a_full_rotation_uses_every_variant_once(self):
        for seed in ("x", "attempt-9", "b58c7d9c"):
            used = [pick_variant(self.VARIANTS, seed, n) for n in range(3)]
            self.assertEqual(sorted(used), list("abc"))

    def test_no_variants_and_negative_counts_are_safe(self):
        self.assertEqual(pick_variant((), "x", 3), "")
        self.assertEqual(pick_variant(self.VARIANTS, "", -5), "a")


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
