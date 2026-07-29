# Branch Governance Evidence Runbook

## Overview

The branch governance verifier (`scripts/check-branch-governance.mjs`) checks
whether the 12 required branch-protection controls for the policy's target
branch are enforced. It supports two modes:

- **Live mode:** When `GITHUB_TOKEN` is set in the environment, it performs
  read-only GitHub API collection (classic protection, required signatures
  separate endpoint, paginated rulesets with individual detail fetches).
  Branch is always taken from `policy.target_branch` (default `"main"`).
  Raw API responses go only to memory (or `$RUNNER_TEMP/fnd01/` mode 0600 in
  CI) and are **never** uploaded or printed.

- **Offline mode:** When `GITHUB_TOKEN` is not set, it reads a local evidence
  JSON file (`$INFORMER_PATH`, first CLI argument, or
  `.github/branch-governance-evidence.json`). The metadata.branch in the
  offline file is validated against policy.target_branch; a mismatch fails
  closed with exit code 2 (`branch-mismatch`). The repository in the output
  is always the literal string `"offline"` (never from user-controlled data).

Either way, the verifier outputs a **fixed-schema redacted JSON summary**
containing only: repository, branch, passed boolean, per-control
enforced+source, failed_count, and a generic summary string. It never prints
tokens, Authorization headers, raw API bodies, error messages, or file paths.

## Prerequisites

- Node.js 22+
- For live mode: a GitHub personal access token with `repo` scope set as
  `GITHUB_TOKEN` (or a `$GITHUB_TOKEN` environment variable present in CI)

## Collecting evidence

### Live mode (recommended)

Set `GITHUB_TOKEN` and optionally `GITHUB_REPOSITORY` (owner/repo format):

```bash
GITHUB_TOKEN="$GH_TOKEN" GITHUB_REPOSITORY="christo0192/Project_HELLO" \
  node scripts/check-branch-governance.mjs
```

The verifier fetches classic branch protection, the separate
`required_signatures` endpoint, the paginated rulesets list (with
`includes_parents=true` to include inherited rulesets), and each
individual ruleset detail. Pagination is bounded to 3 pages; if more pages
exist, the verifier treats it as a pagination failure and fails closed.

Live mode always uses `policy.target_branch` (default `"main"`) — never
`GITHUB_REF_NAME` or any environment variable for the branch.

### Offline mode

If you have a pre-collected evidence JSON file:

```bash
# Default path (.github/branch-governance-evidence.json)
node scripts/check-branch-governance.mjs

# Custom path via environment variable
INFORMER_PATH=/path/to/evidence.json node scripts/check-branch-governance.mjs

# Custom path via CLI argument
node scripts/check-branch-governance.mjs /path/to/evidence.json
```

### Manual evidence collection (workflow_dispatch)

Navigate to **Actions → Branch Governance Evidence → Run workflow**. The
workflow uses the repository's `GITHUB_TOKEN` (read-only permissions) to
collect evidence live and uploads only the redacted verifier summary as a
build artifact. Raw API responses are written to `$RUNNER_TEMP` mode 0600
and are **never** included in the artifact.

**Note:** The current private plan may return HTTP 403. This is expected
fail-closed behavior, not a workflow bug. The redacted summary is always
uploaded (on pass AND fail).

## Interpreting results

### Exit code 0 — All controls ENFORCED

Output (stdout):
```json
{
  "repository": "owner/repo",
  "branch": "main",
  "passed": true,
  "controls": {
    "require_pull_requests": { "enforced": true, "source": "classic" },
    "require_two_approvals": { "enforced": true, "source": "classic" },
    ...
  },
  "failed_count": 0,
  "summary": "ALL 12 controls ENFORCED"
}
```

### Exit code 1 — One or more controls NOT ENFORCED

Output (stderr):
```json
{
  "repository": "owner/repo",
  "branch": "main",
  "passed": false,
  "controls": {
    "require_two_approvals": { "enforced": false },
    ...
  },
  "failed_count": 2,
  "summary": "FAILED: 2 of 12 controls NOT ENFORCED"
}
```

### Exit code 2 — Input error

The evidence source is missing, malformed, unreadable, or branch mismatch.
Output (stderr) is a generic fixed error code — never the file path, raw
body, token, or exception stack. Error codes:

- `evidence-read-failed`
- `malformed-evidence`
- `missing-repository`
- `branch-mismatch`
- `unexpected-error`

## Controls verified

