# Ashby screening workflow — domain + SSRF-hardened ephemeral fetch (Wave 2, Step 5)

Status: **foundation slice — disabled by default, wired to no route/worker/UI.**
Stacked on PR B (`feat/ashby-webhook-reconciliation`). Owner squash-merges;
no agent merge. Merge order **A → B → C**.

## What this delivers (pure, injectable, DB-free domain + security modules)

All modules live under `app/api/src/integrations/ashby/` and are exported from
`index.ts`. Each mirrors the SQL/domain invariants of migration 0029 the way
`integration-schema.ts` did, and is exhaustively unit-tested with injected
fakes (no real network, DNS, DB, scanner, or provider call).

| Module | Work item | Responsibility |
|---|---|---|
| `ssrf.ts` | 4 | HTTPS-only URL policy (allowlist **disabled by default**), full private/loopback/link-local/CGNAT/ULA/NAT64/IPv4-mapped IP classifier, mixed-answer (rebinding) rejection. |
| `resume-fetch.ts` | 4 | Orchestrates one SSRF-hardened, bounded, ephemeral fetch: DNS-resolve → assert every IP public → pin → bounded redirect budget (re-validating each hop) → byte/time caps → provenance sha256. |
| `resume-ingestion.ts` | 4 | Ephemeral ingestion state machine (queued→…→ready/failed_review/cancelled): **fail-closed scan before parse**, magic guard, bounded parser, deterministic fallback, guaranteed byte wipe on every path, restart-safe state emissions, opaque provenance. Never uploads original bytes. |
| `workflow.ts` | 3 | Import eligibility (re-read AI-stage gate), **application-id-only identity** (never merge by contact), terminal-cancellation planning (cancels only in-flight ops/ingestion; never reverses succeeded work; never auto-rejects). |
| `invite-delivery.ts` | 5 | Delivery-mode fan-out, one-active-invite gate, **token-free manual channel** (recruiter-auth relative reissue path only), provider-gated email, idempotent delivery key, reissue = revoke-then-issue. |
| `scorecard.ts` | 7 | Deterministic bounded scorecard mapper (existing dimensions → configured scale, informational recommendation, bounded summary, provenance, **relative** review deep-link). Redacts raw model/CoT/transcript/recording/bearer. Idempotency marker. Feedback-form binding **fails closed** until a tenant probe verifies field ids. |

## Security invariants proven by tests

- SSRF matrix: localhost, private IPv4/IPv6, link-local (169.254.169.254),
  CGNAT, ULA, multicast, IPv4-mapped/compatible IPv6, NAT64, redirect-to-http,
  redirect-to-internal-host, same-host rebinding across a redirect hop,
  userinfo/confusable/IP-literal hosts, non-HTTPS schemes, oversize/empty body,
  timeout — all fail closed with sanitized reason codes; allowlist disabled by
  default refuses everything.
- Fail-closed malware scan runs **before** any parse; an infected/errored scan
  blocks the parse and moves to `failed_review`.
- Ephemeral bytes are `.fill(0)`-wiped on success, every failure, cancellation,
  and a thrown port; never written to the resume bucket.
- Application identity is keyed solely by the external application id; two
  applications sharing an email stay distinct.
- The manual delivery artifact carries no token/bearer/invite-URL.
- The scorecard payload carries no raw model output / CoT / transcript /
  recording / bearer URL.

## Verification (local, this slice)

- `npm --prefix app/api run typecheck` + `npm --prefix app/api run build` — clean.
- `npm --prefix app/api test` — **2100 tests pass** (+81 new across 6 suites).
- Coverage ratchet — **83.58 / 76.52 / 85.41 / 85.96** (floors 71/61/71/73).
- `scripts/sast.sh` + self-test — PASS; `check-env-contract.mjs` — valid;
  `migrate-rollback.test.mjs` — PASS; `git diff --check` — clean.
- No new env vars, migration, route, OpenAPI path, or web change → the
  supabase-check / OpenAPI-contract / web lanes are unaffected by this diff.

## Residual gates (the integration layer — NOT in this slice)

These require DB/route/UI work and a real-Docker pass; a follow-up closure pass
completes them and only then is `ASHBY_W2_PRC_READY` warranted:

1. **Migration `0031`** — RPCs for atomic terminal-cancel (mark link terminal +
   cancel in-flight ops/ingestion in one transaction), operation-outbox claim,
   ingestion-state advance, and scorecard-marker/external-anchor persistence,
   plus policy tests + real-Docker `0001–0031` apply.
2. **Route wiring** — an internal worker that composes the signal decision →
   `decideImport` → `runResumeIngestion` (with the real SSRF transport, ClamAV
   scanner, and parser pool) → invite issuance → scorecard/stage saga over the
   leased queue.
3. **Mission Control** — HR/admin read API + web surface for mapping drift and
   the pending/expired/failed_review/cancelled/withdrawn/delivery/writeback
   states, with audited pause/resume/reissue/retry/cancel actions.
4. **OpenAPI** — add the Mission Control paths/schemas + contract-test counts.
5. **Production SSRF transport** — pinned-IP HTTPS agent (connect to the
   validated IP, keep SNI/Host on the hostname) behind the disabled allowlist.
6. **Tenant probe** — pin real per-job stage/form/interview ids and approve the
   presigned-URL host before any of the above is enabled with production data.

Nothing here makes a real Ashby call, sends email, copies a transcript/recording,
or activates in production. Disabled by default.
