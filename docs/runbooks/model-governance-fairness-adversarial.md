# Runbook — Fairness Harness + Adversarial Suite (LLM-07/08)

**Status:** PROPOSED
**Evidence state:** repository-only (no authentic external evidence)
**Baseline:** `b3f1f301`

## Purpose

Operational guidance for the PR-A Lane A3 fairness harness (LLM-07) and
adversarial suite (LLM-08). Everything here is offline and deterministic; no
provider command, model download, or network evaluation is ever run.

## What this suite is (and is not)

It **is**:

- a deterministic, descriptive-only fairness harness over synthetic/voluntary
  cohort labels (coverage, mean score, uncertainty, disparity with
  `insufficient_data` and minimum-N suppression);
- an adversarial harness that calls the real exported prompt constructors and
  the strict pure output validator, classifying synthetic injection attempts
  as failure/quarantine and rejecting malformed/leaked outputs.

It **is NOT**:

- a model-quality or fairness approval; no threshold here is a launch gate;
- production prompt hardening — the runtime (`claude.ts` / `assessment.ts`)
  does not call the new validator (LLM-08 is foundation/partial);
- a source of protected-trait data — no trait is ever inferred from voice,
  name, accent, transcript, language, or metadata;
- a place to put real secrets, credentials, URLs, or candidate data.

## Running the suite

From the repository root:

```bash
# Fairness + adversarial unit tests (vitest)
cd app/api
npx vitest run src/__tests__/model-governance-fairness.test.ts \
  src/__tests__/model-governance-adversarial.test.ts

# Full API gate (typecheck + all tests + coverage)
npm run typecheck && npm test && npm run test:coverage

# Status-field validator over every PR-A artifact (no fake approval allowed)
cd ../..
node scripts/check-model-governance-status.mjs
node scripts/check-model-governance-status.test.mjs

# Machine schema check (draft-07) against the shipped fixture documents
python3 - <<'PY'
import json, jsonschema
root = 'config/'
for doc, schema in [
    ('app/api/src/__tests__/fixtures/model-governance/cohort-voluntary-synthetic.json',
     'model-governance-fairness.schema.json'),
    ('app/api/src/__tests__/fixtures/model-governance/adversarial-prompt-attacks.json',
     'model-governance-adversarial.schema.json'),
]:
    instance = json.load(open(doc))
    jsonschema.validate(instance, json.load(open(root + schema)))
    print('valid:', doc)
PY
```

## Interpreting results

- **Fairness report**: cohorts below `minimumN` show `state: suppressed` with
  `reason: below_minimum_n` and no value — do not read a suppressed cohort as
  a measured one. `insufficient_data` means no samples; never treat it as a
  meaningful zero. Disparity is `role: descriptive_only` — it flags spread for
  human review, it does not pass or fail anything.
- **Adversarial run**: every fixture must reach `verdict: pass` with the
  expected classification (`failure` for instruction-injection attempts,
  `quarantine` for malformed/leaked outputs). A `fail` verdict means the real
  prompt constructor, the containment check, the classification, or the strict
  validator stopped behaving as specified — investigate before adding fixtures.
- **Containment**: for assessment prompts the sentinel must sit inside the
  fenced transcript; for conversation prompts it must sit inside the
  `Conversation so far:` block. If a payload ever escapes its input region,
  the harness fails closed (quarantine), never trusts the output.

## Adding a fixture

1. Pick a category from the closed set (`system_prompt_extraction`,
   `secret_extraction`, `rubric_override`, `tool_invocation`,
   `hidden_instructions`, `malformed_output`) and a prompt kind.
2. Write the untrusted payload with an obvious `SENTINEL_[A-Z0-9_]+` token
   embedded in it (no real secrets, no URL/credential lookalikes).
3. Set `expected.classification` (`failure` for injection categories,
   `quarantine` for output-shape categories) and `expected.outputRejected`
   (requires an `outputPayload` when true).
4. Recompute the SHA-256 digest manifest (the generator pattern in the A3
   handoff, or `computeFixtureDigest` from
   `app/api/src/model-governance/evaluation.ts`).
5. Run the suite; the new fixture must reach `verdict: pass`.

## Escalations

- If an injection payload is **not** classified (false negative), extend the
  deterministic `ATTACK_PATTERNS` set — do not weaken the sentinel grammar.
- If a valid output is rejected, the strict validator has a contract bug:
  fix the validator, not the fixture.
- Any request to record real cohort data, real transcripts, or provider
  credentials here is out of scope for repository-only work — stop and ask the
  owner.
