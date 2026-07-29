#!/usr/bin/env node

/**
 * check-main-provenance.test.mjs — Full test suite for commit provenance verifier.
 *
 * All tests run sequentially. A network-call trap wraps globalThis.fetch to
 * reject any non-loopback URL, ensuring zero external network calls.
 */

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, classifyCommit, main, validateSha } from "./check-main-provenance.mjs";

// ---------------------------------------------------------------------------
// Network-call trap
// ---------------------------------------------------------------------------
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+/;
const originalFetch = globalThis.fetch;
let extCallCount = 0;
globalThis.fetch = (...args) => {
  const url = typeof args[0] === "string" ? args[0] : (args[0]?.url || args[0]?.href || "");
  if (!LOOPBACK.test(url)) { extCallCount++; throw new Error(`FORBIDDEN_EXTERNAL_NETWORK_CALL: ${url}`); }
  return originalFetch(...args);
};

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERIFIER = path.join(SCRIPT_DIR, "check-main-provenance.mjs");
const CTX = { branch: "main" };

/** Build an evidence object. */
function ev(overrides = {}) {
  return {
    metadata: { branch: "main", checked_at: "2026-01-01T00:00:00Z", ...(overrides.metadata || {}) },
    commits: overrides.commits || [],
  };
}

/** Build a resolved commit object as the verifier's classifyCommit expects. */
function commit(parents, message) {
  return { parents: Array.isArray(parents) ? parents : [parents], message: String(message) };
}

// ---------------------------------------------------------------------------
// Async test runner
// ---------------------------------------------------------------------------
const tests = [];
const _ASYNC_RUNNER_SELF_TEST_FAILED = Symbol("runner-self-test");
function register(name, fn) { tests.push({ name, fn }); }

register("__ASYNC_RUNNER_SELF_TEST", async () => { throw _ASYNC_RUNNER_SELF_TEST_FAILED; });

// ===================================================================
// classifyCommit unit tests
// ===================================================================

register("classify-squash-merge-accepted", () => {
  const r = classifyCommit(commit(["abc"], "feat: add login page (#42)"));
  if (r.verdict !== "accepted") throw new Error(`expected accepted, got ${r.verdict}`);
});

register("classify-squash-merge-multi-line-message", () => {
  const r = classifyCommit(commit(["abc"], "feat: add login page (#42)\n\nThis adds the login page with OAuth support."));
  if (r.verdict !== "accepted") throw new Error(`expected accepted, got ${r.verdict}`);
});

register("classify-squash-merge-number-at-end", () => {
  const r = classifyCommit(commit(["abc"], "fix: correct validation (#1234)"));
  if (r.verdict !== "accepted") throw new Error(`expected accepted, got ${r.verdict}`);
});

register("classify-direct-push-no-pr-ref", () => {
  const r = classifyCommit(commit(["abc"], "fix typo in README"));
  if (r.verdict !== "direct-push") throw new Error(`expected direct-push, got ${r.verdict}`);
});

register("classify-direct-push-empty-message", () => {
  const r = classifyCommit(commit(["abc"], ""));
  if (r.verdict !== "direct-push") throw new Error(`expected direct-push, got ${r.verdict}`);
});

register("classify-direct-push-numeric-parents-not-ref", () => {
  const r = classifyCommit(commit(["abc"], "feat: support 64-bit (# not a number)"));
  if (r.verdict !== "direct-push") throw new Error(`expected direct-push, got ${r.verdict}`);
});

register("classify-merge-commit-two-parents-squash-message", () => {
  // Even with (#N) in message, 2+ parents = merge commit
  const r = classifyCommit(commit(["abc", "def"], "feat: add login page (#42)"));
  if (r.verdict !== "merge-commit") throw new Error(`expected merge-commit, got ${r.verdict}`);
});

register("classify-merge-commit-three-parents", () => {
  const r = classifyCommit(commit(["abc", "def", "ghi"], "Merge branch 'feature-x' into main"));
  if (r.verdict !== "merge-commit") throw new Error(`expected merge-commit, got ${r.verdict}`);
});

register("classify-merge-commit-github-merge-message", () => {
  const r = classifyCommit(commit(["abc", "def"], "Merge pull request #123 from user/branch"));
  if (r.verdict !== "merge-commit") throw new Error(`expected merge-commit, got ${r.verdict}`);
});

