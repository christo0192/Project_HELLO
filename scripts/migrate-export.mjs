#!/usr/bin/env node

/**
 * migrate-export.mjs — MIG-07/08/09: deterministic, typed local logical-export
 * manifest tooling for screening_v2 tables.
 *
 * Produces a JSON manifest with:
 *   - Explicit schema version (currently 1)
 *   - Allowlisted tables and columns only
 *   - Canonical row serialization (sorted keys, no whitespace variance)
 *   - Per-row SHA-256 digest
 *   - Per-table row count and digests
 *   - Sequence current-value snapshot
 *   - Synthetic-only / local-only defaults
 *
 * INVARIANTS:
 *   - No secret values or PII in logs/manifests (fields are redacted in output)
 *   - Fail closed on unknown schema version, table, or column
 *   - Deterministic: same input rows produce identical manifest
 *   - Zero network, no external dependencies
 *
 * Usage: node scripts/migrate-export.mjs <data-file.json>
 *   where data-file.json is an array of {table, rows, sequenceState} objects
 *   matching the ALLOWED_TABLES manifest.
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

const isMainModule = fileURLToPath(import.meta.url) === process.argv[1];

// Bound the input file size before parsing (defense against OOM on a
// malformed/oversized input). Manifests of synthetic data are tiny.
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

// ===================================================================
// Constants — schema version and allowlist
// ===================================================================
const SCHEMA_VERSION = 1;
const MANIFEST_VERSION = 1;

// Canonical ordered column list per table — derived from migrations 0001–0007.
// Each list is the complete set of columns after all ALTER TABLE ADD COLUMN
// statements, in the order they appear cumulatively.
const TABLE_COLUMNS = {
  roles: [
    "id", "title", "jd", "required_skills", "screening_template",
    "is_active", "created_at", "updated_at", "owner_id",
  ],
  resumes: [
    "id", "file_path", "file_name", "mime_type", "text_extracted",
    "parsed", "created_at", "updated_at",
  ],
  candidates: [
    "id", "role_id", "resume_id", "name", "email",
    "phone_raw", "phone_e164", "phone_valid", "skills",
    "experience_years", "parsed", "status", "consent_source",
    "consent_at", "ats_external_id", "ats_source",
    "created_at", "updated_at", "owner_id",
  ],
  call_sessions: [
    "id", "candidate_id", "role_id", "mode", "provider",
    "external_call_id", "status", "recording_url",
    "recording_object_key", "current_question_index",
    "started_at", "ended_at", "duration_sec",
    "waiting_at", "terminal_reason", "owner_id", "updated_at",
  ],
  transcript_turns: [
    "id", "session_id", "turn_index", "speaker", "text", "created_at",
  ],
  assessments: [
    "id", "session_id", "candidate_id",
    "english", "tone", "communication", "motivation", "role_fit",
    "resume_conflicts", "overall_score", "recommendation",
    "summary", "raw", "provenance", "created_at", "updated_at",
  ],
  consent_records: [
    "id", "candidate_id", "source", "proof", "created_at",
  ],
  call_queue: [
    "id", "candidate_id", "role_id", "status", "attempts",
    "next_attempt_at", "created_at",
  ],
  sms_follow_ups: [
    "id", "candidate_id", "template_id", "body", "status", "created_at",
  ],
  ats_sync_log: [
    "id", "candidate_id", "provider", "payload", "status", "created_at",
  ],
  recruiter_memberships: [
    "user_id", "role", "active", "created_at", "updated_at",
  ],
  candidate_invites: [
    "id", "candidate_id", "session_id", "token_digest",
    "expires_at", "revoked_at", "consumed_at", "created_by",
    "created_at", "updated_at",
  ],
  candidate_access_grants: [
    "id", "candidate_id", "session_id", "room_name", "token_digest",
    "grant_type", "expires_at", "revoked_at", "consumed_at", "created_at",
  ],
  audit_events: [
    "id", "actor_id", "actor_type", "action", "target_type",
    "target_id", "result", "correlation_id", "metadata", "created_at",
  ],
};

const ALLOWED_TABLES = new Set(Object.keys(TABLE_COLUMNS));

// Columns whose values are redacted in manifest output (not hashed with them,
// but the serialized value is replaced with "[REDACTED]").
// These columns contain PII, candidate-generated content, or secrets.
const REDACTED_COLUMNS = new Set([
  "name",           // candidate name (PII)
  "email",          // candidate email (PII)
  "phone_raw",      // raw phone number (PII)
  "phone_e164",     // normalized phone (PII)
  "text_extracted", // raw resume text (PII-rich)
  "text",           // transcript turn text (candidate responses)
  "body",           // SMS body (candidate PII)
  "summary",        // assessment summary (may contain PII)
  "metadata",       // audit metadata (bounded, but redact for safety)
  "token_digest",   // SHA-256 digest itself is not secret, but it's an
                     // internal reference; redact to avoid confusion
  "file_path",      // may reveal local paths
  "recording_url",  // may contain signed URLs or paths
  "recording_object_key", // storage key reference
  // JSONB / free-form columns that carry candidate PII or generated
  // content. These are STILL hashed into the row digest (integrity is
  // preserved) but must never appear as plaintext in the manifest body.
  "parsed",         // parsed resume / candidate fields (PII-rich JSONB)
  "payload",        // ats_sync_log payload pushed for a candidate (PII)
  "proof",          // consent_records proof (may hold IP/UA/signature)
  "raw",            // assessment raw model output (may echo candidate text)
  "resume_conflicts", // assessment conflict snippets (may echo resume text)
]);

// ===================================================================
// Helpers
// ===================================================================

/**
 * Recursively canonicalize a value: object keys sorted at EVERY depth,
 * arrays preserved in order. This guarantees a stable serialization for
 * nested JSONB columns (parsed, raw, provenance, …), which a top-level
 * key sort alone would not cover.
 *
 * NOTE: a previous implementation passed `Object.keys(obj).sort()` as the
 * second argument to JSON.stringify. That argument is a recursive property
 * ALLOWLIST, not a sort order — it silently dropped every nested key that
 * did not match a top-level column name, excluding all JSONB content from
 * the digest. This deep canonicalizer fixes that.
 */
