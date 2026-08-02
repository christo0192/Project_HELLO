#!/usr/bin/env node
// run-phase12-hypercare-drill.test.mjs
//
// Self-test for the LCH-03 synthetic hypercare drill harness. Node stdlib
// only. Spawns the real CLI for every case (exercises the actual entry point)
// and asserts exit codes, parsed JSON results, and byte-identical output for
// determinism. Covers:
//   - committed fixtures (0/50/200/1000) incl. non-vacuity and threshold/above
//   - determinism (two identical runs -> byte-identical stdout)
//   - missing required fields, type mismatches, integer/bounds violations
//   - enum violations, extra-key injection
//   - real/SLO/error-budget claim rejection
//   - cross-field invariants (zero-session acceptance, below-threshold
//     acceptance, declared-vs-computed mismatch, elapsed-hours-only)
//   - fake-ID bypass attempts (EV-*, session IDs, tickets, endpoints)
//   - no false positives on truthful prose
//
// Exit code 0 iff every assertion passes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'run-phase12-hypercare-drill.mjs');
const REPO_ROOT = path.resolve(path.dirname(HARNESS), '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'infra', 'launch', 'fixtures', 'hypercare');
const EXAMPLE = path.join(REPO_ROOT, 'infra', 'launch', 'hypercare-drill.example.json');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; failures.push(msg); }
}

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// Base fixture: a valid below-threshold drill (mirrors sessions-50.json).
const baseFixture = {
  manifestVersion: '1.0.0',
  version: '1.0.0',
  drillKind: 'lch03-hypercare-synthetic-sessions',
  title: 'test fixture',
  description: 'test drill fixture',
  authority: {
    source: 'config/current-state.json',
    role: 'authoritative-source-of-truth',
    note: 'test note',
  },
  drill: {
    declaredThreshold: 100,
    syntheticSessionCount: 50,
    elapsedHours: 0,
    elapsedHoursOnly: false,
    trafficSource: 'synthetic_local',
    hypercareWindowAccepted: false,
    hypercareStatus: 'PENDING',
    productionAcceptance: false,
    sloAttainment: null,
    errorBudgetRemaining: null,
    errorBudgetHealthy: null,
    incidentCadence: 'PENDING',
    rollbackAuthority: 'PENDING',
  },
  evidence: {
    evidenceType: 'synthetic_local',
    status: 'PENDING',
    sessionIds: [],
    endpoints: [],
    note: 'test evidence',
  },
};

let tmpCounter = 0;
function writeTemp(doc) {
  tmpCounter += 1;
  const p = path.join(os.tmpdir(), `phase12-l3-drill-${process.pid}-${tmpCounter}.json`);
  fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return p;
}

function run(args) {
  const r = spawnSync(process.execPath, [HARNESS, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  let parsed = null;
  try {
    // The result JSON is the last top-level block on stdout: either the whole
    // stream (single fixture) or the block that starts on a line beginning with
    // '{' (--all prints a text table first, then one JSON object).
    const lines = r.stdout.split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trimStart().startsWith('{')) { start = i; break; }
    }
    if (start >= 0) parsed = JSON.parse(lines.slice(start).join('\n'));
  } catch { parsed = null; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, parsed };
}

function expectInvalid(doc, label, { mustMention = [] } = {}) {
  const p = writeTemp(doc);
  const r = run([p]);
  assert(r.status === 1, `${label}: expected exit 1 (got ${r.status})`);
  assert(r.parsed && r.parsed.valid === false, `${label}: expected valid=false`);
  for (const token of mustMention) {
    const joined = `${r.stdout}\n${r.stderr}`;
    assert(joined.includes(token), `${label}: expected error mentioning "${token}"`);
  }
  fs.unlinkSync(p);
}

