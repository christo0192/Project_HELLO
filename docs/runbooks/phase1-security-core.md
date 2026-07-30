# Phase 1 Security Core — implementation and residual gates

**Evidence date:** 2026-07-30

**Scope:** local/synthetic, browser-only, pre-production

This runbook separates merged/tested engineering from production acceptance. Phase 1 remains **not accepted** and launch gates remain **0/17**.

## Implemented engineering

- Supabase email/password recruiter login UI, configurable OAuth initiation, TOTP enrollment/challenge UI, AAL2 route guard and short local session policy.
- Bearer API authentication, active `recruiter_memberships` role resolution, admin/interviewer/viewer guards and owner filters/stamps around broad server-side database access.
- Single-organization RLS ownership policies; legacy NULL ownership is hidden from interviewers.
- Expiring, revocable, one-time candidate invite digests and short-lived session/room-bound grant digests; plaintext returned only at issuance.
- Candidate join page exchanges the fragment invite, removes it from browser history and receives a room-scoped LiveKit token.
- Client-visible LiveKit metadata reduced to opaque session/room/correlation identifiers. Worker lookup requires a separate bearer credential and fails closed when absent.
- Configurable bounded in-process per-IP/per-user/per-endpoint rate limits with 429 and `Retry-After`.
- Append-only audit schema and a data-minimized API sink foundation.
- Resume extension/MIME/magic checks, archive bounds, bounded parser child process, EICAR regression interface, private random-key storage and production fail-closed behavior when no malware scanner exists.
- Existing SEC-05/07/09/10 controls reverified. SEC-11 is conditionally not applicable because no maintained application image exists.

## Pending blockers by task

| Task | Engineering state | Remaining acceptance blocker |
|---|---|---|
| SEC-01 | Partial | Hosted SSO/MFA, provisioned accounts, recovery, FND-06 and live token evidence |
| SEC-02 | Partial | Complete endpoint ownership matrix and deployed least-privilege identity evidence |
| SEC-03 | Partial | Production RLS/API proof, FND-06, residency/ownership approval |
| SEC-04 | Partial | Live provider concurrency/revocation/join evidence and operational delivery process |
| SEC-05 | Implemented | Reverify every future endpoint |
| SEC-06 | Partial | Distributed multi-instance state, production thresholds and abuse alerts |
| SEC-07 | Partial | Enforced deployed CSP after a clean reporting window |
| SEC-08 | Internally decided | Independent Security review and deployed XSS controls |
| SEC-09 | Implemented in code | Deployed Observatory B+ evidence |
| SEC-10 | Implemented in CI | Continue vulnerability/exception expiry operations |
| SEC-11 | Conditional N/A | Activate when an application Dockerfile/image is introduced |
| SEC-12 | Partial | Full event coverage, transactional fail-closed policy, retention and independent review |
| SEC-13 | Partial | FND-05/FND-06 worker identity, full rubric/resume worker-context delivery and live inspection proof |
| SEC-14 | Partial | Operational malware engine, production parser sandbox/resource evidence and streaming storage path |

## Local verification

```bash
npm --prefix app/api run typecheck
npm --prefix app/api test
cd app/voice-livekit && python3 -m pytest -q
npm --prefix app/web run test:typecheck
npm --prefix app/web run lint
npm --prefix app/web test
npm --prefix app/web run build
bash scripts/supabase-test.sh
bash scripts/check-phase1-security-sql.sh
```

Also run environment, current-state, dependency, secret and diff checks from the handover before commit.

## Fail-closed operational posture

- No worker context is returned without `WORKER_CONTEXT_SECRET` (minimum 32 characters); deploying that shared secret is not a substitute for FND-06.
- Production resume ingestion rejects all uploads until an operational malware scanner is integrated and evidenced.
- Candidate join tokens are not issued by the recruiter `/start` response; only one-time invite exchange can mint them.
- Do not restore resume/rubric context to LiveKit room, participant or token metadata to work around a worker-channel failure.
