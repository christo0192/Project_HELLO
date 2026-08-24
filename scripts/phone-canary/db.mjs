#!/usr/bin/env node

/**
 * db.mjs — the only module in `scripts/phone-canary/` that talks to a
 * database. Every process it starts goes through `exec.mjs`, which is this
 * directory's single `node:child_process` boundary.
 *
 * ── WHY A SUBPROCESS AND NOT A DRIVER ─────────────────────────────────
 * Adding a Postgres driver to this repo would put a TCP-speaking library in
 * the same process as a canary whose entire claim is that it speaks to
 * nothing. `docker exec … psql` keeps every socket outside this process:
 * `netguard.mjs` can trap every egress primitive Node has and still leave the
 * database reachable, because the database is reached by a CHILD.
 *
 * It also matches how the repo already runs real-Postgres tests
 * (`scripts/supabase-test.sh` feeds `.sql` files to `docker exec -i … psql`),
 * so the canary is exercised by the same mechanism as the policy suite rather
 * than by a second one nobody maintains.
 *
 * ── LOCAL ONLY, STRUCTURALLY ──────────────────────────────────────────
 * `docker exec` takes a CONTAINER, not a host. There is no connection string
 * to point somewhere else, and `assertLocalOnly` refuses an argv that grew
 * one anyway — a `-h`, a `--host`, a `-p`, or anything resembling a URI. The
 * container name is validated against a narrow grammar so it cannot carry a
 * shell fragment, and no shell is used anywhere, so it could
 * not act on one if it did.
 */

import { run, start } from './exec.mjs';

export const DEFAULT_CONTAINER = 'supabase_db_screening-bot-local';
export const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * Anything that could redirect psql at a database that is not the local
 * container. Checked over the argv we built, not over the input, because the
 * argv is what actually runs.
 */
export const FORBIDDEN_ARGV = Object.freeze([
  /^-h$/, /^--host(=|$)/, /^-p$/, /^--port(=|$)/,
  /^-d?postgres(ql)?:\/\//i, /:\/\//,
]);

export function assertLocalOnly(argv) {
  for (const arg of argv) {
    for (const bad of FORBIDDEN_ARGV) {
      if (bad.test(arg)) {
        throw new Error(`phone-canary refuses a non-local database target: ${arg}`);
      }
    }
  }
  return argv;
}

export const APP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;

export function psqlArgv(container, extra = [], { appName } = {}) {
  if (!CONTAINER_PATTERN.test(container)) {
    throw new Error('phone-canary refuses a container name outside the allowed grammar');
  }
  // `docker exec` does NOT inherit the caller's environment, so PGAPPNAME has
  // to be handed across the boundary explicitly. Without this the lock race
  // cannot see its own sessions in `pg_stat_activity` and reports "the
  // blocker never took the lock" — a false negative that looks exactly like
  // the real defect it exists to catch.
  const env = appName === undefined ? [] : ['-e', `PGAPPNAME=${appName}`];
  if (appName !== undefined && !APP_NAME_PATTERN.test(appName)) {
    throw new Error('phone-canary refuses an application_name outside the allowed grammar');
  }
  return assertLocalOnly([
    'exec', '-i', ...env, container,
    'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    ...extra,
  ]);
}

export function dockerAvailable() {
  return run('docker', ['version', '--format', '{{.Client.Version}}'],
    { timeoutMs: 15_000 }).code === 0;
}

export function containerRunning(container) {
  if (!CONTAINER_PATTERN.test(container)) return false;
  const probe = run('docker', ['inspect', '-f', '{{.State.Running}}', container],
    { timeoutMs: 15_000 });
  return probe.code === 0 && probe.stdout.trim() === 'true';
}

/** Run SQL from stdin. Returns `{ code, stdout, stderr }`; never throws on a SQL error. */
export function runSql(container, sql, { extra = [], timeoutMs = 600_000 } = {}) {
  return run('docker', psqlArgv(container, extra), { input: sql, timeoutMs });
}

/**
 * One scalar, unaligned and tuples-only. Throws on a SQL error rather than
 * returning an empty string — an empty string is a legitimate value and
 * conflating it with a failure is how a check passes vacuously.
 */
export function queryScalar(container, sql, { timeoutMs = 60_000 } = {}) {
  const out = runSql(container, sql, { extra: ['-A', '-t', '-q'], timeoutMs });
  if (out.code !== 0) {
    throw new Error(`phone-canary query failed (exit ${out.code}): ${firstLine(out.stderr)}`);
  }
  return out.stdout.trim();
}

function firstLine(text) {
  return String(text).split('\n').find((l) => l.trim() !== '') ?? '';
}

/**
 * A long-lived psql session whose stdin stays open — the blocker half of a
 * deterministic lock race. `supabase-test.sh` does this with a FIFO; a live
 * child's stdin is the same mechanism without a filesystem object to leak.
 */
export function openSession(container, { appName }) {
  const child = start('docker', psqlArgv(container, ['-A', '-t', '-q'], { appName }));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });

  return {
    appName,
    send(sql) { child.stdin.write(`${sql}\n`); },
    stdout: () => stdout,
    stderr: () => stderr,
    /** Close stdin and wait. Always resolves; a blocker that died is a fact, not a throw. */
    close() {
      return new Promise((resolve) => {
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        try { child.stdin.end(); } catch { /* already gone */ }
      });
    },
    kill() { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
  };
}

/**
 * Poll until `predicateSql` (a boolean scalar query) answers `t`.
 *
 * Bounded by WALL CLOCK and not by an iteration count, because an iteration
 * count silently becomes a shorter timeout on a slower machine — the exact
 * shape that turned a lease renewal into a hang-up in this lane's P4 review.
 */
export async function waitUntil(container, predicateSql, { timeoutMs = 30_000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (queryScalar(container, predicateSql) === 't') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
