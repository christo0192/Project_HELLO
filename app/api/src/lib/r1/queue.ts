/**
 * The read behind `GET /api/interview-rounds`: the R1 queue, one server page at a time.
 *
 * WHO SEES WHAT. The rule of the R1 video and the review page (`recording/access.ts`): admin and viewer
 * every candidate, an interviewer only a candidate they own. It is a filter on the join, not a check on
 * the rows that came back, so a page and its total only ever count what this person may see.
 *
 * THE VIEWS come from `status`, `status_write` and the link's expiry. R1 has no human-feedback record
 * yet, so "Reviewed" cannot mean that a person watched the interview. It means a status outcome has
 * settled:
 *
 *   in-progress  status is invited or in_progress and the link has not lapsed. A retake re-opens a round,
 *                so one can carry an older result here.
 *   reviewed     a finished round whose status_write is advanced, rejected (the candidate's status was
 *                written) or pending_reject_cancelled (HR overrode the rejection).
 *   to-review    every other finished round, with any other status_write or none yet (scoring has not
 *                finished).
 *   all          every round, including one that ended with nothing counted.
 *
 * FINISHED means completed, or expired or cancelled with a counted attempt. A retake re-opens a round and
 * keeps its result, so that is one whose retake lapsed or was cancelled: the interview stands. Expired or
 * cancelled with nothing counted never produced a result: nobody got through an interview, and there is
 * nothing to review.
 *
 * EXPIRED is what the candidate routes read (`effectiveRoundStatus`): the status, or an invited or
 * in_progress round past `expires_at`. The stored status cannot be left to say it. Only
 * `r1_sweep_expired_rounds` writes `expired`, no job calls it yet, and it leaves a lapsed in_progress
 * round as it is. An interview that outlasts its link reads the same way until its attempt settles
 * (the worker's residency cap is 36 minutes): out of In progress, and in All, where its row still says
 * it is running.
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
 * THE SEARCH is a candidate's name, and a name does not go in a URL: not this route's, which a browser and
 * anything logging requests can keep, and not PostgREST's, where a filter is part of the query string and
 * the response echoes it (`id-batches.ts`). So the text comes in the body of a POST
 * (`POST /api/interview-rounds/search`), the GET refuses a `q`, and no filter carries it: the view is read
 * through the same SQL filters, in page order, and the name is matched here. Who sees what and what each
 * view holds stay in SQL, so a search can only ever find what the same person could page to.
 *
 * ORDER. By the date the link was sent, then by id, so a page boundary is stable. `interview_rounds`
 * stores no finish time. The link lasts 72 hours, so sent order is close to finished order, and it does
 * not move when a round is touched, which `updated_at` would.
 *
 * SCALE. One counted `.range()` page of rounds, filtered in SQL through the `candidates!inner` join (the
 * idiom of `phone-runtime/read.ts`). Everything else is read for that page only: at most four id-batched
 * reads, however long the list grows, with no read per round. A failed read fails the page, because a
 * row with no attempts would say "no recording" about something that exists. A search is the exception:
 * it reads every round of its view, one read per 1000, because its match cannot be a filter. It fails
 * rather than miss a name past `SEARCH_MAX_PAGES`.
 */

import { chunkIds, mapChunks, readAllPages, type PageResult } from '../id-batches.js';
import type { R1DbClient } from '../../services/r1-assessment.js';
import { type R1StaffActor, seesEveryCandidate } from './recording/access.js';
import { withdrawalCutoffs } from './recording/erase.js';
import { RECORDINGS_TABLE, type R1RecordingRow } from './recording/service.js';
import { ATTEMPT_SESSION_COLUMNS, SUMMARY_COLUMNS, listedAttempt, type R1ListedAttempt } from './recording/summary.js';
import { STAFF_LOCALE } from './review.js';

export const R1_QUEUE_VIEWS = ['to-review', 'in-progress', 'reviewed', 'all'] as const;
export type R1QueueView = (typeof R1_QUEUE_VIEWS)[number];

export const R1_QUEUE_SORTS = ['oldest', 'newest'] as const;
export type R1QueueSort = (typeof R1_QUEUE_SORTS)[number];

export const R1_QUEUE_PAGE_SIZE = 25;
export const R1_QUEUE_MAX_PAGE_SIZE = 50;
export const R1_QUEUE_MAX_SEARCH = 100;

