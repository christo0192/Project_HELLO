/**
 * The shared meaning of a status colour: a figure's text shade and a mark's step.
 * Everything that prints a tone reads these, so the Dashboard, the Candidates bars
 * and any later surface cannot disagree about what a colour means.
 */
import { describe, expect, it } from 'vitest';
import {
  BAND_FAMILY,
  countTone,
  evidenceNumberClass,
  FAMILY_CLASSES,
  figureToneClass,
  markFamilyTone,
  markVar,
  meterBand,
  ratingFamily,
  rulerLabelClass,
  stateTextClass,
  toneMark,
  verdictFamily,
  type JudgementFamily,
  type MarkTone,
} from '../tones';

describe('figureToneClass', () => {
  it('leaves a plain figure in ink, so that colour still means something', () => {
    expect(figureToneClass()).toBe('text-ink');
    expect(figureToneClass(undefined)).toBe('text-ink');
  });

  it.each([
    ['info', 'text-moving-text'],
    ['success', 'text-success-text'],
    ['warning', 'text-warning-text'],
    ['closed', 'text-closed-text'],
    ['danger', 'text-error-text'],
  ] as const)('prints a %s figure in %s', (tone, shade) => {
    expect(figureToneClass(tone)).toBe(shade);
  });
});

describe('countTone', () => {
  it('colours a count only when somebody is in it', () => {
    expect(countTone(1, 'warning')).toBe('warning');
    expect(countTone(0, 'warning')).toBeUndefined();
    expect(countTone(undefined, 'warning')).toBeUndefined();
    expect(countTone(null, 'warning')).toBeUndefined();
    expect(countTone(5)).toBeUndefined();
  });
});

describe('a mark step', () => {
  const MARKS: Array<[MarkTone, string, string]> = [
    ['moving-light', 'var(--moving-light)', 'info'],
    ['moving', 'var(--moving)', 'info'],
    ['moving-deep', 'var(--moving-deep)', 'info'],
    ['ready-light', 'var(--ready-light)', 'success'],
    ['ready', 'var(--ready)', 'success'],
    ['unresolved-light', 'var(--unresolved-light)', 'warning'],
    ['unresolved', 'var(--unresolved)', 'warning'],
    ['closed-light', 'var(--closed-light)', 'closed'],
    ['closed', 'var(--closed)', 'closed'],
    ['danger', 'var(--danger)', 'danger'],
    ['neutral', 'var(--rule-2)', 'neutral'],
  ];

  it.each(MARKS)('%s fills with %s, and its badge is the %s tone', (mark, fill, tone) => {
    expect(markVar(mark)).toBe(fill);
    expect(markFamilyTone(mark)).toBe(tone);
  });

  it.each([
    ['info', 'moving'],
    ['success', 'ready'],
    ['warning', 'unresolved'],
    ['closed', 'closed'],
    ['danger', 'danger'],
    ['neutral', 'neutral'],
  ] as const)('a %s word takes the %s mark, which is its family again', (tone, mark) => {
    expect(toneMark(tone)).toBe(mark);
    expect(markFamilyTone(toneMark(tone))).toBe(tone);
  });
});

describe('a verdict family', () => {
  it.each([
    ['advance', 'ready'],
    ['hold', 'unresolved'],
    ['reject', 'closed'],
  ] as const)('%s is %s', (recommendation, family) => {
    expect(verdictFamily(recommendation)).toBe(family);
  });

  it.each([['human_review'], ['something_new'], ['constructor'], [''], [null], [undefined], [7]])(
    'has no hue for %s',
    (value) => {
      expect(verdictFamily(value)).toBeNull();
    },
  );
});

