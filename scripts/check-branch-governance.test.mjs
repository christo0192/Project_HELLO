#!/usr/bin/env node

/**
 * check-branch-governance.test.mjs — Full test suite.
 *
 * All tests run sequentially via an async queue — every promise is awaited
 * before PASS/FAIL is reported. A network-call trap wraps globalThis.fetch
 * to reject any non-loopback URL, ensuring zero external network calls.
 */

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, collectLive, main, GITHUB_ORIGIN } from "./check-branch-governance.mjs";

// ---------------------------------------------------------------------------
// Network-call trap — must NOT make external calls
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
// Constants & fixtures
// ---------------------------------------------------------------------------
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERIFIER = path.join(SCRIPT_DIR, "check-branch-governance.mjs");
const POLICY_PATH = path.resolve(SCRIPT_DIR, "..", ".github", "branch-governance-policy.json");
const policy = JSON.parse(await readFile(POLICY_PATH, "utf8"));

const CTX_OFFLINE = { source: "offline", repository: "redacted", branch: "main" };
const CTX_LIVE = { source: "live", repository: "redacted", branch: "main" };

const CLASSIC_ALL = {
  required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true, dismiss_stale_reviews: true, require_last_push_approval: true },
  required_conversation_resolution: { enabled: true },
  enforce_admins: { enabled: true },
  required_linear_history: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  required_status_checks: { strict: true, contexts: ["quality", "secret-scan"] }
};
const SIGS_ON = { enabled: true, url: "https://api.github.com/..." };
const SIGS_OFF = { enabled: false, url: "https://api.github.com/..." };

const RS_BASE = { id: 1, name: "main-protection", enforcement: "active", target: "branch", conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, bypass_actors: [], rules: [] };
function rs(overrides = {}) { return { ...RS_BASE, ...overrides }; }
function rsFull() {
  return [rs({ rules: [
    { type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } },
    { type: "required_signatures" },
    { type: "required_linear_history" },
    { type: "non_fast_forward" },
    { type: "deletion" },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, { context: "secret-scan" }] } }
  ] })];
}
function ev(overrides = {}) {
  return { metadata: { repository: "test/repo", branch: "main", default_branch: "main", fetched_at: "2026-01-01T00:00:00Z" }, classic_branch_protection: null, classic_required_signatures: null, rulesets: [], _errors: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Async test runner — every test is awaited before PASS/FAIL is counted
// ---------------------------------------------------------------------------
const tests = [];
// Self-test: a deliberately async-rejecting test to prove the runner awaits
const _ASYNC_RUNNER_SELF_TEST_FAILED = Symbol("runner-self-test");
function register(name, fn) { tests.push({ name, fn }); }

// Seed a test that must be caught by the runner
register("__ASYNC_RUNNER_SELF_TEST", async () => { throw _ASYNC_RUNNER_SELF_TEST_FAILED; });

register("classic-all-enforced", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE);
  if (!r.passed) throw new Error(`failed: ${r.failed}`);
  for (const c of policy.controls) if (!r.controls[c.id].enforced) throw new Error(c.id);
});

register("ruleset-full-active", () => {
  const r = check(ev({ rulesets: rsFull() }), policy, CTX_LIVE);
  if (!r.passed) throw new Error(`failed: ${r.failed}`);
  for (const c of policy.controls) if (!r.controls[c.id].enforced) throw new Error(c.id);
});

// Individual negatives
const negClassic = (id, fn) => register(`neg-${id}`, () => {
  const r = check(ev({ classic_branch_protection: fn(), classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE);
  if (!r.failed.includes(id)) throw new Error(`${id} not in failed`);
});
negClassic("require_two_approvals",       () => ({ ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, required_approving_review_count: 1 } }));
negClassic("require_codeowner_review",    () => ({ ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, require_code_owner_reviews: false } }));
negClassic("dismiss_stale_approvals",     () => ({ ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, dismiss_stale_reviews: false } }));
negClassic("require_last_push_approval",  () => ({ ...CLASSIC_ALL, required_pull_request_reviews: { ...CLASSIC_ALL.required_pull_request_reviews, require_last_push_approval: false } }));
negClassic("require_conversation_resolution", () => ({ ...CLASSIC_ALL, required_conversation_resolution: { enabled: false } }));
negClassic("admin_enforcement",      () => ({ ...CLASSIC_ALL, enforce_admins: { enabled: false } }));
negClassic("linear_history",         () => ({ ...CLASSIC_ALL, required_linear_history: { enabled: false } }));
negClassic("force_push_disabled",    () => ({ ...CLASSIC_ALL, allow_force_pushes: { enabled: true } }));
negClassic("deletion_disabled",      () => ({ ...CLASSIC_ALL, allow_deletions: { enabled: true } }));
register("neg-signed_commits", () => {
  if (!check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_OFF }), policy, CTX_OFFLINE).failed.includes("signed_commits"))
    throw new Error("signed_commits not in failed");
});
register("neg-require_pull_requests-classic", () => {
  if (!check(ev({ classic_branch_protection: {}, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE).failed.includes("require_pull_requests"))
    throw new Error("require_pull_requests not in failed");
});

// Status checks
register("status-checks-includes-both", () => {
  if (!check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE).controls.required_status_checks.enforced)
    throw new Error("status checks should pass");
});
register("status-checks-includes-extra", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["quality", "secret-scan", "extra-check"] } };
  if (!check(ev({ classic_branch_protection: c, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE).controls.required_status_checks.enforced)
    throw new Error("extra checks should not fail");
});
register("status-checks-missing-quality", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["secret-scan"] } };
  if (!check(ev({ classic_branch_protection: c, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE).failed.includes("required_status_checks"))
    throw new Error("missing quality should fail");
});
register("status-checks-missing-secret-scan", () => {
  const c = { ...CLASSIC_ALL, required_status_checks: { contexts: ["quality"] } };
  if (!check(ev({ classic_branch_protection: c, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE).failed.includes("required_status_checks"))
    throw new Error("missing secret-scan should fail");
});
register("status-checks-malformed-null-entry", () => {
  const rl = rsFull(); rl[0].rules.find(x => x.type === "required_status_checks").parameters.required_status_checks = [{ context: "quality" }, null, { context: "secret-scan" }];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).failed.includes("required_status_checks"))
    throw new Error("null entry should fail");
});
register("status-checks-malformed-empty-context", () => {
  const rl = rsFull(); rl[0].rules.find(x => x.type === "required_status_checks").parameters.required_status_checks = [{ context: "quality" }, { context: "" }, { context: "secret-scan" }];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).failed.includes("required_status_checks"))
    throw new Error("empty context should fail");
});

