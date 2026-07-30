#!/usr/bin/env node

/**
 * migrate-reconcile.mjs — MIG-09: Reconciliation tooling for screening_v2
 * logical-export manifests.
 *
 * Compares two manifests (source and target) and reports:
 *   - Row count mismatches per table
 *   - Digest mismatches per row (redacted; no PII in output)
 *   - Missing rows in source or target
 *   - Orphan diagnostics: FK references that don't resolve
 *   - Representative relational checks (multi-table cross-references)
 *
 * INVARIANTS:
 *   - Fail closed on malformed manifests (missing required fields)
 *   - All diagnostic output redacts PII — uses row index and table name only
 *   - Deterministic: same two manifests produce identical reconciliation
 *   - Zero network, no external dependencies
 *
 * Usage:
 *   node scripts/migrate-reconcile.mjs <source-manifest.json> <target-manifest.json>
 *   Returns 0 if no mismatches, 1 if mismatches found, 2 on error.
 */

import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const isMainModule = fileURLToPath(import.meta.url) === process.argv[1];

// Bound each manifest file size before parsing (defense against OOM).
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/**
 * Read and parse a manifest JSON file with a size bound and redacted
 * diagnostics (never echo parser output / file contents). Returns the
 * parsed object; throws a coded Error on ENOENT / oversize / parse error.
 */
async function readManifestBounded(filePath, notFoundCode, parseCode) {
  let st;
  try {
    st = await stat(filePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      const e = new Error(`${notFoundCode}: file not found: ${filePath}`);
      e.exitCode = 1;
      throw e;
    }
    const e = new Error(`${parseCode}: failed to read manifest: ${filePath}`);
    e.exitCode = 1;
    throw e;
  }
  if (st.size > MAX_MANIFEST_BYTES) {
    const e = new Error(
      `${parseCode}: manifest file too large: ${st.size} bytes (max ${MAX_MANIFEST_BYTES})`
    );
    e.exitCode = 1;
    throw e;
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    const e = new Error(`${parseCode}: failed to parse manifest JSON: ${filePath}`);
    e.exitCode = 1;
    throw e;
  }
}

// ===================================================================
// Constants
// ===================================================================
const SCHEMA_VERSION = 1;

// Tables with FK references for orphan detection
// Format: { table, fkColumn, referencedTable, referencedColumn (usually "id") }
const FK_RELATIONS = [
  { table: "candidates", fkColumn: "role_id", referencedTable: "roles" },
  { table: "candidates", fkColumn: "resume_id", referencedTable: "resumes" },
  { table: "call_sessions", fkColumn: "candidate_id", referencedTable: "candidates" },
  { table: "call_sessions", fkColumn: "role_id", referencedTable: "roles" },
  { table: "transcript_turns", fkColumn: "session_id", referencedTable: "call_sessions" },
  { table: "assessments", fkColumn: "session_id", referencedTable: "call_sessions" },
  { table: "assessments", fkColumn: "candidate_id", referencedTable: "candidates" },
  { table: "consent_records", fkColumn: "candidate_id", referencedTable: "candidates" },
  { table: "call_queue", fkColumn: "candidate_id", referencedTable: "candidates" },
  { table: "call_queue", fkColumn: "role_id", referencedTable: "roles" },
  { table: "sms_follow_ups", fkColumn: "candidate_id", referencedTable: "candidates" },
  { table: "ats_sync_log", fkColumn: "candidate_id", referencedTable: "candidates" },
  { table: "candidate_invites", fkColumn: "candidate_id", referencedTable: "candidates" },
  { table: "candidate_invites", fkColumn: "session_id", referencedTable: "call_sessions" },
  { table: "candidate_access_grants", fkColumn: "candidate_id", referencedTable: "candidates" },
  { table: "candidate_access_grants", fkColumn: "session_id", referencedTable: "call_sessions" },
];

// Representative relational checks
const RELATIONAL_CHECKS = [
  {
    name: "sessions reference existing roles",
    table: "call_sessions",
    fkColumn: "role_id",
    referencedTable: "roles",
  },
  {
    name: "transcripts reference existing sessions",
    table: "transcript_turns",
    fkColumn: "session_id",
    referencedTable: "call_sessions",
  },
  {
    name: "assessments reference existing sessions",
    table: "assessments",
    fkColumn: "session_id",
    referencedTable: "call_sessions",
  },
  {
    name: "assessments reference existing candidates",
    table: "assessments",
    fkColumn: "candidate_id",
    referencedTable: "candidates",
  },
];

// ===================================================================
// Validators
// ===================================================================

