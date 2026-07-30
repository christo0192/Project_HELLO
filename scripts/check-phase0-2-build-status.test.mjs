#!/usr/bin/env node

/**
 * check-phase0-2-build-status.test.mjs
 *
 * Negative tests for the Phase0-2 build-status checker.
 * Each test temporarily mutates documents and asserts that
 * check-phase0-2-build-status.mjs exits non-zero with the expected
 * error message pattern.
 *
 * Usage: node scripts/check-phase0-2-build-status.test.mjs
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
const checker = path.join(projectRoot, "scripts/check-phase0-2-build-status.mjs");

// Files to copy into each fixture — must include all docs the checker reads
const fixturePaths = [
  "PLAN.md",
  "docs/HANDOVER.md",
  "docs/current-state.md",
  "docs/decisions/fnd-08-inputs.md",
  "docs/decisions/fnd-08-owner-approval.md",
];

async function withFixture(change, expectedMessage) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hello-phase0-2-"));
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
    assert.notEqual(result.status, 0, `Expected failure for: ${expectedMessage}`);
    if (expectedMessage) {
      const output = result.stderr + result.stdout;
      assert.match(
        output,
        new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `Expected output to contain "${expectedMessage}"`
      );
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

const testErrors = [];

// ---------------------------------------------------------------------------
// Baseline: checker must pass on the real repo
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
// Test 1: Missing no-build-blocker statement in PLAN.md must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "PLAN.md");
  const plan = await readFile(target, "utf8");
  // Remove the "None are production/go-live accepted" statement from the top summary
  // and the entire Phase 0 execution status section
  const mutated = plan
    .replace(/None are production\/go-live accepted/i, "All are production/go-live accepted")
    .replace(/\*\*Phase 0 execution status[\s\S]*?(?=\n---\n)/, "Section replaced");
  await writeFile(target, mutated);
}, "must assert build-blocker: none for Phase0-2");

// ---------------------------------------------------------------------------
// Test 2: 0/17 changed (promoted) in PLAN.md must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "PLAN.md");
  const plan = await readFile(target, "utf8");
  // Change "0/17" to "5/17" in the top summary and Phase 0 status
  const mutated = plan
    .replace(/0\s*\/\s*17/g, "5/17")
    .replace(/0\s*\/\s*14/g, "3/14");
  await writeFile(target, mutated);
}, "0/17 launch gates must be preserved");

// ---------------------------------------------------------------------------
// Test 3: D-004 marked as cross-border hard blocker in decision doc must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "docs/decisions/fnd-08-inputs.md");
  const doc = await readFile(target, "utf8");
  // Replace the in-region self-hosted statement with a cross-border hard blocker claim
  const mutated = doc.replace(
    /D-004[^]*?(?:no cross.border|in-region|self.hosted)/i,
    "D-004 | Cross-border data transfer to China; hard go-live blocker | Eng Lead + Legal | Blocked | — |",
  );
  await writeFile(target, mutated);
}, "D-004 must state no cross-border data transfer");

// ---------------------------------------------------------------------------
// Test 4: FND-05 claimed as production-accepted in owner-approval must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "docs/decisions/fnd-08-owner-approval.md");
  const doc = await readFile(target, "utf8");
  // Insert a production-accepted claim for FND-05
  const mutated = doc.replace(
    /FND-05.*?selection is complete.*?pending/is,
    "FND-05 has been production-accepted and deployed",
  );
  await writeFile(target, mutated);
}, "Must not claim production-accepted status");

// ---------------------------------------------------------------------------
// Test 5: FND-06 claimed as production-accepted in owner-approval must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "docs/decisions/fnd-08-owner-approval.md");
  const doc = await readFile(target, "utf8");
  // Insert a production-accepted claim for FND-06
  const mutated = doc.replace(
    /FND-06.*?selection is complete.*?blocked/is,
    "FND-06 is fully production-accepted",
  );
  await writeFile(target, mutated);
}, "Must not claim production-accepted status");

// ---------------------------------------------------------------------------
// Test 6: Production-accepted claim in fnd-08-owner-approval.md must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "docs/decisions/fnd-08-owner-approval.md");
  const doc = await readFile(target, "utf8");
  // Insert "production-accepted" — replace first "Not production/go-live accepted"
  const mutated = doc.replace(
    /Not production\/go-live accepted/i,
    "production-accepted",
  );
  await writeFile(target, mutated);
}, "Must not claim production-accepted status");

// ---------------------------------------------------------------------------
// Test 7: PLAN.md missing D-004 status (hard blocker regression) must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "PLAN.md");
  const plan = await readFile(target, "utf8");
  // Regress D-004 into a hard-blocker claim. The checker clears D-004 via two
  // independent paths, so both must be neutralized for the mutation to bite:
  //   (a) the "Unresolved Phase 2 blockers" paragraph says D-004 is
  //       "no longer a hard go-live blocker" — flip that to a hard-blocker claim.
  //   (b) the D-004 decision-table row is a direction (not "Blocked") — replace
  //       the whole single-line row with a Blocked one.
  const afterParagraph = plan.replace(
    /D-004 no longer a hard go-live blocker/,
    "D-004 is now a hard go-live blocker",
  );
  assert.notEqual(afterParagraph, plan, "Test 7: unresolved-blockers D-004 phrase marker changed");
  const mutated = afterParagraph.replace(
    /\| D-004 \|.*\|/,
    "| D-004 | Scoring provider/hosting: blocked — hard go-live blocker | Eng Lead + Legal | Blocked — hard blocker | 2026-07-30 |",
  );
  assert.notEqual(mutated, afterParagraph, "Test 7: D-004 decision-table row marker changed");
  await writeFile(target, mutated);
}, "D-004 must not be asserted as a hard go-live blocker");

// ---------------------------------------------------------------------------
// Test 8: docs/HANDOVER.md missing PR26 reference must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "docs/HANDOVER.md");
  const handover = await readFile(target, "utf8");
  // Remove PR26 reference
  const mutated = handover.replace(/PR #?26|PR26/g, "PR 99");
  await writeFile(target, mutated);
}, "PR26 must be referenced as merged");

// ---------------------------------------------------------------------------
// Test 9: docs/current-state.md missing pre-production must fail
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "docs/current-state.md");
  const cs = await readFile(target, "utf8");
  // Remove pre-production references
  const mutated = cs.replace(/pre-production/g, "production");
  await writeFile(target, mutated);
}, "Must assert pre-production status");

// ---------------------------------------------------------------------------
// Test 10: FND-05 parked/stale text in HANDOVER fails if removed
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "docs/HANDOVER.md");
  const handover = await readFile(target, "utf8");
  // Override FND-05 status in HANDOVER table row to claim it is deployed
  const mutated = handover.replace(
    /\| FND-05 \|[^|]+\|( [^|]+)\|/,
    "| FND-05 | Fully deployed secret manager exists | **Deployed and accepted** by owner |",
  );
  await writeFile(target, mutated);
}, "FND-05 must be described");

// ---------------------------------------------------------------------------
// Test 11: FND-06 parked/stale text in HANDOVER fails if removed
// ---------------------------------------------------------------------------
await withFixture(async (fixture) => {
  const target = path.join(fixture, "docs/HANDOVER.md");
  const handover = await readFile(target, "utf8");
  // Override FND-06 status in HANDOVER table row to claim it is deployed
  const mutated = handover.replace(
    /\| FND-06 \|[^|]+\|( [^|]+)\|/,
    "| FND-06 | Fully deployed service identities exist | **Deployed and accepted** by owner |",
  );
  await writeFile(target, mutated);
}, "FND-06 must be described");

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (testErrors.length) {
  console.error(`Negative tests FAILED (${testErrors.length}):`);
  for (const e of testErrors) console.error(`- ${e}`);
  process.exit(1);
}

console.log(`All 11 negative phase0-2 build-status tests passed.`);
