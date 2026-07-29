#!/usr/bin/env node

/**
 * check-branch-governance.test.mjs — Test suite for the branch governance verifier.
 *
 * Loads fixtures from scripts/__fixtures__/branch-governance/ and runs
 * positive and negative tests against the check() function.
 *
 * Outputs simple pass/fail lines.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { check } from "./check-branch-governance.mjs";
import { spawnSync } from "node:child_process";

const FIXTURES_DIR = path.join(import.meta.dirname, "__fixtures__/branch-governance");
const VERIFIER = path.join(import.meta.dirname, "check-branch-governance.mjs");

// For legacy support (older Node without import.meta.dirname)
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES_DIR_ALT = path.join(__dirname, "__fixtures__/branch-governance");
const VERIFIER_ALT = path.join(__dirname, "check-branch-governance.mjs");

const fixtureDir = await dirExists(FIXTURES_DIR) ? FIXTURES_DIR : FIXTURES_DIR_ALT;
const verifierPath = await dirExists(path.dirname(VERIFIER)) ? VERIFIER : VERIFIER_ALT;

async function dirExists(p) {
  try {
    const stat = await readdir(p);
    return true;
  } catch { return false; }
}

let passed = 0;
let failed = 0;
let tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  // ---- Positive test ----
  test("all-enforced: exits 0 when all controls ENFORCED", async () => {
    const data = JSON.parse(await readFile(path.join(fixtureDir, "all-enforced.json"), "utf8"));
    const result = check(data);
    if (!result.passed) throw new Error(`Expected passed=true, got ${JSON.stringify(result.failed)}`);
    if (result.failed.length !== 0) throw new Error(`Expected no failures, got ${result.failed.join(", ")}`);
  });

  // ---- Negative tests ----
  test("one-approval-only: exits nonzero when only 1 approval required", async () => {
    const data = JSON.parse(await readFile(path.join(fixtureDir, "one-approval-only.json"), "utf8"));
    const result = check(data);
    if (result.passed) throw new Error("Expected failed for insufficient approvals");
    if (!result.failed.includes("require_two_approvals")) throw new Error("Expected require_two_approvals to fail");
  });

  test("missing-required-checks: exits nonzero when status checks incomplete", async () => {
    const data = JSON.parse(await readFile(path.join(fixtureDir, "missing-required-checks.json"), "utf8"));
    const result = check(data);
    if (result.passed) throw new Error("Expected failed for missing required checks");
    if (!result.failed.includes("required_status_checks")) throw new Error("Expected required_status_checks to fail");
  });

  test("unsigned-commits-allowed: exits nonzero when signed commits not required", async () => {
    const data = JSON.parse(await readFile(path.join(fixtureDir, "unsigned-commits-allowed.json"), "utf8"));
    const result = check(data);
    if (result.passed) throw new Error("Expected failed for unsigned commits");
    if (!result.failed.includes("signed_commits")) throw new Error("Expected signed_commits to fail");
  });

  test("admins-can-bypass: exits nonzero when admins bypass enforcement", async () => {
    const data = JSON.parse(await readFile(path.join(fixtureDir, "admins-can-bypass.json"), "utf8"));
    const result = check(data);
    if (result.passed) throw new Error("Expected failed for admin bypass");
    if (!result.failed.includes("admin_enforcement")) throw new Error("Expected admin_enforcement to fail");
  });

  test("force-push-allowed: exits nonzero when force push not disabled", async () => {
    const data = JSON.parse(await readFile(path.join(fixtureDir, "force-push-allowed.json"), "utf8"));
    const result = check(data);
    if (result.passed) throw new Error("Expected failed for force push allowed");
    if (!result.failed.includes("force_push_disabled")) throw new Error("Expected force_push_disabled to fail");
  });

  test("deletion-allowed: exits nonzero when branch deletion not disabled", async () => {
    const data = JSON.parse(await readFile(path.join(fixtureDir, "deletion-allowed.json"), "utf8"));
    const result = check(data);
    if (result.passed) throw new Error("Expected failed for deletion allowed");
    if (!result.failed.includes("deletion_disabled")) throw new Error("Expected deletion_disabled to fail");
  });

  test("api-401: exits nonzero when API returns 401", async () => {
    const data = JSON.parse(await readFile(path.join(fixtureDir, "api-401.json"), "utf8"));
    const result = check(data);
    if (result.passed) throw new Error("Expected failed for 401 response");
    // All 12 controls should fail on 401
    if (result.failed.length < 12) throw new Error(`Expected all 12 controls to fail on 401, got ${result.failed.length}`);
  });

  test("api-403: exits nonzero when API returns 403", async () => {
    const data = JSON.parse(await readFile(path.join(fixtureDir, "api-403.json"), "utf8"));
    const result = check(data);
    if (result.passed) throw new Error("Expected failed for 403 response");
    if (result.failed.length < 12) throw new Error(`Expected all 12 controls to fail on 403, got ${result.failed.length}`);
  });

  test("api-404: exits nonzero when API returns 404", async () => {
    const data = JSON.parse(await readFile(path.join(fixtureDir, "api-404.json"), "utf8"));
    const result = check(data);
    if (result.passed) throw new Error("Expected failed for 404 response");
    if (result.failed.length < 12) throw new Error(`Expected all 12 controls to fail on 404, got ${result.failed.length}`);
  });

  // ---- Malformed / missing input tests ----
  test("malformed-json: exits 2 when evidence file has malformed JSON", () => {
    const result = spawnSync(process.execPath, [verifierPath, "/dev/stdin"], {
      input: "{ broken json }",
      encoding: "utf8",
    });
    if (result.status !== 2) throw new Error(`Expected exit code 2 for malformed JSON, got ${result.status}`);
  });

  test("missing-file: exits 2 when evidence file not found", () => {
    const result = spawnSync(process.execPath, [verifierPath, "/nonexistent/path/evidence.json"], {
      encoding: "utf8",
    });
    if (result.status !== 2) throw new Error(`Expected exit code 2 for missing file, got ${result.status}`);
  });

  test("network-error-simulation: exits 2 for file read error", () => {
    // Use a directory as the path to simulate read error
    const result = spawnSync(process.execPath, [verifierPath, fixtureDir], {
      encoding: "utf8",
    });
    if (result.status !== 2) throw new Error(`Expected exit code 2 for directory path, got ${result.status}`);
  });

  // ---- Ruleset partial test ----
  test("ruleset-partial: exits nonzero when ruleset covers some controls but not all", async () => {
    const data = JSON.parse(await readFile(path.join(fixtureDir, "ruleset-partial.json"), "utf8"));
    const result = check(data);
    if (result.passed) throw new Error("Expected failed for partial ruleset coverage");
    // This ruleset is missing: non_fast_forward (linear_history), deletion, allow_force_pushes
    // admin_enforcement is enforced because bypass_allowances is empty
    const expectedMissing = ["linear_history", "deletion_disabled", "force_push_disabled"];
    for (const ctrl of expectedMissing) {
      if (!result.failed.includes(ctrl)) throw new Error(`Expected ${ctrl} to fail in partial ruleset`);
    }
    // Verify these are the ONLY failures (should be exactly 3)
    if (result.failed.length !== 3) throw new Error(`Expected exactly 3 failed controls, got ${result.failed.length}: ${result.failed.join(", ")}`);
  });

  // ---- Secret/credential NOT in output test ----
  test("no-secrets-in-output: verifier output never contains token patterns", () => {
    // Run against a fixture and check stderr/stdout for token patterns
    const fixturePath = path.join(fixtureDir, "api-403.json");
    const result = spawnSync(process.execPath, [verifierPath, fixturePath], {
      encoding: "utf8",
    });
    const output = (result.stdout || "") + (result.stderr || "");
    const tokenPatterns = [
      /ghp_[a-zA-Z0-9]{36}/,
      /gho_[a-zA-Z0-9]{36}/,
      /github_pat_[a-zA-Z0-9]{22,}/,
      /Bearer\s+[a-zA-Z0-9_\-.]+/,
      /Authorization:/i,
      /token.*=/i,
      /xox[baprs]-/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
    ];
    for (const pattern of tokenPatterns) {
      if (pattern.test(output)) {
        throw new Error(`Secret pattern ${pattern} found in output`);
      }
    }
  });

  // ---- Run tests ----
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`PASS: ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`FAIL: ${t.name} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(2);
});
