/**
 * R1 interviews: the queue of R1 rounds across candidates, one server page at a time.
 *
 *   /interviews?view=to-review|in-progress|reviewed|all&sort=oldest|newest&page=n&dry_runs=include
 *
 * It opens on To review, oldest first. The API decides what each view holds and who sees which round
 * (`GET /api/interview-rounds`), so the rows and the total are only ever what this person may read.
 *
 * The search stays out of the address: it is a candidate's name, and a name does not go in a URL, in a
 * browser's history or in a link passed along. Leaving the page drops it.
 *
 * A read that changes what is shown clears the rows first: a list under the wrong tab reads as true.
 * Each block keeps its size while it loads, and nothing rises in.
 *
 * Verdicts stay in ink. A row's result is the AI's, and the column says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import {
  EmptyPanel,
  ErrorPanel,
  Pagination,
  SegmentedControl,
  Skeleton,
  Switch,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
} from '../components/design';
import { CandidateInput, Tag } from '../components/design/candidate';
import { VerdictMark } from '../components/r1-review/VerdictBlock';
import { CandidateShell } from '../components/talent/CandidateShell';
import { candidateDisplayName } from '../components/talent/ResumeReviewBadge';
import { formatDate, formatDateTime, formatRelative } from '../lib/datetime';
import { attemptsLabel } from '../lib/r1';
import {
  R1_QUEUE_SORT_OPTIONS,
  R1_QUEUE_VIEW_OPTIONS,
  defaultQueueSort,
  queuePageFrom,
  queueRecordingWords,
  queueSortFrom,
  queueSummary,
  queueViewFrom,
  r1ResultWords,
} from '../lib/r1-queue';
import { rejectionPendingUntil, roundStatusWord } from '../lib/r1-review';
import type { R1QueueResponse, R1QueueRound, R1QueueSort, R1QueueView } from '../lib/r1-types';

/** How long the typing must stop before a search goes to the API. */
const SEARCH_WAIT_MS = 250;

const SKELETON_ROWS = 6;

const EMPTY_WORDS: Readonly<Record<R1QueueView, { title: string; hint?: string }>> = {
  'to-review': { title: 'Nothing is waiting for review.', hint: 'A finished interview appears here until its outcome is settled.' },
  'in-progress': { title: 'No R1 interview is in progress.' },
  reviewed: { title: 'No R1 interview has a settled outcome yet.', hint: 'An outcome is settled when the candidate’s status is written, or a rejection is cancelled.' },
  all: { title: 'No R1 interview has been sent yet.' },
};

type Load =
  | { status: 'loading' }
  | { status: 'ready'; key: string; answer: R1QueueResponse }
  | { status: 'error'; key: string; message: string };

/** ErrorPanel puts it in plain words, so it needs only what was thrown. */
function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}

const RESULT_CELL = 'inline-flex items-center gap-2 whitespace-nowrap';

function ResultCell({ round, nowMs }: { round: R1QueueRound; nowMs: number }) {
  const result = r1ResultWords(round, nowMs);
  if (result.kind === 'text') return <span className="text-label text-ink-secondary">{result.text}</span>;
  const { word, mark, overall } = result.verdict;
  return (
    <span className={RESULT_CELL}>
      <VerdictMark mark={mark} />
      <span className="font-medium">{word}</span>
      {overall !== null && <span className="tabular-nums text-ink-secondary">{Math.round(overall)}</span>}
    </span>
  );
}

/** The last attempt to end, for "Ended 2 days ago". */
function lastEnded(round: R1QueueRound): string | null {
  return round.attempts.reduce<string | null>((latest, attempt) => {
    if (!attempt.ended_at) return latest;
    return latest === null || Date.parse(attempt.ended_at) > Date.parse(latest) ? attempt.ended_at : latest;
  }, null);
}

