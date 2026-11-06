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

export type TagTone =
  | 'neutral'
  | 'accent'
  | 'positive'
  | 'caution'
  | 'negative'
  | 'moving'
  | 'ready'
  | 'unresolved'
  | 'closed';

/**
 * Tone is carried by the tint and the 1px ring. The first five tones reach a
 * scorecard's chips (a skill, a gap, a signal level), which are neither a verdict
 * nor a rating, so they stay in ink: their LABEL is
 * always the secondary ink, and only a fault keeps a hue. Painting small text in
 * the tone colour on the tone's own tint capped at 3.47:1 for teal and 3.94:1 for
 * rose, below AA.
 *
 * The last four are the status families, for a process state and nothing else (an
 * R1 round, a recording, an appeal): the family's wash, its text shade, which
 * clears 4.5:1 on that wash (logsheet-tokens.test.ts), and a ring in its mark.
 * Meaning never depends on the hue: every tag carries a visible group label and an
 * `srPrefix`.
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
  moving: 'bg-moving-soft text-moving-text ring-moving',
  ready: 'bg-ready-soft text-ready-text ring-ready',
  unresolved: 'bg-unresolved-soft text-unresolved-text ring-unresolved',
  closed: 'bg-closed-soft text-closed-text ring-closed',
};

export interface TagProps {
  tone?: TagTone;
  /** Screen-reader-only classification, e.g. "Gap:" before the skill name. */
  srPrefix?: string;
  /**
   * A tinted, ringed CHIP for a SHORT label by default (`inline-flex`, single
   * line). Set `block` for a LONG, wrapping item (a gap or a red flag): the same
   * tint + ring, as a block-level box with room to breathe and normal wrapping.
   */
  block?: boolean;
  className?: string;
  children: ReactNode;
}

export function Tag({ tone = 'neutral', srPrefix, block = false, className, children }: TagProps) {
  return (
    <span
      className={cx(
        // Meta step (12/16, medium), sentence case, tabular figures (a tag
        // can carry a count or a year: "5 yrs", "2024").
        'text-meta font-medium tabular-nums ring-1 ring-inset',
        block
          ? 'block rounded-control px-2.5 py-1.5 leading-snug'
          : 'inline-flex items-center rounded-chip px-2.5 py-0.5',
        toneStyles[tone],
        className,
      )}
    >
      {srPrefix && <span className="sr-only">{srPrefix} </span>}
      {children}
    </span>
  );
}