register("classify-merge-commit-octopus", () => {
  const r = classifyCommit(commit(["a", "b", "c", "d"], "Octopus merge"));
  if (r.verdict !== "merge-commit") throw new Error(`expected merge-commit, got ${r.verdict}`);
});

register("classify-error-null-commit", () => {
  const r = classifyCommit(null);
  if (r.verdict !== "error") throw new Error(`expected error, got ${r.verdict}`);
});

register("classify-error-undefined-commit", () => {
  const r = classifyCommit(undefined);
  if (r.verdict !== "error") throw new Error(`expected error, got ${r.verdict}`);
});

register("classify-error-non-object-commit", () => {
  const r = classifyCommit("string");
  if (r.verdict !== "error") throw new Error(`expected error, got ${r.verdict}`);
});

register("classify-error-missing-parents", () => {
  const r = classifyCommit({ message: "msg" });
  if (r.verdict !== "error") throw new Error(`expected error, got ${r.verdict}`);
});

register("classify-error-null-parents", () => {
  const r = classifyCommit({ parents: null, message: "msg" });
  if (r.verdict !== "error") throw new Error(`expected error, got ${r.verdict}`);
});

register("classify-error-zero-parents", () => {
  const r = classifyCommit(commit([], "root commit"));
  if (r.verdict !== "error") throw new Error(`expected error, got ${r.verdict}`);
});

register("classify-error-empty-string-parent", () => {
  // parents array with empty string entries
  const r = classifyCommit({ parents: [""], message: "msg" });
  if (r.verdict !== "direct-push") throw new Error(`expected direct-push for single empty parent, got ${r.verdict}`);
});

// ===================================================================
// check() integration tests — accepted
// ===================================================================

register("check-single-squash-merge-accepted", () => {
  const r = check(ev({ commits: [commit(["abc"], "feat: x (#42)")] }), CTX);
  if (!r.passed) throw new Error(`should pass: ${r.summary}`);
  if (r.provenance.accepted_count !== 1) throw new Error("accepted_count should be 1");
  if (r.provenance.rejected_count !== 0) throw new Error("rejected_count should be 0");
});

register("check-multiple-squash-merges-accepted", () => {
  const r = check(ev({ commits: [
    commit(["a"], "feat: 1 (#1)"),
    commit(["b"], "feat: 2 (#2)"),
    commit(["c"], "feat: 3 (#3)"),
  ] }), CTX);
  if (!r.passed) throw new Error(`should pass: ${r.summary}`);
  if (r.provenance.accepted_count !== 3) throw new Error("accepted_count should be 3");
});

register("check-squash-merge-complex-message", () => {
  const r = check(ev({ commits: [
    commit(["a"], "feat(api): add search endpoint with pagination (#456)\n\nBREAKING CHANGE: query params changed"),
  ] }), CTX);
  if (!r.passed) throw new Error(`should pass: ${r.summary}`);
});

// ===================================================================
// check() integration tests — rejected
// ===================================================================

register("check-single-direct-push-rejected", () => {
  const r = check(ev({ commits: [commit(["abc"], "direct push commit")] }), CTX);
  if (r.passed) throw new Error("should fail on direct push");
  if (r.provenance.direct_push_count !== 1) throw new Error("direct_push_count should be 1");
});

register("check-single-merge-commit-rejected", () => {
  const r = check(ev({ commits: [commit(["abc", "def"], "Merge pull request #1 from branch")] }), CTX);
  if (r.passed) throw new Error("should fail on merge commit");
  if (r.provenance.merge_commit_count !== 1) throw new Error("merge_commit_count should be 1");
});

register("check-mixed-provenance-rejected", () => {
  const r = check(ev({ commits: [
    commit(["a"], "feat: good (#1)"),
    commit(["b", "c"], "Merge PR #2"),
    commit(["d"], "direct push"),
  ] }), CTX);
  if (r.passed) throw new Error("should fail on mixed provenance");
  if (r.provenance.accepted_count !== 1) throw new Error("accepted_count should be 1");
  if (r.provenance.rejected_count !== 2) throw new Error("rejected_count should be 2");
  if (r.provenance.merge_commit_count !== 1) throw new Error("merge_commit_count should be 1");
  if (r.provenance.direct_push_count !== 1) throw new Error("direct_push_count should be 1");
});

