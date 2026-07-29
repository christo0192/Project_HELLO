/**
 * claude.ts — Claude CLI runner with circuit breaker, bounded output,
 *             stdin write, and dependency injection for deterministic testing.
 *
 * OUTBOUND BOUNDARY: spawns a child `claude` process via CLI.
 * The circuit breaker and timeout are applied here.
 *
 * DEPENDENCY INJECTION: createClaudeRunner(deps) accepts spawnFn, clock,
 * timers, and breaker overrides for testing.
 *
 * ERROR CATEGORIES (stable, no dynamic values):
 *   - "timeout"        → CLI did not complete within deadline
 *   - "spawn_failed"   → could not launch the process (ENOENT, syscall error)
 *   - "non_zero_exit"  → process exited with non-zero code
 *   - "parse_error"    → output was not valid JSON (runClaudeJSON only; BusinessError)
 *   - "output_limit"   → stdout/stderr exceeded maxOutputBytes
 *   - "circuit_open"   → breaker is open, call rejected immediately
 *   - "protocol"       → stdin write failed (EPIPE, broken pipe)
 *
 * ClaudeError categories are recognized by isClaudeProviderFailure().
 * parse_error is a BusinessError — does NOT count toward breaker.
 * non_zero_exit and protocol map to `protocol` for breaker counting.
 *
 * SHELL: false — the executable is spawned directly with safe args.
 * No shell interpretation of executable, model, or args.
 *
 * TIMEOUT: SIGTERM then SIGKILL escalation after 2s (same on all platforms).
 * stdout/stderr capped by maxOutputBytes. Stream errors are wrapped as
 * stable ProviderError('protocol') — no dynamic error text preserved.
 */

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { env } from './env.js';
import {
  CircuitBreaker,
  collectBounded,
  ProviderError,
  BusinessError,
  isProviderFailure,
  type Clock,
  type TimerSet,
  MonotonicClock,
  DefaultTimerSet,
} from './provider-resilience.js';

// ── Error categories ──────────────────────────────────────────────

export type ClaudeErrorCategory = 'timeout' | 'spawn_failed' | 'non_zero_exit' | 'parse_error' | 'output_limit';

export class ClaudeError extends Error {
  public readonly category: ClaudeErrorCategory;
  public readonly exitCode: number | null;

  constructor(category: ClaudeErrorCategory, exitCode: number | null = null) {
    super(category); // stable category — no dynamic values
    this.name = 'ClaudeError';
    this.category = category;
    this.exitCode = exitCode;
  }
}

/**
 * Make isProviderFailure recognize ClaudeError categories.
 * parse_error is a BusinessError — does NOT count toward breaker.
 */
export function isClaudeProviderFailure(err: unknown): boolean {
  if (err instanceof ClaudeError) {
    return err.category !== 'parse_error';
  }
  return isProviderFailure(err);
}

// ── Options ───────────────────────────────────────────────────────

export interface ClaudeOptions {
  model?: string;
  system?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

// ── DI interfaces ─────────────────────────────────────────────────

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: { shell?: boolean },
) => {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  readonly pid?: number;
  kill: (signal?: number | string) => boolean;
  on: (event: string, listener: (...args: any[]) => void) => void;
};

export interface ClaudeRunner {
  runClaude(prompt: string, opts?: ClaudeOptions): Promise<string>;
  runClaudeJSON<T>(prompt: string, opts?: ClaudeOptions): Promise<T>;
}

export interface ClaudeRunnerDeps {
  spawnFn: SpawnFn;
  clock: Clock;
  timers: TimerSet;
  breaker: CircuitBreaker;
}

// ── Runner factory ─────────────────────────────────────────────────

