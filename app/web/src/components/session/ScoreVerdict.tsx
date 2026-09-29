/**
 * The shared pieces of a session scorecard, used by both assessment
 * generations (legacy dimensions in `components/Scorecard.tsx`, role
 * scorecards in `RoleScorecardView`) so the two read as one system.
 *
 * `ScoreVerdict` is the top of the card: the overall figure, the
 * recommendation, and the model's summary. A recruiter opening a screening
 * wants the verdict before the evidence, so it comes first and carries the
 * page's one hero number. The figure stays in ink: the recommendation pill
 * carries the tone (dot + tint + words), so colour is never the only signal
 * and the number reads as a fact rather than a traffic light.
 */

import type { ReactNode } from 'react';
import { cx } from '../design/cx';
import type { StatusTone } from '../design';
import { finiteNumber, recommendationMeta } from './scorecard-read';

/* Same token pairs as `StatusBadge` (hue in the dot and tint, small text in
   the `*-text` tokens or ink), one step larger: this pill sits beside a
   32px figure and is the verdict, not a row annotation. */
const PILL_TONE: Record<StatusTone, string> = {
  neutral: 'bg-ink/[0.05] text-ink-secondary',
  info: 'bg-info-soft text-ink-secondary',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-error-soft text-error-text',
};

const PILL_DOT: Record<StatusTone, string> = {
  neutral: 'bg-ink-muted',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-error',
};

export interface ScoreVerdictProps {
  /** Overall score, 0–100. Anything that is not a finite number reads "Not scored", never 0. */
  overall: unknown;
  recommendation: unknown;
  summary?: unknown;
  /** Appended to the "Overall score" line, e.g. the weighted rubric average. */
  detail?: ReactNode;
  /** Notices that qualify the verdict (provisional score, …). */
  children?: ReactNode;
}

export function ScoreVerdict({ overall, recommendation, summary, detail, children }: ScoreVerdictProps) {
  const reco = recommendationMeta(recommendation);
  const n = finiteNumber(overall);
  const score = n == null ? null : Math.round(n);
  const text = typeof summary === 'string' ? summary.trim() : '';

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {score == null ? (
            <p className="text-[15px] font-semibold leading-8 text-ink">Not scored</p>
          ) : (
            <p className="flex items-baseline gap-1.5">
              <span className="text-[32px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-ink">
                {score}
              </span>
              <span className="text-sm tabular-nums text-ink-tertiary">/ 100</span>
            </p>
          )}
          <p className="mt-2 text-[13px] font-medium leading-5 text-ink-secondary">
            Overall score
            {detail}
          </p>
        </div>
        {reco && (
          <span
            data-recommendation={reco.tone}
            className={cx(
              'inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-[13px] font-semibold',
              PILL_TONE[reco.tone],
            )}
          >
            <span aria-hidden="true" className={cx('h-1.5 w-1.5 rounded-full', PILL_DOT[reco.tone])} />
            {reco.label}
          </span>
        )}
      </div>
      {text && (
        <>
          {/* Visually the summary needs no label (it sits under the verdict it
              explains); a hidden heading lets a screen-reader user jump to it. */}
          <h3 className="sr-only">Summary</h3>
          <p className="mt-4 max-w-prose text-sm leading-6 text-ink-secondary">{text}</p>
        </>
      )}
      {children}
    </div>
  );
}

/**
 * A rubric reading as a row of short bars, the first `level` filled: the
 * same glyph the Scorebar's rubric editor uses, so a "3" looks the same
 * where it is defined and where it is awarded. Decoration only; the level
 * word and number beside it are the real text.
 */
export function ScorePips({ level, max }: { level: number; max: number }) {
  const steps = Array.from({ length: Math.max(1, Math.min(10, Math.round(max))) }, (_, i) => i + 1);
  return (
    <span aria-hidden="true" className="flex items-center gap-[3px]">
      {steps.map((step) => (
        <span
          key={step}
          className={cx('h-[5px] w-[11px] rounded-full', step <= level ? 'bg-info' : 'bg-ink/[0.12]')}
        />
      ))}
    </span>
  );
}
