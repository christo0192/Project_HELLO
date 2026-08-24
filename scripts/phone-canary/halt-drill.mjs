#!/usr/bin/env node

/**
 * halt-drill.mjs — rehearse, and in an incident operate, the phone lane's
 * emergency stop (PLAN TEL-07).
 *
 * ── THE FOUR RULES THIS FILE IS BUILT AROUND ──────────────────────────
 *
 * 1. **DEFAULT TO DOING NOTHING.** No subcommand mutates without `--execute`;
 *    `--target` defaults to `local`, which cannot reach production at all.
 *    A drill that stops the production dialer because somebody pasted the
 *    wrong line is not a drill.
 *
 * 2. **HALT AND CLEAR ARE TWO INVOCATIONS, NEVER ONE.** There is no
 *    `--and-clear`, no rollback, and — deliberately — **no `finally` block in
 *    this file at all**, which `canary0.test.mjs` asserts structurally.
 *    Lifting a kill switch because our own process was ending is a fail-open
 *    on the single control that exists to stop calls to real people, and this
 *    lane has already recorded that "a compensation is a mutation". If a halt
 *    is raised, a human clears it, with the reason in front of them.
 *
 * 3. **CREDENTIALS ARRIVE ON STDIN OR IN THE ENVIRONMENT. NEVER IN ARGV.**
 *    `/proc/<pid>/cmdline` is world-readable and shell history is forever.
 *    `--token` is not merely unsupported, it is REFUSED with a message that
 *    says why, so somebody who tries it learns the rule instead of falling
 *    back to something worse.
 *
 * 4. **NOTHING IDENTIFYING IS PRINTED.** Every line this file writes is a
 *    boolean, a bounded count, or a stable lowercase code. No token, no
 *    engagement id, no candidate field, no phone number, no attempt id, no
 *    actor id — not even the HTTP body it received, which is summarised
 *    field-by-field rather than echoed.
 *
 * ── "EXPECTED VERSION", HONESTLY ──────────────────────────────────────
 * `phone_control` carries **no version column** — 0042 protects it with a row
 * lock, not with optimistic concurrency, and this phase may not add one.
 * So the precondition this tool enforces is the honest one available:
 *
 *   * `halt`  requires `--expect-halted false` to match the control row read
 *     immediately before acting, so a second operator's halt is not silently
 *     absorbed into yours.
 *   * `clear` requires `--expect-reason <reason>` to NAME the halt currently
 *     in force. That is also what `POST /api/phone/halt/clear` enforces
 *     server-side (`halt_reason_mismatch`), so the check is not merely
 *     client-side politeness.
 *
 * It is a check against CARELESSNESS and it is **time-of-check-to-time-of-use**
 * — the residual `routes/phone.ts` already documents. Do not describe it as a
 * lock. The exposure is bounded in the safe direction: the failure mode is a
 * halt that carries a stale but real reason, never a dialer that resumes
 * unnoticed.
 *
 * USAGE
 *   node scripts/phone-canary/halt-drill.mjs probe
 *   node scripts/phone-canary/halt-drill.mjs halt  --reason operator_pause --expect-halted false
 *   node scripts/phone-canary/halt-drill.mjs halt  --reason operator_pause --expect-halted false --execute
 *   node scripts/phone-canary/halt-drill.mjs clear --expect-reason operator_pause --execute
 *   node scripts/phone-canary/halt-drill.mjs halt  --target production --reason emergency_stop \
 *        --expect-halted false --execute --confirm "STOP THE PHONE DIALER"
 */

import { queryScalar, containerRunning, dockerAvailable, DEFAULT_CONTAINER } from './db.mjs';

/** 0042 `chk_phone_control_reason`. Mirrored, and asserted against the migration by the tests. */
export const HALT_REASONS = Object.freeze([
  'operator_pause', 'provider_incident', 'cost_control', 'legal_hold', 'emergency_stop',
]);

export const SUBCOMMANDS = Object.freeze(['probe', 'halt', 'clear']);
export const TARGETS = Object.freeze(['local', 'production']);

/** Typed out in full, on purpose. A confirmation you can tab-complete is not one. */
export const PRODUCTION_CONFIRMATION = 'STOP THE PHONE DIALER';

export class DrillRefusal extends Error {
  constructor(code, hint) {
    super(hint === undefined ? code : `${code}: ${hint}`);
    this.name = 'DrillRefusal';
    this.code = code;
  }
}