register("check-all-direct-pushes-rejected", () => {
  const r = check(ev({ commits: [
    commit(["a"], "fix 1"),
    commit(["b"], "fix 2"),
    commit(["c"], "fix 3"),
  ] }), CTX);
  if (r.passed) throw new Error("should fail on all direct pushes");
  if (r.provenance.direct_push_count !== 3) throw new Error("direct_push_count should be 3");
});

register("check-all-merge-commits-rejected", () => {
  const r = check(ev({ commits: [
    commit(["a", "b"], "merge 1"),
    commit(["c", "d"], "merge 2"),
  ] }), CTX);
  if (r.passed) throw new Error("should fail on all merge commits");
  if (r.provenance.merge_commit_count !== 2) throw new Error("merge_commit_count should be 2");
});

register("check-empty-message-direct-push", () => {
  const r = check(ev({ commits: [commit(["abc"], "")] }), CTX);
  if (r.passed) throw new Error("empty message should fail as direct push");
});

register("check-message-with-number-not-pr-ref", () => {
  const r = check(ev({ commits: [commit(["abc"], "fix: handle 404 errors")] }), CTX);
  if (r.passed) throw new Error("message with 404 should not count as PR ref");
});

register("check-merge-commit-with-pr-number-in-message", () => {
  // Even with (#N), if 2+ parents = merge commit
  const r = check(ev({ commits: [commit(["abc", "def"], "merge (#42)")] }), CTX);
  if (r.passed) throw new Error("merge commit with pr ref in message should still be rejected");
  if (r.provenance.merge_commit_count !== 1) throw new Error("merge_commit_count should be 1");
});

// ===================================================================
// check() malformed evidence tests
// ===================================================================

register("check-evidence-not-object", () => {
  const r = check("string", CTX);
  if (!r._error) throw new Error("non-object should error");
});

register("check-evidence-null", () => {
  const r = check(null, CTX);
  if (!r._error) throw new Error("null should error");
});

register("check-evidence-array", () => {
  const r = check([], CTX);
  if (!r._error) throw new Error("array should error");
});

register("check-metadata-missing", () => {
  const r = check({ commits: [] }, CTX);
  if (!r._error) throw new Error("missing metadata should error");
});

register("check-metadata-not-object", () => {
  const r = check({ metadata: "string", commits: [] }, CTX);
  if (!r._error) throw new Error("non-object metadata should error");
});

register("check-commits-not-array", () => {
  const r = check(ev(), CTX);
  // ev() with no commits override defaults to [] which is fine
  // So let's test explicit non-array
  const r2 = check({ metadata: { branch: "main" }, commits: "string" }, CTX);
  if (!r2._error) throw new Error("string commits should error");
});

register("check-commits-empty", () => {
  const r = check(ev({ commits: [] }), CTX);
  if (!r._error) throw new Error("empty commits should error");
});

register("check-branch-mismatch", () => {
  const r = check(ev({ metadata: { branch: "develop" }, commits: [commit(["a"], "msg")] }), CTX);
  if (r._error !== "branch-mismatch") throw new Error(`expected branch-mismatch, got ${r._error}`);
});

register("check-metadata-with-null-commits", () => {
  const r = check({ metadata: { branch: "main" }, commits: null }, CTX);
  if (!r._error) throw new Error("null commits should error");
});

register("check-commit-embedded-error", () => {
  // Commit with error verdict
  const r = check(ev({ commits: [null] }), CTX);
  if (r.passed) throw new Error("null commit should fail");
  if (r.provenance.error_count !== 1) throw new Error("error_count should be 1");
});

// ===================================================================
// Redaction tests
// ===================================================================

register("redaction-no-sha-in-output", () => {
  const r = check(ev({ commits: [
    commit(["abc123def"], "feat: x (#42)"),
  ] }), CTX);
  const json = JSON.stringify(r);
  // The output (provenance/summary) should not contain SHA values
  // Note: The internal commit sha is not output in the redacted result
  if (json.includes("abc123def")) throw new Error("SHA leaked into output");
});

register("redaction-no-message-in-output", () => {
  const r = check(ev({ commits: [commit(["a"], "feat: secret (#42)")] }), CTX);
  const json = JSON.stringify(r);
  // The internal commit message should not appear in redacted output
  // The summary only says "accepted" or "rejected"
  if (json.includes("feat: secret")) throw new Error("message leaked into output");
});

