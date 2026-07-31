# Phase 6 — Testing & CI/CD (TST-01..16)

**Evidence date:** 2026-07-31
**Scope:** local/synthetic, browser-only, pre-production. Branch: `feat/phase6-testing-ci` (unmerged working tree, PR1 lane L4 integration).

This runbook classifies every Phase 6 task (TST-01…TST-16) truthfully. It is an **implementation status** document: it never claims production acceptance. Launch gates remain **0/17**; accepted roadmap phases remain **0/14** (verified by `config/current-state.json` and `scripts/check-current-state.mjs`). No real E2E, measured load, DR/restore drill, deploy stage, SLSA signing, or hosted branch-protection enforcement is claimed anywhere in this PR.

---

## 1. Per-task classification

| ID | Class | What exists now (this PR) | Remaining external blocker (NOT fabricated) |
|----|-------|---------------------------|---------------------------------------------|
| TST-01 | **partial → build** | Coverage ratchet for API + web (`@vitest/coverage-v8`, fail-closed floors in `vitest.config.ts`); `test:coverage` scripts; scoring-determinism property tests (`scoring-determinism.test.ts`); coverage stage wired into `quality.yml`. Floors are **measured baselines** (see §3), not approvals. | Deployed-code coverage evidence on a real deployment target (external). |
| TST-02 | **partial → build** | OpenAPI 3.0.3 spec (`app/api/openapi/openapi.yaml`, 36 documented operations = route-inventory bijection) + live-handler contract tests (`contract-openapi.test.ts`, 47 tests) + queue message-schema contract (`contract-queue-schema.test.ts`, 13 tests). | Contract coverage of not-yet-built routes (e.g., Phase 7 recording routes) — PR2 extends the spec. |
| TST-03 | **partial → build** | Stitched integration test (`integration-session-flow.test.ts`, 8 tests): create→join→transcript→score happy + error paths over real routes/queue/outbox/assessment with emulated DB/provider. | Real browser/WebRTC/LiveKit-Credentials E2E (external). |
| TST-04 | **external-pending** | **Not built.** Playwright UI-navigation smoke with mocked LiveKit is a possible scaffold but is **not** shipped as TST-04 acceptance. | Real browser + WebRTC + LiveKit credentials = cost/provider; owner-gated. |
| TST-05 | **partial → build** | Offline deterministic SAST (`scripts/sast/analyzer.mjs` + `scripts/sast/rules.json` + `scripts/sast.sh`, 10 rules, repository-owned, zero network, no unpinned curl installer) + self-tests (`scripts/sast.test.mjs`: seeded unsafe fixtures prove red, safe/near-miss prove precision, multi-hit/zero-hit regressions, secret-shaped fixture proves the gitleaks boundary). Existing secret scan (gitleaks) unchanged. | DAST, container-image scan, staging penetration test (external, no maintained image/target). |
| TST-06 | **partial (strong)** | Privacy negative-controls already in the API suite (redaction/DSAR/consent) — untouched; contract tests re-assert auth/RBAC boundaries without weakening them. | Manual privacy review; legal-hold/backup-aging depth carried by Phase 7/external. |
| TST-07 | **existing (automated)** | web axe-core suite stays green (`npm test` 171 tests). | Lighthouse ≥90, manual AT, real-browser matrix (external, documented in `accessibility-testing.md`). |
| TST-08 | **external-pending** | None shipped; support matrix remains a documentation item. | Owner-approved support matrix/policy (external). |
| TST-09 | **external-pending** | `oci-benchmark-run` + `oci-benchmark-ci.yml` scaffold remains (NOT-YET-MEASURED). | Deployed target + k6/Artillery run (external). |
| TST-10 | **partial → build** | Local chaos harness (`support/chaos.ts` in-memory emulation of Supabase/LLM/LiveKit boundaries) + `chaos-failure-injection.test.ts` (22 tests): worker kills at lifecycle boundaries, DB/queue/provider/network faults, duplicate/reordered events, bounded-loss accounting, reconciliation + negative control. | Failure-injection against deployed infra (external). |
| TST-11 | **partial** | `migrate-export/reconcile/storage-manifest` + runbooks kept; TST-15 rehearsal adds clean-reset/roll-forward/restore proof (below). | Real restore/PITR drill against production backups (external, owner-gated). |
| TST-12 | **external-pending** | `incident-response.md`, `infra/oracle/**` documentation kept; no synthetic substitute. | Owner-gated incident/DR exercises (external). |
| TST-13 | **partial → build** | `quality.yml` adds coverage (TST-01), explicit contract/integration/chaos gate suites (TST-02/03/10), offline SAST (TST-05), migration rollback verifier (TST-15); `supabase-ci.yml` adds the TST-15 verifier and runs the rollback rehearsal in `supabase-test.sh`. | Staging deploy, E2E-on-staging, prod-approval, canary (external; no deployed environment exists). |
| TST-14 | **partial** | Lockfiles, SBOM generation (`sbom.sh`, CycloneDX 1.5), deterministic phase0 evidence, provenance checks kept. | SLSA signed provenance (external; no signing key/attestation infra). |
| TST-15 | **partial → build** | **Rollback/compatibility gate.** Forward-only strategy (no per-migration down files exist for 0001–0013 and none are invented): (a) offline contract-continuity + destructive-change detector `scripts/migrate-rollback.test.mjs` (470 statements classified, 0 RED on committed migrations; seeded negative fixtures and a file-level injected incompatible migration prove red); (b) dynamic clean-reset/roll-forward/restore rehearsal in `scripts/supabase-test.sh` (second `db reset` reproduces an identical 281-line schema inventory with zero drift). Rollback verification is explicitly distinct from reverse SQL, which remains unsupported. | Real backup/restore against a hosted project (external). |
| TST-16 | **partial** | `BRANCH_PROTECTION.md`, branch-governance policy-as-code + detectors, `.githooks/pre-commit` kept; no change to hosted enforcement. | **Hosted branch-protection enforcement is the FND-01 external blocker** — not applied, not faked. |

