#!/usr/bin/env node

/**
 * check-synthetic-seed.test.mjs — 70+ mutation self-tests
 *
 * Validates every validator code path with targeted mutations.
 * Zero external network calls (import-safety enforced).
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.resolve(__dirname, "../app/supabase/seed.sql");

import {
  validate, checkUnclosedSyntax, parseJSONValue, parseStatements,
  classifyStatement, parseInsert, cleanSQLValue,
  CODE, CODE_MSG,
} from "./check-synthetic-seed.mjs";

// ===================================================================
// Import safety check
// ===================================================================
const SRC = fs.readFileSync(
  path.resolve(__dirname, "check-synthetic-seed.mjs"), "utf8");
const FORBIDDEN_IMPORTS = ["node:http", "node:https", "node:net", "node:child_process", "node:dgram"];
let importSafe = true;
for (const fi of FORBIDDEN_IMPORTS) {
  if (SRC.includes(`from "${fi}"`) || SRC.includes(`from '${fi}'`)) {
    console.log(`FAIL: IMPORT_SAFETY — forbidden import ${fi} found`);
    importSafe = false;
  }
}
if (importSafe) console.log("PASS: IMPORT_SAFETY — no forbidden imports in validator");

// ===================================================================
// Network trap
// ===================================================================
let networkCalls = 0;
const origFetch = globalThis.fetch;
globalThis.fetch = (...args) => { networkCalls++; return Promise.reject(new Error("no network")); };

// ===================================================================
// Test helpers
// ===================================================================
const SEED = fs.readFileSync(SEED_PATH, "utf8");
let passed = 0;
let failed = 0;
const failures = [];

function assert(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; failures.push({ name, detail }); console.log(`FAIL: ${name} — ${detail || "no detail"}`); }
}

async function testMutation(seed, mutationFn, expectedCodes, testName) {
  if (!Array.isArray(expectedCodes)) expectedCodes = [expectedCodes];
  try {
    const mutated = mutationFn(seed);
    const result = await validate(mutated);
    const hasAny = expectedCodes.some(c => result.codes.includes(c));
    assert(testName, hasAny,
      `expected one of [${expectedCodes.join(",")}], got [${result.codes.join(",")}]`);
  } catch (e) {
    assert(testName, false, `exception: ${e.message}`);
  }
}

// Mutation helper: replace the nth occurrence (0-indexed) or all with /g
function replaceNth(str, pattern, replacement, n, flags) {
  const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags || 'g');
  if (flags && flags.includes('g')) return str.replace(re, replacement);
  let count = 0;
  return str.replace(re, (match) => count++ === n ? replacement : match);
}

// ===================================================================
// F1: Statement classification
// ===================================================================
async function f1() {
  const result = await validate(SEED);
  assert("F1-baseline-valid-seed", result.passed, "baseline seed should pass");

  await testMutation(SEED, s => s.replace(/insert into screening_v2\.roles/gi, "insert into roles"), CODE.MALFORMED, "F1-unqualified-insert-rejected");
  await testMutation(SEED, s => s.replace(/insert into screening_v2\.roles/gi, "insert into public.roles"), CODE.MALFORMED, "F1-non-schema-qualified-insert");
  await testMutation(SEED, s => s + "\ndelete from screening_v2.roles;\n", CODE.UNKNOWN_STATEMENT, "F1-delete-rejected");
  await testMutation(SEED, s => s + "\nupdate screening_v2.roles set title = 'x' where id = 'y';\n", CODE.UNKNOWN_STATEMENT, "F1-update-rejected");
  await testMutation(SEED, s => s + "\ntruncate screening_v2.roles;\n", CODE.UNKNOWN_STATEMENT, "F1-truncate-rejected");
  await testMutation(SEED, s => s + "\ncreate table screening_v2.evil (id uuid);\n", CODE.UNKNOWN_STATEMENT, "F1-create-table-rejected");
  await testMutation(SEED, s => s + "\ncomment on table screening_v2.roles is 'test';\n", CODE.UNKNOWN_STATEMENT, "F1-comment-on-rejected");
  await testMutation(SEED, s => s + "\ngrant all on screening_v2.roles to anon;\n", CODE.UNKNOWN_STATEMENT, "F1-grant-rejected");
  await testMutation(SEED, s => s + "\ndo $$ begin raise notice 'test'; end; $$;\n", CODE.UNKNOWN_STATEMENT, "F1-do-block-rejected");
  await testMutation(SEED, s => s + "\nselect * from screening_v2.roles;\n", CODE.UNKNOWN_STATEMENT, "F1-select-rejected");
  await testMutation(SEED, s => s + "\nwith cte as (select 1) select * from cte;\n", CODE.UNKNOWN_STATEMENT, "F1-with-rejected");
  await testMutation(SEED, s => s + "\ncopy screening_v2.roles from stdin;\n", CODE.UNKNOWN_STATEMENT, "F1-copy-rejected");
  await testMutation(SEED, s => s + "\ncall some_proc();\n", CODE.UNKNOWN_STATEMENT, "F1-call-rejected");
  await testMutation(SEED, s => s + "\ninsert into screening_v2.roles (id, title, created_at, updated_at) select id, title, now(), now() from screening_v2.roles;\n",
    CODE.INSERT_SELECT, "F1-insert-select-rejected");
  await testMutation(SEED, s => s.replace(/on conflict \(id\) do nothing/g, "on conflict (title) do nothing"),
    CODE.NO_ON_CONFLICT, "F1-on-conflict-no-id-rejected");
  await testMutation(SEED, s => s.replace(/\s+on conflict \(id\) do nothing/gi, ""),
    CODE.NO_ON_CONFLICT, "F1-missing-on-conflict-rejected");
  await testMutation(SEED, s => s.replace("000000000003'", "000000000099'"),
    [CODE.UNKNOWN_RESERVED_ID, CODE.CARDINALITY_MISMATCH], "F1-extra-unknown-uuid-rejected");
}

// ===================================================================
// F2: Unclosed syntax detection
// ===================================================================
async function f2() {
  assert("F2-unclosed-syntax-baseline", checkUnclosedSyntax(SEED) === null, "baseline");

  // Unclosed single quote: break a candidate name
  const qm = SEED.replace("Synth Demo Candidate Alpha", "Synth Demo Candidate Alpha");
  const uq = SEED.replace("Synth Demo Candidate Alpha'", "Synth Demo Candidate Alpha");
  const r1 = checkUnclosedSyntax(uq);
  assert("F2-unclosed-single-quote", r1 && r1.includes("quote"), `got: ${r1}`);

  // Unclosed block comment: add /* after the header block comment
  const hdrEnd = SEED.lastIndexOf("-- =============================================================================");
  const uc = SEED.slice(0, hdrEnd) + "/* unclosed forever\n" + SEED.slice(hdrEnd);
  const r2 = checkUnclosedSyntax(uc);
  assert("F2-unclosed-block-comment", r2 && r2.includes("block comment"), `got: ${r2}`);

  // Valid dollar-quote
  const dq = SEED + "\ndo $$ begin null; end; $$;\n";
  assert("F2-dollar-quote-closed", checkUnclosedSyntax(dq) === null, "valid dollar quote");

  // Unbalanced parens
  const up = SEED.replace("'60000000-0000-4000-a000-000000000001'", "'60000000-0000-4000-a000-000000000001'");
  // Add an extra opening paren after the last semicolon
  const lastSemi = SEED.lastIndexOf(";");
  const ub = SEED.slice(0, lastSemi + 1) + "(" + SEED.slice(lastSemi + 1);
  const r3 = checkUnclosedSyntax(ub);
  assert("F2-unbalanced-parens", r3 && r3.includes("paren"), `got: ${r3}`);
}

// ===================================================================
// F3: Timestamp validation
// ===================================================================
async function f3() {
  await testMutation(SEED, s => s.replace(/'2026-01-15T10:00:00Z'::timestamptz/g, "now()"), CODE.NOW_DEFAULT, "F3-now-in-exec-sql");
  await testMutation(SEED, s => s.replace(/'2026-01-15T10:00:00Z'::timestamptz/g, "CURRENT_TIMESTAMP"), CODE.NOW_DEFAULT, "F3-current-timestamp-rejected");
  await testMutation(SEED, s => s.replace(/'2026-01-15T10:00:00Z'::timestamptz/g, "null::timestamptz"), CODE.BAD_TIMESTAMP, "F3-null-timestamp-rejected");
  await testMutation(SEED, s => s.replace("'2026-01-15T10:00:00Z'", "'2026-06-15T10:00:00Z'"), CODE.BAD_TIMESTAMP, "F3-wrong-date-rejected");

  // Lifecycle: started_at > ended_at for first call_session
  await testMutation(SEED, s => s.replace(
    "'2026-01-15T10:15:00Z'::timestamptz,\n  900,\n  '2026-01-15T10:15:00Z'::timestamptz\n) on conflict (id) do nothing;\n\ninsert into screening_v2.call_sessions",
    "'2026-01-15T09:00:00Z'::timestamptz,\n  900,\n  '2026-01-15T09:00:00Z'::timestamptz\n) on conflict (id) do nothing;\n\ninsert into screening_v2.call_sessions"),
    CODE.BAD_TIMESTAMP, "F3-lifecycle-ordering-rejected");

  // Duration mismatch
  await testMutation(SEED, s => s.replace(
    "900,\n  '2026-01-15T10:15:00Z'::timestamptz\n) on conflict (id) do nothing;\n\ninsert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, status, terminal_reason, current_question_index, started_at, ended_at, duration_sec, updated_at) values",
    "600,\n  '2026-01-15T10:15:00Z'::timestamptz\n) on conflict (id) do nothing;\n\ninsert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, status, terminal_reason, current_question_index, started_at, ended_at, duration_sec, updated_at) values"),
    CODE.BAD_TIMESTAMP, "F3-duration-mismatch-rejected");

  // now() in consent
  await testMutation(SEED, s => s.replace("'2026-01-15T12:00:00Z'::timestamptz\n) on conflict (id) do nothing;\n\ninsert into screening_v2.consent_records",
    "now()\n) on conflict (id) do nothing;\n\ninsert into screening_v2.consent_records"), CODE.NOW_DEFAULT, "F3-now-in-consent-rejected");
}

// ===================================================================
// F4: Assessment scoring validation
// ===================================================================
async function f4() {
  // overall_score out of range → exact content check catches it first as E035
  await testMutation(SEED, s => s.replace("82,", "200,"), [CODE.BAD_CONTENT, CODE.BAD_ASSESSMENT],
    "F4-overall-score-out-of-range");
  await testMutation(SEED, s => s.replace("82,", "-1,"), [CODE.BAD_CONTENT, CODE.BAD_ASSESSMENT],
    "F4-negative-score-rejected");
}

// ===================================================================
// F5: Column manifest (Finding 1 — includes two reproduced mutations)
// ===================================================================
async function f5() {
  // REPRODUCED: remove required_skills from role INSERT
  await testMutation(SEED, s => s.replace(
    "id, title, jd, required_skills, screening_template, is_active, created_at, updated_at",
    "id, title, jd, screening_template, is_active, created_at, updated_at"),
    CODE.MISSING_COLUMN, "F5-removed-required-skills-rejected");

  // REPRODUCED: add extra column to role INSERT
  await testMutation(SEED, s => s.replace(
    "id, title, jd, required_skills, screening_template, is_active, created_at, updated_at",
    "id, title, jd, required_skills, screening_template, is_active, created_at, updated_at, extra_col"),
    CODE.EXTRA_COLUMN, "F5-extra-column-rejected");

  // Reordered columns
  await testMutation(SEED, s => s.replace(
    "screening_template, is_active, created_at, updated_at",
    "is_active, screening_template, created_at, updated_at"),
    CODE.BAD_COLUMNS, "F5-reordered-columns-rejected");

  // Remove one value from the first roles VALUES row (last updated_at)
  await testMutation(SEED, s => s.replace(
    "'2026-01-15T10:00:00Z'::timestamptz\n) on conflict (id) do nothing;\n\ninsert into screening_v2.roles (id, title, jd, required_skills, screening_template, is_active, created_at, updated_at) values\n(\n  '60000000-0000-4000-a000-000000000002'",
    "\n) on conflict (id) do nothing;\n\ninsert into screening_v2.roles (id, title, jd, required_skills, screening_template, is_active, created_at, updated_at) values\n(\n  '60000000-0000-4000-a000-000000000002'"),
    [CODE.MISSING_ROW_VALUE, CODE.MALFORMED], "F5-missing-row-value-rejected");
}

// ===================================================================
// F6: Assessment raw contract (Finding 2)
// ===================================================================
async function f6() {
  // Target specific assessment raw by using unique context
  // Remove communication from raw in assessment 051
  await testMutation(SEED, s => s.replace(
    '"communication":{"score":8,"clarity":8,"structure":7,"listening":9,"rapport":8,"english_proficiency":{"band":"C1","grammar":8,"vocabulary":7,"fluency":9,"coherence":8,"notes":"Strong English proficiency"},"filler_usage":{"level":"low","examples":["um","like"],"impact_score":8,"notes":"Minimal filler words"},"native_language_usage":{"level":"low","examples":[],"impact_score":9,"notes":"No noticeable native language interference"},"notes":"Good communication overall"},"motivation":{"score":7,"notes":"Showed moderate enthusiasm for the role"}',
    '"motivation":{"score":7,"notes":"Showed moderate enthusiasm for the role"}'),
    CODE.BAD_ASSESSMENT, "F6-missing-communication-raw-rejected");

  // Remove motivation from raw in assessment 051
  await testMutation(SEED, s => s.replace(
    '"motivation":{"score":7,"notes":"Showed moderate enthusiasm for the role"},"resume_conflicts":[]',
    '"resume_conflicts":[]'),
    CODE.BAD_ASSESSMENT, "F6-missing-motivation-raw-rejected");

  // Non-array resume_conflicts in raw JSON
  await testMutation(SEED, s => s.replace(
    '"resume_conflicts":[]}',
    '"resume_conflicts":"not_array"}'),
    CODE.BAD_ASSESSMENT, "F6-resume-conflicts-not-array");

  // Missing is_synthetic in assessment raw
  await testMutation(SEED, s => s.replace(
    '{"is_synthetic":true,"version":"gov-06-synthetic-v1","source":"demo_seed","communication":{"score":8',
    '{"version":"gov-06-synthetic-v1","source":"demo_seed","communication":{"score":8'),
    CODE.BAD_ASSESSMENT, "F6-missing-is-synthetic-rejected");

  // Sub-score out of range (communication.score > 10)
  await testMutation(SEED, s => s.replace(
    '"score":8,"clarity":8,"structure":7,"listening":9,"rapport":8,"english_proficiency"',
    '"score":15,"clarity":8,"structure":7,"listening":9,"rapport":8,"english_proficiency"'),
    CODE.BAD_ASSESSMENT, "F6-sub-score-out-of-range");
}

// ===================================================================
// F7: Exact content (Finding 3)
// ===================================================================
async function f7() {
  // Wrong candidate→role mapping
  await testMutation(SEED, s => s.replace(
    "000000000021',\n  '60000000-0000-4000-a000-000000000001',\n  '60000000-0000-4000-a000-000000000011'",
    "000000000021',\n  '60000000-0000-4000-a000-000000000002',\n  '60000000-0000-4000-a000-000000000012'"),
    CODE.BAD_CONTENT, "F7-wrong-candidate-role-rejected");

  // Wrong session→candidate in assessment
  await testMutation(SEED, s => s.replace(
    "000000000051',\n  '60000000-0000-4000-a000-000000000031',\n  '60000000-0000-4000-a000-000000000021'",
    "000000000051',\n  '60000000-0000-4000-a000-000000000031',\n  '60000000-0000-4000-a000-000000000022'"),
    CODE.BAD_CONTENT, "F7-wrong-assessment-candidate-rejected");

  // Wrong session mode
  await testMutation(SEED, s => s.replace("'browser',\n  'pipecat',", "'live',\n  'pipecat',"),
    CODE.BAD_CONTENT, "F7-wrong-session-mode-rejected");

  // Wrong provider
  await testMutation(SEED, s => s.replace("'browser',\n  'pipecat',", "'browser',\n  'twilio',"),
    CODE.BAD_CONTENT, "F7-wrong-session-provider-rejected");

  // Wrong consent source (exact content check catches it)
  await testMutation(SEED, s => s.replace("'demo_seed'", "'manual'"),
    [CODE.BAD_CONSENT, CODE.BAD_CONTENT], "F7-wrong-consent-source-rejected");
}

// ===================================================================
// F8: Transcript ordinal validation
// ===================================================================
async function f8() {
  // Duplicate turn index in session 031
  await testMutation(SEED,
    s => s.replace("1, 'candidate',", "0, 'candidate',")
          .replace("'Synth Demo Candidate Beta'", "'Synth Demo Candidate Beta'"),
    CODE.BAD_TRANSCRIPT, "F8-transcript-ordinal-dup-rejected");

  // Wrong speaker
  await testMutation(SEED,
    s => s.replace("'candidate',", "'interviewer',"),
    CODE.BAD_TRANSCRIPT, "F8-wrong-speaker-rejected");
}

// ===================================================================
// F9: Consent proof validation
// ===================================================================
async function f9() {
  await testMutation(SEED, s => s.replace('"method":"simulated_consent"', '"method":"real_consent"'),
    CODE.BAD_CONSENT, "F9-wrong-consent-method-rejected");

  // Target unique consent proof text: simulated_consent + timestamp + is_synthetic
  await testMutation(SEED, s => s.replace(
    '"timestamp":"2026-01-15T12:00:00Z","is_synthetic":true}',
    '"timestamp":"2026-01-15T12:00:00Z"}'),
    CODE.BAD_CONSENT, "F9-missing-consent-is-synthetic-rejected");
}

// ===================================================================
// F10: Non-disclosing diagnostics
// ===================================================================
async function f10() {
  const validResult = await validate(SEED);
  assert("F10-valid-seed", validResult.passed && validResult.codes.length === 0,
    "valid seed produces no codes");

  // Invalid seed produces codes
  const mutResult = await validate(SEED.replace(/'2026-01-15T10:00:00Z'::timestamptz/g, "null::timestamptz"));
  assert("F10-invalid-seed-codes", mutResult.codes.length > 0, "codes present");

  // CLI exit codes (use relative paths to avoid spaces in __dirname)
  const tmpFile = path.resolve("/tmp", "__tmp_seed_test.sql");
  const scriptRel = "check-synthetic-seed.mjs";
  const cwd = __dirname;
  try {
    await writeFile(tmpFile, SEED);
    const out = execSync(`node "${scriptRel}" "${tmpFile}"`, { encoding: "utf8", cwd });
    assert("F10-CLI-valid-exit-0", out.includes("PASSED"), "valid seed exit 0");
  } catch (e) { assert("F10-CLI-valid-exit-0", false, `exception: ${e.message}`); }
  try { await unlink(tmpFile); } catch {}

  try {
    await writeFile(tmpFile, "garbage sql;");
    execSync(`node "${scriptRel}" "${tmpFile}"`, { encoding: "utf8", cwd });
    assert("F10-CLI-invalid-exit-1", false, "invalid seed should exit 1");
  } catch (e) {
    if (e.status === 1) assert("F10-CLI-invalid-exit-1", true, "invalid seed exits 1");
    else assert("F10-CLI-invalid-exit-1", false, `exit ${e.status}: ${e.message}`);
  }
  try { await unlink(tmpFile); } catch {}

  // Missing file test — use direct relative path to avoid cwd issues
  try {
    const result = execSync(`node "${scriptRel}" __nonexistent_gov06_file.sql`, { encoding: "utf8", cwd });
    assert("F10-CLI-missing-exit-2", false, "expected exit 2 for missing file");
  } catch (e) {
    // execSync throws on non-zero exit; check stderr for file-not-found message
    const stderr = e.stderr || "";
    const status = e.status;
    assert("F10-CLI-missing-exit-2", status === 2 || /Could not read seed file/i.test(stderr),
      `status=${status}, stderr=${stderr.slice(0,200)}`);
  }
}

// ===================================================================
// F11: No raw data in code messages
// ===================================================================
async function f11() {
  const codeTexts = Object.values(CODE_MSG).join(" ");
  // token is a legitimate code description word (E013: "Secret token..."), not leaked data
  const patterns = [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, /@example/, /\/home\//];
  for (const p of patterns) {
    if (p.test(codeTexts)) { assert("F11-no-leaked-data", false, `leaked ${p}`); return; }
  }
  assert("F11-no-leaked-data", true, "no raw data leaked in code messages");
}

// ===================================================================
// F12: Synthetic marker
// ===================================================================
async function f12() {
  await testMutation(SEED, s => s.replace("Synthetic Demo Test Engineer", "Regular Test Engineer"),
    CODE.SYNTHETIC_MARKER, "F12-missing-synthetic-marker-rejected");
  await testMutation(SEED, s => s.replace("SYNTHETIC DEMO", "ACTUAL REAL DATA"),
    CODE.SYNTHETIC_MARKER, "F12-missing-synthetic-summary-rejected");
}

// ===================================================================
// F13: Email/phone/PII
// ===================================================================
async function f13() {
  await testMutation(SEED, s => s.replaceAll("@example.invalid", "@gmail.com"),
    CODE.REAL_EMAIL, "F13-real-email-domain-rejected");
  await testMutation(SEED, s => s.replace(
    "'Synthetic Demo Test Engineer'",
    "'ghp_abcdefghijklmnopqrstuvwxyz1234567890'"),
    CODE.PII_SECRET, "F13-secret-ghp-token-rejected");
}

// ===================================================================
// F14: Forbidden + non-allowed tables
// ===================================================================
async function f14() {
  await testMutation(SEED, s => s + "\ninsert into screening_v2.call_queue (id, candidate_id, status, created_at) values ('60000000-0000-4000-a000-000000000071', '60000000-0000-4000-a000-000000000021', 'pending', '2026-01-15T12:00:00Z'::timestamptz) on conflict (id) do nothing;\n",
    CODE.FORBIDDEN_TABLE, "F14-forbidden-table-rejected");
  await testMutation(SEED, s => s + "\ninsert into screening_v2.unknown_table (id) values ('60000000-0000-4000-a000-000000000099') on conflict (id) do nothing;\n",
    CODE.NON_ALLOWED_TABLE, "F14-non-allowed-table-insert");
}

// ===================================================================
// F15: Duplicate IDs
// ===================================================================
async function f15() {
  await testMutation(SEED, s => s.replace("000000000002',", "000000000001',"),
    CODE.DUP_ID_WITHIN, "F15-dup-id-within-table");
}

// ===================================================================
// F16: FK validation
// ===================================================================
async function f16() {
  await testMutation(SEED, s => s.replace(
    "000000000021',\n  '60000000-0000-4000-a000-000000000001',\n  '60000000-0000-4000-a000-000000000011'",
    "000000000021',\n  '60000000-0000-4000-a000-000000000099',\n  '60000000-0000-4000-a000-000000000011'"),
    CODE.BAD_FK_REF, "F16-bad-fk-ref-rejected");
}

// ===================================================================
// F17: Network isolation
// ===================================================================
async function f17() {
  assert("F17-network-trap", networkCalls === 0, `expected 0, got ${networkCalls}`);
}

// ===================================================================
// Run all
// ===================================================================
const start = Date.now();

await f1();
await f2();
await f3();
await f4();
await f5();
await f6();
await f7();
await f8();
await f9();
await f10();
await f11();
await f12();
await f13();
await f14();
await f15();
await f16();
await f17();

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed, ${total} total (${Date.now() - start}ms)`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f.name}: ${f.detail}`);
  process.exit(1);
}
