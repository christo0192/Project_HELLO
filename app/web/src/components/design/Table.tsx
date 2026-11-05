import type {
  HTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';
import { cx } from './cx';

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  /** Screen-reader-only caption describing the table. */
  caption?: string;
  /** Render without the panel container (already inside a panel). */
  bare?: boolean;
  /** Sticky header inside a bounded scroll container. */
  maxHeight?: string;
  /**
   * No gutter on the outer edges, so a bare table on the sheet starts on the
   * sheet's own margin with the heading above it.
   */
  flush?: boolean;
}

/**
 * Semantic table primitive inside a panel. Wraps the table in a
 * horizontal-scroll region so narrow viewports never clip content (WCAG
 * 1.4.10 reflow friendly); pass `maxHeight` for a sticky-header scroll.
 *
 * Type: body cells are 14/20 in the ink; header cells are form labels (12/16,
 * condensed, tertiary ink) so the data, not the labels, carries the weight.
 * No zebra and no header band: rows are ruled. The whole table sets TABULAR
 * figures: counts, scores, dates and
 * times line up column-wise, and a number that updates in place keeps its
 * width. (IBM Plex already draws every digit one width; the utility keeps
 * the column aligned under any fallback face, where "11" and "88" differ.)
 */
export function Table({ caption, className, children, bare = false, flush = false, maxHeight, ...rest }: TableProps) {
  return (
    <div
      // A bounded table is a scroll region: give keyboard users a focus stop
      // and assistive technology a name (axe: scrollable-region-focusable).
      role={maxHeight ? 'region' : undefined}
      aria-label={maxHeight ? caption : undefined}
      tabIndex={maxHeight ? 0 : undefined}
      className={cx(
        'w-full overflow-x-auto',
        // Bare still establishes the containing block: an absolutely placed
        // cell child (a row's stretched link) must be clipped by this scroller,
        // not escape to the page and scroll it sideways.
        bare ? 'relative' : 'glass rounded-card',
        maxHeight && 'overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-info',
      )}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table
        className={cx(
          'w-full min-w-full border-separate border-spacing-0 text-sm tabular-nums',
          flush && '[&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:first-child]:pl-0 [&_th:last-child]:pr-0',
          className,
        )}
        {...rest}
      >
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function THead({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cx('sticky top-0 z-10 text-left', className)} {...rest}>
      {children}
    </thead>
  );
}

export function TBody({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cx('[&>tr:last-child>td]:border-b-0', className)} {...rest}>
      {children}
    </tbody>
  );
}

export function TFoot({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tfoot className={cx('bg-surface-secondary', className)} {...rest}>
      {children}
    </tfoot>
  );
}

export function Tr({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cx('group/row transition-colors duration-hover hover:bg-surface-secondary', className)}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function Th({
  className,
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope={rest.scope ?? 'col'}
      className={cx(
        'form-label h-10 border-b border-line-strong bg-surface px-4 text-left first:rounded-tl-card last:rounded-tr-card',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({
  className,
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cx('h-11 border-b border-glass-ring px-4 align-middle text-ink', className)} {...rest}>
      {children}
    </td>
  );
}