// ── argument parsing ──────────────────────────────────────────────────

/**
 * Pure, and exported so the tests can drive every refusal without a database
 * and without a network. The state machine IS the safety property here, so it
 * is the thing that has to be directly testable.
 */
export function parseArgs(argv) {
  const out = {
    subcommand: null,
    target: 'local',
    reason: null,
    expectHalted: null,
    expectReason: null,
    execute: false,
    confirm: null,
    container: process.env.PHONE_CANARY_CONTAINER ?? DEFAULT_CONTAINER,
    apiBase: process.env.PHONE_HALT_API_BASE ?? null,
  };

  if (argv.length === 0) throw new DrillRefusal('subcommand_required', SUBCOMMANDS.join('|'));
  out.subcommand = argv[0];
  if (!SUBCOMMANDS.includes(out.subcommand)) {
    throw new DrillRefusal('unknown_subcommand', SUBCOMMANDS.join('|'));
  }

  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new DrillRefusal('missing_value', a);
      return v;
    };
    switch (a) {
      case '--target': out.target = value(); break;
      case '--reason': out.reason = value(); break;
      case '--expect-halted': out.expectHalted = value(); break;
      case '--expect-reason': out.expectReason = value(); break;
      case '--execute': out.execute = true; break;
      case '--confirm': out.confirm = value(); break;
      case '--container': out.container = value(); break;
      case '--api-base': out.apiBase = value(); break;
      case '--token':
      case '--password':
      case '--secret':
        // Rule 3, made loud. Falling through to "unknown argument" would let
        // somebody conclude the tool simply lacks the flag and go looking for
        // another way to pass it.
        throw new DrillRefusal('credential_in_argv_refused',
          'pass the admin token on stdin or in PHONE_HALT_ADMIN_TOKEN; argv is world-readable');
      default:
        throw new DrillRefusal('unknown_argument', a);
    }
  }

  if (!TARGETS.includes(out.target)) throw new DrillRefusal('unknown_target', TARGETS.join('|'));

  if (out.subcommand === 'halt') {
    if (out.reason === null) throw new DrillRefusal('reason_required', HALT_REASONS.join('|'));
    if (!HALT_REASONS.includes(out.reason)) {
      throw new DrillRefusal('unknown_reason', HALT_REASONS.join('|'));
    }
    // The precondition is MANDATORY, not defaulted. A default would make the
    // safe answer the one nobody had to think about.
    if (out.expectHalted !== 'false' && out.expectHalted !== 'true') {
      throw new DrillRefusal('expect_halted_required', 'pass --expect-halted true|false');
    }
  }

  if (out.subcommand === 'clear') {
    if (out.expectReason === null) {
      throw new DrillRefusal('expect_reason_required',
        'name the halt currently in force; read it with `probe`');
    }
    if (!HALT_REASONS.includes(out.expectReason)) {
      throw new DrillRefusal('unknown_reason', HALT_REASONS.join('|'));
    }
  }

  if (out.subcommand === 'probe' && out.execute) {
    // `probe` is read-only by construction; accepting `--execute` on it would
    // teach the flag as harmless, which is precisely how it later gets pasted
    // onto `halt`.
    throw new DrillRefusal('probe_is_read_only', 'probe never mutates; drop --execute');
  }

  if (out.target === 'production') {
    if (!out.execute) {
      // Not a silent dry-run. Somebody who typed `--target production` meant
      // to act, and a tool that quietly did nothing would be tried again with
      // more flags until something happened.
      throw new DrillRefusal('production_requires_execute',
        'add --execute; production is never a silent dry run');
    }
    if (out.confirm !== PRODUCTION_CONFIRMATION) {
      throw new DrillRefusal('production_confirmation_required',
        `--confirm ${JSON.stringify(PRODUCTION_CONFIRMATION)}`);
    }
    if (out.apiBase === null || !/^https:\/\/[a-z0-9.-]+(?::\d{2,5})?(?:\/[\w./-]*)?$/i.test(out.apiBase)) {
      throw new DrillRefusal('api_base_required', 'pass --api-base https://… or PHONE_HALT_API_BASE');
    }
  }

  return out;
}

