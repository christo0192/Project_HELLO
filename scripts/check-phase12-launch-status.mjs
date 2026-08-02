#!/usr/bin/env node
// check-phase12-launch-status.mjs
//
// Phase 12 — comprehensive structural + semantic contract validator (Node
// stdlib only, deterministic, no JSON Schema library, no network).
//
// This is NOT a status-field scanner and NOT a decorative schema: it is a
// hand-rolled Draft 2020-12 subset validator that reads the four published
// Phase 12 schemas (LCH-01 launch readiness, LCH-02 launch execution, LCH-03
// hypercare, LCH-04 retro) and validates every committed example and every
// hypercare fixture against its own published schema, plus per-category
// semantic cross-field invariants and the global no-positive-claim rules.
//
// Supported Draft 2020-12 subset (the exact subset the published schemas
// use): $ref (internal #/$defs/ only), type (string|number|integer|boolean|
// object|array|null, single or list), required, properties,
// additionalProperties, const, enum, pattern, minLength, maxLength, minimum,
// maximum, minItems, maxItems, uniqueItems, items, $defs. Any other keyword
// appearing in a published schema is reported as unsupported (schema
// self-check) so the validator can never silently ignore a rule.
//
// Positive claims are rejected at the VALUE level on structured fields (the
// schema enums/consts/null-forbidders), never by scanning prose: truthful
// explanatory text in description/note/title/definition fields must not
// false-positive. No EV-* reference, UUID, ticket ID, or URL can authorize a
// claim: no such field exists in the schemas, unknown keys are rejected, and
// evidence/path/session/endpoint arrays are structurally forced empty.
//
// Usage:
//   node scripts/check-phase12-launch-status.mjs
//       validate all committed Phase 12 artifacts (default baseline = exact
//       immutable Phase 12 base 9db22b360a5949396d5d541e2b8a417035ff5c41)
//   node scripts/check-phase12-launch-status.mjs --baseline-ref <ref>
//       byte-identity reference for current-state (override; must be an
//       immutable ref — never a moving branch tip like origin/main)
//   node scripts/check-phase12-launch-status.mjs --list-artifacts
//       print the exact artifact set validated, then exit 0
//
// Exit codes: 0 = all green; 1 = at least one validation failure;
//             2 = usage or I/O error.
//
// Determinism: no randomness, no wall clock, no environment dependence in
// the output (git byte-identity uses a fixed ref).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateFixture as validateHypercareFixture } from './run-phase12-hypercare-drill.mjs';

const VALIDATOR_NAME = 'check-phase12-launch-status';
const VALIDATOR_VERSION = '1.0.0';

// Exact immutable Phase 12 base for current-state byte identity:
// origin/main@9db22b360a5949396d5d541e2b8a417035ff5c41 (feat: add phase 10
// model governance foundations). config/current-state.json and
// docs/current-state.md must remain byte-for-byte identical to this exact
// commit for pull_request, push, and workflow_dispatch alike; a moving branch
// tip (origin/main) is never an acceptable baseline.
const PHASE12_CURRENT_STATE_BASE = '9db22b360a5949396d5d541e2b8a417035ff5c41';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Artifact inventory (exact committed Phase 12 set)
// ---------------------------------------------------------------------------
const ARTIFACTS = Object.freeze({
  schemas: {
    lch01: 'config/phase12-launch-readiness.schema.json',
    lch02: 'config/phase12-launch-execution.schema.json',
    lch03: 'config/phase12-hypercare.schema.json',
    lch04: 'config/phase12-retro.schema.json',
  },
  examples: {
    lch01: 'infra/launch/launch-readiness.example.json',
    lch02: 'infra/launch/launch-execution.example.json',
    lch03: 'infra/launch/hypercare-drill.example.json',
    lch04: 'infra/launch/retro-template.example.json',
  },
  hypercareFixtures: [
    'infra/launch/fixtures/hypercare/sessions-0.json',
    'infra/launch/fixtures/hypercare/sessions-50.json',
    'infra/launch/fixtures/hypercare/sessions-200.json',
    'infra/launch/fixtures/hypercare/sessions-1000.json',
  ],
  docs: [
    'docs/launch/launch-readiness.md',
    'docs/runbooks/production-launch.md',
    'docs/runbooks/production-rollback.md',
    'docs/runbooks/launch-hypercare.md',
    'docs/runbooks/launch-incident-cadence.md',
    'docs/runbooks/post-launch-retro.md',
  ],
});

// Phase 11 reference paths LCH-02 must reference (and that must exist).
const PHASE11_REFS = Object.freeze({
  releaseRecord: 'infra/deployment-contracts/release-record.example.json',
  deploymentManifest: 'infra/deployment-contracts/manifest.json',
  releaseValidator: 'scripts/validate-deployment-release',
});

const PHASE11_ALLOWED_TRANSITIONS =
  'prepared → staging_verified → canary_observing → promote_pending → promoted | rollback_required → rolled_back | aborted';

