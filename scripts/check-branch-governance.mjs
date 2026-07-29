#!/usr/bin/env node

/**
 * check-branch-governance.mjs — Zero-dependency branch governance verifier.
 *
 * Two modes:
 *   LIVE:   GITHUB_TOKEN env var set → read-only GitHub API collection
 *   OFFLINE: INFORMER_PATH env or CLI arg → local evidence JSON file
 *
 * Policy is loaded from .github/branch-governance-policy.json at runtime.
 * Raw API responses go only to memory (or RUNNER_TEMP mode 0600 in CI).
 * Output is a fixed-schema redacted JSON summary. Never prints tokens,
 * Authorization headers, raw API bodies, error messages, or file paths.
 *
 * Exit codes:
 *   0 — all controls ENFORCED
 *   1 — one or more controls NOT ENFORCED (fail-closed)
 *   2 — input malformed, file not found, or parse error
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
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

/** Validate that a name (owner, repo, branch) matches safe pattern */
function validateGitHubName(name, label) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`invalid-${label}: empty`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`invalid-${label}: contains unsafe characters`);
  }
}

/**
 * Build URL safely. If urlOrPath starts with GITHUB_API, use it as-is.
 * If it starts with http but not GITHUB_API, reject (foreign origin).
 * Otherwise, prefix with GITHUB_API.
 */
function buildGithubUrl(urlOrPath) {
  if (urlOrPath.startsWith(GITHUB_API)) {
    // Already absolute and same-origin — use directly
    return urlOrPath;
  }
  if (urlOrPath.startsWith("http")) {
    // Foreign origin — reject
    throw new Error("foreign-origin-url");
  }
  return `${GITHUB_API}${urlOrPath}`;
}

// ---------------------------------------------------------------------------
// Live collector (GitHub API)
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";
const MAX_RULESET_PAGES = 3;
const RULESET_PER_PAGE = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const TOTAL_COLLECTION_TIMEOUT_MS = 60_000;

/**
 * Fetch one GitHub API endpoint with timeout.
 * @param {string} token
 * @param {string} urlPath - path like /repos/owner/repo/branches/main/protection
 *                            OR absolute URL like https://api.github.com/repos/...
 * @param {object} [opts] - { fetch, baseUrl, timeout, signal }
 * @returns {Promise<object>}
 */
async function ghFetch(token, urlPath, opts = {}) {
  const fetcher = opts.fetch || globalThis.fetch;
  const baseUrl = opts.baseUrl || GITHUB_API;
  const timeoutMs = opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT_MS;
  const parentSignal = opts.signal || null;

  let url;
  if (urlPath.startsWith(baseUrl)) {
    url = urlPath;
  } else if (urlPath.startsWith("http")) {
    if (!urlPath.startsWith(GITHUB_API)) {
      return { _foreign_origin: true, _url: urlPath };
    }
    url = urlPath;
  } else {
    url = `${baseUrl}${urlPath}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("fetch-timeout")), timeoutMs);

  // Link parent signal if provided
  if (parentSignal) {
    const onParentAbort = () => {
      controller.abort(parentSignal.reason);
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    // Clean up listener if we resolve before parent abort
    const origFinally = controller.signal;
    // We handle cleanup on our side
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
    if (parentSignal) {
      // We can't easily remove the listener, but we stopped the timeout
    }
    if (err.name === "AbortError") {
      return { _network_error: true, _reason: "timeout" };
    }
    return { _network_error: true };
  }

  clearTimeout(timeout);

  // Read body as text first for safety
  let text;
  try {
    text = await resp.text();
  } catch {
    return { _malformed: true, _status: resp.status };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { _malformed: true, _status: resp.status, _raw: text };
  }

  // Attach status for error checks
  body._status = resp.status;
  return body;
}

async function ghFetchAll(token, urlPath, opts = {}) {
  const fetcher = opts.fetch || globalThis.fetch;
  const baseUrl = opts.baseUrl || GITHUB_API;
  const timeoutMs = opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT_MS;
  const parentSignal = opts.signal || null;

  const results = [];
  // Ensure pagination param
  let nextUrl = urlPath.includes("?") ? urlPath : `${urlPath}?per_page=${RULESET_PER_PAGE}`;
  let pages = 0;

  while (nextUrl && pages < MAX_RULESET_PAGES) {
    pages++;

    const url = nextUrl.startsWith("http")
      ? (nextUrl.startsWith(GITHUB_API) ? nextUrl : (() => { throw new Error("foreign-pagination-url"); })())
      : `${baseUrl}${nextUrl}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("fetch-timeout")), timeoutMs);

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
      return { _network_error: true };
    }

    clearTimeout(timeout);

    let text;
    try {
      text = await resp.text();
    } catch {
      return { _malformed: true, _status: resp.status };
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { _malformed: true, _status: resp.status, _raw: text };
    }

    if (!Array.isArray(body)) {
      // Paginated endpoint returned non-array → malformed
      body._status = resp.status;
      return { _malformed: true, _status: resp.status };
    }

    results.push(...body);

    // Parse Link header for next page
    const link = resp.headers.get("link");
    if (link) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = match ? match[1] : null;
    } else {
      nextUrl = null;
    }
  }

  if (pages >= MAX_RULESET_PAGES && nextUrl) {
    // More pages exist but we stopped — pagination ambiguity
    results._pagination_truncated = true;
  }

  return results;
}

