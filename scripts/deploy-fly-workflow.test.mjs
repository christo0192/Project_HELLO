#!/usr/bin/env node
// Deterministic contract tests for .github/workflows/deploy-fly.yml.
//
// This workflow is production security code (it holds deploy tokens and pushes
// to Fly). These tests lock its security-relevant contract so a future edit
// cannot silently weaken it. Dependency-free: text + per-job assertions only.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wfPath = path.join(root, ".github/workflows/deploy-fly.yml");
const wf = readFileSync(wfPath, "utf8");

const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

// ── Split into top-level job blocks (2-space indented keys under jobs:) ──
function jobBlock(name) {
  const lines = wf.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i]) || /^[A-Za-z]/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}
const detect = jobBlock("detect");
const migration = jobBlock("migrate-production");
const api = jobBlock("deploy-api");
const voice = jobBlock("deploy-browser-voice");
const phone = jobBlock("deploy-phone-voice");
ok(
  detect && migration && api && voice && phone,
  "expected detect, migrate-production, deploy-api, deploy-browser-voice, deploy-phone-voice jobs to exist",
);

// 1. main-success gating + failed-Quality → no deploy
ok(/workflow_run\.conclusion == 'success'/.test(detect), "gate must require Quality conclusion == success (failed/cancelled must not deploy)");
ok(/workflow_run\.event == 'push'/.test(detect), "gate must require the Quality run's event == push");
ok(/workflow_run\.head_branch == 'main'/.test(detect), "gate must require head_branch == main");

// 2. Trigger is the Quality workflow completing
ok(/workflow_run:/.test(wf) && /workflows:\s*\["Quality"\]/.test(wf), "must trigger on workflow_run of \"Quality\"");
ok(/types:\s*\[completed\]/.test(wf), "workflow_run must listen to completed");

