# Main Branch Protection

This file defines the required hosted-repository settings for FND-01.

**⚠️  NOT ENFORCED.** GitHub returned HTTP 403 when branch protection was
applied; the current private-repository plan does not include the ruleset
feature. The settings below are documentation only until the plan is upgraded
or an equivalent control is selected and evidenced.

The bootstrap owner is `@christo0192`; the Engineering Lead must add
company-controlled teams when available and record the ruleset URL or exported
evidence in the launch evidence store.

## Required settings for `main`

- Require pull requests before merging.
- Require two approvals, including one valid CODEOWNER approval.
- Dismiss stale approvals when new commits are pushed.
- Require approval of the most recent reviewable push.
- Require every review conversation to be resolved.
- Require signed commits and linear history.
- Block force pushes and branch deletion.
- Apply the rules to administrators. Rulesets must have zero `bypass_actors`.
  Break-glass access, if required, must be managed through an audited
  out-of-band process, not through GitHub ruleset bypass permissions.
- Require successful status checks. Add each check only after its workflow is
  merged and has reported at least once:
  - `quality`
  - `secret-scan`
- Require deployments to the production environment to use a separate,
  reviewer-approved environment gate.

### Path-scoped checks

Additional checks (e.g. `dependency-review`, `migration-check`) may exist in
the repository but are NOT listed as required hosted checks because they are
path-scoped — they only trigger when specific files change and therefore do
not report on every pull request. Only `quality` and `secret-scan` are
always-present current checks suitable for required status enforcement.

## Review rules

- The author cannot approve their own change.
- Security-sensitive changes require both Engineering and Security owners.
- Database migrations include forward behavior, recovery behavior, and a
  rehearsal result.
- Production configuration changes contain variable names only. Secret values
  must be injected by the approved secret manager.
- Exceptions name an owner, compensating control, expiry date, and approval.

## First-commit gate

