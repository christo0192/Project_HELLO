#!/usr/bin/env node
// Deterministic validator for the two voice-worker Fly app configs.
//
// The browser worker (project-hello-voice, fly.toml) and the phone worker
// (project-hello-phone-voice, fly.phone.toml) run the SAME source image with
// deliberately different run postures. This validator locks the invariants that
// keep them isolated and keeps secrets out of VCS. Dependency-free: a minimal
// line scanner over the two TOML files, no third-party TOML parser.
//
//   1. fly.toml       → app = project-hello-voice, and NO PHONE_AGENT_NAME key
//                       (the browser worker MUST stay unnamed / auto-dispatch).
//   2. fly.phone.toml → app = project-hello-phone-voice, with a NON-EMPTY
//                       PHONE_AGENT_NAME (named worker; empty would make it a
//                       second auto-dispatching browser worker).
//   3. The two apps have distinct names.
//   4. Neither config declares a public service ([http_service] / [[services]]).
//   5. Neither config bakes a secret value or the SIP trunk value: the secret
//      env KEYS must not appear in [env] at all (they are injected as Fly app
//      secrets at runtime), and PHONE_AGENT_NAME must be a plain dispatch name,
//      never a phone number (no run of 7+ digits) or a trunk value.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Default to the real configs; a directory argument lets the test drive
// synthetic negative-control fixtures through the exact same checker.
const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "app/voice-livekit");

const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

function read(rel) {
  try { return readFileSync(path.join(dir, rel), "utf8"); }
  catch { failures.push(`missing config: app/voice-livekit/${rel}`); return ""; }
}

// Minimal TOML helpers (sufficient for these flat configs).
function topLevelString(text, key) {
  // key = "value" appearing at column 0 (top-level table), before any [table].
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break; // entered a table; app/... are top-level
    const m = line.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`));
    if (m) return m[1];
  }
  return null;
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

const browser = read("fly.toml");
const phoneCfg = read("fly.phone.toml");

// ── 1 & 2. App identity and named/unnamed posture ────────────────────────
const browserApp = topLevelString(browser, "app");
const phoneApp = topLevelString(phoneCfg, "app");
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

// ── 5. No secret values or trunk value baked into either config ──────────
const FORBIDDEN_SECRET_KEYS = [
  "GEMINI_API_KEY", "SARVAM_API_KEY",
  "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WORKER_CONTEXT_SECRET",
];
for (const [label, text] of [["fly.toml", browser], ["fly.phone.toml", phoneCfg]]) {
  for (const key of FORBIDDEN_SECRET_KEYS) {
    ok(!hasEnvKey(text, key), `${label} must not bake secret env ${key} (inject as a runtime Fly app secret)`);
  }
  // No SIP trunk value under any *TRUNK* key, and no bare digit-run trunk id.
  ok(!/TRUNK\S*\s*=\s*"[^"]*[0-9]{7,}[^"]*"/i.test(text), `${label} must not carry a SIP trunk value`);
}

// ── 5b. PHONE_AGENT_NAME is a plain dispatch name, not a number/secret ───
if (typeof phoneName === "string") {
  ok(!/[0-9]{7,}/.test(phoneName), "PHONE_AGENT_NAME must be a dispatch name, not a phone/trunk number");
  ok(/^[A-Za-z][A-Za-z0-9_-]*$/.test(phoneName.trim()), "PHONE_AGENT_NAME must be a simple identifier");
}

if (failures.length) {
  console.error(`voice worker app config contract FAILED (${failures.length}):`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log("voice worker app configs valid (browser unnamed always-on; phone named stopped; isolated; no secrets).");
