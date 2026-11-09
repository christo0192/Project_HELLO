/**
 * What a status colour means, in one place. Each family means one thing on every
 * screen (index.css):
 *
 *   moving      underway, the process has it        tone `info`
 *   ready       a good or ready result              tone `success`
 *   unresolved  unfinished, or needs a second look  tone `warning`
 *   closed      ended, no judgement implied         tone `closed`
 *
 * `danger` stays a fault on our side, and a plain total stays ink: if everything
 * is coloured, nothing is. Colour is never the only signal, so the printed word
 * always stays.
 *
 * A verdict or a rating about one candidate takes a family too (the owner's decision
 * of 2026-11-06, docs/design/logsheet-colour-decision-2026-11-06.md), and only one of
 * three: nothing about a judgement is underway, crimson stays a fault and orange stays
 * the candidate's voice, so a Reject is `closed` and never red.
 */
import type { StatusTone } from './StatusBadge';
import type { TagTone } from './Tag';

/** A tone a figure can be printed in. No tone is ink. */
export type FigureTone = 'info' | 'success' | 'warning' | 'closed' | 'danger';

const FIGURE_TEXT: Record<FigureTone, string> = {
  info: 'text-moving-text',
  success: 'text-success-text',
  warning: 'text-warning-text',
  closed: 'text-closed-text',
  danger: 'text-error-text',
};

/** The class that prints a figure: its family's text shade, or ink. */
export function figureToneClass(tone?: FigureTone): string {
  return tone ? FIGURE_TEXT[tone] : 'text-ink';
}

const STATE_TEXT: Readonly<Partial<Record<TagTone, string>>> = {
  moving: 'text-moving-text',
  ready: 'text-ready-text',
  unresolved: 'text-unresolved-text',
  closed: 'text-closed-text',
  negative: 'text-error-text',
};

/**
 * A state printed as a plain word where its screen has no chip: the text shade of the family its
 * `Tag` takes, so the word and the chip read as one fact. A fault's `Tag` keeps its word in ink inside
 * a crimson ring, so with no ring the plain word takes the crimson itself. A neutral state adds nothing.
 */
export function stateTextClass(tone: TagTone): string | undefined {
  return STATE_TEXT[tone];
}

/**
 * A counted figure's tone. A bucket with nobody in it means nothing, so a zero stays
 * ink: an olive "Needs review 0" would say something wants a second look when nothing
 * does. The same goes for a figure that is not read yet.
 */
export function countTone(count: number | null | undefined, tone?: FigureTone): FigureTone | undefined {
  return count != null && count > 0 ? tone : undefined;
}

/**
 * One step of a family, for a mark that sits beside others in a stack or a list of
 * stages. A badge or a dot takes its family; a bar takes the step, so neighbours
 * in one family stay apart. The steps are validated in logsheet-tokens.test.ts.
 */
export type MarkTone =
  | 'moving-light'
  | 'moving'
  | 'moving-deep'
  | 'ready-light'
  | 'ready'
  | 'unresolved-light'
  | 'unresolved'
  | 'closed-light'
  | 'closed'
  | 'danger'
  | 'neutral';

const MARKS: Record<MarkTone, { fill: string; tone: StatusTone }> = {
  'moving-light': { fill: 'var(--moving-light)', tone: 'info' },
  moving: { fill: 'var(--moving)', tone: 'info' },
  'moving-deep': { fill: 'var(--moving-deep)', tone: 'info' },
  'ready-light': { fill: 'var(--ready-light)', tone: 'success' },
  ready: { fill: 'var(--ready)', tone: 'success' },
  'unresolved-light': { fill: 'var(--unresolved-light)', tone: 'warning' },
  unresolved: { fill: 'var(--unresolved)', tone: 'warning' },
  'closed-light': { fill: 'var(--closed-light)', tone: 'closed' },
  closed: { fill: 'var(--closed)', tone: 'closed' },
  danger: { fill: 'var(--danger)', tone: 'danger' },
  neutral: { fill: 'var(--rule-2)', tone: 'neutral' },
};

/** The token a mark fills with, for a segment or a swatch drawn with an inline style. */
export function markVar(mark: MarkTone): string {
  return MARKS[mark].fill;
}

/** The badge tone of the family a mark belongs to. */
export function markFamilyTone(mark: MarkTone): StatusTone {
  return MARKS[mark].tone;
}

const TONE_MARK: Record<StatusTone, MarkTone> = {
  neutral: 'neutral',
  ink: 'neutral',
  'ink-2': 'neutral',
  info: 'moving',
  success: 'ready',
  warning: 'unresolved',
  closed: 'closed',
  danger: 'danger',
};

/** The other way: the mark of a word that has a badge tone, for a swatch beside it. */
export function toneMark(tone: StatusTone): MarkTone {
  return TONE_MARK[tone];
}

/** The families a verdict or a rating can take. */
export type JudgementFamily = 'ready' | 'unresolved' | 'closed';

