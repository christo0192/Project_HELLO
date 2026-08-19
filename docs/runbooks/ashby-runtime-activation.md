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
| `RESUME_SCANNER`, `RESUME_SCANNER_MAX_DB_AGE_HOURS`, `AV_UPDATER_*` | see §5a | Malware scanner and its signature-update lifecycle. Stage 5 cannot pass without them. |

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
| `operation` | Claims **`invite_delivery` operations and nothing else** (see §7). |
| `reconcile` | The dropped-webhook safety net, under a DB single-flight lease. |
| `reclaim` | `reclaimExpired` — requeues or dead-letters jobs whose lease expired. |

The chain: signed webhook → receipt + outbox (one transaction) → `ashby.signal`
→ authoritative `application.info` re-read + mapping/stage gate → `ashby.import`
(dedup-keyed by **application**, so duplicate webhooks and reconciliation
recoveries converge to one import) → link + `invite_delivery` operation +
`ashby.ingestion` job → ephemeral fetch/scan/parse → candidate → one manual
24-hour invite, whose delivery operation rests at `awaiting_manual_delivery`
until an admin obtains the link (§5).

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
| 4 | `ASHBY_INTEGRATION_ENABLED=true`, register/enable the webhook. **All mappings still paused.** Ashby's signed idless configuration `ping` is acknowledged with 200 and stores/queues nothing. | Webhook shows enabled; receipts accumulate only for real events; reconciliation advances; **zero imports**. |
| 5 | `ASHBY_RESUME_HOSTS=<exact presigned host>`; confirm `RESUME_SCANNER=clamav`. | Health shows `resumeAllowlistEnabled: true` **and `scanner.ready: true`** (§5a — an installed `clamscan` is not enough). One synthetic resume ingests end-to-end; the bucket holds no Ashby original. |
| 6 | Enable **one** mapping via `POST …/mappings/{id}/resume`. | One application flows to a minted invite whose delivery operation rests at `awaiting_manual_delivery`. An admin then clicks **Get invite link** in Mission Control (or calls `POST …/workflows/{id}/invite`), receives the candidate URL once, and the operation becomes `succeeded`. Email stays `blocked_provider`. |
| 7 | Remaining mappings. | DLQ empty; reconciliation advancing; `no_progress_runs` at 0. |

There is deliberately **no write-back stage**: see §7.

---

## 5a. Malware scanner: signature freshness

Resume ingestion cannot be activated until the scanner can actually screen. The
binary being present is **not** that.

### The failure this section exists to prevent

A live production machine had `RESUME_SCANNER=clamav`, a working `clamscan`, a
clean fixture that exited 0 and an EICAR fixture that exited 1 — and libclamav
warning `virus database is older than 7 days` on every invocation. The image ran
`(freshclam --quiet || true)` once at build time and the runtime is non-root
with no updater, so the signatures were frozen at image-build time and could
only get older. Every "clean" verdict was a scan against dead signatures, and
nothing in the product could tell the difference: `clamscan` exits 0 on a clean
file whatever its database age.

### What changed

- **The image bakes no signature database at all.** The build-time
  `freshclam || true` is gone and is not replaced by a mandatory build-time
  download: ClamAV's CDN rate-limits datacentre egress (HTTP 429), so requiring
  it would trade a silent security failure for a flaky build. The database is
  owned entirely by the runtime.
- **The container's PID 1 is a supervisor** (`dist/src/container/entrypoint.js`)
  that runs one `freshclam` attempt at start and then hourly, forwards
  `SIGTERM`/`SIGINT`/`SIGHUP` to the API child, and exits with the child's
  status. Updates are single-flight (two concurrent `freshclam` processes
  writing one database directory is the update race that could corrupt a scan),
  bounded by `AV_UPDATER_TIMEOUT_MS`, and run as the unprivileged user against a
  root-owned read-only `freshclam.conf`. There is no daemon and no socket — the
  scanner shells out to `clamscan`.
- **A failed update never crash-loops the API.** It degrades the resume path
  only; exiting would turn a degraded feature into an outage and restart
  straight back into the same rate limit. Truthfulness is preserved by the
  scanner verdict and by health, not by killing the process.
- **The scanner proves freshness before it scans.** It reads the build time from
  the CVD/CLD header's epoch field — machine-readable, no locale, no stderr
  scraping — and rejects the file if the `daily` database is missing,
  unreadable, corrupt, or older than `RESUME_SCANNER_MAX_DB_AGE_HOURS`. On a
  stale database `clamscan` is **not invoked at all**, so a stale `exit 0` can
  never be mistaken for a clean verdict. Age is judged on `daily` because `main`
  is republished roughly yearly; `main` must still be present and parseable.
