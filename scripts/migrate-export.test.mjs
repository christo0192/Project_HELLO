#!/usr/bin/env node

/**
 * migrate-export.test.mjs — Deterministic tests for migrate-export.mjs
 *
 * Positive tests:
 *   - Valid synthetic data produces a well-formed manifest
 *   - Manifest contains expected tables, counts, digests
 *   - Digests are deterministic (same input → same output)
 *   - Redacted columns show [REDACTED] in output rows
 *
 * Negative (adversarial) tests:
 *   - Unknown table → fails closed
 *   - Unknown column → fails closed
 *   - Duplicate id → fails closed
 *   - Malformed id → fails closed
 *   - Invalid token_digest → fails closed
 *   - Unsupported schema_version → fails closed
 *   - Non-array input → fails closed
 *   - Missing rows array → fails closed
 *
 * Zero network, uses synthetic fixtures only.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

import {
  buildManifest,
  canonicalRow,
  rowDigest,
  TABLE_COLUMNS,
  ALLOWED_TABLES,
  SCHEMA_VERSION,
  MANIFEST_VERSION,
  REDACTED_COLUMNS,
} from "./migrate-export.mjs";

const projectRoot = process.cwd();
const scriptPath = path.join(projectRoot, "scripts/migrate-export.mjs");

// ===================================================================
// Synthetic fixtures — deterministic, no PII, GOV-06 namespace
// ===================================================================
const GOV06_IDS = {
  role: "60000000-0000-4000-a000-000000000001",
  resume: "60000000-0000-4000-a000-000000000010",
  candidate: "60000000-0000-4000-a000-000000000020",
  session: "60000000-0000-4000-a000-000000000030",
  turn1: "60000000-0000-4000-a000-000000000040",
  turn2: "60000000-0000-4000-a000-000000000041",
  assessment: "60000000-0000-4000-a000-000000000050",
  consent: "60000000-0000-4000-a000-000000000060",
};

const FIXED_TS = "2026-01-15T10:00:00Z";

function makeRoles() {
  return [
    {
      id: GOV06_IDS.role,
      title: "Synthetic Demo Test Engineer (fixture)",
      jd: "Synthetic fixture role for unit testing only.",
      required_skills: ["Python", "testing"],
      screening_template: [
        {
          id: "q1",
          question: "Describe a test strategy.",
          weight: 1.0,
          follow_up_hint: "coverage",
        },
      ],
      is_active: true,
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      owner_id: null,
    },
  ];
}

function makeResumes() {
  return [
    {
      id: GOV06_IDS.resume,
      file_path: null,
      file_name: "test-resume.pdf",
      mime_type: "application/pdf",
      text_extracted: "Synthetic resume text for testing purposes only.",
      parsed: { skills: ["Python", "testing"], experience: 3 },
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
    },
  ];
}

function makeCandidates() {
  return [
    {
      id: GOV06_IDS.candidate,
      role_id: GOV06_IDS.role,
      resume_id: GOV06_IDS.resume,
      name: "Fixture Candidate",
      email: "fixture@example.invalid",
      phone_raw: null,
      phone_e164: null,
      phone_valid: false,
      skills: ["Python", "testing"],
      experience_years: 3,
      parsed: { notes: "synthetic" },
      status: "new",
      consent_source: "fixture",
      consent_at: FIXED_TS,
      ats_external_id: null,
      ats_source: null,
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      owner_id: null,
    },
  ];
}

function makeCallSessions() {
  return [
    {
      id: GOV06_IDS.session,
      candidate_id: GOV06_IDS.candidate,
      role_id: GOV06_IDS.role,
      mode: "browser",
      provider: "pipecat",
      external_call_id: null,
      status: "completed",
      recording_url: null,
      recording_object_key: null,
      current_question_index: 3,
      started_at: FIXED_TS,
      ended_at: "2026-01-15T10:30:00Z",
      duration_sec: 1800,
      waiting_at: null,
      terminal_reason: "conversation_complete",
      owner_id: null,
      updated_at: "2026-01-15T10:30:00Z",
    },
  ];
}

function makeTranscriptTurns() {
  return [
    {
      id: GOV06_IDS.turn1,
      session_id: GOV06_IDS.session,
      turn_index: 0,
      speaker: "bot",
      text: "Hello, welcome to the screening.",
      created_at: FIXED_TS,
    },
    {
      id: GOV06_IDS.turn2,
      session_id: GOV06_IDS.session,
      turn_index: 1,
      speaker: "candidate",
      text: "Thank you, I am ready.",
      created_at: "2026-01-15T10:01:00Z",
    },
  ];
}

function makeAssessments() {
  return [
    {
      id: GOV06_IDS.assessment,
      session_id: GOV06_IDS.session,
      candidate_id: GOV06_IDS.candidate,
      english: { score: 8, fluency: "good" },
      tone: { score: 7, professional: "yes" },
      communication: null,
      motivation: null,
      role_fit: { score: 9, match: "strong" },
      resume_conflicts: null,
      overall_score: 80,
      recommendation: "advance",
      summary: "Synthetic assessment for testing.",
      raw: { scores: { english: 8, tone: 7, role_fit: 9 } },
      provenance: {
        schema_version: 1,
        provider: "anthropic",
        requestedModel: "claude-3-5-sonnet-20241022",
        workload: "scoring",
        prompt_template_version: "v2.1",
        timestamp: "2026-01-15T10:35:00Z",
      },
      created_at: "2026-01-15T10:35:00Z",
      updated_at: "2026-01-15T10:35:00Z",
    },
  ];
}

function makeConsentRecords() {
  return [
    {
      id: GOV06_IDS.consent,
      candidate_id: GOV06_IDS.candidate,
      source: "fixture",
      proof: { method: "test-consent", timestamp: FIXED_TS },
      created_at: FIXED_TS,
    },
  ];
}

function buildFullFixture() {
  return [
    { table: "roles", rows: makeRoles() },
    { table: "resumes", rows: makeResumes() },
    { table: "candidates", rows: makeCandidates() },
    { table: "call_sessions", rows: makeCallSessions() },
    { table: "transcript_turns", rows: makeTranscriptTurns() },
    { table: "assessments", rows: makeAssessments() },
    { table: "consent_records", rows: makeConsentRecords() },
  ];
}

// ===================================================================
// Positive tests
// ===================================================================

// 1. Valid fixture produces a well-formed manifest
{
  const manifest = buildManifest(buildFullFixture());
  assert.equal(manifest.manifest_version, MANIFEST_VERSION);
  assert.equal(manifest.schema_version, SCHEMA_VERSION);
  assert.ok(typeof manifest.generated_at === "string");
  assert.ok(manifest.generated_at.length > 0);
  assert.equal(Object.keys(manifest.tables).length, 7);
  assert.deepEqual(manifest.sequence_state, {});
  console.log("PASS: valid fixture produces well-formed manifest");
}

// 2. Table counts are correct
{
  const manifest = buildManifest(buildFullFixture());
  assert.equal(manifest.tables.roles.count, 1);
  assert.equal(manifest.tables.resumes.count, 1);
  assert.equal(manifest.tables.candidates.count, 1);
  assert.equal(manifest.tables.call_sessions.count, 1);
  assert.equal(manifest.tables.transcript_turns.count, 2);
  assert.equal(manifest.tables.assessments.count, 1);
  assert.equal(manifest.tables.consent_records.count, 1);
  console.log("PASS: table counts match");
}

// 3. Digests are deterministic (same input → same output twice)
{
  const m1 = buildManifest(buildFullFixture());
  const m2 = buildManifest(buildFullFixture());
  for (const t of Object.keys(m1.tables)) {
    assert.equal(m1.tables[t].digests.length, m2.tables[t].digests.length);
    for (let i = 0; i < m1.tables[t].digests.length; i++) {
      assert.equal(m1.tables[t].digests[i], m2.tables[t].digests[i]);
    }
  }
  console.log("PASS: digests are deterministic");
}

// 4. Redacted columns are obscured in output
{
  const manifest = buildManifest(buildFullFixture());
  for (const row of manifest.tables.candidates.rows) {
    assert.equal(row.row.name, "[REDACTED]");
    assert.equal(row.row.email, "[REDACTED]");
  }
  for (const row of manifest.tables.transcript_turns.rows) {
    assert.equal(row.row.text, "[REDACTED]");
  }
  for (const row of manifest.tables.assessments.rows) {
    assert.equal(row.row.summary, "[REDACTED]");
  }
  console.log("PASS: PII/PII-rich columns redacted in output");
}

// 5. Column lists in manifest match canonical
{
  const manifest = buildManifest(buildFullFixture());
  for (const [tableName, columns] of Object.entries(TABLE_COLUMNS)) {
    if (manifest.tables[tableName]) {
      assert.deepEqual(
        manifest.tables[tableName].columns,
        columns,
        `columns mismatch for ${tableName}`
      );
    }
  }
  console.log("PASS: manifest column lists match canonical");
}

// 6. All ALLOWED_TABLES can produce an empty table entry
{
  const entries = [];
  for (const t of ALLOWED_TABLES) {
    entries.push({ table: t, rows: [] });
  }
  const manifest = buildManifest(entries);
  assert.equal(Object.keys(manifest.tables).length, ALLOWED_TABLES.size);
  for (const t of ALLOWED_TABLES) {
    assert.equal(manifest.tables[t].count, 0);
  }
  console.log("PASS: all allowed tables accept empty rows");
}

// 7. Canonical row serialization produces consistent output
{
  const row = { b: 2, a: 1, c: 3 };
  const cols = ["a", "b", "c"];
  const canon = canonicalRow(row, cols);
  assert.equal(canon, '{"a":1,"b":2,"c":3}');
  console.log("PASS: canonical row serialization is sorted and compact");
}

// 8. Row digest is SHA-256 hex
{
  const row = { id: GOV06_IDS.role, title: "Test" };
  const cols = ["id", "title"];
  const digest = rowDigest(row, cols);
  assert.equal(digest.length, 64);
  assert.match(digest, /^[a-f0-9]{64}$/);
  console.log("PASS: row digest is SHA-256 hex string");
}

// ===================================================================
// Negative (adversarial) tests
// ===================================================================

// 9. Unknown table → fails closed
{
  assert.throws(
    () => {
      buildManifest([{ table: "unknown_table", rows: [{ id: "00000000-0000-0000-0000-000000000001" }] }]);
    },
    /E014/,
    "unknown table should throw E014"
  );
  console.log("PASS: unknown table fails closed (E014)");
}

// 10. Unknown column → fails closed
{
  assert.throws(
    () => {
      buildManifest([
        { table: "roles", rows: [{ id: GOV06_IDS.role, nonexistent_column: "boom" }] },
      ]);
    },
    /E002/,
    "unknown column should throw E002"
  );
  console.log("PASS: unknown column fails closed (E002)");
}

// 11. Duplicate id within same table → fails closed
{
  assert.throws(
    () => {
      buildManifest([
        {
          table: "roles",
          rows: [
            { id: GOV06_IDS.role, title: "dup1", required_skills: [], screening_template: [], is_active: true, created_at: FIXED_TS, updated_at: FIXED_TS },
            { id: GOV06_IDS.role, title: "dup2", required_skills: [], screening_template: [], is_active: true, created_at: FIXED_TS, updated_at: FIXED_TS },
          ],
        },
      ]);
    },
    /E016/,
    "duplicate id should throw E016"
  );
  console.log("PASS: duplicate id fails closed (E016)");
}

// 12. Malformed id → fails closed
{
  assert.throws(
    () => {
      buildManifest([
        { table: "roles", rows: [{ id: "not-a-uuid", title: "bad", required_skills: [], screening_template: [], is_active: true, created_at: FIXED_TS, updated_at: FIXED_TS }] },
      ]);
    },
    /E003/,
    "malformed id should throw E003"
  );
  console.log("PASS: malformed id fails closed (E003)");
}

// 13. Unsupported schema_version in preamble → fails closed
{
  assert.throws(
    () => {
      buildManifest([
        { _preamble: { schema_version: 999 } },
        { table: "roles", rows: [] },
      ]);
    },
    /E011/,
    "unsupported schema_version should throw E011"
  );
  console.log("PASS: unsupported schema_version fails closed (E011)");
}

// 14. Non-array input → fails closed via buildManifest
{
  assert.throws(
    () => {
      buildManifest("not-an-array");
    },
    /E010/,
    "non-array should throw E010"
  );
  console.log("PASS: non-array input fails closed (E010)");
}

// 15. Missing table field → fails closed
{
  assert.throws(
    () => {
      buildManifest([{ rows: [] }]);
    },
    /E013/,
    "missing table should throw E013"
  );
  console.log("PASS: missing table field fails closed (E013)");
}

// 16. Missing rows array → fails closed
{
  assert.throws(
    () => {
      buildManifest([{ table: "roles" }]);
    },
    /E015/,
    "missing rows should throw E015"
  );
  console.log("PASS: missing rows array fails closed (E015)");
}

// 17. Invalid token_digest in candidate_invites → fails closed
{
  assert.throws(
    () => {
      buildManifest([
        {
          table: "candidate_invites",
          rows: [
            {
              id: GOV06_IDS.consent,
              candidate_id: GOV06_IDS.candidate,
              token_digest: "not-64-hex-chars",
              expires_at: FIXED_TS,
              created_by: GOV06_IDS.role,
              created_at: FIXED_TS,
              updated_at: FIXED_TS,
            },
          ],
        },
      ]);
    },
    /E004/,
    "invalid token_digest should throw E004"
  );
  console.log("PASS: invalid token_digest fails closed (E004)");
}

// 18. Null id is allowed (for tables without id or omittable rows)
{
  const manifest = buildManifest([
    { table: "roles", rows: [{ id: null, title: "nullable-id-test", required_skills: [], screening_template: [], is_active: true, created_at: FIXED_TS, updated_at: FIXED_TS }] },
  ]);
  assert.equal(manifest.tables.roles.count, 1);
  console.log("PASS: null id is allowed (no exception)");
}

// ===================================================================
// CLI integration tests
// ===================================================================

async function withTempDir(fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "migrate-export-test-"));
  try {
    await fn(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// 19. CLI: valid input file produces manifest
await withTempDir(async (tmpDir) => {
  const inputPath = path.join(tmpDir, "input.json");
  const outputPath = path.join(tmpDir, "manifest.json");
  await writeFile(inputPath, JSON.stringify(buildFullFixture()));
  const result = spawnSync(process.execPath, [scriptPath, inputPath, outputPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);
  const manifest = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(manifest.manifest_version, MANIFEST_VERSION);
  assert.equal(manifest.tables.roles.count, 1);
  assert.equal(manifest.tables.transcript_turns.count, 2);
  console.log("PASS: CLI produces valid manifest file");
});

// 20. CLI: missing input file → exit 1
await withTempDir(async (tmpDir) => {
  const result = spawnSync(process.execPath, [scriptPath, "/nonexistent/input.json"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /E020/);
  console.log("PASS: CLI missing input fails closed (E020)");
});

// 21. CLI: malformed JSON → exit 1
await withTempDir(async (tmpDir) => {
  const inputPath = path.join(tmpDir, "bad.json");
  await writeFile(inputPath, "not json at all {{{");
  const result = spawnSync(process.execPath, [scriptPath, inputPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /E021/);
  console.log("PASS: CLI malformed JSON fails closed (E021)");
});

// 22. CLI: wrong input shape (not array) → exit 1
await withTempDir(async (tmpDir) => {
  const inputPath = path.join(tmpDir, "scalar.json");
  await writeFile(inputPath, JSON.stringify("hello"));
  const result = spawnSync(process.execPath, [scriptPath, inputPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /E022/);
  console.log("PASS: CLI non-array input fails closed (E022)");
});

// 23. CLI: support { data: [...], _preamble: {...} } envelope
await withTempDir(async (tmpDir) => {
  const inputPath = path.join(tmpDir, "envelope.json");
  const envelope = {
    _preamble: { schema_version: SCHEMA_VERSION, description: "test envelope" },
    data: buildFullFixture(),
  };
  await writeFile(inputPath, JSON.stringify(envelope));
  const result = spawnSync(process.execPath, [scriptPath, inputPath, path.join(tmpDir, "out.json")], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `envelope CLI failed: ${result.stderr}`);
  const manifest = JSON.parse(await readFile(path.join(tmpDir, "out.json"), "utf8"));
  assert.equal(manifest.tables.roles.count, 1);
  console.log("PASS: CLI envelope format accepted");
});

// ===================================================================
// Summary
// ===================================================================
console.log("\nAll migrate-export tests passed.");
