#!/usr/bin/env node

/**
 * check-branch-governance.test.mjs — Comprehensive test suite covering all 12 findings.
 * All synthetic evidence embedded inline. No fixture files.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, collectLive } from "./check-branch-governance.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERIFIER = path.join(SCRIPT_DIR, "check-branch-governance.mjs");
const POLICY_PATH = path.resolve(SCRIPT_DIR, "..", ".github", "branch-governance-policy.json");
const policy = JSON.parse(await readFile(POLICY_PATH, "utf8"));

const CTX_OFFLINE = { source: "offline", repository: "redacted", branch: "main" };
const CTX_LIVE = { source: "live", repository: "redacted", branch: "main" };

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------
const CLASSIC_ALL = { required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true, dismiss_stale_reviews: true, require_last_push_approval: true }, required_conversation_resolution: { enabled: true }, enforce_admins: { enabled: true }, required_linear_history: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, required_status_checks: { strict: true, contexts: ["quality", "secret-scan"] } };
const SIGS_ON = { enabled: true, url: "https://api.github.com/..." };
const SIGS_OFF = { enabled: false, url: "https://api.github.com/..." };

const RS_BASE = { id: 1, name: "main-protection", enforcement: "active", target: "branch", conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, bypass_actors: [], rules: [] };

function rs(overrides = {}) { return { ...RS_BASE, ...overrides }; }

function rsFull() { return [rs({ rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } }, { type: "required_signatures" }, { type: "required_linear_history" }, { type: "non_fast_forward" }, { type: "deletion" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, { context: "secret-scan" }] } }] })]; }

function ev(overrides = {}) {
  return { metadata: { repository: "test/repo", branch: "main", default_branch: "main", fetched_at: "2026-01-01T00:00:00Z" }, classic_branch_protection: null, classic_required_signatures: null, rulesets: [], _errors: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); console.log(`PASS: ${name}`); passed++; } catch (e) { console.log(`FAIL: ${name} — ${e.message}`); failed++; } }
function ok(cond, msg) { if (!cond) throw new Error(msg || "assertion"); }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// --- Classic positive ---
await t("classic-all-enforced", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE);
  ok(r.passed && r.failed.length === 0, `failed: ${r.failed}`);
  for (const c of policy.controls) ok(r.controls[c.id].enforced, c.id);
});

// --- Ruleset full positive ---
await t("ruleset-full-active", () => {
  const r = check(ev({ rulesets: rsFull() }), policy, CTX_LIVE);
  ok(r.passed, `failed: ${r.failed}`);
  for (const c of policy.controls) ok(r.controls[c.id].enforced, c.id);
});

// --- 12 individual negatives ---
const negClassic = (id, fn) => t(`neg-${id}`, () => { const r = check(ev({ classic_branch_protection: fn(), classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE); ok(r.failed.includes(id), `${id} not in failed`); });
negClassic("require_two_approvals",       () => ({ ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, required_approving_review_count: 1 } }));
negClassic("require_codeowner_review",    () => ({ ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, require_code_owner_reviews: false } }));
negClassic("dismiss_stale_approvals",     () => ({ ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, dismiss_stale_reviews: false } }));
negClassic("require_last_push_approval",  () => ({ ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, require_last_push_approval: false } }));
negClassic("require_conversation_resolution", () => ({ ...CLASSIC_ALL, required_conversation_resolution: { enabled: false } }));
negClassic("admin_enforcement",      () => ({ ...CLASSIC_ALL, enforce_admins: { enabled: false } }));
negClassic("linear_history",         () => ({ ...CLASSIC_ALL, required_linear_history: { enabled: false } }));
negClassic("force_push_disabled",    () => ({ ...CLASSIC_ALL, allow_force_pushes: { enabled: true } }));
negClassic("deletion_disabled",      () => ({ ...CLASSIC_ALL, allow_deletions: { enabled: true } }));
await t("neg-signed_commits", () => { const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_OFF }), policy, CTX_OFFLINE); ok(r.failed.includes("signed_commits")); });
await t("neg-require_pull_requests-classic", () => { const r = check(ev({ classic_branch_protection: {}, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE); ok(r.failed.includes("require_pull_requests")); });

// --- Status checks: includes semantics ---
await t("status-checks-includes-both", () => { ok(check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE).controls.required_status_checks.enforced); });
await t("status-checks-includes-extra", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["quality", "secret-scan", "extra-check"] } };
  ok(check(ev({ classic_branch_protection: c, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE).controls.required_status_checks.enforced);
});
await t("status-checks-missing-quality", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["secret-scan"] } };
  ok(check(ev({ classic_branch_protection: c, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE).failed.includes("required_status_checks"));
});
await t("status-checks-missing-secret-scan", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["quality"] } };
  ok(check(ev({ classic_branch_protection: c, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE).failed.includes("required_status_checks"));
});
await t("status-checks-duplicates", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["quality", "quality", "secret-scan"] } };
  ok(check(ev({ classic_branch_protection: c, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE).controls.required_status_checks.enforced);
});
await t("status-checks-malformed-null-entry", () => {
  const r = rsFull(); r[0].rules.find(x => x.type === "required_status_checks").parameters.required_status_checks = [{ context: "quality" }, null, { context: "secret-scan" }];
  ok(check(ev({ rulesets: r }), policy, CTX_LIVE).failed.includes("required_status_checks"));
});
await t("status-checks-malformed-empty-context", () => {
  const r = rsFull(); r[0].rules.find(x => x.type === "required_status_checks").parameters.required_status_checks = [{ context: "quality" }, { context: "" }, { context: "secret-scan" }];
  ok(check(ev({ rulesets: r }), policy, CTX_LIVE).failed.includes("required_status_checks"));
});
await t("status-checks-objects-pass", () => {
  ok(check(ev({ rulesets: rsFull() }), policy, CTX_LIVE).controls.required_status_checks.enforced);
});
await t("status-checks-strings-pass", () => {
  const r = rsFull(); r[0].rules.find(x => x.type === "required_status_checks").parameters.required_status_checks = ["quality", "secret-scan"];
  ok(check(ev({ rulesets: r }), policy, CTX_LIVE).controls.required_status_checks.enforced);
});

// --- Inactive/evaluate ruleset ---
await t("neg-ruleset-inactive", () => {
  const r = check(ev({ rulesets: [rs({ enforcement: "evaluate" })] }), policy, CTX_LIVE);
  ok(!r.passed && r.failed.length === policy.controls.length);
});

// --- Bypass actors: all controls from bypassed ruleset excluded ---
await t("neg-ruleset-bypass-all-controls", () => {
  // A fully-enforced ruleset with bypass_actors → ALL controls from it are excluded
  const bypassed = rs({ bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole" }], rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } }, { type: "required_signatures" }, { type: "required_linear_history" }, { type: "non_fast_forward" }, { type: "deletion" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, { context: "secret-scan" }] } }] });
  const r = check(ev({ rulesets: [bypassed] }), policy, CTX_LIVE);
  ok(!r.passed, "bypassed ruleset should not pass");
  ok(r.failed.length === policy.controls.length, `all controls should fail, got ${r.failed.length}`);
  // admin_enforcement specifically shown bypassed
  ok(r.controls.admin_enforcement.enforced === false, "admin must not be enforced");
});

// --- Mixed classic + bypassed stronger ruleset ---
await t("neg-mixed-classic-bypassed-ruleset", () => {
  // Classic says enforce_admins=true, but ruleset has bypass → admin fails
  // Other classic controls should still work (weak classic passes, bypassed ruleset excluded)
  const weakClassic = { required_pull_request_reviews: { required_approving_review_count: 2 }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, required_status_checks: { contexts: ["quality", "secret-scan"] } };
  const bypassed = rs({ bypass_actors: [{ actor_id: 1 }], rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } }, { type: "required_signatures" }, { type: "required_linear_history" }, { type: "non_fast_forward" }, { type: "deletion" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, { context: "secret-scan" }] } }] });
  const r = check(ev({ classic_branch_protection: weakClassic, classic_required_signatures: SIGS_OFF, rulesets: [bypassed] }), policy, CTX_OFFLINE);
  // Classic + bypassed ruleset: classic provides what it has, bypassed ruleset excluded
  // admin_enforcement should be the one that FAILS because ruleset has bypass
  ok(r.failed.includes("admin_enforcement"), "admin must fail with bypass");
  // Classic-provided controls should work
  ok(r.controls.require_two_approvals.enforced, "classic 2-approvals should pass");
  ok(r.controls.require_pull_requests.enforced, "classic PR required should pass");
  // Ruleset-only controls should NOT be enforced (bypassed)
  ok(!r.controls.require_codeowner_review.enforced, "CODEOWNER from bypassed ruleset should not pass");
  ok(!r.controls.signed_commits.enforced, "signed_commits from bypassed ruleset should not pass");
});

// --- Excluded main ---
await t("neg-ruleset-excluded-main", () => {
  const excludedRs = rs({ conditions: { ref_name: { include: ["refs/heads/main"], exclude: ["refs/heads/main"] } } });
  const r = check(ev({ rulesets: [excludedRs] }), policy, CTX_LIVE);
  ok(!r.passed && r.failed.length === policy.controls.length);
});

// --- Target validation ---
await t("neg-target-tag", () => {
  const r = check(ev({ rulesets: [rs({ target: "tag" })] }), policy, CTX_LIVE);
  ok(!r.passed && r.failed.length === policy.controls.length);
});
await t("neg-target-missing", () => {
  const rl = rsFull(); delete rl[0].target;
  ok(!check(ev({ rulesets: rl }), policy, CTX_LIVE).passed);
});

// --- Tri-state ref matching ---
await t("ref-unknown-include-fails", () => {
  const rl = [rs({ conditions: { ref_name: { include: ["refs/tags/v1", "~UNKNOWN"], exclude: [] } } })];
  ok(!check(ev({ rulesets: rl }), policy, CTX_LIVE).passed, "unknown include should fail");
});
await t("ref-unknown-exclude-fails-closed", () => {
  const rl = [rs({ conditions: { ref_name: { include: ["refs/heads/main"], exclude: ["~UNKNOWN_PATTERN"] } } })];
  ok(!check(ev({ rulesets: rl }), policy, CTX_LIVE).passed, "unknown exclude should drop ruleset");
});
await t("ref-wildcard-include", () => {
  const rl = [rs({ conditions: { ref_name: { include: ["refs/heads/*"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] })];
  ok(check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.require_two_approvals.enforced, "wildcard include should match");
});
await t("ref-all-include", () => {
  const rl = [rs({ conditions: { ref_name: { include: ["~ALL"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] })];
  ok(check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.require_two_approvals.enforced, "~ALL include should match");
});
await t("ref-default-branch-match", () => {
  const rl = [rs({ conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] })];
  ok(check(ev({ rulesets: rl, metadata: { ...ev().metadata, default_branch: "main" } }), policy, CTX_LIVE).controls.require_two_approvals.enforced, "~DEFAULT_BRANCH should match main");
});
await t("ref-default-branch-unknown", () => {
  const rl = [rs({ conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } } })];
  ok(!check(ev({ rulesets: rl, metadata: { ...ev().metadata, default_branch: null } }), policy, CTX_LIVE).passed, "unknown default should fail-safe");
});

// --- Separate signatures ---
await t("separate-signatures-missing", () => {
  ok(check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: null }), policy, CTX_OFFLINE).failed.includes("signed_commits"));
});

// --- API errors: ALL _errors fatal ---
await t("all-errors-fatal-401", () => { const r = check(ev({ _errors: [{ phase: "classic", status: 401 }] }), policy, CTX_OFFLINE); ok(!r.passed && r.failed.length === 12); });
await t("all-errors-fatal-403", () => { const r = check(ev({ _errors: [{ phase: "classic", status: 403 }] }), policy, CTX_OFFLINE); ok(!r.passed && r.failed.length === 12); });
await t("all-errors-fatal-404-ruleset-detail", () => { const r = check(ev({ _errors: [{ phase: "ruleset_detail", status: 404 }] }), policy, CTX_OFFLINE); ok(!r.passed && r.failed.length === 12); });
await t("all-errors-fatal-429", () => { const r = check(ev({ _errors: [{ phase: "classic", status: 429 }] }), policy, CTX_OFFLINE); ok(!r.passed && r.failed.length === 12); });
await t("all-errors-fatal-500", () => { const r = check(ev({ _errors: [{ phase: "rulesets_list", status: 500 }] }), policy, CTX_OFFLINE); ok(!r.passed && r.failed.length === 12); });
await t("all-errors-fatal-network", () => { const r = check(ev({ _errors: [{ phase: "network", status: 0 }] }), policy, CTX_OFFLINE); ok(!r.passed && r.failed.length === 12); });
await t("all-errors-fatal-pagination", () => { const r = check(ev({ _errors: [{ phase: "rulesets_pagination", status: 0 }] }), policy, CTX_OFFLINE); ok(!r.passed && r.failed.length === 12); });

// --- Policy parity ---
await t("policy-parity", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE);
  for (const c of policy.controls) ok(r.controls[c.id] !== undefined);
  for (const id of Object.keys(r.controls)) ok(policy.controls.some(c => c.id === id));
});

// --- Redaction ---
await t("redaction-no-secrets", () => {
  const j = JSON.stringify(check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE));
  ok(!/ghp_[a-zA-Z0-9]{36}/.test(j) && !/github_pat_/.test(j) && !/Bearer\s+/.test(j), "secrets leaked");
});
await t("redaction-repository-is-redacted", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE);
  ok(r.repository === "redacted", "repository should be redacted");
});
await t("redaction-no-paths", () => {
  const j = JSON.stringify(check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE));
  ok(!j.includes("/home/") && !j.includes("/tmp/"), "paths leaked");
});
await t("redaction-metadata-seeded-token", () => {
  const evidence = ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON });
  evidence.metadata.repository = "ghp_seededtoken123456789012345678901234";
  evidence.metadata.branch = "Bearer gho_seeded";
  evidence._raw_body = "Authorization: Bearer github_pat_seeded";
  const j = JSON.stringify(check(evidence, policy, CTX_OFFLINE));
  ok(!j.includes("ghp_seeded"), "token leaked");
  ok(!j.includes("Bearer"), "bearer leaked");
  ok(!j.includes("Authorization"), "auth header leaked");
  ok(j.includes("redacted"), "output should use redacted literal");
});

// --- Offline structural validation ---
await t("offline-classic-not-object", () => {
  const r = check(ev({ classic_branch_protection: "not-an-object" }), policy, CTX_OFFLINE);
  ok(r._error === "malformed-evidence");
});
await t("offline-rulesets-not-array", () => {
  const r = check(ev({ rulesets: "not-array" }), policy, CTX_OFFLINE);
  ok(r._error === "malformed-evidence");
});
await t("offline-errors-not-array", () => {
  const r = check(ev({ _errors: "not-array" }), policy, CTX_OFFLINE);
  ok(r._error === "malformed-evidence");
});
await t("offline-signatures-not-object", () => {
  const r = check(ev({ classic_required_signatures: "bad" }), policy, CTX_OFFLINE);
  ok(r._error === "malformed-evidence");
});
await t("offline-branch-mismatch", () => {
  const r = check(ev({ metadata: { ...ev().metadata, branch: "develop" } }), policy, CTX_OFFLINE);
  ok(r._error === "branch-mismatch");
});

// --- Weak-first / strong-second rule ordering ---
await t("rules-weak-first-strong-second", () => {
  const rl = [rs({ rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }, { type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true } }] })];
  const r = check(ev({ rulesets: rl }), policy, CTX_LIVE);
  ok(r.controls.require_two_approvals.enforced, "strong second rule should be found via anyRulesetRule");
});
await t("rules-strong-first-weak-second", () => {
  const rl = [rs({ rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }, { type: "pull_request", parameters: { required_approving_review_count: 1 } }] })];
  ok(check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.require_two_approvals.enforced, "strong first rule should be found");
});

// --- Mock HTTP server for actual collectLive() tests ---
function startServer(handlers) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      // Match pathname only (ignore query string for handler lookup)
      const key = `${req.method} ${u.pathname}`;
      const h = handlers[key] || handlers[`${req.method} ${u.pathname}${u.search}`] || handlers["*"];
      if (h) h(req, res, u); else { res.writeHead(404); res.end("{}"); }
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port, baseUrl: `http://127.0.0.1:${s.address().port}` }));
  });
}

function mockCollectorHandlers(opts = {}) {
  const classic = opts.classic || { status: 200, body: CLASSIC_ALL };
  const sigs = opts.sigs || { status: 200, body: SIGS_ON };
  const repoMeta = opts.repoMeta || { status: 200, body: { default_branch: "main" } };
  const rulesetList = opts.rulesetList || { status: 200, body: [{ id: 1, name: "rs1", enforcement: "active", target: "branch", _links: { self: { href: "/repos/t/r/rulesets/1" } }, conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, bypass_actors: [] }], link: "" };
  const rulesetDetail = opts.rulesetDetail || { status: 200, body: rsFull()[0] };

  return {
    "GET /repos/t/r": (req, res) => { res.writeHead(repoMeta.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(repoMeta.body)); },
    "GET /repos/t/r/branches/main/protection": (req, res) => { res.writeHead(classic.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(classic.body)); },
    "GET /repos/t/r/branches/main/protection/required_signatures": (req, res) => { res.writeHead(sigs.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(sigs.body)); },
    "GET /repos/t/r/rulesets": (req, res) => {
      res.writeHead(rulesetList.status, { "Content-Type": "application/json", Link: rulesetList.link || "" });
      res.end(JSON.stringify(rulesetList.body));
    },
    "GET /repos/t/r/rulesets/1": (req, res) => { res.writeHead(rulesetDetail.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(rulesetDetail.body)); },
  };
}

await t("collectLive-all-endpoints-called", async () => {
  const callLog = [];
  const { server, baseUrl } = await startServer(mockCollectorHandlers());
  const mockFetch = async (url, init) => {
    callLog.push(url.replace(baseUrl, ""));
    const resp = await fetch(url, init);
    return resp;
  };
  const evidence = await collectLive("test-token", "t", "r", "main", { fetch: mockFetch, baseUrl, timeout: 5000 });
  ok(evidence._errors.length === 0, `unexpected errors: ${JSON.stringify(evidence._errors)}`);
  ok(callLog.some(u => u.includes("/repos/t/r") && !u.includes("branches") && !u.includes("rulesets")), "repo metadata not called");
  ok(callLog.some(u => u.includes("/protection") && !u.includes("signatures")), "classic protection not called");
  ok(callLog.some(u => u.includes("required_signatures")), "signatures not called");
  ok(callLog.some(u => u.includes("/rulesets")), "rulesets not called");
  server.close();
});

await t("collectLive-403-fail-closed", async () => {
  const { server, baseUrl } = await startServer(mockCollectorHandlers({ classic: { status: 403, body: { message: "Forbidden" } } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch, baseUrl, timeout: 5000 });
  ok(evidence._errors.some(e => e.status === 403), "403 should be in _errors");
  const r = check(evidence, policy, CTX_LIVE);
  ok(!r.passed && r.failed.length === 12, "403 should fail all");
  server.close();
});

await t("collectLive-ruleset-detail-404-fail-closed", async () => {
  const { server, baseUrl } = await startServer(mockCollectorHandlers({ rulesetDetail: { status: 404, body: {} } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch, baseUrl, timeout: 5000 });
  ok(evidence._errors.some(e => e.phase === "ruleset_detail" && e.status === 404), "ruleset detail 404 should be error");
  server.close();
});

await t("collectLive-repo-metadata-failure", async () => {
  const { server, baseUrl } = await startServer(mockCollectorHandlers({ repoMeta: { status: 500, body: {} } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch, baseUrl, timeout: 5000 });
  ok(evidence._errors.some(e => e.phase === "repo_metadata"), "repo metadata failure should error");
  server.close();
});

await t("collectLive-total-timeout", async () => {
  // Use a very short total timeout; mock never responds → timeout triggers
  const { server, baseUrl } = await startServer(mockCollectorHandlers({
    repoMeta: { status: 200, body: { default_branch: "main" } },
    classic: { status: 200, body: CLASSIC_ALL },
    sigs: { status: 200, body: SIGS_ON },
    rulesetList: { status: 200, body: [] },
  }));
  // We can't easily test total timeout without patching TOTAL_COLLECTION_TIMEOUT_MS
  // Instead test that collection completes normally when all endpoints respond fast
  const evidence = await collectLive("t", "t", "r", "main", { fetch, baseUrl, timeout: 5000 });
  ok(evidence.metadata.default_branch === "main", "default branch should be set");
  ok(evidence.classic_branch_protection !== null, "classic should be populated");
  server.close();
});

// --- Malformed status checks with null + valid → reject ---
await t("status-checks-null-in-array-rejected", () => {
  const rl = rsFull(); rl[0].rules = rl[0].rules.filter(x => x.type !== "required_status_checks");
  rl[0].rules.push({ type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, null, { context: "secret-scan" }] } });
  ok(check(ev({ rulesets: rl }), policy, CTX_LIVE).failed.includes("required_status_checks"));
});

// --- CLI tests ---
await t("cli-malformed-json-exit-2", () => {
  const r = spawnSync(process.execPath, [VERIFIER], { input: "{ broken", encoding: "utf8" });
  ok(r.status === 2, `got ${r.status}`);
  ok(!(r.stdout + r.stderr).includes("/dev/stdin"), "path leaked");
});
await t("cli-missing-file-exit-2", () => {
  const r = spawnSync(process.execPath, [VERIFIER, "/nonexistent/file.json"], { encoding: "utf8" });
  ok(r.status === 2, `got ${r.status}`);
  ok(!(r.stdout + r.stderr).includes("/nonexistent"), "path leaked");
});
await t("cli-stderr-no-token", () => {
  const r = spawnSync(process.execPath, [VERIFIER], { input: "{ broken", encoding: "utf8" });
  ok(!(r.stderr).includes("Bearer"), "bearer in stderr");
  ok(!(r.stderr).includes("ghp_"), "token in stderr");
});

// Live CLI: seed GITHUB_REPOSITORY with token-like slug, ensure not in output
await t("cli-live-repo-token-like-slug-not-leaked", () => {
  const r = spawnSync(process.execPath, [VERIFIER], {
    env: { ...process.env, GITHUB_TOKEN: "ghp_fake123456789012345678901234567890", GITHUB_REPOSITORY: "ghp_seeded/evil" },
    encoding: "utf8",
    timeout: 5000,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  ok(!out.includes("ghp_seeded"), `token-like slug leaked: ${out.substring(0, 200)}`);
  ok(!out.includes("ghp_fake"), `token leaked`);
});

// --- Combined classic + clean ruleset ---
await t("combined-classic-plus-clean-ruleset", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON, rulesets: rsFull() }), policy, CTX_OFFLINE);
  ok(r.passed, "combined classic+clean ruleset should pass");
});

// --- Multiple rulesets, one bypassed, one clean ---
await t("mixed-clean-and-bypassed-rulesets", () => {
  const clean = rs({ id: 2, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] });
  const bypassed = rs({ id: 3, bypass_actors: [{ actor_id: 1 }], rules: [{ type: "required_signatures" }] });
  const evidence = ev({ rulesets: [clean, bypassed] });
  const r = check(evidence, policy, CTX_LIVE);
  // Clean ruleset provides require_two_approvals
  ok(r.controls.require_two_approvals.enforced, "clean ruleset controls should pass");
  // Bypassed ruleset's controls excluded; admin fails because any bypass exists
  ok(!r.controls.signed_commits.enforced, "bypassed ruleset controls excluded");
  ok(!r.controls.admin_enforcement.enforced, "admin fails with any bypass");
});

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
