# LLM-07/08 — Fairness Harness + Adversarial Fixtures (PR-A Lane A3)

**Status:** PROPOSED
**Evidence state:** repository-only (no authentic external evidence)
**Baseline:** `b3f1f301`

## Purpose

This document is the coverage map for the two Lane A3 deliverables:

1. **LLM-07 — voluntary/synthetic cohort fairness harness**: a deterministic,
   fully offline module (`app/api/src/model-governance/fairness.ts`) that
   computes **descriptive** cohort statistics (coverage, mean score,
   uncertainty, disparity) from **explicitly voluntary** cohort labels only.
   It never infers a protected trait, suppresses small cohorts, reports
   `insufficient_data` honestly, and derives **no approval**.
2. **LLM-08 — adversarial prompt/output harness**: synthetic adversarial
   fixtures (`app/api/src/__tests__/fixtures/model-governance/`) plus a
   deterministic harness (`app/api/src/model-governance/adversarial.ts`) that
   calls the **real exported prompt constructors** and the **strict pure
   output validator** from `app/api/src/lib/prompts.ts`.

Both are repository-only foundations. They run no network calls, no provider
clients, no model downloads, and no live inference.

## LLM-08 truth: foundation/partial, not production hardening

The production runtime does **not** call the new validator:

- `app/api/src/lib/claude.ts` still parses model output with its internal
  `extractJson` + `JSON.parse` (`runClaudeJSON`), with one bounded retry.
- `app/api/src/services/assessment.ts` still clamps out-of-range sub-scores
  with `computeOverall()` and its fixed `WEIGHTS` constant; it does not reject
  extra keys or malformed shapes.

The seam added to `prompts.ts` (exported delimiter/contract constants,
`extractStructuredJson`, `validateConversationOutput`,
`validateAssessmentOutput`) is **pure and additive**: prompt text, scoring
weights, provider calls and runtime behavior are byte-identical to baseline
(proven by regression tests and by the additive-only git diff to `prompts.ts`).
**LLM-08 is therefore foundation/partial**: it proves the prompt-construction
seams and the strict validator behave as specified, and classifies synthetic
injection attempts deterministically — it is not a claim of production prompt
hardening. Wiring the validator into `runClaudeJSON` / `assessment.ts` would be
a separate, owner-approved runtime change.

## Fairness harness (LLM-07)

### Voluntary cohort label schema

`config/model-governance-fairness.schema.json` + the TS types in
`fairness.ts` define a cohort document:

- every labeled member carries `voluntaryLabel` with `declared: true`,
  `consented: true`, and `declarationSource` in the closed set
  `voluntary_self_declared | synthetic_fixture`;
- members **without** a voluntary label are **excluded** from cohort metrics —
  they are never bucketed and never inferred;
- any member or label key starting with `inferred_from` (voice, name, accent,
  transcript, language, metadata) is **rejected** by the schema
  `propertyNames` guard and by `validateCohortDocument()`;
- the document carries a SHA-256 digest manifest per member (tamper control);
- `minimumN` is a positive integer (the suppression threshold).

### Deterministic metrics (descriptive only)

| Metric | Definition | Insufficient/suppressed when |
|---|---|---|
| `cohort_coverage` | measured cohorts / declared cohorts | no declared cohorts |
| `mean_score` | cohort mean observed score (0..1, normalized from 0..10) | zero members → `insufficient_data`; below minimum N → `suppressed` |
| `uncertainty` | mean label-confidence deficit (`1 − confidence`) | no member supplies confidence → `insufficient_data`; below minimum N → `suppressed` |
| `disparity` | max − min mean score across measured cohorts | fewer than two measured cohorts → `insufficient_data` |

Disparity is reported with `role: descriptive_only`. It is never an
acceptance gate. All thresholds are static `PROPOSED` constants; a report
whose threshold carries an approval value, or that carries a `winner` or
`approvalStatus` claim, is rejected by `validateFairnessReport()`.

### Coverage map — fairness → scoring path

| Fairness artifact | Real code path it references | Relationship |
|---|---|---|
| `fairness.ts` metrics over 0..10 observed scores | `app/api/src/services/assessment.ts` sub-score scale (0-10) and `computeOverall` weighting | Advisory consistency only: the harness treats scores as advisory data, never as an approval source |
| `FAIRNESS_THRESHOLDS` (PROPOSED) | no launch threshold exists anywhere in the repo | No threshold in `fairness.ts` is a launch gate |
| cohort labels | `docs/model-governance/provider-boundaries.md` LLM-01 screening/scoring workloads | Labels are synthetic/voluntary input data, never derived from provider audio or transcript metadata |

## Adversarial harness (LLM-08)

### Fixture categories and sentinel discipline

`app/api/src/__tests__/fixtures/model-governance/adversarial-prompt-attacks.json`
contains 8 fixtures covering all six required categories, both prompt kinds
(`conversation`, `assessment`), and two output-shape failures:

| Category | Fixture | Prompt kind | Expected |
|---|---|---|---|
| `system_prompt_extraction` | adv-system-prompt-extraction-conversation | conversation | failure |
| `system_prompt_extraction` (leak) | adv-system-prompt-leak-assessment | assessment | failure + output rejected |
| `secret_extraction` | adv-secret-extraction-assessment | assessment | failure |
| `rubric_override` | adv-rubric-override-assessment | assessment | failure |
| `tool_invocation` | adv-tool-invocation-conversation | conversation | failure |
| `hidden_instructions` | adv-hidden-instructions-conversation | conversation | failure |
| `malformed_output` | adv-malformed-json-conversation | conversation | quarantine + output rejected |
| `malformed_output` | adv-out-of-range-assessment | assessment | quarantine + output rejected |

