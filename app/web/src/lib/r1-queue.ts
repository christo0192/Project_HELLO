/**
 * The R1 queue, the pure half: what the address means and every sentence a row says about a result.
 * The API decides what each view holds (`lib/r1/queue.ts`); this file only names it.
 *
 * The search is not here. The address carries the view, the sort and the page, and never a name.
 */
import { R1_RESULT_WITHHELD } from './r1';
import { isPlayableState, r1RecordingStateCopy, viewState } from './r1-recording';
import { scoreCanArrive, verdictOf } from './r1-review';
import type { R1Verdict } from './r1-review';
import type { R1QueueRound, R1QueueSort, R1QueueView } from './r1-types';

export const R1_QUEUE_VIEW_OPTIONS: ReadonlyArray<{ value: R1QueueView; label: string }> = [
  { value: 'to-review', label: 'To review' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'all', label: 'All' },
];

export const R1_QUEUE_SORT_OPTIONS: ReadonlyArray<{ value: R1QueueSort; label: string }> = [
  { value: 'oldest', label: 'Oldest first' },
  { value: 'newest', label: 'Newest first' },
];

export function queueViewFrom(param: string | null): R1QueueView {
  return R1_QUEUE_VIEW_OPTIONS.find((option) => option.value === param)?.value ?? 'to-review';
}

/** To review reads whoever has waited longest first, every other view the latest first. */
export function defaultQueueSort(view: R1QueueView): R1QueueSort {
  return view === 'to-review' ? 'oldest' : 'newest';
}

export function queueSortFrom(param: string | null, view: R1QueueView): R1QueueSort {
  return R1_QUEUE_SORT_OPTIONS.find((option) => option.value === param)?.value ?? defaultQueueSort(view);
}

export function queuePageFrom(param: string | null): number {
  return param !== null && /^[1-9]\d{0,5}$/.test(param) ? Number(param) : 1;
}

const VIEW_WORDS: Readonly<Record<R1QueueView, string>> = {
  'to-review': ' to review',
  'in-progress': ' in progress',
  reviewed: ' with a settled outcome',
  all: '',
};

/** What follows the figure at the head of the page. The order means nothing for one row. */
export function queueSummary(view: R1QueueView, sort: R1QueueSort, total: number): string {
  const noun = total === 1 ? 'interview' : 'interviews';
  const order = total > 1 ? `, ${sort} first` : '';
  return `${noun}${VIEW_WORDS[view]}${order}`;
}

export type R1ResultWords = { kind: 'verdict'; verdict: R1Verdict } | { kind: 'text'; text: string };

/**
 * The AI result a row shows. A withheld round says only that, whatever it carries. A finished round with
 * no verdict waits for one only while the review page would: past that, nothing is coming.
 */
export function r1ResultWords(round: R1QueueRound, nowMs: number): R1ResultWords {
  if (round.scores_withheld) return { kind: 'text', text: R1_RESULT_WITHHELD };
  const verdict = verdictOf(round);
  if (verdict) return { kind: 'verdict', verdict };
  if (round.status_write === 'human_review') return { kind: 'text', text: 'Not scored' };
  if (round.status !== 'completed') return { kind: 'text', text: 'No result' };
  const waiting = round.attempts.some((attempt) => scoreCanArrive(attempt, round.created_at, nowMs));
  return { kind: 'text', text: waiting ? 'Not scored yet' : 'Not scored' };
}

/**
 * The recording a row names: the latest attempt with one to watch, else the latest with anything to say,
 * else the latest. A retake that left nothing must not read as "no recording" over the interview that
 * has one. Null: no attempt yet.
 */
export function queueRecordingWords(round: Pick<R1QueueRound, 'attempts'>): string | null {
  const latestFirst = [...round.attempts].reverse();
  const shown =
    latestFirst.find((attempt) => isPlayableState(viewState(attempt.recording)))
    ?? latestFirst.find((attempt) => viewState(attempt.recording) !== 'none')
    ?? latestFirst[0];
  return shown ? r1RecordingStateCopy(shown.recording).tag : null;
}