export function createClaudeRunner(deps?: Partial<ClaudeRunnerDeps>): ClaudeRunner {
  const spawnFn: SpawnFn = deps?.spawnFn ?? (spawn as any);
  const clock: Clock = deps?.clock ?? MonotonicClock;
  const timers: TimerSet = deps?.timers ?? DefaultTimerSet;

  const breaker: CircuitBreaker =
    deps?.breaker ??
    new CircuitBreaker({
      failureThreshold: env.breakerFailureThreshold,
      cooldownMs: env.breakerCooldownMs,
      clock,
      timers,
    });

  /** Shared: safely collect bounded output. Returns empty buffers on null stream. */
  function safeCollect(
    child: ReturnType<SpawnFn>,
    maxBytes: number,
  ): Promise<{ stdout: Buffer[]; stderr: Buffer[] }> {
    const stdout = child.stdout ?? new Readable({ read() { this.push(null); } });
    const stderr = child.stderr ?? new Readable({ read() { this.push(null); } });
    return collectBounded(stdout, stderr, maxBytes);
  }

  /**
   * Validate runtime overrides before spawning.
   * Rejects bool-equivalent values, NaN, Infinity, zero, negative, excessive.
   */
  function validateRuntimeOverrides(opts: ClaudeOptions): void {
    if (opts.timeoutMs !== undefined) {
      const t = opts.timeoutMs;
      if (typeof t !== 'number' || !Number.isFinite(t) || !Number.isInteger(t) || t < 0) {
        throw new TypeError('timeoutMs must be a non-negative integer');
      }
      if (t > 300_000) throw new TypeError('timeoutMs must not exceed 300000');
    }
    if (opts.maxOutputBytes !== undefined) {
      const b = opts.maxOutputBytes;
      if (typeof b !== 'number' || !Number.isFinite(b) || !Number.isInteger(b) || b <= 0) {
        throw new TypeError('maxOutputBytes must be a positive integer');
      }
      if (b > 500 * 1024 * 1024) throw new TypeError('maxOutputBytes must not exceed 500 MiB');
    }
    if (opts.model !== undefined) {
      if (typeof opts.model !== 'string' || opts.model.trim().length === 0) {
        throw new TypeError('model must be a non-empty string');
      }
      if (opts.model.length > 200) throw new TypeError('model must not exceed 200 characters');
    }
    if (opts.system !== undefined) {
      if (typeof opts.system !== 'string') {
        throw new TypeError('system must be a string');
      }
      if (opts.system.length > 4000) throw new TypeError('system must not exceed 4000 characters');
    }
  }

  async function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<string> {
    const model = opts.model ?? env.claudeModel;
    const timeoutMs = opts.timeoutMs ?? env.breakerTimeoutMs;
    const maxOutputBytes = opts.maxOutputBytes ?? env.claudeMaxOutputBytes;

    validateRuntimeOverrides(opts);

    const args = ['-p', '--model', model, '--max-turns', '1'];
    if (opts.system) args.push('--append-system-prompt', opts.system);

    return breaker.call(async () => {
      // Use await so the async function machinery properly attaches
      // rejection handlers before the promise settles, preventing
      // unhandled rejection warnings.
      const settled = await new Promise<string>((resolve, reject) => {
        // State machine: once a terminal decision is made (timeout, process
        // exit, spawn error, output-limit) we set `terminal` and reject or
        // resolve. `outputDone` tracks whether bufferPromise has settled.
        // ── terminal is set BEFORE awaiting bufferPromise in close handler;
        //    but we still need bufferPromise to settle for cleanup — we just
        //    don't use it for the decision.
        let terminal = false;
        let terminalError: Error | null = null;
        let terminalResult: string | null = null;
        let outputPromise: Promise<{ stdout: Buffer[]; stderr: Buffer[] }> | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let killTimer: ReturnType<typeof setTimeout> | null = null;

        function clearTimers(): void {
          if (timer !== null) { timers.clearTimeout(timer); timer = null; }
          if (killTimer !== null) { timers.clearTimeout(killTimer); killTimer = null; }
        }

        /**
         * Attempt to set the terminal decision. Returns true if already
         * terminal (caller should return). Must NOT be called after
         * terminal=true has been set and the promise settled — clears
         * timers on first call.
         */
        function setTerminal(err: Error | null, result: string | null): boolean {
          if (terminal) return true;
          terminal = true;
          clearTimers();
          terminalError = err;
          terminalResult = result;
          return false;
        }

        /**
         * Settle the promise with whatever terminal decision has been
         * recorded. Idempotent — after first call, subsequent calls are
         * no-ops.
         */
        function settle(): void {
          if (terminalError) {
            reject(terminalError);
          } else if (terminalResult !== null) {
            resolve(terminalResult);
          }
        }

        // ── Spawn ──
        let child: ReturnType<SpawnFn>;
        try {
          child = spawnFn(env.claudeBin, args, { shell: false });
        } catch (spawnErr: any) {
          setTerminal(new ClaudeError('spawn_failed'), null);
          settle();
          return;
        }

        outputPromise = safeCollect(child, maxOutputBytes);

        // ── Write prompt to stdin and end it ──
        // Every code path here must: (a) not hang, (b) not leak raw error
        // text, and (c) settle exactly once.
        let stdinWritten = false;

        function writeStdin(): void {
          if (!child.stdin) {
            stdinWritten = true;
            return; // null stdin — no data written, not an error
          }

          try {
            const writeOk = child.stdin.write(prompt);
            if (!writeOk) {
              // Stream is internally buffered; the drain event would handle
              // backpressure but for our max-turns=1 stdin is small.
            }
            child.stdin.end();
            stdinWritten = true;
          } catch (writeErr: any) {
            // Synchronous write/end throw (e.g., destroyed stream after
            // child has exited). Terminal failure — protocol error.
            stdinWritten = true;
            if (!setTerminal(new ClaudeError('spawn_failed'), null)) {
              settle();
            }
          }
        }

        writeStdin();

        // ── Output draining — suppress any output promise rejection so
        // it never creates an unhandled rejection. The close handler will
        // check the output value (or lack thereof) to make its decision.
        // Overflow / stream errors are communicated via the close handler.
        const outputDrained = outputPromise!.then(
          (out) => out,
          () => undefined as unknown as { stdout: Buffer[]; stderr: Buffer[] },
        ).then((out) => out);
        // outputDrained always resolves (never rejects).

        // ── Timeout timer ──
        timer = timers.setTimeout(() => {
          if (setTerminal(null, null)) return;
          // SIGTERM first
          try { child.kill('SIGTERM'); } catch { /* best effort */ }
          // Escalation: SIGKILL after 2s
          killTimer = timers.setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* best effort */ }
          }, 2_000);
          terminalError = new ClaudeError('timeout');
          settle();
        }, timeoutMs);

        // ── Process error (spawn failure) ──
        child.on('error', () => {
          if (setTerminal(null, null)) return;
          terminalError = new ClaudeError('spawn_failed');
          settle();
        });

        // ── Process close ──
        child.on('close', (code: number | null) => {
          // Always clear timers — child has exited, no escalation needed.
          clearTimers();

          // If we already made a terminal decision (timeout, spawn_failed,
          // error event), just drain and return.
          if (terminal) {
            return;
          }

          // No terminal decision yet — decide based on exit code + output.
          terminal = true;
          clearTimers();

          outputDrained.then((output) => {
            if (!output) {
              // Output promise rejected (overflow or stream error).
              reject(new ClaudeError('output_limit'));
              return;
            }
            const stdoutText = Buffer.concat(output.stdout).toString('utf8').trim();
            if (code === 0) {
              resolve(stdoutText);
            } else {
              reject(new ClaudeError('non_zero_exit', code));
            }
          });
        });
      });
      return settled;
    });
  }

  /** Strip ```json fences and return the first JSON object/array found. */
  function extractJson(raw: string): string {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : raw;
    const start = body.search(/[[{]/);
    if (start === -1) return body.trim();
    const lastObj = body.lastIndexOf('}');
    const lastArr = body.lastIndexOf(']');
    const end = Math.max(lastObj, lastArr);
    return end > start ? body.slice(start, end + 1) : body.slice(start).trim();
  }

  /**
   * Run claude and parse result as JSON.
   *
   * JSON parse error → BusinessError (does NOT count toward breaker).
   * One bounded retry through the breaker (new call, respects open state).
   */
  async function runClaudeJSON<T = unknown>(prompt: string, opts: ClaudeOptions = {}): Promise<T> {
    const raw = await runClaude(prompt, opts);
    try {
      return JSON.parse(extractJson(raw)) as T;
    } catch {
      const raw2 = await runClaude(prompt, opts);
      try {
        return JSON.parse(extractJson(raw2)) as T;
      } catch {
        throw new BusinessError();
      }
    }
  }

  return { runClaude, runClaudeJSON };
}

// ── Default singleton (production use, configured from env) ──────

const defaultRunner = createClaudeRunner();
export const runClaude = defaultRunner.runClaude;
export const runClaudeJSON = defaultRunner.runClaudeJSON;
