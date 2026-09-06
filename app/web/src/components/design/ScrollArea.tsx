/**
 * ScrollArea — a bounded, fade-masked vertical scroll region.
 *
 * Focusable and labelled (`role="region"`, `tabIndex=0`) so keyboard users
 * can scroll it — the axe rule `scrollable-region-focusable` requires it.
 */
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /** CSS max-height, e.g. `24rem`. */
  maxHeight: string;
  /** Accessible name for the region. */
  label: string;
  children: ReactNode;
  /** React 19 ref-as-prop — lets callers scroll the region imperatively. */
  ref?: Ref<HTMLDivElement>;
}

export function ScrollArea({ maxHeight, label, className, children, ref, ...rest }: ScrollAreaProps) {
  return (
    <div
      ref={ref}
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
