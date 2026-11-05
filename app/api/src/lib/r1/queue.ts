/**
 * The read behind `GET /api/interview-rounds`: the R1 queue, one server page at a time.
 *
 * WHO SEES WHAT. The rule of the R1 video and the review page (`recording/access.ts`): admin and viewer
 * every candidate, an interviewer only a candidate they own. It is a filter on the join, not a check on
 * the rows that came back, so a page and its total only ever count what this person may see.
 *
 * THE VIEWS come from `status` and `status_write`. R1 has no human-feedback record yet, so "Reviewed"
 * cannot mean that a person watched the interview. It means a status outcome has settled:
 *
 *   in-progress  status is invited or in_progress. A retake re-opens a round, so one can carry an older
 *                result here.
 *   reviewed     status is completed or expired, and status_write is advanced, rejected (the candidate's
 *                status was written) or pending_reject_cancelled (HR overrode the rejection).
 *   to-review    every other finished round: completed with any other status_write or none yet (scoring
 *                has not finished), or expired with one, which is a scored round whose retake lapsed. An
 *                expired round with no status_write never produced a result: its link lapsed unused.
 *   all          every round, cancelled ones and unused lapsed links included.
 *
 * So while auto-status is off (`flag_off`, `hold_flag`, `human_review`) a finished round stays in To
 * review until the feedback record exists. Lingering there is the safe direction: a round wrongly
 * called Reviewed is an interview nobody opens.
 *
 * WHAT IS WITHHELD. While an appeal blocks decision use the row carries no result, as the rounds list
 * and the review page do. To review and Reviewed are decision queues, and which one a round sat in would
 * give the verdict away (`status_write` is withheld for the same reason), so such a round is left out of
 * both and stays in All and In progress.
 *
 * WHAT NEVER LEAVES. Every read names its columns and every field below is projected: no digest, key,
 * URL, room name or contact detail. A recording is the summary staff already read in the rounds list.
 *
 * STAFF DRY RUNS (`consent_locale`, 0120) promise no decision use, so they are hidden unless asked for.
 * The candidate's R1 tab still lists them.
 *
 * ORDER. By the date the link was sent, then by id, so a page boundary is stable. `interview_rounds`
 * stores no finish time. The link lasts 72 hours, so sent order is close to finished order, and it does
 * not move when a round is touched, which `updated_at` would.
 *
 * SCALE. One counted `.range()` page of rounds, filtered in SQL through the `candidates!inner` join (the
 * idiom of `phone-runtime/read.ts`). Everything else is read for that page only: at most four id-batched
 * reads, however long the list grows, with no read per round. A failed read fails the page, because a
 * row with no attempts would say "no recording" about something that exists.
 */

import { chunkIds, mapChunks, readAllPages, type PageResult } from '../id-batches.js';
import type { R1DbClient } from '../../services/r1-assessment.js';
import { type R1StaffActor, seesEveryCandidate } from './recording/access.js';
import { withdrawalCutoffs } from './recording/erase.js';
import { RECORDINGS_TABLE, type R1RecordingRow } from './recording/service.js';
import { SUMMARY_COLUMNS, summarizeRecording, type R1AttemptSummary } from './recording/summary.js';
import { LIVE_SESSION_STATES, STAFF_LOCALE, withdrawnSummary } from './review.js';

export const R1_QUEUE_VIEWS = ['to-review', 'in-progress', 'reviewed', 'all'] as const;
export type R1QueueView = (typeof R1_QUEUE_VIEWS)[number];

export const R1_QUEUE_SORTS = ['oldest', 'newest'] as const;
export type R1QueueSort = (typeof R1_QUEUE_SORTS)[number];

export const R1_QUEUE_PAGE_SIZE = 25;
export const R1_QUEUE_MAX_PAGE_SIZE = 50;
export const R1_QUEUE_MAX_SEARCH = 100;

/** A runaway bound on one id batch. A round has at most three starts, so one page always ends it. */
const MAX_PAGES = 2;

