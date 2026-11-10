/**
 * How the Business impact page prints its figures (M031 S6), as pure
 * functions, so the rules a reader cannot audit from the screen are asserted
 * directly:
 *
 *   - A figure that is not known is a dash, never a 0. Ashby-side figures are
 *     null while Ashby stages are not being read, and a null is not "nobody".
 *   - Steps nest, so no share is over 100%. A share outside 0..1 is a bug, and
 *     it prints a dash rather than a number someone might believe.
 *   - A timing on a small n is withheld by the API; the page says so and keeps n.
 *   - The weeks filter is IST weeks starting on a Monday, the current week
 *     included, the same weeks the cohorts are counted in.
 */

import { formatDate, formatRelative } from './datetime';
import { humanizeEnum } from './humanize';
import { addIstDays, isIstDate, istDayStartUtcIso, istToday, istWeekStart, IST_TIME_ZONE } from './ist-datetime';
import { IMPACT_ASHBY_TIMING_KEYS, type ImpactMeta, type ImpactReasonType, type ImpactTiming, type ImpactTimingKey } from './impact-types';

export const DASH = '—';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A count, or a dash when it is not known. */
export function formatCount(value: number | null | undefined): string {
  return isFiniteNumber(value) ? value.toLocaleString() : DASH;
}

/**
 * A fraction 0..1 as a percent: whole from 10%, one decimal under it, where
 * Offer and Hired sit and a whole percent would round a real 1.4% to 1%.
 */
export function formatShare(share: number | null | undefined): string {
  if (!isFiniteNumber(share)) return DASH;
  // A rounding hair either side is still the whole; anything further is a bug.
  if (share < -1e-9 || share > 1 + 1e-9) return DASH;
  const percent = Math.min(100, Math.max(0, share * 100));
  if (percent === 0) return '0%';
  if (percent < 0.05) return '<0.1%';
  if (percent < 10) return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
  return `${Math.round(percent)}%`;
}

/** A count's share of its whole, or null when there is no whole or the count does not fit in it. */
export function shareOf(count: number | null | undefined, whole: number | null | undefined): number | null {
  if (!isFiniteNumber(count) || !isFiniteNumber(whole) || whole <= 0) return null;
  if (count < 0 || count > whole) return null;
  return count / whole;
}

/** Days: one decimal under 10, whole days from 10. */
export function formatDays(days: number | null | undefined): string {
  if (!isFiniteNumber(days)) return DASH;
  if (days < 10) return days.toFixed(1).replace(/\.0$/, '');
  return String(Math.round(days));
}

export interface TimingView {
  median: string;
  p90: string;
  n: string;
  /**
   * `known`: a median to print. `too_small`: the API withheld it because n is
   * under its floor. `unknown`: no median and no reason to blame n, such as an
   * Ashby-side timing while Ashby stages are not read: every column a dash.
   */
  state: 'known' | 'too_small' | 'unknown';
}

const ASHBY_TIMINGS: ReadonlySet<ImpactTimingKey> = new Set(IMPACT_ASHBY_TIMING_KEYS);

export function timingView(timing: ImpactTiming, context: { minTimingN: number; ashbyRead: boolean }): TimingView {
  // Not read is not "fewer than five": the n of 0 that comes with it is not a count either.
  if (!context.ashbyRead && ASHBY_TIMINGS.has(timing.key)) return { median: DASH, p90: DASH, n: DASH, state: 'unknown' };
  const n = formatCount(timing.n);
  if (isFiniteNumber(timing.medianDays)) {
    return { median: formatDays(timing.medianDays), p90: formatDays(timing.p90Days), n, state: 'known' };
  }
  // The API withholds a median only under the floor. A missing one at or above it is not known.
  if (isFiniteNumber(timing.n) && timing.n < context.minTimingN) return { median: 'n too small', p90: DASH, n, state: 'too_small' };
  return { median: DASH, p90: DASH, n, state: 'unknown' };
}

/** Ashby stages are being read: the worker is on and has checked at least one application. */
export function ashbyStagesRead(meta: ImpactMeta): boolean {
  return meta.progressEnabled === true && meta.coverage.checked > 0;
}

export function freshnessLine(meta: ImpactMeta, now: Date = new Date()): string {
  const coverage = `${formatCount(meta.coverage.checked)} of ${formatCount(meta.coverage.total)} applications`;
  return meta.lastPassAt
    ? `Ashby stages checked ${formatRelative(meta.lastPassAt, now)}, ${coverage}`
    : `Ashby stages not checked yet, ${coverage}`;
}