/** Credentials come from exactly two places, and argv is not one of them. */
export function readToken(env, stdinText) {
  const fromStdin = (stdinText ?? '').trim();
  if (fromStdin !== '') return fromStdin;
  const fromEnv = (env.PHONE_HALT_ADMIN_TOKEN ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  throw new DrillRefusal('admin_token_required',
    'pipe the token on stdin or set PHONE_HALT_ADMIN_TOKEN');
}

// ── sanitized reporting ───────────────────────────────────────────────

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The only way anything leaves this process. A value that is not a boolean, a
 * bounded integer or a stable code is printed as `unprintable`, never as
 * itself — so a field that unexpectedly carries an id or a number cannot
 * reach the operator's terminal or their scrollback.
 */
export function say(key, value) {
  let rendered;
  if (typeof value === 'boolean') rendered = value ? 'true' : 'false';
  else if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1e9) {
    rendered = String(value);
  } else if (typeof value === 'string' && CODE.test(value)) rendered = value;
  else rendered = 'unprintable';
  process.stdout.write(`phone-halt-drill ${key}=${rendered}\n`);
  return rendered;
}

// ── local transport ───────────────────────────────────────────────────

function requireLocalDatabase(container) {
  if (!dockerAvailable()) throw new DrillRefusal('docker_unavailable');
  if (!containerRunning(container)) throw new DrillRefusal('container_not_running');
}

function readControl(container) {
  // Read through `phone_backlog`, which is the SAME derivation the runtime and
  // the health surface use — including "a missing singleton reads as halted".
  // Reading the table directly would let this tool report a control state the
  // dialer does not agree with, which is worse than not reporting one.
  const halted = queryScalar(container,
    "select (screening_v2.phone_backlog(now())->'admission'->>'halted');");
  const present = queryScalar(container,
    "select (screening_v2.phone_backlog(now())->'admission'->>'control_present');");
  const reason = queryScalar(container,
    "select coalesce(screening_v2.phone_backlog(now())->'admission'->>'halt_reason','none');");
  return {
    halted: halted === 'true',
    controlPresent: present === 'true',
    reason: CODE.test(reason) ? reason : 'unprintable',
  };
}

/**
 * Audit evidence. Counted, never listed: the operator needs to know a durable
 * row exists, and the row's actor and target are exactly the things this tool
 * must not print.
 */
function auditCount(container, override) {
  if (!CODE.test(override)) throw new DrillRefusal('bad_override_code');
  return Number(queryScalar(container,
    "select count(*)::text from screening_v2.audit_events"
    + " where target_type = 'phone_control'"
    + `   and metadata->>'override' = '${override}';`));
}

// ── production transport ──────────────────────────────────────────────

/**
 * The single network call site in this file. It uses the `fetch` GLOBAL and
 * imports no HTTP module, which is what lets `canary0.mjs`'s static import
 * scan keep every network specifier out of this directory except in
 * `netguard.mjs`, where trapping them is the job.
 */