describe('a rating family, by position on its own scale', () => {
  it.each([
    [4, 4, 'ready'],
    [3, 4, 'ready'],
    [2, 4, 'unresolved'],
    [1, 4, 'closed'],
    [0, 4, 'closed'],
    [5, 5, 'ready'],
    [4, 5, 'ready'],
    [3, 5, 'unresolved'],
    [2, 5, 'closed'],
    [1, 5, 'closed'],
    [0, 5, 'closed'],
    // The two cut-offs themselves.
    [7.5, 10, 'ready'],
    [5, 10, 'unresolved'],
  ] as const)('%s of %s is %s', (score, max, family) => {
    expect(ratingFamily(score, max)).toBe(family);
  });

  it.each([
    [null, 4],
    [undefined, 4],
    [Number.NaN, 4],
    ['3', 4],
    [3, 0],
    [3, null],
  ])('has no hue for %s of %s', (score, max) => {
    expect(ratingFamily(score, max)).toBeNull();
  });
});

describe('a family by band, which both legacy cards read', () => {
  it.each([
    [0, 'closed'],
    [4.9, 'closed'],
    [5, 'unresolved'],
    [6.9, 'unresolved'],
    [7, 'ready'],
    [10, 'ready'],
  ] as const)('%s of 10 is %s', (value, family) => {
    expect(BAND_FAMILY[meterBand(value, 10)]).toBe(family);
  });

  it('parts from a rating by position where the word would disagree: 7 of 10 prints Strong', () => {
    expect(BAND_FAMILY[meterBand(7, 10)]).toBe('ready');
    expect(ratingFamily(7, 10)).toBe('unresolved');
  });
});

describe('a label under a verdict ruler', () => {
  it('is in its own family, and the stored verdict\'s own is heavier', () => {
    expect(rulerLabelClass('unresolved', 'unresolved')).toBe('text-unresolved-text font-semibold');
    expect(rulerLabelClass('ready', 'unresolved')).toBe('text-ready-text');
    expect(rulerLabelClass('closed', 'unresolved')).toBe('text-closed-text');
  });

  it.each(['ready', 'unresolved', 'closed'] as const)('of %s has no hue with no verdict to show', (family) => {
    expect(rulerLabelClass(family, null)).toBe('text-ink-tertiary');
  });
});

describe('the classes of a family', () => {
  const FAMILIES: JudgementFamily[] = ['ready', 'unresolved', 'closed'];

  it.each(FAMILIES)('%s prints in its text shade and marks in its mark', (family) => {
    expect(FAMILY_CLASSES[family]).toEqual({
      text: `text-${family}-text`,
      glyph: `text-${family}`,
      fill: `bg-${family}`,
      edge: `border-${family}`,
      lightFill: `bg-${family}-light`,
      wash: `bg-${family}-soft`,
    });
  });
});

describe('an evidence number', () => {
  it.each([
    ['ready', 'border-ready bg-paper text-ready-text', 'border-ready-text bg-ready-text text-paper'],
    ['unresolved', 'border-unresolved bg-paper text-unresolved-text', 'border-unresolved-text bg-unresolved-text text-paper'],
    ['closed', 'border-closed bg-paper text-closed-text', 'border-closed-text bg-closed-text text-paper'],
  ] as const)('of a %s metric rests on paper with a mark edge and a text-shade digit, and fills with the text shade when pressed', (family, resting, pressed) => {
    expect(evidenceNumberClass(family, false)).toBe(resting);
    expect(evidenceNumberClass(family, true)).toBe(pressed);
  });

  it('of a metric with no score stays ink', () => {
    expect(evidenceNumberClass(null, false)).toBe('border-ink bg-paper text-ink');
    expect(evidenceNumberClass(null, true)).toBe('border-ink bg-ink text-paper');
  });
});

describe('a state printed as a word', () => {
  it.each([
    ['moving', 'text-moving-text'],
    ['ready', 'text-ready-text'],
    ['unresolved', 'text-unresolved-text'],
    ['closed', 'text-closed-text'],
  ] as const)('reads as its %s chip does', (tone, shade) => {
    expect(stateTextClass(tone)).toBe(shade);
  });

  it('prints a fault in the crimson of its chip\'s ring, because that chip keeps its word in ink', () => {
    expect(stateTextClass('negative')).toBe('text-error-text');
  });

  it('adds nothing for a state with no family', () => {
    expect(stateTextClass('neutral')).toBeUndefined();
  });
});