function QueueRow({ round, listSearch }: { round: R1QueueRound; listSearch: string }) {
  const name = candidateDisplayName(round.candidate_name);
  const nowMs = Date.now();
  const status = roundStatusWord(round, round.attempts, nowMs);
  const recording = queueRecordingWords(round);
  const ended = lastEnded(round);
  const pending = rejectionPendingUntil(round);
  return (
    <Tr>
      <Td className="py-2.5">
        <Link
          to={`/interviews/${round.id}`}
          state={{ listSearch }}
          className="font-medium text-ink underline underline-offset-2 hover:text-ink-secondary focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
        >
          {name}
        </Link>
        {round.is_staff_dry_run && <span className="ml-2"><Tag>Staff dry run</Tag></span>}
        {/* The columns this width has no room for, in one line. */}
        <p className="mt-0.5 text-meta text-ink-tertiary md:hidden">
          {[status, attemptsLabel(round), recording ? `Recording: ${recording}` : null].filter(Boolean).join(' · ')}
        </p>
        {pending && <p className="text-meta text-ink-tertiary md:hidden">Rejection pending until {formatDateTime(pending)}</p>}
      </Td>
      <Td className="py-2.5"><ResultCell round={round} nowMs={nowMs} /></Td>
      <Td className="hidden py-2.5 md:table-cell">
        <span className="text-label">{status}</span>
        {pending && <p className="text-meta text-ink-tertiary">Rejection pending until {formatDateTime(pending)}</p>}
      </Td>
      <Td className="hidden whitespace-nowrap py-2.5 text-label text-ink-secondary md:table-cell">{attemptsLabel(round)}</Td>
      <Td className="hidden py-2.5 md:table-cell">
        {recording ? (
          <Tag srPrefix="Recording:">{recording}</Tag>
        ) : (
          <>
            <span aria-hidden="true">–</span>
            <span className="sr-only">No attempt yet</span>
          </>
        )}
      </Td>
      <Td className="hidden whitespace-nowrap py-2.5 md:table-cell">
        <span className="text-label">{formatDate(round.created_at)}</span>
        {ended && <p className="text-meta text-ink-tertiary">Ended {formatRelative(ended)}</p>}
      </Td>
    </Tr>
  );
}

const HEADERS: ReadonlyArray<{ label: string; wide?: boolean }> = [
  { label: 'Candidate' },
  { label: 'AI recommendation' },
  { label: 'Status', wide: true },
  { label: 'Attempts', wide: true },
  { label: 'Recording', wide: true },
  { label: 'Sent', wide: true },
];

function QueueTable({ rounds, listSearch }: { rounds: readonly R1QueueRound[]; listSearch: string }) {
  return (
    <Table bare caption="R1 interviews">
      <THead>
        <tr>
          {HEADERS.map(({ label, wide }) => (
            <Th key={label} className={wide ? 'hidden md:table-cell' : undefined}>{label}</Th>
          ))}
        </tr>
      </THead>
      <TBody>
        {rounds.map((round) => <QueueRow key={round.id} round={round} listSearch={listSearch} />)}
      </TBody>
    </Table>
  );
}

/** The rows at their final height, so the page does not move when the answer lands. */
function QueueSkeleton() {
  return (
    <div role="status" aria-label="Loading R1 interviews" className="divide-y divide-line">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="flex h-14 items-center gap-6">
          <Skeleton width="30%" height={16} radius={3} />
          <Skeleton width="20%" height={16} radius={3} />
        </div>
      ))}
    </div>
  );
}

