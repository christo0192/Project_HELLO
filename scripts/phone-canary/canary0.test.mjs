#!/usr/bin/env node

/**
 * canary0.test.mjs — the OFFLINE half of Canary-0's gate.
 *
 * No database, no Docker, no network. It tests the things that must hold even
 * when the substrate rehearsal cannot run: the manifest's schema and tamper
 * detection, the zero-PSTN traps, the halt drill's refusal state machine, and
 * the drift guards that keep the SQL, the migrations and this directory from
 * saying different things.
 *
 * ── EVERY CONTROL HERE HAS TO BE ABLE TO FAIL ─────────────────────────
 * A validator is exercised by feeding it a document it must REJECT, not only
 * one it must accept; a leak detector is exercised by tripping it; a network
 * trap is exercised by calling through it. Where a control's whole value is
 * "this never happens", the test constructs the happening. This lane has
 * already shipped a guard that exempted exactly the controls it protected and
 * a mutation that was green because it was mis-applied, so a mutation here is
 * asserted to have CHANGED the input before its effect is believed.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEAK_PATTERNS, MANIFEST_SCHEMA, PATTERNS, buildManifest, canonicalize,
  computeDigest, parseProtocol, sha256, validateManifest,
} from './manifest.mjs';
import { GUARDED_PRIMITIVES, NetworkAttempted, createNetGuard, sdkImportable } from './netguard.mjs';
import { CONTAINER_PATTERN, assertLocalOnly, psqlArgv } from './db.mjs';
import {
  DrillRefusal, HALT_REASONS, PRODUCTION_CONFIRMATION, parseArgs, readToken, say,
} from './halt-drill.mjs';
import { staticImportViolations } from './canary0.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { passed += 1; console.log(`PASS: ${name}`); }
  else { failures.push({ name, detail }); console.log(`FAIL: ${name} — ${detail ?? 'no detail'}`); }
}

function throws(name, fn, expectedCode) {
  try { fn(); ok(name, false, 'did not throw'); }
  catch (error) {
    ok(name, error instanceof DrillRefusal && error.code === expectedCode,
      `threw ${error?.code ?? error?.name} expected ${expectedCode}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
//  A reference manifest, built through the real builder
// ══════════════════════════════════════════════════════════════════════

const RECORDS = {
  verdicts: [
    { scenario: 'alpha_scenario', check: 'first_check', ok: true, code: 'ok' },
    { scenario: 'alpha_scenario', check: 'second_check', ok: true, code: 'expected_status' },
    { scenario: 'beta_scenario', check: 'only_check', ok: true, code: 'ok' },
  ],
  counts: [
    { scenario: 'alpha_scenario', key: 'questions_committed', value: 5 },
    { scenario: 'beta_scenario', key: 'no_answer_attempts', value: 0 },
  ],
  scenarioCount: 2,
};

const META = {
  generatedAtUtc: '2026-08-24T06:00:00Z',
  gitSha: 'a'.repeat(40),
  gitDirty: false,
  suiteSha256: 'b'.repeat(64),
  runnerSha256: 'c'.repeat(64),
  zeroPstn: { sdkImportable: false, networkCalls: 0, trapPositiveControl: 'fired' },
};

const REFERENCE = buildManifest(RECORDS, META);

const clone = (m) => JSON.parse(JSON.stringify(m));
const reseal = (m) => { m.digest = computeDigest(m); return m; };

// ══════════════════════════════════════════════════════════════════════
//  1. The manifest validates, and is deterministic
// ══════════════════════════════════════════════════════════════════════

{
  const v = validateManifest(REFERENCE);
  ok('MANIFEST_REFERENCE_VALIDATES', v.ok, v.errors.join('; '));
  ok('MANIFEST_SCHEMA_PINNED', REFERENCE.schema === MANIFEST_SCHEMA, REFERENCE.schema);

  const again = buildManifest(RECORDS, META);
  ok('MANIFEST_IS_DETERMINISTIC',
    JSON.stringify(again) === JSON.stringify(REFERENCE), 'two builds differ');

  // Order of the input must not change the output — otherwise two runs of the
  // same suite produce different digests and the digest means nothing.
  const shuffled = {
    verdicts: [...RECORDS.verdicts].reverse(),
    counts: [...RECORDS.counts].reverse(),
    scenarioCount: RECORDS.scenarioCount,
  };
  ok('MANIFEST_IGNORES_INPUT_ORDER',
    JSON.stringify(buildManifest(shuffled, META)) === JSON.stringify(REFERENCE),
    'row order changed the manifest');

  ok('CANONICALIZE_SORTS_KEYS',
    canonicalize({ b: 1, a: 2 }) === '{"a":2,"b":1}', canonicalize({ b: 1, a: 2 }));
  ok('SHA256_IS_SHA256',
    sha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
}

// ══════════════════════════════════════════════════════════════════════
//  2. Tamper detection — the digest covers the WHOLE document
// ══════════════════════════════════════════════════════════════════════

const TAMPERS = [
  ['flip a failing check to passing', (m) => { m.scenarios[0].checks[0].status = 'fail'; }],
  ['edit a count', (m) => { m.scenarios[0].counts.questions_committed = 99; }],
  ['edit the totals', (m) => { m.totals.checks_passed = 999; }],
  ['edit the git sha', (m) => { m.git_sha = 'd'.repeat(40); }],
  ['edit the suite hash', (m) => { m.suite_sha256 = 'e'.repeat(64); }],
  ['edit the timestamp', (m) => { m.generated_at_utc = '2020-01-01T00:00:00Z'; }],
  ['edit the zero-PSTN block', (m) => { m.zero_pstn.trap_positive_control = 'not_fired'; }],
  ['drop a scenario', (m) => { m.scenarios.pop(); }],
];

for (const [label, mutate] of TAMPERS) {
  const m = clone(REFERENCE);
  const before = JSON.stringify(m);
  mutate(m);
  // The mutation must actually have landed. A no-op mutation that "passes"
  // the tamper check is the false green this project has already paid for.
  if (JSON.stringify(m) === before) {
    ok(`TAMPER_MUTATION_APPLIED[${label}]`, false, 'mutation was a no-op');
  } else {
    ok(`TAMPER_MUTATION_APPLIED[${label}]`, true);
    const v = validateManifest(m);
    ok(`TAMPER_DETECTED[${label}]`, !v.ok && v.errors.some((e) => e.startsWith('digest_mismatch')),
      v.errors.join('; '));
  }
}

{
  // Re-sealing after a tamper defeats the digest — and MUST still be caught,
  // by the internal-consistency checks. The digest detects editing; the
  // consistency checks detect lying. Neither alone is enough.
  const m = reseal((() => { const x = clone(REFERENCE); x.scenarios[0].checks[0].status = 'fail'; return x; })());
  const v = validateManifest(m);
  ok('RESEALED_TAMPER_CAUGHT_BY_CONSISTENCY', !v.ok
    && v.errors.some((e) => e.includes('checks_passed_disagrees'))
    && v.errors.some((e) => e.includes('scenario_status_disagrees')),
    v.errors.join('; '));

  // And a fully self-consistent lie about the SQL's own scenario count is
  // caught by `scenarios_declared`, which comes from CANARYDONE.
  const n = clone(REFERENCE);
  n.scenarios.pop();
  n.totals.scenarios = n.scenarios.length;
  n.totals.scenarios_passed = n.scenarios.length;
  n.totals.checks = n.scenarios.reduce((a, s) => a + s.checks.length, 0);
  n.totals.checks_passed = n.totals.checks;
  n.totals.checks_failed = 0;
  reseal(n);
  const nv = validateManifest(n);
  ok('DROPPED_SCENARIO_CAUGHT_BY_DECLARED_COUNT',
    !nv.ok && nv.errors.some((e) => e.includes('declared_scenario_count_disagrees')),
    nv.errors.join('; '));
}

// ══════════════════════════════════════════════════════════════════════
//  3. Schema rejections — closed keys, grammars, and the zero-PSTN assertions
// ══════════════════════════════════════════════════════════════════════

const REJECTIONS = [
  ['unknown top-level key', (m) => { m.extra = 'x'; }, 'unexpected_key:extra'],
  ['missing key', (m) => { delete m.git_dirty; }, 'missing_key:git_dirty'],
  ['wrong schema', (m) => { m.schema = 'other/v1'; }, 'wrong_schema'],
  ['sub-second timestamp', (m) => { m.generated_at_utc = '2026-08-24T06:00:00.123Z'; },
    'not_matching_grammar'],
  ['short git sha', (m) => { m.git_sha = 'abc'; }, 'not_matching_grammar'],
  ['non-boolean dirty flag', (m) => { m.git_dirty = 'no'; }, 'not_boolean'],
  ['sdk importable', (m) => { m.zero_pstn.sdk_importable = true; }, 'sdk_importable_must_be_false'],
  ['a network call', (m) => { m.zero_pstn.network_calls = 1; }, 'network_calls_must_be_zero'],
  ['unfired trap', (m) => { m.zero_pstn.trap_positive_control = 'not_fired'; },
    'trap_positive_control_must_have_fired'],
  ['a scenario with no checks', (m) => {
    m.scenarios[1].checks = []; m.scenarios[1].checks_passed = 0; m.scenarios[1].checks_failed = 0;
  }, 'scenario_has_no_checks'],
  ['a check with a free-text code', (m) => { m.scenarios[0].checks[0].code = 'Got 3 rows!'; },
    'not_matching_grammar'],
  ['a scenario name outside the grammar', (m) => { m.scenarios[0].name = 'Alpha Scenario'; },
    'not_matching_grammar'],
  ['a count key outside the grammar', (m) => { m.scenarios[0].counts['Bad Key'] = 1; },
    'not_matching_grammar'],
  ['a negative count', (m) => { m.scenarios[0].counts.questions_committed = -1; },
    'not_bounded_integer'],
  ['unsorted scenarios', (m) => { m.scenarios.reverse(); },
    'scenarios_not_sorted_or_duplicated'],
  ['no scenarios at all', (m) => { m.scenarios = []; }, 'scenarios_missing_or_empty'],
];

for (const [label, mutate, expected] of REJECTIONS) {
  const m = clone(REFERENCE);
  const before = JSON.stringify(m);
  mutate(m);
  if (JSON.stringify(m) === before) {
    ok(`REJECT_MUTATION_APPLIED[${label}]`, false, 'mutation was a no-op');
    continue;
  }
  reseal(m); // seal it, so the failure we observe is the SCHEMA one we named
  const v = validateManifest(m);
  ok(`REJECT[${label}]`, !v.ok && v.errors.some((e) => e.startsWith(expected)),
    `expected ${expected}, got ${v.errors.join('; ')}`);
}

ok('REJECT_NON_OBJECT', validateManifest(null).ok === false && validateManifest([]).ok === false);

// ══════════════════════════════════════════════════════════════════════
//  4. Leak scan — every pattern has a positive control
// ══════════════════════════════════════════════════════════════════════

const LEAK_FIXTURES = {
  uuid: '0f1e2d3c-4b5a-6978-8765-43210fedcba9',
  e164: '+919876543210',
  digit_run: '9876543',
  bearer: 'secret',
  object_key: 'recording.ogg',
  url: 'https://example.test/x',
  email: 'someone@example.test',
  room_name: 'phone-0f1e2d3c',
};

for (const [name] of LEAK_PATTERNS) {
  const fixture = LEAK_FIXTURES[name];
  if (fixture === undefined) {
    ok(`LEAK_POSITIVE_CONTROL[${name}]`, false, 'no fixture: an untested detector');
    continue;
  }
  // Injected as a check CODE, which is where a careless `raise notice` value
  // would actually land.
  const m = clone(REFERENCE);
  m.scenarios[0].checks[0].code = fixture;
  reseal(m);
  const v = validateManifest(m);
  ok(`LEAK_POSITIVE_CONTROL[${name}]`, !v.ok && v.errors.some((e) => e.startsWith('leak:')),
    `${fixture} was not detected: ${v.errors.join('; ')}`);
}

{
  // A leak hidden in a KEY, not a value.
  const m = clone(REFERENCE);
  m.scenarios[0].counts.attempt_9876543 = 1;
  reseal(m);
  const v = validateManifest(m);
  ok('LEAK_IN_KEY_IS_A_LEAK', !v.ok, v.errors.join('; '));

  // The hash exemption is by EXACT PATH. A leak parked one level down from an
  // exempt field, or in a NEW top-level field, must still be caught.
  const w = clone(REFERENCE);
  w.scenarios[0].checks[0].code = 'a'.repeat(64);
  reseal(w);
  ok('HASH_EXEMPTION_DOES_NOT_APPLY_TO_A_CHECK_CODE',
    validateManifest(w).ok, 'a 64-hex code should still satisfy the code grammar');
  const y = clone(REFERENCE);
  y.scenarios[0].checks[0].code = '9876543210';
  reseal(y);
  ok('HASH_EXEMPTION_DOES_NOT_LEAK_INTO_SCENARIOS',
    !validateManifest(y).ok, 'a digit run in a check code was not caught');

  // And the reference itself must be clean, or every control above is
  // measuring a document that already leaks.
  const baseline = validateManifest(REFERENCE);
  ok('REFERENCE_HAS_NO_LEAKS',
    baseline.ok && !baseline.errors.some((e) => e.startsWith('leak')), baseline.errors.join('; '));
}

// ══════════════════════════════════════════════════════════════════════
//  5. Protocol parsing is fail-closed
// ══════════════════════════════════════════════════════════════════════

{
  const good = [
    'CANARY|alpha_scenario|first_check|PASS|ok',
    'CANARYCOUNT|alpha_scenario|questions_committed|5',
    'CANARYDONE|1',
  ].join('\n');
  const p = parseProtocol(good);
  ok('PROTOCOL_PARSES_GOOD_OUTPUT',
    p.errors.length === 0 && p.verdicts.length === 1 && p.counts.length === 1
    && p.scenarioCount === 1, p.errors.join('; '));

  const cases = [
    ['a psql NOTICE', 'NOTICE:  engagement 0f1e2d3c-4b5a-6978-8765-43210fedcba9 admitted'],
    ['a bare select result', '+919876543210'],
    ['a free-text code', 'CANARY|alpha_scenario|first_check|PASS|Got 3 rows'],
    ['a bad status word', 'CANARY|alpha_scenario|first_check|MAYBE|ok'],
    ['a uuid as a scenario name', 'CANARY|0f1e2d3c-4b5a|first_check|PASS|ok'],
    ['a non-numeric count', 'CANARYCOUNT|alpha_scenario|questions_committed|many'],
  ];
  for (const [label, line] of cases) {
    const r = parseProtocol([line, 'CANARYDONE|1'].join('\n'));
    ok(`PROTOCOL_REJECTS[${label}]`, r.errors.length > 0, 'accepted silently');
  }
  ok('PROTOCOL_REQUIRES_CANARYDONE',
    parseProtocol('CANARY|alpha_scenario|first_check|PASS|ok').errors.includes('missing_canarydone'));

  // A run that emitted NOTHING must not parse as a clean, empty success.
  ok('PROTOCOL_REJECTS_SILENCE', parseProtocol('').errors.length > 0);
}

// ══════════════════════════════════════════════════════════════════════
//  6. The zero-PSTN runtime traps
// ══════════════════════════════════════════════════════════════════════

{
  const guard = createNetGuard();
  try {
    ok('NETGUARD_ARMS_EVERY_PRIMITIVE',
      guard.armed.length === GUARDED_PRIMITIVES.length,
      `armed ${guard.armed.join(',')} of ${GUARDED_PRIMITIVES.join(',')}`);
    ok('NETGUARD_MEASURED_WINDOW_STARTS_AT_ZERO', guard.measuredCalls() === 0);

    // The measured window must actually be able to count. Without this, the
    // zero the manifest publishes is indistinguishable from a dead counter.
    let threw = null;
    try { globalThis.fetch('http://127.0.0.1:1/'); } catch (e) { threw = e; }
    ok('NETGUARD_MEASURED_WINDOW_COUNTS_AND_THROWS',
      threw instanceof NetworkAttempted && guard.measuredCalls() === 1,
      `measured=${guard.measuredCalls()}`);

    const verdict = guard.runPositiveControl();
    ok('NETGUARD_POSITIVE_CONTROL_FIRES', verdict === 'fired', verdict);
    ok('NETGUARD_CONTROL_COUNTED_EVERY_PRIMITIVE',
      guard.controlCalls() === guard.armed.length,
      `${guard.controlCalls()} of ${guard.armed.length}`);
    ok('NETGUARD_CONTROL_DOES_NOT_POLLUTE_MEASURED', guard.measuredCalls() === 1);
  } finally {
    guard.dispose();
  }
  // Disposal must restore the real primitives, or this test file poisons
  // everything that runs after it in the same process.
  ok('NETGUARD_DISPOSE_RESTORES', typeof globalThis.fetch === 'function'
    && !String(globalThis.fetch).includes('NetworkAttempted'));
}

{
  // A DISARMED guard must report `not_fired`, not `fired`. This is the
  // control on the control.
  const guard = createNetGuard();
  const stolen = globalThis.fetch;
  globalThis.fetch = () => undefined; // silently swallow one primitive
  const verdict = guard.runPositiveControl();
  globalThis.fetch = stolen;
  guard.dispose();
  ok('NETGUARD_REPORTS_NOT_FIRED_WHEN_A_TRAP_IS_DISARMED', verdict === 'not_fired', verdict);
}

// ══════════════════════════════════════════════════════════════════════
//  7. Structural: the SDK is unreachable and nothing imports the network
// ══════════════════════════════════════════════════════════════════════

{
  const importable = await sdkImportable();
  ok('TELEPHONY_SDK_IS_NOT_RESOLVABLE_FROM_HERE', importable === false,
    'livekit-server-sdk resolves from scripts/phone-canary');

  const FILES = ['db.mjs', 'exec.mjs', 'netguard.mjs', 'manifest.mjs', 'canary0.mjs',
    'halt-drill.mjs'];
  const sources = FILES.map((name) => ({
    name, source: readFileSync(path.join(HERE, name), 'utf8'),
  }));
  const violations = staticImportViolations(sources);
  ok('NO_FORBIDDEN_IMPORTS', violations.length === 0, violations.join(', '));

  // The scanner has to be able to see one. Otherwise the clean result above
  // is a scanner that found nothing because it looks at nothing.
  const seeded = staticImportViolations([
    { name: 'manifest.mjs', source: "import https from 'node:https';" },
    { name: 'canary0.mjs', source: "const x = require('livekit-server-sdk');" },
    // `db.mjs` used to be the exception; it is now `exec.mjs`, and the scanner
    // must have MOVED the permission rather than gained a second one.
    { name: 'db.mjs', source: "import { spawn } from 'node:child_process';" },
  ]);
  ok('IMPORT_SCANNER_POSITIVE_CONTROL', seeded.length === 3, seeded.join(', '));

  // And it must NOT flag the two files whose imports are deliberate.
  ok('IMPORT_SCANNER_ALLOWS_THE_TWO_EXCEPTIONS', staticImportViolations([
    { name: 'exec.mjs', source: "import { spawn } from 'node:child_process';" },
    { name: 'netguard.mjs', source: "import https from 'node:https';" },
  ]).length === 0);

  // The single production-transport call site in the drill.
  const drill = sources.find((s) => s.name === 'halt-drill.mjs').source;
  const fetchSites = [...drill.matchAll(/\bfetch\s*\(/g)].length;
  ok('HALT_DRILL_HAS_EXACTLY_ONE_NETWORK_CALL_SITE', fetchSites === 1, `${fetchSites} sites`);

  // Rule 2 of the drill, asserted rather than merely written down: there is
  // no `finally` anywhere in it, so a clear can never run as cleanup.
  ok('HALT_DRILL_HAS_NO_FINALLY_BLOCK', !/\bfinally\b/.test(drill.replace(/^\s*\*.*$/gm, '')),
    'a finally block appeared in the halt drill');

  // And no code path raises and lowers in one invocation.
  ok('HALT_DRILL_NEVER_CLEARS_INSIDE_HALT',
    !/runHalt[\s\S]*?clear_phone_halt[\s\S]*?function runClear/.test(drill),
    'the halt path references clear_phone_halt');
}

// ══════════════════════════════════════════════════════════════════════
//  8. db.mjs refuses a non-local target
// ══════════════════════════════════════════════════════════════════════

{
  ok('PSQL_ARGV_IS_LOCAL', psqlArgv('supabase_db_x').includes('exec'));
  for (const bad of [
    ['-h', 'db.example.test'], ['--host=db.example.test'], ['-p', '5432'],
    ['postgres://user@host/db'], ['postgresql://host/db'],
  ]) {
    let refused = false;
    try { assertLocalOnly(bad); } catch { refused = true; }
    ok(`DB_REFUSES_NON_LOCAL[${bad.join(' ')}]`, refused, 'accepted');
  }
  ok('DB_ACCEPTS_THE_LOCAL_ARGV',
    assertLocalOnly(['exec', '-i', 'c', 'psql', '-U', 'postgres']).length === 6);
  for (const bad of ['', 'a b', 'x;rm -rf /', '$(whoami)', 'a'.repeat(200)]) {
    ok(`CONTAINER_NAME_REFUSED[${JSON.stringify(bad)}]`, !CONTAINER_PATTERN.test(bad), 'accepted');
  }
  ok('CONTAINER_NAME_ACCEPTED', CONTAINER_PATTERN.test('supabase_db_screening-bot-local'));
}

// ══════════════════════════════════════════════════════════════════════
//  9. The halt drill's refusal state machine
// ══════════════════════════════════════════════════════════════════════

{
  throws('DRILL_REFUSES_NO_SUBCOMMAND', () => parseArgs([]), 'subcommand_required');
  throws('DRILL_REFUSES_UNKNOWN_SUBCOMMAND', () => parseArgs(['stop']), 'unknown_subcommand');
  throws('DRILL_REFUSES_UNKNOWN_ARGUMENT', () => parseArgs(['probe', '--force']), 'unknown_argument');

  // Rule 3 — credentials never in argv.
  for (const flag of ['--token', '--password', '--secret']) {
    throws(`DRILL_REFUSES_CREDENTIAL_IN_ARGV[${flag}]`,
      () => parseArgs(['halt', flag, 'sekrit']), 'credential_in_argv_refused');
  }

  throws('DRILL_HALT_REQUIRES_A_REASON', () => parseArgs(['halt']), 'reason_required');
  throws('DRILL_HALT_REFUSES_AN_UNKNOWN_REASON',
    () => parseArgs(['halt', '--reason', 'because']), 'unknown_reason');
  throws('DRILL_HALT_REQUIRES_THE_PRECONDITION',
    () => parseArgs(['halt', '--reason', 'operator_pause']), 'expect_halted_required');
  throws('DRILL_CLEAR_REQUIRES_THE_REASON_IN_FORCE',
    () => parseArgs(['clear']), 'expect_reason_required');
  throws('DRILL_PROBE_IS_READ_ONLY',
    () => parseArgs(['probe', '--execute']), 'probe_is_read_only');
  throws('DRILL_REFUSES_UNKNOWN_TARGET',
    () => parseArgs(['probe', '--target', 'staging']), 'unknown_target');

  // Production needs all three, and each one alone is refused.
  const prodBase = ['halt', '--target', 'production', '--reason', 'emergency_stop',
    '--expect-halted', 'false'];
  throws('DRILL_PRODUCTION_REQUIRES_EXECUTE', () => parseArgs(prodBase),
    'production_requires_execute');
  throws('DRILL_PRODUCTION_REQUIRES_CONFIRMATION',
    () => parseArgs([...prodBase, '--execute']), 'production_confirmation_required');
  throws('DRILL_PRODUCTION_REJECTS_A_NEAR_MISS_CONFIRMATION',
    () => parseArgs([...prodBase, '--execute', '--confirm', 'stop the phone dialer']),
    'production_confirmation_required');
  throws('DRILL_PRODUCTION_REQUIRES_AN_API_BASE',
    () => parseArgs([...prodBase, '--execute', '--confirm', PRODUCTION_CONFIRMATION,
      '--api-base', 'http://insecure.test']), 'api_base_required');

  const full = parseArgs([...prodBase, '--execute', '--confirm', PRODUCTION_CONFIRMATION,
    '--api-base', 'https://api.example.test']);
  ok('DRILL_PRODUCTION_ACCEPTS_THE_COMPLETE_INVOCATION',
    full.target === 'production' && full.execute === true && full.reason === 'emergency_stop');

  // Rule 1 — the defaults do nothing.
  const defaults = parseArgs(['halt', '--reason', 'operator_pause', '--expect-halted', 'false']);
  ok('DRILL_DEFAULTS_TO_LOCAL_AND_DRY_RUN',
    defaults.target === 'local' && defaults.execute === false);
  ok('DRILL_PROBE_DEFAULTS_TO_LOCAL', parseArgs(['probe']).target === 'local');

  // Token sourcing.
  ok('DRILL_TOKEN_FROM_STDIN', readToken({}, '  tok  \n') === 'tok');
  ok('DRILL_TOKEN_FROM_ENV', readToken({ PHONE_HALT_ADMIN_TOKEN: 'tok' }, '') === 'tok');
  ok('DRILL_TOKEN_STDIN_WINS',
    readToken({ PHONE_HALT_ADMIN_TOKEN: 'env' }, 'stdin') === 'stdin');
  throws('DRILL_REFUSES_WITHOUT_A_TOKEN', () => readToken({}, '   '), 'admin_token_required');
}

// ══════════════════════════════════════════════════════════════════════
// 10. The drill prints nothing identifying
// ══════════════════════════════════════════════════════════════════════

{
  const written = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  const rendered = [
    say('a', true), say('b', 7), say('c', 'stable_code'),
    say('d', '0f1e2d3c-4b5a-6978-8765-43210fedcba9'),
    say('e', '+919876543210'),
    say('f', 'Bearer abcdef'),
    say('g', -1), say('h', 1.5), say('i', { secret: 1 }), say('j', null),
  ];
  process.stdout.write = original;

  ok('SAY_PRINTS_A_BOOLEAN', rendered[0] === 'true');
  ok('SAY_PRINTS_A_COUNT', rendered[1] === '7');
  ok('SAY_PRINTS_A_STABLE_CODE', rendered[2] === 'stable_code');
  for (const i of [3, 4, 5, 6, 7, 8, 9]) {
    ok(`SAY_REFUSES_TO_PRINT_INDEX_${i}`, rendered[i] === 'unprintable', rendered[i]);
  }
  const all = written.join('');
  ok('DRILL_OUTPUT_CARRIES_NO_LEAK',
    !LEAK_PATTERNS.some(([, re]) => re.test(all)), all);
}

// ══════════════════════════════════════════════════════════════════════
// 11. Drift guards — this directory must agree with the migrations
// ══════════════════════════════════════════════════════════════════════

{
  const migration = readFileSync(
    path.join(REPO, 'app/supabase/migrations/0042_phone_screening.sql'), 'utf8');
  const anchor = 'chk_phone_control_reason';
  const at = migration.indexOf(anchor);
  ok('HALT_REASON_ANCHOR_FOUND', at !== -1, 'chk_phone_control_reason missing from 0042');
  if (at !== -1) {
    const open = migration.indexOf(' in (', at);
    const close = migration.indexOf(')', open + 5);
    const members = [...migration.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    ok('HALT_REASON_LIST_IS_NOT_EMPTY', members.length > 0, 'extractor read nothing');
    ok('HALT_REASONS_MATCH_THE_MIGRATION',
      JSON.stringify([...members].sort()) === JSON.stringify([...HALT_REASONS].sort()),
      `migration=${members.join(',')} drill=${HALT_REASONS.join(',')}`);
  }

  // PROTOCOL.md is the contract `canary0.sql` is written against. If it and
  // `manifest.mjs` drift, the SQL is written against a grammar the runner
  // does not enforce.
  const protocolDoc = readFileSync(path.join(HERE, 'PROTOCOL.md'), 'utf8');
  for (const [name, pattern] of [
    ['scenario', PATTERNS.scenario], ['check', PATTERNS.check],
    ['code', PATTERNS.code], ['key', PATTERNS.countKey],
  ]) {
    ok(`PROTOCOL_DOC_PINS[${name}]`, protocolDoc.includes(pattern.source),
      `${pattern.source} is not written down in PROTOCOL.md`);
  }

  // The SQL suite must exist and must speak the protocol.
  const suite = readFileSync(path.join(HERE, 'canary0.sql'), 'utf8');
  ok('SUITE_EMITS_THE_PROTOCOL', suite.includes('CANARY|') && suite.includes('CANARYDONE|'),
    'canary0.sql does not emit protocol lines');
  ok('SUITE_NEVER_CALLS_NOW',
    !/[^_a-z]now\(\)/.test(suite.replace(/--[^\n]*/g, '')),
    'canary0.sql calls now(); every instant must be an explicit p_now');
}

