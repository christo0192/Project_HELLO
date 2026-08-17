# Runbook — Ashby runtime activation

Covers the worker/scheduler runtime added in Wave 2 Step 6: what it is, how to
turn it on in stages, how to turn it off, and how to read its health. Pairs with
[ADR-0012](../adr/0012-ashby-runtime-execution-topology.md) (why it runs
in-process) and [`ashby-screening-workflow.md`](ashby-screening-workflow.md)
(the domain behaviour it drives).

> **The runtime is DISABLED by default and this build changes nothing about the
> running system until an owner flips the flags below.** With the shipped
> defaults `createAshbyRuntime()` returns `null`: no Ashby client is constructed,
> no timer is armed, no DB poll is issued, and no network call is made.

---

## 1. What was missing before this change

The domain layer was complete; the composition root was not. At `1f813ac`:

| Gap | Effect |
|---|---|
| No queue consumer | A signed webhook durably enqueued an `ashby.signal` job that was never claimed. |
| `import_eligible` was terminal | The signal worker returned the verdict and discarded it — no import was ever scheduled. |
| No ingestion work item | `runImport` set the ingestion row to `queued` and enqueued nothing to pick it up. |
| `claim_ashby_operation` had no TS caller | The 0031 lease token was unobtainable, so the operation outbox could never drain. |
| No candidate/session/invite persistence | `runInviteDelivery` was a pure decision function. |
| No `ASHBY_API_KEY` | No code path could construct a client. |
| Nothing called `reclaimExpired` | A machine stopped mid-job left its lease to expire with no sweeper. |
| Reconciliation unscheduled and unguarded | The dropped-webhook safety net could not fire, and had no single-flight lock. |

---

## 2. Configuration

All values are validated and clamped in code; a malformed value falls back to its
default rather than failing the boot.

| Variable | Default | Meaning |
|---|---|---|
| `ASHBY_INTEGRATION_ENABLED` | `false` | Wave-2 master switch (webhook ingress). |
| `ASHBY_WEBHOOK_SECRET` | — | **Fly secret.** HMAC secret; ≥16 chars, `replace_me` rejected. |
| `ASHBY_RUNTIME_ENABLED` | `false` | **Independent** switch for workers + scheduler + outbound client. |
| `ASHBY_API_KEY` | — | **Fly secret.** HTTP Basic username against the fixed allowlisted origin. ≥16 chars. |
| `ASHBY_RESUME_HOSTS` | *(empty)* | Comma-separated **exact** hostnames for presigned resume downloads. Empty ⇒ SSRF allowlist DISABLED ⇒ every fetch fails closed. No wildcards, no suffix matching. |
| `ASHBY_SIGNAL_POLL_MS` | `5000` | Queue poll cadence (clamped 250–300 000). |
| `ASHBY_OPERATION_POLL_MS` | `5000` | Operation-outbox poll cadence (clamped 250–300 000). |
| `ASHBY_RECONCILE_INTERVAL_MS` | `900000` | Reconciliation cadence (clamped 60 000–86 400 000). |
| `ASHBY_RECLAIM_INTERVAL_MS` | `60000` | Expired-lease sweep cadence (clamped 5 000–3 600 000). |
| `ASHBY_LEASE_SECONDS` | `60` | Visibility window per claim (clamped 5–900). |

**The runtime starts only when all four of these hold:**
`ASHBY_INTEGRATION_ENABLED=true` **and** a usable `ASHBY_WEBHOOK_SECRET` **and**
`ASHBY_RUNTIME_ENABLED=true` **and** a usable `ASHBY_API_KEY`.

Secrets are installed **only** through the approved mechanism:

```bash
fly secrets set ASHBY_API_KEY=... --app project-hello-api
fly secrets set ASHBY_WEBHOOK_SECRET=... --app project-hello-api
```

Never put a secret in `fly.toml [env]`, in `.env.example`, in a commit, or in
chat. `scripts/scan-secrets.sh` and `scripts/validate-no-secrets-baked.sh` gate
this in CI.

---

## 3. What the runtime does

Four independent, jittered, single-flight loops (see `scheduler.ts`):

