#!/usr/bin/env node
/**
 * Hosting foundations — non-vacuous static/negative-control tests (L1).
 *
 * Verifies the managed-hosting lane deliverables:
 *  - requirements.txt: exact `==` direct pins only, expected pins present.
 *  - Dockerfile: multi-stage python:3.12-slim, non-root, production `start`
 *    entrypoint, no probe instruction, no blanket copy, no .env.
 *  - .dockerignore: excludes secrets/VCS/venv/caches/tests.
 *  - docker-compose.yml: non-root user, no probe, env passthrough only.
 *  - validate-container.sh and validate-no-secrets-baked.sh: baseline pass,
 *    seeded negative fixtures fail (non-vacuity proof).
 *  - ADR-0010 accepted; ADR-0007 supersession updated; index updated.
 *  - Runbooks present, OWNER_VERIFY-marked, no production claims, no secrets.
 *  - current-state invariants unchanged; no .env baked.
 *
 * Bounded: offline, no Docker, no network, no provider commands, no model
 * downloads, no secrets.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error.message}`);
    console.error(`not ok - ${name}: ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error.message}`);
    console.error(`not ok - ${name}: ${error.message}`);
  }
}

const read = async (p) => readFile(path.join(root, p), "utf8");
const exists = async (p) => {
  try { await readFile(path.join(root, p)); return true; } catch { return false; }
};

const isExactPin = (line) => /^[A-Za-z0-9_.-]+==[^=]+$/.test(line);
const expectedPins = [
  "livekit-agents==1.6.4",
  "livekit-plugins-openai==1.6.4",
  "livekit-plugins-sarvam==1.6.4",
  "livekit-plugins-silero==1.6.4",
  "livekit-plugins-turn-detector==1.6.4",
  "python-dotenv==1.2.2",
  "supabase==2.31.0",
  "httpx==0.28.1",
];


// ── requirements.txt ──────────────────────────────────────────────────────
await checkAsync("requirements.txt exists", async () => {
  assert.equal(await exists("app/voice-livekit/requirements.txt"), true);
});
await checkAsync("requirements.txt is exactly == pinned and non-vacuous", async () => {
  const content = await read("app/voice-livekit/requirements.txt");
  const depLines = content.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  assert.ok(depLines.length >= 7, "at least 7 pinned dependencies");
  for (const line of depLines) {
    assert.ok(isExactPin(line.trim()), `line is not an exact == pin: ${line}`);
    assert.ok(!/[<>=~*]/.test(line.replace(/==[^=]+$/, "")), `name constraint present: ${line}`);
  }
  for (const pin of expectedPins) {
    assert.ok(depLines.includes(pin), `missing expected pin ${pin}`);
  }
});
check("isExactPin negative controls", () => {
  assert.equal(isExactPin("livekit-agents>=1.6.4"), false);
  assert.equal(isExactPin("livekit-agents~=1.6.4"), false);
  assert.equal(isExactPin("livekit-agents"), false);
  assert.equal(isExactPin(""), false);
  assert.equal(isExactPin("livekit-agents==1.6.4==x"), false);
});

// ── Dockerfile ────────────────────────────────────────────────────────────
await checkAsync("Dockerfile contract", async () => {
  const dockerfile = await read("app/voice-livekit/Dockerfile");
  assert.match(dockerfile, /FROM python:3\.12-slim AS builder/);
  assert.match(dockerfile, /FROM python:3\.12-slim AS runtime/);
  assert.match(dockerfile, /USER 1000:1000/);
  assert.match(dockerfile, /groupadd --gid 1000 agent/);
  assert.match(dockerfile, /useradd --uid 1000 --gid 1000/);
  assert.match(dockerfile, /ENTRYPOINT \["python", "agent\.py", "start"\]/);
  assert.doesNotMatch(dockerfile, /"dev"/);
  assert.doesNotMatch(dockerfile, /"console"/);
  assert.doesNotMatch(dockerfile, /^[ \t]*HEALTHCHECK/m);
  assert.doesNotMatch(dockerfile, /COPY \. \./);
  assert.doesNotMatch(dockerfile, /COPY .*\.env/);
  assert.match(dockerfile, /--no-cache-dir/);
  assert.match(dockerfile, /PYTHONPYCACHEPREFIX/);
});
check("Dockerfile production command is start (not dev)", async () => {
  const dockerfile = await read("app/voice-livekit/Dockerfile");
  assert.match(dockerfile, /python", "agent\.py", "start"/);
  assert.doesNotMatch(dockerfile, /python", "agent\.py", "dev"/);
});

// ── .dockerignore ─────────────────────────────────────────────────────────
await checkAsync(".dockerignore exclusions", async () => {
  const dockerignore = await read("app/voice-livekit/.dockerignore");
  for (const pattern of [".env", ".git", ".venv", "venv", "tests", "__pycache__", "Dockerfile", "docker-compose.yml", ".env.example"]) {
    assert.ok(dockerignore.includes(pattern), `.dockerignore missing ${pattern}`);
  }
  assert.match(dockerignore, /\.env\.\*/);
});