// Bool ordering
register("bool-weak-first-strong-second-CODEOWNER", () => {
  const rl = [rs({ rules: [
    { type: "pull_request", parameters: { require_code_owner_review: false, required_approving_review_count: 2 } },
    { type: "pull_request", parameters: { require_code_owner_review: true } }
  ] })];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.require_codeowner_review.enforced)
    throw new Error("CODEOWNER should pass via second rule");
});
register("bool-weak-first-strong-second-dismiss", () => {
  const rl = [rs({ rules: [
    { type: "pull_request", parameters: { dismiss_stale_reviews_on_push: false, required_approving_review_count: 2 } },
    { type: "pull_request", parameters: { dismiss_stale_reviews_on_push: true } }
  ] })];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.dismiss_stale_approvals.enforced)
    throw new Error("dismiss should pass via second rule");
});
register("bool-weak-first-strong-second-last-push", () => {
  const rl = [rs({ rules: [
    { type: "pull_request", parameters: { require_last_push_approval: false, required_approving_review_count: 2 } },
    { type: "pull_request", parameters: { require_last_push_approval: true } }
  ] })];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.require_last_push_approval.enforced)
    throw new Error("last-push should pass via second rule");
});
register("bool-weak-first-strong-second-conversation", () => {
  const rl = [rs({ rules: [
    { type: "pull_request", parameters: { required_review_thread_resolution: false, required_approving_review_count: 2 } },
    { type: "pull_request", parameters: { required_review_thread_resolution: true } }
  ] })];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.require_conversation_resolution.enforced)
    throw new Error("conversation should pass via second rule");
});
register("status-checks-weak-first-strong-second", () => {
  const rl = [rs({ rules: [
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }] } },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, { context: "secret-scan" }] } }
  ] })];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.required_status_checks.enforced)
    throw new Error("status checks should pass via second rule");
});
register("status-checks-strong-first-weak-second", () => {
  const rl = [rs({ rules: [
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, { context: "secret-scan" }] } },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }] } }
  ] })];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.required_status_checks.enforced)
    throw new Error("strong first should work");
});
register("rules-weak-first-strong-second-min", () => {
  const rl = [rs({ rules: [
    { type: "pull_request", parameters: { required_approving_review_count: 1 } },
    { type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true } }
  ] })];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.require_two_approvals.enforced)
    throw new Error("min-value via second rule");
});
register("rules-strong-first-weak-second-min", () => {
  const rl = [rs({ rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }, { type: "pull_request", parameters: { required_approving_review_count: 1 } }] })];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.require_two_approvals.enforced)
    throw new Error("min-value strong first");
});

