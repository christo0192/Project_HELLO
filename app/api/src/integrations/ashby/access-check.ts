/**
 * ashby/access-check.ts — READ-ONLY check of the Ashby permissions the M031
 * business-impact page relies on (plan section 3, checks 10 and 11).
 *
 * WHAT IT ANSWERS: for each permission — Candidates read, Jobs read,
 * Interviews read — does HELLO's key hold it? Each is reported as `ok`,
 * `missing_permission`, `error` (the call failed for another reason, with a
 * coarse code) or `not_tried` (nothing to try, or the time budget ran out).
 * It also reports, as COUNTS ONLY, which stage types appear in the history of
 * one hired and one archived application on an enabled job, so an admin can
 * see whether Hired-type and Archived-type rows exist on this tenant.
 *
 * THE CALLS, each a read from {@link ACCESS_CHECK_READ_OPERATIONS}:
 *  - `jobInterviewPlan.info` for each enabled mapping's job (Jobs read);
 *  - `interviewStage.list` for each distinct plan those reads named
 *    (Interviews read);
 *  - `application.info` and `application.listHistory` on the newest live
 *    imported application of an enabled mapping (Candidates read);
 *  - `application.list` by job and status `Hired`, then `Archived`, limit 1,
 *    and `application.listHistory` on what it finds. History rows carry a
 *    stage id but no type, so each row is matched against the job plan read
 *    above. A row whose own status is not the one asked for is NOT used: an
 *    ignored filter must not pass an active application off as hired.
 *
 * WHAT NEVER LEAVES: no application, candidate, job, plan, stage or actor id,
 * no name, email or title — only states, coarse codes, counts, and stage
 * types (identifier-shaped, e.g. `PreInterviewScreen`). The ids it reads are
 * used for the next call and dropped.
 *
 * BOUNDED: at most {@link MAX_JOBS} jobs, {@link MAX_PLANS} plans and one
 * history page per application, all under ONE deadline. A call the deadline
 * leaves no time for is not made.
 *
 * Ashby answers a missing permission in two documented ways — HTTP 403, and
 * HTTP 200 `{ success: false, errorInfo: { code: 'missing_endpoint_permission' } }`
 * (both pinned in ashby-recommendation-tag-contract.test.ts) — and both read
 * as `missing_permission` here. A 401 is a rejected key, not a missing module,
 * and reads as `error: unauthorized`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isAshbyError } from './errors.js';
import { extractStages } from './probe.js';
import {
  ASHBY_OPERATIONS,
  type AshbyApplicationStatus,
  type AshbyCallOptions,
  type AshbyOperation,
  type ApplicationHistoryParams,
  type ApplicationListParams,
  type InterviewStageListParams,
  type OpaqueRecord,
} from './types.js';

// ── Read-only allowlist ─────────────────────────────────────────────────────

/** The ONLY operations the access check may perform. Every one is `mutation: false`. */
export const ACCESS_CHECK_READ_OPERATIONS = [
  'application.info',
  'application.listHistory',
  'application.list',
  'jobInterviewPlan.info',
  'interviewStage.list',
] as const;
export type AccessCheckOperation = (typeof ACCESS_CHECK_READ_OPERATIONS)[number];

