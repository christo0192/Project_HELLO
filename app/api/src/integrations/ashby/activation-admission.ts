import type { AshbyResult, OpaqueRecord } from './types.js';

export interface ApplicationHistoryLister {
  applicationListHistory<T = OpaqueRecord[]>(params: {
    applicationId: string;
    cursor?: string;
    limit?: number;
    deadlineAt?: number;
  }): Promise<AshbyResult<T>>;
}

export type HistoryAdmission = 'admit' | 'not_after_activation';

/**
 * Prove the complete, unique current interval for a stage. Every page is
 * examined; malformed, future, conflicting, incomplete, or bounded evidence
 * is an error so the caller can retry without advancing a reconciliation
 * cursor. `deadlineAt` is shared with the caller's wall-clock budget.
 */
export async function admitStageAfterActivation(
  client: ApplicationHistoryLister,
  input: { applicationId: string; stageId: string; activationAt: string; maxPages?: number; deadlineAt?: number; nowMs?: () => number },
): Promise<HistoryAdmission> {
  const clock = input.nowMs ?? Date.now;
  const activationMs = Date.parse(input.activationAt);
  if (!Number.isFinite(activationMs)) throw new Error('ashby_history_activation_time_invalid');
  const now = clock();
  if (activationMs > now) throw new Error('ashby_history_activation_time_future');
  const maxPages = Math.min(Math.max(Math.trunc(input.maxPages ?? 10), 1), 50);
  const deadlineAt = input.deadlineAt ?? now + 10_000;
  let cursor: string | undefined;
  const seen = new Set<string>();
  let openTarget = 0;
  let openIntervals = 0;
  let eligible = false;
  for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
    if (clock() >= deadlineAt) throw new Error('ashby_history_deadline');
    const page = await client.applicationListHistory<OpaqueRecord[]>({
      applicationId: input.applicationId, cursor, limit: 100, deadlineAt,
    });
    if (clock() >= deadlineAt) throw new Error('ashby_history_deadline');
    if (typeof page.moreDataAvailable !== 'boolean' || page.moreDataAvailablePresent === false) throw new Error('ashby_history_pagination_flag_missing');
    if (!Array.isArray(page.results)) throw new Error('ashby_history_results_malformed');
    for (const raw of page.results) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ashby_history_row_malformed');
      const row = raw as Record<string, unknown>;
      if (typeof row.stageId !== 'string' || row.stageId.length < 1 || row.stageId.length > 256) throw new Error('ashby_history_stage_malformed');
      if (typeof row.enteredStageAt !== 'string') throw new Error('ashby_history_entry_time_malformed');
      const entered = Date.parse(row.enteredStageAt);
      if (!Number.isFinite(entered) || entered > now) throw new Error('ashby_history_entry_time_invalid');
      if (!Object.prototype.hasOwnProperty.call(row, 'leftStageAt')) throw new Error('ashby_history_exit_time_missing');
      const left = row.leftStageAt;
      if (left !== null && typeof left !== 'string') throw new Error('ashby_history_exit_time_malformed');
      const leftMs = left === null ? null : Date.parse(left);
      if (left !== null && (leftMs === null || !Number.isFinite(leftMs) || leftMs < entered || leftMs > now)) throw new Error('ashby_history_exit_time_invalid');
      if (left === null) openIntervals += 1;
      if (row.stageId === input.stageId && left === null) {
        openTarget += 1;
        if (entered >= activationMs) eligible = true;
      }
    }
    if (!page.moreDataAvailable) {
      if (openTarget !== 1 || openIntervals !== 1) throw new Error('ashby_history_ambiguous');
      return eligible ? 'admit' : 'not_after_activation';
    }
    if (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0 || seen.has(page.nextCursor)) throw new Error('ashby_history_cursor_invalid');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('ashby_history_page_cap');
}