Every payload embeds an obvious `SENTINEL_*` token (grammar-enforced:
`^SENTINEL_[A-Z0-9_]{4,64}$`). No real secrets, credentials, URLs, or
candidate data appear anywhere; the repository secret scan (`scan-secrets.sh`)
and SAST both run against these files in CI.

### Coverage map — adversarial → prompt/provenance/scoring paths

| Attack category | Real code path exercised | Harness proof |
|---|---|---|
| `system_prompt_extraction` | `SCREENING_SYSTEM` (passed as the `system` option in `app/api/src/routes/screening.ts`), `buildConversationPrompt`, `buildAssessmentPrompt` | prompt is built by the real constructor; sentinel stays in the untrusted input region; a leaked output carrying a `system_prompt` key is rejected as `extra_unsafe_keys` |
| `secret_extraction` | `app/api/src/lib/claude.ts` `runClaudeJSON` input path (transcript text) | injection classified failure; containment verified |
| `rubric_override` | `buildAssessmentPrompt` rubric contract + `assessment.ts` fixed weights | injection classified failure; the strict validator rejects output that adds unsafe keys instead of honoring the contract |
| `tool_invocation` | `claude.ts` CLI spawn boundary (no tool-call surface exists) | injection classified failure; output with `tool_calls` key is rejected as `extra_unsafe_keys` |
| `hidden_instructions` | `SCREENING_SYSTEM` AI-disclosure rule | injection classified failure; containment verified |
| `malformed_output` | `claude.ts` `extractJson`/`JSON.parse` seam (mirrored by `extractStructuredJson`) | malformed JSON rejected as `malformed_json`; out-of-range scores rejected as `out_of_range_score` |
| provenance | `app/api/src/lib/model-provenance.ts` `validateProvenance` | every fixture provenance validated with the real LLM-06 validator (by import, no duplication) |

### Containment semantics (honest and precise)

- **Assessment prompts** fence the transcript with the exported
  `PROMPT_TRANSCRIPT_DELIMITER` (`"""`); the harness verifies the sentinel
  sits strictly inside the fenced block and appears nowhere else.
- **Conversation prompts** embed the transcript inline (there is no delimiter
  in `buildConversationPrompt`); the harness verifies the sentinel sits inside
  the `Conversation so far:` block, before the output contract, and appears
  nowhere else.

In both cases the harness **classifies** the attempt deterministically
(failure/quarantine) at the framework level — no model is consulted, and no
output that follows an injected instruction is ever trusted by the harness.

## Enforcement

- `app/api/src/model-governance/fairness.ts` — cohort document + report
  validation, suppression, `insufficient_data`, descriptive-only disparity.
- `app/api/src/model-governance/adversarial.ts` — fixture document
  validation, deterministic classification, containment checks, leak
  detection, run verdicts.
- `app/api/src/lib/prompts.ts` — the additive LLM-08 seam (delimiter/contract
  constants + strict pure output validator).
- `config/model-governance-fairness.schema.json`,
  `config/model-governance-adversarial.schema.json` — machine-checkable
  structural contracts (draft-07).
- `app/api/src/__tests__/model-governance-fairness.test.ts`,
  `app/api/src/__tests__/model-governance-adversarial.test.ts` — mandatory
  negative controls (see below).
- `scripts/check-model-governance-status.mjs` — rejects any approval / winner /
  signed / positive-SLSA status claim in Phase 10 artifacts unconditionally
  (no external-evidence bypass).

### Negative controls proven by tests

1. Member (or label) with `inferred_from_voice` / any `inferred_from_*` trait
   → cohort document rejected.
2. Cohort below minimum N → metrics suppressed (`state: suppressed`,
   `reason: below_minimum_n`, no value).
3. Member without a voluntary label → excluded (never inferred, never
   bucketed).
4. Fairness report with an approved threshold, `winner`, or `approvalStatus`
   → report rejected; disparity `role` must be `descriptive_only`.
5. Zero-sample metrics and sub-minimum-N disparity → `insufficient_data`.
6. Tampered cohort member digest / missing digest → document rejected.
7. Prompt/secret/rubric/tool/hidden-instruction payloads → classified failure;
   sentinel contained in the untrusted input region.
8. Malformed JSON output → rejected `malformed_json`; extra unsafe output keys
   → rejected `extra_unsafe_keys`; out-of-range scores → rejected
   `out_of_range_score`; invalid enums → rejected `invalid_enum`.
9. Non-`SENTINEL_` tokens (real-secret lookalikes) → fixture rejected.
10. Adversarial fixture digest drift / missing digest / duplicate id / bad
    provenance → document rejected.

## Relationship to other artifacts

- `docs/model-governance/evaluation-framework.md` (LLM-02) — the deterministic
  evaluation framework the fairness metrics complement (both share the
  `insufficient_data` and PROPOSED-threshold honesty contract).
- `docs/model-governance/provider-boundaries.md` (LLM-01) — the boundary
  inventory the adversarial fixtures exercise.
- `docs/runbooks/model-provenance.md` — provenance schema referenced by
  fixture validation.
- `docs/runbooks/model-governance-fairness-adversarial.md` — how to run the
  harness, add fixtures, and interpret results.