export function R1InterviewsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // A row hands this to the review, so its breadcrumb comes back to the same view and page.
  const { search: listSearch } = useLocation();
  const view = queueViewFrom(searchParams.get('view'));
  const sort = queueSortFrom(searchParams.get('sort'), view);
  const page = queuePageFrom(searchParams.get('page'));
  const includeDryRuns = searchParams.get('dry_runs') === 'include';

  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [readKey, setReadKey] = useState(0);

  const changeAddress = useCallback(
    (change: (params: URLSearchParams) => void) => {
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          change(params);
          return params;
        },
        // Filtering a list is not a navigation: Back leaves the queue.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // The search commits when the typing stops, and starts again from the first page.
  const committed = useRef('');
  useEffect(() => {
    const next = draft.trim();
    if (next === committed.current) return undefined;
    const timer = setTimeout(() => {
      committed.current = next;
      setSearch(next);
      changeAddress((params) => params.delete('page'));
    }, SEARCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [draft, changeAddress]);

  const requestKey = useMemo(
    () => JSON.stringify({ view, sort, page, search, includeDryRuns, readKey }),
    [view, sort, page, search, includeDryRuns, readKey],
  );

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.listR1Queue({ view, sort, page, search, includeDryRuns }))
      .then((answer) => {
        if (!live) return;
        // The API answered its last page: the address follows it, and the read that causes fills the page.
        if (answer.page !== page) {
          changeAddress((params) => {
            if (answer.page === 1) params.delete('page');
            else params.set('page', String(answer.page));
          });
          return;
        }
        setLoad({ status: 'ready', key: requestKey, answer });
      })
      .catch((error: unknown) => {
        if (live) setLoad({ status: 'error', key: requestKey, message: messageOf(error) });
      });
    return () => {
      live = false;
    };
  }, [view, sort, page, search, includeDryRuns, requestKey, changeAddress]);

  const selectView = useCallback(
    (next: R1QueueView) => {
      changeAddress((params) => {
        if (next === 'to-review') params.delete('view');
        else params.set('view', next);
        params.delete('sort');
        params.delete('page');
      });
    },
    [changeAddress],
  );

  const selectSort = useCallback(
    (next: R1QueueSort) => {
      changeAddress((params) => {
        if (next === defaultQueueSort(view)) params.delete('sort');
        else params.set('sort', next);
        params.delete('page');
      });
    },
    [changeAddress, view],
  );

  const toggleDryRuns = useCallback(
    (next: boolean) => {
      changeAddress((params) => {
        if (next) params.set('dry_runs', 'include');
        else params.delete('dry_runs');
        params.delete('page');
      });
    },
    [changeAddress],
  );

  const answer = load.status === 'ready' && load.key === requestKey ? load.answer : null;
  const failed = load.status === 'error' && load.key === requestKey ? load.message : null;
  const total = answer?.total ?? 0;
  const pageSize = answer?.page_size ?? 25;
  const from = total === 0 ? 0 : ((answer?.page ?? 1) - 1) * pageSize + 1;

  return (
    <CandidateShell variant="inset">
      <h1 className="text-title text-ink">R1 interviews</h1>

      <p data-testid="queue-summary" className="mt-3 flex min-h-9 items-baseline gap-2 text-sm text-ink">
        {answer ? (
          <>
            <span className="text-stat tabular-nums">{answer.total}</span>{' '}
            <span>{queueSummary(view, sort, answer.total)}</span>
          </>
        ) : (
          !failed && <Skeleton width="16rem" height={24} radius={3} />
        )}
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl ariaLabel="Interviews to show" value={view} onChange={selectView} options={R1_QUEUE_VIEW_OPTIONS} />
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <SegmentedControl size="sm" ariaLabel="Order" value={sort} onChange={selectSort} options={R1_QUEUE_SORT_OPTIONS} />
          <label className="min-w-0">
            <span className="sr-only">Find a candidate by name</span>
            <CandidateInput
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={100}
              placeholder="Find by name"
              autoComplete="off"
              className="w-56 max-w-full sm:min-h-9 sm:py-1.5"
            />
          </label>
        </div>
      </div>

      <div className="mt-4">
        {failed !== null ? (
          <ErrorPanel message={failed} onRetry={() => setReadKey((key) => key + 1)} />
        ) : answer === null ? (
          <QueueSkeleton />
        ) : answer.rounds.length === 0 ? (
          <EmptyPanel
            title={search ? 'No interview in this view matches that name.' : EMPTY_WORDS[view].title}
            hint={search ? undefined : EMPTY_WORDS[view].hint}
          />
        ) : (
          <>
            <QueueTable rounds={answer.rounds} listSearch={listSearch} />
            <Pagination
              noun="interviews"
              hidePageSize
              state={{
                page: answer.page,
                pageSize: 25, // The type names the page sizes; this page never shows the select.
                pageCount: Math.max(1, Math.ceil(total / pageSize)),
                total,
                from,
                to: Math.min(total, from + pageSize - 1),
                setPage: (next) => changeAddress((params) => {
                  if (next <= 1) params.delete('page');
                  else params.set('page', String(next));
                }),
                setPageSize: () => undefined,
              }}
            />
          </>
        )}
      </div>

      <div className="mt-4 w-56 max-w-full">
        <Switch size="sm" checked={includeDryRuns} onCheckedChange={toggleDryRuns} label="Show staff dry runs" />
      </div>
    </CandidateShell>
  );
}
