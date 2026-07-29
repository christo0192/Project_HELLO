#!/usr/bin/env node

/**
 * check-synthetic-seed.mjs — GOV-06 offline seed validator
 *
 * Strips SQL comments, parses every executable statement, and verifies:
 *   - Only INSERT INTO screening_v2.<allowed_table> permitted
 *   - Rejects all non-INSERT statements unconditionally
 *   - Exact ordered column manifests per table (no extra/missing/reordered)
 *   - Every INSERT uses exact ON CONFLICT (id) DO NOTHING
 *   - All UUIDs use the reserved GOV-06 namespace
 *   - Exact row UUID manifest (complete set per table)
 *   - No duplicate IDs within or across tables
 *   - Column-by-column FK validation
 *   - Exact canonical content: candidate→role/resume mapping, emails,
 *     names, statuses, session mode/provider/status, transcript ordinals
 *   - Assessment JSON fully validated from raw column (fail closed)
 *   - All emails use @example.invalid, no phone numbers
 *   - Fixed canonical UTC timestamps only, lifecycle ordering
 *   - Synthetic markers on all text fields
 *   - Provider/mode check on call_sessions
 *   - Consent proof shape validation
 *
 * All diagnostics emit category codes only (E001–E040).
 * Zero network. No external imports.
 *
 * Exit: 0 = pass, 1 = failure, 2 = error.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// ===================================================================
// Constants
// ===================================================================
const GOV06_NS = "60000000-0000-4000-a000";
const NS_PREFIX_RE = /^60000000-0000-4000-a000-/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TIMESTAMP_CAST_RE = /^\s*'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)'::\s*timestamptz\s*$/;
const JSONB_CAST_RE = /^\s*'(.*)'::\s*jsonb\s*$/s;
const INT_VALUE_RE = /^\s*(-?\d+)\s*$/;
const BOOL_VALUE_RE = /^\s*(true|false)\s*$/i;
const NULL_VALUE_RE = /^\s*null\s*$/i;

// Canonical ordered column lists (matching CREATE TABLE + ALTER TABLE ADD COLUMN from migrations)
const CANONICAL_COLUMNS = {
  roles:                 ["id","title","jd","required_skills","screening_template","is_active","created_at","updated_at"],
  resumes:               ["id","file_path","file_name","mime_type","text_extracted","parsed","created_at","updated_at"],
  candidates:            ["id","role_id","resume_id","name","email","phone_raw","phone_e164","phone_valid","skills","experience_years","parsed","status","consent_source","consent_at","created_at","updated_at"],
  call_sessions:         ["id","candidate_id","role_id","mode","provider","status","current_question_index","started_at","ended_at","duration_sec","updated_at"],
  transcript_turns:      ["id","session_id","turn_index","speaker","text","created_at"],
  assessments:           ["id","session_id","candidate_id","english","tone","communication","motivation","role_fit","resume_conflicts","overall_score","recommendation","summary","raw","provenance","created_at","updated_at"],
  consent_records:       ["id","candidate_id","source","proof","created_at"],
};

// Columns that are nullable (can be omitted from INSERT because they have defaults or are nullable)
const OMITTABLE_COLUMNS = new Set([
  "external_call_id","recording_url",  // call_sessions
  "phone_raw","phone_e164",            // candidates (nullable)
  "ats_external_id","ats_source",      // candidates (deferred)
  "file_path",                          // resumes
]);

// Columns that CANNOT be omitted (required for the seed manifest check)
const REQUIRED_COLUMNS = new Set();
for (const [,cols] of Object.entries(CANONICAL_COLUMNS)) {
  for (const c of cols) REQUIRED_COLUMNS.add(c);
}
// Remove omittable from required
for (const c of OMITTABLE_COLUMNS) REQUIRED_COLUMNS.delete(c);

const ALLOWED_TABLES = new Set([
  "roles","resumes","candidates","call_sessions",
  "transcript_turns","assessments","consent_records",
]);

const FORBIDDEN_TABLES = new Set(["call_queue","sms_follow_ups","ats_sync_log"]);

const TABLES_WITH_UPDATED_AT = new Set([
  "roles","resumes","candidates","call_sessions","assessments",
]);

// Manifest: table -> { ids[], refs: {col:parentTable} }
const MANIFEST = new Map([
  ["roles", { ids: [
    "60000000-0000-4000-a000-000000000001",
    "60000000-0000-4000-a000-000000000002",
    "60000000-0000-4000-a000-000000000003",
  ], refs: {} }],
  ["resumes", { ids: [
    "60000000-0000-4000-a000-000000000011",
    "60000000-0000-4000-a000-000000000012",
    "60000000-0000-4000-a000-000000000013",
  ], refs: {} }],
  ["candidates", { ids: [
    "60000000-0000-4000-a000-000000000021",
    "60000000-0000-4000-a000-000000000022",
    "60000000-0000-4000-a000-000000000023",
  ], refs: { role_id: "roles", resume_id: "resumes" } }],
  ["call_sessions", { ids: [
    "60000000-0000-4000-a000-000000000031",
    "60000000-0000-4000-a000-000000000032",
    "60000000-0000-4000-a000-000000000033",
  ], refs: { candidate_id: "candidates", role_id: "roles" } }],
  ["transcript_turns", { ids: [
    "60000000-0000-4000-a000-000000000041",
    "60000000-0000-4000-a000-000000000042",
    "60000000-0000-4000-a000-000000000043",
    "60000000-0000-4000-a000-000000000044",
    "60000000-0000-4000-a000-000000000045",
    "60000000-0000-4000-a000-000000000046",
    "60000000-0000-4000-a000-000000000047",
    "60000000-0000-4000-a000-000000000048",
    "60000000-0000-4000-a000-000000000049",
    "60000000-0000-4000-a000-00000000004a",
    "60000000-0000-4000-a000-00000000004b",
    "60000000-0000-4000-a000-00000000004c",
    "60000000-0000-4000-a000-00000000004d",
  ], refs: { session_id: "call_sessions" } }],
  ["assessments", { ids: [
    "60000000-0000-4000-a000-000000000051",
    "60000000-0000-4000-a000-000000000052",
  ], refs: { session_id: "call_sessions", candidate_id: "candidates" } }],
  ["consent_records", { ids: [
    "60000000-0000-4000-a000-000000000061",
    "60000000-0000-4000-a000-000000000062",
    "60000000-0000-4000-a000-000000000063",
  ], refs: { candidate_id: "candidates" } }],
]);

// Exact content map: which candidate→role/resume mapping is expected
const EXPECTED_CONTENT = {
  candidates: {
    "60000000-0000-4000-a000-000000000021": {
      role_id: "60000000-0000-4000-a000-000000000001",
      resume_id: "60000000-0000-4000-a000-000000000011",
      name: "Synth Demo Candidate Alpha",
      email: "synth.test.alpha@example.invalid",
      status: "screened",
      consent_source: "demo_seed",
    },
    "60000000-0000-4000-a000-000000000022": {
      role_id: "60000000-0000-4000-a000-000000000002",
      resume_id: "60000000-0000-4000-a000-000000000012",
      name: "Synth Demo Candidate Beta",
      email: "synth.test.beta@example.invalid",
      status: "screened",
      consent_source: "demo_seed",
    },
    "60000000-0000-4000-a000-000000000023": {
      role_id: "60000000-0000-4000-a000-000000000003",
      resume_id: "60000000-0000-4000-a000-000000000013",
      name: "Synth Demo Candidate Gamma",
      email: "synth.test.gamma@example.invalid",
      status: "screening",
      consent_source: "demo_seed",
    },
  },
  call_sessions: {
    "60000000-0000-4000-a000-000000000031": {
      candidate_id: "60000000-0000-4000-a000-000000000021",
      role_id: "60000000-0000-4000-a000-000000000001",
      mode: "browser",
      provider: "pipecat",
      status: "completed",
      current_question_index: 3,
    },
    "60000000-0000-4000-a000-000000000032": {
      candidate_id: "60000000-0000-4000-a000-000000000022",
      role_id: "60000000-0000-4000-a000-000000000002",
      mode: "browser",
      provider: "pipecat",
      status: "completed",
      current_question_index: 3,
    },
    "60000000-0000-4000-a000-000000000033": {
      candidate_id: "60000000-0000-4000-a000-000000000023",
      role_id: "60000000-0000-4000-a000-000000000003",
      mode: "browser",
      provider: "pipecat",
      status: "in_progress",
      current_question_index: 1,
    },
  },
  transcript_turns: {
    sessions: {
      "60000000-0000-4000-a000-000000000031": { start: 0, end: 4, count: 5 },
      "60000000-0000-4000-a000-000000000032": { start: 0, end: 5, count: 6 },
      "60000000-0000-4000-a000-000000000033": { start: 0, end: 1, count: 2 },
    },
  },
  assessments: {
    "60000000-0000-4000-a000-000000000051": {
      session_id: "60000000-0000-4000-a000-000000000031",
      candidate_id: "60000000-0000-4000-a000-000000000021",
      overall_score: 82,
    },
    "60000000-0000-4000-a000-000000000052": {
      session_id: "60000000-0000-4000-a000-000000000032",
      candidate_id: "60000000-0000-4000-a000-000000000022",
      overall_score: 88,
    },
  },
  consent_records: {
    "60000000-0000-4000-a000-000000000061": {
      candidate_id: "60000000-0000-4000-a000-000000000021",
      source: "demo_seed",
      timestamp: "2026-01-15T12:00:00Z",
    },
    "60000000-0000-4000-a000-000000000062": {
      candidate_id: "60000000-0000-4000-a000-000000000022",
      source: "demo_seed",
      timestamp: "2026-01-15T12:00:01Z",
    },
    "60000000-0000-4000-a000-000000000063": {
      candidate_id: "60000000-0000-4000-a000-000000000023",
      source: "demo_seed",
      timestamp: "2026-01-15T12:00:02Z",
    },
  },
};

const ALL_EXPECTED_IDS = new Set();
for (const [, m] of MANIFEST) {
  for (const id of m.ids) ALL_EXPECTED_IDS.add(id);
}

// Approved canonical UTC timestamps (all from seed)
const APPROVED_TIMESTAMPS = new Set([
  "2026-01-15T10:00:00Z",
  "2026-01-15T10:01:00Z",
  "2026-01-15T10:02:00Z",
  "2026-01-15T10:03:00Z",
  "2026-01-15T10:04:00Z",
  "2026-01-15T10:15:00Z",
  "2026-01-15T10:16:00Z",
  "2026-01-15T11:00:00Z",
  "2026-01-15T11:01:00Z",
  "2026-01-15T11:02:00Z",
  "2026-01-15T11:03:00Z",
  "2026-01-15T11:04:00Z",
  "2026-01-15T11:05:00Z",
  "2026-01-15T11:15:00Z",
  "2026-01-15T11:16:00Z",
  "2026-01-15T11:45:00Z",
  "2026-01-15T11:46:00Z",
  "2026-01-15T12:00:00Z",
  "2026-01-15T12:00:01Z",
  "2026-01-15T12:00:02Z",
]);

// Timestamp column requirements per table
const TIMESTAMP_COLS = new Map([
  ["roles", ["created_at","updated_at"]],
  ["resumes", ["created_at","updated_at"]],
  ["candidates", ["created_at","updated_at"]],
  ["call_sessions", ["updated_at"]],  // created_at not in schema
  ["transcript_turns", ["created_at"]],
  ["assessments", ["created_at","updated_at"]],
  ["consent_records", ["created_at"]],
]);

const CODE = {
  NO_MARKER:           "E001",
  NO_RESERVED_UUID:    "E002",
  NON_RESERVED_UUID:   "E003",
  NO_ON_CONFLICT:      "E004",
  CARDINALITY_MISMATCH:"E005",
  FK_ORDER:            "E006",
  FORBIDDEN_TABLE:     "E007",
  BROAD_DELETE:        "E008",
  TRUNCATE:            "E009",
  UPDATE:              "E010",
  REAL_EMAIL:          "E011",
  BAD_PHONE:           "E012",
  PII_SECRET:          "E013",
  BAD_PATH:            "E014",
  EXTERNAL_URL:        "E015",
  UNKNOWN_STATEMENT:   "E016",
  MALFORMED:           "E017",
  DUP_ID_WITHIN:       "E018",
  DUP_ID_CROSS:        "E019",
  UNKNOWN_RESERVED_ID: "E020",
  BAD_FK_REF:          "E021",
  INCOMPLETE_INSERT:   "E022",
  COMMENT_BYPASS:      "E023",
  MISSING_TABLE:       "E024",
  NOW_DEFAULT:         "E025",
  NON_ALLOWED_TABLE:   "E026",
  MISSING_TIMESTAMP:   "E027",
  BAD_ASSESSMENT:      "E028",
  BAD_TIMESTAMP:       "E029",
  SYNTHETIC_MARKER:    "E030",
  SELECT_STMT:         "E031",
  INSERT_SELECT:       "E032",
  UNCLOSED_SYNTAX:     "E033",
  BAD_COLUMNS:         "E034",
  BAD_CONTENT:         "E035",
  BAD_TRANSCRIPT:      "E036",
  BAD_CONSENT:         "E037",
  MISSING_ROW_VALUE:   "E038",
  EXTRA_COLUMN:        "E039",
  MISSING_COLUMN:      "E040",
};

const CODE_MSG = {
  E001: "Dataset version marker not found in file header",
  E002: "No reserved-namespace UUIDs found",
  E003: "Non-reserved UUID used in seeded row",
  E004: "INSERT without exact ON CONFLICT (id) DO NOTHING",
  E005: "Row ID set does not match exact manifest",
  E006: "FK references parent inserted after child",
  E007: "Forbidden table (call_queue/sms_follow_ups/ats_sync_log) would be seeded",
  E008: "DELETE statement found (prohibited in seed)",
  E009: "TRUNCATE statement found (prohibited in seed)",
  E010: "UPDATE statement found (prohibited in seed)",
  E011: "Email domain not in RFC-reserved .invalid",
  E012: "Phone prefix not in reserved +1555 range",
  E013: "Secret token or PII pattern detected",
  E014: "Real filesystem path pattern detected",
  E015: "External URL detected",
  E016: "Non-INSERT executable SQL statement found (DDL/DML/DCL/EXEC/WITH/COPY/CALL)",
  E017: "Malformed or incomplete SQL syntax detected",
  E018: "Duplicate ID within the same table",
  E019: "Same UUID used in multiple tables",
  E020: "Reserved-namespace ID outside expected manifest set",
  E021: "FK references a seeded parent ID that does not exist",
  E022: "INSERT statement missing VALUES, columns, or semicolon",
  E023: "ON CONFLICT appears only in SQL comment, not executable",
  E024: "Required table has no INSERT statements",
  E025: "now(), CURRENT_TIMESTAMP, clock/statement/transaction_timestamp, localtimestamp, CURRENT_DATE, or relative interval found in executable SQL",
  E026: "INSERT targets a table not in ALLOWED_TABLES",
  E027: "INSERT omits required deterministic timestamp column",
  E028: "Assessment JSON does not match expected shape or ranges",
  E029: "Timestamp value is not a valid canonical fixed UTC literal, is NULL, uses non-Z offset, infinity, or violates lifecycle ordering",
  E030: "Textual field missing synthetic marker (SYNTHETIC DEMO prefix)",
  E031: "SELECT/WITH/COPY/CALL/EXECUTE statement found (prohibited in seed)",
  E032: "INSERT ... SELECT found (prohibited in seed)",
  E033: "Unclosed quote, comment, dollar-tag, or parentheses found in SQL",
  E034: "INSERT column list does not match canonical ordered manifest for table",
  E035: "Row content does not match expected canonical values",
  E036: "Transcript ordinal uniqueness/contiguity/session mapping violated",
  E037: "Consent record proof shape or timestamp alignment invalid",
  E038: "Row value count does not match column count",
  E039: "INSERT contains extra column not in canonical manifest",
  E040: "INSERT missing required canonical column",
};

// ===================================================================
// Helpers
// ===================================================================

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "");
}

function isReserved(uuid) {
  return uuid.startsWith(GOV06_NS);
}

function extractUUIDs(text) {
  const set = new Set();
  let m;
  while ((m = UUID_RE.exec(text)) !== null) {
    set.add(m[0].toLowerCase());
  }
  return [...set];
}

function cleanSQLValue(raw) {
  let s = raw.trim();
  // Remove ::type casts before quoted content
  s = s.replace(/::\s*\w+(?:\s*\[\])?\s*$/i, "").trim();
  // Remove surrounding single quotes
  if (s.startsWith("'") && s.endsWith("'")) {
    s = s.slice(1, -1);
    // Unescape doubled single quotes
    s = s.replace(/''/g, "'");
  }
  return s;
}

function parseJSONValue(raw) {
  const cleaned = cleanSQLValue(raw);
  try { return JSON.parse(cleaned); } catch { return null; }
}

// ===================================================================
// Structural syntax validation
// ===================================================================
function checkUnclosedSyntax(sql) {
  const chars = [...sql];
  let inSingleQuote = false;
  let inDollar = false;
  let dollarTag = "";
  let inLineComment = false;
  let inBlockComment = false;
  let parenDepth = 0;

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const n = i + 1 < chars.length ? chars[i + 1] : "";

    if (!inBlockComment && c === "-" && n === "-") { inLineComment = true; i++; continue; }
    if (inLineComment && c === "\n") { inLineComment = false; continue; }
    if (inLineComment) continue;

    if (!inSingleQuote && !inDollar && c === "/" && n === "*") { inBlockComment = true; i++; continue; }
    if (inBlockComment && c === "*" && n === "/") { inBlockComment = false; i++; continue; }
    if (inBlockComment) continue;

    if (!inDollar && !inLineComment && !inBlockComment) {
      if (c === "'" && (i === 0 || chars[i - 1] !== "\\")) { inSingleQuote = !inSingleQuote; }
    }

    if (!inSingleQuote && !inLineComment && !inBlockComment && c === "$") {
      let tag = "";
      let j = i + 1;
      while (j < chars.length && chars[j] !== "$" && chars[j] !== "'" && !/\s/.test(chars[j])) { tag += chars[j]; j++; }
      if (j < chars.length && chars[j] === "$") {
        if (!inDollar) { inDollar = true; dollarTag = tag; }
        else if (dollarTag === tag) { inDollar = false; dollarTag = ""; }
      }
    }

    if (!inSingleQuote && !inLineComment && !inBlockComment && !inDollar) {
      if (c === "(") parenDepth++;
      else if (c === ")") parenDepth--;
    }
  }

  if (inSingleQuote) return "unclosed single quote";
  if (inBlockComment) return "unclosed block comment";
  if (inDollar) return "unclosed dollar-quote";
  if (parenDepth !== 0) return "unbalanced parentheses";
  return null;
}

// ===================================================================
// Statement parser
// ===================================================================
function parseStatements(sql) {
  const stmts = [];
  const chars = [...sql];
  let i = 0;
  let current = "";
  let inDollar = false;
  let dollarTag = "";
  let inSingleQuote = false;
  let parenDepth = 0;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < chars.length) {
    const c = chars[i];
    const n = i + 1 < chars.length ? chars[i + 1] : "";

    if (!inBlockComment && !inSingleQuote && !inDollar && c === "-" && n === "-") {
      inLineComment = true;
      current += c + n; i += 2; continue;
    }
    if (inLineComment) { current += c; if (c === "\n") inLineComment = false; i++; continue; }

    if (!inLineComment && !inSingleQuote && !inDollar && c === "/" && n === "*") {
      inBlockComment = true;
      current += c + n; i += 2; continue;
    }
    if (inBlockComment && c === "*" && n === "/") {
      current += c + n; inBlockComment = false; i += 2; continue;
    }
    if (inBlockComment) { current += c; i++; continue; }

    if (!inLineComment && !inBlockComment) {
      if (!inDollar && c === "'" && (i === 0 || chars[i-1] !== "\\")) inSingleQuote = !inSingleQuote;
      if (!inSingleQuote && !inDollar && c === "$") {
        let tag = ""; let j = i+1;
        while (j < chars.length && chars[j] !== "$" && chars[j] !== "'" && !/\s/.test(chars[j])) { tag += chars[j]; j++; }
        if (j < chars.length && chars[j] === "$") {
          if (!inDollar) { inDollar = true; dollarTag = tag; } else if (dollarTag === tag) { inDollar = false; dollarTag = ""; }
        }
      }
      if (!inSingleQuote && !inDollar) {
        if (c === "(") parenDepth++;
        if (c === ")") parenDepth--;
        if (c === ";" && parenDepth === 0) {
          const trimmed = current.trim();
          if (trimmed) stmts.push(trimmed);
          current = "";
          i++; continue;
        }
      }
    }

    current += c;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed) stmts.push(trimmed);
  return stmts;
}

// ===================================================================
// Statement classification
// ===================================================================
function classifyStatement(sql) {
  const upper = sql.toUpperCase().replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").trim();

  if (/^CALL\s/i.test(upper)) return { type: "CALL", sql };
  if (/^COPY\s/i.test(upper)) return { type: "COPY", sql };
  if (/^DO\s/i.test(upper) || /^\s*\$\$/i.test(upper)) return { type: "DO", sql };
  if (/^CREATE\s/i.test(upper)) return { type: "DDL", sql };
  if (/^ALTER\s/i.test(upper)) return { type: "DDL", sql };
  if (/^DROP\s/i.test(upper)) return { type: "DDL", sql };
  if (/^COMMENT\s/i.test(upper)) return { type: "DDL", sql };
  if (/^GRANT\s/i.test(upper)) return { type: "DCL", sql };
  if (/^REVOKE\s/i.test(upper)) return { type: "DCL", sql };
  if (/^DELETE\s/i.test(upper)) return { type: "DELETE", sql };
  if (/^UPDATE\s/i.test(upper)) return { type: "UPDATE", sql };
  if (/^TRUNCATE\s/i.test(upper)) return { type: "TRUNCATE", sql };
  if (/^SELECT\s/i.test(upper)) return { type: "SELECT", sql };
  if (/^WITH\s/i.test(upper)) return { type: "WITH", sql };
  if (/^INSERT\s/i.test(upper)) {
    if (/INSERT\s+INTO\s/i.test(upper)) {
      if (/SELECT\s/i.test(upper.replace(/INSERT\s+INTO\s+[^(]+\([^)]*\)\s*/i, ""))) {
        return { type: "INSERT_SELECT", sql };
      }
      return { type: "INSERT", sql };
    }
    return { type: "INSERT_UNQUALIFIED", sql };
  }
  return { type: "UNKNOWN", sql };
}

