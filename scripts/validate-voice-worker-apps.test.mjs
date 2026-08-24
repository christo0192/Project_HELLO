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

// 1. The real configs must pass (no dir arg → defaults to app/voice-livekit).
{
  const r = spawnSync(process.execPath, [validator], { encoding: "utf8" });
  ok(r.status === 0, `real voice worker configs must pass, got:\n${r.stdout}${r.stderr}`);
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
];
for (const [label, browser, phone] of NEG) {
  const dir = fixture(browser, phone);
  const r = run(dir);
  ok(r.code !== 0, `negative control should FAIL but passed: ${label}`);
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`validate-voice-worker-apps.test FAILED (${failures.length}):`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(`validate-voice-worker-apps.test OK (real configs + ${NEG.length} negative controls).`);
