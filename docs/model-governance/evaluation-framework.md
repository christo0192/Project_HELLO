# LLM-02/03/04/05/06 — Deterministic Offline Evaluation Framework (PR-A Lane A2)

**Status:** PROPOSED
**Evidence state:** repository-only (no authentic external evidence)
**Baseline:** `b3f1f301`

## Purpose

This document describes the deterministic, fully offline evaluation framework
for the screening product's LLM workloads (LLM-02), the optional Gemini/DeepSeek
comparison slots (LLM-03/04), the provider evidence register (LLM-05), and the
linkage to the existing provenance infrastructure (LLM-06).

The framework is a **repository-only foundation**. It runs no network calls,
no provider clients, no model downloads, and no live LLM inference. It
evaluates synthetic, de-identified fixtures and produces machine-readable
reports that are honest about what they are.

## Honesty contract

1. **Harness self-test is not authentic evaluation.** Every report carries an
   `evaluationKind` of `harness_self_test` or `authentic`. Self-test reports
   set `modelUnderTest` to `harness-self-test-v1` and conclude with
   `harness_plumbing_only`: they validate the plumbing of the framework and
   make **no claim about any model**.
2. **No model-quality claim from fixtures.** A report derived from synthetic
   fixtures never declares a model better than another. There is no `winner`
   field anywhere in the report schema, and `validateEvaluationReport()` rejects
   any report that carries one.
3. **`insufficient_data` is honest.** Any metric with zero samples reports
   `state: insufficient_data` with `sampleCount: 0` — never a meaningful zero.
4. **All thresholds are PROPOSED.** `EVALUATION_THRESHOLDS` are static
   `PROPOSED` constants. A report whose threshold carries an approval value is
   rejected unless authentic human-annotated evaluation exists — and none
   exists in repository-only work.
5. **Held-out split is disjoint and immutable.** A fixture may never appear in
   both `train` and `held_out`, and observed results must belong to the split
   being evaluated. The held-out split is never used for threshold tuning;
   every report records `heldOutUsedForThresholdTuning: false`.
6. **No network.** The evaluator uses only `node:crypto` hashing and pure
   functions. There is no provider adapter, no endpoint, no SDK construction.

## Metrics

All metrics are deterministic functions of fixtures plus supplied observed
results. Where higher is better, values are normalized to 0..1.

| Metric id | Definition | Insufficient when |
|---|---|---|
| `coverage` | fraction of evaluated-split fixtures with an observed result | evaluated split is empty |
| `factuality` | fraction of observed results whose factuality verdict matches the expected label | no observed results |
| `safety` | fraction of observed results whose safety verdict matches the expected label | no observed results |
| `disclosure` | fraction of observed results whose AI-disclosure verdict matches the expected label | no observed results |
| `scoring_consistency` | fraction of paired first/second pass results that agree (verdicts + score within 0.5) | no paired observations |
| `calibration` | `1 - ECE` (binned expected calibration error over 0..5 rubric scores) | no observed scores |
| `variance` | `1 -` mean per-fixture score variance across passes (normalized; lower variance = better) | no paired observations |

Each metric carries its own `PROPOSED` threshold from `EVALUATION_THRESHOLDS`.
Thresholds are proposed targets only; they are not pass/fail acceptance gates
and are never tuned from the held-out split.

## Harness self-test vs authentic evaluation

- **Harness self-test** (`evaluationKind: harness_self_test`): observed results
  are derived deterministically from fixture labels plus an explicitly marked
  simulated-error injection (`selfTestControl.simulateError`). The resulting
  report is plumbing evidence only — it proves the digest, split, and metric
  machinery behave as specified. The shipped fixture document
  `app/api/src/__tests__/fixtures/model-governance/eval-synthetic-fixtures.json`
  is the self-test input.
- **Authentic evaluation** (`evaluationKind: authentic`): a future path that
  requires authentic human-annotated samples (`dataSource:
  authentic_human_annotated`) and a non-empty `annotationSource` reference.
  No authentic dataset exists in this repository, so no shipped report uses it,
  and even an authentic report carries only an
  `authentic_owner_review_pending` conclusion — never an acceptance.

## Gemini/DeepSeek comparison slots (LLM-03/04 — NOT implemented)

The report schema reserves `optionalComparisons.gemini` and
`optionalComparisons.deepseek` as `NOT_EVALUATED` placeholder slots. These
lanes are explicitly **not implemented**: they are gated on the LLM-02
framework completing AND authentic human-annotated data existing. No
comparison score, no endpoint, and no winner is ever recorded in these slots.
`validateEvaluationReport()` rejects any slot that is not a `NOT_EVALUATED`
placeholder.

## LLM-06 provenance linkage

The report's `provenanceLinkage` section references the real provenance
module by import and by value:

- `module`: `app/api/src/lib/model-provenance.ts`
- `schemaVersion`: imported `MODEL_PROVENANCE_SCHEMA_VERSION`
- `providers`: imported `ALLOWLISTED_PROVIDERS`
- `workloads`: imported `ALLOWLISTED_WORKLOADS`

Every fixture's `provenance` is validated with the real
`validateProvenance()`. The evaluation framework **duplicates no provenance
infrastructure** — provenance construction, validation, and versioning remain
solely in `model-provenance.ts` (TypeScript) and `provenance.py` (Python).

## Digest manifest and held-out discipline

Each fixture document carries a SHA-256 digest manifest computed over the
canonical serialization of every fixture (`canonicalStringify`, sorted keys,
no insignificant whitespace). `validateFixtureDocument()`:

- recomputes every digest and rejects any drift (a corrupted fixture is never
  silently usable);
- rejects any fixture id present in both `split.train` and `split.heldOut`;
- rejects split labels inconsistent with the split map;
- rejects observed results that reference fixtures outside the evaluated split.

## Enforcement

- `app/api/src/model-governance/evaluation.ts` — evaluator, fixture/report
  validators, static PROPOSED thresholds, NOT_EVALUATED compare slots.
- `config/model-governance-eval.schema.json` — machine-checkable structural
  contract for fixture documents and evaluation reports (draft-07, oneOf).
- `app/api/src/__tests__/model-governance-evaluation.test.ts` — mandatory
  negative controls (see below).
- `scripts/check-model-governance-status.mjs` — rejects any approval / winner /
  signed / positive-SLSA status claim in Phase 10 artifacts unconditionally
  (no external-evidence bypass).

### Negative controls proven by tests

1. Corrupted fixture digest (tampered content) → document rejected.
2. Fixture in both train and held-out → document rejected.
3. Zero observed samples → quality metrics report `insufficient_data`.
4. Threshold carrying an approval value → report rejected (no authentic
   evaluation exists).
5. Report carrying a `winner` claim → report rejected.
6. Observed result outside the evaluated split (held-out misuse) → evaluation
   rejected.
7. Self-test report naming a real model, or claiming authentic annotations →
   report rejected.

## Relationship to other artifacts

- `docs/model-governance/provider-boundaries.md` (LLM-01) — the boundary
  inventory this framework evaluates against.
- `docs/model-governance/provider-evidence-register.md` (LLM-05) — external
  evidence status for every current and optional-comparison provider.
- `docs/runbooks/model-provenance.md` — provenance schema and lifecycle that
  the LLM-06 linkage references.
- `app/api/src/__tests__/fixtures/model-governance/eval-synthetic-fixtures.json`
  — shipped synthetic self-test fixtures with digest manifest.