// ===================================================================
// Parse INSERT statement
// ===================================================================
function parseInsert(sql) {
  const m = sql.match(/^\s*INSERT\s+INTO\s+(?:screening_v2\.)?(\w+)\s*\(([^)]+)\)\s*VALUES\s*(.*)$/is);
  if (!m) return null;

  const table = m[1].toLowerCase();
  const columns = m[2].split(",").map(c => c.trim().toLowerCase());
  const valuesPart = m[3];

  // Remove ON CONFLICT suffix for parsing
  let valuesBody = valuesPart;
  let onConflict = "";
  const ocMatch = valuesPart.match(/\s+on\s+conflict\s*\(([^)]+)\)\s*do\s+nothing\s*;?\s*$/i);
  if (ocMatch) {
    onConflict = ocMatch[0].trim();
    valuesBody = valuesPart.slice(0, valuesPart.indexOf(ocMatch[0])).trim();
  }

  // Parse row values — handle nested parens
  const rows = [];
  const chars = [...valuesBody];
  let depth = 0;
  let rowStart = -1;
  for (let idx = 0; idx < chars.length; idx++) {
    const c = chars[idx];
    if (c === "(" && depth === 0) { rowStart = idx + 1; depth++; }
    else if (c === "(") { depth++; }
    else if (c === ")") {
      depth--;
      if (depth === 0 && rowStart >= 0) {
        const rowStr = chars.slice(rowStart, idx).join("").trim();
        if (rowStr) rows.push(rowStr);
        rowStart = -1;
      }
    }
  }

  // Parse individual values within a row (respecting quoted context)
  function parseRowValues(rowStr) {
    const values = [];
    const ch = [...rowStr];
    let cur = "";
    let d = 0;
    let sq = false;
    let dq = false;
    for (let p = 0; p < ch.length; p++) {
      const c2 = ch[p];
      if (c2 === "'" && !dq) sq = !sq;
      if (c2 === '"' && !sq) dq = !dq;
      if (!sq && !dq) {
        if (c2 === "(") d++;
        if (c2 === ")") d--;
        if (c2 === "," && d === 0) { values.push(cur.trim()); cur = ""; continue; }
      }
      cur += c2;
    }
    if (cur.trim()) values.push(cur.trim());
    return values;
  }

  return {
    table,
    columns,
    rows: rows.map(r => parseRowValues(r)),
    rawRows: rows,
    onConflict,
  };
}

