# Credential and PII Inventory

**Evidence date:** 2026-07-29

**Plan tasks:** FND-02, FND-03

**State:** Code infrastructure merged (gitleaks, pre-commit, CI scan, seeded-secret test).
Credential rotation is **owner verification pending** and blocks FND-02 acceptance.
**FND-03 synthetic replacements are complete** — all 7 artifact groups have
deterministic, safe synthetic replacements under `docs/demo/`. The committed
tree is clean; CI secret-scan passed on `main` at `4d103ea`.

No credential values are recorded in this document. Local `.env` files are
excluded from Git. Non-secret revocation evidence is required for each system
before FND-02 can close.

FND-02 covers **8 provider systems**. Retell, ElevenLabs, and Cartesia are
tracked as three separate entries because each has an independent provider
account and credential lifecycle; the schema treats each as a separate
`provider` value.

| System | Known local locations | Required action | Rotation status |
|--------|-----------------------|-----------------|-----------------|
| Supabase | `app/api/.env`, `app/voice/.env`, `app/voice-livekit/.env`, archived server env | Rotate project/service/database credentials; update only approved local runtimes | Owner verification pending |
| LiveKit | `app/api/.env`, `app/voice-livekit/.env` | Rotate API key/secret; invalidate old grants | Owner verification pending |
| Anthropic | Current and archived voice env files | Rotate API keys | Owner verification pending |
| Sarvam | Current and archived voice env files | Rotate API keys | Owner verification pending |
| Deepgram | Previous and archived voice env files | Rotate API keys | Owner verification pending |
| Retell | Archived env files | Revoke or rotate; delete unused resources where approved | Owner verification pending |
| ElevenLabs | Archived env files | Revoke or rotate; delete unused resources where approved | Owner verification pending |
| Cartesia | Archived env files | Revoke or rotate; delete unused resources where approved | Owner verification pending |

## Planned R1 credentials

These are planned R1-only secrets, not provisioned credentials and not evidence
of rotation. Values must never be recorded here. Their implementation and
rotation procedure are tracked in the R1 design/runbook.

| System | Planned secret names / scope | Required action | Rotation status |
|--------|------------------------------|-----------------|-----------------|
| Cloudflare R2 R1 recording | `R1_RECORDING_S3_*` on `project-hello-api` only | Use bucket-scoped credentials for the private R1 recording bucket; rotate with zero live R1 rooms | Planned |
| R1 LiveKit API | `R1_LIVEKIT_*` on `project-hello-api` only | Keep distinct from the LiveKit Cloud/phone key; rotate through the R1 drained switch procedure | Planned |
| R1 browser worker endpoint | Normal `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` on `project-hello-voice` | At self-host cutover, point this normal worker triple at the selected R1 SFU; it is separate from API-only `R1_LIVEKIT_*` | Planned |
| R1 self-hosted LiveKit SFU | `LIVEKIT_KEYS` on `project-hello-r1-rtc` only | Maintain two active keys during rotation; remove the old key only after verification | Planned |
| DeepSeek R1 conversation | `DEEPSEEK_API_KEY` on `project-hello-voice` | Stage before the R1 worker work; rotate through the provider and record non-secret evidence | Planned |

Rotation must be performed in each provider account by an authorized owner.
Acceptable non-secret evidence includes a provider audit-log screenshot, a
confirmed "last rotated" timestamp from the provider console, or a test proving
the old credential is rejected. Deleting a local file or ignoring it via
`.gitignore` does not constitute rotation.

## Candidate-data findings

- Original `docs/HELLO.html`, `docs/HELLO.md`, `docs/hello-assets/`, generated
  PDFs, and voice media remain quarantined by `.gitignore` pending owner
  restricted-storage disposition. Ground-up replacements now live in
  `docs/demo/`. The originals remain excluded from working-tree secret scans
  because embedded/base64 media makes the detector unbounded.
- **FND-03 synthetic replacements are complete** as of `docs/demo/`. All 7
  artifact groups have deterministic, safe JSON/HTML/MD replacements with
  `is_synthetic: true` markers, `@example.invalid` emails, and null phone
  fields. See `docs/demo/` for the full set.
- `app/voice/.env` contains candidate/demo context and must not be copied into a
  committed example.
- Historical handover/planning documents require a manual PII review before any
  further commits.
- **FND-03 disposition:** Synthetic replacements are in place. Disposition of
  original evidence into approved restricted storage is an owner action.
  `PLAN.md` acceptance criteria for FND-03 are partially met — synthetic
  artifacts exist but final owner disposition sign-off is pending.
- **FND-03 artifact scope** (7 fixed group IDs matching `PLAN.md`):
  `hello-html`, `hello-md`, `hello-assets`, `generated-pdf`, `voice-recording`,
  `scorecard-export`, `env-example-values`. All are covered by synthetic
  replacements under `docs/demo/`.

## Scanner state

- A redacted gitleaks configuration (`.gitleaks.toml`), pre-commit hook
  (`.githooks/pre-commit`), and CI workflow (`.github/workflows/secret-scan.yml`)
  are merged and active. The hook falls back to pinned Docker image `v8.30.1`.
  The seeded-secret test blocks a known pattern in CI.
- The committed tree at `4d103ea` passed a redacted gitleaks scan with zero
  findings; the GitHub secret-scan workflow passed on `main`.
- Quarantined local credentials and media are outside the committed set and
  require owner action for rotation and disposition respectively.

## Phase-0 Evidence Validation

FND-02 and FND-03 acceptance requires a structured evidence manifest that
records credential rotation and artifact disposition. The following tooling
is available to validate the manifest shape:

| Artifact | Location |
|----------|----------|
| Schema | `config/phase0-evidence.schema.json` |
| Example (all owner-evidence states pending) | `config/phase0-evidence.example.json` |
| Validator (zero-dependency) | `scripts/check-phase0-evidence.mjs` |
| Deterministic tests | `scripts/check-phase0-evidence.test.mjs` |
| Demo artifact validator | `scripts/check-demo-artifacts.mjs` |
| Demo artifact tests | `scripts/check-demo-artifacts.test.mjs` |
| Demo artifact generator | `scripts/generate-demo-artifacts.mjs` |
| CI workflow | `.github/workflows/phase0-evidence-ci.yml` |
| Owner runbook | `docs/runbooks/phase0-owner-evidence.md` |

The real manifest (`config/phase0-evidence.local.json`) is gitignored and must
never be committed. See `docs/runbooks/phase0-owner-evidence.md` for the
offline procedure.

FND-02 remains **owner verification pending** as of this writing.
FND-03 synthetic replacement is **complete**; owner disposition sign-off is
still required. No code change alone can close these tasks; each requires
human action at the provider account and restricted-storage level.
