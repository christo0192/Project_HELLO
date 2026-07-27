# Contributing

`PLAN.md` is the production-readiness source of truth. Reference its task ID in
every pull request and keep changes scoped to one reviewable outcome.

## Repository rules

1. Never commit `.env` files, credentials, provider keys, production project
   identifiers, candidate PII, recordings, generated scorecards, or raw exports.
2. Use synthetic data in tests, docs, screenshots, and demos.
3. Work on a branch and merge through a reviewed pull request. Direct pushes to
   `main` are prohibited once the company-controlled remote is configured.
4. Add or update tests for behavior changes. Security-sensitive changes must
   include negative authorization tests.
5. Use forward-only database migrations in production. Document recovery and
   rehearse data-affecting migrations in an isolated environment.
6. Keep production secrets in the approved secret manager and expose only the
   minimum variable names described by the configuration contract.

The repository owner authorized a one-time bootstrap push on 2026-07-27 after
the commit-eligible tree passed redacted secret and PII checks. Account-side
credential rotation and quarantined evidence remain production blockers.
