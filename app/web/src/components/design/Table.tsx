import type {
  HTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';
import { cx } from './cx';

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  /** Screen-reader-only caption describing the table. */
  caption?: string;
}

/**
 * Semantic table primitive. Wraps the table in a horizontal-scroll region so
 * narrow viewports never clip content (WCAG 1.4.10 reflow friendly).
 */
export function Table({ caption, className, children, ...rest }: TableProps) {
  return (
    <div className="w-full overflow-x-auto rounded-xl border border-line bg-surface shadow-card">
      <table
        className={cx('w-full min-w-full border-collapse text-sm', className)}
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
    <thead className={cx('bg-surface-secondary text-left', className)} {...rest}>
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
    <tbody className={cx('divide-y divide-line', className)} {...rest}>
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
      className={cx('transition-colors hover:bg-surface-tertiary', className)}
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
        'px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-secondary',
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
    <td className={cx('px-4 py-2.5 align-middle text-ink', className)} {...rest}>
      {children}
    </td>
  );
}
