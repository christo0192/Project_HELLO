#!/usr/bin/env node

/**
 * check-model-governance-status.test.mjs — Negative controls for the PR-A
 * model-governance status-field validator (Lane A1).
 *
 * Each test builds a small fixture tree under the PR-A scan roots and asserts
 * that check-model-governance-status.mjs exits non-zero for seeded approval /
 * winner / signed / SLSA claims and zero for truthful repository-only states.
 * Positive claims are rejected UNCONDITIONALLY: EV-xxxx references and random
 * UUIDs on the same line cannot bypass the gate (HIGH-review regression).
 * Also proves non-vacuity (at least one artifact file is scanned).
 *
 * Usage: node scripts/check-model-governance-status.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const validator = path.join(projectRoot, "scripts/check-model-governance-status.mjs");

const testErrors = [];

/**
 * Build a fixture tree with the given files under the PR-A scan roots and run
 * the validator with cwd = fixture. Returns the spawn result.
 */
async function runWithFixture(files) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "hello-model-governance-status-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const destination = path.join(fixture, rel);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    return spawnSync(process.execPath, [validator], {
      cwd: fixture,
      encoding: "utf8",
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

const assertRejected = async (files, expectedFragment, label) => {
  const result = await runWithFixture(files);
  assert.notEqual(result.status, 0, `${label}: expected failure (got status ${result.status})`);
  if (expectedFragment) {
    assert.match(
      result.stderr + result.stdout,
      new RegExp(expectedFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${label}: expected stderr to contain "${expectedFragment}"`,
    );
  }
};

const assertPassed = async (files, label) => {
  const result = await runWithFixture(files);
  assert.equal(result.status, 0, `${label}: expected pass\n${result.stderr || result.stdout}`);
};

// ── Baseline: real repo must pass ───────────────────────────────────────
{
  const result = spawnSync(process.execPath, [validator], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    testErrors.push(`Baseline check failed: ${result.stderr}`);
  }
}

// ── Non-vacuity: validator must actually scan files ─────────────────────
{
  const result = await runWithFixture({
    "app/api/src/model-governance/boundary.ts":
      "export const entry = { id: 'x', policyStatus: 'PROPOSED' };\n",
  });
  assert.equal(result.status, 0, `non-vacuity baseline: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /artifact file\(s\) scanned/, "validator must report scanned files");
  if (!/1 artifact file\(s\) scanned/.test(result.stdout)) {
    testErrors.push(`Non-vacuity: expected exactly 1 scanned file, got: ${result.stdout.trim()}`);
  }
}

// ── Rejection controls ──────────────────────────────────────────────────

// 1. status: APPROVED (TS)
await assertRejected(
  { "app/api/src/model-governance/a.ts": "export const s = { status: 'APPROVED' };\n" },
  "status approval claim",
  "status APPROVED rejected",
);

// 2. approvalStatus: DEPLOYED (TS camelCase)
await assertRejected(
  { "app/api/src/model-governance/a.ts": "export const s = { approvalStatus: 'DEPLOYED' };\n" },
  "status approval claim",
  "approvalStatus DEPLOYED rejected",
);

// 3. policy_status = ACCEPTED (Python snake, = separator)
await assertRejected(
  { "app/voice-livekit/model_governance/a.py": "policy_status = \"ACCEPTED\"\n" },
  "status approval claim",
  "policy_status ACCEPTED rejected",
);

// 4. Markdown status line
await assertRejected(
  { "docs/model-governance/status.md": "# X\n\n**Status:** DEPLOYED\n" },
  "status approval claim",
  "markdown Status: DEPLOYED rejected",
);

// 5. winner: true
await assertRejected(
  { "docs/model-governance/status.md": "winner: true\n" },
  "winner claim",
  "winner: true rejected",
);

// 6. winner as a status value
await assertRejected(
  { "docs/model-governance/status.md": "decision: winner\n" },
  "winner status value",
  "decision: winner rejected",
);

// 7. slsa_level greater than zero
await assertRejected(
  { "config/model-governance-eval.schema.json": "{ \"slsa_level\": 2 }\n" },
  "slsa_level greater than zero",
  "slsa_level 2 rejected",
);

// 8. signed: true
await assertRejected(
  { "docs/model-governance/status.md": "signed: true\n" },
  "signed flag set to true",
  "signed: true rejected",
);

// 9. Signed = 1 (Python-style)
await assertRejected(
  { "app/voice-livekit/model_governance/a.py": "signed = 1\n" },
  "signed flag set to true",
  "signed = 1 rejected",
);

// 10. Schema file scanned too (config/model-governance*.schema.json)
await assertRejected(
  { "config/model-governance-x.schema.json": "{ \"policyStatus\": \"APPROVED\" }\n" },
  "status approval claim",
  "schema policyStatus APPROVED rejected",
);

// 11. Runbook scanned (docs/runbooks/model-governance*.md)
await assertRejected(
  { "docs/runbooks/model-governance-ops.md": "## Status\nacceptance: ACCEPTED\n" },
  "status approval claim",
  "runbook acceptance ACCEPTED rejected",
);

// ── HIGH-review regression: no external-evidence escape hatch ───────────
// A positive approval claim is rejected even when an EV-xxxx reference or a
// random UUID appears on the same line. Repository-only work can never
// authorize a positive claim.

// 12. status: APPROVED with same-line EV-FAKE reference
await assertRejected(
  {
    "app/api/src/model-governance/a.ts":
      "export const s = { status: 'APPROVED', evidence_id: 'EV-FAKE' };\n",
  },
  "status approval claim",
  "status APPROVED with EV-FAKE rejected",
);

// 13. policyStatus: APPROVED with a random-UUID evidence reference
await assertRejected(
  {
    "app/api/src/model-governance/a.ts":
      "export const s = { policyStatus: 'APPROVED', evidence_id: '4c8e6f2a-1b3d-4e9f-8a7c-0d5e6f7a8b9c' };\n",
  },
  "status approval claim",
  "policyStatus APPROVED with random UUID rejected",
);

// 14. approvalStatus: DEPLOYED with EV-FAKE (camelCase + ref)
await assertRejected(
  {
    "app/api/src/model-governance/a.ts":
      "export const s = { approvalStatus: 'DEPLOYED', evidence_ref: 'EV-FAKE' };\n",
  },
  "status approval claim",
  "approvalStatus DEPLOYED with EV-FAKE rejected",
);

// 15. winner: true with a random-UUID reference on the same line
await assertRejected(
  {
    "docs/model-governance/status.md":
      "winner: true  # audit 9b2e1a44-5c7d-4f6e-8a2b-1c3d4e5f6a7b\n",
  },
  "winner claim",
  "winner with random UUID rejected",
);

// 16. slsa_level 2 with EV-FAKE reference on the same line
await assertRejected(
  { "config/model-governance-eval.schema.json": "{ \"slsa_level\": 2, \"evidence_id\": \"EV-FAKE\" }\n" },
  "slsa_level greater than zero",
  "slsa_level 2 with EV-FAKE rejected",
);

// 17. signed: true with EV-FAKE reference on the same line
await assertRejected(
  { "docs/model-governance/status.md": "signed: true  (EV-FAKE)\n" },
  "signed flag set to true",
  "signed: true with EV-FAKE rejected",
);

// ── Truthful repository-only states are permitted ───────────────────────
await assertPassed(
  {
    "app/api/src/model-governance/a.ts":
      "export const s = { policyStatus: 'PROPOSED', evidenceStatus: 'PENDING' };\n" +
      "export const t = { policyStatus: 'NOT_EVALUATED' };\n",
    "app/voice-livekit/model_governance/b.py": "policy_status = 'PROPOSED'\n",
    "docs/model-governance/status.md":
      "# Notes\n\n**Status:** PENDING owner verification.\n\nState: OWNER_VERIFY\n",
  },
  "truthful states permitted",
);

// ── Non-positive values are permitted ───────────────────────────────────
await assertPassed(
  {
    "docs/model-governance/status.md":
      "signed: false\nslsa_level: 0\nstatus: rejected\n", // 'rejected' is a truthful screening outcome, not a claim
  },
  "signed false / slsa_level 0 / rejected status permitted",
);

// ── Report ──────────────────────────────────────────────────────────────
if (testErrors.length) {
  console.error(`Model-governance status validator negative tests FAILED (${testErrors.length}):`);
  for (const e of testErrors) console.error(`- ${e}`);
  process.exit(1);
}
console.log("All model-governance status validator negative controls passed (baseline + 20 controls + non-vacuity).");
