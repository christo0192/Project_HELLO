/**
 * GOV-05: DSAR (Data Subject Access Request) export/delete/correct
 * route foundations.
 *
 * DESIGN:
 *   - DSAR lifecycle: pending → in_progress → fulfilled | rejected | cancelled
 *   - Export: collects all candidate data into a structured JSON payload.
 *     Never includes secrets, tokens, or internal IDs that could enable
 *     privilege escalation.
 *   - Delete: performs cascading erasure through candidate-related entities.
 *     Blocked by active legal holds (GOV-04). Audits every step.
 *   - Correct: applies targeted corrections to candidate fields + metadata.
 *     Never allows correction of audit log or governance data.
 *   - Negative constraint: job_application consent alone (consent_source =
 *     'job_application') cannot unlock recording or outbound data export.
 *     Explicit recording consent is required.
 *   - Negative constraint: legal hold refuses deletion with audit.
 *
 * DEPENDENCY INJECTION: All functions accept an optional Supabase client
 * override for test isolation.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as defaultSupabase } from './supabase.js';
import { createLogger } from './logger.js';
import type { EventName } from './logger.js';
import {
  isUnderLegalHold,
  attemptErasure,
  recordGovernanceAudit,
  governanceCorrelationId,
} from './retention.js';
import type { LegalHold } from './retention.js';

const dsarLogger = createLogger('dsar');

// ── Type exports ─────────────────────────────────────────────────────

export type DSARRequestType = 'export' | 'delete' | 'correct' | 'restrict';

export type DSARStatus = 'pending' | 'in_progress' | 'fulfilled' | 'rejected' | 'cancelled';

export interface DSARRequest {
  id: string;
  candidateId: string;
  requestType: DSARRequestType;
  requestStatus: DSARStatus;
  requestedBy: string;
  requestedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  fulfilledAt: string | null;
  rejectionReason: string | null;
  legalHoldBlocked: boolean;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface DSARExportResult {
  requestId: string;
  candidate: Record<string, unknown>;
  sessions: Record<string, unknown>[];
  assessments: Record<string, unknown>[];
  transcripts: Record<string, unknown>[];
  resumes: Record<string, unknown>[];
  recordings: Record<string, unknown>[];
  // Recording/outbound data is only included when explicit recording consent exists,
  // not from job_application consent alone.
  recordingDataIncluded: boolean;
  exportedAt: string;
}

export interface DSARDeleteResult {
  success: boolean;
  deletedEntities: string[];
  blockedByLegalHolds: LegalHold[];
  auditEntryId: string | null;
}

export interface DSARCorrectResult {
  success: boolean;
  corrections: Array<{ field: string; oldValue: unknown; newValue: unknown }>;
}

// ── Internal helpers ─────────────────────────────────────────────────

function getClient(supabase?: SupabaseClient): SupabaseClient {
  return supabase ?? (defaultSupabase as unknown as SupabaseClient);
}

// ── DSAR CRUD ────────────────────────────────────────────────────────

/**
 * Create a new DSAR request.
 */
export async function createDSAR(
  candidateId: string,
  requestType: DSARRequestType,
  requestedBy: string,
  notes?: string,
  metadata?: Record<string, unknown>,
  clientOverride?: SupabaseClient,
): Promise<DSARRequest | null> {
  const client = getClient(clientOverride);
  const corrId = governanceCorrelationId();

  const { data, error } = await client
    .from('data_subject_requests')
    .insert({
      candidate_id: candidateId,
      request_type: requestType,
      request_status: 'pending',
      requested_by: requestedBy,
      notes: notes ?? null,
      metadata: metadata ?? null,
    })
    .select()
    .single();

  if (error) {
    dsarLogger.error('error_unhandled' as EventName, { error_type: 'dsar_create_failed' });
    return null;
  }

  // Audit
  await recordGovernanceAudit({
    action: 'dsar_created',
    actorId: requestedBy,
    entityType: 'candidate',
    entityId: candidateId,
    details: { dsar_id: data.id, request_type: requestType },
    outcome: 'success',
    correlationId: corrId,
  }, clientOverride);

  return mapRowToDSAR(data);
}

/**
 * Get DSAR request by ID.
 */
