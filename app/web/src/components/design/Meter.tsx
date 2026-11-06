/**
 * Meter — the candidate-scoped score bar.
 *
 * The scorecard the owner flagged encoded every score as a 1.5px hairline
 * whose colour was the only signal, with no accessible semantics at all.
 * This primitive fixes both halves of that:
 *
 *   - Value redundancy: the number is ALWAYS rendered as text in tabular
 *     figures, and the band ("Low" / "Fair" / "Strong") is ALWAYS rendered
 *     as a word. The fill and the words take the band's family, so the colour
 *     can never disagree with the word beside it. `plain` keeps the old ink
 *     steps, for a reading where a high value is not a good one. `family` is
 *     for a reading that sits under a verdict, whose cuts are not the band's.
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
import {
  BAND_FAMILY,
  DEFAULT_THRESHOLDS,
  FAMILY_CLASSES,
  meterBand,
  type JudgementFamily,
  type MeterBand,
  type MeterThresholds,
} from './tones';

export { DEFAULT_THRESHOLDS, meterBand };
export type { MeterBand, MeterThresholds };

export interface MeterProps {
  label: string;
  value: number;
  /** Scale maximum. 10 for per-signal scores, 100 for the overall score. */
  max?: number;
  /** Larger presentation for the headline overall score. */
  emphasis?: boolean;
  thresholds?: MeterThresholds;
  /** No family: a reading where a high value is not a good one, or no reading at all. */
  plain?: boolean;
  /** This family instead of the band's, so the bar cannot claim another verdict than the one beside it. */
  family?: JudgementFamily;
  className?: string;
}

export const BAND_LABEL: Record<MeterBand, string> = {
  low: 'Low',
  fair: 'Fair',
  strong: 'Strong',
};

const plainFill: Record<MeterBand, string> = {
  low: 'var(--c-ink-muted)',
  fair: 'var(--c-ink-secondary)',
  strong: 'var(--c-ink)',
};

const familyFill: Record<JudgementFamily, string> = {
  closed: 'var(--closed)',
  unresolved: 'var(--unresolved)',
  ready: 'var(--ready)',
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
  plain = false,
  family,
  className,
}: MeterProps) {
  const rawId = useId();
  const labelId = `${rawId.replace(/:/g, '-')}-label`;
  const safe = clampScore(value, max);
  const band = meterBand(safe, max, thresholds);
  const pct = max === 0 ? 0 : (safe / max) * 100;
  const hue = family ?? BAND_FAMILY[band];
  const words = plain ? null : FAMILY_CLASSES[hue].text;

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
          <span className={cx('tabular-nums', words)}>
            {safe}/{max}
          </span>
          <span aria-hidden="true" className="mx-1.5 text-[var(--c-ink-secondary)]">
            ·
          </span>
          <span className={words ?? 'text-[var(--c-ink-secondary)]'}>{BAND_LABEL[band]}</span>
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
          className="data-fill h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: plain ? plainFill[band] : familyFill[hue] }}
        />
      </div>
    </div>
  );
}
