# Runbook: LCH-03 Hypercare Synthetic Drill

**Status:** TEMPLATE / FOUNDATION — NOT_EXECUTED. This runbook documents how
to run the LCH-03 hypercare **synthetic drill** and what it can and cannot
claim. Nothing here is a production hypercare window: the committed LCH-03
records keep `hypercareStatus` at `NOT_RUN`/`PENDING`,
`productionAcceptance: false`, `incidentCadence: PENDING`, and
`rollbackAuthority: PENDING`, and no SLO, error-budget, or real-traffic
claim is ever made.

## 1. Purpose

LCH-03 is "run heightened post-launch monitoring for an SRE-approved window
based on traffic volume (not merely elapsed hours)". The repository
foundation for that gate is a **deterministic, bounded synthetic drill
harness** that:

- validates an input drill fixture against a strict contract
  (`config/phase12-hypercare.schema.json`);
- computes and checks **only** a `syntheticThresholdMet`-style result:

  ```
  syntheticThresholdMet =
      syntheticSessionCount >= declaredThreshold &&
      trafficSource === "synthetic_local"
  ```

- verifies that the fixture's declared `hypercareWindowAccepted` equals that
  computed value.

The harness proves the traffic-count gate is **not vacuous**: zero synthetic
sessions can never accept a window, and elapsed hours alone can never accept
a window (`elapsedHoursOnly` is forced `false`; `elapsedHours` is recorded
information only and is never used for acceptance).

## 2. Contract and bounds

Every fixture is a compact aggregate document — bounded integer counts, never
session arrays. Hard bounds enforced by both the schema and the harness:

| Field | Type | Bound | Meaning |
|-------|------|-------|---------|
| `drill.syntheticSessionCount` | integer | 0..10000 | Compact aggregate synthetic session count |
| `drill.declaredThreshold` | integer | 1..10000 | Minimum count required to accept; 0 is rejected as vacuous |
| `drill.elapsedHours` | integer | 0..168 | Recorded window length (informational only, never used for acceptance) |
| `drill.elapsedHoursOnly` | boolean | `false` only | Wall-clock-only acceptance is forbidden |
| `drill.trafficSource` | enum | `synthetic_local` only | Real/production traffic is never accepted |
| `drill.hypercareStatus` | enum | `NOT_RUN`, `PENDING` | The real hypercare window has not run |
| `drill.productionAcceptance` | boolean | `false` only | Never claimed by a repository drill |
| `drill.sloAttainment` | null | — | Real SLO attainment is never measured |
| `drill.errorBudgetRemaining` | null | — | Real error budget is never measured |
| `drill.errorBudgetHealthy` | null | — | Error-budget health is never claimed |
| `drill.incidentCadence` | enum | `PENDING` only | Cadence roles are not established |
| `drill.rollbackAuthority` | enum | `PENDING` only | No rollback authority is declared |
| `evidence.sessionIds` | array | empty only | No session identifier exists |
| `evidence.endpoints` | array | empty only | No endpoint/host/URL exists |

## 3. Committed fixtures

`infra/launch/fixtures/hypercare/` ships four deterministic fixtures. Run the
whole matrix with:

```bash
node scripts/run-phase12-hypercare-drill.mjs --all
```

| Fixture | Sessions | Threshold | Expected result |
|---------|----------|-----------|-----------------|
| `sessions-0.json` | 0 | 100 | `syntheticThresholdMet: false` (zero control — gate not vacuous) |
| `sessions-50.json` | 50 | 100 | `syntheticThresholdMet: false` (below threshold) |
| `sessions-200.json` | 200 | 100 | `syntheticThresholdMet: true` (above threshold) |
| `sessions-1000.json` | 1000 | 1000 | `syntheticThresholdMet: true` (at threshold, exact) |

Run a single fixture or the example record:

```bash
node scripts/run-phase12-hypercare-drill.mjs infra/launch/fixtures/hypercare/sessions-200.json
node scripts/run-phase12-hypercare-drill.mjs --example   # infra/launch/hypercare-drill.example.json
```

Exit code `0` means the input is valid and every declared claim matches the
deterministic computation. Exit code `1` means at least one fixture is
invalid (missing field, type/enum/bounds violation, extra key, cross-field
violation, or declared/computed mismatch). Exit code `2` is a usage error.

## 4. What the harness rejects

- **Missing/extra fields** — every required field must be present and no
  unknown field may exist (`additionalProperties: false` at every level).
- **Type/enum/bounds** — non-integer or out-of-range counts, wrong types, and
  any status outside the allowed vocabulary.
- **Real-traffic claims** — `trafficSource` other than `synthetic_local`.
- **SLO / error-budget claims** — any non-null `sloAttainment`,
  `errorBudgetRemaining`, or `errorBudgetHealthy`.
- **Production acceptance** — `productionAcceptance: true`.
- **Wall-clock acceptance** — `elapsedHoursOnly: true`, and any
  `hypercareWindowAccepted: true` that rests on elapsed hours instead of the
  session count.
- **Vacuous acceptance** — `hypercareWindowAccepted: true` with
  `syntheticSessionCount: 0`.
- **Below-threshold acceptance** — `hypercareWindowAccepted: true` with
  `syntheticSessionCount < declaredThreshold`.
- **Declared/computed mismatch** — a fixture declaring a result that differs
  from the deterministic computation, in either direction.
- **Identifier bypass** — no `EV-*` reference, UUID, ticket ID, session ID,
  or URL can authorize a claim. Such identifiers are metadata only; the
  harness has no field or function that accepts one as authorization, and
  injecting one is rejected as an extra key or a non-empty evidence array.

## 5. Truth boundary

The committed drill records stay truthful under all runs:
`hypercareStatus` is `PENDING`, `productionAcceptance` is `false`,
`incidentCadence` and `rollbackAuthority` are `PENDING`, `sloAttainment`,
`errorBudgetRemaining`, and `errorBudgetHealthy` are `null`, evidence type is
`synthetic_local`, and `evidence.sessionIds`/`evidence.endpoints` are empty.
`hypercareWindowAccepted: true` on `sessions-200.json` and
`sessions-1000.json` is a **synthetic drill result only** — it is not
production hypercare acceptance.

## 6. Residuals (remain PENDING)

An SRE-approved real hypercare window, real traffic volume, active on-call
cadence, healthy real error budget, and explicit rollback authority require
owner/SRE action and external infrastructure outside the repository and are
not delivered by this foundation. See `PLAN.md` section 8 and
`docs/runbooks/launch-incident-cadence.md`.

## 7. Related artifacts

| Artifact | Purpose |
|----------|---------|
| `config/phase12-hypercare.schema.json` | LCH-03 synthetic drill fixture schema |
| `infra/launch/hypercare-drill.example.json` | LCH-03 example drill record (all-PENDING template) |
| `infra/launch/fixtures/hypercare/*.json` | Committed deterministic fixtures (0/50/200/1000) |
| `scripts/run-phase12-hypercare-drill.mjs` | Deterministic bounded synthetic drill harness |
| `scripts/run-phase12-hypercare-drill.test.mjs` | Harness self-test (determinism, bounds, claims, bypass) |
| `docs/runbooks/launch-incident-cadence.md` | Incident cadence during hypercare (PENDING) |
| `docs/runbooks/slo-error-budget.md` | Pre-existing SLO/error-budget targets (not measured here) |