The repository owner authorized a one-time bootstrap push on 2026-07-27 after
the commit-eligible tree passed redacted secret and PII checks. Subsequent
commits and PRs (#1–#9) passed secret-scan and quality CI on `main`.

FND01 repository controls merged/hosted enforcement blocked; FND02 scanner controls merged/owner rotation evidence pending; FND03 containment controls merged/sanitization+synthetic+restricted-storage disposition pending:
- Credential rotation status for six provider systems is **owner verification
  pending** (see `docs/security/credential-inventory.md`).
- Synthetic replacements for quarantined candidate artifacts have not been
  authored; original evidence disposition is pending.

These are external owner actions; they cannot close solely through additional implementation code.

## Branch governance verifier (evidence-only)

The verifier in `scripts/check-branch-governance.mjs` supports two modes:
- **Live** (`GITHUB_TOKEN`): read-only collection from repo metadata
  (default branch), classic protection, separate required-signatures
  endpoint, ruleset list with `includes_parents=true&per_page=100` and
  pagination (up to 3 pages), and individual ruleset details. Inherited
  rulesets are included. Object endpoints and the ruleset-list array are
  type-checked; missing `default_branch`, malformed classic/signature fields,
  non-numeric ruleset IDs, and incomplete detail bodies produce collection errors. Hostile URL
  origins (lookalike hostnames) are rejected via exact `.origin` comparison.
  Raw responses stay in memory only — never persisted or uploaded.
- **Offline** (`$INFORMER_PATH` or CLI arg): reads a local evidence JSON file
  with full structural validation (root shape, metadata object required,
  metadata.branch must exactly match, per-entry `_errors` and `rulesets`
  shapes).

Collection errors of any kind (401, 403, 404 on ruleset detail, 429, 5xx,
network failure, malformed response, missing default_branch, non-object 200
body, non-numeric ruleset ID, pagination ambiguity, hostile URL origin,
total timeout) → all 12 controls NOT ENFORCED (fail-closed). Only 404 on
classic protection or required-signatures is treated as "control absent"
(not error).

Output is a fixed-schema redacted JSON summary. Repository and branch are
always the literal string `"redacted"`. Never prints tokens, Authorization
headers, raw API bodies, error messages, or file paths.

Exit codes: **0** all enforced, **1** not enforced (fail-closed), **2** input
or configuration error (including `GITHUB_REPOSITORY` with ≠ 2 segments).

**FND-01 remains blocked** until hosted enforcement (GitHub private-plan
upgrade or equivalent) is confirmed AND the `quality` and `secret-scan` status
checks are enforced on `main`, AND direct pushes to `main` are rejected.
The verifier is an evidence-collection tool — it does not enforce anything.

## Commit provenance verifier (compensating control)

**⚠️  DETECTION ONLY — does NOT prevent direct pushes.**

Because hosted branch protection is unavailable on the current private
repository plan, the provenance verifier in
`scripts/check-main-provenance.mjs` provides compensating governance by
detecting non-PR commits on `main` after the fact.

### Detection logic

Each commit pushed to `main` is classified:

| Classification | Condition | Verdict |
|----------------|-----------|--------|
| **Squash-merge PR** | 1 parent + `(#N)` in message | ✅ Accepted |
| **Direct push** | 1 parent, no PR reference | ❌ Rejected |
| **Merge commit** | 2+ parents | ❌ Rejected |
| **Root/error** | 0 parents or missing metadata | ❌ Rejected |

- **Squash-merge** is the accepted PR provenance. GitHub squash-merges
  produce a single-parent commit with `(#N)` in the message.
- **Merge commits** (GitHub merge-commit strategy) have 2+ parents and are
  always rejected, even if the message contains a PR reference.
- **Direct pushes** (no PR flow) produce 1-parent commits with no PR
  reference in the message and are rejected.
- **Rebase merges** (GitHub rebase-merge strategy) produce 1-parent commits.
  If they lack `(#N)` in every commit message, they are rejected as
  direct-push (fail-closed).

### How it works

1. **Monitor workflow** (`.github/workflows/branch-governance-monitor.yml`):
   On every push to `main`, the verifier reads the push event payload
   (`GITHUB_EVENT_PATH`) and runs `git rev-list` to enumerate all pushed
   commits. Each commit's parent count and message are checked for PR
   provenance.
2. **Output**: Fixed-schema redacted JSON — no SHA, no commit message, no
   repository name. Artifact uploaded on every run.
3. **Exit codes**: `0` = all commits have PR provenance; `1` = one or more
   commits lack PR provenance (detected, not prevented).
4. **Fail-closed**: Malformed event payload, missing `GITHUB_EVENT_PATH`,
   empty commit list, or `git rev-list` failure → exit code 1.

See `docs/runbooks/branch-governance-evidence.md` for the collection runbook.

## Free-tier alternatives considered and rejected

| Alternative | Rejection rationale |
|-------------|-------------------|
| **Git hooks (server-side)** | Not available on GitHub Free; no custom hook endpoint on `push` to `main` |
| **`git push` hook via Actions** | A workflow triggered on `push` runs *after* the push, not before — cannot prevent |
| **`pre-receive` hook** | Requires self-hosted runner with filesystem access; violates out-of-scope for self-hosting |
| **Branch protection via API + cron** | Would require write token and mutation, violating invariant 1 (Action cannot prevent) |
| **CODEOWNERS restriction** | Requires branch protection to enforce on `main`; not available on Free plan |
| **Require signed commits (UI)** | Uses classic protection — confirmed unavailable via 403 |
| **GitHub Pro/Team upgrade** | Paid tier — out of scope (free repository constraint) |
| **Public repo** | Out of scope (private repo required) |
| **External forge (GitLab, etc.)** | Out of scope (GitHub Free constraint) |

The only viable no-cost compensating control is **post-push detection** with
redacted evidence upload. This does **NOT** close FND-01; hosted-enforcement
rejection tests are still required.

## Residual limitations

1. The provenance verifier does **not** prevent direct pushes — it detects
   them after they land on `main`.
2. A squash-merge commit crafted with a fake `(#N)` in the message would
   pass the heuristic check (though this is unlikely from an adversarial
   direct push since the adversary would need to guess or know an existing
   PR number).
3. `GITHUB_EVENT_PATH` is only available in `push` event workflows. The
   verifier cannot run as a standalone API check.
4. The monitor workflow requires `fetch-depth: 0` for `git rev-list` to
   work across the full commit range.

See `docs/runbooks/branch-governance-evidence.md` for the collection runbook.
