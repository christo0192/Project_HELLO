/**
 * BarList — a breakdown of one whole into a few categories, as horizontal
 * bars with the count and the share printed beside each.
 *
 * It replaces the dashboard donuts. A donut for three to seven categories
 * asks the reader to compare arc lengths around a circle, which people do
 * badly, and it hid the actual numbers in a legend underneath. Bars on a
 * common baseline compare at a glance, and the figures sit on the same row
 * as their bar, so nothing has to be matched by colour.
 *
 * SEMANTICS. The list IS a data table: a row header per category, then the
 * count and the share. So the text alternative is not an sr-only duplicate
 * bolted on beside a picture (as every canvas chart needs, see
 * `ChartDataTable`); it is the visible structure itself, captioned
 * "<title> data" like the chart tables. The bars are `aria-hidden`: the
 * figures carry the meaning, the bars only make it glanceable.
 *
 * ORDER. Ranked by count by default, because "which is biggest" is the
 * question a breakdown answers. `order="none"` keeps the caller's order for
 * categories that have a real sequence of their own (pipeline stages), where
 * re-sorting by size would scramble the process the reader knows.
 *
 * SCALE. A full bar is the largest row (they compare to each other, and the
 * printed share carries the proportion), or with `scale="total"` the whole.
 * Only a whole-scaled bar gets a grey track: a track says "out of 100%",
 * which a bar scaled to the leader is not.
 *
 * COLOUR. A bar with no meaning of its own is ink. A category that carries one
 * (a pipeline stage, advance / hold / reject) passes its tone, and the figures
 * stay ink: the mark beside the text carries the identity. `info` means the moving
 * family here, as in StatusBadge, and a stage may pass a step of its family
 * (components/design/tones.ts). Colour is never the only signal: the label is
 * always printed.
 */
import { Link } from 'react-router-dom';
import { cx } from '../design/cx';
import { Skeleton } from '../design/Skeleton';
import type { StatusTone } from '../design/StatusBadge';
import type { MarkTone } from '../design/tones';
import { ChartEmpty, ChartError } from './states';
import { shareLabel } from './series';

export type BarTone = StatusTone | MarkTone | 'ink';

const FILL: Record<BarTone, string> = {
  ink: 'bg-ink',
  'ink-2': 'bg-ink-secondary',
  neutral: 'bg-ink-muted',
  info: 'bg-moving',
  'moving-light': 'bg-moving-light',
  moving: 'bg-moving',
  'moving-deep': 'bg-moving-deep',
  success: 'bg-success',
  'ready-light': 'bg-ready-light',
  ready: 'bg-ready',
  warning: 'bg-warning',
  'unresolved-light': 'bg-unresolved-light',
  unresolved: 'bg-unresolved',
  closed: 'bg-closed',
  'closed-light': 'bg-closed-light',
  danger: 'bg-error',
};

export interface BarListDatum {
  label: string;
  value: number;
  /** Drill-down target: the label becomes a router link. */
  href?: string;
  tone?: BarTone;
  /** The raw machine value, one hover away for an operator. */
  title?: string;
}

export interface BarListProps {
  /** Names the table ("<title> data"), matching the chart tables. */
  title: string;
  data: BarListDatum[];
  /** Header of the category column, for screen readers. */
  categoryHeader?: string;
  /** Header of the count column, for screen readers. */
  valueHeader?: string;
  /** Denominator of the share and the bar. Defaults to the sum of `data`. */
  total?: number;
  /** `desc` ranks by count; `none` keeps a sequence that means something. */
  order?: 'desc' | 'none';
  /** Hide the share column when the rows are not parts of one whole. */
  showShare?: boolean;
  /**
   * What a full bar means. `peak` (default): the largest row, so rows compare
   * to each other; the printed share carries the exact proportion. `total`:
   * the whole, for rows that are overlapping facts about one set ("2 of 3
   * policies enabled"), where a full bar must mean "all of them".
   */
  scale?: 'peak' | 'total';
  /** Appended to each link's name, e.g. "View these candidates." */
  linkHint?: string;
  isLoading?: boolean;
  /**
   * Rows the loading state draws, each as tall as a real row. The count is the
   * data's, so a caller that knows its usual size passes it here and the panel
   * does not grow under the reader when the data lands.
   */
  loadingRows?: number;
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyHint?: string;
  className?: string;
}

/** The loading rows' bar lengths, repeated as far as `loadingRows` asks. */
const LOADING_WIDTHS = [0.8, 0.55, 0.35];

