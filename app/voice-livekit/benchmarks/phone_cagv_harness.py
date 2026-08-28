"""Offline-first CAGV feasibility harness.

This module deliberately does not originate PSTN calls or contact production
services. ``--verify`` exercises the safety fixtures locally. ``--measure``
accepts privacy-safe JSONL samples produced by an explicitly configured
non-production runner; it never accepts transcripts, identifiers, room names,
provider payloads, or secrets.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

P95_INDEX = 0.95
MAX_SAMPLES = 10_000
ALLOWED_METRICS = frozenset({
    "warm_gemini_ttft_ms", "interim_coverage", "speculative_remainder_ms",
    "tool_rtt_ms", "post_tool_ttft_ms", "candidate_to_first_audio_ms",
    "one_question", "intra_reply_gap_ms", "participant_to_disclosure_ms",
    "boundary_rtt_ms", "consent_start_rtt_ms", "egress_start_ms",
    "event_loop_lag_ms", "cpu_phase_percent", "egress_failed",
})


def percentile(values: list[float], quantile: float = P95_INDEX) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("metric must be numeric")
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError("metric must be finite and non-negative")
    return result


def load_samples(path: str | Path) -> list[dict[str, Any]]:
    """Load only the allowlisted scalar metric envelope from JSONL."""
    samples: list[dict[str, Any]] = []
    with open(path, encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            if len(line) > 8_000:
                raise ValueError(f"sample line {line_number} is too large")
            raw = json.loads(line)
            if not isinstance(raw, dict):
                raise ValueError(f"sample line {line_number} is not an object")
            unknown = set(raw) - ALLOWED_METRICS
            if unknown:
                raise ValueError(f"sample line {line_number} contains unknown metrics")
            clean: dict[str, Any] = {}
            for key, value in raw.items():
                if key == "one_question":
                    if not isinstance(value, bool):
                        raise ValueError(f"sample line {line_number} one_question is not boolean")
                    clean[key] = value
                elif key == "egress_failed":
                    if not isinstance(value, bool):
                        raise ValueError(f"sample line {line_number} egress_failed is not boolean")
                    clean[key] = value
                else:
                    clean[key] = _number(value)
            samples.append(clean)
            if len(samples) > MAX_SAMPLES:
                raise ValueError("too many samples")
    return samples


def summarize(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Return privacy-safe p50/p95/p99 summaries; missing values stay missing."""
    output: dict[str, Any] = {"sample_count": len(samples), "metrics": {}}
    for key in sorted(ALLOWED_METRICS):
        values = [float(sample[key]) for sample in samples if key in sample and isinstance(sample[key], (int, float))]
        if values:
            output["metrics"][key] = {
                "count": len(values),
                "p50": round(percentile(values, 0.50) or 0, 3),
                "p95": round(percentile(values, 0.95) or 0, 3),
                "p99": round(percentile(values, 0.99) or 0, 3),
            }
    boolean_keys = {"one_question", "egress_failed"}
    for key in sorted(boolean_keys):
        values = [sample[key] for sample in samples if key in sample]
        if values:
            output["metrics"][key] = {
                "count": len(values),
                "true_rate": round(sum(values) / len(values), 6),
            }
    return output


class DurableProbe:
    """Small in-memory model of the server max-one/idempotent probe contract."""

    def __init__(self) -> None:
        self.count = 0
        self.events: set[str] = set()

    def request(self, source_event_id: str) -> str:
        if source_event_id in self.events:
            return "duplicate"
        self.events.add(source_event_id)
        if self.count >= 1:
            return "probe_denied"
        self.count += 1
        return "probe_recorded"


class DurableAdvance:
    """CAS model used by the offline exactly-once fixture."""

    def __init__(self, cursor: int = 0) -> None:
        self.cursor = cursor
        self.events: set[str] = set()

    def advance(self, expected: int, source_event_id: str) -> str:
        if source_event_id in self.events:
            return "duplicate"
        if expected != self.cursor:
            return "stale_cursor"
        self.events.add(source_event_id)
        self.cursor += 1
        return "advanced"


def coordinator_policy(leg_state: str, route: str | None = None) -> dict[str, Any]:
    """Derive policy before final-turn routing exists, without model input."""
    if leg_state == "pre_consent":
        return {"tool_choice": "none", "allowed_tools": (), "audible": False}
    if route in {"clarification", "hesitation", "connectivity"}:
        return {"tool_choice": "none", "allowed_tools": (), "audible": True}
    if route == "callback":
        return {"tool_choice": "auto", "allowed_tools": ("schedule_callback",), "audible": True}
    if leg_state == "active_screening":
        return {
            "tool_choice": "required",
            "allowed_tools": ("request_probe", "advance_screening"),
            "audible": False,
        }
    return {"tool_choice": "none", "allowed_tools": (), "audible": False}


def verify_fixtures() -> dict[str, Any]:
    """Run deterministic hard-stop fixtures without a provider or network."""
    checks: dict[str, bool] = {}
    pre = coordinator_policy("pre_consent")
    active = coordinator_policy("active_screening")
    checks["pre_consent_no_tools_or_audio"] = pre == {
        "tool_choice": "none", "allowed_tools": (), "audible": False,
    }
    checks["active_screening_required_tools"] = active["tool_choice"] == "required" and set(active["allowed_tools"]) == {"request_probe", "advance_screening"} and not active["audible"]
    probe = DurableProbe()
    checks["probe_exactly_once"] = probe.request("evt") == "probe_recorded" and probe.request("evt") == "duplicate" and probe.request("evt-2") == "probe_denied" and probe.count == 1
    advance = DurableAdvance()
    checks["advance_exactly_once_and_cas"] = advance.advance(0, "evt") == "advanced" and advance.advance(0, "evt") == "duplicate" and advance.advance(0, "evt-2") == "stale_cursor" and advance.cursor == 1
    checks["no_pre_tool_audio_contract"] = not active["audible"]
    return {
        "mode": "offline_verify",
        "network": False,
        "production": False,
        "checks": checks,
        "pass": all(checks.values()),
        "live_measurements": "unavailable_without_explicit_non_production_runner",
    }


def _print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--measure", metavar="JSONL")
    args = parser.parse_args(argv)
    if bool(args.verify) == bool(args.measure):
        parser.error("choose exactly one of --verify or --measure")
    if args.verify:
        result = verify_fixtures()
    else:
        result = {"mode": "offline_samples", "network": False, "production": False, **summarize(load_samples(args.measure))}
    _print_json(result)
    return 0 if result.get("pass", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
