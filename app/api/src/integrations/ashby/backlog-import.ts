import type { SupabaseClient } from '@supabase/supabase-js';
import { extractApplicationInfo } from './extractors.js';
import type { AshbyClient } from './client.js';

export const MAX_SNAPSHOT_ITEMS = 500;
export const SNAPSHOT_TTL_MS = 10 * 60_000;
const MAX_PREVIEW_PAGES = 50;

export interface BacklogPreview {
  runId: string;
  mappingId: string;
  externalJobId: string;
  stageId: string;
  expectedCount: number;
  cap: number;
  expiresAt: string;
  configVersion: number;
  activationEpoch: number;
}

export interface BacklogConfirmation {
  status: string;
  runId?: string;
  queuedCount?: number;
}

export interface BacklogImportStore {
  preview(mappingId: string, actorId: string): Promise<BacklogPreview>;
  confirm(mappingId: string, runId: string, expectedCount: number, actorId: string): Promise<BacklogConfirmation>;
}

function providerRow(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('ashby_backlog_row_malformed');
  return value as Record<string, unknown>;
}

/** Read, validate, count, and snapshot one mapped job's current AI-stage rows. */
export function createAshbyBacklogImportStore(db: SupabaseClient, provider: AshbyClient): BacklogImportStore {
  return {
    async preview(mappingId, actorId) {
      const { data, error } = await db.from('ashby_job_mappings')
        .select('id, external_job_id, ai_screening_stage_id, config_version, activation_epoch, status')
        .eq('provider', 'ashby').eq('id', mappingId).maybeSingle();
      if (error) throw new Error('ashby_backlog_mapping_read_error');
      const mapping = data as Record<string, unknown> | null;
      if (!mapping) throw new Error('not_found');
      if (mapping.status !== 'enabled') throw new Error('mapping_not_enabled');
      const jobId = typeof mapping.external_job_id === 'string' ? mapping.external_job_id : '';
      const stageId = typeof mapping.ai_screening_stage_id === 'string' ? mapping.ai_screening_stage_id : '';
      const configVersion = typeof mapping.config_version === 'number' ? mapping.config_version : 0;
      const activationEpoch = typeof mapping.activation_epoch === 'number' ? mapping.activation_epoch : 0;
      if (!jobId || !stageId || !configVersion) throw new Error('mapping_incomplete');

      const snapshot: Array<{ applicationId: string; jobId: string; stageId: string }> = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let pageNo = 0; pageNo < MAX_PREVIEW_PAGES; pageNo += 1) {
        const page = await provider.applicationList<Record<string, unknown>[]>({ jobId, cursor, limit: 100 });
        if (typeof page.moreDataAvailable !== 'boolean' || page.moreDataAvailablePresent === false) throw new Error('ashby_backlog_pagination_flag_missing');
        if (!Array.isArray(page.results)) throw new Error('ashby_backlog_results_malformed');
        for (const raw of page.results) {
          // The provider's jobId filter is only a narrowing hint. Validate
          // every returned row before any ID enters the durable snapshot.
          const root = providerRow(raw);
          const view = extractApplicationInfo(root);
          if (!view.applicationId || view.jobId !== jobId || !view.currentStageId) throw new Error('ashby_backlog_identity_malformed');
          if (view.currentStageId !== stageId || seen.has(view.applicationId)) continue;
          seen.add(view.applicationId);
          snapshot.push({ applicationId: view.applicationId, jobId, stageId });
          if (snapshot.length > MAX_SNAPSHOT_ITEMS) throw new Error('ashby_backlog_cap_exceeded');
        }
        if (!page.moreDataAvailable) break;
        if (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0 || page.nextCursor === cursor) throw new Error('ashby_backlog_cursor_invalid');
        cursor = page.nextCursor;
        if (pageNo === MAX_PREVIEW_PAGES - 1) throw new Error('ashby_backlog_page_cap');
      }
      const expiresAt = new Date(Date.now() + SNAPSHOT_TTL_MS).toISOString();
      const { data: run, error: runError } = await db.rpc('create_ashby_snapshot_preview', {
        p_mapping_id: mappingId,
        p_external_job_id: jobId,
        p_stage_id: stageId,
        p_config_version: configVersion,
        p_activation_epoch: activationEpoch,
        p_actor_id: actorId,
        p_snapshot: snapshot,
        p_expected_count: snapshot.length,
        p_expires_at: expiresAt,
      });
      if (runError) throw new Error('ashby_backlog_preview_persist_error');
      const row = run as { status?: string; run_id?: string; expires_at?: string; expected_count?: number } | null;
      if (row?.status !== 'ok' || typeof row.run_id !== 'string') throw new Error(row?.status ?? 'ashby_backlog_preview_rejected');
      return {
        runId: row.run_id,
        mappingId,
        externalJobId: jobId,
        stageId,
        expectedCount: snapshot.length,
        cap: MAX_SNAPSHOT_ITEMS,
        expiresAt: row.expires_at ?? expiresAt,
        configVersion,
        activationEpoch,
      };
    },
    async confirm(mappingId, runId, expectedCount, actorId) {
      const { data, error } = await db.rpc('confirm_ashby_snapshot_import', {
        p_run_id: runId,
        p_mapping_id: mappingId,
        p_expected_count: expectedCount,
        p_actor_id: actorId,
      });
      if (error) throw new Error('ashby_backlog_confirm_error');
      const row = data as { status?: string; run_id?: string; queued_count?: number } | null;
      return { status: row?.status ?? 'error', runId: row?.run_id, queuedCount: row?.queued_count };
    },
  };
}
