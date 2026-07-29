# Branch Governance Evidence Runbook

## Overview

The branch governance verifier (`scripts/check-branch-governance.mjs`) checks
whether the 12 required branch-protection controls for the policy's target
branch are enforced. It supports two modes:

- **Live mode:** When `GITHUB_TOKEN` is set, it performs read-only GitHub API
  collection (repo metadata, classic protection, required signatures separate
  endpoint, paginated rulesets including inherited, individual ruleset
  details). Branch is always from `policy.target_branch` (default `"main"`).
  Raw responses stay in memory only — **never persisted, never uploaded**.

- **Offline mode:** Reads a local evidence JSON file (`$INFORMER_PATH`, first
  CLI argument, or `.github/branch-governance-evidence.json`). The
  `metadata.branch` must exactly equal `policy.target_branch`; mismatch
  → exit code 2 (`branch-mismatch`). The file is structurally validated
  (root shape, metadata, per-entry `_errors` and `rulesets` shapes).

Either way, the verifier outputs a **fixed-schema redacted JSON summary**
containing only: `repository` (literal `"redacted"`), `branch` (literal
`"redacted"`), `passed`, per-control `enforced`+`source`, `failed_count`,
and a generic `summary` string. It never prints tokens, Authorization
headers, raw API bodies, error messages, exception stacks, or file paths.

## Prerequisites

- Node.js 22+
- For live mode: a GitHub personal access token with `repo` scope set as
  `GITHUB_TOKEN`; `GITHUB_REPOSITORY` in `owner/repo` format (exactly two
  segments — a third segment is rejected)

## Collecting evidence

### Live mode

```bash
GITHUB_TOKEN="$GH_TOKEN" GITHUB_REPOSITORY="christo0192/Project_HELLO" \
  node scripts/check-branch-governance.mjs
```

The verifier fetches:
1. `GET /repos/{owner}/{repo}` — repo metadata (extracts `default_branch`)
2. `GET /repos/{owner}/{repo}/branches/{branch}/protection` — classic branch protection
3. `GET …/protection/required_signatures` — separate signatures endpoint
4. `GET /repos/{owner}/{repo}/rulesets?includes_parents=true&per_page=100` — paginated rulesets (up to 3 pages; more pages → pagination error)
5. `GET /repos/{owner}/{repo}/rulesets/{id}` — each individual ruleset detail

Every API response is validated:
- HTTP 200 bodies must be non-null, non-array objects
- Repo metadata must contain a string `default_branch`
- Ruleset list entries must have numeric IDs
- Ruleset detail bodies must be objects
- Self-href and Link header URLs are checked against the expected origin
  (`https://api.github.com`) via exact `.origin` comparison; lookalike
  origins (`https://api.github.com.evil.example/…`) are rejected

Collection errors of any kind (401, 403, 404 on ruleset detail, 429, 5xx,
network failure, malformed response, pagination ambiguity, hostile URL
origin, missing default_branch, non-object 200 bodies, non-numeric ruleset
IDs) → all 12 controls NOT ENFORCED (fail-closed). Only 404 on classic
protection or required-signatures is treated as "control absent" (not error).

Total collection is bounded to a configurable timeout (default 60 s);
per-request timeout is 10 s. Timeout → collection errors.

### Offline mode

```bash
# Default path (.github/branch-governance-evidence.json)
node scripts/check-branch-governance.mjs

# Custom path via env
INFORMER_PATH=/path/to/evidence.json node scripts/check-branch-governance.mjs

# Custom path via CLI argument
node scripts/check-branch-governance.mjs /path/to/evidence.json
```

### Manual evidence collection (workflow_dispatch)

Navigate to **Actions → Branch Governance Evidence → Run workflow**. The
workflow uses the repository's `GITHUB_TOKEN` (read-only permissions) to run
the verifier live and uploads only the redacted summary as a build artifact.
Raw API responses stay in memory and are **never** included in the artifact.

**Note:** The current private plan may return HTTP 403. This is expected
fail-closed behavior, not a workflow bug. The redacted summary is always
uploaded (on pass AND fail, via `if: always()`).

## Interpreting results

### Exit code 0 — All controls ENFORCED

Output (stdout):
```json
{
  "repository": "redacted",
  "branch": "redacted",
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
  "repository": "redacted",
  "branch": "redacted",
  "passed": false,
  "controls": { ... },
  "failed_count": 3,
  "summary": "FAILED: 3 of 12 controls NOT ENFORCED"
}
```

### Exit code 2 — Input error

The evidence source is missing, malformed, unreadable, structural validation
failed, or repository format invalid. Output (stderr) is a generic fixed
error code — never the file path, raw body, token, or stack. Error codes:

- `evidence-read-failed`
- `malformed-evidence`
- `invalid-repository-format`
- `branch-mismatch`
- `unexpected-error`

## Controls verified