// Ruleset variants
register("neg-ruleset-inactive", () => {
  if (check(ev({ rulesets: [rs({ enforcement: "evaluate" })] }), policy, CTX_LIVE).passed) throw new Error("inactive should fail");
});
register("neg-ruleset-bypass-all-controls", () => {
  const bypassed = rs({ bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole" }], rules: [
    { type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } },
    { type: "required_signatures" }, { type: "required_linear_history" }, { type: "non_fast_forward" }, { type: "deletion" },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, { context: "secret-scan" }] } }
  ] });
  const r = check(ev({ rulesets: [bypassed] }), policy, CTX_LIVE);
  if (r.passed) throw new Error("bypassed should not pass");
  if (r.failed.length !== policy.controls.length) throw new Error(`all controls should fail, got ${r.failed.length}`);
  if (r.controls.admin_enforcement.enforced) throw new Error("admin must not be enforced");
});
register("neg-mixed-classic-bypassed-ruleset", () => {
  const weakClassic = { required_pull_request_reviews: { required_approving_review_count: 2 }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, required_status_checks: { contexts: ["quality", "secret-scan"] } };
  const bypassed = rs({ bypass_actors: [{ actor_id: 1 }], rules: [
    { type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } },
    { type: "required_signatures" }, { type: "required_linear_history" }, { type: "non_fast_forward" }, { type: "deletion" },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "quality" }, { context: "secret-scan" }] } }
  ] });
  const r = check(ev({ classic_branch_protection: weakClassic, classic_required_signatures: SIGS_OFF, rulesets: [bypassed] }), policy, CTX_OFFLINE);
  if (!r.failed.includes("admin_enforcement")) throw new Error("admin must fail with bypass");
  if (!r.controls.require_two_approvals.enforced) throw new Error("classic 2-approvals should pass");
  if (!r.controls.require_pull_requests.enforced) throw new Error("classic PR required should pass");
  if (r.controls.require_codeowner_review.enforced) throw new Error("CODEOWNER from bypassed should not pass");
  if (r.controls.signed_commits.enforced) throw new Error("signed_commits from bypassed should not pass");
});
register("neg-ruleset-excluded-main", () => {
  const excludedRs = rs({ conditions: { ref_name: { include: ["refs/heads/main"], exclude: ["refs/heads/main"] } } });
  if (check(ev({ rulesets: [excludedRs] }), policy, CTX_LIVE).passed) throw new Error("excluded should fail");
});
register("neg-target-tag", () => {
  if (check(ev({ rulesets: [rs({ target: "tag" })] }), policy, CTX_LIVE).passed) throw new Error("target=tag should fail");
});
register("neg-target-missing", () => {
  const rl = rsFull(); delete rl[0].target;
  if (check(ev({ rulesets: rl }), policy, CTX_LIVE).passed) throw new Error("missing target should fail");
});

// Tri-state ref matching
register("ref-unknown-include-fails", () => {
  if (check(ev({ rulesets: [rs({ conditions: { ref_name: { include: ["refs/tags/v1", "~UNKNOWN"], exclude: [] } } })] }), policy, CTX_LIVE).passed)
    throw new Error("unknown include should fail");
});
register("ref-unknown-exclude-fails-closed", () => {
  if (check(ev({ rulesets: [rs({ conditions: { ref_name: { include: ["refs/heads/main"], exclude: ["~UNKNOWN_PATTERN"] } } })] }), policy, CTX_LIVE).passed)
    throw new Error("unknown exclude should drop ruleset");
});
register("ref-wildcard-include", () => {
  const rl = [rs({ conditions: { ref_name: { include: ["refs/heads/*"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] })];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.require_two_approvals.enforced)
    throw new Error("wildcard include should match");
});
register("ref-all-include", () => {
  const rl = [rs({ conditions: { ref_name: { include: ["~ALL"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] })];
  if (!check(ev({ rulesets: rl }), policy, CTX_LIVE).controls.require_two_approvals.enforced)
    throw new Error("~ALL include should match");
});
register("ref-default-branch-match", () => {
  const rl = [rs({ conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] })];
  if (!check(ev({ rulesets: rl, metadata: { ...ev().metadata, default_branch: "main" } }), policy, CTX_LIVE).controls.require_two_approvals.enforced)
    throw new Error("~DEFAULT_BRANCH should match main");
});
register("ref-default-branch-unknown", () => {
  if (check(ev({ rulesets: [rs({ conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } } })], metadata: { ...ev().metadata, default_branch: null } }), policy, CTX_LIVE).passed)
    throw new Error("unknown default should fail-safe");
});

// All _errors fatal
register("all-errors-fatal-401", () => {
  const r = check(ev({ _errors: [{ phase: "classic", status: 401 }] }), policy, CTX_OFFLINE);
  if (r.passed || r.failed.length !== 12) throw new Error("401 should fail all");
});
register("all-errors-fatal-403", () => {
  const r = check(ev({ _errors: [{ phase: "classic", status: 403 }] }), policy, CTX_OFFLINE);
  if (r.passed || r.failed.length !== 12) throw new Error("403 should fail all");
});
register("all-errors-fatal-404-ruleset-detail", () => {
  const r = check(ev({ _errors: [{ phase: "ruleset_detail", status: 404 }] }), policy, CTX_OFFLINE);
  if (r.passed || r.failed.length !== 12) throw new Error("404 detail should fail all");
});
register("all-errors-fatal-429", () => {
  const r = check(ev({ _errors: [{ phase: "classic", status: 429 }] }), policy, CTX_OFFLINE);
  if (r.passed || r.failed.length !== 12) throw new Error("429 should fail all");
});
register("all-errors-fatal-500", () => {
  const r = check(ev({ _errors: [{ phase: "rulesets_list", status: 500 }] }), policy, CTX_OFFLINE);
  if (r.passed || r.failed.length !== 12) throw new Error("500 should fail all");
});
register("all-errors-fatal-network", () => {
  const r = check(ev({ _errors: [{ phase: "network", status: 0 }] }), policy, CTX_OFFLINE);
  if (r.passed || r.failed.length !== 12) throw new Error("network should fail all");
});
register("all-errors-fatal-pagination", () => {
  const r = check(ev({ _errors: [{ phase: "rulesets_pagination", status: 0 }] }), policy, CTX_OFFLINE);
  if (r.passed || r.failed.length !== 12) throw new Error("pagination should fail all");
});

