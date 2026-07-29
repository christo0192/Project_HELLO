#!/usr/bin/env node

/**
 * check-branch-governance.mjs — Zero-dependency branch governance verifier.
 *
 * Two modes:
 *   LIVE:   GITHUB_TOKEN env var set → read-only GitHub API collection
 *   OFFLINE: INFORMER_PATH env or CLI arg → local evidence JSON file
 *
 * Policy is loaded from .github/branch-governance-policy.json at runtime.
 * Output is a fixed-schema redacted JSON summary. Never prints tokens,
 * Authorization headers, raw API bodies, error messages, or file paths.
 *
 * Exit codes:
 *   0 — all controls ENFORCED
 *   1 — one or more controls NOT ENFORCED (fail-closed)
 *   2 — input malformed, file not found, or parse error
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Policy loading
// ---------------------------------------------------------------------------

function resolvePolicyPath() {
  const scriptPath = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(scriptPath);
  return path.resolve(scriptDir, "..", ".github", "branch-governance-policy.json");
}

async function loadPolicy() {
  const raw = await readFile(resolvePolicyPath(), "utf8");
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function get(obj, dotpath) {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = dotpath.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function validateGitHubName(name, label) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`invalid-${label}`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`invalid-${label}`);
  }
}

// ---------------------------------------------------------------------------
// Live collector (GitHub API)
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";
const MAX_RULESET_PAGES = 3;
const RULESET_PER_PAGE = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const TOTAL_COLLECTION_TIMEOUT_MS = 60_000;

async function ghFetch(token, urlPath, opts = {}) {
  const fetcher = opts.fetch || globalThis.fetch;
  const baseUrl = opts.baseUrl || GITHUB_API;
  const timeoutMs = opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT_MS;
  const parentSignal = opts.signal || null;

  let url;
  if (urlPath.startsWith(baseUrl)) {
    url = urlPath;
  } else if (urlPath.startsWith("http")) {
    // Foreign origin
    return { _foreign_origin: true };
  } else {
    url = `${baseUrl}${urlPath}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("timeout", "AbortError")), timeoutMs);

  if (parentSignal) {
    parentSignal.addEventListener("abort", () => controller.abort(parentSignal.reason), { once: true });
  }

  let resp;
  try {
    resp = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "fnd01-branch-governance-verifier/1.0",
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") return { _network_error: true };
    return { _network_error: true };
  }

  clearTimeout(timeout);

  let text;
  try { text = await resp.text(); } catch { return { _malformed: true, _status: resp.status }; }

  let body;
  try { body = JSON.parse(text); } catch { return { _malformed: true, _status: resp.status }; }

  body._status = resp.status;
  return body;
}

async function ghFetchAll(token, urlPath, opts = {}) {
  const fetcher = opts.fetch || globalThis.fetch;
  const baseUrl = opts.baseUrl || GITHUB_API;
  const timeoutMs = opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT_MS;
  const parentSignal = opts.signal || null;

  const results = [];
  let nextUrl = urlPath.includes("?") ? urlPath : `${urlPath}?per_page=${RULESET_PER_PAGE}`;
  let pages = 0;

  while (nextUrl && pages < MAX_RULESET_PAGES) {
    pages++;

    let url;
    if (nextUrl.startsWith("http")) {
      if (!nextUrl.startsWith(GITHUB_API)) return { _foreign_origin: true };
      url = nextUrl;
    } else {
      url = `${baseUrl}${nextUrl}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("timeout", "AbortError")), timeoutMs);
    if (parentSignal) parentSignal.addEventListener("abort", () => controller.abort(parentSignal.reason), { once: true });

    let resp;
    try {
      resp = await fetcher(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "fnd01-branch-governance-verifier/1.0",
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      return { _network_error: true };
    }

    clearTimeout(timeout);

    let text;
    try { text = await resp.text(); } catch { return { _malformed: true, _status: resp.status }; }

    let body;
    try { body = JSON.parse(text); } catch { return { _malformed: true, _status: resp.status }; }

    if (!Array.isArray(body)) return { _malformed: true, _status: resp.status };
    if (resp.status !== 200) return { _malformed: true, _status: resp.status };

    results.push(...body);

    const link = resp.headers.get("link");
    if (link) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = match ? match[1] : null;
    } else {
      nextUrl = null;
    }
  }

  if (pages >= MAX_RULESET_PAGES && nextUrl) {
    results._pagination_truncated = true;
  }

  return results;
}

export async function collectLive(token, owner, repo, branch, opts = {}) {
  validateGitHubName(owner, "owner");
  validateGitHubName(repo, "repo");
  validateGitHubName(branch, "branch");

  const baseUrl = opts.baseUrl || GITHUB_API;
  const timeout = opts.timeout;
  const fetcher = opts.fetch;

  const totalController = new AbortController();
  const totalTimeout = setTimeout(
    () => totalController.abort(new DOMException("total-timeout", "AbortError")),
    TOTAL_COLLECTION_TIMEOUT_MS
  );

  const dOpts = { fetch: fetcher, baseUrl, timeout, signal: totalController.signal };

  const evidence = {
    metadata: {
      repository: `${owner}/${repo}`,
      branch,
      fetched_at: new Date().toISOString(),
      default_branch: null,
    },
    classic_branch_protection: null,
    classic_required_signatures: null,
    rulesets: [],
    _errors: [],
  };

  try {
    // 0. Fetch repo metadata for default_branch
    const repoMeta = await ghFetch(token, `/repos/${owner}/${repo}`, dOpts);
    const repoMetaStatus = repoMeta._status;
    delete repoMeta._status;
    if (repoMeta._network_error || repoMeta._foreign_origin) {
      evidence._errors.push({ phase: "repo_metadata", status: 0 });
    } else if (repoMeta._malformed || repoMetaStatus !== 200) {
      evidence._errors.push({ phase: "repo_metadata", status: repoMetaStatus || 0 });
    } else {
      evidence.metadata.default_branch = repoMeta.default_branch || null;
    }

    if (totalController.signal.aborted) throw totalController.signal.reason;

    // 1. Classic branch protection
    const classic = await ghFetch(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`, dOpts);
    const classicStatus = classic._status;
    delete classic._status;

    if (classic._network_error || classic._foreign_origin) {
      evidence._errors.push({ phase: "classic", status: 0 });
    } else if (classic._malformed) {
      evidence._errors.push({ phase: "classic", status: classicStatus || 0 });
    } else if (classicStatus === 404) {
      evidence.classic_branch_protection = null;
    } else if (classicStatus === 401 || classicStatus === 403) {
      evidence._errors.push({ phase: "classic", status: classicStatus });
    } else if (classicStatus === 200) {
      evidence.classic_branch_protection = classic;
    } else {
      evidence._errors.push({ phase: "classic", status: classicStatus || 0 });
    }

    if (totalController.signal.aborted) throw totalController.signal.reason;

    // 2. Classic required signatures
    const sigs = await ghFetch(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_signatures`, dOpts);
    const sigsStatus = sigs._status;
    delete sigs._status;

    if (sigs._network_error || sigs._foreign_origin) {
      evidence._errors.push({ phase: "required_signatures", status: 0 });
    } else if (sigs._malformed) {
      evidence._errors.push({ phase: "required_signatures", status: sigsStatus || 0 });
    } else if (sigsStatus === 200) {
      evidence.classic_required_signatures = sigs;
    } else if (sigsStatus === 404) {
      evidence.classic_required_signatures = null;
    } else {
      evidence._errors.push({ phase: "required_signatures", status: sigsStatus || 0 });
    }

    if (totalController.signal.aborted) throw totalController.signal.reason;

    // 3. Rulesets list (paginated, with inherited)
    const rulesetList = await ghFetchAll(token, `/repos/${owner}/${repo}/rulesets?includes_parents=true`, dOpts);

    if (rulesetList._network_error || rulesetList._foreign_origin) {
      evidence._errors.push({ phase: "rulesets_list", status: 0 });
    } else if (rulesetList._malformed) {
      evidence._errors.push({ phase: "rulesets_list", status: rulesetList._status || 0 });
    } else if (Array.isArray(rulesetList)) {
      const truncated = rulesetList._pagination_truncated;
      delete rulesetList._pagination_truncated;
      if (truncated) {
        evidence._errors.push({ phase: "rulesets_pagination", status: 0 });
      }
      if (!totalController.signal.aborted) {
        // 4. Fetch each ruleset detail
        for (const rsSummary of rulesetList) {
          if (!rsSummary || typeof rsSummary.id !== "number" || rsSummary.id < 1) continue;

          let detailUrl;
          const selfHref = rsSummary._links?.self?.href;
          if (selfHref) {
            if (typeof selfHref !== "string" || (!selfHref.startsWith(GITHUB_API) && !selfHref.startsWith("/"))) {
              evidence._errors.push({ phase: "ruleset_detail", ruleset_id: rsSummary.id, status: 0 });
              continue;
            }
            detailUrl = selfHref;
          } else {
            detailUrl = `/repos/${owner}/${repo}/rulesets/${rsSummary.id}`;
          }

          const detail = await ghFetch(token, detailUrl, dOpts);
          const detailStatus = detail._status;
          delete detail._status;

          if (detail._network_error || detail._foreign_origin) {
            evidence._errors.push({ phase: "ruleset_detail", ruleset_id: rsSummary.id, status: 0 });
          } else if (detail._malformed) {
            evidence._errors.push({ phase: "ruleset_detail", ruleset_id: rsSummary.id, status: detailStatus || 0 });
          } else if (detailStatus === 200) {
            evidence.rulesets.push(detail);
          } else {
            evidence._errors.push({ phase: "ruleset_detail", ruleset_id: rsSummary.id, status: detailStatus || 0 });
          }

          if (totalController.signal.aborted) throw totalController.signal.reason;
        }
      }
    }
  } finally {
    clearTimeout(totalTimeout);
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Ruleset helpers
// ---------------------------------------------------------------------------

/**
 * Classify a ref pattern against target branch.
 * Returns:
 *   "match"    — definitely matches
 *   "nomatch"  — definitely does not match
 *   "unknown"  — cannot determine (fail-safe)
 */
