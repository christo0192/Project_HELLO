#!/usr/bin/env node

/**
 * manifest.mjs — the Canary-0 sanitized manifest: builder, schema validator,
 * and tamper detector.
 *
 * ── WHY THIS IS A PARSER AND NOT A REDACTOR ───────────────────────────
 * A redactor is a blocklist: it strips the shapes somebody thought of. The
 * shapes nobody thought of survive, and the document still reads as
 * "sanitized" because a redactor ran over it. This lane has already paid for
 * that once — a viewer route that SELECTed a column the diff never showed.
 *
 * So the manifest carries no free-text field ANYWHERE. Every string in it is
 * either a member of a closed set or matches a stable-code grammar
 * (`^[a-z][a-z0-9_]*$`), and the validator rejects any key it was not told
 * about. A uuid, an E.164 number, a room name, an object key, a transcript
 * fragment, a bearer token and a provider event id are all UNREPRESENTABLE in
 * that grammar — there is nothing to strip because nothing else can be said.
 *
 * `LEAK_PATTERNS` below is therefore NOT the control. It is a second,
 * independent one, and it exists because a closed schema is only as closed as
 * its author's key list. If the two ever disagree the run fails.
 *
 * ── THE DIGEST IS OVER THE WHOLE DOCUMENT ─────────────────────────────
 * Including the totals. A tamper that edits a verdict and edits the totals to
 * match still moves the digest, because the digest covers both. It is not a
 * signature and must not be described as one: anybody holding this file can
 * recompute it. What it detects is EDITING, not forgery — a manifest that
 * travelled through a hand, a diff or a copy-paste and came out different.
 */

import { createHash } from 'node:crypto';

export const MANIFEST_SCHEMA = 'phone-canary-0/v1';

/** The grammars, shared with `canary0.sql` via PROTOCOL.md. */
export const PATTERNS = Object.freeze({
  scenario: /^[a-z][a-z0-9_]{2,63}$/,
  check: /^[a-z][a-z0-9_]{2,79}$/,
  code: /^[a-z][a-z0-9_]{0,63}$/,
  countKey: /^[a-z][a-z0-9_]{2,47}$/,
  sha256: /^[0-9a-f]{64}$/,
  gitSha: /^[0-9a-f]{40}$/,
  // Second-resolution UTC only. A sub-second timestamp would be a weak
  // fingerprint of when a particular machine ran; the manifest does not need
  // one and must not carry one.
  utc: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
});

export const STATUSES = Object.freeze(['pass', 'fail']);

/**
 * The independent leak scan. Every one of these has a POSITIVE CONTROL in
 * `canary0.test.mjs`: a fixture that trips it. A detector nobody has ever
 * seen fire is not a detector.
 */
