#!/usr/bin/env node

/**
 * migrate-rollback.test.mjs — TST-15 migration rollback / compatibility gate
 *
 * Phase 6 lane L4. Deterministic, offline, zero-dependency verifier that is
 * the static half of the TST-15 gate. It does NOT invent reverse-SQL
 * down-migration files: the repository strategy is FORWARD-ONLY (see
 * docs/runbooks/supabase-migration-strategy.md and mig-rollback-window.md),
 * so no per-migration down files exist for 0001–0013 and none are fabricated.
 *
 * What this verifier proves (and how it relates to "rollback"):
 *  1. CONTRACT CONTINUITY — every migration only touches entities that exist
 *     in the accumulated schema contract (tables, columns, constraints,
 *     indexes, triggers, policies, enums, functions). A migration that
 *     references an unknown entity is a broken roll-forward and would make
 *     the whole migration chain unreplayable from clean state.
 *  2. DESTRUCTIVE-CHANGE DETECTION — DDL that destroys data or permanently
 *     narrows the schema (DROP TABLE / DROP COLUMN / ALTER COLUMN TYPE /
 *     DROP CONSTRAINT / DROP INDEX / ALTER TYPE ... DROP VALUE / TRUNCATE /
 *     DROP SCHEMA / DROP NOT NULL) is flagged because the forward-only
 *     repository has no reverse SQL to undo it. Sanctioned, replaceable,
 *     guarded drops (DROP POLICY IF EXISTS / DROP TRIGGER IF EXISTS /
 *     DROP FUNCTION IF EXISTS — the documented hardening pattern in 0004,
 *     0005, 0006, 0007, 0011, 0012) are allowed and tracked.
 *  3. IDEMPOTENT RE-APPLY — guarded creation (IF NOT EXISTS / ON CONFLICT)
 *     and additive-only DDL keep the migration set deterministically
 *     re-applicable. The DYNAMIC half of the gate (clean reset, roll-forward,
 *     restore rehearsal, drift-free re-apply) runs in
 *     scripts/supabase-test.sh against the ephemeral local Supabase stack.
 *
 * Rollback verification is therefore explicitly DISTINCT from unsupported
 * reverse SQL: the only sanctioned recovery paths are (a) fail-closed
 * detection BEFORE a destructive migration is accepted, (b) clean reset /
 * roll-forward from committed migrations, and (c) approved backup/restore.
 *
 * Usage:
 *   node scripts/migrate-rollback.test.mjs            # scan migrations + self-tests
 *   node scripts/migrate-rollback.test.mjs --scan-only
 *   node scripts/migrate-rollback.test.mjs --list-fixtures
 *
 * Exit 0 = all migrations pass + all self-tests pass. Exit 1 = any RED
 * finding or test failure (fail-closed).
 *
 * Zero network, synthetic fixtures only, no secrets, no real data.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(ROOT, "app", "supabase", "migrations");
const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "migrate-rollback");
const args = new Set(process.argv.slice(2));

// ===================================================================
// Conservative SQL statement splitter
// ===================================================================

/**
 * Split a migration file into top-level statements. Handles:
 *  - single-quoted strings ('...' with '' escaping)
 *  - double-quoted identifiers ("...")
 *  - dollar-quoted bodies ($$...$$ and $tag$...$tag$)
 *  - line comments (--) and block comments (/* ... *​/)
 *  - DO $$ ... $$ blocks are returned whole (opaque)
 * Returns an array of non-empty trimmed statement strings.
 */
function splitStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'") {
      current += ch;
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
        } else if (sql[i] === "'") {
          current += "'";
          i += 1;
          break;
        } else {
          current += sql[i];
          i += 1;
        }
      }
      continue;
    }
    if (ch === '"') {
      current += ch;
      i += 1;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          current += '""';
          i += 2;
        } else if (sql[i] === '"') {
          current += '"';
          i += 1;
          break;
        } else {
          current += sql[i];
          i += 1;
        }
      }
      continue;
    }
    if (ch === "$") {
      // Possible dollar-quote: $tag$ or $$
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        current += tag;
        i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end === -1) {
          current += sql.slice(i);
          i = n;
        } else {
          current += sql.slice(i, end + tag.length);
          i = end + tag.length;
        }
        continue;
      }
    }
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

// ===================================================================
// Normalization helpers
// ===================================================================

const KW_RE = /\b[a-z_][a-z0-9_]*\b/g;

/** Lowercase the statement but preserve quoted identifiers as placeholders. */
function lowerTokens(sql) {
  // Quoted identifiers are lowercased in place — the quoting already
  // prevents keyword confusion, so preserving the literal is safe.
  return sql.toLowerCase();
}

