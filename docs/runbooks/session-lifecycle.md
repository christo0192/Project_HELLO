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
- `recording_object_key` (uploaded async by LiveKit; stored as object key, not signed URL)
- `recording_url` 🟡 **DEPRECATED** — legacy column, present in schema but never written
  by active code; all recording references use `recording_object_key`.

`status` and `terminal_reason` are immutable once set to a terminal value.

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

## Shutdown (REL-08)

`createShutdownController` provides bounded graceful shutdown:
- SIGTERM/SIGINT triggers `server.close()` + in-flight request drain
- `graceMs` default 30s (configurable, validated 100–300000ms integer)
- If drain completes before deadline → exit code 0
- If deadline expires → force-destroy sockets → exit code 1
- `server.close()` synchronous throw → exit code 1 immediately
- Repeated signals are silently ignored
- In-flight tracking is dynamic (not captured at trigger time)
