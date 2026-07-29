# Project Handover

**Last updated:** 2026-07-29

**Current branch:** `feat/rel-05-06-provider-resilience` (worktreed from `fd58f81` / PR #13, not yet merged to `main`)

**Repository:** `https://github.com/christo0192/Project_HELLO`

**Production status:** Pre-production; do not use real candidate data

**Roadmap source of truth:** [`PLAN.md`](../PLAN.md)

## Resume Here

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git log --oneline --decorate -10
gh pr list --state all --limit 10
cat docs/HANDOVER.md
```

## Defensible Metrics

| Metric | Value |
|--------|-------|
| Completed launch gates | 0/17 — all FND-02, FND-03, and REL acceptance criteria remain unverified at production level |
| Implementation coverage | REL-05/REL-06 code + tests exist on branch; strict acceptance is separate from implementation coverage |
| Branch base | `fd58f81c184af7ae7b15138537ff735070d116ad` (PR #13 FND-02/FND-03) |
| Branch state | In progress; not merged |

> **Note:** The 25% completion figure sometimes seen in earlier summaries is NOT claimed. Zero launch gates are confirmed complete. Implementation coverage and acceptance verification are distinct gates.

## Completed Work

| Work | Plan task | State | Evidence |
|---|---|---|---|
| Repository bootstrap | FND-01 | Repository controls merged; hosted enforcement blocked | CODEOWNERS, review template, documented ruleset exist. GitHub returned HTTP 403 when branch protection was applied; the private-plan tier does not support it. See `.github/BRANCH_PROTECTION.md`. |
| Environment configuration contract | FND-04 | Complete | PR #1, merged 2026-07-27 |
| Architecture decisions (ADR) | FND-07 | Complete | PR #2, merged 2026-07-27. Seven ADRs in `docs/adr/`. |
| API input validation | SEC-05 | Complete | PR #3, merged 2026-07-28 |
| Dependency vulnerability policy | SEC-10 | Complete | PR #4, merged 2026-07-28 |
| Security headers | SEC-09 | Code complete; Observatory B+ pending deployment | PR #5, merged 2026-07-28 |
| CORS + CSP foundation | SEC-07 | Code complete; deployment-gated | PR #6, merged 2026-07-29. Automated API CORS tests + built-HTML CSP smoke pass locally. CSP is report-only. Real-browser denial test, clean CSP report window, and Observatory B+ require deployment. |
| OCI managed-services Terraform foundation | Infrastructure | Code merged; apply-gated | PR #7 (`e8584b0`), merged 2026-07-29. Scaffold only; `terraform apply` has not been run. |
| OCI region benchmark harness | Infrastructure | Code merged; not yet measured | PR #8 (`726ce56`), merged 2026-07-29. Harness and fail-closed runbook exist; no benchmark data has been collected. |
| Supabase local baseline | MIG-03 / partial MIG-04 | Code merged; production apply pending | PR #9 (`4d103ea`), merged 2026-07-29. Unused Mumbai project exists but MIG-01/MIG-02 admin acceptance pending; this is MIG-03/partial MIG-04. Membership-gated RLS and local validation; MIG-01/MIG-02 administrative acceptance plus controlled production connection/application and MIG-13 cutover are future gates. |
| Provider resilience foundation | REL-05, REL-06 | Code complete on `feat/rel-05-06-provider-resilience`; **not merged, not deployed** | Circuit breaker (closed/open/half-open), hardened Node claude runner (shell:false, runtime validation, stdin EPIPE handling, two-phase settle state machine, stable stream-error categories, non_zero_exit counted by breaker, platform-safe kill), Python scoring HTTP with explicit timeouts/lazy transport/async close, circuit_open distinct category, BusinessError resets consecutive failures, closed reason-code mapping for fail_session. Local validation passed: API 274 tests, provider-resilience API 88 tests, Python 98 tests. See `docs/runbooks/provider-resilience.md` for gaps (SDK-internal calls not controlled, no pinned Python requirements, no reconciliation/deployed proof).
**Prospective PR:** assigned by GitHub on merge. This row will be updated when the PR is opened/merged. |

CI on `main` at `4d103ea`: Quality, Secret scan, and Supabase checks all passed on 2026-07-29.

The following PRs are merged into the current branch `feat/rel-05-06-provider-resilience` (based on `fd58f81`):
- PR #10 (docs: Phase-0 governance status)
- PR #11 (docs: FND-08 technical directions)
- PR #12 (FND-01 branch-governance evidence verifier — completed-tooling)
- PR #13 (FND-02/FND-03 — eight-provider rotation evidence, seven-group sanitization — completed-tooling)

PR #12 and #13 add deterministic CI checks for branch governance and secret/PII sanitization. Acceptance remains blocked on hosted enforcement (FND-01) and owner-rotation evidence (FND-02).

## Phase-0 Foundation Status (FND-01, FND-02, FND-03)

These tasks were defined as first-commit gates; after the documented bootstrap exception, they remain production-acceptance blockers. Assessed in `docs/repository-inventory.md`
and `docs/security/credential-inventory.md`. See also `CONTRIBUTING.md` for the
external-blockers summary.

| Task | Code / merge state | Acceptance state |
|---|---|---|
| FND-01 | Repository controls merged | **Blocked**: hosted enforcement blocked — private-plan GitHub API returned 403 |
| FND-02 | Scanner controls merged | **Blocked**: owner rotation evidence pending for eight provider systems; non-secret revocation evidence required |
| FND-03 | Containment controls merged | **Blocked**: sanitization, synthetic, and restricted-storage disposition pending |

## Current Verification

```bash
# API (Node)
cd app/api && npm ci && npm run typecheck && npm test
# Provider-resilience specific (deterministic, no real CLI)
npx vitest run src/__tests__/provider-resilience.test.ts

# Web
cd ../web && npm ci && npm run lint && npm run build
cd ../..

# Contracts, ADRs, audits
node scripts/check-env-contract.mjs
node scripts/check-env-contract.test.mjs
node scripts/check-adrs.mjs
node scripts/audit-seeded-vuln.test.mjs
bash scripts/audit-deps.sh --dir app/api
bash scripts/audit-deps.sh --dir app/web
bash scripts/sbom.sh

# Python compile + tests (no external deps required for stdlib tests)
python3 -m py_compile app/voice-livekit/provider_resilience.py app/voice-livekit/persistence.py
python3 -m pytest app/voice-livekit/tests/test_provider_resilience.py -v --tb=short

# Security
./scripts/scan-secrets.sh --committable
git diff --check
```

### Current Test Counts
| Suite | Count | Notes |
|---|---|---|
| API (Node) | **274 tests** (239 full suite + 35 new/adversarial) | 88 provider-resilience (53 breaker/collectBounded + 35 ClaudeRunner/race/validation) + 186 validation/security |
| Provider resilience (Python) | **98 tests** (54 original + 44 adversarial/transport/classification) | Uses `python3 -m unittest`; no httpx dependency for unit tests using FakeTransport — httpx only needed for tests that exercise `trigger_scoring()` (TestTriggerScoringBreakerOpen). No pinned `requirements.txt` / `pyproject.toml` — gap for future PR. |

## Remaining Production Work

Most remaining P0 tasks in `PLAN.md` Phases 1–12 remain open. The most urgent blockers are:

1. **FND-02 credential rotation**: An authorized account owner must rotate every provider credential listed in `docs/security/credential-inventory.md` and provide non-secret revocation evidence. Deleting local `.env` files does not count.
2. **FND-01 branch protection**: Requires a GitHub plan upgrade or equivalent control approved by the repository owner. Documented rules are not enforced.
3. **FND-03 disposition**: Quarantined candidate artifacts require synthetic replacement and disposition of originals into approved restricted storage with evidence.
4. **FND-08 policy inputs**: Technical directions selected but owners, approvals, residency, RPO/RTO, and open decisions pending.

Engineering work on authentication, tenancy, and authorization (SEC-01 through SEC-04)
must not start until D-001 and D-011 have approved owners and outcomes.

Highest-risk unaddressed gaps:
- No recruiter authentication, MFA, RBAC, tenant isolation, or candidate invite exchange (SEC-01–SEC-04)
- No rate limiting or CSRF decision (SEC-06, SEC-08)
- LiveKit metadata leaks candidate/resume/rubric context (SEC-13)
- Resume and recording uploads are unauthenticated and memory-buffered (SEC-14, REC-01–REC-05)
- Production Supabase auth, RLS, storage, backup, and migration: full hosted acceptance pending (Phases 2–12)

## Working Rules

- Use `christo0192 <christo.b@interviewkickstart.com>` for repository commits.
- Create one scoped branch and pull request per plan outcome; the repository owner reviews and merges manually.
- Never add ignored `.env`, media, prototype evidence, raw exports, or candidate data with forced Git options.
- Use synthetic test data only.
- Run `./scripts/scan-secrets.sh --committable` before every commit.
- Update this file whenever a PR is opened or merged, a blocker changes, or the recommended next task changes.