// 3. Path selection
ok(/grep -qE '\^app\/api\//.test(detect), "detect must select the API service by app/api/ path");
ok(/grep -qE '\^app\/voice-livekit\//.test(detect), "detect must select the voice services by app/voice-livekit/ path");
ok(/if:\s*needs\.detect\.outputs\.api == 'true'/.test(api), "deploy-api must gate on detect.outputs.api == true");
ok(/if:\s*needs\.detect\.outputs\.voice == 'true'/.test(voice), "deploy-browser-voice must gate on detect.outputs.voice == true");
ok(/if:\s*needs\.detect\.outputs\.phone == 'true'/.test(phone), "deploy-phone-voice must gate on detect.outputs.phone == true");
ok(/\^app\/supabase\/migrations\//.test(detect), "detect must select production migrations by app/supabase/migrations/ path");
ok(/database=true/.test(detect), "application/manual deploys must request migration convergence");

// 3b. Shared voice source deploys BOTH voice apps (browser + phone), and the
// detect job declares both outputs.
ok(/api:\s*\$\{\{\s*steps\.decide\.outputs\.api\s*\}\}/.test(detect), "detect must output api");
ok(/voice:\s*\$\{\{\s*steps\.decide\.outputs\.voice\s*\}\}/.test(detect), "detect must output voice");
ok(/phone:\s*\$\{\{\s*steps\.decide\.outputs\.phone\s*\}\}/.test(detect), "detect must output phone");
// In the push path, a voice-livekit change sets BOTH voice=true and phone=true
// in the same branch (shared source → both apps).
ok(
  /grep -qE '\^app\/voice-livekit\/';\s*then\s*\n\s*echo "voice=true"[\s\S]*?echo "phone=true"/.test(detect),
  "a app/voice-livekit change must set BOTH voice=true and phone=true",
);

// 4. Database-before-application ordering and secret isolation
ok(/needs:\s*\[detect, migrate-production\]/.test(api), "deploy-api must require successful production migrations");
ok(/needs:\s*\[detect, migrate-production\]/.test(voice), "deploy-browser-voice must require successful production migrations");
ok(/needs:\s*\[detect, migrate-production\]/.test(phone), "deploy-phone-voice must require successful production migrations");
ok(/if:\s*needs\.detect\.outputs\.database == 'true'/.test(migration), "migration job must gate on detect.outputs.database");
ok(/secrets\.SUPABASE_DB_URL\b/.test(migration), "migration job must use SUPABASE_DB_URL");
ok(/test -n "\$SUPABASE_DB_URL"/.test(migration), "migration job must fail closed when DB URL is absent");
ok(/supabase@2\.110\.0 db push/.test(migration) && /--include-all/.test(migration), "migration job must run a pinned Supabase CLI db push");
ok(!/SUPABASE_DB_URL/.test(api) && !/SUPABASE_DB_URL/.test(voice) && !/SUPABASE_DB_URL/.test(phone), "application jobs must not receive the database credential");
ok(/group:\s*supabase-production-migrations/.test(migration) && /cancel-in-progress:\s*false/.test(migration), "migrations must be globally serialized and never cancelled in flight");

// 5. Per-app secret separation across THREE tokens (the core hardening ask).
//    Each app job may use ONLY its own token and no other.
ok(/secrets\.FLY_API_TOKEN_API\b/.test(api), "deploy-api must use FLY_API_TOKEN_API");
ok(!/FLY_API_TOKEN_VOICE/.test(api) && !/FLY_API_TOKEN_PHONE_VOICE/.test(api), "deploy-api must NOT reference any voice token");
ok(/secrets\.FLY_API_TOKEN_VOICE\b/.test(voice), "deploy-browser-voice must use FLY_API_TOKEN_VOICE");
ok(!/FLY_API_TOKEN_API/.test(voice) && !/FLY_API_TOKEN_PHONE_VOICE/.test(voice), "deploy-browser-voice must NOT reference the api or phone token");
ok(/secrets\.FLY_API_TOKEN_PHONE_VOICE\b/.test(phone), "deploy-phone-voice must use FLY_API_TOKEN_PHONE_VOICE");
ok(!/FLY_API_TOKEN_API/.test(phone) && !/FLY_API_TOKEN_VOICE\b/.test(phone), "deploy-phone-voice must NOT reference the api or the BROWSER voice token");
// The phone token name contains the browser token name as a prefix-free suffix;
// assert the browser job never grabs the phone token by loose matching.
ok(!/secrets\.FLY_API_TOKEN\b(?!_)/.test(wf), "the single cross-app secrets.FLY_API_TOKEN must not be used anywhere");

// 6. Concurrency: top-level + per-app groups, never cancel in-flight
ok(/^concurrency:/m.test(wf), "must declare top-level concurrency");
ok(/group:\s*fly-deploy-api/.test(api) && /cancel-in-progress:\s*false/.test(api), "deploy-api needs its own concurrency group with cancel-in-progress: false");
ok(/group:\s*fly-deploy-browser-voice/.test(voice) && /cancel-in-progress:\s*false/.test(voice), "deploy-browser-voice needs its own concurrency group with cancel-in-progress: false");
ok(/group:\s*fly-deploy-phone-voice/.test(phone) && /cancel-in-progress:\s*false/.test(phone), "deploy-phone-voice needs its own concurrency group with cancel-in-progress: false");

// 7. Immutable action pins — every `uses:` must be a full 40-hex commit SHA
const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
ok(uses.length >= 3, "expected pinned action references");
for (const u of uses) {
  ok(/@[0-9a-f]{40}$/.test(u), `action not pinned to a 40-hex SHA: ${u}`);
  ok(!/@master\b/.test(u) && !/@v?\d+(\.\d+)*$/.test(u), `action uses a floating ref, must be a SHA: ${u}`);
}
ok(/superfly\/flyctl-actions\/setup-flyctl@[0-9a-f]{40}/.test(wf), "setup-flyctl must be SHA-pinned");

// 8. Health / current-registration verification, PER APP and policy-aware.
ok(/\/api\/health/.test(api) && /"200"/.test(api), "deploy-api must verify /api/health returns 200");
// Browser voice: ALWAYS_ON — watermark + CURRENT registration on the correct app.
// These assertions pin the LIVE check, not prose: each string below appears only
// in the executable verification, so deleting the guard fails the test.
ok(/date -u \+/.test(voice) && /echo "watermark=/.test(voice), "deploy-browser-voice must capture a pre-release watermark");
ok(/flyctl logs -a project-hello-voice[\s\S]*?grep 'registered worker'/.test(voice), "deploy-browser-voice must grep a CURRENT 'registered worker' line from project-hello-voice logs");
// The anti-stale-log core: the extracted timestamp MUST be compared >= the
// pre-release watermark. Deleting this comparison (accepting any line) must fail.
ok(/sort \| tail -1\)" = "\$ts"/.test(voice), "deploy-browser-voice must compare the log timestamp against the watermark (no stale-log acceptance)");
ok(/printf '%s\\n%s\\n' "\$WATERMARK" "\$ts"/.test(voice), "deploy-browser-voice watermark comparison must use the captured WATERMARK");
// Fail-closed: an absent current registration must exit non-zero (a true
// worker-down incident is surfaced, never swallowed).
ok(/::error::no current 'registered worker'[\s\S]*?exit 1/.test(voice), "deploy-browser-voice must FAIL CLOSED (exit 1) when no current registration is found");
ok(!/project-hello-phone-voice/.test(voice) && !/fly\.phone\.toml/.test(voice), "deploy-browser-voice must not touch the phone app or its config");
// Phone voice: STOPPED — release on the correct app, ENFORCED to count 0, and it
// must NOT demand or grep for a live registration line (no stale-log acceptance).
ok(/fly\.phone\.toml/.test(phone), "deploy-phone-voice must deploy with fly.phone.toml");
ok(/flyctl scale count 0 -a project-hello-phone-voice/.test(phone), "deploy-phone-voice must ENFORCE stopped/min-0 by scaling the app to count 0 (default-safe by code, not by manual precondition)");
// M-1: the live window is bounded from BOTH sides — a scale-to-zero must run
// BEFORE the release (not only after), so a machine left live by a prior state
// is not rolled live by this deploy. Assert a scale-0 precedes the deploy AND a
// scale-0 follows it.
{
  const preScale = phone.indexOf("flyctl scale count 0 -a project-hello-phone-voice");
  const deployAt = phone.indexOf("flyctl deploy --remote-only --config fly.phone.toml");
  const postScale = phone.lastIndexOf("flyctl scale count 0 -a project-hello-phone-voice");
  ok(preScale !== -1 && deployAt !== -1 && preScale < deployAt,
    "deploy-phone-voice must scale to count 0 BEFORE the release (M-1: bound the live window from both sides)");
  ok(postScale > deployAt,
    "deploy-phone-voice must scale to count 0 AFTER the release as well");
}
// M-1: the transient must be documented as non-dispatchable, tied to the empty
// API name — the guarantee is the missing dispatch target, not the scale timing.
ok(/non-dispatchable/i.test(phone) && /PHONE_AGENT_NAME/.test(phone),
  "deploy-phone-voice must document the release transient as non-dispatchable while the API PHONE_AGENT_NAME is empty");
ok(/status -a project-hello-phone-voice/.test(phone), "deploy-phone-voice must verify status on project-hello-phone-voice");
ok(!/registered worker/.test(phone), "deploy-phone-voice (stopped policy) must NOT require or accept a 'registered worker' line");
ok(!/project-hello-voice\b/.test(phone.replace(/project-hello-phone-voice/g, "")), "deploy-phone-voice must not target the browser app");
ok(/STOPPED/.test(phone), "deploy-phone-voice must document its STOPPED run policy");
ok(/ALWAYS_ON/.test(voice), "deploy-browser-voice must document its ALWAYS_ON run policy");

// ── 8b. M-1 (PR104): the pre-release scale must CLASSIFY its failure ─────
// The old form was `flyctl scale count 0 ... 2>/dev/null || echo "app not
// created yet"`: every failure, including the empty token that actually
// occurred, was reported as a missing app. These controls pin the repair as
// TEXT (the misattributing shape is gone from the EXECUTED lines) and then,
// below, as BEHAVIOUR. Comments are stripped first — the job documents the old
// form on purpose, and a guard that a comment can satisfy (or trip) is not a
// guard on the code.
const phoneCode = phone
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");
ok(/flyctl scale count 0 -a project-hello-phone-voice/.test(phoneCode),
  "comment-stripping must leave the executable scale lines intact (else every assertion below is vacuous)");
// L-1: the historical form spanned a backslash line-continuation
//   flyctl scale count 0 -a … --yes 2>/dev/null \
//     || echo "pre-release scale skipped (app not created yet); …"
// so a `[^\n]*` guard could not match the shape it named — restoring the real
// prior code would have left it green. Match the LOGICAL line instead: the
// command plus any number of continued physical lines.
const LOGICAL_SCALE = String.raw`scale count 0(?:[^\n]*\\\n)*[^\n]*`;
ok(!new RegExp(`${LOGICAL_SCALE}2>\\/dev\\/null`).test(phoneCode),
  "deploy-phone-voice must not silence the pre-release scale's stderr — the failure text is what tells the two causes apart");
ok(!new RegExp(`${LOGICAL_SCALE}\\|\\|\\s*echo`).test(phoneCode),
  "deploy-phone-voice must not swallow a pre-release scale failure with `|| echo`, on one line or across a continuation — that is the misattribution M-1 records");
// The guard must be able to see across a continuation. A positive control on the
// matcher itself, because a regex that cannot match the shape it forbids is the
// guard-that-cannot-fire class: feed it the REAL historical two-line form.
{
  const historical = 'flyctl scale count 0 -a project-hello-phone-voice --yes 2>/dev/null \\\n'
    + '  || echo "pre-release scale skipped (app not created yet); the post-release scale below is the binding guarantee"\n';
  ok(new RegExp(`${LOGICAL_SCALE}\\|\\|\\s*echo`).test(historical),
    "the `|| echo` guard must match the ACTUAL historical continuation form, not only a single-line reconstruction");
  ok(new RegExp(`${LOGICAL_SCALE}2>\\/dev\\/null`).test(historical),
    "the stderr-suppression guard must match the actual historical form");
}
ok(/could not find app/i.test(phoneCode),
  "deploy-phone-voice must match flyctl's app-not-found text explicitly rather than assuming it");
ok(/::error::pre-release scale precondition FAILED[\s\S]*?exit 1/.test(phoneCode),
  "deploy-phone-voice must FAIL CLOSED (exit 1) when the pre-release precondition fails for a reason other than an absent app");
// Ordering: the tolerant branch must be GUARDED by the not-found match, i.e. the
// classification must precede the benign message, never follow it.
{
  const notFoundAt = phoneCode.search(/could not find app/i);
  const skipMsgAt = phoneCode.indexOf("pre-release scale skipped");
  const failClosedAt = phoneCode.indexOf("::error::pre-release scale precondition FAILED");
  ok(notFoundAt !== -1 && skipMsgAt !== -1 && notFoundAt < skipMsgAt,
    "the app-not-found classification must GUARD the benign 'skipped' message, not trail it");
  ok(failClosedAt > skipMsgAt,
    "the fail-closed branch must be the fallthrough after the classified benign case");
}
// The post-release scale is unconditional and unguarded — it is the binding
// guarantee the benign branch leans on, so it must never acquire a fallback.
{
  const after = phoneCode.slice(phoneCode.indexOf("flyctl deploy --remote-only --config fly.phone.toml"));
  ok(/^\s*flyctl scale count 0 -a project-hello-phone-voice --yes\s*$/m.test(after),
    "a bare, unguarded post-release scale must follow the release");
  ok(!/scale count 0[^\n]*(\|\||2>)/.test(after),
    "the post-release scale must carry no fallback and no stderr suppression");
}

// ── 8c. M-1 BEHAVIOUR: run the step's real shell against a stubbed flyctl ──
// A text assertion proves the branch is written; only executing it proves the
// branch works. The step's script is extracted verbatim from the workflow and
// run with a `flyctl` stub on PATH, so the three outcomes are observed, not
// asserted about. No network, no Fly, no token.
function stepScript(jobText, nameFragment) {
  const lines = jobText.split("\n");
  const at = lines.findIndex((l) => l.includes("- name:") && l.includes(nameFragment));
  if (at === -1) return null;
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  if (runAt === -1) return null;
  const indent = lines[runAt + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") { body.push(""); continue; }
    if (l.match(/^\s*/)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}
{
  const script = stepScript(phone, "Deploy phone voice worker");
  ok(script !== null && /flyctl deploy --remote-only --config fly\.phone\.toml/.test(script || ""),
    "must be able to extract the phone deploy step's shell script for behavioural testing");
  if (script) {
    // The stub answers `status` per mode and, in scalefail mode, fails `scale`.
    // Modes: ok | notfound | nocred | scalefail.
    //
    // L-4 — SAFETY INVARIANT, stated and then enforced: this harness executes
    // the workflow's REAL shell, which contains `flyctl deploy`. Nothing may
    // reach Fly. Two things guarantee that and both are asserted below, not
    // assumed: the child's PATH is replaced (not prepended to), so only the
    // stub directory and the base system dirs are searched; and `command -v
    // flyctl` is resolved IN THE CHILD ENV and required to be the stub. No Fly
    // token is passed either — the step reads it from the job `env`, which this
    // harness does not provide.
    const stubDirFor = (statusMode) => {
      const dir = mkdtempSync(path.join(tmpdir(), "fly-stub-"));
      const bin = path.join(dir, "flyctl");
      writeFileSync(bin, [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        `  case "${statusMode}" in`,
        "    ok|scalefail) echo 'App: project-hello-phone-voice'; exit 0 ;;",
        "    notfound) echo 'Error: Could not find App \"project-hello-phone-voice\"' >&2; exit 1 ;;",
        "    nocred) echo 'Error: no access token available' >&2; exit 1 ;;",
        "  esac",
        "fi",
        `if [ "$1" = "scale" ] && [ "${statusMode}" = "scalefail" ]; then`,
        "  echo 'Error: could not scale app: machine update failed' >&2; exit 1",
        "fi",
        'echo "STUB flyctl $*"',
        "exit 0",
      ].join("\n"));
      chmodSync(bin, 0o755);
      return dir;
    };
    const HERMETIC_PATH = (dir) => `${dir}:/usr/bin:/bin`;
    const runWithStub = (statusMode) => {
      const dir = stubDirFor(statusMode);
      const env = { ...process.env, PATH: HERMETIC_PATH(dir) };
      // Resolve flyctl in the SAME environment the step will run in.
      const which = spawnSync("bash", ["-c", "command -v flyctl"], { encoding: "utf8", env });
      const resolved = (which.stdout || "").trim();
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env });
      rmSync(dir, { recursive: true, force: true });
      return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), resolved, stubBin: path.join(dir, "flyctl") };
    };

    // (a) App reachable → the pre-release scale actually RUNS, then the release.
    const okRun = runWithStub("ok");
    ok(okRun.code === 0, `reachable app: the step must succeed, got ${okRun.code}:\n${okRun.out}`);
    ok(/STUB flyctl scale count 0 -a project-hello-phone-voice --yes/.test(okRun.out),
      "reachable app: the PRE-release scale must run");
    ok((okRun.out.match(/scale count 0 -a project-hello-phone-voice/g) || []).length === 2,
      "reachable app: BOTH the pre- and post-release scales must run");
    ok(!/pre-release scale skipped/.test(okRun.out),
      "reachable app: the step must not claim it skipped anything");

    // (b) App not visible → tolerated, said accurately, and the release proceeds
    //     with the post-release scale still binding.
    const nf = runWithStub("notfound");
    ok(nf.code === 0, `absent app: the step must continue, got ${nf.code}:\n${nf.out}`);
    ok(/pre-release scale skipped: app project-hello-phone-voice is NOT VISIBLE/.test(nf.out),
      "absent app: the message must name the observed condition (not visible to this token)");
    ok(!/::error::/.test(nf.out), "absent app: must not raise a workflow error");
    ok(/STUB flyctl deploy --remote-only --config fly.phone.toml/.test(nf.out),
      "absent app: the release must still proceed");
    ok((nf.out.match(/scale count 0 -a project-hello-phone-voice/g) || []).length === 1,
      "absent app: exactly the POST-release scale must run (the binding guarantee)");

    // (c) Credential failure → FAILS CLOSED, and never prints the absent-app
    //     story. This is the exact case that was misreported in production.
    const nc = runWithStub("nocred");
    ok(nc.code !== 0, `credential failure: the step must FAIL CLOSED, got exit ${nc.code}:\n${nc.out}`);
    ok(/::error::pre-release scale precondition FAILED/.test(nc.out),
      "credential failure: must raise a workflow error naming the precondition");
    ok(!/pre-release scale skipped/.test(nc.out) && !/not been created/i.test(nc.out.split("::error::")[0] || ""),
      "credential failure: must NOT be reported as an absent app (the M-1 misattribution)");
    ok(/no access token available/.test(nc.out),
      "credential failure: the underlying flyctl message must be surfaced, not swallowed");
    ok(!/STUB flyctl deploy/.test(nc.out),
      "credential failure: NO release may be pushed once the scale controls are untrustworthy");

    // (d) L-4: `flyctl status` succeeds but the pre-release SCALE fails. Under
    //     `set -e` the step must abort — an unscaled release is exactly the
    //     unbounded live window the pre-release scale exists to prevent.
    const sf = runWithStub("scalefail");
    ok(sf.code !== 0, `scale failure: the step must abort, got exit ${sf.code}:\n${sf.out}`);
    ok(!/STUB flyctl deploy/.test(sf.out),
      "scale failure: NO release may be pushed when the pre-release scale itself fails");

    // L-4: the harness is hermetic — prove it rather than assume it. Every mode
    // must have resolved `flyctl` to the throwaway stub, never to a real binary.
    for (const [label, r] of [["reachable", okRun], ["absent", nf], ["credential", nc], ["scale-failure", sf]]) {
      ok(r.resolved === r.stubBin,
        `${label}: flyctl must resolve to the test stub (${r.stubBin}), got ${JSON.stringify(r.resolved)} — this harness runs the real workflow shell and must never reach Fly`);
    }
    // The step must not carry a credential inline: the token arrives via job
    // `env` (GitHub-masked), which this harness deliberately does not provide.
    // A mention inside a diagnostic message is fine; an assignment or a
    // `secrets.` interpolation inside the shell would not be.
    ok(!/FLY_API_TOKEN[A-Z_]*\s*=/.test(script),
      "the extracted step must not ASSIGN a Fly token inline — it is job env, and absent in this harness");
    ok(!/\$\{\{\s*secrets\./.test(script),
      "the extracted step must not interpolate a `secrets.` expression into the shell");
  }
}

// 9. Least privilege
const perm = (wf.match(/permissions:\n((?:\s+\S.*\n)+)/) || [, ""])[1];
ok(/contents:\s*read/.test(perm), "permissions must grant contents: read");
ok(!/\bwrite\b/.test(perm), "permissions must not grant any write scope");

// 10. Manual recovery valve exposes the full service matrix
ok(/workflow_dispatch:/.test(wf), "must expose a workflow_dispatch recovery valve");
ok(/options:\s*\[api, browser-voice, phone-voice, both, all\]/.test(wf), "manual dispatch must offer api|browser-voice|phone-voice|both|all");
// 'both' = api + browser-voice (no phone); 'all' = every app including phone.
ok(/both\)\s*api=true; voice=true ;;/.test(detect), "'both' must select api + browser-voice only (never phone)");
ok(/all\)\s*api=true; voice=true; phone=true ;;/.test(detect), "'all' must select api + browser-voice + phone-voice");
ok(/phone-voice\)\s*phone=true ;;/.test(detect), "'phone-voice' must select only the phone app");

if (failures.length) {
  console.error(`deploy-fly workflow contract FAILED (${failures.length}):`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log("deploy-fly workflow contract valid (three-app matrix, token isolation, policy-aware verification, classified pre-release precondition).");
