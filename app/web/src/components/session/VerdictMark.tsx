/**
 * The verdict mark: a circle beside the word, used everywhere an AI recommendation
 * is printed.
 *
 * The circle says where the verdict sits, full for Select, half for Borderline
 * and empty for Reject, so a column of them can be read by shape. The word is
 * what a reader and a screen reader get, so the circle is decoration.
 *
 * Circle, word and figure take the verdict's family (the owner's decision of
 * 2026-11-06): Select `ready`, Borderline `unresolved`, Reject `closed`. Crimson
 * stays a fault on our side, so a Reject is never red. A word with no verdict of its
 * own has no hue. An svg keeps an author colour in a Windows contrast theme, so
 * index.css hands the circle its word's forced colour there.
 */

import { cx } from '../design/cx';
import { FAMILY_CLASSES, verdictFamily } from '../design/tones';
import { finiteNumber, recommendationMeta } from './scorecard-read';

type Fill = 'full' | 'half' | 'empty';

const FILL: Readonly<Record<string, Fill>> = { advance: 'full', hold: 'half', reject: 'empty' };

const WORD = {
  md: 'gap-1.5 text-label font-medium',
  lg: 'gap-1.5 text-sm font-medium',
  xl: 'gap-2.5 text-xl font-semibold',
} as const;

const CIRCLE = { md: 'h-3 w-3', lg: 'h-3.5 w-3.5', xl: 'h-4 w-4' } as const;

export interface VerdictMarkProps {
  /** The stored value (`advance`, `hold`, `reject`). Nothing renders without one. */
  recommendation: unknown;
  /** Printed after the word. Never a 0 for a score that is missing. */
  score?: unknown;
  /** `xl` as the headline on Review, `lg` beside a figure, `md` in a list. */
  size?: keyof typeof WORD;
  /** No hue, for a verdict the server held for thin evidence: the word and the circle still say it. */
  plain?: boolean;
  className?: string;
}

export function VerdictMark({ recommendation, score, size = 'md', plain = false, className }: VerdictMarkProps) {
  const meta = recommendationMeta(recommendation);
  if (!meta) return null;
  const fill = typeof recommendation === 'string' ? FILL[recommendation] : undefined;
  const figure = finiteNumber(score);
  const family = plain ? null : verdictFamily(recommendation);
  const shades = family ? FAMILY_CLASSES[family] : null;
  return (
    <span
      data-recommendation={String(recommendation)}
      className={cx('inline-flex items-center whitespace-nowrap', shades?.text ?? 'text-ink', WORD[size], className)}
    >
      {fill && (
        <svg
          aria-hidden="true"
          data-verdict-mark={fill}
          viewBox="0 0 12 12"
          className={cx('shrink-0', shades?.glyph ?? 'text-ink', CIRCLE[size])}
        >
          <circle
            cx="6"
            cy="6"
            r="5.25"
            fill={fill === 'full' ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.5"
          />
          {fill === 'half' && <path d="M6 .75a5.25 5.25 0 0 0 0 10.5z" fill="currentColor" />}
        </svg>
      )}
      <span>{meta.label}</span>
      {figure !== null && (
        <span className={cx('ml-1 font-normal tabular-nums', shades?.text ?? 'text-ink-secondary')}>{Math.round(figure)}</span>
      )}
    </span>
  );
}