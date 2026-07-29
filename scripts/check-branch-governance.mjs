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

// ---------------------------------------------------------------------------
// Live collector (GitHub API)
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";
const MAX_RULESET_PAGES = 3;
const RULESET_PER_PAGE = 100;

async function ghFetch(token, urlPath) {
  const url = `${GITHUB_API}${urlPath}`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "fnd01-branch-governance-verifier/1.0",
      },
    });
  } catch {
    // Network failure: return sentinel
    return { _network_error: true };
  }

  let body;
  try {
    body = await resp.json();
  } catch {
    return { _malformed: true, _status: resp.status };
  }

  // Attach status for error checks
  body._status = resp.status;
  return body;
}

async function ghFetchAll(token, urlPath) {
  const results = [];
  let nextUrl = urlPath.includes("?") ? urlPath : `${urlPath}?per_page=${RULESET_PER_PAGE}`;
  let pages = 0;

  while (nextUrl && pages < MAX_RULESET_PAGES) {
    pages++;
    const url = nextUrl.startsWith("http") ? nextUrl : `${GITHUB_API}${nextUrl}`;

    let resp;
    try {
      resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "fnd01-branch-governance-verifier/1.0",
        },
      });
    } catch {
      return { _network_error: true };
    }

    let body;
    try {
      body = await resp.json();
    } catch {
      return { _malformed: true, _status: resp.status };
    }

    if (!Array.isArray(body)) {
      // Paginated endpoint returned non-array → malformed
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

async function collectLive(token, owner, repo, branch) {
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

  // 1. Classic branch protection
  const classic = await ghFetch(
    token,
    `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`
  );

  const classicStatus = classic._status;
  delete classic._status;
  delete classic._network_error;
  delete classic._malformed;

  if (classicStatus === 404) {
    // No protection configured — not an error, just absent
    evidence.classic_branch_protection = null;
  } else if (classicStatus === 401 || classicStatus === 403) {
    evidence._errors.push({ phase: "classic", status: classicStatus });
    evidence.classic_branch_protection = null;
  } else if (classicStatus === 200) {
    evidence.classic_branch_protection = classic;
  } else {
    // Network error, malformed, or unexpected status
    evidence._errors.push({ phase: "classic", status: classicStatus || 0 });
    evidence.classic_branch_protection = null;
  }

  // 2. Classic required signatures (separate endpoint)
  const sigs = await ghFetch(
    token,
    `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_signatures`
  );

  const sigsStatus = sigs._status;
  delete sigs._status;
  delete sigs._network_error;
  delete sigs._malformed;

  if (sigsStatus === 200) {
    evidence.classic_required_signatures = sigs;
  } else if (sigsStatus === 404) {
    evidence.classic_required_signatures = null;
  } else {
    evidence._errors.push({ phase: "required_signatures", status: sigsStatus || 0 });
    evidence.classic_required_signatures = null;
  }

  // 3. Rulesets list (paginated)
  const rulesetList = await ghFetchAll(
    token,
    `/repos/${owner}/${repo}/rulesets`
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

    // 4. Fetch each ruleset detail
    for (const rsSummary of rulesetList) {
      if (!rsSummary || !rsSummary.id || !rsSummary._links?.self?.href) continue;

      const detail = await ghFetch(token, rsSummary._links.self.href);
      const detailStatus = detail._status;
      delete detail._status;
      delete detail._network_error;
      delete detail._malformed;

      if (detailStatus === 200) {
        evidence.rulesets.push(detail);
      } else {
        // Individual ruleset fetch failure → fail closed
        evidence._errors.push({
          phase: "ruleset_detail",
          ruleset_id: rsSummary.id,
          status: detailStatus || 0,
        });
      }
    }
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
 * Filter rulesets targeting main:
 * - enforcement === "active" only
 * - conditions.ref_name.include contains "refs/heads/main" or "~DEFAULT_BRANCH"
 * - conditions.ref_name.exclude does NOT contain the matching ref
 */
function activeRulesetsForMain(evidence) {
  if (!evidence || !Array.isArray(evidence.rulesets)) return [];
  return evidence.rulesets.filter((rs) => {
    if (rs.enforcement !== "active") return false;
    const cond = get(rs, "conditions.ref_name");
    if (!cond) return false;
    const include = Array.isArray(cond.include) ? cond.include : [];
    const exclude = Array.isArray(cond.exclude) ? cond.exclude : [];
    const targetsMain =
      include.includes("refs/heads/main") || include.includes("~DEFAULT_BRANCH");
    const excludesMain =
      exclude.includes("refs/heads/main") || exclude.includes("~DEFAULT_BRANCH");
    return targetsMain && !excludesMain;
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

function rulesetHasBypassActors(rulesets) {
  for (const rs of rulesets) {
    const actors = rs.bypass_actors;
    if (Array.isArray(actors) && actors.length > 0) return true;
  }
  return false;
}

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

function statusChecksMatch(contexts, expected) {
  const names = parseStatusCheckContexts(contexts);
  if (names.length === 0) return false;
  const sorted = [...names].sort();
  const exp = [...expected].sort();
  return sorted.length === exp.length && sorted.every((v, i) => v === exp[i]);
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
  const repository = evidence?.metadata?.repository || "unknown";
  const branch = evidence?.metadata?.branch || policy?.target_branch || "main";
  const controls = {};
  const failed = [];

  // If any collection-phase error with 401/403 → all controls NOT ENFORCED
  const fatalError = (evidence?._errors || []).find(
    (e) => e.status === 401 || e.status === 403 || e.status === 404
  );
  if (fatalError) {
    for (const ctrl of policy.controls) {
      controls[ctrl.id] = { enforced: false, source: "error" };
      failed.push(ctrl.id);
    }
    return {
      passed: false,
      controls,
      failed,
      summary: `FAILED: API status ${fatalError.status} — all ${policy.controls.length} controls NOT ENFORCED`,
      repository,
      branch,
    };
  }

  // Network/malformed errors (non-401/403/404) also fail closed
  if ((evidence?._errors || []).length > 0) {
    for (const ctrl of policy.controls) {
      controls[ctrl.id] = { enforced: false, source: "error" };
      failed.push(ctrl.id);
    }
    return {
      passed: false,
      controls,
      failed,
      summary: `FAILED: collection error — all ${policy.controls.length} controls NOT ENFORCED`,
      repository,
      branch,
    };
  }

  const classic = evidence?.classic_branch_protection || null;
  const classicSigs = evidence?.classic_required_signatures || null;
  const rulesets = activeRulesetsForMain(evidence);

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
        case "status_checks":
          enforced = statusChecksMatch(val, ctrl.expected_checks || []);
          break;
      }
      if (enforced) source = "classic";
    }

    // ---- Ruleset check (only if not already enforced) ----
    if (!enforced && ctrl.ruleset_check && rulesets.length > 0) {
      switch (ctrl.ruleset_check) {
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
        case "status_checks": {
          const raw = rulesetRuleParam(rulesets, ctrl.ruleset_type, ctrl.ruleset_param);
          if (statusChecksMatch(raw, ctrl.expected_checks || [])) {
            enforced = true;
            source = "ruleset";
          }
          break;
        }
        case "no_bypass_actors": {
          if (!rulesetHasBypassActors(rulesets)) {
            enforced = true;
            source = "ruleset";
          }
          break;
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
  return {
    repository: result.repository,
    branch: result.branch,
    passed: result.passed,
    controls: result.controls,
    failed_count: result.failed.length,
    summary: result.summary,
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
    const branch =
      process.env.GITHUB_REF_NAME ||
      process.env.FND01_BRANCH ||
      policy.target_branch ||
      "main";

    if (!owner || !repoName) {
      process.stderr.write(
        JSON.stringify({
          error: "missing-repository",
        }) + "\n"
      );
      return 2;
    }

    evidence = await collectLive(process.env.GITHUB_TOKEN, owner, repoName, branch);
  } else {
    // Offline mode: read evidence file
    const evidencePath =
      process.env.INFORMER_PATH ||
      process.argv[2] ||
      ".github/branch-governance-evidence.json";

    let raw;
    try {
      raw = await readFile(evidencePath, "utf8");
    } catch (err) {
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
        JSON.stringify({ error: "invalid-evidence-structure" }) + "\n"
      );
      return 2;
    }

    // Treat explicit error status in offline evidence
    const errStatus = parsed?.metadata?.error?.status;
    if (errStatus === 401 || errStatus === 403 || errStatus === 404) {
      parsed._errors = parsed._errors || [];
      parsed._errors.push({ phase: "offline", status: errStatus });
    }

    evidence = parsed;
  }

  const result = check(evidence, policy);
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
