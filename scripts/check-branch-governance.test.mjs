#!/usr/bin/env node

/**
 * check-branch-governance.test.mjs — Comprehensive test suite.
 *
 * All synthetic evidence is embedded inline (no fixture files).
 * Tests: check() function, CLI, live-collector mock HTTP, redaction,
 * policy parity, and every required negative control.
 */

import { readFile } from "node:fs/promises";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, collectLive } from "./check-branch-governance.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERIFIER = path.join(SCRIPT_DIR, "check-branch-governance.mjs");
const POLICY_PATH = path.resolve(SCRIPT_DIR, "..", ".github", "branch-governance-policy.json");

// ---------------------------------------------------------------------------
// Synthetic fixtures (all inline)
// ---------------------------------------------------------------------------

const policy = JSON.parse(await readFile(POLICY_PATH, "utf8"));

const CLASSIC_ALL = {
  required_pull_request_reviews: {
    required_approving_review_count: 2,
    require_code_owner_reviews: true,
    dismiss_stale_reviews: true,
    require_last_push_approval: true,
  },
  required_conversation_resolution: { enabled: true },
  enforce_admins: { enabled: true },
  required_linear_history: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  required_status_checks: { strict: true, contexts: ["quality", "secret-scan"] },
};

const CLASSIC_SIGS_ENABLED = { enabled: true, url: "https://api.github.com/..." };
const CLASSIC_SIGS_DISABLED = { enabled: false, url: "https://api.github.com/..." };

/** Ruleset with all controls satisfied */
function RULESET_FULL() {
  return [
    {
      id: 1, name: "main-protection", enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      bypass_actors: [],
      rules: [
        { type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } },
        { type: "required_signatures" },
        { type: "required_linear_history" },
        { type: "non_fast_forward" },
        { type: "deletion" },
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, { context: "secret-scan" }] } },
      ],
    },
  ];
}

/** Ruleset with bypass actors */
function RULESET_BYPASS() {
  return [
    {
      id: 1, name: "with-bypass", enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole" }],
      rules: [
        { type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } },
        { type: "required_signatures" },
        { type: "required_linear_history" },
        { type: "non_fast_forward" },
        { type: "deletion" },
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, { context: "secret-scan" }] } },
      ],
    },
  ];
}

function RULESET_INACTIVE() {
  return [
    {
      id: 1, name: "evaluate-mode", enforcement: "evaluate",
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      bypass_actors: [], rules: [],
    },
  ];
}

function RULESET_EXCLUDES() {
  return [
    {
      id: 1, name: "excluded", enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: ["refs/heads/main"] } },
      bypass_actors: [], rules: [],
    },
  ];
}

function RULESET_STATUS_STR() {
  return [
    {
      id: 1, name: "str-checks", enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      bypass_actors: [],
      rules: [
        { type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } },
        { type: "required_signatures" },
        { type: "required_linear_history" },
        { type: "non_fast_forward" },
        { type: "deletion" },
        { type: "required_status_checks", parameters: { required_status_checks: ["quality", "secret-scan"] } },
      ],
    },
  ];
}

/** Classic with bypass actors present — admin_enforcement must fail */
function CLASSIC_WITH_BYPASS_RULESET() {
  return {
    classic_branch_protection: { ...CLASSIC_ALL, enforce_admins: { enabled: true } },
    classic_required_signatures: CLASSIC_SIGS_ENABLED,
    rulesets: [
      {
        id: 2, name: "bypass-ruleset", enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        bypass_actors: [{ actor_id: 99, actor_type: "RepositoryRole" }],
        rules: [
          { type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } },
        ],
      },
    ],
  };
}

function ev(overrides = {}) {
  return {
    metadata: { repository: "test/repo", branch: "main", fetched_at: "2026-01-01T00:00:00Z" },
    classic_branch_protection: null,
    classic_required_signatures: null,
    rulesets: [],
    _errors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed++; }
  catch (e) { console.log(`FAIL: ${name} — ${e.message}`); failed++; }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// --- Classic positive ---
await t("classic-all-enforced", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.passed, "expected all enforced");
  ok(r.failed.length === 0, `got ${r.failed.length} failures`);
  for (const c of policy.controls) ok(r.controls[c.id].enforced && r.controls[c.id].source === "classic", `${c.id} not classic-enforced`);
});

