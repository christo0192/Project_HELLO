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
  if (typeof name !== "string" || name.length === 0) throw new Error(`invalid-${label}`);
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error(`invalid-${label}`);
}

function validateRepositorySlug(slug) {
  if (typeof slug !== "string") return false;
  const parts = slug.split("/");
  if (parts.length !== 2) return false;
  try { validateGitHubName(parts[0], "owner"); validateGitHubName(parts[1], "repo"); return true; }
  catch { return false; }
}

/**
 * Exact origin comparison via URL parsing. All absolute URLs must pass this;
 * no string-prefix trust path exists elsewhere.
 */
function urlOriginMatches(urlStr, expectedOrigin) {
  try { return new URL(urlStr).origin === expectedOrigin; }
  catch { return false; }
}

/**
 * Resolve a possibly-relative URL to absolute. If already absolute, validate
 * origin exactly. If relative, prepend apiOrigin.
 */
function resolveUrl(urlPath, apiOrigin) {
  if (urlPath.startsWith("http://") || urlPath.startsWith("https://")) {
    if (!urlOriginMatches(urlPath, apiOrigin)) return { _foreign_origin: true };
    return urlPath;
  }
  return `${apiOrigin}${urlPath}`;
}

// ---------------------------------------------------------------------------
// Live collector (GitHub API)
// ---------------------------------------------------------------------------

async function ghFetch(token, urlPath, opts = {}) {
  const fetcher = opts.fetch || globalThis.fetch;
  const apiOrigin = opts.baseUrl || GITHUB_ORIGIN;
  const timeoutMs = opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT_MS;
  const parentSignal = opts.signal || null;

  const resolved = resolveUrl(urlPath, apiOrigin);
  if (typeof resolved !== "string") return resolved; // _foreign_origin
  const url = resolved;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("timeout", "AbortError")), timeoutMs);

  let cleanupParent;
  if (parentSignal) {
    if (parentSignal.aborted) { clearTimeout(timeout); return { _network_error: true }; }
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
    clearTimeout(timeout); if (cleanupParent) cleanupParent();
    if (err.name === "AbortError") return { _network_error: true };
    return { _network_error: true };
  } finally {
    clearTimeout(timeout); if (cleanupParent) cleanupParent();
  }

  let text;
  try { text = await resp.text(); } catch { return { _malformed: true, _status: resp.status }; }

  let body;
  try { body = JSON.parse(text); } catch { return { _malformed: true, _status: resp.status }; }

  // Attach status only if body is a non-null, non-array object.
  // Otherwise return malformed with a reason.
  if (body && typeof body === "object" && !Array.isArray(body)) {
    body._status = resp.status;
    return body;
  }
  const reason = body === null ? "null-parsed-body" : Array.isArray(body) ? "array-parsed-body" : "non-object-parsed-body";
  return { _malformed: true, _status: resp.status, _reason: reason };
}

async function ghFetchAll(token, urlPath, opts = {}) {
  const fetcher = opts.fetch || globalThis.fetch;
  const apiOrigin = opts.baseUrl || GITHUB_ORIGIN;
  const timeoutMs = opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT_MS;
  const parentSignal = opts.signal || null;

  const results = [];
  const separator = urlPath.includes("?") ? "&" : "?";
  let nextUrl = `${urlPath}${separator}per_page=${RULESET_PER_PAGE}`;
  let pages = 0;

  while (nextUrl && pages < MAX_RULESET_PAGES) {
    pages++;

    const resolved = resolveUrl(nextUrl, apiOrigin);
    if (typeof resolved !== "string") return { _foreign_origin: true };
    const url = resolved;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("timeout", "AbortError")), timeoutMs);

    let cleanupParent;
    if (parentSignal) {
      if (parentSignal.aborted) { clearTimeout(timeout); return { _network_error: true }; }
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
      clearTimeout(timeout); if (cleanupParent) cleanupParent();
      return { _network_error: true };
    } finally {
      clearTimeout(timeout); if (cleanupParent) cleanupParent();
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
    } else { nextUrl = null; }
  }

  if (pages >= MAX_RULESET_PAGES && nextUrl) results._pagination_truncated = true;
  return results;
}

function validateObjectBody(body, label) {
  if (body === null || body === undefined) return `null-${label}`;
  if (Array.isArray(body)) return `array-${label}`;
  if (typeof body !== "object") return `non-object-${label}`;
  return null;
}

