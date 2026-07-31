# Phase 7 Recording Runbook (REC-01…06)

## Implementation context

Phase 7 (PR2: lanes L5 + L6) builds the **recording productionization**
surface on top of the Phase 1-6 foundations. **All Phase 7 behavior is
synthetic/local-only**: no production project is connected, no provider or
cloud call is made, no real candidate data is used, and no real object store
is touched. Storage deletion runs against an injectable synthetic; the
default binding (Supabase Storage `remove`) is wired but never exercised
against a live bucket.

| Aspect | Current (Phase 7) | Future production |
|--------|-------------------|-------------------|
| Upload path | Secondary/degraded **browser upload** (WebM/OGG/MP3/M4A, magic-byte validated, malware-scanned, SHA-256 verified) | Primary = **LiveKit Egress MP3** (external-pending, REC-01) |
| Storage | Synthetic/in-memory (tests) + Supabase Storage binding (untouched live) | Real object store (Supabase Storage / R2) |
| Erasure | `eraseRecording()` — legal-hold/exception aware, idempotent, tombstones `call_sessions` | Real retention cron + backup expiry (external-pending) |
| Processor propagation | Synthetic stub (intent recorded in audit) | Real processor DPAs / worker pipeline (external-pending) |
| Backup aging | Synthetic model (horizon computed from policy) | Real backup system / expiry job (external-pending) |
| Object versioning | `recording_object_version` populated synthetically | Real version IDs (S3/R2) (external-pending) |
| Malware engine | Fail-closed `resolveScanner` (EICAR always rejected; prod rejects all) | Real AV engine (external-pending) |

**PROPOSED labels:** the reduced upload cap (25 MiB default, 50 MiB hard max),
the download signed-URL TTL (default 300 s), and any retention horizon /
backup window in this document are **PROPOSED** — no Product/SRE/Legal
sign-off implied.

---

## 1. Erasure state machine (REC-06, L6)

`eraseRecording(sessionId, actorId, { storage?, client?, correlationId? })`
in `app/api/src/lib/retention.ts` is the **only** entry point for
recording-object erasure (the C-4 fix: `attemptErasure()` remains the
audit-only DSAR/candidate-level model and deletes nothing).

```
eraseRecording(sessionId, actorId):
  1. isUnderLegalHold('recording', sessionId)        → BLOCK  (audit erasure_blocked_legal_hold, object untouched)
  2. isErasureBlocked('recording', sessionId)        → BLOCK  (exception; same audit, block_reason=erasure_exception)
  3. recording_deleted_at IS NOT NULL                → converged no-op (already_deleted) —
                                                     but if the 'deleted' event and/or success
                                                     completion audit is MISSING, backfill it
                                                     (F3 convergence) and return completed
  4. recording_object_key missing                    → skip delete (absent key = success)
  5. storage.remove(objectKey)                       → SYNTHETIC idempotent delete (fail → failed_storage_delete)
  6. UPDATE call_sessions SET recording_deleted_at=now(), recording_object_key=NULL
                                                     → fail → failed_tombstone
  7. INSERT recording_integrity_events('deleted')    → fail → failed_integrity_event
  8. propagateErasureToProcessors(...)  (synthetic)  +  scheduleBackupAging('recording', ...)  (synthetic)
  9. governance audit 'erasure_completed' (success)  → ONLY when 5+6+7 all succeeded
```

### Ordering rationale (contract-mandated)

- **Object deletion precedes tombstoning.** A failure before the tombstone
  leaves the row untouched and fully retryable; the storage delete is
  idempotent so a retry re-runs cleanly.
- **The tombstone is the access cutoff.** Once `recording_deleted_at` is set,
  the L5 download/grant gate (both mint paths, before `createSignedUrl`)
  returns **404** — a deleted recording can never be re-minted or
  re-downloaded, and no subsequent call can resurrect access.
- **Completion is never claimed on partial failure.** Each failure boundary
  returns a distinct `failed_*` status and records a
  `erasure_completed / outcome=failure` governance audit with the failing
  step; `erasure_completed / outcome=success` is written only after object +
  tombstone + event all succeeded.

### Partial-failure behavior

| Failure boundary | Row state | Object state | Retry | Completion claimed? |
|---|---|---|---|---|
| `storage.remove` throws | untouched (no tombstone) | intact | fully retryable | no (audited failure) |
| tombstone UPDATE errors | untouched (no tombstone) | deleted | retry re-runs remove (idempotent) → completes with exactly one `deleted` event + one success audit | no (audited failure) |
| integrity-event INSERT errors | tombstoned (access blocked) | deleted | **converges (F3 repair): the retry BACKFILLS the missing `deleted` event + success completion audit** (unique partial index `uq_v2_recording_integrity_events_deleted_once` makes the event exactly-once at the DB level), returning `completed` with `converged: true` | no (audited failure) — success audit written only on the converging retry |

