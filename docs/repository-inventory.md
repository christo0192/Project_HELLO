# Repository Inventory

**Evidence date:** 2026-07-29

**Plan tasks:** FND-01, FND-02, FND-03

**State:** Bootstrap pushed to private GitHub `main` at `4d103ea` (PRs #1–#9 merged).
Phase-0 Foundation code is merged; acceptance is externally blocked on all three
tasks. See `CONTRIBUTING.md` for the external-blockers summary.

## Maintained product areas

| Path | Purpose | Runtime |
|------|---------|---------|
| `app/api/` | Express/TypeScript API and assessment services | Node.js |
| `app/web/` | Recruiter dashboard and browser LiveKit client | React/Vite |
| `app/voice-livekit/` | Current LiveKit voice agent | Python |
| `app/supabase/` | Current database migrations | PostgreSQL |
| `app/voice/` | Previous Pipecat voice implementation retained during migration | Python |
| `config/` | Current-state manifest and schema; environment schema | JSON |
| `scripts/` | Drift checkers, contract validators, test suites | JavaScript |
| `docs/` | Architecture, handover, and prototype evidence | Documentation/media |
| `_archive/v1-retell/` | Archived Retell implementation; quarantined from Git pending review | Mixed |
| `.gsd/` | Historical planning state; quarantined and superseded by `PLAN.md` | Documentation |

## Local-only and generated paths

The root `.gitignore` excludes nested `.env` files, virtual environments,
`node_modules`, build output, caches, logs, uploads, exports, recordings, and
common key/container formats. Existing nested ignore files remain in place.

The following known artifacts are quarantined from Git pending FND-02/FND-03
review and must not be committed in their current form:

- Local environment files under current and archived services.
- `docs/HELLO.html`, `docs/HELLO.md`, and `docs/hello-assets/`.
- Generated PDFs and audio/video files, including voice samples.
- Archived implementations, stale `.gsd` state, the superseded rebuild plan,
  and candidate-specific handover notes.
- Python bytecode, virtual environments, Node dependencies, and web build output.

## Phase-0 Foundation status

### FND-01 — Git monorepo, branch protection

- **Code / merge:** Repository controls merged. `.gitignore`, `CODEOWNERS`, pull-request template,
  documented review rules, and this inventory are merged.
- **Acceptance:** **Blocked.** GitHub returned HTTP 403 when branch protection
  was applied; the private-repository plan does not include the ruleset feature.
  The rules in `.github/BRANCH_PROTECTION.md` are not enforced (hosted enforcement blocked).
  `PLAN.md` acceptance criterion *"protected remote is configured"* is not met.

### FND-02 — Secret/PII removal, credential rotation, gitleaks

- **Code / merge:** Scanner controls merged. Gitleaks pre-commit hook, CI secret-scan workflow,
  `.gitleaks.toml`, and seeded-secret test are merged. The committed tree passed
  a redacted scan with zero findings; CI secret-scan passed on `main` at `4d103ea`.
- **Acceptance:** **Blocked.** Credential rotation status for six provider
  systems (Supabase, LiveKit, Anthropic, Sarvam, Deepgram, Retell/ElevenLabs/
  Cartesia) is **owner verification pending**. Non-secret revocation evidence is
  required per provider (owner rotation evidence pending). See `docs/security/credential-inventory.md`.
  `PLAN.md` acceptance criterion *"old credentials are revoked"* is not met.

### FND-03 — Quarantine and sanitize demo artifacts

- **Code / merge:** Containment controls merged. Quarantined paths are excluded by `.gitignore`;
  `scan-secrets.sh` prunes media from working-tree scans to avoid unbounded
  detection. All committed `.env.example` files use synthetic placeholders.
- **Acceptance:** **Blocked.** Synthetic replacements for `docs/HELLO.html`,
  `docs/HELLO.md`, `docs/hello-assets/`, generated PDFs, and voice media have
  not been authored (sanitization+synthetic+restricted-storage disposition pending). Original evidence disposition and restricted-storage
  evidence are pending.
  `PLAN.md` acceptance criteria *"no real candidate data in shareable artifacts"*
  and *"original evidence retained only in approved restricted storage"* are
  not met.

## Recent merged infrastructure (not Phase-0 blockers)

| PR | Commit | Description | Production status |
|----|--------|-------------|-------------------|
| #7 | `e8584b0` | OCI managed-services Terraform foundation scaffold | Apply-gated; `terraform apply` not run |
| #8 | `726ce56` | OCI region benchmark harness and fail-closed runbook | NOT-YET-MEASURED; no benchmark data collected |
| #9 | `4d103ea` | Supabase production-safe baseline: membership-gated RLS, local validation | Production apply pending (MIG-01 not done) |

These PRs are code-merged but do not represent deployed or
provisioned infrastructure. They advance Phase 11 (Deployment/capacity) and
Phase 2 (Supabase migration) respectively; none unblock Phase-0 acceptance.
