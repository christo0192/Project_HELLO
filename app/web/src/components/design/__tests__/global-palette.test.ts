import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('global HR palette', () => {
  it('contains the approved light-first surface and semantic tokens', () => {
    for (const value of [
      '#f4f6fb', '#ffffff', '#dbe1ec', '#eaeef6',
      '#0f172a', '#334155', '#6b7391', '#4E6BA6',
      '#398AA2', '#b45a72', '#a16207',
    ]) {
      expect(css.toLowerCase()).toContain(value.toLowerCase());
    }
  });

  it('does not define an alternate dark token block', () => {
    expect(css).not.toMatch(/\.dark\s*\{[\s\S]*--surface:\s*#0c1624/);
    expect(css).toContain(':root,\n  .dark');
  });
});