/** The writes that settle a round: the candidate's status changed, or HR overrode the rejection (0122). */
const SETTLED_WRITES = ['advanced', 'rejected', 'pending_reject_cancelled'] as const;
const SETTLED_LIST = SETTLED_WRITES.join(',');

/** `not.in` on a NULL is NULL, so the unwritten completed round needs its own branch. */
const TO_REVIEW_FILTER =
  `and(status.eq.completed,or(status_write.is.null,status_write.not.in.(${SETTLED_LIST}))),`
  + `and(status.eq.expired,status_write.not.in.(${SETTLED_LIST}))`;

const ROUND_COLUMNS =
  'id,candidate_id,status,expires_at,attempts_allowed,attempts_counted,recommendation,overall,status_write,'
  + 'pending_reject_until,consent_locale,created_at';
const CANDIDATE_EMBED = 'candidates!inner(name,decision_use_blocked_at)';
const ATTEMPT_COLUMNS = 'session_id,round_id,attempt_number,counted,outcome,created_at';
const SESSION_COLUMNS = 'id,interview_round_id,status,ended_at';

type Row = Record<string, unknown>;

export interface R1QueueQuery {
  view: R1QueueView;
  sort: R1QueueSort;
  page: number;
  pageSize: number;
  /** The search as typed, trimmed. Empty is no search. */
  search: string;
  includeDryRuns: boolean;
}

export interface R1QueueAttempt extends R1AttemptSummary {
  in_progress: boolean;
  ended_at: string | null;
}

export interface R1QueueRound {
  id: string;
  candidate_id: string;
  candidate_name: string | null;
  status: string;
  expires_at: string | null;
  attempts_allowed: number;
  attempts_counted: number;
  recommendation: string | null;
  overall: number | null;
  status_write: string | null;
  pending_reject_until: string | null;
  scores_withheld: boolean;
  is_staff_dry_run: boolean;
  created_at: string;
  attempts: R1QueueAttempt[];
}

export interface R1QueueBody {
  view: R1QueueView;
  sort: R1QueueSort;
  page: number;
  page_size: number;
  total: number;
  rounds: R1QueueRound[];
}

export type R1QueueResult =
  | { kind: 'ok'; body: R1QueueBody }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' };

const UNAVAILABLE: R1QueueResult = { kind: 'unavailable' };

const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveInt(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === 'string' && /^[1-9]\d{0,5}$/.test(value) ? Number(value) : null;
}

/** The query string, or null when any part of it is not one this route takes. */
export function parseR1QueueQuery(query: Record<string, unknown>): R1QueueQuery | null {
  const view = query.view === undefined ? 'to-review' : query.view;
  if (!R1_QUEUE_VIEWS.includes(view as R1QueueView)) return null;
  // "To review, oldest first": whoever has waited longest. Every other view reads newest first.
  const sort = query.sort === undefined ? (view === 'to-review' ? 'oldest' : 'newest') : query.sort;
  if (!R1_QUEUE_SORTS.includes(sort as R1QueueSort)) return null;
  const page = positiveInt(query.page, 1);
  const pageSize = positiveInt(query.page_size, R1_QUEUE_PAGE_SIZE);
  if (page === null || pageSize === null || pageSize > R1_QUEUE_MAX_PAGE_SIZE) return null;
  const q = query.q === undefined ? '' : query.q;
  if (typeof q !== 'string' || q.length > R1_QUEUE_MAX_SEARCH) return null;
  if (query.dry_runs !== undefined && query.dry_runs !== 'include') return null;
  return {
    view: view as R1QueueView,
    sort: sort as R1QueueSort,
    page,
    pageSize,
    search: q.trim(),
    includeDryRuns: query.dry_runs === 'include',
  };
}

/**
 * The search as an `ilike` pattern: the typed text, anywhere in the name. LIKE's own wildcards are
 * escaped, and `*` goes because PostgREST reads it as `%`. Null when nothing is left to search for.
 */