/** A runaway bound on one id batch. A round has at most three starts, so one page always ends it. */
const MAX_PAGES = 2;

/** A search reads its whole view, up to here: 50,000 rounds. */
const SEARCH_MAX_PAGES = 50;

/** The writes that settle a round: the candidate's status changed, or HR overrode the rejection (0122). */
const SETTLED_WRITES = ['advanced', 'rejected', 'pending_reject_cancelled'] as const;
const SETTLED_LIST = SETTLED_WRITES.join(',');

/** The statuses a round has while its link can still be used. */
const OPEN_STATUSES = ['invited', 'in_progress'] as const;
const OPEN_LIST = OPEN_STATUSES.join(',');

/** `not.in` on a NULL is NULL, so the unwritten round needs its own branch. */
const UNSETTLED = `or(status_write.is.null,status_write.not.in.(${SETTLED_LIST}))`;

/** A round that is over because its time ran out, stored as such or not: `effectiveRoundStatus` in SQL. */
const expiredBranches = (nowIso: string): string =>
  `status.eq.expired,and(status.in.(${OPEN_LIST}),expires_at.lte.${nowIso})`;

/** A round that ended short of completing, which is finished only with a counted attempt behind it. */
const endedShort = (nowIso: string): string => `or(status.eq.cancelled,${expiredBranches(nowIso)})`;

const toReviewFilter = (nowIso: string): string =>
  `and(status.eq.completed,${UNSETTLED}),and(attempts_counted.gt.0,${UNSETTLED},${endedShort(nowIso)})`;

const reviewedFilter = (nowIso: string): string =>
  `status.eq.completed,and(attempts_counted.gt.0,${endedShort(nowIso)})`;

const ROUND_COLUMNS =
  'id,candidate_id,status,expires_at,attempts_allowed,attempts_counted,recommendation,overall,status_write,'
  + 'pending_reject_until,consent_locale,created_at';
const CANDIDATE_EMBED = 'candidates!inner(name,decision_use_blocked_at)';
const ATTEMPT_COLUMNS = 'session_id,round_id,attempt_number,counted,outcome,created_at';

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
  attempts: R1ListedAttempt[];
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

/**
 * The query string, and the search text from a POST's body, or null when any part of it is not one this
 * route takes. A `q` in the query string is refused, not ignored: a name would already be in the URL, and
 * the unfiltered page answered would read as what was found.
 */
export function parseR1QueueQuery(query: Record<string, unknown>, searchText: unknown = ''): R1QueueQuery | null {
  const view = query.view === undefined ? 'to-review' : query.view;
  if (!R1_QUEUE_VIEWS.includes(view as R1QueueView)) return null;
  // "To review, oldest first": whoever has waited longest. Every other view reads newest first.
  const sort = query.sort === undefined ? (view === 'to-review' ? 'oldest' : 'newest') : query.sort;
  if (!R1_QUEUE_SORTS.includes(sort as R1QueueSort)) return null;
  const page = positiveInt(query.page, 1);
  const pageSize = positiveInt(query.page_size, R1_QUEUE_PAGE_SIZE);
  if (page === null || pageSize === null || pageSize > R1_QUEUE_MAX_PAGE_SIZE) return null;
  if (query.q !== undefined) return null;
  if (typeof searchText !== 'string' || searchText.length > R1_QUEUE_MAX_SEARCH) return null;
  if (query.dry_runs !== undefined && query.dry_runs !== 'include') return null;
  return {
    view: view as R1QueueView,
    sort: sort as R1QueueSort,
    page,
    pageSize,
    search: searchText.trim(),
    includeDryRuns: query.dry_runs === 'include',
  };
}