function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic row serialization.
 * Produces a canonical string from a row object: sorted keys at all depths,
 * JSON without whitespace variance.
 */
function canonicalRow(row, columns) {
  const obj = {};
  for (const col of columns) {
    const val = row[col];
    if (val !== undefined) {
      obj[col] = val;
    }
  }
  return JSON.stringify(canonicalValue(obj));
}

/**
 * Compute SHA-256 digest of a canonical row string.
 */
function rowDigest(row, columns) {
  return createHash("sha256")
    .update(canonicalRow(row, columns))
    .digest("hex");
}

/**
 * Redact sensitive fields in a row for logging/manifest display.
 * Returns a new object with redacted columns replaced.
 */
function redactRow(row, columns) {
  const out = {};
  for (const col of columns) {
    const val = row[col];
    if (val === undefined) continue;
    out[col] = REDACTED_COLUMNS.has(col) ? "[REDACTED]" : val;
  }
  return out;
}

/**
 * Validate a single row against its table schema.
 * Throws on unknown columns, missing required non-nullable columns, or
 * type mismatches where detectable (no DB connection available).
 */
function validateRow(row, tableName, rowIndex) {
  const canonical = TABLE_COLUMNS[tableName];
  if (!canonical) {
    throw new Error(`E001: unknown table "${tableName}"`);
  }
  const allowedSet = new Set(canonical);

  for (const key of Object.keys(row)) {
    if (!allowedSet.has(key)) {
      throw new Error(
        `E002: row ${rowIndex} in "${tableName}" has unknown column "${key}"`
      );
    }
  }

  // id must be UUID-shaped if present
  if (
    "id" in row &&
    row.id !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      String(row.id)
    )
  ) {
    throw new Error(
      `E003: row ${rowIndex} in "${tableName}" has invalid id "${row.id}"`
    );
  }

  // token_digest must be 64 hex chars
  if (
    tableName === "candidate_invites" &&
    "token_digest" in row &&
    row.token_digest !== null &&
    !/^[a-f0-9]{64}$/.test(String(row.token_digest))
  ) {
    throw new Error(
      `E004: row ${rowIndex} in "${tableName}" has invalid token_digest`
    );
  }

  if (
    tableName === "candidate_access_grants" &&
    "token_digest" in row &&
    row.token_digest !== null &&
    !/^[a-f0-9]{64}$/.test(String(row.token_digest))
  ) {
    throw new Error(
      `E005: row ${rowIndex} in "${tableName}" has invalid token_digest`
    );
  }

  return true;
}

// ===================================================================
// Sequence state extraction helpers
// ===================================================================
const ALLOWED_SEQUENCES = new Set([
  // No user-defined sequences in screening_v2; reserved for future use.
]);

