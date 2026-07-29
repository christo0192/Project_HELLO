# Branch Governance Evidence Runbook

## Overview

This runbook describes how to collect, verify, and interpret branch-protection
evidence for the `main` branch. The verifier is **offline and read-only** — it
never calls the GitHub API directly. It reads a local JSON evidence snapshot
and reports which controls are enforced.

## Prerequisites

- Node.js 22+
- GitHub personal access token with `repo` scope (for collecting evidence)
- `gh` CLI (installed and authenticated) OR `curl` with a token

## Step 1: Collect evidence JSON manually

### Option A — Using `gh` CLI

```bash
# Set variables
OWNER="christo0192"
REPO="Project_HELLO"
BRANCH="main"

# Fetch classic branch protection
gh api "/repos/${OWNER}/${REPO}/branches/${BRANCH}/protection" \
  > branch-protection-classic.json 2>/dev/null || echo '{}' > branch-protection-classic.json

# Fetch rulesets
gh api "/repos/${OWNER}/${REPO}/rulesets" \
  > rulesets.json 2>/dev/null || echo '[]' > rulesets.json
```

### Option B — Using `curl`

```bash
OWNER="christo0192"
REPO="Project_HELLO"
BRANCH="main"
TOKEN="ghp_..." # Your token

# Classic protection
curl -s -H "Authorization: Bearer ${TOKEN}" \
  "https://api.github.com/repos/${OWNER}/${REPO}/branches/${BRANCH}/protection" \
  > branch-protection-classic.json

# Rulesets
curl -s -H "Authorization: Bearer ${TOKEN}" \
  "https://api.github.com/repos/${OWNER}/${REPO}/rulesets" \
  > rulesets.json
```

### Option C — Using project's collector script

If a collector script exists in `scripts/`, run:

```bash
bash scripts/collect-branch-evidence.sh
```

## Step 2: Assemble the evidence JSON

Create `.github/branch-governance-evidence.json` with this structure:

```json
{
  "metadata": {
    "repository": "christo0192/Project_HELLO",
    "branch": "main",
    "fetched_at": "2026-07-29T12:00:00Z",
    "error": null
  },
  "classic_branch_protection": <contents of branch-protection-classic.json>,
  "rulesets": <contents of rulesets.json>
}
```

If the API returned an error (e.g., 403), set the `error` field instead:

```json
{
  "metadata": {
    "repository": "christo0192/Project_HELLO",
    "branch": "main",
    "fetched_at": "2026-07-29T12:00:00Z",
    "error": {
      "status": 403,
      "message": "Forbidden — private repository plan does not include branch protection"
    }
  },
  "classic_branch_protection": null,
  "rulesets": []
}
```

**⚠️  Security:** Never commit the raw API output if it contains your token.
The `Authorization` header is not stored in the API response, but exercise
caution. The verifier **never prints raw API bodies or tokens**.

## Step 3: Run the verifier

### Default path

```bash
node scripts/check-branch-governance.mjs
```

This reads `.github/branch-governance-evidence.json` by default.

### Custom path via environment variable

```bash
INFORMER_PATH=/path/to/evidence.json node scripts/check-branch-governance.mjs
```

### Custom path via CLI argument

```bash
node scripts/check-branch-governance.mjs /path/to/evidence.json
```

## Step 4: Interpret the results

### Exit code 0 — All controls ENFORCED

Output (stdout):

```json
{
  "repository": "christo0192/Project_HELLO",
  "branch": "main",
  "passed": true,
  "controls": {
    "require_pull_requests": { "enforced": true, "source": "classic" },
    "require_two_approvals": { "enforced": true, "source": "classic", "details": 2 },
    ...
  },
  "summary": "ALL 12 controls ENFORCED"
}
```

### Exit code 1 — One or more controls NOT ENFORCED

Output (stderr):

```json
{
  "repository": "christo0192/Project_HELLO",
  "branch": "main",
  "passed": false,
  "controls": {
    "require_two_approvals": { "enforced": false, "reason": "not enforced via classic or ruleset" },
    ...
  },
  "summary": "FAILED: 2 of 12 controls NOT ENFORCED"
}
```

### Exit code 2 — Input error

The evidence file is missing, malformed, or unreadable.

## Controls verified

| # | Control | Severity | Classic field | Ruleset type |
|---|---------|----------|---------------|--------------|
| 1 | Require PRs before merging | critical | `required_pull_request_reviews` | `required_pull_request` |
| 2 | Require 2 approvals | critical | `required_approving_review_count >= 2` | `required_pull_request.required_approving_review_count >= 2` |
| 3 | Require CODEOWNER review | critical | `require_code_owner_reviews` | `required_pull_request.require_code_owner_review` |
| 4 | Dismiss stale approvals | high | `dismiss_stale_reviews` | `required_pull_request.dismiss_stale_reviews_on_push` |
| 5 | Require last push approval | high | `require_last_push_approval` | `required_pull_request.require_last_push_approval` |
| 6 | Require conversation resolution | medium | `required_conversation_resolution.enabled` | `required_conversation_resolution` |
| 7 | Enforce for administrators | critical | `enforce_admins.enabled` | `bypass_allowances` (empty) |
| 8 | Require signed commits | high | `required_signatures.enabled` | `required_signatures` |
| 9 | Require linear history | medium | `required_linear_history.enabled` | `non_fast_forward` |
| 10 | Force push disabled | critical | `allow_force_pushes.enabled = false` | `allow_force_pushes.allow_force_pushes = false` |
| 11 | Branch deletion disabled | critical | `allow_deletions.enabled = false` | `deletion` rule exists |
| 12 | Required status checks | critical | `required_status_checks.contexts` | `required_status_checks.required_status_checks` |

## Current status (2026-07-29)

As documented in `.github/BRANCH_PROTECTION.md`, GitHub returned HTTP 403 when
branch protection was applied. The current private-repository plan does not
include the ruleset feature. **FND-01 remains blocked** until hosted
enforcement (private-plan upgrade or equivalent) is confirmed AND the `quality`
and `secret-scan` status checks are enforced on `main`, AND direct pushes to
`main` are rejected.

## Security notes

- **Never share raw API output.** The evidence JSON may contain your
  repository structure, which is sensitive.
- The verifier outputs a **redacted summary only** — no raw API bodies,
  no tokens, no Authorization headers.
- If you need to share results, share the JSON output from the verifier
  (stdout or stderr), not the raw evidence file.
- Store the evidence file with restricted file permissions:
  ```bash
  chmod 600 .github/branch-governance-evidence.json
  ```

## Running tests

```bash
node scripts/check-branch-governance.test.mjs
```

This runs 15 tests: 1 positive (all enforced), 13 negative (various failures),
and 1 secret-leak detection test. All tests must pass before committing changes
to the verifier.