export async function getDSAR(
  requestId: string,
  clientOverride?: SupabaseClient,
): Promise<DSARRequest | null> {
  const client = getClient(clientOverride);
  const { data, error } = await client
    .from('data_subject_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (error || !data) return null;
  return mapRowToDSAR(data);
}

/**
 * List DSAR requests for a candidate.
 */
export async function listCandidateDSARs(
  candidateId: string,
  clientOverride?: SupabaseClient,
): Promise<DSARRequest[]> {
  const client = getClient(clientOverride);
  const { data, error } = await client
    .from('data_subject_requests')
    .select('*')
    .eq('candidate_id', candidateId)
    .order('requested_at', { ascending: false });

  if (error || !data) return [];
  return data.map(mapRowToDSAR);
}

/**
 * Update DSAR request status.
 */
export async function updateDSARStatus(
  requestId: string,
  status: DSARStatus,
  reviewedBy: string,
  rejectionReason?: string,
  clientOverride?: SupabaseClient,
): Promise<DSARRequest | null> {
  const client = getClient(clientOverride);

  const update: Record<string, unknown> = {
    request_status: status,
    reviewed_by: reviewedBy,
    reviewed_at: new Date().toISOString(),
  };

  if (status === 'fulfilled') {
    update.fulfilled_at = new Date().toISOString();
  }
  if (status === 'rejected' && rejectionReason) {
    update.rejection_reason = rejectionReason;
  }

  const { data, error } = await client
    .from('data_subject_requests')
    .update(update)
    .eq('id', requestId)
    .select()
    .single();

  if (error) return null;

  // Map status to audit action
  const actionMap: Record<DSARStatus, string> = {
    fulfilled: 'dsar_fulfilled',
    rejected: 'dsar_rejected',
    cancelled: 'dsar_cancelled',
    pending: 'dsar_created',
    in_progress: 'dsar_created',
  };

  await recordGovernanceAudit({
    action: (actionMap[status] || 'dsar_created') as any,
    actorId: reviewedBy,
    entityType: 'candidate',
    entityId: data.candidate_id,
    details: { dsar_id: requestId, status, rejection_reason: rejectionReason ?? null },
    outcome: status === 'rejected' ? 'failure' : 'success',
  }, clientOverride);

  return mapRowToDSAR(data);
}

// ── DSAR Export ──────────────────────────────────────────────────────

/**
 * Check if consent_source is sufficient for recording/outbound data.
 * job_application consent alone cannot unlock recording/outbound data.
 * Returns true only when explicit recording consent exists.
 */
export function canAccessRecordingData(consentSource: string | null): boolean {
  if (!consentSource) return false;
  // job_application consent is insufficient for recording/outbound data
  if (consentSource === 'job_application') return false;
  // Explicit recording consent sources
  return [
    'recording_consent',
    'explicit_recording',
    'voice_biometrics_consent',
    'ai_processing_consent',
  ].includes(consentSource);
}

/**
 * Export all candidate data for DSAR.
 * Respects consent boundaries: recording/outbound data is only included
 * when explicit recording consent exists (not job_application alone).
 */
export async function exportDSAR(
  dsarId: string,
  clientOverride?: SupabaseClient,
): Promise<DSARExportResult | null> {
  const client = getClient(clientOverride);

  // Get the DSAR request
  const dsar = await getDSAR(dsarId, client);
  if (!dsar) return null;

  // Mark as in_progress
  await client
    .from('data_subject_requests')
    .update({ request_status: 'in_progress' })
    .eq('id', dsarId);

  // Fetch candidate data
  const { data: candidate } = await client
    .from('candidates')
    .select('*')
    .eq('id', dsar.candidateId)
    .single();

  if (!candidate) return null;

  // Determine if recording data can be included
  const consentSource = (candidate.consent_source as string | null) ?? null;
  const recordingDataIncluded = canAccessRecordingData(consentSource);

  // Fetch related data
  const { data: sessions } = await client
    .from('call_sessions')
    .select('*')
    .eq('candidate_id', dsar.candidateId)
    .order('started_at', { ascending: false });

  const { data: assessments } = await client
    .from('assessments')
    .select('*')
    .eq('candidate_id', dsar.candidateId)
    .order('created_at', { ascending: false });

  const { data: transcripts } = await client
    .from('transcript_turns')
    .select('*')
    .eq('candidate_id', dsar.candidateId)
    .order('created_at', { ascending: true });

  const { data: resumes } = await client
    .from('resumes')
    .select('*')
    .eq('candidate_id', dsar.candidateId)
    .order('created_at', { ascending: false });

  // Recordings — only included when consent permits
  let recordings: Record<string, unknown>[] = [];
  if (recordingDataIncluded && sessions) {
    const sessionIds = sessions.map((s: any) => s.id);
    if (sessionIds.length > 0) {
      const { data: recData } = await client
        .from('call_sessions')
        .select('id, recording_object_key, mode, started_at, ended_at, duration_sec')
        .in('id', sessionIds)
        .not('recording_object_key', 'is', null);
      recordings = (recData ?? []).map((r: any) => ({
        sessionId: r.id,
        mode: r.mode,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationSec: r.duration_sec,
        // No signed URL — metadata only per data-minimization
        storageKeyPrefix: r.recording_object_key?.split('/').slice(0, -1).join('/') ?? null,
      }));
    }
  }

  // Build export payload (PII stripped from internal IDs, no tokens/secrets)
  const result: DSARExportResult = {
    requestId: dsarId,
    candidate: {
      id: candidate.id,
      name: candidate.name,
      email: candidate.email,
      phone_e164: candidate.phone_e164,
      skills: candidate.skills,
      experience_years: candidate.experience_years,
      status: candidate.status,
      role_id: candidate.role_id,
      consent_source: candidate.consent_source,
      consent_at: candidate.consent_at,
      created_at: candidate.created_at,
      // Excluded: parsed (contains resume PII - redacted in export)
      // Excluded: phone_raw (normalized E.164 provided instead)
      // Excluded: internal notes or internal status transitions
    },
    sessions: (sessions ?? []).map((s: any) => ({
      id: s.id,
      mode: s.mode,
      status: s.status,
      started_at: s.started_at,
      ended_at: s.ended_at,
      duration_sec: s.duration_sec,
      // Excluded: recording_object_key (internal reference)
      // Excluded: external_call_id (internal telephony reference)
    })),
    assessments: (assessments ?? []).map((a: any) => ({
      id: a.id,
      overall_score: a.overall_score,
      recommendation: a.recommendation,
      summary: a.summary,
      created_at: a.created_at,
      // Excluded: full assessment JSON if it contains internal notes
    })),
    transcripts: (transcripts ?? []).map((t: any) => ({
      speaker: t.speaker,
      text: t.text,
      turn_index: t.turn_index,
      created_at: t.created_at,
    })),
    resumes: (resumes ?? []).map((r: any) => ({
      id: r.id,
      file_name: r.file_name,
      mime_type: r.mime_type,
      created_at: r.created_at,
      // Excluded: file_path (internal), text_extracted (may contain PII);
      // in practice, the full text IS the candidate's data so include it
      text_extracted: r.text_extracted,
    })),
    recordings,
    recordingDataIncluded,
    exportedAt: new Date().toISOString(),
  };

  // Update DSAR as fulfilled
  await updateDSARStatus(dsarId, 'fulfilled', 'system', undefined, client);

  // Audit
  await recordGovernanceAudit({
    action: 'data_exported',
    actorId: dsar.requestedBy,
    entityType: 'candidate',
    entityId: dsar.candidateId,
    details: { dsar_id: dsarId, recording_data_included: recordingDataIncluded },
    outcome: 'success',
  }, clientOverride);

  return result;
}

// ── DSAR Delete (Erasure / Right to be Forgotten) ────────────────────

/**
 * Execute a DSAR data deletion request.
 * Checks legal holds before proceeding. If any active hold exists,
 * deletion is blocked and the attempt is audited.
 *
 * Negative: legal hold refuses deletion with audit trail.
 */
export async function deleteDSAR(
  dsarId: string,
  actorId: string,
  clientOverride?: SupabaseClient,
): Promise<DSARDeleteResult> {
  const client = getClient(clientOverride);
  const corrId = governanceCorrelationId();

  // Get the DSAR request
  const dsar = await getDSAR(dsarId, client);
  if (!dsar) {
    return {
      success: false,
      deletedEntities: [],
      blockedByLegalHolds: [],
      auditEntryId: null,
    };
  }

  if (dsar.requestType !== 'delete') {
    return {
      success: false,
      deletedEntities: [],
      blockedByLegalHolds: [],
      auditEntryId: null,
    };
  }

  const candidateId = dsar.candidateId;

  // Step 1: Check legal holds on the candidate
  const candidateBlocked = await isUnderLegalHold('candidate', candidateId, undefined, client);

  // Step 2: Check legal holds on related sessions
  const { data: sessions } = await client
    .from('call_sessions')
    .select('id')
    .eq('candidate_id', candidateId);

  const sessionIds = (sessions ?? []).map((s: any) => s.id);
  const sessionBlocks: Array<{ entityType: string; entityId: string }> = [];

  for (const sessionId of sessionIds) {
    const blocked = await isUnderLegalHold('session', sessionId, undefined, client);
    if (blocked) {
      sessionBlocks.push({ entityType: 'session', entityId: sessionId });
    }
  }

  if (candidateBlocked || sessionBlocks.length > 0) {
    // Gather all blocking holds
    const allHolds: LegalHold[] = [];
    if (candidateBlocked) {
      const holds = await (await import('./retention.js')).getActiveLegalHolds('candidate', candidateId, client);
      allHolds.push(...holds);
    }
    for (const sb of sessionBlocks) {
      const holds = await (await import('./retention.js')).getActiveLegalHolds(
        sb.entityType as any,
        sb.entityId,
        client,
      );
      allHolds.push(...holds);
    }

    // Mark DSAR as blocked
    await client
      .from('data_subject_requests')
      .update({
        legal_hold_blocked: true,
        request_status: 'pending',
        notes: `Deletion blocked by ${allHolds.length} active legal hold(s)`,
      })
      .eq('id', dsarId);

    // Audit the block
    await recordGovernanceAudit({
      action: 'erasure_blocked_legal_hold',
      actorId,
      entityType: 'candidate',
      entityId: candidateId,
      details: {
        dsar_id: dsarId,
        hold_ids: allHolds.map(h => h.id),
        hold_reasons: allHolds.map(h => h.holdReason),
        session_blocks: sessionBlocks.map(sb => sb.entityId),
      },
      outcome: 'blocked',
      correlationId: corrId,
    }, clientOverride);

    return {
      success: false,
      deletedEntities: [],
      blockedByLegalHolds: allHolds,
      auditEntryId: null,
    };
  }

  // No blocks — proceed with cascade deletion
  const deletedEntities: string[] = [];

  // Delete recordings (if any)
  for (const sessionId of sessionIds) {
    const { error: recordingErr } = await client
      .from('call_sessions')
      .update({ recording_object_key: null })
      .eq('id', sessionId);
    if (!recordingErr) deletedEntities.push(`recording:${sessionId}`);
  }

  // Delete transcripts
  const { error: transcriptErr } = await client
    .from('transcript_turns')
    .delete()
    .eq('candidate_id', candidateId);
  if (!transcriptErr) deletedEntities.push(`transcript:${candidateId}`);

  // Delete assessments
  const { error: assessmentErr } = await client
    .from('assessments')
    .delete()
    .eq('candidate_id', candidateId);
  if (!assessmentErr) deletedEntities.push(`assessment:${candidateId}`);

  // Delete invites
  const { error: inviteErr } = await client
    .from('candidate_invites')
    .delete()
    .eq('candidate_id', candidateId);
  if (!inviteErr) deletedEntities.push(`invite:${candidateId}`);

  // Delete sessions
  const { error: sessionErr } = await client
    .from('call_sessions')
    .delete()
    .eq('candidate_id', candidateId);
  if (!sessionErr) deletedEntities.push(`session:${candidateId}`);

  // Delete resume
  const { error: resumeErr } = await client
    .from('resumes')
    .delete()
    .eq('candidate_id', candidateId);
  if (!resumeErr) deletedEntities.push(`resume:${candidateId}`);

  // Finally, delete the candidate
  const { error: candidateErr } = await client
    .from('candidates')
    .delete()
    .eq('id', candidateId);
  if (!candidateErr) deletedEntities.push(`candidate:${candidateId}`);

  // Mark DSAR as fulfilled
  await updateDSARStatus(dsarId, 'fulfilled', actorId, undefined, client);

  // Audit
  await recordGovernanceAudit({
    action: 'data_deleted',
    actorId,
    entityType: 'candidate',
    entityId: candidateId,
    details: {
      dsar_id: dsarId,
      deleted_entities: deletedEntities,
      cascade_count: deletedEntities.length,
    },
    outcome: 'success',
    correlationId: corrId,
  }, clientOverride);

  return {
    success: true,
    deletedEntities,
    blockedByLegalHolds: [],
    auditEntryId: null,
  };
}

// ── DSAR Correct (Rectification) ─────────────────────────────────────

/**
 * Define which candidate fields are correctable via DSAR.
 * Audit-related, governance, and internal tracking fields are NEVER correctable.
 */
const CORRECTABLE_FIELDS = new Set([
  'name', 'email', 'phone_raw', 'phone_e164',
  'skills', 'experience_years', 'status',
]);

/**
 * Fields that are NEVER correctable via DSAR (governance/audit protection).
 */
const NEVER_CORRECTABLE_FIELDS = new Set([
  'id', 'created_at', 'updated_at', 'owner_id',
  'consent_source', 'consent_at',
  'resume_id', 'role_id', 'parsed',
  'ats_external_id', 'ats_source',
]);

/**
 * Apply corrections to candidate data as part of a DSAR rectification request.
 *
 * Negative: never allows correction of audit log or governance data.
 * Negative: legal hold does not block corrections (only blocks deletion).
 */
export async function correctDSAR(
  dsarId: string,
  corrections: Array<{ field: string; value: unknown }>,
  actorId: string,
  clientOverride?: SupabaseClient,
): Promise<DSARCorrectResult> {
  const client = getClient(clientOverride);
  const corrId = governanceCorrelationId();

  // Get the DSAR request
  const dsar = await getDSAR(dsarId, client);
  if (!dsar || dsar.requestType !== 'correct') {
    return { success: false, corrections: [] };
  }

  const candidateId = dsar.candidateId;

  // Fetch current candidate data
  const { data: candidate } = await client
    .from('candidates')
    .select('*')
    .eq('id', candidateId)
    .single();

  if (!candidate) {
    return { success: false, corrections: [] };
  }

  // Validate and apply corrections
  const applied: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
  const updates: Record<string, unknown> = {};

  for (const correction of corrections) {
    // Reject uncorrectable fields
    if (NEVER_CORRECTABLE_FIELDS.has(correction.field)) continue;
    if (!CORRECTABLE_FIELDS.has(correction.field)) continue;

    const oldValue = (candidate as Record<string, unknown>)[correction.field];

    // Skip no-op corrections
    if (oldValue === correction.value) continue;

    updates[correction.field] = correction.value;
    applied.push({
      field: correction.field,
      oldValue,
      newValue: correction.value,
    });
  }

  if (applied.length === 0) {
    await updateDSARStatus(dsarId, 'fulfilled', actorId, undefined, client);
    await recordGovernanceAudit({
      action: 'data_corrected',
      actorId,
      entityType: 'candidate',
      entityId: candidateId,
      details: { dsar_id: dsarId, corrections_applied: 0, note: 'All corrections were no-op or rejected' },
      outcome: 'success',
      correlationId: corrId,
    }, clientOverride);
    return { success: true, corrections: applied };
  }

  // Apply updates
  const { error } = await client
    .from('candidates')
    .update(updates)
    .eq('id', candidateId);

  if (error) {
    return { success: false, corrections: [] };
  }

  // Mark DSAR as fulfilled
  await updateDSARStatus(dsarId, 'fulfilled', actorId, undefined, client);

  // Audit
  await recordGovernanceAudit({
    action: 'data_corrected',
    actorId,
    entityType: 'candidate',
    entityId: candidateId,
    details: {
      dsar_id: dsarId,
      corrections_applied: applied.length,
      fields: applied.map(a => a.field),
    },
    outcome: 'success',
    correlationId: corrId,
  }, clientOverride);

  return { success: true, corrections: applied };
}

// ── Row mappers ──────────────────────────────────────────────────────

function mapRowToDSAR(row: Record<string, unknown>): DSARRequest {
  return {
    id: row.id as string,
    candidateId: row.candidate_id as string,
    requestType: row.request_type as DSARRequestType,
    requestStatus: row.request_status as DSARStatus,
    requestedBy: row.requested_by as string,
    requestedAt: row.requested_at as string,
    reviewedBy: row.reviewed_by as string | null,
    reviewedAt: row.reviewed_at as string | null,
    fulfilledAt: row.fulfilled_at as string | null,
    rejectionReason: row.rejection_reason as string | null,
    legalHoldBlocked: row.legal_hold_blocked as boolean,
    notes: row.notes as string | null,
    metadata: row.metadata as Record<string, unknown> | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
