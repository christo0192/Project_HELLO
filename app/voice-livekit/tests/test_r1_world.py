"""Unit tests for ``r1_world``: deck-only facts, the SHA pin and the deflection policy."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import r1_world
from r1_world import (
    AUDIENCE_ADVISOR,
    AUDIENCE_INTERVIEWER_FAQ,
    DECK_SHA256,
    DISCOUNTS_USD,
    FACTS,
    INTERVIEWER_DEFLECTION,
    LEARNER_DEFLECTION,
    UNSTATED_TOPICS,
    WORLD_SHA256,
    WORLD_VERSION,
    claims_guarantee,
    deck_conflicts,
    fact,
    facts_for,
)

# Review pin: editing any fact changes WORLD_SHA256.  Update this constant, WORLD_REVISION
# and tests/test_r1_content_pin.py together, in the same reviewed change.
PINNED_WORLD_SHA256 = "6f3470d8dbb9b0cdcb6aa34fcde1e766b0dd4807e2aba81b3d10d8affd2ca199"


class DeckFactsTests(unittest.TestCase):
    def test_numbers_are_the_decks(self):
        self.assertEqual(r1_world.PRICE_USD, 9000)
        self.assertEqual(DISCOUNTS_USD, (500, 1000, 1500))
        self.assertEqual(r1_world.MAX_DISCOUNT_USD, 1500)
        self.assertEqual(r1_world.DURATION_MONTHS, 6)
        self.assertEqual(r1_world.NET_PRICES_USD, (8500, 8000, 7500))
        self.assertIn("$9000", fact("ds.price").text)
        self.assertIn("$500, $1000 and $1500", fact("ds.discounts").text)
        self.assertIn("depending on the payment plan chosen", fact("ds.discounts").text)
        self.assertIn("6 months", fact("ds.duration").text)

    def test_company_and_module_facts_match_the_deck(self):
        self.assertIn("2014", fact("company.founded").text)
        self.assertIn("18 engineering domains", fact("products.interview_prep").text)
        self.assertIn("750 instructors", fact("usp.instructors").text)
        modules = fact("ds.modules").text
        for name in (
            "Python Fundamentals",
            "Database & SQL Programming",
            "Math for Data Science & Machine Learning",
            "Exploratory Data Analysis",
            "Classical Machine Learning",
            "Advanced Machine Learning & Deep Learning",
            "Big Data Analysis",
            "Data Visualization & Storytelling",
            "Capstone Project",
        ):
            self.assertIn(name, modules)
        urgency = fact("ds.urgency_levers").text
        for lever in (
            "limited enrollment spots",
            "upcoming application deadlines",
            "seasonal discounts",
            "high industry demand for data scientists",
            "early access to resources",
            "upcoming recruitment cycles",
            "career advancement potential",
            "proven success stories",
        ):
            self.assertIn(lever, urgency)

    def test_shift_timings_are_the_decks(self):
        shift = fact("role.shift").text
        for token in ("10:00 PM", "8 AM IST", "3:30 AM", "10 hours", "4.5 hours", "5.5 days"):
            self.assertIn(token, shift)

    def test_fact_ids_are_unique_and_pages_are_deck_pages(self):
        ids = [item.id for item in FACTS]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(1 <= item.page <= r1_world.DECK_PAGES for item in FACTS))

    def test_unknown_fact_raises(self):
        with self.assertRaises(KeyError):
            fact("ds.cohort_start")


class NothingBeyondTheDeckTests(unittest.TestCase):
    """The owner decision: what the deck does not state must not be asserted."""

    ALL_TEXT = " ".join(item.text for item in FACTS).lower()

    def test_no_discount_to_plan_mapping_is_asserted(self):
        # The deck says only "depending on the payment plan chosen".
        for amount in ("500", "1000", "1500"):
            for plan_word in ("monthly", "quarterly", "upfront", "up-front", "annual", "emi"):
                pattern = (
                    rf"\${amount}[^.]{{0,40}}{plan_word}|{plan_word}[^.]{{0,40}}\${amount}"
                )
                self.assertNotRegex(self.ALL_TEXT, pattern)

    def test_unstated_specifics_do_not_appear_in_any_fact(self):
        for phrase in (
            "cohort start",
            "starts on",
            "seats left",
            "spots left",
            "hours a week",
            "hours per week",
            "live classes",
            "recorded classes",
            "refund",
            "placement rate",
            "guarantee",
            "certificate",
            "money-back",
            "does not offer",
            "remote",
            "hybrid",
            "salary",
        ):
            self.assertNotIn(phrase, self.ALL_TEXT, phrase)

    def test_every_unstated_topic_is_declared_and_ids_are_unique(self):
        ids = [topic.id for topic in UNSTATED_TOPICS]
        self.assertEqual(len(ids), len(set(ids)))
        for required in (
            "discount_plan_mapping",
            "cohort_start_dates",
            "enrolment_deadline",
            "seat_counts",
            "weekly_hours",
            "delivery_format",
            "project_details",
            "does_not_offer",
            "role_compensation",
            "role_work_mode",
            "role_next_steps",
        ):
            self.assertIn(required, ids)

    def test_the_learner_audience_gets_no_fact_at_all(self):
        self.assertEqual(facts_for("learner"), ())
        self.assertEqual(r1_world.LEARNER_PUBLIC_PRICE_USD, 9000)
        self.assertEqual(r1_world.LEARNER_PUBLIC_DURATION_MONTHS, 6)

    def test_interviewer_faq_is_only_the_shift_timings(self):
        self.assertEqual([item.id for item in facts_for(AUDIENCE_INTERVIEWER_FAQ)], ["role.shift"])

    def test_advisor_facts_exclude_the_role_facts(self):
        ids = {item.id for item in facts_for(AUDIENCE_ADVISOR)}
        self.assertIn("ds.price", ids)
        self.assertNotIn("role.shift", ids)
        self.assertNotIn("role.process", ids)


class PinTests(unittest.TestCase):
    def test_world_sha_is_pinned(self):
        self.assertEqual(
            WORLD_SHA256,
            PINNED_WORLD_SHA256,
            "a world fact changed: review it, bump WORLD_REVISION and update the pins",
        )
        self.assertRegex(WORLD_SHA256, r"^[a-f0-9]{64}$")

    def test_version_embeds_the_sha_prefix(self):
        self.assertEqual(
            WORLD_VERSION, f"r1_world_facts_v{r1_world.WORLD_REVISION}+{WORLD_SHA256[:12]}"
        )

    def test_deck_sha_is_a_lowercase_sha256(self):
        self.assertRegex(DECK_SHA256, r"^[a-f0-9]{64}$")

    def test_sha_changes_when_a_fact_changes(self):
        def digest() -> str:
            return r1_world.hashlib.sha256(r1_world._canonical()).hexdigest()

        original = r1_world.FACTS
        altered = r1_world.Fact(
            "ds.price", "The Data Science course has a listed price of $9500.", 2, ("advisor",)
        )
        try:
            r1_world.FACTS = (altered,) + original[1:]
            self.assertNotEqual(digest(), WORLD_SHA256)
        finally:
            r1_world.FACTS = original
        self.assertEqual(digest(), WORLD_SHA256)


class DeflectionTests(unittest.TestCase):
    def test_deflection_lines(self):
        self.assertEqual(LEARNER_DEFLECTION, "I'm not sure, I haven't thought about that.")
        self.assertEqual(
            INTERVIEWER_DEFLECTION,
            "That's a good question for the hiring team; they'll follow up with you on it.",
        )
        self.assertEqual(set(r1_world.DEFLECTION_POLICY), {"learner", "interviewer", "scorer"})

    def test_deck_conflicts_flag_only_what_the_deck_pins_down(self):
        self.assertEqual(
            deck_conflicts("It's a guaranteed job and 100% placement."), ("guarantee_claim",)
        )
        self.assertEqual(deck_conflicts("The course lasts three months."), ("duration_not_deck",))
        self.assertEqual(deck_conflicts("The course is priced at $12,000."), ("price_not_deck",))
        self.assertEqual(
            deck_conflicts("The course is six months and costs $9000, or $8,000 after $1000 off."),
            (),
        )
        # Plausible specifics the deck does not mention are not conflicts.
        self.assertEqual(deck_conflicts("Classes run on weekends and cohorts start monthly."), ())
        self.assertEqual(deck_conflicts(""), ())


class GuaranteePolarityTests(unittest.TestCase):
    """An honest disclaimer is not a guarantee claim (review P1)."""

    DISCLAIMERS = (
        "I can't guarantee a job, but our career support is strong.",
        "Nobody can guarantee placement.",
        "We don't offer a money-back guarantee.",
        "Job outcomes aren't guaranteed and I won't promise that.",
        "That is not a job guarantee.",
        "Nothing guarantees a job, but we help you prepare.",
        "We focus on interview prep, not job guarantees.",
    )
    CLAIMS = (
        "It's a guaranteed job.",
        "There's a full refund guarantee.",
        "We guarantee placement.",
        "You get a 100% placement record.",
        "No problem, we guarantee a job.",
        "I can't promise much, but it's a guaranteed job.",
    )

    def test_a_disclaimer_is_not_a_claim(self):
        for text in self.DISCLAIMERS:
            with self.subTest(text=text):
                self.assertFalse(claims_guarantee(text))
                self.assertNotIn("guarantee_claim", deck_conflicts(text))

    def test_an_affirmation_is_still_a_claim(self):
        for text in self.CLAIMS:
            with self.subTest(text=text):
                self.assertTrue(claims_guarantee(text))
                self.assertIn("guarantee_claim", deck_conflicts(text))

    def test_a_claim_in_a_later_sentence_is_found_after_a_disclaimer(self):
        text = "I can't guarantee a job. But it is a guaranteed placement programme."
        self.assertTrue(claims_guarantee(text))

    def test_empty_text_claims_nothing(self):
        self.assertFalse(claims_guarantee(""))
        self.assertFalse(claims_guarantee(None))


if __name__ == "__main__":
    unittest.main()
