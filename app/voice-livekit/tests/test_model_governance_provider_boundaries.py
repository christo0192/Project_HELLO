"""
Tests for model_governance/provider_boundaries.py — LLM-01 boundary inventory.

Mirrors the TypeScript test coverage in
app/api/src/__tests__/model-governance-provider-boundaries.test.ts.
Stdlib only; no network; no LiveKit SDK imports.
"""

import unittest
from typing import Any

from model_governance.provider_boundaries import (
    ALLOWED_BOUNDARY_KINDS,
    ALLOWED_POLICY_STATUSES,
    ALLOWED_PROVIDERS,
    ALLOWED_RUNTIMES,
    ALLOWED_WORKLOADS,
    MODEL_GOVERNANCE_SCHEMA_VERSION,
    PROVIDER_BOUNDARIES,
    validate_provider_boundaries,
)


def valid_entry(**overrides: Any) -> dict[str, Any]:
    """Return a valid base boundary entry."""
    entry: dict[str, Any] = {
        "id": "example-boundary",
        "workloads": ["screening"],
        "provider": "deepseek",
        "runtime": "api",
        "boundaryKind": "cli_spawn",
        "constructorPath": "app/api/src/lib/example.ts",
        "envVars": ["CLAUDE_MODEL"],
        "allowlists": [],
        "policyStatus": "PROPOSED",
    }
    entry.update(overrides)
    return entry


class TestShippedInventory(unittest.TestCase):
    """The shipped inventory is non-vacuous and truthful."""

    def test_inventory_is_non_empty_and_valid(self) -> None:
        self.assertGreater(len(PROVIDER_BOUNDARIES), 0)
        result = validate_provider_boundaries(PROVIDER_BOUNDARIES)
        self.assertTrue(result["valid"], result.get("error"))

    def test_covers_required_python_boundary_paths(self) -> None:
        paths = [entry["constructorPath"] for entry in PROVIDER_BOUNDARIES]
        for required in [
            "app/voice-livekit/agent.py",
            "app/voice-livekit/prompting.py",
            "app/voice-livekit/provenance.py",
            "app/voice-livekit/persistence.py",
        ]:
            self.assertIn(required, paths)

    def test_policy_statuses_are_repository_only(self) -> None:
        for entry in PROVIDER_BOUNDARIES:
            self.assertIn(entry["policyStatus"], ALLOWED_POLICY_STATUSES)
            self.assertNotIn("optionalEvidenceRefs", entry)

    def test_closed_enumerations_exported(self) -> None:
        self.assertIn("deepseek", ALLOWED_PROVIDERS)
        self.assertIn("gemini", ALLOWED_PROVIDERS)
        self.assertIn("screening", ALLOWED_WORKLOADS)
        self.assertIn("voice-livekit", ALLOWED_RUNTIMES)
        self.assertIn("sdk_constructor", ALLOWED_BOUNDARY_KINDS)
        self.assertEqual(MODEL_GOVERNANCE_SCHEMA_VERSION, 1)


class TestValidationHappyPaths(unittest.TestCase):
    def test_accepts_minimal_valid_entry(self) -> None:
        result = validate_provider_boundaries([valid_entry()])
        self.assertTrue(result["valid"], result.get("error"))
        self.assertEqual(len(result["data"]), 1)

    def test_accepts_pending_and_not_evaluated(self) -> None:
        for status in ("PENDING", "NOT_EVALUATED"):
            result = validate_provider_boundaries([valid_entry(policyStatus=status)])
            self.assertTrue(result["valid"], f"{status}: {result.get('error')}")

    def test_rejects_approval_claim_with_evidence(self) -> None:
        # HIGH-review regression: no external-evidence escape hatch — even an
        # EV-xxxx or UUID reference cannot authorize a positive approval claim.
        for ref in ("EV-FAKE", "4c8e6f2a-1b3d-4e9f-8a7c-0d5e6f7a8b9c"):
            result = validate_provider_boundaries(
                [valid_entry(policyStatus="APPROVED", optionalEvidenceRefs=[ref])]
            )
            self.assertFalse(result["valid"], f"must reject approval with ref {ref}")
            self.assertIn("no external evidence escape", result["error"])

    def test_rejects_non_list_input(self) -> None:
        result = validate_provider_boundaries({"not": "a list"})
        self.assertFalse(result["valid"])
        self.assertIn("non-empty array", result["error"])

    def test_rejects_empty_list(self) -> None:
        result = validate_provider_boundaries([])
        self.assertFalse(result["valid"])
        self.assertIn("must not be empty", result["error"])

    def test_rejects_unknown_fields(self) -> None:
        result = validate_provider_boundaries([valid_entry(malicious="extra")])
        self.assertFalse(result["valid"])
        self.assertIn("unknown field", result["error"])

    def test_rejects_allowlist_violation(self) -> None:
        result = validate_provider_boundaries([valid_entry(provider="openai")])
        self.assertFalse(result["valid"])
        self.assertIn("provider: not allowlisted", result["error"])


