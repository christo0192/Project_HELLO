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

  // The two scans walk all of src: a generous timeout, as a full parallel run is slow.
  it('no production file spells the retired verdict words as a label', () => {
    const offenders: string[] = [];
    for (const [file, source] of productionSources()) {
      // The phrases that stay are removed first, so only a retired use is left.
      let text = source;
      for (const kept of KEPT_PHRASES) text = text.split(kept).join('');
      for (const pattern of RETIRED_PATTERNS) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  }, 30_000);

  it('every kept phrase is still in use, so the allow-list cannot hide a retired word', () => {
    const all = [...productionSources().values()].join('\n');
    for (const kept of KEPT_PHRASES) expect(all, kept).toContain(kept);
  }, 30_000);

  it.each([
    ["label: 'Advance'", true],
    ['<span>Hold</span>', true],
    ['<td>\n  Advance\n</td>', true],
    ['label="Advance threshold"', true],
    ["'The hold threshold cannot be above the advance threshold.'", true],
    ["context: 'Recommended to advance'", true],
    ["{ label: 'On hold', value: 1 }", true],
    ["label: 'Advance rate'", false],
    ["'Hold released. The screening will run'", false],
    ["subject_request_hold: 'On hold: data request'", false],
    ['errors.hold_threshold = x', false],
  ])('the scan catches %j: %s', (sample, caught) => {
    let text = sample;
    for (const kept of KEPT_PHRASES) text = text.split(kept).join('');
    expect(RETIRED_PATTERNS.some((p) => p.test(text))).toBe(caught);
  });
});

let sources: Map<string, string> | null = null;

/** Every production .ts/.tsx file under src, read once for both scans. */
function productionSources(): Map<string, string> {
  if (!sources) {
    sources = new Map(
      walk('src')
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
        .map((file) => [file, readFileSync(resolve(ROOT, file), 'utf8')]),
    );
  }
  return sources;
}

/**
 * The old verdict words, retired from display: a bare 'Advance' or 'Hold' label,
 * the same as JSX text, and the phrases the rename replaced.
 */
const RETIRED_PATTERNS: readonly RegExp[] = [
  /(['"`])(Advance|Hold)\1/,
  />\s*(Advance|Hold)\s*</,
  /\b(advance|hold) threshold\b/i,
  /\brecommended to advance\b/i,
  /\bOn hold(['"`])/,
];

/**
 * Phrases that use the same words and STAY (owner decision): the team-decision
 * metric, an R1/hold release, and the data-request hold. Explicit, so a new use
 * of the words is a decision someone makes here, not one the scan waves through.
 */
const KEPT_PHRASES: readonly string[] = [
  'Advance rate',
  'Hold released',
  'On hold: data request',
];
