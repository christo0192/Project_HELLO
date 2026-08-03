import type { ReactNode } from 'react';
import { useCountUp, useReducedMotion } from '../../lib/motion';
import { cx } from './cx';
import { Skeleton } from './Skeleton';

export type KpiTone = 'default' | 'success' | 'warning' | 'danger';

export interface KpiCardProps {
  label: string;
  value: number;
  unit?: string;
  hint?: string;
  /** Percent change vs a prior period — restrained semantic chip. */
  delta?: number | null;
  tone?: KpiTone;
  icon?: ReactNode;
  formatValue?: (value: number) => string;
  loading?: boolean;
}

const toneStyles: Record<KpiTone, string> = {
  default: 'text-ink',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-error',
};

function formatDelta(delta: number): string {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

/**
 * KPI card with a Motion count-up value (gated by prefers-reduced-motion).
 * Numeric values use tabular figures for stable alignment.
 */
export function KpiCard({
  label,
  value,
  unit,
  hint,
  delta,
  tone = 'default',
  icon,
  formatValue,
  loading = false,
}: KpiCardProps) {
  const reduced = useReducedMotion();
  const animated = useCountUp(loading ? 0 : value, { disabled: reduced });
  const shown = formatValue
    ? formatValue(animated)
    : Math.round(animated).toLocaleString();

  return (
    <div className="rounded-xl border border-line bg-surface p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-secondary">
          {label}
        </p>
        {icon && (
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-info-soft text-info"
          >
            {icon}
          </span>
        )}
      </div>
      <div className="mt-2">
        {loading ? (
          <Skeleton width={96} height={28} radius={6} />
        ) : (
          <p className={cx('text-2xl font-semibold tabular-nums tracking-tight', toneStyles[tone])}>
            {shown}
            {unit && (
              <span className="ml-1 text-sm font-normal text-ink-tertiary">{unit}</span>
            )}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {delta != null && !loading && (
            <span
              className={cx(
                'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums',
                delta > 0 && 'bg-success-soft text-success',
                delta < 0 && 'bg-error-soft text-error',
                delta === 0 && 'bg-surface-tertiary text-ink-tertiary',
              )}
            >
              {formatDelta(delta)}
            </span>
          )}
          {hint && <p className="text-xs text-ink-tertiary">{hint}</p>}
        </div>
      </div>
    </div>
  );
}
