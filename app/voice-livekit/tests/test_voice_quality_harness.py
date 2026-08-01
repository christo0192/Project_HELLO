"""Deterministic offline tests for voice_quality_harness (VOI-02..06).

Runs under both `python3 -m pytest` and `python3 -m unittest discover`.
No third-party imports; fixtures are loaded relative to this file from
tests/fixtures/voice-quality/.
"""

import copy
import json
import os
import unittest

import voice_quality_harness

from voice_quality_harness import (
    DEFAULT_MAX_WORDS,
    PROPOSED_STATUS,
    EntityMetrics,
    ProfileValidationError,
    entity_metrics,
    normalize_text,
    resolve_profile,
    validate_fixture_document,
    validate_mos_rating,
    validate_network_profile,
    validate_noise_profile,
    validate_pronunciation_entry,
    validate_pronunciation_protocol,
    validate_turn_profile,
    word_error_rate,
)

FIXTURES_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fixtures", "voice-quality"
)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))

SCHEMA_PATH = os.path.join(REPO_ROOT, "config", "voice-quality-harness.schema.json")

FIXTURE_FILES = {
    "turn_profiles.json": frozenset({"profiles"}),
    "noise_profiles.json": frozenset({"profiles"}),
    "network_profiles.json": frozenset({"profiles"}),
    "pronunciation_protocol.json": frozenset({"protocol", "entries"}),
    "wer_pairs.json": frozenset({"pairs"}),
}


def load_fixture(name):
    """Load a fixture JSON file fresh (never shared across tests)."""
    with open(os.path.join(FIXTURES_DIR, name), encoding="utf-8") as handle:
        return json.load(handle)


def pair_by_id(pair_id):
    doc = load_fixture("wer_pairs.json")
    for pair in doc["pairs"]:
        if pair["id"] == pair_id:
            return pair
    raise AssertionError("missing wer pair: %s" % pair_id)


# ── normalize_text ──────────────────────────────────────────────────────


class TestNormalizeText(unittest.TestCase):
    def test_lowercases_and_splits_words(self):
        self.assertEqual(normalize_text("Hello World"), ["hello", "world"])

    def test_strips_punctuation(self):
        self.assertEqual(
            normalize_text("I am from Bengaluru, India."),
            ["i", "am", "from", "bengaluru", "india"],
        )

    def test_keeps_apostrophes(self):
        self.assertEqual(normalize_text("It's a test"), ["it's", "a", "test"])

    def test_empty_text_has_no_tokens(self):
        self.assertEqual(normalize_text(""), [])


# ── word_error_rate ─────────────────────────────────────────────────────


class TestWordErrorRate(unittest.TestCase):
    def test_identical_returns_zero(self):
        self.assertEqual(word_error_rate("hello my name is ravi", "hello my name is ravi"), 0.0)

    def test_non_matching_greater_than_zero(self):
        self.assertGreater(word_error_rate("a b c", "x y z"), 0.0)

    def test_empty_reference_raises(self):
        with self.assertRaises(ValueError):
            word_error_rate("", "hello")

    def test_oversized_reference_raises(self):
        with self.assertRaises(ValueError):
            word_error_rate("a b c", "a b", max_words=2)

    def test_oversized_hypothesis_raises(self):
        with self.assertRaises(ValueError):
            word_error_rate("a b", "a b c", max_words=2)

    def test_empty_hypothesis_is_exactly_one(self):
        self.assertEqual(word_error_rate("i am interested in this role", ""), 1.0)

    def test_deletion_exact_value(self):
        self.assertEqual(word_error_rate("a b c", "a b"), round(1 / 3, 6))

    def test_substitution_exact_value(self):
        self.assertEqual(word_error_rate("a b c", "a c"), round(1 / 3, 6))
        self.assertEqual(word_error_rate("a b c", "a d c"), round(1 / 3, 6))

    def test_normalization_determinism(self):
        self.assertEqual(
            word_error_rate("I am from Bengaluru, India.", "i am from bengaluru india"),
            0.0,
        )

    def test_non_string_raises_type_error(self):
        with self.assertRaises(TypeError):
            word_error_rate(123, "abc")
        with self.assertRaises(TypeError):
            word_error_rate("abc", None)

    def test_default_max_words_constant(self):
        self.assertEqual(DEFAULT_MAX_WORDS, 500)