function validateClassicProtectionShape(classic) {
  const review = classic.required_pull_request_reviews;
  if (review != null) {
    if (typeof review !== "object" || Array.isArray(review)) return "invalid-pull-request-reviews";
    for (const key of ["require_code_owner_reviews", "dismiss_stale_reviews", "require_last_push_approval"]) {
      if (review[key] !== undefined && typeof review[key] !== "boolean") return `invalid-${key}`;
    }
    const count = review.required_approving_review_count;
    if (count !== undefined && (!Number.isInteger(count) || count < 0)) return "invalid-approval-count";
  }

  for (const key of ["required_conversation_resolution", "enforce_admins", "required_linear_history", "allow_force_pushes", "allow_deletions"]) {
    const control = classic[key];
    if (control == null) continue;
    if (typeof control !== "object" || Array.isArray(control) || typeof control.enabled !== "boolean") return `invalid-${key}`;
  }

  const checks = classic.required_status_checks;
  if (checks != null) {
    if (typeof checks !== "object" || Array.isArray(checks)) return "invalid-required-status-checks";
    if (checks.contexts !== undefined && (!Array.isArray(checks.contexts) || checks.contexts.some(context => typeof context !== "string"))) {
      return "invalid-status-check-contexts";
    }
  }
  return null;
}

function validateSignaturesShape(signatures) {
  return typeof signatures.enabled === "boolean" ? null : "invalid-signatures-enabled";
}