export const LEAK_PATTERNS = Object.freeze([
  ['uuid', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  ['e164', /\+\d{7,15}/],
  ['digit_run', /\d{7,}/],
  ['bearer', /\b(?:bearer|token|secret|password|apikey|api_key)\b/i],
  ['object_key', /\.(?:ogg|json|wav|mp3|m4a)\b/i],
  ['url', /\b[a-z][a-z0-9+.-]*:\/\//i],
  ['email', /[^\s@]+@[^\s@]+\.[^\s@]+/],
  ['room_name', /\bphone-[0-9a-f-]{8,}/i],
]);

/** Deterministic serialization: keys sorted, no whitespace, no locale. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The digest covers the whole document EXCEPT the digest field itself. */
export function computeDigest(manifest) {
  const { digest: _ignored, ...rest } = manifest;
  return sha256(canonicalize(rest));
}

/**
 * Build the manifest from parsed protocol records.
 *
 * `records` is `{ verdicts: [{scenario, check, ok, code}], counts:
 * [{scenario, key, value}], scenarioCount }`. Nothing else from the SQL run
 * reaches this function, so nothing else can reach the file.
 */
export function buildManifest(records, meta) {
  const byScenario = new Map();
  const order = [];
  const touch = (name) => {
    if (!byScenario.has(name)) {
      byScenario.set(name, { name, status: 'pass', checks: [], counts: {} });
      order.push(name);
    }
    return byScenario.get(name);
  };

  for (const v of records.verdicts) {
    const s = touch(v.scenario);
    s.checks.push({ name: v.check, status: v.ok ? 'pass' : 'fail', code: v.code });
    if (!v.ok) s.status = 'fail';
  }
  for (const c of records.counts) touch(c.scenario).counts[c.key] = c.value;

  // Sorted, so two runs of the same suite produce byte-identical manifests
  // regardless of the order psql happened to return rows in.
  order.sort();
  const scenarios = order.map((name) => {
    const s = byScenario.get(name);
    s.checks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      name: s.name,
      status: s.status,
      checks_passed: s.checks.filter((c) => c.status === 'pass').length,
      checks_failed: s.checks.filter((c) => c.status === 'fail').length,
      checks: s.checks,
      counts: Object.fromEntries(Object.keys(s.counts).sort().map((k) => [k, s.counts[k]])),
    };
  });

  const checks = scenarios.reduce((n, s) => n + s.checks.length, 0);
  const checksPassed = scenarios.reduce((n, s) => n + s.checks_passed, 0);

  const manifest = {
    schema: MANIFEST_SCHEMA,
    generated_at_utc: meta.generatedAtUtc,
    git_sha: meta.gitSha,
    git_dirty: meta.gitDirty,
    suite_sha256: meta.suiteSha256,
    runner_sha256: meta.runnerSha256,
    zero_pstn: {
      sdk_importable: meta.zeroPstn.sdkImportable,
      network_calls: meta.zeroPstn.networkCalls,
      // 'fired' means the trap was deliberately tripped and DID report. A
      // zero above with this at 'not_fired' is a vacuous zero and the
      // validator rejects it.
      trap_positive_control: meta.zeroPstn.trapPositiveControl,
    },
    scenarios,
    totals: {
      // `scenarioCount` comes from the SQL's own CANARYDONE line, not from
      // counting what we parsed. If a scenario ran and emitted nothing, these
      // two disagree and the validator fails the run — a silent no-op
      // scenario is exactly the failure a manifest built from its own output
      // cannot otherwise see.
      scenarios_declared: records.scenarioCount,
      scenarios: scenarios.length,
      scenarios_passed: scenarios.filter((s) => s.status === 'pass').length,
      checks,
      checks_passed: checksPassed,
      checks_failed: checks - checksPassed,
    },
  };
  manifest.digest = computeDigest(manifest);
  return manifest;
}

// ── Validation ────────────────────────────────────────────────────────

class Fail {
  constructor() { this.errors = []; }
  add(code, where) { this.errors.push(where ? `${code} at ${where}` : code); }
}

function exactKeys(obj, keys, f, where) {
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  for (const k of actual) if (!expected.includes(k)) f.add(`unexpected_key:${k}`, where);
  for (const k of expected) if (!actual.includes(k)) f.add(`missing_key:${k}`, where);
}

function int(v, f, where) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1e9) {
    f.add('not_bounded_integer', where);
    return false;
  }
  return true;
}

function str(v, pattern, f, where) {
  if (typeof v !== 'string' || !pattern.test(v)) {
    f.add('not_matching_grammar', where);
    return false;
  }
  return true;
}

/**
 * The four fields whose OWN grammar is stricter than the leak scan.
 *
 * `git_sha`, `suite_sha256`, `runner_sha256` and `digest` are validated
 * against `^[0-9a-f]{40}$` / `^[0-9a-f]{64}$` before this runs, and a
 * fixed-length lowercase-hex string cannot express an E.164, a dashed uuid,
 * an email, a URL, an object key or a bearer word. What it CAN contain is a
 * run of seven digits, which is why `digit_run` fires on roughly one hash in
 * three and why exempting these four is a correction rather than a hole:
 * without it the scan reports a leak on every second honest run, and a
 * detector that cries wolf is one people learn to silence.
 *
 * The exemption is by EXACT PATH, never by shape. A new field does not
 * inherit it.
 */
export const HASH_FIELD_PATHS = Object.freeze([
  '$.git_sha', '$.suite_sha256', '$.runner_sha256', '$.digest',
]);

