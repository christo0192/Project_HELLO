/**
 * provider-resilience.ts — CIRCUIT BREAKER + TIMEOUT UTILITIES
 *
 * Deterministic circuit breaker (closed / open / half-open).
 * Bounded output collector using Buffer byte length.
 * Injected monotonic clock (default performance.now).
 *
 * BUSINESS / VALIDATION failures (e.g. JSON parse error, 4xx business
 * logic) do NOT count toward the breaker failure threshold.
 *
 * Provider-availability failures that DO count:
 *   - timeout           (process/network deadline exceeded)
 *   - spawn_failed      (could not launch child process)
 *   - connection        (network error, DNS failure, connection refused)
 *   - protocol          (non-zero exit, HTTP protocol error, 5xx upstream)
 *   - output_limit      (provider response exceeded allowable size)
 *
 * DEPENDENCY INJECTION: Clock, TimerSet injected via config.
 * Error messages use stable category codes — no dynamic values.
 */

// ── Error categories ──────────────────────────────────────────────

export type ProviderFailureCategory =
  | 'timeout'
  | 'spawn_failed'
  | 'connection'
  | 'protocol'
  | 'output_limit'
  | 'circuit_open';

export class ProviderError extends Error {
  public readonly category: ProviderFailureCategory;

  constructor(category: ProviderFailureCategory) {
    super(category); // stable category text only — no dynamic values
    this.name = 'ProviderError';
    this.category = category;
  }
}

export class BusinessError extends Error {
  constructor() {
    super('business_error');
    this.name = 'BusinessError';
  }
}

/**
 * Determine whether an error represents a provider-availability failure
 * that SHOULD count toward the circuit-breaker threshold.
 *
 * Business / validation errors do NOT count — retrying would not help.
 */
export function isProviderFailure(err: unknown): boolean {
  if (err instanceof ProviderError) return true;
  if (err instanceof BusinessError) return false;
  if (err instanceof Error) {
    // ProviderError category recognition for wrapped errors.
    // Recognizes ClaudeError categories (non_zero_exit) and any other
    // error carrying a matching category property.
    if ('category' in err) {
      const cat = (err as any).category as string;
      if ([
        'timeout', 'spawn_failed', 'connection', 'protocol',
        'output_limit', 'circuit_open', 'non_zero_exit',
      ].includes(cat)) {
        return true;
      }
    }
    // Node system / OS errors indicating provider unreachable.
    const sys = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'ENETUNREACH'];
    if ((err as NodeJS.ErrnoException).code && sys.includes((err as NodeJS.ErrnoException).code!)) {
      return true;
    }
  }
  return false;
}

// ── Clock abstraction ─────────────────────────────────────────────

export interface Clock {
  now(): number;
}

export const MonotonicClock: Clock = { now: () => performance.now() };

// ── TimerSet abstraction ──────────────────────────────────────────

export interface TimerSet {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export const DefaultTimerSet: TimerSet = { setTimeout, clearTimeout };

// ── Circuit breaker ───────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Max consecutive provider failures before opening. */
  failureThreshold: number;
  /** Cooldown (ms) before transitioning from OPEN → HALF_OPEN for one probe. */
  cooldownMs: number;
  /** Injected monotonic clock. */
  clock?: Clock;
  /** Injected timers. */
  timers?: TimerSet;
}

const DEFAULT_CONFIG: Required<Omit<CircuitBreakerConfig, 'clock' | 'timers'>> &
  Pick<Required<CircuitBreakerConfig>, 'clock' | 'timers'> = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  clock: MonotonicClock,
  timers: DefaultTimerSet,
};

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenProbeInFlight = false;
  private config: Required<CircuitBreakerConfig>;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<CircuitBreakerConfig>;
    this.validateConfig();
  }

  private validateConfig(): void {
    const { failureThreshold, cooldownMs } = this.config;
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new TypeError('failureThreshold must be a positive integer');
    }
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
      throw new TypeError('cooldownMs must be positive');
    }
  }

  getState(): Readonly<CircuitState> {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Call a provider function through the breaker.
   *
   * Business/validation errors pass through and do NOT affect breaker state.
   * A BusinessError during HALF_OPEN resets the breaker (the service is
   * reachable; the error was not a provider-availability failure).
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    const now = this.config.clock.now();

    if (this.state === 'OPEN') {
      if (now - this.lastFailureTime < this.config.cooldownMs) {
        throw new ProviderError('circuit_open');
      }
      this.state = 'HALF_OPEN';
      this.halfOpenProbeInFlight = false;
    }

    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenProbeInFlight) {
        throw new ProviderError('circuit_open');
      }
      this.halfOpenProbeInFlight = true;
    }

    try {
      const result = await fn();
      if (this.state === 'HALF_OPEN') {
        this.reset();
      } else {
        this.failureCount = 0;
      }
      return result;
    } catch (err) {
      if (isProviderFailure(err)) {
        this.recordFailure();
      } else if (err instanceof BusinessError) {
        // An availability-reachable BusinessError should break consecutive
        // provider failures and close a half-open probe.
        if (this.state === 'HALF_OPEN') {
          this.reset();
        } else {
          this.failureCount = 0;
        }
      }
      throw err;
    } finally {
      if (this.state === 'HALF_OPEN') {
        this.halfOpenProbeInFlight = false;
      }
    }
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.halfOpenProbeInFlight = false;
  }

  forceOpen(): void {
    this.state = 'OPEN';
    this.lastFailureTime = this.config.clock.now();
    this.halfOpenProbeInFlight = false;
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = this.config.clock.now();
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'OPEN';
      this.halfOpenProbeInFlight = false;
    }
  }
}

