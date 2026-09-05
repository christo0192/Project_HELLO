/**
 * ScrollArea — a bounded, fade-masked vertical scroll region.
 *
 * Focusable and labelled (`role="region"`, `tabIndex=0`) so keyboard users
 * can scroll it — the axe rule `scrollable-region-focusable` requires it.
 */
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /** CSS max-height, e.g. `24rem`. */
  maxHeight: string;
  /** Accessible name for the region. */
  label: string;
  children: ReactNode;
}

export function ScrollArea({ maxHeight, label, className, children, ...rest }: ScrollAreaProps) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cx(
        'scroll-fade overflow-y-auto overscroll-contain py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-info',
        className,
      )}
      style={{ maxHeight }}
      {...rest}
    >
      {children}
    </div>
  );
}
