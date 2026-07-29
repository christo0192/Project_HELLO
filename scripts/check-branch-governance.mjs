#!/usr/bin/env node

/**
 * check-branch-governance.mjs — Zero-dependency offline branch governance verifier.
 *
 * Reads GitHub API evidence from a local JSON file (INFORMER_PATH env or first CLI arg,
 * default .github/branch-governance-evidence.json) and verifies all required branch
 * protection / ruleset controls for the 'main' branch.
 *
 * NEVER calls the GitHub API directly. This is a read-only offline verifier.
 *
 * Exit codes:
 *   0 — all controls ENFORCED
 *   1 — one or more controls NOT ENFORCED (fail-closed)
 *   2 — input malformed, file not found, or parse error
 *   3 — network/API error (reserved for future live-fetch mode)
 */

import { readFile } from "node:fs/promises";
import process from "node:process";

// ---- Policy definition (mirrors .github/branch-governance-policy.json) ----

const POLICY = {
  required_status_checks: ["quality", "secret-scan"],
  controls: [
    { id: "require_pull_requests",         classic: "required_pull_request_reviews",                       ruleset: "required_pull_request",                             check: "exists" },
    { id: "require_two_approvals",         classic: "required_pull_request_reviews.required_approving_review_count", ruleset: "required_pull_request", rulesetParam: "required_approving_review_count", check: "min_value", minValue: 2 },
    { id: "require_codeowner_review",      classic: "required_pull_request_reviews.require_code_owner_reviews",       ruleset: "required_pull_request", rulesetParam: "require_code_owner_review",        check: "true" },
    { id: "dismiss_stale_approvals",       classic: "required_pull_request_reviews.dismiss_stale_reviews",           ruleset: "required_pull_request", rulesetParam: "dismiss_stale_reviews_on_push",    check: "true" },
    { id: "require_last_push_approval",    classic: "required_pull_request_reviews.require_last_push_approval",      ruleset: "required_pull_request", rulesetParam: "require_last_push_approval",         check: "true" },
    { id: "require_conversation_resolution", classic: "required_conversation_resolution.enabled",                   ruleset: "required_conversation_resolution",                 check: "true" },
    { id: "admin_enforcement",             classic: "enforce_admins.enabled",                                      ruleset: "bypass_allowances",                               check: "enforce_admins" },
    { id: "signed_commits",                classic: "required_signatures.enabled",                                  ruleset: "required_signatures",                             check: "true" },
    { id: "linear_history",                classic: "required_linear_history.enabled",                              ruleset: "non_fast_forward",                                check: "true" },
    { id: "force_push_disabled",           classic: "allow_force_pushes.enabled",                                   ruleset: "allow_force_pushes",                              check: "false" },
    { id: "deletion_disabled",             classic: "allow_deletions.enabled",                                      ruleset: "deletion",                                        check: "false" },
    { id: "required_status_checks",        classic: "required_status_checks.contexts",                              ruleset: "required_status_checks", rulesetParam: "required_status_checks", check: "status_checks", expectedChecks: ["quality", "secret-scan"] },
  ],
};

// ---- Helpers ----

function get(obj, path) {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function hasClassicProtection(evidence) {
  return evidence && evidence.classic_branch_protection && typeof evidence.classic_branch_protection === "object";
}

function getRulesets(evidence) {
  if (!evidence || !Array.isArray(evidence.rulesets)) return [];
  return evidence.rulesets.filter((rs) => {
    const include = get(rs, "conditions.ref_name.include");
    return Array.isArray(include) && include.some((r) => r === "refs/heads/main" || r === "~DEFAULT_BRANCH");
  });
}

function hasRulesetRule(rulesets, ruleType, paramName, expectedValue) {
  for (const rs of rulesets) {
    const rules = get(rs, "rules");
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (rule.type !== ruleType) continue;
      if (paramName === undefined) return true;
      const val = get(rule, `parameters.${paramName}`);
      if (val === expectedValue) return true;
    }
  }
  return false;
}