| Loop | Work |
|---|---|
| `signal` | Claims `ashby.signal`, `ashby.import`, `ashby.ingestion` jobs through the leased queue runner. |
| `operation` | Claims **`invite_delivery` operations and nothing else** (see §6). |
| `reconcile` | The dropped-webhook safety net, under a DB single-flight lease. |
| `reclaim` | `reclaimExpired` — requeues or dead-letters jobs whose lease expired. |

The chain: signed webhook → receipt + outbox (one transaction) → `ashby.signal`
→ authoritative `application.info` re-read + mapping/stage gate → `ashby.import`
(dedup-keyed by **application**, so duplicate webhooks and reconciliation
recoveries converge to one import) → link + `invite_delivery` operation +
`ashby.ingestion` job → ephemeral fetch/scan/parse → candidate → one manual
24-hour invite.

**Multi-machine safety** comes from the database leases (`FOR UPDATE SKIP
LOCKED` + compare-and-set on the live lease token), never from an assumption
about how many machines are running. `auto_start_machines = true` means that
number is not ours to assume.

---

## 4. Staged activation

Do not proceed on a red gate. Each stage is independently reversible.

| Stage | Flip | Exit gate |
|---|---|---|
| 0 | Deploy with everything off. | `GET /api/integrations/ashby/mission-control/health` reports every boolean false; webhook returns 503; no Ashby traffic. |
| 1 | `fly secrets set ASHBY_API_KEY=…`, then `ASHBY_RUNTIME_ENABLED=true`. Integration still off. | Health shows `apiKeyConfigured: true`, `runtime.active: false`. Still no imports. |
| 2 | Probe a job: `GET …/mission-control/jobs/{externalJobId}/stages` (admin). | Sanitized stage ids returned; **no mutation appears in the Ashby audit log**. |
| 3 | Create mappings: `POST …/mission-control/mappings` (admin). | Every mapping lands `paused`. Enabling an incomplete/drifted mapping is refused by the DB. |
| 4 | `ASHBY_INTEGRATION_ENABLED=true`, register the webhook. **All mappings still paused.** | Receipts accumulate; reconciliation drains and advances; **zero imports**. |
| 5 | `ASHBY_RESUME_HOSTS=<exact presigned host>`; confirm `RESUME_SCANNER=clamav`. | Health shows `resumeAllowlistEnabled: true`. One synthetic resume ingests end-to-end; the bucket holds no Ashby original. |
| 6 | Enable **one** mapping via `POST …/mappings/{id}/resume`. | One application flows to exactly one manual 24-hour invite. Email stays `blocked_provider`. |
| 7 | Remaining mappings. | DLQ empty; reconciliation advancing; `no_progress_runs` at 0. |

There is deliberately **no write-back stage**: see §6.

---

## 5. Rollback

Rollback is a flag flip at any stage, in this order:

1. `fly secrets unset ASHBY_RUNTIME_ENABLED` (or set `false`) → the scheduler
   never starts on the next boot; loops stop, in-flight leased work either
   completes or is failed under its lease during graceful shutdown.
2. Pause mappings (`POST …/mappings/{id}/pause`) → no new work is admitted, and
   the operation worker re-checks mapping status at execution time, so a pause
   landing mid-flight stops new deliveries too.
3. `ASHBY_INTEGRATION_ENABLED=false` → the webhook returns 503 and makes no DB or
   network call.

**No migration rollback is required.** `0032` is additive only (one CHECK
extension on `lifecycle`, one on `chk_audit_action`, three nullable columns with
defaults, four new functions, two replaced functions, one new trigger). It
deletes no data and retypes no column; `scripts/migrate-rollback.test.mjs`
confirms the forward-only/no-destructive-DDL property. Reverting the application
code while leaving 0032 in place is safe — the new values and functions simply go
unused.

---

## 6. Why nothing is written back to Ashby (read this before "fixing" it)

**No approved Ashby result sink exists.** A completed screening therefore parks
at the `writeback_pending` lifecycle state (0032) and NOTHING is published: no
`applicationFeedback.submit`, no `applicationFeedbackRequest.create`, no
`application.changeStage`, and **no TA stage move**. There is no auto-reject
anywhere.

Four independent locks enforce this:

1. **The worker refuses.** `SUPPORTED_OPERATION_TYPES` is `['invite_delivery']`;
   `scorecard_write` and `stage_move` are never passed to
   `claim_ashby_operation`.
2. **The payload cannot be built.** `bindFeedbackForm` fails closed with
   `binding_unverified` unless a tenant-VERIFIED form binding is supplied, and no
   column, RPC, or config produces one — `ashby_job_mappings.feedback_form_id` is
   a bare text column with no verified flag and no field-id columns.
3. **The database refuses.** The 0029 `trg_ashby_operation_dependency` trigger
   raises `P0001` if a `stage_move` tries to reach `running`/`succeeded` before
   its `scorecard_write` dependency has succeeded.
4. **The saga refuses.** `enqueueStageMove` re-reads `application.info` and skips
   with `human_moved` unless the application is still at the mapped AI stage — a
   human's move is never undone.

`ashby-writeback-fail-closed.test.ts` asserts all four as an executable gate.
**Unlocking write-back requires a tenant probe that pins the feedback-form field
ids AND a durable verified binding — it is not a flag flip, and widening
`SUPPORTED_OPERATION_TYPES` without that binding would break the guarantee.**

---

## 7. Health and operability

`GET /api/integrations/ashby/mission-control/health` (interviewer+). Returns
**booleans, bounded integers and counts only** — never the API key, the webhook
secret, an allowlisted host, an invite token, a presigned URL, or any candidate
field. `provider` is always `unknown`: the handler contacts no provider, so
claiming `ok` would be a lie.

The public `GET /api/health` deliberately remains a liveness-only `{ok:true}`.

**What health does NOT tell you.** The handler reports runtime *configuration*,
not live loop liveness — it does not own the in-process scheduler handle. Use the
backlog as the liveness signal instead: if `ashby.signal`/`ashby.import` jobs or
`pending` operations stop draining while the flags are on, the loops are not
running. Metrics `ashby_scheduler_tick` / `ashby_scheduler_tick_error` are emitted
per loop and are the intended alerting surface.

### Triage

| Symptom | Likely cause | Action |
|---|---|---|
| Jobs accumulate, no imports | Runtime flags off, or the mapping is paused/drifted | Check health booleans; check mapping status. |
| Resume ingestion always `failed_review` with an allowlist reason | `ASHBY_RESUME_HOSTS` empty or wrong | Set the EXACT presigned host. No wildcards. |
| Ingestion stuck at `failed_review` and refusing to requeue | Requeue ceiling (5) reached — 0032 returns `retry_exhausted` | Investigate the underlying fetch/scan/parse failure; this is a deliberate stop, not a bug. |
| `no_progress_runs` climbing on a checkpoint | A full resync is permanently larger than `item_cap` | Raise `maxItems`/`maxPages` for that stream, or investigate why the stream will not drain. **Do not** "fix" it by advancing a partial cursor — that skips applications permanently. |
| Reconciliation never runs | Another runner holds the single-flight lease, or the lease is stranded | `begin_ashby_sync_run` returns `locked`; the lease self-expires on its deadline. |
| DLQ growing | Repeated handler failures | Inspect `job_dlq`; replay with `replayDlq` after fixing the cause. |
| Retry refused with `blocked_terminal` | The application is withdrawn/deleted/cancelled | Correct — terminal work is never resurrected. |
| Retry refused with `retry_exhausted` | `attempts` reached `max_attempts` | Deliberate bound. Investigate rather than forcing. |

---

## 8. Known limitations recorded honestly

- **`maxPinnedIps` is computed but only the first resolved IP is used**
  (`resume-transport.ts`). Not a vulnerability — every resolved address is
  asserted public before connect — but it means no failover across A-records.
  Left as-is in this PR; it is a one-line behavioural change that deserves its
  own review.
- **Reconciliation progress strategy** is option (c) from the acceptance matrix:
  keep the bounded caps and make a non-advancing run *observable* via
  `no_progress_runs`, rather than advancing a partial cursor. Chosen because
  advancing past unprocessed work would silently skip applications.
- **Health is configuration-derived, not heartbeat-derived** (§7).
- **No web UI** for the new mapping-provisioning or probe endpoints in this PR —
  they are API-only. Mission Control's existing pages are unchanged.
