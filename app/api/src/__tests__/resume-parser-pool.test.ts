/**
 * Bounded resume parser pool + hardened child protocol — unit + negative controls.
 *
 * Pool scheduling tests use an injectable, controllable `parse` so concurrency,
 * queue overload, and release-exactly-once are deterministic. Protocol/hardening
 * tests drive the REAL child (`process.execPath` + resume-parser-child.mjs) and
 * synthetic fixture children for crash/malformed/no-output/stderr/flood/slow
 * paths. Synthetic data only; a secret/contact/resume-text canary control proves
 * no leakage into logs or serialized errors.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseResume,
  resolveChildScript,
  ParserError,
  ParserTimeoutError,
  ParserOutputExceededError,
  ParserAssetMissingError,
  ParserOverloadError,
  type ParserResult,
} from '../lib/resume-parser.js';
import {
  createResumeParserPool,
  type ParseFn,
} from '../lib/resume-parser-pool.js';
import { runResumeParserBenchmark } from '../lib/resume-parser-benchmark.js';

const NODE = process.execPath;
const childFixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/parser-children/${name}`, import.meta.url));

const RESULT: ParserResult = { text: 'ok', totalLength: 2, truncated: false };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A controllable parse that exposes each in-flight call's settle handle. */
function controllableParse() {
  let inFlight = 0;
  let peak = 0;
  const gates: Array<{ settle: (ok: boolean) => void; settled: boolean }> = [];
  const parse: ParseFn = () => {
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
    const d = deferred<ParserResult>();
    const gate = {
      settled: false,
      settle: (ok: boolean) => {
        if (gate.settled) return;
        gate.settled = true;
        inFlight -= 1;
        if (ok) d.resolve(RESULT); else d.reject(new ParserError('synthetic'));
      },
    };
    gates.push(gate);
    return d.promise;
  };
  return { parse, gates, peak: () => peak };
}

const flush = async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

// ═══════════════════════════════════════════════════════════════════════
// Pool scheduling (deterministic, injectable parse)
// ═══════════════════════════════════════════════════════════════════════

describe('pool concurrency bound', () => {
  it('never exceeds the configured concurrency under a burst', async () => {
    const cp = controllableParse();
    const pool = createResumeParserPool({ maxConcurrency: 3, maxQueueDepth: 100, parse: cp.parse });
    const runs = Array.from({ length: 10 }, () => pool.submit(Buffer.from('x'), 'text/plain'));

    expect(pool.stats().active).toBe(3);
    expect(pool.stats().queued).toBe(7);

    let idx = 0;
    while (idx < 10) {
      for (; idx < cp.gates.length; idx++) cp.gates[idx].settle(true);
      await flush();
    }
    await Promise.all(runs);
    await pool.drain();

    expect(cp.peak()).toBeLessThanOrEqual(3);
    expect(pool.stats().peakConcurrency).toBe(3);
    expect(pool.stats().completed).toBe(10);
    expect(pool.stats().active).toBe(0);
  });
});

describe('pool overload + recovery', () => {
  it('rejects deterministically when full and recovers after capacity frees', async () => {
    const cp = controllableParse();
    const pool = createResumeParserPool({ maxConcurrency: 1, maxQueueDepth: 1, parse: cp.parse });

    const a = pool.submit(Buffer.from('a'), 'text/plain'); // runs
    const b = pool.submit(Buffer.from('b'), 'text/plain'); // queued
    expect(pool.stats().active).toBe(1);
    expect(pool.stats().queued).toBe(1);

    // Third submission is over capacity → fails fast, deterministically.
    await expect(pool.submit(Buffer.from('c'), 'text/plain')).rejects.toBeInstanceOf(ParserOverloadError);
    expect(pool.stats().rejected).toBe(1);

    // Free the running slot → queued B starts; capacity recovers.
    cp.gates[0].settle(true);
    await flush();
    expect(pool.stats().active).toBe(1); // B now running
    expect(pool.stats().queued).toBe(0);

    // A new submission is admitted again (recovery).
    const d = pool.submit(Buffer.from('d'), 'text/plain');
    expect(pool.stats().queued).toBe(1);

    for (let i = 1; i < cp.gates.length; i++) cp.gates[i].settle(true);
    await flush();
    for (let i = 0; i < cp.gates.length; i++) cp.gates[i].settle(true);
    await flush();
    await Promise.all([a, b, d]);
    await pool.drain();
    expect(pool.stats().active).toBe(0);
    expect(pool.stats().completed).toBe(3);
  });
});