const SEMVER = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function loadJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'));
  } catch (err) {
    return { __loadError: `cannot read/parse ${relativePath}: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Hand-rolled Draft 2020-12 subset validator
// ---------------------------------------------------------------------------
const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', 'version', '$defs',
  '$ref', 'type', 'required', 'properties', 'additionalProperties',
  'const', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum',
  'maximum', 'minItems', 'maxItems', 'uniqueItems', 'items', 'default',
]);

function resolveRef(ref, rootSchema) {
  if (typeof ref !== 'string') return null;
  if (!ref.startsWith('#/$defs/')) return null; // internal refs only
  // JSON pointer: #/$defs/<name> → navigate $defs.<name>
  const segments = ref.slice('#/'.length).split('/').filter(Boolean);
  let node = rootSchema;
  for (const seg of segments) {
    if (!isObject(node) || !Object.prototype.hasOwnProperty.call(node, seg)) return null;
    node = node[seg];
  }
  return node;
}

/**
 * Validate `value` against one schema node, collecting errors.
 * @param {unknown} value
 * @param {object} node schema node
 * @param {object} rootSchema schema root (for $defs resolution)
 * @param {string} dataPath
 * @param {string[]} errors
 */
function validateNode(value, node, rootSchema, dataPath, errors) {
  if (!isObject(node)) return;

  // $ref first (per JSON Schema, a $ref replaces the node's other keywords)
  if (typeof node.$ref === 'string') {
    const target = resolveRef(node.$ref, rootSchema);
    if (target === null) {
      errors.push(`ref: unresolved or non-internal $ref "${node.$ref}" at ${dataPath}`);
      return;
    }
    validateNode(value, target, rootSchema, dataPath, errors);
    return;
  }

  // type (string or list of type names; integer is the JSON Schema subtype
  // of number — a JS number with no fractional part has semantic type integer)
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const semantic = typeOf(value) === 'number'
      ? (Number.isInteger(value) ? 'integer' : 'number')
      : typeOf(value);
    if (!types.includes(semantic)) {
      errors.push(`type: ${dataPath} must be ${types.join('|')} (got ${semantic} ${JSON.stringify(value)})`);
      return; // no point continuing type-dependent checks
    }
  }

  // const
  if (node.const !== undefined && !deepEqual(value, node.const)) {
    errors.push(`const: ${dataPath} must equal ${JSON.stringify(node.const)} (got ${JSON.stringify(value)})`);
  }

  // enum
  if (node.enum !== undefined) {
    const ok = Array.isArray(node.enum) && node.enum.some((e) => deepEqual(value, e));
    if (!ok) {
      errors.push(`enum: ${dataPath} must be one of ${JSON.stringify(node.enum)} (got ${JSON.stringify(value)})`);
    }
  }

  // pattern
  if (node.pattern !== undefined) {
    if (typeof value !== 'string' || !new RegExp(node.pattern).test(value)) {
      errors.push(`pattern: ${dataPath} must match ${node.pattern} (got ${JSON.stringify(value)})`);
    }
  }

  // minLength / maxLength
  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push(`bounds: ${dataPath} shorter than minLength ${node.minLength}`);
    }
    if (node.maxLength !== undefined && value.length > node.maxLength) {
      errors.push(`bounds: ${dataPath} longer than maxLength ${node.maxLength}`);
    }
  }

  // minimum / maximum
  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) {
      errors.push(`bounds: ${dataPath} below minimum ${node.minimum} (got ${value})`);
    }
    if (node.maximum !== undefined && value > node.maximum) {
      errors.push(`bounds: ${dataPath} above maximum ${node.maximum} (got ${value})`);
    }
  }

  // object structure
  if (isObject(value)) {
    if (node.required !== undefined && Array.isArray(node.required)) {
      for (const req of node.required) {
        if (!Object.prototype.hasOwnProperty.call(value, req)) {
          errors.push(`missing-field: ${dataPath} missing required field "${req}"`);
        }
      }
    }
    if (node.properties !== undefined && isObject(node.properties)) {
      for (const [key, propSchema] of Object.entries(node.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          validateNode(value[key], propSchema, rootSchema, `${dataPath}.${key}`, errors);
        }
      }
    }
    if (node.additionalProperties === false) {
      const allowed = new Set(Object.keys(node.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`extra-key: unknown field "${key}" at ${dataPath}`);
        }
      }
    }
  }

  // array structure
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push(`bounds: ${dataPath} has fewer than minItems ${node.minItems} elements (${value.length})`);
    }
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      errors.push(`bounds: ${dataPath} has more than maxItems ${node.maxItems} elements (${value.length})`);
    }
    if (node.uniqueItems === true) {
      for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (deepEqual(value[i], value[j])) {
            errors.push(`unique-items: duplicate element at ${dataPath}[${i}] and [${j}]`);
          }
        }
      }
    }
    if (node.items !== undefined && isObject(node.items)) {
      for (let i = 0; i < value.length; i += 1) {
        validateNode(value[i], node.items, rootSchema, `${dataPath}[${i}]`, errors);
      }
    }
  }
}

/**
 * Validate a document against a full published schema (root).
 * @returns {string[]} errors (empty = valid)
 */
function validateDocument(doc, schema) {
  const errors = [];
  validateNode(doc, schema, schema, 'doc', errors);
  return errors;
}

/**
 * Schema self-check: draft version, internal refs only, additionalProperties
 * false at every object node, every keyword in the supported subset.
 * @returns {string[]} errors (empty = sound)
 */
function checkSchemaSelf(schema, label) {
  const errors = [];
  if (!isObject(schema)) return [`${label}: schema must be an object`];
  if (typeof schema.$schema !== 'string' || !schema.$schema.startsWith('https://json-schema.org/draft/2020-12/schema')) {
    errors.push(`${label}: $schema must be Draft 2020-12 (got ${JSON.stringify(schema.$schema)})`);
  }
  if (typeof schema.$id !== 'string' || !/^https:\/\/github\.com\/christo0192\/Project_HELLO\/config\//.test(schema.$id)) {
    errors.push(`${label}: $id must be the repo-convention identifier namespace (got ${JSON.stringify(schema.$id)})`);
  }
  if (typeof schema.version !== 'string' || !SEMVER.test(schema.version)) {
    errors.push(`${label}: schema version must be a semantic version string`);
  }

  // Descend only through structural containers ($defs, properties, items);
  // every visited node is a schema node and must use the supported subset.
  const walk = (node, pathStr) => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${pathStr}[${i}]`));
      return;
    }
    if (!isObject(node)) return;

    // keyword support
    for (const key of Object.keys(node)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        errors.push(`${label}: unsupported keyword "${key}" at ${pathStr} — the validator would silently ignore it`);
      }
    }

    if (typeof node.$ref === 'string') {
      if (!node.$ref.startsWith('#/$defs/')) {
        errors.push(`${label}: external or non-$defs $ref "${node.$ref}" at ${pathStr}`);
      } else if (resolveRef(node.$ref, schema) === null) {
        errors.push(`${label}: $ref "${node.$ref}" at ${pathStr} does not resolve`);
      }
    }

    if (node.type === 'object' || (node.type === undefined && (node.properties || node.required))) {
      if (node.additionalProperties !== false) {
        errors.push(`${label}: additionalProperties must be false at ${pathStr || 'root'}`);
      }
    }

    if (Array.isArray(node.required)) {
      for (const req of node.required) {
        if (!isObject(node.properties) || !Object.prototype.hasOwnProperty.call(node.properties, req)) {
          errors.push(`${label}: required field "${req}" at ${pathStr} has no property schema`);
        }
      }
    }
    if (node.enum !== undefined && !Array.isArray(node.enum)) {
      errors.push(`${label}: enum must be an array at ${pathStr}`);
    }
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.every((t) => ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(t))) {
        errors.push(`${label}: invalid type at ${pathStr}`);
      }
    }

    if (isObject(node.$defs)) {
      for (const [key, val] of Object.entries(node.$defs)) walk(val, `${pathStr}.$defs.${key}`);
    }
    if (isObject(node.properties)) {
      for (const [key, val] of Object.entries(node.properties)) walk(val, `${pathStr}.properties.${key}`);
    }
    if (isObject(node.items)) walk(node.items, `${pathStr}.items`);
  };

  walk(schema, 'root');
  return errors;
}

