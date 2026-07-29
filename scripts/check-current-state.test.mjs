#!/usr/bin/env node

/**
 * check-current-state.test.mjs — Negative tests for the current-state drift checker
 *
 * Each test temporarily mutates config/current-state.json or surrounding
 * files and asserts that check-current-state.mjs exits non-zero with the
 * expected error message pattern.
 *
 * Usage: node scripts/check-current-state.test.mjs
 *   exit 0: all negative tests pass
 *   exit 1: one or more tests failed
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const checker = path.join(projectRoot, "scripts/check-current-state.mjs");
const manifestPath = "config/current-state.json";

// Files to copy into each fixture
const fixturePaths = [
  "config/current-state.json",
  "config/current-state.schema.json",
  "README.md",
  "app/README.md",
  "docs/HANDOVER.md",
  "docs/repository-inventory.md",
  "docs/current-state.md",
  "CONTRIBUTING.md",
  "PLAN.md",
];

async function withFixture(change, expectedMessage) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hello-current-state-"));
  try {
    for (const relativePath of fixturePaths) {
      const destination = path.join(fixture, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await cp(path.join(projectRoot, relativePath), destination, { recursive: true });
      } catch {
        // Some fixture files may not exist yet (e.g., docs/current-state.md);
        // create an empty placeholder so the checker doesn't fail on missing doc
        if (relativePath !== "config/current-state.json" && relativePath !== "config/current-state.schema.json") {
          await writeFile(destination, "placeholder");
        }
      }
    }
    await change(fixture);
    const result = spawnSync(process.execPath, [checker], {
      cwd: fixture,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `Expected failure for: ${expectedMessage}`);
    if (expectedMessage) {
      assert.match(
        result.stderr + result.stdout,
        new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `Expected stderr to contain "${expectedMessage}"`
      );
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

const testErrors = [];

// ---------------------------------------------------------------------------
// Baseline: manifest must pass on the real repo
// ---------------------------------------------------------------------------
(function () {
  const result = spawnSync(process.execPath, [checker], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    testErrors.push(`Baseline check failed: ${result.stderr}`);
  }
})();

// ---------------------------------------------------------------------------
// Test 1: Stale provider marked as "current" must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  const pipecat = m.providers.stale.find((p) => p.name === "Pipecat");
  if (pipecat) pipecat.status = "current";
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, 'Stale provider "Pipecat" has status "current"');

// ---------------------------------------------------------------------------
// Test 2: Production claim must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  m.status.production = "production";
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, 'status.production is "production"');

// ---------------------------------------------------------------------------
// Test 3: Gate-count drift — launchGatesComplete > 0 must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  m.gates.launchGatesComplete = 5;
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, "launchGatesComplete is 5");

// ---------------------------------------------------------------------------
// Test 4: Telephony-as-current claim must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  m.status.scope = "telephony";
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, 'status.scope is "telephony"');

// ---------------------------------------------------------------------------
// Test 5: Missing mandatory doc must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  m.docsStatus.mandatoryDocsPresent.push("docs/nonexistent.md");
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, "Mandatory doc missing: docs/nonexistent.md");

// ---------------------------------------------------------------------------
// Test 6: Malformed schema (invalid JSON) must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  await writeFile(target, "this is not json");
}, "Cannot parse config/current-state.json");

// ---------------------------------------------------------------------------
// Test 7: Stale provider missing Pipecat must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  m.providers.stale = m.providers.stale.filter((p) => p.name !== "Pipecat");
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, 'Stale provider list must include "Pipecat"');

// ---------------------------------------------------------------------------
// Test 8: Provider in both active and stale must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  m.providers.active.push({ name: "Pipecat", status: "current", evidenceDate: "2026-07-29" });
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, 'Provider "Pipecat" appears in both active and stale lists');

// ---------------------------------------------------------------------------
// Test 9: Phases count drift must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  m.phases.acceptedPhasesTotal = 20;
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, "acceptedPhasesTotal is 20");

// ---------------------------------------------------------------------------
// Test 10: Mandatory-doc path escape must fail before filesystem access
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  m.docsStatus.mandatoryDocsPresent.push("../outside.md");
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, "Mandatory doc path is unsafe");

// ---------------------------------------------------------------------------
// Test 11: Active component path escape must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  m.runtime.activeComponents.api.path = "../../outside";
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, 'Active component "api" has unsafe path');

// ---------------------------------------------------------------------------
// Test 12: Missing required nested object fails cleanly
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  delete m.status;
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, "manifest.status is required");

// ---------------------------------------------------------------------------
// Test 13: Impossible evidence date must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  m.evidenceDate = "2026-02-30";
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, "evidenceDate must be a real YYYY-MM-DD UTC date");

// ---------------------------------------------------------------------------
// Test 14: Future evidence date must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, manifestPath);
  const m = JSON.parse(await readFile(target, "utf8"));
  m.evidenceDate = "2999-01-01";
  await writeFile(target, `${JSON.stringify(m, null, 2)}\n`);
}, "evidenceDate 2999-01-01 is in the future");

// ---------------------------------------------------------------------------
// Test 15: PLAN gate count is authoritative
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "PLAN.md");
  const plan = await readFile(target, "utf8");
  await writeFile(target, plan.replace(/^- \[ \] \*\*DATA-GATE:.*$/m, ""));
}, "PLAN.md defines 16");

// ---------------------------------------------------------------------------
// Test 16: Handover must record merged PR #19
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "docs/HANDOVER.md");
  const handover = await readFile(target, "utf8");
  await writeFile(target, handover.replace(/PR #19/g, "PR nineteen"));
}, "docs/HANDOVER.md missing current-state marker");

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (testErrors.length) {
  console.error(`Negative tests FAILED (${testErrors.length}):`);
  for (const e of testErrors) console.error(`- ${e}`);
  process.exit(1);
}

// Count actual tests run (exclude baseline)
console.log(`All 16 negative current-state tests passed.`);
