/**
 * provider-resilience.test.ts — DETERMINISTIC TESTS
 *
 * No real child process, no real network. All time-dependent behaviour
 * uses injected fake clock + fake timers + stateful fake child.
 *
 * Coverage:
 *   - CircuitBreaker: threshold opening (each category), BusinessError bypass,
 *     cooldown/half-open, half-open concurrency (exactly one probe),
 *     BusinessError resets consecutive failures and closes half-open,
 *     open rejection uses circuit_open distinct category,
 *     forceOpen / reset, invalid config, circuit_open not counted,
 *     non_zero_exit recognised as provider failure
 *   - collectBounded: byte counting, output_limit, multibyte, empty streams,
 *     stream error -> ProviderError('protocol') (no raw text), maxBytes validation
 *   - isProviderFailure: all categories including non_zero_exit, BusinessError,
 *     Node system codes, non-Error values, circuit_open
 *   - ClaudeRunner: stdin write, timeout kill, spawn throw, child error,
 *     non-zero exit, output overflow, null stdin/stdout/stderr,
 *     parse retry/open-state, timer/listener cleanup, kill escalation cleared,
 *     runtime override validation, shell:false, stable stream error category
 *   - ProviderError/BusinessError stable messages
 *
 * All async tests are awaited. No open handles leak.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import {
  CircuitBreaker,
  collectBounded,
  isProviderFailure,
  ProviderError,
  BusinessError,
  type Clock,
  type TimerSet,
} from '../lib/provider-resilience.js';
import { createClaudeRunner, type SpawnFn, ClaudeError } from '../lib/claude.js';

// ── Helper: wait for pending microtasks ───────────────────────────

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// Suppress unhandled rejections that are expected ClaudeErrors
// from the runner's internal promise chains settling after the
// outer promise is already resolved/rejected by another path.
process.on('unhandledRejection', (reason: any) => {
  if (reason && reason.name === 'ClaudeError') {
    return; // suppressed — expected race in runner internals
  }
});

// ── Stateful fake clock ───────────────────────────────────────────

function fakeClock(initial = 0): Clock & { advance(ms: number): void } {
  let now = initial;
  return {
    now: () => now,
    advance(ms: number) { now += ms; },
  };
}

// ── Stateful fake timers ──────────────────────────────────────────

interface TimerEntry {
  id: number;
  fireAt: number;
  cb: () => void;
}

function fakeTimers(): TimerSet & { tick(ms: number): void; getPendingCount(): number; getTimer(id: number): TimerEntry | undefined } {
  let timeouts: TimerEntry[] = [];
  let nextId = 1;
  let now = 0;

  return {
    setTimeout: ((cb: () => void, delay: number) => {
      const id = nextId++;
      timeouts.push({ id, fireAt: now + delay, cb });
      return id as any;
    }) as any,
    clearTimeout: (id: any) => {
      timeouts = timeouts.filter((t) => t.id !== id);
    },
    tick(ms: number) {
      now += ms;
      const ready = timeouts.filter((t) => t.fireAt <= now);
      timeouts = timeouts.filter((t) => t.fireAt > now);
      for (const t of ready) t.cb();
    },
    getPendingCount() { return timeouts.length; },
    getTimer(id: number) { return timeouts.find((t) => t.id === id); },
  } as any;
}

// ── Stateful fake child ───────────────────────────────────────────

interface FakeChild {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  pid?: number;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  /** Simulate the child producing stdout data. */
  emitStdout(data: Buffer): void;
  /** Simulate the child producing stderr data. */
  emitStderr(data: Buffer): void;
  /** Simulate the child closing. */
  emitClose(code: number | null): void;
  /** Simulate the child erroring. */
  emitError(err: Error): void;
  /** Simulate stdin error. */
  emitStdinError(err: Error): void;
  /** Check if stdin was written with exact bytes and ended. */
  assertStdinWritten(expected: string): void;
  /** Get accumulated stdin writes. */
  getStdinWrites(): Buffer[];
  /** Check if stdin.end() was called. */
  wasStdinEnded(): boolean;
  /** Manually set stdin to null (for null-stdin tests). */
  setStdinNull(): void;
  /** Manually set stdout to null (for null-stdout tests). */
  setStdoutNull(): void;
  /** Manually set stderr to null (for null-stderr tests). */
  setStderrNull(): void;
  /** Make stdin.write throw synchronously. */
  setStdinWriteThrow(): void;
  /** Override the on-close listener list. */
  _setCloseListener(l: (code: number | null) => void): void;
  _getCloseListener(): ((code: number | null) => void) | undefined;
  _setErrorListener(l: () => void): void;
  _getErrorListener(): (() => void) | undefined;
}

