#!/usr/bin/env node

/**
 * migrate-reconcile.test.mjs — Deterministic tests for migrate-reconcile.mjs
 *
 * Positive tests:
 *   - Identical manifests → clean reconciliation
 *   - Empty manifests → clean reconciliation
 *   - Different table subsets → mismatches reported
 *
 * Negative (adversarial) tests:
 *   - Count mismatch → detected as failure
 *   - Digest mismatch → detected as failure
 *   - Missing row → detected as failure
 *   - Extra row → detected as failure
 *   - Orphan FK → detected as warning
 *   - Relational violation → detected as failure
 *   - Malformed manifest → fails closed with error
 *   - Unsupported schema_version → fails closed
 *   - Missing required field → fails closed
 *   - count/rows.length mismatch → fails closed
 *
 * Zero network, uses synthetic fixtures only.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { reconcile, Report, validateManifest } from "./migrate-reconcile.mjs";
import { rowDigest, TABLE_COLUMNS } from "./migrate-export.mjs";

const projectRoot = process.cwd();
const scriptPath = path.join(projectRoot, "scripts/migrate-reconcile.mjs");

// ===================================================================
// Helpers
// ===================================================================
const SCHEMA_VERSION = 1;
const FIXED_TS = "2026-01-15T10:00:00Z";
const ROLE_ID = "60000000-0000-4000-a000-000000000001";
const CAND_ID = "60000000-0000-4000-a000-000000000020";
const SESS_ID = "60000000-0000-4000-a000-000000000030";

/** Create a full role row with all canonical columns */
function fullRoleRow(id, overrides = {}) {
  return {
    id,
    title: "Test Role",
    jd: null,
    required_skills: [],
    screening_template: [],
    is_active: true,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    owner_id: null,
    ...overrides,
  };
}

/** Create a full candidate row with all canonical columns */
function fullCandidateRow(id, overrides = {}) {
  return {
    id,
    role_id: null,
    resume_id: null,
    name: "Test Candidate",
    email: "test@example.invalid",
    phone_raw: null,
    phone_e164: null,
    phone_valid: false,
    skills: [],
    experience_years: null,
    parsed: null,
    status: "new",
    consent_source: "test",
    consent_at: null,
    ats_external_id: null,
    ats_source: null,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    owner_id: null,
    ...overrides,
  };
}

/**
 * Build a valid manifest for testing.
 * Uses the canonical TABLE_COLUMNS for each table to compute real digests.
 */
function makeManifest(tables) {
  const result = {
    manifest_version: 1,
    schema_version: SCHEMA_VERSION,
    generated_at: FIXED_TS,
    tables: {},
    sequence_state: {},
  };
  for (const [tableName, data] of Object.entries(tables)) {
    const columns = TABLE_COLUMNS[tableName] || data.columns || Object.keys(data.rows[0] || {});
    const rows = data.rows;
    const digests = rows.map((r) => {
      // Support explicit digest override for testing
      if (data.forcedDigests && data.forcedDigests[rows.indexOf(r)]) {
        return data.forcedDigests[rows.indexOf(r)];
      }
      return rowDigest(r, columns);
    });
    result.tables[tableName] = {
      count: rows.length,
      rows: rows.map((r, i) => ({ row: r, digest: digests[i] })),
      digests,
      columns,
    };
  }
  return result;
}

// ===================================================================
// Positive tests
// ===================================================================

// 1. Identical manifests → clean
{
  const m1 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  const m2 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  const report = reconcile(m1, m2);
  assert.equal(report.mismatches.length, 0);
  assert.equal(report.errors.length, 0);
  assert.equal(report.hasFailures, false);
  console.log("PASS: identical manifests → clean");
}

// 2. Empty manifests → clean
{
  const m1 = makeManifest({});
  const m2 = makeManifest({});
  const report = reconcile(m1, m2);
  assert.equal(report.mismatches.length, 0);
  assert.equal(report.errors.length, 0);
  console.log("PASS: empty manifests → clean");
}