function classifyRef(pattern, targetBranch, knownDefaultBranch) {
  // Exact match
  if (pattern === `refs/heads/${targetBranch}`) return "match";

  // ~ALL
  if (pattern === "~ALL") return "match";

  // ~DEFAULT_BRANCH — need known default
  if (pattern === "~DEFAULT_BRANCH") {
    if (knownDefaultBranch === targetBranch) return "match";
    if (knownDefaultBranch && knownDefaultBranch !== targetBranch) return "nomatch";
    return "unknown";
  }

  // refs/heads/* — matches any branch
  if (pattern === "refs/heads/*") return "match";

  // refs/heads/main* — prefix under refs/heads/
  if (pattern.startsWith("refs/heads/") && pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    if (`refs/heads/${targetBranch}`.startsWith(prefix)) return "match";
    return "nomatch";
  }

  // refs/tags/*, refs/*, ~UNKNOWN, or anything else → unknown for include, unknown for exclude
  if (pattern.startsWith("refs/") && !pattern.startsWith("refs/heads/")) return "nomatch";
  return "unknown";
}

function activeRulesetsForBranch(evidence, targetBranch, knownDefaultBranch) {
  if (!evidence || !Array.isArray(evidence.rulesets)) return [];
  return evidence.rulesets.filter((rs) => {
    if (rs.enforcement !== "active") return false;
    // Require target === "branch"
    if (rs.target !== "branch") return false;

    const cond = get(rs, "conditions.ref_name");
    if (!cond) return false;
    const include = Array.isArray(cond.include) ? cond.include : [];
    const exclude = Array.isArray(cond.exclude) ? cond.exclude : [];

    // Include: at least one definite match, no unknowns
    let hasMatch = false;
    let hasUnknownInclude = false;
    for (const p of include) {
      const c = classifyRef(p, targetBranch, knownDefaultBranch);
      if (c === "match") hasMatch = true;
      if (c === "unknown") hasUnknownInclude = true;
    }
    if (!hasMatch || hasUnknownInclude) return false;

    // Exclude: any definite match → drop; any unknown → drop (fail-closed)
    for (const p of exclude) {
      const c = classifyRef(p, targetBranch, knownDefaultBranch);
      if (c === "match" || c === "unknown") return false;
    }

    return true;
  });
}