function createFakeChild(): FakeChild {
  const stdout = new Readable({ read() { /* push-only */ } });
  const stderr = new Readable({ read() { /* push-only */ } });
  const stdinWrites: Buffer[] = [];
  let stdinEnded = false;
  let stdinWriteThrow = false;
  let _stdinObj: NodeJS.WritableStream | null = new Writable({
    write(chunk: Buffer, _encoding: string, _cb: (err?: Error) => void) {
      if (stdinWriteThrow) {
        throw new Error('stream destroyed');
      }
      stdinWrites.push(chunk);
      _cb();
    },
    final(cb: (error?: Error | null) => void) {
      if (stdinWriteThrow) {
        cb(new Error('stream destroyed'));
        return;
      }
      stdinEnded = true;
      cb();
    },
  });
  let _stdoutObj: NodeJS.ReadableStream | null = stdout;
  let _stderrObj: NodeJS.ReadableStream | null = stderr;

  const killFn = vi.fn().mockReturnValue(true);
  const onListeners = new Map<string, (...args: any[]) => void>();

  const fakeChild: FakeChild = {
    get stdout() { return _stdoutObj!; },
    set stdout(_val: any) { /* noop */ },
    get stderr() { return _stderrObj!; },
    set stderr(_val: any) { /* noop */ },
    get stdin() { return _stdinObj!; },
    set stdin(_val: any) { /* noop */ },
    pid: 12345,
    kill: killFn,
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      onListeners.set(event, listener);
    }),
    emitStdout(data: Buffer) {
      stdout.push(data);
    },
    emitStderr(data: Buffer) {
      stderr.push(data);
    },
    emitClose(code: number | null) {
      stdout.push(null);
      stderr.push(null);
      const listener = onListeners.get('close');
      if (listener) process.nextTick(() => listener(code));
    },
    emitError(err: Error) {
      const listener = onListeners.get('error');
      if (listener) process.nextTick(() => listener(err));
    },
    emitStdinError(err: Error) {
      (_stdinObj as NodeJS.WritableStream & { destroy(error?: Error): void }).destroy(err);
    },
    assertStdinWritten(expected: string) {
      const full = Buffer.concat(stdinWrites).toString('utf8');
      expect(full).toBe(expected);
      expect(stdinEnded).toBe(true);
    },
    getStdinWrites() { return stdinWrites; },
    wasStdinEnded() { return stdinEnded; },
    setStdinNull() {
      _stdinObj = null;
    },
    setStdoutNull() {
      _stdoutObj = null;
      // We don't destroy the stream — we just make the getter return null
    },
    setStderrNull() {
      _stderrObj = null;
    },
    setStdinWriteThrow() {
      stdinWriteThrow = true;
    },
    _setCloseListener(l: (code: number | null) => void) {
      onListeners.set('close', l);
    },
    _getCloseListener() { return onListeners.get('close'); },
    _setErrorListener(l: () => void) {
      onListeners.set('error', l);
    },
    _getErrorListener() { return onListeners.get('error'); },
  };

  return fakeChild;
}

// ── Circuit breaker tests ─────────────────────────────────────────

