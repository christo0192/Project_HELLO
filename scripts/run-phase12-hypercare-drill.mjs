#!/usr/bin/env node
// run-phase12-hypercare-drill.mjs
//
// LCH-03 synthetic hypercare drill harness (Node stdlib only, deterministic).
//
// This harness validates an input LCH-03 drill fixture and computes/checks
// ONLY a syntheticThresholdMet-style result:
//
//   syntheticThresholdMet =
//     syntheticSessionCount >= declaredThreshold &&
//     trafficSource === "synthetic_local"
//
// and verifies the fixture's declared hypercareWindowAccepted equals that
// computed value. It NEVER accepts, computes, or emits:
//   - production hypercare acceptance (hypercareStatus stays NOT_RUN|PENDING)
//   - real SLO attainment (sloAttainment must be null)
//   - error-budget health (errorBudgetRemaining/errorBudgetHealthy must be null)
//   - real traffic (trafficSource must be "synthetic_local")
//   - wall-clock acceptance (elapsedHoursOnly must be false; elapsedHours is
//     informational only and never used for acceptance)
//
// Fixtures are compact aggregate counts (bounded integers), never session
// arrays. Bounds are hard:
//   syntheticSessionCount  0..10000
//   declaredThreshold      1..10000   (0 would make the gate vacuous)
//   elapsedHours           0..168
//
// No EV-* reference, UUID, ticket ID, or URL can authorize any claim: no such
// field exists, extra keys are rejected, and sessionIds/endpoints are
// structurally forced empty.
//
// Usage:
//   node scripts/run-phase12-hypercare-drill.mjs <fixture.json>   run one fixture
//   node scripts/run-phase12-hypercare-drill.mjs --example        run the example record
//   node scripts/run-phase12-hypercare-drill.mjs --all            run the committed fixture matrix
//
// Exit codes: 0 all inputs valid and every declared claim verified;
//             1 at least one fixture invalid or claim mismatch;
//             2 usage or I/O error.
//
// Determinism: no randomness, no wall clock, no environment dependence in
// the result. Running the same input twice produces byte-identical output.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_NAME = 'run-phase12-hypercare-drill';
const HARNESS_VERSION = '1.0.0';
const DRILL_KIND = 'lch03-hypercare-synthetic-sessions';
const ACCEPTANCE_BASIS = 'synthetic_session_count_vs_declared_threshold';

const BOUNDS = Object.freeze({
  minSyntheticSessions: 0,
  maxSyntheticSessions: 10000,
  minDeclaredThreshold: 1,
  maxDeclaredThreshold: 10000,
  maxElapsedHours: 168,
});

const TRAFFIC_SOURCES = Object.freeze(['synthetic_local']);
const HYPERCARE_STATUSES = Object.freeze(['NOT_RUN', 'PENDING']);
const PENDING_ONLY = Object.freeze(['PENDING']);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'infra', 'launch', 'fixtures', 'hypercare');
const COMMITTED_FIXTURES = Object.freeze([
  'sessions-0.json',
  'sessions-50.json',
  'sessions-200.json',
  'sessions-1000.json',
]);
const EXAMPLE_PATH = path.join(REPO_ROOT, 'infra', 'launch', 'hypercare-drill.example.json');

