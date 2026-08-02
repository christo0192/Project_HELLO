#!/usr/bin/env node
// check-phase12-launch-status.test.mjs
//
// Self-test for the Phase 12 comprehensive contract validator. Node stdlib
// only. Every negative control builds a temp fixture tree (copy of the
// committed Phase 12 artifacts), mutates ONE artifact, runs the real
// validator CLI, and asserts exit 1 with the expected error tokens. Positive
// controls assert exit 0 (committed happy paths, truthful prose).
//
// Coverage (non-vacuous, per LCH category 01-04):
//   - missing required fields, type mismatches, enum/const violations,
//     extra-key injection, cross-field invariant violations, positive claims
//   - fake evidence IDs adjacent to claims (no identifier bypass)
//   - canonical gate mismatch / duplicate / out-of-set (LCH-01)
//   - hypercare zero-session / elapsed-hours-only / declared-vs-computed
//     mismatch / bounds (LCH-03)
//   - retro positive statuses and action-item filing (LCH-04)
//   - evidence path safety (absolute, traversal, NUL, non-regular file)
//   - current-state byte identity (git baseline in a fixture repo)
//   - truthful prose must NOT false-positive (structured values only)
//   - determinism: two identical runs -> byte-identical stdout
//
// Exit code 0 iff every assertion passes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VALIDATOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'check-phase12-launch-status.mjs');
const REPO_ROOT = path.resolve(path.dirname(VALIDATOR), '..');

let passed = 0;
let failed = 0;
const failures = [];

function assertOk(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; failures.push(msg); }
}

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, doc) { fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`, 'utf8'); }

/**
 * Turn a fixture dir into a git repo with a baseline commit and return the
 * exact baseline SHA. Every fixture validator run compares current-state
 * byte identity against an exact immutable base, never a moving branch tip.
 */
function gitBaseline(fixture) {
  const run = (args) => spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
  run(['init', '-q']);
  run(['add', '-A']);
  const commit = run(['-c', 'user.name=phase12-test', '-c', 'user.email=phase12-test@example.com', 'commit', '-q', '-m', 'baseline']);
  if (commit.status !== 0) throw new Error(`fixture git baseline commit failed: ${commit.stderr || commit.stdout}`);
  return run(['rev-parse', 'HEAD']).stdout.trim();
}

// ---------------------------------------------------------------------------
// Fixture tree: every file the validator reads, copied from the real repo.
// ---------------------------------------------------------------------------
const FIXTURE_FILES = [
  'PLAN.md',
  'config/current-state.json',
  'config/phase12-launch-readiness.schema.json',
  'config/phase12-launch-execution.schema.json',
  'config/phase12-hypercare.schema.json',
  'config/phase12-retro.schema.json',
  'infra/launch/launch-readiness.example.json',
  'infra/launch/launch-execution.example.json',
  'infra/launch/hypercare-drill.example.json',
  'infra/launch/retro-template.example.json',
  'infra/launch/fixtures/hypercare/sessions-0.json',
  'infra/launch/fixtures/hypercare/sessions-50.json',
  'infra/launch/fixtures/hypercare/sessions-200.json',
  'infra/launch/fixtures/hypercare/sessions-1000.json',
  'infra/deployment-contracts/release-record.example.json',
  'infra/deployment-contracts/manifest.json',
  'scripts/validate-deployment-release',
  'scripts/check-phase12-launch-status.mjs',
  'scripts/run-phase12-hypercare-drill.mjs',
  'docs/current-state.md',
  'docs/launch/launch-readiness.md',
  'docs/runbooks/production-launch.md',
  'docs/runbooks/production-rollback.md',
  'docs/runbooks/launch-hypercare.md',
  'docs/runbooks/launch-incident-cadence.md',
  'docs/runbooks/post-launch-retro.md',
];

async function copyFixtureTree(fixture) {
  for (const rel of FIXTURE_FILES) {
    const dest = path.join(fixture, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, rel), dest);
  }
}

function runValidator(fixture, extraArgs = []) {
  return spawnSync(process.execPath, [path.join(fixture, 'scripts/check-phase12-launch-status.mjs'), ...extraArgs], {
    cwd: fixture,
    encoding: 'utf8',
  });
}

/**
 * Build a fixture, apply `mutate(fixture)`, run the validator, assert result.
 * @param {(fixture: string) => void} mutate
 * @param {{tokens?: string[], expectExit?: number, label?: string}} opts
 */
async function withFixture(mutate, { tokens = [], expectExit = 1, label = 'case' } = {}) {
  const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'phase12-l4-'));
  try {
    await copyFixtureTree(fixture);
    await gitBaseline(fixture);
    await mutate(fixture);
    const res = runValidator(fixture, ['--baseline-ref', 'HEAD']);
    assertOk(res.status === expectExit, `${label}: expected exit ${expectExit} (got ${res.status})\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const joined = `${res.stdout}\n${res.stderr}`;
    for (const t of tokens) {
      assertOk(joined.includes(t), `${label}: expected output mentioning "${t}" (got: ${joined.slice(0, 2000)})`);
    }
    return res;
  } finally {
    await fs.promises.rm(fixture, { recursive: true, force: true });
  }
}

