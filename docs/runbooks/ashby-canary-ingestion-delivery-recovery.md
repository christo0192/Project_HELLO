# Runbook — recovering the live synthetic canary after the ingestion/delivery ordering fix

**Scope.** One application link whose resume ingestion dead-lettered and whose
`invite_delivery` operation was driven to `failed / ingestion_not_ready` with
`attempts = 5 = max_attempts`. This is the exact shape the live synthetic canary
produced at `b92e590`.

**Audience.** An operator with service-role access to the production database
(`fly ssh` into the API machine, or an equivalent service-role session). Every
step below is service-role-only; none of it is reachable from a browser role.

**Nothing in this document contains a tenant, application, job, candidate, or
link identifier.** Every id is resolved at run time. Do not paste one into a
committed file.

---

## 0. Preconditions — all three, in order

1. **Both code fixes are deployed.** Replaying the ingestion job before them
   reproduces the identical failure and consumes the replay. Confirm the running
   image contains:
   - migration `0035` and the 512-bound `MAX_FILE_HANDLE_LEN` (the ordering /
     file-handle fix), **and**
   - migration `0036` and the Node 22 pinned-lookup fix in
     `resume-transport.ts` (the transport fix, below). Without it *every* resume fetch fails, so the recovery in this
     document will run to completion and still leave the ingestion in
     `failed_review`.

   **The transport fix, in one paragraph.** The pinned-IP transport injects its
   own DNS `lookup` so the socket connects to an address that was already
   asserted public. Node 22 calls that lookup with `{ all: true }` (the
   `autoSelectFamily` default) and expects an **address array** back; the old
   implementation always answered with the legacy `(address, family)` tuple, so
   Node read an array out of a bare string and rejected the connect with
   `ERR_INVALID_IP_ADDRESS` before a single packet left the machine. The failure
   surfaced as ingestion `failed_review / fetch_http_error` while the very same
   presigned URL fetched fine by hand (`200`, a real PDF) — which is the
   signature to look for. The lookup now answers both shapes and still never
   falls back to system DNS.
2. **The runtime is still off** (or the mapping still paused) while you inspect.
   Turn it on only at step 3.
3. **You have read the current state** rather than assuming it. Step 1 below is
   read-only.

---

## 1. Read the current state (read-only)

Resolve the link from the application id, then read the three objects that
matter — the link, its ingestion, and its invite operations:

```sql
-- Substitute the application id at the prompt; never store it.
select l.id            as application_link_id,
       l.terminal_state,
       l.external_resume_file_handle is not null as resume_backed,
       length(l.external_resume_file_handle)     as handle_len,
       m.status         as mapping_status,
       i.state          as ingestion_state,
       i.attempts       as ingestion_attempts,
       i.failed_reason
  from screening_v2.ashby_application_links l
  left join screening_v2.ashby_job_mappings      m on m.id = l.job_mapping_id
  left join screening_v2.ashby_resume_ingestions i on i.application_link_id = l.id
 where l.provider = 'ashby'
   and l.external_application_id = :application_id;

select id, operation_type, state, attempts, max_attempts, error_code, operation_key
  from screening_v2.ashby_operations
 where application_link_id = :application_link_id
 order by created_at;
```

**Read `ingestion_attempts` now, before you deploy anything.** It decides
whether the recovery below is executable at all. The requeue in §2a is bounded
at **5** attempts by `advance_ashby_ingestion` (0032), and the pinned-transport
defect failed *every* fetch identically — so the counter may already be at the
ceiling, burned entirely by one now-fixed fault. If `ingestion_attempts >= 5`,
go to **§2a-0** first; starting §2a without it dead-ends at `retry_exhausted`
halfway through the recovery.

`handle_len` on the canary reads **270**. That value was rejected pre-transport
by the old 256 id bound; under the fix it is comfortably inside the 512
file-handle bound.

Also read the fleet-wide counters, which exist as of `0035` and are the honest
answer to "is this waiting or is it broken":

```sql
select screening_v2.ashby_prerequisite_backlog(900);
```

- `ingestion_stuck_queued` / `ingestion_stuck_fetching` — stranded ingestions.
- `pending_blocked` — invites WAITING on a prerequisite (the total).
- `pending_blocked_failed_ingestion` — the **subset** of those that will never
  clear on their own, because the link's ingestion ended `failed_review` and only
  a human can requeue it (see §2a). This one degrades `/health` with
  `invite_blocked_failed_ingestion`; subtract it from `pending_blocked` to get
  the genuinely transient count.
- `failed_prerequisite` — invites already killed by the ordering defect; this is
  the count step 4 reduces. Nothing new can enter it after `0035`.

