/**
 * The R1 recording part of a DSAR (`lib/dsar.ts` calls these two functions and nothing else).
 *
 * ERASE (`eraseCandidateR1Recordings`): runs after the legal-hold gate and BEFORE any row of the
 * existing cascade is deleted. The recordings table is the only index of the objects in R2, so the
 * objects must be gone, and proven gone (erase.ts verifies), while the rows still exist. Any failure
 * returns before a single row is deleted and the caller does not mark the request fulfilled. The
 * `r1_recording_purge` outbox is the backstop for every OTHER delete path (an ops script, a plain
 * candidate delete); a DSAR drains the candidate's open outbox rows too.
 *
 *   - no R1 recording and no open outbox row for the candidate -> nothing to do, the store is never touched
 *   - rows exist but the R2 config is not enabled on this machine -> FAILURE (never "skip")
 *   - a legal hold on a recording (session id) -> BLOCKED with the holds, nothing erased
 *   - anything else that fails -> FAILURE with a closed code
 *
 * EXPORT (`listCandidateR1Recordings`): metadata only, no URL, no key, no hash (consistent with the
 * rest of the DSAR export: staff play a recording through the audited playback route).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LegalHold } from '../../retention.js';
import type { R1DbClient } from '../../../services/r1-assessment.js';
import { getR1RecordingConfig, type R1RecordingConfig } from './config.js';
import { PURGE_TABLE, eraseOutboxRow, eraseRecording, sessionIdOfPrefix, type R1PurgeRow } from './erase.js';
import { findActiveHolds, toLegalHold } from './holds.js';
import { R1RecordingDbError, RECORDINGS_TABLE, type R1RecordingRow } from './service.js';
import { getR1RecordingStore } from './store-factory.js';
import type { R1ObjectStore } from './store.js';

export interface R1DsarStepDeps {
  readonly recordingConfig?: () => R1RecordingConfig;
  readonly store?: (config: Extract<R1RecordingConfig, { enabled: true }>) => R1ObjectStore;
  readonly now?: () => Date;
  readonly actorId?: string;
}

export type R1DsarEraseResult =
  | { readonly ok: true; readonly erased: string[] }
  | { readonly ok: false; readonly kind: 'blocked'; readonly holds: LegalHold[] }
  | { readonly ok: false; readonly kind: 'failed'; readonly code: string };

const OUTBOX_SCAN_ROWS = 500;

async function roundIdsOf(db: R1DbClient, candidateId: string): Promise<string[]> {
  const { data, error } = await db.from('interview_rounds').select('id').eq('candidate_id', candidateId);
  if (error) throw new R1RecordingDbError();
  return (Array.isArray(data) ? data : []).map((row: { id?: unknown }) => String(row.id));
}

async function recordingsOfRounds(db: R1DbClient, roundIds: readonly string[], columns: string, liveOnly: boolean): Promise<Array<Record<string, any>>> {
  const out: Array<Record<string, any>> = [];
  for (let at = 0; at < roundIds.length; at += 100) {
    let query = db.from(RECORDINGS_TABLE).select(columns).in('round_id', roundIds.slice(at, at + 100));
    if (liveOnly) query = query.is('deleted_at', null);
    const { data, error } = await query;
    if (error) throw new R1RecordingDbError();
    out.push(...(Array.isArray(data) ? data : []));
  }
  return out;
}

function closedCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9_]{1,64}$/.test(message) ? message : 'r1_dsar_error';
}

/** Erase every R1 recording of the candidate (any status, incl. `preparing`) and drain their open outbox rows. */
export async function eraseCandidateR1Recordings(
  candidateId: string,
  client: SupabaseClient,
  deps: R1DsarStepDeps = {},
): Promise<R1DsarEraseResult> {
  const db = client as unknown as R1DbClient;
  try {
    const roundIds = await roundIdsOf(db, candidateId);
    if (roundIds.length === 0) return { ok: true, erased: [] };
    const rows = (await recordingsOfRounds(db, roundIds, '*', true)) as R1RecordingRow[];

    // Open outbox rows whose prefix names one of this candidate's rounds.
    const { data: outboxData, error: outboxError } = await db
      .from(PURGE_TABLE)
      .select('*')
      .is('done_at', null)
      .order('queued_at', { ascending: true })
      .limit(OUTBOX_SCAN_ROWS);
    if (outboxError) throw new R1RecordingDbError();
    const rounds = new Set(roundIds.map((id) => id.toLowerCase()));
    const outbox = ((Array.isArray(outboxData) ? outboxData : []) as R1PurgeRow[]).filter((row) => {
      const parts = row.prefix.split('/');
      return parts.length === 4 && parts[0] === 'r1' && rounds.has((parts[1] ?? '').toLowerCase());
    });
    if (rows.length === 0 && outbox.length === 0) return { ok: true, erased: [] };

    // Rows exist: the objects must be erased, so the store must be reachable. Never skip.
    const config = (deps.recordingConfig ?? ((): R1RecordingConfig => getR1RecordingConfig()))();
    if (!config.enabled) return { ok: false, kind: 'failed', code: 'r1_storage_unconfigured' };
    const store = (deps.store ?? getR1RecordingStore)(config);
    const eraseDeps = { db, store, bucket: config.s3.bucket, ...(deps.now ? { now: deps.now } : {}) };
    const actor = { actorId: deps.actorId, actorType: deps.actorId ? 'recruiter' : 'system' };

    // All-or-nothing on holds: a held recording stops the whole request before anything is deleted.
    const sessionIds = [
      ...rows.map((row) => row.session_id),
      ...outbox.map((row) => sessionIdOfPrefix(row.prefix)).filter((id): id is string => id !== null),
    ];
    const holds = await findActiveHolds(db, sessionIds.map((id) => ({ type: 'recording' as const, id })));
    if (holds.length > 0) return { ok: false, kind: 'blocked', holds: holds.map(toLegalHold) };

    const erased: string[] = [];
    for (const row of rows) {
      const outcome = await eraseRecording(eraseDeps, row, 'dsar', actor);
      if (outcome.kind === 'blocked') return { ok: false, kind: 'failed', code: 'r1_erase_blocked' };
      erased.push(row.session_id);
    }
    for (const row of outbox) {
      const outcome = await eraseOutboxRow(eraseDeps, row, actor);
      if (outcome.kind === 'failed') return { ok: false, kind: 'failed', code: outcome.code };
      if (outcome.kind === 'blocked') return { ok: false, kind: 'failed', code: 'r1_erase_blocked' };
      const sessionId = sessionIdOfPrefix(row.prefix);
      if (sessionId) erased.push(sessionId);
    }
    return { ok: true, erased };
  } catch (error) {
    return { ok: false, kind: 'failed', code: closedCode(error) };
  }
}