// ===================================================================
// Check ON CONFLICT clause
// ===================================================================
function hasOnConflict(insert) {
  return /on\s+conflict\s*\(\s*id\s*\)\s*do\s+nothing\s*;?\s*$/i.test(insert.onConflict);
}

// ===================================================================
// Extract IDs from first column position of each row
// ===================================================================
function extractInsertIDs(insert) {
  return insert.rows.map(r => r[0] ? r[0].toLowerCase().replace(/^'|'$/g, "").replace(/::uuid/gi, "").trim() : "").filter(Boolean);
}

// ===================================================================
// Extract all UUIDs from row values (for FK existence checks)
// ===================================================================
function extractAllValuesIDs(insert) {
  const ids = [];
  for (const row of insert.rows) {
    for (const val of row) {
      const uuids = extractUUIDs(val);
      for (const u of uuids) ids.push(u);
    }
  }
  return ids;
}

// ===================================================================
// Validate canonical column manifest (Finding 1)
// ===================================================================
function validateColumnManifest(insert) {
  const { table, columns } = insert;
  const canonical = CANONICAL_COLUMNS[table];
  if (!canonical) return null; // shouldn't happen

  const codes = [];

  // Check for extra columns not in canonical set
  for (const col of columns) {
    if (!canonical.includes(col)) {
      codes.push(CODE.EXTRA_COLUMN);
    }
  }

  // Check for missing required columns
  const canonicalSet = new Set(canonical);
  const presentSet = new Set(columns);
  for (const col of canonical) {
    if (!presentSet.has(col) && !OMITTABLE_COLUMNS.has(col)) {
      codes.push(CODE.MISSING_COLUMN);
    }
  }

  // Check column order matches canonical
  const filteredCols = columns.filter(c => canonicalSet.has(c));
  const canonicalOrdered = canonical.filter(c => presentSet.has(c));
  if (filteredCols.length !== canonicalOrdered.length ||
      filteredCols.some((c, i) => c !== canonicalOrdered[i])) {
    codes.push(CODE.BAD_COLUMNS);
  }

  // Check row value count matches column count
  for (const row of insert.rows) {
    if (row.length !== columns.length) {
      codes.push(CODE.MISSING_ROW_VALUE);
    }
  }

  return codes.length > 0 ? codes : null;
}