# ── entity_metrics ──────────────────────────────────────────────────────


class TestEntityMetrics(unittest.TestCase):
    def test_perfect_match(self):
        text = "abcdef"
        entities = [(0, 2, "ab"), (2, 4, "cd"), (4, 6, "ef")]
        result = entity_metrics(text, entities, list(entities))
        self.assertIsInstance(result, EntityMetrics)
        self.assertEqual(result.precision, 1.0)
        self.assertEqual(result.recall, 1.0)
        self.assertEqual(result.f1, 1.0)
        self.assertEqual(result.matched, 3)
        self.assertEqual(result.reference_count, 3)
        self.assertEqual(result.predicted_count, 3)

    def test_empty_predicted(self):
        result = entity_metrics("abc", [(0, 2, "ab")], [])
        self.assertEqual(result.precision, 0.0)
        self.assertEqual(result.recall, 0.0)
        self.assertEqual(result.f1, 0.0)
        self.assertEqual(result.matched, 0)

    def test_empty_reference_raises(self):
        with self.assertRaises(ValueError):
            entity_metrics("abc", [], [])

    def test_out_of_bounds_span_raises(self):
        with self.assertRaises(ValueError):
            entity_metrics("abc", [(0, 5, "x")], [])
        with self.assertRaises(ValueError):
            entity_metrics("abc", [(-1, 1, "x")], [])

    def test_zero_length_span_raises(self):
        with self.assertRaises(ValueError):
            entity_metrics("abc", [(1, 1, "x")], [])

    def test_non_int_bound_raises(self):
        with self.assertRaises(ValueError):
            entity_metrics("abc", [(0.5, 2, "x")], [])
        with self.assertRaises(ValueError):
            entity_metrics("abc", [("0", 2, "x")], [])

    def test_empty_label_raises(self):
        with self.assertRaises(ValueError):
            entity_metrics("abc", [(0, 2, "")], [])

    def test_overlapping_reference_raises(self):
        with self.assertRaises(ValueError):
            entity_metrics("abcdef", [(0, 3, "ab"), (2, 5, "cd")], [])

    def test_touching_reference_is_not_overlapping(self):
        result = entity_metrics("abcd", [(0, 2, "ab"), (2, 4, "cd")], [])
        self.assertEqual(result.reference_count, 2)

    def test_overlapping_predicted_is_deterministic(self):
        # Both predicted spans share the same reference region; greedy
        # matching in predicted order matches it exactly once.
        text = "abcdef"
        reference = [(0, 2, "ab")]
        predicted = [(0, 2, "ab"), (0, 2, "ab")]
        result = entity_metrics(text, reference, predicted)
        self.assertEqual(result.matched, 1)
        self.assertEqual(result.precision, 0.5)
        self.assertEqual(result.recall, 1.0)
        self.assertEqual(result.f1, round(2 * 0.5 * 1.0 / (0.5 + 1.0), 6))

    def test_partial_match_exact_values(self):
        # (3,5,"de") matches neither (0,2,"ab") nor (2,4,"cd").
        text = "abcdef"
        reference = [(0, 2, "ab"), (2, 4, "cd")]
        predicted = [(0, 2, "ab"), (3, 5, "de")]
        result = entity_metrics(text, reference, predicted)
        self.assertEqual(result.matched, 1)
        self.assertEqual(result.precision, 0.5)
        self.assertEqual(result.recall, 0.5)
        self.assertEqual(result.f1, 0.5)


# ── validate_mos_rating ─────────────────────────────────────────────────