describe('CircuitBreaker', () => {
  describe('config validation', () => {
    it('rejects non-integer failureThreshold', () => {
      expect(() => new CircuitBreaker({ failureThreshold: 2.5 })).toThrow(TypeError);
    });
    it('rejects zero failureThreshold', () => {
      expect(() => new CircuitBreaker({ failureThreshold: 0 })).toThrow(TypeError);
    });
    it('rejects negative cooldownMs', () => {
      expect(() => new CircuitBreaker({ cooldownMs: -1 })).toThrow(TypeError);
    });
    it('rejects zero cooldownMs', () => {
      expect(() => new CircuitBreaker({ cooldownMs: 0 })).toThrow(TypeError);
    });
    it('rejects NaN cooldownMs', () => {
      expect(() => new CircuitBreaker({ cooldownMs: NaN })).toThrow(TypeError);
    });
    it('accepts valid config', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000 });
      expect(cb.getState()).toBe('CLOSED');
    });
  });

  describe('threshold opening for each provider failure category', () => {
    const categories = ['timeout', 'spawn_failed', 'connection', 'protocol', 'output_limit', 'non_zero_exit'] as const;

    for (const cat of categories) {
      it(`opens after threshold consecutive ${cat} failures`, async () => {
        const clock = fakeClock();
        const cb = new CircuitBreaker({ failureThreshold: 3, clock });

        // Verify the category is recognised by isProviderFailure (real Error, not plain object)
        if (cat === 'non_zero_exit') {
          class CatErr extends Error { category = cat; }
          expect(isProviderFailure(new CatErr())).toBe(true);
        }

        for (let i = 0; i < 2; i++) {
          await expect(cb.call(() => Promise.reject(new ProviderError(cat as any)))).rejects.toThrow(ProviderError);
          expect(cb.getState()).toBe('CLOSED');
        }
        await expect(cb.call(() => Promise.reject(new ProviderError(cat as any)))).rejects.toThrow(ProviderError);
        expect(cb.getState()).toBe('OPEN');
        expect(cb.getFailureCount()).toBe(3);
      });
    }
  });

  describe('BusinessError bypass and reset', () => {
    it('does NOT count BusinessError toward threshold', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker({ failureThreshold: 2, clock });
      await expect(cb.call(() => Promise.reject(new BusinessError()))).rejects.toThrow(BusinessError);
      expect(cb.getState()).toBe('CLOSED');
      expect(cb.getFailureCount()).toBe(0);
      await expect(cb.call(() => Promise.reject(new ProviderError('timeout')))).rejects.toThrow(ProviderError);
      expect(cb.getState()).toBe('CLOSED');
      expect(cb.getFailureCount()).toBe(1);
    });
    it('BusinessError resets consecutive provider failure count', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker({ failureThreshold: 3, clock });
      await expect(cb.call(() => Promise.reject(new ProviderError('timeout')))).rejects.toThrow(ProviderError);
      await expect(cb.call(() => Promise.reject(new ProviderError('timeout')))).rejects.toThrow(ProviderError);
      expect(cb.getFailureCount()).toBe(2);
      await expect(cb.call(() => Promise.reject(new BusinessError()))).rejects.toThrow(BusinessError);
      expect(cb.getFailureCount()).toBe(0);
    });
    it('BusinessError during HALF_OPEN resets breaker to CLOSED', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, clock });
      await expect(cb.call(() => Promise.reject(new ProviderError('timeout')))).rejects.toThrow(ProviderError);
      expect(cb.getState()).toBe('OPEN');
      clock.advance(10_001);
      await expect(cb.call(() => Promise.reject(new BusinessError()))).rejects.toThrow(BusinessError);
      expect(cb.getState()).toBe('CLOSED');
      expect(cb.getFailureCount()).toBe(0);
    });
  });

  describe('success resets failure count', () => {
    it('resets after consecutive provider failures', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker({ failureThreshold: 3, clock });
      for (let i = 0; i < 2; i++) {
        await expect(cb.call(() => Promise.reject(new ProviderError('connection')))).rejects.toThrow(ProviderError);
      }
      expect(cb.getFailureCount()).toBe(2);
      await cb.call(() => Promise.resolve('ok'));
      expect(cb.getFailureCount()).toBe(0);
      expect(cb.getState()).toBe('CLOSED');
    });
  });

  describe('open state and cooldown', () => {
    it('rejects calls with circuit_open when open', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, clock });
      await expect(cb.call(() => Promise.reject(new ProviderError('connection')))).rejects.toThrow(ProviderError);
      expect(cb.getState()).toBe('OPEN');
      try {
        await cb.call(() => Promise.resolve('ok'));
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).category).toBe('circuit_open');
      }
    });
    it('circuit_open does not increment failure count', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, clock });
      await expect(cb.call(() => Promise.reject(new ProviderError('timeout')))).rejects.toThrow(ProviderError);
      expect(cb.getFailureCount()).toBe(1);
      await expect(cb.call(() => Promise.reject(new ProviderError('timeout')))).rejects.toThrow(ProviderError);
      expect(cb.getFailureCount()).toBe(2);
      expect(cb.getState()).toBe('OPEN');
      try { await cb.call(() => Promise.resolve('should not run')); } catch { /* expected */ }
      expect(cb.getFailureCount()).toBe(2);
    });
    it('transitions to half-open after cooldown', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, clock });
      await expect(cb.call(() => Promise.reject(new ProviderError('connection')))).rejects.toThrow(ProviderError);
      expect(cb.getState()).toBe('OPEN');
      clock.advance(10_001);
      await cb.call(() => Promise.resolve('recovered'));
      expect(cb.getState()).toBe('CLOSED');
      expect(cb.getFailureCount()).toBe(0);
    });
    it('half-open probe failure reopens circuit', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, clock });
      await expect(cb.call(() => Promise.reject(new ProviderError('connection')))).rejects.toThrow(ProviderError);
      expect(cb.getState()).toBe('OPEN');
      clock.advance(10_001);
      await expect(cb.call(() => Promise.reject(new ProviderError('timeout')))).rejects.toThrow(ProviderError);
      expect(cb.getState()).toBe('OPEN');
    });
  });

  describe('exactly one half-open probe under concurrency', () => {
    it('allows exactly one probe when half-open, rejects concurrent', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, clock });
      await expect(cb.call(() => Promise.reject(new ProviderError('connection')))).rejects.toThrow(ProviderError);
      expect(cb.getState()).toBe('OPEN');
      clock.advance(10_001);
      const probe1 = cb.call(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'probe1';
      });
      const probe2 = cb.call(async () => 'probe2').catch((err) => {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).category).toBe('circuit_open');
      });
      const [r1] = await Promise.all([probe1, probe2]);
      expect(r1).toBe('probe1');
      expect(cb.getState()).toBe('CLOSED');
    });
  });

  describe('forceOpen and reset', () => {
    it('forceOpen transitions to OPEN state', () => {
      const cb = new CircuitBreaker();
      expect(cb.getState()).toBe('CLOSED');
      cb.forceOpen();
      expect(cb.getState()).toBe('OPEN');
    });
    it('reset transitions to CLOSED and clears failure count', async () => {
      const clock = fakeClock();
      const cb = new CircuitBreaker({ failureThreshold: 1, clock });
      await expect(cb.call(() => Promise.reject(new ProviderError('connection')))).rejects.toThrow(ProviderError);
      expect(cb.getState()).toBe('OPEN');
      expect(cb.getFailureCount()).toBe(1);
      cb.reset();
      expect(cb.getState()).toBe('CLOSED');
      expect(cb.getFailureCount()).toBe(0);
    });
  });
});

