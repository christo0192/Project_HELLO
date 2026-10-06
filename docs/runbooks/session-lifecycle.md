# Session Lifecycle Runbook (REL-07 / REL-08)

## Phase 2 implementation context

This runbook reflects the **local-only Phase 2 implementation** on commit
63f8ba1 (PR25). Key distinctions from any future production state:

| Aspect | Current (Phase 2) | Future production |
|--------|-------------------|-------------------|
| Voice provider | **LiveKit** — active, implemented in `livekit.ts` | Same LiveKit, with Pipecat explicitly stale |
| Pipecat | 🗄️ **Stale** — not a production fallback | Not revived |
| Recording storage | `recording_object_key` stored; short-TTL signed URL minted on download | Same pattern |
| `recording_url` column | 🟡 **DEPRECATED** — present in schema, nullable, never written by active code | Removed or frozen |
| `recording_url` in lifecycle | Referenced below as mutable metadata; this applies to `recording_object_key` in practice | Same |
| Supabase persistence | Local-only; no hosted project connected | Production Supabase MIG-01+ |

> The `recording_url` reference in the mutable-metadata table below reflects
> the legacy column name; the active implementation uses `recording_object_key`.

## State table

| State | Owner | Terminal | Description |
|---|---|---|---|
| `created` | api | no | Row inserted; no room or worker yet |
| `waiting` | api | no | LiveKit room created; token issued; worker not yet attached |
| `in_progress` | api / worker | no | Active session in progress |
| `completed` | worker / api | **yes** | Normal end |
| `failed` | worker / api | **yes** | Error end |
| `cancelled` | api | **yes** | Recruiter cancel or system cancel |
| `expired` | reconciler (REL-09) | **yes** | Idle/grace timeout |

## Allowed transitions

```
created     → waiting, in_progress, cancelled, failed
waiting     → in_progress, cancelled, failed, expired
in_progress → completed, failed, cancelled, expired
completed   → (terminal — immutable)
failed      → (terminal — immutable)
cancelled   → (terminal — immutable)
expired     → (terminal — immutable)
```

Transitions are enforced at the DB level by `trg_session_lifecycle` (BEFORE UPDATE trigger). Any violation raises PostgreSQL error code `P0001` and rolls back the update. The Node API layer uses compare-and-set (`.eq('status', expectedStatus)`) so a zero-row response always means a conflict — never success.

## terminal_reason — Required, per-state conditional constraint

`terminal_reason` is NOT a column NOT NULL. It uses a per-state conditional CHECK constraint:

- **Non-terminal states**: `terminal_reason IS NULL`
- **Terminal states**: `terminal_reason IN (state-compatible codes)` (NOT NULL implicitly enforced by the IN clause)
- **Legacy backfilled rows**: `terminal_reason = 'legacy_unknown'` is allowed for any terminal state (backfilled by 0006 migration)

**`legacy_unknown` is migration-only**. The application layer (persistence.py, session-lifecycle.ts) NEVER accepts `legacy_unknown` for a live transition. It exists solely to keep backfilled rows valid.

## terminal_reason allowlist

| State | Allowable reasons | Notes |
|---|---|---|
| `completed` | `conversation_complete`, `assessment_done` | `conversation_complete` is default |
| `failed` | `room_create_error`, `worker_crash`, `provider_error`, `assessment_error`, `shutdown_forced`, `drain_timeout` | |
| `cancelled` | `recruiter_cancelled`, `migrated_abandoned`, `duplicate_session`, `shutdown_drain` | `migrated_abandoned` = legacy backfill |
| `expired` | `idle_timeout`, `grace_timeout` | |
| Any terminal | `legacy_unknown` | **Migration-only**. Rejected by application layer. |

**Every new terminal transition MUST supply a valid state-compatible reason.** No null is permitted.

## Mutable metadata on terminal sessions