class TestValidateMosRating(unittest.TestCase):
    def test_inclusive_bounds_pass_and_return_float(self):
        for value in (1.0, 5.0, 4.2):
            with self.subTest(value=value):
                result = validate_mos_rating(value)
                self.assertIsInstance(result, float)
                self.assertEqual(result, float(value))

    def test_below_scale_raises(self):
        with self.assertRaises(ValueError):
            validate_mos_rating(0.99)

    def test_above_scale_raises(self):
        with self.assertRaises(ValueError):
            validate_mos_rating(5.01)

    def test_nan_raises(self):
        with self.assertRaises(ValueError):
            validate_mos_rating(float("nan"))

    def test_infinity_raises(self):
        with self.assertRaises(ValueError):
            validate_mos_rating(float("inf"))
        with self.assertRaises(ValueError):
            validate_mos_rating(float("-inf"))

    def test_non_numeric_raises_type_error(self):
        with self.assertRaises(TypeError):
            validate_mos_rating("4.2")

    def test_int_value_returns_float(self):
        result = validate_mos_rating(4)
        self.assertIsInstance(result, float)
        self.assertEqual(result, 4.0)


# ── fixture-document envelope ───────────────────────────────────────────


class TestFixtureDocumentValidation(unittest.TestCase):
    def test_shipped_documents_pass(self):
        for name, collections in FIXTURE_FILES.items():
            with self.subTest(fixture=name):
                doc = load_fixture(name)
                validated = validate_fixture_document(doc, allowed_collections=collections)
                self.assertIs(validated, doc)

    def test_status_approved_rejected(self):
        doc = copy.deepcopy(load_fixture("turn_profiles.json"))
        doc["status"] = "approved"
        with self.assertRaises(ProfileValidationError):
            validate_fixture_document(doc, allowed_collections=frozenset({"profiles"}))

    def test_version_removed_rejected(self):
        doc = copy.deepcopy(load_fixture("turn_profiles.json"))
        del doc["version"]
        with self.assertRaises(ProfileValidationError):
            validate_fixture_document(doc, allowed_collections=frozenset({"profiles"}))

    def test_version_zero_rejected(self):
        doc = copy.deepcopy(load_fixture("turn_profiles.json"))
        doc["version"] = 0
        with self.assertRaises(ProfileValidationError):
            validate_fixture_document(doc, allowed_collections=frozenset({"profiles"}))

    def test_schema_removed_rejected(self):
        doc = copy.deepcopy(load_fixture("turn_profiles.json"))
        del doc["schema"]
        with self.assertRaises(ProfileValidationError):
            validate_fixture_document(doc, allowed_collections=frozenset({"profiles"}))

    def test_unknown_top_level_key_rejected(self):
        doc = copy.deepcopy(load_fixture("turn_profiles.json"))
        doc["bogus"] = 1
        with self.assertRaises(ProfileValidationError):
            validate_fixture_document(doc, allowed_collections=frozenset({"profiles"}))


# ── shipped profile resolution ──────────────────────────────────────────


class TestShippedProfilesResolve(unittest.TestCase):
    def test_turn_profiles_resolve(self):
        doc = load_fixture("turn_profiles.json")
        for profile in doc["profiles"]:
            with self.subTest(profile_id=profile["id"]):
                resolved = resolve_profile(
                    doc["profiles"], profile["id"], validate_turn_profile
                )
                self.assertEqual(resolved["id"], profile["id"])

    def test_noise_profiles_resolve(self):
        doc = load_fixture("noise_profiles.json")
        for profile in doc["profiles"]:
            with self.subTest(profile_id=profile["id"]):
                resolved = resolve_profile(
                    doc["profiles"], profile["id"], validate_noise_profile
                )
                self.assertEqual(resolved["id"], profile["id"])

    def test_network_profiles_resolve(self):
        doc = load_fixture("network_profiles.json")
        for profile in doc["profiles"]:
            with self.subTest(profile_id=profile["id"]):
                resolved = resolve_profile(
                    doc["profiles"], profile["id"], validate_network_profile
                )
                self.assertEqual(resolved["id"], profile["id"])


# ── turn profile negative controls ──────────────────────────────────────


