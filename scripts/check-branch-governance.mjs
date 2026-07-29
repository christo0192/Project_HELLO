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

// Re-exported so tests can reference the exact expected origins
export const GITHUB_ORIGIN = "https://api.github.com";
const MAX_RULESET_PAGES = 3;
const RULESET_PER_PAGE = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;

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

/**
 * Validate that repoSlug has exactly two safe segments: "owner/repo".
 * No third segment, no leading/trailing slashes, no empty segments.
 */
function validateRepositorySlug(slug) {
  if (typeof slug !== "string") return false;
  const parts = slug.split("/");
  if (parts.length !== 2) return false;
  try {
    validateGitHubName(parts[0], "owner");
    validateGitHubName(parts[1], "repo");
    return true;
  } catch {
    return false;
  }
}

/**
 * Exact origin comparison. Parses the URL and checks `.origin`.
 * `expectedOrigin` must be a bare origin like "https://api.github.com".
 */
function urlOriginMatches(urlStr, expectedOrigin) {
  try {
    const u = new URL(urlStr);
    return u.origin === expectedOrigin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Live collector (GitHub API)
// ---------------------------------------------------------------------------

async function ghFetch(token, urlPath, opts = {}) {
  const fetcher = opts.fetch || globalThis.fetch;
  const apiOrigin = opts.baseUrl || GITHUB_ORIGIN;
  const timeoutMs = opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT_MS;
  const parentSignal = opts.signal || null;

  let url;
  if (urlPath.startsWith(apiOrigin)) {
    url = urlPath;
  } else if (urlPath.startsWith("http")) {
    // Foreign origin
    if (!urlOriginMatches(urlPath, apiOrigin)) return { _foreign_origin: true };
    url = urlPath;
  } else {
    url = `${apiOrigin}${urlPath}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("timeout", "AbortError")), timeoutMs);

  let cleanupParent;
  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timeout);
      return { _network_error: true };
    }
    const onAbort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", onAbort, { once: true });
    cleanupParent = () => parentSignal.removeEventListener("abort", onAbort);
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
    if (cleanupParent) cleanupParent();
    if (err.name === "AbortError") return { _network_error: true };
    return { _network_error: true };
  } finally {
    clearTimeout(timeout);
    if (cleanupParent) cleanupParent();
  }

  let text;
  try { text = await resp.text(); } catch { return { _malformed: true, _status: resp.status }; }

  let body;
  try { body = JSON.parse(text); } catch { return { _malformed: true, _status: resp.status }; }

  body._status = resp.status;
  return body;
}

async function ghFetchAll(token, urlPath, opts = {}) {
  const apiOrigin = opts.baseUrl || GITHUB_ORIGIN;
  const timeoutMs = opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT_MS;
  const parentSignal = opts.signal || null;

  const results = [];
  // Build initial URL: if path has query params, append per_page; otherwise add
  const separator = urlPath.includes("?") ? "&" : "?";
  let nextUrl = `${urlPath}${separator}per_page=${RULESET_PER_PAGE}`;
  let pages = 0;

  while (nextUrl && pages < MAX_RULESET_PAGES) {
    pages++;

    let url;
    if (nextUrl.startsWith("http")) {
      if (!urlOriginMatches(nextUrl, apiOrigin)) return { _foreign_origin: true };
      url = nextUrl;
    } else {
      url = `${apiOrigin}${nextUrl}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("timeout", "AbortError")), timeoutMs);

    let cleanupParent;
    if (parentSignal) {
      if (parentSignal.aborted) {
        clearTimeout(timeout);
        return { _network_error: true };
      }
      const onAbort = () => controller.abort(parentSignal.reason);
      parentSignal.addEventListener("abort", onAbort, { once: true });
      cleanupParent = () => parentSignal.removeEventListener("abort", onAbort);
    }

    let resp;
    try {
      resp = await globalThis.fetch(url, {
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
      if (cleanupParent) cleanupParent();
      return { _network_error: true };
    } finally {
      clearTimeout(timeout);
      if (cleanupParent) cleanupParent();
    }

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

/**
 * Validate that a 200 body is a non-null, non-array object.
 */
function validateObjectBody(body, label) {
  if (body === null || body === undefined) return `null-${label}`;
  if (Array.isArray(body)) return `array-${label}`;
  if (typeof body !== "object") return `non-object-${label}`;
  return null;
}

export async function collectLive(token, owner, repo, branch, opts = {}) {
  validateGitHubName(owner, "owner");
  validateGitHubName(repo, "repo");
  validateGitHubName(branch, "branch");

  const baseUrl = opts.baseUrl || GITHUB_ORIGIN;
  const timeout = opts.timeout;
  const fetcher = opts.fetch;
  const totalTimeoutMs = opts.totalTimeout != null ? opts.totalTimeout : DEFAULT_TOTAL_TIMEOUT_MS;

  const totalController = new AbortController();
  const totalTimeout = setTimeout(
    () => totalController.abort(new DOMException("total-timeout", "AbortError")),
    totalTimeoutMs
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

  const pushErr = (phase, status, extra) => {
    const e = { phase, status };
    if (extra) Object.assign(e, extra);
    evidence._errors.push(e);
  };

  try {
    // 0. Fetch repo metadata for default_branch
    const repoMeta = await ghFetch(token, `/repos/${owner}/${repo}`, dOpts);
    const repoMetaStatus = repoMeta._status;
    delete repoMeta._status;

    if (repoMeta._network_error || repoMeta._foreign_origin) {
      pushErr("repo_metadata", 0);
    } else if (repoMeta._malformed || repoMetaStatus !== 200) {
      pushErr("repo_metadata", repoMetaStatus || 0);
    } else {
      const bodyErr = validateObjectBody(repoMeta, "repo-meta");
      if (bodyErr) {
        pushErr("repo_metadata", 200, { reason: bodyErr });
      } else if (typeof repoMeta.default_branch !== "string" || repoMeta.default_branch.length === 0) {
        pushErr("repo_metadata", 200, { reason: "missing-default-branch" });
      } else {
        evidence.metadata.default_branch = repoMeta.default_branch;
      }
    }

    if (totalController.signal.aborted) throw totalController.signal.reason;

    // 1. Classic branch protection
    const classic = await ghFetch(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`, dOpts);
    const classicStatus = classic._status;
    delete classic._status;

    if (classic._network_error || classic._foreign_origin) {
      pushErr("classic", 0);
    } else if (classic._malformed) {
      pushErr("classic", classicStatus || 0);
    } else if (classicStatus === 404) {
      evidence.classic_branch_protection = null;
    } else if (classicStatus === 401 || classicStatus === 403) {
      pushErr("classic", classicStatus);
    } else if (classicStatus === 200) {
      const bodyErr = validateObjectBody(classic, "classic");
      if (bodyErr) {
        pushErr("classic", 200, { reason: bodyErr });
        evidence.classic_branch_protection = null;
      } else {
        evidence.classic_branch_protection = classic;
      }
    } else {
      pushErr("classic", classicStatus || 0);
    }

    if (totalController.signal.aborted) throw totalController.signal.reason;

    // 2. Classic required signatures
    const sigs = await ghFetch(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_signatures`, dOpts);
    const sigsStatus = sigs._status;
    delete sigs._status;

    if (sigs._network_error || sigs._foreign_origin) {
      pushErr("required_signatures", 0);
    } else if (sigs._malformed) {
      pushErr("required_signatures", sigsStatus || 0);
    } else if (sigsStatus === 200) {
      const bodyErr = validateObjectBody(sigs, "sigs");
      if (bodyErr) {
        pushErr("required_signatures", 200, { reason: bodyErr });
      } else {
        evidence.classic_required_signatures = sigs;
      }
    } else if (sigsStatus === 404) {
      evidence.classic_required_signatures = null;
    } else {
      pushErr("required_signatures", sigsStatus || 0);
    }

    if (totalController.signal.aborted) throw totalController.signal.reason;

    // 3. Rulesets list (paginated, with inherited)
    const rulesetList = await ghFetchAll(token, `/repos/${owner}/${repo}/rulesets?includes_parents=true`, dOpts);

    if (rulesetList._network_error || rulesetList._foreign_origin) {
      pushErr("rulesets_list", 0);
    } else if (rulesetList._malformed) {
      pushErr("rulesets_list", rulesetList._status || 0);
    } else if (Array.isArray(rulesetList)) {
      const truncated = rulesetList._pagination_truncated;
      delete rulesetList._pagination_truncated;
      if (truncated) {
        pushErr("rulesets_pagination", 0);
      }
      if (!totalController.signal.aborted) {
        // 4. Fetch each ruleset detail
        for (const rsSummary of rulesetList) {
          if (!rsSummary || typeof rsSummary !== "object") {
            pushErr("ruleset_detail", 0, { reason: "invalid-list-entry" });
            continue;
          }
          if (typeof rsSummary.id !== "number" || rsSummary.id < 1 || !Number.isFinite(rsSummary.id)) {
            pushErr("ruleset_detail", 0, { reason: "non-numeric-id" });
            continue;
          }

          let detailUrl;
          const selfHref = rsSummary._links?.self?.href;
          if (selfHref) {
            if (typeof selfHref !== "string" || (!urlOriginMatches(selfHref, baseUrl) && !selfHref.startsWith("/"))) {
              pushErr("ruleset_detail", 0, { ruleset_id: rsSummary.id, reason: "hostile-self-href" });
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
            pushErr("ruleset_detail", detail._network_error ? 0 : 0, { ruleset_id: rsSummary.id });
          } else if (detail._malformed) {
            pushErr("ruleset_detail", detailStatus || 0, { ruleset_id: rsSummary.id });
          } else if (detailStatus === 200) {
            const bodyErr = validateObjectBody(detail, "ruleset-detail");
            if (bodyErr) {
              pushErr("ruleset_detail", 200, { ruleset_id: rsSummary.id, reason: bodyErr });
            } else {
              evidence.rulesets.push(detail);
            }
          } else {
            pushErr("ruleset_detail", detailStatus || 0, { ruleset_id: rsSummary.id });
          }

          if (totalController.signal.aborted) break;
        }
      }
    }
  } finally {
    clearTimeout(totalTimeout);
    totalController.abort(new DOMException("cleanup", "AbortError"));
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
  if (pattern === `refs/heads/${targetBranch}`) return "match";
  if (pattern === "~ALL") return "match";
  if (pattern === "~DEFAULT_BRANCH") {
    if (knownDefaultBranch === targetBranch) return "match";
    if (knownDefaultBranch && knownDefaultBranch !== targetBranch) return "nomatch";
    return "unknown";
  }
  if (pattern === "refs/heads/*") return "match";
  if (pattern.startsWith("refs/heads/") && pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    if (`refs/heads/${targetBranch}`.startsWith(prefix)) return "match";
    return "nomatch";
  }
  if (pattern.startsWith("refs/") && !pattern.startsWith("refs/heads/")) return "nomatch";
  return "unknown";
}

function activeRulesetsForBranch(evidence, targetBranch, knownDefaultBranch) {
  if (!evidence || !Array.isArray(evidence.rulesets)) return [];
  return evidence.rulesets.filter((rs) => {
    if (!rs || typeof rs !== "object") return false;
    if (rs.enforcement !== "active") return false;
    if (rs.target !== "branch") return false;
    const cond = get(rs, "conditions.ref_name");
    if (!cond || typeof cond !== "object") return false;
    const include = Array.isArray(cond.include) ? cond.include : [];
    const exclude = Array.isArray(cond.exclude) ? cond.exclude : [];
    let hasMatch = false, hasUnknownInclude = false;
    for (const p of include) {
      const c = classifyRef(p, targetBranch, knownDefaultBranch);
      if (c === "match") hasMatch = true;
      if (c === "unknown") hasUnknownInclude = true;
    }
    if (!hasMatch || hasUnknownInclude) return false;
    for (const p of exclude) {
      const c = classifyRef(p, targetBranch, knownDefaultBranch);
      if (c === "match" || c === "unknown") return false;
    }
    return true;
  });
}

/**
 * Check if ANY rule across ALL rulesets matches ruleType AND predicate.
 * predicate receives the rule object. If predicate is absent, just checks type.
 */
function anyRulesetRule(rulesets, ruleType, predicate) {
  for (const rs of rulesets) {
    const rules = rs.rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (!rule || typeof rule !== "object") continue;
      if (rule.type !== ruleType) continue;
      if (!predicate) return true;
      if (predicate(rule)) return true;
    }
  }
  return false;
}

/** Predicate: rule.parameters[paramName] === true */
function paramBoolPredicate(paramName) {
  return (rule) => {
    const p = rule.parameters;
    return p && typeof p === "object" && p[paramName] === true;
  };
}

/** Predicate: rule.parameters[paramName] >= minVal */
function paramMinPredicate(paramName, minVal) {
  return (rule) => {
    const p = rule.parameters;
    const v = p && typeof p === "object" ? p[paramName] : undefined;
    return typeof v === "number" && v >= minVal;
  };
}

/** Predicate: rule.parameters[paramName] is an array that includes all expected checks */
function statusChecksPredicate(paramName, expected) {
  return (rule) => {
    const p = rule.parameters;
    if (!p || typeof p !== "object") return false;
    const raw = p[paramName];
    return statusChecksInclude(raw, expected);
  };
}

function rulesetHasBypassActors(rulesets) {
  for (const rs of rulesets) {
    if (!rs || typeof rs !== "object") continue;
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

export function check(evidence, policy, ctx = {}) {
  const repository = ctx.repository || "redacted";
  const branch = ctx.branch || policy?.target_branch || "main";
  const isOffline = ctx.source === "offline";

  // Offline structural validation: root shape
  if (isOffline) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: evidence not an object", repository, branch, _error: "malformed-evidence" };
    }

    // metadata required
    const meta = evidence.metadata;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: metadata missing or invalid", repository, branch, _error: "malformed-evidence" };
    }

    // metadata.branch must exactly match
    if (meta.branch !== branch) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: metadata.branch does not match policy.target_branch", repository, branch, _error: "branch-mismatch" };
    }

    // Validate metadata.default_branch shape if present
    if (meta.default_branch != null && typeof meta.default_branch !== "string") {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: metadata.default_branch not a string", repository, branch, _error: "malformed-evidence" };
    }

    // Validate classic_branch_protection
    const cbp = evidence.classic_branch_protection;
    if (cbp !== null && cbp !== undefined && (typeof cbp !== "object" || Array.isArray(cbp))) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: classic_branch_protection not an object", repository, branch, _error: "malformed-evidence" };
    }

    // Validate classic_required_signatures
    const cs = evidence.classic_required_signatures;
    if (cs !== null && cs !== undefined && (typeof cs !== "object" || Array.isArray(cs))) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: classic_required_signatures not an object", repository, branch, _error: "malformed-evidence" };
    }

    // Validate rulesets array
    const rs = evidence.rulesets;
    if (rs !== null && rs !== undefined && !Array.isArray(rs)) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: rulesets not an array", repository, branch, _error: "malformed-evidence" };
    }

    // Validate _errors array
    const er = evidence._errors;
    if (er !== null && er !== undefined && !Array.isArray(er)) {
      return { passed: false, controls: {}, failed: [], summary: "FAILED: _errors not an array", repository, branch, _error: "malformed-evidence" };
    }

    // Per-element validation: _errors entries
    if (Array.isArray(er)) {
      for (const e of er) {
        if (!e || typeof e !== "object" || typeof e.phase !== "string" || typeof e.status !== "number") {
          return { passed: false, controls: {}, failed: [], summary: "FAILED: malformed _errors entry", repository, branch, _error: "malformed-evidence" };
        }
      }
    }

    // Per-element validation: rulesets entries
    if (Array.isArray(rs)) {
      for (const r of rs) {
        if (!r || typeof r !== "object" || typeof r.id !== "number" || !Array.isArray(r.rules) || typeof r.enforcement !== "string") {
          return { passed: false, controls: {}, failed: [], summary: "FAILED: malformed ruleset entry", repository, branch, _error: "malformed-evidence" };
        }
      }
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

  // Split rulesets: clean vs bypassed
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

    // ---- Ruleset check (clean rulesets only) ----
    if (ctrl.ruleset_check && ctrl.ruleset_type && ctrl.id !== "admin_enforcement") {
      if (!enforced && cleanRulesets.length > 0) {
        switch (ctrl.ruleset_check) {
          case "rule_exists":
            if (anyRulesetRule(cleanRulesets, ctrl.ruleset_type)) { enforced = true; source = "ruleset"; }
            break;
          case "bool_true": {
            if (anyRulesetRule(cleanRulesets, ctrl.ruleset_type, paramBoolPredicate(ctrl.ruleset_param))) {
              enforced = true; source = "ruleset";
            }
            break;
          }
          case "min_value": {
            if (anyRulesetRule(cleanRulesets, ctrl.ruleset_type, paramMinPredicate(ctrl.ruleset_param, ctrl.min_value || 0))) {
              enforced = true; source = "ruleset";
            }
            break;
          }
          case "status_checks_includes":
          case "status_checks": {
            if (anyRulesetRule(cleanRulesets, ctrl.ruleset_type, statusChecksPredicate(ctrl.ruleset_param, ctrl.expected_checks || []))) {
              enforced = true; source = "ruleset";
            }
            break;
          }
        }
      }
    }

    // ---- admin_enforcement: ANY bypass → fail ----
    if (ctrl.id === "admin_enforcement") {
      if (hasAnyBypass) {
        enforced = false;
        source = null;
      } else if (!enforced && cleanRulesets.length > 0) {
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

/**
 * Exported for test injection.
 * @param {object} opts — { token?, repository?, evidencePath?, injectCollectLive? }
 */
export async function main(opts = {}) {
  const policy = await loadPolicy();
  const branch = policy.target_branch || "main";

  let evidence;
  let source;

  const token = opts.token ?? process.env.GITHUB_TOKEN;
  const repository = opts.repository ?? process.env.GITHUB_REPOSITORY ?? "";

  if (token) {
    source = "live";
    if (!validateRepositorySlug(repository)) {
      process.stderr.write(JSON.stringify({ error: "invalid-repository-format" }) + "\n");
      return 2;
    }
    const [owner, repoName] = repository.split("/");
    const collectFn = opts.injectCollectLive || collectLive;
    try {
      evidence = await collectFn(token, owner, repoName, branch);
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