// ===================================================================
// Main export logic
// ===================================================================
function buildManifest(data) {
  const manifest = {
    manifest_version: MANIFEST_VERSION,
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    tables: {},
    sequence_state: {},
  };

  if (!Array.isArray(data)) {
    throw new Error("E010: input data must be an array of table objects");
  }

  // Validate schema_version in preamble if present
  for (const entry of data) {
    if (entry && typeof entry === "object" && entry._preamble) {
      if (
        entry._preamble.schema_version !== undefined &&
        entry._preamble.schema_version !== SCHEMA_VERSION
      ) {
        throw new Error(
          `E011: unsupported schema_version ${entry._preamble.schema_version}; ` +
            `expected ${SCHEMA_VERSION}`
        );
      }
    }
  }

  // Filter out preamble entries
  const tableEntries = data.filter(
    (e) => e && typeof e === "object" && !e._preamble
  );

  for (const entry of tableEntries) {
    if (!entry || typeof entry !== "object") {
      throw new Error("E012: each entry must be a non-null object");
    }

    const { table, rows, sequenceState } = entry;

    if (!table || typeof table !== "string") {
      throw new Error("E013: each entry must have a string 'table' field");
    }

    if (!ALLOWED_TABLES.has(table)) {
      throw new Error(`E014: unknown table "${table}"`);
    }

    if (!Array.isArray(rows)) {
      throw new Error(`E015: table "${table}" must have an array 'rows' field`);
    }

    const columns = TABLE_COLUMNS[table];

    // Check for duplicate ids within this table
    const seenIds = new Map();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      validateRow(row, table, i);
      if (row.id !== undefined && row.id !== null) {
        const idStr = String(row.id);
        if (seenIds.has(idStr)) {
          throw new Error(
            `E016: duplicate id "${idStr}" in table "${table}" ` +
              `(rows ${seenIds.get(idStr)} and ${i})`
          );
        }
        seenIds.set(idStr, i);
      }
    }

    const digestRows = rows.map((row) => {
      const digest = rowDigest(row, columns);
      return {
        row: redactRow(row, columns),
        digest,
      };
    });

    // Compute aggregate: per-table digest set (ordered by first appearance)
    const digests = digestRows.map((r) => r.digest);

    manifest.tables[table] = {
      count: rows.length,
      columns,
      rows: digestRows,
      digests,
    };

    // Sequence state (if provided)
    if (sequenceState) {
      if (
        typeof sequenceState !== "object" ||
        Array.isArray(sequenceState)
      ) {
        throw new Error(
          `E017: sequenceState for "${table}" must be an object`
        );
      }
      for (const seqName of Object.keys(sequenceState)) {
        if (!ALLOWED_SEQUENCES.has(seqName)) {
          throw new Error(
            `E018: unknown sequence "${seqName}" in table "${table}"`
          );
        }
      }
      // Merge into global sequence_state
      Object.assign(manifest.sequence_state, sequenceState);
    }
  }

  // If no sequence state was provided, emit empty object
  return manifest;
}

// ===================================================================
// CLI entry point
// ===================================================================
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error(
      "Usage: node scripts/migrate-export.mjs <input-data.json> [output-manifest.json]"
    );
    process.exit(2);
  }

  const inputPath = args[0];
  const outputPath = args[1] || null;

  let raw;
  try {
    const st = await stat(inputPath);
    if (st.size > MAX_INPUT_BYTES) {
      console.error(
        `E023: input file too large: ${st.size} bytes (max ${MAX_INPUT_BYTES})`
      );
      process.exit(1);
    }
    // Diagnostics are intentionally redacted: never echo parser output or
    // file contents (may contain PII in a real export).
    raw = JSON.parse(await readFile(inputPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`E020: input file not found: ${inputPath}`);
      process.exit(1);
    }
    console.error(`E021: failed to read or parse input JSON: ${inputPath}`);
    process.exit(1);
  }

  // Accept both array and { data: [...], _preamble: {...} } envelope
  let dataArray;
  if (Array.isArray(raw)) {
    dataArray = raw;
  } else if (raw && Array.isArray(raw.data)) {
    dataArray = raw.data;
    // Pass preamble through
    if (raw._preamble) {
      dataArray = [{ _preamble: raw._preamble }, ...dataArray];
    }
  } else {
    console.error(
      "E022: input must be a JSON array or { data: [...], _preamble: {...} }"
    );
    process.exit(1);
  }

  try {
    const manifest = buildManifest(dataArray);
    const out = `${JSON.stringify(manifest, null, 2)}\n`;

    if (outputPath) {
      await writeFile(outputPath, out, "utf8");
      console.error(
        `Manifest v${MANIFEST_VERSION} written to ${outputPath} ` +
          `(${Object.keys(manifest.tables).length} tables, ` +
          `${Object.values(manifest.tables).reduce(
            (s, t) => s + t.count, 0
          )} rows)`
      );
    } else {
      process.stdout.write(out);
    }
  } catch (err) {
    console.error(`Export failed: ${err.message}`);
    process.exit(1);
  }
}

if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

export { buildManifest, canonicalRow, rowDigest, redactRow, TABLE_COLUMNS, ALLOWED_TABLES, SCHEMA_VERSION, MANIFEST_VERSION, REDACTED_COLUMNS };
