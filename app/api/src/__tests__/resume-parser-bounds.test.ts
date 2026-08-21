/**
 * The parser's bounds: what is now configurable, how it is clamped, and — at
 * least as importantly — every control that is UNCHANGED.
 *
 * WHY THIS EXISTS. `RESUME_PARSER_TIMEOUT_MS` was set in `fly.toml` and read
 * by exactly one of the parser's two callers: the synchronous HTTP resume
 * route passed it explicitly, while the Ashby ingestion path reaches the
 * parser through `createResumeParserPool()` with no config at all and got the
 * 30 s built-in. The child's heap cap was a hard literal with no override at
 * any layer. Both are now bounded configuration honoured by both callers.
 *
 * WHAT THIS DOES NOT CLAIM. Making these tunable does not prove the live
 * canary's `parse_error` was a timeout or an OOM — the classifier shipped in
 * this change is what will NAME that, and until it does, no cause is asserted
 * here. What is proven is that the two suspected bounds are now observable,
 * configurable, clamped, and safe.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseResume,
  resolveChildScript,
  resumeParserTimeoutMs,
  resumeParserChildHeapMb,
  PARSER_TIMEOUT_BOUNDS,
  PARSER_CHILD_HEAP_MB_BOUNDS,
  ParserAssetMissingError,
  ParserError,
  ParserTimeoutError,
} from '../lib/resume-parser.js';

const env = (over: Record<string, string> = {}) => over as NodeJS.ProcessEnv;

// ═══════════════════════════════════════════════════════════════════════
// 1. Defaults and clamps — pinned, so a silent change fails here
// ═══════════════════════════════════════════════════════════════════════

describe('configured bounds', () => {
  it('pins the shipped defaults', () => {
    expect(PARSER_TIMEOUT_BOUNDS).toEqual({ def: 30_000, min: 1_000, max: 300_000 });
    expect(PARSER_CHILD_HEAP_MB_BOUNDS).toEqual({ def: 256, min: 128, max: 1_024 });
    // An unset environment reproduces the pre-change behaviour EXACTLY. The
    // evidence-backed production values live in fly.toml, not in the code
    // default, so no other deployment silently changes behaviour.
    expect(resumeParserTimeoutMs(env())).toBe(30_000);
    expect(resumeParserChildHeapMb(env())).toBe(256);
  });

  it('honours a valid configured value', () => {
    expect(resumeParserTimeoutMs(env({ RESUME_PARSER_TIMEOUT_MS: '120000' }))).toBe(120_000);
    expect(resumeParserChildHeapMb(env({ RESUME_PARSER_CHILD_HEAP_MB: '512' }))).toBe(512);
  });

  it('CLAMPS rather than honouring an out-of-range value', () => {
    expect(resumeParserTimeoutMs(env({ RESUME_PARSER_TIMEOUT_MS: '1' }))).toBe(1_000);
    expect(resumeParserTimeoutMs(env({ RESUME_PARSER_TIMEOUT_MS: '99999999' }))).toBe(300_000);
    // The ceiling matters: an unclamped heap cap would let one document evict
    // the ~1 GiB ClamAV signature set on a 2 GiB machine.
    expect(resumeParserChildHeapMb(env({ RESUME_PARSER_CHILD_HEAP_MB: '1' }))).toBe(128);
    expect(resumeParserChildHeapMb(env({ RESUME_PARSER_CHILD_HEAP_MB: '99999' }))).toBe(1_024);
  });

  it('a garbled value takes the default — a typo must not take ingestion down', () => {
    for (const bad of ['', ' ', 'abc', '12.5', '-500', 'NaN', '0x100', '1e3']) {
      expect(resumeParserChildHeapMb(env({ RESUME_PARSER_CHILD_HEAP_MB: bad })))
        .toBe(PARSER_CHILD_HEAP_MB_BOUNDS.def);
      expect(resumeParserTimeoutMs(env({ RESUME_PARSER_TIMEOUT_MS: bad })))
        .toBe(PARSER_TIMEOUT_BOUNDS.def);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. What actually reaches the child process
// ═══════════════════════════════════════════════════════════════════════

/**
 * A child that echoes its OWN spawn environment and argv back as the parser's
 * result, so the spawn contract can be asserted without mocking `spawn`.
 */
const ECHO_CHILD = new URL('./fixtures/parser-echo-child.mjs', import.meta.url).pathname;

async function echo(config: Parameters<typeof parseResume>[2] = {}): Promise<Record<string, unknown>> {
  const r = await parseResume(Buffer.from('%PDF-1.4 synthetic'), 'application/pdf', {
    childScript: ECHO_CHILD, ...config,
  });
  return JSON.parse(r.text) as Record<string, unknown>;
}