/** DSAR export: one metadata object per recording of the candidate. No URL, key, bucket, hash or ETag. */
export async function listCandidateR1Recordings(candidateId: string, client: SupabaseClient): Promise<Array<Record<string, unknown>>> {
  const db = client as unknown as R1DbClient;
  try {
    const roundIds = await roundIdsOf(db, candidateId);
    if (roundIds.length === 0) return [];
    const recordings = await recordingsOfRounds(
      db,
      roundIds,
      'session_id,round_id,status,layout,duration_ms,video_bytes,audio_bytes,started_at_ms,created_at,delete_after',
      false,
    );
    if (recordings.length === 0) return [];
    const attemptNumbers = new Map<string, number>();
    for (let at = 0; at < roundIds.length; at += 100) {
      const { data, error } = await db.from('interview_round_attempts').select('session_id,attempt_number').in('round_id', roundIds.slice(at, at + 100));
      if (error) throw new R1RecordingDbError();
      for (const attempt of Array.isArray(data) ? data : []) attemptNumbers.set(String(attempt.session_id), Number(attempt.attempt_number));
    }
    return recordings
      .map((row) => {
        const bytes = row.video_bytes === null && row.audio_bytes === null ? null : Number(row.video_bytes ?? 0) + Number(row.audio_bytes ?? 0);
        const startedMs = Number(row.started_at_ms);
        return {
          session_id: row.session_id,
          attempt_number: attemptNumbers.get(String(row.session_id)) ?? null,
          status: row.status,
          layout: row.layout ?? null,
          duration_ms: row.duration_ms ?? null,
          bytes,
          recorded_at: Number.isFinite(startedMs) && startedMs > 0 ? new Date(startedMs).toISOString() : row.created_at,
          delete_after: row.delete_after,
        };
      })
      .sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)));
  } catch {
    // Like the other export sections, a failed read leaves this section out rather than failing the export.
    return [];
  }
}