/** Validate a complete ruleset detail without rejecting legitimate tag/push rulesets. */
function validateRulesetDetailShape(detail) {
  if (typeof detail.id !== "number" || !Number.isFinite(detail.id) || detail.id < 1) return "invalid-id";
  if (!["active", "evaluate", "disabled"].includes(detail.enforcement)) return "invalid-enforcement";
  if (!["branch", "tag", "push"].includes(detail.target)) return "invalid-target";
  if (!Array.isArray(detail.bypass_actors)) return "invalid-bypass_actors";
  if (!Array.isArray(detail.rules)) return "invalid-rules-array";

  if (detail.target === "branch" || detail.target === "tag") {
    const refName = detail.conditions?.ref_name;
    if (!refName || typeof refName !== "object" || Array.isArray(refName)) return "invalid-conditions-ref-name";
    if (!Array.isArray(refName.include)) return "invalid-conditions-include";
    if (!Array.isArray(refName.exclude)) return "invalid-conditions-exclude";
    if (refName.include.some(value => typeof value !== "string")) return "invalid-conditions-include-element";
    if (refName.exclude.some(value => typeof value !== "string")) return "invalid-conditions-exclude-element";
  }

  for (const rule of detail.rules) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return "invalid-rule-entry";
    if (typeof rule.type !== "string") return "invalid-rule-type";
    if (rule.parameters !== undefined && (typeof rule.parameters !== "object" || rule.parameters === null || Array.isArray(rule.parameters))) {
      return "invalid-rule-parameters";
    }
  }
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
    metadata: { repository: `${owner}/${repo}`, branch, fetched_at: new Date().toISOString(), default_branch: null },
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
    // 0. Repo metadata
    const repoMeta = await ghFetch(token, `/repos/${owner}/${repo}`, dOpts);
    const repoMetaStatus = repoMeta._status;
    delete repoMeta._status;

    if (repoMeta._network_error || repoMeta._foreign_origin) { pushErr("repo_metadata", 0); }
    else if (repoMeta._malformed || repoMetaStatus !== 200) { pushErr("repo_metadata", repoMetaStatus || 0, repoMeta._reason ? { reason: repoMeta._reason } : undefined); }
    else {
      const bodyErr = validateObjectBody(repoMeta, "repo-meta");
      if (bodyErr) { pushErr("repo_metadata", 200, { reason: bodyErr }); }
      else if (typeof repoMeta.default_branch !== "string" || repoMeta.default_branch.length === 0) { pushErr("repo_metadata", 200, { reason: "missing-default-branch" }); }
      else { evidence.metadata.default_branch = repoMeta.default_branch; }
    }
    // Proceed — errors already recorded

    // 1. Classic
    const classic = await ghFetch(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`, dOpts);
    const classicStatus = classic._status;
    delete classic._status;

    if (classic._network_error || classic._foreign_origin) { pushErr("classic", 0); }
    else if (classic._malformed) { pushErr("classic", classicStatus || 0, classic._reason ? { reason: classic._reason } : undefined); }
    else if (classicStatus === 404) { evidence.classic_branch_protection = null; }
    else if (classicStatus === 401 || classicStatus === 403) { pushErr("classic", classicStatus); }
    else if (classicStatus === 200) {
      const bodyErr = validateObjectBody(classic, "classic") || validateClassicProtectionShape(classic);
      if (bodyErr) { pushErr("classic", 200, { reason: bodyErr }); evidence.classic_branch_protection = null; }
      else { evidence.classic_branch_protection = classic; }
    } else { pushErr("classic", classicStatus || 0); }
    // Proceed — errors already recorded

    // 2. Signatures
    const sigs = await ghFetch(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_signatures`, dOpts);
    const sigsStatus = sigs._status;
    delete sigs._status;

    if (sigs._network_error || sigs._foreign_origin) { pushErr("required_signatures", 0); }
    else if (sigs._malformed) { pushErr("required_signatures", sigsStatus || 0, sigs._reason ? { reason: sigs._reason } : undefined); }
    else if (sigsStatus === 200) {
      const bodyErr = validateObjectBody(sigs, "sigs") || validateSignaturesShape(sigs);
      if (bodyErr) { pushErr("required_signatures", 200, { reason: bodyErr }); }
      else { evidence.classic_required_signatures = sigs; }
    } else if (sigsStatus === 404) { evidence.classic_required_signatures = null; }
    else { pushErr("required_signatures", sigsStatus || 0); }
    // Proceed — errors already recorded

    // 3. Rulesets list
    const rulesetList = await ghFetchAll(token, `/repos/${owner}/${repo}/rulesets?includes_parents=true`, dOpts);

    if (rulesetList._network_error || rulesetList._foreign_origin) { pushErr("rulesets_list", 0); }
    else if (rulesetList._malformed) { pushErr("rulesets_list", rulesetList._status || 0); }
    else if (Array.isArray(rulesetList)) {
      const truncated = rulesetList._pagination_truncated;
      delete rulesetList._pagination_truncated;
      if (truncated) pushErr("rulesets_pagination", 0);
      if (!totalController.signal.aborted) {
        for (const rsSummary of rulesetList) {
          if (!rsSummary || typeof rsSummary !== "object") { pushErr("ruleset_detail", 0, { reason: "invalid-list-entry" }); continue; }
          if (typeof rsSummary.id !== "number" || rsSummary.id < 1 || !Number.isFinite(rsSummary.id)) { pushErr("ruleset_detail", 0, { reason: "non-numeric-id" }); continue; }

          let detailUrl;
          const selfHref = rsSummary._links?.self?.href;
          if (selfHref) {
            if (typeof selfHref !== "string" || (!urlOriginMatches(selfHref, baseUrl) && !selfHref.startsWith("/"))) {
              pushErr("ruleset_detail", 0, { ruleset_id: rsSummary.id, reason: "hostile-self-href" }); continue;
            }
            detailUrl = selfHref;
          } else { detailUrl = `/repos/${owner}/${repo}/rulesets/${rsSummary.id}`; }

          const detail = await ghFetch(token, detailUrl, dOpts);
          const detailStatus = detail._status;
          delete detail._status;

          if (detail._network_error || detail._foreign_origin) { pushErr("ruleset_detail", 0, { ruleset_id: rsSummary.id }); }
          else if (detail._malformed) { pushErr("ruleset_detail", detailStatus || 0, { ...(detail._reason ? { reason: detail._reason } : {}), ruleset_id: rsSummary.id }); }
          else if (detailStatus === 200) {
            const bodyErr = validateObjectBody(detail, "ruleset-detail");
            if (bodyErr) { pushErr("ruleset_detail", 200, { ruleset_id: rsSummary.id, reason: bodyErr }); }
            else {
              const shapeErr = validateRulesetDetailShape(detail);
              if (shapeErr) { pushErr("ruleset_detail", 200, { ruleset_id: rsSummary.id, reason: shapeErr }); }
              else { evidence.rulesets.push(detail); }
            }
          } else { pushErr("ruleset_detail", detailStatus || 0, { ruleset_id: rsSummary.id }); }

          if (totalController.signal.aborted) continue;
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

function paramBoolPredicate(paramName) {
  return (rule) => { const p = rule.parameters; return p && typeof p === "object" && p[paramName] === true; };
}
function paramMinPredicate(paramName, minVal) {
  return (rule) => { const p = rule.parameters; const v = p && typeof p === "object" ? p[paramName] : undefined; return typeof v === "number" && v >= minVal; };
}
function statusChecksPredicate(paramName, expected) {
  return (rule) => { const p = rule.parameters; if (!p || typeof p !== "object") return false; return statusChecksInclude(p[paramName], expected); };
}

function rulesetHasBypassActors(rulesets) {
  for (const rs of rulesets) {
    if (!rs || typeof rs !== "object") continue;
    // Must be an actual array — string "not-an-array" is ignored (not a bypass)
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
  for (const exp of expected) if (!unique.includes(exp)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Core check function
// ---------------------------------------------------------------------------

/**
 * Validate a ruleset entry shape for offline evidence.
 * Returns null if ok, else error reason. Conservative: absent fields where
 * the code handles defaults are not errors.
 */
function validateOfflineRulesetEntry(r) {
  return validateRulesetDetailShape(r);
}

export function check(evidence, policy, ctx = {}) {
  const repository = ctx.repository || "redacted";
  const branch = ctx.branch || policy?.target_branch || "main";
  const isOffline = ctx.source === "offline";

  if (isOffline) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
      return { passed: false, controls: {}, failed: [], summary: "FAILED: evidence not an object", repository, branch, _error: "malformed-evidence" };

    const meta = evidence.metadata;
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
      return { passed: false, controls: {}, failed: [], summary: "FAILED: metadata missing or invalid", repository, branch, _error: "malformed-evidence" };
    if (meta.branch !== branch)
      return { passed: false, controls: {}, failed: [], summary: "FAILED: metadata.branch does not match policy.target_branch", repository, branch, _error: "branch-mismatch" };
    if (typeof meta.default_branch !== "string" || meta.default_branch.length === 0)
      return { passed: false, controls: {}, failed: [], summary: "FAILED: metadata.default_branch missing or invalid", repository, branch, _error: "malformed-evidence" };

    if (!Array.isArray(evidence.rulesets) || !Array.isArray(evidence._errors))
      return { passed: false, controls: {}, failed: [], summary: "FAILED: required evidence arrays missing", repository, branch, _error: "malformed-evidence" };

    const cbp = evidence.classic_branch_protection;
    if (cbp !== null && cbp !== undefined && (typeof cbp !== "object" || Array.isArray(cbp)))
      return { passed: false, controls: {}, failed: [], summary: "FAILED: classic_branch_protection not an object", repository, branch, _error: "malformed-evidence" };
    if (cbp && validateClassicProtectionShape(cbp))
      return { passed: false, controls: {}, failed: [], summary: "FAILED: malformed classic protection", repository, branch, _error: "malformed-evidence" };

    const cs = evidence.classic_required_signatures;
    if (cs !== null && cs !== undefined && (typeof cs !== "object" || Array.isArray(cs)))
      return { passed: false, controls: {}, failed: [], summary: "FAILED: classic_required_signatures not an object", repository, branch, _error: "malformed-evidence" };
    if (cs && validateSignaturesShape(cs))
      return { passed: false, controls: {}, failed: [], summary: "FAILED: malformed required signatures", repository, branch, _error: "malformed-evidence" };

    const rs = evidence.rulesets;
    if (rs !== null && rs !== undefined && !Array.isArray(rs))
      return { passed: false, controls: {}, failed: [], summary: "FAILED: rulesets not an array", repository, branch, _error: "malformed-evidence" };

    const er = evidence._errors;
    if (er !== null && er !== undefined && !Array.isArray(er))
      return { passed: false, controls: {}, failed: [], summary: "FAILED: _errors not an array", repository, branch, _error: "malformed-evidence" };

    if (Array.isArray(er)) {
      for (const e of er) {
        if (!e || typeof e !== "object" || typeof e.phase !== "string" || typeof e.status !== "number")
          return { passed: false, controls: {}, failed: [], summary: "FAILED: malformed _errors entry", repository, branch, _error: "malformed-evidence" };
      }
    }

    if (Array.isArray(rs)) {
      for (const r of rs) {
        const shapeErr = validateOfflineRulesetEntry(r);
        if (shapeErr)
          return { passed: false, controls: {}, failed: [], summary: "FAILED: malformed ruleset entry", repository, branch, _error: "malformed-evidence" };
      }
    }
  }

  const controls = {};
  const failed = [];

  const errs = evidence?._errors || [];
  if (errs.length > 0) {
    for (const ctrl of policy.controls) controls[ctrl.id] = { enforced: false, source: "error" };
    failed.push(...policy.controls.map(c => c.id));
    return { passed: false, controls, failed, summary: `FAILED: collection errors — all ${policy.controls.length} controls NOT ENFORCED`, repository, branch };
  }

  const classic = evidence?.classic_branch_protection || null;
  const classicSigs = evidence?.classic_required_signatures || null;
  const knownDefaultBranch = evidence?.metadata?.default_branch || null;

  const allRulesets = activeRulesetsForBranch(evidence, branch, knownDefaultBranch);
  const cleanRulesets = allRulesets.filter(rs => !(Array.isArray(rs.bypass_actors) && rs.bypass_actors.length > 0));
  const bypassedRulesets = allRulesets.filter(rs => Array.isArray(rs.bypass_actors) && rs.bypass_actors.length > 0);
  const hasAnyBypass = bypassedRulesets.length > 0;

  for (const ctrl of policy.controls) {
    let enforced = false;
    let source = null;

    if (ctrl.classic_check) {
      let val;
      if (ctrl.classic_separate_endpoint) val = classicSigs ? get(classicSigs, "enabled") : undefined;
      else val = classic ? get(classic, ctrl.classic_field) : undefined;

      switch (ctrl.classic_check) {
        case "exists": enforced = val !== undefined && val !== null; break;
        case "bool_true": enforced = val === true; break;
        case "bool_false": enforced = val === false; break;
        case "min_value": enforced = typeof val === "number" && val >= (ctrl.min_value || 0); break;
        case "status_checks_includes":
        case "status_checks": enforced = statusChecksInclude(val, ctrl.expected_checks || []); break;
      }
      if (enforced) source = "classic";
    }

    if (ctrl.ruleset_check && ctrl.ruleset_type && ctrl.id !== "admin_enforcement") {
      if (!enforced && cleanRulesets.length > 0) {
        switch (ctrl.ruleset_check) {
          case "rule_exists":
            if (anyRulesetRule(cleanRulesets, ctrl.ruleset_type)) { enforced = true; source = "ruleset"; } break;
          case "bool_true":
            if (anyRulesetRule(cleanRulesets, ctrl.ruleset_type, paramBoolPredicate(ctrl.ruleset_param))) { enforced = true; source = "ruleset"; } break;
          case "min_value":
            if (anyRulesetRule(cleanRulesets, ctrl.ruleset_type, paramMinPredicate(ctrl.ruleset_param, ctrl.min_value || 0))) { enforced = true; source = "ruleset"; } break;
          case "status_checks_includes":
          case "status_checks":
            if (anyRulesetRule(cleanRulesets, ctrl.ruleset_type, statusChecksPredicate(ctrl.ruleset_param, ctrl.expected_checks || []))) { enforced = true; source = "ruleset"; } break;
        }
      }
    }

    if (ctrl.id === "admin_enforcement") {
      if (hasAnyBypass) { enforced = false; source = null; }
      else if (!enforced && cleanRulesets.length > 0) { enforced = true; source = "ruleset"; }
    }

    const result = { enforced };
    if (source) result.source = source;
    if (!enforced) failed.push(ctrl.id);
    controls[ctrl.id] = result;
  }

  const passed = failed.length === 0;
  const summary = passed ? `ALL ${policy.controls.length} controls ENFORCED` : `FAILED: ${failed.length} of ${policy.controls.length} controls NOT ENFORCED`;
  return { passed, controls, failed, summary, repository, branch };
}

// ---------------------------------------------------------------------------
// Redacted output
// ---------------------------------------------------------------------------

function redactedOutput(result) {
  return {
    repository: "redacted", branch: "redacted",
    passed: result.passed,
    controls: result.controls,
    failed_count: result.failed ? result.failed.length : 0,
    summary: result.summary,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(opts = {}) {
  const policy = await loadPolicy();
  const branch = policy.target_branch || "main";

  let evidence, source;

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
    const evidencePath = opts.evidencePath || process.env.INFORMER_PATH || process.argv[2] || ".github/branch-governance-evidence.json";
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
  if (result.passed) { process.stdout.write(json + "\n"); return 0; }
  else { process.stderr.write(json + "\n"); return 1; }
}

// Run if called directly
const thisScript = fileURLToPath(import.meta.url);
if (process.argv[1] && (process.argv[1] === thisScript || process.argv[1].endsWith("check-branch-governance.mjs"))) {
  main().then((code) => process.exit(code)).catch(() => {
    process.stderr.write(JSON.stringify({ error: "unexpected-error" }) + "\n");
    process.exit(2);
  });
}