**Invariant:** nothing above implies a green launch gate. All 0/17 and 0/14 counts are preserved.

---

## 2. CI stages — before vs after

**Before (PR1):** `quality.yml` ran static manifest/ADR/env checks, API install+typecheck+test, API dependency audit, web install+lint+typecheck+test+build, CSP smoke, web audit, seeded dependency-policy test, SBOMs, LiveKit worker compile+test. `supabase-ci.yml` ran migrations+policy+seed+drift in `supabase-test.sh` plus static-security/SQL/gov checks.

**After (PR1, this branch):**

`quality.yml` adds:
1. API coverage ratchet (TST-01) — `npm run test:coverage`, fail-closed below committed floors.
2. Contract, integration, and chaos gate suites (TST-02/03/10) — explicit `vitest run` of the five new suite files (they also run inside `npm test`/coverage).
3. Web coverage ratchet (TST-01) — `npm run test:coverage`, fail-closed below committed floors.
4. Offline SAST + self-tests (TST-05) — `bash scripts/sast.sh && node scripts/sast.test.mjs`.
5. Migration rollback & compatibility verifier (TST-15, offline) — `node scripts/migrate-rollback.test.mjs`.

`supabase-ci.yml` adds:
1. `TST-15 migration rollback & compatibility verifier (offline)` in the static-security job.
2. `supabase-test.sh` runs the TST-15 static half **before** containers and the dynamic clean-reset/roll-forward/restore rehearsal **after** the seed/policy/SQL checks (second `db reset` → seed parity → drift re-check → 281-line inventory equality).
3. Path triggers extended for `scripts/migrate-rollback.test.mjs` and `docs/runbooks/phase6-*.md`.

New files in this lane: `scripts/migrate-rollback.test.mjs`, `scripts/sast/{analyzer.mjs,rules.json}`, `scripts/sast.sh`, `scripts/sast.test.mjs`, `scripts/__fixtures__/{migrate-rollback,sast}/`, `docs/runbooks/phase6-testing-ci.md`. Workflow files (`quality.yml`, `supabase-ci.yml`) and `scripts/supabase-test.sh` are lane-L4-owned; L1/L2/L3 files were applied from their patches and only integration-fixed where a test revealed an exact issue (see §4).

---

## 3. Coverage ratchet baselines (TST-01)