// Incomplete collection negatives
register("collectLive-repo-meta-no-default-branch", async () => {
  const { server, baseUrl } = await startServer(mockHandlers({ repoMeta: { status: 200, body: { default_branch: null } } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.phase === "repo_metadata" && e.reason === "missing-default-branch")) throw new Error("missing default_branch should error");
  const r = check(evidence, policy, CTX_LIVE);
  if (r.passed || r.failed.length !== 12) throw new Error("classic-all but repo-meta broken → all fail");
  server.close();
});
register("collectLive-classic-is-array", async () => {
  const { server, baseUrl } = await startServer(mockHandlers({ classic: { status: 200, body: [] } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.phase === "classic" && e.reason === "array-parsed-body")) throw new Error("classic array should error");
  const r = check(evidence, policy, CTX_LIVE);
  if (r.passed || r.failed.length !== 12) throw new Error("classic array → all fail");
  server.close();
});
register("collectLive-sigs-is-null", async () => {
  const { server, baseUrl } = await startServer(mockHandlers({ sigs: { status: 200, body: null } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.phase === "required_signatures" && e.reason === "null-parsed-body")) throw new Error("sigs null should error");
  const r = check(evidence, policy, CTX_LIVE);
  if (r.passed || r.failed.length !== 12) throw new Error("sigs null → all fail");
  server.close();
});
register("collectLive-detail-is-array", async () => {
  const { server, baseUrl } = await startServer(mockHandlers({ rulesetDetail: { status: 200, body: [] } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.phase === "ruleset_detail" && e.reason === "array-parsed-body")) throw new Error("detail array should error");
  server.close();
});
register("collectLive-non-numeric-ruleset-id", async () => {
  const { server, baseUrl } = await startServer(mockHandlers({
    rulesetList: { status: 200, body: [{ id: "not-a-number", name: "rs" }], link: "" }
  }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.phase === "ruleset_detail" && e.reason === "non-numeric-id")) throw new Error("non-numeric id should error");
  server.close();
});

// Collection: malformed detail shapes
register("collectLive-detail-invalid-bypass-actors", async () => {
  const detail = { ...rsFull()[0], bypass_actors: "not-an-array" };
  const { server, baseUrl } = await startServer(mockHandlers({ rulesetDetail: { status: 200, body: detail } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.phase === "ruleset_detail" && e.reason === "invalid-bypass_actors")) throw new Error("string bypass_actors should error");
  server.close();
});
register("collectLive-detail-invalid-rule-parameters", async () => {
  const detail = {
    id: 1, name: "rs1", enforcement: "active", target: "branch",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [{ type: "pull_request", parameters: "not-an-object" }]
  };
  const { server, baseUrl } = await startServer(mockHandlers({ rulesetDetail: { status: 200, body: detail } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.phase === "ruleset_detail" && e.reason === "invalid-rule-parameters")) throw new Error("string rule.parameters should error");
  server.close();
});
register("collectLive-detail-invalid-id", async () => {
  const detail = { ...rsFull()[0], id: "bad" };
  const { server, baseUrl } = await startServer(mockHandlers({ rulesetDetail: { status: 200, body: detail } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.phase === "ruleset_detail" && e.reason === "invalid-id")) throw new Error("non-numeric detail.id should error");
  server.close();
});
register("collectLive-detail-missing-bypass-actors", async () => {
  const detail = { ...rsFull()[0] };
  delete detail.bypass_actors;
  const { server, baseUrl } = await startServer(mockHandlers({ rulesetDetail: { status: 200, body: detail } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.reason === "invalid-bypass_actors")) throw new Error("missing bypass_actors should error");
  server.close();
});
register("collectLive-detail-missing-target", async () => {
  const detail = { ...rsFull()[0] };
  delete detail.target;
  const { server, baseUrl } = await startServer(mockHandlers({ rulesetDetail: { status: 200, body: detail } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.reason === "invalid-target")) throw new Error("missing target should error");
  server.close();
});
register("collectLive-detail-missing-enforcement", async () => {
  const detail = { ...rsFull()[0] };
  delete detail.enforcement;
  const { server, baseUrl } = await startServer(mockHandlers({ rulesetDetail: { status: 200, body: detail } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.reason === "invalid-enforcement")) throw new Error("missing enforcement should error");
  server.close();
});
register("collectLive-tag-ruleset-is-valid-but-ignored", async () => {
  const detail = { ...rsFull()[0], target: "tag", conditions: { ref_name: { include: ["refs/tags/*"], exclude: [] } } };
  const { server, baseUrl } = await startServer(mockHandlers({
    classic: { status: 404, body: {} },
    sigs: { status: 404, body: {} },
    rulesetDetail: { status: 200, body: detail },
  }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (evidence._errors.length !== 0) throw new Error(`legitimate tag ruleset rejected: ${JSON.stringify(evidence._errors)}`);
  if (check(evidence, policy, CTX_LIVE).passed) throw new Error("tag ruleset must not enforce branch controls");
  server.close();
});
register("collectLive-classic-malformed-review-shape", async () => {
  const classic = { ...CLASSIC_ALL, required_pull_request_reviews: "required" };
  const { server, baseUrl } = await startServer(mockHandlers({ classic: { status: 200, body: classic } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.reason === "invalid-pull-request-reviews")) throw new Error("malformed classic reviews should error");
  server.close();
});
register("collectLive-signatures-malformed-enabled", async () => {
  const { server, baseUrl } = await startServer(mockHandlers({ sigs: { status: 200, body: { enabled: "true" } } }));
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!evidence._errors.some(e => e.reason === "invalid-signatures-enabled")) throw new Error("malformed signatures should error");
  server.close();
});

// Offline hardened: deeper ruleset shape
register("offline-bypass_actors-string-treated-clean", () => {
  // In offline check(), bypass_actors: "not-an-array" should fail validation
  const r = check(ev({ rulesets: [{ id: 1, enforcement: "active", target: "branch", conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, bypass_actors: "not-an-array", rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] }] }), policy, CTX_OFFLINE);
  if (!r._error || r._error !== "malformed-evidence") throw new Error("string bypass_actors should reject offline evidence");
});
register("offline-invalid-rule-parameters-offline", () => {
  const r = check(ev({ rulesets: [{ id: 1, enforcement: "active", target: "branch", conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, bypass_actors: [], rules: [{ type: "pull_request", parameters: ["array-not-ok"] }] }] }), policy, CTX_OFFLINE);
  if (!r._error || r._error !== "malformed-evidence") throw new Error("array rule.parameters should reject");
});
register("offline-invalid-rule-type", () => {
  const r = check(ev({ rulesets: [{ id: 1, enforcement: "active", target: "branch", conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, bypass_actors: [], rules: [{ type: 123 }] }] }), policy, CTX_OFFLINE);
  if (!r._error || r._error !== "malformed-evidence") throw new Error("numeric rule.type should reject");
});
register("classic-ok-but-malformed-bypass-fails-all", () => {
  const evidence = ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON, rulesets: [{ id: 1, enforcement: "active", target: "branch", conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, bypass_actors: "bad", rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] }] });
  const r = check(evidence, policy, CTX_OFFLINE);
  if (!r._error) throw new Error("classic-ok + malformed ruleset should fail");
});
register("offline-invalid-conditions-include", () => {
  const r = check(ev({ rulesets: [{ id: 1, enforcement: "active", target: "branch", conditions: { ref_name: { include: "not-array", exclude: [] } }, bypass_actors: [], rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] }] }), policy, CTX_OFFLINE);
  if (!r._error) throw new Error("string include should reject");
});
register("offline-invalid-conditions-exclude", () => {
  const r = check(ev({ rulesets: [{ id: 1, enforcement: "active", target: "branch", conditions: { ref_name: { include: ["refs/heads/main"], exclude: "not-array" } }, bypass_actors: [], rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] }] }), policy, CTX_OFFLINE);
  if (!r._error) throw new Error("string exclude should reject");
});
register("offline-missing-bypass-actors", () => {
  const malformed = rsFull()[0];
  delete malformed.bypass_actors;
  if (!check(ev({ rulesets: [malformed] }), policy, CTX_OFFLINE)._error) throw new Error("missing bypass_actors should reject");
});
register("offline-missing-default-branch", () => {
  const metadata = { ...ev().metadata };
  delete metadata.default_branch;
  if (!check(ev({ metadata }), policy, CTX_OFFLINE)._error) throw new Error("missing default branch should reject");
});
register("offline-required-arrays-missing", () => {
  const evidence = ev();
  delete evidence.rulesets;
  delete evidence._errors;
  if (!check(evidence, policy, CTX_OFFLINE)._error) throw new Error("missing evidence arrays should reject");
});
register("offline-malformed-classic-review-shape", () => {
  const classic = { ...CLASSIC_ALL, required_pull_request_reviews: "required" };
  if (!check(ev({ classic_branch_protection: classic }), policy, CTX_OFFLINE)._error) throw new Error("malformed classic should reject");
});
register("offline-malformed-signatures-shape", () => {
  if (!check(ev({ classic_required_signatures: { enabled: "true" } }), policy, CTX_OFFLINE)._error) throw new Error("malformed signatures should reject");
});

// Existing offline tests
register("offline-evidence-not-object", () => {
  if (check("string", policy, CTX_OFFLINE)._error !== "malformed-evidence") throw new Error("non-object should fail");
});
register("offline-metadata-missing", () => {
  if (!check({ classic_branch_protection: CLASSIC_ALL }, policy, CTX_OFFLINE)._error) throw new Error("missing metadata should fail");
});
register("offline-metadata-default-branch-number", () => {
  if (!check(ev({ metadata: { repository: "a/b", branch: "main", default_branch: 42 } }), policy, CTX_OFFLINE)._error) throw new Error("numeric default_branch should fail");
});
register("offline-errors-entry-missing-phase", () => {
  if (!check(ev({ _errors: [{ status: 0 }] }), policy, CTX_OFFLINE)._error) throw new Error("missing phase should fail");
});
register("offline-errors-entry-missing-status", () => {
  if (!check(ev({ _errors: [{ phase: "classic" }] }), policy, CTX_OFFLINE)._error) throw new Error("missing status should fail");
});
register("offline-branch-mismatch", () => {
  if (check(ev({ metadata: { ...ev().metadata, branch: "develop" } }), policy, CTX_OFFLINE)._error !== "branch-mismatch") throw new Error("branch mismatch should fail");
});
register("offline-classic-not-object", () => {
  if (!check(ev({ classic_branch_protection: "bad" }), policy, CTX_OFFLINE)._error) throw new Error("string classic should fail");
});
register("offline-signatures-not-object", () => {
  if (!check(ev({ classic_required_signatures: "bad" }), policy, CTX_OFFLINE)._error) throw new Error("string sigs should fail");
});
register("offline-rulesets-not-array", () => {
  if (!check(ev({ rulesets: "bad" }), policy, CTX_OFFLINE)._error) throw new Error("string rulesets should fail");
});
register("offline-errors-not-array", () => {
  if (!check(ev({ _errors: "bad" }), policy, CTX_OFFLINE)._error) throw new Error("string _errors should fail");
});

// Hostile URL origin checks with STRONG assertions
register("hostile-origin-lookalike-in-self-href", async () => {
  const { server, baseUrl } = await startServer({
    "GET /repos/t/r": (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ default_branch: "main" })); },
    "GET /repos/t/r/branches/main/protection": (req, res) => { res.writeHead(404); res.end("{}"); },
    "GET /repos/t/r/branches/main/protection/required_signatures": (req, res) => { res.writeHead(404); res.end("{}"); },
    "GET /repos/t/r/rulesets": (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", Link: "" });
      res.end(JSON.stringify([{ id: 1, name: "rs", _links: { self: { href: "https://api.github.com.evil.example/repos/t/r/rulesets/1" } } }]));
    },
  });
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  const err = evidence._errors.find(e => e.reason === "hostile-self-href");
  if (!err) throw new Error("hostile lookalike self-href must produce error");
  const r = check(evidence, policy, CTX_LIVE);
  if (r.passed) throw new Error("hostile href should fail all controls");
  server.close();
});

register("hostile-origin-in-page-link-rejected", async () => {
  let hostileHit = false;
  const { server, baseUrl } = await startServer({
    "GET /repos/t/r": (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ default_branch: "main" })); },
    "GET /repos/t/r/branches/main/protection": (req, res) => { res.writeHead(404); res.end("{}"); },
    "GET /repos/t/r/branches/main/protection/required_signatures": (req, res) => { res.writeHead(404); res.end("{}"); },
    "GET /repos/t/r/rulesets": (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", Link: '<https://evil.example/repos/t/r/rulesets?page=2>; rel="next"' });
      res.end(JSON.stringify([{ id: 1, name: "rs", _links: { self: { href: "/repos/t/r/rulesets/1" } } }]));
    },
    "GET /repos/t/r/rulesets/1": (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(rsFull()[0])); },
  });
  const mockFetch = async (url, init) => {
    if (!LOOPBACK.test(url)) { hostileHit = true; throw new Error("FORBIDDEN_EXTERNAL_NETWORK_CALL"); }
    return originalFetch(url, init);
  };
  const evidence = await collectLive("t", "t", "r", "main", { fetch: mockFetch, baseUrl, timeout: 5000 });
  // hostileHit MUST be false (origin check blocked it before fetch)
  if (hostileHit) throw new Error("hostile Link was actually fetched — origin check failed");
  // Must have a foreign-origin error
  if (!evidence._errors.some(e => e.phase === "rulesets_list" && e.status === 0)) throw new Error("hostile Link must produce rulesets_list error");
  server.close();
});