function namePattern(search: string): string | null {
  const literal = search.replace(/\*/g, '').trim();
  return literal === '' ? null : `%${literal.replace(/[\\%_]/g, '\\$&')}%`;
}

/** The rounds this person may see in this view: a page of them, or only how many there are. */
function roundsRead(db: R1DbClient, actor: R1StaffActor, query: R1QueueQuery) {
  const filtered = (columns: string, options: { count: 'exact'; head?: boolean }) => {
    let read = db.from('interview_rounds').select(columns, options);
    if (!seesEveryCandidate(actor)) read = read.eq('candidates.owner_id', actor.id);
    if (!query.includeDryRuns) read = read.neq('consent_locale', STAFF_LOCALE);
    const pattern = namePattern(query.search);
    if (pattern !== null) read = read.ilike('candidates.name', pattern);
    if (query.view === 'in-progress') read = read.in('status', ['invited', 'in_progress']);
    if (query.view === 'to-review') read = read.or(TO_REVIEW_FILTER);
    if (query.view === 'reviewed') read = read.in('status', ['completed', 'expired']).in('status_write', [...SETTLED_WRITES]);
    if (query.view === 'to-review' || query.view === 'reviewed') read = read.is('candidates.decision_use_blocked_at', null);
    return read;
  };
  return {
    count: () => filtered(`id,${CANDIDATE_EMBED}`, { count: 'exact', head: true }),
    page: (from: number, to: number) => filtered(`${ROUND_COLUMNS},${CANDIDATE_EMBED}`, { count: 'exact' })
      .order('created_at', { ascending: query.sort === 'oldest' })
      .order('id', { ascending: true })
      .range(from, to),
  };
}

interface RoundsWindow {
  rows: Row[];
  total: number;
  page: number;
}

/**
 * The page asked for, or the last page when it runs past the end: a link kept while rounds left the
 * view is not an error. PostgREST refuses a counted read past the end outright (PGRST103, 416), so the
 * total then needs a read of its own. Null when a read failed.
 */
async function readRoundsWindow(db: R1DbClient, actor: R1StaffActor, query: R1QueueQuery): Promise<RoundsWindow | null> {
  const reads = roundsRead(db, actor, query);
  const readPage = (page: number) => {
    const from = (page - 1) * query.pageSize;
    return reads.page(from, from + query.pageSize - 1);
  };

  const answer = await readPage(query.page);
  const pastTheEnd = (answer.error as { code?: unknown } | null)?.code === 'PGRST103';
  if (answer.error && !pastTheEnd) return null;
  const rows = (Array.isArray(answer.data) ? answer.data : []) as Row[];
  if (!pastTheEnd && (rows.length > 0 || query.page === 1)) {
    return typeof answer.count === 'number' ? { rows, total: answer.count, page: query.page } : null;
  }

  let total: unknown = answer.count;
  if (typeof total !== 'number') {
    const counted = await reads.count();
    total = counted.error ? null : counted.count;
  }
  if (typeof total !== 'number') return null;
  if (total === 0) return { rows: [], total: 0, page: 1 };
  const last = Math.ceil(total / query.pageSize);
  const lastAnswer = await readPage(last);
  if (lastAnswer.error || typeof lastAnswer.count !== 'number') return null;
  return { rows: (Array.isArray(lastAnswer.data) ? lastAnswer.data : []) as Row[], total: lastAnswer.count, page: last };
}