/**
 * Resolve ~DEFAULT_BRANCH by fetching the repository.
 * Returns the default_branch name, or null if fetch fails.
 */
async function resolveDefaultBranch(token, owner, repo, opts = {}) {
  const baseUrl = opts.baseUrl || GITHUB_API;
  const timeoutMs = opts.timeout != null ? opts.timeout : DEFAULT_TIMEOUT_MS;
  const fetcher = opts.fetch || globalThis.fetch;

  const url = `${baseUrl}/repos/${owner}/${repo}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("fetch-timeout")), timeoutMs);

  try {
    const resp = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "fnd01-branch-governance-verifier/1.0",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (resp.status !== 200) return null;
    const data = await resp.json();
    return data.default_branch || null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * Collect live evidence from GitHub API.
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {object} [opts] - { fetch, baseUrl, timeout }
 * @returns {Promise<object>} evidence
 */
export async function collectLive(token, owner, repo, branch, opts = {}) {
  // Validate inputs
  validateGitHubName(owner, "owner");
  validateGitHubName(repo, "repo");
  validateGitHubName(branch, "branch");

  const baseUrl = opts.baseUrl || GITHUB_API;
  const timeout = opts.timeout;
  const fetcher = opts.fetch;

  // Create a top-level AbortController to bound total collection
  const totalController = new AbortController();
  const totalTimeout = setTimeout(
    () => totalController.abort(new Error("total-collection-timeout")),
    TOTAL_COLLECTION_TIMEOUT_MS
  );

  const downstreamOpts = { fetch: fetcher, baseUrl, timeout, signal: totalController.signal };

  const evidence = {
    metadata: {
      repository: `${owner}/${repo}`,
      branch,
      fetched_at: new Date().toISOString(),
    },
    classic_branch_protection: null,
    classic_required_signatures: null,
    rulesets: [],
    _errors: [],
  };

  try {
    // 1. Classic branch protection
    const classic = await ghFetch(
      token,
      `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`,
      downstreamOpts
    );

    const classicStatus = classic._status;
    delete classic._status;

    if (classic._network_error) {
      evidence._errors.push({ phase: "classic", status: 0 });
      evidence.classic_branch_protection = null;
    } else if (classic._malformed) {
      evidence._errors.push({ phase: "classic", status: classicStatus || 0 });
      evidence.classic_branch_protection = null;
    } else if (classic._foreign_origin) {
      evidence._errors.push({ phase: "classic", status: 0 });
      evidence.classic_branch_protection = null;
    } else if (classicStatus === 404) {
      // No protection configured — not an error, just absent
      evidence.classic_branch_protection = null;
    } else if (classicStatus === 401 || classicStatus === 403) {
      evidence._errors.push({ phase: "classic", status: classicStatus });
      evidence.classic_branch_protection = null;
    } else if (classicStatus === 200) {
      evidence.classic_branch_protection = classic;
    } else {
      evidence._errors.push({ phase: "classic", status: classicStatus || 0 });
      evidence.classic_branch_protection = null;
    }

    if (totalController.signal.aborted) throw totalController.signal.reason;

    // 2. Classic required signatures (separate endpoint)
    const sigs = await ghFetch(
      token,
      `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_signatures`,
      downstreamOpts
    );

    const sigsStatus = sigs._status;
    delete sigs._status;

    if (sigs._network_error) {
      evidence._errors.push({ phase: "required_signatures", status: 0 });
      evidence.classic_required_signatures = null;
    } else if (sigs._malformed) {
      evidence._errors.push({ phase: "required_signatures", status: sigsStatus || 0 });
      evidence.classic_required_signatures = null;
    } else if (sigs._foreign_origin) {
      evidence._errors.push({ phase: "required_signatures", status: 0 });
      evidence.classic_required_signatures = null;
    } else if (sigsStatus === 200) {
      evidence.classic_required_signatures = sigs;
    } else if (sigsStatus === 404) {
      evidence.classic_required_signatures = null;
    } else {
      evidence._errors.push({ phase: "required_signatures", status: sigsStatus || 0 });
      evidence.classic_required_signatures = null;
    }

    if (totalController.signal.aborted) throw totalController.signal.reason;

    // 3. Rulesets list (paginated)
    const rulesetList = await ghFetchAll(
      token,
      `/repos/${owner}/${repo}/rulesets`,
      downstreamOpts
    );

    if (rulesetList._network_error) {
      evidence._errors.push({ phase: "rulesets_list", status: 0 });
    } else if (rulesetList._malformed) {
      evidence._errors.push({ phase: "rulesets_list", status: rulesetList._status || 0 });
    } else if (Array.isArray(rulesetList)) {
      const truncated = rulesetList._pagination_truncated;
      delete rulesetList._pagination_truncated;

      if (truncated) {
        evidence._errors.push({ phase: "rulesets_pagination", status: 0 });
      }

      if (totalController.signal.aborted) throw totalController.signal.reason;

      // 4. Fetch each ruleset detail
      for (const rsSummary of rulesetList) {
        if (!rsSummary || !rsSummary.id) continue;

        // Use self URL if available, otherwise build from id
        let detailUrl;
        if (rsSummary._links?.self?.href) {
          detailUrl = rsSummary._links.self.href;
        } else {
          detailUrl = `/repos/${owner}/${repo}/rulesets/${rsSummary.id}`;
        }

        const detail = await ghFetch(token, detailUrl, downstreamOpts);
        const detailStatus = detail._status;
        delete detail._status;

        if (detail._network_error) {
          evidence._errors.push({ phase: "ruleset_detail", ruleset_id: rsSummary.id, status: 0 });
        } else if (detail._malformed) {
          evidence._errors.push({ phase: "ruleset_detail", ruleset_id: rsSummary.id, status: detailStatus || 0 });
        } else if (detail._foreign_origin) {
          evidence._errors.push({ phase: "ruleset_detail", ruleset_id: rsSummary.id, status: 0 });
        } else if (detailStatus === 200) {
          evidence.rulesets.push(detail);
        } else {
          evidence._errors.push({
            phase: "ruleset_detail",
            ruleset_id: rsSummary.id,
            status: detailStatus || 0,
          });
        }

        if (totalController.signal.aborted) throw totalController.signal.reason;
      }
    }
  } finally {
    clearTimeout(totalTimeout);
  }

  // Store raw evidence to RUNNER_TEMP in CI (mode 0600), never uploaded
  if (process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_TEMP) {
    try {
      await mkdir(path.join(process.env.RUNNER_TEMP, "fnd01"), { recursive: true });
      const rawPath = path.join(process.env.RUNNER_TEMP, "fnd01", "raw-evidence.json");
      await writeFile(rawPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    } catch {
      // Best-effort; never fail on temp-file writes
    }
  }

  return evidence;
}

// ---------------------------------------------------------------------------
// Ruleset helpers (corrected semantics)
// ---------------------------------------------------------------------------

/**
 * Resolve ~DEFAULT_BRANCH against known default branch.
 */
function resolveRefName(ref, knownDefaultBranch) {
  if (ref === "~DEFAULT_BRANCH") {
    return knownDefaultBranch || null;
  }
  return ref;
}

/**
 * Check if a ref_name include pattern matches the target branch.
 * Patterns supported:
 *   - exact match: "refs/heads/main"
 *   - ~DEFAULT_BRANCH (resolved)
 *   - ~ALL
 *   - refs/heads/* (matches anything under refs/heads/)
 *   - refs/heads/main* (prefix match under main*)
 * Unknown/ambiguous patterns → return false (fail-safe)
 * Tag patterns → return false
 */
function refMatches(refPattern, targetBranch, knownDefaultBranch) {
  const resolved = resolveRefName(refPattern, knownDefaultBranch);

  // Exact match
  if (resolved === `refs/heads/${targetBranch}`) return true;

  // ~ALL matches everything
  if (refPattern === "~ALL") return true;

  // refs/heads/* matches any branch
  if (refPattern === "refs/heads/*") return true;

  // refs/heads/main* — prefix match, but only for main* patterns
  // We handle this conservatively: only match if pattern starts with
  // refs/heads/ and the target branch starts with the pattern suffix
  if (refPattern.startsWith("refs/heads/") && refPattern.endsWith("*")) {
    const prefix = refPattern.slice(0, -1); // e.g. "refs/heads/main"
    const expectedRef = `refs/heads/${targetBranch}`;
    if (expectedRef.startsWith(prefix)) return true;
  }

  // refs/tags/*, ~UNKNOWN, or anything unrecognized → fail-safe: return false
  return false;
}

/**
 * Filter rulesets targeting the branch (target_branch):
 * - enforcement === "active" only
 * - target === "branch" (or missing, for backwards compat)
 * - conditions.ref_name.include matches target branch
 * - conditions.ref_name.exclude does NOT match
 */
function activeRulesetsForBranch(evidence, targetBranch, knownDefaultBranch) {
  if (!evidence || !Array.isArray(evidence.rulesets)) return [];
  return evidence.rulesets.filter((rs) => {
    if (rs.enforcement !== "active") return false;

    // Check target type
    if (rs.target && rs.target !== "branch") return false;

    const cond = get(rs, "conditions.ref_name");
    if (!cond) return false;
    const include = Array.isArray(cond.include) ? cond.include : [];
    const exclude = Array.isArray(cond.exclude) ? cond.exclude : [];

    // Must match at least one include pattern
    const matchesInclude = include.some((pattern) =>
      refMatches(pattern, targetBranch, knownDefaultBranch)
    );
    if (!matchesInclude) return false;

    // Must NOT match any exclude pattern
    const matchesExclude = exclude.some((pattern) =>
      refMatches(pattern, targetBranch, knownDefaultBranch)
    );
    if (matchesExclude) return false;

    return true;
  });
}

function findRulesetRule(rulesets, ruleType) {
  for (const rs of rulesets) {
    const rules = rs.rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (rule.type === ruleType) return rule;
    }
  }
  return null;
}

function rulesetRuleParam(rulesets, ruleType, paramName) {
  const rule = findRulesetRule(rulesets, ruleType);
  if (!rule || !rule.parameters) return undefined;
  return rule.parameters[paramName];
}

/**
 * Bypass check: admin_enforcement fails if ANY applicable ruleset
 * has a non-empty bypass_actors array (most permissive wins).
 */
function rulesetHasBypassActors(rulesets) {
  for (const rs of rulesets) {
    const actors = rs.bypass_actors;
    if (Array.isArray(actors) && actors.length > 0) return true;
  }
  return false;
}

/**
 * Parse status check contexts from either string[] or object[] format.
 */
function parseStatusCheckContexts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && typeof entry.context === "string") return entry.context;
      return null;
    })
    .filter(Boolean);
}

/**
 * Status check matching: "includes quality AND secret-scan".
 * Extra checks beyond those two do NOT cause a false negative.
 * Missing one of the two does fail.
 * Duplicates are ok (we dedupe before checking).
 */
function statusChecksInclude(contexts, expected) {
  const names = parseStatusCheckContexts(contexts);
  if (names.length === 0) return false;

  // Deduplicate
  const unique = [...new Set(names)];

  // Every expected check must be present
  for (const exp of expected) {
    if (!unique.includes(exp)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Core check function
// ---------------------------------------------------------------------------

/**
 * @param {object} evidence  — collected or loaded evidence
 * @param {object} policy    — parsed branch-governance-policy.json
 * @returns {{ passed: boolean, controls: Record<string,{enforced:boolean,source?:string}>, failed: string[], summary: string, repository: string, branch: string }}
 */
export function check(evidence, policy) {
  // Repository MUST come from GITHUB_REPOSITORY (live) or be "offline" (offline)
  const repository = process.env.GITHUB_REPOSITORY
    ? process.env.GITHUB_REPOSITORY
    : "offline";

  // Branch MUST be policy.target_branch always
  const branch = policy?.target_branch || "main";

  // Offline mode: validate that metadata.branch matches policy.target_branch
  if (!process.env.GITHUB_TOKEN && evidence?.metadata?.branch) {
    if (evidence.metadata.branch !== branch) {
      return {
        passed: false,
        controls: {},
        failed: [],
        summary: "FAILED: metadata.branch does not match policy.target_branch",
        repository,
        branch,
        _error: "branch-mismatch",
      };
    }
  }

  const controls = {};
  const failed = [];

  // Validate evidence structure for offline mode
  if (!process.env.GITHUB_TOKEN) {
    if (evidence.classic_branch_protection !== null && evidence.classic_branch_protection !== undefined) {
      if (typeof evidence.classic_branch_protection !== "object" || Array.isArray(evidence.classic_branch_protection)) {
        return {
          passed: false,
          controls: {},
          failed: [],
          summary: "FAILED: malformed evidence — classic_branch_protection is not an object",
          repository,
          branch,
          _error: "malformed-evidence",
        };
      }
    }
    if (evidence.rulesets !== null && evidence.rulesets !== undefined) {
      if (!Array.isArray(evidence.rulesets)) {
        return {
          passed: false,
          controls: {},
          failed: [],
          summary: "FAILED: malformed evidence — rulesets is not an array",
          repository,
          branch,
          _error: "malformed-evidence",
        };
      }
    }
    if (evidence._errors !== null && evidence._errors !== undefined) {
      if (!Array.isArray(evidence._errors)) {
        return {
          passed: false,
          controls: {},
          failed: [],
          summary: "FAILED: malformed evidence — _errors is not an array",
          repository,
          branch,
          _error: "malformed-evidence",
        };
      }
    }
  }

  // Fatal errors: 401, 403, network errors, malformed responses
  // 404 on classic/sigs endpoints is NOT fatal — just "control absent"
  const hasFatalError = (evidence?._errors || []).some(
    (e) => e.status === 401 || e.status === 403 || e.status === 0 || e.status == null
  );

  if (hasFatalError) {
    for (const ctrl of policy.controls) {
      controls[ctrl.id] = { enforced: false, source: "error" };
      if (ctrl.id) failed.push(ctrl.id);
    }
    return {
      passed: false,
      controls,
      failed,
      summary: `FAILED: API status error — all ${policy.controls.length} controls NOT ENFORCED`,
      repository,
      branch,
    };
  }

  const classic = evidence?.classic_branch_protection || null;
  const classicSigs = evidence?.classic_required_signatures || null;

  // Resolve ~DEFAULT_BRANCH for this repo
  // In live mode, we'd have fetched it; in offline mode we try env or metadata
  let knownDefaultBranch = process.env.GITHUB_DEFAULT_BRANCH || null;
  if (!knownDefaultBranch && evidence?.metadata?.default_branch) {
    knownDefaultBranch = evidence.metadata.default_branch;
  }

  const rulesets = activeRulesetsForBranch(evidence, branch, knownDefaultBranch);

  for (const ctrl of policy.controls) {
    let enforced = false;
    let source = null;

    // ---- Classic check ----
    if (ctrl.classic_check) {
      let val;
      // signed_commits uses separate endpoint for classic
      if (ctrl.classic_separate_endpoint) {
        val = classicSigs ? get(classicSigs, "enabled") : undefined;
      } else {
        val = classic ? get(classic, ctrl.classic_field) : undefined;
      }

      switch (ctrl.classic_check) {
        case "exists":
          enforced = val !== undefined && val !== null;
          break;
        case "bool_true":
          enforced = val === true;
          break;
        case "bool_false":
          enforced = val === false;
          break;
        case "min_value":
          enforced = typeof val === "number" && val >= (ctrl.min_value || 0);
          break;
        case "status_checks_includes":
          enforced = statusChecksInclude(val, ctrl.expected_checks || []);
          break;
        case "status_checks": // legacy — treat as includes
          enforced = statusChecksInclude(val, ctrl.expected_checks || []);
          break;
      }
      if (enforced) source = "classic";
    }

    // ---- Ruleset check (union: passes if ANY applicable ruleset provides it) ----
    // Special case: no_bypass_actors ALWAYS runs (even if classic already passes)
    // because a ruleset with bypass_actors overrides classic enforce_admins.
    const rulesetCheck = ctrl.ruleset_check;
    if (rulesetCheck && rulesets.length > 0) {
      if (rulesetCheck === "no_bypass_actors") {
        // This check always runs — can override classic pass
        if (!rulesetHasBypassActors(rulesets)) {
          enforced = true;
          source = "ruleset";
        } else {
          // Bypass actors exist — override any classic enforcement
          enforced = false;
          source = null;
        }
      } else if (!enforced) {
        // Union: only check if not already enforced
        switch (rulesetCheck) {
          case "rule_exists": {
            const rule = findRulesetRule(rulesets, ctrl.ruleset_type);
            if (rule) { enforced = true; source = "ruleset"; }
            break;
          }
          case "bool_true": {
            const v = rulesetRuleParam(rulesets, ctrl.ruleset_type, ctrl.ruleset_param);
            if (v === true) { enforced = true; source = "ruleset"; }
            break;
          }
          case "min_value": {
            const v = rulesetRuleParam(rulesets, ctrl.ruleset_type, ctrl.ruleset_param);
            if (typeof v === "number" && v >= (ctrl.min_value || 0)) {
              enforced = true;
              source = "ruleset";
            }
            break;
          }
          case "status_checks_includes": {
            const raw = rulesetRuleParam(rulesets, ctrl.ruleset_type, ctrl.ruleset_param);
            if (statusChecksInclude(raw, ctrl.expected_checks || [])) {
              enforced = true;
              source = "ruleset";
            }
            break;
          }
          case "status_checks": { // legacy
            const raw = rulesetRuleParam(rulesets, ctrl.ruleset_type, ctrl.ruleset_param);
            if (statusChecksInclude(raw, ctrl.expected_checks || [])) {
              enforced = true;
              source = "ruleset";
            }
            break;
          }
        }
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
// Redacted output (fixed schema — never raw bodies, tokens, paths, messages)
// ---------------------------------------------------------------------------

function redactedOutput(result) {
  // Strip any internal _error fields
  const { _error, ...clean } = result;
  return {
    repository: clean.repository,
    branch: clean.branch,
    passed: clean.passed,
    controls: clean.controls,
    failed_count: clean.failed ? clean.failed.length : 0,
    summary: clean.summary,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const policy = await loadPolicy();

  let evidence;

  // Live mode
  if (process.env.GITHUB_TOKEN) {
    const repo =
      process.env.GITHUB_REPOSITORY ||
      process.env.FND01_REPOSITORY ||
      "";
    const [owner, repoName] = repo.split("/");
    // Branch is ALWAYS policy.target_branch
    const branch = policy.target_branch || "main";

    if (!owner || !repoName) {
      process.stderr.write(
        JSON.stringify({ error: "missing-repository" }) + "\n"
      );
      return 2;
    }

    try {
      evidence = await collectLive(process.env.GITHUB_TOKEN, owner, repoName, branch);
    } catch (err) {
      process.stderr.write(
        JSON.stringify({ error: "unexpected-error" }) + "\n"
      );
      return 2;
    }
  } else {
    // Offline mode: read evidence file
    const evidencePath =
      process.env.INFORMER_PATH ||
      process.argv[2] ||
      ".github/branch-governance-evidence.json";

    let raw;
    try {
      raw = await readFile(evidencePath, "utf8");
    } catch {
      // Redacted: never include path in output
      process.stderr.write(
        JSON.stringify({ error: "evidence-read-failed" }) + "\n"
      );
      return 2;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      process.stderr.write(
        JSON.stringify({ error: "malformed-evidence" }) + "\n"
      );
      return 2;
    }

    if (!parsed || typeof parsed !== "object") {
      process.stderr.write(
        JSON.stringify({ error: "malformed-evidence" }) + "\n"
      );
      return 2;
    }

    evidence = parsed;
  }

  const result = check(evidence, policy);

  // If check returned an _error field, convert to exit code 2
  if (result._error) {
    process.stderr.write(
      JSON.stringify({ error: result._error }) + "\n"
    );
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
if (
  process.argv[1] &&
  (process.argv[1] === thisScript ||
    process.argv[1].endsWith("check-branch-governance.mjs"))
) {
  main().then((code) => process.exit(code)).catch(() => {
    process.stderr.write(
      JSON.stringify({ error: "unexpected-error" }) + "\n"
    );
    process.exit(2);
  });
}
