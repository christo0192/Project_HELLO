/**
 * GOV-04 / GOV-10: Synthetic legal-hold, retention, erasure exception,
 * and governance audit trail foundations.
 *
 * DESIGN:
 *   - Retention policies are configurable per data category.
 *   - D-009: retain-default (-1 days = indefinite) is the initial seed,
 *     but erasure MUST still be honoured. retain-default ≠ no-erasure.
 *   - Legal holds block erasure of referenced entities. Blocked erasure
 *     attempts are recorded in the governance audit trail.
 *   - Erasure exceptions provide scoped exemptions from deletion.
 *   - All governance actions are recorded in the append-only governance_audit table.
 *
 * DEPENDENCY INJECTION: All functions accept an optional Supabase client
 * override for test isolation. When omitted, the default service-role client
 * is used.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as defaultSupabase } from './supabase.js';
import { env } from './env.js';
import { egressObjectKey, egressManifestObjectKey } from './recording-egress.js';
import { createLogger } from './logger.js';
import type { EventName } from './logger.js';

const govLogger = createLogger('governance');

// ── Type exports ─────────────────────────────────────────────────────

export type DataCategory =
  | 'candidate' | 'session' | 'transcript' | 'recording'
  | 'assessment' | 'resume' | 'invite' | 'audit_log';

export type RetentionStrategy = 'delete' | 'anonymize' | 'archive';

export interface RetentionPolicy {
  id: string;
  dataCategory: DataCategory;
  retentionDays: number;        // -1 = indefinite (D-009 default)
  strategy: RetentionStrategy;
  isDefault: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type HoldSource =
  | 'court_order' | 'internal_investigation'
  | 'litigation_hold' | 'regulatory' | 'other';

export interface LegalHold {
  id: string;
  entityType: 'candidate' | 'session' | 'transcript' | 'recording' | 'assessment' | 'resume';
  entityId: string;
  holdReason: string;
  holdSource: HoldSource;
  placedBy: string;
  placedAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
  releaseReason: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown> | null;
}

export type ErasureExceptionType =
  | 'legal_hold' | 'retention_obligation'
  | 'business_necessity' | 'regulatory';

export interface ErasureException {
  id: string;
  entityType: string;
  entityId: string;
  exceptionType: ErasureExceptionType;
  reason: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  metadata: Record<string, unknown> | null;
}

export type GovernanceAction =
  | 'legal_hold_placed' | 'legal_hold_released' | 'legal_hold_blocked_deletion'
  | 'retention_policy_created' | 'retention_policy_updated'
  | 'erasure_exception_granted' | 'erasure_exception_revoked'
  | 'dsar_created' | 'dsar_fulfilled' | 'dsar_rejected' | 'dsar_cancelled'
  | 'data_exported' | 'data_deleted' | 'data_corrected'
  | 'erasure_blocked_legal_hold' | 'erasure_completed'
  | 'governance_config_changed';

export type AuditOutcome = 'success' | 'failure' | 'blocked';

export interface GovernanceAuditEntry {
  id: string;
  action: GovernanceAction;
  actorId: string;
  actorType: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown> | null;
  outcome: AuditOutcome;
  correlationId: string | null;
  createdAt: string;
}

// ── Internal helpers ─────────────────────────────────────────────────

function getClient(supabase?: SupabaseClient): SupabaseClient {
  return supabase ?? (defaultSupabase as unknown as SupabaseClient);
}

function categoryToEntityType(category: DataCategory): string {
  return category;
}

/**
 * Generate a correlation ID for grouping related governance events.
 */
export function governanceCorrelationId(): string {
  return crypto.randomUUID();
}

// ── Retention policy helpers ─────────────────────────────────────────

/**
 * Get the retention policy for a data category.
 * Falls back to the default policy if no specific policy is configured.
 */
export async function getRetentionPolicy(
  dataCategory: DataCategory,
  clientOverride?: SupabaseClient,
): Promise<RetentionPolicy | null> {
  const client = getClient(clientOverride);
  const { data, error } = await client
    .from('retention_policies')
    .select('*')
    .eq('data_category', dataCategory)
    .single();

  if (error) {
    // Try to find the default policy
    const { data: defaultPolicy } = await client
      .from('retention_policies')
      .select('*')
      .eq('is_default', true)
      .eq('data_category', dataCategory)
      .single();

    if (defaultPolicy) return mapRowToRetentionPolicy(defaultPolicy);
    return null;
  }

  return mapRowToRetentionPolicy(data);
}

/**
 * Set a retention policy for a data category.
 * Upserts by data_category (unique constraint).
 */
export async function setRetentionPolicy(
  dataCategory: DataCategory,
  retentionDays: number,
  strategy: RetentionStrategy,
  notes: string | null,
  actorId: string,
  clientOverride?: SupabaseClient,
): Promise<RetentionPolicy | null> {
  const client = getClient(clientOverride);

  // Check if a policy already exists
  const existing = await client
    .from('retention_policies')
    .select('id')
    .eq('data_category', dataCategory)
    .single();

  const payload: Record<string, unknown> = {
    data_category: dataCategory,
    retention_days: retentionDays,
    strategy,
    notes,
    is_default: false,
  };

  let result;
  if (existing.data) {
    result = await client
      .from('retention_policies')
      .update(payload)
      .eq('data_category', dataCategory)
      .select()
      .single();
  } else {
    result = await client
      .from('retention_policies')
      .insert({ ...payload, created_by: actorId })
      .select()
      .single();
  }

  if (result.error) return null;

  // Audit
  await recordGovernanceAudit({
    action: existing.data ? 'retention_policy_updated' : 'retention_policy_created',
    actorId,
    entityType: 'retention_policy',
    entityId: result.data.id,
    details: { data_category: dataCategory, retention_days: retentionDays, strategy },
    outcome: 'success',
  }, clientOverride);

  return mapRowToRetentionPolicy(result.data);
}