// ghFetch origin check: startsWith bypass is gone; resolveUrl uses exact URL.origin
// The hostile-origin-lookalike-in-self-href test above proves origin checks work.
// Additional: verify that a relative-path-only detail with correct self-href works.

// Pagination
register("pagination-includes-both-query-params", async () => {
  let receivedQuery = null;
  const { server, baseUrl } = await startServer({
    "GET /repos/t/r": (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ default_branch: "main" })); },
    "GET /repos/t/r/branches/main/protection": (req, res) => { res.writeHead(404); res.end("{}"); },
    "GET /repos/t/r/branches/main/protection/required_signatures": (req, res) => { res.writeHead(404); res.end("{}"); },
    "GET /repos/t/r/rulesets": (req, res) => {
      receivedQuery = new URL(req.url, `http://${req.headers.host}`).searchParams;
      res.writeHead(200, { "Content-Type": "application/json", Link: "" });
      res.end(JSON.stringify([]));
    },
  });
  await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  if (!receivedQuery) throw new Error("rulesets endpoint should be called");
  if (receivedQuery.get("includes_parents") !== "true") throw new Error(`includes_parents=${receivedQuery.get("includes_parents")}`);
  if (receivedQuery.get("per_page") !== "100") throw new Error(`per_page=${receivedQuery.get("per_page")}`);
  server.close();
});

