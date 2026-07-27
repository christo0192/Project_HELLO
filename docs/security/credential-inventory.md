# Credential and PII Inventory

**Evidence date:** 2026-07-27

**Plan tasks:** FND-02, FND-03

**State:** Open; clean bootstrap set verified, account-side rotation incomplete.

No credential values are recorded in this document. Local `.env` files are
ignored but contain configured values for one or more of the following systems:

| System | Known local locations | Required action |
|--------|-----------------------|-----------------|
| Supabase | `app/api/.env`, `app/voice/.env`, `app/voice-livekit/.env`, archived server env | Rotate project/service/database credentials and update only approved local runtimes |
| LiveKit | `app/api/.env`, `app/voice-livekit/.env` | Rotate API key/secret and invalidate old grants |
| Anthropic | Current and archived voice env files | Rotate API keys |
| Sarvam | Current and archived voice env files | Rotate API keys |
| Deepgram | Previous and archived voice env files | Rotate API keys |
| Retell, ElevenLabs, Cartesia | Archived env files | Revoke or rotate; delete unused resources where approved |

Rotation must be performed in each provider account by an authorized owner and
verified by proving the old credential fails. Ignoring or deleting a local file
does not count as rotation.

## Candidate-data findings

- `docs/HELLO.html`, `docs/HELLO.md`, `docs/hello-assets/`, generated PDFs, and
  voice media are quarantined by `.gitignore` pending synthetic replacement.
  They are excluded from the bounded source scan because embedded/base64 media
  makes the detector unbounded; FND-03 requires manual review and replacement.
- `app/voice/.env` contains candidate/demo context and must not be copied into a
  committed example.
- Historical handover/planning documents require a manual PII review before the
  first commit.

## Scanner state

- A redacted gitleaks configuration, native pre-commit hook, and CI workflow are
  present.
- The local gitleaks binary is not currently installed, so a clean tool-produced
  report has not yet been captured.
- Placeholder CODEOWNERS and the absent private remote prevent CI enforcement.