export function staleLine(meta: ImpactMeta): string | null {
  const n = meta.staleRows;
  if (!isFiniteNumber(n) || n <= 0) return null;
  return n === 1 ? '1 application is due a fresh check.' : `${formatCount(n)} applications are due a fresh check.`;
}

export function unlabelledNotice(meta: ImpactMeta): string | null {
  const n = meta.unlabelledStages;
  if (!isFiniteNumber(n) || n <= 0) return null;
  return n === 1
    ? '1 Ashby stage has no milestone label yet. Applications in it show as Other and do not count towards R1, R2 or Offer until an admin labels it.'
    : `${formatCount(n)} Ashby stages have no milestone label yet. Applications in them show as Other and do not count towards R1, R2 or Offer until an admin labels them.`;
}

// ── The weeks filter ─────────────────────────────────────────────────────

export type ImpactWeeks = '4' | '12' | '26' | 'all';

export const IMPACT_WEEK_OPTIONS: ReadonlyArray<{ value: ImpactWeeks; label: string }> = [
  { value: '4', label: '4 weeks' },
  { value: '12', label: '12 weeks' },
  { value: '26', label: '26 weeks' },
  { value: 'all', label: 'All' },
];

/** The contract's default window. */
export const DEFAULT_IMPACT_WEEKS: ImpactWeeks = '12';

/**
 * "All" still sends a start date, because the summary's default is 12 weeks.
 * HELLO first imported an Ashby application in August 2026 (migration 0029),
 * so nothing is older than this.
 */
export const IMPACT_ALL_FROM = '2026-01-01';

export function weeksFrom(param: string | null): ImpactWeeks {
  return IMPACT_WEEK_OPTIONS.find((option) => option.value === param)?.value ?? DEFAULT_IMPACT_WEEKS;
}

/** The IST dates the summary is asked for: whole IST weeks, the current one included. */
export function weeksWindow(weeks: ImpactWeeks, now: Date = new Date()): { from: string; to: string } {
  const to = istToday(now);
  if (weeks === 'all') return { from: IMPACT_ALL_FROM, to };
  return { from: addIstDays(istWeekStart(to), -7 * (Number(weeks) - 1)), to };
}

export function weeksPhrase(weeks: ImpactWeeks): string {
  return weeks === 'all' ? 'All weeks' : `Last ${weeks} weeks`;
}

// ── Cohorts, stages, reasons ─────────────────────────────────────────────

/** "2 Nov 2026": the IST Monday a cohort week starts on. */
export function cohortWeekLabel(weekStart: string): string {
  if (!isIstDate(weekStart)) return DASH;
  return formatDate(istDayStartUtcIso(weekStart), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: IST_TIME_ZONE,
  });
}

const MILESTONE_LABELS: Readonly<Record<string, string>> = {
  christy: 'Christy stage',
  moved_forward: 'Moved forward',
  r1: 'R1',
  r2: 'R2',
  r3: 'R3',
  r4: 'R4',
  r5: 'R5',
  offer: 'Offer',
  hired: 'Hired',
  archived: 'Archived',
  lead: 'Lead',
  other: 'Other',
};

/** A stage's milestone in words, or null when it has none. */
export function milestoneLabel(milestone: string | null | undefined): string | null {
  if (!milestone) return null;
  return humanizeEnum(milestone, MILESTONE_LABELS) || null;
}

export const REASON_TYPE_ORDER: readonly ImpactReasonType[] = ['rejected_by_org', 'rejected_by_candidate', 'other', 'none'];

export const REASON_TYPE_LABEL: Readonly<Record<ImpactReasonType, string>> = {
  rejected_by_org: 'Rejected by us',
  rejected_by_candidate: 'Withdrew',
  other: 'Other',
  none: 'No reason recorded',
};

export interface ReasonTypeRow {
  type: ImpactReasonType;
  label: string;
  count: string;
  share: string;
}

/** The archive reasons at one stage, by type, in a fixed order, each with its share of the stage. */
export function reasonTypeRows(
  byReasonType: Partial<Record<ImpactReasonType, number>>,
  archived: number,
): ReasonTypeRow[] {
  return REASON_TYPE_ORDER.map((type) => {
    const count = byReasonType[type];
    return {
      type,
      label: REASON_TYPE_LABEL[type],
      count: formatCount(count),
      share: formatShare(shareOf(count, archived)),
    };
  });
}
