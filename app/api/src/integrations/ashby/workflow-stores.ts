/**
 * ashby/workflow-stores.ts — service-role Supabase adapters for the 0031
 * workflow-execution RPCs + the Mission Control read projections. Every call
 * uses the service-role client (RLS-bypassing, server-only); browser roles
 * never reach these tables. Opaque ids + sanitized codes only cross this
 * boundary — no PII, tokens, presigned URLs, transcripts, or recordings.
 *
 * Split from the orchestrators (which stay pure) so unit tests drive in-memory
 * fakes and production wires these thin RPC adapters — the same seam pattern as
 * PR B's ports.ts / stores.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  RuntimeWorkflowStores,
  ExistingLinkRow,
  EnqueueResult,
  OperationClaimRow,
  WorkflowLinkRow,
} from './orchestration.js';
import type { AshbyLinkLookup } from './completion-observer.js';

const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000001';

function statusOf(data: unknown): string {
  return (data as { status?: string } | null)?.status ?? 'error';
}

/** Production WorkflowStores backed by the 0029/0031 tables + RPCs. */
export function createWorkflowStores(client: SupabaseClient, actorId: string = SYSTEM_ACTOR): RuntimeWorkflowStores {
  return {
    async findLinkByApplicationId(externalApplicationId): Promise<ExistingLinkRow | null> {
      const { data, error } = await client
        .from('ashby_application_links')
        .select('id, external_application_id, terminal_state, external_resume_file_handle')
        .eq('provider', 'ashby')
        .eq('external_application_id', externalApplicationId)
        .maybeSingle();
      if (error) throw new Error('ashby_link_read_error');
      if (!data) return null;
      const row = data as {
        id: string;
        external_application_id: string;
        terminal_state: string | null;
        external_resume_file_handle: string | null;
      };
      return {
        id: row.id,
        externalApplicationId: row.external_application_id,
        terminalState: (row.terminal_state as ExistingLinkRow['terminalState']) ?? null,
        externalResumeFileHandle: row.external_resume_file_handle ?? null,
      };
    },
    /**
     * Backfill-on-reuse. Guarded in SQL as well as by the caller: the `is`
     * filter means a concurrent writer that already set a handle wins and this
     * update matches no row, so a stored handle is never overwritten.
     */
    async bindLinkResumeHandle(applicationLinkId, handle): Promise<void> {
      const { error } = await client
        .from('ashby_application_links')
        .update({ external_resume_file_handle: handle })
        .eq('provider', 'ashby')
        .eq('id', applicationLinkId)
        .is('external_resume_file_handle', null);
      if (error) throw new Error('ashby_link_handle_backfill_error');
    },
    async createLink(input): Promise<{ id: string }> {
      const { data, error } = await client
        .from('ashby_application_links')
        .insert({
          provider: 'ashby',
          external_application_id: input.externalApplicationId,
          external_job_id: input.externalJobId,
          external_stage_id: input.externalStageId,
          job_mapping_id: input.jobMappingId,
          external_resume_file_handle: input.externalResumeFileHandle,
          lifecycle: 'imported',
        })
        .select('id')
        .single();
      if (error || !data) throw new Error('ashby_link_create_error');
      return { id: (data as { id: string }).id };
    },
    async advanceIngestion(applicationLinkId, nextState, provenance) {
      const { data, error } = await client.rpc('advance_ashby_ingestion', {
        p_application_link_id: applicationLinkId,
        p_next_state: nextState,
        p_content_sha256: provenance?.contentSha256 ?? null,
        p_extractor_version: provenance?.extractorVersion ?? null,
        p_structurer_version: provenance?.structurerVersion ?? null,
        p_failed_reason: provenance?.failedReason ?? null,
      });
      if (error) throw new Error('ashby_ingestion_advance_error');
      return { status: statusOf(data), state: (data as { state?: string } | null)?.state };
    },
    async enqueueOperation(input): Promise<EnqueueResult> {
      const { data, error } = await client.rpc('enqueue_ashby_operation', {
        p_application_link_id: input.applicationLinkId,
        p_operation_type: input.operationType,
        p_operation_key: input.operationKey,
        p_depends_on: input.dependsOn ?? null,
        p_marker: input.marker ?? null,
        p_actor_id: actorId,
      });
      if (error) throw new Error('ashby_operation_enqueue_error');
      return { status: statusOf(data), id: (data as { id?: string } | null)?.id };
    },
    async completeOperation(id, leaseToken, externalAnchor, marker): Promise<'ok' | 'not_owned'> {
      const { data, error } = await client.rpc('complete_ashby_operation', {
        p_operation_id: id,
        p_lease_token: leaseToken,
        p_external_anchor: externalAnchor ?? null,
        p_marker: marker ?? null,
        p_actor_id: actorId,
      });
      if (error) throw new Error('ashby_operation_complete_error');
      return statusOf(data) === 'ok' ? 'ok' : 'not_owned';
    },
    async failOperation(id, leaseToken, errorCode, retryable) {
      const { data, error } = await client.rpc('fail_ashby_operation', {
        p_operation_id: id,
        p_lease_token: leaseToken,
        p_error_code: errorCode,
        p_retryable: retryable,
      });
      if (error) throw new Error('ashby_operation_fail_error');
      if (statusOf(data) !== 'ok') return 'not_owned';
      const outcome = (data as { outcome?: string } | null)?.outcome;
      return { outcome: outcome === 'failed' ? 'failed' : 'retry' };
    },
    async deferOperation(id, leaseToken, reasonCode, delaySeconds): Promise<'ok' | 'not_owned'> {
      const { data, error } = await client.rpc('defer_ashby_operation', {
        p_operation_id: id,
        p_lease_token: leaseToken,
        p_reason_code: reasonCode,
        p_delay_seconds: delaySeconds,
      });
      if (error) throw new Error('ashby_operation_defer_error');
      return statusOf(data) === 'ok' ? 'ok' : 'not_owned';
    },
    async claimOperation(operationType, owner, leaseSeconds): Promise<OperationClaimRow | null> {
      const { data, error } = await client.rpc('claim_ashby_operation', {
        p_operation_type: operationType,
        p_owner: owner,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error('ashby_operation_claim_error');
      const row = data as Record<string, unknown> | null;
      if (statusOf(data) !== 'claimed') return null;
      const id = row?.id;
      const leaseToken = row?.lease_token;
      const linkId = row?.application_link_id;
      if (typeof id !== 'string' || typeof leaseToken !== 'string' || typeof linkId !== 'string') {
        throw new Error('ashby_operation_claim_malformed');
      }
      return {
        id,
        operationType: row?.operation_type as OperationClaimRow['operationType'],
        operationKey: typeof row?.operation_key === 'string' ? row.operation_key : null,
        applicationLinkId: linkId,
        leaseToken,
        attempts: typeof row?.attempts === 'number' ? row.attempts : 0,
        maxAttempts: typeof row?.max_attempts === 'number' ? row.max_attempts : 5,
        marker: typeof row?.marker === 'string' ? row.marker : null,
      };
    },
    async readIngestion(applicationLinkId): Promise<{ state: string; attempts: number } | null> {
      const { data, error } = await client
        .from('ashby_resume_ingestions')
        .select('state, attempts')
        .eq('provider', 'ashby')
        .eq('application_link_id', applicationLinkId)
        .maybeSingle();
      if (error) throw new Error('ashby_ingestion_read_error');
      if (!data) return null;
      const row = data as { state: string; attempts: number };
      return { state: String(row.state), attempts: Number(row.attempts) || 0 };
    },
    async readLink(applicationLinkId): Promise<WorkflowLinkRow | null> {
      const { data, error } = await client
        .from('ashby_application_links')
        .select(
          'id, external_application_id, external_job_id, job_mapping_id, ' +
            'candidate_id, session_id, invite_id, lifecycle, terminal_state, ' +
            'external_resume_file_handle',
        )
        .eq('provider', 'ashby')
        .eq('id', applicationLinkId)
        .maybeSingle();
      if (error) throw new Error('ashby_link_read_error');
      if (!data) return null;
      const r = data as unknown as Record<string, unknown>;
      return {
        id: String(r.id),
        externalApplicationId: String(r.external_application_id),
        externalJobId: (r.external_job_id as string | null) ?? null,
        externalResumeFileHandle: (r.external_resume_file_handle as string | null) ?? null,
        jobMappingId: (r.job_mapping_id as string | null) ?? null,
        candidateId: (r.candidate_id as string | null) ?? null,
        sessionId: (r.session_id as string | null) ?? null,
        inviteId: (r.invite_id as string | null) ?? null,
        lifecycle: String(r.lifecycle),
        terminalState: (r.terminal_state as WorkflowLinkRow['terminalState']) ?? null,
      };
    },
    async parkOperationAwaitingDelivery(id, leaseToken, externalAnchor): Promise<'ok' | 'not_owned'> {
      const { data, error } = await client.rpc('park_ashby_operation_awaiting_delivery', {
        p_operation_id: id,
        p_lease_token: leaseToken,
        p_external_anchor: externalAnchor,
      });
      if (error) throw new Error('ashby_operation_park_error');
      return statusOf(data) === 'ok' ? 'ok' : 'not_owned';
    },
    async markWritebackPending(applicationLinkId, reason): Promise<{ status: string }> {
      const { data, error } = await client.rpc('mark_ashby_writeback_pending', {
        p_application_link_id: applicationLinkId,
        p_reason: reason,
        p_actor_id: actorId,
      });
      if (error) throw new Error('ashby_writeback_pending_error');
      return { status: statusOf(data) };
    },
  };
}

/**
 * Session -> Ashby application link lookup for the completion observer.
 * Returns null for the overwhelmingly common case of a non-Ashby session, so
 * the observer costs one indexed lookup on the ordinary recruiter path.
 */
export function createAshbyLinkLookup(client: SupabaseClient): AshbyLinkLookup {
  return {
    async findLinkBySessionId(sessionId) {
      const { data, error } = await client
        .from('ashby_application_links')
        .select('id, terminal_state')
        .eq('provider', 'ashby')
        .eq('session_id', sessionId)
        .maybeSingle();
      if (error) throw new Error('ashby_link_by_session_error');
      if (!data) return null;
      const row = data as { id: string; terminal_state: string | null };
      return { id: String(row.id), terminalState: row.terminal_state ?? null };
    },
  };
}

// ── Mission Control read + action store ──────────────────────────────────────

/** A sanitized mapping row for Mission Control (no PII/tokens). */
export interface MissionControlMapping {
  id: string;
  externalJobId: string;
  status: 'paused' | 'enabled' | 'drift';
  statusReason: string | null;
  deliveryMode: string;
  hasAiStage: boolean;
  hasTaStage: boolean;
  label: string | null;
  updatedAt: string;
}

/** A sanitized workflow row for Mission Control (no PII/tokens). */
export interface MissionControlWorkflow {
  applicationLinkId: string;
  externalApplicationId: string;
  externalJobId: string | null;
  lifecycle: string;
  terminalState: string | null;
  ingestionState: string | null;
  operations: Array<{ id: string; type: string; state: string; errorCode: string | null }>;
  /**
   * Status of the screening session this application was materialized into,
   * or null when no session exists yet (or it could not be read).
   *
   * This is what makes a failed completion-park LEGIBLE. `observeAshbyCompletion`
   * is deliberately best-effort with respect to scoring — it must never discard
   * a scored assessment — so a transient RPC failure can leave a screened
   * application without its `writeback_pending` lifecycle. That combination
   * (`sessionStatus === 'completed'` while `lifecycle !== 'writeback_pending'`
   * and no terminal state) is exactly the stranded case, and it is visible here
   * rather than only in a log line. Re-parking is idempotent, so an operator
   * who sees it can act on it. A session status enum is not PII.
   */
  sessionStatus: string | null;
  updatedAt: string;
}

/** Admin-supplied mapping provisioning input. Opaque tenant ids only. */
export interface MissionControlMappingUpsert {
  /** Existing mapping id for an update; omit to create. */
  id?: string | null;
  externalJobId: string;
  roleId: string;
  ownerId: string;
  deliveryMode: 'email' | 'manual' | 'both';
  aiScreeningStageId?: string | null;
  taScreeningStageId?: string | null;
  feedbackFormId?: string | null;
  interviewId?: string | null;
  attributionUserId?: string | null;
  /** Non-sensitive display label only — never PII or a secret. */
  label?: string | null;
  actorId: string;
}

/** Outcome of an atomic manual-invite hand-off. Never carries the token. */
export interface MissionControlInviteIssue {
  status: string;
  inviteId?: string;
  revokedInvites?: number;
}

export interface MissionControlStore {
  listMappings(limit: number): Promise<MissionControlMapping[]>;
  listWorkflows(limit: number): Promise<MissionControlWorkflow[]>;
  /** Create/update a mapping. Always lands `paused`; never enables. */
  upsertMapping(input: MissionControlMappingUpsert): Promise<{ status: string; id?: string }>;
  /**
   * Atomically revoke every prior active invite for the application's session
   * and issue exactly one new one, storing ONLY the supplied digest. The
   * caller mints the plaintext and is the only holder of it.
   */
  reissueManualInvite(input: {
    applicationLinkId: string;
    tokenDigest: string;
    expiresAt: string;
    actorId: string;
  }): Promise<MissionControlInviteIssue>;
  setMappingStatus(mappingId: string, status: 'paused' | 'enabled', reason: string | null, actorId: string): Promise<{ status: string; mappingStatus?: string }>;
  cancelApplication(linkId: string, terminalState: string, reason: string | null, actorId: string): Promise<{ status: string; cancelledOperations?: number; cancelledIngestion?: number }>;
  retryOperation(operationId: string, actorId: string): Promise<{ status: string }>;
}

/** Mission Control read/action store (service-role; sanitized projections). */
export function createMissionControlStore(client: SupabaseClient): MissionControlStore {
  return {
    async listMappings(limit): Promise<MissionControlMapping[]> {
      const { data, error } = await client
        .from('ashby_job_mappings')
        .select('id, external_job_id, status, status_reason, delivery_mode, ai_screening_stage_id, ta_screening_stage_id, label, updated_at')
        .eq('provider', 'ashby')
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error('ashby_mc_mappings_error');
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        externalJobId: String(r.external_job_id),
        status: r.status as MissionControlMapping['status'],
        statusReason: (r.status_reason as string | null) ?? null,
        deliveryMode: String(r.delivery_mode),
        hasAiStage: r.ai_screening_stage_id != null,
        hasTaStage: r.ta_screening_stage_id != null,
        label: (r.label as string | null) ?? null,
        updatedAt: String(r.updated_at),
      }));
    },
    async listWorkflows(limit): Promise<MissionControlWorkflow[]> {
      const { data, error } = await client
        .from('ashby_application_links')
        .select(
          'id, external_application_id, external_job_id, lifecycle, terminal_state, session_id, updated_at, ' +
            'ashby_resume_ingestions ( state ), ' +
            'ashby_operations ( id, operation_type, state, error_code )',
        )
        .eq('provider', 'ashby')
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error('ashby_mc_workflows_error');

      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;

      // Session status is fetched as a SEPARATE bounded query rather than an
      // embedded join: it is a strictly additive diagnostic, so a failure to
      // read it must degrade to `null` and never take down the workflow list
      // that operators rely on.
      const sessionIds = [...new Set(
        rows.map((r) => r.session_id).filter((v): v is string => typeof v === 'string' && v.length > 0),
      )];
      const sessionStatus = new Map<string, string>();
      if (sessionIds.length > 0) {
        try {
          const { data: sessions, error: sessErr } = await client
            .from('call_sessions')
            .select('id, status')
            .in('id', sessionIds);
          if (!sessErr) {
            for (const s of ((sessions ?? []) as Array<{ id?: unknown; status?: unknown }>)) {
              if (typeof s.id === 'string' && typeof s.status === 'string') {
                sessionStatus.set(s.id, s.status);
              }
            }
          }
        } catch {
          // Diagnostic only — leave every sessionStatus null.
        }
      }

      return rows.map((r) => {
        const ings = (r.ashby_resume_ingestions as Array<{ state: string }> | null) ?? [];
        const ops = (r.ashby_operations as Array<{ id: string; operation_type: string; state: string; error_code: string | null }> | null) ?? [];
        return {
          applicationLinkId: String(r.id),
          externalApplicationId: String(r.external_application_id),
          externalJobId: (r.external_job_id as string | null) ?? null,
          lifecycle: String(r.lifecycle),
          terminalState: (r.terminal_state as string | null) ?? null,
          ingestionState: ings[0]?.state ?? null,
          operations: ops.map((o) => ({ id: o.id, type: o.operation_type, state: o.state, errorCode: o.error_code ?? null })),
          sessionStatus: typeof r.session_id === 'string' ? sessionStatus.get(r.session_id) ?? null : null,
          updatedAt: String(r.updated_at),
        };
      });
    },
    async setMappingStatus(mappingId, status, reason, actorId) {
      const { data, error } = await client.rpc('set_ashby_mapping_status', {
        p_mapping_id: mappingId,
        p_status: status,
        p_reason: reason,
        p_actor_id: actorId,
      });
      if (error) throw new Error('ashby_mc_set_status_error');
      return { status: statusOf(data), mappingStatus: (data as { mapping_status?: string } | null)?.mapping_status };
    },
    async cancelApplication(linkId, terminalState, reason, actorId) {
      const { data, error } = await client.rpc('cancel_ashby_application', {
        p_application_link_id: linkId,
        p_terminal_state: terminalState,
        p_reason: reason,
        p_actor_id: actorId,
        p_actor_type: 'recruiter',
      });
      if (error) throw new Error('ashby_mc_cancel_error');
      const d = data as { status?: string; cancelled_operations?: number; cancelled_ingestion?: number } | null;
      return { status: d?.status ?? 'error', cancelledOperations: d?.cancelled_operations, cancelledIngestion: d?.cancelled_ingestion };
    },
    async retryOperation(operationId, actorId) {
      // 0032: an AUDITED, attempt-bounded, terminal-safe RPC. The prior direct
      // table UPDATE discarded the actor (an unattributable admin action) and
      // ignored max_attempts, and — because the 0029 terminal trigger guards
      // INSERT only — could return a failed operation to `pending` on a
      // withdrawn application, which a runtime would then execute.
      const { data, error } = await client.rpc('retry_ashby_operation', {
        p_operation_id: operationId,
        p_actor_id: actorId,
      });
      if (error) throw new Error('ashby_mc_retry_error');
      return { status: statusOf(data) };
    },
    async reissueManualInvite(input): Promise<MissionControlInviteIssue> {
      const { data, error } = await client.rpc('reissue_ashby_manual_invite', {
        p_application_link_id: input.applicationLinkId,
        // DIGEST ONLY — the plaintext token never crosses this boundary.
        p_token_digest: input.tokenDigest,
        p_expires_at: input.expiresAt,
        p_actor_id: input.actorId,
      });
      if (error) throw new Error('ashby_mc_reissue_error');
      const row = data as { status?: string; invite_id?: string; revoked_invites?: number } | null;
      return {
        status: statusOf(data),
        inviteId: row?.invite_id,
        revokedInvites: typeof row?.revoked_invites === 'number' ? row.revoked_invites : undefined,
      };
    },
    async upsertMapping(input) {
      // Mapping creation ALWAYS lands paused. Enabling stays a separate,
      // explicit admin action gated by the DB completeness + drift checks.
      const { data, error } = await client.rpc('upsert_ashby_job_mapping', {
        p_mapping_id: input.id ?? null,
        p_external_job_id: input.externalJobId,
        p_role_id: input.roleId,
        p_ai_screening_stage_id: input.aiScreeningStageId ?? null,
        p_ta_screening_stage_id: input.taScreeningStageId ?? null,
        p_feedback_form_id: input.feedbackFormId ?? null,
        p_interview_id: input.interviewId ?? null,
        p_attribution_user_id: input.attributionUserId ?? null,
        p_owner_id: input.ownerId,
        p_delivery_mode: input.deliveryMode,
        p_invite_ttl_hours: 24,
        // ALWAYS paused on create/update through this surface. Enabling is a
        // separate, explicit admin action (POST /mappings/:id/resume) that the
        // DB still gates on stage completeness and absence of drift.
        p_status: 'paused',
        p_label: input.label ?? null,
        p_actor_id: input.actorId,
      });
      if (error) throw new Error('ashby_mc_upsert_mapping_error');
      return { status: statusOf(data), id: (data as { id?: string } | null)?.id };
    },
  };
}
