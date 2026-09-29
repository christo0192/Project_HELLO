import type {
  HTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';
import { cx } from './cx';

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  /** Screen-reader-only caption describing the table. */
  caption?: string;
  /** Render without the glass container (already inside a panel). */
  bare?: boolean;
  /** Sticky header inside a bounded scroll container. */
  maxHeight?: string;
}

/**
 * Semantic table primitive inside a glass container. Wraps the table in a
 * horizontal-scroll region so narrow viewports never clip content (WCAG
 * 1.4.10 reflow friendly); pass `maxHeight` for a sticky-header scroll.
 *
 * Type: body cells are 14/20 in the ink; header cells are the meta step
 * (12/16, medium, tertiary ink) so the data, not the labels, carries the
 * weight. The whole table sets TABULAR figures: counts, scores, dates and
 * times line up column-wise, and a number that updates in place keeps its
 * width. (IBM Plex already draws every digit one width; the utility keeps
 * the column aligned under any fallback face, where "11" and "88" differ.)
 */
export function Table({ caption, className, children, bare = false, maxHeight, ...rest }: TableProps) {
  return (
    <div
      // A bounded table is a scroll region: give keyboard users a focus stop
      // and assistive technology a name (axe: scrollable-region-focusable).
      role={maxHeight ? 'region' : undefined}
      aria-label={maxHeight ? caption : undefined}
      tabIndex={maxHeight ? 0 : undefined}
      className={cx(
        'w-full overflow-x-auto',
        bare ? '' : 'glass rounded-card',
        maxHeight && 'overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-info',
      )}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table
        className={cx('w-full min-w-full border-separate border-spacing-0 text-sm tabular-nums', className)}
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

/**
 * Rows reveal with a short CSS stagger (`.rows-reveal`, index.css) on mount
 * and whenever new rows mount (pagination, filters). Pure CSS so typing into
 * a filter never re-runs an animation engine; collapses under reduced motion.
 */
export function TBody({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cx('rows-reveal [&>tr:last-child>td]:border-b-0', className)} {...rest}>
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
    <tfoot className={cx('bg-white/40', className)} {...rest}>
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
      className={cx('group/row transition-colors duration-150 hover:bg-white/60', className)}
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
        'h-10 border-b border-glass-ring bg-white/80 px-4 text-left text-meta font-medium text-ink-tertiary first:rounded-tl-card last:rounded-tr-card',
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