describe('pool release-exactly-once', () => {
  it('releases capacity on failure and a later queued item proceeds', async () => {
    const cp = controllableParse();
    const pool = createResumeParserPool({ maxConcurrency: 1, maxQueueDepth: 5, parse: cp.parse });

    const a = pool.submit(Buffer.from('a'), 'text/plain'); // runs
    const b = pool.submit(Buffer.from('b'), 'text/plain'); // queued

    cp.gates[0].settle(false); // A fails
    await expect(a).rejects.toBeInstanceOf(ParserError);
    await flush();

    expect(pool.stats().active).toBe(1); // B proceeded after A's failure
    cp.gates[1].settle(true);
    await b;
    await pool.drain();

    expect(pool.stats().failed).toBe(1);
    expect(pool.stats().completed).toBe(1);
    expect(pool.stats().active).toBe(0);
  });

  it('a synchronous throw in parse still releases capacity', async () => {
    let calls = 0;
    const parse: ParseFn = () => {
      calls += 1;
      if (calls === 1) throw new ParserError('sync_boom'); // synchronous throw
      return Promise.resolve(RESULT);
    };
    const pool = createResumeParserPool({ maxConcurrency: 1, maxQueueDepth: 5, parse });
    const a = pool.submit(Buffer.from('a'), 'text/plain');
    const b = pool.submit(Buffer.from('b'), 'text/plain');
    await expect(a).rejects.toBeInstanceOf(ParserError);
    await expect(b).resolves.toEqual(RESULT);
    await pool.drain();
    expect(pool.stats().active).toBe(0);
    expect(pool.stats().failed).toBe(1);
    expect(pool.stats().completed).toBe(1);
  });

  it('drain resolves only after all work settles', async () => {
    const cp = controllableParse();
    const pool = createResumeParserPool({ maxConcurrency: 2, maxQueueDepth: 5, parse: cp.parse });
    const runs = [pool.submit(Buffer.from('a'), 'text/plain'), pool.submit(Buffer.from('b'), 'text/plain')];
    let drained = false;
    const drainP = pool.drain().then(() => { drained = true; });
    await flush();
    expect(drained).toBe(false);
    cp.gates.forEach((g) => g.settle(true));
    await Promise.all(runs);
    await drainP;
    expect(drained).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Real child protocol / hardening
// ═══════════════════════════════════════════════════════════════════════

describe('binary stdin protocol (no base64)', () => {
  it('round-trips Unicode extracted text exactly', async () => {
    const input = 'héllo 世界 🚀 café — ünïcödé résumé';
    const r = await parseResume(Buffer.from(input, 'utf-8'), 'text/plain', { timeoutMs: 10_000, nodeBin: NODE });
    expect(r.text).toBe(input);
    expect(r.truncated).toBe(false);
  });

  it('handles arbitrary bounded binary input without crashing', async () => {
    const buf = Buffer.allocUnsafe(4096);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + 13) & 0xff;
    const r = await parseResume(buf, 'text/plain', { timeoutMs: 10_000, nodeBin: NODE });
    expect(typeof r.text).toBe('string');
  });

  it('reports pre-truncation length and truncates to maxTextLength', async () => {
    const input = 'a'.repeat(500);
    const r = await parseResume(Buffer.from(input), 'text/plain', { timeoutMs: 10_000, nodeBin: NODE, maxTextLength: 100 });
    expect(r.text.length).toBe(100);
    expect(r.totalLength).toBe(500);
    expect(r.truncated).toBe(true);
  });

  it('fails closed on input overflow', async () => {
    const r = parseResume(Buffer.alloc(2000, 0x61), 'text/plain', { timeoutMs: 10_000, nodeBin: NODE, maxInputBytes: 100 });
    await expect(r).rejects.toBeInstanceOf(ParserError);
  });
});

describe('child failure classes release/settle correctly', () => {
  it('oversized stdout → ParserOutputExceededError', async () => {
    await expect(parseResume(Buffer.from('x'), 'text/plain', {
      timeoutMs: 10_000, nodeBin: NODE, childScript: childFixture('flood.mjs'), maxOutputBytes: 1000,
    })).rejects.toBeInstanceOf(ParserOutputExceededError);
  });

  it('malformed output → ParserError', async () => {
    const err = await parseResume(Buffer.from('x'), 'text/plain', {
      timeoutMs: 10_000, nodeBin: NODE, childScript: childFixture('malformed.mjs'),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ParserError);
    expect((err as ParserError).detail).toBe('bad_output');
  });

  it('no output → ParserError', async () => {
    const err = await parseResume(Buffer.from('x'), 'text/plain', {
      timeoutMs: 10_000, nodeBin: NODE, childScript: childFixture('nooutput.mjs'),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ParserError);
    expect((err as ParserError).detail).toBe('no_output');
  });

  it('nonzero child exit → ParserError', async () => {
    const err = await parseResume(Buffer.from('x'), 'text/plain', {
      timeoutMs: 10_000, nodeBin: NODE, childScript: childFixture('crash.mjs'),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ParserError);
    expect((err as ParserError).detail).toBe('child_exit');
  });

  it('spawn error → ParserError', async () => {
    await expect(parseResume(Buffer.from('x'), 'text/plain', {
      timeoutMs: 10_000, nodeBin: '/nonexistent/definitely/not/a/binary',
    })).rejects.toBeInstanceOf(ParserError);
  });

  it('timeout kills the child → ParserTimeoutError', async () => {
    await expect(parseResume(Buffer.from('x'), 'text/plain', {
      timeoutMs: 50, nodeBin: NODE, childScript: childFixture('slow.mjs'),
    })).rejects.toBeInstanceOf(ParserTimeoutError);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Fail-closed child asset resolution (production)
// ═══════════════════════════════════════════════════════════════════════

describe('resolveChildScript fail-closed', () => {
  it('throws ParserAssetMissingError when the .mjs is absent (no tsx)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parser-empty-'));
    try {
      expect(() => resolveChildScript(dir, {})).toThrow(ParserAssetMissingError);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does NOT fall back to tsx implicitly even when a .ts exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parser-ts-'));
    writeFileSync(join(dir, 'resume-parser-child.ts'), '// synthetic');
    try {
      expect(() => resolveChildScript(dir, { allowTsxFallback: false })).toThrow(ParserAssetMissingError);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses tsx only with an explicit opt-in and a present .ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parser-tsok-'));
    writeFileSync(join(dir, 'resume-parser-child.ts'), '// synthetic');
    try {
      const r = resolveChildScript(dir, { allowTsxFallback: true });
      expect(r.useTsx).toBe(true);
      expect(r.path.endsWith('.ts')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('prefers the compiled .mjs when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parser-mjs-'));
    writeFileSync(join(dir, 'resume-parser-child.mjs'), '// synthetic');
    try {
      const r = resolveChildScript(dir, {});
      expect(r.useTsx).toBe(false);
      expect(r.path.endsWith('.mjs')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('honors an explicit childScript seam', () => {
    const r = resolveChildScript('/ignored', { childScript: '/some/where/child.ts' });
    expect(r.useTsx).toBe(true);
    expect(r.path).toBe('/some/where/child.ts');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Canary control — no leakage into logs or serialized errors
// ═══════════════════════════════════════════════════════════════════════

describe('canary control', () => {
  it('child stderr and error detail never leak into thrown errors or captured logs', async () => {
    const lines: string[] = [];
    const origOut = process.stdout.write;
    const origWarn = console.warn;
    const origErr = console.error;
    process.stdout.write = ((s: string | Uint8Array) => { lines.push(String(s)); return true; }) as typeof process.stdout.write;
    console.warn = ((s?: unknown) => { lines.push(String(s)); }) as typeof console.warn;
    console.error = ((s?: unknown) => { lines.push(String(s)); }) as typeof console.error;

    let err: unknown;
    try {
      err = await parseResume(Buffer.from('résumé text canary CONTACT-9f2@example.com'), 'text/plain', {
        timeoutMs: 10_000, nodeBin: NODE, childScript: childFixture('stderr-canary.mjs'),
      }).catch((e) => e);
    } finally {
      process.stdout.write = origOut;
      console.warn = origWarn;
      console.error = origErr;
    }

    expect(err).toBeInstanceOf(ParserError);
    const e = err as ParserError;
    const errBlob = `${e.message}\n${e.detail}\n${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
    const logBlob = lines.join('\n');
    for (const canary of ['CANARY-CHILD-STDERR', 'CONTACT-9f2@example.com', 'résumé text canary']) {
      expect(errBlob).not.toContain(canary);
      expect(logBlob).not.toContain(canary);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Benchmark smoke (real child, small N) — bounded concurrency, no leak
// ═══════════════════════════════════════════════════════════════════════

describe('benchmark smoke', () => {
  it('runs a small synthetic soak through the pool with bounded concurrency', async () => {
    const m = await runResumeParserBenchmark({ count: 24, maxConcurrency: 3, timeoutMs: 15_000, nodeBin: NODE, seed: 1 });
    expect(m.count).toBe(24);
    expect(m.completed + m.failed).toBe(24);
    expect(m.peakConcurrency).toBeLessThanOrEqual(3);
    expect(m.completed).toBeGreaterThanOrEqual(m.byFormat.txt.completed);
    // Non-adversarial formats should complete cleanly.
    expect(m.byFormat.txt.failed).toBe(0);
    expect(m.rssPeakBytes).toBeGreaterThanOrEqual(m.rssStartBytes);
  }, 60_000);
});
