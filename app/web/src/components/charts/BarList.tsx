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
 * COLOUR. One accent for every bar unless a category carries a meaning of
 * its own (advance / hold / reject), in which case the caller passes a tone.
 * Colour is never the only signal: the label is always printed.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../design/cx';
import { Skeleton } from '../design/Skeleton';
import { ChartEmpty, ChartError } from './states';
import { shareLabel } from './series';

export type BarTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

const FILL: Record<BarTone, string> = {
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-error',
  neutral: 'bg-ink-muted',
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
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyHint?: string;
  className?: string;
}

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
  error = null,
  onRetry,
  emptyTitle = 'Nothing to show yet',
  emptyHint,
  className,
}: BarListProps) {
  if (isLoading) {
    return (
      <div className={cx('space-y-3 py-1', className)} role="status" aria-label={`Loading ${title}`}>
        {[0.8, 0.55, 0.35].map((w) => (
          <div key={w} className="flex items-center gap-3">
            <Skeleton width="6.5rem" height={12} />
            <Skeleton className="flex-1" height={6} radius={999} style={{ maxWidth: `${w * 100}%` }} />
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
                        className="flex min-h-11 items-center rounded-md text-ink-secondary underline-offset-4 transition-colors duration-150 ease-out hover:text-ink hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-info sm:min-h-8"
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
                      scale === 'total' && 'overflow-hidden rounded-[3px] bg-ink/[0.06]',
                    )}
                  >
                    <GrowFill pct={pct} className={FILL[row.tone ?? 'info']} />
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

/**
 * The fill is sized to its share from the first frame and only its SCALE
 * animates (transform, not width: no layout work per frame). It grows from
 * the left once, 240ms ease-out, and the global reduced-motion rule collapses
 * the transition to nothing.
 */
function GrowFill({ pct, className }: { pct: number; className: string }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span
      className={cx(
        'block h-full origin-left rounded-[3px] transition-transform duration-[240ms] ease-out',
        drawn ? 'scale-x-100' : 'scale-x-0',
        className,
      )}
      style={{ width: `${pct}%` }}
    />
  );
}