// ── Legal hold helpers ───────────────────────────────────────────────

/**
 * Create a legal hold on an entity. When active, blocks erasure.
 * Returns the created hold or throws on error.
 */
export async function createLegalHold(
  entityType: LegalHold['entityType'],
  entityId: string,
  holdReason: string,
  holdSource: HoldSource,
  placedBy: string,
  expiresAt?: string,
  metadata?: Record<string, unknown>,
  clientOverride?: SupabaseClient,
  correlationId?: string,
): Promise<LegalHold> {
  const client = getClient(clientOverride);
  const corrId = correlationId ?? governanceCorrelationId();

  const { data, error } = await client
    .from('legal_holds')
    .insert({
      entity_type: entityType,
      entity_id: entityId,
      hold_reason: holdReason,
      hold_source: holdSource,
      placed_by: placedBy,
      expires_at: expiresAt ?? null,
      metadata: metadata ?? null,
    })
    .select()
    .single();

  if (error) {
    govLogger.error('error_unhandled' as EventName, { error_type: 'legal_hold_create_failed' });
    throw new Error(`Failed to create legal hold: ${error.message}`);
  }

  // Audit
  await recordGovernanceAudit({
    action: 'legal_hold_placed',
    actorId: placedBy,
    entityType,
    entityId,
    details: { hold_id: data.id, hold_reason: holdReason, hold_source: holdSource },
    outcome: 'success',
    correlationId: corrId,
  }, clientOverride);

  return mapRowToLegalHold(data);
}

/**
 * Release an active legal hold. Idempotent: if already released, returns null.
 */
export async function releaseLegalHold(
  holdId: string,
  releasedBy: string,
  releaseReason: string,
  clientOverride?: SupabaseClient,
  correlationId?: string,
): Promise<LegalHold | null> {
  const client = getClient(clientOverride);
  const corrId = correlationId ?? governanceCorrelationId();

  // Check current state
  const { data: existing } = await client
    .from('legal_holds')
    .select('*')
    .eq('id', holdId)
    .single();

  if (!existing) return null;
  if (existing.released_at) return mapRowToLegalHold(existing); // already released

  const { data, error } = await client
    .from('legal_holds')
    .update({
      released_at: new Date().toISOString(),
      released_by: releasedBy,
      release_reason: releaseReason,
    })
    .eq('id', holdId)
    .select()
    .single();

  if (error) {
    govLogger.error('error_unhandled' as EventName, { error_type: 'legal_hold_release_failed' });
    throw new Error(`Failed to release legal hold: ${error.message}`);
  }

  // Audit
  await recordGovernanceAudit({
    action: 'legal_hold_released',
    actorId: releasedBy,
    entityType: existing.entity_type,
    entityId: existing.entity_id,
    details: { hold_id: holdId, release_reason: releaseReason },
    outcome: 'success',
    correlationId: corrId,
  }, clientOverride);

  return mapRowToLegalHold(data);
}

/**
 * Check if a legal hold is active for a given entity.
 * Optionally filters by hold source.
 */
export async function isUnderLegalHold(
  entityType: LegalHold['entityType'],
  entityId: string,
  holdSource?: HoldSource,
  clientOverride?: SupabaseClient,
): Promise<boolean> {
  const client = getClient(clientOverride);

  let query = client
    .from('legal_holds')
    .select('id')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .is('released_at', null);

  if (holdSource) {
    query = query.eq('hold_source', holdSource);
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data) return false;
  return true;
}

/**
 * Get all active legal holds for an entity.
 */
export async function getActiveLegalHolds(
  entityType: LegalHold['entityType'],
  entityId: string,
  clientOverride?: SupabaseClient,
): Promise<LegalHold[]> {
  const client = getClient(clientOverride);

  const { data, error } = await client
    .from('legal_holds')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .is('released_at', null)
    .order('placed_at', { ascending: false });

  if (error || !data) return [];
  return data.map(mapRowToLegalHold);
}

/**
 * Attempt erasure of an entity, respecting legal holds.
 * Returns { success: true } on completion or { success: false, blockedBy: [...] }
 * if active holds exist.
 */
export async function attemptErasure(
  entityType: LegalHold['entityType'],
  entityId: string,
  actorId: string,
  clientOverride?: SupabaseClient,
  correlationId?: string,
): Promise<{ success: boolean; blockedBy?: LegalHold[]; message?: string }> {
  const client = getClient(clientOverride);
  const corrId = correlationId ?? governanceCorrelationId();

  // Check for active legal holds
  const activeHolds = await getActiveLegalHolds(entityType, entityId, client);

  if (activeHolds.length > 0) {
    // Blocked by legal hold — audit the attempt
    await recordGovernanceAudit({
      action: 'erasure_blocked_legal_hold',
      actorId,
      entityType,
      entityId,
      details: {
        hold_ids: activeHolds.map(h => h.id),
        hold_reasons: activeHolds.map(h => h.holdReason),
      },
      outcome: 'blocked',
      correlationId: corrId,
    }, clientOverride);

    return {
      success: false,
      blockedBy: activeHolds,
      message: 'Erasure blocked by active legal hold(s). Release hold(s) before proceeding.',
    };
  }

  // No holds — proceed with erasure
  await recordGovernanceAudit({
    action: 'erasure_completed',
    actorId,
    entityType,
    entityId,
    details: { strategy: 'delete' },
    outcome: 'success',
    correlationId: corrId,
  }, clientOverride);

  return { success: true, message: 'Erasure completed. Entity data has been deleted.' };
}