| # | Control | Severity | Classic field | Ruleset type |
|---|---------|----------|---------------|--------------|
| 1 | Require PRs before merging | critical | `required_pull_request_reviews` exists | `pull_request` rule exists |
| 2 | Require 2 approvals | critical | `required_approving_review_count >= 2` | `pull_request.required_approving_review_count >= 2` (any rule) |
| 3 | Require CODEOWNER review | critical | `require_code_owner_reviews == true` | any `pull_request` rule with `require_code_owner_review: true` |
| 4 | Dismiss stale approvals | high | `dismiss_stale_reviews == true` | any `pull_request` rule with `dismiss_stale_reviews_on_push: true` |
| 5 | Require last push approval | high | `require_last_push_approval == true` | any `pull_request` rule with `require_last_push_approval: true` |
| 6 | Require conversation resolution | medium | `required_conversation_resolution.enabled == true` | any `pull_request` rule with `required_review_thread_resolution: true` |
| 7 | Enforce for administrators | critical | `enforce_admins.enabled == true` | Every active ruleset has empty `bypass_actors` |
| 8 | Require signed commits | high | separate signatures endpoint `enabled == true` | `required_signatures` rule exists |
| 9 | Require linear history | medium | `required_linear_history.enabled == true` | `required_linear_history` rule exists |
| 10 | Force push disabled | critical | `allow_force_pushes.enabled == false` | `non_fast_forward` rule exists |
| 11 | Branch deletion disabled | critical | `allow_deletions.enabled == false` | `deletion` rule exists |
| 12 | Required status checks | critical | `required_status_checks.contexts` includes `"quality"` AND `"secret-scan"` (extra checks ok) | any `required_status_checks` rule whose contexts include both |

### Ruleset filtering semantics

- Only rulesets with `enforcement === "active"` AND `target === "branch"`
  (strictly — missing or non-branch targets are dropped) are considered.
- Include patterns: `refs/heads/main`, `~ALL`, `refs/heads/*`,
  `refs/heads/main*`, and `~DEFAULT_BRANCH` (resolved against repo metadata).
  Unknown patterns → ruleset dropped (fail-safe).
- Exclude patterns: any match OR any unknown → ruleset dropped (fail-closed).
- Multiple rulesets are unioned: a control passes if ANY clean (non-bypassed)
  active ruleset provides it. Within a ruleset, any matching rule works
  (weak-first/strong-second ordering is handled correctly).
- Bypass actors: rulesets with non-empty `bypass_actors` are excluded from
  non-admin controls. `admin_enforcement` fails if ANY active ruleset has
  `bypass_actors` (intersection — the most permissive wins for bypass).

### Collection completeness

A control only passes if evidence is collected without errors. Any collection
error entry in `_errors` → all 12 controls fail closed. This prevents
incomplete evidence (e.g. missing default_branch, malformed ruleset detail
bodies, failed ruleset-detail 404 fetches) from producing false-positive
passes.

## Running tests

```bash
node scripts/check-branch-governance.test.mjs
```

All synthetic evidence is embedded inline. 89 tests cover:
- Classic and ruleset full-positive and 12 individual-control negatives
- Bool-parameter weak-first/strong-second ordering (CODEOWNER, dismiss,
  last-push, conversation resolution)
- Status-checks parameter ordering (weak-first/strong-second)
- Min-value parameter ordering
- Tri-state ref matching (~ALL, ~DEFAULT_BRANCH, wildcard, unknown patterns)
- Target validation (tag, missing)
- Bypass actors (all controls excluded, mixed classic+bypassed)
- Excluded-main conditions
- All `_errors` entries fatal (401, 403, 404-detail, 429, 500, network, pagination)
- Collection malformation (missing default_branch, classic array, sigs null,
  detail array, non-numeric ruleset IDs)
- Offline structural validation (root shape, metadata required,
  metadata.default_branch type, per-entry _errors shape, per-entry rulesets
  shape, contradictory malformed + passing classic)
- Hostile origin lookalike rejection (self-href, Link header)
- Pagination exact query (`includes_parents=true&per_page=100`)
- Total collection timeout (injectable, hanging mock)
- >10 rule details without MaxListeners warnings
- GITHUB_REPOSITORY segment validation (1, 2, and 3 segments)
- Live CLI via injectable mock collector (zero network)
- Offline CLI via temp files (malformed JSON, valid JSON, missing file)
- Policy parity, redaction, path/slug leak checks
- Combined classic+ruleset and mixed clean/bypassed regression

## Security notes

- **Never share raw API output.** The raw evidence contains repository
  structure details. Share only the verifier's redacted JSON summary.
- The verifier **never prints**: tokens, `Authorization` headers, raw API
  bodies, error messages, file paths, or exception stacks.
- Raw API responses stay in memory only — **never persisted, never uploaded**.
- The uploaded evidence artifact contains only the redacted verifier summary.
- Do **not** store raw evidence JSON inside the repository.
- Do **not** embed tokens or credentials in evidence files.
- `GITHUB_REPOSITORY` must have exactly two `/`-separated segments. Both
  segments must match `^[a-zA-Z0-9._-]+$`. A third segment (or single segment)
  is rejected before any API call.
- Repository and branch in the output are always the literal `"redacted"`.
  User-controlled metadata values are never echoed.