function rulesetRuleValue(rulesets, ruleType, paramName) {
  for (const rs of rulesets) {
    const rules = get(rs, "rules");
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (rule.type !== ruleType) continue;
      const val = get(rule, `parameters.${paramName}`);
      if (val !== undefined) return val;
    }
  }
  return undefined;
}

function rulesetFindFirstRule(rulesets, ruleType) {
  for (const rs of rulesets) {
    const rules = get(rs, "rules");
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (rule.type === ruleType) return rule;
    }
  }
  return null;
}

function rulesetBypassAllowed(rulesets) {
  // If any ruleset targeting main has non-empty bypass_allowances, admins can bypass
  for (const rs of rulesets) {
    const bypass = get(rs, "bypass_allowances");
    if (bypass) {
      const users = bypass.users || [];
      const teams = bypass.teams || [];
      const apps = bypass.apps || [];
      if (users.length > 0 || teams.length > 0 || apps.length > 0) return true;
    }
  }
  return false;
}

function checkStatusChecks(contexts, expected) {
  if (!Array.isArray(contexts)) return false;
  const sorted = [...contexts].sort();
  const expectedSorted = [...expected].sort();
  return sorted.length === expectedSorted.length && sorted.every((v, i) => v === expectedSorted[i]);
}

function checkStatusChecksRuleset(rulesets, expected) {
  const checks = rulesetRuleValue(rulesets, "required_status_checks", "required_status_checks");
  if (!Array.isArray(checks)) return false;
  return checkStatusChecks(checks, expected);
}

// ---- Core check function ----

/**
 * @param {object} evidence - Parsed evidence JSON
 * @returns {{ passed: boolean, controls: object, failed: string[], summary: string, repository: string, branch: string }}
 */
export function check(evidence) {
  const repository = evidence?.metadata?.repository || "unknown";
  const branch = evidence?.metadata?.branch || "main";
  const controls = {};
  const failed = [];

  // If evidence has an error field set (401/403/404), all controls fail
  const err = evidence?.metadata?.error;
  if (err && err.status && err.status >= 400) {
    for (const ctrl of POLICY.controls) {
      controls[ctrl.id] = { enforced: false, source: "error", reason: `API error ${err.status}: ${err.message || "unknown"}` };
      failed.push(ctrl.id);
    }
    return {
      passed: false,
      controls,
      failed,
      summary: `FAILED: API error ${err.status} — all ${POLICY.controls.length} controls NOT ENFORCED`,
      repository,
      branch,
    };
  }

  const classic = hasClassicProtection(evidence) ? evidence.classic_branch_protection : null;
  const rulesets = getRulesets(evidence);

  for (const ctrl of POLICY.controls) {
    let enforced = false;
    let source = null;
    let details = null;

    // Check via classic branch protection
    if (classic) {
      const classicValue = get(classic, ctrl.classic);
      switch (ctrl.check) {
        case "exists":
          enforced = classicValue !== undefined && classicValue !== null;
          if (enforced) source = "classic";
          break;
        case "true":
          enforced = classicValue === true;
          if (enforced) source = "classic";
          else if (ctrl.id === "require_last_push_approval" && classicValue === undefined) {
            // Field may not exist in older API versions — stay not enforced
          }
          break;
        case "false":
          enforced = classicValue === false;
          if (enforced) source = "classic";
          break;
        case "min_value":
          enforced = typeof classicValue === "number" && classicValue >= ctrl.minValue;
          if (enforced) { source = "classic"; details = classicValue; }
          break;
        case "enforce_admins":
          enforced = classicValue === true;
          if (enforced) source = "classic";
          break;
        case "status_checks":
          enforced = checkStatusChecks(classicValue, ctrl.expectedChecks);
          if (enforced) source = "classic";
          break;
      }
    }

    // If not enforced via classic, check via rulesets
    if (!enforced && rulesets.length > 0) {
      switch (ctrl.check) {
        case "exists":
          enforced = hasRulesetRule(rulesets, ctrl.ruleset);
          if (enforced) source = "ruleset";
          break;
        case "true":
          enforced = hasRulesetRule(rulesets, ctrl.ruleset, ctrl.rulesetParam, true);
          if (enforced) source = "ruleset";
          break;
        case "false":
          if (ctrl.id === "force_push_disabled") {
            const fpRule = rulesetFindFirstRule(rulesets, "allow_force_pushes");
            if (fpRule) {
              enforced = get(fpRule, "parameters.allow_force_pushes") === false;
              if (enforced) source = "ruleset";
            }
          } else if (ctrl.id === "deletion_disabled") {
            const delRule = rulesetFindFirstRule(rulesets, "deletion");
            if (delRule) {
              enforced = true;
              source = "ruleset";
            }
          }
          break;
        case "min_value":
          const val = rulesetRuleValue(rulesets, ctrl.ruleset, ctrl.rulesetParam);
          enforced = typeof val === "number" && val >= ctrl.minValue;
          if (enforced) { source = "ruleset"; details = val; }
          break;
        case "enforce_admins":
          enforced = !rulesetBypassAllowed(rulesets);
          if (enforced) source = "ruleset";
          break;
        case "status_checks":
          enforced = checkStatusChecksRuleset(rulesets, ctrl.expectedChecks);
          if (enforced) source = "ruleset";
          break;
      }
    }

    // Build result
    const result = { enforced };
    if (source) result.source = source;
    if (details !== null) result.details = details;
    if (!enforced) {
      result.reason = `not enforced via classic or ruleset`;
      failed.push(ctrl.id);
    }
    controls[ctrl.id] = result;
  }

  const passed = failed.length === 0;
  const summary = passed
    ? `ALL ${POLICY.controls.length} controls ENFORCED`
    : `FAILED: ${failed.length} of ${POLICY.controls.length} controls NOT ENFORCED`;

  return { passed, controls, failed, summary, repository, branch };
}

