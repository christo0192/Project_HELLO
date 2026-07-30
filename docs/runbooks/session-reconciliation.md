# Session Reconciliation Runbook (REL-09)

## Phase 3 implementation context

This runbook reflects the **local-only Phase 3 implementation** on commit
`de4d25c` (PR27 baseline). All data is **synthetic-only**; no production
project connected; no real candidate data or provider credentials used.

| Aspect | Current (Phase 3) | Future production |
|--------|-------------------|-------------------|
| Persistence | Local Supabase via `supabase-local.sh` | Production Supabase with MIG-01+ |
| Data | Synthetic seed data only (GOV-06) | Real candidate screening data |
| Voice provider | LiveKit — active | Same LiveKit |
| Reconciler triggers | Manual or cron | Scheduled job + event-driven |
| Quarantine actions | Log + DB record only | Could integrate with alerting |

---

## 1. Overview

The reconciliation system provides **read-only detection** of data
inconsistencies across the screening pipeline, with **safe, idempotent
repair plans** for stuck sessions and a **quarantine mechanism** for
sessions that need human review.

### What it detects

| Category | Description | Severity | Auto-repair |
|---|---|---|---|
| `stuck_session` | Session in `waiting`, `created`, or `in_progress` past timeout | error/warning | ✅ → `expired` |
| `orphan_room` | Session in `waiting` with no worker attached | error | ✅ → `expired` |
| `transcript_gap` | Terminal session (`completed`/`failed`) with zero transcript turns | critical/warning | ❌ → quarantine if `completed` |
| `missing_recording` | `completed` session with no `recording_object_key` | error | ❌ → quarantine |
| `overdue_scorecard` | `completed` session with no assessment row | warning | ❌ → quarantine |

### Timeouts (configurable)

| State | Default timeout | Reason code |
|---|---|---|
| `waiting` | 5 minutes | `idle_timeout` |
| `created` | 30 minutes | `idle_timeout` |
| `in_progress` | 2 hours | `idle_timeout` |

---

## 2. Detection

### Running a full reconciliation scan

The `reconcile()` function runs all five detectors and logs results to
`reconciliation_log`.

```typescript
import { reconcile } from '../lib/reconciliation.js';

// Run with defaults (5 min / 30 min / 2 hour timeouts)
const report = await reconcile();

console.log(report.summary);
// { stuck_session: 0, orphan_room: 0, transcript_gap: 0,
//   missing_recording: 0, overdue_scorecard: 0 }

// With explicit run ID and custom timeouts
const report2 = await reconcile(crypto.randomUUID(), {
  waitingTimeoutMs: 10 * 60 * 1000,    // 10 min
  createdTimeoutMs: 60 * 60 * 1000,    // 1 hour
  progressTimeoutMs: 4 * 60 * 60 * 1000, // 4 hours
});
```

### Report structure

```typescript
interface ReconciliationReport {
  runId: string;          // UUID for this run
  detectedAt: string;     // ISO-8601
  issues: ReconciliationIssue[];
  summary: Record<IssueCategory, number>;
  total: number;
}

interface ReconciliationIssue {
  runId: string;
  category: IssueCategory;
  severity: 'info' | 'warning' | 'error' | 'critical';
  sessionId: string | null;
  candidateId: string | null;
  signature: string;      // deterministic hash for idempotent logging
  description: string;
  details: Record<string, unknown>;
}
```

---

## 3. Repair Plans

### Generating a plan

```typescript
import { planRepair } from '../lib/reconciliation.js';

const plan = planRepair(issue);
// { issue, action: 'transition_to_expired', reason: '...' }
```

### Executing a repair

```typescript
import { executeRepair } from '../lib/reconciliation.js';

const result = await executeRepair(plan);
// { ok: true, action: 'transition_to_expired', sessionId: '...' }
```

### Repair actions

| Action | Effect | Idempotent? |
|---|---|---|
| `transition_to_expired` | CAS transition to `expired` with reason `idle_timeout` | ✅ Conflict → noop |
| `transition_to_failed` | CAS transition to `failed` with reason `provider_error` | ✅ Conflict → noop |
| `quarantine_session` | Insert into `quarantined_sessions` table | ✅ Unique constraint → noop |
| `noop` | No action taken | ✅ Always safe |

### Idempotency guarantees

1. **CAS transitions**: The underlying `transitionSession()` uses Supabase
   compare-and-set (`.eq('status', expectedStatus)`). If the session has
   already transitioned, the CAS returns 0 rows → `conflict: true` →
   repair is recorded as noop.

2. **Quarantine inserts**: `quarantined_sessions` has a UNIQUE constraint
   on `session_id`. Re-inserting the same session is a no-op.

3. **Issue logging**: `reconciliation_log` has a UNIQUE constraint on
   `issue_signature` (deterministic hash of category+session_id). The
   `logIssues()` function uses `ON CONFLICT DO NOTHING` semantics.

---

## 4. Database Schema

