/**
 * A native select opens the operating system's grey list, the control the owner
 * screenshotted on 29 September. Every recruiter and admin picker is a
 * `Combobox` now. This scan fails the next one that is not.
 *
 * The files left below are the ones a recruiter never sees: pages a candidate
 * opens on their own device, where the platform's own picker is the right one
 * on a phone, the primitive itself, and two legacy files no route reaches.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');

const ALLOWED = new Set([
  // Candidate-facing.
  'components/candidate-join/AudioReadinessStep.tsx',
  'components/candidate-r1/R1ReadinessStep.tsx',
  'pages/AppealPage.tsx',
  // The primitive those pages use.
  'components/design/Field.tsx',
  'components/design/index.ts',
  // Reached by no route.
  'components/ui.tsx',
  'pages/AdminDashboardPage.tsx',
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Comments may say why a select is wrong without being one. */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('no native select on a recruiter or admin screen', () => {
  it('finds none outside the files a recruiter never sees', () => {
    const offenders = sources(SRC)
      .map((path) => relative(SRC, path).split(sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => /<select\b|\bSelectField\b/.test(stripComments(readFileSync(join(SRC, rel), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('keeps no stale entry in its own allow-list', () => {
    const present = new Set(sources(SRC).map((path) => relative(SRC, path).split(sep).join('/')));
    expect([...ALLOWED].filter((rel) => !present.has(rel))).toEqual([]);
  });

  it('routes no page to the two legacy files', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).not.toMatch(/AdminDashboardPage/);
  });
});