The following lifecycle fields remain mutable even after terminal state is reached:
- `ended_at` (set during terminalization; can be adjusted if needed)
- `duration_sec` (can be updated post-hoc)
- `duration_unobserved_legs` (0115; phone sessions only, see below)
- `recording_object_key` (uploaded async by LiveKit; stored as object key, not signed URL)
- `recording_url` 🟡 **DEPRECATED** — legacy column, present in schema but never written
  by active code; all recording references use `recording_object_key`.

`status` and `terminal_reason` are immutable once set to a terminal value.

### Phone `duration_sec` (0115)

For a phone session (`external_call_id = phone-<uuid>`), `duration_sec` is the sum of the
connected time of its answered legs (`phone_call_attempts`), computed once on first
completion by `set_phone_session_duration` through `phone_session_leg_duration`:

- A leg ends at its **observed** end (`observed_ended_at`, the SIP leave the worker
  reported on `/recording/complete`) when one exists, otherwise at its `ended_at`. Either
  way it is capped at the session's own `ended_at` (the 0076 bound).
- A leg whose only end is the **lease reclaim** (`state = 'abandoned'`, `outcome_class`
  and `abandon_reason` NULL, no `observed_ended_at`, ended no later than the session) is
  **excluded** and counted in `duration_unobserved_legs`. The reclaim time is when our
  sweep noticed, not when the call ended (live session 9f60523d: a 6 min reclaim span on
  an 18 s leg).
- If no answered leg has a known end, `duration_sec` is **NULL** (unknown), never 0 and
  never the reclaim span. Every reader tolerates NULL (funnel sums, DSAR export, the web
  pages).
- `duration_unobserved_legs`: NULL = not computed by the 0115 rule (a session completed
  before 0115 with no reclaimed leg, or not a phone session); 0 = every leg's end is known;
  N > 0 = `duration_sec` is a lower bound (or NULL).

0115 §3c backfilled completed phone sessions that already had a reclaimed leg. That
backfill is a `duration_sec` / `duration_unobserved_legs`-only UPDATE on terminal rows,
which this table allows: neither lifecycle trigger fires, because `status` and
`terminal_reason` do not change. It is idempotent (a backfilled row has
`duration_unobserved_legs >= 1` and is not selected again).

The web app never presents a phone session's `duration_sec` as time "on the call". It
shows the recorded total across the legs, and the connected total only when every leg's
end is known.

## DISABLED persistence

When no Supabase client is available (no `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`):
- `save_turn()` raises `LifecycleError("persistence disabled for active session")` when called with a real session_id
- `activate_session()`, `complete_session()`, `fail_session()` return DISABLED outcome
- The agent entrypoint checks `activate_result.ok` and aborts before provider construction on non-SUCCESS

Only the no-session console path (`session_id = None`) permits silent no-op, because there is no persisted state to protect.

## DB triggers

| Trigger | Purpose |
|---|---|
| `trg_insert_created` | Enforces new rows start at status `created` |
| `trg_session_lifecycle` | Enforces allowed-next transitions; rejects terminal → anything |
| `trg_terminal_reason_immutable` | Rejects changes to a non-null terminal_reason |

## No SECURITY DEFINER reopening seam

Terminal rows are truly immutable for lifecycle fields. If a reopened session is needed (REL-09 reconciler), it must create a NEW row and link back. No SECURITY DEFINER function exists to un-terminate a session.

## Phone engagement terminal relabels (0114, 0115)

A phone screening also has a **phone engagement** (`screening_v2.phone_engagements`), the
dialing cycle that owns the session. Its own trigger,
`enforce_phone_engagement_transition`, makes a terminal engagement (`terminal_at` set)
immutable: no column may change. There are exactly **two** exceptions. Both are relabels
of the state only: `state`, `state_reason`, `version` and `updated_at` change, and
**nothing else**. `terminal_at`, `session_id`, `next_eligible_at` and every budget stay
as they are. Neither exception reopens anything, and neither touches the `call_sessions`
row, which stays `completed` with its `terminal_reason`.