- **Scanning is process-wide serialized with bounded backpressure.** Loading a
  real database costs roughly 1 GiB per `clamscan`; concurrent processes can OOM
  the 2 GiB Fly machine. One scan runs, at most two wait, and excess work fails
  closed as `scanner_busy`. The 120 s binary timeout covers measured shared-CPU
  cold loads. Health additionally runs a cached real-binary EICAR capability
  proof, so fresh headers alone can never produce `scanner.ready: true`.

### Configuration

| Variable | Default | Bounds | Meaning |
|---|---|---|---|
| `RESUME_SCANNER` | `test` (prod: `clamav`) | — | `clamav` selects the production scanner **and** enables the updater. |
| `RESUME_SCANNER_DB_DIR` | `/var/lib/clamav` | — | Database directory; owned by the runtime user, mode 0700. |
| `RESUME_SCANNER_MAX_DB_AGE_HOURS` | `24` | 1–168 | Maximum `daily` age. Deliberately far stricter than ClamAV's own 7-day warning. Malformed ⇒ default. |
| `RESUME_SCANNER_TIMEOUT_MS` | `120000` | 30–300 s | Per-binary bound; queue wait is separately bounded by the same value. |
| `AV_UPDATER_INTERVAL_MS` | `3600000` | 15 min–12 h | Refresh cadence. 24 opportunities inside the 24 h ceiling. |
| `AV_UPDATER_TIMEOUT_MS` | `600000` | 60 s–30 min | Hard wall-clock bound per attempt; covers a cold ~113 MB download. |

### The cold-start window is fail-closed, on purpose

Between container start and the first successful update there is **no** database,
so every resume ingestion is refused with `signatures_missing` and health reports
`scanner.ready: false`. On a warm machine this is a one-off ~30–60 s window
(`main` ~89 MB + `daily` ~23 MB); afterwards `ScriptedUpdates` fetches a few
hundred KB per refresh. Refusing to screen is the correct behaviour, and it is
visible rather than silent — which is the whole difference from the defect above.

### Operator verification

Health is the fleet-wide check; run it after any deploy that touches the image.

```bash
curl -sS -H "Authorization: Bearer <interviewer+ token>" \
  https://<api-host>/api/integrations/ashby/mission-control/health \
  | jq '{status, reasons, scanner}'
```

Expected once a machine has completed its first update:

```json
{
  "status": "healthy",
  "reasons": [],
  "scanner": { "mode": "clamav", "ready": true, "signatureAgeSec": 1832, "maxAgeSec": 86400, "reason": null }
}
```

`signatureAgeSec` should normally sit well under `AV_UPDATER_INTERVAL_MS / 1000`.
The first authenticated health read also performs a cached real EICAR binary
proof and can take one scan budget. `ready: false` with `signatures_missing` in
the first minute after a deploy is expected; `capability_timeout`,
`capability_failed`, or `scanner_busy` means the binary/resource proof did not
pass and activation must stop.

To verify the container itself (image build + rehearsal, before deploying):

```bash
docker build -t hello-api-av app/api
# 1. no database is baked in
docker run --rm --entrypoint ls hello-api-av -la /var/lib/clamav
# 2. the runtime user owns the database directory and cannot rewrite its config
docker run --rm --entrypoint id hello-api-av            # uid != 0
docker run --rm --entrypoint stat hello-api-av -c '%U %a' /var/lib/clamav /etc/clamav/freshclam.conf
# 3. a real update, then a real scan: clean accepted, EICAR rejected
docker run --rm --entrypoint sh hello-api-av -c '
  freshclam --config-file=/etc/clamav/freshclam.conf --stdout >/dev/null &&
  printf "ordinary resume" > /tmp/clean.txt &&
  clamscan --no-summary --infected /tmp/clean.txt; echo "clean exit=$?" &&
  printf %s "X5O!P%@AP[4\\PZX54(P^)7CC)7}\$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H+H*" > /tmp/eicar.txt &&
  clamscan --no-summary --infected /tmp/eicar.txt; echo "eicar exit=$?"'
# expect: clean exit=0, eicar exit=1, and NO "database is older than" warning
```

### Rollback

Rollback is configuration-only; nothing here has a migration or a data footprint.

