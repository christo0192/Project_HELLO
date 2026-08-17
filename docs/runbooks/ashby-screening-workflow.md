# Ashby screening workflow — full closure (Wave 2, Step 5)

Status: **complete integrated implementation — disabled by default; no real
tenant/provider/email activity.** Stacked on PR B (`feat/ashby-webhook-reconciliation`).
Owner squash-merges; no agent merge. Merge order **A → B → C**.

## Restack (post PR B review-repair)

PR B was repaired for the integrated-review findings F1/F2/F3 and rebased onto
`main` (PR A merged as `c2bfb9c`). PR C was rebased onto the repaired B head
`0679170` (GitHub base stays `feat/ashby-webhook-reconciliation` while B is
open); the PR C diff contains only C changes. The F2 repair **folded the
standalone `SignalEnqueuer` port into the transactional-outbox `ReceiptStore`**
(`record({enqueue})` now inserts receipt + signal job in one transaction and
reports `workPending`; reconciliation enqueues import work per observed
application). PR C consumes none of the removed symbols, so the rebase is a
clean interface no-op for C. A new regression — `ashby-full-chain-recovery.test.ts`
— composes the repaired webhook/reconciliation outbox with C's `runImport` to
prove that a dropped-then-recovered signal AND an enqueue-failed/redelivered
(and a lost-job re-driven) signal each reach **exactly one** import / workflow
link / seeded ingestion / invite set — not merely a receipt.