| Migration | From | To | Interlock |
|---|---|---|---|
| 0114 C2 | `failed / assessment_aborted` | `completed / late_score_after_stranded_abort` | A `source='phone'` assessment exists for the bound session, and the abort was the stranded sweep's own applied ledger row. |
| 0115 §5 | `completed` | `failed / screening_abandoned` | The bound session's **latest** assessment (by `created_at`, `revision`, `id`) is a `source='phone'` row graded `insufficient` with a **measured** `evidence_answered = 0`. NULL (unmeasured) never qualifies, nor does a browser row, a `decision` grade or one answered question. The transaction-local GUC `screening_v2.zero_answer_relabel` must name the engagement. |

The GUC is defence in depth that keeps an accidental UPDATE out. It is **not** a security
boundary, because any writer can call `set_config`. Judge the 0115 exception on its data
predicate alone.

A relabel cannot be flipped back. The 0114 exception matches only
`failed / assessment_aborted`, so a later stranded or late completion of a
`failed / screening_abandoned` engagement is refused like any other terminal write.

### `relabel_zero_answer_phone_engagement(p_engagement_id, p_actor_id, p_now)`

This RPC is the only writer of the 0115 relabel. It is SECURITY DEFINER and callable by
`service_role` only. Under the engagement row lock it re-checks the whole predicate, then:

1. Relabels the engagement `completed -> failed / screening_abandoned` (version + 1,
   `updated_at = p_now`). The UI shows it as **"Abandoned: dropped before screening"**,
   which is neutral about who dropped.
2. Moves the candidate `screened -> screening`, never `queued`. The 0114 §4e guards
   apply: this assessment is the candidate's latest, the candidate is not
   decision-blocked, and no non-system `candidate_status_changed` audit exists at or
   after it (a human decided since, so their decision stands). A candidate already at
   `screening` is left alone and not audited.
3. Writes audit rows with **existing** actions: `screening_failed` on the
   `phone_engagement`, and `candidate_status_changed` on the candidate when it moved. Both
   carry `metadata {from, to, reason: 'screening_abandoned', migration: '0115'}` and no
   PII. The all-zero system actor audits as `system`; any other id audits as `recruiter`.

It **never** requeues, rescreens, or creates an attempt, a ledger row or a queue job, and
it never touches the Ashby link. The link stays parked (`writeback_pending`, held for
evidence review). Nothing redials, because `ensure_ashby_phone_engagement` answers
`engagement_terminal` for a terminal cycle.

| Answer | Meaning |
|---|---|
| `applied` | The relabel happened. `candidate_moved` says whether the candidate status moved too. |
| `already` | The engagement is already `failed / screening_abandoned`. Nothing is written (idempotent). |
| `not_eligible` | Nothing is written. `reason` is one of `invalid_request`, `not_found`, `not_completed` or `not_zero_answer`. |

**Callers.** The phone assessment handler (`lib/phone-runtime/assessment-handler.ts`)
calls it as the system actor after the completion post whenever the session's phone
assessment has a measured `evidence_answered = 0`. An RPC error throws, so the job
retries, and the retry calls only the RPC and never re-scores. An operator calls it for a
historical correction with `docs/runbooks/sql/m013-relabel-zero-answer.sql`. Relabelling
historical sessions other than the one the owner approved needs the owner's approval
first.

Since 0115 the API no longer sets `screened` for a phone assessment with a measured
`evidence_answered = 0`, so new cases never pass through `screened`. Browser rows and
unmeasured phone rows keep the old rule, where `insufficient` still sets `screened`.

## Shutdown (REL-08)

`createShutdownController` provides bounded graceful shutdown:
- SIGTERM/SIGINT triggers `server.close()` + in-flight request drain
- `graceMs` default 30s (configurable, validated 100–300000ms integer)
- If drain completes before deadline → exit code 0
- If deadline expires → force-destroy sockets → exit code 1
- `server.close()` synchronous throw → exit code 1 immediately
- Repeated signals are silently ignored
- In-flight tracking is dynamic (not captured at trigger time)
