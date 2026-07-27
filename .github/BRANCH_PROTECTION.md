# Main Branch Protection

This file defines the required hosted-repository settings for FND-01. It does
not apply them automatically. The bootstrap owner is `@christo0192`; the
Engineering Lead must add company-controlled teams when available and record the
ruleset URL or exported evidence in the launch evidence store.

## Required settings for `main`

- Require pull requests before merging.
- Require two approvals, including one valid CODEOWNER approval.
- Dismiss stale approvals when new commits are pushed.
- Require approval of the most recent reviewable push.
- Require every review conversation to be resolved.
- Require signed commits and linear history.
- Block force pushes and branch deletion.
- Apply the rules to administrators; bypass is limited to a named break-glass
  role and every use must be audited.
- Require successful status checks. Add each check only after its workflow is
  merged and has reported at least once:
  - `quality`
  - `secret-scan`
  - `dependency-review`
  - `migration-check`
- Require deployments to the production environment to use a separate,
  reviewer-approved environment gate.

## Review rules

- The author cannot approve their own change.
- Security-sensitive changes require both Engineering and Security owners.
- Database migrations include forward behavior, recovery behavior, and a
  rehearsal result.
- Production configuration changes contain variable names only. Secret values
  must be injected by the approved secret manager.
- Exceptions name an owner, compensating control, expiry date, and approval.

## First-commit gate

Do not create or push the first commit until FND-02 and FND-03 are complete:
all discovered credentials have been rotated, secret scanning is clean, and
candidate PII/evidence has been removed or replaced with approved synthetic data.

The repository owner authorized a one-time bootstrap push on 2026-07-27 after
the commit-eligible tree passed redacted secret and PII checks. Account-side
credential rotation and quarantined local evidence remain open production gates.
