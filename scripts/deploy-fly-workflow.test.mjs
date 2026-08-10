#!/usr/bin/env node
// Deterministic contract tests for .github/workflows/deploy-fly.yml.
//
// This workflow is production security code (it holds deploy tokens and pushes
// to Fly). These tests lock its security-relevant contract so a future edit
// cannot silently weaken it. Dependency-free: text + per-job assertions only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
const voice = jobBlock("deploy-voice");
ok(detect && migration && api && voice, "expected detect, migrate-production, deploy-api, deploy-voice jobs to exist");

// 1. main-success gating + failed-Quality → no deploy
ok(/workflow_run\.conclusion == 'success'/.test(detect), "gate must require Quality conclusion == success (failed/cancelled must not deploy)");
ok(/workflow_run\.event == 'push'/.test(detect), "gate must require the Quality run's event == push");
ok(/workflow_run\.head_branch == 'main'/.test(detect), "gate must require head_branch == main");

// 2. Trigger is the Quality workflow completing
ok(/workflow_run:/.test(wf) && /workflows:\s*\["Quality"\]/.test(wf), "must trigger on workflow_run of \"Quality\"");
ok(/types:\s*\[completed\]/.test(wf), "workflow_run must listen to completed");

// 3. Path selection
ok(/grep -qE '\^app\/api\//.test(detect), "detect must select the API service by app/api/ path");
ok(/grep -qE '\^app\/voice-livekit\//.test(detect), "detect must select the voice service by app/voice-livekit/ path");
ok(/if:\s*needs\.detect\.outputs\.api == 'true'/.test(api), "deploy-api must gate on detect.outputs.api == true");
ok(/if:\s*needs\.detect\.outputs\.voice == 'true'/.test(voice), "deploy-voice must gate on detect.outputs.voice == true");
ok(/\^app\/supabase\/migrations\//.test(detect), "detect must select production migrations by app/supabase/migrations/ path");
ok(/database=true/.test(detect), "application/manual deploys must request migration convergence");

// 4. Database-before-application ordering and secret isolation
ok(/needs:\s*\[detect, migrate-production\]/.test(api), "deploy-api must require successful production migrations");
ok(/needs:\s*\[detect, migrate-production\]/.test(voice), "deploy-voice must require successful production migrations");
ok(/if:\s*needs\.detect\.outputs\.database == 'true'/.test(migration), "migration job must gate on detect.outputs.database");
ok(/secrets\.SUPABASE_DB_URL\b/.test(migration), "migration job must use SUPABASE_DB_URL");
ok(/test -n "\$SUPABASE_DB_URL"/.test(migration), "migration job must fail closed when DB URL is absent");
ok(/supabase@2\.110\.0 db push/.test(migration) && /--include-all/.test(migration), "migration job must run a pinned Supabase CLI db push");
ok(!/SUPABASE_DB_URL/.test(api) && !/SUPABASE_DB_URL/.test(voice), "application jobs must not receive the database credential");
ok(/group:\s*supabase-production-migrations/.test(migration) && /cancel-in-progress:\s*false/.test(migration), "migrations must be globally serialized and never cancelled in flight");

// 5. Per-service secret separation (the core hardening ask)
ok(/secrets\.FLY_API_TOKEN_API\b/.test(api), "deploy-api must use FLY_API_TOKEN_API");
ok(!/FLY_API_TOKEN_VOICE/.test(api), "deploy-api must NOT reference the voice token");
ok(/secrets\.FLY_API_TOKEN_VOICE\b/.test(voice), "deploy-voice must use FLY_API_TOKEN_VOICE");
ok(!/FLY_API_TOKEN_API/.test(voice), "deploy-voice must NOT reference the api token");
ok(!/secrets\.FLY_API_TOKEN\b(?!_)/.test(wf), "the single cross-app secrets.FLY_API_TOKEN must not be used anywhere");

// 6. Concurrency: top-level + per-service groups, never cancel in-flight
ok(/^concurrency:/m.test(wf), "must declare top-level concurrency");
ok(/group:\s*fly-deploy-api/.test(api) && /cancel-in-progress:\s*false/.test(api), "deploy-api needs its own concurrency group with cancel-in-progress: false");
ok(/group:\s*fly-deploy-voice/.test(voice) && /cancel-in-progress:\s*false/.test(voice), "deploy-voice needs its own concurrency group with cancel-in-progress: false");

// 7. Immutable action pins — every `uses:` must be a full 40-hex commit SHA
const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
ok(uses.length >= 3, "expected pinned action references");
for (const u of uses) {
  ok(/@[0-9a-f]{40}$/.test(u), `action not pinned to a 40-hex SHA: ${u}`);
  ok(!/@master\b/.test(u) && !/@v?\d+(\.\d+)*$/.test(u), `action uses a floating ref, must be a SHA: ${u}`);
}
ok(/superfly\/flyctl-actions\/setup-flyctl@[0-9a-f]{40}/.test(wf), "setup-flyctl must be SHA-pinned");

// 8. Health / current-registration verification
ok(/\/api\/health/.test(api) && /"200"/.test(api), "deploy-api must verify /api/health returns 200");
ok(/date -u \+/.test(voice) && /watermark=/.test(voice), "deploy-voice must capture a pre-release watermark");
ok(/WATERMARK/.test(voice) && /registered worker/.test(voice), "deploy-voice must verify a CURRENT 'registered worker' log against the watermark");

// 9. Least privilege
const perm = (wf.match(/permissions:\n((?:\s+\S.*\n)+)/) || [, ""])[1];
ok(/contents:\s*read/.test(perm), "permissions must grant contents: read");
ok(!/\bwrite\b/.test(perm), "permissions must not grant any write scope");

// 10. Manual recovery valve
ok(/workflow_dispatch:/.test(wf), "must expose a workflow_dispatch recovery valve");
ok(/options:\s*\[api, voice, both\]/.test(wf), "manual dispatch must offer api|voice|both");

if (failures.length) {
  console.error(`deploy-fly workflow contract FAILED (${failures.length}):`);
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log("deploy-fly workflow contract valid (12 property groups).");