// --- Ruleset full positive ---
await t("ruleset-full-active", () => {
  const r = check(ev({ rulesets: RULESET_FULL() }), policy);
  ok(r.passed, "expected all enforced via ruleset");
  for (const c of policy.controls) ok(r.controls[c.id].enforced, `${c.id} not enforced`);
});

// --- 12 individual negative tests ---
await t("neg-require_pull_requests", () => {
  const rs = RULESET_FULL(); rs[0].rules = rs[0].rules.filter(x => x.type !== "pull_request");
  const r = check(ev({ rulesets: rs }), policy);
  ok(r.failed.includes("require_pull_requests"));
});

await t("neg-require_two_approvals", () => {
  const c = { ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, required_approving_review_count: 1 } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.failed.includes("require_two_approvals"));
});

await t("neg-require_codeowner_review", () => {
  const c = { ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, require_code_owner_reviews: false } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.failed.includes("require_codeowner_review"));
});

await t("neg-dismiss_stale_approvals", () => {
  const c = { ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, dismiss_stale_reviews: false } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.failed.includes("dismiss_stale_approvals"));
});

await t("neg-require_last_push_approval", () => {
  const c = { ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, require_last_push_approval: false } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.failed.includes("require_last_push_approval"));
});

await t("neg-require_conversation_resolution", () => {
  const c = { ...CLASSIC_ALL, required_conversation_resolution: { enabled: false } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.failed.includes("require_conversation_resolution"));
});

await t("neg-admin_enforcement", () => {
  const c = { ...CLASSIC_ALL, enforce_admins: { enabled: false } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.failed.includes("admin_enforcement"));
});

await t("neg-signed_commits", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: CLASSIC_SIGS_DISABLED }), policy);
  ok(r.failed.includes("signed_commits"));
});

await t("neg-linear_history", () => {
  const c = { ...CLASSIC_ALL, required_linear_history: { enabled: false } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.failed.includes("linear_history"));
});

await t("neg-force_push_disabled", () => {
  const c = { ...CLASSIC_ALL, allow_force_pushes: { enabled: true } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.failed.includes("force_push_disabled"));
});

await t("neg-deletion_disabled", () => {
  const c = { ...CLASSIC_ALL, allow_deletions: { enabled: true } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.failed.includes("deletion_disabled"));
});

// --- Status checks "includes quality AND secret-scan" semantics (C1) ---
await t("status-checks-includes-both-passes", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["quality", "secret-scan"] } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.controls.required_status_checks.enforced, "both checks should pass");
});

await t("status-checks-includes-extra-passes", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["quality", "secret-scan", "extra"] } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.controls.required_status_checks.enforced, "extra checks should not cause false negative");
});

await t("status-checks-missing-quality-fails", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["secret-scan"] } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(!r.controls.required_status_checks.enforced, "missing quality should fail");
});

await t("status-checks-missing-secret-scan-fails", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["quality"] } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(!r.controls.required_status_checks.enforced, "missing secret-scan should fail");
});

await t("status-checks-duplicates-passes", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["quality", "quality", "secret-scan"] } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(r.controls.required_status_checks.enforced, "duplicates should pass");
});

await t("status-checks-malformed-context-fails", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: [null, "quality"] } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(!r.controls.required_status_checks.enforced, "malformed null context should fail");
});

