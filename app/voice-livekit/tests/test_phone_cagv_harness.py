from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from benchmarks.phone_cagv_harness import (
    DurableAdvance,
    DurableProbe,
    coordinator_policy,
    load_samples,
    summarize,
    verify_fixtures,
)


class TestCagvHarness(unittest.TestCase):
    def test_offline_hard_stop_fixtures_pass(self):
        result = verify_fixtures()
        self.assertTrue(result["pass"])
        self.assertFalse(result["network"])
        self.assertFalse(result["production"])
        self.assertEqual(result["live_measurements"], "unavailable_without_explicit_non_production_runner")

    def test_policy_is_derived_from_leg_state(self):
        self.assertEqual(coordinator_policy("pre_consent")["allowed_tools"], ())
        self.assertEqual(coordinator_policy("active_screening")["tool_choice"], "required")
        self.assertEqual(coordinator_policy("active_screening")["allowed_tools"], ("request_probe", "advance_screening"))
        self.assertEqual(coordinator_policy("active_screening", "clarification")["allowed_tools"], ())

    def test_probe_is_max_one_and_idempotent(self):
        probe = DurableProbe()
        self.assertEqual(probe.request("a"), "probe_recorded")
        self.assertEqual(probe.request("a"), "duplicate")
        self.assertEqual(probe.request("b"), "probe_denied")
        self.assertEqual(probe.count, 1)

    def test_advance_is_cas_and_idempotent(self):
        advance = DurableAdvance()
        self.assertEqual(advance.advance(0, "a"), "advanced")
        self.assertEqual(advance.advance(0, "a"), "duplicate")
        self.assertEqual(advance.advance(0, "b"), "stale_cursor")
        self.assertEqual(advance.cursor, 1)

    def test_sample_loader_rejects_unknown_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "samples.jsonl"
            path.write_text(json.dumps({"secret": 1}) + "\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_samples(path)

    def test_summary_keeps_missing_metrics_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "samples.jsonl"
            path.write_text(
                json.dumps({"warm_gemini_ttft_ms": 100, "one_question": True}) + "\n",
                encoding="utf-8",
            )
            result = summarize(load_samples(path))
            self.assertEqual(result["metrics"]["warm_gemini_ttft_ms"]["p95"], 100.0)
            self.assertNotIn("tool_rtt_ms", result["metrics"])
            self.assertEqual(result["metrics"]["one_question"]["true_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()