The same four counters surface on `GET /api/integrations/ashby/mission-control/health`
under `backlog`, and a non-zero stuck count degrades the verdict with
`ingestion_stuck`. Read the gates from `/health`, not from the metrics sink —
the sink is a no-op in this deployment.

---

## 2. Replay the ingestion DLQ job — existing primitive, no new SQL

`screening_v2.replay_dlq_job(uuid, timestamptz)` (migration `0028`) is the
correct instrument and needs nothing new: it locks the DLQ row `SKIP LOCKED` so
two racing replays cannot both fire, re-inserts and consumes the row in one
transaction, and resets `dedup_key` to null so the replay cannot collide with a
live dedup key.

### 2a-0. If the attempt ceiling was burned by the transport defect

Skip this whole section if `attempts < 5`. It exists for exactly one situation:
**all five attempts recorded the same now-fixed fault**, so the counter is
measuring one defect five times rather than five independent chances.

```sql
select state, attempts, failed_reason
  from screening_v2.ashby_resume_ingestions
 where application_link_id = :application_link_id;
```

Proceed only when **all** of these hold:

1. `state = 'failed_review'` and `attempts >= 5`;
2. `failed_reason` is one of `fetch_http_error`, `fetch_transport_error`,
   `fetch_timeout`; **and**
3. you have confirmed **by hand** that a freshly minted `file.info` URL for this
   link fetches successfully (`200`, a real PDF).

Step 3 is not ceremony. `resume-fetch.ts` maps *both* a genuine provider error
status *and* a status-0 connect failure to `http_error`, so `fetch_http_error`
on its own **cannot** tell you the cause was the transport. The RPC's allowlist
narrows the field; it cannot make the judgement. That is yours, and it is why
this is an attributable audited call rather than an automatic behaviour.

```sql
select screening_v2.reset_ashby_ingestion_attempts(
  :application_link_id, :acting_admin_user_id);
```

`:acting_admin_user_id` is the real admin's auth UUID — it is what makes the
correction attributable. The call writes an `ashby_ingestion_attempts_reset`
audit event carrying the pre-reset `attempts`, the `failed_reason` that
justified it, and the acting admin.

**What it does and does not do.** It sets `attempts = 0` for that one row and
**nothing else** — the state stays `failed_review`, the ceiling of 5 is
untouched, and no global bound moves. You still take the ordinary §2a exit
afterwards, which charges attempt 1 of 5 exactly as it would have. There remains
exactly **one** way a row leaves `failed_review`, and it is still counted. This
is the same mis-accounting correction that `reopen_ashby_invite_delivery` makes
for invite deliveries (step 4), built to the same shape deliberately.

**Its four refusals**, each independent:

| Refusal | Meaning |
|---|---|
| `not_found` | no ingestion row, or no link |
| `not_resettable` | the row is not in `failed_review` — a live ingestion's counter belongs to the scheduler |
| `blocked_terminal` | the application was withdrawn/deleted/cancelled — the resurrection guard |
| `not_a_transport_failure` | `failed_reason` is outside the transport allowlist. A scan, parse, or guard failure measured a **real** fault; those attempts are not returned. |

`noop` (rather than `ok`) means `attempts` was already 0 and nothing changed.

If you get `not_a_transport_failure`, **stop and read `failed_reason`** — the
ingestion is failing for a different reason and this recovery is the wrong
instrument.

### 2a. First check the ingestion state — a replay onto `failed_review` does nothing

**Read the ingestion row before replaying.** The handler now records
`failed_review` on the last attempt before dead-lettering, so from this point on
a dead-lettered ingestion will usually leave the row in `failed_review` rather
than `queued`. That matters, because the `0029` trigger allows
`queued -> {fetching, cancelled}` **only**: a replayed job against a
`failed_review` row cannot make the `fetching` transition, so the handler returns
early and **the job reports success having done nothing at all.**

```sql
select state, attempts from screening_v2.ashby_resume_ingestions
 where application_link_id = :application_link_id;
```

