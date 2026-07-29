/**
 * REL-08 bounded graceful-shutdown controller.
 *
 * Usage (in index.ts):
 *   const ctrl = createShutdownController({ graceMs: env.shutdownGraceMs });
 *   const server = http.createServer(app).listen(env.port);
 *   ctrl.boot(server).then(code => process.exit(code));
 *
 * Contract:
 * - On SIGTERM/SIGINT: stop accepting connections (server.close), drain
 *   in-flight requests.  Both server-closed callback AND in-flight drain
 *   must complete before resolving 0 (clean).
 * - After graceMs: force-destroy all tracked sockets, resolve 1 (forced).
 * - server.close() synchronously throws: resolve 1 immediately.
 * - Repeated signals after the first are ignored (settled once).
 * - trigger() before boot() is queued and fires on boot.
 * - boot() called twice throws.
 * - Signal and server listeners are removed on settle.
 * - In-flight tracking is always active (no race): requests arriving after
 *   shutdown-trigger increment inflight; close callback checks inflight === 0
 *   dynamically — drainDone is NOT captured at trigger time.
 * - drain resolver is installed BEFORE server.close() to close the
 *   synchronous callback/request-finish race.
 * - Per-socket close listeners are removed on settle.
 * - Options (graceMs, signals) are validated before booted state is set.
 * - process.exit is NOT called here — callers decide the exit strategy.
 * - All timers and the clock are injectable for deterministic tests.
 */

import type * as http from 'node:http';
import type * as net from 'node:net';

// ── Injectable clock/timer interface ────────────────────────────────

export interface ShutdownClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

const realClock: ShutdownClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

const MIN_GRACE_MS = 100;
const MAX_GRACE_MS = 300_000;

// ── Options ──────────────────────────────────────────────────────────

export interface ShutdownOptions {
  /** Grace period in ms before connections are force-destroyed. Default 30 000. */
  graceMs?: number;
  /** Override signals to listen on. Default ['SIGTERM', 'SIGINT']. */
  signals?: NodeJS.Signals[];
  /** Injectable clock for deterministic tests. */
  clock?: ShutdownClock;
}

// ── Public handle ────────────────────────────────────────────────────

export interface ShutdownHandle {
  /**
   * Registers signal handlers, attaches request tracking to the server,
   * and returns a promise that resolves with the process exit code once
   * shutdown completes.
   *
   * Resolve values:
   *   0 — server closed and all in-flight requests drained before deadline
   *   1 — forced close (deadline expired), server.close error, or drain error
   *
   * Throws if called more than once.
   */
  boot(server: http.Server): Promise<number>;

  /**
   * Manually trigger shutdown.  If called before boot(), the shutdown fires
   * immediately when boot() is subsequently called.
   */
  trigger(signal?: string): void;
}

// ── Implementation ───────────────────────────────────────────────────