// ---------------------------------------------------------------------------
// Category semantic checks (cross-field invariants)
// ---------------------------------------------------------------------------
const GATE_FORBIDDEN_STATUSES = ['COMPLETE', 'GREEN', 'SIGNED', 'APPROVED', 'GO'];
const LCH02_FORBIDDEN_STATUSES = [
  'DEPLOYED', 'ACTIVE', 'LIVE', 'GO', 'GREEN', 'APPROVED', 'AUTHORIZED', 'EXECUTED',
  'COMPLETED', 'SIGNED', 'ACCEPTED', 'PROMOTED', 'ROLLED_BACK', 'ABORTED', 'PROVISIONED',
];
const RETRO_FORBIDDEN_STATUSES = ['PUBLISHED', 'COMPLETED', 'FILED', 'CLOSED'];

function checkLch01(doc, errors) {
  const gates = doc?.gates;
  if (!Array.isArray(gates)) return;

  for (const g of gates) {
    if (isObject(g) && GATE_FORBIDDEN_STATUSES.includes(g.status)) {
      errors.push(`lch01-cross-field: gate ${JSON.stringify(g.gateId)} status ${JSON.stringify(g.status)} is a forbidden positive claim`);
    }
    if (isObject(g) && typeof g.gateId === 'string' && !CANONICAL_GATE_IDS.includes(g.gateId)) {
      errors.push(`lch01-canonical: gate ${JSON.stringify(g.gateId)} is not one of the 17 canonical launch gates`);
    }
  }
  // no duplicates
  const seen = new Set();
  for (const g of gates) {
    if (isObject(g) && typeof g.gateId === 'string') {
      if (seen.has(g.gateId)) errors.push(`lch01-canonical: duplicate gate ${JSON.stringify(g.gateId)}`);
      seen.add(g.gateId);
    }
  }
  // exact canonical set + order
  const ids = gates.filter((g) => isObject(g) && typeof g.gateId === 'string').map((g) => g.gateId);
  if (ids.length !== CANONICAL_GATE_IDS.length || !ids.every((id, i) => id === CANONICAL_GATE_IDS[i])) {
    errors.push('lch01-canonical: gate array must contain exactly the 17 canonical gate IDs in PLAN.md section 8 order');
  }
  // go decision positive claim cross-field: GO requires non-null recordedBy, but recordedBy is forbidden
  const go = doc?.goDecision;
  if (isObject(go)) {
    if (go.decision === 'GO') {
      errors.push('lch01-cross-field: goDecision.decision "GO" is a forbidden positive claim (GO requires authorized named sign-off with authentic external evidence)');
    }
    if (go.decision !== 'PENDING' && go.decision !== 'PROPOSED' && go.decision !== undefined) {
      errors.push(`lch01-cross-field: goDecision.decision ${JSON.stringify(go.decision)} is outside {PENDING, PROPOSED}`);
    }
    if (go.recordedBy !== null && go.recordedBy !== undefined) {
      errors.push('lch01-cross-field: goDecision.recordedBy must be null: no signatory may be recorded');
    }
    if (go.date !== null && go.date !== undefined) {
      errors.push('lch01-cross-field: goDecision.date must be null: no decision date may be recorded');
    }
    if (go.evidenceRef !== null && go.evidenceRef !== undefined) {
      errors.push('lch01-cross-field: goDecision.evidenceRef must be null: no evidence may authorize a decision');
    }
  }
  const approvals = doc?.approvals;
  if (isObject(approvals)) {
    if (approvals.status !== 'PENDING') {
      errors.push(`lch01-cross-field: approvals.status must be PENDING (got ${JSON.stringify(approvals.status)})`);
    }
    if (approvals.signatory !== null && approvals.signatory !== undefined) {
      errors.push('lch01-cross-field: approvals.signatory must be null: no signatory may be recorded');
    }
    if (approvals.date !== null && approvals.date !== undefined) {
      errors.push('lch01-cross-field: approvals.date must be null');
    }
    if (approvals.evidenceRef !== null && approvals.evidenceRef !== undefined) {
      errors.push('lch01-cross-field: approvals.evidenceRef must be null');
    }
  }
  const evidence = doc?.evidence;
  if (isObject(evidence)) {
    if (evidence.type !== 'synthetic_local') {
      errors.push(`lch01-cross-field: evidence.type must be "synthetic_local" (got ${JSON.stringify(evidence.type)})`);
    }
    if (evidence.status !== 'PENDING') {
      errors.push(`lch01-cross-field: evidence.status must be PENDING (got ${JSON.stringify(evidence.status)})`);
    }
  }
  const authority = doc?.authority;
  if (isObject(authority)) {
    if (authority.source !== 'config/current-state.json') {
      errors.push(`lch01-authority: authority.source must be "config/current-state.json" (got ${JSON.stringify(authority.source)})`);
    }
    if (authority.role !== 'authoritative-source-of-truth') {
      errors.push(`lch01-authority: authority.role must be "authoritative-source-of-truth" (got ${JSON.stringify(authority.role)})`);
    }
  }
}