> **Convergence (F3 repair):** an integrity-event write failure no longer
> permanently loses the `deleted` evidence. A retry of a tombstoned session
> checks for the `deleted` event + `erasure_completed` success audit and
> backfills whichever is missing, so the append-only log never ends with a
> tombstone and no corresponding event, and exactly one event + one success
> audit exist after convergence (a further retry is `already_deleted` — no
> duplicate evidence). Between a tombstone-write failure and its retry the
> object is already gone while the row is untouched, so a download attempt can
> at worst 500 on the missing object — it can never serve bytes.

### Legal hold / erasure exception precedence

- Active legal hold **or** erasure exception → erasure is **blocked** and the
  attempt is audited (`erasure_blocked_legal_hold`, outcome `blocked`,
  `block_reason` in details); the object is left intact.
- Releasing the hold (`releaseLegalHold`) or revoking the exception
  (`revokeErasureException`) then permits erasure. Checks reuse the existing
  exported functions (`isUnderLegalHold`, `isErasureBlocked`) — no
  re-implementation.

### Storage interface (synthetic, injectable)

```ts
interface RecordingStorage {
  /** Idempotent: removing an absent key resolves as success. */
  remove(objectKey: string): Promise<void>;
}
```

- Default binding: `supabaseStorageRecordingStorage(bucket)` →
  `supabase.storage.from(bucket).remove([objectKey])`, errors surfaced
  (fail-closed). A not-found-tolerant wrapper for real object stores is
  external-pending.
- Tests inject an in-memory synthetic (`recording-retention.test.ts`).
  **No cloud writes, no real bucket ops in tests.**

---

## 2. REC-01 buildable half (L6) + browser upload (L5)

- **Primary path external-pending:** LiveKit Egress server-side MP3 → private
  storage is **not built** (provider creds, cost, residency). Browser upload
  remains the secondary/degraded path.
- **Buildable half (recordings.ts reserved block):** pinned constants
  `RECORDING_INTEGRITY_ALGORITHM = 'sha256'`,
  `RECORDING_INTEGRITY_SHA256_HEX_LENGTH = 64`, and
  `RECORDING_SECONDARY_DEGRADED_MAX_BYTES = 25 MiB (PROPOSED)` so a future
  Egress consumer has a stable digest primitive and a bounded degraded-path
  cap.
- Upload hardening (L5): magic-byte/MIME/extension validation (415),
  fail-closed malware scan (422, EICAR always rejected), per-session quota
  (409, `upsert:false`), reduced bounded multer cap (413 pre-buffer — this
  **bounds memory, it is not constant-memory streaming**), SHA-256 computed
  at upload and persisted with `recording_provenance='browser_upload'`.
- **Verify-on-DOWNLOAD (F1 repair, the real at-rest tamper detection):** the
  upload path does NOT compare against a persisted digest — that check was
  unreachable (the quota gate rejects any second upload, so `recording_sha256`
  is always NULL on the upload path) and its expected value would be
  uploader-controlled. Instead, when `recording_sha256` is present the
  download path fetches the stored object bytes through the injectable
  storage seam (`lib/recording-integrity.ts`), hashes them server-side
  (SHA-256), and compares against the persisted digest BEFORE minting a
  signed URL. On mismatch or over-cap the session is quarantined
  (convergence-safe guarded update + `mismatch_quarantined` event) and the
  request returns 409; a storage read failure is a redacted fail-closed 500
  and NEVER mints a URL. Legacy rows without a hash skip re-verification
  entirely (truthful legacy behavior). Resource use is bounded by
  `RECORDING_MAX_BYTES` / the recorded `recording_size_bytes` (known-size
  gate before any fetch, re-check after). Full constant-memory streaming
  re-verify remains external-pending (consistent with C-3).

---

## 3. External-pending register (truthful)

The following are **NOT built in Phase 7** and must not be treated as real:

- **REC-01 primary:** LiveKit Egress server-side MP3 path.
- **REC-02:** Egress formats/destinations/residency spike, copy worker,
  failure-callback + retry (doc-only, ADR-0006).
- **Real object versioning:** `recording_object_version` is populated
  synthetically only.
- **Real retention cron** (no scheduled erasure job) and **real backup
  expiry** (`scheduleBackupAging` is a synthetic model computing a horizon;
  `propagateErasureToProcessors` is a synthetic stub recording intent — no
  real processor DPAs or worker pipelines).
