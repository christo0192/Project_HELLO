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
ok(/ALWAYS_ON/.test(voice), "deploy-browser-voice must document its ALWAYS_ON run policy");
// An EMPTY watermark would degrade the >= comparison into accepting ANY
// historical line; both lanes must refuse to verify on one.
ok(/empty pre-release watermark[\s\S]*?exit 1/.test(voice), "deploy-browser-voice must FAIL CLOSED on an empty watermark (else the anti-stale comparison is vacuous)");
// The failure path must surface one UNSUPPRESSED flyctl logs attempt, so a
// logs-transport/credential failure is distinguishable from an unregistered
// worker (the M-1 misattribution class).
ok(/flyctl logs -a project-hello-voice --no-tail \|\| true/.test(voice), "deploy-browser-voice failure path must run one unsuppressed flyctl logs attempt before the fail-closed error");
// Phone voice: ALWAYS_ON since the §6 canary flip
// (docs/runbooks/phone-worker-deployment.md §6) — the SAME watermark +
// CURRENT-registration contract as the browser job, against the phone app.
ok(/fly\.phone\.toml/.test(phone), "deploy-phone-voice must deploy with fly.phone.toml");
ok(/date -u \+/.test(phone) && /echo "watermark=/.test(phone), "deploy-phone-voice must capture a pre-release watermark");
ok(/flyctl logs -a project-hello-phone-voice[\s\S]*?grep 'registered worker'/.test(phone), "deploy-phone-voice must grep a CURRENT 'registered worker' line from project-hello-phone-voice logs");
// The anti-stale-log core: the extracted timestamp MUST be compared >= the
// pre-release watermark. Deleting this comparison (accepting any line) must fail.
ok(/sort \| tail -1\)" = "\$ts"/.test(phone), "deploy-phone-voice must compare the log timestamp against the watermark (no stale-log acceptance)");
ok(/printf '%s\\n%s\\n' "\$WATERMARK" "\$ts"/.test(phone), "deploy-phone-voice watermark comparison must use the captured WATERMARK");
// Fail-closed: an absent current registration must exit non-zero — a
// dispatchable phone lane with no registered worker is dispatch-into-silence.
ok(/::error::no current 'registered worker'[\s\S]*?exit 1/.test(phone), "deploy-phone-voice must FAIL CLOSED (exit 1) when no current registration is found");
ok(/status -a project-hello-phone-voice/.test(phone), "deploy-phone-voice must verify status on project-hello-phone-voice");
ok(/empty pre-release watermark[\s\S]*?exit 1/.test(phone), "deploy-phone-voice must FAIL CLOSED on an empty watermark (else the anti-stale comparison is vacuous)");
ok(/flyctl logs -a project-hello-phone-voice --no-tail \|\| true/.test(phone), "deploy-phone-voice failure path must run one unsuppressed flyctl logs attempt before the fail-closed error");
// The §6 flip REMOVED the stopped-era scale-to-zero. Guard that REMOVAL
// two-sided: the scale lines coming back would re-zero a live canary window on
// every unrelated shared-source merge (runbook §6a names that failure mode),
// so their absence is part of the reviewed posture, not an accident.
{
  const phoneCode = phone
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  ok(/flyctl deploy --remote-only --config fly\.phone\.toml/.test(phoneCode),
    "comment-stripping must leave the executable deploy line intact (else the ban below is vacuous)");
  ok(!/flyctl\s+(scale|machine)\b/.test(phoneCode),
    "deploy-phone-voice must contain NO flyctl scale/machine command — the §6 flip made it ALWAYS_ON, and any re-zeroing (scale count 0 under either flag spelling, machine stop/destroy) silently kills a live canary window (runbook §6a); reverting to STOPPED is a reviewed posture change, not a line edit");
}
ok(/ALWAYS_ON/.test(phone), "deploy-phone-voice must document its ALWAYS_ON run policy");
ok(!/project-hello-voice\b/.test(phone.replace(/project-hello-phone-voice/g, "")), "deploy-phone-voice must not target the browser app");


// ── 8b. BEHAVIOUR: run the phone verify step's real shell against a stub ──
// Text assertions prove the guards are written; only executing the shell
// proves they fire. The step's script is extracted verbatim and run with stub
// `flyctl` and `sleep` binaries on a REPLACED PATH (hermetic — asserted, not
// assumed; no token is provided, so nothing can reach Fly).
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
  const script = stepScript(phone, "Verify CURRENT worker registration");
  ok(script !== null && /registered worker/.test(script || ""),
    "must be able to extract the phone verify step's shell script for behavioural testing");
  if (script) {
    const stubDirFor = (logsMode) => {
      const dir = mkdtempSync(path.join(tmpdir(), "fly-stub-"));
      const bin = path.join(dir, "flyctl");
      writeFileSync(bin, [
        "#!/usr/bin/env bash",
        'if [ "$1" = "logs" ]; then',
        `  case "${logsMode}" in`,
        "    registered) echo '2099-01-01T00:00:00 registered worker id=stub' ;;",
        "    silent) : ;;",
        "  esac",
        "  exit 0",
        "fi",
        'echo "STUB flyctl $*"',
        "exit 0",
      ].join("\n"));
      chmodSync(bin, 0o755);
      // No-op sleep so the 24-attempt failure loop completes instantly.
      const slp = path.join(dir, "sleep");
      writeFileSync(slp, "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(slp, 0o755);
      return dir;
    };
    const runWithStub = (logsMode, watermark) => {
      const dir = stubDirFor(logsMode);
      const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, WATERMARK: watermark };
      const which = spawnSync("bash", ["-c", "command -v flyctl"], { encoding: "utf8", env });
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env });
      const resolved = (which.stdout || "").trim();
      rmSync(dir, { recursive: true, force: true });
      return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), resolved, stubBin: path.join(dir, "flyctl") };
    };

    // (a) Current registration at/after the watermark → verify passes.
    const okRun = runWithStub("registered", "2020-01-01T00:00:00");
    ok(okRun.code === 0, `current registration: verify must pass, got ${okRun.code}:\n${okRun.out}`);
    ok(/re-registered at 2099-01-01T00:00:00/.test(okRun.out),
      "current registration: the accepted timestamp must be the one from the log line");

    // (b) No registration ever → FAILS CLOSED with the named error.
    const silent = runWithStub("silent", "2020-01-01T00:00:00");
    ok(silent.code !== 0, `no registration: verify must FAIL CLOSED, got exit ${silent.code}:\n${silent.out}`);
    ok(/::error::no current 'registered worker'/.test(silent.out),
      "no registration: must raise the named workflow error");

    // (c) EMPTY watermark → refuse BEFORE consulting logs; a stale line must
    //     not be given the chance to satisfy a vacuous comparison.
    const empty = runWithStub("registered", "");
    ok(empty.code !== 0, `empty watermark: verify must FAIL CLOSED, got exit ${empty.code}:\n${empty.out}`);
    ok(/empty pre-release watermark/.test(empty.out),
      "empty watermark: must name the refusal (not report an unregistered worker)");
    ok(!/re-registered/.test(empty.out),
      "empty watermark: must never accept a registration line");

    // (d) A registration line OLDER than the watermark is STALE evidence and
    //     must be rejected — this is the entire point of the watermark.
    const stale = runWithStub("registered", "2100-01-01T00:00:00");
    ok(stale.code !== 0, `stale registration: verify must FAIL CLOSED, got exit ${stale.code}:\n${stale.out}`);
    ok(!/re-registered/.test(stale.out),
      "stale registration: a pre-watermark line must never be accepted");

    // Hermetic: flyctl must resolve to the throwaway stub in every mode.
    for (const [label, r] of [["registered", okRun], ["silent", silent], ["empty-watermark", empty], ["stale", stale]]) {
      ok(r.resolved === r.stubBin,
        `${label}: flyctl must resolve to the test stub (${r.stubBin}), got ${JSON.stringify(r.resolved)} — this harness runs the real workflow shell and must never reach Fly`);
    }
    ok(!/\$\{\{\s*secrets\./.test(script),
      "the extracted verify step must not interpolate a `secrets.` expression into the shell");
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

// ── 11. On-demand orchestration deploy reconciliation ────────────────────
// The always-on registration proof must stay EXACTLY as today when orchestration
// is OFF, and switch to start->verify->deploy->stop when ON. These assertions
// prove: (a) the OFF path is still gated + present (byte-identical safety), (b)
// the signal is the config flag read at detect time, (c) an ON branch exists and
// delegates to the shared script, (d) the ON branch does NOT require a
// pre-existing current registration in the workflow YAML.

// (a) OFF path unchanged: the historical always-on deploy+verify steps still
//     exist, and are now GATED to run only when orchestration != 'worker'. The
//     full always-on verification contract (§8 above) already asserts their
//     bodies are intact; here we assert the guard that keeps them the OFF path.
ok(/name: Deploy browser voice worker\n\s*id: deploy\n\s*if: needs\.detect\.outputs\.voice_orchestration != 'worker'/.test(voice),
  "the browser always-on deploy step must be gated to orchestration OFF (voice_orchestration != 'worker')");
ok(/name: Verify CURRENT worker registration[\s\S]*?if: needs\.detect\.outputs\.voice_orchestration != 'worker'/.test(voice),
  "the browser always-on verify step must be gated to orchestration OFF");
ok(/if: needs\.detect\.outputs\.phone_orchestration != 'worker'/.test(phone),
  "the phone always-on steps must be gated to orchestration OFF (phone_orchestration != 'worker')");

// (b) The signal is the config flag, read in detect from the checked-out tree,
//     and emitted per voice app. Absent/"off"/other must resolve to "off".
ok(/voice_orchestration:\s*\$\{\{\s*steps\.decide\.outputs\.voice_orchestration\s*\}\}/.test(detect), "detect must output voice_orchestration");
ok(/phone_orchestration:\s*\$\{\{\s*steps\.decide\.outputs\.phone_orchestration\s*\}\}/.test(detect), "detect must output phone_orchestration");
ok(/WORKER_ORCHESTRATION\[\[:space:\]\]\*=\[\[:space:\]\]\*"worker"/.test(detect),
  "detect must read the orchestration signal from the config's WORKER_ORCHESTRATION = \"worker\" flag");
ok(/orch fly\.toml/.test(detect) && /orch fly\.phone\.toml/.test(detect),
  "detect must evaluate the flag against BOTH voice configs");
ok(/echo "voice_orchestration=off"/.test(detect) && /echo "phone_orchestration=off"/.test(detect),
  "the manual-dispatch branch must also emit the orchestration signal (default off)");

// (c) An ON branch exists for BOTH voice apps, gated to orchestration ON, and
//     delegates to the shared reconciliation script (start->verify->deploy->stop).
ok(/name: Deploy browser voice worker on-demand \(orchestration ON\)\n\s*if: needs\.detect\.outputs\.voice_orchestration == 'worker'/.test(voice),
  "the browser job must have an ON-demand branch gated to orchestration ON");
ok(/name: Deploy phone voice worker on-demand \(orchestration ON\)\n\s*if: needs\.detect\.outputs\.phone_orchestration == 'worker'/.test(phone),
  "the phone job must have an ON-demand branch gated to orchestration ON");
ok(/scripts\/deploy-voice-orchestration\.sh/.test(voice) && /scripts\/deploy-voice-orchestration\.sh/.test(phone),
  "both ON-demand branches must delegate to scripts/deploy-voice-orchestration.sh");
ok(/APP: project-hello-voice\b/.test(voice) && /FLY_CONFIG: fly\.toml\b/.test(voice),
  "the browser ON-demand branch must target project-hello-voice / fly.toml");
ok(/APP: project-hello-phone-voice\b/.test(phone) && /FLY_CONFIG: fly\.phone\.toml\b/.test(phone),
  "the phone ON-demand branch must target project-hello-phone-voice / fly.phone.toml");
// Token isolation must hold in the ON branches too (each app, only its token).
ok(!/FLY_API_TOKEN_API/.test(voice) && !/FLY_API_TOKEN_PHONE_VOICE/.test(voice),
  "the browser ON-demand branch must not reference the api or phone token");
ok(!/FLY_API_TOKEN_API/.test(phone) && !/FLY_API_TOKEN_VOICE\b/.test(phone),
  "the phone ON-demand branch must not reference the api or browser token");

// (d) The ON branch does NOT require a pre-existing current registration in the
//     workflow YAML: the ON branch body carries no in-YAML "no current
//     'registered worker'" fail-closed loop — that logic moved into the script,
//     which starts a machine FIRST. Assert the ON branch is just the delegation.
{
  const onBranch = (voice.match(/name: Deploy browser voice worker on-demand[\s\S]*?bash "\$GITHUB_WORKSPACE\/scripts\/deploy-voice-orchestration\.sh"/) || [""])[0];
  ok(onBranch && !/for i in \$\(seq 1 24\)/.test(onBranch),
    "the ON-demand branch must not inline the always-on 24-attempt registration loop (it starts a machine first, in the script)");
}

// ── 11b. BEHAVIOUR: run the shared reconciliation SCRIPT against stubs ────
// Prove the ON-path mechanism executes start->verify->deploy->stop and that its
// cleanup returns ONLY a machine it started, on success AND on failure. Runs the
// real script with stub flyctl/date/sleep on a replaced PATH; no token reaches
// Fly (the stub never calls out).
{
  const scriptPath = path.join(root, "scripts/deploy-voice-orchestration.sh");
  const scriptSrc = readFileSync(scriptPath, "utf8");
  ok(/machine start/.test(scriptSrc) && /machine stop/.test(scriptSrc) && /flyctl deploy/.test(scriptSrc),
    "the reconciliation script must start a machine, deploy, and stop a machine");
  ok(/trap cleanup EXIT/.test(scriptSrc),
    "the reconciliation script must clean up (stop the started machine) via an EXIT trap");
  ok(/registered worker/.test(scriptSrc) && /WATERMARK/.test(scriptSrc),
    "the reconciliation script must carry the same watermarked current-registration proof");

  const makeStub = ({ logsMode = "registered", deployRc = 0 }) => {
    const dir = mkdtempSync(path.join(tmpdir(), "orch-stub-"));
    // flyctl stub: records each machine start/stop into a call log; emits a
    // registration line for logs in "registered" mode; deploy exits deployRc.
    const calls = path.join(dir, "calls.log");
    const bin = path.join(dir, "flyctl");
    writeFileSync(bin, [
      "#!/usr/bin/env bash",
      `echo "$@" >> ${JSON.stringify(calls)}`,
      'case "$1" in',
      '  logs)',
      `    case "${logsMode}" in`,
      "      registered) echo '2099-01-01T00:00:00 registered worker id=stub' ;;",
      "      silent) : ;;",
      "    esac ;;",
      "  machine)",
      '    if [ "$2" = "list" ]; then',
      // one stopped machine 'm1'; after a start it reports started.
      '      if [ -f ' + JSON.stringify(path.join(dir, "started")) + ' ]; then echo "m1 app started"; else echo "m1 app stopped"; fi',
      '    elif [ "$2" = "start" ]; then touch ' + JSON.stringify(path.join(dir, "started")) + '; ',
      '    elif [ "$2" = "stop" ]; then rm -f ' + JSON.stringify(path.join(dir, "started")) + '; ',
      "    fi ;;",
      `  deploy) exit ${deployRc} ;;`,
      "esac",
      "exit 0",
    ].join("\n"));
    chmodSync(bin, 0o755);
    const slp = path.join(dir, "sleep"); writeFileSync(slp, "#!/usr/bin/env bash\nexit 0\n"); chmodSync(slp, 0o755);
    return { dir, calls };
  };
  const runScript = (stub, env = {}) => {
    const r = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stub.dir}:/usr/bin:/bin`,
        APP: "project-hello-phone-voice",
        FLY_CONFIG: "fly.phone.toml",
        WATERMARK: "2020-01-01T00:00:00",
        READY_ATTEMPTS: "3", START_ATTEMPTS: "3", SLEEP_SECONDS: "0",
        ...env,
      },
    });
    const callLog = (() => { try { return readFileSync(stub.calls, "utf8"); } catch { return ""; } })();
    return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), callLog };
  };

  // (i) Happy path: registers, deploys, and STOPS the machine it started.
  {
    const stub = makeStub({ logsMode: "registered", deployRc: 0 });
    const r = runScript(stub);
    ok(r.code === 0, `on-demand happy path must succeed, got ${r.code}:\n${r.out}`);
    ok(/machine start m1/.test(r.callLog), "on-demand must START a pool machine");
    ok(/deploy --remote-only --config fly\.phone\.toml/.test(r.callLog), "on-demand must deploy the config");
    ok(/machine stop m1/.test(r.callLog), "on-demand must STOP the machine it started (cleanup)");
    rmSync(stub.dir, { recursive: true, force: true });
  }
  // (ii) Deploy fails ⇒ non-zero exit, but the started machine is STILL stopped
  //      (the trap cleans up on failure — never leaves a started machine).
  {
    const stub = makeStub({ logsMode: "registered", deployRc: 7 });
    const r = runScript(stub);
    ok(r.code !== 0, `on-demand must FAIL when deploy fails, got ${r.code}:\n${r.out}`);
    ok(/machine start m1/.test(r.callLog) && /machine stop m1/.test(r.callLog),
      "on a failed deploy the started machine must STILL be stopped (fail-safe cleanup)");
    rmSync(stub.dir, { recursive: true, force: true });
  }
  // (iii) Worker never registers ⇒ FAIL CLOSED, and still cleans up. This is the
  //       registration safety: ON does not mean "skip the proof".
  {
    const stub = makeStub({ logsMode: "silent", deployRc: 0 });
    const r = runScript(stub);
    ok(r.code !== 0, `on-demand must FAIL CLOSED when the worker never registers, got ${r.code}:\n${r.out}`);
    ok(/machine stop m1/.test(r.callLog),
      "even on a registration failure the started machine must be stopped");
    rmSync(stub.dir, { recursive: true, force: true });
  }
  // (iv) Empty watermark ⇒ refuse before doing anything (no machine started).
  {
    const stub = makeStub({ logsMode: "registered", deployRc: 0 });
    const r = runScript(stub, { WATERMARK: "" });
    ok(r.code !== 0, "on-demand must refuse an empty watermark");
    ok(/empty pre-release watermark/.test(r.out), "must name the empty-watermark refusal");
    ok(!/machine start/.test(r.callLog), "an empty watermark must refuse BEFORE starting any machine");
    rmSync(stub.dir, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error(`deploy-fly workflow contract FAILED (${failures.length}):`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log("deploy-fly workflow contract valid (three-app matrix, token isolation, policy-aware ALWAYS_ON verification on both voice apps; on-demand orchestration reconciliation start->verify->deploy->stop with fail-safe cleanup; OFF path byte-identical).");
