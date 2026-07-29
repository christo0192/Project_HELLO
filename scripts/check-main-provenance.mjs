#!/usr/bin/env node

/**
 * check-main-provenance.mjs — Zero-dependency commit provenance verifier.
 *
 * Detects whether commits arriving on main originated from a GitHub
 * squash-merged PR (the only PR merge strategy that produces 1-parent
 * commits on the target branch with a PR-number reference in the message)
 * versus direct push, merge commit, rebase, or ambiguous provenance.
 *
 * Two modes:
 *   LIVE:   GITHUB_TOKEN + GITHUB_EVENT_PATH env vars → reads push-event
 *           payload, runs git rev-list to enumerate pushed commits,
 *           checks each for PR provenance.
 *   OFFLINE: INFORMER_PATH env / CLI arg → local evidence JSON file.
 *
 * Output is a fixed-schema redacted JSON summary. Never prints token,
 * SHA, commit message, repository name, actor login/email, or file paths.
 *
 * Exit codes:
 *   0 — ALL commits have acceptable PR provenance (squash-merge)
 *   1 — ONE OR MORE commits lack acceptable provenance (fail-closed)
 *   2 — input malformed, file not found, parse error, or invalid env
 */

import { readFile, writeFile } from "node:fs/promises";
import { execSync, execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PR_REF_RE = /\(#(\d+)\)\s*$/m;

const HEX40_RE = /^[0-9a-f]{40}$/i;
const ZERO_SHA = "0000000000000000000000000000000000000000";

/**
 * Validate a Git SHA is exactly 40 hex characters.
 * All-zero SHA is valid (creation/deletion push event sentinel).
 * Throws on invalid input.
 */
export function validateSha(sha, label) {
  if (typeof sha !== "string") {
    throw new Error(`${label}: not a string`);
  }
  if (!HEX40_RE.test(sha)) {
    throw new Error(`${label}: invalid SHA — not 40 hex characters`);
  }
  // All-zero is a valid sentinel for branch creation or deletion
  return sha;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract PR reference from a commit message.
 * Returns the PR number as a string if found, or null.
 * GitHub squash-merge produces:  "Title (#123)"
 * GitHub merge-commit produce:   "Merge pull request #123 from ..."
 */
function extractPRNumber(message) {
  if (typeof message !== "string") return null;
  // Match squash-merge style: "text (#N)"
  const m = message.match(PR_REF_RE);
  if (m) return m[1];
  return null;
}

/**
 * Classify a single commit's provenance.
 *
 * @param {object} commit — { parents: string[], message: string, sha?: string }
 * @returns {{ verdict: string, reason?: string }}
 *   verdicts: "accepted", "merge-commit", "direct-push", "ambiguous", "error"
 */
export function classifyCommit(commit) {
  if (!commit || typeof commit !== "object") {
    return { verdict: "error", reason: "invalid-commit-object" };
  }

  const parents = commit.parents;
  if (!Array.isArray(parents)) {
    return { verdict: "error", reason: "invalid-parents-array" };
  }

  const message = typeof commit.message === "string" ? commit.message : "";

  // Merge commit: 2+ parents
  if (parents.length >= 2) {
    // Check if message starts with "Merge pull request #N" — still a merge commit
    return { verdict: "merge-commit", reason: `commit has ${parents.length} parents` };
  }

  // Single-parent commit: could be squash-merge, direct push, or rebase
  if (parents.length === 1) {
    const prNum = extractPRNumber(message);
    if (prNum) {
      // Has PR reference — accept as squash-merge provenance
      return { verdict: "accepted", reason: "squash-merge" };
    }
    // No PR reference — could be direct push or rebase without PR ref
    // We fail closed: without PR reference, we treat as direct push
    return { verdict: "direct-push", reason: "no-PR-reference-in-message" };
  }

  // Zero parents (root commit) — very rare, treat as error
  return { verdict: "error", reason: "commit-has-zero-parents" };
}

/**
 * Check all commits in an evidence object for provenance.
 *
 * @param {object} evidence — { commits: [], metadata: {} }
 * @param {object} ctx — { branch?: string }
 * @returns {{ passed: boolean, provenance: object, summary: string, _error?: string }}
 */
export function check(evidence, ctx = {}) {
  const branch = ctx.branch || "main";

  // Validate evidence shape
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { passed: false, provenance: null, summary: "FAILED: evidence not an object", _error: "malformed-evidence" };
  }

  const meta = evidence.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return { passed: false, provenance: null, summary: "FAILED: metadata missing or invalid", _error: "malformed-evidence" };
  }
  if (meta.branch && meta.branch !== branch) {
    return { passed: false, provenance: null, summary: "FAILED: metadata.branch mismatch", _error: "branch-mismatch" };
  }

  const commits = evidence.commits;
  if (!Array.isArray(commits)) {
    return { passed: false, provenance: null, summary: "FAILED: commits not an array", _error: "malformed-evidence" };
  }
  if (commits.length === 0) {
    return { passed: false, provenance: null, summary: "FAILED: empty commit list", _error: "no-commits" };
  }

  let accepted = 0;
  let rejected = 0;
  let directPush = 0;
  let mergeCommit = 0;
  let ambiguous = 0;
  let errors = 0;

  for (const commitRef of commits) {
    // Handle null/undefined entries in commits array
    if (!commitRef || typeof commitRef !== "object") {
      rejected++;
      errors++;
      continue;
    }
    // Support both { parents: [...], message: "..." } and resolved objects
    const commitObj = commitRef._resolved || commitRef;
    if (!commitObj || typeof commitObj !== "object") {
      rejected++;
      errors++;
      continue;
    }
    const result = classifyCommit(commitObj);

    switch (result.verdict) {
      case "accepted":
        accepted++;
        break;
      case "merge-commit":
        rejected++;
        mergeCommit++;
        break;
      case "direct-push":
        rejected++;
        directPush++;
        break;
      case "error":
        rejected++;
        errors++;
        break;
      default:
        rejected++;
        ambiguous++;
        break;
    }
  }

  const total = commits.length;
  const passed = accepted === total && rejected === 0 && errors === 0;

  const provenance = {
    total_commits: total,
    accepted_count: accepted,
    rejected_count: rejected,
    direct_push_count: directPush,
    merge_commit_count: mergeCommit,
    ambiguous_count: ambiguous,
    error_count: errors,
  };

  let summary;
  if (passed) {
    summary = `ALL ${total} commits have acceptable PR provenance (squash-merge)`;
  } else if (rejected > 0) {
    summary = `FAILED: ${rejected} of ${total} commits lack PR provenance — direct-push=${directPush} merge-commit=${mergeCommit} ambiguous=${ambiguous} error=${errors}`;
  } else {
    summary = "FAILED: provenance check could not be completed";
  }

  return { passed, provenance, summary };
}

// ---------------------------------------------------------------------------
// Redacted output
// ---------------------------------------------------------------------------

function redactedOutput(result) {
  return {
    passed: result.passed,
    provenance: result.provenance,
    summary: result.summary,
  };
}

// ---------------------------------------------------------------------------
// Live collector (GitHub Actions push event)
// ---------------------------------------------------------------------------

/**
 * Collect commit provenance evidence from a GitHub Actions push event.
 *
 * Reads GITHUB_EVENT_PATH (push event payload JSON), extracts before/after
 * refs, runs `git rev-list` to enumerate commits, and for each commit
 * gets parent count and message.
 */
export async function collectLive(opts = {}) {
  const eventPath = opts.eventPath || process.env.GITHUB_EVENT_PATH;
  const repoDir = opts.repoDir || process.env.GITHUB_WORKSPACE || process.cwd();

  if (!eventPath) {
    return { _error: { phase: "event_path", status: 0, reason: "missing-GITHUB_EVENT_PATH" } };
  }

  let payload;
  try {
    const raw = await readFile(eventPath, "utf8");
    payload = JSON.parse(raw);
  } catch {
    return { _error: { phase: "event_read", status: 0, reason: "cannot-read-event-payload" } };
  }

  if (!payload || typeof payload !== "object") {
    return { _error: { phase: "event_payload", status: 0, reason: "invalid-event-payload" } };
  }

  const eventName = payload.action ? `push` : (process.env.GITHUB_EVENT_NAME || "push");
  if (eventName !== "push") {
    return { _error: { phase: "event_name", status: 0, reason: `unexpected-event-${eventName}` } };
  }

  const ref = payload.ref || process.env.GITHUB_REF || "";
  const before = payload.before;
  const after = payload.after || payload.head || process.env.GITHUB_SHA;

  if (!before || !after) {
    return { _error: { phase: "push_refs", status: 0, reason: "missing-before-or-after" } };
  }

  if (typeof before !== "string" || typeof after !== "string") {
    return { _error: { phase: "push_refs", status: 0, reason: "non-string-before-or-after" } };
  }

  // Determine branch from ref
  let branch = "";
  if (ref.startsWith("refs/heads/")) {
    branch = ref.slice("refs/heads/".length);
  } else if (process.env.GITHUB_REF_NAME) {
    branch = process.env.GITHUB_REF_NAME;
  } else {
    return { _error: { phase: "ref_parse", status: 0, reason: "cannot-determine-branch" } };
  }

  // Enumerate commits between before and after
  let revList;
  try {
    validateSha(before, "before");
    validateSha(after, "after");
    revList = execFileSync(
      "git",
      ["rev-list", "--parents", `${before}..${after}`],
      { cwd: repoDir, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    ).trim();
  } catch (err) {
    const reason = err.message && (err.message.includes("invalid SHA") || err.message.includes("not a string"))
      ? `invalid-sha-${err.message}`
      : "git-rev-list-failed";
    return { _error: { phase: "rev_list", status: 0, reason } };
  }

  if (!revList) {
    return { _error: { phase: "rev_list_empty", status: 0, reason: "no-commits-in-range" } };
  }

  const lines = revList.split("\n");
  const commits = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    const sha = parts[0];
    const parents = parts.slice(1);

    // Get commit message
    let message = "";
    try {
      validateSha(sha, "sha");
      message = execFileSync(
        "git",
        ["log", "--format=%B", "-n", "1", sha],
        { cwd: repoDir, encoding: "utf8", maxBuffer: 1024 * 1024 }
      ).trim();
    } catch (err) {
      // If we can't read message, record as error
    }

    commits.push({
      _sha: sha, // internal only, never output
      parents,
      message,
      _resolved: { parents, message },
    });
  }

  return {
    metadata: { event: eventName, branch, checked_at: new Date().toISOString() },
    commits,
    _raw: { before, after, ref },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(opts = {}) {
  const branch = opts.branch || "main";

  let evidence, source;

  const evidencePath = opts.evidencePath || process.env.INFORMER_PATH || process.argv[2];
  const eventPath = opts.eventPath ?? process.env.GITHUB_EVENT_PATH;

  // Explicit offline evidence always wins over ambient GitHub Actions
  // variables. This keeps fixture/replay checks deterministic inside CI.
  if (!evidencePath && eventPath) {
    source = "live";
    try {
      const result = await collectLive({ ...opts, eventPath });
      if (result._error) {
        process.stderr.write(JSON.stringify({ error: "collection-failed", reason: result._error.reason }) + "\n");
        return 1;
      }
      evidence = result;
    } catch {
      process.stderr.write(JSON.stringify({ error: "unexpected-collection-error" }) + "\n");
      return 1;
    }
  } else {
    source = "offline";
    if (!evidencePath) {
      process.stderr.write(JSON.stringify({ error: "no-evidence-source" }) + "\n");
      return 2;
    }
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

  const result = check(evidence, { branch });
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
if (process.argv[1] && (process.argv[1] === thisScript || process.argv[1].endsWith("check-main-provenance.mjs"))) {
  main().then((code) => process.exit(code)).catch(() => {
    process.stderr.write(JSON.stringify({ error: "unexpected-error" }) + "\n");
    process.exit(2);
  });
}