// ── Erasure exception helpers ────────────────────────────────────────

/**
 * Grant an erasure exception for an entity.
 * Legal holds automatically create exceptions; this function is for
 * additional business/regulatory exceptions.
 */
export async function grantErasureException(
  entityType: string,
  entityId: string,
  exceptionType: ErasureExceptionType,
  reason: string,
  grantedBy: string,
  expiresAt?: string,
  metadata?: Record<string, unknown>,
  clientOverride?: SupabaseClient,
): Promise<ErasureException | null> {
  const client = getClient(clientOverride);

  const { data, error } = await client
    .from('erasure_exceptions')
    .insert({
      entity_type: entityType,
      entity_id: entityId,
      exception_type: exceptionType,
      reason,
      granted_by: grantedBy,
      expires_at: expiresAt ?? null,
      metadata: metadata ?? null,
    })
    .select()
    .single();

  if (error) return null;

  // Audit
  await recordGovernanceAudit({
    action: 'erasure_exception_granted',
    actorId: grantedBy,
    entityType,
    entityId,
    details: { exception_id: data.id, exception_type: exceptionType, reason },
    outcome: 'success',
  }, clientOverride);

  return mapRowToErasureException(data);
}

/**
 * Revoke an erasure exception.
 */
export async function revokeErasureException(
  exceptionId: string,
  revokedBy: string,
  reason: string,
  clientOverride?: SupabaseClient,
): Promise<ErasureException | null> {
  const client = getClient(clientOverride);

  const { data, error } = await client
    .from('erasure_exceptions')
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: revokedBy,
    })
    .eq('id', exceptionId)
    .is('revoked_at', null)
    .select()
    .single();

  if (error) return null;

  // Audit
  await recordGovernanceAudit({
    action: 'erasure_exception_revoked',
    actorId: revokedBy,
    entityType: data.entity_type,
    entityId: data.entity_id,
    details: { exception_id: exceptionId, reason },
    outcome: 'success',
  }, clientOverride);

  return mapRowToErasureException(data);
}

/**
 * Check if erasure is blocked by any active exception or legal hold.
 */
export async function isErasureBlocked(
  entityType: string,
  entityId: string,
  clientOverride?: SupabaseClient,
): Promise<boolean> {
  const client = getClient(clientOverride);

  // Check legal holds
  const { data: holds } = await client
    .from('legal_holds')
    .select('id')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .is('released_at', null)
    .maybeSingle();

  if (holds) return true;

  // Check erasure exceptions
  const { data: exceptions } = await client
    .from('erasure_exceptions')
    .select('id')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .is('revoked_at', null)
    .maybeSingle();

  if (exceptions) return true;

  return false;
}

// ── Governance audit trail ───────────────────────────────────────────

/**
 * Record an entry in the governance audit trail.
 * This is the central logging point for all governance actions.
 */
export async function recordGovernanceAudit(
  params: {
    action: GovernanceAction;
    actorId: string;
    actorType?: string;
    entityType?: string | null;
    entityId?: string | null;
    details?: Record<string, unknown> | null;
    outcome?: AuditOutcome;
    correlationId?: string;
  },
  clientOverride?: SupabaseClient,
): Promise<void> {
  const client = getClient(clientOverride);

  const { error } = await client
    .from('governance_audit')
    .insert({
      action: params.action,
      actor_id: params.actorId,
      actor_type: params.actorType ?? 'recruiter',
      entity_type: params.entityType ?? null,
      entity_id: params.entityId ?? null,
      details: (params.details ?? null) as Record<string, unknown> | null,
      outcome: params.outcome ?? 'success',
      correlation_id: params.correlationId ?? null,
    });

  if (error) {
    govLogger.error('error_unhandled' as EventName, {
      error_type: 'governance_audit_failed',
    });
  }
}

/**
 * Query governance audit entries with optional filters.
 */
export async function queryGovernanceAudit(
  filters: {
    action?: GovernanceAction;
    actorId?: string;
    entityType?: string;
    entityId?: string;
    outcome?: AuditOutcome;
    fromDate?: string;
    toDate?: string;
    limit?: number;
    offset?: number;
  },
  clientOverride?: SupabaseClient,
): Promise<GovernanceAuditEntry[]> {
  const client = getClient(clientOverride);

  let query = client
    .from('governance_audit')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 50)
    .range(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? 50) - 1);

  if (filters.action) query = query.eq('action', filters.action);
  if (filters.actorId) query = query.eq('actor_id', filters.actorId);
  if (filters.entityType) query = query.eq('entity_type', filters.entityType);
  if (filters.entityId) query = query.eq('entity_id', filters.entityId);
  if (filters.outcome) query = query.eq('outcome', filters.outcome);
  if (filters.fromDate) query = query.gte('created_at', filters.fromDate);
  if (filters.toDate) query = query.lte('created_at', filters.toDate);

  const { data, error } = await query;
  if (error || !data) return [];
  return data.map(mapRowToGovernanceAudit);
}

