#!/usr/bin/env node

/**
 * provision-voice-worker-pool.mjs — idempotently bring a Fly app's on-demand
 * voice-worker pool up to N STOPPED machines and register each in the
 * voice_worker_leases ledger, so `claim_voice_worker` has capacity to hand out.
 *
 * This is the ops half of on-demand orchestration activation (PR B). The
 * runtime never CREATES pool machines — it only starts/stops/reaps rows that
 * already exist — so a fresh pool must be provisioned once (and re-run any time
 * the desired size changes, or after a `fly deploy` replaces the release image).
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────
 *   1. Lists machines in the Fly app (Fly Machines REST API).
 *   2. If fewer than N machines exist, CREATES the shortfall as STOPPED
 *      machines cloned from a TEMPLATE machine's config — by default the app's
 *      current release image, taken from an existing machine (so a redeploy is
 *      reflected the next time this runs). Each created machine is created with
 *      `skip_launch: true` so it lands STOPPED, never running, never costing.
 *   3. Registers EVERY machine (existing + created) via the `register_voice_worker`
 *      RPC (idempotent: an already-registered machine is left as-is).
 *   4. Prints a verification table: machine id, Fly state, lease state.
 *
 * ── IDEMPOTENT ────────────────────────────────────────────────────────
 * Safe to run repeatedly. It never creates ABOVE N, never starts a machine,
 * never touches a machine that is not STOPPED, and `register_voice_worker` is a
 * no-op for an already-registered row. Running it twice with the same N is a
 * no-op after the first.
 *
 * ── SECRETS COME FROM THE ENVIRONMENT, NEVER ARGV ─────────────────────
 * FLY_API_TOKEN, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are read from the
 * environment (e.g. `fly ssh console` on the API machine, or a CI job with the
 * secrets injected). They are NEVER accepted as arguments and NEVER printed.
 * The service-role key touches only the register RPC.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────
 *   node scripts/provision-voice-worker-pool.mjs \
 *     --app project-hello-phone-voice --pipeline phone --size 3
 *
 *   Flags:
 *     --app <slug>        REQUIRED. The Fly app that owns the pool.
 *     --pipeline <p>      REQUIRED. 'phone' or 'browser' (the lease pipeline).
 *     --size <N>          REQUIRED. Desired pool size (1..50).
 *     --region <r>        Optional. Region for CREATED machines (default: the
 *                         template machine's region).
 *     --dry-run           List + plan only; create/register nothing.
 *
 * Exit 0 on success (pool at or above N and all registered), non-zero on any
 * failure. Nothing here starts a machine or places a call.
 *
 * ── SHRINKING THE POOL: --retire <machineId> (M019) ───────────────────
 *   node scripts/provision-voice-worker-pool.mjs \
 *     --app project-hello-voice --retire 89122ec60edd28 [--retire <id> ...] [--dry-run]
 *
 * Removes pool machines safely. `--size` never shrinks (it only creates), and a
 * hand-run `fly machine destroy` is unsafe: the machine's `stopped` lease row
 * stays behind, `claim_voice_worker` hands the dead machine out, the start fails
 * `not_found`, and that session gets the same dead machine back on every retry.
 *
 * A machine is retired only when BOTH hold:
 *   - Fly reports it `stopped` (or `created`: provisioned, never started), and
 *   - its lease row reads `stopped` (no session holds it).
 * Every requested machine is checked before anything is touched; one refusal
 * refuses the whole run. Retiring every machine of the app is refused too: the
 * last machine is the template the next provisioning clones.
 *
 * Order per machine: `retire_voice_worker` FIRST (0131; it deletes the row only
 * while it is `stopped`, atomically, so no claim can hand the machine out after
 * it), and only on `retired` is the Fly machine destroyed — without `force`, so
 * Fly itself refuses a machine that is running. A retire that answers anything
 * else (a claim raced in) destroys nothing.
 *
 * Like the provisioning mode it acts unless `--dry-run` is given; run the
 * dry-run first. `--retire` takes no `--size`; `--pipeline` is optional (the
 * lease row is addressed by app + machine id).
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';

// api.machines.dev is the host that serves the Machines REST API; api.fly.io/v1
// 404s every /apps/{app}/machines call (RCA 2026-09-06 — the old default here
// made an external run of this script fail its very first GET).
const FLY_API = process.env.FLY_API_BASE_URL ?? 'https://api.machines.dev/v1';
const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_SIZE = 50;
// Fly machine ids are lowercase hex (14 chars today); the same bound the API's
// per-machine agent-name check uses (worker-agent-name.ts PER_MACHINE_ID_RE).
const MACHINE_ID_RE = /^[0-9a-z]{8,32}$/;
// Fly states in which a machine is not running and never started by itself.
const RETIRABLE_FLY_STATES = new Set(['stopped', 'created']);

/**
 * Fatal error. In the CLI it prints a stable, secret-free message and exits 1.
 * A test can inject an `onDie` that THROWS instead of exiting, so the process
 * survives and the message can be asserted — while the CLI keeps exit-1
 * semantics. `die` never interpolates a secret; callers must pass only stable
 * text (never a token, a provider body, or a URL with credentials).
 */
