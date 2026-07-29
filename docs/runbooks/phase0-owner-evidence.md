# Phase-0 Owner Evidence Runbook

**Audience:** Engineering Lead or Security Lead performing FND-02 (credential
rotation) and FND-03 (candidate-artifact disposition) evidence collection.

**Goal:** Produce a validated evidence manifest that proves credential rotation
and artifact sanitization have occurred, without leaking secrets, PII, or
candidate data into the Git repository.

---

## 1. Overview

The Phase-0 evidence manifest (`config/phase0-evidence.local.json`, **never
committed**) is a structured JSON document that records:

- Which provider credentials were rotated (FND-02), by whom, and what proof exists
- Which candidate artifacts were reviewed and dispositioned (FND-03)

The schema enforces a strict shape. The validator (`scripts/check-phase0-evidence.mjs`)
checks that the shape is valid, but **does not verify the truth of the evidence**.
Acceptance still requires human/provider action (e.g. confirming the audit log
screenshot is authentic). The validator also uses regex heuristics to detect
common secret and PII patterns; these heuristics **cannot prove the absence** of
all secrets or PII — acceptance still needs human review.

---

## 2. Creating the Evidence Manifest

### 2.1. Never commit the real manifest

The real manifest file `config/phase0-evidence.local.json` is listed in `.gitignore`.
Only the **example** file `config/phase0-evidence.example.json` is committed.
Always work on `config/phase0-evidence.local.json` and keep it local.

### 2.2. Procedure

1. **Rotate credentials** in each provider account (Supabase, LiveKit,
   Anthropic, Sarvam, Deepgram, Retell, ElevenLabs, Cartesia). Capture
   non-secret evidence for each (audit-log screenshot, provider-console
   timestamp, or credential-rejection test).

2. **Store evidence externally.** Place screenshots, logs, or test output in
   the approved restricted storage (outside Git). Record each item's location
   as a `restricted://FND02/...` reference.

3. **Review and sanitize artifacts** for FND-03. For each artifact
   (recordings, scorecards, screenshots, etc.), determine whether it is clean
   (no PII found), or has been replaced with synthetic data. Quarantined
   artifacts MUST remain in status=pending — they cannot pass exit‑0
   validation until a clean or synthetic replacement replaces them.

4. **Write the manifest** at `config/phase0-evidence.local.json` following the
   schema and example. See Section 3 for the schema reference.

5. **Validate locally**:

   ```bash
   node scripts/check-phase0-evidence.mjs config/phase0-evidence.local.json
   ```

   Expected exit code: `0` (complete + valid, all 8 providers + 7 artifact
   groups verified, none pending).

6. **Do NOT stage or commit `config/phase0-evidence.local.json`.** It is gitignored.

---

## 3. Schema Reference

See `config/phase0-evidence.schema.json` (draft 2020-12) for the full schema.

### Top-level fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `schemaVersion` | Yes | string (enum) | Must be exactly `1.0.0` |
| `evidenceDate` | Yes | string (date-time UTC) | When the evidence was captured |
| `owner` | Yes | object | Role and evidence date of the attesting owner |
| `credentialGroups` | Yes | array | Array of FND-02 credential rotation entries |
| `artifactGroups` | Yes | array | Array of FND-03 artifact disposition entries |

### Owner

| Field | Required | Type | Constraints |
|-------|----------|------|-------------|
| `role` | Yes | string (enum) | One of: Engineering Lead, Security Lead, Product Manager, Legal Counsel |
| `evidenceDate` | Yes | string (date-time UTC) | When the owner recorded their attestation |

### Credential group

| Field | Required | Type | Constraints |
|-------|----------|------|-------------|
| `groupId` | Yes | string | Pattern: `^[a-z][a-z0-9-]+$` |
| `provider` | Yes | string (enum) | One of: supabase, livekit, anthropic, sarvam, deepgram, retell, elevenlabs, cartesia |
| `status` | Yes | string (enum) | `pending` or `verified` |
| `verification` | Conditional | object | Required if status=verified; must be absent if status=pending |
| `verification.ownerRole` | Yes | string (enum) | One of: Engineering Lead, Security Lead, Product Manager, Legal Counsel |
| `verification.evidenceDate` | Yes | string (date-time UTC) | When rotation evidence was captured |
| `verification.evidenceRef` | Yes | string | Pattern: `restricted://FND02/...` |
| `verification.rotationAction` | Yes | string | One of: rotated, revoked, deleted-resource |
| `verification.oldCredentialRejectionMethod` | Yes | string | One of: audit-log-screenshot, provider-console-timestamp, credential-rejection-test |

### Artifact group

| Field | Required | Type | Constraints |
|-------|----------|------|-------------|
| `groupId` | Yes | string (enum) | One of: hello-html, hello-md, hello-assets, generated-pdf, voice-recording, scorecard-export, env-example-values |
| `artifactType` | Yes | string | One of: interview-recording, scorecard-pdf, candidate-screenshot, resume-copy, voice-media, generated-document, browser-recording |
| `status` | Yes | string (enum) | `pending` or `verified` |
| `verification` | Conditional | object | Required if status=verified; must be absent if status=pending |
| `verification.manualReviewOutcome` | Yes | string | One of: clean, replaced-synthetic, quarantined |
| `verification.dispositionStatus` | Yes | string | One of: retained-restricted, deleted-after-replacement, pending-review |
| `verification.evidenceRef` | Yes | string | Pattern: `restricted://FND03/...` |

