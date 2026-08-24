#!/usr/bin/env node
// Tests for validate-voice-worker-apps.mjs: the REAL configs must pass, and a
// battery of synthetic negative controls must each be rejected. Each fixture
// lives in its own mkdtemp directory (isolated; never asserts over a shared
// namespace) and is run through the validator as a subprocess.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(here, "validate-voice-worker-apps.mjs");

const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

function run(dir) {
  const r = spawnSync(process.execPath, [validator, dir], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function run2(voiceDir, apiDir) {
  const r = spawnSync(process.execPath, [validator, voiceDir, apiDir], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// 1. The real configs must pass (no dir arg → defaults to app/voice-livekit +
//    the real app/api). The current state is worker-named / API-silent.
{
  const r = spawnSync(process.execPath, [validator], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  ok(r.status === 0, `real voice worker configs must pass, got:\n${out}`);
  ok(/phone_agent_name_state=api_silent_pre_canary/.test(out),
    "real configs must SURFACE the pre-canary silent state as a stable code");
}

const GOOD_BROWSER = `app = "project-hello-voice"
primary_region = "bom"

[build]
  dockerfile = "Dockerfile"

[env]
  COMPANY_NAME = "Interview Kickstart"

[[vm]]
  cpus = 1
`;
const GOOD_PHONE = `app = "project-hello-phone-voice"
primary_region = "bom"

[build]
  dockerfile = "Dockerfile"

[env]
  COMPANY_NAME = "Interview Kickstart"
  PHONE_AGENT_NAME = "phone-screener"

[[vm]]
  cpus = 1
`;

function fixture(browser, phone) {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-apps-"));
  if (browser !== null) writeFileSync(path.join(dir, "fly.toml"), browser);
  if (phone !== null) writeFileSync(path.join(dir, "fly.phone.toml"), phone);
  return dir;
}

// Positive control: a clean synthetic pair passes.
{
  const dir = fixture(GOOD_BROWSER, GOOD_PHONE);
  const r = run(dir);
  ok(r.code === 0, `clean synthetic pair should pass: ${r.out}`);
  rmSync(dir, { recursive: true, force: true });
}

// Negative controls — each must be rejected (non-zero exit).
const NEG = [
  ["browser names itself (would stop auto-dispatch)", GOOD_BROWSER.replace("[env]\n", '[env]\n  PHONE_AGENT_NAME = "oops"\n'), GOOD_PHONE],
  ["phone worker unnamed (empty)", GOOD_BROWSER, GOOD_PHONE.replace('PHONE_AGENT_NAME = "phone-screener"', 'PHONE_AGENT_NAME = ""')],
  ["phone worker missing PHONE_AGENT_NAME", GOOD_BROWSER, GOOD_PHONE.replace('  PHONE_AGENT_NAME = "phone-screener"\n', "")],
  ["wrong browser app name", GOOD_BROWSER.replace("project-hello-voice", "project-hello-somethingelse"), GOOD_PHONE],
  ["wrong phone app name", GOOD_BROWSER, GOOD_PHONE.replace("project-hello-phone-voice", "project-hello-voice")],
  ["phone declares a public http_service", GOOD_BROWSER, GOOD_PHONE + '\n[http_service]\n  internal_port = 8080\n'],
  ["phone declares [[services]]", GOOD_BROWSER, GOOD_PHONE + '\n[[services]]\n  internal_port = 8080\n'],
  ["baked LIVEKIT_API_SECRET", GOOD_BROWSER, GOOD_PHONE.replace("[env]\n", '[env]\n  LIVEKIT_API_SECRET = "sk_live_abc"\n')],
  ["baked SUPABASE_SERVICE_ROLE_KEY", GOOD_BROWSER, GOOD_PHONE.replace("[env]\n", '[env]\n  SUPABASE_SERVICE_ROLE_KEY = "eyJ.secret"\n')],
  ["SIP trunk value baked", GOOD_BROWSER, GOOD_PHONE.replace("[env]\n", '[env]\n  SIP_TRUNK_ID = "trunk-9998887776"\n')],
  ["PHONE_AGENT_NAME is a phone number", GOOD_BROWSER, GOOD_PHONE.replace('"phone-screener"', '"919876543210"')],
  ["missing phone config entirely", GOOD_BROWSER, null],
  // L-1: a REAL-shaped SIP trunk id has no 7+ digit run — the old value regex
  // missed it. The exact-key guard must reject it regardless of value shape.
  ["baked PHONE_SIP_TRUNK_ID (ST_ format, no digit run)", GOOD_BROWSER, GOOD_PHONE.replace("[env]\n", '[env]\n  PHONE_SIP_TRUNK_ID = "ST_a1b2c3d4e5f6"\n')],
  ["baked a future *_TRUNK_* key (arn value)", GOOD_BROWSER, GOOD_PHONE.replace("[env]\n", '[env]\n  MY_TRUNK_ARN = "arn:aws:chime:trunk/abc"\n')],
];
for (const [label, browser, phone] of NEG) {
  const dir = fixture(browser, phone);
  const r = run(dir);
  ok(r.code !== 0, `negative control should FAIL but passed: ${label}`);
  rmSync(dir, { recursive: true, force: true });
}

// ── H-1: worker <-> API dispatch-name agreement ─────────────────────────
// These drive BOTH the voice-livekit dir AND a synthetic API dir (argv[3]),
// so the agreement can be exercised in every state without touching real files.
function fixture2(browser, phone, apiEnvExample, apiFlyToml) {
  const voice = mkdtempSync(path.join(tmpdir(), "voice-apps-v-"));
  writeFileSync(path.join(voice, "fly.toml"), browser);
  writeFileSync(path.join(voice, "fly.phone.toml"), phone);
  const api = mkdtempSync(path.join(tmpdir(), "voice-apps-api-"));
  if (apiEnvExample !== null) writeFileSync(path.join(api, ".env.example"), apiEnvExample);
  if (apiFlyToml) writeFileSync(path.join(api, "fly.toml"), apiFlyToml);
  return { voice, api };
}
const PHONE_NAMED_DIFF = GOOD_PHONE.replace('"phone-screener"', '"totally-different-name"');
const API_FLY_WITH = (name) => `app = "project-hello-api"\n\n[env]\n  PHONE_AGENT_NAME = "${name}"\n\n[http_service]\n  internal_port = 8080\n  min_machines_running = 1\n`;

// Positive: the CURRENT state — worker named, API .env.example silent — passes
// AND surfaces the code (H-1 requires the pre-canary state be visible).
{
  const { voice, api } = fixture2(GOOD_BROWSER, GOOD_PHONE, "PHONE_AGENT_NAME=\n", null);
  const r = run2(voice, api);
  ok(r.code === 0, `api_silent_pre_canary must PASS: ${r.out}`);
  ok(/phone_agent_name_state=api_silent_pre_canary/.test(r.out), "api_silent_pre_canary must be surfaced");
  rmSync(voice, { recursive: true, force: true }); rmSync(api, { recursive: true, force: true });
}
// Positive: API names the SAME worker (canary-ready) — via .env.example.
{
  const { voice, api } = fixture2(GOOD_BROWSER, GOOD_PHONE, "PHONE_AGENT_NAME=phone-screener\n", null);
  const r = run2(voice, api);
  ok(r.code === 0, `names_agree (.env.example) must PASS: ${r.out}`);
  ok(/phone_agent_name_state=names_agree/.test(r.out), "names_agree must be surfaced");
  rmSync(voice, { recursive: true, force: true }); rmSync(api, { recursive: true, force: true });
}
// Positive: agreement asserted through the API fly.toml [env] AUTHORITY, even
// when .env.example is still silent (deploy authority wins).
{
  const { voice, api } = fixture2(GOOD_BROWSER, GOOD_PHONE, "PHONE_AGENT_NAME=\n", API_FLY_WITH("phone-screener"));
  const r = run2(voice, api);
  ok(r.code === 0, `names_agree via fly.toml authority must PASS: ${r.out}`);
  rmSync(voice, { recursive: true, force: true }); rmSync(api, { recursive: true, force: true });
}
// Negative controls — mismatched non-empty names, BOTH directions, and both API sources.
const AGREE_NEG = [
  ["mismatch: worker named, API .env.example names a DIFFERENT worker", GOOD_PHONE, "PHONE_AGENT_NAME=some-other-name\n", null],
  ["mismatch: worker named, API fly.toml AUTHORITY names a different worker", GOOD_PHONE, "PHONE_AGENT_NAME=phone-screener\n", API_FLY_WITH("wrong-name")],
  ["mismatch: worker named X, API named Y (both via .env.example)", PHONE_NAMED_DIFF, "PHONE_AGENT_NAME=phone-screener\n", null],
  ["other direction: API names a worker that is silent (worker empty)", GOOD_PHONE.replace('"phone-screener"', '""'), "PHONE_AGENT_NAME=phone-screener\n", null],
];
for (const [label, phone, apiEnv, apiFly] of AGREE_NEG) {
  const { voice, api } = fixture2(GOOD_BROWSER, phone, apiEnv, apiFly);
  const r = run2(voice, api);
  ok(r.code !== 0, `agreement negative control should FAIL but passed: ${label}\n${r.out}`);
  rmSync(voice, { recursive: true, force: true }); rmSync(api, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`validate-voice-worker-apps.test FAILED (${failures.length}):`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(`validate-voice-worker-apps.test OK (real configs + ${NEG.length} negative + agreement controls).`);
