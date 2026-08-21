/**
 * integrations/ashby/candidate-workflow.ts — the candidate-scoped, read-only
 * projection of an Ashby screening workflow.
 *
 * This is deliberately NOT a second state model. Every value it emits is the
 * SAME vocabulary Mission Control already reads straight off the 0029/0032
 * tables:
 *   - `lifecycle`      — ashby_application_links.lifecycle
 *                        (imported|processing|ready|completed|writeback_pending|cancelled)
 *   - `terminalState`  — ashby_application_links.terminal_state
 *                        (withdrawn|deleted|manual_stage_cancel)
 *   - `ingestionState` — ashby_resume_ingestions.state
 *                        (queued|fetching|scanning|extracting|structuring|ready|failed_review|cancelled)
 *   - operation state  — ashby_operations.state
 *                        (pending|running|succeeded|failed|blocked|cancelled)
 *   - `sessionStatus`  — call_sessions.status
 * See `MissionControlWorkflow` in workflow-stores.ts for the operator-facing
 * projection of the same rows.
 *
 * What makes this projection *purpose-built* is what it REFUSES to carry. The
 * candidate page is a wider surface than Mission Control (viewer role, every
 * owning interviewer), so this projection never emits:
 *   - external Ashby identifiers (external_application_id / external_job_id),
 *   - internal row ids of any kind — no application link id, no operation id,
 *     no ingestion id, no session id,
 *   - operation keys, markers, leases, attempt/lease bookkeeping,
 *   - invite tokens or digests, presigned URLs, provider payloads,
 *   - candidate PII of any kind (the card is rendered next to the profile that
 *     already shows it, and adds nothing).
 *
 * `error_code` IS emitted: 0029 constrains it to `^[a-z0-9_.:-]{1,64}$` — a
 * sanitized stable code by construction. The sibling free-text columns
 * (`error_detail`, ingestion `failed_reason`) are NOT emitted: they are only
 * "bounded" and "sanitized" by convention, which is not a guarantee this
 * surface should rely on.
 *
 * `stage_move` operations are filtered out entirely. This lane shows the
 * invite and scorecard legs only; stage movement is neither shown nor
 * controllable here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The operation legs this surface reports on. `stage_move` is never included. */
export const CANDIDATE_WORKFLOW_OPERATION_TYPES = ['invite_delivery', 'scorecard_write'] as const;
export type CandidateWorkflowOperationType = (typeof CANDIDATE_WORKFLOW_OPERATION_TYPES)[number];

export interface CandidateAshbyWorkflowOperation {
  type: CandidateWorkflowOperationType;
  state: string;
  /** Sanitized stable code from 0029's CHECK, or null. Never a provider body. */
  errorCode: string | null;
}

export interface CandidateAshbyWorkflowView {
  lifecycle: string;
  terminalState: string | null;
  ingestionState: string | null;
  /** At most one entry per type — the most recently updated row for that leg. */
  operations: CandidateAshbyWorkflowOperation[];
  sessionStatus: string | null;
  /** Null when the row carries no usable timestamp — never a fabricated one. */
  updatedAt: string | null;
}

export interface CandidateAshbyWorkflowStore {
  /**
   * The candidate's current Ashby workflow, or `null` when the candidate has
   * no Ashby application link at all (a non-Ashby candidate — an ordinary
   * absence, never an error).
   */
  getForCandidate(candidateId: string): Promise<CandidateAshbyWorkflowView | null>;
  /**
   * The workflow of ONE named application link.
   *
   * A candidate may hold several Ashby applications. A surface addressed by a
   * specific link (the scoped review shell) must report THAT link, not the
   * candidate's most recent one — otherwise the card silently describes a
   * different application than the page around it. Neither entry point
   * authorizes anything; see the store doc below.
   */
  getForApplicationLink(applicationLinkId: string): Promise<CandidateAshbyWorkflowView | null>;
}

/** Raw shapes as selected below — narrow, so the projection cannot over-read. */
interface RawOperation {
  operation_type?: unknown;
  state?: unknown;
  error_code?: unknown;
  updated_at?: unknown;
}
export interface RawCandidateWorkflowRow {
  lifecycle?: unknown;
  terminal_state?: unknown;
  session_id?: unknown;
  updated_at?: unknown;
  ashby_resume_ingestions?: Array<{ state?: unknown }> | { state?: unknown } | null;
  ashby_operations?: RawOperation[] | null;
}