API (vitest/coverage-v8 **4.1.10**, clean run): statements 79.53%, branches 70.70%, functions 80.07%, lines 81.92% → committed floors 71/61/71/73 (L1: floor(clean)−1; the contract/integration/chaos suites raised the measured values well above the floors).

Web (vitest/coverage-v8 **4.1.10**, clean runs 59.38/51.18/59.14/63.30) → committed floors 58/50/58/62.

**L4 integration fix (documented):** L1 added `@vitest/coverage-v8@3.2.7` to web; that version's chain (`test-exclude → glob → minimatch → brace-expansion`) carries GHSA-mh99-v99m-4gvg (ReDoS) with **no fixed release** (`npm audit` `fixAvailable: upgrade @vitest/coverage-v8 to 4.1.10`), so `audit-deps.sh --dir app/web` failed closed. Within L1's allowed path (`app/web/package.json`/lock), web was aligned with API on `vitest@4.1.10` + `@vitest/coverage-v8@4.1.10`; 171 web tests still pass and both audits are green. The vitest-4 v8 provider counts ~2× branch points (799 vs 464) and slightly more lines, so the web floors were **re-measured on the new engine** (not aspirational) and are documented in `app/web/vitest.config.ts`. Branches floor moved 69→50 solely because the instrumenter counts more branch points; the ratchet still fails closed on any meaningful regression.

**Residual (unchanged):** API coverage includes all `src/**/*.ts` except tests/setup; `pg-adapter.ts`, real-provider/CLI routes and `src/index.ts` remain low-covered existing gaps. Ratchet sensitivity is aggregate (~a single 100+ statement well-covered module), by design.

---

## 4. Integration fixes made by L4 (within L1/L2/L3 allowed paths, test-revealed)

1. **Web vitest 4.1.10 upgrade** (`app/web/package.json` + `package-lock.json`, L1 path) — see §3. The audit gate (`bash scripts/audit-deps.sh --dir app/web`) revealed the exact issue; the only npm-provided fix is the major-version alignment.
2. **Web thresholds re-baseline** (`app/web/vitest.config.ts`, L1 path) — forced by the instrumenter change above; floors re-measured on the new engine.
3. **SAST analyzer bugs found during integration** (all inside the L4-created `scripts/sast/` + tests): (a) RegExp compiled without the `g` flag → `while (re.exec())` never advanced `lastIndex` and looped forever/OOM — fixed to `gsm` flags; (b) `Sync?` quantifier bug in the S002 rule (`execSync?` means "Syn + optional c") — fixed to `exec(?:Sync)?`; (c) S201 needed the `m` flag for per-line `^`; (d) single-file `--scan-dir` roots were silently skipped — file roots now supported; (e) default scan excludes `*.test.*`/`*.spec.*` files because tests legitimately exercise dangerous APIs as negative controls (fixtures are scanned explicitly by the self-tests). Regression tests added: multi-hit (3× `eval(`, 2× `execSync(` all reported; loop terminates) and zero-hit (near-miss fixture: zero findings, clean exit).
4. **Migration-verifier calibration** (L4-created `scripts/migrate-rollback.test.mjs`): guarded `DROP CONSTRAINT IF EXISTS` on **CHECK** constraints is the sanctioned replaceable data-guard pattern (0004→0006 evolution) and is allowed with type tracking; unguarded drops and UNIQUE/PK/FK drops stay RED. `DROP POLICY/TRIGGER/FUNCTION IF EXISTS` are sanctioned replaceable hardening; all real migrations 0001–0013 classify 0 RED.

---

## 5. Verifier commands (all run on this branch)

