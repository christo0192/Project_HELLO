# Deployment Contracts, Parity, Release State Machine & Provenance (PR-B, Lane B2 — DEP-04..07)

Repository-only foundations for the Phase 11 deployment gates owned by lane B2.
Nothing in this lane claims a deployment, a promotion, a canary result, a
rollback, a signature, an SLSA level above 0, or any parity achieved: every
policy state is `PROPOSED` or `PENDING`, every evidence type is
`synthetic_local`, and every approval is PENDING owner verification.

## Scope of this lane

| Gate | Deliverable | State |
|------|-------------|-------|
| DEP-04 | Provider-neutral deployment contract manifest (env var NAMES only, runtime secret source, no `.tf`) | `PROPOSED` — every service `NOT_DEPLOYED` |
| DEP-05 | Staging/prod structural parity manifest (scale-only differences allowed) | `PROPOSED` — `parityStatus: PENDING`, `parityAchieved: false` |
| DEP-06 | Deterministic canary/blue-green release state machine + rollback compatibility checker | `PROPOSED` — example record stays `prepared` |
| DEP-07 | Offline artifact provenance manifest/validator (commit/lockfile/SBOM/test-evidence placeholders) | `PROPOSED` — SLSA 0, unsigned, `generatedAt: PENDING` |

Lane B1 (DEP-01/02/03 capacity, topology, HA) is owned separately in the same
PR and documented in `docs/deployment-capacity/README.md`.

## Repository layout

| Path | Purpose |
|------|---------|
| `infra/deployment-contracts/manifest.json` | Deployment contract manifest — 7 ADR-0010 services, env var NAMES only |
| `infra/deployment-contracts/parity-manifest.json` | Staging/prod structural parity manifest |
| `infra/deployment-contracts/release-record.example.json` | Example release record in the `prepared` state |
| `infra/deployment-contracts/provenance-manifest.json` | Offline provenance template (SLSA 0, unsigned) |
| `config/deployment-capacity-contracts.schema.json` | DEP-04 manifest schema |
| `config/deployment-capacity-parity.schema.json` | DEP-05 parity schema |
| `config/deployment-capacity-release.schema.json` | DEP-06 release record schema |
| `config/deployment-capacity-provenance.schema.json` | DEP-07 provenance schema |
| `scripts/validate-deployment-contracts` | DEP-04/05 validator (repo mode + `--fixtures`) |
| `scripts/validate-deployment-release` | DEP-06 state machine + rollback validator (`--fixtures`) |
| `scripts/artifact-provenance-validate` | DEP-07 provenance validator (repo mode + `--fixtures`) |
| `scripts/validate-deployment-schema-drift` | Schema-contract drift validation (all Phase 11 schemas, stdlib only) |
| `docs/runbooks/deployment-capacity-contracts.md` | DEP-04 runbook |
| `docs/runbooks/deployment-capacity-parity.md` | DEP-05 runbook |
| `docs/runbooks/canary-rollback.md` | DEP-06 runbook (state machine + rollback) |
| `docs/runbooks/deployment-capacity-provenance.md` | DEP-07 runbook |

## Core invariants (all enforced offline)

1. **Env var NAMES only.** The contract stores names (`^[A-Z][A-Z0-9_]*$`)
   with a `secret` flag and a `secretSource`. Values, `NAME=value` forms, URLs,
   and credential-like tokens are rejected. Every name must be declared in
   `config/environment.schema.json`.
2. **Runtime secret source.** ADR-0010 decision 2: values are injected at
   runtime from a managed Infisical project via a machine identity. The
   repository never stores a value.
3. **No Terraform.** A `.tf` file anywhere under `infra/deployment-contracts/`
   is a build failure (audited-plan correction C3). `infra/oracle/**` is
   untouched.
4. **Structural parity.** Staging and prod declare the same service set, the
   same env var NAMES, the same artifact inputs and the same runtimes.
   Replica counts and instance sizes may differ (scale-only).
5. **Deterministic release state machine.** Only the documented transitions
   are legal; `prepared → promoted` and any skip of staging verification are
   rejected. Rollback compatibility is checked against the repository
   migrations registry only.
6. **SLSA 0, unsigned.** The provenance template claims no build, no
   signature, and no attestation. Fake signatures, `signed: true`,
   `slsa_level > 0`, missing lock digests and completed test-evidence claims
   are all rejected.

## Schema-contract drift validation

`scripts/validate-deployment-schema-drift` freezes the machine-critical
invariants of every published Phase 11 schema (`config/deployment-capacity*.schema.json`
and `infra/capacity/*schema.json`): required keys, `const` values, enums,
patterns, minima, and `additionalProperties: false`. It fails whenever a schema
file drifts away from its frozen contract, runs representative positive and
negative fixtures through the same contract, and probes the executable
validators to confirm they agree.

**Honesty boundary:** the repository does not vendor a full JSON Schema engine
(no new dependencies are permitted), so CI verifies **contract-critical schema
drift** — it is NOT full Draft 2020-12 validation. Full validation of these
files remains available locally with any Draft-compliant engine.

## Validators

```bash
# DEP-04/05 — deployment contract + parity (repo mode + seeded negatives)
node scripts/validate-deployment-contracts
node scripts/validate-deployment-contracts --fixtures

# DEP-06 — release state machine + rollback compatibility
node scripts/validate-deployment-release validate infra/deployment-contracts/release-record.example.json
node scripts/validate-deployment-release --fixtures

# DEP-07 — offline artifact provenance
node scripts/artifact-provenance-validate validate infra/deployment-contracts/provenance-manifest.json
node scripts/artifact-provenance-validate --fixtures

# PR-B status-field validator (scans all Phase 11 artifact paths)
node scripts/check-deployment-capacity-status.mjs
node scripts/check-deployment-capacity-status.test.mjs
```

## What this lane does NOT prove

- No service is deployed, provisioned, promoted, or rolled back by any
  repository artifact.
- No canary ran; cohort and observation windows are PENDING SRE/product.
- No signature or SLSA attestation exists; signing maturity is PENDING owner.
- No provider endpoint, credential, or cloud action is referenced or executed.
- The owner operates every live target outside CI, per ADR-0010.
