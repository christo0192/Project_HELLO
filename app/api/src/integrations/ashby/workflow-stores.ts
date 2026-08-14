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
import type { WorkflowStores, ExistingLinkRow, EnqueueResult } from './orchestration.js';

const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000001';

function statusOf(data: unknown): string {
  return (data as { status?: string } | null)?.status ?? 'error';
}

/** Production WorkflowStores backed by the 0029/0031 tables + RPCs. */
export function createWorkflowStores(client: SupabaseClient, actorId: string = SYSTEM_ACTOR): WorkflowStores {
  return {
    async findLinkByApplicationId(externalApplicationId): Promise<ExistingLinkRow | null> {
      const { data, error } = await client
        .from('ashby_application_links')
        .select('id, external_application_id, terminal_state')
        .eq('provider', 'ashby')
        .eq('external_application_id', externalApplicationId)
        .maybeSingle();
      if (error) throw new Error('ashby_link_read_error');
      if (!data) return null;
      const row = data as { id: string; external_application_id: string; terminal_state: string | null };
      return {
        id: row.id,
        externalApplicationId: row.external_application_id,
        terminalState: (row.terminal_state as ExistingLinkRow['terminalState']) ?? null,
      };
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
  updatedAt: string;
}

export interface MissionControlStore {
  listMappings(limit: number): Promise<MissionControlMapping[]>;
  listWorkflows(limit: number): Promise<MissionControlWorkflow[]>;
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
          'id, external_application_id, external_job_id, lifecycle, terminal_state, updated_at, ' +
            'ashby_resume_ingestions ( state ), ' +
            'ashby_operations ( id, operation_type, state, error_code )',
        )
        .eq('provider', 'ashby')
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error('ashby_mc_workflows_error');
      return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
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
      // Retry = reset a failed operation to pending (bounded) via a targeted update.
      const { data, error } = await client
        .from('ashby_operations')
        .update({ state: 'pending', scheduled_at: new Date().toISOString(), error_code: null })
        .eq('id', operationId)
        .eq('provider', 'ashby')
        .in('state', ['failed'])
        .select('id')
        .maybeSingle();
      if (error) throw new Error('ashby_mc_retry_error');
      void actorId;
      return { status: data ? 'ok' : 'not_retryable' };
    },
  };
}
