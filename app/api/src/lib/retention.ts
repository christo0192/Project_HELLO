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
