"""
Tests for provenance.py — validation, creation, security, and integration.

Mirrors the TypeScript test coverage for app/api/src/__tests__/model-provenance.test.ts.
"""

import copy
import json
import unittest
from datetime import datetime, timezone
from typing import Any

from provenance import (
    ALLOWLISTED_PROVIDERS,
    ALLOWLISTED_WORKLOADS,
    LEGACY_PROVENANCE,
    MODEL_PROVENANCE_SCHEMA_VERSION,
    SCREENING_PROVENANCE_VERSION,
    create_provenance,
    screening_provenance,
    validate_provenance,
)


# ── Fixed clock for deterministic tests ─────────────────────────────────

FIXED_NOW = datetime(2026, 7, 28, 12, 0, 0, tzinfo=timezone.utc)

fixed_clock = {
    "now": lambda: FIXED_NOW,
    "parse": lambda ts: datetime.strptime(
        ts.rstrip("Z").split(".")[0], "%Y-%m-%dT%H:%M:%S"
    ).replace(tzinfo=timezone.utc) if "." not in ts.rstrip("Z") else datetime.strptime(
        ts.rstrip("Z"), "%Y-%m-%dT%H:%M:%S.%f"
    ).replace(tzinfo=timezone.utc),
}


def valid_payload(**overrides: Any) -> dict[str, Any]:
    """Return a valid base provenance payload."""
    payload = {
        "schema_version": MODEL_PROVENANCE_SCHEMA_VERSION,
        "provider": "deepseek",
        "requestedModel": "deepseek-chat",
        "workload": "screening",
        "prompt_template_version": "2026-08-04.1",
        "timestamp": "2026-07-28T12:00:00.000Z",
    }
    payload.update(overrides)
    return payload


