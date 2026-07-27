#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const checker = path.join(projectRoot, "scripts/check-env-contract.mjs");
const fixturePaths = [
  "config/environment.schema.json",
  "app/api/.env.example",
  "app/api/src",
  "app/web/.env.example",
  "app/web/src",
  "app/voice-livekit/.env.example",
  "app/voice-livekit/agent.py",
  "app/voice-livekit/persistence.py",
  "app/voice-livekit/prompting.py",
];

async function withFixture(change, expectedMessage) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hello-env-contract-"));
  try {
    for (const relativePath of fixturePaths) {
      const destination = path.join(fixture, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(projectRoot, relativePath), destination, { recursive: true });
    }
    await change(fixture);
    const result = spawnSync(process.execPath, [checker], {
      cwd: fixture,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `expected failure for ${expectedMessage}`);
    assert.match(result.stderr, new RegExp(expectedMessage));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

const baseline = spawnSync(process.execPath, [checker], {
  cwd: projectRoot,
  encoding: "utf8",
});
assert.equal(baseline.status, 0, baseline.stderr);

await withFixture(async (fixture) => {
  const target = path.join(fixture, "app/web/.env.example");
  await writeFile(target, `${await readFile(target, "utf8")}UNKNOWN_SETTING=value\n`);
}, "unknown example variable UNKNOWN_SETTING");

await withFixture(async (fixture) => {
  const target = path.join(fixture, "app/api/.env.example");
  const content = await readFile(target, "utf8");
  await writeFile(target, content.replace("LIVEKIT_API_SECRET=replace_me", "LIVEKIT_API_SECRET=unsafe-sample"));
}, "secret LIVEKIT_API_SECRET must use replace_me");

await withFixture(async (fixture) => {
  const target = path.join(fixture, "config/environment.schema.json");
  const schema = JSON.parse(await readFile(target, "utf8"));
  delete schema.components.web.variables.VITE_API_BASE;
  await writeFile(target, `${JSON.stringify(schema, null, 2)}\n`);
}, "runtime variable VITE_API_BASE is missing from schema");

console.log("Environment contract negative tests passed.");