/** Check if ANY rule across ALL rulesets matches ruleType and optional predicate */
function anyRulesetRule(rulesets, ruleType, predicate) {
  for (const rs of rulesets) {
    const rules = rs.rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (rule.type !== ruleType) continue;
      if (!predicate) return true;
      if (predicate(rule)) return true;
    }
  }
  return false;
}

function rulesetRuleParamAny(rulesets, ruleType, paramName) {
  for (const rs of rulesets) {
    const rules = rs.rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (rule.type !== ruleType) continue;
      if (rule.parameters && rule.parameters[paramName] !== undefined) {
        return rule.parameters[paramName];
      }
    }
  }
  return undefined;
}

/** Check if ANY rule across all rulesets satisfies min_value */
function anyRulesetRuleMinValue(rulesets, ruleType, paramName, minVal) {
  for (const rs of rulesets) {
    const rules = rs.rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (rule.type !== ruleType) continue;
      const v = rule.parameters?.[paramName];
      if (typeof v === "number" && v >= minVal) return true;
    }
  }
  return false;
}

function rulesetHasBypassActors(rulesets) {
  for (const rs of rulesets) {
    if (Array.isArray(rs.bypass_actors) && rs.bypass_actors.length > 0) return true;
  }
  return false;
}

function parseStatusCheckContexts(raw) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  for (const entry of raw) {
    if (typeof entry === "string") { result.push(entry); continue; }
    if (entry && typeof entry === "object" && typeof entry.context === "string") {
      if (entry.context.length > 0) { result.push(entry.context); continue; }
    }
    // null, non-string context, missing context, empty string → reject entire batch
    return [];
  }
  return result;
}