---

## 4. Running the Validator

```bash
# Validate a specific manifest
node scripts/check-phase0-evidence.mjs config/phase0-evidence.local.json

# Validate the example (for CI / smoke test)
node scripts/check-phase0-evidence.mjs config/phase0-evidence.example.json
```

### Exit code meanings

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Complete + valid. All 8 providers covered, all 7 artifact group IDs present, all entries verified. | Manifest is ready for review/acceptance |
| 2 | Valid shape but at least one entry has status="pending". | Complete remaining entries and re-validate |
| 1 | Invalid / unsafe / tool error. Schema violation, secret-like content, PII, or file error. | Fix the reported category; check diagnostics for guidance |

### What the validator validates

- File is a regular file ≤ 64 KB (not a symlink or directory)
- JSON is well-formed
- `schemaVersion` matches the schema's own version (currently `1.0.0`)
- Schema fields and types are correct
- No unknown fields (strict `additionalProperties: false`)
- All 8 providers have exactly one credential group entry (supabase, livekit,
  anthropic, sarvam, deepgram, retell, elevenlabs, cartesia)
- All 7 artifact group IDs are present (hello-html, hello-md, hello-assets,
  generated-pdf, voice-recording, scorecard-export, env-example-values)
- Owner role is one of the approved enum values (no free text, no person names)
- Verification ownerRole is also one of the approved enum values
- All dates are valid ISO 8601 UTC timestamps and are not in the future
- No secret-like field names or values (JWT, private keys, token prefixes,
  high-entropy base64, URLs with creds, URLs with query/fragment)
- No PII (emails, phone numbers)
- No absolute paths or parent-traversal paths
- No duplicate group IDs
- No placeholder claims
- Evidence refs follow `restricted://FND02/...` or `restricted://FND03/...` grammar
- FND-03 outcome combinations are valid. Only 3 combos exit 0:
  `clean:retained-restricted`, `replaced-synthetic:retained-restricted`,
  and `replaced-synthetic:deleted-after-replacement`. Quarantined artifacts
  must remain in status=pending (external handling)
- If status=pending, verification must be absent; if status=verified,
  verification must be present with all required fields

### What the validator does NOT validate

- The truth or authenticity of the evidence (does it actually prove rotation?)
- Whether the owner actually performed the rotation
- Whether the evidence references point to real files
- Content of externally-stored evidence
- **Regex heuristics cannot prove the absence of all PII or secrets** — human
  review is still required

---

## 5. Acceptance Still Requires Human Action

The validator only checks **shape**. A passing validator does not mean FND-02
or FND-03 are complete. The following must still happen outside the tool:

1. **Provider verification:** An authorized owner must confirm each rotation
   by checking the provider's audit log or console.
2. **Evidence authenticity:** Screenshots, timestamps, or rejection tests must
   be reviewed for authenticity.
3. **Disposition confirmation:** Artifact disposition must be confirmed against
   the restricted storage records.
4. **Acceptance sign-off:** The evidence must be accepted by the project lead
   or security officer.

---

## 6. Synthetic Demo Artifacts

Synthetic demo replacements for all 7 FND-03 artifact groups live under
`docs/demo/`. These are safe, shareable, deterministic replacements that
contain no PII, secrets, or real candidate data.

| Group ID | Synthetic Path | Type |
|----------|---------------|------|
| hello-html | `docs/demo/hello.html` | Static offline HTML |
| hello-md | `docs/demo/hello.md` | Markdown document |
| hello-assets | `docs/demo/hello-assets/` | Synthetic resume JSON |
| generated-pdf | `docs/demo/generated-pdf/` | Scorecard JSON + template |
| voice-recording | `docs/demo/voice-recording/` | Non-speech tone metadata |
| scorecard-export | `docs/demo/scorecard-export/` | Scorecard export JSON |
| env-example-values | `docs/demo/env-example-values/` | Env var placeholder schema |

### Validating demo artifacts

```bash
node scripts/check-demo-artifacts.mjs
node scripts/check-demo-artifacts.test.mjs
```

The validator checks for:
- All 7 group files exist and are well-formed
- No PII (all emails use `@example.invalid`, phone fields are null/absent)
- No secrets, tokens, private keys, or credentials
- No live external network destinations (only reserved `example.invalid`, `example.com`, `example.org`, `example.net`, `example.edu`, and local `localhost` references are allowed in documentation fields)
- No scripts, event handlers, data URLs, or external resource attributes in HTML files
- No path traversal or symlinks
- JSON files have `is_synthetic: true` markers
- Timestamps are deterministic (all set to `2025-06-15T10:00:00Z`)
- File sizes are bounded (max 1 MB per file, 5 MB total)

### Regeneration

```bash
node scripts/generate-demo-artifacts.mjs
```

All generators are deterministic — running twice produces identical checksums.

## 7. Restricted Evidence

All non-secret evidence (screenshots, logs, test output) remains **outside Git**
in the approved restricted storage. The manifest only contains references
(`restricted://FND02/...`, `restricted://FND03/...`) that point to these
external resources.

Never commit:
- Screenshots of provider consoles
- Audit log exports
- Old credential rejection test results
- Original candidate artifacts
- The real evidence manifest (`config/phase0-evidence.local.json`)

These belong in restricted storage, not in the repository.
