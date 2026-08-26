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
//                       (the browser worker MUST stay unnamed / auto-dispatch).
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

import { readFileSync } from "node:fs";
import { APPROVED_WORKER_REGIONS, assertPolicyConsistent, checkPrimaryRegion } from "./fly-region-policy.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

ok(!hasEnvKey(browser, "PHONE_AGENT_NAME"), "fly.toml (browser) must NOT set PHONE_AGENT_NAME — the browser worker stays unnamed / auto-dispatching");
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

if (failures.length) {
  console.error(`voice worker app config contract FAILED (${failures.length}):`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
for (const n of notes) console.error(`voice worker app config note: ${n}`);
console.log("voice worker app configs valid (browser unnamed; phone named & API-dispatched; isolated; no secrets; approved deployment region across all three Fly app configs; worker<->API name agreement surfaced).");