let _onDie = (msg) => {
  process.stderr.write(`provision-voice-worker-pool: ${msg}\n`);
  process.exit(1);
};

export function setDieHandler(fn) {
  _onDie = fn;
}

function die(msg) {
  _onDie(msg);
  // If the handler returned (a test handler that records instead of exiting),
  // still stop the current flow by throwing a sentinel the caller recognises.
  throw new ProvisionDied(msg);
}

/** Sentinel thrown after `die` so a non-exiting handler still unwinds. */
export class ProvisionDied extends Error {}

export function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--app') { out.app = argv[++i]; continue; }
    if (a === '--pipeline') { out.pipeline = argv[++i]; continue; }
    if (a === '--size') { out.size = Number(argv[++i]); continue; }
    if (a === '--region') { out.region = argv[++i]; continue; }
    if (a === '--retire') { (out.retire ??= []).push(argv[++i]); continue; }
    die(`unknown argument: ${a}`);
  }
  return out;
}

export function validateRetire(args) {
  if (!args.app || !APP_SLUG_RE.test(args.app)) {
    die('--app is required and must be a valid Fly app slug');
  }
  if (args.size !== undefined || args.region !== undefined) {
    die('--retire cannot be combined with --size or --region');
  }
  if (args.pipeline !== undefined && args.pipeline !== 'phone' && args.pipeline !== 'browser') {
    die("--pipeline, if given, must be 'phone' or 'browser'");
  }
  if (!Array.isArray(args.retire) || args.retire.length === 0) {
    die('--retire needs at least one machine id');
  }
  for (const id of args.retire) {
    if (typeof id !== 'string' || !MACHINE_ID_RE.test(id)) {
      die('--retire takes a Fly machine id (8..32 lowercase letters or digits)');
    }
  }
  if (new Set(args.retire).size !== args.retire.length) {
    die('--retire names the same machine more than once');
  }
}

export function validate(args) {
  if (!args.app || !APP_SLUG_RE.test(args.app)) {
    die('--app is required and must be a valid Fly app slug');
  }
  if (args.pipeline !== 'phone' && args.pipeline !== 'browser') {
    die("--pipeline is required and must be 'phone' or 'browser'");
  }
  if (!Number.isInteger(args.size) || args.size < 1 || args.size > MAX_SIZE) {
    die(`--size is required and must be an integer in 1..${MAX_SIZE}`);
  }
  if (args.region !== undefined && !/^[a-z]{3}$/.test(args.region)) {
    die('--region, if given, must be a 3-letter Fly region code');
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v === 'replace_me') die(`missing required env var: ${name}`);
  return v;
}

async function fly(token, method, path, body) {
  const res = await fetch(`${FLY_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text.length ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) {
    // Never print the provider body verbatim (it can quote config); a status is enough.
    die(`Fly API ${method} ${path} failed: HTTP ${res.status}`);
  }
  return parsed;
}

async function registerLease(supabaseUrl, serviceKey, app, pipeline, machineId) {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/register_voice_worker`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
      // The lease RPCs live in the screening_v2 schema; PostgREST routes by header.
      'content-profile': 'screening_v2',
      accept: 'application/json',
    },
    body: JSON.stringify({
      p_app: app,
      p_pipeline: pipeline,
      p_machine_id: machineId,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    die(`register_voice_worker failed for ${machineId}: HTTP ${res.status}`);
  }
  let parsed = null;
  try { parsed = text.length ? JSON.parse(text) : null; } catch { /* keep null */ }
  // The RPC returns {status:'registered'|'exists'|...}. Both are success.
  const status = parsed && typeof parsed === 'object' ? parsed.status : 'unknown';
  return status;
}

function serviceHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    'content-type': 'application/json',
    // The lease table + RPCs live in the screening_v2 schema; PostgREST routes by header.
    'content-profile': 'screening_v2',
    'accept-profile': 'screening_v2',
    accept: 'application/json',
  };
}

