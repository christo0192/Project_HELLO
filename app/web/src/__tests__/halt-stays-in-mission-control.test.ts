/**
 * Halt all calling is a filled danger button with one home. It stays in Mission
 * Control and out of every recruiter screen, where a red button a click away is
 * the look the stakeholder objected to and a mistake nobody can take back.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('Halt all calling', () => {
  it('renders from Mission Control and nowhere else', () => {
    const users = sources(SRC)
      .filter((path) => /<OperatorHaltControl\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split(sep).join('/'));
    expect(users).toEqual(['pages/MissionControlPage.tsx']);
  });

  it('keeps its filled danger treatment', () => {
    const source = readFileSync(join(SRC, 'components/mission-control/OperatorHaltControl.tsx'), 'utf8');
    expect(source).toMatch(/buttonClass\('danger', 'lg'\)/);
  });
});
