import type { ReactNode } from 'react';
import { cx } from './cx';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const toneStyles: Record<StatusTone, string> = {
  neutral: 'bg-surface-tertiary text-ink-secondary ring-1 ring-inset ring-line',
  info: 'bg-info-soft text-info ring-1 ring-inset ring-info/30',
  success: 'bg-success-soft text-success ring-1 ring-inset ring-success/30',
  warning: 'bg-warning-soft text-warning ring-1 ring-inset ring-warning/30',
  danger: 'bg-error-soft text-error ring-1 ring-inset ring-error/30',
};

export interface StatusBadgeProps {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
}

/** Small semantic status badge — restrained, text-first. */
export function StatusBadge({
  tone = 'neutral',
  children,
  className,
}: StatusBadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium',
        toneStyles[tone],
        className,
      )}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {children}
    </span>
  );
}
