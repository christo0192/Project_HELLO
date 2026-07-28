# Project Handover

**Last updated:** 2026-07-28 09:45 UTC

**Repository:** `https://github.com/christo0192/Project_HELLO`

**Production status:** Pre-production; do not use real candidate data

**Roadmap source of truth:** [`PLAN.md`](../PLAN.md)

## Resume Here

PR #5 (SEC-09) is merged. The repository is on `main` at commit `ae2098b`.
SEC-07 (CORS + CSP) is in progress on branch `feat/sec-07-cors-csp`.

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
| SEC-09 security headers | Merged, acceptance pending | [PR #5](https://github.com/christo0192/Project_HELLO/pull/5), merged 2026-07-28. Code complete; Observatory B+ gate pending deployment. |
| SEC-07 CORS + CSP | In progress | Branch `feat/sec-07-cors-csp` |

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
(max-age=31536000; includeSubDomains) is set only when NODE_ENV=production.
`createApp()` accepts an optional `nodeEnv` parameter for testable HSTS
gating without mutating global `process.env`. NODE_ENV is registered in
the environment contract. PR #5 is merged; the code is complete but
acceptance is pending the Mozilla Observatory B+ score, which requires
deployed CSP (SEC-07) for a full evaluation.

SEC-07 (code foundation): CORS enforces exact canonical WEB_ORIGIN entries in
production (no trailing slash, path, query, hash, or credentials); localhost
fallback is non-production only; disallowed origins receive no
Access-Control-Allow-Origin (not a 500). CSP is emitted on dashboard HTML
responses via a Vite plugin using loadEnv/defineConfig, report-only by
default with exact enforce/report-only mode parsing. No unsafe-inline or
unsafe-eval. connect-src covers API, Supabase (REST + Realtime WSS), and
LiveKit (signalling WSS, required — no silent fallback to Supabase).
media-src includes blob: and Supabase for signed recording URLs. Origins
use standard URL.origin semantics (default ports omitted). LiveKit
accepts native ws(s):// or http(s)→ws(s) conversion. Injection vectors
(semicolons, control chars, wildcards, unsafe keywords) are rejected at
construction time. The 64 KiB CSP report endpoint validates legacy and
Reporting API shapes, requires document-uri plus a directive, returns
exact 413/400 under the stable error contract, and logs structured JSON
via console.warn with URL origins only (no paths/queries/fragments/
credentials/raw bodies). VITE_LIVEKIT_URL, VITE_CSP_MODE, and
VITE_CSP_REPORT_ENDPOINT are registered as required production controls.
NODE_ENV is requiredInProduction (exact production CORS and HSTS gate).
Vite preview is documented as non-production. A lightweight Node smoke
test asserts the CSP header on built preview HTML (scripts/smoke-test-csp.mjs).

Pending SEC-07 gates: real deployed HTML CSP header, real-browser
unapproved-origin CORS denial, approved media/connect smoke with enforced
CSP, owner-approved clean CSP report window, enforce deployment, and
Mozilla Observatory verification. These require deployment infrastructure;
the code foundation passes all automated tests (186 total: 63 validation +
123 CORS/CSP/policy).

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

Latest SEC-07 branch results:

- API TypeScript typecheck: passed.
- API tests: 186 passed (63 validation + 123 CORS/CSP/policy), covering:
  - CORS: exact match, no-trailing-slash rejection, no-Origin, preflight,
    production-vs-dev, webOrigin override, malformed config rejection
    (path, query, hash, credentials, non-http scheme, empty), config
    error never echoes raw value, NODE_ENV validation (reject invalid),
    production rejects loopback entries (localhost, 127/8, ::1, 0.0.0.0)
    even if explicitly in WEB_ORIGIN, production requires https (rejects
    http:// even for non-loopback), all production config errors are
    generic (never echo raw values).
  - CSP reports: legacy/Reporting API shapes, application/csp-report and
    application/reports+json content types, exact 413 oversized, exact 400
    malformed JSON, structured JSON log via console.warn, URL-origin-only
    logging, path/query/fragment stripping, credential stripping,
    control-char truncation, log injection via newline sanitised.
  - CSP policy construction: URL.origin semantics (default ports omitted),
    http→ws/https→wss conversion, ws/wss native pass-through,
    banned keywords rejected (unsafe-inline, unsafe-eval, strict-dynamic,
    wildcard, unsafe-hashes, report-sample), injection rejection,
    mode parsing, malformed endpoint → undefined, report-endpoint
    validation (absolute HTTP(S), path allowed, no credentials/query/
    fragment/semicolon), buildCspHeader canonical round-trip enforcement
    (rejects API/Supabase with path/query/hash/credentials, rejects
    non-canonical LiveKit), object-src 'none' included.
- Web TypeScript typecheck and lint: passed.
- Web production build: passed (CSP plugin uses loadEnv, matches HTML
  documents only, precomputes header at config resolution, fails on
  invalid mode/canonical origins, requires VITE_LIVEKIT_URL explicitly,
  blocks enforce mode on non-production Vite servers, requires both
  cached header and name — no fallback string).
- CSP smoke test (Node.js against vite preview): passed — CSP header
  present on HTML, no unsafe directives, object-src 'none' present,
  absent on JS assets; fails (exits 1) when no JS asset found in build.
- Environment contract: valid; NODE_ENV requiredInProduction=true.
- API dependency audit: passing (no vulnerabilities).
- Web dependency audit: passing (react-router excepted).
- Seeded dependency-policy tests: 33 passed.
- SBOM generation: CycloneDX 1.5 for API (273 components) and web (177 components).
- Environment contract: valid for api, web, voice-livekit.
- Seven ADR checks, LiveKit worker Python compilation: passed.
- Secret scan (`--committable`): passed.
- `git diff --check`: passed.

## Remaining Production Work

FND-04, FND-07, SEC-05, and SEC-10 are complete plan tasks. SEC-09 code is
merged (PR #5) with Observatory B+ pending. FND-01 is partial. SEC-07 code
foundation is in progress on branch `feat/sec-07-cors-csp`. All other P0
tasks in `PLAN.md` remain open unless a later handover explicitly marks them
complete.

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
- No rate limiting or CSRF decision (SEC-06, SEC-08).
- Unauthenticated CSP report endpoint has no rate limiting (pending SEC-06).
- CSP is foundation-only (SEC-07); deployed enforcement, real-browser
  denial test, and clean report window are pending.
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

Complete SEC-07: deploy with report-only CSP, evidence clean report window,
then enforce. The next independent engineering PR after SEC-07 merges should
implement SEC-08 (CSRF decision) or SEC-06 (rate limiting). SEC-01 through
SEC-04 follow the approved authentication and tenancy decisions.

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