register("redaction-summary-generic", () => {
  const r = check(ev({ commits: [commit(["a"], "feat: x (#42)")] }), CTX);
  if (r.summary.includes("(#42")) throw new Error("PR number leaked into summary");
});

register("redaction-output-structure", () => {
  const r = check(ev({ commits: [commit(["a"], "feat: x (#42)")] }), CTX);
  const ro = { passed: r.passed, provenance: r.provenance, summary: r.summary };
  if (ro.provenance.total_commits !== 1) throw new Error("missing total_commits");
  if (ro.provenance.accepted_count === undefined) throw new Error("missing accepted_count");
  if (ro.provenance.rejected_count === undefined) throw new Error("missing rejected_count");
  if (ro.provenance.direct_push_count === undefined) throw new Error("missing direct_push_count");
  if (ro.provenance.merge_commit_count === undefined) throw new Error("missing merge_commit_count");
  if (ro.provenance.ambiguous_count === undefined) throw new Error("missing ambiguous_count");
  if (ro.provenance.error_count === undefined) throw new Error("missing error_count");
});

// ===================================================================
// CLI offline tests
// ===================================================================

register("cli-offline-valid-accepted-exit-0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fnd01-prov-"));
  const f = path.join(dir, "evidence.json");
  await writeFile(f, JSON.stringify(ev({ commits: [commit(["a"], "feat: x (#42)")] })));
  const r = spawnSync(process.execPath, [VERIFIER, f], { encoding: "utf8" });
  await rm(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`expected exit 0, got ${r.status}: ${r.stderr}`);
  if (r.stdout.includes("sha") || r.stdout.includes("message")) throw new Error("raw data leaked to stdout");
});

register("cli-offline-valid-rejected-exit-1", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fnd01-prov-"));
  const f = path.join(dir, "evidence.json");
  await writeFile(f, JSON.stringify(ev({ commits: [commit(["a"], "direct push")] })));
  const r = spawnSync(process.execPath, [VERIFIER, f], { encoding: "utf8" });
  await rm(dir, { recursive: true, force: true });
  if (r.status !== 1) throw new Error(`expected exit 1, got ${r.status}`);
});

register("cli-offline-malformed-json-exit-2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fnd01-prov-"));
  const f = path.join(dir, "bad.json");
  await writeFile(f, "{ broken");
  const r = spawnSync(process.execPath, [VERIFIER, f], { encoding: "utf8" });
  await rm(dir, { recursive: true, force: true });
  if (r.status !== 2) throw new Error(`expected exit 2, got ${r.status}`);
  if ((r.stdout + r.stderr).includes(dir)) throw new Error("path leaked");
});

register("cli-offline-missing-file-exit-2", () => {
  const r = spawnSync(process.execPath, [VERIFIER, "/nonexistent/file.json"], { encoding: "utf8" });
  if (r.status !== 2) throw new Error(`expected exit 2, got ${r.status}`);
  if ((r.stdout + r.stderr).includes("/nonexistent")) throw new Error("path leaked");
});

register("cli-offline-no-arg-exit-2", () => {
  const env = { ...process.env, INFORMER_PATH: "" };
  delete env.GITHUB_EVENT_PATH;
  delete env.GITHUB_TOKEN;
  const r = spawnSync(process.execPath, [VERIFIER], { encoding: "utf8", env });
  if (r.status !== 2) throw new Error(`expected exit 2, got ${r.status}`);
});

register("cli-offline-branch-mismatch-exit-2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fnd01-prov-"));
  const f = path.join(dir, "evidence.json");
  await writeFile(f, JSON.stringify({
    metadata: { branch: "develop", checked_at: "now" },
    commits: [commit(["a"], "feat: x (#42)")],
  }));
  const r = spawnSync(process.execPath, [VERIFIER, f], { encoding: "utf8" });
  await rm(dir, { recursive: true, force: true });
  if (r.status !== 2) throw new Error(`expected exit 2, got ${r.status}`);
});

register("cli-offline-accepted-via-env", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fnd01-prov-"));
  const f = path.join(dir, "evidence.json");
  await writeFile(f, JSON.stringify(ev({ commits: [commit(["a"], "feat: x (#42)")] })));
  const r = spawnSync(process.execPath, [VERIFIER, f], { encoding: "utf8", env: { ...process.env } });
  await rm(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`expected exit 0, got ${r.status}`);
});

