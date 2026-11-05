/**
 * ProportionBar — a compact breakdown row: label, a thin bar sized to a
 * share of the block's total, and the tabular figure. The bar is
 * decorative (aria-hidden); the figure carries the meaning. The fill is drawn
 * at its width: nothing grows in.
 */
import type { ReactNode } from 'react';
import { cx } from './cx';

export type ProportionTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

const fills: Record<ProportionTone, string> = {
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-error',
  neutral: 'bg-ink-muted',
};

export interface ProportionBarProps {
  label: ReactNode;
  value: number;
  /** Total the bar is measured against (≥ value). Defaults to value. */
  total?: number;
  tone?: ProportionTone;
  /** Render the value differently (e.g. percentages). */
  formatValue?: (value: number) => string;
  className?: string;
}

export function ProportionBar({
  label,
  value,
  total,
  tone = 'info',
  formatValue,
  className,
}: ProportionBarProps) {
  const denominator = total && total > 0 ? total : Math.max(value, 1);
  const pct = Math.max(0, Math.min(100, (value / denominator) * 100));
  return (
    <div className={cx('flex items-center gap-3 text-sm', className)}>
      <span className="w-28 shrink-0 truncate text-ink-secondary">{label}</span>
      <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/[0.06]">
        <span
          className={cx('data-fill block h-full rounded-full', fills[tone])}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-10 shrink-0 text-right font-semibold tabular-nums text-ink">
        {formatValue ? formatValue(value) : value.toLocaleString()}
      </span>
    </div>
  );
}