function checkLch02(doc, errors) {
  const deployment = doc?.deployment;
  if (isObject(deployment)) {
    if (deployment.deployed === true) {
      errors.push('lch02-cross-field: deployment.deployed must be false: repository-only work never deploys or provisions anything');
    }
    if (deployment.launchSessionId !== null && deployment.launchSessionId !== undefined) {
      errors.push('lch02-cross-field: deployment.launchSessionId must be null: no launch session exists');
    }
    if (typeof deployment.stage === 'string' && LCH02_FORBIDDEN_STATUSES.includes(deployment.stage)) {
      errors.push(`lch02-cross-field: deployment.stage ${JSON.stringify(deployment.stage)} is a forbidden positive claim`);
    }
    if (typeof deployment.releaseState === 'string' && LCH02_FORBIDDEN_STATUSES.includes(deployment.releaseState)) {
      errors.push(`lch02-cross-field: deployment.releaseState ${JSON.stringify(deployment.releaseState)} is a forbidden positive claim`);
    }
    const sm = deployment.stateMachine;
    if (isObject(sm)) {
      if (sm.forked === true) {
        errors.push('lch02-no-fork: deployment.stateMachine.forked must be false: Phase 12 references the Phase 11 machine and does not fork it');
      }
      if (sm.reference !== 'infra/deployment-contracts/release-record.example.json') {
        errors.push(`lch02-no-fork: deployment.stateMachine.reference must be the Phase 11 release record (got ${JSON.stringify(sm.reference)})`);
      }
      if (sm.validator !== 'scripts/validate-deployment-release') {
        errors.push(`lch02-no-fork: deployment.stateMachine.validator must be the Phase 11 validator (got ${JSON.stringify(sm.validator)})`);
      }
      if (sm.allowedTransitions !== PHASE11_ALLOWED_TRANSITIONS) {
        errors.push('lch02-no-fork: deployment.stateMachine.allowedTransitions must be exactly the Phase 11 DEP-06 legal chain (no alternative transitions)');
      }
    }
  }
  const firstSession = doc?.firstSession;
  if (isObject(firstSession)) {
    if (firstSession.firstSessionCompleted === true) {
      errors.push('lch02-cross-field: firstSession.firstSessionCompleted must be false: no first session has completed');
    }
    if (firstSession.firstRealSessionCompleted === true) {
      errors.push('lch02-cross-field: firstSession.firstRealSessionCompleted must be false: no real session has completed');
    }
    if (firstSession.sessionId !== null && firstSession.sessionId !== undefined) {
      errors.push('lch02-cross-field: firstSession.sessionId must be null: no session identifier exists');
    }
    if (firstSession.recordedAt !== null && firstSession.recordedAt !== undefined) {
      errors.push('lch02-cross-field: firstSession.recordedAt must be null: no session timestamp exists');
    }
  }
  const onCall = doc?.onCall;
  if (isObject(onCall)) {
    if (onCall.onCallActive === true) {
      errors.push('lch02-cross-field: onCall.onCallActive must be false: no on-call engineer is active');
    }
    if (typeof onCall.onCallRoster === 'string' && onCall.onCallRoster !== 'PENDING') {
      errors.push(`lch02-cross-field: onCall.onCallRoster must be PENDING (got ${JSON.stringify(onCall.onCallRoster)})`);
    }
  }
  const rollback = doc?.rollback;
  if (isObject(rollback)) {
    if (typeof rollback.rollbackAuthority === 'string' && !['NOT_DEPLOYED', 'PENDING', 'NOT_ACTIVE'].includes(rollback.rollbackAuthority)) {
      errors.push(`lch02-cross-field: rollback.rollbackAuthority ${JSON.stringify(rollback.rollbackAuthority)} is a forbidden positive claim (AUTHORIZED/APPROVED/GRANTED/ACTIVE rejected)`);
    }
    if (rollback.authorizedBy !== null && rollback.authorizedBy !== undefined) {
      errors.push('lch02-cross-field: rollback.authorizedBy must be null: no rollback authority is named');
    }
    if (rollback.decisionDate !== null && rollback.decisionDate !== undefined) {
      errors.push('lch02-cross-field: rollback.decisionDate must be null');
    }
    if (rollback.targetKind !== 'repository-marker') {
      errors.push(`lch02-cross-field: rollback.targetKind must be "repository-marker" (got ${JSON.stringify(rollback.targetKind)})`);
    }
  }
  const monitoring = doc?.monitoring;
  if (isObject(monitoring)) {
    if (monitoring.dashboardMonitored === true) {
      errors.push('lch02-cross-field: monitoring.dashboardMonitored must be false: no dashboard is monitored');
    }
    if (monitoring.endpoint !== null && monitoring.endpoint !== undefined) {
      errors.push('lch02-cross-field: monitoring.endpoint must be null: no monitoring endpoint exists');
    }
    if (monitoring.observabilityConnected === true) {
      errors.push('lch02-cross-field: monitoring.observabilityConnected must be false');
    }
    if (monitoring.alertsActive === true) {
      errors.push('lch02-cross-field: monitoring.alertsActive must be false: no alert is active');
    }
  }
  const evidence = doc?.evidence;
  if (isObject(evidence)) {
    if (evidence.evidenceType !== 'synthetic_local') {
      errors.push(`lch02-cross-field: evidence.evidenceType must be "synthetic_local" (got ${JSON.stringify(evidence.evidenceType)})`);
    }
    if (evidence.status !== 'PENDING') {
      errors.push(`lch02-cross-field: evidence.status must be PENDING (got ${JSON.stringify(evidence.status)})`);
    }
    if (Array.isArray(evidence.paths) && evidence.paths.length !== 0) {
      errors.push('lch02-cross-field: evidence.paths must be empty: no evidence path exists or can authorize a claim');
    }
  }
  const authority = doc?.authority;
  if (isObject(authority)) {
    if (authority.source !== 'config/current-state.json') {
      errors.push(`lch02-authority: authority.source must be "config/current-state.json" (got ${JSON.stringify(authority.source)})`);
    }
  }
}

