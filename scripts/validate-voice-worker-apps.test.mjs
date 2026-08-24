#!/usr/bin/env node
// Tests for validate-voice-worker-apps.mjs: the REAL configs must pass, and a
// battery of synthetic negative controls must each be rejected. Each fixture
// lives in its own mkdtemp directory (isolated; never asserts over a shared
// namespace) and is run through the validator as a subprocess.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  ok(/worker_regions_approved=sin/.test(out),
    "real configs must SURFACE the approved worker region allowlist as a stable code");
  ok(/region_configs_checked=fly\.toml,fly\.phone\.toml,app\/api\/fly\.toml/.test(out),
    "the region contract must cover ALL THREE Fly app configs, and say which it checked");
}

const GOOD_BROWSER = `app = "project-hello-voice"
primary_region = "sin"

[build]
  dockerfile = "Dockerfile"

[env]
  COMPANY_NAME = "Interview Kickstart"

[[vm]]
  cpus = 1
`;
const GOOD_PHONE = `app = "project-hello-phone-voice"
primary_region = "sin"

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
  // ── PR104 region contract. The phone worker regressing to the deprecated
  // `bom` is the exact release failure this contract exists to prevent, so it
  // gets its own control in BOTH configs — the browser worker shares the image
  // and the same creation-time trap.
  ["phone worker regresses to deprecated bom", GOOD_BROWSER, GOOD_PHONE.replace('primary_region = "sin"', 'primary_region = "bom"')],
  ["browser worker regresses to deprecated bom", GOOD_BROWSER.replace('primary_region = "sin"', 'primary_region = "bom"'), GOOD_PHONE],
  ["both workers on deprecated bom", GOOD_BROWSER.replace('primary_region = "sin"', 'primary_region = "bom"'), GOOD_PHONE.replace('primary_region = "sin"', 'primary_region = "bom"')],
  // Allowlist, not denylist: a region that is merely absent from the approved
  // list must be rejected too, or the next region Fly deprecates sails through.
  ["phone worker on an unapproved (not-yet-deprecated) region", GOOD_BROWSER, GOOD_PHONE.replace('primary_region = "sin"', 'primary_region = "iad"')],
  ["browser worker on an unapproved region", GOOD_BROWSER.replace('primary_region = "sin"', 'primary_region = "fra"'), GOOD_PHONE],
  // Absence is not a pass: without primary_region Fly places new machines by
  // deploy-host proximity, so "not stated" must not equal "stated correctly".
  ["phone worker omits primary_region entirely", GOOD_BROWSER, GOOD_PHONE.replace('primary_region = "sin"\n', "")],
  ["browser worker omits primary_region entirely", GOOD_BROWSER.replace('primary_region = "sin"\n', ""), GOOD_PHONE],
  // Fly matches the region code literally; a padded/upper-case value would not
  // resolve, and must not be laundered into "sin" by a lenient comparison.
  ["phone worker region is padded", GOOD_BROWSER, GOOD_PHONE.replace('primary_region = "sin"', 'primary_region = " sin "')],
  ["phone worker region is upper-case", GOOD_BROWSER, GOOD_PHONE.replace('primary_region = "sin"', 'primary_region = "SIN"')],
  // A deprecated region must stay rejected even when its case is varied — the
  // evasion a case-sensitive denylist would miss.
  ["phone worker on upper-case BOM", GOOD_BROWSER, GOOD_PHONE.replace('primary_region = "sin"', 'primary_region = "BOM"')],
  // L-3: the scanner reads the FIRST match, so a good value followed by a bad
  // one would validate on the good one. Invalid TOML that flyctl would reject
  // outright — but a checker must never be the thing that calls it fine.
  ["phone worker declares primary_region twice (sin then bom)", GOOD_BROWSER, GOOD_PHONE.replace('primary_region = "sin"', 'primary_region = "sin"\nprimary_region = "bom"')],
  ["browser worker declares primary_region twice (sin then bom)", GOOD_BROWSER.replace('primary_region = "sin"', 'primary_region = "sin"\nprimary_region = "bom"'), GOOD_PHONE],
  ["phone worker declares the app key twice", GOOD_BROWSER, GOOD_PHONE.replace('app = "project-hello-phone-voice"', 'app = "project-hello-phone-voice"\napp = "project-hello-voice"')],
];
for (const [label, browser, phone] of NEG) {
  const dir = fixture(browser, phone);
  const r = run(dir);
  ok(r.code !== 0, `negative control should FAIL but passed: ${label}`);
  rmSync(dir, { recursive: true, force: true });
}

// ── PR104: the region guard must be EFFECTIVE, not merely present ───────
// A negative control proves the validator rejects a bad region; these prove the
// guard is load-bearing — that the rejection comes from the region and nothing
// else, and that the failure names the region and its replacement so an operator
// is told what to write. A guard whose message does not identify the defect is
// how "bom" survived a review in the first place.
{
  const dir = fixture(GOOD_BROWSER, GOOD_PHONE.replace('primary_region = "sin"', 'primary_region = "bom"'));
  const r = run(dir);
  ok(r.code !== 0, "deprecated-region fixture must fail");
  ok(/fly\.phone\.toml primary_region "bom" is DEPRECATED/.test(r.out),
    `the failure must name the offending config AND region, got:\n${r.out}`);
  ok(/use "sin"/.test(r.out), `the failure must name the replacement region, got:\n${r.out}`);
  ok(!/fly\.toml primary_region/.test(r.out.replace(/fly\.phone\.toml primary_region/g, "")),
    "only the offending config may be reported — a blanket region failure would hide which file is wrong");
  rmSync(dir, { recursive: true, force: true });
}
// Isolation of the mutation: the ONLY difference between the passing and the
// failing fixture is the region string, so the rejection cannot be attributed to
// anything else in the config.
{
  const good = fixture(GOOD_BROWSER, GOOD_PHONE);
  const bad = fixture(GOOD_BROWSER, GOOD_PHONE.replace('primary_region = "sin"', 'primary_region = "bom"'));
  const rg = run(good);
  const rb = run(bad);
  ok(rg.code === 0 && rb.code !== 0,
    `a single region character change must flip the verdict (good=${rg.code}, bad=${rb.code})`);
  ok(/voice worker app config contract FAILED \(1\)/.test(rb.out),
    `the region mutation must produce EXACTLY one failure, got:\n${rb.out}`);
  rmSync(good, { recursive: true, force: true });
  rmSync(bad, { recursive: true, force: true });
}
// The policy itself must be internally consistent, and must keep naming `bom`
// as deprecated: the cheapest way to "fix" a region failure is to allowlist the
// deprecated region, and that must be impossible rather than merely discouraged.
{
  const policy = await import(pathToFileURL(path.join(here, "fly-region-policy.mjs")).href);
  ok(policy.assertPolicyConsistent().length === 0,
    `the shipped region policy must be self-consistent: ${policy.assertPolicyConsistent().join("; ")}`);
  ok(policy.APPROVED_WORKER_REGIONS.includes("sin"), "sin must be an approved worker region");
  ok(!policy.APPROVED_WORKER_REGIONS.includes("bom"), "bom must never be an approved worker region");
  ok(Object.prototype.hasOwnProperty.call(policy.DEPRECATED_REGIONS, "bom"),
    "bom must stay recorded as deprecated — dropping the record is how the regression returns");
  ok(policy.DEPRECATED_REGIONS.bom.superseded_by === "sin", "the bom record must name sin as its replacement");

  // L-2: a REAL positive control on assertPolicyConsistent itself. The check
  // above can only ever run against a policy that passes, so on its own it
  // cannot tell "no problems" from "cannot report problems". These feed it
  // deliberately broken policies and require the SPECIFIC diagnosis — the
  // failure mode, not merely a non-empty array.
  const fires = (label, approved, deprecated, pattern) => {
    const problems = policy.assertPolicyConsistent(approved, deprecated);
    ok(problems.some((p) => pattern.test(p)),
      `assertPolicyConsistent must fire on ${label}, got: ${JSON.stringify(problems)}`);
  };
  fires("a deprecated region that is also allowlisted", ["sin", "bom"], policy.DEPRECATED_REGIONS,
    /bom is both APPROVED and DEPRECATED/);
  fires("bom dropped from the deprecated record", policy.APPROVED_WORKER_REGIONS, {},
    /bom must stay recorded as DEPRECATED/);
  fires("an empty allowlist", [], policy.DEPRECATED_REGIONS,
    /APPROVED_WORKER_REGIONS is empty/);
  fires("a non-region-code entry", ["singapore"], { bom: { superseded_by: "singapore" } },
    /is not a Fly region code/);
  fires("a deprecated region pointing at an unapproved replacement", ["sin"], { bom: { superseded_by: "xyz" } },
    /must name an APPROVED superseded_by region/);
  // …and must NOT fire on a well-formed alternative policy, or it would be
  // firing on everything rather than on contradictions.
  ok(policy.assertPolicyConsistent(["sin", "iad"], { bom: { superseded_by: "sin" } }).length === 0,
    "assertPolicyConsistent must accept a well-formed policy it did not ship with");

  const contradictory = policy.checkPrimaryRegion("probe", "bom");
  ok(contradictory.length === 1 && /DEPRECATED/.test(contradictory[0]),
    "checkPrimaryRegion must reject a deprecated region with a DEPRECATED verdict");
  ok(policy.checkPrimaryRegion("probe", "sin").length === 0, "checkPrimaryRegion must accept an approved region");
  ok(policy.checkPrimaryRegion("probe", null).length === 1, "checkPrimaryRegion must reject an ABSENT region");
}

// ── M-B: the region contract covers app/api/fly.toml too ────────────────
// The API app carries the identical creation-time trap. Sweeping two configs
// out of three is how a class survives a sweep, so the third is driven here
// through the same checker, in both directions.
{
  const API_FLY = (region) => `app = "project-hello-api"\nprimary_region = "${region}"\n\n[env]\n  NODE_ENV = "production"\n\n[http_service]\n  internal_port = 8787\n`;
  const withApiFly = (apiFly) => {
    const voice = mkdtempSync(path.join(tmpdir(), "voice-apps-v-"));
    writeFileSync(path.join(voice, "fly.toml"), GOOD_BROWSER);
    writeFileSync(path.join(voice, "fly.phone.toml"), GOOD_PHONE);
    const api = mkdtempSync(path.join(tmpdir(), "voice-apps-api-"));
    writeFileSync(path.join(api, ".env.example"), "PHONE_AGENT_NAME=\n");
    if (apiFly !== null) writeFileSync(path.join(api, "fly.toml"), apiFly);
    return { voice, api };
  };
  const drive = (apiFly) => {
    const { voice, api } = withApiFly(apiFly);
    const r = run2(voice, api);
    rmSync(voice, { recursive: true, force: true });
    rmSync(api, { recursive: true, force: true });
    return r;
  };
  const good = drive(API_FLY("sin"));
  ok(good.code === 0, `an API config on an approved region must PASS: ${good.out}`);
  ok(/region_configs_checked=fly\.toml,fly\.phone\.toml,app\/api\/fly\.toml/.test(good.out),
    "the API config must be named among the region-checked configs");
  const bad = drive(API_FLY("bom"));
  ok(bad.code !== 0, `an API config on the deprecated region must FAIL: ${bad.out}`);
  ok(/app\/api\/fly\.toml primary_region "bom" is DEPRECATED/.test(bad.out),
    `the failure must name app/api/fly.toml specifically, got:\n${bad.out}`);
  ok(/voice worker app config contract FAILED \(1\)/.test(bad.out),
    `the API region mutation must produce EXACTLY one failure, got:\n${bad.out}`);
  const unapproved = drive(API_FLY("iad"));
  ok(unapproved.code !== 0, "an API config on an unapproved region must FAIL");
  const dup = drive(`app = "project-hello-api"\nprimary_region = "sin"\nprimary_region = "bom"\n\n[env]\n  NODE_ENV = "production"\n`);
  ok(dup.code !== 0, "an API config declaring primary_region twice must FAIL");
  // The real repo's API config must actually be on the approved region — the
  // synthetic controls above would pass even if the shipped file were stale.
  const realApiFly = readFileSync(path.join(here, "..", "app/api/fly.toml"), "utf8");
  ok(/^primary_region = "sin"$/m.test(realApiFly),
    "the SHIPPED app/api/fly.toml must declare primary_region = \"sin\"");
  ok(!/^primary_region = "bom"$/m.test(realApiFly),
    "the SHIPPED app/api/fly.toml must not declare the deprecated region");
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
// The synthetic API config carries an approved primary_region because the real
// one must: the region contract covers all three Fly app configs (M-B), and a
// fixture that omitted it would be testing a file shape the validator rejects.
const API_FLY_WITH = (name) => `app = "project-hello-api"\nprimary_region = "sin"\n\n[env]\n  PHONE_AGENT_NAME = "${name}"\n\n[http_service]\n  internal_port = 8080\n  min_machines_running = 1\n`;

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
console.log(`validate-voice-worker-apps.test OK (real configs + ${NEG.length} negative + region/mutation + agreement controls).`);