// ── Bounded pipe: cap child-process stdout/stderr by Buffer bytes ─

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * Collect stdout/stderr from Readable streams, capping each at `maxBytes`
 * of Buffer byte length. If the cap is exceeded the stream is destroyed
 * and the promise rejects with ProviderError('output_limit').
 *
 * Only removes handlers that this function installed (does not destroy
 * listeners owned by other code). Stream errors reject as provider failure.
 *
 * maxBytes must be a finite positive integer.
 */
export function collectBounded(
  stdout: NodeJS.ReadableStream,
  stderr: NodeJS.ReadableStream,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<{ stdout: Buffer[]; stderr: Buffer[] }> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isInteger(maxBytes)) {
    return Promise.reject(new TypeError('maxBytes must be a finite positive integer'));
  }

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let stdoutDone = false;
    let stderrDone = false;

    // Track installed handlers so cleanup only removes what we installed.
    const stdoutHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];
    const stderrHandlers: Array<{ event: string; handler: (...args: any[]) => void }> = [];

    function cleanup(): void {
      for (const { event, handler } of stdoutHandlers) {
        stdout.off(event, handler);
      }
      for (const { event, handler } of stderrHandlers) {
        stderr.off(event, handler);
      }
    }

    function onEvent(stream: 'stdout' | 'stderr', event: string, handler: (...args: any[]) => void): void {
      const target = stream === 'stdout' ? stdout : stderr;
      const registry = stream === 'stdout' ? stdoutHandlers : stderrHandlers;
      target.on(event, handler);
      registry.push({ event, handler });
    }

    function checkDone(): void {
      if (settled) return;
      if (stdoutDone && stderrDone) {
        settled = true;
        cleanup();
        resolve({ stdout: stdoutChunks, stderr: stderrChunks });
      }
    }

    function destroyReadable(stream: NodeJS.ReadableStream): void {
      const maybeDestroy = (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy;
      if (typeof maybeDestroy === 'function') maybeDestroy.call(stream);
    }

    /** Check if cumulative bytes exceed max and reject with output_limit. */
    function checkOverflow(stream: 'stdout' | 'stderr'): void {
      const bytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
      if (bytes > maxBytes) {
        settled = true;
        cleanup();
        destroyReadable(stdout);
        destroyReadable(stderr);
        reject(new ProviderError('output_limit'));
      }
    }

    function onStdoutData(chunk: Buffer): void {
      if (settled) return;
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
      checkOverflow('stdout');
    }

    function onStderrData(chunk: Buffer): void {
      if (settled) return;
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      checkOverflow('stderr');
    }

    function onStdoutEnd(): void {
      stdoutDone = true;
      checkDone();
    }

    function onStderrEnd(): void {
      stderrDone = true;
      checkDone();
    }

    /** Stream error — reject as stable ProviderError (no dynamic error text). */
    function onStdoutError(_err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      destroyReadable(stdout);
      destroyReadable(stderr);
      reject(new ProviderError('protocol'));
    }

    function onStderrError(_err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      destroyReadable(stdout);
      destroyReadable(stderr);
      reject(new ProviderError('protocol'));
    }

    onEvent('stdout', 'data', onStdoutData);
    onEvent('stderr', 'data', onStderrData);
    onEvent('stdout', 'end', onStdoutEnd);
    onEvent('stderr', 'end', onStderrEnd);
    onEvent('stdout', 'error', onStdoutError);
    onEvent('stderr', 'error', onStderrError);
    onEvent('stdout', 'close', onStdoutEnd);
    onEvent('stderr', 'close', onStderrEnd);
  });
}