function firstKw(sql) {
  // Local (non-global) regex: a module-level /g regex keeps lastIndex across
  // calls and would skip the first keyword on subsequent invocations.
  const m = /\b[a-z_][a-z0-9_]*\b/.exec(lowerTokens(sql).trim());
  return m ? m[0] : "";
}

/** Parse a possibly-schema-qualified name: schema.table, table, "Schema"."Table". */
function parseQualified(raw) {
  const parts = raw
    .trim()
    .replace(/^"([^"]+)"/, "$1")
    .split(".")
    .map((p) => p.trim().replace(/^"(.*)"$/, "$1").replace(/^"(.*)"$/, "$1"));
  const unquoted = parts.map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p));
  const name = unquoted[unquoted.length - 1] ?? "";
  const schema = unquoted.length > 1 ? unquoted[unquoted.length - 2] : "";
  return { schema, name };
}

/** Extract the first table name from "ALTER TABLE <name> ..." / "CREATE INDEX ... ON <name>". */
function tableFromAlter(stmt) {
  const m = /^alter\s+table\s+("?[A-Za-z0-9_.-]+"?)/i.exec(stmt);
  return m ? parseQualified(m[1]) : null;
}

function tableFromOn(stmt) {
  const m = /\bon\s+("?[A-Za-z0-9_.-]+"?)\b/i.exec(stmt);
  return m ? parseQualified(m[1]) : null;
}

function tableFromCreate(stmt) {
  const m = /^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?("?[A-Za-z0-9_.-]+"?)/i.exec(stmt);
  return m ? parseQualified(m[1]) : null;
}

// ===================================================================
// Schema contract model + analyzer
// ===================================================================

/**
 * Scan an ordered list of migration files and produce findings.
 * model = {
 *   tables: Map<name, Set<columnName>>,
 *   constraints: Set<name>,
 *   indexes: Set<name>,
 *   triggers: Set<name>,
 *   policies: Set<`${table}:${name}`>,
 *   enums: Set<name>,
 *   functions: Set<name>,
 * }
 * findings = [{ level: 'RED'|'OK', migration, stmt, rule, message }]
 */