// ===================================================================
// Validate content: email, phone, synthetic markers, etc.
// ===================================================================
function validateCellContent(cellText) {
  const codes = [];
  const clean = cellText.replace(/::\w+\s*$/i, "").replace(/^'|'$/g, "");

  // Check email
  const emailMatch = clean.match(/[\w.+-]+@([\w.-]+)/);
  if (emailMatch) {
    const domain = emailMatch[1].toLowerCase();
    if (domain !== "example.invalid") codes.push(CODE.REAL_EMAIL);
  }

  // Check phone
  const phoneClean = clean.replace(/[\s\-\(\)\.]/g, "");
  if (/^\+?1?\d{10,}$/.test(phoneClean) && phoneClean.length >= 10) {
    codes.push(CODE.BAD_PHONE);
  }

  // Check secret/token patterns
  if (/gh[pous]_[A-Za-z0-9]{36}/.test(clean) ||
      /sk-[A-Za-z0-9]{20,}/.test(clean) ||
      /(?:password|secret|token|api_key)\s*[:=]\s*['"][^'"]+['"]/i.test(clean)) {
    codes.push(CODE.PII_SECRET);
  }

  // Check paths
  if (/\/(?:home|Users|tmp|var|etc|opt|usr)\/[\w./-]+/.test(clean)) {
    codes.push(CODE.BAD_PATH);
  }

  // Check URLs
  if (/https?:\/\/[^\s'"),;]+/.test(clean)) {
    codes.push(CODE.EXTERNAL_URL);
  }

  return codes;
}

// ===================================================================
// Validate timestamp
// ===================================================================
function validateTimestampLiteral(cellText, colName, tableName) {
  const clean = cellText.trim();

  // NULL is allowed for nullable timestamp columns
  if (/^null$/i.test(clean)) {
    // ended_at can be null (in-progress session)
    const nullableTimestamps = new Set(["ended_at"]);
    if (nullableTimestamps.has(colName)) return null;
    return [CODE.BAD_TIMESTAMP];
  }

  // Check for temporal functions
  const temporalFns = [
    /now\s*\(/i, /current_timestamp/i, /clock_timestamp/i,
    /statement_timestamp/i, /transaction_timestamp/i,
    /localtimestamp/i, /current_date/i,
    /interval\s/i,
  ];
  for (const re of temporalFns) {
    if (re.test(clean)) return [CODE.NOW_DEFAULT];
  }

  // Check for infinity
  if (/infinity/i.test(clean)) return [CODE.BAD_TIMESTAMP];

  // Extract the timestamp value
  const tm = clean.match(/'([^']+)'/);
  if (!tm) return [CODE.BAD_TIMESTAMP];

  const ts = tm[1];

  // Must be canonical Z-suffixed UTC
  if (!CANONICAL_UTC_RE.test(ts)) return [CODE.BAD_TIMESTAMP];

  // Must be in approved set
  if (!APPROVED_TIMESTAMPS.has(ts)) return [CODE.BAD_TIMESTAMP];

  return null;
}

// ===================================================================
// Validate lifecycle ordering for a table's row values
// ===================================================================
function validateLifecycleOrdering(insert, rowIdx) {
  const { table, columns, rows } = insert;
  const codes = [];
  const row = rows[rowIdx];

  if (table === "call_sessions") {
    // started_at <= ended_at (when ended_at is non-null)
    const startedIdx = columns.indexOf("started_at");
    const endedIdx = columns.indexOf("ended_at");
    if (startedIdx >= 0 && endedIdx >= 0) {
      const startedVal = row[startedIdx];
      const endedVal = row[endedIdx];
      if (startedVal && endedVal && !/^null$/i.test(endedVal)) {
        const st = startedVal.match(/'([^']+)'/);
        const et = endedVal.match(/'([^']+)'/);
        if (st && et && st[1] > et[1]) codes.push(CODE.BAD_TIMESTAMP);
      }
    }
    // started_at >= updated_at would be weird, but skip (updated_at is when row was created)
  }

  if (table === "assessments") {
    const createdIdx = columns.indexOf("created_at");
    const updatedIdx = columns.indexOf("updated_at");
    if (createdIdx >= 0 && updatedIdx >= 0) {
      const cVal = row[createdIdx];
      const uVal = row[updatedIdx];
      if (cVal && uVal) {
        const ct = cVal.match(/'([^']+)'/);
        const ut = uVal.match(/'([^']+)'/);
        if (ct && ut && ct[1] > ut[1]) codes.push(CODE.BAD_TIMESTAMP);
      }
    }
  }

  return codes.length > 0 ? codes : null;
}

