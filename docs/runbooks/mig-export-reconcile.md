# MIG-07/08/09: Local Export, Import, and Reconciliation Runbook

**Status:** Local implementation document
**Tools:** `scripts/migrate-export.mjs`, `scripts/migrate-reconcile.mjs`, `scripts/storage-manifest.mjs`
**Related:** `docs/data-classification.md` (GOV-01), `scripts/storage-manifest.test.mjs`

## Overview

This runbook describes the local workflow for:

1. **MIG-07:** Generating a deterministic logical-export manifest of screening_v2 table data
2. **MIG-08:** Generating a storage-object manifest with cryptographic digests
3. **MIG-09:** Reconciling two export manifests (source vs target) to detect drift

All tools operate **locally only** on synthetic data. No credentials, provider endpoints, hosted databases, or production systems are accessed.

---

## 1. Local logical export (`migrate-export.mjs`)

### Prerequisites

- Node.js 18+
- Synthetic data fixture file (JSON array of `{table, rows}` objects)
- No database connection: the tool reads a JSON file, not a live database

### Usage

```bash
# Generate an export manifest from a data file
node scripts/migrate-export.mjs input-data.json output-manifest.json

# Print manifest to stdout
node scripts/migrate-export.mjs input-data.json
```

### Input format

The input is a JSON array with one entry per table:

```json
[
  {
    "table": "roles",
    "rows": [
      {
        "id": "60000000-0000-4000-a000-000000000001",
        "title": "Synthetic Demo Test Engineer",
        "jd": "Synthetic demo position for local rehearsal only.",
        "required_skills": ["Python", "testing"],
        "screening_template": [{"id": "q1", "question": "...", "weight": 1.0}],
        "is_active": true,
        "created_at": "2026-01-15T10:00:00Z",
        "updated_at": "2026-01-15T10:00:00Z",
        "owner_id": null
      }
    ]
  }
]
```

An envelope format `{_preamble: {...}, data: [...]}` is also accepted.

### Output manifest

The manifest contains:

- `manifest_version`: currently 1
- `schema_version`: currently 1
- `generated_at`: UTC ISO-8601 timestamp
- `tables`: per-table object with `count`, `columns`, `rows` (each with redacted fields and SHA-256 digest), and `digests` array
- `sequence_state`: reserved for future sequence snapshots

### Column allowlist

Only columns defined in migrations 0001–0007 are allowed. The canonical column list is defined in `TABLE_COLUMNS` within the script. Unknown tables or columns cause immediate failure (E001–E002).

### PII redaction

The following columns are redacted (value replaced with `[REDACTED]`) in manifest output:

- `name`, `email`, `phone_raw`, `phone_e164` (candidate PII)
- `text_extracted` (resume content)
- `text` (transcript turns)
- `body` (SMS body)
- `summary` (assessment summary)
- `metadata` (audit metadata)
- `token_digest` (invite/access grant digests)
- `file_path`, `recording_url`, `recording_object_key` (path/signed URL references)

Digests are computed from the **unredacted** row data, so two exports of identical data produce identical digests even though the output rows are redacted.

---

## 2. Storage manifest (`storage-manifest.mjs`)

### Usage

```bash
# Scan a directory and generate a storage manifest
node scripts/storage-manifest.mjs scan /path/to/storage/dir [output.json]

# Verify a directory against an existing manifest
node scripts/storage-manifest.mjs verify /path/to/storage/dir manifest.json
```

### Allowed file types

Only these extensions are accepted: `.pdf`, `.json`, `.mp4`, `.m4a`, `.mp3`, `.ogg`, `.wav`, `.webm`, `.txt`, `.csv`, `.png`, `.jpg`, `.jpeg`, `.webp`.

Files larger than 100 MB are rejected. Symlinks are rejected. Hidden files (dot-prefixed) are skipped.

### Content type allowlist

Only common storage types: `application/pdf`, `application/json`, `audio/mp4`, `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/webm`, `video/mp4`, `video/webm`, `video/ogg`, `text/plain`, `text/csv`, `image/png`, `image/jpeg`, `image/webp`.

### Path traversal protection

All file paths are resolved against the root directory. Paths containing `..` that would escape the root are rejected with S001. Symlinks are rejected with S002.

### Verification output

The verify command produces four result categories:

- **verified:** Objects that match their expected size, digest, and content type
- **missing:** Objects expected by the manifest but not found on disk
- **corrupt:** Objects found but with mismatched size, digest, or content type
- **unexpected:** Objects on disk that are not listed in the manifest

Exit code 0 = all objects verified. Exit code 1 = mismatches detected.

---

## 3. Reconciliation (`migrate-reconcile.mjs`)

### Usage

```bash
node scripts/migrate-reconcile.mjs source-manifest.json target-manifest.json
```

Exit code 0 = no mismatches found.
Exit code 1 = content mismatches detected (count, digest, missing/extra rows, relational violations).
Exit code 2 = errors (malformed manifests, file not found).