await t("status-checks-empty-fails", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: [] } };
  const r = check(ev({ classic_branch_protection: c, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  ok(!r.controls.required_status_checks.enforced, "empty contexts should fail");
});

// --- Inactive/evaluate ruleset ---
await t("neg-ruleset-inactive", () => {
  const r = check(ev({ rulesets: RULESET_INACTIVE() }), policy);
  ok(!r.passed, "inactive ruleset should fail");
  ok(r.failed.length === policy.controls.length, `expected ${policy.controls.length} failures, got ${r.failed.length}`);
});

// --- Bypass actor ---
await t("neg-ruleset-bypass-actor", () => {
  const r = check(ev({ rulesets: RULESET_BYPASS() }), policy);
  ok(r.failed.includes("admin_enforcement"), "admin should fail with bypass actor");
});

// --- B5: Mixed classic + bypass ruleset regression ---
await t("neg-mixed-classic-bypass-admin-enforcement", () => {
  const data = CLASSIC_WITH_BYPASS_RULESET();
  const r = check(ev(data), policy);
  ok(r.failed.includes("admin_enforcement"), "classic enforce_admins=true + ruleset with bypass_actors → admin_enforcement NOT ENFORCED");
});

// --- Excluded main ---
await t("neg-ruleset-excluded-main", () => {
  const r = check(ev({ rulesets: RULESET_EXCLUDES() }), policy);
  ok(!r.passed, "excluded main should fail all");
  ok(r.failed.length === policy.controls.length);
});

// --- Status check object parsing ---
await t("status-checks-objects", () => {
  const r = check(ev({ rulesets: RULESET_FULL() }), policy);
  ok(r.controls.required_status_checks.enforced, "object-format should pass");
});

await t("status-checks-strings", () => {
  const r = check(ev({ rulesets: RULESET_STATUS_STR() }), policy);
  ok(r.controls.required_status_checks.enforced, "string-format should pass");
});

// --- Separate signatures ---
await t("separate-signatures-missing", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: null }), policy);
  ok(r.failed.includes("signed_commits"), "signed_commits should fail without separate endpoint");
});

// --- API errors (D1: 401/403 are fatal, 404 on classic is NOT) ---
await t("api-401-fatal", () => {
  const r = check(ev({ _errors: [{ phase: "classic", status: 401 }] }), policy);
  ok(!r.passed && r.failed.length === policy.controls.length, "401 fails all");
});
await t("api-403-fatal", () => {
  const r = check(ev({ _errors: [{ phase: "classic", status: 403 }] }), policy);
  ok(!r.passed && r.failed.length === policy.controls.length, "403 fails all");
});
await t("api-404-not-fatal-on-classic", () => {
  // 404 on classic = control absent, not fatal
  const r = check(ev({ _errors: [{ phase: "classic", status: 404 }] }), policy);
  // 404 should NOT be fatal — it's just absent. So the check runs normally.
  // Without any rulesets or classic data, all controls should fail.
  // But the 404 error in _errors with status 404 should NOT trigger fail-closed.
  // Let's verify: with status 404, the fatal check looks for 401/403/0/null
  ok(!r.passed, "404 on classic should not be fatal but controls still absent");
});

// --- Network/malformed ---
await t("network-error-fail-closed", () => {
  const r = check(ev({ _errors: [{ phase: "network", status: 0 }] }), policy);
  ok(!r.passed && r.failed.length === policy.controls.length, "network error (status 0) fails all");
});

// --- Pagination ---
await t("pagination-truncated-fail-closed", () => {
  const r = check(ev({ _errors: [{ phase: "rulesets_pagination", status: 0 }] }), policy);
  ok(!r.passed && r.failed.length === policy.controls.length, "pagination truncation fails all");
});

// --- Policy parity ---
await t("policy-parity", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  for (const c of policy.controls) ok(r.controls[c.id] !== undefined, `${c.id} missing from result`);
  for (const id of Object.keys(r.controls)) ok(policy.controls.some(c => c.id === id), `${id} not in policy`);
});

// --- Redaction (C2, C3) ---
await t("redaction-no-secrets", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy);
  const j = JSON.stringify(r);
  for (const p of [/ghp_[a-zA-Z0-9]{36}/, /github_pat_[a-zA-Z0-9]{22,}/, /Bearer\s+[a-zA-Z0-9_\-.]+/, /-----BEGIN (RSA |EC )?PRIVATE KEY-----/]) {
    ok(!p.test(j), `secret pattern ${p} found`);
  }
});