/** The rounds this person may see in this view: a page of them, all of them, or only how many there are. */
function roundsRead(db: R1DbClient, actor: R1StaffActor, query: R1QueueQuery, nowMs: number) {
  const nowIso = new Date(nowMs).toISOString();
  const filtered = (columns: string, options?: { count: 'exact'; head?: boolean }) => {
    let read = db.from('interview_rounds').select(columns, options);
    if (!seesEveryCandidate(actor)) read = read.eq('candidates.owner_id', actor.id);
    if (!query.includeDryRuns) read = read.neq('consent_locale', STAFF_LOCALE);
    if (query.view === 'in-progress') read = read.in('status', [...OPEN_STATUSES]).gt('expires_at', nowIso);
    if (query.view === 'to-review') read = read.or(toReviewFilter(nowIso));
    if (query.view === 'reviewed') read = read.or(reviewedFilter(nowIso)).in('status_write', [...SETTLED_WRITES]);
    if (query.view === 'to-review' || query.view === 'reviewed') read = read.is('candidates.decision_use_blocked_at', null);
    return read;
  };
  const inPageOrder = (options?: { count: 'exact' }) => filtered(`${ROUND_COLUMNS},${CANDIDATE_EMBED}`, options)
    .order('created_at', { ascending: query.sort === 'oldest' })
    .order('id', { ascending: true });
  return {
    count: () => filtered(`id,${CANDIDATE_EMBED}`, { count: 'exact', head: true }),
    page: (from: number, to: number) => inPageOrder({ count: 'exact' }).range(from, to),
    // Uncounted: a view of exactly 1000 rounds ends on a read past the end, which is refused when counted.
    scan: (from: number, to: number) => inPageOrder().range(from, to),
  };
}

interface RoundsWindow {
  rows: Row[];
  total: number;
  page: number;
}

function candidateNameOf(round: Row): string | null {
  return isRecord(round.candidates) ? text(round.candidates.name) : null;
}

/**
 * The page asked for out of what a search found, or its last page. Each round counts once: one sent while
 * a newest-first read is between pages moves the rows along, and brings the last of a page round again.
 */
async function searchRoundsWindow(reads: ReturnType<typeof roundsRead>, query: R1QueueQuery): Promise<RoundsWindow | null> {
  const scanned = await readAllPages<Row>(reads.scan, SEARCH_MAX_PAGES);
  if (!scanned.ok) return null;
  const wanted = query.search.toLowerCase();
  const found = [...new Map(scanned.rows.map((round) => [String(round.id), round])).values()]
    .filter((round) => candidateNameOf(round)?.toLowerCase().includes(wanted));
  const page = Math.min(query.page, Math.max(1, Math.ceil(found.length / query.pageSize)));
  const from = (page - 1) * query.pageSize;
  return { rows: found.slice(from, from + query.pageSize), total: found.length, page };
}

/**
 * The page asked for, or the last page when it runs past the end: a link kept while rounds left the
 * view is not an error. PostgREST refuses a counted read past the end outright (PGRST103, 416), so the
 * total then needs a read of its own. Null when a read failed.
 */
async function readRoundsWindow(db: R1DbClient, actor: R1StaffActor, query: R1QueueQuery, nowMs: number): Promise<RoundsWindow | null> {
  const reads = roundsRead(db, actor, query, nowMs);
  if (query.search !== '') return searchRoundsWindow(reads, query);
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
    const window = await readRoundsWindow(db, actor, query, nowMs);
    if (window === null) return UNAVAILABLE;
    const roundIds = window.rows.map((round) => String(round.id));

    const [attemptRows, recordingRows, sessionRows, cutoffs] = roundIds.length === 0
      ? [[], [], [], new Map<string, number>()]
      : await Promise.all([
          readForRounds(roundIds, (chunk) => db.from('interview_round_attempts').select(ATTEMPT_COLUMNS).in('round_id', chunk)
            .order('attempt_number', { ascending: true }).order('created_at', { ascending: true }).order('session_id', { ascending: true })),
          readForRounds(roundIds, (chunk) => db.from(RECORDINGS_TABLE).select(SUMMARY_COLUMNS).in('round_id', chunk)
            .order('session_id', { ascending: true })),
          readForRounds(roundIds, (chunk) => db.from('call_sessions').select(ATTEMPT_SESSION_COLUMNS).in('interview_round_id', chunk)
            .order('id', { ascending: true })),
          withdrawalCutoffs(db, roundIds),
        ]);
    if (attemptRows === null || recordingRows === null || sessionRows === null) return UNAVAILABLE;

    const sessions = new Map(sessionRows.map((row) => [String(row.id), row]));
    const recordings = new Map((recordingRows as unknown as R1RecordingRow[]).map((row) => [row.session_id, row]));
    const attemptsByRound = new Map<string, R1ListedAttempt[]>();
    for (const row of attemptRows) {
      const sessionId = String(row.session_id);
      const roundId = String(row.round_id);
      push(attemptsByRound, roundId, listedAttempt(row, sessions.get(sessionId), recordings.get(sessionId) ?? null, cutoffs.get(roundId), nowMs));
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