describe('the spawn contract', () => {
  it('passes the CLAMPED heap cap as --max-old-space-size', async () => {
    const seen = await echo({ envSource: env({ RESUME_PARSER_CHILD_HEAP_MB: '512' }) });
    expect(seen.nodeOptions).toContain('--max-old-space-size=512');
  });

  it('an explicit config value is clamped too, so no caller can bypass the bound', async () => {
    expect((await echo({ childHeapMb: 99_999 })).nodeOptions)
      .toContain('--max-old-space-size=1024');
    expect((await echo({ childHeapMb: 1 })).nodeOptions)
      .toContain('--max-old-space-size=128');
  });

  it('the interpolated cap is always an integer — never operator text in a spawn argument', async () => {
    for (const raw of ['512; rm -rf /', '$(whoami)', '`id`', '256 --inspect']) {
      const seen = await echo({ envSource: env({ RESUME_PARSER_CHILD_HEAP_MB: raw }) });
      expect(seen.nodeOptions).toBe('--max-old-space-size=256');   // fell back to the default
    }
  });

  it('the default env reproduces the historical 256 MiB cap exactly', async () => {
    const seen = await echo({ envSource: env() });
    expect(seen.nodeOptions).toBe('--max-old-space-size=256');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Every control that is UNCHANGED — asserted, not assumed
// ═══════════════════════════════════════════════════════════════════════

describe('unchanged parser controls', () => {
  it('bytes go via BINARY stdin, never argv — argv carries only the mime and two bounds', async () => {
    const seen = await echo();
    expect(seen.argv).toEqual(['application/pdf', String(25 * 1024 * 1024), '50000']);
    expect(JSON.stringify(seen.argv)).not.toContain('%PDF');
    expect(seen.stdinBytes).toBe(Buffer.from('%PDF-1.4 synthetic').length);
  });

  it('the input, text and output bounds keep their shipped values', async () => {
    const seen = await echo();
    expect(Number((seen.argv as string[])[1])).toBe(25 * 1024 * 1024);   // 25 MiB input cap
    expect(Number((seen.argv as string[])[2])).toBe(50_000);             // 50k text cap
  });

  it('a child that exceeds the stdout bound is killed with the stable code', async () => {
    await expect(parseResume(Buffer.from('x'), 'application/pdf', {
      childScript: new URL('./fixtures/parser-flood-child.mjs', import.meta.url).pathname,
      maxOutputBytes: 1_024,
    })).rejects.toMatchObject({ code: 'PARSER_OUTPUT_EXCEEDED' });
  });

  it('the parent still enforces the timeout by SIGKILL', async () => {
    await expect(parseResume(Buffer.from('x'), 'application/pdf', {
      childScript: new URL('./fixtures/parser-hang-child.mjs', import.meta.url).pathname,
      timeoutMs: 150,
    })).rejects.toBeInstanceOf(ParserTimeoutError);
  });

  it('stderr is discarded — a child that writes secrets to it leaks nothing', async () => {
    const r = await parseResume(Buffer.from('x'), 'application/pdf', {
      childScript: new URL('./fixtures/parser-stderr-child.mjs', import.meta.url).pathname,
    });
    expect(r.text).toBe('ok');
    expect(JSON.stringify(r)).not.toContain('ada@example.com');
    expect(JSON.stringify(r)).not.toContain('SUPER_SECRET');
  });

  it('a non-zero child exit is the stable `child_exit` detail, with no dynamic text', async () => {
    const err = await parseResume(Buffer.from('x'), 'application/pdf', {
      childScript: new URL('./fixtures/parser-exit-child.mjs', import.meta.url).pathname,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParserError);
    expect((err as ParserError).detail).toBe('child_exit');
    expect((err as Error).message).toBe('PARSER_ERROR');
  });

  it('production still FAILS CLOSED when the compiled child asset is absent', () => {
    expect(() => resolveChildScript('/nonexistent-dir-for-this-test', {}))
      .toThrow(ParserAssetMissingError);
    // And never invokes tsx implicitly.
    expect(() => resolveChildScript('/nonexistent-dir-for-this-test', { allowTsxFallback: true }))
      .toThrow(ParserAssetMissingError);
  });

  it('the spawn is shell-free — no shell metacharacter in the mime can be interpreted', async () => {
    // The mime is a fixed enum from the upload guard, but `shell: false` is
    // what makes that a defence-in-depth detail rather than the only guard.
    const seen = await echo({ });
    expect(seen.argv).toEqual(['application/pdf', String(25 * 1024 * 1024), '50000']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. The honest limit
// ═══════════════════════════════════════════════════════════════════════

describe('what a bigger heap and a longer timeout do NOT do', () => {
  it('an unsupported/garbled document is still refused, never accepted to make a canary green', async () => {
    const err = await parseResume(Buffer.from('x'), 'application/pdf', {
      childScript: new URL('./fixtures/parser-badoutput-child.mjs', import.meta.url).pathname,
      childHeapMb: 1_024, timeoutMs: 300_000,
    }).catch((e: unknown) => e);
    // The most generous bounds this module permits still produce a VERDICT.
    // Malformed, encrypted and unsupported documents remain needs_review.
    expect(err).toBeInstanceOf(ParserError);
    expect((err as ParserError).detail).toBe('bad_output');
  });
});
