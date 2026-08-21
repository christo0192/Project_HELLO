/**
 * Tag — the candidate-scoped chip.
 *
 * Every tone carries a text label in addition to its colour: the group is
 * named visibly ("Matched skills", "Gaps", "Red flags") and each chip can
 * also carry an `srPrefix`, so a chip read on its own is still classified.
 * Nothing in the candidate experience is distinguishable by hue alone.
 */

import type { ReactNode } from 'react';
import { cx } from './cx';

export type TagTone = 'neutral' | 'accent' | 'positive' | 'caution' | 'negative';

/**
 * Tone is carried by the tint and the 1px ring; the LABEL is always the
 * secondary ink. Painting small text in the tone colour on the tone's own
 * tint caps at 3.47:1 for teal and 3.94:1 for rose — below AA — and this
 * palette is fixed, so the text takes the 9:1 ink instead. Meaning never
 * depended on the hue anyway: every tag carries a visible group label and
 * an `srPrefix`.
 */
const toneStyles: Record<TagTone, string> = {
  neutral:
    'bg-[var(--c-border-light)] text-[var(--c-ink-secondary)] ring-[var(--c-border)]',
  accent:
    'bg-[var(--c-accent-light)] text-[var(--c-ink-secondary)] ring-[var(--c-accent)]',
  positive:
    'bg-[var(--c-positive-light)] text-[var(--c-ink-secondary)] ring-[var(--c-positive)]',
  caution:
    'bg-[var(--c-caution-light)] text-[var(--c-ink-secondary)] ring-[var(--c-caution)]',
  negative:
    'bg-[var(--c-negative-light)] text-[var(--c-ink-secondary)] ring-[var(--c-negative)]',
};

export interface TagProps {
  tone?: TagTone;
  /** Screen-reader-only classification, e.g. "Gap:" before the skill name. */
  srPrefix?: string;
  className?: string;
  children: ReactNode;
}

export function Tag({ tone = 'neutral', srPrefix, className, children }: TagProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        toneStyles[tone],
        className,
      )}
    >
      {srPrefix && <span className="sr-only">{srPrefix} </span>}
      {children}
    </span>
  );
}