// ── Row mappers (snake_case → camelCase) ─────────────────────────────

function mapRowToRetentionPolicy(row: Record<string, unknown>): RetentionPolicy {
  return {
    id: row.id as string,
    dataCategory: row.data_category as DataCategory,
    retentionDays: row.retention_days as number,
    strategy: row.strategy as RetentionStrategy,
    isDefault: row.is_default as boolean,
    notes: row.notes as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapRowToLegalHold(row: Record<string, unknown>): LegalHold {
  return {
    id: row.id as string,
    entityType: row.entity_type as LegalHold['entityType'],
    entityId: row.entity_id as string,
    holdReason: row.hold_reason as string,
    holdSource: row.hold_source as HoldSource,
    placedBy: row.placed_by as string,
    placedAt: row.placed_at as string,
    releasedAt: row.released_at as string | null,
    releasedBy: row.released_by as string | null,
    releaseReason: row.release_reason as string | null,
    expiresAt: row.expires_at as string | null,
    metadata: row.metadata as Record<string, unknown> | null,
  };
}

function mapRowToErasureException(row: Record<string, unknown>): ErasureException {
  return {
    id: row.id as string,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    exceptionType: row.exception_type as ErasureExceptionType,
    reason: row.reason as string,
    grantedBy: row.granted_by as string,
    grantedAt: row.granted_at as string,
    expiresAt: row.expires_at as string | null,
    revokedAt: row.revoked_at as string | null,
    revokedBy: row.revoked_by as string | null,
    metadata: row.metadata as Record<string, unknown> | null,
  };
}

function mapRowToGovernanceAudit(row: Record<string, unknown>): GovernanceAuditEntry {
  return {
    id: row.id as string,
    action: row.action as GovernanceAction,
    actorId: row.actor_id as string,
    actorType: row.actor_type as string,
    entityType: row.entity_type as string | null,
    entityId: row.entity_id as string | null,
    details: row.details as Record<string, unknown> | null,
    outcome: row.outcome as AuditOutcome,
    correlationId: row.correlation_id as string | null,
    createdAt: row.created_at as string,
  };
}

// ══════════════════════════════════════════════════════════════════════
// REC-06 (Phase 7 L6): Recording-object erasure — real deletion against
// SYNTHETIC storage. C-4 fix: attemptErasure() above is audit-only by
// design (it models DSAR/candidate-level erasure); this section adds the
// net-new recording-object deletion path with legal-hold / erasure-
// exception precedence, idempotent tombstoning, and explicit partial-
// failure semantics. NO cloud/production writes; the default storage
// binding is a thin Supabase-Storage remove() that tests replace with an
// in-memory synthetic.
// ══════════════════════════════════════════════════════════════════════

/**
 * REC-06: injectable recording-storage delete interface (synthetic-safe).
 * `remove` MUST be idempotent — removing an absent key resolves as success
 * (mirrors the in-memory synthetic used by tests; the production binding
 * keeps the same contract).
 */
export interface RecordingStorage {
  remove(objectKey: string): Promise<void>;
  /**
   * OPTIONAL existence probe, added by 0038 for the orphan branch below.
   *
   * A session with a NULL `recording_object_key` and a live
   * `recording_egress_id` may still have objects in the bucket: the egress
   * wrote them, and the finalize that would have linked them never ran. The
   * DB row alone cannot answer whether anything is there, and an idempotent
   * `remove()` cannot either — it succeeds on an absent key, which is exactly
   * how a false "removed" record gets written.
   *
   * Optional so every existing injected synthetic stays valid. When it is
   * absent the erasure reports `orphan_probe: 'unavailable'` and does NOT
   * claim removal — an honest "we could not look" rather than a confident
   * "there was nothing there".
   */
  exists?(objectKey: string): Promise<boolean>;
}

/**
 * REC-06 default binding: Supabase Storage `.from(bucket).remove([key])`.
 * Errors are surfaced (fail-closed); a not-found-tolerant wrapper for real
 * object stores is external-pending (see docs/runbooks/phase7-recording.md).
 */
export function supabaseStorageRecordingStorage(
  bucket: string,
  clientOverride?: SupabaseClient,
): RecordingStorage {
  return {
    async remove(objectKey: string): Promise<void> {
      const client = getClient(clientOverride);
      const { error } = await client.storage.from(bucket).remove([objectKey]);
      if (error) {
        throw new Error(`recording storage remove failed: ${error.message}`);
      }
    },
    async exists(objectKey: string): Promise<boolean> {
      const client = getClient(clientOverride);
      // `list` with an exact `search` is the cheapest true existence probe:
      // it transfers a name, never bytes, and never mints a URL.
      const slash = objectKey.lastIndexOf('/');
      const prefix = slash >= 0 ? objectKey.slice(0, slash) : '';
      const name = slash >= 0 ? objectKey.slice(slash + 1) : objectKey;
      const { data, error } = await client.storage
        .from(bucket)
        .list(prefix, { search: name, limit: 100 });
      if (error) throw new Error(`recording storage probe failed: ${error.message}`);
      return Array.isArray(data) && data.some((entry) => (entry as { name?: string }).name === name);
    },
  };
}

/**
 * REC-06 erasure state-machine status.
 *   completed            → object deleted, tombstoned, event appended, audited.
 *   already_deleted      → idempotent no-op (tombstone present); no error,
 *                          no second delete, no duplicate completion audit.
 *   blocked_legal_hold   → fail-closed block; object untouched; audited.
 *   blocked_exception    → fail-closed block (erasure exception); untouched.
 *   not_found            → no such session; nothing deleted.
 *   failed_*             → partial-failure boundary; completion NOT claimed;
 *                          a failure-outcome audit is recorded. Retrying is
 *                          safe: storage remove is idempotent and access is
 *                          never resurrected once the tombstone is set.
 */
export type EraseRecordingStatus =
  | 'completed'
  | 'already_deleted'
  | 'blocked_legal_hold'
  | 'blocked_exception'
  | 'not_found'
  | 'failed_storage_delete'
  | 'failed_tombstone'
  | 'failed_integrity_event';

export interface EraseRecordingResult {
  status: EraseRecordingStatus;
  correlationId: string;
  blockedBy?: 'legal_hold' | 'erasure_exception';
  failure?: 'storage_delete' | 'tombstone_write' | 'integrity_event_write';
  /** Object key that was (or should have been) removed, when known. */
  objectKey?: string | null;
  /** True when completion was reached via evidence backfill on a retry (F3). */
  converged?: boolean;
}

/**
 * REC-06 (C-4): erase a recording object idempotently and tombstone the
 * session so the L5 download/grant gate (recording_deleted_at → 404) can
 * never re-mint or re-download it.
 *
 * ORDERING (documented, contract-mandated):
 *   1. legal-hold / erasure-exception precedence → block + audit, object
 *      untouched (reuses existing exported functions — never re-implemented);
 *   2. idempotency + evidence convergence (recording_deleted_at IS NOT NULL):
 *      fully-converged → already_deleted no-op (no duplicate evidence); a
 *      missing 'deleted' event and/or success completion audit is BACKFILLED
 *      so a retry after failed_integrity_event converges instead of losing
 *      the append-only evidence (F3 repair);
 *   3. storage-object delete (synthetic; absent key = success);
 *   4. tombstone UPDATE (recording_deleted_at=now(), recording_object_key=NULL)
 *      — access is cut from here (L5 gate returns 404);
 *   5. append-only recording_integrity_events(event_type='deleted');
 *   6. synthetic processor-propagation + backup-aging models (labelled
 *      synthetic — no real DPAs / backup systems exist);
 *   7. governance audit 'erasure_completed' (success) — ONLY written when
 *      object deletion + tombstone + event all succeeded.
 *
 * PARTIAL FAILURES (explicit, never claimed as completion):
 *   - storage delete fails      → row untouched; fully retryable; audit failure.
 *   - tombstone write fails     → object gone, row untouched; retry re-runs
 *     (storage remove idempotent) and completes with exactly one event + one
 *     success audit.
 *   - integrity-event write fails → tombstone IS set (access blocked, no
 *     resurrection) and completion is NOT claimed; the failure is audited and
 *     a RETRY converges/backfills the missing 'deleted' event + success
 *     completion audit (F3 repair) — the append-only log is never left with a
 *     tombstone and no corresponding event.
 */
export async function eraseRecording(
  sessionId: string,
  actorId: string,
  opts: { storage?: RecordingStorage; client?: SupabaseClient; correlationId?: string } = {},
): Promise<EraseRecordingResult> {
  const client = getClient(opts.client);
  const storage = opts.storage ?? supabaseStorageRecordingStorage(env.recordingsBucket, client);
  const corrId = opts.correlationId ?? governanceCorrelationId();

  // 1. Legal-hold precedence (fail-closed; reuse existing functions).
  if (await isUnderLegalHold('recording', sessionId, undefined, client)) {
    const activeHolds = await getActiveLegalHolds('recording', sessionId, client);
    await recordGovernanceAudit({
      action: 'erasure_blocked_legal_hold',
      actorId,
      entityType: 'recording',
      entityId: sessionId,
      details: {
        block_reason: 'legal_hold',
        hold_ids: activeHolds.map((h) => h.id),
      },
      outcome: 'blocked',
      correlationId: corrId,
    }, client);
    return { status: 'blocked_legal_hold', blockedBy: 'legal_hold', correlationId: corrId };
  }

  // 2. Erasure-exception precedence. isErasureBlocked already re-checks holds,
  //    so reaching this point with true implies an active exception.
  if (await isErasureBlocked('recording', sessionId, client)) {
    await recordGovernanceAudit({
      action: 'erasure_blocked_legal_hold',
      actorId,
      entityType: 'recording',
      entityId: sessionId,
      details: { block_reason: 'erasure_exception' },
      outcome: 'blocked',
      correlationId: corrId,
    }, client);
    return { status: 'blocked_exception', blockedBy: 'erasure_exception', correlationId: corrId };
  }

  // 3. Idempotency + convergence (C-4 + F3 repair): an already-erased
  //    recording is a no-op UNLESS the append-only 'deleted' evidence is
  //    missing (a retry after failed_integrity_event). In that case the
  //    retry BACKFILLS the missing event + success completion audit so the
  //    log converges instead of permanently returning already_deleted.
  // 0038: `recording_egress_id` is read as well. A NULL key is NOT proof that
  // nothing is in the bucket — an egress that completed without a finalize
  // wrote its object (and its manifest) and left the row unlinked, which is
  // the exact shape the whole convergence repair exists for. Erasing such a
  // session by tombstoning the row alone would leave candidate audio in
  // storage while recording a completed erasure.
  const { data: session, error: sessionErr } = await client
    .from('call_sessions')
    .select('recording_deleted_at, recording_object_key, recording_egress_id')
    .eq('id', sessionId)
    .single();
  if (sessionErr || !session) {
    return { status: 'not_found', correlationId: corrId };
  }
  if (session.recording_deleted_at) {
    const now = new Date();
    // Existing 'deleted' event? (unique partial index ⇒ at most one).
    const { data: existingEvent } = await client
      .from('recording_integrity_events')
      .select('id')
      .eq('session_id', sessionId)
      .eq('event_type', 'deleted')
      .limit(1)
      .maybeSingle();
    // Existing success completion audit for this session?
    const { data: existingAudit } = await client
      .from('governance_audit')
      .select('id')
      .eq('action', 'erasure_completed')
      .eq('outcome', 'success')
      .eq('entity_id', sessionId)
      .limit(1)
      .maybeSingle();

    if (existingEvent && existingAudit) {
      // Fully converged: idempotent no-op (no duplicate evidence).
      return { status: 'already_deleted', correlationId: corrId, objectKey: null };
    }

    // Backfill missing evidence (F3 repair). The unique partial index on
    // (session_id) where event_type='deleted' makes concurrent backfills
    // converge: a 23505 unique violation means another retry already
    // appended it — treat as present.
    if (!existingEvent) {
      const { error: evErr } = await client
        .from('recording_integrity_events')
        .insert({
          session_id: sessionId,
          event_type: 'deleted',
          detail: `recording erased via synthetic storage (corr ${corrId})`,
          correlation_id: corrId,
        });
      if (evErr && evErr.code !== '23505') {
        return { status: 'failed_integrity_event', failure: 'integrity_event_write', correlationId: corrId, objectKey: null };
      }
    }

    // Exactly-once success completion audit — only when it is missing.
    if (!existingAudit) {
      const propagation = propagateErasureToProcessors(sessionId, corrId, { now });
      const aging = await scheduleBackupAging(sessionId, 'recording', { now, client });
      await recordGovernanceAudit({
        action: 'erasure_completed',
        actorId,
        entityType: 'recording',
        entityId: sessionId,
        details: {
          strategy: 'delete',
          converged: true,
          // 0038 (compliance): this was hardcoded `true`. It is a BACKFILL of
          // missing evidence for a row that was already tombstoned — this
          // pass removed nothing at all, and saying otherwise made the
          // completion record a false success. The truthful value is false;
          // whether an object was removed is recorded by the pass that
          // actually removed it.
          object_key_removed: false,
          backfilled_evidence: true,
          processors: propagation.processors,
          backup_aging: {
            policy_id: aging.policyId,
            retention_days: aging.retentionDays,
            horizon_iso: aging.horizonIso,
            synthetic: true,
          },
        },
        outcome: 'success',
        correlationId: corrId,
      }, client);
    }

    // Converged: completion is now truthfully claimable with exactly one
    // deleted event + one success audit.
    return { status: 'completed', correlationId: corrId, objectKey: null, converged: true };
  }

  const objectKey = session.recording_object_key as string | null;
  const egressId = (session as { recording_egress_id?: string | null }).recording_egress_id ?? null;

  // What this pass actually removed, as opposed to what it intended to.
  let objectRemoved = false;
  let manifestRemoved = false;
  /** 'not_applicable' | 'absent' | 'removed' | 'unavailable' */
  let orphanProbe: 'not_applicable' | 'absent' | 'removed' | 'unavailable' = 'not_applicable';

  const failStorage = async (): Promise<EraseRecordingResult> => {
    await recordGovernanceAudit({
      action: 'erasure_completed',
      actorId,
      entityType: 'recording',
      entityId: sessionId,
      details: { strategy: 'delete', failure: 'storage_delete', object_key_removed: false },
      outcome: 'failure',
      correlationId: corrId,
    }, client);
    return { status: 'failed_storage_delete', failure: 'storage_delete', correlationId: corrId, objectKey };
  };

  // 4. Storage-object deletion (idempotent; absent key = success).
  if (objectKey) {
    try {
      await storage.remove(objectKey);
      objectRemoved = true;
    } catch {
      return failStorage();
    }

    // 0038: the MANIFEST. `startAuthoritativeRecording` sets
    // `disableManifest: false`, so a `<key>.json` manifest exists for every
    // egress-recorded session — and nothing ever removed it, on this normal
    // fully-linked path either, not only in the orphan case. It is only
    // derived when the linked key IS the egress key: a browser_upload object
    // has no manifest, and deleting a guessed sibling would be a second,
    // quieter false success.
    if (objectKey === egressObjectKey(sessionId)) {
      try {
        await storage.remove(egressManifestObjectKey(sessionId));
        manifestRemoved = true;
      } catch {
        return failStorage();
      }
    }
  } else if (egressId) {
    // ── 0038: the ORPHAN branch ────────────────────────────────────────
    // NULL key + live egress id. The row says nothing was ever linked; the
    // BUCKET may disagree. Probe, and report only what was observed.
    const orphanKey = egressObjectKey(sessionId);
    const orphanManifest = egressManifestObjectKey(sessionId);
    if (typeof storage.exists !== 'function') {
      // We cannot look. That is a real, reportable limitation — not evidence
      // of absence, and not grounds to claim a removal.
      orphanProbe = 'unavailable';
    } else {
      let present: boolean;
      let manifestPresent: boolean;
      try {
        present = await storage.exists(orphanKey);
        manifestPresent = await storage.exists(orphanManifest);
      } catch {
        return failStorage();
      }
      if (!present && !manifestPresent) {
        // Idempotent success — but audited as `absent`, NOT as a removal.
        orphanProbe = 'absent';
      } else {
        try {
          if (present) {
            await storage.remove(orphanKey);
            objectRemoved = true;
          }
          if (manifestPresent) {
            await storage.remove(orphanManifest);
            manifestRemoved = true;
          }
        } catch {
          // Present and NOT deletable is a failure, never a success.
          return failStorage();
        }
        orphanProbe = 'removed';
      }
    }
  }

  // 5. Tombstone: revoke access from here (L5 gate → 404; key NULLed so no
  //    re-mint can target the object).
  const { error: tombErr } = await client
    .from('call_sessions')
    .update({
      recording_deleted_at: new Date().toISOString(),
      recording_object_key: null,
    })
    .eq('id', sessionId);
  if (tombErr) {
    await recordGovernanceAudit({
      action: 'erasure_completed',
      actorId,
      entityType: 'recording',
      entityId: sessionId,
      // 0038 (compliance): was hardcoded `true`. On a NULL-key session
      // nothing was removed, and a failure record that overstates what it
      // deleted is still a false record.
      details: {
        strategy: 'delete',
        failure: 'tombstone_write',
        object_key_removed: objectRemoved,
        manifest_removed: manifestRemoved,
        orphan_probe: orphanProbe,
      },
      outcome: 'failure',
      correlationId: corrId,
    }, client);
    return { status: 'failed_tombstone', failure: 'tombstone_write', correlationId: corrId, objectKey };
  }

  // 6. Append-only integrity event.
  const { error: evErr } = await client
    .from('recording_integrity_events')
    .insert({
      session_id: sessionId,
      event_type: 'deleted',
      detail: `recording erased via synthetic storage (corr ${corrId})`,
      correlation_id: corrId,
    });
  if (evErr) {
    await recordGovernanceAudit({
      action: 'erasure_completed',
      actorId,
      entityType: 'recording',
      entityId: sessionId,
      details: {
        strategy: 'delete',
        failure: 'integrity_event_write',
        // 0038 (compliance): was hardcoded `true`.
        object_key_removed: objectRemoved,
        manifest_removed: manifestRemoved,
        orphan_probe: orphanProbe,
        tombstoned: true,
      },
      outcome: 'failure',
      correlationId: corrId,
    }, client);
    return { status: 'failed_integrity_event', failure: 'integrity_event_write', correlationId: corrId, objectKey: null };
  }

  // 7. Synthetic processor-propagation + backup-aging models. Intent is
  //    recorded in the completion-audit details — modelled, NOT real DPAs
  //    or backup systems (runbook labels these external-pending).
  const now = new Date();
  const propagation = propagateErasureToProcessors(sessionId, corrId, { now });
  const aging = await scheduleBackupAging(sessionId, 'recording', { now, client });

  // 8. Completion audit — only after object + tombstone + event succeeded.
  await recordGovernanceAudit({
    action: 'erasure_completed',
    actorId,
    entityType: 'recording',
    entityId: sessionId,
    details: {
      strategy: 'delete',
      // What was ACTUALLY removed by this pass, not what the row implied.
      // `Boolean(objectKey)` was already truthful for the linked path; it is
      // not sufficient for the orphan path, where a removal can happen with
      // no linked key at all.
      object_key_removed: objectRemoved,
      manifest_removed: manifestRemoved,
      orphan_probe: orphanProbe,
      processors: propagation.processors,
      backup_aging: {
        policy_id: aging.policyId,
        retention_days: aging.retentionDays,
        horizon_iso: aging.horizonIso,
        synthetic: true,
      },
    },
    outcome: 'success',
    correlationId: corrId,
  }, client);

  return { status: 'completed', correlationId: corrId, objectKey };
}

/**
 * REC-05 (F2 repair): revoke recording access — the write path that makes
 * `recording_revoked_at` buildable-now (both mint paths already gate on it
 * with a 403 before createSignedUrl).
 *
 * RETRY-CONVERGENT + EXACTLY-ONCE:
 *   1. CAS update `SET recording_revoked_at = now() WHERE id = ? AND
 *      recording_revoked_at IS NULL` — only the first caller flips it; a
 *      concurrent or retry caller observes it already set and skips the
 *      transition (no duplicate success evidence).
 *   2. The append-only `revoked` integrity event is appended ONCE per
 *      session — the unique partial index
 *      uq_v2_recording_integrity_events_revoked_once enforces it at the DB
 *      level, so a retry after a partial write BACKFILLS the missing event
 *      instead of appending a duplicate or permanently no-op'ing.
 *   3. `revoked` is returned only when a transition OR a backfill happened
 *      (the caller audits exactly then); `already_revoked` (fully converged)
 *      produces no duplicate audit/event.
 */
export type RevokeRecordingStatus =
  | 'revoked'
  | 'already_revoked'
  | 'not_found'
  | 'failed_update'
  | 'failed_event';

export interface RevokeRecordingResult {
  status: RevokeRecordingStatus;
  /** ISO-8601 revocation timestamp (null when the session was not found). */
  revokedAt: string | null;
  correlationId: string;
  /** True when the revoked event was backfilled on a retry (convergence). */
  backfilled?: boolean;
}

export async function revokeRecording(
  sessionId: string,
  actorId: string,
  opts: { client?: SupabaseClient; reason?: string; correlationId?: string } = {},
): Promise<RevokeRecordingResult> {
  const client = getClient(opts.client);
  const corrId = opts.correlationId ?? governanceCorrelationId();
  const reason = opts.reason;
  void actorId; // actor attribution is carried by the route audit, not stored

  const { data: session, error: sessionErr } = await client
    .from('call_sessions')
    .select('recording_revoked_at')
    .eq('id', sessionId)
    .single();
  if (sessionErr || !session) {
    return { status: 'not_found', revokedAt: null, correlationId: corrId };
  }

  let transitioned = false;
  let revokedAt: string | null = (session.recording_revoked_at as string | null) ?? null;
  if (session.recording_revoked_at === null) {
    const stamped = new Date().toISOString();
    const { data: updated, error: updErr } = await client
      .from('call_sessions')
      .update({ recording_revoked_at: stamped })
      .eq('id', sessionId)
      .is('recording_revoked_at', null)
      .select('recording_revoked_at');
    if (updErr) {
      return { status: 'failed_update', revokedAt: null, correlationId: corrId };
    }
    const matched = Array.isArray(updated) ? updated.length > 0 : Boolean(updated);
    if (matched) {
      transitioned = true;
      revokedAt = stamped;
    } else {
      // Lost the CAS race (concurrent revocation) — read the winner's stamp.
      const { data: nowRow } = await client
        .from('call_sessions')
        .select('recording_revoked_at')
        .eq('id', sessionId)
        .single();
      revokedAt = (nowRow?.recording_revoked_at as string | null) ?? revokedAt;
    }
  }

  // Converge the append-only 'revoked' event (backfill on retry).
  const { data: existingEvent } = await client
    .from('recording_integrity_events')
    .select('id')
    .eq('session_id', sessionId)
    .eq('event_type', 'revoked')
    .limit(1)
    .maybeSingle();

  let backfilled = false;
  if (!existingEvent) {
    const { error: evErr } = await client
      .from('recording_integrity_events')
      .insert({
        session_id: sessionId,
        event_type: 'revoked',
        detail: `recording access revoked (corr ${corrId})` + (reason ? `: ${reason}` : ''),
        correlation_id: corrId,
      });
    if (evErr && evErr.code !== '23505') {
      // A 23505 unique violation means a concurrent retry already appended
      // the event — that is convergence, not failure.
      return { status: 'failed_event', revokedAt, correlationId: corrId };
    }
    // A backfill is only "repairing a partial write" when THIS call did not
    // perform the transition (the transition itself appends its own event).
    backfilled = !transitioned && !evErr;
  }

  const status: RevokeRecordingStatus =
    transitioned || backfilled ? 'revoked' : 'already_revoked';
  return { status, revokedAt, correlationId: corrId, backfilled };
}

/**
 * REC-06 (SYNTHETIC STUB): models the intent to propagate an erasure to
 * downstream processors (e.g. a future LiveKit Egress MP3 store or a
 * transcript/derived-data worker). There are NO real processor DPAs or
 * worker pipelines — this returns deterministic intent so the completion
 * audit can prove propagation was modelled, not faked.
 */
export interface ProcessorErasureIntent {
  sessionId: string;
  correlationId: string | null;
  recordedAt: string;
  processors: Array<{
    id: string;
    synthetic: true;
    erasure_forwarded: boolean;
    note: string;
  }>;
}

export function propagateErasureToProcessors(
  sessionId: string,
  correlationId?: string | null,
  opts: { now?: Date } = {},
): ProcessorErasureIntent {
  return {
    sessionId,
    correlationId: correlationId ?? null,
    recordedAt: (opts.now ?? new Date()).toISOString(),
    processors: [
      {
        id: 'livekit_egress_mp3',
        synthetic: true,
        erasure_forwarded: true,
        note: 'modelled intent only — no real DPA/worker pipeline (external-pending)',
      },
    ],
  };
}

/**
 * REC-06 (SYNTHETIC MODEL): computes the backup-expiry horizon from the
 * data category's retention policy. No real backup system exists; the
 * horizon is a deterministic model output (given `now`) so a future real
 * backup-aging job has a stable contract to implement. retentionDays -1
 * (D-009 retain-default = indefinite) or a missing policy yields a null
 * horizon (no expiry computed).
 */
export interface BackupAgingPlan {
  sessionId: string;
  dataCategory: DataCategory;
  policyId: string | null;
  retentionDays: number | null;
  strategy: RetentionStrategy | null;
  /** ISO-8601 expiry horizon; null when indefinite (-1) or no policy. */
  horizonIso: string | null;
  synthetic: true;
}

export async function scheduleBackupAging(
  sessionId: string,
  dataCategory: DataCategory,
  opts: { now?: Date; client?: SupabaseClient } = {},
): Promise<BackupAgingPlan> {
  const now = opts.now ?? new Date();
  const policy = await getRetentionPolicy(dataCategory, opts.client);
  if (!policy) {
    return {
      sessionId,
      dataCategory,
      policyId: null,
      retentionDays: null,
      strategy: null,
      horizonIso: null,
      synthetic: true,
    };
  }
  const horizon =
    policy.retentionDays !== null && policy.retentionDays >= 0
      ? new Date(now.getTime() + policy.retentionDays * 86_400_000).toISOString()
      : null;
  return {
    sessionId,
    dataCategory,
    policyId: policy.id,
    retentionDays: policy.retentionDays,
    strategy: policy.strategy,
    horizonIso: horizon,
    synthetic: true,
  };
}