| # | Control | Severity | Classic field | Ruleset type |
|---|---------|----------|---------------|--------------|
| 1 | Require PRs before merging | critical | `required_pull_request_reviews` exists | `pull_request` rule exists |
| 2 | Require 2 approvals | critical | `required_approving_review_count >= 2` | `pull_request.required_approving_review_count >= 2` |
| 3 | Require CODEOWNER review | critical | `require_code_owner_reviews == true` | `pull_request.require_code_owner_review == true` |
| 4 | Dismiss stale approvals | high | `dismiss_stale_reviews == true` | `pull_request.dismiss_stale_reviews_on_push == true` |
| 5 | Require last push approval | high | `require_last_push_approval == true` | `pull_request.require_last_push_approval == true` |
| 6 | Require conversation resolution | medium | `required_conversation_resolution.enabled == true` | `pull_request.required_review_thread_resolution == true` |
| 7 | Enforce for administrators | critical | `enforce_admins.enabled == true` | `bypass_actors` is empty (intersection: any ruleset with non-empty bypass_actors fails) |
| 8 | Require signed commits | high | separate `required_signatures` endpoint `enabled == true` | `required_signatures` rule exists |
| 9 | Require linear history | medium | `required_linear_history.enabled == true` | `required_linear_history` rule exists |
| 10 | Force push disabled | critical | `allow_force_pushes.enabled == false` | `non_fast_forward` rule exists |
| 11 | Branch deletion disabled | critical | `allow_deletions.enabled == false` | `deletion` rule exists |
| 12 | Required status checks | critical | `required_status_checks.contexts` includes `"quality"` AND `"secret-scan"` (extra checks ok) | `required_status_checks` with entries matching `quality` + `secret-scan` |

### Ruleset filtering semantics

- Only rulesets with `enforcement === "active"` and `target === "branch"` (or
  missing target) are considered.
- The include patterns are matched: `refs/heads/main`, `~DEFAULT_BRANCH`
  (resolved via `GET /repos/{owner}/{repo}` in live mode), `~ALL`,
  `refs/heads/*`, and `refs/heads/main*` prefix patterns.
- Unknown/ambiguous patterns like `refs/tags/*`, `~UNKNOWN` → ignored
  (fail-safe).
- Exclude patterns that match the target branch → ruleset is dropped.
- Multiple rulesets with the same rule type: a control passes if ANY
  applicable ruleset provides it (union).
- Bypass actors: `admin_enforcement` fails if ANY applicable ruleset has
  non-empty `bypass_actors` (intersection — the most permissive wins for
  bypass).

## Current status (2026-07-29)

As documented in `.github/BRANCH_PROTECTION.md`, GitHub returned HTTP 403 when
branch protection was applied. The current private-repository plan does not
include the ruleset feature. **FND-01 remains blocked** until hosted
enforcement (private-plan upgrade or equivalent) is confirmed AND the `quality`
and `secret-scan` status checks are enforced on `main`, AND direct pushes to
`main` are rejected.

## Security notes

- **Never share raw API output.** The raw evidence contains repository
  structure details. Share only the verifier's redacted JSON summary.
- The verifier **never prints**: tokens, `Authorization` headers, raw API
  bodies, error messages, file paths, or exception stacks.
- The evidence workflow writes raw API responses only to `$RUNNER_TEMP/fnd01/`
  with mode 0600. This directory is ephemeral and never uploaded.
- The uploaded artifact contains only the redacted verifier summary.
- For local live runs, raw API responses stay in memory only.
- Do **not** store raw evidence JSON inside the repository.
- Do **not** embed tokens or credentials in evidence files.
- In offline mode, `metadata.repository` and `metadata.branch` are
  attacker-controlled fields and are **never** echoed in the verifier output.
  Repository is always `"offline"`, branch is always `policy.target_branch`.

## Running tests

```bash
node scripts/check-branch-governance.test.mjs
```

All synthetic fixtures are embedded inline in the test file — no separate
fixture directory. Tests cover: classic positive, ruleset positive, 12
individual control negatives, inactive/evaluate ruleset, bypass actors,
excluded-main conditions, status-check include semantics (including extras
ok, missing one fails, duplicates ok, malformed null fails), separate
signatures endpoint, 401/403 fatal, 404 non-fatal on classic, network/malformed
errors, pagination truncation, policy parity, secret/path/error-message
redaction, metadata redaction (repository + branch + raw error body), fixed
error codes, offline structural validation, live collector mock HTTP with
all 4 endpoints, per-request timeout, multi-page rulesets, bounded-pagination
failure, HTTP failures (401/403/404/429/500/malformed/timeout), owner/repo/
branch validation, and mixed classic+bypass ruleset regression.