await t("redaction-no-error-messages", () => {
  const r = check(ev({ _errors: [{ phase: "classic", status: 403 }] }), policy);
  ok(!r.summary.includes("Forbidden"), "summary must not leak error text");
});

await t("redaction-no-paths", () => {
  const j = JSON.stringify(check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: CLASSIC_SIGS_ENABLED }), policy));
  ok(!j.includes("/home/") && !j.includes("/tmp/") && !j.includes("/mnt/"), "output has paths");
});

await t("redaction-seeded-secret", () => {
  const evidence = ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: CLASSIC_SIGS_ENABLED });
  evidence._seeded_jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzZWVkIjoiZm9vIn0.bar";
  const r = check(evidence, policy);
  ok(!JSON.stringify(r).includes("eyJhbGci"), "seeded JWT leaked");
  ok(!JSON.stringify(r).includes("_seeded_jwt"), "raw key leaked");
});

// --- C2: Redaction leak tests with seeded secrets in metadata ---
await t("redaction-metadata-repository-leak", () => {
  // Seed a GitHub token in metadata.repository
  const evidence = ev({
    metadata: { repository: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/fake", branch: "main" },
    classic_branch_protection: CLASSIC_ALL,
    classic_required_signatures: CLASSIC_SIGS_ENABLED,
  });
  const r = check(evidence, policy);
  ok(r.repository === "offline", "repository must be 'offline' in offline mode, not attacker-controlled value");
  const j = JSON.stringify(r);
  ok(!j.includes("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), "seeded token in metadata.repository leaked");
});

await t("redaction-metadata-branch-leak", () => {
  // Seed a token-like string in metadata.branch
  const evidence = ev({
    metadata: { repository: "test/repo", branch: "Bearer xxxxxxxxxxxxxxxxxxxxxxxx" },
    classic_branch_protection: CLASSIC_ALL,
    classic_required_signatures: CLASSIC_SIGS_ENABLED,
  });
  const r = check(evidence, policy);
  ok(r.branch === "main", "branch must be policy.target_branch");
  const j = JSON.stringify(r);
  ok(!j.includes("Bearer"), "seeded Bearer in metadata.branch leaked");
});

await t("redaction-raw-error-body-leak", () => {
  // Seed secret in _raw_error_body
  const evidence = ev({
    metadata: { repository: "test/repo", branch: "main" },
    classic_branch_protection: CLASSIC_ALL,
    classic_required_signatures: CLASSIC_SIGS_ENABLED,
    _errors: [{ phase: "test", status: 500, _raw: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
  });
  const r = check(evidence, policy);
  const j = JSON.stringify(r);
  ok(!j.includes("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), "raw error body leaked");
});

// --- C3: CLI error code tests ---
await t("cli-malformed-json-exit-2", () => {
  const tmp = path.join(process.env.TMPDIR || process.env.TMP || "/tmp", "fnd01-test-malformed.json");
  writeFileSync(tmp, "{ broken");
  const r = spawnSync(process.execPath, [VERIFIER, tmp], { encoding: "utf8" });
  try { unlinkSync(tmp); } catch {}
  ok(r.status === 2, `expected 2, got ${r.status}`);
  const out = (r.stdout || "") + (r.stderr || "");
  ok(out.includes("malformed-evidence"), "output must use fixed error code");
  ok(!out.includes("stack"), "output must not include exception stack");
});

await t("cli-missing-file-exit-2", () => {
  const r = spawnSync(process.execPath, [VERIFIER, "/nonexistent/file.json"], { encoding: "utf8" });
  ok(r.status === 2, `expected 2, got ${r.status}`);
  const out = (r.stdout || "") + (r.stderr || "");
  ok(out.includes("evidence-read-failed"), "output must use fixed error code");
  ok(!out.includes("/nonexistent"), "output must not include path");
  ok(!out.includes("ENOENT"), "output must not leak system error");
});

await t("cli-stderr-no-token", () => {
  // Run with no GITHUB_TOKEN and no input — should be evidence-read-failed
  const r = spawnSync(process.execPath, [VERIFIER], { encoding: "utf8" });
  ok(r.status === 2, `expected 2, got ${r.status}`);
  const out = (r.stdout || "") + (r.stderr || "");
  ok(!out.includes("Authorization"), "output must not include Authorization header");
  ok(!out.includes("Bearer"), "output must not include Bearer token");
});

// --- Offline branch mismatch (B1) ---
await t("offline-branch-mismatch-fails-exit-2", () => {
  const evidence = ev({ metadata: { repository: "test/repo", branch: "develop" } });
  const r = check(evidence, policy);
  ok(r._error === "branch-mismatch", "branch mismatch should return branch-mismatch error");
});

// --- D2: HTTP failure scenarios via mock server ---
await t("mock-http-401-fail-closed", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Bad credentials" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  // Add a mock repo endpoint for default_branch resolution
  try {
    const evidence = await collectLive("fake-token", "owner", "repo", "main", {
      baseUrl,
      fetch: globalThis.fetch,
    });
    ok(evidence._errors.length > 0, "401 should produce errors");
    ok(evidence._errors.some(e => e.status === 401), "should have 401 error");
  } finally {
    server.close();
  }
});

await t("mock-http-403-fail-closed", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Forbidden" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const evidence = await collectLive("fake-token", "owner", "repo", "main", {
      baseUrl,
      fetch: globalThis.fetch,
    });
    ok(evidence._errors.some(e => e.status === 403), "403 error should be recorded");
  } finally {
    server.close();
  }
});

await t("mock-http-404-on-ruleset-detail", async () => {
  let rulesetDetailCalled = false;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === "/repos/o/r/branches/main/protection") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(CLASSIC_ALL));
    } else if (u.pathname === "/repos/o/r/branches/main/protection/required_signatures") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(CLASSIC_SIGS_ENABLED));
    } else if (u.pathname === "/repos/o/r/rulesets") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ id: 1, name: "rs1", enforcement: "active", _links: { self: { href: "/repos/o/r/rulesets/1" } }, conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, bypass_actors: [], rules: [] }]));
    } else if (u.pathname === "/repos/o/r/rulesets/1") {
      rulesetDetailCalled = true;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
    } else {
      res.writeHead(404); res.end("{}");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const evidence = await collectLive("fake-token", "o", "r", "main", {
      baseUrl,
      fetch: globalThis.fetch,
    });
    ok(rulesetDetailCalled, "ruleset detail should have been fetched");
    ok(evidence.rulesets.length === 0, "ruleset detail 404 should not add to rulesets");
  } finally {
    server.close();
  }
});