function validateManifest(manifest, label) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`R001: ${label} is not a valid manifest object`);
  }
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `R002: ${label} has unsupported schema_version ${manifest.schema_version}; ` +
        `expected ${SCHEMA_VERSION}`
    );
  }
  if (!manifest.tables || typeof manifest.tables !== "object") {
    throw new Error(`R003: ${label} is missing 'tables' object`);
  }
  for (const [tableName, tableData] of Object.entries(manifest.tables)) {
    if (!tableData || typeof tableData !== "object") {
      throw new Error(`R004: ${label} table "${tableName}" is not an object`);
    }
    if (typeof tableData.count !== "number") {
      throw new Error(`R005: ${label} table "${tableName}" missing numeric 'count'`);
    }
    if (!Array.isArray(tableData.rows)) {
      throw new Error(`R006: ${label} table "${tableName}" missing 'rows' array`);
    }
    if (!Array.isArray(tableData.digests)) {
      throw new Error(`R007: ${label} table "${tableName}" missing 'digests' array`);
    }
    if (tableData.count !== tableData.rows.length) {
      throw new Error(
        `R008: ${label} table "${tableName}" count (${tableData.count}) != rows.length (${tableData.rows.length})`
      );
    }
    if (tableData.count !== tableData.digests.length) {
      throw new Error(
        `R009: ${label} table "${tableName}" count (${tableData.count}) != digests.length (${tableData.digests.length})`
      );
    }
  }
}

// ===================================================================
// Build lookup maps
// ===================================================================
function buildIdMap(manifest) {
  const map = {};
  for (const [tableName, tableData] of Object.entries(manifest.tables)) {
    map[tableName] = new Map();
    for (let i = 0; i < tableData.rows.length; i++) {
      const row = tableData.rows[i].row;
      if (row.id !== undefined && row.id !== null) {
        map[tableName].set(String(row.id), { index: i, digest: tableData.digests[i], row });
      }
    }
  }
  return map;
}

// ===================================================================
// Reconciliation logic
// ===================================================================

class Report {
  constructor() {
    this.mismatches = [];
    this.warnings = [];
    this.errors = [];
  }

  addMismatch(category, message) {
    this.mismatches.push({ category, message });
  }

  addWarning(category, message) {
    this.warnings.push({ category, message });
  }

  addError(category, message) {
    this.errors.push({ category, message });
  }

  get hasFailures() {
    return this.mismatches.length > 0 || this.errors.length > 0;
  }

  print() {
    for (const e of this.errors) {
      console.error(`ERROR  [${e.category}]: ${e.message}`);
    }
    for (const m of this.mismatches) {
      console.error(`FAIL   [${m.category}]: ${m.message}`);
    }
    for (const w of this.warnings) {
      console.warn(`WARN   [${w.category}]: ${w.message}`);
    }
  }

  summary(sourceLabel, targetLabel) {
    const parts = [
      `Reconciliation: ${sourceLabel} vs ${targetLabel}`,
      `  Mismatches: ${this.mismatches.length}`,
      `  Warnings:   ${this.warnings.length}`,
      `  Errors:     ${this.errors.length}`,
    ];
    return parts.join("\n");
  }
}