This PR (#58) implements Ashby Wave 2 work items 3–7 as an integrated screening
workflow: application import + cancellation, ephemeral SSRF-hardened resume
ingestion, invitation lifecycle, Mission Control (API + web), and the
scorecard→stage saga — with a migration, OpenAPI parity, real-Docker migration/
policy verification, and full synthetic + adversarial tests. Everything is
gated OFF until a tenant probe approves real ids/hosts and a provider/domain.

## Migration 0031 (`0031_ashby_workflow.sql`) — service-role-only, additive

Additive lease/anchor/marker columns on `ashby_operations` + eight audited
SECURITY DEFINER RPCs (pinned `search_path`, revoked from browser roles):

| RPC | Purpose |
|---|---|
| `enqueue_ashby_operation` | Idempotent outbox insert (unique key + content marker); fails closed on a terminal link. |
| `claim_ashby_operation` | `FOR UPDATE SKIP LOCKED` lease claim of the next runnable op whose dependency (scorecard-before-stage) succeeded. |
| `complete_ashby_operation` | CAS success under the live lease; persists sanitized external anchor + marker. |
| `fail_ashby_operation` | CAS retry/fail under the live lease (retryable → pending while attempts remain). |
| `cancel_ashby_application` | ONE-transaction terminal cancellation: mark link terminal + cancel in-flight ops + in-flight ingestion; idempotent; never reverses succeeded work; never auto-rejects. |
| `advance_ashby_ingestion` | Restart-safe ingestion transition with hash/version provenance (0029 trigger enforces legality). |
| `set_ashby_mapping_status` | Mission Control pause/resume (enable requires completeness + non-drift). |

Audit allowlist widened additively (`ashby_application_cancel`,
`ashby_operation_enqueue`, `ashby_operation_update`). `policy_tests.sql` adds
structural asserts + a live functional block (idempotent outbox, duplicate
marker, scorecard-before-stage at claim, stale-lease CAS rejection, atomic
terminal cancel + idempotency + block-after-terminal, illegal ingestion
transition, pause/resume gate). **Real Docker `0001–0031` apply: clean, zero
drift, all policy tests pass.**

## API modules (`app/api/src/integrations/ashby/`)

Pure domain (`ssrf`, `resume-fetch`, `resume-ingestion`, `workflow`,
`invite-delivery`, `scorecard`) + orchestration + wiring:

- `orchestration.ts` — disabled-by-default workers over injected seams:
  `runImport`, `runIngestionJob`, `runInviteDelivery`, `enqueueScorecard` /
  `enqueueStageMove` (re-read AI-stage guard; human move skips; no auto-reject).
- `workflow-stores.ts` — service-role adapters for the 0031 RPCs + the
  Mission Control sanitized read/action store.
- `resume-transport.ts` — production pinned-IP HTTPS transport: connects to the
  validated IP while keeping SNI/Host on the hostname; redirects disabled;
  bounded read. Host allowlist stays disabled until a tenant probe.

## Mission Control

- API: `routes/ashby-mission-control.ts` mounted at
  `/api/integrations/ashby/mission-control` (recruiter-authenticated, distinct
  from the pre-auth webhook). Reads (`GET /mappings`, `/workflows`) require
  interviewer+; actions (`POST …/pause|resume`, `…/cancel`, `…/retry`) require
  admin. Candidate/unauthenticated fail closed (401/403). Sanitized projections
  only — no PII, tokens, presigned URLs, transcripts, or recordings. Mutations
  are race-safe + audited inside their RPCs.
- Web: `pages/AshbyMissionControlPage.tsx` (admin-gated route
  `/ashby-mission-control`) lists mapping health + workflow state with
  pause/resume/cancel/retry actions; `api.ts` + `types.ts` extended.
- OpenAPI: 6 paths + 9 schemas added; `contract-openapi` counts updated
  (67 paths / 138 schemas); route↔spec bijection + auth boundary green.

## Verification (local, this closure)

- `app/api`: typecheck + build clean; **2129 tests pass**; coverage
  82.71 / 75.48 / 83.89 / 85.23 (floors 71/61/71/73).
- Real Docker `scripts/supabase-test.sh`: `0001–0031` apply clean, zero drift,
  restore rehearsal identical, full policy suite (incl. 0031) PASS.
- `app/web`: typecheck + lint clean; page suite + axe green; coverage ratchet
  + build (see PR CI).
- `sast.sh`, `check-env-contract.mjs`, `migrate-rollback.test.mjs`,
  `check-current-state.mjs`, `check-adrs.mjs`, `git diff --check`, gitleaks — all green.

## Security invariants (proven by tests)

SSRF matrix (localhost/private/link-local/CGNAT/ULA/NAT64/mapped-IPv6/rebinding/
redirect-to-internal/http-downgrade/userinfo/IP-literal/oversize/timeout, allowlist
disabled by default); fail-closed scan before parse; ephemeral bytes wiped on
every path, never bucketed; application-id-only identity (never merge by contact);
atomic terminal cancel (in-flight only, never reverse succeeded, never auto-reject);
token-free manual invite channel; provider-gated email; scorecard redaction (no
raw model/CoT/transcript/recording/bearer) + idempotency marker + fail-closed
tenant form binding; stale-lease CAS rejection; Mission Control candidate/
unauthorized fail closed with no PII/tokens.

## Residual gates

> **CORRECTION (Wave 2 Step 6).** An earlier version of this section claimed the
> residual was "runtime activation only — not code". **That was inaccurate.** The
> domain and persistence layers were complete, but the production composition
> root did not exist: nothing in a running process ever claimed an Ashby job.
> Specifically, at `1f813ac` there was no queue consumer, no scheduler, no
> reclaim sweeper, no `ASHBY_API_KEY`, no `claimOperation` adapter (so the 0031
> `claim_ashby_operation` RPC had zero TypeScript callers), no ingestion work
> item, and no candidate/session/invite persistence. A signed webhook durably
> enqueued a job that would never be claimed. That code is delivered in the
> runtime-activation PR — see
> [`ashby-runtime-activation.md`](ashby-runtime-activation.md) and ADR-0012.

**Remaining EXTERNAL gates (genuinely not code).** Real Ashby credentials and a
tenant probe to pin per-job stage/form/interview ids and approve the
presigned-URL host; an approved email provider + verified sending domain; the
privacy/legal erasure decision for withdrawn/deleted applications; production
malware-scanner (ClamAV) configuration. The runtime remains disabled by default
behind two independent flags; no real provider call, email send,
transcript/recording copy, or deployment is performed by this work.

**Still not implemented, by design.** There is no approved Ashby result sink, so
`scorecard_write` and `stage_move` are never claimed or executed and a completed
screening parks at the `writeback_pending` lifecycle state (migration 0032),
written by the completion observer on the authoritative assessment path. See the
runtime-activation runbook for the four locks that enforce this.

**Manual invite delivery.** The invite row stores only a SHA-256 digest, so the
usable link exists for exactly one moment: the response to an authorized admin
calling `POST …/mission-control/workflows/{id}/invite` (or clicking *Get invite
link* in Mission Control). Until that happens the delivery operation rests at
`awaiting_manual_delivery` — it is deliberately NOT `succeeded`, because no
candidate can be contacted yet.
