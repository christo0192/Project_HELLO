/**
 * RubricScale — a metric's four-level rubric, shown as the SCALE it is.
 *
 * The rubric used to render as a two-column definition list ("1 · Poor —
 * text"), which reads like four unrelated notes. It is an ordered scale:
 * each level is a step up from the one before, and Ashby's Score field has
 * exactly these four steps. So each level is a cell of one continuous
 * surface, labelled with its name and a four-pip meter filled to its
 * height — the progression is visible before a word is read, and the same
 * cell shape is reused by the editor, so what you type is what you will see.
 *
 * The pips are decoration (`aria-hidden`); the level number and name are
 * real text, so the meaning never depends on the fill.
 */

import type { ReactNode } from 'react';
import { SCORE_LABELS } from '../../types';
import type { ScoreValue } from '../../types';
import { cx } from '../design';
import { RUBRIC_LEVELS } from './rubric';

/** Four short bars, the first `level` of them filled — a quiet rating glyph. */
export function LevelPips({ level, className }: { level: ScoreValue; className?: string }) {
  return (
    <span aria-hidden="true" className={cx('flex items-center gap-[3px]', className)}>
      {RUBRIC_LEVELS.map((step) => (
        <span
          key={step}
          className={cx(
            'h-[5px] w-[11px] rounded-full transition-colors duration-200',
            step <= level ? 'bg-info' : 'bg-ink/[0.12]',
          )}
        />
      ))}
    </span>
  );
}

/** The level's heading: number, name, and its meter. */
export function LevelHeading({
  level,
  htmlFor,
  className,
}: {
  level: ScoreValue;
  /** Renders as the `<label>` of an editor field when given. */
  htmlFor?: string;
  className?: string;
}) {
  const content: ReactNode = (
    <>
      <span className="flex items-baseline gap-1.5">
        {/* The space between the two spans is REAL text: without it the
            accessible name (and a label lookup) reads "1Poor". */}
        <span className="text-xs font-medium tabular-nums text-ink-tertiary">{level}</span>{' '}
        <span className="text-[13px] font-semibold text-ink">{SCORE_LABELS[level]}</span>
      </span>
      <LevelPips level={level} />
    </>
  );
  const shared = cx('flex items-center justify-between gap-3', className);
  return htmlFor ? (
    <label htmlFor={htmlFor} className={shared}>
      {content}
    </label>
  ) : (
    <div className={shared}>{content}</div>
  );
}

/**
 * Read-only rubric. One rounded surface divided by hairlines (`gap-px` over
 * a faint ink fill), never four floating cards — a scale is one object.
 */
export function RubricScale({
  rubric,
  className,
}: {
  rubric: Partial<Record<ScoreValue, string>> | null | undefined;
  className?: string;
}) {
  return (
    <ol
      aria-label="Rubric, 1 Poor to 4 Excellent"
      className={cx(
        'grid grid-cols-1 gap-px overflow-hidden rounded-[14px] bg-ink/[0.08] sm:grid-cols-2',
        className,
      )}
    >
      {RUBRIC_LEVELS.map((level) => (
        <li key={level} className="flex flex-col gap-1.5 bg-white/80 px-3.5 py-3">
          <LevelHeading level={level} />
          <p className="text-[13px] leading-5 text-ink-secondary">
            {rubric?.[level]?.trim() || (
              <span className="italic text-ink-tertiary">Not described</span>
            )}
          </p>
        </li>
      ))}
    </ol>
  );
}