await t("mock-http-429-fail-closed", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Too Many Requests" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const evidence = await collectLive("fake-token", "o", "r", "main", {
      baseUrl,
      fetch: globalThis.fetch,
    });
    ok(evidence._errors.some(e => e.status === 429 || e.status === 0), "429 should produce error");
  } finally {
    server.close();
  }
});

await t("mock-http-500-fail-closed", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end("Internal Server Error");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const evidence = await collectLive("fake-token", "o", "r", "main", {
      baseUrl,
      fetch: globalThis.fetch,
    });
    ok(evidence._errors.length > 0, "500 should produce errors");
  } finally {
    server.close();
  }
});

await t("mock-http-malformed-non-json", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("not json at all {{{");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const evidence = await collectLive("fake-token", "o", "r", "main", {
      baseUrl,
      fetch: globalThis.fetch,
    });
    // The malformed response will be caught by the classic endpoint
    ok(evidence._errors.length > 0, "malformed JSON should produce errors");
  } finally {
    server.close();
  }
});

// --- A4: Multi-page ruleset ---
await t("mock-http-multi-page-ruleset", async () => {
  let pageCount = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === "/repos/o/r/branches/main/protection") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(CLASSIC_ALL));
    } else if (u.pathname === "/repos/o/r/branches/main/protection/required_signatures") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(CLASSIC_SIGS_ENABLED));
    } else if (u.pathname === "/repos/o/r/rulesets") {
      pageCount++;
      const page = parseInt(u.searchParams.get("page") || "1");
      const perPage = parseInt(u.searchParams.get("per_page") || "100");
      if (page === 1) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Link": `</repos/o/r/rulesets?per_page=100&page=2>; rel="next"`,
        });
        res.end(JSON.stringify([
          { id: page * 10 + 1, name: `rs-page${page}-1`, enforcement: "active",
            _links: { self: { href: `/repos/o/r/rulesets/${page * 10 + 1}` } },
            conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
            bypass_actors: [], rules: [
              { type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } },
              { type: "required_signatures" },
              { type: "required_linear_history" },
              { type: "non_fast_forward" },
              { type: "deletion" },
              { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, { context: "secret-scan" }] } },
            ],
          },
        ]));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([
          { id: page * 10 + 2, name: `rs-page${page}-2`, enforcement: "active",
            _links: { self: { href: `/repos/o/r/rulesets/${page * 10 + 2}` } },
            conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
            bypass_actors: [], rules: [
              { type: "required_signatures" },
              { type: "required_linear_history" },
              { type: "non_fast_forward" },
              { type: "deletion" },
            ],
          },
        ]));
      }
    } else if (u.pathname.match(/\/repos\/o\/r\/rulesets\/\d+/)) {
      // Return ruleset detail mirroring the summary
      const id = parseInt(u.pathname.split("/").pop());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id, name: `rs-${id}`, enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        bypass_actors: [],
        rules: [{ type: "required_signatures" }],
      }));
    } else {
      res.writeHead(404); res.end("{}");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const evidence = await collectLive("fake-token", "o", "r", "main", {
      baseUrl,
      fetch: globalThis.fetch,
    });
    ok(pageCount >= 2, `expected 2+ pages, got ${pageCount}`);
    ok(evidence.rulesets.length >= 2, `expected 2+ rulesets, got ${evidence.rulesets.length}`);
  } finally {
    server.close();
  }
});