class TestTurnProfileMutations(unittest.TestCase):
    def test_status_approved_rejected(self):
        profiles = copy.deepcopy(load_fixture("turn_profiles.json")["profiles"])
        profiles[0]["status"] = "approved"
        with self.assertRaises(ProfileValidationError):
            validate_turn_profile(profiles[0])

    def test_unknown_params_key_rejected(self):
        profiles = copy.deepcopy(load_fixture("turn_profiles.json")["profiles"])
        profiles[0]["params"]["bogus"] = 0.5
        with self.assertRaises(ProfileValidationError):
            validate_turn_profile(profiles[0])

    def test_out_of_range_barge_in_sensitivity_rejected(self):
        profiles = copy.deepcopy(load_fixture("turn_profiles.json")["profiles"])
        profiles[0]["params"]["barge_in_sensitivity"] = 1.5
        with self.assertRaises(ProfileValidationError):
            validate_turn_profile(profiles[0])

    def test_missing_param_rejected(self):
        profiles = copy.deepcopy(load_fixture("turn_profiles.json")["profiles"])
        del profiles[0]["params"]["vad_aggression"]
        with self.assertRaises(ProfileValidationError):
            validate_turn_profile(profiles[0])

    def test_bool_not_accepted_for_int_param(self):
        profiles = copy.deepcopy(load_fixture("turn_profiles.json")["profiles"])
        profiles[0]["params"]["vad_aggression"] = True
        with self.assertRaises(ProfileValidationError):
            validate_turn_profile(profiles[0])

    def test_unknown_profile_id_raises(self):
        profiles = copy.deepcopy(load_fixture("turn_profiles.json")["profiles"])
        with self.assertRaises(ProfileValidationError):
            resolve_profile(profiles, "does_not_exist", validate_turn_profile)

    def test_resolve_validates_every_profile(self):
        profiles = copy.deepcopy(load_fixture("turn_profiles.json")["profiles"])
        profiles[1]["status"] = "approved"
        with self.assertRaises(ProfileValidationError):
            resolve_profile(profiles, "default_turn", validate_turn_profile)


# ── noise profile negative controls ─────────────────────────────────────


class TestNoiseProfileMutations(unittest.TestCase):
    def test_status_approved_rejected(self):
        profiles = copy.deepcopy(load_fixture("noise_profiles.json")["profiles"])
        profiles[0]["status"] = "approved"
        with self.assertRaises(ProfileValidationError):
            validate_noise_profile(profiles[0])

    def test_unknown_params_key_rejected(self):
        profiles = copy.deepcopy(load_fixture("noise_profiles.json")["profiles"])
        profiles[0]["params"]["bogus"] = 1
        with self.assertRaises(ProfileValidationError):
            validate_noise_profile(profiles[0])

    def test_out_of_range_noise_snr_db_rejected(self):
        profiles = copy.deepcopy(load_fixture("noise_profiles.json")["profiles"])
        profiles[0]["params"]["noise_snr_db"] = 45.0
        with self.assertRaises(ProfileValidationError):
            validate_noise_profile(profiles[0])

    def test_unknown_scene_rejected(self):
        profiles = copy.deepcopy(load_fixture("noise_profiles.json")["profiles"])
        profiles[0]["params"]["scene"] = "nightclub"
        with self.assertRaises(ProfileValidationError):
            validate_noise_profile(profiles[0])


# ── network profile negative controls ───────────────────────────────────


class TestNetworkProfileMutations(unittest.TestCase):
    def test_status_approved_rejected(self):
        profiles = copy.deepcopy(load_fixture("network_profiles.json")["profiles"])
        profiles[0]["status"] = "approved"
        with self.assertRaises(ProfileValidationError):
            validate_network_profile(profiles[0])

    def test_unknown_params_key_rejected(self):
        profiles = copy.deepcopy(load_fixture("network_profiles.json")["profiles"])
        profiles[0]["params"]["bogus"] = 1
        with self.assertRaises(ProfileValidationError):
            validate_network_profile(profiles[0])

    def test_out_of_range_bandwidth_rejected(self):
        profiles = copy.deepcopy(load_fixture("network_profiles.json")["profiles"])
        profiles[0]["params"]["bandwidth_kbps"] = 16
        with self.assertRaises(ProfileValidationError):
            validate_network_profile(profiles[0])

    def test_unknown_network_profile_id_rejected(self):
        profiles = copy.deepcopy(load_fixture("network_profiles.json")["profiles"])
        with self.assertRaises(ProfileValidationError):
            resolve_profile(profiles, "not_a_profile", validate_network_profile)

    def test_reconnect_missing_required_key_rejected(self):
        profiles = copy.deepcopy(load_fixture("network_profiles.json")["profiles"])
        del profiles[0]["params"]["reconnect"]["enabled"]
        with self.assertRaises(ProfileValidationError):
            validate_network_profile(profiles[0])

    def test_reconnect_extra_key_rejected(self):
        profiles = copy.deepcopy(load_fixture("network_profiles.json")["profiles"])
        profiles[0]["params"]["reconnect"]["bogus"] = 1
        with self.assertRaises(ProfileValidationError):
            validate_network_profile(profiles[0])

    def test_reconnect_max_reconnects_out_of_range_rejected(self):
        profiles = copy.deepcopy(load_fixture("network_profiles.json")["profiles"])
        profiles[0]["params"]["reconnect"]["max_reconnects"] = 99
        with self.assertRaises(ProfileValidationError):
            validate_network_profile(profiles[0])

    def test_reconnect_non_bool_enabled_rejected(self):
        profiles = copy.deepcopy(load_fixture("network_profiles.json")["profiles"])
        profiles[0]["params"]["reconnect"]["enabled"] = "yes"
        with self.assertRaises(ProfileValidationError):
            validate_network_profile(profiles[0])


