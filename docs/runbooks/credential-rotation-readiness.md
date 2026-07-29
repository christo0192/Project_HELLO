# Credential Rotation Readiness

> **Status:** Pending — credentials remain active by owner decision.
> Rotation/revocation has **not** yet been performed.  This document
> captures the readiness posture and procedural steps so that when
> the owner authorises rotation, the team can execute deterministically.

## Context

Eight provider credentials required for platform operation are currently
stored in access-controlled locations (environment files, vault, or CI
secrets).  These credentials were discovered during Phase-0 discovery and
have been **temporarily retained** to keep the platform operational while
the team prepares rotation artefacts.

- **Git-history secret scanning** (`scripts/scan-git-history.sh`) checks
  every reachable commit to detect secrets committed in the past and
  potentially removed without revocation.  This is a necessary precursor
  to safe rotation: if a secret exists in the Git history, rotation alone
  is insufficient — the history entry must also be scrubbed.
- **Existing scanning** (`scripts/scan-secrets.sh --committable`) protects
  the working tree and staged changes.
- **CI enforcement** (`.github/workflows/secret-scan.yml`) runs both
  scanners on every push and pull request.

**Scanner success is NOT proof of revocation.**  A clean scan only means
no credentials are present in Git history or the working tree.  It does
not mean the credentials have been rotated, invalidated, or tested against
the provider.

## Pending rotation items

| # | Credential | Provider | Status |
|---|-----------|----------|--------|
| 1 | API key | Supabase (production) | Rotation pending |
| 2 | API key | Supabase (staging) | Rotation pending |
| 3 | Service account key | OCI (production) | Rotation pending |
| 4 | Service account key | OCI (staging) | Rotation pending |
| 5 | LiveKit API key | LiveKit cloud | Rotation pending |
| 6 | SMTP credentials | Email provider | Rotation pending |
| 7 | SMS API key | SMS provider | Rotation pending |
| 8 | Webhook signing secret | Webhook provider | Rotation pending |

## Pre-rotation checklist

Before any rotation event, confirm:

- [ ] Full Git history scan passes with exit 0 on `origin/main`
- [ ] Working-tree scan (`./scripts/scan-secrets.sh`) passes
- [ ] No sensitive material appears in logs or CI output
- [ ] Provider admin console / vault is accessible
- [ ] Rollback plan documented per credential
- [ ] Communication sent to stakeholders (downtime expectation)

## Rotation procedure (general)

1. **Generate** new credential in provider admin console / vault.
2. **Deploy** new credential to environment (`./scripts/inject-secret.sh`
   or equivalent; this script is not yet implemented — see FND-03).
3. **Verify** the application works with the new credential (smoke test).
4. **Revoke** the old credential in the provider console.
5. **Confirm** revocation (provider returns auth error for old key).
6. **Remove** any traces from Git history (see below).
7. **Re-scan** full history and working tree.
8. **Document** the rotation in the session handover / evidence log.

## Removing secrets from Git history

> This step is destructive.  Coordinate with all contributors before
> rewriting history.  Prefer `git filter-repo` over `filter-branch`.

```bash
# 1. Ensure a clean starting point
git checkout main
git pull origin main

# 2. Install git-filter-repo if not present
#    pip install git-filter-repo   or   brew install git-filter-repo

# 3. Remove the secret from all commits
#    (example — adjust the path/regex to match the actual secret)
# git filter-repo --path .env.test --invert-paths

# 4. Force-push to origin (requires co-ordinated team action)
# git push origin --force --all

# 5. Re-scan to confirm removal
bash scripts/scan-git-history.sh
```

## When to re-run the history scanner

- Before every rotation event
- After any Git history rewrite
- After merging a PR that touches any credential-related path
- Periodically (recommended: on every push via CI)

## Known limitations

- The history scanner relies on gitleaks default rules plus the project
  `.gitleaks.toml`.  Credential formats not covered by these rules are
  invisible to the scanner.
- Binary files are scanned heuristically; some encoded secrets may evade
  detection.
- The scanner cannot detect secrets that were never committed to Git
  (e.g., leaked via email, chat, or build artefacts).
- Scanner success does not prove revocation — see the caveat above.
- This document is a readiness plan, not a completed procedure.  Each
  credential rotation must be separately authorised, executed, and
  verified.