// 3. Same content across tables → clean
{
  const m1 = makeManifest({
    roles: { rows: [fullRoleRow(ROLE_ID, { title: "R1" })] },
    candidates: { rows: [fullCandidateRow(CAND_ID, { name: "C1", role_id: ROLE_ID })] },
  });
  const m2 = makeManifest({
    roles: { rows: [fullRoleRow(ROLE_ID, { title: "R1" })] },
    candidates: { rows: [fullCandidateRow(CAND_ID, { name: "C1", role_id: ROLE_ID })] },
  });
  const report = reconcile(m1, m2);
  assert.equal(report.mismatches.length, 0);
  assert.equal(report.errors.length, 0);
  console.log("PASS: same content across tables → clean");
}

// ===================================================================
// Negative (adversarial) tests
// ===================================================================

// 4. Count mismatch → detected
{
  const m1 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  const m2 = makeManifest({
    roles: { rows: [fullRoleRow(ROLE_ID), fullRoleRow("60000000-0000-4000-a000-000000000099", { title: "R2" })] },
  });
  const report = reconcile(m1, m2);
  assert.ok(report.hasFailures);
  assert.ok(report.mismatches.some((m) => m.category === "COUNT"));
  console.log("PASS: count mismatch → detected (COUNT)");
}

// 5. Digest mismatch → detected
{
  const m1 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  const m2 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID, { title: "Different Title" })] } });
  const report = reconcile(m1, m2);
  assert.ok(report.hasFailures);
  assert.ok(report.mismatches.some((m) => m.category === "DIGEST"));
  console.log("PASS: digest mismatch → detected (DIGEST)");
}

// 6. Missing row in target → detected
{
  const m1 = makeManifest({
    roles: { rows: [fullRoleRow(ROLE_ID), fullRoleRow("60000000-0000-4000-a000-000000000099", { title: "R2" })] },
  });
  const m2 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  const report = reconcile(m1, m2);
  assert.ok(report.hasFailures);
  assert.ok(report.mismatches.some((m) => m.category === "ROW_EXTRA_IN_SOURCE"));
  console.log("PASS: extra row in source → detected (ROW_EXTRA_IN_SOURCE)");
}

// 7. Extra row in target → detected
{
  const m1 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  const m2 = makeManifest({
    roles: { rows: [fullRoleRow(ROLE_ID), fullRoleRow("60000000-0000-4000-a000-000000000099", { title: "R2" })] },
  });
  const report = reconcile(m1, m2);
  assert.ok(report.hasFailures);
  assert.ok(report.mismatches.some((m) => m.category === "ROW_EXTRA_IN_TARGET"));
  console.log("PASS: extra row in target → detected (ROW_EXTRA_IN_TARGET)");
}

// 8. Missing table in target → detected
{
  const m1 = makeManifest({
    roles: { rows: [fullRoleRow(ROLE_ID)] },
    candidates: { rows: [fullCandidateRow(CAND_ID)] },
  });
  const m2 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  const report = reconcile(m1, m2);
  assert.ok(report.mismatches.some((m) => m.category === "TABLE_MISSING_IN_TARGET"));
  console.log("PASS: missing table in target → detected (TABLE_MISSING_IN_TARGET)");
}

// 9. Orphan FK warning — candidate references role that doesn't exist
{
  const m = makeManifest({
    roles: { rows: [] },
    candidates: { rows: [fullCandidateRow(CAND_ID, { role_id: "00000000-0000-0000-0000-000000009999" })] },
  });
  const report = reconcile(m, m);
  // Same manifest, so orphans exist in both source and target
  assert.ok(report.warnings.some((w) => w.category === "ORPHAN_IN_SOURCE"), "expected ORPHAN_IN_SOURCE");
  assert.ok(report.warnings.some((w) => w.category === "ORPHAN_IN_TARGET"), "expected ORPHAN_IN_TARGET");
  console.log("PASS: orphan FK → warning (ORPHAN_IN_SOURCE / ORPHAN_IN_TARGET)");
}

// 10. Count mismatch with empty target → detected
{
  const m1 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  const m2 = makeManifest({ roles: { rows: [] } });
  const report = reconcile(m1, m2);
  assert.ok(report.hasFailures);
  assert.ok(report.mismatches.some((m) => m.category === "COUNT"));
  console.log("PASS: empty target count mismatch → detected (COUNT)");
}

// 11. Malformed manifest (null) → error
{
  assert.throws(
    () => validateManifest(null, "null"),
    /R001/
  );
  console.log("PASS: null manifest → R001");
}

// 12. Unsupported schema_version → error
{
  assert.throws(
    () => validateManifest({ schema_version: 999, tables: {} }, "bad"),
    /R002/
  );
  console.log("PASS: unsupported schema_version → R002");
}