function checkLch03(doc, errors, fixtureName) {
  const drill = doc?.drill;
  if (!isObject(drill)) return;
  const { declaredThreshold, syntheticSessionCount, trafficSource, hypercareWindowAccepted, elapsedHoursOnly } = drill;
  const numericCount = typeof syntheticSessionCount === 'number';
  const numericThreshold = typeof declaredThreshold === 'number';
  const booleanAccepted = typeof hypercareWindowAccepted === 'boolean';

  if (booleanAccepted && hypercareWindowAccepted === true) {
    if (numericCount && syntheticSessionCount === 0) {
      errors.push('lch03-cross-field: hypercareWindowAccepted cannot be true with 0 synthetic sessions: the gate is not vacuous');
    }
    if (numericCount && numericThreshold && syntheticSessionCount < declaredThreshold) {
      errors.push(`lch03-cross-field: hypercareWindowAccepted cannot be true with ${syntheticSessionCount} sessions below the declared threshold ${declaredThreshold}`);
    }
    if (trafficSource !== 'synthetic_local') {
      errors.push('lch03-cross-field: hypercareWindowAccepted requires trafficSource "synthetic_local": real traffic is never accepted');
    }
    if (elapsedHoursOnly === true) {
      errors.push('lch03-cross-field: elapsed-hours-only acceptance is forbidden: wall-clock duration alone cannot accept a window');
    }
  }

  // declared/computed must match (both directions)
  if (numericCount && numericThreshold && booleanAccepted) {
    const computed = syntheticSessionCount >= declaredThreshold && trafficSource === 'synthetic_local';
    if (computed !== hypercareWindowAccepted) {
      errors.push(`lch03-cross-field: declared hypercareWindowAccepted (${JSON.stringify(hypercareWindowAccepted)}) does not match the computed synthetic result (${JSON.stringify(computed)}) for ${syntheticSessionCount} sessions vs threshold ${declaredThreshold}`);
    }
  }

  if (drill.productionAcceptance === true) {
    errors.push('lch03-cross-field: drill.productionAcceptance must be false: repository drills never claim production acceptance');
  }
  for (const k of ['sloAttainment', 'errorBudgetRemaining', 'errorBudgetHealthy']) {
    if (drill[k] !== null && drill[k] !== undefined) {
      errors.push(`lch03-cross-field: drill.${k} must be null: real ${k} is never claimed by a synthetic drill (got ${JSON.stringify(drill[k])})`);
    }
  }
  if (typeof drill.hypercareStatus === 'string' && !['NOT_RUN', 'PENDING'].includes(drill.hypercareStatus)) {
    errors.push(`lch03-cross-field: drill.hypercareStatus ${JSON.stringify(drill.hypercareStatus)} is a forbidden positive claim (only NOT_RUN|PENDING)`);
  }
  if (typeof drill.incidentCadence === 'string' && drill.incidentCadence !== 'PENDING') {
    errors.push(`lch03-cross-field: drill.incidentCadence must be PENDING (got ${JSON.stringify(drill.incidentCadence)})`);
  }
  if (typeof drill.rollbackAuthority === 'string' && drill.rollbackAuthority !== 'PENDING') {
    errors.push(`lch03-cross-field: drill.rollbackAuthority must be PENDING (got ${JSON.stringify(drill.rollbackAuthority)})`);
  }
  if (drill.elapsedHoursOnly === true) {
    errors.push('lch03-cross-field: drill.elapsedHoursOnly must be false: wall-clock-only acceptance is forbidden');
  }
  const evidence = doc?.evidence;
  if (isObject(evidence)) {
    if (Array.isArray(evidence.sessionIds) && evidence.sessionIds.length !== 0) {
      errors.push('lch03-cross-field: evidence.sessionIds must be empty: no session identifier exists or can authorize a claim');
    }
    if (Array.isArray(evidence.endpoints) && evidence.endpoints.length !== 0) {
      errors.push('lch03-cross-field: evidence.endpoints must be empty: no endpoint, host, or URL exists or can authorize a claim');
    }
    if (evidence.evidenceType !== 'synthetic_local') {
      errors.push(`lch03-cross-field: evidence.evidenceType must be "synthetic_local" (got ${JSON.stringify(evidence.evidenceType)})`);
    }
    if (evidence.status !== 'PENDING') {
      errors.push(`lch03-cross-field: evidence.status must be PENDING (got ${JSON.stringify(evidence.status)})`);
    }
  }
  const authority = doc?.authority;
  if (isObject(authority)) {
    if (authority.source !== 'config/current-state.json') {
      errors.push(`lch03-authority: authority.source must be "config/current-state.json" (got ${JSON.stringify(authority.source)})`);
    }
  }
  // (fixtureName only used to disambiguate error context in callers)
  void fixtureName;
}