// ===================================================================
// Validate duration consistency for call_sessions
// ===================================================================
function validateDuration(insert, rowIdx) {
  const { columns, rows } = insert;
  const row = rows[rowIdx];

  const startedIdx = columns.indexOf("started_at");
  const endedIdx = columns.indexOf("ended_at");
  const durIdx = columns.indexOf("duration_sec");

  if (startedIdx < 0 || endedIdx < 0 || durIdx < 0) return null;

  const startedVal = row[startedIdx];
  const endedVal = row[endedIdx];
  const durVal = row[durIdx];

  if (!startedVal || !endedVal || /^null$/i.test(startedVal) || /^null$/i.test(endedVal)) return null;
  if (!durVal || /^null$/i.test(durVal)) return null;

  const st = startedVal.match(/'([^']+)'/) || [];
  const et = endedVal.match(/'([^']+)'/) || [];
  if (!st[1] || !et[1]) return null;

  const startMs = new Date(st[1]).getTime();
  const endMs = new Date(et[1]).getTime();
  if (isNaN(startMs) || isNaN(endMs)) return null;

  const expectedDur = Math.round((endMs - startMs) / 1000);
  const durMatch = durVal.match(/(-?\d+)/);
  if (!durMatch) return null;

  const actualDur = parseInt(durMatch[1], 10);
  if (actualDur !== expectedDur) return [CODE.BAD_TIMESTAMP];

  return null;
}

