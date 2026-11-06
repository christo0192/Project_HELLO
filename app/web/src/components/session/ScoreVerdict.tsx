/**
 * The shared pieces of a session scorecard, used by both assessment
 * generations (legacy dimensions in `components/Scorecard.tsx`, role
 * scorecards in `RoleScorecardView`) so the two read as one system.
 *
 * `ScoreVerdict` is the top of the card: the overall figure, the
 * recommendation, and the model's summary. A recruiter opening a screening
 * wants the verdict before the evidence, so it comes first and carries the
 * page's one hero number. The figure takes the verdict's family, as the circle and
 * the word beside it do, and those two still say it without colour. A score held for
 * thin evidence takes no hue: the server has just said it is no result to act on.
 */

import type { ReactNode } from 'react';
import { cx } from '../design/cx';
import { FAMILY_CLASSES, ratingFamily, verdictFamily, type JudgementFamily } from '../design/tones';
import { finiteNumber } from './scorecard-read';
import { VerdictMark } from './VerdictMark';

export interface ScoreVerdictProps {
  /** Overall score, 0–100. Anything that is not a finite number reads "Not scored", never 0. */
  overall: unknown;
  recommendation: unknown;
  summary?: unknown;
  /** Appended to the "Overall score" line, e.g. the weighted rubric average. */
  detail?: ReactNode;
  /** Notices that qualify the verdict (provisional score, …). */
  children?: ReactNode;
  /** Held for thin evidence, or an R1 row with no usable result: the figure and the mark take no hue. */
  held?: boolean;
}

export function ScoreVerdict({ overall, recommendation, summary, detail, children, held = false }: ScoreVerdictProps) {
  const n = finiteNumber(overall);
  const score = n == null ? null : Math.round(n);
  const text = typeof summary === 'string' ? summary.trim() : '';
  const family = held ? null : verdictFamily(recommendation);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {score == null ? (
            <p className="text-section leading-8 text-ink">Not scored</p>
          ) : (
            <p className="flex items-baseline gap-1.5">
              <span className={cx('text-stat leading-none tabular-nums', family ? FAMILY_CLASSES[family].text : 'text-ink')}>
                {score}
              </span>
              <span className="text-sm tabular-nums text-ink-tertiary">/ 100</span>
            </p>
          )}
          <p className="mt-2 text-label font-medium leading-5 text-ink-secondary">
            Overall score
            {detail}
          </p>
        </div>
        <VerdictMark recommendation={recommendation} size="lg" plain={held} />
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
 * A rubric reading as a row of short bars, the first `level` filled, in the family
 * of the rating: its position on this metric's own scale. The same glyph as the
 * Scorebar's rubric editor, which defines a level and so awards nothing, and stays
 * ink. Decoration only; the level word and number beside it are the real text.
 *
 * `family` is for a host that knows better than the position: null is ink, for ratings
 * the page has just said gave no usable result.
 */
export function ScorePips({
  level,
  max,
  family = ratingFamily(level, max),
}: {
  level: number;
  max: number;
  family?: JudgementFamily | null;
}) {
  const steps = Array.from({ length: Math.max(1, Math.min(10, Math.round(max))) }, (_, i) => i + 1);
  return (
    <span aria-hidden="true" className="flex items-center gap-[3px]">
      {steps.map((step) => (
        <span
          key={step}
          className={cx(
            'h-[5px] w-[11px] rounded-full',
            step <= level ? cx('data-fill', family ? FAMILY_CLASSES[family].fill : 'bg-info') : 'bg-ink/[0.12]',
          )}
        />
      ))}
    </span>
  );
}