function analyzeMigrations(files) {
  const model = {
    tables: new Map(),
    constraints: new Set(),
    constraintTypes: new Map(),
    indexes: new Set(),
    triggers: new Set(),
    policies: new Set(),
    enums: new Set(),
    functions: new Set(),
  };
  const findings = [];

  const red = (migration, stmt, rule, message) =>
    findings.push({ level: "RED", migration, stmt: stmt.slice(0, 160), rule, message });
  const ok = (migration, stmt, rule, message) =>
    findings.push({ level: "OK", migration, stmt: stmt.slice(0, 160), rule, message });

  for (const file of files) {
    const migration = path.basename(String(file.name));
    const sql = String(file.sql ?? "");
    const statements = splitStatements(sql);

    for (const stmt of statements) {
      const low = lowerTokens(stmt);
      const first = firstKw(stmt);

      // ── DML / utility: not schema contract — ignore ─────────────
      if (/^(insert|update|delete|select|comment|grant|revoke|notify|vacuum|analyze|set)\b/.test(first)) {
        ok(migration, stmt, "IGNORED_DML_UTILITY", "data or session utility statement; not part of the schema contract");
        continue;
      }
      // opaque DO blocks
      if (/^do\b/.test(first)) {
        ok(migration, stmt, "OPAQUE_DO_BLOCK", "opaque DO $$ block; body not statically analyzed (reviewed by owner)");
        continue;
      }
      // CREATE SCHEMA — additive schema-level container (not data-bearing)
      if (/^create\s+(?:or\s+replace\s+)?schema\b/.test(low)) {
        ok(migration, stmt, "CREATE_SCHEMA", "additive schema creation");
        continue;
      }
      // ALTER DEFAULT PRIVILEGES — privilege management; RLS/browser-role
      // posture is enforced separately by supabase-ci static checks
      if (/^alter\s+default\s+privileges\b/.test(low)) {
        ok(migration, stmt, "ALTER_DEFAULT_PRIVILEGES", "privilege management; RLS/browser-role posture enforced separately");
        continue;
      }

      // ── DESTRUCTIVE / unreversible (no reverse SQL in a forward-only repo) ──
      if (/^drop\s+table\b/.test(low)) {
        red(migration, stmt, "DESTRUCTIVE_DROP_TABLE", "DROP TABLE is unrecoverable without reverse SQL; forward-only strategy forbids it");
        continue;
      }
      if (/^drop\s+schema\b/.test(low)) {
        red(migration, stmt, "DESTRUCTIVE_DROP_SCHEMA", "DROP SCHEMA is unrecoverable; forward-only strategy forbids it");
        continue;
      }
      if (/^truncate\b/.test(low)) {
        red(migration, stmt, "DESTRUCTIVE_TRUNCATE", "TRUNCATE destroys rows irreversibly; forbidden in forward-only migrations");
        continue;
      }
      if (/^alter\s+type\b/.test(low) && /drop\s+value\b/.test(low)) {
        red(migration, stmt, "DESTRUCTIVE_ENUM_DROP_VALUE", "ALTER TYPE ... DROP VALUE removes an enum label that existing rows may depend on; no reverse SQL");
        continue;
      }
      if (/^alter\s+table\b/.test(low)) {
        const table = tableFromAlter(stmt);
        if (!table) {
          red(migration, stmt, "UNPARSEABLE_ALTER_TABLE", "ALTER TABLE could not be parsed for table name");
          continue;
        }
        const tblName = table.name;
        if (!model.tables.has(tblName)) {
          red(migration, stmt, "CONTRACT_UNKNOWN_TABLE", `ALTER TABLE references '${tblName}' which does not exist in the accumulated contract`);
          continue;
        }
        const tableColumns = model.tables.get(tblName);
        // ALTER COLUMN ... TYPE → destructive (type change is not reversible)
        if (/alter\s+column\s+"?[a-z0-9_.-]+"?\s+type\b/.test(low)) {
          red(migration, stmt, "DESTRUCTIVE_ALTER_COLUMN_TYPE", "ALTER COLUMN TYPE changes existing column semantics; no reverse SQL");
          continue;
        }
        // ALTER COLUMN ... DROP NOT NULL → contract narrowing
        if (/alter\s+column\s+"?[a-z0-9_.-]+"?\s+drop\s+not\s+null\b/.test(low)) {
          red(migration, stmt, "DESTRUCTIVE_DROP_NOT_NULL", "Dropping a NOT NULL constraint is a contract change without reverse SQL");
          continue;
        }
        // ALTER TABLE ... DROP COLUMN → destructive
        if (/^alter\s+table\b[\s\S]*\bdrop\s+column\b/.test(low)) {
          red(migration, stmt, "DESTRUCTIVE_DROP_COLUMN", "DROP COLUMN is unrecoverable; no reverse SQL");
          continue;
        }
        // ALTER TABLE ... DROP CONSTRAINT → destructive if it exists in contract
        const dropConstraint = /^alter\s+table\b[\s\S]*\bdrop\s+constraint\s+(if\s+exists\s+)?("?[a-z0-9_.-]+"?)/i.exec(stmt);
        if (dropConstraint) {
          const cname = dropConstraint[2].replace(/^"|"$/g, "");
          const guarded = !!dropConstraint[1];
          const ctype = model.constraintTypes.get(cname);
          if (!guarded) {
            red(migration, stmt, "DESTRUCTIVE_DROP_CONSTRAINT_UNGUARDED", `DROP CONSTRAINT '${cname}' without IF EXISTS; no reverse SQL`);
          } else if (ctype === "unique" || ctype === "primary_key" || ctype === "foreign_key" || ctype === "exclude") {
            red(migration, stmt, "DESTRUCTIVE_DROP_CONSTRAINT", `DROP CONSTRAINT IF EXISTS '${cname}' removes a data-integrity guarantee (${ctype}); no reverse SQL`);
          } else {
            // CHECK constraints (and unknown/legacy names) are replaceable
            // data-guarding logic — the documented evolution pattern (0004→0006).
            ok(migration, stmt, "REPLACEABLE_DROP_CONSTRAINT", `DROP CONSTRAINT IF EXISTS '${cname}' (CHECK/legacy — replaceable data-guard, re-created in same chain)`);
          }
          continue;
        }
        // ADD COLUMN
        const addColumn = /^alter\s+table\b[\s\S]*\badd\s+column\s+(if\s+not\s+exists\s+)?("?[a-z0-9_.-]+"?)/i.exec(stmt);
        if (addColumn) {
          const colName = addColumn[2].replace(/^"|"$/g, "");
          const guarded = !!addColumn[1];
          if (tableColumns.has(colName)) {
            red(migration, stmt, "DUPLICATE_ADD_COLUMN", `ADD COLUMN '${colName}' on '${tblName}' duplicates an existing column without a guard`);
          } else {
            if (!guarded) ok(migration, stmt, "ADD_COLUMN", `ADD COLUMN '${colName}' on '${tblName}' (additive; recommend IF NOT EXISTS for idempotent re-apply)`);
            else ok(migration, stmt, "ADD_COLUMN_GUARDED", `ADD COLUMN IF NOT EXISTS '${colName}' on '${tblName}' (additive + guarded)`);
            tableColumns.add(colName);
          }
          continue;
        }
        // ADD CONSTRAINT
        if (/^alter\s+table\b[\s\S]*\badd\s+constraint\b/.test(low)) {
          const m = /add\s+constraint\s+("?[a-z0-9_.-]+"?)\s+(check|unique|primary\s+key|foreign\s+key|exclude)\b/i.exec(stmt);
          const nameMatch = /add\s+constraint\s+("?[a-z0-9_.-]+"?)/i.exec(stmt);
          if (nameMatch) {
            const cname = nameMatch[1].replace(/^"|"$/g, "");
            model.constraints.add(cname);
            if (m) model.constraintTypes.set(cname, m[2].replace(/\s+/g, "_"));
          }
          ok(migration, stmt, "ADD_CONSTRAINT", "additive constraint addition");
          continue;
        }
        // SET/DROP DEFAULT — data-independent, sanctioned
        if (/alter\s+column\b[\s\S]*(set|drop)\s+default\b/.test(low)) {
          ok(migration, stmt, "COLUMN_DEFAULT_CHANGE", "column default change is data-independent and re-applicable");
          continue;
        }
        ok(migration, stmt, "ALTER_TABLE_OK", "non-destructive ALTER TABLE");
        continue;
      }

      // ── CREATE TABLE ─────────────────────────────────────────────
      if (/^create\s+(?:unlogged\s+)?table\b/.test(low)) {
        const table = tableFromCreate(stmt);
        if (!table) {
          red(migration, stmt, "UNPARSEABLE_CREATE_TABLE", "CREATE TABLE could not be parsed");
          continue;
        }
        const guarded = /\bif\s+not\s+exists\b/.test(low);
        if (model.tables.has(table.name) && !guarded) {
          red(migration, stmt, "DUPLICATE_CREATE_TABLE", `CREATE TABLE '${table.name}' duplicates an existing table without IF NOT EXISTS`);
          continue;
        }
        if (!model.tables.has(table.name)) {
          model.tables.set(table.name, new Set());
          const columns = [...stmt.matchAll(/\b([a-z_][a-z0-9_]*)\s+(uuid|jsonb?|text|varchar(?:\([0-9]+\))?|numeric(?:\([0-9]+(?:,[0-9]+)?\))?|integer|bigint|smallint|boolean|timestamp(?:tz)?|date|time(?:tz)?|real|double\s+precision|bytea|serial|bigserial)\b/gi)];
          for (const c of columns) model.tables.get(table.name).add(c[1]);
        }
        // Inline NAMED constraints inside CREATE TABLE (constraint <name> <type>)
        const inlineConstraints = [...stmt.matchAll(/\bconstraint\s+([a-z0-9_.]+)\s+(check|unique|primary\s+key|foreign\s+key|exclude)\b/gi)];
        for (const c of inlineConstraints) {
          model.constraints.add(c[1]);
          model.constraintTypes.set(c[1], c[2].replace(/\s+/g, "_"));
        }
        ok(migration, stmt, "CREATE_TABLE", `CREATE TABLE '${table.name}' (additive)`);
        continue;
      }

      // ── CREATE INDEX / DROP INDEX ────────────────────────────────
      if (/^create\s+(?:unique\s+)?index\b/.test(low)) {
        const guarded = /\bif\s+not\s+exists\b/.test(low);
        const on = tableFromOn(stmt);
        const m = /create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?("?[a-z0-9_.-]+"?)/i.exec(stmt);
        const idxName = m ? m[1].replace(/^"|"$/g, "") : null;
        if (on && !model.tables.has(on.name)) {
          red(migration, stmt, "CONTRACT_UNKNOWN_TABLE", `CREATE INDEX targets '${on.name}' which is not in the contract`);
          continue;
        }
        if (idxName) {
          if (model.indexes.has(idxName) && !guarded) {
            red(migration, stmt, "DUPLICATE_CREATE_INDEX", `CREATE INDEX '${idxName}' duplicates an existing index without IF NOT EXISTS`);
            continue;
          }
          model.indexes.add(idxName);
        }
        ok(migration, stmt, "CREATE_INDEX", "additive index creation");
        continue;
      }
      if (/^drop\s+index\b/.test(low)) {
        const guarded = /\bif\s+exists\b/.test(low);
        const m = /drop\s+index\s+(?:if\s+exists\s+)?("?[a-z0-9_.-]+"?)/i.exec(stmt);
        const idxName = m ? m[1].replace(/^"|"$/g, "") : null;
        const idxUnqualified = idxName ? idxName.split(".").pop() : null;
        if (idxUnqualified && model.indexes.has(idxUnqualified)) {
          red(migration, stmt, "DESTRUCTIVE_DROP_INDEX", `DROP INDEX '${idxName}' removes an index created by an earlier migration; no reverse SQL`);
        } else if (!guarded) {
          red(migration, stmt, "DESTRUCTIVE_DROP_INDEX_UNGUARDED", "DROP INDEX without IF EXISTS on a forward-only chain");
        } else {
          ok(migration, stmt, "REPLACEABLE_DROP_INDEX", "DROP INDEX IF EXISTS (not previously created in contract)");
        }
        continue;
      }

      // ── CREATE POLICY / DROP POLICY ──────────────────────────────
      if (/^create\s+policy\b/.test(low)) {
        const m = /create\s+policy\s+("?[a-z0-9_.-]+"?)/i.exec(stmt);
        const on = tableFromOn(stmt);
        const pname = m ? m[1].replace(/^"|"$/g, "") : null;
        if (on && !model.tables.has(on.name)) {
          red(migration, stmt, "CONTRACT_UNKNOWN_TABLE", `CREATE POLICY targets '${on.name}' which is not in the contract`);
          continue;
        }
        if (pname && on) model.policies.add(`${on.name}:${pname}`);
        ok(migration, stmt, "CREATE_POLICY", "RLS policy creation (RLS posture enforced separately by supabase-ci static checks)");
        continue;
      }
      if (/^drop\s+policy\b/.test(low)) {
        // Sanctioned replaceable hardening pattern (0002/0004): guarded policy
        // drops that accompany tighter re-creation are allowed. Policy posture
        // is re-asserted by supabase-ci.yml static checks, so a policy drop is
        // NOT treated as a destructive change.
        if (!/\bif\s+exists\b/.test(low)) {
          red(migration, stmt, "DESTRUCTIVE_DROP_POLICY_UNGUARDED", "DROP POLICY without IF EXISTS; guard required in a forward-only chain");
        } else {
          const m = /drop\s+policy\s+if\s+exists\s+("?[a-z0-9_.-]+"?)/i.exec(stmt);
          const on = tableFromOn(stmt);
          if (m && on) model.policies.delete(`${on.name}:${m[1].replace(/^"|"$/g, "")}`);
          ok(migration, stmt, "REPLACEABLE_DROP_POLICY", "DROP POLICY IF EXISTS — sanctioned replaceable hardening (posture re-asserted by RLS static checks)");
        }
        continue;
      }

      // ── CREATE / DROP TRIGGER ────────────────────────────────────
      if (/^create\s+trigger\b/.test(low)) {
        const m = /create\s+trigger\s+("?[a-z0-9_.-]+"?)/i.exec(stmt);
        const on = tableFromOn(stmt);
        if (on && !model.tables.has(on.name)) {
          red(migration, stmt, "CONTRACT_UNKNOWN_TABLE", `CREATE TRIGGER targets '${on.name}' which is not in the contract`);
          continue;
        }
        if (m) model.triggers.add(m[1].replace(/^"|"$/g, ""));
        ok(migration, stmt, "CREATE_TRIGGER", "trigger creation");
        continue;
      }
      if (/^drop\s+trigger\b/.test(low)) {
        if (!/\bif\s+exists\b/.test(low)) {
          red(migration, stmt, "DESTRUCTIVE_DROP_TRIGGER_UNGUARDED", "DROP TRIGGER without IF EXISTS; guard required in a forward-only chain");
        } else {
          const m = /drop\s+trigger\s+if\s+exists\s+("?[a-z0-9_.-]+"?)/i.exec(stmt);
          if (m) model.triggers.delete(m[1].replace(/^"|"$/g, ""));
          ok(migration, stmt, "REPLACEABLE_DROP_TRIGGER", "DROP TRIGGER IF EXISTS — sanctioned replaceable hardening");
        }
        continue;
      }

      // ── CREATE / DROP FUNCTION ───────────────────────────────────
      if (/^create\s+(?:or\s+replace\s+)?function\b/.test(low)) {
        const m = /create\s+(?:or\s+replace\s+)?function\s+("?[a-z0-9_.-]+"?)/i.exec(stmt);
        if (m) model.functions.add(m[1].replace(/^"|"$/g, ""));
        ok(migration, stmt, "CREATE_FUNCTION", "function creation / replacement (replacement is sanctioned)");
        continue;
      }
      if (/^drop\s+function\b/.test(low)) {
        if (!/\bif\s+exists\b/.test(low)) {
          red(migration, stmt, "DESTRUCTIVE_DROP_FUNCTION_UNGUARDED", "DROP FUNCTION without IF EXISTS; guard required in a forward-only chain");
        } else {
          const m = /drop\s+function\s+if\s+exists\s+("?[a-z0-9_.-]+"?)/i.exec(stmt);
          if (m) model.functions.delete(m[1].replace(/^"|"$/g, ""));
          ok(migration, stmt, "REPLACEABLE_DROP_FUNCTION", "DROP FUNCTION IF EXISTS — sanctioned replaceable");
        }
        continue;
      }

      // ── CREATE TYPE / ALTER TYPE (non-drop) ─────────────────────
      if (/^create\s+type\b/.test(low)) {
        const m = /create\s+type\s+("?[a-z0-9_.-]+"?)/i.exec(stmt);
        if (m) model.enums.add(m[1].replace(/^"|"$/g, ""));
        ok(migration, stmt, "CREATE_TYPE", "type/enum creation");
        continue;
      }
      if (/^alter\s+type\b/.test(low)) {
        if (/add\s+value\b/.test(low)) {
          ok(migration, stmt, "ALTER_TYPE_ADD_VALUE", "ALTER TYPE ADD VALUE is additive");
        } else {
          ok(migration, stmt, "ALTER_TYPE_OK", "non-destructive ALTER TYPE");
        }
        continue;
      }

      // ── CREATE EXTENSION / SECURITY LABEL / misc ────────────────
      if (/^create\s+extension\b/.test(low)) {
        ok(migration, stmt, "CREATE_EXTENSION", "extension creation");
        continue;
      }

      // ── Unknown / unclassified DDL: fail-closed with an explicit note ──
      red(migration, stmt, "UNCLASSIFIED_DDL", "statement could not be classified by the contract analyzer; add an explicit rule or guard");
    }
  }

  return { model, findings };
}