/** The lease row's state for (app, machine), or null when no row exists. Read-only. */
async function readLeaseRow(supabaseUrl, serviceKey, app, machineId) {
  const q = `app=eq.${encodeURIComponent(app)}&machine_id=eq.${encodeURIComponent(machineId)}&select=state`;
  const res = await fetch(`${supabaseUrl}/rest/v1/voice_worker_leases?${q}`, {
    method: 'GET',
    headers: serviceHeaders(serviceKey),
  });
  const text = await res.text();
  if (!res.ok) die(`lease read failed for ${machineId}: HTTP ${res.status}`);
  let rows = null;
  try { rows = text.length ? JSON.parse(text) : []; } catch { /* keep null */ }
  if (!Array.isArray(rows)) die(`lease read for ${machineId} returned no row list`);
  if (rows.length === 0) return null;
  return typeof rows[0]?.state === 'string' ? rows[0].state : 'unknown';
}

/** retire_voice_worker (0131). Returns its {status,...} envelope. */
async function retireLeaseRpc(supabaseUrl, serviceKey, app, machineId) {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/retire_voice_worker`, {
    method: 'POST',
    headers: serviceHeaders(serviceKey),
    body: JSON.stringify({ p_app: app, p_machine_id: machineId }),
  });
  const text = await res.text();
  if (!res.ok) return { status: `http_${res.status}` };
  let parsed = null;
  try { parsed = text.length ? JSON.parse(text) : null; } catch { /* keep null */ }
  return parsed && typeof parsed === 'object' ? parsed : { status: 'unknown' };
}

/**
 * Destroy a Fly machine WITHOUT force (Fly refuses one that is running). Never
 * dies: the caller has already retired the lease and must report the exact
 * manual follow-up. Returns { ok, status }.
 */
async function destroyFlyMachine(token, app, machineId) {
  try {
    const res = await fetch(`${FLY_API}/apps/${app}/machines/${machineId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    await res.text();
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * The retire (pool-shrink) core. Side effects are injectable for tests:
 *   flyRequest(method, path, body) → parsed Fly response (the machine listing)
 *   readLease(app, machineId)      → lease state string, or null for no row
 *   retireLease(app, machineId)    → retire_voice_worker envelope
 *   destroyMachine(app, machineId) → { ok, status }
 *   out(str)                       → stdout writer
 * Returns { retired: [ids], planned: [ids], raced: [ids] }.
 */
export async function retire(args, deps = {}) {
  validateRetire(args);

  const needsFly = !deps.flyRequest || !deps.destroyMachine;
  const needsDb = !deps.readLease || !deps.retireLease;
  const token = needsFly ? requireEnv('FLY_API_TOKEN') : null;
  const supabaseUrl = needsDb ? requireEnv('SUPABASE_URL').replace(/\/+$/, '') : null;
  const serviceKey = needsDb ? requireEnv('SUPABASE_SERVICE_ROLE_KEY') : null;

  const flyRequest = deps.flyRequest ?? ((method, path, body) => fly(token, method, path, body));
  const readLease = deps.readLease ?? ((app, id) => readLeaseRow(supabaseUrl, serviceKey, app, id));
  const retireLease = deps.retireLease ?? ((app, id) => retireLeaseRpc(supabaseUrl, serviceKey, app, id));
  const destroyMachine = deps.destroyMachine ?? ((app, id) => destroyFlyMachine(token, app, id));
  const out = deps.out ?? ((s) => process.stdout.write(s));

  // 1. Plan: every requested machine must be stopped on Fly AND hold a stopped
  //    lease. Nothing is touched unless the whole plan passes.
  const machines = (await flyRequest('GET', `/apps/${args.app}/machines`)) ?? [];
  if (!Array.isArray(machines)) die('Fly returned a non-array machine list');
  const flyState = new Map(machines.map((m) => [m.id, m.state]));

  const plan = [];
  for (const id of args.retire) {
    const flyNow = flyState.get(id);
    const lease = flyNow === undefined ? null : await readLease(args.app, id);
    let refusal = null;
    if (flyNow === undefined) refusal = 'not a machine of this app';
    else if (!RETIRABLE_FLY_STATES.has(flyNow)) refusal = `Fly state is ${flyNow}, not stopped`;
    else if (lease === null) refusal = 'no lease row (not a registered pool machine)';
    else if (lease !== 'stopped') refusal = `lease state is ${lease}, not stopped`;
    plan.push({ id, fly: flyNow ?? '(absent)', lease: lease ?? '(none)', refusal });
  }

  out(`Retire from ${args.app}: ${args.retire.length} machine(s) requested, ${machines.length} in the app.\n`);
  out('\n  MACHINE ID              FLY STATE     LEASE         PLAN\n');
  out('  ----------------------  ------------  ------------  ------------\n');
  for (const p of plan) {
    out(`  ${p.id.padEnd(22)}  ${String(p.fly).padEnd(12)}  ${String(p.lease).padEnd(12)}  `
      + `${p.refusal ? `REFUSED: ${p.refusal}` : 'retire'}\n`);
  }

  const refused = plan.filter((p) => p.refusal);
  if (refused.length > 0) {
    die(`refusing to retire: ${refused.length} machine(s) are not stopped with a stopped lease `
      + `(${refused.map((p) => p.id).join(', ')}); nothing was changed`);
  }
  if (args.retire.length >= machines.length) {
    die('refusing to retire every machine of the app: the last machine is the template the '
      + 'next provisioning clones; nothing was changed');
  }

  if (args.dryRun) {
    out(`\n[DRY RUN] Would retire ${plan.length} machine(s); nothing was changed.\n`);
    return { retired: [], planned: plan.map((p) => p.id), raced: [] };
  }

  // 2. Act, per machine: lease FIRST (so no claim can hand it out), then Fly.
  const retired = [];
  const raced = [];
  for (const p of plan) {
    const env = await retireLease(args.app, p.id);
    const status = env && typeof env === 'object' ? env.status : 'unknown';
    if (status !== 'retired') {
      // A claim took the row between the plan and now (or the RPC failed). The
      // machine stays registered and in the pool; destroy nothing.
      out(`  ${p.id}: lease NOT retired (${status}${env?.state ? `, state ${env.state}` : ''}); machine kept\n`);
      raced.push(p.id);
      continue;
    }
    const d = await destroyMachine(args.app, p.id);
    if (!d || !d.ok) {
      die(`lease retired for ${p.id} but the Fly destroy failed (HTTP ${d?.status ?? 0}). The machine `
        + `is no longer in the pool (nothing can claim it). Destroy it by hand, without --force: `
        + `fly machine destroy ${p.id} -a ${args.app} - or re-run the provisioning mode to `
        + `register it again`);
    }
    out(`  ${p.id}: lease retired, Fly machine destroyed\n`);
    retired.push(p.id);
  }
  out(`\nRetired ${retired.length} of ${plan.length} machine(s). Pool now ${machines.length - retired.length}.\n`);
  if (raced.length > 0) {
    die(`${raced.length} machine(s) were claimed or refused during the run and were kept: ${raced.join(', ')}`);
  }
  return { retired, planned: [], raced };
}

/**
 * The provisioning core, with every side effect injectable so it can run
 * against a stubbed Fly transport in tests. `deps`:
 *   flyRequest(method, path, body) → parsed Fly response (defaults to the real
 *     token-bearing fetch)
 *   register(app, pipeline, machineId) → lease status string (defaults to the
 *     real service-role RPC)
 *   out(str) → stdout writer (defaults to process.stdout.write)
 * Returns { total, created, existing, registrations } for assertions.
 */
export async function provision(args, deps = {}) {
  validate(args);

  const token = deps.flyRequest ? null : requireEnv('FLY_API_TOKEN');
  const supabaseUrl = deps.register ? null : requireEnv('SUPABASE_URL').replace(/\/+$/, '');
  const serviceKey = deps.register ? null : requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const flyRequest = deps.flyRequest ?? ((method, path, body) => fly(token, method, path, body));
  const register = deps.register
    ?? ((app, pipeline, id) => registerLease(supabaseUrl, serviceKey, app, pipeline, id));
  const out = deps.out ?? ((s) => process.stdout.write(s));

  // 1. List existing machines.
  const machines = (await flyRequest('GET', `/apps/${args.app}/machines`)) ?? [];
  if (!Array.isArray(machines)) die('Fly returned a non-array machine list');
  const existing = machines.map((m) => ({
    id: m.id,
    state: m.state,
    region: m.region,
    image: m.config?.image,
    config: m.config,
  }));

  out(
    `Pool for ${args.app} (${args.pipeline}): found ${existing.length} machine(s), target ${args.size}.\n`,
  );

  // 2. Create the shortfall, cloned from a template machine's config.
  const toCreate = Math.max(0, args.size - existing.length);
  const created = [];
  if (toCreate > 0) {
    if (existing.length === 0) {
      // No template to clone. We refuse rather than guess an image/config — the
      // operator must `fly deploy` the worker at least once so a release image
      // exists, then re-run this script.
      die(
        `no existing machine to clone a release image from. Deploy the worker `
        + `once (fly deploy) so the app has a release image, then re-run.`,
      );
    }
    const template = existing[0];
    if (!template.config || !template.image) {
      die('the template machine has no usable config/image to clone');
    }
    const region = args.region ?? template.region;
    for (let i = 0; i < toCreate; i++) {
      if (args.dryRun) {
        created.push({ id: `(dry-run #${i + 1})`, state: 'stopped', planned: true });
        continue;
      }
      // Create STOPPED: `skip_launch` lands the machine created-but-not-started,
      // so it costs nothing and is claimable by the runtime on demand.
      const body = {
        region,
        skip_launch: true,
        config: {
          ...template.config,
          // Guard: never inherit a restart policy that would auto-start the
          // machine. On-demand means the runtime decides when it runs.
          restart: { policy: 'no' },
          auto_destroy: false,
        },
      };
      const m = await flyRequest('POST', `/apps/${args.app}/machines`, body);
      if (!m || typeof m.id !== 'string') die('Fly create returned no machine id');
      // Enforce the STOPPED-pool invariants the runtime depends on, so a Fly
      // response that silently ignored skip_launch/restart cannot leave a
      // running or auto-restarting pool machine unnoticed.
      if (m.config && m.config.restart && m.config.restart.policy !== 'no') {
        die(`created machine ${m.id} did not carry restart policy 'no'`);
      }
      created.push({ id: m.id, state: m.state ?? 'created' });
    }
  }

  // 3. Register every machine (existing + created) in the lease ledger. Existing
  //    machines are registered too, which is the PARTIAL-CREATE SELF-HEAL: a
  //    prior run that created a machine but crashed before registering it leaves
  //    an unregistered orphan, and this re-registers it (register is idempotent).
  const all = [...existing.map((m) => m.id), ...created.filter((c) => !c.planned).map((c) => c.id)];
  const registrations = new Map();
  if (!args.dryRun) {
    for (const id of all) {
      const status = await register(args.app, args.pipeline, id);
      registrations.set(id, status);
    }
  }

  // 4. Verification table.
  out('\n  MACHINE ID              FLY STATE     LEASE\n');
  out('  ----------------------  ------------  ------------\n');
  const rows = [
    ...existing.map((m) => ({ id: m.id, fly: m.state })),
    ...created.map((c) => ({ id: c.id, fly: c.state })),
  ];
  for (const r of rows) {
    const lease = args.dryRun ? '(dry-run)' : (registrations.get(r.id) ?? 'n/a');
    out(
      `  ${String(r.id).padEnd(22)}  ${String(r.fly).padEnd(12)}  ${lease}\n`,
    );
  }
  const total = existing.length + created.length;
  out(
    `\n${args.dryRun ? '[DRY RUN] ' : ''}Pool size: ${total} (target ${args.size}). `
    + `Created ${created.length}, existing ${existing.length}.\n`,
  );
  if (total < args.size && !args.dryRun) {
    die(`pool is BELOW target after provisioning (${total} < ${args.size})`);
  }
  return {
    total,
    created: created.length,
    existing: existing.length,
    registrations,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.retire !== undefined) {
    await retire(args);
    return;
  }
  await provision(args);
}

// Only auto-run as a CLI, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    // A ProvisionDied has already reported through the die handler (exit 1);
    // do not double-report. Anything else is sanitized to a stable message.
    if (err instanceof ProvisionDied) return;
    die(`unexpected failure: ${err?.message ?? 'unknown'}`);
  });
}