function statusChecksInclude(contexts, expected) {
  const names = parseStatusCheckContexts(contexts);
  if (names.length === 0) return false;
  const unique = [...new Set(names)];
  for (const exp of expected) {
    if (!unique.includes(exp)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Core check function (deterministic — no ambient env)
// ---------------------------------------------------------------------------

/**
 * @param {object} evidence
 * @param {object} policy
 * @param {object} ctx — { source: "live"|"offline", repository: string, branch: string }
 */
export function check(evidence, policy, ctx = {}) {
  const repository = ctx.repository || "redacted";
  const branch = ctx.branch || policy?.target_branch || "main";
  const isOffline = ctx.source === "offline";
  const isLive = ctx.source === "live";

  // Offline branch validation
  if (isOffline && evidence?.metadata?.branch) {
    if (evidence.metadata.branch !== branch) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: metadata.branch does not match policy.target_branch", repository, branch, _error: "branch-mismatch" };
    }
  }

  // Offline structural validation
  if (isOffline) {
    const cbp = evidence.classic_branch_protection;
    if (cbp !== null && cbp !== undefined && (typeof cbp !== "object" || Array.isArray(cbp))) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: malformed evidence — classic_branch_protection not an object", repository, branch, _error: "malformed-evidence" };
    }
    const rs = evidence.rulesets;
    if (rs !== null && rs !== undefined && !Array.isArray(rs)) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: malformed evidence — rulesets not an array", repository, branch, _error: "malformed-evidence" };
    }
    const er = evidence._errors;
    if (er !== null && er !== undefined && !Array.isArray(er)) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: malformed evidence — _errors not an array", repository, branch, _error: "malformed-evidence" };
    }
    // Validate classic_required_signatures shape if present
    const cs = evidence.classic_required_signatures;
    if (cs !== null && cs !== undefined && (typeof cs !== "object" || Array.isArray(cs))) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: malformed evidence — classic_required_signatures not an object", repository, branch, _error: "malformed-evidence" };
    }
  }

  const controls = {};
  const failed = [];

  // ANY _errors entry → fail closed (all controls NOT ENFORCED)
  const errs = evidence?._errors || [];
  if (errs.length > 0) {
    for (const ctrl of policy.controls) {
      controls[ctrl.id] = { enforced: false, source: "error" };
    }
    failed.push(...policy.controls.map(c => c.id));
    return {
      passed: false, controls, failed,
      summary: `FAILED: collection errors — all ${policy.controls.length} controls NOT ENFORCED`,
      repository, branch,
    };
  }

  const classic = evidence?.classic_branch_protection || null;
  const classicSigs = evidence?.classic_required_signatures || null;
  const knownDefaultBranch = evidence?.metadata?.default_branch || null;

  // Split rulesets: clean (no bypass) vs bypassed (has bypass_actors)
  const allRulesets = activeRulesetsForBranch(evidence, branch, knownDefaultBranch);
  const cleanRulesets = allRulesets.filter(rs => !(Array.isArray(rs.bypass_actors) && rs.bypass_actors.length > 0));
  const bypassedRulesets = allRulesets.filter(rs => Array.isArray(rs.bypass_actors) && rs.bypass_actors.length > 0);
  const hasAnyBypass = bypassedRulesets.length > 0;

  for (const ctrl of policy.controls) {
    let enforced = false;
    let source = null;

    // ---- Classic check ----
    if (ctrl.classic_check) {
      let val;
      if (ctrl.classic_separate_endpoint) {
        val = classicSigs ? get(classicSigs, "enabled") : undefined;
      } else {
        val = classic ? get(classic, ctrl.classic_field) : undefined;
      }

      switch (ctrl.classic_check) {
        case "exists": enforced = val !== undefined && val !== null; break;
        case "bool_true": enforced = val === true; break;
        case "bool_false": enforced = val === false; break;
        case "min_value": enforced = typeof val === "number" && val >= (ctrl.min_value || 0); break;
        case "status_checks_includes":
        case "status_checks":
          enforced = statusChecksInclude(val, ctrl.expected_checks || []); break;
      }
      if (enforced) source = "classic";
    }

    // ---- Ruleset check (clean rulesets only for non-admin) ----
    if (ctrl.ruleset_check && ctrl.ruleset_type && ctrl.id !== "admin_enforcement") {
      // For non-admin controls, only consider clean rulesets
      if (!enforced && cleanRulesets.length > 0) {
        switch (ctrl.ruleset_check) {
          case "rule_exists":
            if (anyRulesetRule(cleanRulesets, ctrl.ruleset_type)) { enforced = true; source = "ruleset"; }
            break;
          case "bool_true": {
            const v = rulesetRuleParamAny(cleanRulesets, ctrl.ruleset_type, ctrl.ruleset_param);
            if (v === true) { enforced = true; source = "ruleset"; }
            break;
          }
          case "min_value": {
            if (anyRulesetRuleMinValue(cleanRulesets, ctrl.ruleset_type, ctrl.ruleset_param, ctrl.min_value || 0)) {
              enforced = true; source = "ruleset";
            }
            break;
          }
          case "status_checks_includes":
          case "status_checks": {
            const raw = rulesetRuleParamAny(cleanRulesets, ctrl.ruleset_type, ctrl.ruleset_param);
            if (statusChecksInclude(raw, ctrl.expected_checks || [])) { enforced = true; source = "ruleset"; }
            break;
          }
        }
      }
      // If bypassed rulesets exist, they cannot establish enforcement
      // (they're bypassed — excluded from clean)
    }

    // ---- admin_enforcement: ANY bypass → fail ----
    if (ctrl.id === "admin_enforcement") {
      if (hasAnyBypass) {
        enforced = false;
        source = null; // override any classic pass
      } else if (!enforced && cleanRulesets.length > 0) {
        // No bypass actors → enforced via ruleset
        enforced = true;
        source = "ruleset";
      }
    }

    const result = { enforced };
    if (source) result.source = source;
    if (!enforced) failed.push(ctrl.id);
    controls[ctrl.id] = result;
  }

  const passed = failed.length === 0;
  const summary = passed
    ? `ALL ${policy.controls.length} controls ENFORCED`
    : `FAILED: ${failed.length} of ${policy.controls.length} controls NOT ENFORCED`;

  return { passed, controls, failed, summary, repository, branch };
}

