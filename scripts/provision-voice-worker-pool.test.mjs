#!/usr/bin/env node
// Tests for provision-voice-worker-pool.mjs — the ops half of on-demand
// orchestration activation. Two layers, matching the peer convention in
// validate-voice-worker-apps.test.mjs:
//   1. Arg/env validation is exercised through a SUBPROCESS (spawnSync) so the
//      real die-path (exit 1, stable message on stderr, NO secret echoed) is
//      what is asserted — not a mocked handler.
//   2. The provisioning core (`provision`) is exercised in-process with injected
//      `deps` (a stubbed Fly transport + register + out), so idempotency, the
//      partial-create self-heal, dry-run, and the created-machine invariants are
//      proven deterministically with no network, no timers, no real Fly.
//
// Plain .mjs, the failures[] harness — NOT vitest, NOT node:test.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "provision-voice-worker-pool.mjs");

const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

// A subprocess run. `env` overrides are merged onto process.env; passing an
// empty string for a var makes requireEnv treat it as missing (its contract).
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const SECRET = "super-secret-token-value";

// ── 1. Arg/env validation via SUBPROCESS ────────────────────────────────
// Each of these must exit non-zero with a STABLE message, and must NEVER echo
// the injected FLY_API_TOKEN into stdout+stderr.
{
  // Bad app slug (uppercase). Token is set to a fake secret so we can prove the
  // die path never prints it.
  const r = run(
    ["--app", "BAD_SLUG", "--pipeline", "phone", "--size", "2"],
    { FLY_API_TOKEN: SECRET, SUPABASE_URL: SECRET, SUPABASE_SERVICE_ROLE_KEY: SECRET },
  );
  ok(r.code === 1, `bad app slug must exit 1, got ${r.code}:\n${r.out}`);
  ok(/must be a valid Fly app slug/.test(r.out),
    `bad app slug must name the slug contract, got:\n${r.out}`);
  ok(!r.out.includes(SECRET), `bad-slug die path must not echo the secret, got:\n${r.out}`);
}
{
  // Size below range.
  const r = run(
    ["--app", "project-hello-phone-voice", "--pipeline", "phone", "--size", "0"],
    { FLY_API_TOKEN: SECRET, SUPABASE_URL: SECRET, SUPABASE_SERVICE_ROLE_KEY: SECRET },
  );
  ok(r.code === 1, `--size 0 must exit 1, got ${r.code}:\n${r.out}`);
  ok(/must be an integer in 1\.\.50/.test(r.out),
    `--size 0 must name the 1..50 range, got:\n${r.out}`);
  ok(!r.out.includes(SECRET), `--size 0 die path must not echo the secret, got:\n${r.out}`);
}
{
  // Size above range.
  const r = run(
    ["--app", "project-hello-phone-voice", "--pipeline", "phone", "--size", "51"],
    { FLY_API_TOKEN: SECRET, SUPABASE_URL: SECRET, SUPABASE_SERVICE_ROLE_KEY: SECRET },
  );
  ok(r.code === 1, `--size 51 must exit 1, got ${r.code}:\n${r.out}`);
  ok(/must be an integer in 1\.\.50/.test(r.out),
    `--size 51 must name the 1..50 range, got:\n${r.out}`);
  ok(!r.out.includes(SECRET), `--size 51 die path must not echo the secret, got:\n${r.out}`);
}
{
  // Valid args, but FLY_API_TOKEN missing (empty string ⇒ treated as missing by
  // requireEnv). The phone/supabase vars are unset too so nothing else short-
  // circuits first. A secret cannot be injected here (it is the missing thing),
  // so this case only asserts the stable message + exit code.
  const r = run(
    ["--app", "project-hello-phone-voice", "--pipeline", "phone", "--size", "2"],
    { FLY_API_TOKEN: "", SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
  );
  ok(r.code === 1, `missing FLY_API_TOKEN must exit 1, got ${r.code}:\n${r.out}`);
  ok(/missing required env var: FLY_API_TOKEN/.test(r.out),
    `missing token must name the env var, got:\n${r.out}`);
}

// ── in-process import of the core + injectable die ──────────────────────
const mod = await import(script);
const { provision, parseArgs, setDieHandler, ProvisionDied } = mod;

// A template machine as Fly's GET returns it — a valid config + image + a
// restart policy the invariant expects.
function templateMachine(id = "tmpl-0") {
  return {
    id,
    state: "stopped",
    region: "sin",
    config: { image: "registry.fly.io/project-hello-phone-voice:deployment-1", restart: { policy: "no" } },
  };
}

// A stubbed Fly transport factory. `getList` is the array returned by GET; each
// POST returns a fresh created machine with a unique id (counter) and, by
// default, restart.policy 'no'. Records every POST body for invariant asserts.
function makeFly(getList, { postRestartPolicy = "no" } = {}) {
  let n = 0;
  const postBodies = [];
  const counts = { get: 0, post: 0 };
  const flyRequest = async (method, _path, body) => {
    if (method === "GET") { counts.get++; return getList; }
    if (method === "POST") {
      counts.post++;
      postBodies.push(body);
      n++;
      return {
        id: `created-${n}`,
        state: "created",
        config: { ...body.config, restart: { policy: postRestartPolicy } },
      };
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { flyRequest, postBodies, counts };
}

// A register stub. `plan` maps id→status (default 'registered'); records call
// ids and count.
function makeRegister(plan = {}) {
  const calls = [];
  const register = async (_app, _pipeline, id) => {
    calls.push(id);
    return plan[id] ?? "registered";
  };
  return { register, calls };
}

const sink = () => {}; // silent out()

// ── 2a. Plan idempotency: 1 existing, size 3 ⇒ creates the shortfall only ─
{
  const fly = makeFly([templateMachine("existing-0")]);
  const reg = makeRegister();
  const res = await provision(
    { app: "project-hello-phone-voice", pipeline: "phone", size: 3, dryRun: false },
    { flyRequest: fly.flyRequest, register: reg.register, out: sink },
  );
  ok(res.created === 2, `1 existing + size 3 must create 2, got ${res.created}`);
  ok(res.total === 3, `total must be 3, got ${res.total}`);
  ok(res.existing === 1, `existing must be 1, got ${res.existing}`);
  ok(reg.calls.length === 3, `register must be called for all 3 machines, got ${reg.calls.length}`);
  ok(reg.calls.includes("existing-0"), "the existing machine must be registered");
  ok(res.registrations.size === 3, `registrations Map must have 3 distinct keys, got ${res.registrations.size}`);
}

// ── 2b. Re-run at capacity: 3 existing, size 3 ⇒ creates 0, STILL registers 3
// One id is a previously-unregistered ORPHAN ('registered'), two are already
// registered ('exists') — the partial-create self-heal re-registers all three.
{
  const fly = makeFly([
    templateMachine("m-a"),
    { ...templateMachine("m-b"), id: "m-b" },
    { ...templateMachine("m-c"), id: "m-c" },
  ]);
  const reg = makeRegister({ "m-a": "exists", "m-b": "exists", "m-c": "registered" });
  const res = await provision(
    { app: "project-hello-phone-voice", pipeline: "phone", size: 3, dryRun: false },
    { flyRequest: fly.flyRequest, register: reg.register, out: sink },
  );
  ok(res.created === 0, `at capacity must create 0, got ${res.created}`);
  ok(res.total === 3, `total must be 3, got ${res.total}`);
  ok(fly.counts.post === 0, `no POST may be issued at capacity, got ${fly.counts.post}`);
  ok(reg.calls.length === 3, `all 3 must be registered even with 0 created, got ${reg.calls.length}`);
  ok(res.registrations.size === 3, `registrations Map must hold all 3, got ${res.registrations.size}`);
  ok(res.registrations.get("m-a") === "exists"
    && res.registrations.get("m-b") === "exists"
    && res.registrations.get("m-c") === "registered",
    `the orphan self-heal must surface each id's status: ${JSON.stringify([...res.registrations])}`);
}

// ── 2c. Dry-run: parses --dry-run, POST never called, register never called ─
{
  const fly = makeFly([templateMachine("existing-0")]);
  const reg = makeRegister();
  const args = parseArgs(["--app", "project-hello-phone-voice", "--pipeline", "phone", "--size", "3", "--dry-run"]);
  ok(args.dryRun === true, "parseArgs must set dryRun from --dry-run");
  const res = await provision(
    args,
    { flyRequest: fly.flyRequest, register: reg.register, out: sink },
  );
  ok(fly.counts.post === 0, `dry-run must not POST, got ${fly.counts.post} POST(s)`);
  ok(reg.calls.length === 0, `dry-run must not register, got ${reg.calls.length} register call(s)`);
  ok(res.total === 3, `dry-run must still report a plan (total 3), got ${res.total}`);
  ok(res.registrations.size === 0, `dry-run registrations Map must be empty, got ${res.registrations.size}`);
}

// ── 3a. Created-machine invariants: the POST body carries the STOPPED-pool
// contract (skip_launch, restart policy 'no', auto_destroy false). ──────────
{
  const fly = makeFly([templateMachine("existing-0")]);
  const reg = makeRegister();
  await provision(
    { app: "project-hello-phone-voice", pipeline: "phone", size: 2, dryRun: false },
    { flyRequest: fly.flyRequest, register: reg.register, out: sink },
  );
  ok(fly.postBodies.length === 1, `exactly one POST for shortfall 1, got ${fly.postBodies.length}`);
  const body = fly.postBodies[0];
  ok(body.skip_launch === true, "POST body must carry skip_launch === true");
  ok(body.config && body.config.restart && body.config.restart.policy === "no",
    "POST body config.restart.policy must be 'no'");
  ok(body.config && body.config.auto_destroy === false, "POST body config.auto_destroy must be false");
}

// ── 3b. The script DIES if a created machine's returned config does NOT carry
// restart policy 'no'. setDieHandler makes die() record+throw so the process
// survives; RESET afterwards so cases don't leak. ──────────────────────────
{
  setDieHandler((msg) => { throw new Error("DIE:" + msg); });
  const fly = makeFly([templateMachine("existing-0")], { postRestartPolicy: "always" });
  const reg = makeRegister();
  let caught = null;
  try {
    await provision(
      { app: "project-hello-phone-voice", pipeline: "phone", size: 2, dryRun: false },
      { flyRequest: fly.flyRequest, register: reg.register, out: sink },
    );
  } catch (e) {
    caught = e;
  }
  // The die handler throws (DIE:...), which wins over the ProvisionDied unwind.
  ok(caught instanceof Error, "a bad restart policy must reject provision()");
  ok(caught && !(caught instanceof ProvisionDied) && /restart policy/.test(caught.message),
    `the rejection must name the restart-policy invariant, got: ${caught && caught.message}`);
  // Reset to a thrower so a later accidental die() cannot exit the test process.
  setDieHandler((msg) => { throw new ProvisionDied(msg); });
}

if (failures.length) {
  console.error(`provision-voice-worker-pool.test FAILED (${failures.length}):`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(`provision-voice-worker-pool.test OK (subprocess arg/env validation + secret-hygiene + idempotency + orphan self-heal + dry-run + created-machine invariants).`);