/** Rows for these rounds, in id batches, each paged. Null when any read failed. */
async function readForRounds(
  roundIds: readonly string[],
  read: (chunk: string[]) => { range(from: number, to: number): PageResult },
): Promise<Row[] | null> {
  const results = await mapChunks(
    chunkIds(roundIds),
    (chunk) => readAllPages<Row>((from, to) => read(chunk).range(from, to), MAX_PAGES),
    { stopWhen: (result) => !result.ok },
  );
  const rows: Row[] = [];
  for (const result of results) {
    if (!result?.ok) return null;
    rows.push(...result.rows);
  }
  return rows;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Never rejects: Express 4 does not catch a rejection from an async route handler. */
export async function readR1Queue(
  db: R1DbClient,
  actor: R1StaffActor,
  query: R1QueueQuery,
  nowMs: number = Date.now(),
): Promise<R1QueueResult> {
  if (!actor.active) return { kind: 'forbidden' };
  try {
    const window = await readRoundsWindow(db, actor, query);
    if (window === null) return UNAVAILABLE;
    const roundIds = window.rows.map((round) => String(round.id));

    const [attemptRows, recordingRows, sessionRows, cutoffs] = roundIds.length === 0
      ? [[], [], [], new Map<string, number>()]
      : await Promise.all([
          readForRounds(roundIds, (chunk) => db.from('interview_round_attempts').select(ATTEMPT_COLUMNS).in('round_id', chunk)
            .order('attempt_number', { ascending: true }).order('created_at', { ascending: true }).order('session_id', { ascending: true })),
          readForRounds(roundIds, (chunk) => db.from(RECORDINGS_TABLE).select(SUMMARY_COLUMNS).in('round_id', chunk)
            .order('session_id', { ascending: true })),
          readForRounds(roundIds, (chunk) => db.from('call_sessions').select(SESSION_COLUMNS).in('interview_round_id', chunk)
            .order('id', { ascending: true })),
          withdrawalCutoffs(db, roundIds),
        ]);
    if (attemptRows === null || recordingRows === null || sessionRows === null) return UNAVAILABLE;

    const sessions = new Map(sessionRows.map((row) => [String(row.id), row]));
    const recordings = new Map((recordingRows as unknown as R1RecordingRow[]).map((row) => [row.session_id, row]));
    const attemptsByRound = new Map<string, R1QueueAttempt[]>();
    for (const row of attemptRows) {
      const sessionId = String(row.session_id);
      const roundId = String(row.round_id);
      const session = sessions.get(sessionId);
      const cutoff = cutoffs.get(roundId);
      const at = Date.parse(String(row.created_at));
      // The review page's rule: a time that cannot be read is treated as covered.
      const withdrawn = cutoff !== undefined && (!Number.isFinite(at) || at <= cutoff);
      const summary = summarizeRecording(recordings.get(sessionId) ?? null, nowMs);
      push(attemptsByRound, roundId, {
        session_id: sessionId,
        attempt_number: Number(row.attempt_number),
        counted: row.counted === true,
        outcome: text(row.outcome),
        in_progress: LIVE_SESSION_STATES.has(session?.status),
        ended_at: text(session?.ended_at),
        recording: withdrawn ? withdrawnSummary(summary) : summary,
      });
    }

    const rounds = window.rows.map((round): R1QueueRound => {
      const candidate = isRecord(round.candidates) ? round.candidates : null;
      // A join that came back without its candidate cannot prove the result may be shown.
      const withheld = candidate === null || (candidate.decision_use_blocked_at !== null && candidate.decision_use_blocked_at !== undefined);
      return {
        id: String(round.id),
        candidate_id: String(round.candidate_id),
        candidate_name: text(candidate?.name),
        status: String(round.status),
        expires_at: text(round.expires_at),
        attempts_allowed: Number(round.attempts_allowed),
        attempts_counted: Number(round.attempts_counted),
        recommendation: withheld ? null : text(round.recommendation),
        overall: withheld ? null : num(round.overall),
        status_write: withheld ? null : text(round.status_write),
        pending_reject_until: withheld ? null : text(round.pending_reject_until),
        scores_withheld: withheld,
        is_staff_dry_run: round.consent_locale === STAFF_LOCALE,
        created_at: String(round.created_at),
        attempts: attemptsByRound.get(String(round.id)) ?? [],
      };
    });

    return {
      kind: 'ok',
      body: { view: query.view, sort: query.sort, page: window.page, page_size: query.pageSize, total: window.total, rounds },
    };
  } catch {
    return UNAVAILABLE;
  }
}