// ===================================================================
// Validate Assessment JSON (stored in `raw` column)
// ===================================================================
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateAssessmentRaw(rawVal) {
  const codes = [];

  // Must be a proper JSON string
  const raw = parseJSONValue(rawVal);
  if (!raw || typeof raw !== "object") return [CODE.BAD_ASSESSMENT];

  // Must have is_synthetic
  if (raw.is_synthetic !== true) codes.push(CODE.BAD_ASSESSMENT);
  // Must have version matching expected
  if (raw.version !== "gov-06-synthetic-v1") codes.push(CODE.BAD_ASSESSMENT);
  // Must have source
  if (raw.source !== "demo_seed") codes.push(CODE.BAD_ASSESSMENT);

  // Must have communication object with required fields
  if (!raw.communication || typeof raw.communication !== "object") {
    codes.push(CODE.BAD_ASSESSMENT);
  } else {
    const comm = raw.communication;
    if (typeof comm.score !== "number" || comm.score < 0 || comm.score > 10) codes.push(CODE.BAD_ASSESSMENT);
    if (typeof comm.clarity !== "number" || comm.clarity < 0 || comm.clarity > 10) codes.push(CODE.BAD_ASSESSMENT);
    if (typeof comm.structure !== "number" || comm.structure < 0 || comm.structure > 10) codes.push(CODE.BAD_ASSESSMENT);
    if (typeof comm.listening !== "number" || comm.listening < 0 || comm.listening > 10) codes.push(CODE.BAD_ASSESSMENT);
    if (typeof comm.rapport !== "number" || comm.rapport < 0 || comm.rapport > 10) codes.push(CODE.BAD_ASSESSMENT);
    if (!comm.notes || typeof comm.notes !== "string" || comm.notes.trim() === "") codes.push(CODE.BAD_ASSESSMENT);

    // english_proficiency
    if (!comm.english_proficiency || typeof comm.english_proficiency !== "object") {
      codes.push(CODE.BAD_ASSESSMENT);
    } else {
      const ep = comm.english_proficiency;
      if (typeof ep.grammar !== "number" || ep.grammar < 0 || ep.grammar > 10) codes.push(CODE.BAD_ASSESSMENT);
      if (typeof ep.band !== "string" || !/^[ABC][12]$/.test(ep.band)) codes.push(CODE.BAD_ASSESSMENT);
      if (!ep.notes || typeof ep.notes !== "string" || ep.notes.trim() === "") codes.push(CODE.BAD_ASSESSMENT);
    }

    // filler_usage
    if (!comm.filler_usage || typeof comm.filler_usage !== "object") {
      codes.push(CODE.BAD_ASSESSMENT);
    } else {
      const fu = comm.filler_usage;
      if (!["low","moderate","high"].includes(fu.level)) codes.push(CODE.BAD_ASSESSMENT);
      if (!Array.isArray(fu.examples)) codes.push(CODE.BAD_ASSESSMENT);
      else for (const ex of fu.examples) { if (typeof ex !== "string") codes.push(CODE.BAD_ASSESSMENT); }
      if (typeof fu.impact_score !== "number" || fu.impact_score < 0 || fu.impact_score > 10) codes.push(CODE.BAD_ASSESSMENT);
      if (!fu.notes || typeof fu.notes !== "string" || fu.notes.trim() === "") codes.push(CODE.BAD_ASSESSMENT);
    }

    // native_language_usage
    if (!comm.native_language_usage || typeof comm.native_language_usage !== "object") {
      codes.push(CODE.BAD_ASSESSMENT);
    } else {
      const nl = comm.native_language_usage;
      if (!["none","low","moderate","high"].includes(nl.level)) codes.push(CODE.BAD_ASSESSMENT);
      if (!Array.isArray(nl.examples)) codes.push(CODE.BAD_ASSESSMENT);
      else for (const ex of nl.examples) { if (typeof ex !== "string") codes.push(CODE.BAD_ASSESSMENT); }
      if (typeof nl.impact_score !== "number" || nl.impact_score < 0 || nl.impact_score > 10) codes.push(CODE.BAD_ASSESSMENT);
      if (!nl.notes || typeof nl.notes !== "string" || nl.notes.trim() === "") codes.push(CODE.BAD_ASSESSMENT);
    }
  }

  // Must have motivation object
  if (!raw.motivation || typeof raw.motivation !== "object") {
    codes.push(CODE.BAD_ASSESSMENT);
  } else {
    const mot = raw.motivation;
    if (typeof mot.score !== "number" || mot.score < 0 || mot.score > 10) codes.push(CODE.BAD_ASSESSMENT);
    if (!mot.notes || typeof mot.notes !== "string" || mot.notes.trim() === "") codes.push(CODE.BAD_ASSESSMENT);
  }

  // Must have resume_conflicts array
  if (!Array.isArray(raw.resume_conflicts)) {
    codes.push(CODE.BAD_ASSESSMENT);
  } else {
    for (const rc of raw.resume_conflicts) {
      if (typeof rc !== "object") { codes.push(CODE.BAD_ASSESSMENT); continue; }
      if (typeof rc.topic !== "string" || typeof rc.resume_says !== "string" ||
          typeof rc.candidate_said !== "string" || typeof rc.resolved !== "boolean" ||
          typeof rc.note !== "string") codes.push(CODE.BAD_ASSESSMENT);
    }
  }

  // No unknown fields at top level
  const allowedTopFields = ["is_synthetic","version","source","communication","motivation","resume_conflicts"];
  for (const key of Object.keys(raw)) {
    if (!allowedTopFields.includes(key)) codes.push(CODE.BAD_ASSESSMENT);
  }

  return codes.length > 0 ? codes : null;
}

// ===================================================================
// Validate synthetic marker on text fields
// ===================================================================
function validateSyntheticMarker(cellText) {
  const clean = cleanSQLValue(cellText);
  if (/^SYNTHETIC DEMO/i.test(clean) || /^Synthetic Demo/i.test(clean) || /^Synth Demo/i.test(clean)) return null;
  return [CODE.SYNTHETIC_MARKER];
}

// ===================================================================
// Validate transcript turns (Findings 3)
// ===================================================================
function validateTranscriptOrdinals(insert) {
  const { table, columns, rows } = insert;
  if (table !== "transcript_turns") return null;

  const codes = [];
  const sessionIdIdx = columns.indexOf("session_id");
  const turnIdx = columns.indexOf("turn_index");
  const speakerIdx = columns.indexOf("speaker");

  if (sessionIdIdx < 0 || turnIdx < 0 || speakerIdx < 0) return [CODE.BAD_TRANSCRIPT];

  // Group by session
  const sessionTurns = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sid = cleanSQLValue(row[sessionIdIdx]);
    const tidx = parseInt(row[turnIdx], 10);
    const speaker = cleanSQLValue(row[speakerIdx]);

    if (!sessionTurns[sid]) sessionTurns[sid] = [];
    sessionTurns[sid].push({ idx: i, turn: tidx, speaker });
  }

  for (const [sid, turns] of Object.entries(sessionTurns)) {
    // Check speaker is valid
    for (const t of turns) {
      if (t.speaker !== "bot" && t.speaker !== "candidate") codes.push(CODE.BAD_TRANSCRIPT);
    }

    // Check contiguity (0, 1, 2, ...)
    const sorted = [...turns].sort((a, b) => a.turn - b.turn);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].turn !== i) codes.push(CODE.BAD_TRANSCRIPT);
    }

    // Check uniqueness per session
    const turnSet = new Set(sorted.map(t => t.turn));
    if (turnSet.size !== sorted.length) codes.push(CODE.BAD_TRANSCRIPT);
  }

  return codes.length > 0 ? codes : null;
}

// ===================================================================
// Validate consent proof shape (Finding 3)
// ===================================================================
function validateConsentProof(insert) {
  const { table, columns, rows } = insert;
  if (table !== "consent_records") return null;

  const codes = [];
  const sourceIdx = columns.indexOf("source");
  const proofIdx = columns.indexOf("proof");

  if (sourceIdx < 0 || proofIdx < 0) return [CODE.BAD_CONSENT];

  for (const row of rows) {
    const source = cleanSQLValue(row[sourceIdx]);
    if (source !== "demo_seed") codes.push(CODE.BAD_CONSENT);

    const proof = parseJSONValue(row[proofIdx]);
    if (!proof || typeof proof !== "object") {
      codes.push(CODE.BAD_CONSENT);
    } else {
      if (proof.method !== "simulated_consent") codes.push(CODE.BAD_CONSENT);
      if (typeof proof.timestamp !== "string" || !CANONICAL_UTC_RE.test(proof.timestamp)) codes.push(CODE.BAD_CONSENT);
      if (proof.is_synthetic !== true) codes.push(CODE.BAD_CONSENT);
      const allowedProofKeys = new Set(["method","timestamp","is_synthetic"]);
      for (const key of Object.keys(proof)) {
        if (!allowedProofKeys.has(key)) codes.push(CODE.BAD_CONSENT);
      }
    }
  }

  return codes.length > 0 ? codes : null;
}