// Total timeout injectable
register("total-timeout-injectable", async () => {
  const { server, baseUrl } = await startServer({
    "GET /repos/t/r": (req, res) => { /* hang forever — never respond */ },
  });
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 1000, totalTimeout: 200 });
  // After totalTimeout fires, the hanging repo-meta fetch returns _network_error.
  // collectLive should return evidence (not throw) with _errors populated.
  if (!evidence._errors.some(e => e.phase === "repo_metadata" && e.status === 0)) throw new Error("hang should produce repo_metadata error");
  const r = check(evidence, policy, CTX_LIVE);
  if (r.passed) throw new Error("timeout evidence should fail all controls");
  server.close();
});

// >10 rule details — no MaxListeners
register("no-maxlisteners-warning-on-many-details", async () => {
  const detailBodies = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1, name: `rs${i + 1}`, enforcement: "active", target: "branch",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }],
  }));
  const listBody = detailBodies.map((d) => ({
    id: d.id, name: d.name,
    _links: { self: { href: `/repos/t/r/rulesets/${d.id}` } },
    enforcement: "active", target: "branch",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
  }));
  const detailMap = {};
  for (const d of detailBodies) {
    detailMap[`GET /repos/t/r/rulesets/${d.id}`] = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(d));
    };
  }
  let warningEmitted = false;
  const origWarn = process.emitWarning;
  process.emitWarning = (msg, ...args) => {
    if (typeof msg === "string" && msg.includes("MaxListeners")) warningEmitted = true;
    return origWarn.call(process, msg, ...args);
  };
  const { server, baseUrl } = await startServer({
    "GET /repos/t/r": (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ default_branch: "main" })); },
    "GET /repos/t/r/branches/main/protection": (req, res) => { res.writeHead(404); res.end("{}"); },
    "GET /repos/t/r/branches/main/protection/required_signatures": (req, res) => { res.writeHead(404); res.end("{}"); },
    "GET /repos/t/r/rulesets": (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", Link: "" });
      res.end(JSON.stringify(listBody));
    },
    ...detailMap,
  });
  const evidence = await collectLive("t", "t", "r", "main", { fetch: globalThis.fetch, baseUrl, timeout: 5000 });
  process.emitWarning = origWarn;
  if (warningEmitted) throw new Error("MaxListeners warning emitted");
  if (evidence.rulesets.length !== 15) throw new Error(`should have 15 rulesets, got ${evidence.rulesets.length}`);
  server.close();
});