function reconcile(source, target, sourceLabel = "source", targetLabel = "target") {
  const report = new Report();

  // -- Validate both manifests --
  try {
    validateManifest(source, sourceLabel);
  } catch (err) {
    report.addError("VALIDATION", `${sourceLabel}: ${err.message}`);
    return report;
  }
  try {
    validateManifest(target, targetLabel);
  } catch (err) {
    report.addError("VALIDATION", `${targetLabel}: ${err.message}`);
    return report;
  }

  const sourceTables = new Set(Object.keys(source.tables));
  const targetTables = new Set(Object.keys(target.tables));

  // -- Schema version check --
  if (source.schema_version !== target.schema_version) {
    report.addMismatch(
      "SCHEMA_VERSION",
      `source v${source.schema_version} != target v${target.schema_version}`
    );
  }

  // -- Table presence check --
  for (const t of sourceTables) {
    if (!targetTables.has(t)) {
      report.addMismatch("TABLE_MISSING_IN_TARGET", `table "${t}" is present in source but missing in target`);
    }
  }
  for (const t of targetTables) {
    if (!sourceTables.has(t)) {
      report.addMismatch("TABLE_MISSING_IN_SOURCE", `table "${t}" is present in target but missing in source`);
    }
  }

  const commonTables = [...sourceTables].filter((t) => targetTables.has(t));

  // -- Count mismatches --
  for (const t of commonTables) {
    const sc = source.tables[t].count;
    const tc = target.tables[t].count;
    if (sc !== tc) {
      report.addMismatch(
        "COUNT",
        `table "${t}": source has ${sc} rows, target has ${tc} rows (delta: ${tc - sc})`
      );
    }
  }

  // -- Digest mismatches (row-by-row, by index) --
  for (const t of commonTables) {
    const sRows = source.tables[t].rows;
    const tRows = target.tables[t].rows;
    const sDigests = source.tables[t].digests;
    const tDigests = target.tables[t].digests;
    const maxLen = Math.max(sDigests.length, tDigests.length);

    for (let i = 0; i < maxLen; i++) {
      if (i >= sDigests.length) {
        // Extra row in target
        const tId = tRows[i]?.row?.id ?? `row[${i}]`;
        report.addMismatch(
          "ROW_EXTRA_IN_TARGET",
          `table "${t}" row ${i} (id=${tId}) exists in target but not in source`
        );
      } else if (i >= tDigests.length) {
        // Extra row in source
        const sId = sRows[i]?.row?.id ?? `row[${i}]`;
        report.addMismatch(
          "ROW_EXTRA_IN_SOURCE",
          `table "${t}" row ${i} (id=${sId}) exists in source but not in target`
        );
      } else if (sDigests[i] !== tDigests[i]) {
        // Digest mismatch — report redacted
        const sId = sRows[i]?.row?.id ?? `row[${i}]`;
        report.addMismatch(
          "DIGEST",
          `table "${t}" row ${i} (id=${sId}): digest mismatch ` +
            `(${sDigests[i].slice(0, 12)}... vs ${tDigests[i].slice(0, 12)}...)`
        );
      }
    }
  }

  // -- Orphan diagnostics: FK references that don't resolve --
  const sourceIdMap = buildIdMap(source);
  const targetIdMap = buildIdMap(target);

  for (const fk of FK_RELATIONS) {
    const { table, fkColumn, referencedTable } = fk;

    // Check source orphans
    if (source.tables[table]) {
      for (let i = 0; i < source.tables[table].rows.length; i++) {
        const row = source.tables[table].rows[i].row;
        const fkValue = row[fkColumn];
        if (fkValue !== null && fkValue !== undefined) {
          const refMap = sourceIdMap[referencedTable];
          if (refMap && !refMap.has(String(fkValue))) {
            report.addWarning(
              "ORPHAN_IN_SOURCE",
              `table "${table}" row ${i} references ${referencedTable}.id=${fkValue} which does not exist in source`
            );
          }
        }
      }
    }
    // Check target orphans
    if (target.tables[table]) {
      for (let i = 0; i < target.tables[table].rows.length; i++) {
        const row = target.tables[table].rows[i].row;
        const fkValue = row[fkColumn];
        if (fkValue !== null && fkValue !== undefined) {
          const refMap = targetIdMap[referencedTable];
          if (refMap && !refMap.has(String(fkValue))) {
            report.addWarning(
              "ORPHAN_IN_TARGET",
              `table "${table}" row ${i} references ${referencedTable}.id=${fkValue} which does not exist in target`
            );
          }
        }
      }
    }
  }

  // -- Representative relational checks --
  for (const check of RELATIONAL_CHECKS) {
    const { name, table, fkColumn, referencedTable } = check;

    for (const [manifest, label, idMap] of [
      [source, sourceLabel, sourceIdMap],
      [target, targetLabel, targetIdMap],
    ]) {
      if (!manifest.tables[table]) continue;
      const refMap = idMap[referencedTable];
      if (!refMap) continue;

      for (let i = 0; i < manifest.tables[table].rows.length; i++) {
        const row = manifest.tables[table].rows[i].row;
        const fkValue = row[fkColumn];
        if (fkValue !== null && fkValue !== undefined) {
          if (!refMap.has(String(fkValue))) {
            report.addMismatch(
              "RELATIONAL",
              `[${label}] ${name}: ${table} row ${i} has ${fkColumn}=${fkValue} ` +
                `but no matching ${referencedTable} row`
            );
          }
        }
      }
    }
  }

  return report;
}

// ===================================================================
// Main
// ===================================================================
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: node scripts/migrate-reconcile.mjs <source-manifest.json> <target-manifest.json>");
    process.exit(2);
  }

  const [sourcePath, targetPath] = args;

  let source, target;
  try {
    source = await readManifestBounded(sourcePath, "R020", "R021");
  } catch (err) {
    console.error(err.message);
    process.exit(err.exitCode ?? 1);
  }

  try {
    target = await readManifestBounded(targetPath, "R022", "R023");
  } catch (err) {
    console.error(err.message);
    process.exit(err.exitCode ?? 1);
  }

  const report = reconcile(source, target, sourcePath, targetPath);
  report.print();

  console.error(report.summary(sourcePath, targetPath));

  if (report.errors.length > 0) {
    process.exit(2);
  }
  if (report.mismatches.length > 0) {
    process.exit(1);
  }

  console.error("Reconciliation complete: all checks passed.");
}

if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

export { reconcile, validateManifest, Report, FK_RELATIONS, RELATIONAL_CHECKS };