const VERDICT_FAMILY: Readonly<Record<string, JudgementFamily>> = {
  advance: 'ready',
  hold: 'unresolved',
  reject: 'closed',
};

/** The family of a stored recommendation. Needs human review, or anything unknown, has no hue. */
export function verdictFamily(recommendation: unknown): JudgementFamily | null {
  if (typeof recommendation !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(VERDICT_FAMILY, recommendation) ? VERDICT_FAMILY[recommendation] : null;
}

/**
 * The family of a rating, by its position on the metric's own scale, so a 5-point scale
 * works as a 4-point one does. A metric with no score has no rating and no hue.
 */
export function ratingFamily(score: unknown, max: unknown): JudgementFamily | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return null;
  const position = score / max;
  return position >= 0.75 ? 'ready' : position >= 0.5 ? 'unresolved' : 'closed';
}

/** The band a reading falls in, by its place on a scale. */
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

/**
 * A band's family. Both legacy cards read this, so one number keeps one colour on each. It lives here
 * because the Session and Screening card is held apart from the candidate-scoped primitives
 * (candidate-scope-palette.test.ts).
 */
export const BAND_FAMILY: Readonly<Record<MeterBand, JudgementFamily>> = {
  low: 'closed',
  fair: 'unresolved',
  strong: 'ready',
};

/** Whole class names, or Tailwind would not see them. */
export const FAMILY_CLASSES: Readonly<
  Record<JudgementFamily, { text: string; glyph: string; fill: string; edge: string; lightFill: string; wash: string }>
> = {
  ready: {
    text: 'text-ready-text',
    glyph: 'text-ready',
    fill: 'bg-ready',
    edge: 'border-ready',
    lightFill: 'bg-ready-light',
    wash: 'bg-ready-soft',
  },
  unresolved: {
    text: 'text-unresolved-text',
    glyph: 'text-unresolved',
    fill: 'bg-unresolved',
    edge: 'border-unresolved',
    lightFill: 'bg-unresolved-light',
    wash: 'bg-unresolved-soft',
  },
  closed: {
    text: 'text-closed-text',
    glyph: 'text-closed',
    fill: 'bg-closed',
    edge: 'border-closed',
    lightFill: 'bg-closed-light',
    wash: 'bg-closed-soft',
  },
};

/**
 * A label under a verdict ruler: in its family, the stored verdict's own heavier. With no verdict to
 * show, the ruler claims nothing, so a label has no hue.
 */
export function rulerLabelClass(family: JudgementFamily, current: JudgementFamily | null): string {
  if (current === null) return 'text-ink-tertiary';
  return family === current ? `${FAMILY_CLASSES[family].text} font-semibold` : FAMILY_CLASSES[family].text;
}

const EVIDENCE_NUMBER: Readonly<Record<JudgementFamily | 'ink', { resting: string; quiet: string; pressed: string }>> = {
  ready: {
    resting: 'border-ready bg-paper text-ready-text',
    quiet: 'border-rule bg-paper text-ready-text',
    pressed: 'border-ready-text bg-ready-text text-paper',
  },
  unresolved: {
    resting: 'border-unresolved bg-paper text-unresolved-text',
    quiet: 'border-rule bg-paper text-unresolved-text',
    pressed: 'border-unresolved-text bg-unresolved-text text-paper',
  },
  closed: {
    resting: 'border-closed bg-paper text-closed-text',
    quiet: 'border-rule bg-paper text-closed-text',
    pressed: 'border-closed-text bg-closed-text text-paper',
  },
  ink: {
    resting: 'border-ink bg-paper text-ink',
    quiet: 'border-rule bg-paper text-ink',
    pressed: 'border-ink bg-ink text-paper',
  },
};

/**
 * A numbered evidence tag, in the family of the rating of the metric it cites, so a
 * glance at the strip says where the weak and the strong evidence sit. Paper on the
 * text shade is 5.67:1 or better. A metric with no score has no rating and stays ink.
 *
 * A tag is a bare number, so nothing but colour says its family, and the text shades of
 * Select and Borderline collapse for a colour-blind reader (delta E 3.7). So the resting
 * edge is the family's mark, which the validator passes (15.5). The digit and the pressed
 * fill keep the text shade, because paper on the Borderline mark is only 3.30:1.
 *
 * A tick on the strip can step back (`quiet`), so that the weakest metric's lead: the digit
 * stays, and the edge goes to the printed rule. Its family then rests on the digit alone, so
 * Select and Borderline read alike there to a colour-blind reader. The rating stays a word in
 * its rubric row, and the tick takes its mark edge back once its metric is open or it is pressed.
 */
export function evidenceNumberClass(family: JudgementFamily | null, pressed: boolean, quiet = false): string {
  const shades = EVIDENCE_NUMBER[family ?? 'ink'];
  if (pressed) return shades.pressed;
  return quiet ? shades.quiet : shades.resting;
}
