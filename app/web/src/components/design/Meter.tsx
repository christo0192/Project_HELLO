/**
 * Meter — the candidate-scoped score bar.
 *
 * The scorecard the owner flagged encoded every score as a 1.5px hairline
 * whose colour was the only signal, with no accessible semantics at all.
 * This primitive fixes both halves of that:
 *
 *   - Value redundancy: the number is ALWAYS rendered as text in tabular
 *     figures, and the band ("Low" / "Fair" / "Strong") is ALWAYS rendered
 *     as a word. Colour is the third signal, never the first, so the meter
 *     survives greyscale and colour-vision deficiency.
 *   - Semantics: `role="meter"` with aria-valuenow/min/max, an
 *     aria-valuetext that spells out value and band, and an accessible
 *     name taken from the visible label.
 *
 * The track is 8px (not 1.5px) so a low value is still a visible bar
 * rather than an invisible stub, and its fill/track contrast is verified
 * against WCAG 1.4.11 by the palette contrast test.
 */

import { useId } from 'react';
import { cx } from './cx';

export type MeterBand = 'low' | 'fair' | 'strong';

/**
 * Band cut-points as a fraction of the scale. The default reproduces the
 * legacy per-metric bar exactly (amber at 5/10, emerald at 7/10); the
 * overall score keeps its own legacy cut-points (50 and 75 of 100), which
 * are NOT the same fractions — so they are passed in rather than assumed.
 */
export interface MeterThresholds {
  fair: number;
  strong: number;
}

export const DEFAULT_THRESHOLDS: MeterThresholds = { fair: 0.5, strong: 0.7 };

export interface MeterProps {
  label: string;
  value: number;
  /** Scale maximum. 10 for per-signal scores, 100 for the overall score. */
  max?: number;
  /** Larger presentation for the headline overall score. */
  emphasis?: boolean;
  thresholds?: MeterThresholds;
  className?: string;
}

export function meterBand(
  value: number,
  max: number,
  thresholds: MeterThresholds = DEFAULT_THRESHOLDS,
): MeterBand {
  const fraction = max === 0 ? 0 : value / max;
  if (fraction >= thresholds.strong) return 'strong';
  if (fraction >= thresholds.fair) return 'fair';
  return 'low';
}

export const BAND_LABEL: Record<MeterBand, string> = {
  low: 'Low',
  fair: 'Fair',
  strong: 'Strong',
};

const bandFill: Record<MeterBand, string> = {
  low: 'var(--c-negative)',
  fair: 'var(--c-caution)',
  strong: 'var(--c-positive)',
};

/** Clamp to the scale and drop NaN, exactly as the legacy MetricBar did. */
export function clampScore(value: number, max: number): number {
  return Math.max(0, Math.min(max, Number(value) || 0));
}

export function Meter({
  label,
  value,
  max = 10,
  emphasis = false,
  thresholds = DEFAULT_THRESHOLDS,
  className,
}: MeterProps) {
  const rawId = useId();
  const labelId = `${rawId.replace(/:/g, '-')}-label`;
  const safe = clampScore(value, max);
  const band = meterBand(safe, max, thresholds);
  const pct = max === 0 ? 0 : (safe / max) * 100;

  return (
    <div className={cx('w-full', className)}>
      <div
        className={cx(
          'mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5',
          emphasis ? 'text-sm' : 'text-xs',
        )}
      >
        <span id={labelId} className="text-[var(--c-ink-secondary)]">
          {label}
        </span>
        <span className="font-medium text-[var(--c-ink)]">
          <span className="font-mono tabular-nums">
            {safe}/{max}
          </span>
          <span aria-hidden="true" className="mx-1.5 text-[var(--c-ink-secondary)]">
            ·
          </span>
          <span className="text-[var(--c-ink-secondary)]">{BAND_LABEL[band]}</span>
        </span>
      </div>
      <div
        role="meter"
        aria-labelledby={labelId}
        aria-valuenow={safe}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuetext={`${safe} out of ${max} — ${BAND_LABEL[band]}`}
        data-band={band}
        className={cx(
          'w-full overflow-hidden rounded-full bg-[var(--c-border-light)]',
          emphasis ? 'h-3' : 'h-2',
        )}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: bandFill[band] }}
        />
      </div>
    </div>
  );
}