export function createShutdownController(options: ShutdownOptions = {}): ShutdownHandle {
  let booted = false;
  let queuedSignal: string | null = null;

  let resolveShutdown!: (code: number) => void;
  const shutdownPromise = new Promise<number>((resolve) => {
    resolveShutdown = resolve;
  });

  let executeShutdown: ((sig: string) => void) | null = null;

  function trigger(signal = 'manual') {
    if (!booted) {
      queuedSignal = signal;
      return;
    }
    executeShutdown?.(signal);
  }

  function boot(server: http.Server): Promise<number> {
    // ── Validate BEFORE setting booted state ──────────────────────
    const graceMs = options.graceMs ?? 30_000;
    const signals: NodeJS.Signals[] = options.signals ?? ['SIGTERM', 'SIGINT'];
    const clock = options.clock ?? realClock;

    if (!Number.isFinite(graceMs) || !Number.isInteger(graceMs) ||
        graceMs < MIN_GRACE_MS || graceMs > MAX_GRACE_MS) {
      throw new Error(`graceMs must be an integer between ${MIN_GRACE_MS} and ${MAX_GRACE_MS}`);
    }

    // Deduplicate (only check if non-empty — empty signals means manual trigger only)
    const uniqueSignals = new Set(signals);
    if (signals.length > 0 && uniqueSignals.size !== signals.length) {
      throw new Error('signals must be unique');
    }

    if (booted) throw new Error('boot() called twice');
    booted = true;

    // ── Track sockets for forced close ───────────────────────────
    const sockets = new Set<net.Socket>();
    const socketCloseListeners = new Map<net.Socket, () => void>();

    const connectionHandler = (socket: net.Socket) => {
      sockets.add(socket);
      const onClose = () => {
        sockets.delete(socket);
        socketCloseListeners.delete(socket);
      };
      socketCloseListeners.set(socket, onClose);
      socket.once('close', onClose);
    };
    server.on('connection', connectionHandler);

    // ── Track in-flight requests ──────────────────────────────────
    let inflightCount = 0;
    let drainResolver: (() => void) | null = null;

    const requestHandler = (_req: http.IncomingMessage, res: http.ServerResponse) => {
      inflightCount++;
      let done_called = false;
      const done = () => {
        if (done_called) return;
        done_called = true;
        inflightCount--;
        if (inflightCount === 0 && drainResolver) {
          const cb = drainResolver;
          drainResolver = null;
          cb();
        }
      };
      res.once('finish', done);
      res.once('close', done);
    };
    server.on('request', requestHandler);

    // ── Registered signal handlers (for cleanup) ─────────────────
    const registeredHandlers: Array<{ sig: NodeJS.Signals; fn: () => void }> = [];

    let shutdownStarted = false;
    let settled = false;

    function settleOnce(code: number, timer: ReturnType<typeof setTimeout> | null) {
      if (settled) return;
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      // Remove all process listeners.
      for (const { sig, fn } of registeredHandlers) {
        process.removeListener(sig, fn);
      }
      // Remove server listeners.
      server.removeListener('connection', connectionHandler);
      server.removeListener('request', requestHandler);
      // Remove per-socket close listeners.
      for (const [sock, listener] of socketCloseListeners) {
        sock.removeListener('close', listener);
      }
      socketCloseListeners.clear();
      resolveShutdown(code);
    }

    // ── Shutdown procedure ────────────────────────────────────────
    executeShutdown = (_sig: string) => {
      if (shutdownStarted) return;
      shutdownStarted = true;

      // Grace timer — force-close if in-flight have not drained.
      const deadlineTimer = clock.setTimeout(() => {
        // Destroy all sockets tracked at timeout time
        const all = Array.from(sockets);
        for (const s of all) {
          s.destroy();
        }
        settleOnce(1, null);
      }, graceMs);

      // Dual-gate: both server closed AND in-flight drained.
      let serverClosed = false;

      function checkDone() {
        if (serverClosed && inflightCount === 0) {
          settleOnce(0, deadlineTimer);
        }
      }

      // IMPORTANT: install drain resolver BEFORE calling server.close().
      // This prevents a race where a request finishes between the close
      // callback and resolver registration.
      if (!drainResolver) {
        drainResolver = () => {
          checkDone();
        };
      }

      // Stop accepting new connections.
      try {
        server.close((err?: Error) => {
          if (settled) return;
          if (err) {
            settleOnce(1, deadlineTimer);
            return;
          }
          serverClosed = true;
          checkDone();
        });
      } catch (err) {
        settleOnce(1, deadlineTimer);
        return;
      }

      // Check immediately — might already be drained.
      checkDone();
    };

    // ── Register signal handlers ──────────────────────────────────
    for (const sig of uniqueSignals) {
      const fn = () => executeShutdown!(sig);
      registeredHandlers.push({ sig, fn });
      process.on(sig, fn);
    }

    // If trigger() was called before boot(), fire now.
    if (queuedSignal !== null) {
      const sig = queuedSignal;
      queuedSignal = null;
      executeShutdown(sig);
    }

    return shutdownPromise;
  }

  return { boot, trigger };
}