// ---------------------------------------------------------------------------
// Redacted output
// ---------------------------------------------------------------------------

function redactedOutput(result) {
  return {
    repository: "redacted",
    branch: "redacted",
    passed: result.passed,
    controls: result.controls,
    failed_count: result.failed ? result.failed.length : 0,
    summary: result.summary,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const policy = await loadPolicy();
  const branch = policy.target_branch || "main";

  let evidence;
  let source;

  if (process.env.GITHUB_TOKEN) {
    source = "live";
    const repo = process.env.GITHUB_REPOSITORY || "";
    const [owner, repoName] = repo.split("/");
    if (!owner || !repoName) {
      process.stderr.write(JSON.stringify({ error: "missing-repository" }) + "\n");
      return 2;
    }
    try {
      evidence = await collectLive(process.env.GITHUB_TOKEN, owner, repoName, branch);
    } catch {
      process.stderr.write(JSON.stringify({ error: "unexpected-error" }) + "\n");
      return 1;
    }
  } else {
    source = "offline";
    const evidencePath = process.env.INFORMER_PATH || process.argv[2] || ".github/branch-governance-evidence.json";
    let raw;
    try { raw = await readFile(evidencePath, "utf8"); } catch {
      process.stderr.write(JSON.stringify({ error: "evidence-read-failed" }) + "\n");
      return 2;
    }
    try { evidence = JSON.parse(raw); } catch {
      process.stderr.write(JSON.stringify({ error: "malformed-evidence" }) + "\n");
      return 2;
    }
    if (!evidence || typeof evidence !== "object") {
      process.stderr.write(JSON.stringify({ error: "malformed-evidence" }) + "\n");
      return 2;
    }
  }

  const result = check(evidence, policy, { source, repository: "redacted", branch });

  if (result._error) {
    process.stderr.write(JSON.stringify({ error: result._error }) + "\n");
    return 2;
  }

  const output = redactedOutput(result);
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
const thisScript = fileURLToPath(import.meta.url);
if (process.argv[1] && (process.argv[1] === thisScript || process.argv[1].endsWith("check-branch-governance.mjs"))) {
  main().then((code) => process.exit(code)).catch(() => {
    process.stderr.write(JSON.stringify({ error: "unexpected-error" }) + "\n");
    process.exit(2);
  });
}