/** Walk every string in the document through the independent leak scan. */
export function scanForLeaks(value, f, path = '$') {
  if (HASH_FIELD_PATHS.includes(path)) return;
  if (typeof value === 'string') {
    for (const [name, re] of LEAK_PATTERNS) {
      if (re.test(value)) f.add(`leak:${name}`, path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForLeaks(v, f, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // Keys are part of the document too. A leak hidden in a key is a leak.
      for (const [name, re] of LEAK_PATTERNS) {
        if (re.test(k)) f.add(`leak_in_key:${name}`, `${path}.${k}`);
      }
      scanForLeaks(v, f, `${path}.${k}`);
    }
  }
}

/**
 * Validate a manifest. Returns `{ ok, errors }`. Fail-closed: an input that is
 * not an object, or that carries a key this validator was not told about, is
 * a failure and never a warning.
 */
export function validateManifest(input) {
  const f = new Fail();
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['not_an_object'] };
  }

  exactKeys(input, [
    'schema', 'generated_at_utc', 'git_sha', 'git_dirty', 'suite_sha256',
    'runner_sha256', 'zero_pstn', 'scenarios', 'totals', 'digest',
  ], f, '$');

  if (input.schema !== MANIFEST_SCHEMA) f.add('wrong_schema', '$.schema');
  str(input.generated_at_utc, PATTERNS.utc, f, '$.generated_at_utc');
  str(input.git_sha, PATTERNS.gitSha, f, '$.git_sha');
  if (typeof input.git_dirty !== 'boolean') f.add('not_boolean', '$.git_dirty');
  str(input.suite_sha256, PATTERNS.sha256, f, '$.suite_sha256');
  str(input.runner_sha256, PATTERNS.sha256, f, '$.runner_sha256');
  str(input.digest, PATTERNS.sha256, f, '$.digest');

  const z = input.zero_pstn;
  if (z === null || typeof z !== 'object' || Array.isArray(z)) {
    f.add('not_an_object', '$.zero_pstn');
  } else {
    exactKeys(z, ['sdk_importable', 'network_calls', 'trap_positive_control'], f, '$.zero_pstn');
    // THE ASSERTION, not a report. A manifest may not claim zero PSTN with
    // the SDK reachable or with a network call recorded.
    if (z.sdk_importable !== false) f.add('sdk_importable_must_be_false', '$.zero_pstn');
    if (z.network_calls !== 0) f.add('network_calls_must_be_zero', '$.zero_pstn');
    // And the zero must be a MEASURED zero. Without a trap that demonstrably
    // fires, `network_calls: 0` is what a broken counter also reports.
    if (z.trap_positive_control !== 'fired') {
      f.add('trap_positive_control_must_have_fired', '$.zero_pstn');
    }
  }

  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0) {
    f.add('scenarios_missing_or_empty', '$.scenarios');
  } else {
    let previous = '';
    input.scenarios.forEach((s, i) => {
      const at = `$.scenarios[${i}]`;
      if (s === null || typeof s !== 'object' || Array.isArray(s)) {
        f.add('not_an_object', at);
        return;
      }
      exactKeys(s, ['name', 'status', 'checks_passed', 'checks_failed', 'checks', 'counts'], f, at);
      str(s.name, PATTERNS.scenario, f, `${at}.name`);
      if (typeof s.name === 'string') {
        if (s.name <= previous) f.add('scenarios_not_sorted_or_duplicated', `${at}.name`);
        previous = s.name;
      }
      if (!STATUSES.includes(s.status)) f.add('bad_status', `${at}.status`);
      int(s.checks_passed, f, `${at}.checks_passed`);
      int(s.checks_failed, f, `${at}.checks_failed`);

      if (!Array.isArray(s.checks) || s.checks.length === 0) {
        // A scenario with no checks is a scenario that proved nothing while
        // reporting `pass`. That is the failure mode this whole file exists
        // to make impossible, so it is an error and not an empty list.
        f.add('scenario_has_no_checks', `${at}.checks`);
      } else {
        s.checks.forEach((c, j) => {
          const cat = `${at}.checks[${j}]`;
          if (c === null || typeof c !== 'object' || Array.isArray(c)) {
            f.add('not_an_object', cat);
            return;
          }
          exactKeys(c, ['name', 'status', 'code'], f, cat);
          str(c.name, PATTERNS.check, f, `${cat}.name`);
          if (!STATUSES.includes(c.status)) f.add('bad_status', `${cat}.status`);
          str(c.code, PATTERNS.code, f, `${cat}.code`);
        });
        const p = s.checks.filter((c) => c && c.status === 'pass').length;
        const q = s.checks.filter((c) => c && c.status === 'fail').length;
        if (p !== s.checks_passed) f.add('checks_passed_disagrees', `${at}.checks_passed`);
        if (q !== s.checks_failed) f.add('checks_failed_disagrees', `${at}.checks_failed`);
        const derived = q === 0 ? 'pass' : 'fail';
        if (s.status !== derived) f.add('scenario_status_disagrees', `${at}.status`);
      }

      if (s.counts === null || typeof s.counts !== 'object' || Array.isArray(s.counts)) {
        f.add('not_an_object', `${at}.counts`);
      } else {
        for (const [k, v] of Object.entries(s.counts)) {
          str(k, PATTERNS.countKey, f, `${at}.counts.${k}`);
          int(v, f, `${at}.counts.${k}`);
        }
      }
    });
  }

  const t = input.totals;
  if (t === null || typeof t !== 'object' || Array.isArray(t)) {
    f.add('not_an_object', '$.totals');
  } else {
    exactKeys(t, [
      'scenarios_declared', 'scenarios', 'scenarios_passed',
      'checks', 'checks_passed', 'checks_failed',
    ], f, '$.totals');
    for (const k of Object.keys(t)) int(t[k], f, `$.totals.${k}`);
    if (Array.isArray(input.scenarios)) {
      const n = input.scenarios.length;
      if (t.scenarios !== n) f.add('totals_scenarios_disagrees', '$.totals.scenarios');
      // The SQL's own declared count must equal what we parsed. A scenario
      // that ran and emitted nothing shows up exactly here.
      if (t.scenarios_declared !== n) f.add('declared_scenario_count_disagrees', '$.totals');
      const passed = input.scenarios.filter((s) => s && s.status === 'pass').length;
      if (t.scenarios_passed !== passed) f.add('totals_scenarios_passed_disagrees', '$.totals');
      const checks = input.scenarios.reduce(
        (acc, s) => acc + (Array.isArray(s?.checks) ? s.checks.length : 0), 0);
      const cp = input.scenarios.reduce(
        (acc, s) => acc + (Array.isArray(s?.checks)
          ? s.checks.filter((c) => c && c.status === 'pass').length : 0), 0);
      if (t.checks !== checks) f.add('totals_checks_disagrees', '$.totals.checks');
      if (t.checks_passed !== cp) f.add('totals_checks_passed_disagrees', '$.totals');
      if (t.checks_failed !== checks - cp) f.add('totals_checks_failed_disagrees', '$.totals');
    }
  }

  scanForLeaks(input, f);

  // Last, so a tamper report is not drowned by the shape errors it causes.
  if (typeof input.digest === 'string' && PATTERNS.sha256.test(input.digest)) {
    if (computeDigest(input) !== input.digest) f.add('digest_mismatch', '$.digest');
  }

  return { ok: f.errors.length === 0, errors: f.errors };
}

