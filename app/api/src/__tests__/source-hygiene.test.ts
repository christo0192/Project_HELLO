/**
 * Source hygiene guard — no literal control bytes in committed source.
 *
 * WHY THIS EXISTS: a raw control byte inside a string literal makes git treat
 * the file as BINARY, which silently breaks `git diff`, `git grep`, code review,
 * and any text-based lint. The Wave 2 review already caught one instance (a NUL
 * inside a webhook test fixture); a second survived in `ashby-client.test.ts`
 * and was only found by accident while writing the activation runtime. A test
 * is the cheapest place to make that class of defect impossible to reintroduce.
 *
 * The fix is always the same: write a JavaScript escape such as backslash-u
 * 0001 inside the string literal instead of pasting the raw byte. The escape
 * is exactly as effective for the code under test and keeps the file
 * reviewable.
 * Runs offline over the repository source; no network, no DB.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, '..');

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.cjs', '.js'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '__pycache__']);

/**
 * Control characters that must never appear literally. TAB (0x09), LF (0x0A)
 * and CR (0x0D) are legitimate whitespace and are excluded.
 */
function offendingCharCodes(text: string): Array<{ line: number; code: number }> {
  const hits: Array<{ line: number; code: number }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      const code = ch.charCodeAt(0);
      const isControl = (code < 0x09) || (code > 0x0d && code < 0x20) || code === 0x7f;
      if (isControl) hits.push({ line: i + 1, code });
    }
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED_EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

describe('source hygiene — no literal control bytes', () => {
  const files = walk(API_SRC);

  it('scans a non-trivial number of files (guards against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('every API source file is free of literal control characters', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const hits = offendingCharCodes(readFileSync(file, 'utf8'));
      if (hits.length > 0) {
        const where = hits.slice(0, 3)
          .map((h) => `line ${h.line} (0x${h.code.toString(16).padStart(2, '0')})`)
          .join(', ');
        offenders.push(`${relative(API_SRC, file)}: ${where}`);
      }
    }
    expect(
      offenders,
      `Literal control bytes make git treat these files as binary. Use an escape such as '\\u0001' instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the detector itself flags a seeded control byte (negative control)', () => {
    // Built from char codes so this test file stays clean while still proving
    // the detector is not vacuous.
    const seeded = `const x = 'a${String.fromCharCode(1)}b';`;
    const hits = offendingCharCodes(seeded);
    expect(hits).toHaveLength(1);
    expect(hits[0].code).toBe(1);

    // And it must NOT flag legitimate whitespace.
    expect(offendingCharCodes('a\tb\r\nc')).toEqual([]);
  });
});