// ── docker-compose.yml ────────────────────────────────────────────────────
await checkAsync("docker-compose.yml contract", async () => {
  const compose = await read("app/voice-livekit/docker-compose.yml");
  assert.match(compose, /user: "1000:1000"/);
  assert.doesNotMatch(compose, /HEALTHCHECK|healthcheck/i);
  assert.match(compose, /\$\{LIVEKIT_URL:-\}/);
  assert.match(compose, /\$\{LIVEKIT_API_SECRET:-\}/);
  assert.doesNotMatch(compose, /sk-(ant|live|proj)-/);
  assert.doesNotMatch(compose, /[A-F0-9]{32,}/);
});

// ── no .env baked ─────────────────────────────────────────────────────────
await checkAsync("no .env file in build context (only .env.example)", async () => {
  assert.equal(await exists("app/voice-livekit/.env"), false, ".env must not exist");
  assert.equal(await exists("app/voice-livekit/.env.example"), true);
});

// ── validators: baseline pass + seeded negative controls ─────────────────
const VALIDATOR = path.join(root, "scripts/validate-no-secrets-baked.sh");
const CONTAINER_VALIDATOR = path.join(root, "scripts/validate-container.sh");

await checkAsync("validate-no-secrets-baked baseline passes on build context", async () => {
  const result = spawnSync("bash", [VALIDATOR, "app/voice-livekit"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

async function withFixture(files, fn) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hello-hosting-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const destination = path.join(fixture, rel);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    return await fn(fixture);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

await checkAsync("validate-no-secrets-baked rejects synthetic sentinel (non-vacuity)", async () => {
  await withFixture({ "bad/sentinel.txt": "SYNTHETIC_FORBIDDEN_SECRET_VALUE\n" }, async (fixture) => {
    const result = spawnSync("bash", [VALIDATOR, path.join(fixture, "bad")], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `sentinel fixture must fail (got ${result.status})`);
    assert.match(result.stderr, /synthetic sentinel/i);
  });
});

await checkAsync("validate-no-secrets-baked rejects baked .env", async () => {
  await withFixture({ "bad/.env": "LIVEKIT_API_SECRET=replace_me\n" }, async (fixture) => {
    const result = spawnSync("bash", [VALIDATOR, path.join(fixture, "bad")], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `.env fixture must fail (got ${result.status})`);
  });
});

await checkAsync("validate-no-secrets-baked rejects secret-looking values", async () => {
  await withFixture({ "bad/env.txt": "SUPABASE_SERVICE_ROLE_KEY=xyz\n"
 }, async (fixture) => {
    const result = spawnSync("bash", [VALIDATOR, path.join(fixture, "bad")], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `secret-value fixture must fail (got ${result.status})`);
  });
});

await checkAsync("validate-no-secrets-baked allows documented placeholders", async () => {
  await withFixture({ "ok/env.txt": "SUPABASE_SERVICE_ROLE_KEY=replace_me\nLIVEKIT_API_KEY=replace_me\n" }, async (fixture) => {
    const result = spawnSync("bash", [VALIDATOR, path.join(fixture, "ok")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});

await checkAsync("validate-container baseline passes (static subset)", async () => {
  const result = spawnSync("bash", [CONTAINER_VALIDATOR], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

await checkAsync("validate-container rejects a HEALTHCHECK-bearing Dockerfile", async () => {
  await withFixture({
    "requirements.txt": "livekit-agents==1.6.4\n",
    "Dockerfile": "FROM python:3.12-slim AS builder\nRUN true\nFROM python:3.12-slim AS runtime\nUSER 1000:1000\nHEALTHCHECK CMD echo ok\nENTRYPOINT [\"python\",\"agent.py\",\"start\"]\n",
    ".dockerignore": ".env\n.git\n",
    "docker-compose.yml": "services:\n  x:\n    user: \"1000:1000\"\n",
  }, async (fixture) => {
    const result = spawnSync("bash", [CONTAINER_VALIDATOR, fixture], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `HEALTHCHECK fixture must fail (got ${result.status})`);
  });
});

await checkAsync("validate-container rejects a dev-mode entrypoint", async () => {
  await withFixture({
    "requirements.txt": "livekit-agents==1.6.4\n",
    "Dockerfile": "FROM python:3.12-slim AS builder\nRUN true\nFROM python:3.12-slim AS runtime\nUSER 1000:1000\nENTRYPOINT [\"python\",\"agent.py\",\"dev\"]\n",
    ".dockerignore": ".env\n.git\n",
    "docker-compose.yml": "services:\n  x:\n    user: \"1000:1000\"\n",
  }, async (fixture) => {
    const result = spawnSync("bash", [CONTAINER_VALIDATOR, fixture], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `dev-entrypoint fixture must fail (got ${result.status})`);
  });
});

await checkAsync("validate-container rejects non-== pins", async () => {
  await withFixture({
    "requirements.txt": "livekit-agents>=1.6.4\n",
    "Dockerfile": "FROM python:3.12-slim AS builder\nRUN true\nFROM python:3.12-slim AS runtime\nUSER 1000:1000\nENTRYPOINT [\"python\",\"agent.py\",\"start\"]\n",
    ".dockerignore": ".env\n.git\n",
    "docker-compose.yml": "services:\n  x:\n    user: \"1000:1000\"\n",
  }, async (fixture) => {
    const result = spawnSync("bash", [CONTAINER_VALIDATOR, fixture], { encoding: "utf8" });
    assert.notEqual(result.status, 0, `non-pinned fixture must fail (got ${result.status})`);
  });
});

// ── ADRs ──────────────────────────────────────────────────────────────────
await checkAsync("ADR-0010 present and accepted with required sections", async () => {
  const adr = await read("docs/adr/0010-hosting-topology.md");
  assert.match(adr, /^# ADR-0010: /m);
  assert.match(adr, /^\*\*Status:\*\* Accepted$/m);
  assert.match(adr, /^\*\*Decision owner:\*\* .+$/m);
  assert.match(adr, /^\*\*Plan references:\*\* .+$/m);
  for (const section of ["Context", "Decision", "Consequences", "Evidence", "Supersession"]) {
    assert.ok(adr.includes(`## ${section}\n`), `ADR-0010 missing ${section}`);
  }
});
await checkAsync("ADR-0010 supersedes scoped ADR-0007/FND-05 portions", async () => {
  const adr = await read("docs/adr/0010-hosting-topology.md");
  assert.match(adr, /ADR-0007/);
  assert.match(adr, /FND-05/);
  assert.match(adr, /not\s+production acceptance/i);
});
await checkAsync("ADR-0007 supersession updated narrowly", async () => {
  const adr7 = await read("docs/adr/0007-production-deployment-and-region.md");
  const supersession = adr7.split("## Supersession")[1] ?? "";
  assert.match(supersession, /0010-hosting-topology\.md/);
  assert.match(supersession, /superseded/i);
  // Only the Supersession section may mention ADR-0010 in ADR-0007.
  assert.equal((adr7.match(/0010-hosting-topology/g) ?? []).length, 1);
});
await checkAsync("ADR index includes ADR-0010", async () => {
  const index = await read("docs/adr/README.md");
  assert.match(index, /\(0010-hosting-topology\.md\)/);
});
await checkAsync("check-adrs.mjs passes", async () => {
  const result = spawnSync(process.execPath, ["scripts/check-adrs.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

// ── Runbooks ──────────────────────────────────────────────────────────────
const runbooks = [
  "docs/runbooks/hosting-livekit-cloud.md",
  "docs/runbooks/hosting-infisical.md",
  "docs/runbooks/hosting-vps-fallback.md",
  "docs/runbooks/hosting-e2-gateway.md",
];
await checkAsync("runbooks present, OWNER_VERIFY-marked, no production claims", async () => {
  for (const runbook of runbooks) {
    const content = await read(runbook);
    assert.ok(content.includes("OWNER_VERIFY") || content.includes("PENDING owner"),
      `${runbook} missing OWNER_VERIFY/PENDING owner marker`);
    assert.ok(content.includes("PENDING"), `${runbook} missing PENDING marker`);
    for (const forbidden of [/production-ready/i, /\bis deployed\b/i, /\blive in production\b/i, /\bdeployed and verified\b/i]) {
      assert.doesNotMatch(content, forbidden, `${runbook} contains a production claim`);
    }
    assert.doesNotMatch(content, /sk-(ant|live|proj)-/);
    assert.doesNotMatch(content, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  }
});
await checkAsync("runbooks do not contain real credential shapes", async () => {
  for (const runbook of runbooks) {
    const content = await read(runbook);
    assert.doesNotMatch(content, /\b[A-Za-z0-9_-]{40,}\b/, `${runbook} contains a long token-shaped string`);
    assert.doesNotMatch(content, /LIVEKIT_API_SECRET=[^ \t\n]+/);
  }
});

// ── current-state invariants ──────────────────────────────────────────────
await checkAsync("current-state invariants unchanged", async () => {
  const state = JSON.parse(await read("config/current-state.json"));
  assert.equal(state.status.production, "pre-production");
  assert.equal(state.status.dataStage, "synthetic-only");
  assert.equal(state.status.scope, "browser-only");
  assert.equal(state.gates.launchGatesComplete, 0);
  assert.equal(state.gates.launchGatesTotal, 17);
  assert.equal(state.phases.acceptedPhasesComplete, 0);
  assert.equal(state.phases.acceptedPhasesTotal, 14);
  assert.equal(state.evidenceDate, "2026-07-30");
});
await checkAsync("check-current-state.mjs passes", async () => {
  const result = spawnSync(process.execPath, ["scripts/check-current-state.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

// ── git diff --check ──────────────────────────────────────────────────────
await checkAsync("git diff --check clean", async () => {
  const result = spawnSync("git", ["diff", "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

// ── summary ───────────────────────────────────────────────────────────────
if (failed > 0) {
  console.error(`\nvalidate-hosting-foundation: FAILED (${failed} failed, ${passed} passed)`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}
console.log(`\nvalidate-hosting-foundation: PASS (${passed} checks)`);
