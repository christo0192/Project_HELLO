/**
 * ashby/progress-worker.ts: where each imported Ashby application went after
 * Christy (M031 S3, plan section 5 "Worker").
 *
 * WHAT A PASS DOES. The `ashby-progress` loop (runtime-workers.ts), behind
 * ASHBY_PROGRESS_ENABLED (off by default), runs {@link runProgressPass}:
 *
 *  1. Skips the pass while the resume scanner is deferring ingestion jobs
 *     (`job_queue` rows `delayed` with a `scanner…` reason, the health
 *     surface's `scannerDeferredJobs`). That is how a starved API machine
 *     shows itself (clamscan times out when Fly throttles the CPU), and this
 *     worker can wait. Only `scanner_timeout` and `scanner_busy` count: a
 *     stale or missing signature database and a readiness hold are not CPU.
 *     The pause is capped: after {@link MAX_SCANNER_SKIPS} skipped passes in
 *     a row on one machine, a pass of one application runs, and the skipped
 *     passes are counted on its run row.
 *  2. `claim_ashby_progress_due` (0139) seeds a progress row for every link
 *     with none, then claims a small batch of due rows, FOR UPDATE SKIP
 *     LOCKED in next_check_at order, under a lease longer than the pass.
 *  3. Per application, at most about 2 Ashby calls a second, each with its
 *     own budget inside the pass's deadline ({@link callBudgetMs}):
 *     - `application.info`: status, current stage (type, plan order, plan,
 *       group), current job, archive reason (id, Ashby's catalogue text,
 *       reasonType, isArchived), archivedAt, updatedAt;
 *     - `application.listHistory`, every page, when anything changed, the
 *       history was never read, it was last read more than `historyMaxAge`
 *       ago, or an open backfill began after it was read: each row's id,
 *       stageId, title, entry and exit times, stageNumber, and whether
 *       `actorId` was set. The actor id itself is never kept. A missing
 *       `leftStageAt` (the live API drops it on the current row) is "has not
 *       left";
 *     - `interviewStage.info` (Interviews read) for a stage known only from
 *       history, to give it a type and plan position, a few per pass, each
 *       with a short budget; none after one that did not answer.
 *  4. `record_ashby_application_progress` writes it all in one transaction,
 *     only while the lease still holds: progress, intervals upserted on
 *     Ashby's history id (a row a fresh read no longer returns is marked
 *     `gone_at`, never deleted), the reason catalogue, stages seen only in
 *     history. The next check follows {@link nextCheckDelayMs}.
 *  5. `record_ashby_progress_run`: one run row, counts and codes only. Next
 *     to the failures it counts the rows handed back unread (`deferred`)
 *     and the passes skipped for the scanner just before it (`scanner_paused`).
 *
 * FAILURES never stop the pass. A missing permission (HTTP 403 or 200 with
 * `success: false`, named `missing_endpoint_permission`, as the S1 access
 * check classifies it) is stored as `check_error_code` and retried daily. A
 * 404 on application.info marks the row gone: it is not read again until a
 * backfill. A call that does not answer inside its own budget is that
 * application's `timeout`, backed off like any failure, so one application
 * can never use a whole pass, pass after pass. A 429 is the client's own
 * Retry-After handling; past the call's budget it is not slept, and the rest
 * of the batch is handed back for a later pass. Only a row the PASS's
 * deadline cut short, begun with no more than one call budget left, is
 * handed back unread, its claim refunded.
 *
 * READ-ONLY toward Ashby by construction ({@link PROGRESS_READ_OPERATIONS},
 * {@link assertProgressReadOnly}). HELLO-side it writes only the five 0138
 * tables, through the 0139 functions: never a link, a candidate or an
 * assessment.
 *
 * PRIVACY: opaque ids, stage titles, Ashby's own reason catalogue, closed
 * codes, booleans and timestamps. No name, email, phone, resume, custom
 * field, hiring team, offer, Ashby staff id or free text about a candidate
 * is read off a payload: each field is copied by name and validated.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkIds } from '../../lib/id-batches.js';
import { classifyAccessError } from './access-check.js';
import type { AshbyProgressConfig } from './config.js';
import { isAshbyError } from './errors.js';
import { extractStages, sanitizeTitle } from './probe.js';
import { createStageCatalogStore, defaultMilestone, type StageMilestone } from './stage-catalog.js';
import {
  ASHBY_APPLICATION_STATUSES,
  ASHBY_OPERATIONS,
  type AshbyApplicationStatus,
  type AshbyCallOptions,
  type AshbyOperation,
  type ApplicationHistoryParams,
  type OpaqueRecord,
} from './types.js';

// ── Read-only allowlist ─────────────────────────────────────────────────────

/** The ONLY Ashby operations the worker may perform. Every one is `mutation: false`. */
export const PROGRESS_READ_OPERATIONS = ['application.info', 'application.listHistory', 'interviewStage.info'] as const;
export type ProgressOperation = (typeof PROGRESS_READ_OPERATIONS)[number];