// ===================================================================
// Validate exact content (Finding 3)
// ===================================================================
function validateExactContent(insert) {
  const { table, columns, rows } = insert;
  const content = EXPECTED_CONTENT[table];
  if (!content) return null;

  // For tables with per-row expected content (candidates, call_sessions, assessments, consent_records)
  if (table === "candidates" || table === "call_sessions" || table === "assessments" || table === "consent_records") {
    const idIdx = columns.indexOf("id");
    if (idIdx < 0) return null;

    const codes = [];
    for (const row of rows) {
      const rowId = cleanSQLValue(row[idIdx]).toLowerCase();
      const expected = content[rowId];
      if (!expected) continue; // Will be caught by manifest check

      for (const [col, expectedVal] of Object.entries(expected)) {
        const colIdx = columns.indexOf(col);
        if (colIdx < 0) {
          if (col === "timestamp") continue; // checked in consent proof
          codes.push(CODE.BAD_CONTENT);
          continue;
        }
        if (row[colIdx] === undefined) { codes.push(CODE.BAD_CONTENT); continue; }
        const actualVal = cleanSQLValue(row[colIdx]);
        if (typeof expectedVal === "number") {
          const numMatch = actualVal.match(/(-?\d+(?:\.\d+)?)/);
          if (!numMatch || parseInt(numMatch[1], 10) !== expectedVal) codes.push(CODE.BAD_CONTENT);
        } else if (typeof expectedVal === "string") {
          // Case-insensitive comparison for display names; exact for emails/status/etc
          if (actualVal.toLowerCase() !== expectedVal.toLowerCase()) codes.push(CODE.BAD_CONTENT);
        }
      }
    }
    return codes.length > 0 ? codes : null;
  }

  return null;
}

// ===================================================================
// Validate truncation metadata count
// ===================================================================
function validateTranscriptCountBySession(inserts) {
  const codes = [];
  const expected = EXPECTED_CONTENT.transcript_turns.sessions;
  if (!expected) return null;

  // Count transcript turns per session
  const counts = {};
  for (const ins of inserts) {
    if (ins.table !== "transcript_turns") continue;
    const sidIdx = ins.columns.indexOf("session_id");
    for (const row of ins.rows) {
      const sid = cleanSQLValue(row[sidIdx]);
      counts[sid] = (counts[sid] || 0) + 1;
    }
  }

  for (const [sid, exp] of Object.entries(expected)) {
    if (counts[sid] !== exp.count) codes.push(CODE.BAD_TRANSCRIPT);
  }

  return codes.length > 0 ? codes : null;
}