// ===================================================================
// main() opts tests
// ===================================================================

register("main-opts-evidencePath-accepted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fnd01-prov-"));
  const f = path.join(dir, "evidence.json");
  await writeFile(f, JSON.stringify(ev({ commits: [commit(["a"], "feat: x (#42)")] })));
  const exit = await main({ evidencePath: f });
  await rm(dir, { recursive: true, force: true });
  if (exit !== 0) throw new Error(`expected exit 0, got ${exit}`);
});

register("main-opts-evidencePath-rejected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fnd01-prov-"));
  const f = path.join(dir, "evidence.json");
  await writeFile(f, JSON.stringify(ev({ commits: [commit(["a"], "direct push")] })));
  const exit = await main({ evidencePath: f });
  await rm(dir, { recursive: true, force: true });
  if (exit !== 1) throw new Error(`expected exit 1, got ${exit}`);
});

register("main-opts-evidencePath-malformed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fnd01-prov-"));
  const f = path.join(dir, "bad.json");
  await writeFile(f, "{{{");
  const exit = await main({ evidencePath: f });
  await rm(dir, { recursive: true, force: true });
  if (exit !== 2) throw new Error(`expected exit 2, got ${exit}`);
});

register("main-opts-no-source", async () => {
  const exit = await main({ eventPath: "", token: "" });
  if (exit !== 2) throw new Error(`expected exit 2, got ${exit}`);
});

// ===================================================================
// validateSha adversarial tests
// ===================================================================

register("validateSha-valid-40-hex-chars", () => {
  // Should not throw for a well-formed SHA
  validateSha("abcdef0123456789abcdef0123456789abcdef01", "test");
});

register("validateSha-valid-uppercase-hex", () => {
  validateSha("ABCDEF0123456789ABCDEF0123456789ABCDEF01", "test");
});

register("validateSha-valid-mixed-case-hex", () => {
  validateSha("AbCdEf0123456789AbCdEf0123456789aBcDeF01", "test");
});

register("validateSha-zero-sha-allowed", () => {
  // All-zero SHA is a valid sentinel for branch creation/deletion
  validateSha("0000000000000000000000000000000000000000", "test");
});