/** Fail closed unless the operation is an allowlisted READ in the registry. */
export function assertProgressReadOnly(operation: string): asserts operation is ProgressOperation {
  if (!(PROGRESS_READ_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error('ashby_progress_operation_not_allowed');
  }
  const spec = ASHBY_OPERATIONS[operation as AshbyOperation];
  if (!spec || spec.mutation) throw new Error('ashby_progress_operation_not_allowed');
}

// ── Bounds ──────────────────────────────────────────────────────────────────

/** History rows per page asked for. */
export const HISTORY_PAGE_LIMIT = 100;
/** Pages read per application; past it the read fails (a partial history would mark rows gone). */
export const MAX_HISTORY_PAGES = 10;
/** `interviewStage.info` calls per pass, for stages known only from history. */
export const MAX_STAGE_LOOKUPS_PER_PASS = 5;
/** Links one claim may seed. */
export const SEED_PER_PASS = 500;
/** A row is not started with less than this left of the pass. */
export const MIN_ROW_BUDGET_MS = 3_000;
/** After a rate limit, the rest of the batch waits this long. */
export const RATE_LIMIT_HOLD_MS = 5 * 60_000;
/** Ashby calls one application usually costs: application.info and one history page. */
export const CALLS_PER_APPLICATION = 2;
/**
 * One Ashby call's own budget, its retries and any Retry-After wait included
 * (the client tries for 15 s at a time). A call that has not answered by then
 * fails as the application's `timeout`. Never more than half the pass: see
 * {@link callBudgetMs}.
 */
export const CALL_BUDGET_MS = 20_000;
/** An `interviewStage.info` lookup's budget: the stage's type is optional detail. */
export const STAGE_LOOKUP_BUDGET_MS = 5_000;
/** The resume ingestion queue (runtime-workers.ts ASHBY_INGESTION_QUEUE; a test pins the two). */
export const SCANNER_QUEUE = 'ashby.ingestion';
/**
 * The scanner deferrals that mean the API machine is short of CPU: the scan
 * timed out, or the scanner gate was full (lib/malware-scanner.ts). A stale or
 * missing signature database and a readiness hold are not CPU and never pause
 * the worker.
 */
export const SCANNER_PRESSURE_REASONS = ['scanner_timeout', 'scanner_busy'] as const;
/** Passes one machine skips in a row for the scanner before a pass of one application runs anyway. */
export const MAX_SCANNER_SKIPS = 5;
/** Counted on a run row next to its failures (errors_by_code), never a failure: rows handed back unread. */
export const RUN_DEFERRED_KEY = 'deferred';
/** Counted on a run row next to its failures: passes this machine skipped for the scanner just before it. */
export const RUN_SCANNER_PAUSED_KEY = 'scanner_paused';
/** A row due for longer than this and still unread is stale (the worker is off or far behind). */
export const PROGRESS_STALE_AFTER_SECONDS = 86_400;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** "Moved recently": Active and moved within this window is checked every few hours. */
export const RECENT_WINDOW_MS = 14 * DAY_MS;
/** "Long finished": Hired or Archived longer ago than this is checked monthly. */
export const TERMINAL_WINDOW_MS = 90 * DAY_MS;
const ERROR_BACKOFF_BASE_MS = 15 * 60_000;
const ERROR_BACKOFF_MAX_MS = DAY_MS;
const PG_INTEGER_MAX = 2_147_483_647;

const ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
const SHAPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CODE_RE = /^[a-z0-9_.:-]{1,64}$/;

function opaqueId(raw: unknown): string | null {
  return typeof raw === 'string' && ID_RE.test(raw) ? raw : null;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** A provider timestamp as canonical ISO, or null. */
function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function msOf(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// ── Reading application.info ────────────────────────────────────────────────

export interface ProgressStageView {
  id: string;
  title: string | null;
  type: string | null;
  orderInPlan: number | null;
  groupId: string | null;
  planId: string | null;
}

export interface ProgressReasonView {
  id: string;
  /** Ashby's own reason-catalogue text ("Not a fit"), sanitized; never text typed about a candidate. */
  text: string | null;
  reasonType: string | null;
  isArchived: boolean | null;
}

/** What the worker copies off `application.info`, by name, each field validated. */
export interface ProgressApplicationView {
  status: AshbyApplicationStatus | null;
  currentStage: ProgressStageView | null;
  currentJobId: string | null;
  archiveReason: ProgressReasonView | null;
  archivedAt: string | null;
  updatedAt: string | null;
}

function stageView(raw: unknown): ProgressStageView | null {
  const rec = asRecord(raw);
  const id = opaqueId(rec?.id);
  if (!rec || !id) return null;
  const order = rec.orderInInterviewPlan;
  return {
    id,
    title: sanitizeTitle(rec.title),
    type: typeof rec.type === 'string' && SHAPE_RE.test(rec.type) ? rec.type : null,
    orderInPlan: typeof order === 'number' && Number.isSafeInteger(order) && order >= 0 && order <= PG_INTEGER_MAX ? order : null,
    groupId: opaqueId(rec.interviewStageGroupId),
    planId: opaqueId(rec.interviewPlanId),
  };
}

/**
 * The fields the page needs off an `application.info` result, or null when
 * the payload carries neither a status nor a current stage (malformed). The
 * application may be nested under `application`. Nothing else is read: no
 * candidate, contact, custom field, hiring team or offer.
 */
export function readApplicationInfo(results: unknown): ProgressApplicationView | null {
  const root = asRecord(results);
  if (!root) return null;
  const app = asRecord(root.application) ?? root;
  const rawStatus = app.status;
  const status = typeof rawStatus === 'string' && (ASHBY_APPLICATION_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as AshbyApplicationStatus)
    : null;
  const currentStage = stageView(app.currentInterviewStage);
  if (status === null && currentStage === null && typeof rawStatus !== 'string') return null;
  const job = asRecord(app.job);
  const reasonRec = asRecord(app.archiveReason);
  const reasonId = opaqueId(reasonRec?.id);
  return {
    status,
    currentStage,
    currentJobId: opaqueId(job?.id) ?? opaqueId(app.jobId),
    archiveReason: reasonRec && reasonId
      ? {
          id: reasonId,
          text: sanitizeTitle(reasonRec.text),
          reasonType: typeof reasonRec.reasonType === 'string' && SHAPE_RE.test(reasonRec.reasonType) ? reasonRec.reasonType : null,
          isArchived: typeof reasonRec.isArchived === 'boolean' ? reasonRec.isArchived : null,
        }
      : null,
    archivedAt: isoOrNull(app.archivedAt),
    updatedAt: isoOrNull(app.updatedAt),
  };
}

// ── Reading application.listHistory ────────────────────────────────────────

/** One stage-history row, as kept. `movedByPerson` replaces the actor id. */
export interface ProgressHistoryRow {
  historyId: string;
  stageId: string;
  title: string | null;
  enteredAt: string;
  /** Null while the application is still in the stage. */
  leftAt: string | null;
  stageNumber: number | null;
  /** true: Ashby named an actor; false: it said none (null); null: the key was absent. */
  movedByPerson: boolean | null;
}

/**
 * One history row, or null when it is malformed: no usable id, stage id or
 * entry time, or an exit time that is not a time. An ABSENT `leftStageAt`
 * means "has not left": the live API drops the null key on the current-stage
 * row (inferred in activation-admission.ts, 2026-09-29). Only whether
 * `actorId` was set is read, never its value.
 */
export function readHistoryRow(raw: unknown): ProgressHistoryRow | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const historyId = opaqueId(rec.id);
  const stageId = opaqueId(rec.stageId) ?? opaqueId(rec.interviewStageId);
  const enteredAt = isoOrNull(rec.enteredStageAt);
  if (!historyId || !stageId || !enteredAt) return null;
  const hasLeft = Object.prototype.hasOwnProperty.call(rec, 'leftStageAt') && rec.leftStageAt !== null;
  const leftAt = hasLeft ? isoOrNull(rec.leftStageAt) : null;
  if (hasLeft && leftAt === null) return null;
  const n = rec.stageNumber;
  let movedByPerson: boolean | null = null;
  if (Object.prototype.hasOwnProperty.call(rec, 'actorId')) {
    if (rec.actorId === null) movedByPerson = false;
    else if (typeof rec.actorId === 'string' && rec.actorId.length > 0) movedByPerson = true;
  }
  return {
    historyId,
    stageId,
    title: sanitizeTitle(rec.title),
    enteredAt,
    leftAt,
    stageNumber: typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= PG_INTEGER_MAX ? n : null,
    movedByPerson,
  };
}

// ── Cadence ─────────────────────────────────────────────────────────────────

export interface CadenceInput {
  status: AshbyApplicationStatus | null;
  currentStageEnteredAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
}

/**
 * How long until an application is read again (plan section 5):
 *  - Active (or Lead, or no status) and moved or updated in the last 14 days:
 *    `activeRecent` hours (6);
 *  - any other Active: `active` hours (24);
 *  - Hired or Archived within 90 days of finishing: `terminal` hours (168);
 *    longer ago: `terminalOld` hours (720). Finishing is the archive time, or
 *    for a hire the entry to its current (Hired) stage. Unknown counts as recent.
 * The history itself is re-read on a check whenever anything changed or it is
 * older than `historyMaxAge` (see {@link needsHistoryRead}).
 */
export function nextCheckDelayMs(input: CadenceInput, nowMs: number, cadence: AshbyProgressConfig['cadenceHours']): number {
  if (input.status === 'Hired' || input.status === 'Archived') {
    const finishedAt = input.status === 'Archived'
      ? msOf(input.archivedAt) ?? msOf(input.currentStageEnteredAt) ?? msOf(input.updatedAt)
      : msOf(input.currentStageEnteredAt) ?? msOf(input.updatedAt);
    const old = finishedAt !== null && nowMs - finishedAt > TERMINAL_WINDOW_MS;
    return (old ? cadence.terminalOld : cadence.terminal) * HOUR_MS;
  }
  const moves = [msOf(input.currentStageEnteredAt), msOf(input.updatedAt)].filter((v): v is number => v !== null);
  const lastMove = moves.length > 0 ? Math.max(...moves) : null;
  const recent = lastMove !== null && nowMs - lastMove <= RECENT_WINDOW_MS;
  return (recent ? cadence.activeRecent : cadence.active) * HOUR_MS;
}

/**
 * Backoff after a failed read. A refused permission or key does not fix
 * itself in minutes: a day. A rate limit: 15 minutes. Anything else doubles
 * from 15 minutes with each attempt, up to a day.
 */
export function errorBackoffMs(code: string, attempts: number): number {
  if (code === 'missing_endpoint_permission' || code === 'forbidden' || code === 'unauthorized') return ERROR_BACKOFF_MAX_MS;
  if (code === 'rate_limited') return ERROR_BACKOFF_BASE_MS;
  const n = Math.max(1, Math.min(Math.trunc(attempts) || 1, 20));
  return Math.min(ERROR_BACKOFF_BASE_MS * 2 ** (n - 1), ERROR_BACKOFF_MAX_MS);
}

// ── The store seam ──────────────────────────────────────────────────────────

/** A claimed row: ids, the lease (verbatim), and the stored state a fresh read is compared with. */
export interface ClaimedProgress {
  progressId: string;
  linkId: string;
  applicationId: string;
  /** Exactly as the claim answered: handed back unparsed, so no precision is lost. */
  leaseUntil: string;
  attempts: number;
  stored: {
    status: string | null;
    currentStageId: string | null;
    currentStageEnteredAt: string | null;
    archivedAt: string | null;
    ashbyUpdatedAt: string | null;
    lastCheckedAt: string | null;
    /** The newest last_seen_at of its intervals: when its history was last read. */
    historyReadAt: string | null;
  };
}

export interface ProgressClaim {
  seeded: number;
  /** A backfill is open: the pass records its run even when empty, so the backfill can close. */
  backfillOpen: boolean;
  /**
   * When the open backfill began, or null. A history read before then is
   * read again, so a backfill rebuilds every application's intervals.
   */
  backfillStartedAt: string | null;
  claimed: ClaimedProgress[];
}

/** One history row as record_ashby_application_progress takes it. */
export interface HistoryPayloadRow {
  history_id: string;
  stage_id: string;
  title: string | null;
  entered_at: string;
  left_at: string | null;
  stage_number: number | null;
  moved_by_person: boolean | null;
}

/** One stage known only from history, as record_ashby_application_progress takes it. */
export interface StagePayload {
  stage_id: string;
  interview_plan_id: string | null;
  title: string | null;
  stage_type: string | null;
  order_in_plan: number | null;
  stage_group_id: string | null;
  default_milestone: StageMilestone | null;
}

export interface ApplicationPayload {
  status: AshbyApplicationStatus | null;
  current_stage_id: string | null;
  current_stage_entered_at: string | null;
  current_job_id: string | null;
  archive_reason_id: string | null;
  archive_reason_type: string | null;
  archived_at: string | null;
  ashby_updated_at: string | null;
}

export type ProgressRecord =
  | {
      outcome: 'ok';
      next_check_at: string;
      application: ApplicationPayload;
      /** Null: the history was not read this time and the stored intervals stand. */
      history: HistoryPayloadRow[] | null;
      reason: { reason_id: string; text: string | null; reason_type: string | null; is_archived: boolean | null } | null;
      stages: StagePayload[];
    }
  | { outcome: 'error'; error_code: string; next_check_at: string }
  | { outcome: 'gone'; error_code: string }
  | { outcome: 'deferred'; next_check_at: string };

export type RecordAnswer =
  | { status: 'ok'; changed: boolean }
  | { status: 'lease_lost' }
  | { status: 'not_found' }
  | { status: 'refused'; code: string };

export interface ProgressRunInput {
  startedAt: string;
  finishedAt: string;
  checked: number;
  changed: number;
  errors: Record<string, number>;
}

export interface ProgressRunView {
  mode: 'sweep' | 'backfill';
  startedAt: string | null;
  finishedAt: string | null;
  checked: number;
  changed: number;
  /** Rows handed back unread (the pass's deadline or a rate limit): {@link RUN_DEFERRED_KEY}. */
  deferred: number;
  /** Passes skipped for a CPU-starved scanner just before this one: {@link RUN_SCANNER_PAUSED_KEY}. */
  scannerPaused: number;
  /** Failures by code; the two counts above are not among them. */
  errors: Array<{ code: string; count: number }>;
}

/** Counts only: no link, application, candidate, run or stage id. */
export interface ProgressOverview {
  links: number;
  linksExcluded: number;
  progressRows: number;
  checked: number;
  neverChecked: number;
  dueNow: number;
  gone: number;
  stale: number;
  byStatus: { Active: number; Hired: number; Archived: number; Lead: number; unknown: number };
  byError: Array<{ code: string; count: number }>;
  intervals: { total: number; open: number; gone: number };
  historyStages: number;
  openBackfill: { startedAt: string | null; remaining: number } | null;
  lastSweep: ProgressRunView | null;
  recentRuns: ProgressRunView[];
  /**
   * Passes skipped for a CPU-starved scanner in the last 24 hours, as the
   * passes that ran after them recorded, and when the newest of those ran.
   */
  scannerPause: { skippedPasses: number; lastAt: string | null };
}

export interface BackfillStart {
  state: 'started' | 'already_running';
  startedAt: string | null;
  links: number;
  seeded: number;
  marked: number;
}

export interface ProgressStore {
  /**
   * True while the resume scanner defers ingestion jobs because a scan timed
   * out or the scanner was full ({@link SCANNER_PRESSURE_REASONS}): the
   * machine is short of CPU. A signature or readiness hold does not count.
   */
  scannerBusy(): Promise<boolean>;
  claimDue(input: { limit: number; leaseSeconds: number; seedLimit: number; nowIso: string }): Promise<ProgressClaim>;
  /** Catalogue rows for these stage ids: where each came from and whether it has a type. */
  knownStages(stageIds: string[]): Promise<Map<string, { source: 'plan' | 'history'; stageType: string | null }>>;
  /** Christy stage ids of every mapping not archived, for a history stage's default milestone. */
  christyStageIds(): Promise<string[]>;
  record(progressId: string, leaseUntil: string, nowIso: string, record: ProgressRecord): Promise<RecordAnswer>;
  recordRun(run: ProgressRunInput): Promise<{ backfillFinished: boolean }>;
  overview(nowIso: string, staleAfterSeconds: number): Promise<ProgressOverview>;
  startBackfill(actorId: string, nowIso: string): Promise<BackfillStart>;
}

/** The reads a pass makes. Satisfied by AshbyClient; injected for tests. */
export interface ProgressReader {
  applicationInfo<T = OpaqueRecord>(applicationId: string, extra?: OpaqueRecord, options?: AshbyCallOptions): Promise<{ results: T }>;
  applicationListHistory<T = OpaqueRecord[]>(params: ApplicationHistoryParams): Promise<{
    results: T;
    moreDataAvailable: boolean;
    moreDataAvailablePresent?: boolean;
    nextCursor?: string;
  }>;
  interviewStageInfo<T = OpaqueRecord>(interviewStageId: string, options?: AshbyCallOptions): Promise<{ results: T }>;
}

// ── Classifying a failed read ───────────────────────────────────────────────

type ReadFailure =
  | { kind: 'gone'; code: string }
  | { kind: 'error'; code: string }
  | { kind: 'rate_limited'; code: 'rate_limited' }
  | { kind: 'deadline' };

/** Codes a 200 `success: false` may name for an application Ashby no longer has. */
const GONE_ENDPOINT_CODES = new Set(['application_not_found', 'not_found']);

/** The failures that mean time ran out (or Ashby could not answer in it), not a refusal. */
const TIME_CLASS_CODES = new Set(['timeout', 'server_error', 'network']);

function isTimeClass(err: unknown): boolean {
  const verdict = classifyAccessError(err);
  return verdict.state === 'error' && verdict.error !== null && TIME_CLASS_CODES.has(verdict.error);
}

/**
 * The PASS's deadline, not the application, stopped this call: it began with
 * less than its own budget left of the pass and failed as the pass ran out,
 * or it could not start at all.
 */
class PassDeadlineError extends Error {
  constructor() {
    super('ashby_progress_pass_deadline');
  }
}

/**
 * The budget one Ashby call gets inside a pass: {@link CALL_BUDGET_MS}, and
 * never more than half the pass, so one call that never answers cannot use
 * the pass up and the rows behind it are still read.
 */
export function callBudgetMs(config: Pick<AshbyProgressConfig, 'passDeadlineMs'>): number {
  return Math.min(CALL_BUDGET_MS, Math.floor(config.passDeadlineMs / 2));
}

function classifyReadFailure(err: unknown, op: ProgressOperation): ReadFailure {
  if (err instanceof PassDeadlineError) return { kind: 'deadline' };
  const verdict = classifyAccessError(err);
  if (verdict.state === 'missing_permission') return { kind: 'error', code: 'missing_endpoint_permission' };
  if (op === 'application.info') {
    if (verdict.error === 'not_found') return { kind: 'gone', code: 'application_not_found' };
    if (isAshbyError(err) && err.category === 'logical_failure'
      && err.endpointCodes.some((c) => GONE_ENDPOINT_CODES.has(c.toLowerCase()))) {
      return { kind: 'gone', code: 'application_not_found' };
    }
  }
  if (verdict.error === 'rate_limited') return { kind: 'rate_limited', code: 'rate_limited' };
  // A call that ran out of its OWN budget: the application's failure, backed off.
  return { kind: 'error', code: verdict.error };
}

class HistoryReadError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

// ── One pass ────────────────────────────────────────────────────────────────

export interface ProgressPassDeps {
  reader: ProgressReader;
  store: ProgressStore;
  config: AshbyProgressConfig;
  /** Wall clock (epoch ms). A real Ashby client compares deadlines against Date.now(). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Passes this machine skipped in a row for the scanner, just before this
   * one (the loop keeps the count). At {@link MAX_SCANNER_SKIPS} a pass of
   * one application runs even while the scanner is short of CPU; whenever a
   * pass runs, the count goes on its run row.
   */
  scannerSkips?: number;
}

export interface ProgressPassResult {
  /** Why no Ashby call was made, or null when the pass ran. */
  skipped: 'disabled' | 'scanner_busy' | null;
  /** The scanner is still short of CPU, but the pause reached its cap: a pass of one application ran. */
  trickle: boolean;
  seeded: number;
  claimed: number;
  /** Reads recorded: ok, failed or gone. */
  checked: number;
  /** Recorded reads that changed something the page counts. */
  changed: number;
  /** Rows handed back unread (deadline or rate limit). */
  deferred: number;
  /** Failures by sanitized code, lease_lost and record failures included. */
  errors: Record<string, number>;
  /** Ashby calls made. */
  calls: number;
  rateLimited: boolean;
  deadlineHit: boolean;
  /** The pass filled its batch and stopped for no reason of its own: more is likely due. */
  drain: boolean;
  backfillFinished: boolean;
}

function emptyResult(skipped: ProgressPassResult['skipped']): ProgressPassResult {
  return {
    skipped, trickle: false, seeded: 0, claimed: 0, checked: 0, changed: 0, deferred: 0, errors: {}, calls: 0,
    rateLimited: false, deadlineHit: false, drain: false, backfillFinished: false,
  };
}

/**
 * What a backfill of `applications` applications costs: a backfill re-reads
 * every history, so {@link CALLS_PER_APPLICATION} Ashby calls each
 * (application.info and one history page), but one for each of the `gone`
 * applications Ashby no longer had (application.info answers 404 again), at
 * the pass's pace. Longer histories take a page per 100 rows on top. Pure
 * Ashby time: the gaps between passes come on top.
 */
export function estimateBackfill(applications: number, config: Pick<AshbyProgressConfig, 'minCallIntervalMs'>, gone = 0): {
  expectedCalls: number;
  estimatedMinutes: number;
  requestsPerSecond: number;
} {
  const n = Math.max(0, Math.trunc(applications) || 0);
  const g = Math.min(n, Math.max(0, Math.trunc(gone) || 0));
  const expectedCalls = (n - g) * CALLS_PER_APPLICATION + g;
  return {
    expectedCalls,
    estimatedMinutes: Math.ceil((expectedCalls * config.minCallIntervalMs) / 60_000),
    requestsPerSecond: Math.round((1_000 / config.minCallIntervalMs) * 10) / 10,
  };
}

/** The lease a claim takes: longer than a whole pass, so a row is never read twice at once. */
export function leaseSecondsFor(config: AshbyProgressConfig): number {
  return Math.min(3_600, Math.max(30, Math.ceil(config.passDeadlineMs / 1_000) + 60));
}

/**
 * Run one pass. Throws only when HELLO's own tables cannot be read or
 * written (the scheduler counts it as a tick error); every Ashby failure is
 * recorded on its row and counted by code.
 */
export async function runProgressPass(deps: ProgressPassDeps): Promise<ProgressPassResult> {
  const { reader, store, config } = deps;
  if (!config.enabled) return emptyResult('disabled');
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // The scanner's pause, capped: a machine that skipped MAX_SCANNER_SKIPS
  // passes in a row reads one application anyway, so the worker never stops
  // for good behind one resume that keeps timing out.
  const pausedBefore = Math.max(0, Math.trunc(deps.scannerSkips ?? 0) || 0);
  let batchSize = config.batchSize;
  let trickle = false;
  if (await store.scannerBusy()) {
    if (pausedBefore < MAX_SCANNER_SKIPS) return emptyResult('scanner_busy');
    batchSize = 1;
    trickle = true;
  }

  const startedAt = now();
  const deadlineAt = startedAt + config.passDeadlineMs;
  const budget = callBudgetMs(config);
  const claim = await store.claimDue({
    limit: batchSize,
    leaseSeconds: leaseSecondsFor(config),
    seedLimit: SEED_PER_PASS,
    nowIso: new Date(startedAt).toISOString(),
  });
  const result = emptyResult(null);
  result.trickle = trickle;
  result.seeded = claim.seeded;
  result.claimed = claim.claimed.length;
  const tally = (code: string): void => { result.errors[code] = (result.errors[code] ?? 0) + 1; };

  // ≈2 requests a second, across the whole pass. Each call gets its own
  // budget, cut to what is left of the pass. A call that fails as the PASS
  // runs out (it began with less than its budget left) is the pass's doing;
  // one that fails on its own budget is the application's.
  let lastCallAt = Number.NEGATIVE_INFINITY;
  type Timing = { deadlineAt: number; failFastPastDeadline: true };
  async function call<T>(op: ProgressOperation, budgetMs: number, run: (timing: Timing) => Promise<T>): Promise<T> {
    assertProgressReadOnly(op);
    const wait = lastCallAt + config.minCallIntervalMs - now();
    if (wait > 0) await sleep(Math.min(wait, Math.max(0, deadlineAt - now())));
    const startAt = now();
    // No call starts past the pass's deadline, whatever the reader does with it.
    if (startAt >= deadlineAt) throw new PassDeadlineError();
    const callDeadline = Math.min(deadlineAt, startAt + budgetMs);
    const passBound = callDeadline === deadlineAt;
    lastCallAt = startAt;
    result.calls += 1;
    try {
      return await run({ deadlineAt: callDeadline, failFastPastDeadline: true });
    } catch (err) {
      if (passBound && now() >= deadlineAt && isTimeClass(err)) throw new PassDeadlineError();
      throw err;
    }
  }

  // Per pass: stages already sent or looked up, and whether lookups stopped
  // (Interviews read refused, or a lookup that did not answer in its budget).
  const stagesHandled = new Set<string>();
  let stageLookups = 0;
  let stageLookupsOff = false;
  let christy: Set<string> | null = null;

  async function readHistory(applicationId: string): Promise<ProgressHistoryRow[]> {
    const rows = new Map<string, ProgressHistoryRow>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const res = await call('application.listHistory', budget, (timing) =>
        reader.applicationListHistory({ applicationId, cursor, limit: HISTORY_PAGE_LIMIT, ...timing }));
      if (!Array.isArray(res.results)) throw new HistoryReadError('malformed_response');
      for (const raw of res.results) {
        const row = readHistoryRow(raw);
        if (!row) throw new HistoryReadError('malformed_response');
        // One upsert per Ashby id: a repeated row would fail the whole write.
        if (!rows.has(row.historyId)) rows.set(row.historyId, row);
      }
      if (!res.moreDataAvailable) return [...rows.values()];
      const next = res.nextCursor;
      if (typeof next !== 'string' || next.length === 0 || cursors.has(next)) throw new HistoryReadError('malformed_response');
      cursors.add(next);
      cursor = next;
    }
    throw new HistoryReadError('history_page_cap');
  }

  async function stagesToAdd(app: ProgressApplicationView, history: ProgressHistoryRow[] | null): Promise<StagePayload[]> {
    const titles = new Map<string, string | null>();
    for (const row of history ?? []) {
      if (!titles.has(row.stageId) || row.title !== null) titles.set(row.stageId, row.title ?? titles.get(row.stageId) ?? null);
    }
    if (app.currentStage && !titles.has(app.currentStage.id)) titles.set(app.currentStage.id, app.currentStage.title);
    const ids = [...titles.keys()].filter((id) => !stagesHandled.has(id));
    if (ids.length === 0) return [];
    const known = await store.knownStages(ids);
    const out: StagePayload[] = [];
    for (const id of ids) {
      const had = known.get(id);
      // A plan stage, or a history stage that already has its type: nothing to add.
      if (had && (had.source === 'plan' || had.stageType !== null)) {
        stagesHandled.add(id);
        continue;
      }
      let stage: ProgressStageView | null = app.currentStage?.id === id && app.currentStage.type !== null ? app.currentStage : null;
      if (!stage && !stageLookupsOff && stageLookups < MAX_STAGE_LOOKUPS_PER_PASS && now() + MIN_ROW_BUDGET_MS < deadlineAt) {
        stageLookups += 1;
        try {
          const res = await call('interviewStage.info', Math.min(STAGE_LOOKUP_BUDGET_MS, budget), (timing) =>
            reader.interviewStageInfo(id, timing));
          const [found] = extractStages([res.results]).filter((s) => s.id === id);
          const rec = asRecord(res.results);
          if (found) {
            stage = {
              id,
              title: found.title,
              type: found.type,
              orderInPlan: found.orderInInterviewPlan !== null && found.orderInInterviewPlan <= PG_INTEGER_MAX ? found.orderInInterviewPlan : null,
              groupId: found.interviewStageGroupId,
              planId: opaqueId(rec?.interviewPlanId),
            };
          }
        } catch (err) {
          // Without the type the stage still shows by its history title. No
          // more lookups this pass after a refusal, or one that did not answer.
          if (classifyAccessError(err).state === 'missing_permission'
            || err instanceof PassDeadlineError || isTimeClass(err)) stageLookupsOff = true;
        }
      }
      // Known from history already and nothing new learned: leave it.
      if (had && !stage) {
        stagesHandled.add(id);
        continue;
      }
      christy ??= new Set((await store.christyStageIds()).map(opaqueId).filter((s): s is string => s !== null));
      const title = stage?.title ?? titles.get(id) ?? null;
      const type = stage?.type ?? null;
      out.push({
        stage_id: id,
        interview_plan_id: stage?.planId ?? null,
        title,
        stage_type: type,
        order_in_plan: stage?.orderInPlan ?? null,
        stage_group_id: stage?.groupId ?? null,
        default_milestone: defaultMilestone({ id, type, title }, christy),
      });
      stagesHandled.add(id);
    }
    return out;
  }

  async function readOne(row: ClaimedProgress): Promise<ProgressRecord | 'deferred' | 'rate_limited'> {
    const tNow = now;
    const failed = (code: string): ProgressRecord => ({
      outcome: 'error', error_code: code, next_check_at: new Date(tNow() + errorBackoffMs(code, row.attempts)).toISOString(),
    });
    // Cut short by the pass's deadline. Handed back unread only when the row
    // began with no more than one call's budget left: the pass ran out on it.
    // A row that began with more ran the pass out with its own slow reads,
    // and is that application's timeout, backed off like any failure.
    const leftAtStart = deadlineAt - tNow();
    const cutShort = (): ProgressRecord | 'deferred' => (leftAtStart > budget ? failed('timeout') : 'deferred');

    let info: unknown;
    try {
      info = (await call('application.info', budget, (timing) => reader.applicationInfo(row.applicationId, undefined, timing))).results;
    } catch (err) {
      const f = classifyReadFailure(err, 'application.info');
      if (f.kind === 'deadline') return cutShort();
      if (f.kind === 'gone') return { outcome: 'gone', error_code: f.code };
      if (f.kind === 'rate_limited') return 'rate_limited';
      return failed(f.code);
    }
    const app = readApplicationInfo(info);
    if (!app) return failed('malformed_response');

    let history: ProgressHistoryRow[] | null = null;
    if (needsHistoryRead(row, app, tNow(), config.cadenceHours.historyMaxAge * HOUR_MS, claim.backfillStartedAt)) {
      try {
        history = await readHistory(row.applicationId);
      } catch (err) {
        if (err instanceof HistoryReadError) return failed(err.code);
        const f = classifyReadFailure(err, 'application.listHistory');
        if (f.kind === 'deadline') return cutShort();
        if (f.kind === 'rate_limited') return 'rate_limited';
        return failed(f.kind === 'gone' ? 'not_found' : f.code);
      }
    }

    const stageId = app.currentStage?.id ?? null;
    let enteredAt: string | null = null;
    if (history) {
      const inStage = history.filter((h) => h.stageId === stageId);
      const open = inStage.filter((h) => h.leftAt === null);
      const pick = (open.length > 0 ? open : inStage).sort((a, b) => Date.parse(b.enteredAt) - Date.parse(a.enteredAt))[0];
      enteredAt = pick?.enteredAt ?? null;
    } else if (stageId !== null && stageId === row.stored.currentStageId) {
      enteredAt = row.stored.currentStageEnteredAt;
    }

    const stages = await stagesToAdd(app, history);
    const delay = nextCheckDelayMs(
      { status: app.status, currentStageEnteredAt: enteredAt, updatedAt: app.updatedAt, archivedAt: app.archivedAt },
      tNow(),
      config.cadenceHours,
    );
    return {
      outcome: 'ok',
      next_check_at: new Date(tNow() + delay).toISOString(),
      application: {
        status: app.status,
        current_stage_id: stageId,
        current_stage_entered_at: enteredAt,
        current_job_id: app.currentJobId,
        archive_reason_id: app.archiveReason?.id ?? null,
        archive_reason_type: app.archiveReason?.reasonType ?? null,
        archived_at: app.archivedAt,
        ashby_updated_at: app.updatedAt,
      },
      history: history?.map((h) => ({
        history_id: h.historyId,
        stage_id: h.stageId,
        title: h.title,
        entered_at: h.enteredAt,
        left_at: h.leftAt,
        stage_number: h.stageNumber,
        moved_by_person: h.movedByPerson,
      })) ?? null,
      reason: app.archiveReason
        ? { reason_id: app.archiveReason.id, text: app.archiveReason.text, reason_type: app.archiveReason.reasonType, is_archived: app.archiveReason.isArchived }
        : null,
      stages,
    };
  }

  async function handBack(rows: ClaimedProgress[], holdMs: number): Promise<void> {
    const at = new Date(now() + holdMs).toISOString();
    for (const row of rows) {
      try {
        const answer = await store.record(row.progressId, row.leaseUntil, new Date(now()).toISOString(), { outcome: 'deferred', next_check_at: at });
        if (answer.status === 'ok') result.deferred += 1;
      } catch {
        // The lease runs out on its own; the row is due again then.
      }
    }
  }

  async function write(row: ClaimedProgress, record: ProgressRecord): Promise<void> {
    let answer: RecordAnswer;
    try {
      answer = await store.record(row.progressId, row.leaseUntil, new Date(now()).toISOString(), record);
    } catch {
      tally('record_error');
      // A write Postgres refused (a value past a CHECK): back off rather than re-read it every pass.
      await store.record(row.progressId, row.leaseUntil, new Date(now()).toISOString(), {
        outcome: 'error', error_code: 'record_error', next_check_at: new Date(now() + errorBackoffMs('record_error', row.attempts)).toISOString(),
      }).catch(() => undefined);
      return;
    }
    if (answer.status === 'lease_lost') { tally('lease_lost'); return; }
    if (answer.status === 'not_found') { tally('progress_not_found'); return; }
    if (answer.status === 'refused') {
      tally('record_refused');
      await store.record(row.progressId, row.leaseUntil, new Date(now()).toISOString(), {
        outcome: 'error', error_code: 'record_refused', next_check_at: new Date(now() + errorBackoffMs('record_refused', row.attempts)).toISOString(),
      }).catch(() => undefined);
      return;
    }
    result.checked += 1;
    if (answer.changed) result.changed += 1;
    if (record.outcome === 'error' || record.outcome === 'gone') tally(record.error_code);
  }

  const rows = claim.claimed;
  for (let i = 0; i < rows.length; i += 1) {
    if (now() + MIN_ROW_BUDGET_MS >= deadlineAt) {
      result.deadlineHit = true;
      await handBack(rows.slice(i), 0);
      break;
    }
    let outcome: Awaited<ReturnType<typeof readOne>>;
    try {
      outcome = await readOne(rows[i]);
    } catch {
      // HELLO's own catalogue or mapping read failed mid-row: back off, keep going.
      outcome = {
        outcome: 'error', error_code: 'internal_error',
        next_check_at: new Date(now() + errorBackoffMs('internal_error', rows[i].attempts)).toISOString(),
      };
    }
    if (outcome === 'deferred') {
      result.deadlineHit = true;
      await handBack(rows.slice(i), 0);
      break;
    }
    if (outcome === 'rate_limited') {
      // Ashby is pushing back: this row backs off, the rest wait, the pass ends.
      result.rateLimited = true;
      await write(rows[i], { outcome: 'error', error_code: 'rate_limited', next_check_at: new Date(now() + errorBackoffMs('rate_limited', rows[i].attempts)).toISOString() });
      await handBack(rows.slice(i + 1), RATE_LIMIT_HOLD_MS);
      break;
    }
    await write(rows[i], outcome);
  }

  // The run row counts, next to the failures, the rows handed back unread and
  // the passes this machine skipped for the scanner just before this one, so
  // neither is invisible on the status route.
  const runCounts: Record<string, number> = { ...result.errors };
  if (result.deferred > 0) runCounts[RUN_DEFERRED_KEY] = result.deferred;
  if (pausedBefore > 0) runCounts[RUN_SCANNER_PAUSED_KEY] = pausedBefore;
  if (result.checked > 0 || Object.keys(runCounts).length > 0 || claim.backfillOpen) {
    const run = await store.recordRun({
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(Math.max(now(), startedAt)).toISOString(),
      checked: result.checked,
      changed: Math.min(result.changed, result.checked),
      errors: runCounts,
    });
    result.backfillFinished = run.backfillFinished;
  }
  result.drain = !trickle && result.claimed >= batchSize && !result.rateLimited && !result.deadlineHit;
  return result;
}

/**
 * Whether this check re-reads the stage history: never read, or read longer
 * ago than `historyMaxAgeMs`, or read before the open backfill began
 * (`backfillStartedAt`: a backfill rebuilds every application's intervals,
 * for example after a fix to the history reader), or the application changed
 * (status, stage, archive time or Ashby's updatedAt). Ashby says its
 * 2026-11-04 archive-time fix gave existing applications no new modification
 * time, and whether a history edit moves updatedAt is not documented: hence
 * the age and backfill rules.
 */
export function needsHistoryRead(
  row: Pick<ClaimedProgress, 'stored'>,
  app: ProgressApplicationView,
  nowMs: number,
  historyMaxAgeMs: number,
  backfillStartedAt: string | null = null,
): boolean {
  const s = row.stored;
  if (s.lastCheckedAt === null || s.historyReadAt === null) return true;
  const readAt = msOf(s.historyReadAt);
  if (readAt === null || nowMs - readAt >= historyMaxAgeMs) return true;
  const backfillAt = msOf(backfillStartedAt);
  if (backfillAt !== null && readAt < backfillAt) return true;
  if (s.status !== app.status) return true;
  if (s.currentStageId !== (app.currentStage?.id ?? null)) return true;
  if (msOf(s.archivedAt) !== msOf(app.archivedAt)) return true;
  if (msOf(s.ashbyUpdatedAt) !== msOf(app.updatedAt)) return true;
  return false;
}

// ── HELLO's side ────────────────────────────────────────────────────────────

function count(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

function text(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}

/** Failures by code, sanitized: only safe codes, counts, largest first. */
export function codeCounts(raw: unknown): Array<{ code: string; count: number }> {
  const rec = asRecord(raw);
  if (!rec) return [];
  return Object.entries(rec)
    .filter(([code]) => CODE_RE.test(code))
    .map(([code, n]) => ({ code, count: count(n) }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1))
    .slice(0, 50);
}

function runView(raw: unknown): ProgressRunView | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const codes = asRecord(rec.errors_by_code) ?? {};
  // The two counts a run row keeps next to its failures, kept apart from them.
  const { [RUN_DEFERRED_KEY]: deferred, [RUN_SCANNER_PAUSED_KEY]: paused, ...failures } = codes;
  return {
    mode: rec.mode === 'backfill' ? 'backfill' : 'sweep',
    startedAt: isoOrNull(rec.started_at),
    finishedAt: isoOrNull(rec.finished_at),
    checked: count(rec.checked),
    changed: count(rec.changed),
    deferred: count(deferred),
    scannerPaused: count(paused),
    errors: codeCounts(failures),
  };
}

function claimedRow(raw: unknown): ClaimedProgress | null {
  const rec = asRecord(raw);
  const progressId = text(rec?.progress_id);
  const linkId = text(rec?.link_id);
  const applicationId = text(rec?.application_id);
  const leaseUntil = text(rec?.lease_until);
  if (!rec || !progressId || !linkId || !applicationId || !leaseUntil) return null;
  return {
    progressId,
    linkId,
    applicationId,
    leaseUntil,
    attempts: count(rec.attempts),
    stored: {
      status: text(rec.status),
      currentStageId: text(rec.current_stage_id),
      currentStageEnteredAt: text(rec.current_stage_entered_at),
      archivedAt: text(rec.archived_at),
      ashbyUpdatedAt: text(rec.ashby_updated_at),
      lastCheckedAt: text(rec.last_checked_at),
      historyReadAt: text(rec.history_read_at),
    },
  };
}

/**
 * The service-role store. Every write goes through a 0139 function, which
 * writes only the 0138 tables (and the backfill's one audit row). Reads: the
 * scanner-deferral count on job_queue, the stage catalogue for a few stage
 * ids, the mappings for their Christy stage. Never a link, a candidate or an
 * assessment write.
 */
export function createProgressStore(client: SupabaseClient): ProgressStore {
  const catalog = createStageCatalogStore(client);
  return {
    async scannerBusy() {
      // CPU starvation only: a scan that timed out, or a full scanner gate.
      // A stale or missing signature database (scanner_signatures_*) or a
      // readiness hold also defers ingestion, for hours, with the CPU idle.
      const { count: n, error } = await client
        .from('job_queue')
        .select('*', { count: 'exact', head: true })
        .eq('name', SCANNER_QUEUE)
        .eq('status', 'delayed')
        .in('defer_reason', [...SCANNER_PRESSURE_REASONS]);
      if (error) throw new Error('ashby_progress_scanner_read_error');
      return typeof n === 'number' && n > 0;
    },

    async claimDue({ limit, leaseSeconds, seedLimit, nowIso }) {
      const { data, error } = await client.rpc('claim_ashby_progress_due', {
        p_limit: limit, p_lease_seconds: leaseSeconds, p_seed_limit: seedLimit, p_now: nowIso,
      });
      if (error) throw new Error('ashby_progress_claim_error');
      const res = asRecord(data) ?? {};
      const claimed = Array.isArray(res.claimed) ? res.claimed.map(claimedRow).filter((r): r is ClaimedProgress => r !== null) : [];
      return {
        seeded: count(res.seeded),
        backfillOpen: res.backfill_open === true,
        backfillStartedAt: isoOrNull(res.backfill_started_at),
        claimed,
      };
    },

    async knownStages(stageIds) {
      const out = new Map<string, { source: 'plan' | 'history'; stageType: string | null }>();
      for (const chunk of chunkIds(stageIds)) {
        const { data, error } = await client
          .from('ashby_stage_catalog')
          .select('stage_id, source, stage_type')
          .in('stage_id', chunk);
        if (error) throw new Error('ashby_progress_catalog_read_error');
        for (const r of (data ?? []) as Array<Record<string, unknown>>) {
          const id = opaqueId(r.stage_id);
          if (id) out.set(id, { source: r.source === 'history' ? 'history' : 'plan', stageType: text(r.stage_type) });
        }
      }
      return out;
    },

    async christyStageIds() {
      return (await catalog.readTargets()).christyStageIds;
    },

    async record(progressId, leaseUntil, nowIso, record) {
      const { data, error } = await client.rpc('record_ashby_application_progress', {
        p_progress_id: progressId, p_lease_until: leaseUntil, p_now: nowIso, p_result: record,
      });
      if (error) throw new Error('ashby_progress_record_error');
      const res = asRecord(data) ?? {};
      if (res.status === 'ok') return { status: 'ok', changed: res.changed === true };
      if (res.status === 'lease_lost') return { status: 'lease_lost' };
      if (res.status === 'not_found') return { status: 'not_found' };
      const code = typeof res.status === 'string' && CODE_RE.test(res.status) ? res.status : 'unknown';
      return { status: 'refused', code };
    },

    async recordRun(run) {
      const { data, error } = await client.rpc('record_ashby_progress_run', {
        p_started_at: run.startedAt,
        p_finished_at: run.finishedAt,
        p_checked: run.checked,
        p_changed: run.changed,
        p_errors: run.errors,
        p_now: run.finishedAt,
      });
      if (error) throw new Error('ashby_progress_run_error');
      const res = asRecord(data) ?? {};
      if (res.status !== 'ok') throw new Error('ashby_progress_run_refused');
      return { backfillFinished: res.backfill_finished === true };
    },

    async overview(nowIso, staleAfterSeconds) {
      const { data, error } = await client.rpc('ashby_progress_overview', { p_now: nowIso, p_stale_after_seconds: staleAfterSeconds });
      if (error) throw new Error('ashby_progress_overview_error');
      const res = asRecord(data) ?? {};
      const byStatus = asRecord(res.by_status) ?? {};
      const intervals = asRecord(res.intervals) ?? {};
      const open = asRecord(res.open_backfill);
      const pause = asRecord(res.scanner_pause) ?? {};
      return {
        links: count(res.links),
        linksExcluded: count(res.links_excluded),
        progressRows: count(res.progress_rows),
        checked: count(res.checked),
        neverChecked: count(res.never_checked),
        dueNow: count(res.due_now),
        gone: count(res.gone),
        stale: count(res.stale),
        byStatus: {
          Active: count(byStatus.Active),
          Hired: count(byStatus.Hired),
          Archived: count(byStatus.Archived),
          Lead: count(byStatus.Lead),
          unknown: count(byStatus.unknown),
        },
        byError: codeCounts(res.by_error),
        intervals: { total: count(intervals.total), open: count(intervals.open), gone: count(intervals.gone) },
        historyStages: count(res.history_stages),
        openBackfill: open ? { startedAt: isoOrNull(open.started_at), remaining: count(open.remaining) } : null,
        lastSweep: runView(res.last_sweep),
        recentRuns: (Array.isArray(res.recent_runs) ? res.recent_runs : []).map(runView).filter((r): r is ProgressRunView => r !== null).slice(0, 10),
        scannerPause: { skippedPasses: count(pause.skipped_passes), lastAt: isoOrNull(pause.last_at) },
      };
    },

    async startBackfill(actorId, nowIso) {
      const { data, error } = await client.rpc('start_ashby_progress_backfill', { p_actor_id: actorId, p_now: nowIso });
      if (error) throw new Error('ashby_progress_backfill_error');
      const res = asRecord(data) ?? {};
      const state = res.status === 'started' ? 'started' : res.status === 'already_running' ? 'already_running' : null;
      if (!state) throw new Error('ashby_progress_backfill_refused');
      return {
        state,
        startedAt: isoOrNull(res.started_at),
        links: count(res.links),
        seeded: count(res.seeded),
        marked: count(res.marked),
      };
    },
  };
}