// main() opts.evidencePath
register("main-opts-evidencePath", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fnd01-test-"));
  const f = path.join(dir, "evidence.json");
  await writeFile(f, JSON.stringify(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON })));
  const exit = await main({ evidencePath: f });
  if (exit !== 0) throw new Error(`should exit 0, got ${exit}`);
  await rm(dir, { recursive: true, force: true });
});

// GITHUB_REPOSITORY segment validation
register("cli-repo-three-segments", async () => {
  const mockCollect = async () => ({ metadata: { repository: "a/b/c", branch: "main", fetched_at: "now", default_branch: "main" }, classic_branch_protection: null, classic_required_signatures: null, rulesets: [], _errors: [] });
  const exit = await main({ token: "fake_token_not_ghp_format", repository: "o/r/extra", injectCollectLive: mockCollect });
  if (exit !== 2) throw new Error(`should exit 2, got ${exit}`);
});
register("cli-repo-one-segment", async () => {
  const mockCollect = async () => ({ metadata: { repository: "only", branch: "main", fetched_at: "now", default_branch: "main" }, classic_branch_protection: null, classic_required_signatures: null, rulesets: [], _errors: [] });
  const exit = await main({ token: "fake_token_not_ghp_format", repository: "only", injectCollectLive: mockCollect });
  if (exit !== 2) throw new Error(`should exit 2, got ${exit}`);
});

// Live CLI via mock (zero network)
register("cli-live-mock-collector-pass", async () => {
  const evidence = ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON });
  const mockCollect = async () => evidence;
  const exit = await main({ token: "fake_token_not_ghp_format", repository: "test-owner/test-repo", injectCollectLive: mockCollect });
  if (exit !== 0) throw new Error(`should exit 0, got ${exit}`);
});
register("cli-live-mock-collector-fail", async () => {
  const mockCollect = async () => ({ metadata: { repository: "a/b", branch: "main", fetched_at: "now", default_branch: "main" }, classic_branch_protection: null, classic_required_signatures: null, rulesets: [], _errors: [] });
  const exit = await main({ token: "fake_token_not_ghp_format", repository: "test-owner/test-repo", injectCollectLive: mockCollect });
  if (exit !== 1) throw new Error(`should exit 1, got ${exit}`);
});