/** Fail closed unless the operation is an allowlisted READ in the registry. */
export function assertAccessCheckReadOnly(operation: string): asserts operation is AccessCheckOperation {
  if (!(ACCESS_CHECK_READ_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error('ashby_access_check_operation_not_allowed');
  }
  const spec = ASHBY_OPERATIONS[operation as AshbyOperation];
  if (!spec || spec.mutation) throw new Error('ashby_access_check_operation_not_allowed');
}

// ── Result vocabulary ───────────────────────────────────────────────────────

export const ACCESS_STATES = ['ok', 'missing_permission', 'error', 'not_tried'] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

/**
 * Coarse, closed set. `deadline` only ever accompanies `not_tried` (the time
 * budget ran out before the call); `status_unconfirmed` only a sample (the
 * application Ashby returned did not carry the status that was asked for).
 */
export const ACCESS_ERROR_CODES = [
  'unauthorized',
  'not_found',
  'client_error',
  'rate_limited',
  'server_error',
  'timeout',
  'network',
  'malformed_response',
  'output_limit',
  'logical_failure',
  'invalid_request',
  'status_unconfirmed',
  'deadline',
  'unknown',
] as const;
export type AccessErrorCode = (typeof ACCESS_ERROR_CODES)[number];

export interface AccessOutcome {
  state: AccessState;
  /** Null for `ok` and `missing_permission`; see {@link ACCESS_ERROR_CODES}. */
  error: AccessErrorCode | null;
}

/** One operation across all its calls. `calls` = ok + missingPermission + failed. */
export interface AccessOperationResult extends AccessOutcome {
  calls: number;
  ok: number;
  missingPermission: number;
  failed: number;
}

export interface StageTypeCount {
  /** Null when the plan stage carried no usable type. */
  type: string | null;
  count: number;
}

/** One application's stage history, as counts only. */
export interface AccessCheckHistory {
  /** History rows read (one page). */
  rows: number;
  /** Rows whose stage id is on the job's plan. Null when no plan was read to match against. */
  matched: number | null;
  /** Rows whose stage is not on the job's current plan. Null as for `matched`. */
  unmatched: number | null;
  /** True when Ashby said there were more rows than the one page read. */
  truncated: boolean;
  /** Matched rows by stage type, in plan order of each type's first stage. */
  stageTypes: StageTypeCount[];
}

export interface AccessCheckSample extends AccessOutcome {
  /** Whether such an application was found; null when the look-up could not answer. */
  found: boolean | null;
  /** Null unless the application was found and its history read. */
  history: AccessCheckHistory | null;
}

export interface AccessCheckResult {
  permissions: {
    candidatesRead: AccessOutcome;
    jobsRead: AccessOutcome;
    interviewsRead: AccessOutcome;
  };
  operations: {
    applicationInfo: AccessOperationResult;
    applicationListHistory: AccessOperationResult;
    applicationList: AccessOperationResult;
    jobInterviewPlanInfo: AccessOperationResult;
    interviewStageList: AccessOperationResult;
  };
  mappings: {
    /** Enabled, live mappings read (bounded by the source). */
    enabled: number;
    /** Distinct jobs whose plans the check set out to read (at most {@link MAX_JOBS}). */
    jobsChecked: number;
    /** True when there were more mappings or jobs than were checked. */
    truncated: boolean;
  };
  samples: {
    imported: AccessCheckSample;
    hired: AccessCheckSample;
    archived: AccessCheckSample;
  };
  /** True when the overall deadline cut the check short. */
  deadlineHit: boolean;
}

// ── Seams ───────────────────────────────────────────────────────────────────

/** The reads the check makes. Satisfied by AshbyClient; injected for tests. */
export interface AccessCheckReader {
  applicationInfo<T = OpaqueRecord>(applicationId: string, extra?: OpaqueRecord, options?: AshbyCallOptions): Promise<{ results: T }>;
  applicationListHistory<T = OpaqueRecord[]>(params: ApplicationHistoryParams): Promise<{ results: T; moreDataAvailable: boolean }>;
  applicationList<T = OpaqueRecord[]>(params?: ApplicationListParams): Promise<{ results: T; moreDataAvailable: boolean }>;
  jobInterviewPlanInfo<T = OpaqueRecord>(jobId: string, extra?: OpaqueRecord, options?: AshbyCallOptions): Promise<{ results: T }>;
  interviewStageList<T = OpaqueRecord[]>(params: InterviewStageListParams): Promise<{ results: T }>;
}

/** What the check needs from HELLO's own tables. Opaque ids only, never returned. */
export interface AccessCheckTargets {
  enabledMappings: number;
  /** Distinct Ashby job ids of enabled mappings, newest mapping first. */
  jobIds: string[];
  /** True when the source read fewer mappings than exist. */
  truncated: boolean;
  /** The newest live imported application of an enabled mapping, if any. */
  imported: { applicationId: string; jobId: string } | null;
}

export interface AccessCheckSource {
  readTargets(): Promise<AccessCheckTargets>;
}

// ── Bounds ──────────────────────────────────────────────────────────────────

export const MAX_JOBS = 5;
const MAX_PLANS = 5;
const HISTORY_PAGE = 100;
const MAX_STAGE_TYPES = 20;
/** Budget for the WHOLE check, every call and retry included. */
export const ACCESS_CHECK_DEADLINE_MS = 25_000;
/** Enabled mappings the source reads; more is reported as `truncated`. */
const MAPPING_READ_CAP = 50;

const ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function opaqueId(raw: unknown): string | null {
  return typeof raw === 'string' && ID_RE.test(raw) ? raw : null;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

// ── Error classification ────────────────────────────────────────────────────

export type ClassifiedAccessError =
  | { state: 'missing_permission'; error: null }
  | { state: 'error'; error: AccessErrorCode };

/** Map a failed call to a permission verdict or one coarse code. Never a provider message. */
export function classifyAccessError(err: unknown): ClassifiedAccessError {
  if (!isAshbyError(err)) return { state: 'error', error: 'unknown' };
  if (err.httpStatus === 403) return { state: 'missing_permission', error: null };
  if (err.endpointCodes.some((c) => c.toLowerCase() === 'missing_endpoint_permission')) {
    return { state: 'missing_permission', error: null };
  }
  if (err.httpStatus === 401) return { state: 'error', error: 'unauthorized' };
  const byCategory = (category: string): AccessErrorCode => {
    switch (category) {
      case 'http_client_error': return err.httpStatus === 404 ? 'not_found' : 'client_error';
      case 'rate_limited': return 'rate_limited';
      case 'http_server_error': return 'server_error';
      case 'timeout': return 'timeout';
      case 'network': return 'network';
      case 'malformed_response': return 'malformed_response';
      case 'output_limit': return 'output_limit';
      case 'logical_failure': return 'logical_failure';
      case 'invalid_request': return 'invalid_request';
      default: return 'unknown';
    }
  };
  // An exhausted retry carries the last transient class as its code.
  const code = err.category === 'retry_exhausted' ? byCategory(err.code) : byCategory(err.category);
  return { state: 'error', error: code };
}

// ── The check ───────────────────────────────────────────────────────────────

type OpKey = keyof AccessCheckResult['operations'];

const OP_NAMES: Readonly<Record<OpKey, AccessCheckOperation>> = {
  applicationInfo: 'application.info',
  applicationListHistory: 'application.listHistory',
  applicationList: 'application.list',
  jobInterviewPlanInfo: 'jobInterviewPlan.info',
  interviewStageList: 'interviewStage.list',
};

interface Tally {
  ok: number;
  missingPermission: number;
  failed: number;
  firstError: AccessErrorCode | null;
  skippedForDeadline: boolean;
}

type CallOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing_permission' }
  | { kind: 'error'; error: AccessErrorCode }
  | { kind: 'skipped' };

/** One job's plan, kept only for matching history rows. */
interface PlanView {
  planId: string | null;
  typeById: Map<string, string | null>;
  /** Distinct types in plan order of their first stage. */
  typeOrder: Array<string | null>;
}

function readPlanId(results: unknown): string | null {
  const root = asRecord(results);
  if (!root) return null;
  const direct = opaqueId(root.interviewPlanId);
  if (direct) return direct;
  const nested = asRecord(root.jobInterviewPlan) ?? asRecord(root.interviewPlan);
  if (nested) {
    const id = opaqueId(nested.interviewPlanId) ?? opaqueId(nested.id);
    if (id) return id;
  }
  // Every documented stage also names its plan.
  for (const list of [root.stages, root.interviewStages]) {
    if (!Array.isArray(list)) continue;
    for (const stage of list) {
      const id = opaqueId(asRecord(stage)?.interviewPlanId);
      if (id) return id;
    }
  }
  return null;
}

function readPlan(results: unknown): PlanView {
  const stages = extractStages(results);
  const typeById = new Map<string, string | null>();
  const typeOrder: Array<string | null> = [];
  for (const stage of stages) {
    typeById.set(stage.id, stage.type);
    if (!typeOrder.includes(stage.type)) typeOrder.push(stage.type);
  }
  return { planId: readPlanId(results), typeById, typeOrder };
}

function summarizeHistory(results: unknown, moreDataAvailable: boolean, plan: PlanView | null): AccessCheckHistory {
  const all = Array.isArray(results) ? results : [];
  const page = all.slice(0, HISTORY_PAGE);
  let rows = 0;
  let matched = 0;
  let unmatched = 0;
  const counts = new Map<string | null, number>();
  for (const raw of page) {
    const rec = asRecord(raw);
    if (!rec) continue;
    rows += 1;
    if (!plan) continue;
    const stageId = opaqueId(rec.stageId) ?? opaqueId(rec.interviewStageId);
    if (stageId !== null && plan.typeById.has(stageId)) {
      matched += 1;
      const type = plan.typeById.get(stageId) ?? null;
      counts.set(type, (counts.get(type) ?? 0) + 1);
    } else {
      unmatched += 1;
    }
  }
  const stageTypes: StageTypeCount[] = [];
  for (const type of plan?.typeOrder ?? []) {
    const count = counts.get(type);
    if (count && stageTypes.length < MAX_STAGE_TYPES) stageTypes.push({ type, count });
  }
  return {
    rows,
    matched: plan ? matched : null,
    unmatched: plan ? unmatched : null,
    truncated: moreDataAvailable === true || all.length > HISTORY_PAGE,
    stageTypes,
  };
}

/** missing_permission outranks ok (an endpoint the page needs is refused), ok outranks error. */
function rollUp(parts: Array<{ tally: Tally }>): AccessOutcome {
  if (parts.some((p) => p.tally.missingPermission > 0)) return { state: 'missing_permission', error: null };
  if (parts.some((p) => p.tally.ok > 0)) return { state: 'ok', error: null };
  const failed = parts.find((p) => p.tally.failed > 0);
  if (failed) return { state: 'error', error: failed.tally.firstError ?? 'unknown' };
  return { state: 'not_tried', error: parts.some((p) => p.tally.skippedForDeadline) ? 'deadline' : null };
}

export interface RunAccessCheckOptions {
  /** Wall clock (epoch ms). A real Ashby client compares deadlines against Date.now(). */
  now?: () => number;
  /** May only tighten the built-in {@link ACCESS_CHECK_DEADLINE_MS}. */
  deadlineAt?: number;
}

/**
 * Run the check. Never throws for a provider failure: every call's outcome is
 * captured as a state. Writes nothing, anywhere.
 */
export async function runAccessCheck(
  reader: AccessCheckReader,
  targets: AccessCheckTargets,
  options: RunAccessCheckOptions = {},
): Promise<AccessCheckResult> {
  const now = options.now ?? Date.now;
  const ownDeadline = now() + ACCESS_CHECK_DEADLINE_MS;
  const deadlineAt = typeof options.deadlineAt === 'number' && Number.isFinite(options.deadlineAt)
    ? Math.min(options.deadlineAt, ownDeadline)
    : ownDeadline;
  let deadlineHit = false;

  const tallies = Object.fromEntries(
    (Object.keys(OP_NAMES) as OpKey[]).map((k) => [k, { ok: 0, missingPermission: 0, failed: 0, firstError: null, skippedForDeadline: false }]),
  ) as Record<OpKey, Tally>;

  async function call<T>(op: OpKey, run: () => Promise<T>): Promise<CallOutcome<T>> {
    assertAccessCheckReadOnly(OP_NAMES[op]);
    const tally = tallies[op];
    if (now() >= deadlineAt) {
      deadlineHit = true;
      tally.skippedForDeadline = true;
      return { kind: 'skipped' };
    }
    try {
      const value = await run();
      tally.ok += 1;
      return { kind: 'ok', value };
    } catch (err) {
      const verdict = classifyAccessError(err);
      if (verdict.state === 'missing_permission') {
        tally.missingPermission += 1;
        return { kind: 'missing_permission' };
      }
      tally.failed += 1;
      tally.firstError ??= verdict.error;
      if (now() >= deadlineAt) deadlineHit = true;
      return { kind: 'error', error: verdict.error };
    }
  }

  const sampleFrom = <T>(outcome: Exclude<CallOutcome<T>, { kind: 'ok' }>, found: boolean | null): AccessCheckSample => {
    if (outcome.kind === 'missing_permission') return { state: 'missing_permission', error: null, found, history: null };
    if (outcome.kind === 'error') return { state: 'error', error: outcome.error, found, history: null };
    return { state: 'not_tried', error: 'deadline', found, history: null };
  };

  async function readHistory(applicationId: string, plan: PlanView | null): Promise<AccessCheckSample> {
    const outcome = await call('applicationListHistory', () =>
      reader.applicationListHistory({ applicationId, limit: HISTORY_PAGE, deadlineAt }));
    if (outcome.kind !== 'ok') return sampleFrom(outcome, true);
    return {
      state: 'ok',
      error: null,
      found: true,
      history: summarizeHistory(outcome.value.results, outcome.value.moreDataAvailable, plan),
    };
  }

  // 1. Jobs read: each enabled job's interview plan.
  const distinctJobs = [...new Set(targets.jobIds.map(opaqueId).filter((id): id is string => id !== null))];
  const jobs = distinctJobs.slice(0, MAX_JOBS);
  const plans = new Map<string, PlanView>();
  for (const jobId of jobs) {
    const outcome = await call('jobInterviewPlanInfo', () => reader.jobInterviewPlanInfo(jobId, undefined, { deadlineAt }));
    if (outcome.kind === 'ok') plans.set(jobId, readPlan(outcome.value.results));
  }

  // 2. Interviews read: the stage list of each distinct plan those reads named.
  const planIds = [...new Set([...plans.values()].map((p) => p.planId).filter((id): id is string => id !== null))]
    .slice(0, MAX_PLANS);
  for (const interviewPlanId of planIds) {
    await call('interviewStageList', () => reader.interviewStageList({ interviewPlanId, deadlineAt }));
  }

  // 3. Candidates read: the newest imported application, and its history.
  let imported: AccessCheckSample = { state: 'not_tried', error: null, found: false, history: null };
  const importedId = opaqueId(targets.imported?.applicationId);
  if (targets.imported && importedId) {
    await call('applicationInfo', () => reader.applicationInfo(importedId, undefined, { deadlineAt }));
    imported = await readHistory(importedId, plans.get(targets.imported.jobId) ?? null);
  }

  // 4. One hired and one archived application on an enabled job, if any.
  async function findByStatus(status: AshbyApplicationStatus): Promise<AccessCheckSample> {
    if (jobs.length === 0) return { state: 'not_tried', error: null, found: null, history: null };
    for (const jobId of jobs) {
      const outcome = await call('applicationList', () => reader.applicationList({ jobId, status, limit: 1, deadlineAt }));
      if (outcome.kind !== 'ok') return sampleFrom(outcome, null);
      const rows = Array.isArray(outcome.value.results) ? outcome.value.results : [];
      if (rows.length === 0) continue;
      const first = asRecord(rows[0]);
      // An ignored filter would list any application; never pass one off as `status`.
      if (!first || first.status !== status) return { state: 'error', error: 'status_unconfirmed', found: null, history: null };
      const applicationId = opaqueId(first.id);
      if (!applicationId) return { state: 'error', error: 'malformed_response', found: null, history: null };
      return readHistory(applicationId, plans.get(jobId) ?? null);
    }
    return { state: 'ok', error: null, found: false, history: null };
  }
  const hired = await findByStatus('Hired');
  const archived = await findByStatus('Archived');

  const op = (k: OpKey): AccessOperationResult => {
    const t = tallies[k];
    return { ...rollUp([{ tally: t }]), calls: t.ok + t.missingPermission + t.failed, ok: t.ok, missingPermission: t.missingPermission, failed: t.failed };
  };

  return {
    permissions: {
      candidatesRead: rollUp([
        { tally: tallies.applicationInfo },
        { tally: tallies.applicationListHistory },
        { tally: tallies.applicationList },
      ]),
      jobsRead: rollUp([{ tally: tallies.jobInterviewPlanInfo }]),
      interviewsRead: rollUp([{ tally: tallies.interviewStageList }]),
    },
    operations: {
      applicationInfo: op('applicationInfo'),
      applicationListHistory: op('applicationListHistory'),
      applicationList: op('applicationList'),
      jobInterviewPlanInfo: op('jobInterviewPlanInfo'),
      interviewStageList: op('interviewStageList'),
    },
    mappings: {
      enabled: Math.max(0, Math.trunc(targets.enabledMappings) || 0),
      jobsChecked: jobs.length,
      truncated: targets.truncated === true || distinctJobs.length > MAX_JOBS,
    },
    samples: { imported, hired, archived },
    deadlineHit,
  };
}

// ── HELLO's side: which jobs and which application to try ───────────────────

/**
 * Reads ONLY: enabled, live mappings (id and job id), then the newest live
 * imported application among them. A link whose application was cancelled,
 * withdrawn or deleted is skipped, because a deleted application cannot be
 * read and would report a 404 that says nothing about permissions.
 */
export function createAshbyAccessCheckSource(client: SupabaseClient): AccessCheckSource {
  return {
    async readTargets(): Promise<AccessCheckTargets> {
      const { data, error } = await client
        .from('ashby_job_mappings')
        .select('id, external_job_id')
        .eq('provider', 'ashby')
        .eq('status', 'enabled')
        .is('archived_at', null)
        .order('updated_at', { ascending: false })
        // One row past the cap says there were more.
        .limit(MAPPING_READ_CAP + 1);
      if (error) throw new Error('ashby_access_check_mappings_error');
      const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      const truncated = rows.length > MAPPING_READ_CAP;
      const jobByMapping = new Map<string, string>();
      for (const r of rows.slice(0, MAPPING_READ_CAP)) {
        const id = typeof r.id === 'string' && UUID_RE.test(r.id) ? r.id : null;
        const jobId = opaqueId(r.external_job_id);
        if (id && jobId) jobByMapping.set(id, jobId);
      }
      const jobIds = [...new Set(jobByMapping.values())];
      if (jobByMapping.size === 0) {
        return { enabledMappings: Math.min(rows.length, MAPPING_READ_CAP), jobIds, truncated, imported: null };
      }

      const links = await client
        .from('ashby_application_links')
        .select('external_application_id, job_mapping_id')
        .eq('provider', 'ashby')
        .in('job_mapping_id', [...jobByMapping.keys()])
        .is('terminal_state', null)
        .order('created_at', { ascending: false })
        .limit(1);
      if (links.error) throw new Error('ashby_access_check_links_error');
      const link = Array.isArray(links.data) ? asRecord(links.data[0]) : null;
      const applicationId = opaqueId(link?.external_application_id);
      const jobId = typeof link?.job_mapping_id === 'string' ? jobByMapping.get(link.job_mapping_id) : undefined;
      return {
        enabledMappings: Math.min(rows.length, MAPPING_READ_CAP),
        jobIds,
        truncated,
        imported: applicationId && jobId ? { applicationId, jobId } : null,
      };
    },
  };
}