register("validateSha-rejects-non-string", () => {
  try {
    validateSha(null, "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("not a string")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-undefined", () => {
  try {
    validateSha(undefined, "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("not a string")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-short-sha", () => {
  try {
    validateSha("abc123", "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("invalid SHA")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-non-hex-chars", () => {
  try {
    validateSha("gggggggggggggggggggggggggggggggggggggggg", "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("invalid SHA")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-shell-metachar-semicolon", () => {
  try {
    validateSha("abcdef01; rm -rf /", "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("invalid SHA")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-shell-metachar-backtick", () => {
  try {
    validateSha("abcdef01\`cat /etc/passwd\`", "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("invalid SHA")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-shell-metachar-dollar", () => {
  try {
    validateSha("abcdef01$(cat /etc/passwd)", "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("invalid SHA")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-shell-metachar-pipe", () => {
  try {
    validateSha("abcdef01|cat /etc/passwd", "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("invalid SHA")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-sha-with-newline", () => {
  try {
    validateSha("abcdef0123456789abcdef0123456789abcdef01\n", "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("invalid SHA")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-too-long-sha", () => {
  try {
    validateSha("abcdef0123456789abcdef0123456789abcdef0123456789", "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("invalid SHA")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-empty-string", () => {
  try {
    validateSha("", "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("invalid SHA")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-boolean", () => {
  try {
    validateSha(true, "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("not a string")) throw new Error(`wrong error: ${e.message}`);
  }
});

register("validateSha-rejects-number", () => {
  try {
    validateSha(12345, "test");
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("not a string")) throw new Error(`wrong error: ${e.message}`);
  }
});

// ===================================================================
// classifyCommit edge cases
// ===================================================================

register("classify-message-only-hash-prefix", () => {
  // "#" at start but not parenthesized PR ref
  const r = classifyCommit(commit(["a"], "#42 fix something"));
  if (r.verdict !== "direct-push") throw new Error(`expected direct-push, got ${r.verdict}`);
});

register("classify-message-hash-not-at-end", () => {
  const r = classifyCommit(commit(["a"], "feat (#42): add login"));
  if (r.verdict !== "direct-push") throw new Error(`expected direct-push, got ${r.verdict}`);
});

register("classify-message-trailing-number-without-parens", () => {
  const r = classifyCommit(commit(["a"], "added #42"));
  if (r.verdict !== "direct-push") throw new Error(`expected direct-push, got ${r.verdict}`);
});

register("classify-message-non-numeric-in-parens", () => {
  const r = classifyCommit(commit(["a"], "feat: x (#abc)"));
  if (r.verdict !== "direct-push") throw new Error(`expected direct-push (not numeric), got ${r.verdict}`);
});

register("classify-error-commit-with-array-message", () => {
  // Invalid message type should still flow through — it will be coerced to ""
  const r = classifyCommit({ parents: ["a"], message: ["not", "a", "string"] });
  if (r.verdict !== "direct-push") throw new Error(`expected direct-push, got ${r.verdict}`);
});

register("classify-error-commit-with-number-message", () => {
  const r = classifyCommit({ parents: ["a"], message: 42 });
  if (r.verdict !== "direct-push") throw new Error(`expected direct-push, got ${r.verdict}`);
});

// ===================================================================
// Rebase detection: no PR ref in message = direct push (fail-closed)
// ===================================================================

register("rebase-no-pr-ref", () => {
  // Rebasing squashes commits but doesn't add PR ref if done outside GitHub
  const r = check(ev({ commits: [
    commit(["a"], "fix: something"),
    commit(["b"], "fix: another thing"),
  ] }), CTX);
  if (r.passed) throw new Error("rebase without PR ref should fail");
  if (r.provenance.direct_push_count !== 2) throw new Error("should count as direct pushes");
});

register("rebase-with-pr-ref-in-some", () => {
  // Partial PR ref — still fail because some commits lack provenance
  const r = check(ev({ commits: [
    commit(["a"], "fix: first (#1)"),
    commit(["b"], "fix: second (no ref)"),
  ] }), CTX);
  if (r.passed) throw new Error("partial refs should fail");
  if (r.provenance.accepted_count !== 1) throw new Error("one should be accepted");
  if (r.provenance.direct_push_count !== 1) throw new Error("one should be direct push");
});

// ===================================================================
// Redaction: MANY commits
// ===================================================================

register("many-commits-all-accepted", () => {
  const commits = Array.from({ length: 100 }, (_, i) => commit([`p${i}`], `feat: item ${i} (#${i + 1000})`));
  const r = check(ev({ commits }), CTX);
  if (!r.passed) throw new Error("100 accepted should pass");
  if (r.provenance.accepted_count !== 100) throw new Error("all 100 should be accepted");
});

register("many-commits-one-rejected", () => {
  const commits = Array.from({ length: 49 }, (_, i) => commit([`p${i}`], `feat: ${i} (#${i})`));
  commits.push(commit(["x"], "direct push"));
  commits.push(commit(["y"], `feat: 50 (#50)`));
  const r = check(ev({ commits }), CTX);
  if (r.passed) throw new Error("one direct push should fail all");
  if (r.provenance.accepted_count !== 50) throw new Error("50 should be accepted");
  if (r.provenance.direct_push_count !== 1) throw new Error("1 should be direct push");
});

// ===================================================================
// RUN ALL TESTS SEQUENTIALLY
// ===================================================================
let passed = 0, fail = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (e) {
    if (e === _ASYNC_RUNNER_SELF_TEST_FAILED) {
      console.log(`PASS: __ASYNC_RUNNER_SELF_TEST (async rejection caught)`);
      passed++;
    } else {
      console.log(`FAIL: ${name} — ${e.message}`);
      fail++;
    }
  }
}

// Restore original fetch
globalThis.fetch = originalFetch;

// Network trap
if (extCallCount > 0) {
  console.log(`FAIL: NETWORK_TRAP — ${extCallCount} external network call(s) detected`);
  fail++;
} else {
  console.log(`PASS: NETWORK_TRAP — zero external network calls`);
  passed++;
}

console.log(`\n${passed} passed, ${fail} failed, ${passed + fail} total`);
process.exit(fail > 0 ? 1 : 0);
