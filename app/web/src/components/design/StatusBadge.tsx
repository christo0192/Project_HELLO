import type { ReactNode } from 'react';
import { cx } from './cx';

export type StatusTone = 'neutral' | 'ink' | 'ink-2' | 'info' | 'success' | 'warning' | 'closed' | 'danger';

/*
 * The word carries the status and the colour says which kind it is. A tone is the
 * family's soft wash, its text shade and a dot in its mark (components/design/tones.ts):
 * `info` is underway, `success` a good or ready result, `warning` unfinished or
 * needing a second look, `closed` ended with no judgement implied. `info` means the
 * moving family HERE and in BarList: the `--info` token stays ink, because it is the
 * primary fill. A fault on our side is crimson text inside a crimson edge, and a
 * chip with no meaning of its own stays neutral.
 *
 * `ink` and `ink-2` are for a skill, a gap, a flag, a signal level or a resume conflict,
 * which are neither a verdict nor a rating and take no hue: darker ink is the only
 * weight a red flag or an unresolved conflict gets. They print exactly what these chips
 * printed before the families came back.
 */
const toneStyles: Record<StatusTone, string> = {
  neutral: 'bg-surface-secondary text-ink-secondary',
  ink: 'bg-surface-secondary text-ink',
  'ink-2': 'bg-surface-secondary text-ink-secondary',
  info: 'bg-moving-soft text-moving-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  closed: 'bg-closed-soft text-closed-text',
  danger: 'bg-error-soft text-error-text ring-1 ring-inset ring-error',
};

const dotStyles: Record<StatusTone, string> = {
  neutral: 'bg-ink-muted',
  ink: 'bg-ink-secondary',
  'ink-2': 'bg-ink-secondary',
  info: 'bg-moving',
  success: 'bg-success',
  warning: 'bg-warning',
  closed: 'bg-closed',
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