function checkLch04(doc, errors) {
  const retro = doc?.retro;
  if (isObject(retro)) {
    if (typeof retro.retroStatus === 'string' && RETRO_FORBIDDEN_STATUSES.includes(retro.retroStatus)) {
      errors.push(`lch04-cross-field: retro.retroStatus ${JSON.stringify(retro.retroStatus)} is a forbidden positive claim (only PENDING|TEMPLATE|NOT_STARTED)`);
    }
    if (retro.sessionDate !== null && retro.sessionDate !== undefined) {
      errors.push('lch04-cross-field: retro.sessionDate must be null: no retro session has run');
    }
    if (retro.facilitator !== null && retro.facilitator !== undefined) {
      errors.push('lch04-cross-field: retro.facilitator must be null: no facilitator is named');
    }
    if (Array.isArray(retro.participants) && retro.participants.length !== 0) {
      errors.push('lch04-cross-field: retro.participants must be empty: no participant is named');
    }
    if (Array.isArray(retro.findings) && retro.findings.length !== 0) {
      errors.push('lch04-cross-field: retro.findings must be empty: no finding is recorded');
    }
    for (const k of ['published', 'completed', 'filed', 'closed']) {
      if (retro[k] === true) {
        errors.push(`lch04-cross-field: retro.${k} must be false: a repository-only retro template never publishes/completes/files/closes`);
      }
    }
  }
  const actionItems = doc?.actionItems;
  if (isObject(actionItems)) {
    if (actionItems.actionItemsFiled === true) {
      errors.push('lch04-cross-field: actionItems.actionItemsFiled must be false: no action item is filed');
    }
    if (typeof actionItems.count === 'number' && actionItems.count !== 0) {
      errors.push(`lch04-cross-field: actionItems.count must be 0 (got ${actionItems.count}): no real action item exists`);
    }
    if (Array.isArray(actionItems.items) && actionItems.items.length !== 0) {
      errors.push('lch04-cross-field: actionItems.items must be empty: no real action item may be claimed');
    }
  }
  const evidence = doc?.evidence;
  if (isObject(evidence)) {
    if (evidence.evidenceType !== 'synthetic_local') {
      errors.push(`lch04-cross-field: evidence.evidenceType must be "synthetic_local" (got ${JSON.stringify(evidence.evidenceType)})`);
    }
    if (evidence.status !== 'PENDING') {
      errors.push(`lch04-cross-field: evidence.status must be PENDING (got ${JSON.stringify(evidence.status)})`);
    }
  }
  const authority = doc?.authority;
  if (isObject(authority)) {
    if (authority.source !== 'config/current-state.json') {
      errors.push(`lch04-authority: authority.source must be "config/current-state.json" (got ${JSON.stringify(authority.source)})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Canonical 17 gate IDs: PLAN.md section 8 (lines with "- [ ] **XXX-GATE:**")
// is the authority; the LCH-01 schema enum must match it exactly.
// ---------------------------------------------------------------------------
function extractPlanGateIds() {
  const planPath = path.join(REPO_ROOT, 'PLAN.md');
  try {
    const text = fs.readFileSync(planPath, 'utf8');
    const re = /^\s*- \[ \] \*\*([A-Z][A-Z0-9]*-GATE):/gm;
    const ids = [];
    let m;
    while ((m = re.exec(text)) !== null) ids.push(m[1]);
    return ids;
  } catch {
    return null;
  }
}

let CANONICAL_GATE_IDS = [
  'PII-GATE', 'AUTH-GATE', 'KEY-GATE', 'UPLOAD-GATE', 'AI-GATE', 'CONSENT-GATE',
  'MIGRATION-GATE', 'BACKUP-GATE', 'LOAD-GATE', 'OBSERVABILITY-GATE', 'CI-GATE',
  'E2E-GATE', 'RELIABILITY-GATE', 'SECURITY-GATE', 'FAIRNESS-GATE', 'LEGAL-GATE',
  'DATA-GATE',
];

// ---------------------------------------------------------------------------
// Evidence path safety (only applied where paths are actually permitted; the
// committed Phase 12 evidence arrays are forced empty, so any injected path
// is rejected as an array violation first).
// ---------------------------------------------------------------------------
function isSafeEvidencePath(value, root = REPO_ROOT) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (path.isAbsolute(value)) return false;
  if (value.includes('\0')) return false;
  if (value.includes('..')) return false; // any traversal attempt, incl "a/../b"
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  try {
    const st = fs.lstatSync(resolved);
    if (!st.isFile()) return false; // reject directories, symlinks, sockets, etc.
  } catch {
    return false; // must resolve to an existing committed regular file
  }
  return true;
}

// ---------------------------------------------------------------------------
// Current-state checks: semantic (always) + byte identity (git ref)
// ---------------------------------------------------------------------------
function checkCurrentState(errors, out) {
  const manifest = loadJson('config/current-state.json');
  if (manifest.__loadError) {
    errors.push(`current-state: ${manifest.__loadError}`);
    return;
  }
  const gates = manifest.gates;
  const phases = manifest.phases;
  const status = manifest.status;
  if (!isObject(gates)) {
    errors.push('current-state: gates must be an object');
  } else {
    if (gates.launchGatesComplete !== 0) errors.push(`current-state: launchGatesComplete must be 0 (got ${gates.launchGatesComplete})`);
    if (gates.launchGatesTotal !== 17) errors.push(`current-state: launchGatesTotal must be 17 (got ${gates.launchGatesTotal})`);
  }
  if (!isObject(phases)) {
    errors.push('current-state: phases must be an object');
  } else {
    if (phases.acceptedPhasesComplete !== 0) errors.push(`current-state: acceptedPhasesComplete must be 0 (got ${phases.acceptedPhasesComplete})`);
    if (phases.acceptedPhasesTotal !== 14) errors.push(`current-state: acceptedPhasesTotal must be 14 (got ${phases.acceptedPhasesTotal})`);
  }
  if (!isObject(status)) {
    errors.push('current-state: status must be an object');
  } else {
    if (status.production !== 'pre-production') errors.push(`current-state: status.production must be "pre-production" (got ${JSON.stringify(status.production)})`);
    if (status.dataStage !== 'synthetic-only') errors.push(`current-state: status.dataStage must be "synthetic-only" (got ${JSON.stringify(status.dataStage)})`);
    if (status.scope !== 'browser-only') errors.push(`current-state: status.scope must be "browser-only" (got ${JSON.stringify(status.scope)})`);
  }
  out.currentState = {
    launchGatesComplete: gates?.launchGatesComplete,
    launchGatesTotal: gates?.launchGatesTotal,
    acceptedPhasesComplete: phases?.acceptedPhasesComplete,
    acceptedPhasesTotal: phases?.acceptedPhasesTotal,
    production: status?.production,
  };
}

function checkCurrentStateByteIdentity(ref, errors, out) {
  const targets = ['config/current-state.json', 'docs/current-state.md'];
  const res = spawnSync('git', ['-C', REPO_ROOT, 'diff', '--exit-code', ref, '--', ...targets], {
    encoding: 'utf8',
  });
  if (res.error || res.status === 129) {
    // FAIL CLOSED: no git or an unusable git means the byte-identity gate
    // cannot be proven — this is a validation error, never a silent skip.
    errors.push(`current-state: git unavailable or unusable — byte identity of ${targets.join(', ')} vs ${ref} cannot be verified (fail closed)`);
    out.byteIdentity = { checked: false, identical: null, reason: 'git unavailable', ref };
    return;
  }
  if (res.status === 128) {
    // FAIL CLOSED: an unresolvable baseline ref must never look like a pass.
    errors.push(`current-state: baseline ref "${ref}" not found — byte identity of ${targets.join(', ')} cannot be verified (fail closed)`);
    out.byteIdentity = { checked: false, identical: null, reason: `git ref "${ref}" not found`, ref };
    return;
  }
  if (res.status !== 0) {
    for (const t of targets) errors.push(`current-state: ${t} differs from ${ref} (byte identity broken)`);
    out.byteIdentity = { checked: true, identical: false, ref };
    return;
  }
  out.byteIdentity = { checked: true, identical: true, ref };
}

// ---------------------------------------------------------------------------
// Phase 11 reference existence (LCH-02 must reference, not fork)
// ---------------------------------------------------------------------------
function checkPhase11References(errors, out) {
  for (const [label, rel] of Object.entries(PHASE11_REFS)) {
    const full = path.join(REPO_ROOT, rel);
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile()) {
        errors.push(`phase11-ref: ${rel} must exist as a regular file (${label})`);
        continue;
      }
    } catch {
      errors.push(`phase11-ref: ${rel} must exist (${label})`);
      continue;
    }
    if (label === 'releaseRecord' || label === 'deploymentManifest') {
      const doc = loadJson(rel);
      if (doc.__loadError) errors.push(`phase11-ref: ${rel} must parse as JSON (${label})`);
    }
  }
  out.phase11Refs = Object.values(PHASE11_REFS).every((rel) => {
    try {
      return fs.lstatSync(path.join(REPO_ROOT, rel)).isFile();
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Docs existence (structural: exists, non-empty, starts with a markdown
// heading). Prose is never scanned for positive-claim tokens.
// ---------------------------------------------------------------------------
function checkDocs(errors, out) {
  for (const rel of ARTIFACTS.docs) {
    const full = path.join(REPO_ROOT, rel);
    try {
      const text = fs.readFileSync(full, 'utf8');
      if (text.trim().length === 0) errors.push(`docs: ${rel} must be non-empty`);
      else if (!/^#{1,2} /m.test(text)) errors.push(`docs: ${rel} must contain a markdown heading`);
    } catch {
      errors.push(`docs: ${rel} must exist`);
    }
  }
  out.docsChecked = ARTIFACTS.docs.length;
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------
function validateAll({ baselineRef, listArtifacts } = {}) {
  const errors = [];
  const out = {};

  if (listArtifacts) {
    process.stdout.write('Phase 12 committed artifact set validated by this script:\n');
    for (const [k, rel] of Object.entries(ARTIFACTS.schemas)) process.stdout.write(`  schema ${k}: ${rel}\n`);
    for (const [k, rel] of Object.entries(ARTIFACTS.examples)) process.stdout.write(`  example ${k}: ${rel}\n`);
    for (const rel of ARTIFACTS.hypercareFixtures) process.stdout.write(`  hypercare fixture: ${rel}\n`);
    for (const rel of ARTIFACTS.docs) process.stdout.write(`  doc: ${rel}\n`);
    process.stdout.write(`  phase11 refs: ${Object.values(PHASE11_REFS).join(', ')}\n`);
    return { errors: [], out };
  }

  // 1. schemas: load + self-check
  const schemas = {};
  const schemaFiles = ARTIFACTS.schemas;
  for (const [cat, rel] of Object.entries(schemaFiles)) {
    const schema = loadJson(rel);
    if (schema.__loadError) {
      errors.push(`schema ${cat}: ${schema.__loadError}`);
      continue;
    }
    schemas[cat] = schema;
    errors.push(...checkSchemaSelf(schema, `schema ${cat} (${rel})`));
  }

  // 2. canonical gate authority: PLAN.md section 8 vs LCH-01 schema enum
  const planIds = extractPlanGateIds();
  const lch01Schema = schemas.lch01;
  if (planIds === null) {
    errors.push('lch01-canonical: PLAN.md must exist and parse for canonical gate extraction');
  } else if (planIds.length !== 17) {
    errors.push(`lch01-canonical: PLAN.md section 8 must list exactly 17 gates (found ${planIds.length})`);
  } else {
    CANONICAL_GATE_IDS = [...planIds];
    const schemaEnum = lch01Schema?.$defs?.gate?.properties?.gateId?.enum;
    if (!Array.isArray(schemaEnum)) {
      errors.push('lch01-canonical: LCH-01 schema $defs.gate.properties.gateId.enum must exist');
    } else if (schemaEnum.length !== planIds.length || !schemaEnum.every((id, i) => id === planIds[i])) {
      errors.push('lch01-canonical: LCH-01 schema gate enum must match PLAN.md section 8 order exactly');
    }
    out.canonicalGateIds = CANONICAL_GATE_IDS.length;
  }

  // 3. examples: schema validation + category semantics
  const exampleResults = {};
  for (const [cat, rel] of Object.entries(ARTIFACTS.examples)) {
    const doc = loadJson(rel);
    if (doc.__loadError) {
      errors.push(`example ${cat}: ${doc.__loadError}`);
      continue;
    }
    const schema = schemas[cat];
    if (schema) {
      const schemaErrors = validateDocument(doc, schema);
      for (const e of schemaErrors) errors.push(`example ${cat} (${rel}): ${e}`);
    }
    if (cat === 'lch01') checkLch01(doc, errors);
    if (cat === 'lch02') checkLch02(doc, errors);
    if (cat === 'lch03') checkLch03(doc, errors, rel);
    if (cat === 'lch04') checkLch04(doc, errors);
    exampleResults[cat] = true;
  }
  out.examplesValidated = Object.keys(exampleResults).length;

  // 4. hypercare fixtures: schema validation + category semantics + canonical
  //    drill-harness computation (declared claim must equal computed result)
  const fixtureResults = [];
  for (const rel of ARTIFACTS.hypercareFixtures) {
    const doc = loadJson(rel);
    if (doc.__loadError) {
      errors.push(`hypercare fixture ${rel}: ${doc.__loadError}`);
      continue;
    }
    const schema = schemas.lch03;
    if (schema) {
      const schemaErrors = validateDocument(doc, schema);
      for (const e of schemaErrors) errors.push(`hypercare fixture ${rel}: ${e}`);
    }
    checkLch03(doc, errors, rel);
    const drillCheck = validateHypercareFixture(doc, { fixtureName: rel });
    if (!drillCheck.valid) {
      for (const e of drillCheck.errors) errors.push(`hypercare fixture ${rel} (harness): ${e}`);
    }
    const computed = (typeof doc?.drill?.syntheticSessionCount === 'number' &&
      typeof doc?.drill?.declaredThreshold === 'number' &&
      doc.drill.syntheticSessionCount >= doc.drill.declaredThreshold &&
      doc?.drill?.trafficSource === 'synthetic_local');
    fixtureResults.push({
      fixture: rel,
      valid: drillCheck.valid,
      syntheticSessionCount: doc?.drill?.syntheticSessionCount,
      declaredThreshold: doc?.drill?.declaredThreshold,
      hypercareWindowAccepted: doc?.drill?.hypercareWindowAccepted,
      computed,
      declaredClaimVerified: drillCheck.valid && computed === doc?.drill?.hypercareWindowAccepted,
      drillStatus: drillCheck.valid ? 'verified' : 'invalid',
    });
  }
  out.hypercareFixturesValidated = fixtureResults.length;

  // 5. current-state: semantic + byte identity
  checkCurrentState(errors, out);
  checkCurrentStateByteIdentity(baselineRef, errors, out);

  // 6. Phase 11 references exist
  checkPhase11References(errors, out);

  // 7. docs existence
  checkDocs(errors, out);

  return { errors, out };
}

function usage() {
  process.stdout.write(
    `usage: node ${VALIDATOR_NAME}.mjs [--baseline-ref <ref>] [--list-artifacts]\n` +
    `  (no args)          validate every committed Phase 12 artifact (schemas, examples, hypercare fixtures)\n` +
    `  --baseline-ref R   byte-identity ref for current-state (default ${PHASE12_CURRENT_STATE_BASE}; must be an immutable ref, never origin/main)\n` +
    `  --list-artifacts   print the exact artifact set this validator checks, then exit\n`,
  );
  return 2;
}

function main(argv) {
  const args = argv.slice(2);
  let baselineRef = PHASE12_CURRENT_STATE_BASE;
  let listArtifacts = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--baseline-ref') {
      i += 1;
      if (i >= args.length) return usage();
      baselineRef = args[i];
    } else if (args[i] === '--list-artifacts') {
      listArtifacts = true;
    } else {
      return usage();
    }
  }

  const { errors, out } = validateAll({ baselineRef, listArtifacts });
  const ok = errors.length === 0;

  process.stdout.write('Phase 12 launch readiness — comprehensive contract validator\n');
  process.stdout.write(`validator: ${VALIDATOR_NAME}.mjs v${VALIDATOR_VERSION} (Node stdlib, Draft 2020-12 subset)\n`);
  process.stdout.write(`baseline: ${baselineRef}\n`);
  process.stdout.write(`schemas validated: 4  examples validated: ${out.examplesValidated ?? 0}  ` +
    `hypercare fixtures validated: ${out.hypercareFixturesValidated ?? 0}  docs checked: ${out.docsChecked ?? 0}\n`);
  if (out.canonicalGateIds !== undefined) {
    process.stdout.write(`canonical launch gates (PLAN.md section 8): ${out.canonicalGateIds} IDs, schema enum matches\n`);
  }
  if (out.currentState) {
    const cs = out.currentState;
    process.stdout.write(`current-state: gates ${cs.launchGatesComplete}/${cs.launchGatesTotal}  ` +
      `phases ${cs.acceptedPhasesComplete}/${cs.acceptedPhasesTotal}  production ${cs.production}\n`);
  }
  if (out.byteIdentity) {
    const bi = out.byteIdentity;
    if (bi.checked) {
      process.stdout.write(`current-state byte identity vs ${bi.ref}: ${bi.identical ? 'identical' : 'DIFFERS'}\n`);
    } else {
      process.stdout.write(`current-state byte identity: NOT VERIFIED — fail closed (${bi.reason})\n`);
    }
  }
  if (out.phase11Refs !== undefined) {
    process.stdout.write(`phase 11 reference paths (release record, manifest, validator): ${out.phase11Refs ? 'present' : 'MISSING'}\n`);
  }

  if (ok) {
    process.stdout.write('RESULT: ALL GREEN — no missing required field, type/const/enum/bounds violation, extra key, cross-field violation, or positive claim.\n');
    return 0;
  }

  process.stdout.write(`RESULT: FAIL — ${errors.length} error(s):\n`);
  for (const e of errors) process.stdout.write(`  [${e}]\n`);
  return 1;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  process.exitCode = main(process.argv);
}

// Exported for the self-test (path-safety unit checks).
export { isSafeEvidencePath, validateDocument, checkSchemaSelf, CANONICAL_GATE_IDS, ARTIFACTS };
