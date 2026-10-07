#!/usr/bin/env node
// Deterministic validator for the two voice-worker Fly app configs AND the
// worker<->API dispatch-name agreement.
//
// The browser worker (project-hello-voice, fly.toml) and the phone worker
// (project-hello-phone-voice, fly.phone.toml) run the SAME source image with
// deliberately different run postures. This validator locks the invariants that
// keep them isolated, keeps secrets out of VCS, and — the H-1 repair — ties the
// phone worker's dispatch NAME to the API deployment that must dispatch to it,
// so the two halves can never silently disagree. Dependency-free: a minimal
// line scanner over the TOML configs and the API .env.example.
//
//   1. fly.toml       → app = project-hello-voice, and NO PHONE_AGENT_NAME key
//                       (the browser worker registers under its OWN
//                       BROWSER_AGENT_NAME when orchestration is on; carrying
//                       the PHONE name would misroute phone dispatch / conflate
//                       the two workers).
//   2. fly.phone.toml → app = project-hello-phone-voice, with a NON-EMPTY
//                       PHONE_AGENT_NAME (named worker; empty would make it a
//                       second auto-dispatching browser worker).
//   3. The two apps have distinct names.
//   4. Neither config declares a public service ([http_service] / [[services]]).
//   5. Neither config bakes a secret value or a SIP trunk: the secret env KEYS
//      must not appear in [env] at all, no [env] key may name a TRUNK (an
//      exact-key check, format-independent — a real `ST_...` id has no digit
//      run to catch), and PHONE_AGENT_NAME must be a plain dispatch identifier.
//   6. WORKER<->API NAME AGREEMENT (H-1). A named LiveKit worker receives work
//      ONLY by explicit dispatch to its name, and the API is the dispatcher.
//      The worker name (fly.phone.toml) and the API's PHONE_AGENT_NAME
//      (app/api/fly.toml [env] if it sets it, else app/api/.env.example) must
//      be in one of these states, and the state is SURFACED as a stable code:
//        both_unset            worker & API both silent            (permitted)
//        api_silent_pre_canary worker named, API silent            (permitted — CURRENT state)
//        names_agree           worker named, API names the same    (permitted — canary-ready)
//        phone_agent_name_mismatch      two different non-empty names (REJECTED)
//        api_dispatches_to_absent_worker  API named, worker silent   (REJECTED)
//      A mismatched non-empty name is never correct in either direction: the
//      API would create a room and dispatch to a name nothing registers under,
//      and "a room with no agent sits silent while a real person says hello".
//   7. DEPLOYMENT REGION (PR104). ALL THREE Fly app configs in this repo —
//      both worker configs AND app/api/fly.toml — must declare a primary_region
//      drawn from the reviewed allowlist in scripts/fly-region-policy.mjs. The
//      first release of the dedicated phone app failed BEFORE machine creation
//      because fly.phone.toml still named the deprecated `bom`; Fly recommended
//      `sin`, where every app in this project already runs. `primary_region` is
//      read when a resource is CREATED, so a deprecated value deploys green
//      against existing machines and fails only when it matters — which is why
//      it is checked statically here rather than discovered at release time.
//      The API config is in scope even though this validator is otherwise about
//      the two workers: the trap is a property of the region field, not of the
//      app, and sweeping two of three configs is how a class survives a sweep.
//   8. NO DUPLICATE top-level `app` / `primary_region` key in any config. The
//      scanner returns the FIRST match, so a file carrying both a good and a
//      bad value would validate on the good one. Duplicate keys are invalid
//      TOML and flyctl rejects the file, but a checker must not be the thing
//      that says "fine" about a file the deploy will reject.
//  10. PER-MACHINE REGISTRATION (E2, M009). PHONE_PER_MACHINE_AGENT_NAME is
//      allowed only in fly.phone.toml, and only absent or exactly "true";
//      fly.toml (browser) must never carry it. A top-level kill_timeout is
//      accepted (bare integer seconds, 1..300; >= 90 on the phone app so a
//      stop drains a live call instead of Fly's 5 s default force-kill).
//  11. SDK DRAIN BUDGET (C9-1, M009 PR-C). fly.phone.toml must declare
//      kill_timeout AND PHONE_DRAIN_TIMEOUT_SEC (30..120), and
//      drain + 2 x PHONE_SHUTDOWN_PROCESS_TIMEOUT (default 90) + 30 must be
//      <= kill_timeout. fly.toml (browser) must never carry the drain key.