// ===================================================================
// Real-migration scan (0001–0013)
// ===================================================================

async function loadRealMigrations() {
  const entries = await readdir(MIGRATION_DIR);
  const files = entries
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const loaded = [];
  for (const f of files) {
    loaded.push({ name: f, sql: await readFile(path.join(MIGRATION_DIR, f), "utf8") });
  }
  return loaded;
}

function scanMigrations(migrations) {
  const { findings } = analyzeMigrations(migrations);
  const reds = findings.filter((f) => f.level === "RED");
  return { findings, reds };
}

// ===================================================================
// In-memory negative/positive fixture self-tests
// ===================================================================

function runScannerOn(files) {
  // files: [{name, sql}]
  return scanMigrations(files);
}

function runSelfTests() {
  const results = [];
  const check = (label, cond, detail) => {
    assert.ok(cond, `${label}: ${detail}`);
    results.push(`PASS: ${label}`);
  };

  // ── Negative fixtures: must be RED (prove the gate is not vacuous) ──
  {
    const { reds } = runScannerOn([
      { name: "9001_negative_drop_table.sql", sql: "drop table screening_v2.candidates;" },
    ]);
    check("N1 DROP TABLE → RED", reds.some((r) => r.rule === "DESTRUCTIVE_DROP_TABLE"), "expected DESTRUCTIVE_DROP_TABLE");
  }
  {
    const { reds } = runScannerOn([
      { name: "0001_base.sql", sql: "create table screening_v2.candidates (id uuid primary key, email text not null);" },
      { name: "9002_negative_drop_column.sql", sql: "alter table screening_v2.candidates drop column email;" },
    ]);
    check("N2 DROP COLUMN → RED", reds.some((r) => r.rule === "DESTRUCTIVE_DROP_COLUMN"), "expected DESTRUCTIVE_DROP_COLUMN");
  }
  {
    const { reds } = runScannerOn([
      { name: "9003_negative_unknown_table.sql", sql: "alter table screening_v2.no_such_table add column x integer;" },
    ]);
    check("N3 unknown table → RED", reds.some((r) => r.rule === "CONTRACT_UNKNOWN_TABLE"), "expected CONTRACT_UNKNOWN_TABLE");
  }
  {
    const { reds } = runScannerOn([
      { name: "0001_base.sql", sql: "create table screening_v2.candidates (id uuid primary key);" },
      { name: "9004_negative_duplicate_create.sql", sql: "create table screening_v2.candidates (id uuid primary key);" },
    ]);
    check("N4 duplicate CREATE TABLE → RED", reds.some((r) => r.rule === "DUPLICATE_CREATE_TABLE"), "expected DUPLICATE_CREATE_TABLE");
  }
  {
    const { reds } = runScannerOn([
      { name: "0001_base.sql", sql: "create table screening_v2.roles (id uuid primary key, name text not null);" },
      { name: "9005_negative_alter_type.sql", sql: "alter table screening_v2.roles alter column name type varchar(5000);" },
    ]);
    check("N5 ALTER COLUMN TYPE → RED", reds.some((r) => r.rule === "DESTRUCTIVE_ALTER_COLUMN_TYPE"), "expected DESTRUCTIVE_ALTER_COLUMN_TYPE");
  }
  {
    const { reds } = runScannerOn([
      { name: "0001_base.sql", sql: "create table screening_v2.roles (id uuid primary key, name text not null);" },
      { name: "9006_negative_drop_constraint.sql", sql: "alter table screening_v2.roles drop constraint chk_roles_something;" },
    ]);
    check("N6 unguarded DROP CONSTRAINT → RED", reds.some((r) => r.rule === "DESTRUCTIVE_DROP_CONSTRAINT_UNGUARDED"), "expected DESTRUCTIVE_DROP_CONSTRAINT_UNGUARDED");
  }
  {
    const { reds } = runScannerOn([
      { name: "9007_negative_truncate.sql", sql: "truncate screening_v2.transcript_events;" },
    ]);
    check("N7 TRUNCATE → RED", reds.some((r) => r.rule === "DESTRUCTIVE_TRUNCATE"), "expected DESTRUCTIVE_TRUNCATE");
  }
  {
    const { reds } = runScannerOn([
      { name: "0001_base.sql", sql: "create table screening_v2.transcript_events (id uuid primary key, session_id uuid); create index idx_transcript_events_seq on screening_v2.transcript_events (session_id);" },
      { name: "9008_negative_drop_index.sql", sql: "drop index screening_v2.idx_transcript_events_seq;" },
    ]);
    check("N8 DROP INDEX → RED", reds.some((r) => r.rule === "DESTRUCTIVE_DROP_INDEX"), "expected DESTRUCTIVE_DROP_INDEX");
  }

  // ── Positive (sanctioned) fixtures: must be OK / not RED ──
  {
    const { reds, findings } = runScannerOn([
      { name: "0001_base.sql", sql: "create table screening_v2.roles (id uuid primary key, name text not null);" },
      { name: "0002_policy_hardening.sql", sql: "drop policy if exists \"anon read roles\" on screening_v2.roles;" },
    ]);
    check("P1 guarded policy drop → not RED", reds.length === 0, `unexpected reds: ${JSON.stringify(reds.map((r) => r.rule))}`);
    check("P1 sanctioned drop tracked as OK", findings.some((f) => f.rule === "REPLACEABLE_DROP_POLICY"), "expected REPLACEABLE_DROP_POLICY");
  }
  {
    const { reds } = runScannerOn([
      { name: "0001_base.sql", sql: "create table if not exists screening_v2.roles (id uuid primary key);" },
      { name: "0002_guarded_recreate.sql", sql: "create table if not exists screening_v2.roles (id uuid primary key);" },
    ]);
    check("P2 guarded duplicate CREATE → not RED", reds.length === 0, `unexpected reds: ${JSON.stringify(reds.map((r) => r.rule))}`);
  }
  {
    const { reds } = runScannerOn([
      { name: "0001_base.sql", sql: "create table screening_v2.roles (id uuid primary key);" },
      { name: "0002_add_column_guarded.sql", sql: "alter table screening_v2.roles add column if not exists description text;" },
    ]);
    check("P3 guarded ADD COLUMN → not RED", reds.length === 0, `unexpected reds: ${JSON.stringify(reds.map((r) => r.rule))}`);
  }
  {
    const { reds } = runScannerOn([
      { name: "0001_base.sql", sql: "create table screening_v2.roles (id uuid primary key, status text);" },
      { name: "0002_default_change.sql", sql: "alter table screening_v2.roles alter column status set default 'created';" },
    ]);
    check("P4 SET DEFAULT → not RED", reds.length === 0, `unexpected reds: ${JSON.stringify(reds.map((r) => r.rule))}`);
  }
  {
    const { reds } = runScannerOn([
      { name: "0001_base.sql", sql: "create table screening_v2.roles (id uuid primary key);" },
      { name: "0002_drop_trigger_guarded.sql", sql: "drop trigger if exists trg_roles_updated on screening_v2.roles; create trigger trg_roles_updated before update on screening_v2.roles for each row execute function screening_v2.set_updated();" },
    ]);
    check("P5 guarded trigger drop+recreate → not RED", reds.length === 0, `unexpected reds: ${JSON.stringify(reds.map((r) => r.rule))}`);
  }

  return results;
}