- **`queued`** — replay directly (this was the canary's state at `b92e590`).
- **`failed_review`** — requeue it first. **This is the canary's state after the
  transport failure**, and it is now the ordinary case: the handler records
  `failed_review` before dead-lettering, so `failed_reason = fetch_http_error`
  is exactly what the pinned-lookup defect leaves behind. **The requeue must
  happen BEFORE the DLQ replay in §2b** — replaying onto a `failed_review` row
  reports success having done nothing, and burns the replay. `failed_review -> queued` is the one
  exit the trigger allows, and `advance_ashby_ingestion` is the audited way to
  take it:

  ```sql
  select screening_v2.advance_ashby_ingestion(
    :application_link_id, 'queued', null, null, null, null);
  ```

  This **increments `attempts`** against the ceiling of 5, and returns
  `retry_exhausted` (leaving the row in `failed_review`) once that ceiling is
  reached.

  If you get `retry_exhausted`, the question is *what those five attempts
  measured*:
  - **Five independent faults** — stop. The cause in `failed_reason` is what
    needs fixing, not the attempt count. Do not reset.
  - **One now-fixed defect, recorded five times** — that is the transport case,
    and §2a-0 is the audited way to correct it. Go there, then come back here.
- **`ready`** or **`cancelled`** — terminal. Do not replay; skip to step 3.

### 2b. Replay the job

Replay **exactly one** job — the `ashby.ingestion` entry for this link:

> **Order matters.** §2a-0 (only if the ceiling was burned) → §2a requeue →
> §2b replay. If §2a returned `retry_exhausted` and §2a-0 does not apply, do not
> replay at all — the ingestion has genuinely failed five times and the cause in
> `failed_reason` is what needs fixing.

```sql
select id, name, payload->>'applicationLinkId' as link
  from screening_v2.job_dlq
 where name = 'ashby.ingestion'
   and payload->>'applicationLinkId' = :application_link_id;

select screening_v2.replay_dlq_job(:dlq_id);
```

Then let the runtime drain it. The ingestion handler now moves the row
`queued -> fetching` **before** the provider call, so from this point a failure
is durable and visible instead of silently leaving the row in `queued`.

---

## 3. Wait for `ready` — verify, do not assume

Poll the ingestion state for the link:

```sql
select state, attempts, failed_reason
  from screening_v2.ashby_resume_ingestions
 where application_link_id = :application_link_id;
```

- **`ready`** — proceed to step 4.
- **`failed_review`** — **STOP; do not reopen the invite.** `failed_reason`
  carries the sanitized cause (`fetch_invalid_request_*`, `fetch_url_unresolved`,
  `fetch_http_error`, `scan_*`, `guard_*`, `parse_error`, …); diagnose that
  first. A `fetch_http_error` on a URL that fetches fine by hand is the
  pinned-transport signature from precondition 1 — check the deployed image
  before requeuing, or the requeue just spends another attempt. Before `0035` this
  state was unreachable from `queued`, which is why the canary's row read
  `queued` rather than failed.

  Note this is a *hard stop for the invite*, not for the ingestion: once the
  underlying cause is fixed you can requeue via §2a and come back here. But the
  invite stays blocked — and visibly so, via `pending_blocked_failed_ingestion`
  and the `invite_blocked_failed_ingestion` health reason — until the ingestion
  genuinely reaches `ready`.
- **`fetching` for more than ~15 minutes** — the ingestion is stranded, not slow.
  `ashby_prerequisite_backlog` counts it under `ingestion_stuck_fetching`.

---

## 4. Reopen the exhausted invite operation

Only now, and only via the audited RPC. **The existing primitives cannot do
this, and that was verified rather than assumed:**

- `retry_ashby_operation` refuses with `retry_exhausted` at
  `attempts >= max_attempts`. That guard is correct and is not weakened.
- Re-enqueueing is a no-op: `inviteDeliveryOperationKey` fixes the operation key
  at import time with the literal `inviteId = 'pending'`, and
  `enqueue_ashby_operation` is `on conflict do nothing`.
- A direct `UPDATE` bypasses the audit trail and every guard, and is not
  acceptable.

```sql
select screening_v2.reopen_ashby_invite_delivery(:operation_id, :acting_admin_user_id);
```

`:operation_id` is the `invite_delivery` row from step 1. `:acting_admin_user_id`
is the real admin's auth UUID — it is what makes the recovery attributable.

**Its six guards, each of which refuses independently:**

| Refusal | Meaning |
|---|---|
| `unsupported_operation_type` | not an `invite_delivery` — `scorecard_write` / `stage_move` are never reopened, preserving the result-sink refusal |
| `not_retryable` | the operation is not in state `failed` |
| `blocked_terminal` | the application was withdrawn/deleted/cancelled — the resurrection guard |
| `blocked_mapping` | the mapping is no longer `enabled` |
| `ingestion_not_ready` | a resume-backed link whose ingestion is not `ready` |
| `not_a_deferral` | the recorded `error_code` is outside the deferral allowlist |

That last guard is the one that matters most. The allowlist is exactly
`ingestion_not_ready` and `mapping_inactive`. A delivery that failed for a REAL
delivery reason — `blocked_provider`, `invalid_reissue_path`, `candidate_missing`,
`persist_failed` — is refused, which is what keeps this RPC from becoming a
general-purpose back door around `max_attempts`.

**On the attempt counter.** The reopen sets `attempts = 0` for that one row and
leaves `max_attempts` untouched. This is a correction of a **mis-accounting**,
not a relaxation of a safety control: under the old code those five attempts
were *deferrals* — waits — booked against the failure budget by the ordering
defect. It is strictly safer than raising `max_attempts`, which would permanently
enlarge the budget for genuine failures too. The audit row records the pre-reset
`attempts`, the `error_code` that justified the reset, and the acting admin.

---

## 5. Verify the outcome, then verify the ordering property

```sql
select l.candidate_id, l.session_id, l.invite_id, l.lifecycle,
       o.state, o.attempts, o.error_code
  from screening_v2.ashby_application_links l
  join screening_v2.ashby_operations o on o.application_link_id = l.id
 where l.id = :application_link_id and o.operation_type = 'invite_delivery';
```

> **The invite is now joinable.** A delivered Ashby invite used to dead-end at
> `POST /api/livekit/exchange`, because materialization leaves the session in
> `created` with a NULL `external_call_id` and nothing provisioned a LiveKit
> room for an *existing* session. That room and its authoritative egress are now
> provisioned just-in-time on exchange — see
> [`ashby-room-provisioning.md`](./ashby-room-provisioning.md). If a candidate
> reports "We could not open your screening room just now", that is a 503 on
> the provisioning step and the invite is **still valid**; do not reissue it.

Expect **exactly one** candidate, one session, one invite, and the manual
operation resting at **`awaiting_manual_delivery`** — *not* `succeeded`.
`succeeded` on an `invite_delivery` means one thing only: an authorized human
took possession of a usable link, which happens in `mark_ashby_invite_delivered`
via the Mission Control delivery endpoint.

Then confirm the property that made the recovery necessary is now enforced:

```sql
select screening_v2.ashby_prerequisite_backlog(900);
```

`failed_prerequisite` should have dropped by the number of rows you reopened,
and it must not grow again. If it does, the claim gate in `0035` is not in
effect on that database — check that migration `0035` actually applied before
doing anything else.

---

## What changed, so this recovery is needed once and not repeatedly

1. **`file.info` validates the handle with its own 512 bound**, not the 256 id
   bound. 512 is one cross-layer contract: the client constant, the resume-handle
   extractor, and the `0029` column CHECK. If a tenant ever produces a longer
   handle, all three move in the same change — never independently.
2. **A permanent provider error fails the ingestion job once**, with a durable
   sanitized reason, instead of five identical attempts into the DLQ.
3. **The ingestion leaves `queued` before the provider call**, so a failure at
   that stage reaches `failed_review` instead of stranding the row forever.
4. **Prerequisites are part of what RUNNABLE means.** `claim_ashby_operation`
   will not hand out an `invite_delivery` whose mapping is paused, or whose
   resume-backed link is not ingestion-ready. Waiting therefore costs no attempt,
   and the operation becomes claimable again on the next poll after the
   prerequisite is satisfied — no wake-up plumbing, no polling storm.

   **Promptly, not instantly.** An idle scheduler loop backs off geometrically to
   a 60-second ceiling, and a prior deferral adds its own clamped delay on top,
   so expect roughly **one to two minutes** between an ingestion reaching `ready`
   and the invite being claimed. That is fine for invite delivery — but do not
   build a tighter timing expectation on it, and do not read a 90-second gap as a
   stall.
5. **The post-claim race defers instead of failing.** `defer_ashby_operation`
   refunds the attempt the claim charged and reschedules behind a clamped delay.
6. **Blocked and stuck work is visible** in `/health` rather than only by direct
   database inspection.
7. **The pinned transport speaks Node 22's lookup contract**, so the resume
   fetch can actually connect. It also fails over across the resolved addresses
   — bounded, ordered, within the same wall-clock budget, and only while nothing
   has been served yet. Failover covers an address that refuses, resets, or
   fails TLS **and** one that silently drops packets: the latter raises no error
   at all, so each attempt carries its own 5s connect sub-budget whose expiry
   counts as a bad address rather than as the clock running out. The overall
   deadline still wins, so this can only make a fetch finish sooner.
8. **A ceiling burned by one defect can be corrected, once, with attribution.**
   `reset_ashby_ingestion_attempts` (0036) returns the attempts a single
   transport fault consumed — allowlisted by `failed_reason`, refused on a
   terminal application or a non-`failed_review` row, audited with the pre-reset
   count, and leaving both the state and the ceiling untouched (§2a-0).
