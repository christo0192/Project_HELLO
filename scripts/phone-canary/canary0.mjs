#!/usr/bin/env node

/**
 * canary0.mjs — Canary-0: the no-PSTN rehearsal of the phone screening lane.
 *
 * WHAT THIS IS
 *   A deterministic, executable rehearsal of every phone screening outcome
 *   against a REAL local Postgres carrying `0001..0045`, driven entirely by
 *   synthetic ingress events. It is the closest thing to a real call that can
 *   exist without a carrier, a number, or a person.
 *
 * WHAT THIS IS NOT
 *   It is NOT Canary-1. Canary-1 is the owner calling their own number over a
 *   real trunk, and it is documented in `docs/adr/0013-phone-screening-runtime.md`
 *   and `docs/runbooks/phone-canary-and-halt.md` and deliberately NOT
 *   implemented here — see the ADR's "Canary-1" section for the Legal/DLT
 *   gates that stand in front of it. Nothing in this directory can place a
 *   call: `netguard.mjs` documents the three independent reasons why.
 *
 * USAGE
 *   node scripts/phone-canary/canary0.mjs [--container NAME] [--out FILE]
 *                                         [--print] [--no-race]
 *
 *   Exit 0 only when every scenario passed, the manifest validated, and the
 *   measured network-call count was zero with the trap positive control
 *   confirmed firing. Anything else exits non-zero.
 *
 * REQUIRES a running local Postgres container with the migrations applied.
 * It REFUSES to run without one rather than reporting a vacuous success —
 * "no database" and "everything passed" must never look the same.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitState } from './exec.mjs';
import { createNetGuard, sdkImportable } from './netguard.mjs';
import {
  DEFAULT_CONTAINER, containerRunning, dockerAvailable, openSession, queryScalar,
  runSql, waitUntil,
} from './db.mjs';
import { buildManifest, parseProtocol, sha256, validateManifest } from './manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const FIXTURES = path.join(HERE, 'fixtures.sql');
const SUITE = path.join(HERE, 'canary0.sql');
const TEARDOWN = path.join(HERE, 'teardown.sql');

/**
 * The race's own phone-line suffix. `phone_suppressions` is unique on the
 * DIGEST of the line, so two live fixtures sharing a number would let one
 * scenario's opt-out suppress another's candidate. `canary0.sql` owns
 * 10001..90001; the race owns this one and nothing else may use it.
 */
const RACE_LINE_SUFFIX = '99001';

// ── argv ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { container: process.env.PHONE_CANARY_CONTAINER ?? DEFAULT_CONTAINER,
    outFile: null, print: false, race: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--container') { out.container = argv[++i]; }
    else if (a.startsWith('--container=')) { out.container = a.slice(12); }
    else if (a === '--out') { out.outFile = argv[++i]; }
    else if (a.startsWith('--out=')) { out.outFile = a.slice(6); }
    else if (a === '--print') { out.print = true; }
    else if (a === '--no-race') { out.race = false; }
    else throw new Error(`phone-canary: unknown argument ${a}`);
  }
  if (out.container === undefined || out.container === null || out.container === '') {
    throw new Error('phone-canary: --container needs a value');
  }
  return out;
}

// ── the halt race ─────────────────────────────────────────────────────

/**
 * The one scenario SQL cannot express, because it needs two sessions
 * contending at the same instant.
 *
 * The race that matters is NOT "is a halted lane refused" — `canary0.sql`
 * proves that single-handed. It is: **a halt raised while an admission is
 * already inside the door must still stop that admission.**
 *
 * `admit_phone_attempt` takes `pg_advisory_xact_lock(hashtext('phone_admission'))`
 * FIRST and reads `phone_control` after it. So:
 *
 *   blocker  takes the advisory lock and holds it
 *   admitter calls admit_phone_attempt and BLOCKS on that lock
 *   halter   raises the halt and commits          <- lands mid-admission
 *   blocker  commits, releasing the lock
 *   admitter proceeds, reads the control row, and must answer `halted`
 *
 * Determinism comes from `pg_stat_activity`, not from sleeping: the halt is
 * only raised once the admitter is OBSERVED waiting on a Lock. If the
 * admitter never waits, the RPC did not take the lock the ordering depends
 * on, and the wait times out and fails the run — which is the point. A test
 * that slept instead would pass on a lock that was never taken.
 */