# ── pronunciation protocol ──────────────────────────────────────────────


class TestPronunciationEntry(unittest.TestCase):
    def test_valid_entry_passes(self):
        entry = {
            "name": "Priya Sharma",
            "role": "Senior Software Engineer",
            "synthetic": True,
        }
        validated = validate_pronunciation_entry(entry)
        self.assertIs(validated, entry)

    def test_synthetic_false_rejected(self):
        entry = {
            "name": "Priya Sharma",
            "role": "Senior Software Engineer",
            "synthetic": False,
        }
        with self.assertRaises(ProfileValidationError):
            validate_pronunciation_entry(entry)

    def test_extra_key_rejected(self):
        entry = {
            "name": "Priya Sharma",
            "role": "Senior Software Engineer",
            "synthetic": True,
            "bogus": 1,
        }
        with self.assertRaises(ProfileValidationError):
            validate_pronunciation_entry(entry)


class TestPronunciationProtocol(unittest.TestCase):
    def test_shipped_fixture_validates(self):
        doc = load_fixture("pronunciation_protocol.json")
        validated = validate_pronunciation_protocol(doc)
        self.assertIs(validated, doc)

    def test_synthetic_false_entry_rejected(self):
        doc = copy.deepcopy(load_fixture("pronunciation_protocol.json"))
        doc["entries"][0]["synthetic"] = False
        with self.assertRaises(ProfileValidationError):
            validate_pronunciation_protocol(doc)

    def test_entry_missing_role_rejected(self):
        doc = copy.deepcopy(load_fixture("pronunciation_protocol.json"))
        del doc["entries"][0]["role"]
        with self.assertRaises(ProfileValidationError):
            validate_pronunciation_protocol(doc)

    def test_protocol_missing_raters_required_rejected(self):
        doc = copy.deepcopy(load_fixture("pronunciation_protocol.json"))
        del doc["protocol"]["raters_required"]
        with self.assertRaises(ProfileValidationError):
            validate_pronunciation_protocol(doc)

    def test_raters_required_zero_rejected(self):
        doc = copy.deepcopy(load_fixture("pronunciation_protocol.json"))
        doc["protocol"]["raters_required"] = 0
        with self.assertRaises(ProfileValidationError):
            validate_pronunciation_protocol(doc)

    def test_empty_entries_rejected(self):
        doc = copy.deepcopy(load_fixture("pronunciation_protocol.json"))
        doc["entries"] = []
        with self.assertRaises(ProfileValidationError):
            validate_pronunciation_protocol(doc)


# ── fixture-wide integrity ──────────────────────────────────────────────


