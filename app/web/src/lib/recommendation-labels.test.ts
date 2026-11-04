import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recommendationMeta } from '../components/session/scorecard-read';
import { RECOMMENDATION_ORDER, recommendationLabel } from '../components/talent/candidateFilters';
import { recommendationWords } from './candidate-report/buildReportHtml';
import { R1_RECOMMENDATION_LABEL } from './r1';
import { RECOMMENDATION_LABELS } from './recommendation-labels';

/**
 * The verdict is worded in one place. Five surfaces used to carry their own
 * copy of the map, so a rename could land on four and quietly miss the fifth.
 * CandidateScorecard keeps its map private, so candidate-scorecard.test.tsx
 * checks its word by rendering it.
 */

const ROOT = process.cwd();

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(resolve(ROOT, directory))) {
    const relative = join(directory, name).replace(/\\/g, '/');
    if (statSync(resolve(ROOT, relative)).isDirectory()) found.push(...walk(relative));
    else found.push(relative);
  }
  return found;
}

const SURFACE_FILES = [
  'src/components/talent/candidateFilters.ts',
  'src/components/session/scorecard-read.ts',
  'src/components/talent/CandidateScorecard.tsx',
  'src/lib/candidate-report/buildReportHtml.ts',
  'src/lib/r1.ts',
];

describe('recommendation labels', () => {
  it('words each stored value as the owner decided', () => {
    expect(RECOMMENDATION_LABELS).toEqual({
      advance: 'Select',
      hold: 'Borderline',
      reject: 'Reject',
    });
  });

  it('covers exactly the stored vocabulary', () => {
    expect(Object.keys(RECOMMENDATION_LABELS).sort()).toEqual([...RECOMMENDATION_ORDER].sort());
  });

  it.each(['advance', 'hold', 'reject'] as const)(
    'every surface says the same word for %s',
    (value) => {
      const word = RECOMMENDATION_LABELS[value];
      expect(recommendationLabel(value)).toBe(word);
      expect(recommendationMeta(value)?.label).toBe(word);
      expect(recommendationWords(value)).toBe(word);
      expect(R1_RECOMMENDATION_LABEL[value]).toBe(word);
    },
  );

  it('leaves each surface its own human_review wording and fallback', () => {
    expect(recommendationMeta('human_review')?.label).toBe('Needs human review');
    expect(recommendationWords('human_review')).toBe('Human review');
    expect(recommendationLabel(null)).toBe('Unassessed');
    expect(recommendationWords(null)).toBe('Unassessed');
    expect(recommendationLabel('something_new')).toBe('something_new');
    expect(recommendationMeta('something_new')).toEqual({ label: 'Something new', tone: 'neutral' });
    expect(recommendationWords('something_new')).toBe('Something new');
  });

  it.each(SURFACE_FILES)('%s reads the words from the shared module', (file) => {
    expect(readFileSync(resolve(ROOT, file), 'utf8')).toMatch(
      /import \{ RECOMMENDATION_LABELS \} from '[./a-z-]*recommendation-labels';/,
    );
  });

  it('no production file spells the retired verdict words as a label', () => {
    const offenders = walk('src')
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => /(['"`])(Advance|Hold)\1/.test(readFileSync(resolve(ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