| Command | Result |
|---|---|
| `cd app/api && npm ci && npm run typecheck` | green |
| `cd app/api && npm test` | 24 files, **1120 tests** passed |
| `cd app/api && npm run test:coverage` | green (79.53/70.70/80.07/81.92 ≥ 71/61/71/73) |
| `cd app/api && npx vitest run src/__tests__/{contract-openapi,contract-queue-schema,integration-session-flow,chaos-failure-injection,scoring-determinism}.test.ts` | green (gate suites) |
| `cd app/web && npm ci && npm run lint && npm run test:typecheck && npm test` | green (171 tests) |
| `cd app/web && npm run test:coverage && npm run build` | green (59.38/51.18/59.14/63.30 ≥ 58/50/58/62; build clean) |
| `bash scripts/audit-deps.sh --dir app/api` / `--dir app/web` | green (valid exceptions only) |
| `python3 -m py_compile app/voice-livekit/{agent,persistence,prompting,observability,provenance,provider_resilience}.py` | green |
| `cd app/voice-livekit && python3 -m unittest discover -s tests -p 'test_*.py'` | 360 tests OK |
| `bash scripts/supabase-test.sh` | **exit 0** — migrations 0001–0013 apply, policy/seed/SQL tests pass, MIG-03 drift clean, TST-15 offline verifier RED on fixtures, second clean reset reproduces identical 281-line inventory with zero drift |
| `node scripts/migrate-rollback.test.mjs` | exit 0 (13 migrations, 470 statements, 0 RED; 14 in-memory self-tests; on-disk negative fixture flagged 4 RED) |
| `bash scripts/sast.sh && node scripts/sast.test.mjs` | green (10 rules; 16 self-tests incl. multi-hit/zero-hit regressions) |
| `node scripts/check-current-state.mjs` + `.test.mjs`; `check-phase0-2-build-status.*`; `check-env-contract.*`; `check-adrs.mjs`; `smoke-test-csp.mjs`; `audit-seeded-vuln.test.mjs`; `sbom.sh` | all green; **0/17 gates and 0/14 phases unchanged** |
| `git diff --check` | clean (see §6) |

---

## 6. Negative controls (each proven RED, then reverted where mutating)

1. **Coverage ratchet** (L1, documented in `phase6-l1-handoff.md`): excluding covered modules → gate red (statements 70.77% < 71) with all tests green; reverted. Single-line sensitivity probe documented (a line ≈ 0.03pt at this scale).
2. **Contract** (L2): in-process spec mutations (remove/add/ret-type a documented field) → red; file-level `session_id`→`session_identifier` rename → red; restored file-identical; re-run green.
3. **Chaos** (L3): reconciliation-disabled assertion flip → red; reverted; full suite green.
4. **TST-15 rollback**: (a) on-disk seeded incompatible migration (`scripts/__fixtures__/migrate-rollback/9001_incompatible_negative.sql`) flagged 4 RED findings in the normal verifier run; (b) file-level negative control: injected `9999_negative_control.sql` (`drop table screening_v2.candidates;`) into `app/supabase/migrations/` → verifier exit 1 (RED), file removed, verifier green again, migrations dir clean.
5. **SAST**: seeded unsafe fixtures (eval/exec/spawn-shell/subprocess-shell/os.system/exec-eval/pickle/shell-eval/curl-pipe) → analyzer exit 1 with findings; safe and near-miss fixtures → zero findings; multi-hit fixture → every occurrence reported; secret-shaped fixture → **not** flagged (SAST does not scan secrets/env — gitleaks boundary). All fixtures are permanent (non-mutating) negative controls.

---

## 7. External-pending register (truthful — no substitution claimed)

| Item | Status | Owner/blocker |
|---|---|---|
| TST-04 real browser+WebRTC+LiveKit E2E | not built | cost/provider; owner-gated |
| TST-05 DAST / container scan / staging pen test | not built | no maintained image/deployed target |
| TST-08 support matrix | not shipped | owner approval |
| TST-09 measured load (k6/Artillery) | not measured | no deployed target |
| TST-11 real restore/PITR drill | not run | DB Admin + owner change control |
| TST-12 incident-response exercise | not run | owner-gated |
| TST-13 staging deploy / prod approval / canary | not configured | no deployed environment |
| TST-14 SLSA signed provenance | not signed | signing infra/owner |
| TST-15 hosted backup/restore validation | not run | hosted project + owner approval |
| TST-16 hosted branch-protection enforcement | **FND-01 external blocker** | not applied, not faked |
| Reverse-SQL rollback (down migrations) | **not supported** | forward-only strategy; rehearsal is the sanctioned substitute |

---

## 8. Non-goals honoured

No staging/prod deploy stages; no hosted branch-protection application; no real E2E/WebRTC; no measured load; no DR/restore drill; no SLSA signing; no OpenAPI for not-yet-built routes; no fabricated approvals; no secrets/`.env`/real candidate data; no provider/cloud calls; no AI-attribution markers anywhere in this PR.