const SEMVER = /^\d+\.\d+\.\d+$/;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isInteger(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * Structural + semantic validation of one LCH-03 drill fixture.
 * @param {unknown} doc parsed fixture JSON
 * @param {{fixtureName?: string}} [opts]
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateFixture(doc, { fixtureName = 'fixture.json' } = {}) {
  const errors = [];
  const fail = (rule, msg) => errors.push(`${rule}: ${msg}`);

  // --- root shape ---------------------------------------------------------
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail('root-type', 'fixture must be a JSON object');
    return { valid: false, errors };
  }

  const ROOT_REQUIRED = ['manifestVersion', 'version', 'drillKind', 'title', 'description', 'authority', 'drill', 'evidence'];
  for (const k of ROOT_REQUIRED) {
    if (!(k in doc)) fail('missing-field', `missing required root field "${k}"`);
  }
  if (doc.manifestVersion !== undefined && (typeof doc.manifestVersion !== 'string' || !SEMVER.test(doc.manifestVersion))) {
    fail('type-enum', `manifestVersion must be a semantic version string (got ${typeOf(doc.manifestVersion)})`);
  }
  if (doc.version !== undefined && (typeof doc.version !== 'string' || !SEMVER.test(doc.version))) {
    fail('type-enum', `version must be a semantic version string (got ${typeOf(doc.version)})`);
  }
  if (doc.drillKind !== undefined && doc.drillKind !== DRILL_KIND) {
    fail('type-enum', `drillKind must be "${DRILL_KIND}" (got ${JSON.stringify(doc.drillKind)})`);
  }
  if (doc.title !== undefined && typeof doc.title !== 'string') {
    fail('type-enum', `title must be a string (got ${typeOf(doc.title)})`);
  } else if (doc.title !== undefined && doc.title.length < 1) {
    fail('bounds', 'title must be non-empty');
  } else if (doc.title !== undefined && doc.title.length > 500) {
    fail('bounds', 'title longer than 500 characters');
  }
  if (doc.description !== undefined && typeof doc.description !== 'string') {
    fail('type-enum', `description must be a string (got ${typeOf(doc.description)})`);
  } else if (doc.description !== undefined && (doc.description.length < 1 || doc.description.length > 4000)) {
    fail('bounds', 'description must be 1..4000 characters');
  }
  for (const k of Object.keys(doc)) {
    if (!ROOT_REQUIRED.includes(k)) fail('extra-key', `unknown root field "${k}"`);
  }

  // --- authority ----------------------------------------------------------
  const authority = doc.authority;
  if (authority !== undefined) {
    if (authority === null || typeof authority !== 'object' || Array.isArray(authority)) {
      fail('type-enum', 'authority must be an object');
    } else {
      for (const k of ['source', 'role', 'note']) {
        if (!(k in authority)) fail('missing-field', `missing required field "authority.${k}"`);
      }
      if (authority.source !== 'config/current-state.json') {
        fail('type-enum', `authority.source must be "config/current-state.json" (got ${JSON.stringify(authority.source)})`);
      }
      if (authority.role !== 'authoritative-source-of-truth') {
        fail('type-enum', `authority.role must be "authoritative-source-of-truth" (got ${JSON.stringify(authority.role)})`);
      }
      if (authority.note !== undefined && typeof authority.note !== 'string') {
        fail('type-enum', `authority.note must be a string (got ${typeOf(authority.note)})`);
      } else if (authority.note !== undefined && (authority.note.length < 1 || authority.note.length > 2000)) {
        fail('bounds', 'authority.note must be 1..2000 characters');
      }
      for (const k of Object.keys(authority)) {
        if (!['source', 'role', 'note'].includes(k)) fail('extra-key', `unknown field "authority.${k}"`);
      }
    }
  }

  // --- drill --------------------------------------------------------------
  const drill = doc.drill;
  const DRILL_REQUIRED = [
    'declaredThreshold', 'syntheticSessionCount', 'elapsedHours', 'elapsedHoursOnly',
    'trafficSource', 'hypercareWindowAccepted', 'hypercareStatus', 'productionAcceptance',
    'sloAttainment', 'errorBudgetRemaining', 'errorBudgetHealthy', 'incidentCadence',
    'rollbackAuthority',
  ];
  if (drill !== undefined) {
    if (drill === null || typeof drill !== 'object' || Array.isArray(drill)) {
      fail('type-enum', 'drill must be an object');
    } else {
      for (const k of DRILL_REQUIRED) {
        if (!(k in drill)) fail('missing-field', `missing required field "drill.${k}"`);
      }
      for (const k of Object.keys(drill)) {
        if (!DRILL_REQUIRED.includes(k)) fail('extra-key', `unknown field "drill.${k}"`);
      }

      const B = BOUNDS;
      if (drill.declaredThreshold !== undefined) {
        if (!isInteger(drill.declaredThreshold)) fail('type-enum', `drill.declaredThreshold must be an integer (got ${typeOf(drill.declaredThreshold)})`);
        else if (drill.declaredThreshold < B.minDeclaredThreshold || drill.declaredThreshold > B.maxDeclaredThreshold) {
          fail('bounds', `drill.declaredThreshold out of bounds ${B.minDeclaredThreshold}..${B.maxDeclaredThreshold} (got ${drill.declaredThreshold})`);
        }
      }
      if (drill.syntheticSessionCount !== undefined) {
        if (!isInteger(drill.syntheticSessionCount)) fail('type-enum', `drill.syntheticSessionCount must be an integer (got ${typeOf(drill.syntheticSessionCount)})`);
        else if (drill.syntheticSessionCount < B.minSyntheticSessions || drill.syntheticSessionCount > B.maxSyntheticSessions) {
          fail('bounds', `drill.syntheticSessionCount out of bounds ${B.minSyntheticSessions}..${B.maxSyntheticSessions} (got ${drill.syntheticSessionCount})`);
        }
      }
      if (drill.elapsedHours !== undefined) {
        if (!isInteger(drill.elapsedHours)) fail('type-enum', `drill.elapsedHours must be an integer (got ${typeOf(drill.elapsedHours)})`);
        else if (drill.elapsedHours < 0 || drill.elapsedHours > B.maxElapsedHours) {
          fail('bounds', `drill.elapsedHours out of bounds 0..${B.maxElapsedHours} (got ${drill.elapsedHours})`);
        }
      }
      if (drill.elapsedHoursOnly !== undefined) {
        if (typeof drill.elapsedHoursOnly !== 'boolean') fail('type-enum', `drill.elapsedHoursOnly must be a boolean (got ${typeOf(drill.elapsedHoursOnly)})`);
        else if (drill.elapsedHoursOnly !== false) fail('type-enum', 'drill.elapsedHoursOnly must be false: wall-clock-only acceptance is forbidden');
      }
      if (drill.trafficSource !== undefined) {
        if (typeof drill.trafficSource !== 'string' || !TRAFFIC_SOURCES.includes(drill.trafficSource)) {
          fail('type-enum', `drill.trafficSource must be one of ${JSON.stringify(TRAFFIC_SOURCES)} (got ${JSON.stringify(drill.trafficSource)})`);
        }
      }
      if (drill.hypercareWindowAccepted !== undefined && typeof drill.hypercareWindowAccepted !== 'boolean') {
        fail('type-enum', `drill.hypercareWindowAccepted must be a boolean (got ${typeOf(drill.hypercareWindowAccepted)})`);
      }
      if (drill.hypercareStatus !== undefined) {
        if (typeof drill.hypercareStatus !== 'string' || !HYPERCARE_STATUSES.includes(drill.hypercareStatus)) {
          fail('type-enum', `drill.hypercareStatus must be one of ${JSON.stringify(HYPERCARE_STATUSES)} (got ${JSON.stringify(drill.hypercareStatus)})`);
        }
      }
      if (drill.productionAcceptance !== undefined) {
        if (typeof drill.productionAcceptance !== 'boolean') fail('type-enum', `drill.productionAcceptance must be a boolean (got ${typeOf(drill.productionAcceptance)})`);
        else if (drill.productionAcceptance !== false) fail('cross-field', 'drill.productionAcceptance must be false: repository drills never claim production acceptance');
      }
      for (const k of ['sloAttainment', 'errorBudgetRemaining', 'errorBudgetHealthy']) {
        if (drill[k] !== undefined && drill[k] !== null) {
          fail('cross-field', `drill.${k} must be null: real ${k.replace(/([A-Z])/g, ' $1').toLowerCase()} is never claimed by a synthetic drill (got ${JSON.stringify(drill[k])})`);
        }
      }
      if (drill.incidentCadence !== undefined) {
        if (typeof drill.incidentCadence !== 'string' || !PENDING_ONLY.includes(drill.incidentCadence)) {
          fail('type-enum', `drill.incidentCadence must be one of ${JSON.stringify(PENDING_ONLY)} (got ${JSON.stringify(drill.incidentCadence)})`);
        }
      }
      if (drill.rollbackAuthority !== undefined) {
        if (typeof drill.rollbackAuthority !== 'string' || !PENDING_ONLY.includes(drill.rollbackAuthority)) {
          fail('type-enum', `drill.rollbackAuthority must be one of ${JSON.stringify(PENDING_ONLY)} (got ${JSON.stringify(drill.rollbackAuthority)})`);
        }
      }
    }
  }

  // --- evidence -----------------------------------------------------------
  const evidence = doc.evidence;
  if (evidence !== undefined) {
    if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
      fail('type-enum', 'evidence must be an object');
    } else {
      for (const k of ['evidenceType', 'status', 'sessionIds', 'endpoints', 'note']) {
        if (!(k in evidence)) fail('missing-field', `missing required field "evidence.${k}"`);
      }
      if (evidence.evidenceType !== 'synthetic_local') {
        fail('type-enum', `evidence.evidenceType must be "synthetic_local" (got ${JSON.stringify(evidence.evidenceType)})`);
      }
      if (evidence.status !== 'PENDING') {
        fail('type-enum', `evidence.status must be "PENDING" (got ${JSON.stringify(evidence.status)})`);
      }
      if (evidence.sessionIds !== undefined) {
        if (!Array.isArray(evidence.sessionIds)) fail('type-enum', 'evidence.sessionIds must be an array');
        else if (evidence.sessionIds.length !== 0) fail('bounds', 'evidence.sessionIds must be empty: no session identifier exists or can authorize a claim');
      }
      if (evidence.endpoints !== undefined) {
        if (!Array.isArray(evidence.endpoints)) fail('type-enum', 'evidence.endpoints must be an array');
        else if (evidence.endpoints.length !== 0) fail('bounds', 'evidence.endpoints must be empty: no endpoint, host, or URL exists or can authorize a claim');
      }
      if (evidence.note !== undefined && typeof evidence.note !== 'string') {
        fail('type-enum', `evidence.note must be a string (got ${typeOf(evidence.note)})`);
      } else if (evidence.note !== undefined && (evidence.note.length < 1 || evidence.note.length > 1000)) {
        fail('bounds', 'evidence.note must be 1..1000 characters');
      }
      for (const k of Object.keys(evidence)) {
        if (!['evidenceType', 'status', 'sessionIds', 'endpoints', 'note'].includes(k)) fail('extra-key', `unknown field "evidence.${k}"`);
      }
    }
  }

  // --- semantic / cross-field (only when structurally usable) -------------
  const structurallyUsable =
    drill !== null && typeof drill === 'object' && !Array.isArray(drill) &&
    isInteger(drill?.syntheticSessionCount) && isInteger(drill?.declaredThreshold) &&
    typeof drill?.trafficSource === 'string' && typeof drill?.hypercareWindowAccepted === 'boolean';

  if (structurallyUsable) {
    const accepted = drill.hypercareWindowAccepted;
    const computed = drill.syntheticSessionCount >= drill.declaredThreshold && drill.trafficSource === 'synthetic_local';

    if (accepted === true) {
      if (drill.syntheticSessionCount === 0) {
        fail('cross-field', 'hypercareWindowAccepted cannot be true with 0 synthetic sessions: the gate is not vacuous');
      }
      if (drill.syntheticSessionCount < drill.declaredThreshold) {
        fail('cross-field', `hypercareWindowAccepted cannot be true with ${drill.syntheticSessionCount} sessions below the declared threshold ${drill.declaredThreshold}`);
      }
      if (drill.trafficSource !== 'synthetic_local') {
        fail('cross-field', 'hypercareWindowAccepted requires trafficSource "synthetic_local": real traffic is never accepted by a synthetic drill');
      }
      if (drill.elapsedHoursOnly === true) {
        fail('cross-field', 'elapsed-hours-only acceptance is forbidden: wall-clock duration alone cannot accept a hypercare window');
      }
    }
    if (computed !== accepted) {
      fail('cross-field', `declared hypercareWindowAccepted (${JSON.stringify(accepted)}) does not match the computed synthetic result (${JSON.stringify(computed)}) for ${drill.syntheticSessionCount} sessions vs threshold ${drill.declaredThreshold}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Compute the deterministic drill result for one fixture.
 * The result never carries production acceptance, SLO, or error-budget claims.
 * @param {unknown} doc parsed fixture JSON
 * @param {{fixtureName?: string}} [opts]
 * @returns {object}
 */
export function runFixture(doc, { fixtureName = 'fixture.json' } = {}) {
  const validation = validateFixture(doc, { fixtureName });
  const d = (doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}).drill || {};
  const syntheticThresholdMet =
    isInteger(d.syntheticSessionCount) && isInteger(d.declaredThreshold) &&
    d.syntheticSessionCount >= d.declaredThreshold && d.trafficSource === 'synthetic_local';

  return {
    harness: HARNESS_NAME,
    harnessVersion: HARNESS_VERSION,
    drillKind: DRILL_KIND,
    fixture: fixtureName,
    valid: validation.valid,
    syntheticSessionCount: d.syntheticSessionCount ?? null,
    declaredThreshold: d.declaredThreshold ?? null,
    trafficSource: d.trafficSource ?? null,
    elapsedHours: d.elapsedHours ?? null,
    elapsedHoursOnly: d.elapsedHoursOnly ?? null,
    syntheticThresholdMet,
    hypercareWindowAccepted: d.hypercareWindowAccepted ?? null,
    declaredClaimVerified: validation.valid && syntheticThresholdMet === d.hypercareWindowAccepted,
    hypercareStatus: d.hypercareStatus ?? null,
    productionAcceptance: d.productionAcceptance ?? null,
    sloAttainment: d.sloAttainment ?? null,
    errorBudgetRemaining: d.errorBudgetRemaining ?? null,
    errorBudgetHealthy: d.errorBudgetHealthy ?? null,
    incidentCadence: d.incidentCadence ?? null,
    rollbackAuthority: d.rollbackAuthority ?? null,
    evidenceType: (doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}).evidence?.evidenceType ?? null,
    acceptanceBasis: ACCEPTANCE_BASIS,
    elapsedHoursUsedForAcceptance: false,
    wallClockAcceptance: false,
    bounds: { ...BOUNDS },
    errors: validation.errors,
  };
}

function readFixture(filePath, fixtureName) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, doc: JSON.parse(raw), fixtureName };
  } catch (err) {
    return {
      ok: false,
      result: {
        harness: HARNESS_NAME,
        harnessVersion: HARNESS_VERSION,
        drillKind: DRILL_KIND,
        fixture: fixtureName,
        valid: false,
        syntheticThresholdMet: false,
        errors: [`io-parse: cannot read/parse ${filePath}: ${err.message}`],
      },
    };
  }
}

function runOne(filePath) {
  const fixtureName = path.basename(filePath);
  const { ok, doc, result } = readFixture(filePath, fixtureName);
  const out = ok ? runFixture(doc, { fixtureName }) : result;
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return out.valid ? 0 : 1;
}

function runCommittedFixtures() {
  const lines = [];
  const results = [];
  let allValid = true;
  for (const name of COMMITTED_FIXTURES) {
    const filePath = path.join(FIXTURES_DIR, name);
    const { ok, doc, result } = readFixture(filePath, name);
    const out = ok ? runFixture(doc, { fixtureName: name }) : result;
    results.push(out);
    if (!out.valid) allValid = false;
    lines.push(
      `${name.padEnd(22)} ${String(out.syntheticSessionCount).padStart(5)}  ${String(out.declaredThreshold).padStart(7)}  ` +
      `${String(out.syntheticThresholdMet).padEnd(5)} ${String(out.hypercareWindowAccepted).padEnd(5)}  ${out.declaredClaimVerified ? 'verified' : 'MISMATCH'}`,
    );
  }
  const summary = {
    harness: HARNESS_NAME,
    harnessVersion: HARNESS_VERSION,
    drillKind: DRILL_KIND,
    mode: 'committed-fixture-matrix',
    fixtures: results.map((r) => ({
      fixture: r.fixture,
      valid: r.valid,
      syntheticSessionCount: r.syntheticSessionCount,
      declaredThreshold: r.declaredThreshold,
      syntheticThresholdMet: r.syntheticThresholdMet,
      hypercareWindowAccepted: r.hypercareWindowAccepted,
      declaredClaimVerified: r.declaredClaimVerified,
    })),
    allValid,
    bounds: { ...BOUNDS },
  };
  process.stdout.write('LCH-03 synthetic hypercare drill — committed fixture matrix (deterministic)\n');
  process.stdout.write('fixture                   sessions  threshold  met   declared  claim\n');
  for (const l of lines) process.stdout.write(`${l}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return allValid ? 0 : 1;
}

function usage() {
  process.stdout.write(
    `usage: node ${HARNESS_NAME}.mjs <fixture.json> | --example | --all\n` +
    `  <fixture.json>  validate one LCH-03 hypercare drill fixture and compute its synthetic result\n` +
    `  --example       validate infra/launch/hypercare-drill.example.json\n` +
    `  --all           validate the committed fixture matrix (sessions-0/50/200/1000.json)\n`,
  );
  return 2;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === '--all') return runCommittedFixtures();
  if (args.length === 1 && args[0] === '--example') return runOne(EXAMPLE_PATH);
  if (args.length === 1) return runOne(path.resolve(args[0]));
  return usage();
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  process.exitCode = main(process.argv);
}
