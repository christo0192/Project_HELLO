/**
 * container/entrypoint.ts — PID 1 for the API container.
 *
 * The runtime image is non-root and has no init system, no cron and no daemon.
 * Something still has to keep the ClamAV signature database current, and that
 * something must not be the API process itself: the API is what we want to keep
 * alive and responsive, and folding a ~113 MB download plus a repeating timer
 * into it couples resume-scanner health to request-serving health.
 *
 * So the container's PID 1 is this supervisor. It:
 *
 *   1. starts the signature updater (immediate attempt + periodic refresh),
 *   2. spawns the API as a child and streams its stdio through untouched,
 *   3. forwards termination signals to the child and waits for it to leave,
 *   4. exits with the child's own status.
 *
 * WHY PID 1 MATTERS HERE. A process with pid 1 gets no default signal
 * dispositions: an unhandled SIGTERM is discarded rather than killing it, so a
 * naive PID 1 makes `docker stop` and Fly's graceful drain hang until the
 * 30-second SIGKILL. The handlers below are therefore load-bearing, not
 * decoration. PID 1 is also the reaper of orphaned children — Node reaps its
 * own, which is all this container ever creates (the API and freshclam).
 *
 * WHY THE UPDATER CANNOT KILL THE CONTAINER. A failed or rate-limited download
 * leaves the resume scanner fail-closed, which is a degraded feature; exiting
 * would turn it into an outage and Fly would restart straight back into the
 * same rate limit. The updater's failures are surfaced through the scanner
 * verdict and the activation health surface instead, so nothing here ever
 * claims readiness it does not have — it simply refuses to take the API down
 * for it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { loadAvUpdaterConfig, startAvUpdater, type AvUpdaterHandle } from '../lib/av-updater.js';
import { createLogger } from '../lib/logger.js';

const supervisorLogger = createLogger('container-entrypoint');

/** The compiled API entry, relative to `dist/`. */
export const API_ENTRY = 'dist/src/index.js';

/** Signals forwarded to the API child. */
export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/**
 * Extra grace on top of the API's own `SHUTDOWN_GRACE_MS` before the child is
 * killed outright. The API drains in-flight requests and leased Ashby work
 * inside its own budget; this margin only covers process teardown after that.
 */
export const KILL_MARGIN_MS = 5_000;

/** Bounds mirroring `lib/shutdown.ts`, so a malformed value cannot disable the kill. */
function resolveGraceMs(source: NodeJS.ProcessEnv): number {
  const raw = source.SHUTDOWN_GRACE_MS;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw.trim())) return 30_000;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) return 30_000;
  return Math.min(n, 300_000);
}

export interface SupervisorOptions {
  source?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Injectable spawner (tests). */
  spawnChild?: (command: string, args: string[]) => ChildProcess;
  /** Injectable updater factory (tests). Return null to disable. */
  startUpdater?: (cfg: ReturnType<typeof loadAvUpdaterConfig>) => AvUpdaterHandle | null;
  /** Signal registrar (tests). */
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
}

export interface SupervisorHandle {
  /** Resolves with the exit code the supervisor should use. */
  exitCode: Promise<number>;
  /** The updater handle, or null when ClamAV is not the configured scanner. */
  updater: AvUpdaterHandle | null;
  /** Deliver a termination signal (used by the registered handlers and tests). */
  terminate(signal: NodeJS.Signals): void;
}

/**
 * Start the supervisor. Exported separately from the module's own bootstrap so
 * the lifecycle — updater start, signal forwarding, exit propagation — is
 * testable without spawning a real API or a real freshclam.
 */
export function startSupervisor(opts: SupervisorOptions = {}): SupervisorHandle {
  const source = opts.source ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const graceMs = resolveGraceMs(source);

  // ── 1. Signature updater ───────────────────────────────────────────────
  const updaterConfig = loadAvUpdaterConfig(source);
  const startUpdater = opts.startUpdater
    ?? ((cfg): AvUpdaterHandle | null => (
      cfg.enabled
        ? startAvUpdater({ intervalMs: cfg.intervalMs, timeoutMs: cfg.timeoutMs, immediate: true })
        : null
    ));
  const updater = startUpdater(updaterConfig);

  // ── 2. API child ───────────────────────────────────────────────────────
  const spawnChild = opts.spawnChild
    ?? ((command: string, args: string[]): ChildProcess =>
      spawn(command, args, { stdio: 'inherit', cwd }));
  const child = spawnChild(process.execPath, [join(cwd, API_ENTRY)]);

  let settled = false;
  let killTimer: NodeJS.Timeout | null = null;
  let resolveExit: (code: number) => void = () => undefined;
  const exitCode = new Promise<number>((resolve) => { resolveExit = resolve; });

  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    updater?.stop();
    resolveExit(code);
  };

  child.on('exit', (code, signal) => {
    // Conventional 128+n encoding for a signal-terminated child, so the
    // container's exit status still tells an operator what happened.
    if (typeof code === 'number') { finish(code); return; }
    finish(signal ? 128 + signalNumber(signal) : 1);
  });
  child.on('error', () => {
    supervisorLogger.error('unknown_event', {
      error_category: 'container_supervisor',
      error_type: 'api_spawn_failed',
    });
    finish(1);
  });

  // ── 3. Signal forwarding ───────────────────────────────────────────────
  const terminate = (signal: NodeJS.Signals): void => {
    if (settled) return;
    try { child.kill(signal); } catch { /* child already gone */ }
    if (killTimer) return;
    killTimer = setTimeout(() => {
      // The child overran its own drain budget; stop waiting.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, graceMs + KILL_MARGIN_MS);
    if (typeof killTimer.unref === 'function') killTimer.unref();
  };

  const onSignal = opts.onSignal
    ?? ((signal: NodeJS.Signals, handler: () => void): void => { process.on(signal, handler); });
  for (const signal of FORWARDED_SIGNALS) onSignal(signal, () => terminate(signal));

  return { exitCode, updater, terminate };
}

/** Minimal signal-name → number map for exit-status encoding. */
function signalNumber(signal: NodeJS.Signals): number {
  switch (signal) {
    case 'SIGINT': return 2;
    case 'SIGKILL': return 9;
    case 'SIGTERM': return 15;
    case 'SIGHUP': return 1;
    default: return 15;
  }
}

/* c8 ignore start — container bootstrap; exercised by the container rehearsal,
   not by the unit suite (it would spawn the real API and exit the test runner). */
const isDirectRun = process.argv[1] !== undefined
  && process.argv[1].endsWith(join('dist', 'src', 'container', 'entrypoint.js'));
if (isDirectRun) {
  const handle = startSupervisor();
  handle.exitCode.then((code) => { process.exit(code); }).catch(() => { process.exit(1); });
}
/* c8 ignore stop */