| Symptom | Action |
|---|---|
| Ingestion blocked and you must accept a slightly older database | Raise `RESUME_SCANNER_MAX_DB_AGE_HOURS` (bounded 1–168). **Never above 168**, and treat it as an incident, not a setting. |
| Updater failing persistently (CDN rate limit / egress block) | Leave it fail-closed. Resume ingestion pauses; every other surface is unaffected. Do **not** disable the freshness check. |
| The whole scanner change must be reverted | `fly deploy` the previous image. `RESUME_SCANNER=test` is **not** a valid production rollback: the test scanner is not anti-malware evidence and health reports it `ready: false` with reason `test_scanner`. |
| Ingestion must stop entirely | Pause the mappings (§6), or `ASHBY_RUNTIME_ENABLED=false`. |

There is deliberately no switch that accepts a stale database. The only way to
scan is to have current signatures and a passing real-binary capability proof.

Accepted availability/defence-in-depth residuals for this phase:

- A new machine depends on ClamAV's CDN for its initial database. Rate limiting
  leaves resume ingestion visibly fail-closed; it never weakens scanning or
  takes down unrelated API surfaces.
- The non-root API/updater user owns the signature directory. A future hardening
  phase may split updater and parser UIDs; current protection assumes no API
  remote-code execution and never treats header freshness as the sole readiness
  proof.

---

## 5. Handing the candidate their link (manual delivery)

Minting an invite produces only a SHA-256 digest — by design, so a leaked
database or log cannot be replayed. That means the plaintext link exists for
exactly one moment: the HTTPS response to an authenticated admin.

**Operator flow.** Mission Control → *Application workflows* → **Get invite
link** (or **Reissue invite link**). The link is shown once with its true
expiry and a Copy button; send it to the candidate yourself. Equivalent API:

```
POST /api/integrations/ashby/mission-control/workflows/{applicationLinkId}/invite
```

**Guarantees.**

- Admin-only. Interviewer, viewer, candidate and unauthenticated callers get
  403 and no token is minted.
- Atomic revoke-then-issue in one transaction: reissuing kills the previous
  link before the new one exists, so there is never more than one live invite
  for the session.
- Exactly 24 hours, pinned by a database CHECK.
- The response is `Cache-Control: no-store, private`. The token rides in the
  URL **fragment**, which browsers never send to a server, and the candidate
  page moves it straight into memory and strips it from the address bar.
- The token is never logged, audited, persisted, placed in a query string, or
  sent to Ashby. Only its digest reaches the database.
- Refused for a terminal application (`blocked_terminal`) and for one whose
  screening session has not been materialized yet (`not_ready`).

**Why the operation says `awaiting_manual_delivery`.** Until a human has taken
possession of a usable link, no candidate can be contacted. Reporting that
operation as `succeeded` — which an earlier revision did — told the operator
delivery had happened when it had not. `succeeded` now means exactly one thing:
an authorized admin obtained the link.

**The link is genuinely unrecoverable.** If it is lost, reissue. There is no
"show it again", because the server does not have it.

**Why the email operation ends `failed / blocked_provider`.** The email channel
is provider-gated and has no transport wired at all, so it sends nothing. The
worker therefore records it as a durable, NON-retryable failure carrying the
sanitized reason `blocked_provider` rather than completing it. Marking it
`succeeded` would be the same untruth the manual channel was repaired for: an
operator reading Mission Control would see a delivered email that no candidate
ever received. A mapping in `email` or `both` mode will accumulate these; that
is the honest signal that the mapping needs a decision — switch it to the manual
channel, or wait for an approved provider and verified domain. The manual half
of a `both` mapping is unaffected and still delivers.

## 6. Rollback

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

## 7. Why nothing is written back to Ashby (read this before "fixing" it)

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

## 8. Health and operability

`GET /api/integrations/ashby/mission-control/health` (interviewer+). Returns
**booleans, bounded integers and counts only** — never the API key, the webhook
secret, an allowlisted host, an invite token, a presigned URL, or any candidate
field. `provider` is always `unknown`: the handler contacts no provider, so
claiming `ok` would be a lie.

The public `GET /api/health` deliberately remains a liveness-only `{ok:true}`.

**Three independent signals, because none alone is truthful.**

