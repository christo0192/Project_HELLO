# Runbook: DEP-07 Offline Artifact Provenance

Status: **PENDING / PROPOSED.** This runbook is repository architecture only.
No build is recorded, no artifact is signed, and no SLSA level above 0 is
claimed. Signing service, external attestations, and SLSA maturity are PENDING
owner verification.

## 1. Purpose

`infra/deployment-contracts/provenance-manifest.json` is an offline provenance
template that references the repository's existing build inputs:

- the clean baseline commit `b3f1f301` (origin/main) as
  `source.baselineCommitSha`; the build commit stays `PENDING`;
- the package lockfiles (`app/api/package-lock.json`,
  `app/web/package-lock.json`, `app/voice-livekit/requirements.txt`) with
  sha256 digests (PENDING placeholders in the template);
- the SBOM outputs of the existing `scripts/sbom.sh` generator
  (`sbom-artifacts/*.cdx.json` — generated, never committed);
- test-evidence paths with placeholder status `PENDING_RUN`.

## 2. Signing and SLSA boundary

- `signing.signed` is `false`; `signed: true`, a registered `keyId`, and any
  non-empty `attestations` list are rejected.
- `slsa.level` and `slsaLevelClaimed` are `0`; any value above 0 is rejected.
- Any signature-like string (for example a DER prefix or a
  `signature: ...` value) is rejected — the fake-signature negative control.
- `generatedAt` must be `PENDING` — a timestamp would claim a recorded build.

## 3. Path safety and file bounds

Every lockfile/SBOM/testEvidence path is hardened BEFORE any digest state is
consulted — even when the digest placeholder is `PENDING`:

- absolute paths and `..` traversal are rejected;
- paths that escape the repository root are rejected;
- symlinks and non-regular files are rejected;
- NUL bytes are rejected;
- files larger than **8 MiB** (`MAX_PROVENANCE_FILE_BYTES`) are rejected
  before hashing.

The validator never reads a file outside the repository root.

## 4. Commands

```bash
node scripts/artifact-provenance-validate validate infra/deployment-contracts/provenance-manifest.json
node scripts/artifact-provenance-validate --fixtures   # seeded negatives
```

The validator rejects offline:

- fake signature strings and `signed: true`;
- `slsa_level > 0` claims;
- missing lock digests and digests that do not match the repository files;
- non-empty attestations, claimed builder identities, and generatedAt
  timestamps;
- test-evidence entries claiming completion (only PENDING_RUN / PENDING /
  NOT_RUN placeholders are permitted);
- URL-like and secret-like content anywhere in the manifest.

## 5. Truth boundary

The template is a placeholder set, not a provenance claim. When the owner
records a real build they may replace `PENDING` digests with computed sha256
values — the validator recomputes and cross-checks every real digest against
the repository. Until then, everything remains PENDING and SLSA 0.

## 6. Owner path to real provenance

1. Generate SBOMs (`bash scripts/sbom.sh`) and compute lockfile digests.
2. Record the build commit and builder identity in the manifest (owner
   judgment on which fields move from PENDING).
3. Re-run `scripts/artifact-provenance-validate validate ...` — every real
   digest is cross-checked against the repository files.
4. Signing/SLSA maturity is a separate owner decision with real evidence;
   this repository never claims it on its own.
