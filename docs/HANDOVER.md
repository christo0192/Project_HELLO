# Project Handover

**Last updated:** 2026-07-28 08:45 UTC

**Repository:** `https://github.com/christo0192/Project_HELLO`

**Production status:** Pre-production; do not use real candidate data

**Roadmap source of truth:** [`PLAN.md`](../PLAN.md)

## Resume Here

PR #4 (SEC-10) is merged. Branch `feat/sec-09-security-headers` is based on
`main` commit `6d75b5b`. SEC-09 security headers are in review in
[PR #5](https://github.com/christo0192/Project_HELLO/pull/5).

When resuming after the branch is merged:

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git log --oneline --decorate -8
gh pr list --state all --limit 10
cat docs/HANDOVER.md
```

## Completed Work

| Work | State | Evidence |
|---|---|---|
| Repository bootstrap | Complete | Initial private GitHub push, commit `f160dd2` |
| FND-01 repository setup | Partial | Git/CODEOWNERS/PR workflow exist; branch protection is unavailable on the current private GitHub plan |
| FND-04 environment contract | Complete | [PR #1](https://github.com/christo0192/Project_HELLO/pull/1), merged 2026-07-27 |
| FND-07 architecture decisions | Complete | [PR #2](https://github.com/christo0192/Project_HELLO/pull/2), merged 2026-07-27 |
| SEC-05 API input validation | Complete | [PR #3](https://github.com/christo0192/Project_HELLO/pull/3), merged 2026-07-28 |
| SEC-10 dependency policy | Complete | [PR #4](https://github.com/christo0192/Project_HELLO/pull/4), merged 2026-07-28 |
| SEC-09 security headers | In review | [PR #5](https://github.com/christo0192/Project_HELLO/pull/5) |

SEC-05 adds strict Zod schemas for accepted body, path, query, and multipart
field inputs; stable malformed/oversized request responses; sanitized unexpected
errors; real JSON and multipart size-limit tests; seeded property tests; and API
tests in the quality workflow.

SEC-10 adds lockfile-aware `npm audit` blocking on high/critical vulnerabilities in CI;
a per-GHSA+package exception registry with concrete owner, compensating control,
through-end-of-day-UTC expiry, review trigger, and project scoping; automated
architecture-invariant checks that invalidate stale exceptions; CycloneDX 1.5
SBOM generation and 90-day retention; deterministic seeded policy-violation
tests using synthetic audit fixtures (33 tests covering per-advisory severity,
package matching, inherited dependency chains, malformed audit data, exception
metadata and expiry, stale exceptions, architecture invariants, and cyclic
references); postcss remediated in the web lockfile (8.5.23); and react-router RSC
advisory excepted with an automated invariant guard and project scoping to
app/web.

SEC-09 adds Express middleware that sets X-Content-Type-Options (nosniff),
X-Frame-Options (DENY), Referrer-Policy (strict-origin-when-cross-origin),
and Permissions-Policy (camera/microphone/geolocation disabled) on every
response — including OPTIONS preflight, CORS-blocked, and error responses.
Express X-Powered-By is disabled. Strict-Transport-Security
(max-age=31536000; includeSubDomains) is set only when NODE_ENV=production,
keeping local development unaffected. NODE_ENV is registered in the
environment schema and example. Production deployment verification via
Mozilla Observatory (target: B+) is still pending and will likely require
coordination with the SEC-07 Content-Security-Policy implementation.
`createApp()` accepts an optional `nodeEnv` parameter so tests can verify
HSTS behaviour without mutating global `process.env`. SEC-09 remains incomplete
until the deployed endpoint reaches the required Mozilla Observatory B+ score.

## Current Verification

Run these commands from the repository root before merging or starting the next
task:

```bash
cd app/api && npm ci && npm run typecheck && npm test
cd ../web && npm ci && npm run lint && npm run build
cd ../..
node scripts/check-env-contract.mjs
node scripts/check-env-contract.test.mjs
node scripts/check-adrs.mjs
node scripts/audit-seeded-vuln.test.mjs
bash scripts/audit-deps.sh --dir app/api
bash scripts/audit-deps.sh --dir app/web
bash scripts/sbom.sh
./scripts/scan-secrets.sh --committable
git diff --check
```

Latest SEC-09 branch results:

- API TypeScript typecheck: passed.
- API tests: 63 passed, including GET, HEAD, preflight, malformed-request,
  CORS-error, sanitized-500, HSTS-gating, and fingerprint-suppression coverage.
- API dependency audit: passing (no vulnerabilities, no stale exceptions).
- Web lint and production build: passed.
- Web dependency audit: passing with a documented exception for react-router
  (GHSA-qwww-vcr4-c8h2, RSC CSRF bypass — not exploitable in Vite SPA;
  architecture invariant guard active). Postcss remediated to 8.5.23.
- Seeded dependency-policy tests: 33 passed, covering accepted and rejected
  advisories, exception validation and expiry, malformed audit shapes, direct
  and inherited vulnerabilities, architecture invariants, and cyclic references.
- SBOM generation: CycloneDX 1.5 for API (273 components) and web (177 components).
- Environment contract, negative contract tests, seven ADR checks, and LiveKit
  worker Python compilation: passed.
- Commit-eligible secret scan: passed.
- `git diff --check`: passed.

## Remaining Production Work

FND-04, FND-07, SEC-05, and SEC-10 are complete plan tasks. FND-01 is partial,
and SEC-09 is in review in
[PR #5](https://github.com/christo0192/Project_HELLO/pull/5), with deployed
Mozilla Observatory B+ verification still pending. All other P0 tasks in
`PLAN.md` remain open unless a later handover explicitly marks them complete.

Immediate external blockers:

1. FND-02: rotate every credential currently present in ignored local
   environment files, record revocation evidence, and make the full working-tree
   secret scan clean. Never commit the local environment files.
2. FND-01: upgrade the GitHub plan or approve an equivalent control so required
   reviews and branch protection can be enforced, not just followed by
   convention.
3. FND-08: assign accountable Product, Legal, Security, and Engineering owners;
   approve tenancy, residency/data flow, RPO/RTO, launch capacity, and the open
   D-001 through D-011 decisions.
4. FND-03: sanitize or permanently quarantine ignored prototype evidence and
   complete PII/DLP review.

In parallel, the repository owner must complete the FND-02 credential rotations
and drive FND-08 decisions. Authentication and tenancy work should not begin
until D-001 and D-011 have approved owners and outcomes.

Highest-risk engineering gaps:

- No recruiter authentication, MFA, RBAC, tenant isolation, or candidate invite
  exchange (SEC-01 through SEC-04).
- No rate limiting, exact production CORS/CSP policy, or CSRF decision (SEC-06 through SEC-08).
- The web build retains a known chunk-size warning.
- Sensitive candidate/resume/rubric context is still placed in client-visible
  LiveKit metadata (SEC-13).
- Resume and browser recording uploads are unauthenticated and memory-buffered;
  recording accepts up to 100 MB and signed URLs last one year (SEC-14 and
  REC-01 through REC-05).
- Production Supabase isolation, RLS/storage policy, backup/PITR, migration,
  queue/idempotency, observability, privacy governance, security testing,
  deployment, load testing, and launch approval are still pending in Phases
  2 through 12.

## Next Step

After SEC-09 is merged, the next independent engineering PR should implement
SEC-07 (exact CORS and CSP). SEC-01 through SEC-04 follow the approved
authentication and tenancy decisions.

## Working Rules

- Use `christo0192 <christo.b@interviewkickstart.com>` for repository commits.
- Create one scoped branch and pull request per plan outcome; the repository
  owner reviews and merges manually.
- Never add ignored `.env`, media, prototype evidence, raw exports, or candidate
  data with forced Git options.
- Use synthetic test data only.
- Run `./scripts/scan-secrets.sh --committable` before every commit.
- Update this file whenever a PR is opened or merged, a blocker changes, or the
  recommended next task changes.
