import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('parser child script resolution', () => {
  const libDir = resolve(dirname(fileURLToPath(import.meta.url)), '../lib');

  it('resume-parser-child.mjs exists alongside .ts for production use', () => {
    const mjsPath = resolve(libDir, 'resume-parser-child.mjs');
    expect(existsSync(mjsPath)).toBe(true);
  });

  it('does not require a TypeScript child or tsx at runtime', () => {
    const tsPath = resolve(libDir, 'resume-parser-child.ts');
    expect(existsSync(tsPath)).toBe(false);
  });

  it('parseResume works via .mjs with process.execPath (no tsx)', async () => {
    const { parseResume } = await import('../lib/resume-parser.js');
    // Use explicit nodeBin to force Node execution path
    const result = await parseResume(
      Buffer.from('Hello world test'),
      'text/plain',
      { timeoutMs: 10000, nodeBin: process.execPath },
    );
    expect(result.text).toBe('Hello world test');
    expect(result.totalLength).toBe(16);
    expect(result.truncated).toBe(false);
  });
});
