# Phase-0 Owner Evidence Runbook

**Audience:** Engineering Lead or Security Lead performing FND-02 (credential
rotation) and FND-03 (candidate-artifact disposition) evidence collection.

**Goal:** Produce a validated evidence manifest that proves credential rotation
and artifact sanitization have occurred, without leaking secrets, PII, or
candidate data into the Git repository.

---

## 1. Overview

The Phase-0 evidence manifest (`config/phase0-evidence.json`, **never
committed**) is a structured JSON document that records:

- Which provider credentials were rotated (FND-02), by whom, and what proof exists
- Which candidate artifacts were reviewed and dispositioned (FND-03)

The schema enforces a strict shape. The validator (`scripts/check-phase0-evidence.mjs`)
checks that the shape is valid, but **does not verify the truth of the evidence**.
Acceptance still requires human/provider action (e.g. confirming the audit log
screenshot is authentic).

---

## 2. Creating the Evidence Manifest

### 2.1. Never commit the real manifest

The real manifest file `config/phase0-evidence.json` is listed in `.gitignore`.
Only the **example** file `config/phase0-evidence.example.json` is committed.
Always work on `config/phase0-evidence.json` and keep it local.

### 2.2. Procedure

1. **Rotate credentials** in each provider account (Supabase, LiveKit,
   Anthropic, Sarvam, Deepgram, Retell/ElevenLabs/Cartesia). Capture
   non-secret evidence for each (audit-log screenshot, provider-console
   timestamp, or credential-rejection test).

2. **Store evidence externally.** Place screenshots, logs, or test output in
   the approved restricted storage (outside Git). Record each item's location
   as a `restricted://FND02/...` reference.

3. **Review and sanitize artifacts** for FND-03. For each quarantined artifact
   (recordings, scorecards, screenshots, etc.), determine whether it is clean,
   replaced with synthetic data, or quarantined. Record the disposition.

4. **Write the manifest** at `config/phase0-evidence.json` following the
   schema and example. See Section 3 for the schema reference.

5. **Validate locally**:

   ```bash
   node scripts/check-phase0-evidence.mjs config/phase0-evidence.json
   ```

   Expected exit code: `0` (complete + valid).

6. **Do NOT stage or commit `config/phase0-evidence.json`.** It is gitignored.

---

## 3. Schema Reference

See `config/phase0-evidence.schema.json` (draft 2020-12) for the full schema.

### Top-level fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `schemaVersion` | Yes | string (semver) | Version of this schema, e.g. `1.0.0` |
| `evidenceDate` | Yes | string (date-time UTC) | When the evidence was captured |
| `owner` | Yes | object | Role and evidence date of the attesting owner |
| `credentialGroups` | Yes | array | Array of FND-02 credential rotation entries |
| `artifactGroups` | Yes | array | Array of FND-03 artifact disposition entries |

### Credential group

| Field | Required | Type | Constraints |
|-------|----------|------|-------------|
| `groupId` | Yes | string | Pattern: `^[a-z][a-z0-9-]+$` |
| `provider` | Yes | string | One of: supabase, livekit, anthropic, sarvam, deepgram, retell-elevenlabs-cartesia |
| `verification.ownerRole` | Yes | string | Role of the verifier |
| `verification.evidenceDate` | Yes | string (date-time UTC) | When rotation evidence was captured |
| `verification.evidenceRef` | Yes | string | Pattern: `restricted://FND02/...` |
| `verification.rotationAction` | Yes | string | One of: rotated, revoked, deleted-resource |
| `verification.oldCredentialRejectionMethod` | Yes | string | One of: audit-log-screenshot, provider-console-timestamp, credential-rejection-test |

### Artifact group

| Field | Required | Type | Constraints |
|-------|----------|------|-------------|
| `groupId` | Yes | string | Pattern: `^[a-z][a-z0-9-]+$` |
| `artifactType` | Yes | string | One of: interview-recording, scorecard-pdf, candidate-screenshot, resume-copy, voice-media, generated-document, browser-recording |
| `verification.manualReviewOutcome` | Yes | string | One of: clean, replaced-synthetic, quarantined |
| `verification.dispositionStatus` | Yes | string | One of: retained-restricted, deleted-after-replacement, pending-review |
| `verification.evidenceRef` | Yes | string | Pattern: `restricted://FND03/...` |

---

## 4. Running the Validator

```bash
# Validate a specific manifest
node scripts/check-phase0-evidence.mjs config/phase0-evidence.json

# Validate the example (for CI / smoke test)
node scripts/check-phase0-evidence.mjs config/phase0-evidence.example.json
```

### Exit code meanings

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Complete + valid. All 6 providers covered, all groups verified. | Manifest is ready for review/acceptance |
| 2 | Valid shape but incomplete. Some providers missing or groups not fully verified. | Add missing provider entries or complete verification fields |
| 1 | Invalid / unsafe / tool error. Schema violation, secret-like content, PII, or file error. | Fix the reported category; check diagnostics for guidance |

### What the validator validates

- File is a regular file ≤ 64 KB
- JSON is well-formed
- Schema fields and types are correct
- No unknown fields (strict `additionalProperties: false`)
- No secret-like field names or values (JWT, private keys, URLs with creds, etc.)
- No PII (emails, phone numbers)
- No future dates
- No duplicate group IDs
- No placeholder claims marked as verified
- All 6 providers have at least one credential group
- All credential groups have complete verification

### What the validator does NOT validate

- The truth or authenticity of the evidence (does it actually prove rotation?)
- Whether the owner actually performed the rotation
- Whether the evidence references point to real files
- Content of externally-stored evidence

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

## 6. Restricted Evidence

All non-secret evidence (screenshots, logs, test output) remains **outside Git**
in the approved restricted storage. The manifest only contains references
(`restricted://FND02/...`, `restricted://FND03/...`) that point to these
external resources.

Never commit:
- Screenshots of provider consoles
- Audit log exports
- Old credential rejection test results
- Original candidate artifacts

These belong in restricted storage, not in the repository.