// ══════════════════════════════════════════════════════════════════════
// 12. The ADR's blast-radius claim must stay true, in BOTH directions
// ══════════════════════════════════════════════════════════════════════

/**
 * ADR-0013 originally said P8B "is scripts, tests and documentation only". It
 * is not: it also refactors `app/voice-livekit/agent.py`, which is production
 * worker runtime. The claim was defensible about BEHAVIOUR and false about
 * BLAST RADIUS, and an auditor reading it would not have gone looking for the
 * runtime file. An independent review caught it.
 *
 * A prose correction rots. This guard is deliberately TWO-SIDED, because each
 * side alone would decay into a different lie:
 *
 *   * if the ADR stops naming `agent.py`, the false-blast-radius state returns;
 *   * if `agent.py` stops carrying the seam the ADR describes, the ADR is
 *     describing a refactor that is no longer there.
 *
 * A one-sided grep would pass happily through the second case, which is the
 * one a later revert actually produces.
 */
{
  const adrPath = path.join(REPO, 'docs/adr/0013-phone-screening-runtime.md');
  const adr = readFileSync(adrPath, 'utf8');

  // Extract the section, and FAIL if the anchor is missing rather than
  // asserting over an empty string — a renamed heading must not make every
  // assertion below pass vacuously.
  const start = adr.indexOf('**Blast radius.**');
  const end = adr.indexOf('## Evidence');
  ok('ADR_BLAST_RADIUS_SECTION_EXISTS', start !== -1 && end > start,
    'the Blast radius paragraph is missing or moved after Evidence');
  const blast = start !== -1 && end > start ? adr.slice(start, end) : '';

  ok('ADR_NAMES_THE_PRODUCTION_RUNTIME_EDIT',
    blast.includes('app/voice-livekit/agent.py'),
    'ADR-0013 no longer names the production runtime file P8B edits');
  ok('ADR_NAMES_THE_SEAM_IT_CLAIMS',
    blast.includes('_await_candidate_activity') && blast.includes('wait_for_activity'),
    'ADR-0013 describes the refactor without naming the seam');

  // The retired claim, pinned as retired. Cheap, and it is the exact sentence
  // the review flagged.
  ok('ADR_DROPPED_THE_DOCS_ONLY_CLAIM',
    !/scripts,? tests,? and documentation only/.test(adr),
    'the inaccurate "scripts, tests and documentation only" claim is back');

  // ── The other direction: the seam must actually be there ──────────────
  const agent = readFileSync(path.join(REPO, 'app/voice-livekit/agent.py'), 'utf8');
  ok('AGENT_CARRIES_THE_EXTRACTED_SEAM',
    /async def _await_candidate_activity\(/.test(agent),
    'agent.py no longer defines the seam ADR-0013 describes');
  // Defaulted, and defaulted TO the production helper — that default is the
  // whole basis of the "behaviour-preserving" claim, so it is what gets pinned
  // rather than the parameter's mere presence.
  ok('AGENT_SEAM_IS_OPTIONAL_AND_DEFAULTS_TO_PRODUCTION',
    /wait_for_activity: [^\n]*\| None = None/.test(agent)
    && /wait_for_activity if wait_for_activity is not None else _await_candidate_activity/
      .test(agent),
    'the silence loop no longer defaults to the production wait — the ADR\'s '
    + 'behaviour-preserving claim would be false');
}

// ══════════════════════════════════════════════════════════════════════

console.log('');
if (failures.length > 0) {
  console.log(`phone-canary offline gate: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail ?? ''}`);
  process.exitCode = 1;
} else {
  console.log(`phone-canary offline gate: ${passed} passed, 0 failed`);
}