function expectValid(doc, label, { expectedMet = null } = {}) {
  const p = writeTemp(doc);
  const r = run([p]);
  assert(r.status === 0, `${label}: expected exit 0 (got ${r.status})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert(r.parsed && r.parsed.valid === true, `${label}: expected valid=true`);
  if (expectedMet !== null) {
    assert(r.parsed.syntheticThresholdMet === expectedMet, `${label}: expected syntheticThresholdMet=${expectedMet} (got ${r.parsed.syntheticThresholdMet})`);
  }
  fs.unlinkSync(p);
}

// ---------------------------------------------------------------------------
// 1. Committed fixtures (positive controls + non-vacuity)
// ---------------------------------------------------------------------------
const committed = ['sessions-0.json', 'sessions-50.json', 'sessions-200.json', 'sessions-1000.json'];
const expectedResults = { 'sessions-0.json': false, 'sessions-50.json': false, 'sessions-200.json': true, 'sessions-1000.json': true };

for (const name of committed) {
  const p = path.join(FIXTURES_DIR, name);
  const r = run([p]);
  assert(r.status === 0, `${name}: expected exit 0 (got ${r.status})`);
  assert(r.parsed && r.parsed.valid === true, `${name}: expected valid=true`);
  assert(r.parsed.syntheticThresholdMet === expectedResults[name], `${name}: expected syntheticThresholdMet=${expectedResults[name]}`);
  assert(r.parsed.hypercareWindowAccepted === expectedResults[name], `${name}: declared hypercareWindowAccepted must equal computed result`);
  assert(r.parsed.declaredClaimVerified === true, `${name}: declaredClaimVerified must be true`);
  // never-positive invariants on every committed fixture result
  assert(r.parsed.hypercareStatus === 'NOT_RUN' || r.parsed.hypercareStatus === 'PENDING', `${name}: hypercareStatus must stay NOT_RUN/PENDING`);
  assert(r.parsed.productionAcceptance === false, `${name}: productionAcceptance must be false`);
  assert(r.parsed.sloAttainment === null, `${name}: sloAttainment must be null`);
  assert(r.parsed.errorBudgetRemaining === null, `${name}: errorBudgetRemaining must be null`);
  assert(r.parsed.errorBudgetHealthy === null, `${name}: errorBudgetHealthy must be null`);
  assert(r.parsed.incidentCadence === 'PENDING', `${name}: incidentCadence must be PENDING`);
  assert(r.parsed.rollbackAuthority === 'PENDING', `${name}: rollbackAuthority must be PENDING`);
  assert(r.parsed.evidenceType === 'synthetic_local', `${name}: evidenceType must be synthetic_local`);
  assert(r.parsed.elapsedHoursUsedForAcceptance === false, `${name}: elapsed hours must never be used for acceptance`);
  assert(r.parsed.wallClockAcceptance === false, `${name}: wall-clock acceptance must never be true`);
  assert(r.parsed.acceptanceBasis === 'synthetic_session_count_vs_declared_threshold', `${name}: acceptance basis must be count-vs-threshold`);
}

// non-vacuity: zero-session fixture is NOT accepted
assert(expectedResults['sessions-0.json'] === false, 'zero-session fixture must prove gate non-vacuity (not accepted)');

// --all mode
{
  const r = run(['--all']);
  assert(r.status === 0, '--all: expected exit 0');
  assert(r.parsed && r.parsed.mode === 'committed-fixture-matrix', '--all: expected matrix mode');
  assert(r.parsed.allValid === true, '--all: allValid must be true');
  assert(r.parsed.fixtures.length === 4, '--all: must report exactly 4 fixtures');
  for (const f of r.parsed.fixtures) {
    assert(f.declaredClaimVerified === true, `--all: ${f.fixture} claim must be verified`);
  }
}

// --example mode
{
  const r = run(['--example']);
  assert(r.status === 0, '--example: expected exit 0');
  assert(r.parsed && r.parsed.valid === true, '--example: expected valid=true');
  assert(r.parsed.syntheticThresholdMet === false, '--example: example is a zero-session template, must not be met');
  assert(r.parsed.hypercareStatus === 'PENDING', '--example: hypercareStatus must stay PENDING');
}

// ---------------------------------------------------------------------------
// 2. Determinism
// ---------------------------------------------------------------------------
{
  const p = path.join(FIXTURES_DIR, 'sessions-1000.json');
  const r1 = run([p]);
  const r2 = run([p]);
  assert(r1.status === 0 && r2.status === 0, 'determinism: both runs must exit 0');
  assert(r1.stdout === r2.stdout, 'determinism: identical input must produce byte-identical stdout (single fixture)');
  const a1 = run(['--all']);
  const a2 = run(['--all']);
  assert(a1.stdout === a2.stdout, 'determinism: identical input must produce byte-identical stdout (--all matrix)');
}

// ---------------------------------------------------------------------------
// 3. Missing required fields
// ---------------------------------------------------------------------------
{
  const cases = [
    ['missing root drillKind', (d) => { delete d.drillKind; }, 'drillKind'],
    ['missing root authority', (d) => { delete d.authority; }, 'authority'],
    ['missing root evidence', (d) => { delete d.evidence; }, 'evidence'],
    ['missing drill.syntheticSessionCount', (d) => { delete d.drill.syntheticSessionCount; }, 'syntheticSessionCount'],
    ['missing drill.declaredThreshold', (d) => { delete d.drill.declaredThreshold; }, 'declaredThreshold'],
    ['missing drill.hypercareWindowAccepted', (d) => { delete d.drill.hypercareWindowAccepted; }, 'hypercareWindowAccepted'],
    ['missing drill.productionAcceptance', (d) => { delete d.drill.productionAcceptance; }, 'productionAcceptance'],
    ['missing drill.hypercareStatus', (d) => { delete d.drill.hypercareStatus; }, 'hypercareStatus'],
    ['missing drill.rollbackAuthority', (d) => { delete d.drill.rollbackAuthority; }, 'rollbackAuthority'],
    ['missing evidence.sessionIds', (d) => { delete d.evidence.sessionIds; }, 'sessionIds'],
    ['missing evidence.endpoints', (d) => { delete d.evidence.endpoints; }, 'endpoints'],
    ['missing authority.source', (d) => { delete d.authority.source; }, 'authority.source'],
  ];
  for (const [label, mutate, token] of cases) {
    const d = deepClone(baseFixture);
    mutate(d);
    expectInvalid(d, label, { mustMention: [token] });
  }
}

// ---------------------------------------------------------------------------
// 4. Type mismatches
// ---------------------------------------------------------------------------
{
  const cases = [
    ['syntheticSessionCount as string "100"', (d) => { d.drill.syntheticSessionCount = '100'; }, 'integer'],
    ['declaredThreshold as string "100"', (d) => { d.drill.declaredThreshold = '100'; }, 'integer'],
    ['declaredThreshold as float 100.5', (d) => { d.drill.declaredThreshold = 100.5; }, 'integer'],
    ['hypercareWindowAccepted as string "yes"', (d) => { d.drill.hypercareWindowAccepted = 'yes'; }, 'boolean'],
    ['productionAcceptance as string "false"', (d) => { d.drill.productionAcceptance = 'false'; }, 'boolean'],
    ['elapsedHours as string "0"', (d) => { d.drill.elapsedHours = '0'; }, 'integer'],
    ['elapsedHoursOnly as string "false"', (d) => { d.drill.elapsedHoursOnly = 'false'; }, 'boolean'],
    ['manifestVersion as number 1.0', (d) => { d.manifestVersion = 1.0; }, 'manifestVersion'],
    ['drillKind as number', (d) => { d.drillKind = 42; }, 'drillKind'],
    ['trafficSource as number', (d) => { d.drill.trafficSource = 42; }, 'trafficSource'],
    ['evidence.evidenceType as boolean', (d) => { d.evidence.evidenceType = true; }, 'evidenceType'],
    ['evidence.sessionIds as object', (d) => { d.evidence.sessionIds = {}; }, 'sessionIds'],
    ['authority as array', (d) => { d.authority = []; }, 'authority'],
  ];
  for (const [label, mutate, token] of cases) {
    const d = deepClone(baseFixture);
    mutate(d);
    expectInvalid(d, label, { mustMention: [token] });
  }
}

// ---------------------------------------------------------------------------
// 5. Bounds / integer range
// ---------------------------------------------------------------------------
{
  const cases = [
    ['syntheticSessionCount -1', (d) => { d.drill.syntheticSessionCount = -1; }, 'out of bounds'],
    ['syntheticSessionCount 10001', (d) => { d.drill.syntheticSessionCount = 10001; }, 'out of bounds'],
    ['declaredThreshold 0 (vacuous)', (d) => { d.drill.declaredThreshold = 0; }, 'out of bounds'],
    ['declaredThreshold 10001', (d) => { d.drill.declaredThreshold = 10001; }, 'out of bounds'],
    ['elapsedHours -1', (d) => { d.drill.elapsedHours = -1; }, 'out of bounds'],
    ['elapsedHours 169', (d) => { d.drill.elapsedHours = 169; }, 'out of bounds'],
    ['declaredThreshold NaN', (d) => { d.drill.declaredThreshold = Number.NaN; }, 'integer'],
  ];
  for (const [label, mutate, token] of cases) {
    const d = deepClone(baseFixture);
    mutate(d);
    expectInvalid(d, label, { mustMention: [token] });
  }
}

// ---------------------------------------------------------------------------
// 6. Enum violations
// ---------------------------------------------------------------------------
{
  const cases = [
    ['trafficSource "production"', (d) => { d.drill.trafficSource = 'production'; }, 'trafficSource'],
    ['trafficSource "real"', (d) => { d.drill.trafficSource = 'real'; }, 'trafficSource'],
    ['trafficSource "prod"', (d) => { d.drill.trafficSource = 'prod'; }, 'trafficSource'],
    ['hypercareStatus "ACTIVE"', (d) => { d.drill.hypercareStatus = 'ACTIVE'; }, 'hypercareStatus'],
    ['hypercareStatus "RUNNING"', (d) => { d.drill.hypercareStatus = 'RUNNING'; }, 'hypercareStatus'],
    ['hypercareStatus "COMPLETE"', (d) => { d.drill.hypercareStatus = 'COMPLETE'; }, 'hypercareStatus'],
    ['incidentCadence "ACTIVE"', (d) => { d.drill.incidentCadence = 'ACTIVE'; }, 'incidentCadence'],
    ['incidentCadence "SCHEDULED"', (d) => { d.drill.incidentCadence = 'SCHEDULED'; }, 'incidentCadence'],
    ['rollbackAuthority "AUTHORIZED"', (d) => { d.drill.rollbackAuthority = 'AUTHORIZED'; }, 'rollbackAuthority'],
    ['rollbackAuthority "APPROVED"', (d) => { d.drill.rollbackAuthority = 'APPROVED'; }, 'rollbackAuthority'],
    ['drillKind "lch99-x"', (d) => { d.drillKind = 'lch99-x'; }, 'drillKind'],
    ['evidence.status "COMPLETE"', (d) => { d.evidence.status = 'COMPLETE'; }, 'status'],
  ];
  for (const [label, mutate, token] of cases) {
    const d = deepClone(baseFixture);
    mutate(d);
    expectInvalid(d, label, { mustMention: [token] });
  }
}

// ---------------------------------------------------------------------------
// 7. Extra-key injection
// ---------------------------------------------------------------------------
{
  const cases = [
    ['extra root productionEndpoint', (d) => { d.productionEndpoint = 'https://example.invalid/prod'; }, 'productionEndpoint'],
    ['extra root sessionId', (d) => { d.sessionId = 'sess-abc123'; }, 'sessionId'],
    ['extra root approvedBy', (d) => { d.approvedBy = 'Jane'; }, 'approvedBy'],
    ['extra root signatureDate', (d) => { d.signatureDate = '2026-09-01'; }, 'signatureDate'],
    ['extra drill.onCallActive', (d) => { d.drill.onCallActive = true; }, 'onCallActive'],
    ['extra drill.sloHealth', (d) => { d.drill.sloHealth = 'healthy'; }, 'sloHealth'],
    ['extra evidence.evidenceId', (d) => { d.evidence.evidenceId = 'EV-0001'; }, 'evidenceId'],
    ['extra authority.owner', (d) => { d.authority.owner = 'owner'; }, 'authority.owner'],
  ];
  for (const [label, mutate, token] of cases) {
    const d = deepClone(baseFixture);
    mutate(d);
    expectInvalid(d, label, { mustMention: [token] });
  }
}

// ---------------------------------------------------------------------------
// 8. Real / SLO / error-budget claim rejection
// ---------------------------------------------------------------------------
{
  const cases = [
    ['sloAttainment 99.95', (d) => { d.drill.sloAttainment = 99.95; }, 'sloAttainment'],
    ['sloAttainment 99.99', (d) => { d.drill.sloAttainment = 99.99; }, 'sloAttainment'],
    ['errorBudgetRemaining 5.2', (d) => { d.drill.errorBudgetRemaining = 5.2; }, 'errorBudgetRemaining'],
    ['errorBudgetRemaining 0', (d) => { d.drill.errorBudgetRemaining = 0; }, 'errorBudgetRemaining'],
    ['errorBudgetHealthy true', (d) => { d.drill.errorBudgetHealthy = true; }, 'errorBudgetHealthy'],
    ['errorBudgetHealthy false', (d) => { d.drill.errorBudgetHealthy = false; }, 'errorBudgetHealthy'],
  ];
  for (const [label, mutate, token] of cases) {
    const d = deepClone(baseFixture);
    mutate(d);
    expectInvalid(d, label, { mustMention: [token] });
  }
}

// ---------------------------------------------------------------------------
// 9. Cross-field invariants
// ---------------------------------------------------------------------------
{
  const cases = [
    ['accept true + 0 sessions (non-vacuity)', (d) => { d.drill.syntheticSessionCount = 0; d.drill.hypercareWindowAccepted = true; }, 'not vacuous'],
    ['accept true + 5 sessions < threshold 100', (d) => { d.drill.syntheticSessionCount = 5; d.drill.hypercareWindowAccepted = true; }, 'below the declared threshold'],
    ['accept true + 99 sessions < threshold 100', (d) => { d.drill.syntheticSessionCount = 99; d.drill.hypercareWindowAccepted = true; }, 'below the declared threshold'],
    ['accept true + production traffic', (d) => { d.drill.syntheticSessionCount = 200; d.drill.trafficSource = 'production'; d.drill.hypercareWindowAccepted = true; }, 'production'],
    ['declared false but computed true (200>=100)', (d) => { d.drill.syntheticSessionCount = 200; }, 'does not match'],
    ['declared true but computed false (50<100)', (d) => { d.drill.hypercareWindowAccepted = true; }, 'does not match'],
    ['productionAcceptance true', (d) => { d.drill.productionAcceptance = true; }, 'productionAcceptance'],
    ['elapsedHoursOnly true (wall-clock acceptance)', (d) => { d.drill.elapsedHoursOnly = true; }, 'elapsedHoursOnly'],
    ['elapsedHoursOnly true + accept true', (d) => { d.drill.elapsedHoursOnly = true; d.drill.syntheticSessionCount = 200; d.drill.hypercareWindowAccepted = true; }, 'elapsed'],
  ];
  for (const [label, mutate, token] of cases) {
    const d = deepClone(baseFixture);
    mutate(d);
    expectInvalid(d, label, { mustMention: [token] });
  }
}

// ---------------------------------------------------------------------------
// 10. Fake-ID bypass attempts (identifiers must never authorize a claim)
// ---------------------------------------------------------------------------
{
  const cases = [
    ['accept true + 0 sessions + sessionIds [EV-FAKE]', (d) => { d.drill.syntheticSessionCount = 0; d.drill.hypercareWindowAccepted = true; d.evidence.sessionIds = ['EV-FAKE']; }, 'sessionIds'],
    ['accept true + 0 sessions + endpoints [url]', (d) => { d.drill.syntheticSessionCount = 0; d.drill.hypercareWindowAccepted = true; d.evidence.endpoints = ['https://example.invalid/health']; }, 'endpoints'],
    ['accept true + 0 sessions + extra ticket INC-12345', (d) => { d.drill.syntheticSessionCount = 0; d.drill.hypercareWindowAccepted = true; d.ticket = 'INC-12345'; }, 'ticket'],
    ['accept true + 0 sessions + extra uuid', (d) => { d.drill.syntheticSessionCount = 0; d.drill.hypercareWindowAccepted = true; d.uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; }, 'uuid'],
    ['below threshold + extra EV-0001 evidenceId', (d) => { d.evidence.evidenceId = 'EV-0001'; }, 'evidenceId'],
    ['below threshold + extra sessionUrl', (d) => { d.sessionUrl = 'https://example.invalid/s/abc'; }, 'sessionUrl'],
    ['below threshold + sessionIds [sess-abc123]', (d) => { d.evidence.sessionIds = ['sess-abc123']; }, 'sessionIds'],
  ];
  for (const [label, mutate, token] of cases) {
    const d = deepClone(baseFixture);
    mutate(d);
    expectInvalid(d, label, { mustMention: [token] });
  }
}

// ---------------------------------------------------------------------------
// 11. No false positives on truthful prose / non-semantic text
// ---------------------------------------------------------------------------
{
  const d = deepClone(baseFixture);
  d.description = 'This runbook section says go to the next section and click the green button when ready; production launch acceptance remains external.';
  d.title = 'Go/no-go prose test';
  d.evidence.note = 'Synthetic local drill. Real traffic, SLO attainment, and error-budget health are NOT claimed here.';
  d.authority.note = 'Says "production hypercare" only in the negation that it is never accepted by this drill.';
  expectValid(d, 'truthful prose must not cause false positives', { expectedMet: false });
}

// ---------------------------------------------------------------------------
// 12. Usage / I/O handling
// ---------------------------------------------------------------------------
{
  const r = run([]);
  assert(r.status === 2, 'no args: expected exit 2 (usage)');
  const r2 = run(['/nonexistent/phase12-nope.json']);
  assert(r2.status === 1, 'missing file: expected exit 1');
  assert(r2.parsed && r2.parsed.valid === false, 'missing file: expected valid=false');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`PASS=${passed} FAIL=${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`FAILED: ${f}`);
  process.exit(1);
}
console.log('run-phase12-hypercare-drill.test.mjs: ALL GREEN');
