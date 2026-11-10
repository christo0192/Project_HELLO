/**
 * The pieces every Business impact table prints a figure with.
 *
 * A count with applications behind it is a button that opens the list of them
 * (owner decision D-M031-3). A zero opens nothing, so it is plain, and a count
 * that is not known is a dash on screen and words to a screen reader, never 0.
 */
import type { ReactNode, ThHTMLAttributes } from 'react';
import { cx } from '../design/cx';
import { DASH, formatCount, formatShare } from '../../lib/impact-format';
import type { ImpactListTarget, ImpactSummaryParams } from '../../lib/impact';

/** What a pressed figure asks the list panel for. */
export interface ImpactListRequest {
  target: ImpactListTarget;
  /** The panel's heading, e.g. "Select · Moved forward". */
  title: string;
  /** The figure that was pressed. */
  count: number;
  /** A narrower window or job than the page's: a cohort week, a job row. */
  scope?: ImpactSummaryParams;
}

export type OpenImpactList = (request: ImpactListRequest, opener: HTMLElement) => void;

/** A figure that is not known: a dash, and words for a screen reader. */
export function Dash() {
  return (
    <>
      <span aria-hidden="true">{DASH}</span>
      <span className="sr-only">Not available</span>
    </>
  );
}

/**
 * A cell that has no figure by definition, not for want of one: Came in has no
 * step before it, and nothing is still at, or drops from, the end of the line.
 * A paler dash, and words that say it does not apply, so it is never read as
 * a figure Ashby has not given yet.
 */
export function NotApplicable() {
  return (
    <>
      <span aria-hidden="true" className="text-ink-tertiary">
        {DASH}
      </span>
      <span className="sr-only">Does not apply</span>
    </>
  );
}

export interface CountButtonProps {
  count: number | null | undefined;
  /** What the figure counts, for the button's name: "Select, moved forward". */
  name: string;
  request: Omit<ImpactListRequest, 'count'>;
  onOpen: OpenImpactList;
  className?: string;
}

export function CountButton({ count, name, request, onOpen, className }: CountButtonProps) {
  if (typeof count !== 'number' || !Number.isFinite(count)) return <Dash />;
  const figure = formatCount(count);
  if (count <= 0) return <span className={className}>{figure}</span>;
  return (
    <button
      type="button"
      onClick={(event) => onOpen({ ...request, count }, event.currentTarget)}
      // Starts with the figure as printed, so a spoken "click 240" finds it (WCAG 2.5.3).
      aria-label={`${figure}, ${name}. Show these applications`}
      className={cx(
        // No side padding or negative margin: in a flush table's last column either would
        // overhang the table and scroll it sideways. The figure lines up with its header.
        'textlink inline-flex min-h-6 min-w-6 items-center justify-end rounded-control font-medium tabular-nums text-ink',
        'transition-colors duration-hover ease-out hover:bg-ink/[0.05]',
        className,
      )}
    >
      {figure}
    </button>
  );
}

/** A share as printed, with a dash read out as words. */
export function Share({ share, className }: { share: number | null | undefined; className?: string }) {
  const text = formatShare(share);
  return <span className={cx('tabular-nums', className)}>{text === DASH ? <Dash /> : text}</span>;
}

/** A row's own header cell: the step, the verdict, the stage, the week. */
export function RowHead({ children, className, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { children: ReactNode }) {
  return (
    <th
      scope="row"
      // The last row loses its rule, as `TBody` takes it off every `td`: a row header
      // that kept it drew half a line under the table.
      className={cx(
        'h-11 border-b border-glass-ring px-4 py-2 text-left align-middle font-normal text-ink [tr:last-child>&]:border-b-0',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}
