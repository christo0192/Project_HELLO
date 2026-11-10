/**
 * The Business impact client (M031 S6): `GET /api/impact/summary` and
 * `GET /api/impact/candidates`, typed exactly as
 * `.gsd/milestones/M031/API-CONTRACT.md` fixes them. The API (S5) is built
 * against the same contract elsewhere, so the shapes below are the contract's,
 * field for field, and nothing the page reads is declared anywhere else.
 *
 * Invariants:
 *   - Both reads go through `apiClient`, which attaches the signed-in bearer.
 *     The API checks the role on every call (interviewer and up).
 *   - A response that is not in the contract shape is refused here as
 *     `impact_malformed_response`, so the page never draws half a payload.
 *   - The candidate list sends no personal field in its query: only a step, a
 *     verdict and an outcome, a stage id, the date window and a job.
 */

import { ApiError, apiClient } from './api-client';
import type { ImpactCandidatesPage, ImpactCandidatesParams, ImpactSummary, ImpactSummaryParams } from './impact-types';

export * from './impact-types';

export const IMPACT_ROUTES = Object.freeze({
  summary: '/api/impact/summary',
  candidates: '/api/impact/candidates',
});

/** The contract's largest page. */
export const IMPACT_MAX_PAGE_SIZE = 100;

function appendWindow(query: URLSearchParams, params: ImpactSummaryParams): void {
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.job) query.set('job', params.job);
}

function withQuery(path: string, query: URLSearchParams): string {
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

export function impactSummaryPath(params: ImpactSummaryParams): string {
  const query = new URLSearchParams();
  appendWindow(query, params);
  return withQuery(IMPACT_ROUTES.summary, query);
}

export function impactCandidatesPath(params: ImpactCandidatesParams): string {
  const query = new URLSearchParams();
  const { target } = params;
  if (target.kind === 'step') {
    query.set('step', target.step);
    // `reachedOnly` is the contract's default, so only a drop is said.
    if (target.dropped) query.set('dropped', 'true');
  } else if (target.kind === 'verdict') {
    query.set('verdict', target.verdict);
    query.set('outcome', target.outcome);
  } else {
    query.set('leaveStageId', target.stageId);
  }
  appendWindow(query, params);
  if (params.page !== undefined) query.set('page', String(Math.max(1, Math.floor(params.page))));
  if (params.pageSize !== undefined) {
    query.set('pageSize', String(Math.min(IMPACT_MAX_PAGE_SIZE, Math.max(1, Math.floor(params.pageSize)))));
  }
  return withQuery(IMPACT_ROUTES.candidates, query);
}

const MALFORMED = 'impact_malformed_response';

function malformed(): never {
  throw new ApiError(MALFORMED, 200, MALFORMED);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The summary, or `impact_malformed_response`. Checks the frame the page is
 * drawn from (every block present, in its type), not every figure: a figure
 * the page cannot read prints a dash, never a 0.
 */
export function readImpactSummary(body: unknown): ImpactSummary {
  if (!isRecord(body) || body.ok !== true) malformed();
  const { meta, filters, verdictOutcomes } = body;
  if (!isRecord(meta) || typeof meta.progressEnabled !== 'boolean') malformed();
  if (!isRecord(meta.coverage) || !isNumber(meta.coverage.checked) || !isNumber(meta.coverage.total)) malformed();
  if (!isRecord(filters) || !Array.isArray(filters.jobs)) malformed();
  if (!isRecord(verdictOutcomes) || !Array.isArray(verdictOutcomes.columns) || !Array.isArray(verdictOutcomes.rows)) {
    malformed();
  }
  for (const list of ['pipeline', 'leaves', 'timings', 'cohorts', 'byJob'] as const) {
    if (!Array.isArray(body[list])) malformed();
  }
  return body as unknown as ImpactSummary;
}

const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/**
 * A page of the list, or `impact_malformed_response`. A row with no candidate
 * record (`candidateId` and `name` null) is an application that never became a
 * candidate: it is kept, so the list still matches the count it sits behind.
 *
 * `hidden` (D-M031-5) is required, and a whole number from 0: without it the
 * page could not tell "nobody is here" from "they are someone else's", so a
 * response that leaves it out or garbles it is refused rather than drawn.
 */
export function readImpactCandidates(body: unknown): ImpactCandidatesPage {
  if (!isRecord(body) || body.ok !== true) malformed();
  if (!isNumber(body.total) || !isNumber(body.page) || !isNumber(body.pageSize) || !Array.isArray(body.rows)) {
    malformed();
  }
  if (!isCount(body.hidden)) malformed();
  for (const row of body.rows as unknown[]) {
    if (!isRecord(row) || !isTextOrNull(row.candidateId) || !isTextOrNull(row.name)) malformed();
  }
  return body as unknown as ImpactCandidatesPage;
}

export async function fetchImpactSummary(params: ImpactSummaryParams, signal?: AbortSignal): Promise<ImpactSummary> {
  return readImpactSummary(await apiClient.request<unknown>(impactSummaryPath(params), { signal }));
}

export async function fetchImpactCandidates(
  params: ImpactCandidatesParams,
  signal?: AbortSignal,
): Promise<ImpactCandidatesPage> {
  return readImpactCandidates(await apiClient.request<unknown>(impactCandidatesPath(params), { signal }));
}