1. **In-process scheduler heartbeat** (`scheduler`): real tick bookkeeping from
   the live scheduler handle — `lastTickAt`, `ticks`, `errors`,
   `consecutiveErrors`, and a `stale` flag when a loop has not ticked within
   three of its own intervals (floor 30 s). `registeredInThisProcess: false`
   means *this machine* has no scheduler; it is **not** a claim about the fleet,
   because `auto_start_machines` can run several machines.
2. **Durable backlog** (`backlog`): correct on any machine — `queuePending`,
   `dlqDepth`, `oldestPendingAgeSec`, `operationsPending`, `operationsFailed`,
   `operationsAwaitingDelivery`, `writebackPending`, `reconcileNoProgressRuns`,
   `reconcileLastSuccessAt`, and (0035) `operationsBlockedPrerequisite`,
   `operationsFailedPrerequisite`, `ingestionStuckQueued`,
   `ingestionStuckFetching`, and `operationsBlockedFailedIngestion`. The last four separate "waiting on a prerequisite"
   from "broken": a prerequisite-gated invite counts as `operationsPending`
   forever and a stranded ingestion had no signal at all, so a failure of that
   shape was previously discoverable only by direct database inspection. See
   [ashby-canary-ingestion-delivery-recovery.md](ashby-canary-ingestion-delivery-recovery.md).

3. **Malware scanner readiness** (`scanner`, §5a): the resume path is
   fail-closed without current ClamAV signatures, so an activation health
   surface that ignored it would show `healthy` while every ingestion was being
   refused. Reports a mode enum, `ready`, `signatureAgeSec`, `maxAgeSec` and a
   stable reason code — never a path, a ClamAV or signature version, a mirror,
   or a filename. The built-in development test scanner is **never** `ready`.

`status` is `healthy` / `degraded` / `idle` (idle = the integration is switched
off, which is neither healthy nor broken), with stable `reasons` codes:
`dlq_non_empty`, `queue_not_draining`, `reconciliation_not_advancing`,
`scheduler_loop_stale`, `scheduler_stopped`, `backlog_unavailable`,
`scanner_signatures_stale`, `scanner_signatures_missing`,
`scanner_signatures_unreadable`, `scanner_signatures_corrupt`,
`scanner_test_scanner`, `scanner_scanner_not_configured`. Thresholds
are returned in the payload so an alert can be written against them.

**Config-active is never reported as worker-live**: an integration with every
flag on but a dead scheduler reports `degraded`, not `healthy`.

### Triage

