import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function codeWithoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(path);
    return /\.ts$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const root = process.cwd();
/** The interviewer's name before Lexy, as a word (identifiers like `dexUserId` never match). */
const DEX = /\bDex\b/;
const directories = ['src/lib/r1'];
const singles = ['src/lib/scorecards/r1-prompt.ts', 'src/routes/r1.ts', 'src/routes/r1-candidate.ts',
  'src/routes/r1-hr.ts', 'src/routes/r1-recording.ts'];

describe('R1 shipped copy', () => {
  it('strips comments while preserving code and URLs', () => {
    const pattern = /christy/i;
    expect(codeWithoutComments("const a = 'Christy';")).toMatch(pattern);
    expect(codeWithoutComments('// Christy')).not.toMatch(pattern);
    expect(codeWithoutComments('/* Christy */')).not.toMatch(pattern);
    expect(codeWithoutComments('/** description\n * Christy\n */')).not.toMatch(pattern);
    expect(codeWithoutComments('{/* Christy */}')).not.toMatch(pattern);
    expect(codeWithoutComments("const u = 'https://x.test/Christy';")).toMatch(pattern);
  });

  it('keeps identifiers and catches the shipped word Dex', () => {
    expect("const a = 'Dex';").toMatch(DEX);
    expect('Dex (AI Interviewer)').toMatch(DEX);
    for (const identifier of ['dexUserId', 'R1_MEET_ASHBY_DEX_USER_ID', 'dex_absent', 'r1_dex_sales', 'hasDex']) {
      expect(identifier).not.toMatch(DEX);
    }
  });

  it('scans all expected files and excludes the old name', () => {
    for (const file of singles) expect(existsSync(resolve(root, file)), file).toBe(true);
    const files = [...directories.flatMap((dir) => walk(resolve(root, dir))),
      ...singles.map((file) => resolve(root, file))];
    expect(files.length).toBeGreaterThanOrEqual(20);
    for (const file of files) {
      const code = codeWithoutComments(readFileSync(file, 'utf8'));
      expect(code, relative(root, file)).not.toMatch(/christy/i);
      // Owner 2026-11-27: the interviewer is Lexy; Dex is gone from every shipped string.
      expect(code, relative(root, file)).not.toMatch(DEX);
    }
  });
});