import { readFileSync } from "node:fs";
import { APPROVED_WORKER_REGIONS, assertPolicyConsistent, checkPrimaryRegion } from "./fly-region-policy.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// When imported (e.g. by the test, for `checkOrchestrationPosture`) the module
// must expose its pure helpers WITHOUT running the CLI validation or calling
// process.exit. The executable body below is guarded on being the entrypoint.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Default to the real configs; directory arguments let the test drive
// synthetic fixtures through the exact same checker.
//   argv[2] → the voice-livekit dir (fly.toml, fly.phone.toml)
//   argv[3] → the API dir           (.env.example, optional fly.toml)
const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "app/voice-livekit");
const apiDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, "app/api");

const failures = [];
const notes = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

function read(rel) {
  try { return readFileSync(path.join(dir, rel), "utf8"); }
  catch { failures.push(`missing config: app/voice-livekit/${rel}`); return ""; }
}
function readApiOptional(rel) {
  try { return readFileSync(path.join(apiDir, rel), "utf8"); }
  catch { return null; }
}

// Minimal TOML helpers (sufficient for these flat configs).
function topLevelStringAll(text, key) {
  // Every `key = "value"` at column 0 (top-level table), before any [table].
  const found = [];
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break; // entered a table; app/... are top-level
    const m = line.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`));
    if (m) found.push(m[1]);
  }
  return found;
}
function topLevelString(text, key) {
  const found = topLevelStringAll(text, key);
  return found.length > 0 ? found[0] : null;
}
function envValue(text, key) {
  // value of a key inside the [env] table (2-space indented in our files).
  const lines = text.split("\n");
  let inEnv = false;
  for (const raw of lines) {
    if (/^\s*\[env\]\s*$/.test(raw)) { inEnv = true; continue; }
    if (inEnv && /^\s*\[[^\]]+\]\s*$/.test(raw)) break; // next table
    if (!inEnv) continue;
    const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`));
    if (m) return m[1];
  }
  return undefined;
}
function hasEnvKey(text, key) {
  return envValue(text, key) !== undefined;
}
/** Every KEY assigned inside the [env] table, for exact-key guards. */
function envKeys(text) {
  const keys = [];
  let inEnv = false;
  for (const raw of text.split("\n")) {
    if (/^\s*\[env\]\s*$/.test(raw)) { inEnv = true; continue; }
    if (inEnv && /^\s*\[[^\]]+\]\s*$/.test(raw)) break;
    if (!inEnv) continue;
    const m = raw.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}
/** A KEY=value line in a shell-style .env file. Returns undefined if the key is
 *  absent, "" if present-but-empty, else the (unquoted, trimmed) value. */
function envFileValue(text, key) {
  if (text === null) return undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(new RegExp(`^\\s*${key}\\s*=(.*)$`));
    if (m) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  return undefined;
}

/** Any `key = value` assignment anywhere in the file (any table), returning the
 *  raw RHS token(s). Used by the orchestration-posture check, which cares about
 *  a handful of scaling keys wherever Fly accepts them ([[vm]], [http_service],
 *  [[services]].concurrency, or a bare top-level). Deliberately format-simple:
 *  matches `key = <value>` with optional quotes, across the whole file. */
