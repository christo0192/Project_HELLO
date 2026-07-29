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

## Dependency policy (SEC-10)

Every PR is audited for high and critical npm vulnerabilities in CI. A
lockfile-aware scan runs on pull requests and pushes to main; findings that
are not covered by a non-expired exception block the build.

### Accepting an exception

Add an entry to `.github/audit-exceptions.json`. Every entry **must** include:

| Field | Requirement |
|---|---|
| `id` | GHSA advisory ID (e.g. `GHSA-xxxx-xxxx-xxxx`) |
| `package` | npm package name |
| `owner` | Accountable team or person |
| `rationale` | Why the CVE is not exploitable in this project |
| `compensating_control` | Architecture or operational control that prevents exploitation; prefer automated invariants |
| `expiry` | UTC date in `YYYY-MM-DD` form (e.g. `2026-10-01`). The exception is valid through the end of that date. Exceptions are never permanent. |
| `review_trigger` | Concrete condition that should cause re-evaluation (e.g. version upgrade, feature introduction) |
| `projects` | Optional non-empty array limiting the exception to specific project paths, such as `app/web` |

Exceptions are matched **per advisory** (not per package). If one package has
three CVEs and only two are excepted, the third still blocks CI.

Expired or stale exceptions fail the policy check and must be removed or renewed.
An exception can also be invalidated before expiry if a CI invariant check fails
(e.g. the react-router RSC exception is invalidated if
`react-router.config.ts` appears).

### SBOM

A CycloneDX 1.5 Software Bill of Materials is generated for the API and web
projects on pull requests and pushes to `main`, then retained as a build artifact
for 90 days. Run `bash scripts/sbom.sh` locally to preview.

The repository owner authorized a one-time bootstrap push on 2026-07-27 after
the commit-eligible tree passed redacted secret and PII checks. Account-side
credential rotation and quarantined evidence remain production blockers.

## External blockers (Phase 0)

Phase-0 Foundation tasks: FND01 repository controls merged/hosted enforcement blocked; FND02 scanner controls merged/owner rotation evidence pending; FND03 containment controls merged/sanitization+synthetic+restricted-storage disposition pending. Each requires owner action outside the working tree and cannot close solely through additional implementation code.

| Blocker | Plan task | Required action | Evidence needed |
|---------|-----------|-----------------|-----------------|
| Branch protection not enforced | FND-01 | GitHub private-plan upgrade or equivalent control approved by repository owner | Ruleset URL or exported settings evidence; status checks enforced on `main` |
| Credential rotation pending (6 providers) | FND-02 | Authorized owner rotates each credential in-provider | Non-secret revocation evidence per provider (audit log, rotation timestamp, or old-credential-rejection test) |
| Candidate artifacts not sanitized | FND-03 | Synthetic replacements authored for all quarantined media | Shareable synthetic assets committed; original evidence dispositioned to approved restricted storage with evidence |

See `docs/repository-inventory.md` for per-task detail and
`docs/security/credential-inventory.md` for the per-provider rotation table.

`PLAN.md` is the production-readiness source of truth. These blockers must be
resolved before FND-01, FND-02, and FND-03 can be marked complete.

## Phase-0 evidence CI workflow

The repository includes a CI workflow (`.github/workflows/phase0-evidence-ci.yml`)
that validates the evidence example and runs deterministic tests on every pull
request and push to `main`. The workflow:

1. Validates `config/phase0-evidence.example.json` (expected exit 2 — valid
   shape but incomplete). Does not fail on exit 2.
2. Runs `scripts/check-phase0-evidence.test.mjs` (fails on non-zero).
3. Runs gitleaks secret scan.
4. Runs `git diff --check` for whitespace issues.

Real evidence manifests (`config/phase0-evidence.json`) are gitignored and
must be validated locally before acceptance review.