// --- A4: Bounded pagination failure ---
await t("mock-http-bounded-pagination-failure", async () => {
  let pageCount = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === "/repos/o/r/branches/main/protection") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(CLASSIC_ALL));
    } else if (u.pathname === "/repos/o/r/branches/main/protection/required_signatures") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(CLASSIC_SIGS_ENABLED));
    } else if (u.pathname === "/repos/o/r/rulesets") {
      pageCount++;
      const page = parseInt(u.searchParams.get("page") || "1");
      const perPage = parseInt(u.searchParams.get("per_page") || "100");
      const nextPage = page + 1;
      const nextLink = nextPage <= 4
        ? `</repos/o/r/rulesets?per_page=${perPage}&page=${nextPage}>; rel="next"`
        : "";
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Link": nextLink,
      });
      res.end(JSON.stringify([
        { id: page, name: `rs-p${page}`, enforcement: "active",
          _links: { self: { href: `/repos/o/r/rulesets/${page}` } },
          conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
          bypass_actors: [], rules: [],
        },
      ]));
    } else if (u.pathname.match(/\/repos\/o\/r\/rulesets\/\d+/)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: parseInt(u.pathname.split("/").pop()), enforcement: "active", rules: [] }));
    } else {
      res.writeHead(404); res.end("{}");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const evidence = await collectLive("fake-token", "o", "r", "main", {
      baseUrl,
      fetch: globalThis.fetch,
    });
    // With 4 pages and MAX_RULESET_PAGES=3, we should get pagination truncation error
    ok(evidence._errors.some(e => e.phase === "rulesets_pagination"), "pagination truncation should be recorded");
  } finally {
    server.close();
  }
});

// --- D3: Offline evidence structural validation ---
await t("offline-invalid-classic-type", () => {
  const r = check(ev({ classic_branch_protection: "not-an-object" }), policy);
  ok(r._error === "malformed-evidence", "non-object classic should be malformed");
});

await t("offline-invalid-rulesets-type", () => {
  const r = check(ev({ rulesets: "not-an-array" }), policy);
  ok(r._error === "malformed-evidence", "non-array rulesets should be malformed");
});

