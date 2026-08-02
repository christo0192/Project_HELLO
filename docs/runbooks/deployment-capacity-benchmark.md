# DEP-01 Capacity Benchmark Runbook (synthetic_local)

The DEP-01 foundation is a deterministic, offline benchmark harness for the
screening platform's synthetic session lifecycle (API latency model, worker
pool utilization, session arrivals, queue depth, saturation events). It exists
so the repository can exercise benchmark mechanics before the owner provisions
any real target.

**Truth boundary:** everything this harness produces is `synthetic_local`. No
real measurement, no provider endpoint, no capacity conclusion, and no pass
budget exist. Live targets are owner-operated outside CI and are never listed
in repository files.

## Files

- `infra/capacity/benchmark.schema.json` — input configuration schema
- `infra/capacity/benchmark-report.schema.json` — machine report schema
- `scripts/capacity-benchmark-run` — the CLI (Node.js, standard library only)

## Commands

```bash
# 1. Deterministic self-test (39 checks; stats, determinism, non-vacuity,
#    schema invariants, and all negative controls)
node scripts/capacity-benchmark-run self-test

# 2. Synthetic fixture report (deterministic, seed default 42)
node scripts/capacity-benchmark-run fixture --scenario synthetic-local --output json >/tmp/capacity-fixture.json
node scripts/capacity-benchmark-run fixture --scenario synthetic-local --output json --seed 7

# 3. Run a custom synthetic config
node scripts/capacity-benchmark-run run --config infra/capacity/config.example.json --output json

# 4. Validate inputs and reports
node scripts/capacity-benchmark-run config-validate <config.json>
node scripts/capacity-benchmark-run schema-validate <report.json>
```

## Configuration inputs

| Input | Meaning |
|-------|---------|
| `concurrency` | Target concurrent session count to simulate (1..1000) |
| `durationSeconds` | Measurement window after warmup (1..86400) |
| `warmupSeconds` | Warmup window; warmup observations are excluded (0..3600) |
| `headroomPercent` | SRE-input placeholder; stored, never applied (0..200) |
| `costUnit` | Unit definition (label + ISO currency + `pricingStatus: PENDING`). A definition only, never a price |

Example config shape:

```json
{
  "schemaVersion": "1.0.0",
  "scenario": "synthetic-local",
  "concurrency": 50,
  "durationSeconds": 120,
  "warmupSeconds": 10,
  "headroomPercent": 50,
  "costUnit": { "label": "per concurrent session-hour", "currency": "USD", "pricingStatus": "PENDING" }
}
```

## Report invariants (enforced by the schema and the CLI)

- `evidence.evidenceType` is always `synthetic_local`.
- `policy.state` is always `PROPOSED` or `PENDING`; `approvalStatus` is always
  `PENDING`; `capacityApproved` is always `false`.
- `summary.status` is always `SYNTHETIC_LOCAL`; `claims` is always `none`.
- A report claiming `capacityApproved: true`, a `DEPLOYED` policy state, or a
  `COMPLETED`-style real-run status is rejected.

## Exit codes

- `0` — validation passed / command succeeded.
- `1` — invalid input, schema violation, secret-like content, or self-test
  failure.

## Owner path to real measurement

1. Owner provisions a provider target (no repository action provisions it).
2. Owner supplies a target definition in a local, non-committed config.
3. The report is reviewed by owner/SRE; policy states may move to `PROPOSED`
   thresholds only after that review. No repository artifact may claim
   acceptance.

## What this runbook does NOT authorize

- No provider login, card, purchase, apply, or production action.
- No free-tier or vendor pricing claim.
- No conclusion about safe concurrency, latency, failover, or cost.
