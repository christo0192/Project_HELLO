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
- Apply the rules to administrators. Rulesets must have zero bypass_actors.
  Break-glass access, if required, must be managed through an audited out-of-band
  process, not through GitHub ruleset bypass permissions.
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

The offline verifier in `scripts/check-branch-governance.mjs` reads a local
GitHub API evidence snapshot (`$INFORMER_PATH` or
`.github/branch-governance-evidence.json`) or runs in live mode when
`GITHUB_TOKEN` is set, and reports which of the 12 required controls in
`.github/branch-governance-policy.json` are enforced.

- **Exit 0:** All controls ENFORCED.
- **Exit 1:** One or more controls NOT ENFORCED (fail-closed).
- **Exit 2:** Input malformed, file not found, or parse error.

**FND-01 remains blocked** until hosted enforcement (GitHub private-plan
upgrade or equivalent) is confirmed AND the `quality` and `secret-scan` status
checks are enforced on `main`, AND direct pushes to `main` are rejected.
The verifier is an evidence-collection tool — it does not enforce anything.

See `docs/runbooks/branch-governance-evidence.md` for the collection and
interpretation runbook.
