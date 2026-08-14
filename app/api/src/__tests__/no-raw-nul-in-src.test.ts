/**
 * Source-hygiene guard (F3): no source file under app/api/src may contain a raw
 * NUL (0x00) byte. A literal NUL makes git classify a file as binary — breaking
 * textual diff/review and any grep/lint/coverage tooling — and lets an editor or
 * formatter silently alter control-character test data with no visible diff. Use
 * the explicit `\u0000` escape in test data instead.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url)); // app/api/src

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(?:ts|tsx|js|mjs|cjs|json)$/.test(entry)) out.push(p);
  }
  return out;
}

describe('source hygiene', () => {
  it('contains no raw NUL byte anywhere under app/api/src', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (readFileSync(file).includes(0x00)) offenders.push(file);
    }
    expect(offenders, `raw NUL bytes found in: ${offenders.join(', ')}`).toEqual([]);
  });
});