// 13. Missing tables field → error
{
  assert.throws(
    () => validateManifest({ schema_version: SCHEMA_VERSION }, "missing"),
    /R003/
  );
  console.log("PASS: missing tables → R003");
}

// 14. Missing count in table → error
{
  const m = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  delete m.tables.roles.count;
  assert.throws(
    () => validateManifest(m, "test"),
    /R005/
  );
  console.log("PASS: missing count → R005");
}

// 15. Missing rows array → error
{
  const m = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  delete m.tables.roles.rows;
  assert.throws(
    () => validateManifest(m, "test"),
    /R006/
  );
  console.log("PASS: missing rows → R006");
}

// 16. Missing digests array → error
{
  const m = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  delete m.tables.roles.digests;
  assert.throws(
    () => validateManifest(m, "test"),
    /R007/
  );
  console.log("PASS: missing digests → R007");
}

// 17. count != rows.length → error
{
  const m = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  m.tables.roles.count = 999;
  assert.throws(
    () => validateManifest(m, "test"),
    /R008/
  );
  console.log("PASS: count != rows.length → R008");
}

// 18. count != digests.length → error
{
  const m = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  m.tables.roles.digests = [];
  assert.throws(
    () => validateManifest(m, "test"),
    /R009/
  );
  console.log("PASS: count != digests.length → R009");
}

// 19. Schema version mismatch → fails closed as VALIDATION error
{
  const m1 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  const m2 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  m2.schema_version = 2;
  const report = reconcile(m1, m2);
  assert.ok(report.errors.some((e) => e.category === "VALIDATION"), "expected VALIDATION error on schema version mismatch");
  assert.ok(report.hasFailures, "schema version mismatch must produce failure");
  console.log("PASS: schema version mismatch → fails closed (VALIDATION)");
}

// ===================================================================
// CLI integration tests
// ===================================================================

async function withTempDir(fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "migrate-reconcile-test-"));
  try {
    await fn(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// 20. CLI: identical manifests → exit 0
await withTempDir(async (tmpDir) => {
  const srcPath = path.join(tmpDir, "src.json");
  const tgtPath = path.join(tmpDir, "tgt.json");
  const m = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  await writeFile(srcPath, JSON.stringify(m));
  await writeFile(tgtPath, JSON.stringify(m));
  const result = spawnSync(process.execPath, [scriptPath, srcPath, tgtPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  console.log("PASS: CLI identical manifests → exit 0");
});

// 21. CLI: different manifests → exit 1 with DIGEST
await withTempDir(async (tmpDir) => {
  const srcPath = path.join(tmpDir, "src.json");
  const tgtPath = path.join(tmpDir, "tgt.json");
  const m1 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } });
  const m2 = makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID, { title: "Changed" })] } });
  await writeFile(srcPath, JSON.stringify(m1));
  await writeFile(tgtPath, JSON.stringify(m2));
  const result = spawnSync(process.execPath, [scriptPath, srcPath, tgtPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DIGEST/);
  console.log("PASS: CLI different manifests → exit 1 with DIGEST");
});

// 22. CLI: missing file → exit 1
await withTempDir(async (tmpDir) => {
  const result = spawnSync(process.execPath, [scriptPath, "/nonexistent/a.json", "/nonexistent/b.json"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /R020/);
  console.log("PASS: CLI missing file → exit 1 (R020)");
});

// 23. CLI: malformed source → exit 1
await withTempDir(async (tmpDir) => {
  const srcPath = path.join(tmpDir, "bad.json");
  const tgtPath = path.join(tmpDir, "good.json");
  await writeFile(srcPath, "{{{bad json}}}");
  await writeFile(tgtPath, JSON.stringify(makeManifest({ roles: { rows: [fullRoleRow(ROLE_ID)] } })));
  const result = spawnSync(process.execPath, [scriptPath, srcPath, tgtPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /R021/);
  console.log("PASS: CLI malformed source → exit 1 (R021)");
});

// 24. CLI: wrong argument count → exit 2
{
  const result = spawnSync(process.execPath, [scriptPath, "only-one.json"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage/);
  console.log("PASS: CLI wrong arg count → exit 2");
}

// ===================================================================
// Summary
// ===================================================================
console.log("\nAll migrate-reconcile tests passed.");