export function BarList({
  title,
  data,
  categoryHeader = 'Category',
  valueHeader = 'Count',
  total,
  order = 'desc',
  showShare = true,
  scale = 'peak',
  linkHint,
  isLoading = false,
  loadingRows = LOADING_WIDTHS.length,
  error = null,
  onRetry,
  emptyTitle = 'Nothing to show yet',
  emptyHint,
  className,
}: BarListProps) {
  if (isLoading) {
    return (
      <div className={className} role="status" aria-label={`Loading ${title}`}>
        {/* A real row's height: the link's target plus the cell's 1px padding. */}
        {Array.from({ length: loadingRows }, (_, i) => (
          <div key={i} className="flex min-h-[46px] items-center gap-3 sm:min-h-[34px]">
            <Skeleton width="6.5rem" height={12} />
            <Skeleton
              className="flex-1"
              height={6}
              style={{ maxWidth: `${LOADING_WIDTHS[i % LOADING_WIDTHS.length] * 100}%` }}
            />
          </div>
        ))}
      </div>
    );
  }
  if (error) return <ChartError message={error} onRetry={onRetry} />;

  const rows = order === 'desc' ? [...data].sort((a, b) => b.value - a.value) : data;
  const whole = total ?? data.reduce((sum, d) => sum + d.value, 0);
  const peak = Math.max(0, ...rows.map((d) => d.value));
  if (rows.length === 0 || whole <= 0) {
    return <ChartEmpty title={emptyTitle} hint={emptyHint} />;
  }

  return (
    <table className={cx('w-full table-fixed border-collapse text-label', className)}>
      <caption className="sr-only">{title} data</caption>
      <colgroup>
        <col />
        <col className="w-11" />
        {showShare && <col className="w-11" />}
      </colgroup>
      {/* Column headers for assistive tech only. The header CELLS stay in the
          table (zero height, text visually hidden) rather than hiding the
          whole row group: a positioned-away <thead> can drop out of the
          browser's table semantics and take the headers with it. */}
      <thead>
        <tr>
          <th scope="col" className="h-0 p-0"><span className="sr-only">{categoryHeader}</span></th>
          <th scope="col" className="h-0 p-0"><span className="sr-only">{valueHeader}</span></th>
          {showShare && <th scope="col" className="h-0 p-0"><span className="sr-only">Share</span></th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const share = shareLabel(row.value, whole);
          // By default bars are measured against the LARGEST row, so the leader
          // spans the track and the rest compare to it. Against the whole,
          // seven stages of ~15% each drew as seven indistinguishable stubs.
          const full = scale === 'total' ? whole : peak;
          const pct = full > 0 ? Math.max(0, Math.min(100, (row.value / full) * 100)) : 0;
          const name = `${row.label}: ${row.value.toLocaleString()}${showShare ? ` (${share})` : ''}.${linkHint ? ` ${linkHint}` : ''}`;
          return (
            <tr key={row.label}>
              <th scope="row" className="pr-3 text-left font-normal">
                <div className="flex min-w-0 items-center gap-3">
                  {/* No overflow clipping on this wrapper: it would cut off
                      the link's focus ring. The label itself truncates. */}
                  <span className="w-[7.25rem] shrink-0" title={row.title ?? row.label}>
                    {row.href ? (
                      <Link
                        to={row.href}
                        aria-label={name}
                        className="flex min-h-11 items-center rounded-md text-ink-secondary underline-offset-4 transition-colors duration-hover ease-out hover:text-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-info sm:min-h-8"
                      >
                        <span className="truncate">{row.label}</span>
                      </Link>
                    ) : (
                      <span className="flex min-h-8 items-center text-ink-secondary">
                        <span className="truncate">{row.label}</span>
                      </span>
                    )}
                  </span>
                  <span
                    aria-hidden="true"
                    className={cx(
                      'h-2 min-w-0 flex-1',
                      // Only a whole-scaled bar has a track: there a full
                      // track does mean "all of them".
                      scale === 'total' && 'overflow-hidden rounded-chip bg-ink/[0.06]',
                    )}
                  >
                    <Fill pct={pct} className={FILL[row.tone ?? 'ink']} />
                  </span>
                </div>
              </th>
              <td className="text-right text-sm font-semibold tabular-nums text-ink">
                {row.value.toLocaleString()}
              </td>
              {showShare && (
                <td className="pl-2 text-right tabular-nums text-ink-tertiary">{share}</td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The fill is printed at its share. Nothing grows in. */
function Fill({ pct, className }: { pct: number; className: string }) {
  return <span className={cx('data-fill block h-full rounded-chip', className)} style={{ width: `${pct}%` }} />;
}
