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
        className={cx('w-full min-w-full border-separate border-spacing-0 text-sm', className)}
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
        'h-10 border-b border-glass-ring bg-white/70 px-4 text-left text-xs font-medium text-ink-tertiary backdrop-blur-sm first:rounded-tl-card last:rounded-tr-card',
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
