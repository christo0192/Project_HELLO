import type { ReactNode } from 'react';
import { cx } from './cx';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/*
 * The word carries the status. A tone is a shaded field and a dot in ink; only
 * a fault on our side takes a hue, as crimson text inside a crimson edge.
 */
const toneStyles: Record<StatusTone, string> = {
  neutral: 'bg-surface-secondary text-ink-secondary',
  info: 'bg-info-soft text-ink-secondary',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-error-soft text-error-text ring-1 ring-inset ring-error',
};

const dotStyles: Record<StatusTone, string> = {
  neutral: 'bg-ink-muted',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-error',
};

export interface StatusBadgeProps {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
  /** Hide the tone dot for data chips that carry no status meaning. */
  dot?: boolean;
  /** Break a long label over two lines, for a column with a width budget. The dot stays on the first. */
  wrap?: boolean;
}

/**
 * Small semantic status chip: restrained, text-first. Meta step of the type
 * scale (12/16, medium), sentence case, tabular figures so a count inside a
 * badge ("Quota 92%") holds its width as it changes.
 */
export function StatusBadge({
  tone = 'neutral',
  children,
  className,
  dot = true,
  wrap = false,
}: StatusBadgeProps) {
  return (
    <span
      data-status-badge={tone}
      className={cx(
        'inline-flex gap-1.5 rounded-chip px-2 py-0.5 text-meta font-medium tabular-nums',
        wrap ? 'items-start' : 'items-center whitespace-nowrap',
        toneStyles[tone],
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden="true"
          // Centred on a 16px line: (16 - 6) / 2.
          className={cx('h-1.5 w-1.5 shrink-0 rounded-full', wrap && 'mt-[5px]', dotStyles[tone])}
        />
      )}
      {children}
    </span>
  );
}