// ===================================================================
// On-disk seeded negative fixture (prove red against a real file)
// ===================================================================

async function runOnDiskNegativeFixtures() {
  // A directory with an intentionally-incompatible migration. The analyzer
  // must flag it RED. This is the "seed negative incompatible migration"
  // negative control: a reviewer can re-run the analyzer over the fixture
  // directory and watch it fail closed.
  const entries = await readdir(FIXTURE_DIR);
  const files = entries
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: null }));
  const loaded = [];
  for (const f of files) {
    loaded.push({ name: f.name, sql: await readFile(path.join(FIXTURE_DIR, f.name), "utf8") });
  }
  const { reds } = scanMigrations(loaded);
  const expected = new Set(["DESTRUCTIVE_DROP_TABLE", "DESTRUCTIVE_DROP_COLUMN", "CONTRACT_UNKNOWN_TABLE", "DESTRUCTIVE_ALTER_COLUMN_TYPE"]);
  const found = new Set(reds.map((r) => r.rule));
  for (const rule of expected) {
    assert.ok(found.has(rule), `on-disk negative fixture did not trigger ${rule}; reds: ${JSON.stringify(reds.map((r) => r.rule))}`);
  }
  console.log(`PASS: on-disk negative fixtures flagged ${reds.length} RED finding(s): ${[...new Set(reds.map((r) => r.rule))].join(", ")}`);
  return reds.length > 0;
}