class TestNegativeControls(unittest.TestCase):
    """Lane A1 mandatory negative controls."""

    def test_rejects_url_lookalike_in_optional_field(self) -> None:
        cases = [
            valid_entry(notes="See https://example.invalid/evidence for details."),
            valid_entry(optionalEvidenceRefs=["https://example.invalid/evidence/123"]),
            valid_entry(notes="endpoint wss://rtc.example.invalid"),
        ]
        for entry in cases:
            result = validate_provider_boundaries([entry])
            self.assertFalse(result["valid"], f"must reject: {entry}")
            self.assertRegex(result["error"], r"URL")

    def test_rejects_token_lookalike_in_optional_field(self) -> None:
        cases = [
            valid_entry(notes="rotated sk-ant-test-abcdef1234567890 last month."),
            valid_entry(optionalEvidenceRefs=["sk-livekit-abcdef1234567890"]),
            valid_entry(notes="guard: api_key value never stored"),
        ]
        for entry in cases:
            result = validate_provider_boundaries([entry])
            self.assertFalse(result["valid"], f"must reject: {entry}")
            self.assertRegex(result["error"], r"credential")

    def test_rejects_approved_unconditionally(self) -> None:
        result = validate_provider_boundaries([valid_entry(policyStatus="APPROVED")])
        self.assertFalse(result["valid"])
        self.assertIn("no external evidence escape", result["error"])

    def test_rejects_deployed_accepted_winner_unconditionally(self) -> None:
        for claim in ("DEPLOYED", "ACCEPTED", "winner", "Winner"):
            result = validate_provider_boundaries(
                [valid_entry(policyStatus=claim, optionalEvidenceRefs=["EV-FAKE"])]
            )
            self.assertFalse(result["valid"], f"must reject claim: {claim}")
            self.assertIn("no external evidence escape", result["error"])

    def test_rejects_unsafe_repository_paths(self) -> None:
        for unsafe_path in ("/etc/passwd", "../outside/file.ts", "C:\\outside\\file.ts"):
            result = validate_provider_boundaries([valid_entry(constructorPath=unsafe_path)])
            self.assertFalse(result["valid"], f"must reject path: {unsafe_path}")

    def test_rejects_malformed_env_var_and_evidence_ref(self) -> None:
        bad_env = validate_provider_boundaries([valid_entry(envVars=["claude_model"])])
        self.assertFalse(bad_env["valid"])
        self.assertIn("envVars", bad_env["error"])

        bad_ref = validate_provider_boundaries(
            [valid_entry(optionalEvidenceRefs=["../outside-ref"])]
        )
        self.assertFalse(bad_ref["valid"])
        self.assertIn("evidence", bad_ref["error"])

    def test_truthful_prose_permitted(self) -> None:
        result = validate_provider_boundaries(
            [
                valid_entry(policyStatus="PROPOSED", notes="Pending owner verification."),
                valid_entry(id="second-entry", policyStatus="NOT_EVALUATED"),
            ]
        )
        self.assertTrue(result["valid"], result.get("error"))


if __name__ == "__main__":
    unittest.main()