function asArray<T>(value: T[] | T | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isReportedType(value: unknown): value is CandidateWorkflowOperationType {
  return (CANDIDATE_WORKFLOW_OPERATION_TYPES as readonly string[]).includes(value as string);
}

/**
 * Pure row → view projection. Exported so the sanitization contract can be
 * tested without a database.
 *
 * Operations are reduced to at most one per reported type (latest
 * `updated_at` wins, ties resolved by input order) and emitted in a stable,
 * declaration-ordered sequence so the card never reorders between polls.
 */
export function projectCandidateWorkflow(
  row: RawCandidateWorkflowRow,
  sessionStatus: string | null,
): CandidateAshbyWorkflowView {
  const latestByType = new Map<CandidateWorkflowOperationType, { op: CandidateAshbyWorkflowOperation; at: string }>();
  for (const raw of asArray(row.ashby_operations)) {
    if (!isReportedType(raw.operation_type)) continue;
    if (typeof raw.state !== 'string') continue;
    const at = typeof raw.updated_at === 'string' ? raw.updated_at : '';
    const existing = latestByType.get(raw.operation_type);
    if (existing && existing.at >= at) continue;
    latestByType.set(raw.operation_type, {
      at,
      op: {
        type: raw.operation_type,
        state: raw.state,
        errorCode: typeof raw.error_code === 'string' ? raw.error_code : null,
      },
    });
  }

  const ingestion = asArray(row.ashby_resume_ingestions)[0];

  return {
    lifecycle: typeof row.lifecycle === 'string' ? row.lifecycle : 'imported',
    terminalState: typeof row.terminal_state === 'string' ? row.terminal_state : null,
    ingestionState: typeof ingestion?.state === 'string' ? ingestion.state : null,
    operations: CANDIDATE_WORKFLOW_OPERATION_TYPES.map((t) => latestByType.get(t)?.op).filter(
      (o): o is CandidateAshbyWorkflowOperation => o != null,
    ),
    sessionStatus,
    updatedAt: typeof row.updated_at === 'string' && row.updated_at.length > 0 ? row.updated_at : null,
  };
}

/**
 * Service-role reader for the candidate-scoped card.
 *
 * The CALLER is responsible for having already established that the requesting
 * user may see this candidate (role + interviewer ownership). This store
 * performs no authorization of its own and must never be reachable from a
 * route that has not resolved the candidate under those rules.
 *
 * Two entry points, one query:
 *   - `getForCandidate` is for a surface addressed by a CANDIDATE. When that
 *     candidate holds more than one Ashby application link, the most recently
 *     updated one is reported — a single deterministic "current workflow"
 *     rather than a list the card would have to disambiguate with external job
 *     ids it is not allowed to show.
 *   - `getForApplicationLink` is for a surface addressed by a LINK. It reports
 *     that link and no other, so the card can never describe a different
 *     application than the page around it.
 */
export function createCandidateWorkflowStore(client: SupabaseClient): CandidateAshbyWorkflowStore {
  // Only the reported legs cross the DB→API boundary: `stage_move` rows (and
  // their error codes) are filtered server-side, not discarded in JS, and both
  // embeds are explicitly bounded so a link that accumulates operations cannot
  // grow this read without limit.
  const SELECT =
    'lifecycle, terminal_state, session_id, updated_at, ' +
    'ashby_resume_ingestions ( state ), ' +
    'ashby_operations ( operation_type, state, error_code, updated_at )';
  const OPERATION_LIMIT = 20;

  /** Session status is a strictly additive diagnostic — a failure degrades to null. */
  async function readSessionStatus(sessionId: unknown): Promise<string | null> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    try {
      const { data, error } = await client
        .from('call_sessions')
        .select('status')
        .eq('id', sessionId)
        .maybeSingle();
      if (error) return null;
      const status = (data as { status?: unknown } | null)?.status;
      return typeof status === 'string' ? status : null;
    } catch {
      return null;
    }
  }

  /**
   * The one link read. `scope` applies the caller's filter; everything else —
   * the column allowlist, the operation-type filter, the bounds, the failure
   * contract — is identical for both entry points by construction.
   */
  async function readOne(
    scope: (q: ReturnType<ReturnType<SupabaseClient['from']>['select']>) => typeof q,
  ): Promise<CandidateAshbyWorkflowView | null> {
    const base = client.from('ashby_application_links').select(SELECT) as never;
    const { data, error } = await scope(base as never)
      .eq('provider', 'ashby')
      .in('ashby_operations.operation_type', CANDIDATE_WORKFLOW_OPERATION_TYPES as never)
      .order('updated_at', { ascending: false })
      .limit(1)
      .limit(OPERATION_LIMIT, { foreignTable: 'ashby_operations' })
      .limit(1, { foreignTable: 'ashby_resume_ingestions' });
    // A lookup failure is a FAILURE. It must never be reported as "this
    // candidate has no Ashby workflow".
    if (error) throw new Error('ashby_candidate_workflow_error');

    const row = ((data ?? []) as RawCandidateWorkflowRow[])[0];
    if (!row) return null;
    return projectCandidateWorkflow(row, await readSessionStatus(row.session_id));
  }

  return {
    getForCandidate: (candidateId) => readOne((q) => q.eq('candidate_id', candidateId)),
    getForApplicationLink: (applicationLinkId) => readOne((q) => q.eq('id', applicationLinkId)),
  };
}