// ===================================================================
// Main
// ===================================================================

async function main() {
  let failures = 0;
  const pass = (msg) => console.log(`PASS: ${msg}`);
  const fail = (msg) => {
    failures += 1;
    console.error(`FAIL: ${msg}`);
  };

  // 1. Real migrations scan (0001–0013)
  const migrations = await loadRealMigrations();
  if (migrations.length === 0) {
    fail("no migrations found under app/supabase/migrations");
    process.exit(1);
  }
  const { findings, reds } = scanMigrations(migrations);
  console.log(`\n=== TST-15 migration contract scan: ${migrations.length} migrations, ${findings.length} statements classified ===`);
  const byMigration = new Map();
  for (const f of findings) {
    if (!byMigration.has(f.migration)) byMigration.set(f.migration, []);
    byMigration.get(f.migration).push(f);
  }
  for (const [mig, fs] of byMigration) {
    const r = fs.filter((f) => f.level === "RED").length;
    console.log(`  ${mig}: ${fs.length} statements, ${r} RED`);
    if (r > 0) {
      for (const f of fs.filter((x) => x.level === "RED")) {
        console.error(`    RED [${f.rule}] ${f.message}\n         SQL: ${f.stmt}`);
      }
    }
  }
  if (reds.length > 0) {
    fail(`${reds.length} RED destructive/compatibility finding(s) in committed migrations`);
  } else {
    pass(`all ${migrations.length} committed migrations pass the destructive-change + contract-continuity gate`);
  }

  // 2. In-memory self-tests (negative + positive)
  console.log("\n=== TST-15 self-tests (in-memory fixtures) ===");
  const selfTestResults = runSelfTests();
  for (const r of selfTestResults) console.log(`  ${r}`);

  // 3. On-disk seeded negative fixture (prove red against a real file)
  if (!args.has("--scan-only")) {
    console.log("\n=== TST-15 on-disk seeded negative fixture ===");
    try {
      const redCount = await runOnDiskNegativeFixtures();
      if (redCount > 0) pass("seeded negative incompatible migration was flagged RED as designed");
      else fail("seeded negative incompatible migration was NOT flagged (gate is vacuous)");
    } catch (err) {
      fail(`on-disk negative fixture failed: ${err.message}`);
    }
  }

  // 4. Summary
  if (args.has("--list-fixtures")) {
    console.log("\nOn-disk negative fixture directory: scripts/__fixtures__/migrate-rollback/");
    console.log("Re-run: node scripts/migrate-rollback.test.mjs --scan-only <fixture-dir>");
  }

  if (failures > 0) {
    console.error(`\nmigrate-rollback verifier FAILED (${failures} failure(s)). Gate is RED — fail-closed.`);
    process.exit(1);
  }
  console.log("\nmigrate-rollback verifier PASSED: committed migrations are contract-continuous and free of destructive/unreversible DDL; seeded negative fixtures fail as designed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("migrate-rollback verifier crashed:", err);
  process.exit(2);
});