- **Real malware engine** (ClamAV/commercial) — scanner stays fail-closed.
- **Cloud/production deletion** — the Supabase Storage binding exists but is
  only ever exercised against synthetic storage.
- **BACKUP-GATE / restore-PITR drill / DPA / region / Legal recording
  consent** — unchanged external gates.

**Gates/phases:** `0/17` launch gates and `0/14` accepted phases are
unchanged (`config/current-state.json` untouched).

---

## 4. Operational notes

- Access revocation has two distinct surfaces: REC-05 `recording_revoked_at`
  (immediate revocation denies new mints within TTL) and REC-06
  `recording_deleted_at` (erasure tombstone → 404). Both run before
  `createSignedUrl` on the recruiter download and candidate grant mint paths.
- **Revocation is buildable-now (F2 repair).** `POST
  /api/recordings/:sessionId/revoke` (admin-only, `requireRole('admin')`,
  bounded `reason` ≤ 200 chars, uniform 403 for non-admins, 404 for unknown
  sessions) calls `revokeRecording()` in `lib/retention.ts`: a CAS update
  (`SET recording_revoked_at = now() WHERE … AND recording_revoked_at IS
  NULL`) flips the tombstone exactly once, the append-only `revoked`
  integrity event is written exactly once (unique partial index
  `uq_v2_recording_integrity_events_revoked_once`), and the route audits
  `recording.revoked` ONLY on the transition/backfill. Retries converge to
  `already_revoked` (200, no duplicate event/audit); a partial write (event
  missing) is backfilled on retry. Both mint paths then return 403 before
  signing. The route is documented in OpenAPI and covered by the contract
  test.
- **Erasure-exception audit semantics (F4):** legal-hold and erasure-exception
  blocks share the governance action `erasure_blocked_legal_hold` because
  migration 0012's `chk_gov_audit_action` has no separate exception action
  (schema does not support one — deliberately unchanged). Query semantics:
  distinguish the two by filtering `details->>'block_reason'` =
  `'legal_hold'` vs `'erasure_exception'`. A future migration may add a
  distinct action additively; until then the `block_reason` filter is the
  documented discriminator.
- Post-erasure, a session's `recording_object_key` is NULLed. The L5-owned
  upload quota gate keys on `recording_object_key` presence, so a session may
  technically be re-recorded after erasure (a **new** recording, never a
  resurrection of the deleted object). This is a documented observation, not
  a Phase 7 change.
- Audit metadata never carries object keys, URLs, or tokens; only
  `session_id`, sha256 **prefix**, `size_bytes`, `content_type`,
  `provenance`, `reason`.
- `recording.upload`, `recording.quarantined`, `recording.revoked`,
  `recording.deleted` are security-relevant writes (fail-closed audit);
  `recording.download` and `recording.integrity_verified` are fail-open.
- **Schema/security consistency (repair):**
  1. Migration 0014 additively evolves 0007's `chk_audit_action` to accept
     the six Phase 7 `recording_*` actions (the DB-backed audit sink would
     otherwise reject every Phase 7 recording audit row); SQL tests assert
     the evolved constraint.
  2. `recording_integrity_events` is now enforced append-only at the DB
     boundary: `prevent_recording_integrity_mutation()` blocks UPDATE and
     direct DELETE for every role (including service_role — accidental
     service-layer mutation is prevented) while preserving the FK
     `ON DELETE CASCADE` from `call_sessions` (parent-gone check allows the
     sanctioned cascade). Escape hatch: `SET LOCAL
     app.allow_recording_integrity_mutation='true'` in a dedicated session
     only. SQL tests exercise the live guard (UPDATE/DELETE blocked, cascade
     works).
  3. Exactly-once lifecycle events are DB-guaranteed by unique partial
     indexes on `(session_id) where event_type in ('deleted','revoked')`.
     No broad authenticated writes were added; RLS posture unchanged.

## 5. Verifiers (post-repair, run before handoff)

```text
cd app/api && npm ci && npm run typecheck   -> tsc clean
cd app/api && npm test                      -> incl. recording-retention.test.ts + recordings.test.ts (F1/F2/F3)
cd app/api && npm run test:coverage         -> ratchet held (>= 71/61/71/73)
cd app/api && npm test -- contract-openapi  -> 35 documented paths incl. POST /api/recordings/{sessionId}/revoke
node scripts/migrate-rollback.test.mjs      -> 0014 with audit-CHECK evolution + guards: 0 RED
bash scripts/supabase-test.sh               -> 0014 reset ×2, policy tests incl. append-only guard, zero drift
```
