import type { ReactNode } from 'react';
import { cx } from './cx';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/*
 * Hue lives in the dot and the tint; the label is small text and therefore
 * uses the text-only derivatives (≥ 4.5:1 on the tint) or the ink.
 */
const toneStyles: Record<StatusTone, string> = {
  neutral: 'bg-ink/[0.05] text-ink-secondary',
  info: 'bg-info-soft text-ink-secondary',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-error-soft text-error-text',
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
}

/** Small semantic status pill — restrained, text-first. */
export function StatusBadge({
  tone = 'neutral',
  children,
  className,
  dot = true,
}: StatusBadgeProps) {
  return (
    <span
      data-status-badge={tone}
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
        toneStyles[tone],
        className,
      )}
    >
      {dot && <span aria-hidden="true" className={cx('h-1.5 w-1.5 rounded-full', dotStyles[tone])} />}
      {children}
    </span>
  );
}