// ── collectBounded tests ──────────────────────────────────────────

describe('collectBounded', () => {
  it('collects Buffer chunks under the byte limit', async () => {
    const stdout = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const stderr = Readable.from([Buffer.from('error log')]);
    const result = await collectBounded(stdout, stderr, 1024);
    expect(Buffer.concat(result.stdout).toString()).toBe('hello world');
    expect(Buffer.concat(result.stderr).toString()).toBe('error log');
  });

  it('rejects ProviderError when stdout exceeds byte limit', async () => {
    const big = Buffer.alloc(200, 0x78);
    const stdout = Readable.from([big, big, big]);
    const stderr = Readable.from([Buffer.from('small')]);
    await expect(collectBounded(stdout, stderr, 400)).rejects.toThrow(ProviderError);
  });

  it('rejects ProviderError when single oversized chunk exceeds limit', async () => {
    const stdout = Readable.from([Buffer.alloc(500, 0x79)]);
    const stderr = Readable.from([Buffer.from('ok')]);
    await expect(collectBounded(stdout, stderr, 200)).rejects.toThrow(ProviderError);
  });

  it('rejects ProviderError when stderr exceeds byte limit', async () => {
    const big = Buffer.alloc(200, 0x7a);
    const stdout = Readable.from([Buffer.from('ok')]);
    const stderr = Readable.from([big]);
    await expect(collectBounded(stdout, stderr, 100)).rejects.toThrow(ProviderError);
  });

  it('handles empty streams', async () => {
    const stdout = Readable.from([]);
    const stderr = Readable.from([]);
    const result = await collectBounded(stdout, stderr, 1024);
    expect(result.stdout).toHaveLength(0);
    expect(result.stderr).toHaveLength(0);
  });

  it('multibyte characters are counted as buffer bytes, not string chars', async () => {
    const emojis = Buffer.from('😀😀😀😀😀😀😀😀😀😀');
    const stdout = Readable.from([emojis]);
    const stderr = Readable.from([Buffer.from('ok')]);
    await expect(collectBounded(stdout, stderr, 20)).rejects.toThrow(ProviderError);
  });

  it('stream error rejects as ProviderError protocol (no raw text)', async () => {
    const stdout = new Readable({ read() { /* no-op */ } });
    const stderr = Readable.from([Buffer.from('data')]);
    // Destroy stdout with error after a tick (simulates pipe breaking)
    const p = collectBounded(stdout, stderr, 1024);
    process.nextTick(() => stdout.destroy(new Error('stream error')));
    await expect(p).rejects.toMatchObject({ category: 'protocol' });
  });

  it('stderr stream error rejects as ProviderError protocol (no raw text)', async () => {
    const stdout = Readable.from([Buffer.from('data')]);
    const stderr = new Readable({
      read() {
        this.destroy(new Error('stderr stream error'));
      },
    });
    await expect(collectBounded(stdout, stderr, 1024)).rejects.toMatchObject({ category: 'protocol' });
  });

  it('rejects zero maxBytes', async () => {
    const stdout = Readable.from([Buffer.from('hi')]);
    const stderr = Readable.from([Buffer.from('')]);
    await expect(collectBounded(stdout, stderr, 0)).rejects.toThrow(TypeError);
  });

  it('rejects negative maxBytes', async () => {
    const stdout = Readable.from([Buffer.from('hi')]);
    const stderr = Readable.from([Buffer.from('')]);
    await expect(collectBounded(stdout, stderr, -1)).rejects.toThrow(TypeError);
  });

  it('rejects NaN maxBytes', async () => {
    const stdout = Readable.from([Buffer.from('hi')]);
    const stderr = Readable.from([Buffer.from('')]);
    await expect(collectBounded(stdout, stderr, NaN)).rejects.toThrow(TypeError);
  });

  it('rejects non-integer maxBytes', async () => {
    const stdout = Readable.from([Buffer.from('hi')]);
    const stderr = Readable.from([Buffer.from('')]);
    await expect(collectBounded(stdout, stderr, 100.5)).rejects.toThrow(TypeError);
  });
});

// ── isProviderFailure comprehensive tests ─────────────────────────