// CLI offline
register("cli-malformed-json-exit-2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fnd01-test-"));
  const f = path.join(dir, "bad.json");
  await writeFile(f, "{ broken");
  const r = spawnSync(process.execPath, [VERIFIER, f], { encoding: "utf8" });
  await rm(dir, { recursive: true, force: true });
  if (r.status !== 2) throw new Error(`got ${r.status}`);
  if ((r.stdout + r.stderr).includes(dir)) throw new Error("path leaked");
  if ((r.stdout + r.stderr).includes("/tmp/")) throw new Error("tmp path leaked");
});
register("cli-missing-file-exit-2", () => {
  const r = spawnSync(process.execPath, [VERIFIER, "/nonexistent/file.json"], { encoding: "utf8" });
  if (r.status !== 2) throw new Error(`got ${r.status}`);
  if ((r.stdout + r.stderr).includes("/nonexistent")) throw new Error("path leaked");
});
register("cli-offline-valid-json-exit-0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fnd01-test-"));
  const f = path.join(dir, "good.json");
  await writeFile(f, JSON.stringify(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON })));
  const r = spawnSync(process.execPath, [VERIFIER, f], { encoding: "utf8" });
  await rm(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`got ${r.status}: ${r.stderr}`);
  if ((r.stdout + r.stderr).includes(dir)) throw new Error("path leaked");
});

// Policy + redaction
register("policy-parity", () => {
  const r = check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE);
  for (const c of policy.controls) if (r.controls[c.id] === undefined) throw new Error(`missing ${c.id}`);
  for (const id of Object.keys(r.controls)) if (!policy.controls.some(c => c.id === id)) throw new Error(`extra ${id}`);
});
register("redaction-no-secrets", () => {
  const j = JSON.stringify(check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE));
  if (/ghp_[a-zA-Z0-9]{36}/.test(j)) throw new Error("ghp_ leaked");
  if (/github_pat_/.test(j)) throw new Error("github_pat_ leaked");
  if (/Bearer\s+/.test(j)) throw new Error("Bearer leaked");
});
register("redaction-repository-is-redacted", () => {
  if (check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON }), policy, CTX_OFFLINE).repository !== "redacted")
    throw new Error("repository should be redacted");
});
register("redaction-metadata-seeded-token", () => {
  const evidence = ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON });
  const ghp = "gh";
  evidence.metadata.repository = `${ghp}p_seededtoken123456789012345678901234`;
  const j = JSON.stringify(check(evidence, policy, CTX_OFFLINE));
  if (j.includes("ghp_seeded")) throw new Error("token leaked");
  if (!j.includes("redacted")) throw new Error("output should use redacted literal");
});

// Combined
register("combined-classic-plus-clean-ruleset", () => {
  if (!check(ev({ classic_branch_protection: CLASSIC_ALL, classic_required_signatures: SIGS_ON, rulesets: rsFull() }), policy, CTX_OFFLINE).passed)
    throw new Error("combined should pass");
});
register("mixed-clean-and-bypassed", () => {
  const clean = rs({ id: 2, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }] });
  const bypassed = rs({ id: 3, bypass_actors: [{ actor_id: 1 }], rules: [{ type: "required_signatures" }] });
  const r = check(ev({ rulesets: [clean, bypassed] }), policy, CTX_LIVE);
  if (!r.controls.require_two_approvals.enforced) throw new Error("clean ruleset controls should pass");
  if (r.controls.signed_commits.enforced) throw new Error("bypassed ruleset controls excluded");
  if (r.controls.admin_enforcement.enforced) throw new Error("admin fails with any bypass");
});

// =======================================================================
// RUN ALL TESTS SEQUENTIALLY — EVERY PROMISE AWAITED BEFORE COUNTING
// =======================================================================
let passed = 0, fail = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (e) {
    // Self-test: the runner must catch the async rejection
    if (e === _ASYNC_RUNNER_SELF_TEST_FAILED) {
      console.log(`PASS: __ASYNC_RUNNER_SELF_TEST (async rejection caught — runner works)`);
      passed++;
    } else {
      console.log(`FAIL: ${name} — ${e.message}`);
      fail++;
    }
  }
}

// Restore original fetch
globalThis.fetch = originalFetch;

// Network trap assertion
if (extCallCount > 0) {
  console.log(`FAIL: NETWORK_TRAP — ${extCallCount} external network call(s) detected`);
  fail++;
} else {
  console.log(`PASS: NETWORK_TRAP — zero external network calls`);
  passed++;
}

console.log(`\n${passed} passed, ${fail} failed, ${passed + fail} total`);
process.exit(fail > 0 ? 1 : 0);

// -----------------------------------------------------------------------
// Mock helpers
// -----------------------------------------------------------------------
function startServer(handlers) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const key = `${req.method} ${u.pathname}`;
      const h = handlers[key] || handlers[`${req.method} ${u.pathname}${u.search}`] || handlers["*"];
      if (h) h(req, res, u); else { res.writeHead(404); res.end("{}"); }
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port, baseUrl: `http://127.0.0.1:${s.address().port}` }));
  });
}

function mockHandlers(opts = {}) {
  const classic = opts.classic || { status: 200, body: CLASSIC_ALL };
  const sigs = opts.sigs || { status: 200, body: SIGS_ON };
  const repoMeta = opts.repoMeta || { status: 200, body: { default_branch: "main" } };
  const rulesetList = opts.rulesetList || {
    status: 200,
    body: [{ id: 1, name: "rs1", enforcement: "active", target: "branch", _links: { self: { href: "/repos/t/r/rulesets/1" } }, conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, bypass_actors: [] }],
    link: "",
  };
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