| Symptom | Likely cause | Action |
|---|---|---|
| Jobs accumulate, no imports | Runtime flags off, or the mapping is paused/drifted | Check health booleans; check mapping status. |
| Resume ingestion always `failed_review` with an allowlist reason | `ASHBY_RESUME_HOSTS` empty or wrong | Set the EXACT presigned host. No wildcards. |
| Resume ingestion always `failed_review` and health shows `scanner.ready: false` with `signatures_missing` | The machine has not completed its first signature update (normal for ~30–60 s after a deploy), or the updater cannot reach the CDN | Wait one interval and re-check. If it persists, check egress to `database.clamav.net`; the scanner stays fail-closed until it succeeds (§5a). |
| Health shows `scanner_signatures_stale` | Updates have been failing long enough for `daily` to pass `RESUME_SCANNER_MAX_DB_AGE_HOURS` | Investigate egress/rate limiting. Do **not** widen the ceiling as a fix; ingestion refusing to run on dead signatures is the intended behaviour. |
| Health shows `scanner_test_scanner` in production | `RESUME_SCANNER` is not `clamav` | The development scanner is not anti-malware evidence. Set `RESUME_SCANNER=clamav` and redeploy. |
| Ingestion stuck at `failed_review` and refusing to requeue | Requeue ceiling (5) reached — 0032 returns `retry_exhausted` | Investigate the underlying fetch/scan/parse failure; this is a deliberate stop, not a bug. |
| `no_progress_runs` climbing on a checkpoint | A full resync is permanently larger than `item_cap` | Raise `maxItems`/`maxPages` for that stream, or investigate why the stream will not drain. **Do not** "fix" it by advancing a partial cursor — that skips applications permanently. |
| Reconciliation never runs | Another runner holds the single-flight lease, or the lease is stranded | `begin_ashby_sync_run` returns `locked`; the lease self-expires on its deadline. |
| DLQ growing | Repeated handler failures | Inspect `job_dlq`; replay with `replayDlq` after fixing the cause. |
| Retry refused with `blocked_terminal` | The application is withdrawn/deleted/cancelled | Correct — terminal work is never resurrected. |
| Retry refused with `retry_exhausted` | `attempts` reached `max_attempts` | Deliberate bound. Investigate rather than forcing. |
| `operationsAwaitingDelivery` climbing | Invites minted but no admin has taken the links | Expected until an operator runs the §5 hand-off. Not an error. |
| `operationsBlockedPrerequisite` non-zero | Invites correctly WAITING on a paused mapping or an unfinished resume ingestion | Not an error, and it consumes no attempt. Resume the mapping, or let ingestion finish. Subtract `operationsBlockedFailedIngestion` for the genuinely transient count. |
| `invite_blocked_failed_ingestion` in `reasons` | An invite is blocked behind a `failed_review` ingestion, which only a human can requeue | Real, non-transient. Fix the `failed_reason` cause, then requeue the ingestion per §2a of the recovery runbook. It will never clear on its own. |
| `ingestion_stuck` in `reasons` | A resume ingestion has sat in `queued`/`fetching` past the stuck window | Real fault. Diagnose via the recovery runbook — check the scanner first, it is the usual cause. |
| `invite_prerequisite_failed` in `reasons` | Invites killed by the pre-0035 ordering defect | Recovery backlog, not a live fault. Run `reopen_ashby_invite_delivery` per the recovery runbook. |
| `writebackPending` climbing | Screenings completing with no approved result sink | Expected (§7). These are results awaiting manual publication. |
| A workflow shows `screened: not parked` (session `completed`, lifecycle not `writeback_pending`, not terminal) | The completion observer's park did not land — it is best-effort so that a transient failure can never discard a scored assessment | The assessment itself is safe and visible on the ordinary session surfaces. Nothing downstream waits on `writeback_pending` (there is no result sink), so this is a bookkeeping gap. Re-parking is idempotent: it self-corrects on any later completion for that session, and the state is legible here rather than log-only. |
| An `invite_delivery` operation shows `failed / blocked_provider` | The email channel is gated off (§5) | Expected for `email`/`both` mappings. Switch the mapping to `manual`, or wait for an approved provider. |
| Health `degraded` with `scheduler_loop_stale` | A loop stopped ticking on THIS machine | Check the process; the backlog fields tell you whether another machine is still draining. |

---

## 9. Known limitations recorded honestly

- **Pinned-IP failover is live** (`resume-transport.ts`). `maxPinnedIps` is no
  longer computed-and-ignored: the transport now walks a bounded, ordered set
  of the already-validated addresses (IPv4 first, then IPv6, resolver order
  preserved within each family, de-duplicated, capped at 4) and moves to the
  next one **only** on a connect/TLS/socket failure raised *before* a response
  begins. Once the server has answered — any status, any byte of body — the
  attempt is final, because replaying a one-shot presigned GET is neither safe
  nor useful. The whole sequence shares the caller's single wall-clock budget,
  so failover cannot extend the fetch deadline. Ordering does not filter:
  every address the orchestrator asserted public stays eligible, so the
  upstream all-address check is not quietly narrowed to "the v4 records were
  fine".
- **Reconciliation progress strategy** is option (c) from the acceptance matrix:
  keep the bounded caps and make a non-advancing run *observable* via
  `no_progress_runs`, rather than advancing a partial cursor. Chosen because
  advancing past unprocessed work would silently skip applications.
- **Health is now heartbeat + backlog derived** (§8). The heartbeat is
  process-local by necessity; the backlog is the fleet-wide signal.
- **No web UI** for the mapping-provisioning or stage-probe endpoints — they
  remain API-only. Mission Control *does* now carry the manual invite hand-off
  (§5).
- **`consent_at` is NULL for Ashby-originated candidates.** The recruiter upload
  path stamps it because a human watched the submission happen; an Ashby import
  has no such moment — the applicant consented in the tenant's system at a time
  only the tenant knows. Writing `now()` would fabricate a consent timestamp, so
  it is deliberately left null. This is also the safe choice: the column default
  keeps `consent_source='job_application'`, so the DSAR/recording/outbound gates
  stay exactly as restrictive as for every other candidate — nothing is
  over-permitted. Setting a real value needs the tenant/legal evidence that is
  out of scope here (Legal D-010 remains an unwaived go-live gate).
- **Queue error text is allowlisted, not denylisted.** A handler error that is
  not already a stable snake_case code is persisted as `unknown_error`; the
  detail is lost on purpose so a driver message carrying row content can never
  reach `job_queue.error_message` or the DLQ.