### Checks performed

1. **Schema version** — both manifests must have the same schema version (currently 1)
2. **Table presence** — tables present in one but missing from the other are flagged
3. **Row counts** — per-table count comparison
4. **Row digests** — SHA-256 digest comparison row by row
5. **Missing/extra rows** — detected when row counts differ
6. **Foreign key orphans** — FK references that don't resolve within the manifest (warning)
7. **Relational integrity** — representative multi-table cross-references (e.g., sessions reference existing roles, transcripts reference existing sessions)

### Example: detecting drift

```bash
# Export current state
node scripts/migrate-export.mjs current-data.json current-manifest.json

# Export expected state (e.g., from backup or reference)
node scripts/migrate-export.mjs reference-data.json reference-manifest.json

# Reconcile
node scripts/migrate-reconcile.mjs current-manifest.json reference-manifest.json
```

---

## 4. Security requirements

### Encrypted temporary artifacts

Any temporary artifact that contains manifest data (which includes redacted row representations and digests) MUST be:

1. Written to a directory with `0700` permissions (owner-only access)
2. Deleted immediately after use via `rm -rf` or the temp directory cleanup
3. NOT committed to version control

For CI/CD pipelines, use ephemeral runners or temp directories created with `fs.mkdtemp()` / `mktemp -d`. Never write manifests to shared or world-readable paths.

### Hard stops for hosted/real data

These tools MUST NOT be used with:

1. **Production or staging database connections** — The tools read JSON files, not databases. No database URL or credentials should ever be passed.
2. **Real candidate data** — Only synthetic data from the GOV-06 namespace (`60000000-0000-4000-a000-XXXXXXXXXX`) is permitted.
3. **Production Supabase storage buckets** — The `storage-manifest.mjs` tool operates on local directories only. Never point it at `resumes_v2` or `recordings_v2` buckets containing actual resume files or call recordings.
4. **Network services or provider endpoints** — These tools perform zero network I/O. Any attempt to add network access is outside scope.

The Env Contract (`config/environment.schema.json`) and current-state manifest (`config/current-state.json`) enforce `"dataStage": "synthetic-only"` and `"status.production": "pre-production"` as machine-readable guards. The current-state drift checker (`scripts/check-current-state.mjs`) auto-fails if either invariant is violated.

---

## 5. Testing

### Unit tests

```bash
# Export tests (23 tests)
node scripts/migrate-export.test.mjs

# Reconcile tests (24 tests)
node scripts/migrate-reconcile.test.mjs

# Storage manifest tests (31 tests)
node scripts/storage-manifest.test.mjs

# Syntax checks
node --check scripts/migrate-export.mjs
node --check scripts/migrate-reconcile.mjs
node --check scripts/storage-manifest.mjs
```

All tests are deterministic, zero-network, and use synthetic fixtures only.

### Test coverage

- **Positive tests:** Empty data, single row, multiple rows, multiple tables, identical manifests, deterministic output
- **Negative tests:** Malformed manifests, unknown tables/columns, duplicate IDs, digest mismatches, count mismatches, missing/extra rows, orphan FKs, path traversal, symlinks, disallowed extensions, oversized files, invalid digests, duplicate keys

---

## 6. Known limitations (local implementation)

| Limitation | Impact | Mitigation |
|-----------|--------|------------|
| No live database reader | Must provide JSON input separately | A future `--db` mode could read from local Supabase |
| Sequence state not captured | Sequences are empty in output | Reserved for future use (post-MVP) |
| Storage manifest scans local dirs only | Cannot verify remote buckets | Out of scope for local tooling |
| Token digests redacted as "Secret" | Digest verification requires unredacted value | Run in isolated environment; redacted output is safe for logging |
| No encryption implemented | Artifacts are plain JSON | Encrypted temp artifact requirement is documented but not code-enforced |
| Reconcile compares rows by array index | Two logically-identical dumps in a different row order report spurious digest/extra-row mismatches | Both manifests must come from the same deterministic export; a future `--db` mode should sort/match rows by `id` |
| Relational/orphan checks skip an absent referenced table | If a referenced table is missing from a manifest entirely, its FK/orphan checks are silently skipped rather than failing | Always export the full dependency set together; treat a missing referenced table as a hard error in a future `--db` mode |

---

## 7. Integration with hosted acceptance testing

The local workflow (this runbook) is separate from hosted acceptance testing. When hosted Supabase projects are available for integration testing:

1. The export tool would receive a `--db` flag to read directly from the local Supabase instance
2. The storage manifest tool would add a `--bucket` flag for Supabase storage
3. Reconciliation would compare local export vs Supabase export
4. All PII redaction and classification rules from `docs/data-classification.md` remain in force
5. A new runbook (`docs/runbooks/hosted-export-reconcile.md`) would document the hosted workflow

The local tools do not require any shared secrets, database URLs, or provider endpoints. They serve as the deterministic foundation that hosted acceptance tests will build upon.