async function runHaltRace(container) {
  const scenario = 'halt_race';
  const verdicts = [];
  const counts = [];
  const check = (name, ok, code) => verdicts.push({ scenario, check: name, ok, code });

  const tag = 'canary0-race';
  const blocker = openSession(container, { appName: 'canary0-blocker' });
  const admitter = openSession(container, { appName: 'canary0-admitter' });
  let engagement = null;
  try {
    engagement = queryScalar(container,
      `select _phone_canary.fixture('${tag}', '${RACE_LINE_SUFFIX}')::text;`);
    if (!/^[0-9a-f-]{36}$/.test(engagement)) {
      check('fixture_created', false, 'fixture_unreadable');
      return { verdicts, counts };
    }
    check('fixture_created', true, 'ok');

    // The instant every session uses. 2026-10-19 is a Monday; 06:00Z = 11:30 IST.
    const now = "'2026-10-19T06:00:00Z'::timestamptz";

    // Make sure nothing is halted going in, or the race proves nothing.
    queryScalar(container, `select screening_v2.clear_phone_halt(null, ${now})->>'status';`);

    blocker.send('begin;');
    blocker.send("select pg_advisory_xact_lock(hashtext('phone_admission'));");
    const blockerHolds = await waitUntil(container,
      `select exists (select 1 from pg_stat_activity
         where application_name = 'canary0-blocker' and state = 'idle in transaction');`,
      { timeoutMs: 30_000 });
    check('blocker_holds_admission_lock', blockerHolds,
      blockerHolds ? 'ok' : 'blocker_never_took_the_lock');
    if (!blockerHolds) return { verdicts, counts };

    admitter.send(
      `select 'RACE=' || (screening_v2.admit_phone_attempt(`
      + `'${engagement}'::uuid, 'initial', 'canary0-race', 180, ${now})->>'status');`);

    // THE determinism. Not a sleep.
    const admitterWaits = await waitUntil(container,
      `select exists (select 1 from pg_stat_activity
         where application_name = 'canary0-admitter' and wait_event_type = 'Lock');`,
      { timeoutMs: 30_000 });
    check('admission_blocks_on_the_advisory_lock', admitterWaits,
      admitterWaits ? 'ok' : 'admission_did_not_take_the_lock');
    if (!admitterWaits) return { verdicts, counts };

    // The halt lands while the admission is already inside the door.
    const halted = queryScalar(container,
      `select screening_v2.set_phone_halt('emergency_stop', null, ${now})->>'status';`);
    check('halt_raised_mid_admission', halted === 'ok', halted === 'ok' ? 'ok' : 'halt_refused');

    blocker.send('commit;');
    await blocker.close();

    const admitterOut = await admitter.close();
    const line = admitterOut.stdout.split('\n').map((l) => l.trim())
      .find((l) => l.startsWith('RACE='));
    const status = line === undefined ? 'no_output' : line.slice(5);
    // The whole race, in one assertion.
    check('admission_that_was_mid_flight_is_refused', status === 'halted',
      status === 'halted' ? 'ok' : 'admission_not_refused');
    counts.push({ scenario, key: 'admissions_refused', value: status === 'halted' ? 1 : 0 });

    // And no attempt row was written by the loser.
    const attempts = queryScalar(container,
      `select count(*)::text from screening_v2.phone_call_attempts`
      + ` where engagement_id = '${engagement}'::uuid;`);
    check('no_attempt_row_written', attempts === '0',
      attempts === '0' ? 'ok' : 'attempt_row_written');

    // Clearing must be a SEPARATE, deliberate act — never a `finally`. See
    // `halt-drill.mjs` for why. Here it is an explicit teardown step on the
    // success path, and the check below proves the lane is running again.
    const cleared = queryScalar(container,
      `select screening_v2.clear_phone_halt(null, ${now})->>'status';`);
    check('halt_cleared_deliberately', cleared === 'ok', cleared === 'ok' ? 'ok' : 'clear_refused');
    return { verdicts, counts };
  } finally {
    blocker.kill();
    admitter.kill();
    if (engagement !== null) {
      try { queryScalar(container, `select _phone_canary.teardown('${tag}');`); }
      catch { /* teardown is best effort; the suite drops its schema anyway */ }
    }
  }
}

// ── static leg of the zero-PSTN control ───────────────────────────────

const NETWORK_SPECIFIERS = [
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns',
  'http', 'https', 'net', 'tls', 'dgram', 'dns', 'livekit-server-sdk',
  '@livekit/', 'undici', 'axios', 'node-fetch', 'ws',
];

/**
 * `exec.mjs` may import `node:child_process` and nothing else may; `netguard.mjs`
 * must import the network modules, because trapping them is its job. Every
 * other file in this directory must import neither.
 */