// ── Protocol parsing ──────────────────────────────────────────────────

/**
 * Parse `canary0.sql`'s stdout into records. **Fail-closed on anything that
 * is not a protocol line**, because a psql NOTICE, a stray `select` or a
 * PL/pgSQL error detail is exactly how an identifier would reach the file.
 */
export function parseProtocol(stdout) {
  const verdicts = [];
  const counts = [];
  const errors = [];
  let scenarioCount = null;

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    const parts = line.split('|');
    if (parts[0] === 'CANARY' && parts.length === 5) {
      const [, scenario, check, status, code] = parts;
      if (!PATTERNS.scenario.test(scenario)) { errors.push('bad_scenario_name'); continue; }
      if (!PATTERNS.check.test(check)) { errors.push('bad_check_name'); continue; }
      if (status !== 'PASS' && status !== 'FAIL') { errors.push('bad_status'); continue; }
      if (!PATTERNS.code.test(code)) { errors.push('bad_code'); continue; }
      verdicts.push({ scenario, check, ok: status === 'PASS', code });
    } else if (parts[0] === 'CANARYCOUNT' && parts.length === 4) {
      const [, scenario, key, value] = parts;
      if (!PATTERNS.scenario.test(scenario)) { errors.push('bad_scenario_name'); continue; }
      if (!PATTERNS.countKey.test(key)) { errors.push('bad_count_key'); continue; }
      if (!/^(0|[1-9][0-9]{0,8})$/.test(value)) { errors.push('bad_count_value'); continue; }
      counts.push({ scenario, key, value: Number(value) });
    } else if (parts[0] === 'CANARYDONE' && parts.length === 2) {
      if (!/^(0|[1-9][0-9]{0,8})$/.test(parts[1])) { errors.push('bad_done_count'); continue; }
      scenarioCount = Number(parts[1]);
    } else {
      // Deliberately NOT ignored. Unrecognised output means the suite said
      // something we do not understand, and "we did not understand it" is
      // not a reason to publish a manifest that omits it.
      errors.push('unrecognised_output_line');
    }
  }
  if (scenarioCount === null) errors.push('missing_canarydone');
  return { verdicts, counts, scenarioCount: scenarioCount ?? 0, errors };
}