// ---- CLI ----

async function main() {
  const evidencePath = process.env.INFORMER_PATH || process.argv[2] || ".github/branch-governance-evidence.json";

  let raw;
  try {
    raw = await readFile(evidencePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      process.stderr.write(JSON.stringify({ error: "evidence-file-not-found", path: evidencePath }) + "\n");
      return 2;
    }
    if (err.code === "EACCES" || err.code === "EISDIR") {
      process.stderr.write(JSON.stringify({ error: "cannot-read-evidence-file", path: evidencePath, detail: err.code }) + "\n");
      return 2;
    }
    process.stderr.write(JSON.stringify({ error: "file-read-error", path: evidencePath, detail: err.message }) + "\n");
    return 2;
  }

  let evidence;
  try {
    evidence = JSON.parse(raw);
  } catch {
    process.stderr.write(JSON.stringify({ error: "malformed-json", path: evidencePath }) + "\n");
    return 2;
  }

  // Validate basic structure
  if (!evidence || typeof evidence !== "object") {
    process.stderr.write(JSON.stringify({ error: "invalid-evidence-structure", path: evidencePath }) + "\n");
    return 2;
  }

  const result = check(evidence);

  // Build redacted output — NO raw API bodies, NO tokens, NO secrets
  const output = {
    repository: result.repository,
    branch: result.branch,
    passed: result.passed,
    controls: result.controls,
    summary: result.summary,
  };

  const json = JSON.stringify(output, null, 2);

  if (result.passed) {
    process.stdout.write(json + "\n");
    return 0;
  } else {
    process.stderr.write(json + "\n");
    return 1;
  }
}

// Run if called directly
if (process.argv[1] && (process.argv[1] === import.meta.url?.replace("file://", "") || process.argv[1].endsWith("check-branch-governance.mjs"))) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(JSON.stringify({ error: "unexpected-error", detail: err.message }) + "\n");
    process.exit(2);
  });
}