const EXAMPLE_PATHS = {
  lch01: 'infra/launch/launch-readiness.example.json',
  lch02: 'infra/launch/launch-execution.example.json',
  lch03: 'infra/launch/fixtures/hypercare/sessions-50.json',
  lch04: 'infra/launch/retro-template.example.json',
};

function mutateExample(cat, change) {
  return async (fixture) => {
    const rel = EXAMPLE_PATHS[cat];
    const doc = readJson(path.join(fixture, rel));
    change(doc);
    writeJson(path.join(fixture, rel), doc);
  };
}

// ---------------------------------------------------------------------------
// 1. Committed happy paths (positive controls)
// ---------------------------------------------------------------------------
{
  const r = runValidator(REPO_ROOT);
  assertOk(r.status === 0, `real repo validator must exit 0 (got ${r.status})\n${r.stdout}\n${r.stderr}`);
  assertOk(r.stdout.includes('RESULT: ALL GREEN'), 'real repo must report ALL GREEN');
}
{
  const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'phase12-l4-'));
  try {
    await copyFixtureTree(fixture);
    await gitBaseline(fixture);
    const r = runValidator(fixture, ['--baseline-ref', 'HEAD']);
    assertOk(r.status === 0, `unmutated fixture must exit 0 (got ${r.status})\n${r.stdout}\n${r.stderr}`);
    assertOk(r.stdout.includes('schemas validated: 4'), 'fixture must validate 4 schemas');
    assertOk(r.stdout.includes('examples validated: 4'), 'fixture must validate 4 examples');
    assertOk(r.stdout.includes('hypercare fixtures validated: 4'), 'fixture must validate 4 hypercare fixtures');
    assertOk(r.stdout.includes('canonical launch gates (PLAN.md section 8): 17'), 'fixture must report 17 canonical gates');
  } finally {
    await fs.promises.rm(fixture, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. LCH-01 mutations: missing / type / enum / extra key / cross-field /
//    canonical gates / positive claims / fake-ID bypass
// ---------------------------------------------------------------------------
{
  const cases = [
    // missing required
    ['lch01 missing gate.gateId', (d) => { delete d.gates[0].gateId; }, ['gateId']],
    ['lch01 missing gate.status', (d) => { delete d.gates[0].status; }, ['status']],
    ['lch01 missing root registryStatus', (d) => { delete d.registryStatus; }, ['registryStatus']],
    ['lch01 missing root authority', (d) => { delete d.authority; }, ['authority']],
    // type
    ['lch01 gateId as number', (d) => { d.gates[0].gateId = 123; }, ['type']],
    ['lch01 status as boolean', (d) => { d.gates[0].status = true; }, ['type']],
    // enum / const / positive claims
    ['lch01 gate status COMPLETE', (d) => { d.gates[0].status = 'COMPLETE'; }, ['COMPLETE']],
    ['lch01 gate status GREEN', (d) => { d.gates[0].status = 'GREEN'; }, ['GREEN']],
    ['lch01 gate status SIGNED', (d) => { d.gates[0].status = 'SIGNED'; }, ['SIGNED']],
    ['lch01 goDecision GO', (d) => { d.goDecision.decision = 'GO'; }, ['GO']],
    ['lch01 approvals.status SIGNED', (d) => { d.approvals.status = 'SIGNED'; }, ['PENDING']],
    ['lch01 approvals.signatory non-null', (d) => { d.approvals.signatory = 'Jane Owner'; }, ['signatory']],
    // extra key injection
    ['lch01 extra approvedBy', (d) => { d.approvedBy = 'Jane'; }, ['approvedBy']],
    ['lch01 extra signatureDate', (d) => { d.signatureDate = '2026-08-15'; }, ['signatureDate']],
    ['lch01 extra productionEndpoint on gate', (d) => { d.gates[0].productionEndpoint = 'https://example.invalid/prod'; }, ['productionEndpoint']],
    // cross-field / positive claim combos
    ['lch01 GO + recordedBy (both)', (d) => { d.goDecision.decision = 'GO'; d.goDecision.recordedBy = 'Jane Owner'; }, ['GO']],
    ['lch01 goDecision.date non-null', (d) => { d.goDecision.date = '2026-08-15'; }, ['date']],
    // fake evidence ID adjacent to positive claim (no bypass)
    ['lch01 COMPLETE + evidence_id EV-FAKE', (d) => { d.gates[0].status = 'COMPLETE'; d.gates[0].evidence_id = 'EV-FAKE'; }, ['COMPLETE', 'evidence_id']],
    ['lch01 GREEN + same-line uuid field', (d) => { d.gates[0].status = 'GREEN'; d.gates[0].uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; }, ['GREEN', 'uuid']],
    // canonical gates
    ['lch01 only 16 gates', (d) => { d.gates = d.gates.slice(0, 16); }, ['17 canonical']],
    ['lch01 duplicate gate', (d) => { d.gates.push(deepClone(d.gates[0])); }, ['duplicate gate']],
    ['lch01 bogus gate id', (d) => { d.gates[0].gateId = 'BOGUS-GATE'; }, ['not one of the 17 canonical']],
    ['lch01 out-of-order gates', (d) => { const g = d.gates.shift(); d.gates.splice(5, 0, g); }, ['17 canonical']],
  ];
  for (const [label, change, tokens] of cases) {
    await withFixture(mutateExample('lch01', change), { tokens, label });
  }
}

// ---------------------------------------------------------------------------
// 3. LCH-02 mutations: missing / type / const / enum / extra key /
//    cross-field / no-fork / evidence path
// ---------------------------------------------------------------------------
{
  const cases = [
    // missing required
    ['lch02 missing deployed', (d) => { delete d.deployment.deployed; }, ['deployed']],
    ['lch02 missing launchSessionId', (d) => { delete d.deployment.launchSessionId; }, ['launchSessionId']],
    ['lch02 missing onCallActive', (d) => { delete d.onCall.onCallActive; }, ['onCallActive']],
    // type
    ['lch02 deployed as string "yes"', (d) => { d.deployment.deployed = 'yes'; }, ['type']],
    ['lch02 launchSessionId non-null number', (d) => { d.deployment.launchSessionId = 42; }, ['null']],
    ['lch02 sessionId non-null string', (d) => { d.firstSession.sessionId = 'prod-001'; }, ['sessionId']],
    // const / enum / positive claims
    ['lch02 deployed true', (d) => { d.deployment.deployed = true; }, ['deployed']],
    ['lch02 stage DEPLOYED', (d) => { d.deployment.stage = 'DEPLOYED'; }, ['DEPLOYED']],
    ['lch02 rollbackAuthority AUTHORIZED', (d) => { d.rollback.rollbackAuthority = 'AUTHORIZED'; }, ['AUTHORIZED']],
    ['lch02 rollbackAuthority ACTIVE', (d) => { d.rollback.rollbackAuthority = 'ACTIVE'; }, ['ACTIVE']],
    ['lch02 onCallActive true', (d) => { d.onCall.onCallActive = true; }, ['onCallActive']],
    ['lch02 rollback.authorizedBy non-null', (d) => { d.rollback.authorizedBy = 'Bob'; }, ['authorizedBy']],
    // extra key injection
    ['lch02 extra productionEndpoint', (d) => { d.productionEndpoint = 'https://example.invalid'; }, ['productionEndpoint']],
    ['lch02 extra approvedBy in firstSession', (d) => { d.firstSession.approvedBy = 'Jane'; }, ['approvedBy']],
    ['lch02 extra signatureDate', (d) => { d.signatureDate = '2026-08-15'; }, ['signatureDate']],
    // cross-field invariants
    ['lch02 deployed true + launchSessionId prod-001', (d) => { d.deployment.deployed = true; d.deployment.launchSessionId = 'prod-001'; }, ['prod-001']],
    ['lch02 firstSessionCompleted true', (d) => { d.firstSession.firstSessionCompleted = true; }, ['firstSessionCompleted']],
    ['lch02 firstRealSessionCompleted true', (d) => { d.firstSession.firstRealSessionCompleted = true; }, ['firstRealSessionCompleted']],
    ['lch02 dashboardMonitored true', (d) => { d.monitoring.dashboardMonitored = true; }, ['dashboardMonitored']],
    ['lch02 monitoring.endpoint non-null', (d) => { d.monitoring.endpoint = 'https://example.invalid/metrics'; }, ['endpoint']],
    ['lch02 alertsActive true', (d) => { d.monitoring.alertsActive = true; }, ['alertsActive']],
    ['lch02 observabilityConnected true', (d) => { d.monitoring.observabilityConnected = true; }, ['observabilityConnected']],
    // Phase 11 machine must NOT be forked
    ['lch02 stateMachine.forked true', (d) => { d.deployment.stateMachine.forked = true; }, ['forked']],
    ['lch02 allowedTransitions altered', (d) => { d.deployment.stateMachine.allowedTransitions = 'prepared → promoted'; }, ['allowedTransitions']],
    ['lch02 stateMachine.reference changed', (d) => { d.deployment.stateMachine.reference = 'infra/custom-machine.json'; }, ['reference']],
    ['lch02 targetKind changed', (d) => { d.rollback.targetKind = 'live-host'; }, ['repository-marker']],
    // evidence path injection (committed paths are not permitted at all)
    ['lch02 evidence.paths injected existing file', (d) => { d.evidence.paths = ['infra/launch/launch-readiness.example.json']; }, ['paths']],
    ['lch02 evidence.paths injected absolute', (d) => { d.evidence.paths = ['/etc/passwd']; }, ['paths']],
  ];
  for (const [label, change, tokens] of cases) {
    await withFixture(mutateExample('lch02', change), { tokens, label });
  }
}

// ---------------------------------------------------------------------------
// 4. LCH-03 hypercare mutations: missing / type / enum / extra key / bounds /
//    cross-field (zero, elapsed, mismatch) / fake-ID bypass
// ---------------------------------------------------------------------------
{
  const cases = [
    // missing required
    ['lch03 missing syntheticSessionCount', (d) => { delete d.drill.syntheticSessionCount; }, ['syntheticSessionCount']],
    ['lch03 missing hypercareWindowAccepted', (d) => { delete d.drill.hypercareWindowAccepted; }, ['hypercareWindowAccepted']],
    ['lch03 missing declaredThreshold', (d) => { delete d.drill.declaredThreshold; }, ['declaredThreshold']],
    ['lch03 missing productionAcceptance', (d) => { delete d.drill.productionAcceptance; }, ['productionAcceptance']],
    ['lch03 missing evidence.sessionIds', (d) => { delete d.evidence.sessionIds; }, ['sessionIds']],
    // type
    ['lch03 count as string "100"', (d) => { d.drill.syntheticSessionCount = '100'; }, ['type']],
    ['lch03 threshold as float', (d) => { d.drill.declaredThreshold = 100.5; }, ['type']],
    ['lch03 hypercareWindowAccepted as string "yes"', (d) => { d.drill.hypercareWindowAccepted = 'yes'; }, ['type']],
    ['lch03 elapsedHours as string', (d) => { d.drill.elapsedHours = '0'; }, ['type']],
    // enum
    ['lch03 trafficSource production', (d) => { d.drill.trafficSource = 'production'; }, ['production']],
    ['lch03 trafficSource real', (d) => { d.drill.trafficSource = 'real'; }, ['trafficSource']],
    ['lch03 hypercareStatus ACTIVE', (d) => { d.drill.hypercareStatus = 'ACTIVE'; }, ['ACTIVE']],
    ['lch03 hypercareStatus COMPLETE', (d) => { d.drill.hypercareStatus = 'COMPLETE'; }, ['COMPLETE']],
    ['lch03 incidentCadence ACTIVE', (d) => { d.drill.incidentCadence = 'ACTIVE'; }, ['incidentCadence']],
    ['lch03 rollbackAuthority AUTHORIZED', (d) => { d.drill.rollbackAuthority = 'AUTHORIZED'; }, ['AUTHORIZED']],
    ['lch03 drillKind wrong', (d) => { d.drillKind = 'lch99-x'; }, ['drillKind']],
    // extra key injection
    ['lch03 extra drill.sloAttainment 99.95', (d) => { d.drill.sloAttainment = 99.95; }, ['sloAttainment']],
    ['lch03 extra drill.onCallActive', (d) => { d.drill.onCallActive = true; }, ['onCallActive']],
    ['lch03 extra drill.sloHealth', (d) => { d.drill.sloHealth = 'healthy'; }, ['sloHealth']],
    ['lch03 extra evidence.evidenceId EV-0001', (d) => { d.evidence.evidenceId = 'EV-0001'; }, ['evidenceId']],
    ['lch03 extra ticket INC-12345', (d) => { d.ticket = 'INC-12345'; }, ['ticket']],
    // bounds
    ['lch03 count 10001 (upper)', (d) => { d.drill.syntheticSessionCount = 10001; }, ['maximum']],
    ['lch03 count -1 (lower)', (d) => { d.drill.syntheticSessionCount = -1; }, ['minimum']],
    ['lch03 threshold 0 (vacuous)', (d) => { d.drill.declaredThreshold = 0; }, ['minimum']],
    ['lch03 elapsedHours 169', (d) => { d.drill.elapsedHours = 169; }, ['maximum']],
    // cross-field invariants
    ['lch03 accept true + 0 sessions (non-vacuity)', (d) => { d.drill.syntheticSessionCount = 0; d.drill.hypercareWindowAccepted = true; }, ['not vacuous']],
    ['lch03 accept true + 5 sessions below threshold', (d) => { d.drill.syntheticSessionCount = 5; d.drill.hypercareWindowAccepted = true; }, ['below the declared threshold']],
    ['lch03 accept true + production traffic', (d) => { d.drill.syntheticSessionCount = 200; d.drill.trafficSource = 'production'; d.drill.hypercareWindowAccepted = true; }, ['production']],
    ['lch03 declared false but computed true', (d) => { d.drill.syntheticSessionCount = 200; }, ['does not match']],
    ['lch03 declared true but computed false', (d) => { d.drill.hypercareWindowAccepted = true; }, ['does not match']],
    ['lch03 elapsedHoursOnly true', (d) => { d.drill.elapsedHoursOnly = true; }, ['elapsedHoursOnly']],
    ['lch03 elapsedHoursOnly true + accept true', (d) => { d.drill.elapsedHoursOnly = true; d.drill.syntheticSessionCount = 200; d.drill.hypercareWindowAccepted = true; }, ['elapsed']],
    ['lch03 productionAcceptance true', (d) => { d.drill.productionAcceptance = true; }, ['productionAcceptance']],
    ['lch03 sloAttainment non-null 99.99', (d) => { d.drill.sloAttainment = 99.99; }, ['sloAttainment']],
    ['lch03 errorBudgetRemaining non-null 5.2', (d) => { d.drill.errorBudgetRemaining = 5.2; }, ['errorBudgetRemaining']],
    ['lch03 errorBudgetHealthy non-null true', (d) => { d.drill.errorBudgetHealthy = true; }, ['errorBudgetHealthy']],
    // fake-ID bypass attempts
    ['lch03 accept true + 0 + sessionIds [EV-FAKE]', (d) => { d.drill.syntheticSessionCount = 0; d.drill.hypercareWindowAccepted = true; d.evidence.sessionIds = ['EV-FAKE']; }, ['sessionIds']],
    ['lch03 accept true + 0 + endpoints [url]', (d) => { d.drill.syntheticSessionCount = 0; d.drill.hypercareWindowAccepted = true; d.evidence.endpoints = ['https://example.invalid/health']; }, ['endpoints']],
    ['lch03 accept true + 0 + uuid field', (d) => { d.drill.syntheticSessionCount = 0; d.drill.hypercareWindowAccepted = true; d.uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; }, ['uuid']],
    ['lch03 below threshold + sessionUrl', (d) => { d.sessionUrl = 'https://example.invalid/s/abc'; }, ['sessionUrl']],
  ];
  for (const [label, change, tokens] of cases) {
    await withFixture(mutateExample('lch03', change), { tokens, label });
  }
}

// ---------------------------------------------------------------------------
// 5. LCH-04 retro mutations: missing / type / enum / const / extra key /
//    cross-field positive claims
// ---------------------------------------------------------------------------
{
  const cases = [
    // missing required
    ['lch04 missing retroStatus', (d) => { delete d.retro.retroStatus; }, ['retroStatus']],
    ['lch04 missing actionItemsFiled', (d) => { delete d.actionItems.actionItemsFiled; }, ['actionItemsFiled']],
    ['lch04 missing retro.published', (d) => { delete d.retro.published; }, ['published']],
    ['lch04 missing authority', (d) => { delete d.authority; }, ['authority']],
    // type
    ['lch04 retroStatus as number', (d) => { d.retro.retroStatus = 7; }, ['type']],
    ['lch04 actionItemsFiled as string', (d) => { d.actionItems.actionItemsFiled = 'yes'; }, ['type']],
    ['lch04 published as string', (d) => { d.retro.published = 'yes'; }, ['type']],
    // enum / const / positive claims
    ['lch04 retroStatus PUBLISHED', (d) => { d.retro.retroStatus = 'PUBLISHED'; }, ['PUBLISHED']],
    ['lch04 retroStatus COMPLETED', (d) => { d.retro.retroStatus = 'COMPLETED'; }, ['COMPLETED']],
    ['lch04 retroStatus FILED', (d) => { d.retro.retroStatus = 'FILED'; }, ['FILED']],
    ['lch04 retroStatus CLOSED', (d) => { d.retro.retroStatus = 'CLOSED'; }, ['CLOSED']],
    ['lch04 published true', (d) => { d.retro.published = true; }, ['published']],
    ['lch04 completed true', (d) => { d.retro.completed = true; }, ['completed']],
    ['lch04 filed true', (d) => { d.retro.filed = true; }, ['filed']],
    ['lch04 closed true', (d) => { d.retro.closed = true; }, ['closed']],
    ['lch04 actionItemsFiled true', (d) => { d.actionItems.actionItemsFiled = true; }, ['actionItemsFiled']],
    ['lch04 actionItems.count 3', (d) => { d.actionItems.count = 3; }, ['count must be 0']],
    // extra key injection
    ['lch04 extra publishedDate', (d) => { d.publishedDate = '2026-09-01'; }, ['publishedDate']],
    ['lch04 retro.sessionDate non-null', (d) => { d.retro.sessionDate = '2026-09-01'; }, ['sessionDate']],
    ['lch04 retro.facilitator non-null', (d) => { d.retro.facilitator = 'Bob'; }, ['facilitator']],
    ['lch04 retro.participants named', (d) => { d.retro.participants = ['Alice']; }, ['participants']],
    ['lch04 retro.findings recorded', (d) => { d.retro.findings = [{ title: 'went well' }]; }, ['findings']],
    ['lch04 actionItems.items non-empty', (d) => { d.actionItems.items = [{ title: 'fix bug', status: 'PENDING', owner: null, dueDate: null, evidenceRef: null }]; }, ['items']],
    // cross-field positive combo
    ['lch04 COMPLETED + published true', (d) => { d.retro.retroStatus = 'COMPLETED'; d.retro.published = true; }, ['COMPLETED']],
    ['lch04 PUBLISHED + actionItemsFiled true', (d) => { d.retro.retroStatus = 'PUBLISHED'; d.actionItems.actionItemsFiled = true; }, ['PUBLISHED', 'actionItemsFiled']],
  ];
  for (const [label, change, tokens] of cases) {
    await withFixture(mutateExample('lch04', change), { tokens, label });
  }
}

// ---------------------------------------------------------------------------
// 6. Truthful prose must NOT false-positive (structured values only)
// ---------------------------------------------------------------------------
{
  const prose = 'Go to the next section and click the green button when the reviewer is ready; ' +
    'the checklist is signed off for review only, production acceptance remains external, ' +
    'the dashboard is not monitored, no on-call engineer is active, nothing is deployed, ' +
    'no real SLO or error budget is measured, and no EV-* reference, UUID, ticket ID, or URL ' +
    'authorizes any of these claims.';
  const cases = [
    ['lch01 truthful prose', 'lch01', (d) => {
      d.description = prose + ' This registry is not launch completion and no gate is green.';
    }],
    ['lch02 truthful prose', 'lch02', (d) => {
      d.description = prose + ' The Phase 11 release record stays prepared; production live is not claimed.';
    }],
    ['lch03 truthful prose', 'lch03', (d) => {
      d.description = prose + ' hypercareWindowAccepted is a synthetic drill result only, never production hypercare acceptance.';
      d.evidence.note = 'Real SLO attainment, error-budget health, and production traffic are NOT claimed here; go/no-go stays PENDING.';
    }],
    ['lch04 truthful prose', 'lch04', (d) => {
      d.description = prose + ' The retro is not published and no action item is filed until after launch and hypercare closure.';
    }],
  ];
  for (const [label, cat, change] of cases) {
    await withFixture(mutateExample(cat, change), { tokens: [], expectExit: 0, label });
  }
}

// ---------------------------------------------------------------------------
// 7. Evidence path safety (unit-level, exported from the validator)
// ---------------------------------------------------------------------------
{
  const { isSafeEvidencePath } = await import(VALIDATOR);
  assertOk(isSafeEvidencePath('/etc/passwd') === false, 'path safety: absolute path rejected');
  assertOk(isSafeEvidencePath('../outside') === false, 'path safety: .. traversal rejected');
  assertOk(isSafeEvidencePath('a/../b.json') === false, 'path safety: embedded traversal rejected');
  assertOk(isSafeEvidencePath('config/current-state.json\0x') === false, 'path safety: NUL byte rejected');
  assertOk(isSafeEvidencePath('scripts') === false, 'path safety: directory (non-regular file) rejected');
  assertOk(isSafeEvidencePath('PLAN.md') === true, 'path safety: committed regular file allowed');
  assertOk(isSafeEvidencePath('config/current-state.json') === true, 'path safety: committed regular file allowed (2)');
  assertOk(isSafeEvidencePath('') === false, 'path safety: empty path rejected');
}

// ---------------------------------------------------------------------------
// 8. Current-state byte identity (exact immutable SHA baseline in a fixture
//    repo): a semantically neutral byte mutation must still exit non-zero.
// ---------------------------------------------------------------------------
{
  const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'phase12-l4-'));
  try {
    await copyFixtureTree(fixture);
    const sha = await gitBaseline(fixture);
    // mutate current-state.json with a semantically-neutral byte change
    const csPath = path.join(fixture, 'config/current-state.json');
    const cs = readJson(csPath);
    cs.evidenceDate = '2026-07-29'; // not a semantically-checked field
    writeJson(csPath, cs);
    const res = runValidator(fixture, ['--baseline-ref', sha]);
    assertOk(res.status === 1, `byte identity: expected exit 1 (got ${res.status})\n${res.stdout}\n${res.stderr}`);
    assertOk(res.stdout.includes(`differs from ${sha}`), `byte identity: expected "differs from ${sha}" in output`);
    assertOk(res.stdout.includes('byte identity broken'), 'byte identity: expected byte identity broken marker');
  } finally {
    await fs.promises.rm(fixture, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 8a. Current-state byte identity: missing/unavailable baseline ref must FAIL
//     CLOSED — exit non-zero, a byte-identity error, never "skipped", never
//     ALL GREEN.
// ---------------------------------------------------------------------------
{
  const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'phase12-l4-'));
  try {
    await copyFixtureTree(fixture);
    await gitBaseline(fixture);
    const res = runValidator(fixture, ['--baseline-ref', 'refs/heads/definitely-missing-phase12-review']);
    assertOk(res.status === 1, `missing baseline ref: expected exit 1 (got ${res.status})\n${res.stdout}\n${res.stderr}`);
    assertOk(res.stdout.includes('not found'), 'missing baseline ref: expected "not found" message');
    assertOk(res.stdout.includes('fail closed'), 'missing baseline ref: expected fail-closed marker');
    assertOk(res.stdout.includes('RESULT: FAIL'), 'missing baseline ref: must report FAIL');
    assertOk(!res.stdout.includes('skipped'), 'missing baseline ref: must never report skipped');
    assertOk(!res.stdout.includes('ALL GREEN'), 'missing baseline ref: must never report ALL GREEN');
  } finally {
    await fs.promises.rm(fixture, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 8b. Current-state byte identity: git completely unavailable (spawn error
//     path) must FAIL CLOSED, never exit 0.
// ---------------------------------------------------------------------------
{
  const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'phase12-l4-'));
  try {
    await copyFixtureTree(fixture);
    const res = spawnSync(process.execPath, [path.join(fixture, 'scripts/check-phase12-launch-status.mjs'), '--baseline-ref', 'HEAD'], {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent-phase12' },
    });
    assertOk(res.status === 1, `git unavailable: expected exit 1 (got ${res.status})\n${res.stdout}\n${res.stderr}`);
    assertOk(res.stdout.includes('fail closed'), 'git unavailable: expected fail-closed marker');
    assertOk(res.stdout.includes('RESULT: FAIL'), 'git unavailable: must report FAIL');
    assertOk(!res.stdout.includes('skipped'), 'git unavailable: must never report skipped');
    assertOk(!res.stdout.includes('ALL GREEN'), 'git unavailable: must never report ALL GREEN');
  } finally {
    await fs.promises.rm(fixture, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 8c. Static workflow regression: the Phase 12 workflow must pin the exact
//     immutable base 9db22b360a5949396d5d541e2b8a417035ff5c41 for BOTH the
//     validator invocation and the standalone current-state diff, for
//     pull_request / push / workflow_dispatch alike, with no moving
//     origin/main baseline anywhere.
// ---------------------------------------------------------------------------
{
  const BASE = '9db22b360a5949396d5d541e2b8a417035ff5c41';
  const workflowPath = path.join(REPO_ROOT, '.github/workflows/phase12-launch-readiness.yml');
  let workflow;
  try {
    workflow = fs.readFileSync(workflowPath, 'utf8');
  } catch {
    workflow = '';
    assertOk(false, `static workflow: ${workflowPath} must exist`);
  }
  const validatorInvocation = `node scripts/check-phase12-launch-status.mjs --baseline-ref ${BASE}`;
  const diffInvocation = `git diff --exit-code ${BASE} -- config/current-state.json docs/current-state.md`;
  assertOk(workflow.includes(validatorInvocation), `static workflow: must invoke the validator with the exact pinned base (${validatorInvocation})`);
  assertOk(workflow.includes(diffInvocation), `static workflow: standalone current-state diff must use the exact pinned base (${diffInvocation})`);
  assertOk(workflow.includes('pull_request:'), 'static workflow: must trigger on pull_request');
  assertOk(workflow.includes('push:'), 'static workflow: must trigger on push');
  assertOk(workflow.includes('workflow_dispatch:'), 'static workflow: must trigger on workflow_dispatch');
  assertOk(!workflow.includes('origin/main'), 'static workflow: no moving origin/main baseline may remain');
}

// ---------------------------------------------------------------------------
// 9. Determinism: identical input -> byte-identical stdout
// ---------------------------------------------------------------------------
{
  const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'phase12-l4-'));
  try {
    await copyFixtureTree(fixture);
    await gitBaseline(fixture);
    const r1 = runValidator(fixture, ['--baseline-ref', 'HEAD']);
    const r2 = runValidator(fixture, ['--baseline-ref', 'HEAD']);
    assertOk(r1.status === 0 && r2.status === 0, 'determinism: both runs exit 0');
    assertOk(r1.stdout === r2.stdout, 'determinism: identical input must produce byte-identical stdout');
  } finally {
    await fs.promises.rm(fixture, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 10. Usage / IO
// ---------------------------------------------------------------------------
{
  const r = runValidator(REPO_ROOT, ['--bogus-flag']);
  assertOk(r.status === 2, `unknown flag: expected exit 2 (got ${r.status})`);
  const r2 = runValidator(REPO_ROOT, ['--baseline-ref']);
  assertOk(r2.status === 2, `--baseline-ref without value: expected exit 2 (got ${r2.status})`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`PASS=${passed} FAIL=${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`FAILED: ${f}`);
  process.exit(1);
}
console.log('check-phase12-launch-status.test.mjs: ALL GREEN');