export function staticImportViolations(files) {
  const bad = [];
  for (const { name, source } of files) {
    const specifiers = [...source.matchAll(/(?:^|[\s(=])(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .concat([...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]));
    for (const spec of specifiers) {
      if (spec === 'node:child_process' || spec === 'child_process') {
        if (name !== 'exec.mjs') bad.push(`${name}:child_process`);
        continue;
      }
      if (NETWORK_SPECIFIERS.some((n) => spec === n || spec.startsWith(n))) {
        if (name !== 'netguard.mjs') bad.push(`${name}:${spec}`);
      }
    }
  }
  return bad;
}

// ── main ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const guard = createNetGuard();
  const problems = [];

  try {
    if (!dockerAvailable()) {
      throw new Error('phone-canary: docker is not available; refusing to report a vacuous pass');
    }
    if (!containerRunning(args.container)) {
      throw new Error(
        `phone-canary: container ${args.container} is not running.\n`
        + 'Start the local stack (scripts/supabase-local.sh) or pass --container.\n'
        + 'Canary-0 needs a REAL Postgres carrying 0001..0045; it will not simulate one.');
    }

    const suiteSql = readFileSync(SUITE, 'utf8');
    const runnerSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');

    // Structural + static legs, before anything runs.
    const importable = await sdkImportable();
    if (importable) problems.push('telephony SDK is resolvable from scripts/phone-canary');
    const violations = staticImportViolations(
      ['db.mjs', 'exec.mjs', 'netguard.mjs', 'manifest.mjs', 'canary0.mjs', 'halt-drill.mjs']
        .map((name) => ({ name, source: readFileSync(path.join(HERE, name), 'utf8') })));
    if (violations.length > 0) problems.push(`forbidden imports: ${violations.join(', ')}`);

    // The substrate helpers first. They print nothing; anything on their
    // stdout is a defect and would otherwise be parsed as protocol output.
    const fixtures = runSql(args.container, readFileSync(FIXTURES, 'utf8'),
      { extra: ['-A', '-t', '-q'] });
    if (fixtures.code !== 0) {
      process.stderr.write(fixtures.stderr);
      throw new Error(`phone-canary: fixtures failed to install (psql exit ${fixtures.code})`);
    }
    if (fixtures.stdout.trim() !== '') problems.push('fixtures.sql wrote to stdout');

    // ── PRECONDITION, stated out loud ─────────────────────────────────
    // The halt scenario asserts `already_halted: false` on its first
    // `set_phone_halt`, so it needs the control row down when it starts. A
    // canary run that failed PART WAY THROUGH the race would otherwise leave
    // a halt raised and redden the NEXT run's scenario 7 for a reason that
    // has nothing to do with the code under test.
    //
    // This is NOT the thing `halt-drill.mjs` rule 2 forbids, and the
    // difference is worth being explicit about rather than leaving to
    // whoever next reads both files. That rule is about PRODUCTION, where a
    // raised halt is a person's decision to stop calling people and lifting
    // it as cleanup is a fail-open. This is a local test database with no
    // dialer attached, the clear is an explicit, named SETUP step rather
    // than a `finally`, and it happens BEFORE the run rather than after it —
    // so it can never undo a stop the run itself just made.
    const precondition = queryScalar(args.container,
      "select screening_v2.clear_phone_halt(null, now())->>'status';");
    if (precondition !== 'ok' && precondition !== 'halt_unreadable') {
      problems.push(`could not establish a cleared control row: ${precondition}`);
    }

    const run = runSql(args.container, suiteSql, { extra: ['-A', '-t', '-q'] });
    if (run.code !== 0) {
      process.stderr.write(run.stderr);
      throw new Error(`phone-canary: the scenario suite failed (psql exit ${run.code})`);
    }
    const parsed = parseProtocol(run.stdout);
    if (parsed.errors.length > 0) {
      problems.push(`protocol violations: ${[...new Set(parsed.errors)].join(', ')}`);
    }

    if (args.race) {
      const race = await runHaltRace(args.container);
      parsed.verdicts.push(...race.verdicts);
      parsed.counts.push(...race.counts);
      // `CANARYDONE` counts the SQL scenarios only; the race is the tenth and
      // the runner is the one that knows it ran.
      parsed.scenarioCount += 1;
    }

    // The substrate comes down whether or not the scenarios passed — it is a
    // test fixture and leaving it behind would let the NEXT run inherit it.
    // This is NOT the halt-clear case: nothing here lifts a control that
    // guards a call to a person. See `halt-drill.mjs` rule 2 for the
    // distinction, which is the whole reason this comment exists.
    const teardown = runSql(args.container, readFileSync(TEARDOWN, 'utf8'),
      { extra: ['-A', '-t', '-q'] });
    if (teardown.code !== 0) problems.push('teardown.sql failed');
    if (teardown.stdout.trim() !== '') problems.push('teardown.sql wrote to stdout');

    // The measured window closes HERE, before the positive control runs.
    const measured = guard.measuredCalls();
    const control = guard.runPositiveControl();

    const manifest = buildManifest(parsed, {
      generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...gitState(REPO),
      suiteSha256: sha256(suiteSql),
      runnerSha256: sha256(runnerSource),
      zeroPstn: {
        sdkImportable: importable,
        networkCalls: measured,
        trapPositiveControl: control,
      },
    });

    const verdict = validateManifest(manifest);
    if (!verdict.ok) problems.push(`manifest invalid: ${verdict.errors.join('; ')}`);

    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    if (args.outFile !== null) writeFileSync(args.outFile, json, 'utf8');
    if (args.print || args.outFile === null) process.stdout.write(json);

    const t = manifest.totals;
    process.stderr.write(
      `phone-canary-0: ${t.scenarios_passed}/${t.scenarios} scenarios, `
      + `${t.checks_passed}/${t.checks} checks, network calls ${measured}, `
      + `trap ${control}\n`);

    if (t.checks_failed > 0) problems.push(`${t.checks_failed} check(s) failed`);
    if (problems.length > 0) {
      for (const p of problems) process.stderr.write(`phone-canary FAILED: ${p}\n`);
      process.exitCode = 1;
    }
  } finally {
    guard.dispose();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`phone-canary FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
