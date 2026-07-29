# Credential and PII Inventory

**Evidence date:** 2026-07-29

**Plan tasks:** FND-02, FND-03

**State:** Code infrastructure merged (gitleaks, pre-commit, CI scan, seeded-secret test).
Credential rotation and candidate-artifact disposition are **owner verification
pending** and block FND-02/FND-03 acceptance. The committed tree is clean;
CI secret-scan passed on `main` at `4d103ea`.

No credential values are recorded in this document. Local `.env` files are
excluded from Git. Non-secret revocation evidence is required for each system
before FND-02 can close.

| System | Known local locations | Required action | Rotation status |
|--------|-----------------------|-----------------|-----------------|
| Supabase | `app/api/.env`, `app/voice/.env`, `app/voice-livekit/.env`, archived server env | Rotate project/service/database credentials; update only approved local runtimes | Owner verification pending |
| LiveKit | `app/api/.env`, `app/voice-livekit/.env` | Rotate API key/secret; invalidate old grants | Owner verification pending |
| Anthropic | Current and archived voice env files | Rotate API keys | Owner verification pending |
| Sarvam | Current and archived voice env files | Rotate API keys | Owner verification pending |
| Deepgram | Previous and archived voice env files | Rotate API keys | Owner verification pending |
| Retell, ElevenLabs, Cartesia | Archived env files | Revoke or rotate; delete unused resources where approved | Owner verification pending |

Rotation must be performed in each provider account by an authorized owner.
Acceptable non-secret evidence includes a provider audit-log screenshot, a
confirmed "last rotated" timestamp from the provider console, or a test proving
the old credential is rejected. Deleting a local file or ignoring it via
`.gitignore` does not constitute rotation.

## Candidate-data findings

- `docs/HELLO.html`, `docs/HELLO.md`, `docs/hello-assets/`, generated PDFs, and
  voice media are quarantined by `.gitignore` pending synthetic replacement.
  They are excluded from working-tree secret scans because embedded/base64 media
  makes the detector unbounded.
- `app/voice/.env` contains candidate/demo context and must not be copied into a
  committed example.
- Historical handover/planning documents require a manual PII review before any
  further commits.
- **FND-03 disposition:** Review evidence pending before FND-03 closure. Synthetic replacements have not been authored.
  Disposition of original evidence into approved restricted storage is pending;
  governed archival evidence not recorded in repo. `PLAN.md` acceptance criteria for
  FND-03 are not met.

## Scanner state

- A redacted gitleaks configuration (`.gitleaks.toml`), pre-commit hook
  (`.githooks/pre-commit`), and CI workflow (`.github/workflows/secret-scan.yml`)
  are merged and active. The hook falls back to pinned Docker image `v8.30.1`.
  The seeded-secret test blocks a known pattern in CI.
- The committed tree at `4d103ea` passed a redacted gitleaks scan with zero
  findings; the GitHub secret-scan workflow passed on `main`.
- Quarantined local credentials and media are outside the committed set and
  require owner action for rotation and disposition respectively.