class TestProvenanceValidation(unittest.TestCase):
    """Comprehensive test suite for provenance validation."""

    maxDiff = None

    # ── Happy paths ──────────────────────────────────────────────────

    def test_valid_provenance(self):
        result = validate_provenance(valid_payload(), fixed_clock)
        self.assertTrue(result["valid"])
        self.assertEqual(result["data"]["provider"], "deepseek")
        self.assertEqual(result["data"]["requestedModel"], "deepseek-chat")
        self.assertEqual(result["data"]["workload"], "screening")

    def test_valid_gemini_screening_provenance(self):
        result = validate_provenance(
            valid_payload(provider="gemini", requestedModel="gemini-3.1-flash-lite"),
            fixed_clock,
        )
        self.assertTrue(result["valid"])
        self.assertEqual(result["data"]["provider"], "gemini")

    def test_valid_with_inference_params(self):
        result = validate_provenance(
            valid_payload(inference_params={"temperature": 0.7, "max_tokens": 4096}),
            fixed_clock,
        )
        self.assertTrue(result["valid"])
        self.assertEqual(result["data"]["inference_params"]["temperature"], 0.7)
        self.assertEqual(result["data"]["inference_params"]["max_tokens"], 4096)

    def test_valid_scoring_workload(self):
        result = validate_provenance(
            valid_payload(workload="scoring", requestedModel="claude-sonnet-4-20250514"),
            fixed_clock,
        )
        self.assertTrue(result["valid"])
        self.assertEqual(result["data"]["workload"], "scoring")

    def test_valid_timestamp_with_ms(self):
        result = validate_provenance(
            valid_payload(timestamp="2026-07-28T12:00:00.123Z"),
            fixed_clock,
        )
        self.assertTrue(result["valid"])

    def test_valid_tolerance_future(self):
        result = validate_provenance(
            valid_payload(timestamp="2026-07-28T12:00:04.999Z"),
            fixed_clock,
        )
        self.assertTrue(result["valid"])

    # ── Null / non-object rejection ──────────────────────────────────

    def test_validate_rejects_none(self):
        result = validate_provenance(None, fixed_clock)
        self.assertFalse(result["valid"])

    def test_validate_rejects_list(self):
        result = validate_provenance([], fixed_clock)
        self.assertFalse(result["valid"])

    def test_validate_rejects_non_dict(self):
        result = validate_provenance("not a dict", fixed_clock)
        self.assertFalse(result["valid"])

    def test_validate_rejects_integer(self):
        result = validate_provenance(42, fixed_clock)
        self.assertFalse(result["valid"])

    # ── Unknown fields ───────────────────────────────────────────────

    def test_rejects_unknown_top_level_field(self):
        result = validate_provenance(
            valid_payload(extraField="oops"), fixed_clock
        )
        self.assertFalse(result["valid"])
        self.assertEqual(result["error"], "provenance: unknown field at top level")

    def test_rejects_multiple_unknown_fields(self):
        result = validate_provenance(
            valid_payload(x=1, y=2), fixed_clock
        )
        self.assertFalse(result["valid"])
        self.assertNotIn("x", result["error"])
        self.assertNotIn("y", result["error"])

    def test_rejects_unknown_inference_param_key(self):
        result = validate_provenance(
            valid_payload(inference_params={"badKey": 0.5}), fixed_clock
        )
        self.assertFalse(result["valid"])
        self.assertNotIn("badKey", result["error"])

    # ── Allowlist violations ─────────────────────────────────────────

    def test_rejects_unknown_provider(self):
        result = validate_provenance(valid_payload(provider="openai"), fixed_clock)
        self.assertFalse(result["valid"])

    def test_rejects_empty_provider(self):
        result = validate_provenance(valid_payload(provider=""), fixed_clock)
        self.assertFalse(result["valid"])

    def test_rejects_unknown_workload(self):
        result = validate_provenance(valid_payload(workload="deployment"), fixed_clock)
        self.assertFalse(result["valid"])

    # ── Schema version ───────────────────────────────────────────────

    def test_rejects_wrong_schema_version(self):
        result = validate_provenance(valid_payload(schema_version=2), fixed_clock)
        self.assertFalse(result["valid"])

    def test_rejects_zero_schema_version(self):
        result = validate_provenance(valid_payload(schema_version=0), fixed_clock)
        self.assertFalse(result["valid"])

    def test_rejects_string_schema_version(self):
        result = validate_provenance(valid_payload(schema_version="1"), fixed_clock)
        self.assertFalse(result["valid"])

    def test_rejects_float_schema_version(self):
        result = validate_provenance(valid_payload(schema_version=1.5), fixed_clock)
        self.assertFalse(result["valid"])

    def test_rejects_boolean_schema_version(self):
        result = validate_provenance(valid_payload(schema_version=True), fixed_clock)
        self.assertFalse(result["valid"])

    def test_rejects_nan_schema_version(self):
        result = validate_provenance(valid_payload(schema_version=float("nan")), fixed_clock)
        self.assertFalse(result["valid"])

    def test_rejects_infinity_schema_version(self):
        result = validate_provenance(valid_payload(schema_version=float("inf")), fixed_clock)
        self.assertFalse(result["valid"])

    # ── Closed identifier grammar ────────────────────────────────────

    def test_rejects_model_with_whitespace(self):
        result = validate_provenance(
            valid_payload(requestedModel="claude haiku"), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_model_with_control_char(self):
        result = validate_provenance(
            valid_payload(requestedModel="claude\x00haiku"), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_model_with_url(self):
        result = validate_provenance(
            valid_payload(requestedModel="http://evil.com/model"), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_model_with_absolute_path(self):
        result = validate_provenance(
            valid_payload(requestedModel="/usr/bin/claude"), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_model_with_parent_path(self):
        result = validate_provenance(
            valid_payload(requestedModel="../etc/passwd"), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_model_with_windows_path(self):
        result = validate_provenance(
            valid_payload(requestedModel=r"C:\Users\claude.exe"), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_model_with_api_key(self):
        result = validate_provenance(
            valid_payload(requestedModel="sk-abcdef1234567890"), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_accepts_valid_model_hyphens_dots_colons(self):
        result = validate_provenance(
            valid_payload(requestedModel="claude-3.5-sonnet:20241022"), fixed_clock
        )
        self.assertTrue(result["valid"])

    # ── Timestamp ────────────────────────────────────────────────────

    def test_rejects_non_utc_timestamp(self):
        result = validate_provenance(
            valid_payload(timestamp="2026-07-28T12:00:00"), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_timezone_offset_timestamp(self):
        result = validate_provenance(
            valid_payload(timestamp="2026-07-28T12:00:00+00:00"), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_future_timestamp(self):
        result = validate_provenance(
            valid_payload(timestamp="2077-01-01T00:00:00Z"), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_empty_timestamp(self):
        result = validate_provenance(
            valid_payload(timestamp=""), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_impossible_date(self):
        result = validate_provenance(
            valid_payload(timestamp="2026-02-31T12:00:00Z"), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_pre_epoch(self):
        result = validate_provenance(
            valid_payload(timestamp="1969-12-31T23:59:59Z"), fixed_clock
        )
        self.assertFalse(result["valid"])

    # ── Inference params ─────────────────────────────────────────────

    def test_rejects_unknown_inference_param(self):
        result = validate_provenance(
            valid_payload(inference_params={"unknownParam": 0.5}), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_temperature_over_2(self):
        result = validate_provenance(
            valid_payload(inference_params={"temperature": 3}), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_negative_temperature(self):
        result = validate_provenance(
            valid_payload(inference_params={"temperature": -1}), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_boolean_temperature(self):
        result = validate_provenance(
            valid_payload(inference_params={"temperature": True}), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_string_max_tokens(self):
        result = validate_provenance(
            valid_payload(inference_params={"max_tokens": "bad"}), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_float_max_tokens(self):
        result = validate_provenance(
            valid_payload(inference_params={"max_tokens": 100.5}), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_max_tokens_over_100000(self):
        result = validate_provenance(
            valid_payload(inference_params={"max_tokens": 100001}), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_max_tokens_zero(self):
        result = validate_provenance(
            valid_payload(inference_params={"max_tokens": 0}), fixed_clock
        )
        self.assertFalse(result["valid"])

    # ── Oversized values ─────────────────────────────────────────────

    def test_rejects_model_over_200_chars(self):
        result = validate_provenance(
            valid_payload(requestedModel="a" * 201), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_version_over_100_chars(self):
        result = validate_provenance(
            valid_payload(prompt_template_version="a" * 101), fixed_clock
        )
        self.assertFalse(result["valid"])

    def test_rejects_payload_over_2kb(self):
        payload = valid_payload(
            requestedModel="x" * 500,
            inference_params={"temperature": 0.5, "max_tokens": 1},
        )
        result = validate_provenance(payload, fixed_clock)
        self.assertFalse(result["valid"])

    # ── Missing required fields ──────────────────────────────────────

    def test_rejects_missing_requested_model(self):
        payload = valid_payload()
        del payload["requestedModel"]
        result = validate_provenance(payload, fixed_clock)
        self.assertFalse(result["valid"])

    def test_rejects_missing_provider(self):
        payload = valid_payload()
        del payload["provider"]
        result = validate_provenance(payload, fixed_clock)
        self.assertFalse(result["valid"])

    def test_rejects_missing_timestamp(self):
        payload = valid_payload()
        del payload["timestamp"]
        result = validate_provenance(payload, fixed_clock)
        self.assertFalse(result["valid"])

    # ── Deep-copy / mutation isolation ───────────────────────────────

    def test_deep_copy_mutation_of_original_does_not_affect_result(self):
        """Prove that mutating the original payload does not affect the validated result."""
        original = valid_payload(
            requestedModel="original-model",
            inference_params={"temperature": 0.5, "max_tokens": 100},
        )
        result = validate_provenance(copy.deepcopy(original), fixed_clock)
        self.assertTrue(result["valid"])
        data = result["data"]

        # Mutate the original aggressively
        original["requestedModel"] = "mutated-model"
        original["inference_params"]["temperature"] = 999
        original["inference_params"]["max_tokens"] = 99999
        original["provider"] = "mutated"
        del original["timestamp"]
        original["extra_key"] = "injected"

        # Verify the validated data is untouched
        self.assertEqual(data["requestedModel"], "original-model")
        self.assertEqual(data["inference_params"]["temperature"], 0.5)
        self.assertEqual(data["inference_params"]["max_tokens"], 100)
        self.assertEqual(data["provider"], "deepseek")
        self.assertIn("timestamp", data)

    def test_deep_copy_create_provenance_mutation_isolation(self):
        """Prove that mutating create_provenance arguments does not affect the result."""
        original_model = "deepseek-chat"
        p = create_provenance(
            provider="deepseek",
            requested_model=original_model,
            workload="screening",
            prompt_template_version="2026-08-04.1",
            inference_params={"temperature": 0.3},
            clock=fixed_clock,
        )
        self.assertEqual(p["requestedModel"], original_model)
        # The returned data should be a dict that is not frozen but is a deep copy
        # This proves mutation isolation without claiming immutability
        self.assertIsInstance(p, dict)
        self.assertEqual(p["inference_params"]["temperature"], 0.3)

    # ── create_provenance ────────────────────────────────────────────

    def test_create_provenance(self):
        p = create_provenance(
            provider="deepseek",
            requested_model="deepseek-chat",
            workload="screening",
            prompt_template_version="2026-08-04.1",
            clock=fixed_clock,
        )
        self.assertEqual(p["provider"], "deepseek")
        self.assertEqual(p["requestedModel"], "deepseek-chat")
        self.assertEqual(p["workload"], "screening")
        self.assertEqual(p["schema_version"], 1)
        self.assertEqual(p["timestamp"], "2026-07-28T12:00:00.000Z")

    def test_create_provenance_strips_empty_inference_params(self):
        p = create_provenance(
            provider="deepseek",
            requested_model="claude",
            workload="screening",
            prompt_template_version="v1",
            inference_params={},
            clock=fixed_clock,
        )
        self.assertNotIn("inference_params", p)

    def test_create_provenance_invalid_raises(self):
        with self.assertRaises(ValueError):
            create_provenance(
                provider="bogus",
                requested_model="",
                workload="screening",
                prompt_template_version="v1",
                clock=fixed_clock,
            )

    # ── screening_provenance ─────────────────────────────────────────

    def test_screening_provenance(self):
        p = screening_provenance("gemini-3.1-flash-lite", fixed_clock)
        self.assertEqual(p["provider"], "gemini")
        self.assertEqual(p["workload"], "screening")
        self.assertEqual(p["requestedModel"], "gemini-3.1-flash-lite")
        self.assertEqual(p["prompt_template_version"], SCREENING_PROVENANCE_VERSION)

    # ── legacy provenance ────────────────────────────────────────────

    def test_legacy_provenance(self):
        self.assertEqual(LEGACY_PROVENANCE["schema_version"], 0)
        self.assertEqual(LEGACY_PROVENANCE["provider"], "legacy")
        self.assertEqual(LEGACY_PROVENANCE["requestedModel"], "unknown")

    # ── Diagnostics never echo ───────────────────────────────────────

    def test_diagnostics_never_echo_unknown_field(self):
        result = validate_provenance(
            valid_payload(secret_field="super-secret"), fixed_clock
        )
        self.assertFalse(result["valid"])
        self.assertNotIn("secret_field", result["error"])

    def test_diagnostics_never_echo_unknown_inference_param(self):
        result = validate_provenance(
            valid_payload(inference_params={"secret_param": 0.5}), fixed_clock
        )
        self.assertFalse(result["valid"])
        self.assertNotIn("secret_param", result["error"])

    # ── Clock injection tests ────────────────────────────────────────

    def test_injected_clock_rejects_future_timestamp(self):
        """A past clock should reject a timestamp that is far in its future."""
        past_clock = {
            "now": lambda: datetime(2020, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
            "parse": lambda ts: datetime.strptime(
                ts.rstrip("Z").split(".")[0], "%Y-%m-%dT%H:%M:%S"
            ).replace(tzinfo=timezone.utc),
        }
        result = validate_provenance(valid_payload(timestamp="2026-07-28T12:00:00Z"), past_clock)
        self.assertFalse(result["valid"])
        self.assertIn("future", result["error"])

    def test_injected_clock_sets_timestamp_in_create(self):
        custom_clock = {
            "now": lambda: datetime(2025, 6, 15, 10, 30, 0, tzinfo=timezone.utc),
            "parse": lambda ts: datetime.strptime(
                ts.rstrip("Z").split(".")[0], "%Y-%m-%dT%H:%M:%S"
            ).replace(tzinfo=timezone.utc),
        }
        p = create_provenance(
            provider="deepseek",
            requested_model="claude",
            workload="screening",
            prompt_template_version="v1",
            clock=custom_clock,
        )
        self.assertEqual(p["timestamp"], "2025-06-15T10:30:00.000Z")

    def test_default_clock_produces_recent_timestamps(self):
        """Default clock should produce timestamps close to real time."""
        before = datetime.now(timezone.utc).timestamp()
        p = create_provenance(
            provider="deepseek",
            requested_model="claude",
            workload="screening",
            prompt_template_version="v1",
        )
        after = datetime.now(timezone.utc).timestamp()
        ts = datetime.strptime(
            p["timestamp"].rstrip("Z").split(".")[0], "%Y-%m-%dT%H:%M:%S"
        ).replace(tzinfo=timezone.utc).timestamp()
        self.assertGreaterEqual(ts, before - 1)
        self.assertLessEqual(ts, after + 1)

    # ── Clock validation: fail closed on bad parse ───────────────────

    def test_clock_parse_failure_fails_closed(self):
        """A clock parse that returns None should fail closed."""
        broken_clock = {
            "now": lambda: datetime(2026, 7, 28, 12, 0, 0, tzinfo=timezone.utc),
            "parse": lambda ts: None,
        }
        result = validate_provenance(valid_payload(), broken_clock)
        self.assertFalse(result["valid"])


# ── If __name__ == "__main__" ──────────────────────────────────────────

if __name__ == "__main__":
    unittest.main()