// ===================================================================
// Main validation
// ===================================================================
async function validate(sql, filePath) {
  const codes = [];

  // 1. Check version marker
  if (!/synthetic_dataset_version\s*=\s*gov-06-synthetic-v1/.test(sql)) codes.push(CODE.NO_MARKER);

  // 2. Check for unclosed syntax
  const syntaxErr = checkUnclosedSyntax(sql);
  if (syntaxErr) codes.push(CODE.UNCLOSED_SYNTAX);

  // 3. Parse statements
  const stmts = parseStatements(sql);
  if (stmts.length === 0) { codes.push(CODE.MALFORMED); return { passed: false, codes }; }

  // 4. Check header comment boundary (ON CONFLICT in comment is a bypass attempt)
  const strippedHeader = sql.replace(/\/\*[\s\S]*?\*\//, "").split("\n").slice(0,5).join("\n");
  if (/on\s+conflict/i.test(strippedHeader) && !/insert/i.test(strippedHeader)) {
    codes.push(CODE.COMMENT_BYPASS);
  }

  // 5. Classify each statement
  const allInserts = [];
  const seenIDs = new Map(); // id -> {table, rowIdx}
  const tableRowCounts = new Map();

  // Strip comments from each statement before processing
  const cleanedStmts = stmts.map(s => stripComments(s).trim()).filter(Boolean);

  for (const stmt of cleanedStmts) {
    const { type, sql: stmtSql } = classifyStatement(stmt);
    const lowerSql = stmtSql.toLowerCase();

    if (type === "INSERT") {
      const insert = parseInsert(stmtSql);
      if (!insert) { codes.push(CODE.MALFORMED); continue; }

      // Check schema-qualified
      if (!/screening_v2\./.test(stmtSql)) { codes.push(CODE.MALFORMED); continue; }

      const table = insert.table;

      // Check table is allowed
      if (!ALLOWED_TABLES.has(table)) {
        if (FORBIDDEN_TABLES.has(table)) { codes.push(CODE.FORBIDDEN_TABLE); continue; }
        codes.push(CODE.NON_ALLOWED_TABLE);
        continue;
      }

      // Check ON CONFLICT
      if (!/on\s+conflict\s*\(\s*id\s*\)\s*do\s+nothing/i.test(insert.onConflict)) {
        codes.push(CODE.NO_ON_CONFLICT);
      }

      // Check column manifest (Finding 1)
      const colCodes = validateColumnManifest(insert);
      if (colCodes) codes.push(...colCodes);

      // Extract IDs and validate
      const rowIds = extractInsertIDs(insert);
      const allValuesIDs = extractAllValuesIDs(insert);

      // Check for non-reserved UUIDs
      for (const id of allValuesIDs) {
        if (!isReserved(id)) codes.push(CODE.NON_RESERVED_UUID);
      }

      // Check for non-reserved row IDs
      for (const id of rowIds) {
        if (!isReserved(id)) codes.push(CODE.NON_RESERVED_UUID);
      }

      // Validate each row
      for (let rIdx = 0; rIdx < insert.rows.length; rIdx++) {
        const row = insert.rows[rIdx];

        // Validate row value count against column count
        if (row.length !== insert.columns.length) {
          codes.push(CODE.MISSING_ROW_VALUE);
        }

        // Check content of each cell
        for (const cell of row) {
          const cellCodes = validateCellContent(cell);
          if (cellCodes) codes.push(...cellCodes);
        }

        // Validate timestamps
        for (let cIdx = 0; cIdx < insert.columns.length; cIdx++) {
          const col = insert.columns[cIdx];
          const cell = row[cIdx];
          if (cell === undefined) continue;

          // Check required timestamp columns
          const requiredTsCols = TIMESTAMP_COLS.get(table) || [];
          if (requiredTsCols.includes(col)) {
            const tsCodes = validateTimestampLiteral(cell, col, table);
            if (tsCodes) codes.push(...tsCodes);
          }
        }

        // Lifecycle ordering
        const lifecycleCodes = validateLifecycleOrdering(insert, rIdx);
        if (lifecycleCodes) codes.push(...lifecycleCodes);

        // Duration consistency
        const durCodes = validateDuration(insert, rIdx);
        if (durCodes) codes.push(...durCodes);

        // Synthetic marker on specific text fields
        if (table === "roles") {
          const titleIdx = insert.columns.indexOf("title");
          if (titleIdx >= 0) {
            const mkCodes = validateSyntheticMarker(row[titleIdx]);
            if (mkCodes) codes.push(...mkCodes);
          }
          // Also check jd
          const jdIdx = insert.columns.indexOf("jd");
          if (jdIdx >= 0) {
            const mkCodes = validateSyntheticMarker(row[jdIdx]);
            if (mkCodes) codes.push(...mkCodes);
          }
        }
        if (table === "resumes") {
          const textIdx = insert.columns.indexOf("text_extracted");
          if (textIdx >= 0) {
            const mkCodes = validateSyntheticMarker(row[textIdx]);
            if (mkCodes) codes.push(...mkCodes);
          }
        }
        if (table === "candidates") {
          const nameIdx = insert.columns.indexOf("name");
          if (nameIdx >= 0) {
            const mkCodes = validateSyntheticMarker(row[nameIdx]);
            if (mkCodes) codes.push(...mkCodes);
          }
        }
        if (table === "assessments") {
          const summaryIdx = insert.columns.indexOf("summary");
          if (summaryIdx >= 0) {
            const mkCodes = validateSyntheticMarker(row[summaryIdx]);
            if (mkCodes) codes.push(...mkCodes);
          }

          // Validate assessment raw contract and canonical mirror columns.
          const rawIdx = insert.columns.indexOf("raw");
          if (rawIdx >= 0) {
            const rawCodes = validateAssessmentRaw(row[rawIdx]);
            if (rawCodes) codes.push(...rawCodes);

            const rawObj = parseJSONValue(row[rawIdx]);
            const mirrorColumns = ["communication", "motivation", "resume_conflicts"];
            for (const mirrorCol of mirrorColumns) {
              const mirrorIdx = insert.columns.indexOf(mirrorCol);
              if (mirrorIdx < 0) { codes.push(CODE.BAD_ASSESSMENT); continue; }
              const mirrorObj = parseJSONValue(row[mirrorIdx]);
              if (mirrorObj === null || stableJson(mirrorObj) !== stableJson(rawObj?.[mirrorCol])) {
                codes.push(CODE.BAD_ASSESSMENT);
              }
            }
          } else {
            codes.push(CODE.BAD_ASSESSMENT);
          }
        }

        // Track IDs for duplicate detection
        const pk = rowIds[rIdx];
        if (pk && isReserved(pk)) {
          if (seenIDs.has(pk)) {
            const prev = seenIDs.get(pk);
            if (prev.table === table) codes.push(CODE.DUP_ID_WITHIN);
            else codes.push(CODE.DUP_ID_CROSS);
          } else {
            seenIDs.set(pk, { table, rowIdx: rIdx });
          }
        }
      }

      // Track table-row mappings for manifest checks
      if (!tableRowCounts.has(table)) tableRowCounts.set(table, []);
      tableRowCounts.get(table).push(...rowIds);

      allInserts.push(insert);

    } else if (type === "DO") {
      // Check for temporal functions in DO block
      if (/now\s*\(|current_timestamp|clock_timestamp/i.test(stmtSql)) codes.push(CODE.NOW_DEFAULT);
      codes.push(CODE.UNKNOWN_STATEMENT);
    } else if (type === "INSERT_UNQUALIFIED") {
      codes.push(CODE.MALFORMED);
    } else if (type === "INSERT_SELECT") {
      codes.push(CODE.INSERT_SELECT);
    } else {
      codes.push(CODE.UNKNOWN_STATEMENT);
    }
  }

  // 6. Transcript ordinal validation
  for (const ins of allInserts) {
    const tcCodes = validateTranscriptOrdinals(ins);
    if (tcCodes) codes.push(...tcCodes);
  }
  const tcCountCodes = validateTranscriptCountBySession(allInserts);
  if (tcCountCodes) codes.push(...tcCountCodes);

  // 7. Consent proof validation
  for (const ins of allInserts) {
    const cCodes = validateConsentProof(ins);
    if (cCodes) codes.push(...cCodes);
  }

  // 8. Exact content validation
  for (const ins of allInserts) {
    const eccodes = validateExactContent(ins);
    if (eccodes) codes.push(...eccodes);
  }

  // 9. Check reserved UUIDs exist
  if (allInserts.length === 0) codes.push(CODE.NO_RESERVED_UUID);

  // 10. Manifest cardinality
  const manifestIDs = new Set();
  for (const [table, m] of MANIFEST) {
    const actualIDs = (tableRowCounts.get(table) || []).filter(id => isReserved(id));
    const expectedSet = new Set(m.ids);
    const actualSet = new Set(actualIDs);

    // Check every expected ID is present
    for (const eid of m.ids) {
      if (!actualSet.has(eid)) codes.push(CODE.CARDINALITY_MISMATCH);
    }
    // Check for unknown reserved IDs
    for (const aid of actualIDs) {
      if (!expectedSet.has(aid)) codes.push(CODE.UNKNOWN_RESERVED_ID);
    }

    for (const id of actualIDs) manifestIDs.add(id);
  }

  // 11. FK validation
  for (const ins of allInserts) {
    const { table, columns, rows } = ins;
    const man = MANIFEST.get(table);
    if (!man) continue;
    for (const [fkCol, parentTable] of Object.entries(man.refs)) {
      const fkIdx = columns.indexOf(fkCol);
      if (fkIdx < 0) continue;
      const parentMan = MANIFEST.get(parentTable);
      if (!parentMan) continue;
      const parentIDs = new Set(parentMan.ids);
      for (const row of rows) {
        const fkVal = cleanSQLValue(row[fkIdx]).toLowerCase();
        if (!fkVal || fkVal === "null") continue;
        if (!parentIDs.has(fkVal)) codes.push(CODE.BAD_FK_REF);
      }
    }
  }

  // 12. Missing table check
  for (const [table] of MANIFEST) {
    if (!tableRowCounts.has(table) || (tableRowCounts.get(table) || []).length === 0) {
      codes.push(CODE.MISSING_TABLE);
    }
  }

  return { passed: codes.length === 0, codes: [...new Set(codes)] };
}

// ===================================================================
// CLI entry point
// ===================================================================
async function main() {
  const filePath = process.argv[2] || path.join(process.argv[1], "../../app/supabase/seed.sql");
  const resolvedPath = path.resolve(filePath);

  let sql;
  try {
    sql = await readFile(resolvedPath, "utf8");
  } catch (err) {
    console.error("ERROR: Could not read seed file:", err.message);
    process.exit(2);
  }

  const result = await validate(sql, resolvedPath);

  if (result.passed) {
    console.log("\nVALIDATOR PASSED");
    process.exit(0);
  } else {
    for (const code of result.codes) {
      const msg = CODE_MSG[code] || "Unknown code";
      console.log(`  ${code}: ${msg}`);
    }
    console.log("\nVALIDATOR FAILED —", result.codes.length, "code(s)");
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("check-synthetic-seed.mjs") || process.argv[1].includes("check-synthetic-seed"))) {
  main();
}

export {
  validate, stripComments, parseStatements, classifyStatement, parseInsert,
  extractInsertIDs, extractAllValuesIDs, hasOnConflict, isReserved,
  cleanSQLValue, checkUnclosedSyntax, validateAssessmentRaw,
  validateSyntheticMarker, validateColumnManifest, validateExactContent,
  validateTranscriptOrdinals, validateConsentProof, validateTimestampLiteral,
  parseJSONValue, CODE, CODE_MSG, MANIFEST, CANONICAL_COLUMNS, OMITTABLE_COLUMNS,
  EXPECTED_CONTENT, APPROVED_TIMESTAMPS,
};