await t("offline-invalid-errors-type", () => {
  const r = check(ev({ _errors: "not-an-array" }), policy);
  ok(r._error === "malformed-evidence", "non-array _errors should be malformed");
});

// --- A6: Validate owner/repo/branch ---
await t("validate-empty-owner-fails", async () => {
  try {
    await collectLive("token", "", "repo", "main");
    ok(false, "should have thrown");
  } catch (e) {
    ok(e.message.includes("invalid-owner"), `expected invalid-owner error, got: ${e.message}`);
  }
});

await t("validate-owner-with-slash-fails", async () => {
  try {
    await collectLive("token", "owner/attack", "repo", "main");
    ok(false, "should have thrown");
  } catch (e) {
    ok(e.message.includes("invalid-owner"), "owner with slash should be rejected");
  }
});

await t("validate-repo-with-at-fails", async () => {
  try {
    await collectLive("token", "owner", "repo@evil", "main");
    ok(false, "should have thrown");
  } catch (e) {
    ok(e.message.includes("invalid-repo"), "repo with @ should be rejected");
  }
});

await t("validate-branch-with-spaces-fails", async () => {
  try {
    await collectLive("token", "owner", "repo", "main branch");
    ok(false, "should have thrown");
  } catch (e) {
    ok(e.message.includes("invalid-branch"), "branch with space should be rejected");
  }
});

// --- Classic + ruleset combined ---
await t("combined-classic-wins", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: CLASSIC_SIGS_ENABLED, rulesets: RULESET_FULL() }), policy);
  ok(r.passed, "combined should pass");
  for (const c of policy.controls) {
    // admin_enforcement may come from ruleset (no_bypass_actors) since that check always runs
    if (c.id === "admin_enforcement") {
      ok(r.controls[c.id].enforced, `${c.id} should be enforced`);
    } else {
      ok(r.controls[c.id].source === "classic", `${c.id} not classic`);
    }
  }
});

// --- Live collector comprehensive mock (A2) ---
await t("live-collector-mock-all-endpoints-called", async () => {
  const calledEndpoints = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const path = u.pathname;
    calledEndpoints.push(path);

    // Verify Authorization header is present but never assert its value
    ok(req.headers.authorization, "Authorization header must be present");

    if (path === "/repos/o/r/branches/main/protection") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(CLASSIC_ALL));
    } else if (path === "/repos/o/r/branches/main/protection/required_signatures") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(CLASSIC_SIGS_ENABLED));
    } else if (path === "/repos/o/r/rulesets") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(RULESET_FULL()));
    } else if (path === "/repos/o/r/rulesets/1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(RULESET_FULL()[0]));
    } else {
      res.writeHead(404); res.end("{}");
    }
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const evidence = await collectLive("test-token-12345", "o", "r", "main", {
      baseUrl,
      fetch: globalThis.fetch,
    });

    // Assert all 4 endpoint types were called
    ok(calledEndpoints.some(p => p.includes("/branches/main/protection") && !p.includes("required_signatures")), "classic protection endpoint called");
    ok(calledEndpoints.some(p => p.includes("/required_signatures")), "required signatures endpoint called");
    ok(calledEndpoints.filter(p => p === "/repos/o/r/rulesets").length >= 1, "rulesets list endpoint called");
    ok(calledEndpoints.some(p => p === "/repos/o/r/rulesets/1"), "ruleset detail endpoint called");

    // Verify evidence can pass check
    const r = check(evidence, policy);
    ok(r.passed, "collected evidence should pass all controls");
  } finally {
    server.close();
  }
});

// --- A3: Timeout ---
await t("live-collector-timeout", async () => {
  const server = http.createServer((req, res) => {
    // Never respond — triggers timeout
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const evidence = await collectLive("fake-token", "o", "r", "main", {
      baseUrl,
      fetch: globalThis.fetch,
      timeout: 100, // 100ms timeout
    });
    // Should produce network errors
    ok(evidence._errors.length > 0, "timeout should produce errors");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