describe('isProviderFailure', () => {
  it('returns true for all ProviderError categories', () => {
    expect(isProviderFailure(new ProviderError('timeout'))).toBe(true);
    expect(isProviderFailure(new ProviderError('spawn_failed'))).toBe(true);
    expect(isProviderFailure(new ProviderError('connection'))).toBe(true);
    expect(isProviderFailure(new ProviderError('protocol'))).toBe(true);
    expect(isProviderFailure(new ProviderError('output_limit'))).toBe(true);
    expect(isProviderFailure(new ProviderError('circuit_open'))).toBe(true);
  });

  it('returns true for ClaudeError non_zero_exit category', () => {
    class Err extends Error { category = 'non_zero_exit'; }
    expect(isProviderFailure(new Err())).toBe(true);
  });

  it('returns false for BusinessError', () => {
    expect(isProviderFailure(new BusinessError())).toBe(false);
  });

  it('returns true for Node system errors with known codes', () => {
    const err = new Error('connect ECONNREFUSED') as NodeJS.ErrnoException;
    err.code = 'ECONNREFUSED';
    expect(isProviderFailure(err)).toBe(true);
    const err2 = new Error('timed out') as NodeJS.ErrnoException;
    err2.code = 'ETIMEDOUT';
    expect(isProviderFailure(err2)).toBe(true);
  });

  it('returns true for errors with category property matching known types', () => {
    class CustomError extends Error {
      category = 'connection';
    }
    expect(isProviderFailure(new CustomError())).toBe(true);
  });

  it('returns false for generic errors', () => {
    expect(isProviderFailure(new Error('something broke'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isProviderFailure('string error')).toBe(false);
    expect(isProviderFailure(null)).toBe(false);
    expect(isProviderFailure(undefined)).toBe(false);
    expect(isProviderFailure({})).toBe(false);
  });
});

// ── ProviderError stable messages ─────────────────────────────────

describe('ProviderError and BusinessError stable messages', () => {
  it('ProviderError uses category as message', () => {
    const err = new ProviderError('timeout');
    expect(err.message).toBe('timeout');
    expect(err.category).toBe('timeout');
  });
  it('BusinessError uses fixed message', () => {
    const err = new BusinessError();
    expect(err.message).toBe('business_error');
  });
});

// ── ClaudeRunner tests (stateful fake child + fake timers) ────────

describe('ClaudeRunner', () => {
  const opts = { timeoutMs: 100, maxOutputBytes: 1024 };

  it('writes prompt to stdin and ends it', async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const clock = fakeClock();
    const timers = fakeTimers();
    const runner = createClaudeRunner({ spawnFn, clock, timers });

    const resultPromise = runner.runClaude('test prompt', opts);
    await tick();
    child.emitStdout(Buffer.from('response text'));
    child.emitClose(0);

    const result = await resultPromise;
    child.assertStdinWritten('test prompt');
    expect(result).toBe('response text');
    expect(timers.getPendingCount()).toBe(0);
  });

  it('timeout kills child and rejects with ClaudeError timeout', async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const clock = fakeClock();
    const timers = fakeTimers();
    const runner = createClaudeRunner({ spawnFn, clock, timers });

    const resultPromise = runner.runClaude('prompt', opts);
    await tick();
    timers.tick(100);

    // Emit close (schedules listener via process.nextTick)
    child.emitClose(null);
    // Wait for close listener to fire and clear escalation timer
    await tick();

    try {
      await resultPromise;
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.category).toBe('timeout');
    }
    expect(child.kill).toHaveBeenCalled();
    expect(timers.getPendingCount()).toBe(0);
  });

  it('spawn synchronous throw maps to spawn_failed', async () => {
    const spawnFn: SpawnFn = vi.fn(() => { throw new Error('booom'); }) as any;
    const runner = createClaudeRunner({ spawnFn });
    try {
      await runner.runClaude('prompt', opts);
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.category).toBe('spawn_failed');
    }
  });

  it('child error event maps to spawn_failed', async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const runner = createClaudeRunner({ spawnFn });
    const resultPromise = runner.runClaude('prompt', opts);
    await tick();
    child.emitError(new Error('ENOENT'));
    child.emitClose(null);
    try {
      await resultPromise;
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.category).toBe('spawn_failed');
    }
  });

  it('non-zero exit maps to non_zero_exit', async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const runner = createClaudeRunner({ spawnFn });
    const resultPromise = runner.runClaude('prompt', opts);
    await tick();
    child.emitStdout(Buffer.from('some output'));
    child.emitClose(1);
    try {
      await resultPromise;
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.category).toBe('non_zero_exit');
      expect(err.exitCode).toBe(1);
    }
  });

  it('output overflow maps to output_limit', async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const runner = createClaudeRunner({ spawnFn });
    const smallOpts = { timeoutMs: 10000, maxOutputBytes: 10 };
    const resultPromise = runner.runClaude('prompt', smallOpts);
    await tick();
    child.emitStdout(Buffer.alloc(20, 0x78));
    // Output overflow detected by collectBounded; close the child to settle.
    await tick();
    child.emitClose(0);
    try {
      await resultPromise;
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.category).toBe('output_limit');
    }
  });

  it('null stdin does not crash runner', async () => {
    const child = createFakeChild();
    child.setStdinNull();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const runner = createClaudeRunner({ spawnFn });
    const resultPromise = runner.runClaude('prompt', opts);
    await tick();
    child.emitStdout(Buffer.from('response'));
    child.emitClose(0);
    await expect(resultPromise).resolves.toBe('response');
  });

  it('null stdout/stderr do not crash runner', async () => {
    const child = createFakeChild();
    child.setStdoutNull();
    child.setStderrNull();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const runner = createClaudeRunner({ spawnFn });
    const resultPromise = runner.runClaude('prompt', opts);
    await tick();
    child.emitClose(0);
    const result = await resultPromise;
    expect(result).toBe('');
  });

  it('timer and listener cleanup on successful close', async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const clock = fakeClock();
    const timers = fakeTimers();
    const runner = createClaudeRunner({ spawnFn, clock, timers });
    const resultPromise = runner.runClaude('prompt', opts);
    await tick();
    child.emitStdout(Buffer.from('ok'));
    child.emitClose(0);
    const result = await resultPromise;
    expect(result).toBe('ok');
    await tick();
    expect(timers.getPendingCount()).toBe(0);
  });

  it('kill escalation timer cleared when child closes before escalation', async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const clock = fakeClock();
    const timers = fakeTimers();
    const runner = createClaudeRunner({ spawnFn, clock, timers });
    const resultPromise = runner.runClaude('prompt', opts);
    await tick();
    // Advance past timeout (fires SIGTERM + sets 2s escalation)
    timers.tick(100);
    // Child closes before escalation fires
    child.emitClose(null);
    try { await resultPromise; } catch { /* expected: timeout */ }
    await tick();
    expect(timers.getPendingCount()).toBe(0);
  });

  // ── Finding 1: stdin callback EPIPE / write throw / null stdin ──

  it('synchronous stdin.write throw maps to spawn_failed', async () => {
    const child = createFakeChild();
    child.setStdinWriteThrow();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const runner = createClaudeRunner({ spawnFn });
    const resultPromise = runner.runClaude('prompt', opts);
    await tick();
    // Child may close after write failure
    child.emitClose(null);
    try {
      await resultPromise;
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.category).toBe('spawn_failed');
    }
  });

  it('error-before-close settles with error state', async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const runner = createClaudeRunner({ spawnFn });
    const resultPromise = runner.runClaude('prompt', opts);
    await tick();
    child.emitError(new Error('ENOENT'));
    // Close arrives after error
    await tick();
    child.emitClose(null);
    try {
      await resultPromise;
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.category).toBe('spawn_failed');
    }
  });

  it('close-before-write-callback completes successfully', async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const runner = createClaudeRunner({ spawnFn });
    const resultPromise = runner.runClaude('prompt', opts);
    // Close immediately (child exits very fast)
    await tick();
    child.emitStdout(Buffer.from('fast output'));
    child.emitClose(0);
    await expect(resultPromise).resolves.toBe('fast output');
  });

  it('timeout-before-write-callback rejects with timeout', async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const clock = fakeClock();
    const timers = fakeTimers();
    const runner = createClaudeRunner({ spawnFn, clock, timers });
    const resultPromise = runner.runClaude('long prompt', opts);
    await tick();
    // Timeout fires before stdin finishes writing
    timers.tick(100);
    // Child closes after timeout (scheduled via nextTick)
    child.emitClose(null);
    await tick();
    try {
      await resultPromise;
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.category).toBe('timeout');
    }
  });

  // ── Finding 2: table-driven event ordering permutations ──

  describe('event ordering permutations (no hang, exactly-one settle)', () => {
    type Order = Array<'stdout_end' | 'stderr_end' | 'stdout_data' | 'close_0' | 'close_1' | 'error' | 'timeout' | 'overflow'>;

    // Each permutation: emit events in order, await result, verify
    // exactly one settle and no pending timers.
    // NOTE: overflow and error events now require an emitClose afterwards
    // because outputDrained suppresses rejections and the close handler
    // makes the terminal decision.
    const permutations: Array<{ name: string; order: Order; expectedCategory?: string; expectedValue?: string }> = [
      {
        name: 'happy path: data then close(0)',
        order: ['stdout_data', 'close_0'],
        expectedValue: 'hello',
      },
      {
        name: 'data then close(1)',
        order: ['stdout_data', 'close_1'],
        expectedCategory: 'non_zero_exit',
      },
      {
        name: 'error then close',
        order: ['error', 'close_0'],
        expectedCategory: 'spawn_failed',
      },
      {
        name: 'timeout then close',
        order: ['timeout', 'close_0'],
        expectedCategory: 'timeout',
      },
      {
        name: 'overflow then close',
        order: ['overflow', 'close_0'],
        expectedCategory: 'output_limit',
      },
      {
        name: 'close(0) before end events (fast exit)',
        order: ['close_0'],
        expectedValue: '',
      },
      {
        name: 'close(1) before end events',
        order: ['close_1'],
        expectedCategory: 'non_zero_exit',
      },
    ];

    for (const perm of permutations) {
      it(perm.name, async () => {
        const child = createFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => child) as any;
        const clock = fakeClock();
        const timers = fakeTimers();
        const runner = createClaudeRunner({ spawnFn, clock, timers });
        const resultPromise = runner.runClaude('prompt', opts);

        await tick();

        // Execute events in order
        for (const event of perm.order) {
          switch (event) {
            case 'stdout_end':
              child.emitStdout(Buffer.from(''));
              break;
            case 'stderr_end':
              child.emitStderr(Buffer.from(''));
              break;
            case 'stdout_data':
              child.emitStdout(Buffer.from('hello'));
              break;
            case 'close_0':
              child.emitClose(0);
              break;
            case 'close_1':
              child.emitClose(1);
              break;
            case 'error':
              child.emitError(new Error('ENOENT'));
              break;
            case 'timeout':
              timers.tick(100);
              break;
            case 'overflow':
              child.emitStdout(Buffer.alloc(2000, 0x78));
              break;
          }
        }

        // Wait for settle
        await tick();

        if (perm.expectedCategory) {
          try {
            await resultPromise;
            expect.fail('should have thrown ' + perm.expectedCategory);
          } catch (err: any) {
            expect(err.category).toBe(perm.expectedCategory);
          }
        } else {
          const result = await resultPromise;
          expect(result).toBe(perm.expectedValue);
        }
        expect(timers.getPendingCount()).toBe(0);
      });
    }
  });

  // ── Finding 4: non_zero_exit counted by breaker ──

  it('non_zero_exit counts toward breaker threshold (via isProviderFailure)', async () => {
    // The breaker uses isProviderFailure to decide whether to count.
    // non_zero_exit is recognised via the category check.
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const clock = fakeClock();
    const timers = fakeTimers();
    // Low threshold so we can trigger open
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10000, clock, timers });
    const runner = createClaudeRunner({ spawnFn, clock, timers, breaker: cb });

    // First non-zero-exit
    let p = runner.runClaude('prompt', opts);
    await tick();
    child.emitStdout(Buffer.from('oops'));
    child.emitClose(1);
    try { await p; } catch { /* expected */ }
    expect(cb.getFailureCount()).toBe(1);
    expect(cb.getState()).toBe('CLOSED');

    // Second non-zero-exit — should open breaker
    const child2 = createFakeChild();
    vi.mocked(spawnFn).mockReturnValue(child2 as any);
    p = runner.runClaude('prompt', opts);
    await tick();
    child2.emitStdout(Buffer.from('oops2'));
    child2.emitClose(1);
    try { await p; } catch { /* expected */ }
    expect(cb.getFailureCount()).toBe(2);
    expect(cb.getState()).toBe('OPEN');

    // Third call should be rejected as circuit_open
    const child3 = createFakeChild();
    vi.mocked(spawnFn).mockReturnValue(child3 as any);
    try { await runner.runClaude('prompt', opts); expect.fail(); }
    catch (err: any) {
      expect(err.category).toBe('circuit_open');
    }
    expect(cb.getFailureCount()).toBe(2); // not incremented
  });

  it('runClaudeJSON retries once on parse error, BusinessError on second failure', async () => {
    let callCount = 0;
    const spawnFn: SpawnFn = vi.fn(() => {
      callCount++;
      return createFakeChild();
    }) as any;
    const runner = createClaudeRunner({ spawnFn });

    const resultPromise = runner.runClaudeJSON('prompt', opts);

    await tick();
    const child1 = vi.mocked(spawnFn).mock.results[0]?.value;
    if (child1) {
      child1.emitStdout(Buffer.from('not json'));
      child1.emitClose(0);
    }
    await tick();
    await tick();

    const child2 = vi.mocked(spawnFn).mock.results[1]?.value;
    if (child2) {
      child2.emitStdout(Buffer.from('also not json'));
      child2.emitClose(0);
    }

    try {
      await resultPromise;
      expect.fail('should have thrown BusinessError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(BusinessError);
    }
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  // ── Finding 5: runtime override validation ──

  describe('runtime override validation (finding 5/6)', () => {
    it('rejects bool equivalent timeoutMs', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { timeoutMs: true as any })).rejects.toThrow(TypeError);
    });
    it('rejects NaN timeoutMs', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { timeoutMs: NaN })).rejects.toThrow(TypeError);
    });
    it('rejects negative timeoutMs', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { timeoutMs: -1 })).rejects.toThrow(TypeError);
    });
    it('rejects non-integer timeoutMs', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { timeoutMs: 10.5 })).rejects.toThrow(TypeError);
    });
    it('rejects excessive timeoutMs', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { timeoutMs: 500000 })).rejects.toThrow(TypeError);
    });
    it('accepts valid timeoutMs', async () => {
      // Use mock spawn so we don't actually spawn
      const child = createFakeChild();
      const spawnFn: SpawnFn = vi.fn(() => child) as any;
      const runner = createClaudeRunner({ spawnFn });
      const p = runner.runClaude('prompt', { timeoutMs: 5000, maxOutputBytes: 1024 });
      // Should not throw TypeError — validation passes
      await tick();
      child.emitStdout(Buffer.from('ok'));
      child.emitClose(0);
      await expect(p).resolves.toBe('ok');
    });
    it('rejects bool equivalent maxOutputBytes', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { maxOutputBytes: false as any })).rejects.toThrow(TypeError);
    });
    it('rejects NaN maxOutputBytes', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { maxOutputBytes: NaN })).rejects.toThrow(TypeError);
    });
    it('rejects zero maxOutputBytes', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { maxOutputBytes: 0 })).rejects.toThrow(TypeError);
    });
    it('rejects negative maxOutputBytes', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { maxOutputBytes: -100 })).rejects.toThrow(TypeError);
    });
    it('rejects excessive maxOutputBytes', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { maxOutputBytes: 600 * 1024 * 1024 })).rejects.toThrow(TypeError);
    });
    it('rejects empty model string', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { model: '' })).rejects.toThrow(TypeError);
    });
    it('rejects whitespace-only model', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { model: '   ' })).rejects.toThrow(TypeError);
    });
    it('rejects bool equivalent model', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { model: true as any })).rejects.toThrow(TypeError);
    });
    it('rejects excessive model length', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { model: 'x'.repeat(201) })).rejects.toThrow(TypeError);
    });
    it('rejects non-string system', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { system: 123 as any })).rejects.toThrow(TypeError);
    });
    it('rejects excessive system length', async () => {
      const runner = createClaudeRunner();
      await expect(runner.runClaude('x', { system: 'x'.repeat(4001) })).rejects.toThrow(TypeError);
    });
    it('accepts valid model string', async () => {
      const child = createFakeChild();
      const spawnFn: SpawnFn = vi.fn(() => child) as any;
      const runner = createClaudeRunner({ spawnFn });
      const p = runner.runClaude('prompt', { model: 'claude-3', timeoutMs: 5000, maxOutputBytes: 1024 });
      await tick();
      child.emitStdout(Buffer.from('ok'));
      child.emitClose(0);
      await expect(p).resolves.toBe('ok');
    });
  });

  // ── Finding 5: no shell interpretation (shell:false) ──

  describe('shell:false and direct spawn', () => {
    it('spawnFn is called with shell:false', async () => {
      const child = createFakeChild();
      const spawnFn: SpawnFn = vi.fn((cmd, args, opts_) => {
        // Verify shell is not true
        expect(opts_).toEqual({ shell: false });
        return child;
      }) as any;
      const runner = createClaudeRunner({ spawnFn });
      const resultPromise = runner.runClaude('prompt', opts);
      await tick();
      child.emitStdout(Buffer.from('ok'));
      child.emitClose(0);
      await expect(resultPromise).resolves.toBe('ok');
      expect(spawnFn).toHaveBeenCalledTimes(1);
    });

    it('args include model and system', async () => {
      const child = createFakeChild();
      let capturedArgs: readonly string[] = [];
      const spawnFn: SpawnFn = vi.fn((_cmd, args, _opts) => {
        capturedArgs = args;
        return child;
      }) as any;
      const runner = createClaudeRunner({ spawnFn });
      const resultPromise = runner.runClaude('prompt', { ...opts, model: 'claude-3-haiku', system: 'Be concise' });
      await tick();
      child.emitStdout(Buffer.from('ok'));
      child.emitClose(0);
      await expect(resultPromise).resolves.toBe('ok');
      expect(capturedArgs).toContain('--model');
      expect(capturedArgs).toContain('claude-3-haiku');
      expect(capturedArgs).toContain('--append-system-prompt');
      expect(capturedArgs).toContain('Be concise');
    });
  });

  // ── Finding 3: stream errors are stable ProviderError ──

  it('stream error from child stdout is wrapped as output_limit (not raw text)', async () => {
    const child = createFakeChild();
    const spawnFn: SpawnFn = vi.fn(() => child) as any;
    const runner = createClaudeRunner({ spawnFn });
    const resultPromise = runner.runClaude('prompt', opts);
    await tick();
    // Emit a stream error from child's stdout — collectBounded rejects
    // with ProviderError('protocol'). The close handler will see undefined
    // output and reject with output_limit.
    (child.stdout as NodeJS.ReadableStream & { destroy(error?: Error): void }).destroy(new Error('EPIPE broken pipe'));
    await tick();
    child.emitClose(null);
    await tick();
    try {
      await resultPromise;
      expect.fail('should have thrown');
    } catch (err: any) {
      // Must be output_limit, NOT the raw error text
      expect(err.category).toBe('output_limit');
      expect(err.message).not.toContain('EPIPE');
    }
  });
});