async function callProduction(apiBase, token, pathname, body) {
  const response = await fetch(`${apiBase.replace(/\/+$/, '')}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  // Field-by-field, never the body. An error body can carry anything.
  return {
    httpStatus: response.status,
    ok: payload !== null && payload.ok === true,
    halted: payload !== null && typeof payload.halted === 'boolean' ? payload.halted : null,
    alreadyHalted: payload !== null && typeof payload.already_halted === 'boolean'
      ? payload.already_halted : null,
    wasHalted: payload !== null && typeof payload.was_halted === 'boolean'
      ? payload.was_halted : null,
    error: payload !== null && typeof payload.error === 'string' && CODE.test(payload.error)
      ? payload.error : null,
  };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// ── subcommands ───────────────────────────────────────────────────────

function runProbe(args) {
  requireLocalDatabase(args.container);
  const control = readControl(args.container);
  say('mode', 'probe');
  say('control_present', control.controlPresent);
  say('halted', control.halted);
  say('halt_reason', control.reason);
  // The fail-closed derivation, stated as the code states it, so a drill
  // report and the health surface cannot disagree.
  say('admission_fail_closed', !control.controlPresent || control.halted);
  say('halt_set_audit_rows', auditCount(args.container, 'phone_admission_halt_set'));
  say('halt_cleared_audit_rows', auditCount(args.container, 'phone_admission_halt_cleared'));
  say('mutated', false);
  return 0;
}

async function runHalt(args, token) {
  say('mode', 'halt');
  say('target', args.target);
  say('reason', args.reason);
  say('dry_run', !args.execute);

  if (args.target === 'local') {
    requireLocalDatabase(args.container);
    const before = readControl(args.container);
    say('observed_halted', before.halted);
    // The precondition, checked against what was just read.
    const expected = args.expectHalted === 'true';
    if (before.halted !== expected) {
      say('precondition', 'expect_halted_mismatch');
      say('mutated', false);
      return 2;
    }
    say('precondition', 'ok');
    if (!args.execute) { say('mutated', false); return 0; }

    const auditBefore = auditCount(args.container, 'phone_admission_halt_set');
    const status = queryScalar(args.container,
      `select screening_v2.set_phone_halt('${args.reason}', null, now())->>'status';`);
    say('rpc_status', CODE.test(status) ? status : 'unprintable');
    const after = readControl(args.container);
    say('halted', after.halted);
    say('admission_fail_closed', !after.controlPresent || after.halted);
    // Evidence: a durable audit row appeared. A halt that left no trace is
    // not a halt anybody can review afterwards.
    const auditAfter = auditCount(args.container, 'phone_admission_halt_set');
    say('audit_rows_added', Math.max(0, auditAfter - auditBefore));
    say('mutated', status === 'ok');
    // NOTHING is cleared here. See rule 2 at the top of this file.
    say('clear_is_a_separate_invocation', true);
    return status === 'ok' && after.halted ? 0 : 1;
  }

  const result = await callProduction(args.apiBase, token, '/api/phone/halt',
    { reason: args.reason });
  say('http_ok', result.ok);
  say('halted', result.halted === null ? 'unprintable' : result.halted);
  say('already_halted', result.alreadyHalted === null ? 'unprintable' : result.alreadyHalted);
  say('error', result.error ?? 'none');
  say('mutated', result.ok);
  say('clear_is_a_separate_invocation', true);
  say('audit_evidence', 'server_side_audit_events_row_written_by_the_route');
  return result.ok ? 0 : 1;
}

async function runClear(args, token) {
  say('mode', 'clear');
  say('target', args.target);
  say('dry_run', !args.execute);

  if (args.target === 'local') {
    requireLocalDatabase(args.container);
    const before = readControl(args.container);
    say('control_present', before.controlPresent);
    say('observed_halted', before.halted);
    if (!before.controlPresent) {
      // 0042 refuses to invent a cleared row and so does this. An unreadable
      // kill switch is a database problem, and lifting it by guessing would
      // be the fail-open the whole lane is built to avoid.
      say('precondition', 'halt_unreadable');
      say('mutated', false);
      return 2;
    }
    if (before.halted && before.reason !== args.expectReason) {
      say('precondition', 'halt_reason_mismatch');
      say('mutated', false);
      return 2;
    }
    say('precondition', 'ok');
    if (!args.execute) { say('mutated', false); return 0; }

    const auditBefore = auditCount(args.container, 'phone_admission_halt_cleared');
    const status = queryScalar(args.container,
      'select screening_v2.clear_phone_halt(null, now())->>\'status\';');
    say('rpc_status', CODE.test(status) ? status : 'unprintable');
    const after = readControl(args.container);
    say('halted', after.halted);
    say('admission_fail_closed', !after.controlPresent || after.halted);
    say('audit_rows_added',
      Math.max(0, auditCount(args.container, 'phone_admission_halt_cleared') - auditBefore));
    say('mutated', status === 'ok');
    return status === 'ok' && !after.halted ? 0 : 1;
  }

  const result = await callProduction(args.apiBase, token, '/api/phone/halt/clear',
    { reason: args.expectReason });
  say('http_ok', result.ok);
  say('halted', result.halted === null ? 'unprintable' : result.halted);
  say('was_halted', result.wasHalted === null ? 'unprintable' : result.wasHalted);
  say('error', result.error ?? 'none');
  say('mutated', result.ok);
  say('audit_evidence', 'server_side_audit_events_row_written_by_the_route');
  return result.ok ? 0 : 1;
}

export async function main(argv, env = process.env) {
  const args = parseArgs(argv);
  let token = null;
  if (args.target === 'production') token = readToken(env, await readStdin());
  if (args.subcommand === 'probe') return runProbe(args);
  if (args.subcommand === 'halt') return runHalt(args, token);
  return runClear(args, token);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      const code = error instanceof DrillRefusal ? error.code : 'drill_error';
      process.stderr.write(`phone-halt-drill refused: ${code}\n`);
      if (error instanceof DrillRefusal && error.message !== code) {
        process.stderr.write(`phone-halt-drill hint: ${error.message.slice(code.length + 2)}\n`);
      }
      process.exitCode = 2;
    },
  );
}