function anyValueAll(text, key) {
  const found = [];
  for (const raw of text.split("\n")) {
    const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*("?)([^"#\\n]*?)\\1\\s*(#.*)?$`));
    if (m) found.push(m[2].trim());
  }
  return found;
}

/**
 * The orchestration-posture invariant (deliverable 2). Given one worker config's
 * text, its declared orchestration state, and a label, return a list of posture
 * failures (empty ⇒ consistent).
 *
 * Two directions, both about NOT defeating the deploy gate the other lane relies
 * on:
 *   • orchestration ON  ⇒ the app MUST be able to scale to zero. A config that
 *     pins it always-on (`min_machines_running >= 1`, or auto-stop disabled)
 *     both defeats the whole cost purpose AND makes the on-demand deploy path's
 *     "start a stopped pool machine" premise false — there is no stopped machine
 *     to start, and the app never returns to zero. Rejected.
 *   • orchestration OFF ⇒ the always-on registration proof MUST stay reachable.
 *     Pinning `min_machines_running = 0` (or enabling auto-stop) on an OFF worker
 *     scales it to zero with NO orchestrator to start it on demand, so the
 *     always-on deploy job's current-registration proof would fail closed on a
 *     worker nothing is keeping up. Rejected. (Absent keys = Fly's always-on
 *     default for these worker apps, which is correct for OFF — so silence is a
 *     pass here; only an explicit scale-to-zero pin is the misconfig.)
 */
export function checkOrchestrationPosture(label, text, orchestrationOn) {
  const problems = [];
  const minRun = anyValueAll(text, "min_machines_running");
  const autoStop = anyValueAll(text, "auto_stop_machines");
  const minRunNums = minRun.map((v) => Number.parseInt(v, 10));
  const autoStopOn = autoStop.some((v) => /^(true|"?stop"?|"?suspend"?)$/i.test(v));
  const autoStopOff = autoStop.some((v) => /^(false|"?off"?)$/i.test(v));

  if (orchestrationOn) {
    // Must be able to reach zero.
    for (const n of minRunNums) {
      if (Number.isFinite(n) && n >= 1) {
        problems.push(`${label} declares WORKER_ORCHESTRATION = "worker" (on-demand) but pins min_machines_running = ${n} (>= 1); an orchestration-on app must scale to zero — the on-demand deploy path starts a STOPPED pool machine and returns it to stopped, which a min-1 pin defeats`);
      }
    }
    if (autoStopOff) {
      problems.push(`${label} declares WORKER_ORCHESTRATION = "worker" (on-demand) but disables auto_stop_machines; an orchestration-on app must be allowed to stop (scale to zero)`);
    }
  } else {
    // Must stay always-on so the current-registration proof is reachable.
    for (const n of minRunNums) {
      if (Number.isFinite(n) && n === 0) {
        problems.push(`${label} is NOT orchestration-on (WORKER_ORCHESTRATION != "worker") yet pins min_machines_running = 0; with no orchestrator to start it on demand, the always-on deploy job's CURRENT-registration proof would fail closed on a worker nothing keeps up. Either keep it always-on (remove the pin) or turn orchestration ON (WORKER_ORCHESTRATION = "worker")`);
      }
    }
    if (autoStopOn) {
      problems.push(`${label} is NOT orchestration-on yet enables auto_stop_machines; the same always-on-proof hazard as a min-0 pin — an always-on worker must not auto-stop`);
    }
  }
  return problems;
}

// ── 5f. SDK drain budget (C9-1, M009 PR-C) ───────────────────────────────
// The named phone worker sets the LiveKit SDK drain_timeout from
// PHONE_DRAIN_TIMEOUT_SEC (agent.py `_phone_drain_timeout_sec`). On a stop the
// SDK waits that long for a live job, THEN sends it a ShutdownRequest and
// gives the process its shutdown grace. All of it must fit inside Fly's
// kill_timeout, or the force-kill lands mid-upload and the recording is lost:
//   drain + 2 x PHONE_SHUTDOWN_PROCESS_TIMEOUT + 30 <= kill_timeout
// So on the phone app both kill_timeout and PHONE_DRAIN_TIMEOUT_SEC are
// REQUIRED (absent drain = the SDK's 1800 s default, which no kill_timeout can
// cover). The worker clamps drain to 30..120 and the shutdown grace to
// 10..120; the validator demands values inside those clamps rather than
// reasoning about a clamped value the file does not state. The browser app
// must not carry PHONE_DRAIN_TIMEOUT_SEC: its options are byte-identical.
export const PHONE_DRAIN_BUDGET_MARGIN_SEC = 30;
export const PHONE_SHUTDOWN_PROCESS_TIMEOUT_DEFAULT_SEC = 90;
const BARE_INT_STR = /^[0-9]+$/;
/**
 * Pure check of the phone drain budget, exported for the test. Inputs are the
 * raw strings from the config (undefined = absent). Returns a list of problems.
 */
export function checkPhoneDrainBudget({ killTimeout, drain, shutdown }) {
  const problems = [];
  if (killTimeout === undefined) {
    problems.push("fly.phone.toml must declare a top-level kill_timeout: the drain budget (PHONE_DRAIN_TIMEOUT_SEC + 2 x PHONE_SHUTDOWN_PROCESS_TIMEOUT + 30) has to fit inside it");
  }
  if (drain === undefined) {
    problems.push("fly.phone.toml must set PHONE_DRAIN_TIMEOUT_SEC in [env]; absent, the SDK drains for its 1800 s default and Fly force-kills a live call before its teardown runs");
  } else if (!BARE_INT_STR.test(drain)) {
    problems.push(`fly.phone.toml PHONE_DRAIN_TIMEOUT_SEC must be a whole number of seconds (got ${JSON.stringify(drain)})`);
  } else {
    const d = Number.parseInt(drain, 10);
    if (d < 30 || d > 120) {
      problems.push(`fly.phone.toml PHONE_DRAIN_TIMEOUT_SEC must be within the worker clamp 30..120 (got ${drain})`);
    }
  }
  let shutdownSecs = PHONE_SHUTDOWN_PROCESS_TIMEOUT_DEFAULT_SEC;
  if (shutdown !== undefined) {
    if (!BARE_INT_STR.test(shutdown)) {
      problems.push(`fly.phone.toml PHONE_SHUTDOWN_PROCESS_TIMEOUT must be a whole number of seconds (got ${JSON.stringify(shutdown)})`);
      shutdownSecs = Number.NaN;
    } else {
      shutdownSecs = Number.parseInt(shutdown, 10);
      if (shutdownSecs < 10 || shutdownSecs > 120) {
        problems.push(`fly.phone.toml PHONE_SHUTDOWN_PROCESS_TIMEOUT must be within the worker clamp 10..120 (got ${shutdown})`);
      }
    }
  }
  if (problems.length === 0) {
    const kill = Number.parseInt(String(killTimeout), 10);
    const d = Number.parseInt(drain, 10);
    const need = d + 2 * shutdownSecs + PHONE_DRAIN_BUDGET_MARGIN_SEC;
    if (!(Number.isFinite(kill) && need <= kill)) {
      problems.push(`fly.phone.toml drain budget exceeds kill_timeout: PHONE_DRAIN_TIMEOUT_SEC ${d} + 2 x PHONE_SHUTDOWN_PROCESS_TIMEOUT ${shutdownSecs} + ${PHONE_DRAIN_BUDGET_MARGIN_SEC} = ${need} > kill_timeout ${killTimeout}; Fly would force-kill the job before its evidence upload finishes`);
    }
  }
  return problems;
}

/**
 * R1 has its own shutdown budget and is never valid on the phone app.
 *
 * While R1 is dormant (mode absent, "off" or unknown) the browser app declares none
 * of it, so the live legacy lane keeps Fly's default stop behaviour. The change that
 * selects R1 (mode "r1_only", compared exactly like the worker's own predicate: trimmed)
 * must declare kill_timeout and both drain settings in the same file.
 */
export function checkR1DrainBudget({ killTimeout, drain, shutdown, mode }) {
  const problems = [];
  if (String(mode ?? "").trim() === "r1_only"
    && (killTimeout === undefined || drain === undefined || shutdown === undefined)) {
    problems.push("fly.toml R1_LANE_MODE=r1_only requires kill_timeout, R1_DRAIN_TIMEOUT_SEC and R1_SHUTDOWN_PROCESS_TIMEOUT_SEC to be declared together");
    return problems;
  }
  if (drain === undefined && shutdown === undefined) return problems;
  if (killTimeout === undefined) {
    problems.push("fly.toml must declare kill_timeout when R1 drain settings are present");
    return problems;
  }
  if (!BARE_INT_STR.test(String(drain ?? "")) || !BARE_INT_STR.test(String(shutdown ?? ""))) {
    problems.push("fly.toml R1_DRAIN_TIMEOUT_SEC and R1_SHUTDOWN_PROCESS_TIMEOUT_SEC must be whole seconds");
    return problems;
  }
  const d = Number.parseInt(drain, 10), s = Number.parseInt(shutdown, 10);
  if (d < 30 || d > 60 || s < 30 || s > 90) {
    problems.push("fly.toml R1 drain settings must be within worker bounds (drain 30..60, shutdown 30..90)");
    return problems;
  }
  const need = d + 2 * s + PHONE_DRAIN_BUDGET_MARGIN_SEC;
  if (need > Number.parseInt(killTimeout, 10)) {
    problems.push(`fly.toml R1 drain budget exceeds kill_timeout: R1_DRAIN_TIMEOUT_SEC ${drain} + 2 x R1_SHUTDOWN_PROCESS_TIMEOUT_SEC ${shutdown} + ${PHONE_DRAIN_BUDGET_MARGIN_SEC} = ${need} > kill_timeout ${killTimeout}`);
  }
  return problems;
}

if (isMain) {
const browser = read("fly.toml");
const phoneCfg = read("fly.phone.toml");

// ── 1 & 2. App identity and named/unnamed posture ────────────────────────
const browserApp = topLevelString(browser, "app");
const phoneApp = topLevelString(phoneCfg, "app");
for (const [label, text] of [["fly.toml", browser], ["fly.phone.toml", phoneCfg]]) {
  const appKeys = topLevelStringAll(text, "app");
  ok(appKeys.length <= 1, `${label} declares the top-level app key ${appKeys.length} times — a duplicate key is invalid TOML and hides which app would be deployed`);
}
ok(browserApp === "project-hello-voice", `fly.toml app must be project-hello-voice (got ${browserApp})`);
ok(phoneApp === "project-hello-phone-voice", `fly.phone.toml app must be project-hello-phone-voice (got ${phoneApp})`);

ok(!hasEnvKey(browser, "PHONE_AGENT_NAME"), "fly.toml (browser) must NOT set PHONE_AGENT_NAME — the browser worker registers under its own BROWSER_AGENT_NAME; carrying the phone name would misroute phone dispatch");
ok(!hasEnvKey(browser, "BROWSER_WORKER_ONE_JOB"), "fly.toml must leave BROWSER_WORKER_ONE_JOB absent until the reviewed R1 cutover sets its exact on value");
ok(!hasEnvKey(phoneCfg, "BROWSER_WORKER_ONE_JOB"), "fly.phone.toml must NOT set BROWSER_WORKER_ONE_JOB — the one-job browser gate is never a phone setting");
ok(!hasEnvKey(browser, "R1_READINESS_HOST"), "fly.toml must leave R1_READINESS_HOST absent: the live Cloud browser worker is already named and orchestrated, and this opt-in (post-registration readiness + the livekit_host report) is set only at the reviewed R1 cutover, after the host-aware API is deployed — shipping it in fly.toml would change the live Cloud lane and break it against an older API's strict /ready-machine schema");
ok(!hasEnvKey(phoneCfg, "R1_READINESS_HOST"), "fly.phone.toml must NOT set R1_READINESS_HOST — the R1 readiness contract is browser-only and never a phone setting");
for (const key of envKeys(phoneCfg)) {
  ok(!key.startsWith("R1_"), `fly.phone.toml must NOT set ${key}; R1 belongs only to the browser worker`);
}
const phoneName = envValue(phoneCfg, "PHONE_AGENT_NAME");
ok(typeof phoneName === "string" && phoneName.trim().length > 0, "fly.phone.toml must set a NON-EMPTY PHONE_AGENT_NAME (named worker)");

// ── 3. Distinct apps ──────────────────────────────────────────────────────
ok(browserApp && phoneApp && browserApp !== phoneApp, "browser and phone workers must be distinct Fly apps");

// ── 4. No public service on either worker ────────────────────────────────
for (const [label, text] of [["fly.toml", browser], ["fly.phone.toml", phoneCfg]]) {
  ok(!/^\s*\[http_service\]/m.test(text), `${label} must not declare an [http_service] (worker, no public ingress)`);
  ok(!/^\s*\[\[services\]\]/m.test(text), `${label} must not declare [[services]] (worker, no public ingress)`);
}

// ── 5. No secret values or trunk baked into either config ─────────────────
const FORBIDDEN_SECRET_KEYS = [
  "GEMINI_API_KEY", "SARVAM_API_KEY",
  "DEEPSEEK_API_KEY",
  "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WORKER_CONTEXT_SECRET",
  // L-1: the SIP trunk is an API-side runtime secret and must never be baked
  // into a worker config. Exact-key, so a real `ST_...` id (no digit run) is
  // caught where the old value-shape regex could not.
  "PHONE_SIP_TRUNK_ID",
];
for (const [label, text] of [["fly.toml", browser], ["fly.phone.toml", phoneCfg]]) {
  for (const key of FORBIDDEN_SECRET_KEYS) {
    ok(!hasEnvKey(text, key), `${label} must not bake secret env ${key} (inject as a runtime Fly app secret)`);
  }
  // Any future *TRUNK* key, by exact key rather than value shape.
  for (const k of envKeys(text)) {
    ok(!/TRUNK/i.test(k), `${label} must not carry a SIP trunk key (${k}); a trunk is a runtime Fly app secret, never [env]`);
  }
  // Belt-and-braces: a digit-run trunk value under any TRUNK key.
  ok(!/TRUNK\S*\s*=\s*"[^"]*[0-9]{7,}[^"]*"/i.test(text), `${label} must not carry a SIP trunk value`);
}

// ── 5b. PHONE_AGENT_NAME is a plain dispatch name, not a number/secret ───
if (typeof phoneName === "string") {
  ok(!/[0-9]{7,}/.test(phoneName), "PHONE_AGENT_NAME must be a dispatch name, not a phone/trunk number");
  ok(/^[A-Za-z][A-Za-z0-9_-]*$/.test(phoneName.trim()), "PHONE_AGENT_NAME must be a simple identifier");
}

// ── 5d. Per-machine registration flag (E2, M009) ─────────────────────────
// PHONE_PER_MACHINE_AGENT_NAME makes the PHONE worker register as
// `<PHONE_AGENT_NAME>-<FLY_MACHINE_ID>` so the API can dispatch a leased
// session to exactly its leased machine. Phone app: absent (PR-A, the shared
// name) or exactly "true" — any other value is a typo the worker silently
// reads as OFF, which would look like a rollout that never happened. Browser
// app: never — the browser worker has no per-machine dispatch, and the key
// there could only be a copy-paste from the phone config.
ok(!hasEnvKey(browser, "PHONE_PER_MACHINE_AGENT_NAME"),
  "fly.toml (browser) must NOT set PHONE_PER_MACHINE_AGENT_NAME — per-machine registration is a phone-worker-only rollout flag");
{
  const perMachine = envValue(phoneCfg, "PHONE_PER_MACHINE_AGENT_NAME");
  ok(perMachine === undefined || perMachine === "true",
    `fly.phone.toml PHONE_PER_MACHINE_AGENT_NAME must be absent or exactly "true" (got ${JSON.stringify(perMachine)})`);
  notes.push(`phone_per_machine_agent_name=${perMachine === "true" ? "on" : "off"}`);
}

// ── 5e. kill_timeout (E2, M009) ──────────────────────────────────────────
// Fly's default 5 s force-kill defeats the SDK drain, so the phone app sets a
// top-level kill_timeout. Accepted on either config; when present it must be a
// single top-level bare integer in seconds. On the PHONE app it must cover the
// parent's PHONE_SHUTDOWN_PROCESS_TIMEOUT grace (90 s) and stay within Fly's
// documented 300 s maximum — a value Fly refuses would fail the deploy late.
function topLevelRawAll(text, key) {
  const found = [];
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const m = line.replace(/\r$/, "").match(new RegExp(`^${key}\\s*=\\s*([^#]*?)\\s*(#.*)?$`));
    if (m) found.push(m[1]);
  }
  return found;
}
for (const [label, text, isPhone] of [["fly.toml", browser, false], ["fly.phone.toml", phoneCfg, true]]) {
  const declared = topLevelRawAll(text, "kill_timeout");
  // A kill_timeout nested under a table is not the app-level setting Fly reads.
  const anywhere = anyValueAll(text, "kill_timeout").length;
  ok(anywhere === declared.length,
    `${label} declares kill_timeout inside a table; it must be a top-level key to apply to the app`);
  ok(declared.length <= 1, `${label} declares kill_timeout ${declared.length} times — a duplicate key is invalid TOML`);
  if (declared.length !== 1) continue;
  const raw = declared[0];
  ok(/^[0-9]+$/.test(raw), `${label} kill_timeout must be a bare integer number of seconds (got ${raw})`);
  const secs = Number.parseInt(raw, 10);
  ok(secs >= 1 && secs <= 300, `${label} kill_timeout must be within Fly's 1..300 s range (got ${raw})`);
  if (isPhone) {
    ok(secs >= 90, `fly.phone.toml kill_timeout must be >= 90 s so a stop drains the phone worker (PHONE_SHUTDOWN_PROCESS_TIMEOUT) instead of force-killing a live call (got ${raw})`);
  }
}

// ── 5f. SDK drain budget (C9-1); the check itself is checkPhoneDrainBudget above.
{
  ok(!hasEnvKey(browser, "PHONE_DRAIN_TIMEOUT_SEC"),
    "fly.toml (browser) must NOT set PHONE_DRAIN_TIMEOUT_SEC — the SDK drain bound is a phone-worker-only option");
  const killDeclared = topLevelRawAll(phoneCfg, "kill_timeout");
  const killTimeout = killDeclared.length === 1 && /^[0-9]+$/.test(killDeclared[0])
    ? killDeclared[0]
    : (killDeclared.length === 0 ? undefined : "invalid");
  // An invalid/duplicate kill_timeout is already reported by 5e; do not
  // double-report it as "absent" here.
  if (killTimeout !== "invalid") {
    for (const problem of checkPhoneDrainBudget({
      killTimeout,
      drain: envValue(phoneCfg, "PHONE_DRAIN_TIMEOUT_SEC"),
      shutdown: envValue(phoneCfg, "PHONE_SHUTDOWN_PROCESS_TIMEOUT"),
    })) ok(false, problem);
  }
  const drainNote = envValue(phoneCfg, "PHONE_DRAIN_TIMEOUT_SEC");
  notes.push(`phone_drain_timeout_sec=${drainNote === undefined ? "absent" : drainNote}`);
}

{
  const declared = topLevelRawAll(browser, "kill_timeout");
  const killTimeout = declared.length === 1 && /^[0-9]+$/.test(declared[0]) ? declared[0] : undefined;
  for (const problem of checkR1DrainBudget({
    killTimeout,
    drain: envValue(browser, "R1_DRAIN_TIMEOUT_SEC"),
    shutdown: envValue(browser, "R1_SHUTDOWN_PROCESS_TIMEOUT_SEC"),
    mode: envValue(browser, "R1_LANE_MODE"),
  })) ok(false, problem);
}

// ── 5c. Deployment region contract (PR104) ───────────────────────────────
// The policy is validated before it is applied: a self-contradicting allowlist
// (a deprecated region also listed as approved, or `bom` quietly dropped from
// the deprecated record) would report green while permitting the exact
// regression this check exists to prevent.
for (const problem of assertPolicyConsistent()) ok(false, problem);

// Every Fly app config this repo owns, not only the two workers. The API app is
// included because the creation-time trap belongs to the field, not to the app
// — and because a class swept in two files out of three is not swept.
const apiFlyText = readApiOptional("fly.toml");
const REGION_SCOPED = [
  ["fly.toml", browser],
  ["fly.phone.toml", phoneCfg],
  ...(apiFlyText !== null ? [["app/api/fly.toml", apiFlyText]] : []),
];
for (const [label, text] of REGION_SCOPED) {
  const declared = topLevelStringAll(text, "primary_region");
  // Duplicate-key fail-closed: the scanner reads the first value, so a file
  // carrying `sin` then `bom` would validate on the `sin`. Refuse instead.
  ok(declared.length <= 1,
    `${label} declares primary_region ${declared.length} times (${declared.map((v) => JSON.stringify(v)).join(", ")}); `
    + "a duplicate key is invalid TOML and hides the value that would actually apply");
  if (declared.length > 1) continue;
  for (const problem of checkPrimaryRegion(label, declared[0] ?? null)) ok(false, problem);
}
// The API config being ABSENT must not be a silent pass in the default (real)
// invocation: that is the file whose region this contract was extended to hold.
ok(process.argv[3] !== undefined || apiFlyText !== null,
  "app/api/fly.toml is missing — the region contract covers all three Fly app configs and cannot verify one it cannot read");
notes.push(`worker_regions_approved=${APPROVED_WORKER_REGIONS.join(",")}`);
notes.push(`region_configs_checked=${REGION_SCOPED.map(([l]) => l).join(",")}`);

// ── 6. Worker <-> API dispatch-name agreement (H-1) ──────────────────────
// The API is the dispatcher. Read the name it will dispatch under: fly.toml
// [env] is the deploy authority when it sets the key, else the documented
// .env.example. A worker named with no API counterpart is the CURRENT,
// permitted pre-canary state; two non-empty names that differ (either
// direction) is a silent-failure wire and is rejected.
const apiFlyName = envValue(readApiOptional("fly.toml") ?? "", "PHONE_AGENT_NAME");
const apiEnvName = envFileValue(readApiOptional(".env.example"), "PHONE_AGENT_NAME");
const apiName = apiFlyName !== undefined ? apiFlyName : (apiEnvName ?? "");

const w = (typeof phoneName === "string" ? phoneName.trim() : "");
const a = (apiName || "").trim();
let agreementState;
if (w === "" && a === "") agreementState = "both_unset";
else if (w !== "" && a === "") agreementState = "api_silent_pre_canary";
else if (w !== "" && a !== "" && w === a) agreementState = "names_agree";
else if (w === "" && a !== "") agreementState = "api_dispatches_to_absent_worker";
else agreementState = "phone_agent_name_mismatch";

const AGREEMENT_OK = agreementState === "both_unset"
  || agreementState === "api_silent_pre_canary"
  || agreementState === "names_agree";
ok(AGREEMENT_OK,
  `phone_agent_name_state=${agreementState}: the phone worker name and the API's `
  + "PHONE_AGENT_NAME must be identical, or the API must be silent (pre-canary). "
  + "A mismatched non-empty name in EITHER direction dispatches into silence.");
// Surface the state as a stable code even on success — the pre-canary silent
// state must be visible/auditable, not merely absent (H-1 was invisible before).
notes.push(`phone_agent_name_state=${agreementState}`);

// ── 9. Orchestration posture (deliverable 2) ─────────────────────────────
// An app that declares on-demand orchestration must be able to scale to zero
// (no always-on pin), and an always-on worker must not be pinned to zero — the
// deploy gate's always-on registration proof depends on it staying up. The
// signal is the SAME exact string the worker runtime and the deploy workflow
// read: WORKER_ORCHESTRATION = "worker" in [env].
const browserOrchOn = envValue(browser, "WORKER_ORCHESTRATION") === "worker";
const phoneOrchOn = envValue(phoneCfg, "WORKER_ORCHESTRATION") === "worker";
for (const problem of checkOrchestrationPosture("fly.toml", browser, browserOrchOn)) ok(false, problem);
for (const problem of checkOrchestrationPosture("fly.phone.toml", phoneCfg, phoneOrchOn)) ok(false, problem);
notes.push(`orchestration_state=browser:${browserOrchOn ? "worker" : "off"},phone:${phoneOrchOn ? "worker" : "off"}`);

if (failures.length) {
  console.error(`voice worker app config contract FAILED (${failures.length}):`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
for (const n of notes) console.error(`voice worker app config note: ${n}`);
console.log("voice worker app configs valid (both workers named & API-dispatched when orchestration on; isolated; no secrets; approved deployment region across all three Fly app configs; worker<->API name agreement surfaced; orchestration posture consistent with scale-to-zero vs always-on).");
} // end if (isMain)