### `reconciliation_log`

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `run_id` | UUID | Groups issues from one `reconcile()` call |
| `detected_at` | timestamptz | When the issue was detected |
| `issue_category` | text | `stuck_session`, `orphan_room`, `transcript_gap`, `missing_recording`, `overdue_scorecard` |
| `severity` | text | `info`, `warning`, `error`, `critical` |
| `session_id` | UUID (FK → call_sessions) | Nullable |
| `candidate_id` | UUID (FK → candidates) | Nullable |
| `issue_signature` | text (UNIQUE) | Deterministic hash for idempotency |
| `details` | jsonb | Arbitrary details |
| `repaired` | boolean | Whether a repair action was applied |
| `repair_action` | text | The repair action taken |
| `repair_reason` | text | Human-readable summary |
| `quarantined` | boolean | Whether the session was quarantined |
| `created_at` | timestamptz | Row creation time |

**Append-only**: UPDATE/DELETE triggers raise an error. Only the
`repaired`, `repair_action`, `repair_reason`, and `quarantined` columns
are SET during repair (not a row mutation per se — the table is
append-only for inserts; repair columns are updated in place).

### `quarantined_sessions`

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `session_id` | UUID (UNIQUE, FK → call_sessions) | Session under quarantine |
| `candidate_id` | UUID (FK → candidates) | Nullable |
| `quarantined_at` | timestamptz | When quarantined |
| `quarantined_by` | text | `reconciler`, `manual`, `system` |
| `reason` | text | Human-readable explanation |
| `details` | jsonb | Arbitrary details |
| `resolved` | boolean | Whether a human has resolved this |
| `resolved_at` | timestamptz | When resolved |
| `resolved_by` | text | Who resolved it |
| `resolution_note` | text | Resolution notes |
| `created_at` | timestamptz | Row creation time |

---

## 5. Database Functions

Three helper functions are installed by migration `0011`:

### `stuck_sessions(waiting_timeout_sec, created_timeout_sec, progress_timeout_sec)`

Returns sessions stuck in non-terminal states past configurable timeouts.

```sql
SELECT * FROM screening_v2.stuck_sessions(300, 1800, 7200);
```

### `sessions_without_transcripts()`

Returns terminal sessions (`completed`, `failed`) with no transcript turns.

```sql
SELECT * FROM screening_v2.sessions_without_transcripts();
```

### `sessions_missing_recording()`

Returns completed sessions with no `recording_object_key`.

```sql
SELECT * FROM screening_v2.sessions_missing_recording();
```

### `missing_assessment_sessions()`

Returns completed sessions with no assessment row.

```sql
SELECT * FROM screening_v2.missing_assessment_sessions();
```

---

## 6. Running Reconciliation

### Manual trigger (Node)

```bash
cd app/api
npx tsx -e "
import { reconcile, planRepair, executeRepair } from './src/lib/reconciliation.js';
const report = await reconcile();
console.log(JSON.stringify(report.summary, null, 2));
// Auto-repair stuck sessions and orphan rooms
for (const issue of report.issues) {
  const plan = planRepair(issue);
  if (plan.action !== 'noop') {
    const result = await executeRepair(plan);
    console.log(result.action, result.sessionId, result.ok);
  }
}
"
```

### SQL queries for investigation

```sql
-- All unresolved issues from the last run
SELECT * FROM screening_v2.reconciliation_log
WHERE NOT repaired
ORDER BY detected_at DESC;

-- Sessions currently quarantined
SELECT q.*, s.status, s.mode
FROM screening_v2.quarantined_sessions q
JOIN screening_v2.call_sessions s ON s.id = q.session_id
WHERE NOT q.resolved;

-- Stuck sessions (5-min waiting timeout)
SELECT * FROM screening_v2.call_sessions
WHERE status IN ('created', 'waiting', 'in_progress')
  AND (
    (status = 'waiting' AND waiting_at < now() - interval '5 minutes')
    OR (status = 'created' AND created_at < now() - interval '30 minutes')
    OR (status = 'in_progress' AND started_at < now() - interval '2 hours')
  );
```

---

## 7. Negative Tests

The reconciliation system is verified with focused negative tests:

| Test | What it proves |
|---|---|
| Stuck sessions detected with correct severity | error for `waiting`/`created`, warning for `in_progress` |
| Transcript gaps: `completed` → quarantine, `failed` → noop | Context-aware decisions |
| Repair is idempotent on CAS conflict | Running repair twice is safe |
| Quarantine is idempotent on re-insert | Unique constraint prevents duplicates |
| Repair actions are audited in `reconciliation_log` | Every repair leaves an audit trail |
| Detector failure doesn't poison whole run | Each detector is isolated |

---

## 8. Not covered (Phase 3 scope boundaries)

- **Automatic cron scheduling**: Not implemented. The reconciler is
  designed for manual or cron-triggered invocation.
- **Alerting / notification**: No Slack/email integration. Quarantine
  events are logged to the DB only.
- **Provider fallback switching**: REL-06 fallback decisions are
  documented in `provider-resilience.md`; the reconciler does not
  switch providers.
- **LiveKit room cleanup**: The reconciler marks sessions as `expired`
  but does not call LiveKit's `DeleteRoom` API. That is a separate
  concern (see `livekit.ts` / REL-08).
- **Human review UI**: No dashboard for reviewing quarantined sessions.
  SQL queries are the current interface.

---

## 9. Related documentation

| Document | Topic |
|---|---|
| `provider-resilience.md` | Circuit breaker, timeout, fallback decisions |
| `session-lifecycle.md` | Session state machine, CAS transitions |
| `observability-foundation.md` | Logging, metrics, tracing |
| `mig-export-reconcile.md` | Data export and reconciliation tooling |