class TestFixtureWideIntegrity(unittest.TestCase):
    def test_every_document_validates_and_every_profile_is_proposed(self):
        total_profiles = 0
        total_proposed = 0
        for name, collections in FIXTURE_FILES.items():
            with self.subTest(fixture=name):
                doc = load_fixture(name)
                validated = validate_fixture_document(doc, allowed_collections=collections)
                self.assertIs(validated, doc)
                self.assertEqual(validated["status"], PROPOSED_STATUS)
                self.assertIsInstance(validated["version"], int)
                self.assertGreaterEqual(validated["version"], 1)
                if "profiles" in validated:
                    profiles = validated["profiles"]
                    self.assertGreaterEqual(len(profiles), 3)
                    for profile in profiles:
                        total_profiles += 1
                        self.assertEqual(profile["status"], PROPOSED_STATUS)
                        total_proposed += 1
        # Non-vacuous: exactly the shipped 9 profiles, all proposed.
        self.assertEqual(total_profiles, 9)
        self.assertEqual(total_proposed, 9)

    def test_pronunciation_entries_shape(self):
        doc = load_fixture("pronunciation_protocol.json")
        self.assertEqual(len(doc["entries"]), 5)
        for entry in doc["entries"]:
            self.assertIs(entry["synthetic"], True)
            self.assertIsInstance(entry["name"], str)
            self.assertTrue(entry["name"])
            self.assertIsInstance(entry["role"], str)
            self.assertTrue(entry["role"])
        self.assertEqual(doc["protocol"]["rating_scale"], "MOS 1-5")
        self.assertEqual(doc["protocol"]["synthetic_only"], True)
        self.assertGreaterEqual(doc["protocol"]["raters_required"], 1)

    def test_wer_pairs_shape(self):
        doc = load_fixture("wer_pairs.json")
        self.assertEqual(len(doc["pairs"]), 5)
        for pair in doc["pairs"]:
            self.assertIn("id", pair)
            self.assertIn("reference", pair)
            self.assertIn("hypothesis", pair)


# ── wer_pairs fixture semantics ─────────────────────────────────────────


class TestWerPairsFixture(unittest.TestCase):
    def test_all_pairs_compute_without_raising(self):
        doc = load_fixture("wer_pairs.json")
        for pair in doc["pairs"]:
            with self.subTest(pair=pair["id"]):
                wer = word_error_rate(pair["reference"], pair["hypothesis"])
                self.assertGreaterEqual(wer, 0.0)

    def test_identical_pair_is_zero(self):
        pair = pair_by_id("identical")
        self.assertEqual(word_error_rate(pair["reference"], pair["hypothesis"]), 0.0)

    def test_empty_hypothesis_pair_is_one(self):
        pair = pair_by_id("empty_hypothesis")
        self.assertEqual(word_error_rate(pair["reference"], pair["hypothesis"]), 1.0)

    def test_normalization_pair_is_zero(self):
        pair = pair_by_id("normalization")
        self.assertEqual(word_error_rate(pair["reference"], pair["hypothesis"]), 0.0)

    def test_deletion_and_insertion_pairs_strictly_between(self):
        for pair_id in ("deletion", "insertion"):
            with self.subTest(pair=pair_id):
                pair = pair_by_id(pair_id)
                wer = word_error_rate(pair["reference"], pair["hypothesis"])
                self.assertGreater(wer, 0.0)
                self.assertLess(wer, 1.0)


# ── schema contract (config/voice-quality-harness.schema.json) ──────────


class TestSchemaContract(unittest.TestCase):
    def test_schema_parses_and_marks_proposed_contract(self):
        with open(SCHEMA_PATH, encoding="utf-8") as handle:
            schema = json.load(handle)
        self.assertEqual(schema.get("$schema"), "http://json-schema.org/draft-07/schema#")
        self.assertIn("oneOf", schema)
        definitions = schema["definitions"]
        for name in (
            "profileEnvelope",
            "fixtureDocument",
            "turnProfiles",
            "noiseProfiles",
            "networkProfiles",
            "pronunciationProtocol",
            "werPairs",
        ):
            self.assertIn(name, definitions)
        self.assertEqual(
            definitions["fixtureDocument"]["properties"]["status"], {"const": "proposed"}
        )
        self.assertEqual(
            definitions["profileEnvelope"]["properties"]["status"], {"const": "proposed"}
        )
        self.assertEqual(
            definitions["profileEnvelope"]["properties"]["version"],
            {"type": "integer", "minimum": 1},
        )


if __name__ == "__main__":
    unittest.main()
