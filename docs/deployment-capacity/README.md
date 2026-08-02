# Deployment & Capacity Foundations (PR-B — DEP-01..07)

Repository-only foundations for the Phase 11 deployment & capacity gates.
Nothing in this directory claims provisioned capacity, high availability,
failover, deployment, acceptance, promotion, signing, or SLSA above 0. Every
policy state is `PROPOSED` or `PENDING`, and every evidence type is
`synthetic_local`.

## Scope

| Gate | Deliverable | State |
|------|-------------|-------|
| DEP-01 | Deterministic `synthetic_local` capacity benchmark CLI + schemas | Foundation only — no real measurement, no pass budget |
| DEP-02 | Managed topology manifest with failure domains and scale triggers | `PROPOSED` — nothing provisioned |
| DEP-03 | HA decision evidence template with explicit single-instance risk | Template only — approval `PENDING` |
| DEP-04 | Provider-neutral deployment contract manifest (env NAMES only, runtime secret source, no `.tf`) | `PROPOSED` — every service `NOT_DEPLOYED` |
| DEP-05 | Staging/prod structural parity manifest (scale-only differences) | `PROPOSED` — `parityStatus: PENDING`, `parityAchieved: false` |
| DEP-06 | Deterministic canary/blue-green release state machine + rollback compatibility | `PROPOSED` — example record stays `prepared` |
| DEP-07 | Offline artifact provenance manifest/validator (commit/lockfile/SBOM/test-evidence placeholders) | `PROPOSED` — SLSA 0, unsigned |

Lane B1 (DEP-01/02/03) is documented below; lane B2 (DEP-04..07) is documented
in `docs/deployment-capacity/contracts.md` and the DEP-04/05/06/07 runbooks
(`docs/runbooks/deployment-capacity-contracts.md`,
`docs/runbooks/deployment-capacity-parity.md`,
`docs/runbooks/canary-rollback.md`,
`docs/runbooks/deployment-capacity-provenance.md`).

## Repository layout

| Path | Purpose |
|------|---------|
| `infra/capacity/benchmark.schema.json` | Input config schema (concurrency, duration, warmup, headroom, cost-unit) |
| `infra/capacity/benchmark-report.schema.json` | Machine report schema (`synthetic_local`, `PROPOSED`/`PENDING` only) |
| `infra/capacity/managed-topology.schema.json` | Topology manifest schema (every scale trigger needs a metric **and** a source) |
| `infra/capacity/managed-topology.manifest.json` | ADR-0010 topology manifest — 7 components, all `PENDING` |
| `infra/capacity/ha-decision.example.json` | Synthetic example of the DEP-03 evidence template |
| `config/deployment-capacity-ha.schema.json` | HA decision evidence template schema |
| `scripts/capacity-benchmark-run` | Standard-library CLI (self-test / fixture / run / validators) |
| `scripts/check-deployment-capacity-status.mjs` | PR-B status-field validator (positive claims rejected) |
| `scripts/check-deployment-capacity-status.test.mjs` | Negative controls for the validator and CLI |
| `scripts/validate-deployment-contracts` | DEP-04/05 contract + parity validator (repo mode + `--fixtures`) |
| `scripts/validate-deployment-release` | DEP-06 state machine + rollback validator (`--fixtures`) |
| `scripts/artifact-provenance-validate` | DEP-07 provenance validator (repo mode + `--fixtures`) |
| `docs/runbooks/deployment-capacity-benchmark.md` | Benchmark runbook |
| `docs/runbooks/deployment-capacity-ha-decision.md` | HA decision runbook |
| `docs/runbooks/deployment-capacity-contracts.md` | DEP-04 contract runbook |
| `docs/runbooks/deployment-capacity-parity.md` | DEP-05 parity runbook |
| `docs/runbooks/canary-rollback.md` | DEP-06 release state machine runbook |
| `docs/runbooks/deployment-capacity-provenance.md` | DEP-07 provenance runbook |

## Policy state model

Allowed states in every Phase 11 repository artifact:

- `PROPOSED` — a proposal exists; nothing is implemented or measured.
- `PENDING` — an item awaits owner/SRE verification or input.
- `synthetic_local` — evidence type for the benchmark harness; real targets are
  owner-operated outside CI and never run here.

Forbidden states (rejected by the status validator): `APPROVED`, `DEPLOYED`,
`ACCEPTED`, `WINNER`, `SIGNED`, `slsa_level > 0`, `signed: true`, and any
positive capacity/HA claim, unless backed by an authentic external evidence
identifier (which never exists in repository-only work).

## Validators

```bash
# Deterministic offline self-test + fixture
node scripts/capacity-benchmark-run self-test
node scripts/capacity-benchmark-run fixture --scenario synthetic-local --output json >/tmp/capacity-fixture.json
node scripts/capacity-benchmark-run schema-validate /tmp/capacity-fixture.json

# Structural validators (negative controls included in the test suite)
node scripts/capacity-benchmark-run config-validate <config.json>
node scripts/capacity-benchmark-run ha-validate <ha-decision.json>
node scripts/capacity-benchmark-run topology-validate <topology-manifest.json>

# Status-field validator across PR-B artifact paths
node scripts/check-deployment-capacity-status.mjs
node scripts/check-deployment-capacity-status.test.mjs

# Lane B2 (DEP-04..07) validators
node scripts/validate-deployment-contracts
node scripts/validate-deployment-contracts --fixtures
node scripts/validate-deployment-release --fixtures
node scripts/artifact-provenance-validate validate infra/deployment-contracts/provenance-manifest.json
node scripts/artifact-provenance-validate --fixtures
node scripts/validate-deployment-schema-drift   # schema-contract drift (all Phase 11 schemas)
```

## What this does NOT prove

- No real latency, capacity, failover, or cost measurement exists.
- No arbitrary pass budget or acceptance threshold exists.
- No provider, cloud, or network target is exercised by any script here.
- No component is provisioned, deployed, or live.
- Live benchmark targets are owner-operated and are never part of CI.
